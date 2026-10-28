import type { Drafter } from "./drafter.js";
import { amountOf, buildRequest, clamp, decideAction, evidencePlan, hoursLeft, offerAmount, ruleScore } from "./policy.js";
import type { Action, DisputeCase, OutboundRequest, PayPalClient, Recommendation } from "./types.js";

export class DisputeCopilot {
  constructor(private readonly paypal: PayPalClient, private readonly drafter: Drafter, private readonly now: () => Date = () => new Date()) {}

  async loadCase(id: string): Promise<DisputeCase> {
    const dispute = await this.paypal.getDispute(id);
    return { dispute, facts: await this.paypal.getFacts(dispute) };
  }

  /** Queue: every open dispute with its recommendation, most urgent first (hours left, then amount). */
  async queue(): Promise<Recommendation[]> {
    const disputes = await this.paypal.listOpenDisputes();
    const cases = await Promise.all(disputes.map(async (dispute) => ({ dispute, facts: await this.paypal.getFacts(dispute) })));
    const recs = await Promise.all(cases.map((kase) => this.recommend(kase)));
    return recs.sort((a, b) => (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity) || b.amount - a.amount);
  }

  async recommend(kase: DisputeCase): Promise<Recommendation> {
    const { dispute, facts } = kase;
    const amount = amountOf(dispute.dispute_amount);
    const plan = evidencePlan(dispute.reason, facts);
    const { score, factors } = ruleScore(dispute, facts);
    const first = decideAction(score, amount);
    const offer = offerAmount(dispute.dispute_amount);
    let drafted = await this.drafter.draft({ kase, action: first.action, score, factors, plan, ...(first.action === "OFFER" ? { offer } : {}) });

    // The model may nudge the score within ±LLM_MAX_ADJUST; if that flips the action, redraft once for the new action.
    const finalScore = clamp(score + (drafted.adjustment?.delta ?? 0), 0, 100);
    const final = decideAction(finalScore, amount);
    if (final.action !== first.action) {
      const redraft = await this.drafter.draft({ kase, action: final.action, score: finalScore, factors, plan, ...(final.action === "OFFER" ? { offer } : {}) });
      drafted = { ...redraft, ...(drafted.adjustment ? { adjustment: drafted.adjustment } : {}) };
    }
    return {
      disputeId: dispute.dispute_id,
      hoursLeft: hoursLeft(dispute, this.now()),
      amount,
      currency: dispute.dispute_amount.currency_code,
      score: finalScore,
      factors,
      evidencePlan: plan,
      action: final.action,
      actionReason: final.reason,
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
    const plan = evidencePlan(kase.dispute.reason, kase.facts);
    return buildRequest(kase.dispute.dispute_id, action, draft, kase.facts, plan, offerAmount(kase.dispute.dispute_amount));
  }

  /** Human-approved send. Rebuilds the request server-side; the client never supplies a raw PayPal request. */
  async approve(id: string, action: Action, draft: string): Promise<{ request: OutboundRequest; status: number; body: unknown }> {
    const request = await this.preview(id, action, draft);
    const result = await this.paypal.send(id, request);
    return { request, status: result.status, body: result.body };
  }
}
