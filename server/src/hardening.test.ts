import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DisputeCopilot } from "./copilot.js";
import { LlmDrafter, TemplateDrafter } from "./drafter.js";
import { createApp, CSP } from "./index.js";
import { MockPayPalClient, PayPalHttpError, SandboxPayPalClient, paypalErrorReason } from "./paypal-client.js";
import { allowedActions, buildRequest, evidencePlan } from "./policy.js";
import type { Dispute, PayPalClient } from "./types.js";
import type { Drafter } from "./drafter.js";

const fixtures = resolve(import.meta.dirname, "..", "..", "fixtures", "disputes.json");
const NOW = new Date("2026-10-28T00:00:00Z");
const SANDBOX = "https://api-m.sandbox.paypal.com";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** Scripted fetch: routes by "METHOD path" prefix, records every call. */
function scripted(routes: Array<[string, (init: RequestInit) => Response | Promise<Response>]>) {
  const calls: Array<{ key: string; init: RequestInit }> = [];
  const impl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const key = `${init.method ?? "GET"} ${url.pathname}${url.search}`;
    calls.push({ key, init });
    const route = routes.find(([prefix]) => key.startsWith(prefix));
    if (!route) return json({ name: "RESOURCE_NOT_FOUND" }, 404);
    return route[1](init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const oauth = (expires = 3600): [string, () => Response] => ["POST /v1/oauth2/token", () => json({ access_token: `tok-${Math.random()}`, expires_in: expires })];
const client = (impl: typeof fetch, extra: Partial<ConstructorParameters<typeof SandboxPayPalClient>[0]> = {}) =>
  new SandboxPayPalClient({ clientId: "id", clientSecret: "secret", baseUrl: SANDBOX, retryDelayMs: 1, ...extra }, impl);
const bearer = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

const servers: Array<{ close: () => void }> = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));
function serve(paypal: PayPalClient, drafter: Drafter, options: Parameters<typeof createApp>[2] = {}) {
  const server = createApp(paypal, drafter, options).listen(0);
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { url, post };
}
const mock = () => MockPayPalClient.fromFile(fixtures, NOW);

