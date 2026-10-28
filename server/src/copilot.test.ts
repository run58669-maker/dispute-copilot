import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DisputeCopilot } from "./copilot.js";
import { LlmDrafter, TemplateDrafter, parseLlmJson } from "./drafter.js";
import { createApp } from "./index.js";
import { MockPayPalClient, SandboxPayPalClient } from "./paypal-client.js";

const fixtures = resolve(import.meta.dirname, "..", "..", "fixtures", "disputes.json");
const NOW = new Date("2026-10-28T00:00:00Z");

describe("copilot on mock fixtures", () => {
  it("ranks the queue by urgency and recommends fight / offer / accept", async () => {
    const copilot = new DisputeCopilot(MockPayPalClient.fromFile(fixtures, NOW), new TemplateDrafter(), () => NOW);
    const queue = await copilot.queue();
    expect(queue).toHaveLength(5);
    expect(queue[0]?.disputeId).toBe("PP-D-MOCK-1003"); // 12 h left
    const byId = Object.fromEntries(queue.map((r) => [r.disputeId, r]));
    expect(byId["PP-D-MOCK-1001"]?.action).toBe("FIGHT");
    expect(byId["PP-D-MOCK-1002"]?.action).toBe("OFFER");
    expect(byId["PP-D-MOCK-1002"]?.offerAmount).toEqual({ currency_code: "USD", value: "32.25" });
    expect(byId["PP-D-MOCK-1004"]?.action).toBe("ACCEPT");
    expect(byId["PP-D-MOCK-1005"]?.action).toBe("ACCEPT");
    expect(queue.every((r) => r.draft.length > 0 && r.draftSource === "template")).toBe(true);
  });

  it("only sends after approve, and the dispute leaves the queue", async () => {
    const paypal = MockPayPalClient.fromFile(fixtures, NOW);
    const copilot = new DisputeCopilot(paypal, new TemplateDrafter(), () => NOW);
    await copilot.queue();
    await copilot.preview("PP-D-MOCK-1001", "FIGHT", "Delivered per USPS tracking.");
    expect(paypal.sent).toHaveLength(0);
    const result = await copilot.approve("PP-D-MOCK-1001", "FIGHT", "Delivered per USPS tracking.");
    expect(result.request.path).toBe("/v1/customer/disputes/PP-D-MOCK-1001/provide-evidence");
    expect(paypal.sent).toHaveLength(1);
    expect((await copilot.queue()).map((r) => r.disputeId)).not.toContain("PP-D-MOCK-1001");
  });
});

describe("LLM drafter", () => {
  it("parses fenced JSON and clamps the score adjustment", () => {
    expect(parseLlmJson('```json\n{"draft":"hi","delta":40,"why":"w"}\n```')).toEqual({ draft: "hi", delta: 15, why: "w" });
    expect(() => parseLlmJson('{"delta":1}')).toThrow();
  });

  it("applies the model's adjustment and redrafts when the action flips", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      calls.push(body.messages[1]?.content.split("\n")[0] ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ draft: "LLM text", delta: 15, why: "Buyer admitted receipt." }) } }] }));
    }) as typeof fetch;
    const copilot = new DisputeCopilot(MockPayPalClient.fromFile(fixtures, NOW), new LlmDrafter({ apiKey: "k", baseUrl: "https://llm.example", model: "m" }, fakeFetch), () => NOW);
    const kase = await copilot.loadCase("PP-D-MOCK-1002"); // rule score 42 → OFFER; +15 → 57, still OFFER
    const rec = await copilot.recommend(kase);
    expect(rec.score).toBe(57);
    expect(rec.draftSource).toBe("llm");
    expect(rec.llmAdjustment?.why).toBe("Buyer admitted receipt.");
    expect(calls).toHaveLength(1);
  });

  it("falls back to the template when the model call fails", async () => {
    const failing = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const copilot = new DisputeCopilot(MockPayPalClient.fromFile(fixtures, NOW), new LlmDrafter({ apiKey: "k", baseUrl: "https://llm.example", model: "m" }, failing), () => NOW);
    const rec = await copilot.recommend(await copilot.loadCase("PP-D-MOCK-1001"));
    expect(rec.draftSource).toBe("template");
    expect(rec.action).toBe("FIGHT");
  });
});

describe("safety", () => {
  it("refuses a live PayPal base URL", () => {
    expect(() => new SandboxPayPalClient({ clientId: "a", clientSecret: "b", baseUrl: "https://api-m.paypal.com" })).toThrow(/sandbox/);
  });

  it("HTTP API: health, queue, validation and approve", async () => {
    const server = createApp(MockPayPalClient.fromFile(fixtures, NOW), new TemplateDrafter()).listen(0);
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    try {
      expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ ok: true, paypal: "mock", drafter: "template" });
      const queue = (await (await fetch(`${url}/api/disputes`)).json()) as { items: unknown[] };
      expect(queue.items).toHaveLength(5);
      const bad = await fetch(`${url}/api/disputes/PP-D-MOCK-1001/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "DELETE", draft: "x" }) });
      expect(bad.status).toBe(400);
      const missing = await fetch(`${url}/api/disputes/NOPE-1/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ACCEPT", draft: "x" }) });
      expect(missing.status).toBe(404);
      const ok = await fetch(`${url}/api/disputes/PP-D-MOCK-1004/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ACCEPT", draft: "Refunding now." }) });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { request: { path: string } }).request.path).toBe("/v1/customer/disputes/PP-D-MOCK-1004/accept-claim");
    } finally {
      server.close();
    }
  });
});
