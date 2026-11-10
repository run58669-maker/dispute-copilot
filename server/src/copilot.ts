import { randomUUID } from "node:crypto";
import type { Drafter } from "./drafter.js";
import { mapLimit } from "./limit.js";
import { factsErrorReason, MAX_IN_FLIGHT, PayPalHttpError } from "./paypal-client.js";
import { allowedActions, amountOf, buildRequest, decideAction, evidencePlan, hoursLeft, offerAmount, restrictToAllowed, ruleScore, thresholdAmount } from "./policy.js";
import type { Action, DisputeCase, OutboundRequest, PayPalClient, Recommendation } from "./types.js";

/** A preview and its recommendation stay valid this long; approve after that needs a fresh preview. */
export const PREVIEW_TTL_MS = 10 * 60_000;

export interface PreviewResult {
  request: OutboundRequest;
  /** Single-use nonce; approve must send it back. */
  previewId: string;
  expiresAt: string;
  recommendedAction: Action;
  rulesAction: Action;
}

interface PreviewEntry {
  previewId: string;
  action: Action;
  draft: string;
  request: OutboundRequest;
  rulesAction: Action;
  recommendedAction: Action;
  expiresAt: number;
}

export class DisputeCopilot {
  /** Last recommendation per dispute (from the queue or a preview), so preview/approve never re-run the LLM. */
  private readonly recs = new Map<string, { rec: Recommendation; expiresAt: number }>();
  /** Last preview per dispute; approve sends exactly this request, once. */
  private readonly previews = new Map<string, PreviewEntry>();

  constructor(
    private readonly paypal: PayPalClient,
    private readonly drafter: Drafter,
    private readonly now: () => Date = () => new Date(),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private remember(rec: Recommendation): Recommendation {
    const now = this.clock();
    for (const map of [this.recs, this.previews] as Array<Map<string, { expiresAt: number }>>) for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k);
    this.recs.set(rec.disputeId, { rec, expiresAt: now + PREVIEW_TTL_MS });
    return rec;
  }

  async loadCase(id: string): Promise<DisputeCase> {
    const dispute = await this.paypal.getDispute(id);
    return { dispute, facts: await this.factsFor(dispute) };
  }

  /** Facts never fail the caller: any error becomes `unknown`, which routes the case to human review. */
  private async factsFor(dispute: DisputeCase["dispute"]): Promise<DisputeCase["facts"]> {
    try {
      return await this.paypal.getFacts(dispute);
    } catch (error) {
      return { unknown: true, unknownReason: factsErrorReason(error) };
    }
  }

  /** Queue: every open dispute with its recommendation, most urgent first (hours left, then amount). At most 5 disputes in flight. */
  async queue(): Promise<Recommendation[]> {
    const disputes = await this.paypal.listOpenDisputes();
    const recs = await mapLimit(disputes, MAX_IN_FLIGHT, async (dispute) => this.remember(await this.recommend({ dispute, facts: await this.factsFor(dispute) })));
    return recs.sort((a, b) => (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity) || b.amount - a.amount);
  }