describe("write auth gate", () => {
  it("refuses every write with 403 when ADMIN_TOKEN is unset, even with a header; preview stays open", async () => {
    const paypal = mock();
    const { url, post } = serve(paypal, new TemplateDrafter());
    const res = await post("/api/disputes/PP-D-MOCK-1004/approve", { action: "ACCEPT", draft: "ok" }, { "x-admin-token": "anything" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/Read-only demo/);
    expect(paypal.sent).toHaveLength(0);
    expect((await post("/api/disputes/PP-D-MOCK-1004/preview", { action: "ACCEPT", draft: "ok" })).status).toBe(200);
    expect(await (await fetch(`${url}/api/health`)).json()).toMatchObject({ writes: "read-only" });
  });

  it("requires the exact x-admin-token when one is configured", async () => {
    const paypal = mock();
    const { post } = serve(paypal, new TemplateDrafter(), { adminToken: "s3cret" });
    expect((await post("/api/disputes/PP-D-MOCK-1004/approve", { action: "ACCEPT", draft: "ok" })).status).toBe(403);
    expect((await post("/api/disputes/PP-D-MOCK-1004/approve", { action: "ACCEPT", draft: "ok" }, { "x-admin-token": "s3cre" })).status).toBe(403);
    expect((await post("/api/disputes/PP-D-MOCK-1004/approve", { action: "ACCEPT", draft: "ok" }, { "x-admin-token": "s3cret" })).status).toBe(200);
    expect(paypal.sent).toHaveLength(1);
  });
});

describe("rate limit and headers", () => {
  it("limits reads per IP and counts writes in their own bucket", async () => {
    const { url, post } = serve(mock(), new TemplateDrafter(), { rateLimit: { read: 3, write: 2 } });
    const reads = [];
    for (let i = 0; i < 4; i += 1) reads.push((await fetch(`${url}/api/disputes`)).status);
    expect(reads).toEqual([200, 200, 200, 429]);
    const writes = [];
    for (let i = 0; i < 3; i += 1) writes.push((await post("/api/disputes/PP-D-MOCK-1004/approve", { action: "ACCEPT", draft: "ok" })).status);
    expect(writes).toEqual([403, 403, 429]);
    expect((await fetch(`${url}/api/health`)).status).toBe(200); // health is exempt
  });

  it("defaults to 30 reads per minute", async () => {
    const { url } = serve(mock(), new TemplateDrafter());
    const statuses = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await fetch(`${url}/api/health-none`)).status);
    expect(statuses.slice(0, 30).every((s) => s !== 429)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("sends no-store on the API and security headers everywhere", async () => {
    const { url } = serve(mock(), new TemplateDrafter());
    const api = await fetch(`${url}/api/health`);
    expect(api.headers.get("cache-control")).toBe("no-store");
    const page = await fetch(`${url}/`);
    for (const res of [api, page]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      expect(res.headers.get("content-security-policy")).toBe(CSP);
    }
    expect(CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });
});

describe("SandboxPayPalClient (mocked fetch)", () => {
  it("fetches an OAuth token once and reuses it", async () => {
    const { impl, calls } = scripted([oauth(), ["GET /v1/customer/disputes/D-1", () => json({ dispute_id: "D-1" })]]);
    const pp = client(impl);
    await pp.getDispute("D-1");
    await pp.getDispute("D-1");
    expect(calls.filter((c) => c.key.startsWith("POST /v1/oauth2/token"))).toHaveLength(1);
    const tokenCall = calls[0]!;
    expect((tokenCall.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(tokenCall.init.body).toBe("grant_type=client_credentials");
  });

  it("refreshes a token that is about to expire, and after a 401", async () => {
    let n = 0;
    let first401 = true;
    const { impl, calls } = scripted([
      ["POST /v1/oauth2/token", () => json({ access_token: `tok-${++n}`, expires_in: 30 })], // < 60 s margin: refetch each time
      ["GET /v1/customer/disputes/D-1", () => json({ dispute_id: "D-1" })],
      ["GET /v1/customer/disputes/D-2", (init) => (bearer(init) === "Bearer tok-3" && first401 ? ((first401 = false), json({ name: "AUTHENTICATION_FAILURE" }, 401)) : json({ dispute_id: "D-2" }))],
    ]);
    const pp = client(impl);
    await pp.getDispute("D-1");
    await pp.getDispute("D-1");
    expect(n).toBe(2);
    expect((await pp.getDispute("D-2")).dispute_id).toBe("D-2");
    expect(n).toBe(4);
    expect(bearer(calls.at(-1)!.init)).toBe("Bearer tok-4");
  });

  it("surfaces an OAuth failure with PayPal's safe error code", async () => {
    const { impl } = scripted([["POST /v1/oauth2/token", () => json({ error: "invalid_client", error_description: "Client Authentication failed" }, 401)]]);
    await expect(client(impl).getDispute("D-1")).rejects.toMatchObject({ status: 401, reason: "invalid_client" });
  });

  it("follows list pagination via the next link, de-duplicates, and refuses foreign next links", async () => {
    const { impl, calls } = scripted([
      oauth(),
      ["GET /v1/customer/disputes?dispute_state=REQUIRED_ACTION&page_size=50", () => json({ items: [{ dispute_id: "D-1" }, { dispute_id: "D-2" }], links: [{ rel: "next", href: `${SANDBOX}/v1/customer/disputes?page=2` }] })],
      ["GET /v1/customer/disputes?page=2", () => json({ items: [{ dispute_id: "D-2" }, { dispute_id: "D-3" }, { dispute_id: "../x" }], links: [{ rel: "next", href: "https://evil.example/v1/customer/disputes?page=3" }] })],
      ["GET /v1/customer/disputes/D-", () => json({ dispute_id: "D" })],
    ]);
    const list = await client(impl).listOpenDisputes();
    expect(list).toHaveLength(3);
    expect(calls.map((c) => c.key).filter((k) => k.startsWith("GET /v1/customer/disputes/"))).toEqual(["GET /v1/customer/disputes/D-1", "GET /v1/customer/disputes/D-2", "GET /v1/customer/disputes/D-3"]);
    expect(calls.some((c) => c.key.includes("page=3"))).toBe(false);
  });

  it("stops paginating at maxPages", async () => {
    const { impl, calls } = scripted([oauth(), ["GET /v1/customer/disputes?", () => json({ items: [], links: [{ rel: "next", href: `${SANDBOX}/v1/customer/disputes?page=n` }] })]]);
    await client(impl, { maxPages: 2 }).listOpenDisputes();
    expect(calls.filter((c) => c.key.startsWith("GET /v1/customer/disputes?"))).toHaveLength(2);
  });

  it("uploads provide-evidence as multipart with the JSON input part and an idempotency key", async () => {
    const { impl, calls } = scripted([oauth(), ["POST /v1/customer/disputes/D-1/provide-evidence", () => json({ links: [] })]]);
    const facts = { carrier: "USPS", trackingNumber: "9400", trackingStatus: "DELIVERED" as const };
    const request = buildRequest("D-1", "FIGHT", "Delivered.", facts, evidencePlan("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", facts));
    const result = await client(impl).send("D-1", request);
    expect(result.status).toBe(200);
    const sent = calls.at(-1)!.init;
    expect(sent.body).toBeInstanceOf(FormData);
    const part = (sent.body as FormData).get("input") as Blob;
    expect(part.type).toBe("application/json");
    const input = JSON.parse(await part.text()) as { evidences: Array<{ evidence_type: string; notes: string; evidence_info?: unknown }> };
    expect(input.evidences.map((e) => e.evidence_type)).toEqual(["PROOF_OF_FULFILLMENT", "ONLINE_TRACKING_INFORMATION"]);
    expect(input.evidences[0]?.evidence_info).toEqual({ tracking_info: [{ carrier_name: "USPS", tracking_number: "9400" }] });
    const headers = sent.headers as Record<string, string>;
    expect(headers["PayPal-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers["Content-Type"]).toBeUndefined(); // fetch sets the multipart boundary itself
  });

  it("sends make-offer as JSON", async () => {
    const { impl, calls } = scripted([oauth(), ["POST /v1/customer/disputes/D-1/make-offer", () => json({})]]);
    await client(impl).send("D-1", buildRequest("D-1", "OFFER", "Half back.", {}, [], { currency_code: "USD", value: "5.00" }));
    const sent = calls.at(-1)!.init;
    expect((sent.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(sent.body))).toMatchObject({ offer_type: "REFUND", offer_amount: { currency_code: "USD", value: "5.00" } });
  });

  it("times out a hung request after timeoutMs", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(client(hang, { timeoutMs: 20 }).getDispute("D-1")).rejects.toMatchObject({ status: 504, reason: "timeout" });
  });

  it("never resends a write: a 503 on accept-claim is sent exactly once and reported as status unknown", async () => {
    const { impl, calls } = scripted([oauth(), ["POST /v1/customer/disputes/D-1/accept-claim", () => json({}, 503)]]);
    const error = (await client(impl).send("D-1", buildRequest("D-1", "ACCEPT", "We accept.", {}, [])).catch((e: unknown) => e)) as PayPalHttpError;
    expect(error).toBeInstanceOf(PayPalHttpError);
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/^Status unknown — verify in PayPal Resolution Center/);
    expect(calls.filter((c) => c.key.endsWith("/accept-claim"))).toHaveLength(1);
  });

  it("never resends a write that timed out (make-offer / provide-evidence)", async () => {
    for (const action of ["OFFER", "FIGHT"] as const) {
      const posts: string[] = [];
      const impl = (async (input: string, init: RequestInit = {}) => {
        const url = new URL(input);
        if (url.pathname === "/v1/oauth2/token") return json({ access_token: "t", expires_in: 3600 });
        posts.push(url.pathname);
        return new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
      }) as unknown as typeof fetch;
      const facts = { carrier: "USPS", trackingNumber: "9400", trackingStatus: "DELIVERED" as const };
      const request = buildRequest("D-1", action, "x", facts, evidencePlan("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", facts), { currency_code: "USD", value: "1.00" });
      await expect(client(impl, { timeoutMs: 20 }).send("D-1", request)).rejects.toMatchObject({ status: 502, reason: "timeout", message: expect.stringMatching(/^Status unknown/) });
      expect(posts).toHaveLength(1);
    }
  });

  it("HTTP: a write with unknown outcome answers 502 with the verify message", async () => {
    const { impl } = scripted([oauth(), ["POST /v1/customer/disputes/", () => json({}, 500)]]);
    const pp = client(impl);
    const kase = await mock().getDispute("PP-D-MOCK-1004");
    const paypal: PayPalClient = { mode: "sandbox", listOpenDisputes: async () => [kase], getDispute: async () => kase, getFacts: async () => ({}), send: (id, r) => pp.send(id, r) };
    const { post } = serve(paypal, new TemplateDrafter(), { adminToken: "t" });
    const preview = (await (await post("/api/disputes/PP-D-MOCK-1004/preview", { action: "ACCEPT", draft: "ok" })).json()) as { previewId?: string };
    const res = await post("/api/disputes/PP-D-MOCK-1004/approve", { action: "ACCEPT", draft: "ok", previewId: preview.previewId }, { "x-admin-token": "t" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/^Status unknown — verify in PayPal Resolution Center/);
  });

  it("after a second 429, surfaces status + safe reason fields only", async () => {
    const body = { name: "RATE_LIMIT_REACHED", message: "Too many requests.", debug_id: "abc", details: [{ issue: "RATE_LIMIT", description: "buyer jane@example.com" }], payer: { email: "jane@example.com" } };
    const { impl, calls } = scripted([oauth(), ["GET /v1/customer/disputes/D-1", () => json(body, 429, { "Retry-After": "0" })]]);
    const error = (await client(impl).getDispute("D-1").catch((e: unknown) => e)) as PayPalHttpError;
    expect(error).toBeInstanceOf(PayPalHttpError);
    expect(error.status).toBe(429);
    expect(error.reason).toBe("RATE_LIMIT_REACHED | Too many requests. | issues: RATE_LIMIT");
    expect(JSON.stringify(error.reason)).not.toContain("jane");
    expect(calls.filter((c) => c.key === "GET /v1/customer/disputes/D-1")).toHaveLength(2);
  });

  it("does not retry 4xx business errors", async () => {
    const { impl, calls } = scripted([oauth(), ["POST /v1/customer/disputes/D-1/make-offer", () => json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "NOT_ALLOWED_TO_MAKE_OFFER" }] }, 422)]]);
    await expect(client(impl).send("D-1", buildRequest("D-1", "OFFER", "x", {}, [], { currency_code: "USD", value: "1.00" }))).rejects.toMatchObject({
      status: 422,
      reason: "UNPROCESSABLE_ENTITY | issues: NOT_ALLOWED_TO_MAKE_OFFER",
    });
    expect(calls.filter((c) => c.key.endsWith("/make-offer"))).toHaveLength(1);
  });

  it("paypalErrorReason ignores non-objects and unknown fields", () => {
    expect(paypalErrorReason("oops")).toBeUndefined();
    expect(paypalErrorReason({ debug_id: "x" })).toBeUndefined();
  });
});

describe("getFacts (real mode, mocked fetch)", () => {
  const dispute = (txn?: string): Dispute => ({
    dispute_id: "D-1",
    create_time: "2026-10-01T00:00:00Z",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_amount: { currency_code: "USD", value: "80.00" },
    disputed_transactions: [{ ...(txn ? { seller_transaction_id: txn } : {}), items: [{ item_description: "Mug" }] }],
  });
  const capture: [string, () => Response] = ["GET /v2/payments/captures/CAP1", () => json({ id: "CAP1", supplementary_data: { related_ids: { order_id: "ORD1" } } })];

  it("walks capture -> order -> tracker into tracking facts", async () => {
    const { impl } = scripted([
      oauth(),
      capture,
      ["GET /v2/checkout/orders/ORD1", () => json({ purchase_units: [{ items: [{ name: "Ceramic mug", category: "PHYSICAL_GOODS" }], shipping: { trackers: [{ id: "CAP1-9400", status: "SHIPPED" }] } }] })],
      ["GET /v1/shipping/trackers/CAP1-9400", () => json({ carrier: "USPS", tracking_number: "9400", status: "DELIVERED" })],
    ]);
    expect(await client(impl).getFacts(dispute("CAP1"))).toEqual({ itemTitle: "Ceramic mug", carrier: "USPS", trackingNumber: "9400", trackingStatus: "DELIVERED" });
  });

  it("marks facts unknown without a seller transaction, when the capture is unreadable, or when nothing was tracked", async () => {
    const none = scripted([oauth()]);
    expect(await client(none.impl).getFacts(dispute())).toMatchObject({ unknown: true, unknownReason: expect.stringMatching(/no seller transaction/) });
    expect(none.calls).toHaveLength(0);

    const missing = scripted([oauth()]); // capture -> 404
    expect(await client(missing.impl).getFacts(dispute("CAP1"))).toMatchObject({ unknown: true, unknownReason: expect.stringMatching(/Capture CAP1 not readable \(HTTP 404\)/) });

    const untracked = scripted([oauth(), capture, ["GET /v2/checkout/orders/ORD1", () => json({ purchase_units: [{ items: [{ name: "Mug", category: "PHYSICAL_GOODS" }] }] })]]);
    expect(await client(untracked.impl).getFacts(dispute("CAP1"))).toMatchObject({ itemTitle: "Mug", unknown: true, unknownReason: expect.stringMatching(/No shipment tracking/) });
  });

  it("propagates a PayPal outage instead of pretending facts are unknown", async () => {
    const { impl } = scripted([oauth(), ["GET /v2/payments/captures/CAP1", () => json({ name: "INTERNAL_SERVER_ERROR" }, 500)]]);
    await expect(client(impl).getFacts(dispute("CAP1"))).rejects.toMatchObject({ status: 500, reason: "INTERNAL_SERVER_ERROR" });
  });

  it("unknown facts route to FIGHT + human review, never a silent OFFER/ACCEPT", async () => {
    const { impl } = scripted([oauth()]);
    const copilot = new DisputeCopilot(client(impl), new TemplateDrafter(), () => NOW);
    const rec = await copilot.recommend({ dispute: dispute("CAP1"), facts: await client(impl).getFacts(dispute("CAP1")) });
    expect(rec).toMatchObject({ action: "FIGHT", needsHumanReview: true, actionChangedByLLM: false });
    expect(rec.actionReason).toMatch(/^Insufficient facts/);
  });
});

describe("allowed actions", () => {
  it("reads status, allowed_response_options and links", async () => {
    const paypal = mock();
    expect(allowedActions(await paypal.getDispute("PP-D-MOCK-1001"))).toEqual(["FIGHT", "OFFER", "ACCEPT"]);
    expect(allowedActions(await paypal.getDispute("PP-D-MOCK-1003"))).toEqual(["FIGHT", "ACCEPT"]); // chargeback: no offers
    expect(allowedActions({ ...(await paypal.getDispute("PP-D-MOCK-1001")), status: "UNDER_REVIEW" })).toEqual([]);
    expect(allowedActions({ dispute_id: "x", create_time: "", reason: "OTHER", status: "WAITING_FOR_SELLER_RESPONSE", dispute_amount: { currency_code: "USD", value: "1" } })).toEqual([]);
  });

  it("refuses to preview or approve an action PayPal does not allow, and lists what is allowed", async () => {
    const { post } = serve(mock(), new TemplateDrafter(), { adminToken: "t" });
    const res = await post("/api/disputes/PP-D-MOCK-1003/preview", { action: "OFFER", draft: "half" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Allowed: FIGHT, ACCEPT/);
    expect((await post("/api/disputes/PP-D-MOCK-1003/approve", { action: "OFFER", draft: "half" }, { "x-admin-token": "t" })).status).toBe(409);
  });

  it("puts allowed actions, reason and currency on every queue row", async () => {
    const queue = await new DisputeCopilot(mock(), new TemplateDrafter(), () => NOW).queue();
    const row = queue.find((r) => r.disputeId === "PP-D-MOCK-1003")!;
    expect(row).toMatchObject({ allowedActions: ["FIGHT", "ACCEPT"], reason: "UNAUTHORISED", currency: "USD", paypalStatus: "WAITING_FOR_SELLER_RESPONSE", lifecycleStage: "CHARGEBACK" });
  });
});

describe("AI-changed recommendation", () => {
  const cfg = { apiKey: "k", baseUrl: "https://llm.example", model: "m" };
  const minus15 = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ assessment: "a", draft: "We accept.", delta: -15, why: "Buyer photos look convincing." }) } }] }))) as unknown as typeof fetch;

  it("flags a flip and requires an explicit confirm to approve", async () => {
    const paypal = mock();
    const drafter = new LlmDrafter(cfg, minus15);
    const rec = await new DisputeCopilot(paypal, drafter, () => NOW).recommend(await paypal.getDispute("PP-D-MOCK-1002").then(async (d) => ({ dispute: d, facts: await paypal.getFacts(d) })));
    expect(rec).toMatchObject({ rulesAction: "OFFER", action: "ACCEPT", actionChangedByLLM: true });

    const { post } = serve(paypal, drafter, { adminToken: "t" });
    const blocked = await post("/api/disputes/PP-D-MOCK-1002/approve", { action: "ACCEPT", draft: "We accept." }, { "x-admin-token": "t" });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/AI changed the recommendation from OFFER to ACCEPT/);
    expect(paypal.sent).toHaveLength(0);
    const ok = await post("/api/disputes/PP-D-MOCK-1002/approve", { action: "ACCEPT", draft: "We accept.", confirmAiChange: true }, { "x-admin-token": "t" });
    expect(ok.status).toBe(200);
  });

  it("does not flag when the model keeps the action", async () => {
    const queue = await new DisputeCopilot(mock(), new TemplateDrafter(), () => NOW).queue();
    expect(queue.every((r) => !r.actionChangedByLLM && r.rulesAction === r.action)).toBe(true);
  });
});

