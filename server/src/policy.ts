import type { Action, Dispute, DisputeReason, EvidenceItem, Money, OrderFacts, OutboundRequest, ScoreFactor } from "./types.js";

/** Decision thresholds. FIGHT at or above `fight`, OFFER at or above `offer`, else ACCEPT. */
export const THRESHOLDS = { fight: 60, offer: 30 } as const;
/** Below this amount (in the dispute currency) fighting costs more seller time than it saves: accept. */
export const MIN_WORTH_FIGHTING = 15;
/** Share of the disputed amount offered back when the copilot recommends a partial refund. */
export const OFFER_SHARE = 0.5;
/** PayPal limit on evidence `notes`, offer `note` and accept-claim `note`. */
export const NOTE_MAX = 2000;
/** The LLM may move the rule score by at most this much, and must say why. */
export const LLM_MAX_ADJUST = 15;

export function hoursLeft(dispute: Dispute, now: Date): number | null {
  if (!dispute.seller_response_due_date) return null;
  const due = Date.parse(dispute.seller_response_due_date);
  if (Number.isNaN(due)) return null;
  return Math.round(((due - now.getTime()) / 3_600_000) * 10) / 10;
}

export function amountOf(money: Money): number {
  const n = Number(money.value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Which `evidence_type` values (PayPal Disputes v1 enum) answer each reason, and whether the facts on hand cover them.
 * Grounded in PayPal's reason-to-evidence guidance; types not in the enum are never produced.
 */
export function evidencePlan(reason: DisputeReason, facts: OrderFacts): EvidenceItem[] {
  switch (reason) {
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
      if (facts.digitalGood) {
        return [
          { evidence_type: "PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED", have: facts.trackingStatus === "DELIVERED", why: "Digital goods: show the download/activation record." },
          { evidence_type: "ITEM_DESCRIPTION", have: facts.listingMatchesItem === true, why: "Listing shows it was a digital delivery." },
        ];
      }
      return [
        { evidence_type: "PROOF_OF_FULFILLMENT", have: Boolean(facts.trackingNumber && facts.carrier), why: "Carrier + tracking number for the shipment." },
        { evidence_type: "ONLINE_TRACKING_INFORMATION", have: facts.trackingStatus === "DELIVERED", why: "Tracking shows delivered." },
        { evidence_type: "PROOF_OF_DELIVERY_SIGNATURE", have: facts.signatureOnDelivery === true, why: "Signature confirmation (matters for high-value items)." },
      ];
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      return [
        { evidence_type: "ITEM_DESCRIPTION", have: facts.listingMatchesItem === true, why: "Listing text and photos match what was shipped." },
        { evidence_type: "RETURN_POLICY", have: facts.returnPolicyPublished === true, why: "Published return policy the buyer agreed to." },
        { evidence_type: "PHOTOS_OF_SHIPPED_ITEM", have: false, why: "Photos taken before shipping (seller must upload)." },
      ];
    case "UNAUTHORISED":
      return [
        { evidence_type: "PROOF_OF_FULFILLMENT", have: Boolean(facts.trackingNumber), why: "Shipped to the account's confirmed address." },
        { evidence_type: "DELIVERY_ADDRESS", have: facts.deliveredToMatchingAddress === true, why: "Delivery address matches the PayPal shipping address." },
        { evidence_type: "DETAILS_OF_PURCHASE", have: (facts.priorPurchasesBySameBuyer ?? 0) > 0, why: "Earlier undisputed purchases by the same account." },
      ];
    case "CREDIT_NOT_PROCESSED":
      return [{ evidence_type: "PROOF_OF_REFUND", have: Boolean(facts.refundId), why: "Refund id showing the credit was issued." }];
    default:
      return [{ evidence_type: "OTHER", have: false, why: "No specific checklist for this reason; seller explains." }];
  }
}

/** Transparent rule score (0–100). Every point has a labelled factor so the seller sees why. */
export function ruleScore(dispute: Dispute, facts: OrderFacts): { score: number; factors: ScoreFactor[] } {
  const factors: ScoreFactor[] = [{ label: "Base", points: 30 }];
  const plan = evidencePlan(dispute.reason, facts);
  const covered = plan.filter((item) => item.have).length;
  if (plan.length > 0) factors.push({ label: `Evidence on hand ${covered}/${plan.length}`, points: Math.round((covered / plan.length) * 40) });

  if (dispute.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" && facts.trackingStatus === "DELIVERED" && facts.deliveredToMatchingAddress) {
    factors.push({ label: "Delivered to the buyer's PayPal address", points: 15 });
  }
  if (dispute.reason === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" && facts.trackingStatus === "NONE") {
    factors.push({ label: "No tracking at all", points: -25 });
  }
  if (dispute.reason === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED") {
    // PayPal usually sides with the buyer on SNAD unless the listing is airtight.
    factors.push({ label: "Not-as-described cases lean to the buyer", points: -15 });
  }
  if (dispute.reason === "UNAUTHORISED" && facts.digitalGood) {
    factors.push({ label: "Digital goods have no delivery address to prove", points: -15 });
  }
  if (facts.buyerContactedSellerFirst === false) factors.push({ label: "Buyer never contacted the seller first", points: 5 });
  if ((facts.priorPurchasesBySameBuyer ?? 0) >= 2) factors.push({ label: "Repeat buyer with undisputed history", points: 5 });
  if (amountOf(dispute.dispute_amount) >= 750 && facts.signatureOnDelivery !== true && !facts.digitalGood) {
    factors.push({ label: "High value without signature confirmation", points: -10 });
  }
  const raw = factors.reduce((sum, factor) => sum + factor.points, 0);
  return { score: clamp(raw, 0, 100), factors };
}

export function decideAction(score: number, amount: number): { action: Action; reason: string } {
  if (amount < MIN_WORTH_FIGHTING) {
    return { action: "ACCEPT", reason: `Amount under ${MIN_WORTH_FIGHTING}: fighting costs more time than it recovers.` };
  }
  if (score >= THRESHOLDS.fight) return { action: "FIGHT", reason: `Win score ${score} ≥ ${THRESHOLDS.fight}: the evidence on hand answers the claim.` };
  if (score >= THRESHOLDS.offer) return { action: "OFFER", reason: `Win score ${score} is between ${THRESHOLDS.offer} and ${THRESHOLDS.fight}: a partial refund likely beats a coin-flip.` };
  return { action: "ACCEPT", reason: `Win score ${score} < ${THRESHOLDS.offer}: accepting early stops further holds and fees.` };
}

export function offerAmount(money: Money): Money {
  const value = Math.round(amountOf(money) * OFFER_SHARE * 100) / 100;
  return { currency_code: money.currency_code, value: value.toFixed(2) };
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function truncateNote(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= NOTE_MAX ? trimmed : `${trimmed.slice(0, NOTE_MAX - 1)}…`;
}

/** Builds the exact PayPal request for an approved action. Validates before anything leaves the server. */
export function buildRequest(
  disputeId: string,
  action: Action,
  draft: string,
  facts: OrderFacts,
  plan: EvidenceItem[],
  offer?: Money,
): OutboundRequest {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(disputeId)) throw new Error("Invalid dispute id.");
  const note = truncateNote(draft);
  if (note.length === 0) throw new Error("Draft is empty.");
  const base = `/v1/customer/disputes/${disputeId}`;
  if (action === "FIGHT") {
    const evidences = plan
      .filter((item) => item.have)
      .map((item) => ({
        evidence_type: item.evidence_type,
        ...(item.evidence_type === "PROOF_OF_FULFILLMENT" && facts.trackingNumber && facts.carrier
          ? { evidence_info: { tracking_info: [{ carrier_name: facts.carrier, tracking_number: facts.trackingNumber }] } }
          : {}),
        notes: note,
      }));
    if (evidences.length === 0) throw new Error("No evidence on hand to submit; choose OFFER or ACCEPT.");
    return { method: "POST", path: `${base}/provide-evidence`, contentType: "multipart/form-data", body: { input: { evidences } } };
  }
  if (action === "OFFER") {
    if (!offer) throw new Error("Offer amount missing.");
    return { method: "POST", path: `${base}/make-offer`, contentType: "application/json", body: { note, offer_type: "REFUND", offer_amount: offer } };
  }
  return { method: "POST", path: `${base}/accept-claim`, contentType: "application/json", body: { note } };
}
