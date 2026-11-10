import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisputeCopilot } from "./copilot.js";
import { LLM_CONCURRENCY, LlmDrafter, RETRY_CAP_MS, retryDelayMs, scrubMessage, type DraftInput } from "./drafter.js";
import { createApp } from "./index.js";
import { decideAction, evidencePlan, ruleScore } from "./policy.js";
import { MockPayPalClient } from "./paypal-client.js";

const fixtures = resolve(import.meta.dirname, "..", "..", "fixtures", "disputes.json");
const NOW = new Date("2026-10-28T00:00:00Z");
const KEY = "AIzaSyTESTKEY1234567890abcdef";
const cfg = { apiKey: KEY, baseUrl: "https://llm.example", model: "m" };
const okBody = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ assessment: "a", draft: "d" }) } }] }));
const noSleep = async () => {};

async function input(id: string): Promise<DraftInput> {
  const client = MockPayPalClient.fromFile(fixtures, NOW);
  const dispute = await client.getDispute(id);
  const kase = { dispute: structuredClone(dispute), facts: await client.getFacts(dispute) };
  const { score, factors } = ruleScore(kase.dispute, kase.facts);
  return { kase, action: decideAction(score, Number(kase.dispute.dispute_amount.value)).action, score, factors, plan: evidencePlan(kase.dispute.reason, kase.facts) };
}

afterEach(() => vi.restoreAllMocks());

describe("LLM failure diagnostics", () => {
  it("records an HTTP failure without the key, URL or headers, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify([{ error: { code: 400, message: `API key not valid ${KEY}. See https://llm.example/v1?key=${KEY}`, status: "INVALID_ARGUMENT" } }]);
    const drafter = new LlmDrafter(cfg, (async () => new Response(body, { status: 400 })) as unknown as typeof fetch, noSleep);
    expect((await drafter.draft(await input("PP-D-MOCK-1001"))).source).toBe("template");
    const s = drafter.status();
    expect(s.llmLastError).toMatchObject({ kind: "http", status: 400 });
    expect(s.llmLastError?.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(s.llmLastOkAt).toBeUndefined();
    const dump = JSON.stringify(s) + warn.mock.calls.flat().join(" ");
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("llm.example");
    expect(dump).not.toMatch(/Bearer|authorization/i);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("classifies timeout, parse and other failures; caps the message at 200 chars", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const k = await input("PP-D-MOCK-1001");
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const a = new LlmDrafter({ ...cfg, timeoutMs: 20 }, hang, noSleep);
    await a.draft(k);
    expect(a.status().llmLastError?.kind).toBe("timeout");
    const b = new LlmDrafter(cfg, (async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }))) as unknown as typeof fetch, noSleep);
    await b.draft(k);
    expect(b.status().llmLastError?.kind).toBe("parse");
    const c = new LlmDrafter(cfg, (async () => {
      throw new TypeError(`fetch failed ${"x".repeat(500)}`);
    }) as unknown as typeof fetch, noSleep);
    await c.draft(k);
    expect(c.status().llmLastError?.kind).toBe("other");
    expect(c.status().llmLastError?.message.length).toBeLessThanOrEqual(200);
  });

  it("records llmLastOkAt on success and exposes both through /api/health", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const drafter = new LlmDrafter(cfg, (async () => (fail ? new Response("nope", { status: 500 }) : okBody())) as unknown as typeof fetch, noSleep);
    const server = createApp(MockPayPalClient.fromFile(fixtures, NOW), drafter).listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ ok: true, paypal: "mock", drafter: "llm", writes: "read-only" });
      await drafter.draft(await input("PP-D-MOCK-1001"));
      const h1 = (await (await fetch(`${url}/api/health`)).json()) as Record<string, unknown>;
      expect(h1.llmLastError).toMatchObject({ kind: "http", status: 500 });
      expect(h1).not.toHaveProperty("llmLastOkAt");
      fail = false;
      await drafter.draft(await input("PP-D-MOCK-1002"));
      const h2 = (await (await fetch(`${url}/api/health`)).json()) as Record<string, unknown>;
      expect(typeof h2.llmLastOkAt).toBe("string");
      expect(h2.llmLastError).toBeDefined(); // last failure stays visible
    } finally {
      server.close();
    }
  });
});

describe("LLM concurrency and 429 retry", () => {
  it("parses retry delays from header and body", () => {
    expect(retryDelayMs("3", "")).toBe(3000);
    expect(retryDelayMs(null, "Please retry in 12.3s.")).toBe(12300);
    expect(retryDelayMs(null, '{"retryDelay": "7s"}')).toBe(7000);
    expect(retryDelayMs(null, "boom")).toBeUndefined();
    expect(scrubMessage("see https://a.b/c?key=abc and key=zzz", "")).toBe("see [url] and key=[redacted]");
  });

  it("runs at most LLM_CONCURRENCY calls at once", async () => {
    let active = 0;
    let peak = 0;
    const slow = (async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      return okBody();
    }) as unknown as typeof fetch;
    const drafter = new LlmDrafter(cfg, slow, noSleep);
    const copilot = new DisputeCopilot(MockPayPalClient.fromFile(fixtures, NOW), drafter, () => NOW);
    const queue = await copilot.queue();
    expect(queue.every((r) => r.draftSource === "llm")).toBe(true);
    expect(peak).toBe(LLM_CONCURRENCY);
  });

  it("retries a 429 once after the stated delay, then succeeds", async () => {
    let calls = 0;
    const slept: number[] = [];
    const f = (async () => {
      calls += 1;
      return calls === 1 ? new Response(JSON.stringify([{ error: { message: "Quota exceeded. Please retry in 4.2s." } }]), { status: 429 }) : okBody();
    }) as unknown as typeof fetch;
    const drafter = new LlmDrafter(cfg, f, async (ms) => void slept.push(ms));
    expect((await drafter.draft(await input("PP-D-MOCK-1001"))).source).toBe("llm");
    expect(calls).toBe(2);
    expect(slept).toEqual([4200]);
    expect(drafter.status().llmLastError).toBeUndefined();
  });

  it("does not retry when the stated delay exceeds the cap, and retries only once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const long = (async () => {
      calls += 1;
      return new Response("retry in 30s", { status: 429 });
    }) as unknown as typeof fetch;
    const a = new LlmDrafter(cfg, long, noSleep);
    expect((await a.draft(await input("PP-D-MOCK-1001"))).source).toBe("template");
    expect(calls).toBe(1);
    expect(RETRY_CAP_MS).toBe(10_000);
    calls = 0;
    const short = (async () => {
      calls += 1;
      return new Response("retry in 1s", { status: 429 });
    }) as unknown as typeof fetch;
    const b = new LlmDrafter(cfg, short, noSleep);
    await b.draft(await input("PP-D-MOCK-1001"));
    expect(calls).toBe(2);
    expect(b.status().llmLastError).toMatchObject({ kind: "http", status: 429 });
  });
});
