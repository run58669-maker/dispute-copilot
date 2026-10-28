import { describe, expect, it } from "vitest";
import { NOTE_MAX, buildRequest, decideAction, evidencePlan, hoursLeft, offerAmount, ruleScore } from "./policy.js";
import type { Dispute } from "./types.js";

const base: Dispute = {
  dispute_id: "PP-D-1",
  create_time: "2026-10-01T00:00:00Z",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_amount: { currency_code: "USD", value: "100.00" },
};

describe("evidence plan", () => {
  it("asks for tracking proof on not-received and marks what is on hand", () => {
    const plan = evidencePlan("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", { carrier: "USPS", trackingNumber: "1", trackingStatus: "DELIVERED" });
    expect(plan.map((p) => p.evidence_type)).toEqual(["PROOF_OF_FULFILLMENT", "ONLINE_TRACKING_INFORMATION", "PROOF_OF_DELIVERY_SIGNATURE"]);
    expect(plan.map((p) => p.have)).toEqual([true, true, false]);
  });

  it("uses the digital-delivery checklist for digital goods", () => {
    expect(evidencePlan("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", { digitalGood: true })[0]?.evidence_type).toBe("PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED");
  });
});

describe("rule score and action", () => {
  it("scores a delivered, tracked parcel high enough to fight", () => {
    const { score, factors } = ruleScore(base, { carrier: "USPS", trackingNumber: "1", trackingStatus: "DELIVERED", deliveredToMatchingAddress: true });
    expect(score).toBeGreaterThanOrEqual(60);
    expect(factors.some((f) => f.label.startsWith("Delivered"))).toBe(true);
    expect(decideAction(score, 100).action).toBe("FIGHT");
  });

  it("scores no-tracking low and accepts", () => {
    const { score } = ruleScore(base, { trackingStatus: "NONE" });
    expect(score).toBeLessThan(30);
    expect(decideAction(score, 100).action).toBe("ACCEPT");
  });

  it("accepts tiny amounts regardless of score", () => {
    expect(decideAction(95, 9.99).action).toBe("ACCEPT");
  });

  it("offers half the disputed amount, to the cent", () => {
    expect(offerAmount({ currency_code: "USD", value: "64.50" })).toEqual({ currency_code: "USD", value: "32.25" });
  });

  it("computes hours left from the seller due date", () => {
    expect(hoursLeft({ ...base, seller_response_due_date: "2026-10-02T12:00:00Z" }, new Date("2026-10-01T00:00:00Z"))).toBe(36);
    expect(hoursLeft(base, new Date())).toBeNull();
  });
});

describe("request builder", () => {
  const facts = { carrier: "USPS", trackingNumber: "9400", trackingStatus: "DELIVERED" as const };
  const plan = evidencePlan("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", facts);

  it("builds provide-evidence with tracking info for FIGHT", () => {
    const req = buildRequest("PP-D-1", "FIGHT", "note", facts, plan);
    expect(req.path).toBe("/v1/customer/disputes/PP-D-1/provide-evidence");
    const evidences = (req.body.input as { evidences: Array<Record<string, unknown>> }).evidences;
    expect(evidences.map((e) => e.evidence_type)).toEqual(["PROOF_OF_FULFILLMENT", "ONLINE_TRACKING_INFORMATION"]);
    expect(evidences[0]?.evidence_info).toEqual({ tracking_info: [{ carrier_name: "USPS", tracking_number: "9400" }] });
  });

  it("builds make-offer and accept-claim, and caps notes at PayPal's limit", () => {
    const offer = buildRequest("PP-D-1", "OFFER", "x".repeat(5000), facts, plan, { currency_code: "USD", value: "50.00" });
    expect(offer.path.endsWith("/make-offer")).toBe(true);
    expect((offer.body.note as string).length).toBe(NOTE_MAX);
    expect(offer.body.offer_type).toBe("REFUND");
    expect(buildRequest("PP-D-1", "ACCEPT", "ok", facts, plan).path.endsWith("/accept-claim")).toBe(true);
  });

  it("rejects path-injection ids and fighting with no evidence", () => {
    expect(() => buildRequest("../../v1/payments", "ACCEPT", "ok", facts, plan)).toThrow(/Invalid dispute id/);
    expect(() => buildRequest("PP-D-1", "FIGHT", "ok", {}, evidencePlan("OTHER", {}))).toThrow(/No evidence/);
  });
});
