import type { Drafter } from "./drafter.js";
import { mapLimit } from "./limit.js";
import { factsErrorReason, MAX_IN_FLIGHT, PayPalHttpError } from "./paypal-client.js";
import { allowedActions, amountOf, buildRequest, clamp, decideAction, evidencePlan, hoursLeft, offerAmount, ruleScore } from "./policy.js";
import type { Action, DisputeCase, OutboundRequest, PayPalClient, Recommendation } from "./types.js";

export class DisputeCopilot {
  constructor(private readonly paypal: PayPalClient, private readonly drafter: Drafter, private readonly now: () => Date = () => new Date()) {}

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
    const recs = await mapLimit(disputes, MAX_IN_FLIGHT, async (dispute) => this.recommend({ dispute, facts: await this.factsFor(dispute) }));
    return recs.sort((a, b) => (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity) || b.amount - a.amount);
  }

  async recommend(kase: DisputeCase): Promise<Recommendation> {
    const { dispute, facts } = kase;
    const amount = amountOf(dispute.dispute_amount);
    const plan = evidencePlan(dispute.reason, facts);
    const { score, factors } = ruleScore(dispute, facts);
    // Missing facts must never quietly become OFFER/ACCEPT: route to a human with the fight checklist.
    const first = facts.unknown
      ? { action: "FIGHT" as Action, reason: `Insufficient facts: ${facts.unknownReason ?? "order data unavailable"} Human review needed before any response.` }
      : decideAction(score, amount);
    const offer = offerAmount(dispute.dispute_amount);
    let drafted = await this.drafter.draft({ kase, action: first.action, score, factors, plan, ...(first.action === "OFFER" ? { offer } : {}) });

    // The model may nudge the score within ±LLM_MAX_ADJUST; if that flips the action, redraft once for the new action.
    const finalScore = clamp(score + (drafted.adjustment?.delta ?? 0), 0, 100);
    const final = facts.unknown ? first : decideAction(finalScore, amount);
    const changed = final.action !== first.action;
    if (changed) {
      const redraft = await this.drafter.draft({ kase, action: final.action, score: finalScore, factors, plan, ...(final.action === "OFFER" ? { offer } : {}) });
      drafted = { ...redraft, ...(drafted.adjustment ? { adjustment: drafted.adjustment } : {}) };
    }
    return {
      disputeId: dispute.dispute_id,
      hoursLeft: hoursLeft(dispute, this.now()),
      amount,
      currency: dispute.dispute_amount.currency_code,
      reason: dispute.reason,
      score: finalScore,
      factors,
      evidencePlan: plan,
      action: final.action,
      actionReason: final.reason,
      rulesAction: first.action,
      actionChangedByLLM: changed,
      needsHumanReview: Boolean(facts.unknown),
      allowedActions: allowedActions(dispute),
      paypalStatus: dispute.status,
      ...(dispute.dispute_life_cycle_stage ? { lifecycleStage: dispute.dispute_life_cycle_stage } : {}),
      ...(final.action === "OFFER" ? { offerAmount: offer } : {}),
      assessment: drafted.assessment,
      draft: drafted.draft,
      draftSource: drafted.source,
      ...(drafted.adjustment && drafted.adjustment.delta !== 0 ? { llmAdjustment: drafted.adjustment } : {}),
    };
  }

  /** Preview of exactly what Approve would send. The seller may override the action and edit the draft. */
  async preview(id: string, action: Action, draft: string): Promise<OutboundRequest> {
    const kase = await this.loadCase(id);
    const allowed = allowedActions(kase.dispute);
    if (!allowed.includes(action)) {
      throw new PayPalHttpError(409, `PayPal does not allow ${action} on this dispute now (status ${kase.dispute.status}). Allowed: ${allowed.join(", ") || "none"}.`);
    }
    const plan = evidencePlan(kase.dispute.reason, kase.facts);
    return buildRequest(kase.dispute.dispute_id, action, draft, kase.facts, plan, offerAmount(kase.dispute.dispute_amount));
  }

  /**
   * Human-approved send. Rebuilds the request server-side; the client never supplies a raw PayPal request.
   * When the model flipped the rules' action, the seller must tick an explicit confirmation.
   */
  async approve(id: string, action: Action, draft: string, confirmAiChange = false): Promise<{ request: OutboundRequest; status: number; body: unknown }> {
    const request = await this.preview(id, action, draft);
    const rec = await this.recommend(await this.loadCase(id));
    if (rec.actionChangedByLLM && !confirmAiChange) {
      throw new PayPalHttpError(409, `AI changed the recommendation from ${rec.rulesAction} to ${rec.action}; tick the confirmation before sending.`);
    }
    const result = await this.paypal.send(id, request);
    return { request, status: result.status, body: result.body };
  }
}