describe("judge fixes", () => {
  it("accept note is factual: no claim that the buyer was already refunded", async () => {
    const paypal = mock();
    const rec = await new DisputeCopilot(paypal, new TemplateDrafter(), () => NOW).recommend(await paypal.getDispute("PP-D-MOCK-1004").then(async (d) => ({ dispute: d, facts: await paypal.getFacts(d) })));
    expect(rec.action).toBe("ACCEPT");
    expect(rec.draft).toBe("We accept this claim. The refund of 42.00 USD will be issued through PayPal.");
    expect(rec.draft).not.toMatch(/refunded/);
  });

  it("puts the seller note on one evidence item only; others keep their own explanation", () => {
    const facts = { carrier: "USPS", trackingNumber: "9400", trackingStatus: "DELIVERED" as const, signatureOnDelivery: true };
    const plan = evidencePlan("MERCHANDISE_OR_SERVICE_NOT_RECEIVED", facts);
    const note = "n".repeat(1500);
    const evidences = (buildRequest("D-1", "FIGHT", note, facts, plan).body.input as { evidences: Array<{ notes: string }> }).evidences;
    expect(evidences).toHaveLength(3);
    expect(evidences.filter((e) => e.notes === note)).toHaveLength(1);
    expect(evidences.slice(1).map((e) => e.notes)).toEqual([plan[1]!.why, plan[2]!.why]);
  });

  it("mock demo state resets every 10 minutes so the queue is never left empty", async () => {
    let t = 0;
    const paypal = MockPayPalClient.fromFile(fixtures, NOW, { resetEveryMs: 600_000, clock: () => t });
    const copilot = new DisputeCopilot(paypal, new TemplateDrafter(), () => NOW);
    await copilot.approve("PP-D-MOCK-1004", "ACCEPT", "ok");
    expect(await paypal.listOpenDisputes()).toHaveLength(4);
    t = 599_999;
    expect(await paypal.listOpenDisputes()).toHaveLength(4);
    t = 600_000;
    expect(await paypal.listOpenDisputes()).toHaveLength(5);
    expect(paypal.sent).toHaveLength(0);
  });

  it("HTTP: upstream PayPal errors surface as {status, reason} with 502 for 5xx", async () => {
    const failing: PayPalClient = {
      mode: "sandbox",
      listOpenDisputes: async () => {
        throw new PayPalHttpError(503, "PayPal GET /v1/customer/disputes -> 503", "SERVICE_UNAVAILABLE");
      },
      getDispute: async () => {
        throw new PayPalHttpError(404, "nope");
      },
      getFacts: async () => ({}),
      send: async () => ({ ok: true, status: 200, body: {} }),
    };
    const { url } = serve(failing, new TemplateDrafter());
    const res = await fetch(`${url}/api/disputes`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "PayPal GET /v1/customer/disputes -> 503", status: 503, reason: "SERVICE_UNAVAILABLE" });
  });
});
