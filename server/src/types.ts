/** Subset of the PayPal Disputes v1 `dispute_reason` enum (all ten values, from schema.json). */
export const DISPUTE_REASONS = [
  "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  "UNAUTHORISED",
  "CREDIT_NOT_PROCESSED",
  "DUPLICATE_TRANSACTION",
  "INCORRECT_AMOUNT",
  "PAYMENT_BY_OTHER_MEANS",
  "CANCELED_RECURRING_BILLING",
  "PROBLEM_WITH_REMITTANCE",
  "OTHER",
] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export const OFFER_TYPES = ["REFUND", "REFUND_WITH_RETURN", "REFUND_WITH_REPLACEMENT", "REPLACEMENT_WITHOUT_REFUND"] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

export interface Money {
  currency_code: string;
  value: string;
}

/** The fields of a PayPal dispute (GET /v1/customer/disputes/{id}) that the copilot reads. */
export interface Dispute {
  dispute_id: string;
  create_time: string;
  update_time?: string;
  reason: DisputeReason;
  status: string;
  dispute_state?: string;
  dispute_life_cycle_stage?: string;
  dispute_amount: Money;
  seller_response_due_date?: string;
  disputed_transactions?: Array<{
    seller_transaction_id?: string;
    buyer?: { name?: string };
    items?: Array<{ item_description?: string; item_quantity?: string }>;
  }>;
  messages?: Array<{ posted_by: string; time_posted?: string; content: string }>;
  /** What PayPal currently lets the seller do (Disputes v1). */
  allowed_response_options?: {
    accept_claim?: { accept_claim_types?: string[] };
    make_offer?: { offer_types?: string[] };
    acknowledge_return_item?: unknown;
  };
  /** HATEOAS links; `provide_evidence` / `make_offer` / `accept_claim` appear only when that action is available. */
  links?: Array<{ rel?: string; href?: string; method?: string }>;
}

/**
 * Facts about the order behind a dispute. In live mode these come from Orders/Captures (and later a
 * tracking source); in mock mode from fixtures. Anything unknown stays undefined, never guessed.
 */
export interface OrderFacts {
  itemTitle?: string;
  digitalGood?: boolean;
  carrier?: string;
  trackingNumber?: string;
  trackingStatus?: "DELIVERED" | "IN_TRANSIT" | "NONE";
  deliveredToMatchingAddress?: boolean;
  signatureOnDelivery?: boolean;
  listingMatchesItem?: boolean;
  returnPolicyPublished?: boolean;
  buyerContactedSellerFirst?: boolean;
  priorPurchasesBySameBuyer?: number;
  refundId?: string;
  /** True when the facts needed to judge fulfilment could not be read; the copilot then asks a human. */
  unknown?: boolean;
  unknownReason?: string;
}

export interface DisputeCase {
  dispute: Dispute;
  facts: OrderFacts;
}

export type Action = "FIGHT" | "OFFER" | "ACCEPT";

export interface ScoreFactor {
  label: string;
  points: number;
}

export interface EvidenceItem {
  evidence_type: string;
  have: boolean;
  why: string;
}

export interface Recommendation {
  disputeId: string;
  hoursLeft: number | null;
  amount: number;
  currency: string;
  score: number;
  factors: ScoreFactor[];
  evidencePlan: EvidenceItem[];
  action: Action;
  actionReason: string;
  offerAmount?: Money;
  /** One-paragraph case assessment (LLM, or deterministic template). */
  assessment: string;
  draft: string;
  draftSource: "llm" | "template";
  llmAdjustment?: { delta: number; why: string };
  reason: DisputeReason;
  /** Action the rules alone chose, before the model's score nudge. */
  rulesAction: Action;
  /** The model's nudge flipped the action: the UI warns and approve needs an explicit confirm. */
  actionChangedByLLM: boolean;
  /** Facts were insufficient: recommendation is "FIGHT — human review", never a silent OFFER/ACCEPT. */
  needsHumanReview: boolean;
  /** Seller actions PayPal currently allows for this dispute (from status, stage, allowed_response_options, links). */
  allowedActions: Action[];
  paypalStatus: string;
  lifecycleStage?: string;
}

/** What the server is about to send to PayPal for an approved action. Shown to the seller before sending. */
export interface OutboundRequest {
  method: "POST";
  path: string;
  contentType: "application/json" | "multipart/form-data";
  body: Record<string, unknown>;
}

export interface PayPalClient {
  readonly mode: "mock" | "sandbox";
  listOpenDisputes(): Promise<Dispute[]>;
  getDispute(id: string): Promise<Dispute>;
  getFacts(dispute: Dispute): Promise<OrderFacts>;
  send(disputeId: string, request: OutboundRequest): Promise<{ ok: true; status: number; body: unknown }>;
}