  async recommend(kase: DisputeCase): Promise<Recommendation> {
    const { dispute, facts } = kase;
    const amount = amountOf(dispute.dispute_amount);
    const plan = evidencePlan(dispute.reason, facts);
    const { score, factors } = ruleScore(dispute, facts);
    const allowed = allowedActions(dispute);
    const thresholdValue = thresholdAmount(dispute.dispute_amount);
    // The policy action comes from the rule score only. Missing facts route to FIGHT + human review when PayPal allows FIGHT.
    const unknownFight = facts.unknown && (allowed.length === 0 || allowed.includes("FIGHT"));
    const policy = unknownFight
      ? { action: "FIGHT" as Action, reason: `Insufficient facts: ${facts.unknownReason ?? "order data unavailable"} Human review needed before any response.` }
      : decideAction(score, thresholdValue);
    const action = restrictToAllowed(policy.action, allowed);
    let actionReason = policy.reason;
    if (facts.unknown && !unknownFight) actionReason = `Order facts unavailable (${facts.unknownReason ?? "order data unavailable"}), so the human review is needed; FIGHT is not allowed here. ${actionReason}`;
    if (action !== policy.action) actionReason += ` ${policy.action} is not allowed by PayPal now (allowed: ${allowed.join(", ")}), so ${action} is the best allowed action.`;
    if (allowed.length === 0) actionReason = `Informational only: PayPal allows no seller action now (status ${dispute.status}). ${actionReason}`;
    const offer = offerAmount(dispute.dispute_amount);
    // The model writes text only (assessment, draft). It does not change the score or the action.
    const drafted = await this.drafter.draft({ kase, action, score, factors, plan, ...(action === "OFFER" ? { offer } : {}) });
    return {
      disputeId: dispute.dispute_id,
      hoursLeft: hoursLeft(dispute, this.now()),
      amount,
      currency: dispute.dispute_amount.currency_code,
      reason: dispute.reason,
      score,
      factors,
      evidencePlan: plan,
      action,
      actionReason,
      rulesAction: policy.action,
      needsHumanReview: Boolean(facts.unknown),
      allowedActions: allowed,
      paypalStatus: dispute.status,
      ...(dispute.dispute_life_cycle_stage ? { lifecycleStage: dispute.dispute_life_cycle_stage } : {}),
      ...(action === "OFFER" ? { offerAmount: offer } : {}),
      assessment: drafted.assessment,
      draft: drafted.draft,
      draftSource: drafted.source,
      ...(drafted.model ? { draftModel: drafted.model } : {}),
    };
  }

  /**
   * Preview of exactly what Approve would send. The seller may override the action and edit the draft.
   * Uses the cached recommendation (the LLM runs only if this dispute has none yet) and stores the request
   * under a single-use previewId for approve.
   */
  async preview(id: string, action: Action, draft: string): Promise<PreviewResult> {
    const kase = await this.loadCase(id);
    const allowed = allowedActions(kase.dispute);
    if (!allowed.includes(action)) {
      throw new PayPalHttpError(409, `PayPal does not allow ${action} on this dispute now (status ${kase.dispute.status}). Allowed: ${allowed.join(", ") || "none"}.`);
    }
    const plan = evidencePlan(kase.dispute.reason, kase.facts);
    const request = buildRequest(kase.dispute.dispute_id, action, draft, kase.facts, plan, offerAmount(kase.dispute.dispute_amount));
    const cached = this.recs.get(id);
    const rec = cached && cached.expiresAt > this.clock() ? cached.rec : this.remember(await this.recommend(kase));
    const entry: PreviewEntry = {
      previewId: randomUUID(),
      action,
      draft,
      request,
      rulesAction: rec.rulesAction,
      recommendedAction: rec.action,
      expiresAt: this.clock() + PREVIEW_TTL_MS,
    };
    this.previews.set(id, entry);
    return {
      request,
      previewId: entry.previewId,
      expiresAt: new Date(entry.expiresAt).toISOString(),
      recommendedAction: entry.recommendedAction,
      rulesAction: entry.rulesAction,
    };
  }

  /**
   * Human-approved send of the last preview: no LLM call, no rebuild, the client never supplies a raw PayPal request.
   * No matching preview (missing, expired, replaced, or action/draft edited since) -> 409 "Preview first".
   */
  async approve(
    id: string,
    action: Action,
    draft: string,
    opts: { previewId?: string } = {},
  ): Promise<{ request: OutboundRequest; status: number; body: unknown }> {
    const entry = this.previews.get(id);
    if (!entry || entry.expiresAt <= this.clock() || !opts.previewId || entry.previewId !== opts.previewId) {
      throw new PayPalHttpError(409, "Preview first: there is no current preview for this dispute (missing, expired or replaced).");
    }
    if (entry.action !== action || entry.draft !== draft) {
      throw new PayPalHttpError(409, "Preview first: the action or draft changed since the preview.");
    }
    this.previews.delete(id); // single use: a double click cannot send twice
    const result = await this.paypal.send(id, entry.request);
    return { request: entry.request, status: result.status, body: result.body };
  }
}
