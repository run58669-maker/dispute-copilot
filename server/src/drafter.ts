import { LLM_MAX_ADJUST, clamp, truncateNote } from "./policy.js";
import type { Action, DisputeCase, EvidenceItem, Money, ScoreFactor } from "./types.js";

export interface DraftInput {
  kase: DisputeCase;
  action: Action;
  score: number;
  factors: ScoreFactor[];
  plan: EvidenceItem[];
  offer?: Money;
}

export interface DraftResult {
  draft: string;
  source: "llm" | "template";
  adjustment?: { delta: number; why: string };
}

export interface Drafter {
  readonly kind: "llm" | "template";
  draft(input: DraftInput): Promise<DraftResult>;
}

/** Facts as plain lines. The only material either drafter may cite. */
export function factLines(input: DraftInput): string[] {
  const { dispute, facts } = input.kase;
  const lines = [
    `Dispute ${dispute.dispute_id}, reason ${dispute.reason}, amount ${dispute.dispute_amount.value} ${dispute.dispute_amount.currency_code}.`,
  ];
  if (facts.itemTitle) lines.push(`Item: ${facts.itemTitle}${facts.digitalGood ? " (digital)" : ""}.`);
  if (facts.carrier && facts.trackingNumber) lines.push(`Shipped with ${facts.carrier}, tracking ${facts.trackingNumber}, status ${facts.trackingStatus ?? "unknown"}.`);
  if (facts.deliveredToMatchingAddress) lines.push("Delivered to the shipping address on the PayPal transaction.");
  if (facts.signatureOnDelivery) lines.push("Signature was collected on delivery.");
  if (facts.listingMatchesItem) lines.push("The listing description matches the item shipped.");
  if (facts.returnPolicyPublished) lines.push("A return policy was published on the listing.");
  if ((facts.priorPurchasesBySameBuyer ?? 0) > 0) lines.push(`The same buyer made ${facts.priorPurchasesBySameBuyer} earlier purchases without dispute.`);
  if (facts.buyerContactedSellerFirst === false) lines.push("The buyer did not contact the seller before opening the dispute.");
  if (facts.refundId) lines.push(`Refund ${facts.refundId} was issued.`);
  return lines;
}

export class TemplateDrafter implements Drafter {
  readonly kind = "template" as const;

  async draft(input: DraftInput): Promise<DraftResult> {
    const facts = factLines(input);
    let text: string;
    if (input.action === "FIGHT") {
      const have = input.plan.filter((item) => item.have).map((item) => item.evidence_type).join(", ");
      text = ["We respectfully ask PayPal to resolve this case in the seller's favour.", ...facts, `Evidence provided: ${have}.`].join("\n");
    } else if (input.action === "OFFER") {
      text = [
        `We are sorry about your experience. To resolve this quickly we offer a refund of ${input.offer?.value} ${input.offer?.currency_code}.`,
        ...facts.slice(1),
      ].join("\n");
    } else {
      text = "We accept this claim and have refunded the buyer. Thank you for your patience.";
    }
    return { draft: truncateNote(text), source: "template" };
  }
}

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

/** Any OpenAI-compatible /chat/completions endpoint (default: Gemini 2.5 Flash free tier). Falls back to the template on any failure. */
export class LlmDrafter implements Drafter {
  readonly kind = "llm" as const;
  private readonly fallback = new TemplateDrafter();

  constructor(private readonly config: LlmConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async draft(input: DraftInput): Promise<DraftResult> {
    const system = [
      "You are a PayPal dispute specialist working for a small online seller.",
      "Write the text the seller will submit to PayPal for the chosen action. Use ONLY the facts given; never invent tracking numbers, dates or events.",
      "Plain English, factual, polite, under 1200 characters.",
      `You may adjust the rule-based win score by an integer between -${LLM_MAX_ADJUST} and ${LLM_MAX_ADJUST} if the facts justify it; say why in one sentence.`,
      'Reply with JSON only: {"draft": string, "delta": integer, "why": string}.',
    ].join(" ");
    const user = [
      `Action: ${input.action}${input.offer ? ` (refund offer ${input.offer.value} ${input.offer.currency_code})` : ""}.`,
      `Rule score: ${input.score}. Factors: ${input.factors.map((f) => `${f.label} (${f.points >= 0 ? "+" : ""}${f.points})`).join("; ")}.`,
      `Evidence plan: ${input.plan.map((p) => `${p.evidence_type}=${p.have ? "have" : "missing"}`).join(", ")}.`,
      "Facts:",
      ...factLines(input),
      ...(input.kase.dispute.messages ?? []).map((m) => `Message from ${m.posted_by}: ${m.content.slice(0, 500)}`),
    ].join("\n");
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 20_000);
      const response = await this.fetchImpl(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);
      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const parsed = parseLlmJson(json.choices?.[0]?.message?.content ?? "");
      return { draft: truncateNote(parsed.draft), source: "llm", adjustment: { delta: parsed.delta, why: parsed.why } };
    } catch {
      return this.fallback.draft(input);
    }
  }
}

/** Strict parse of the model reply: unknown shapes throw (caller falls back), delta is clamped. */
export function parseLlmJson(content: string): { draft: string; delta: number; why: string } {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  const value = JSON.parse(stripped) as Record<string, unknown>;
  if (typeof value.draft !== "string" || value.draft.trim() === "") throw new Error("LLM draft missing");
  const delta = typeof value.delta === "number" && Number.isFinite(value.delta) ? Math.round(value.delta) : 0;
  return { draft: value.draft, delta: clamp(delta, -LLM_MAX_ADJUST, LLM_MAX_ADJUST), why: typeof value.why === "string" ? value.why.slice(0, 300) : "" };
}
