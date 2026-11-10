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

  it("classifies timeout, parse and other failures; caps the message at 400 chars", async () => {
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
    expect(c.status().llmLastError?.message.length).toBeLessThanOrEqual(400);
  });

  it("records llmLastOkAt on success and exposes both through /api/health", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const drafter = new LlmDrafter(cfg, (async () => (fail ? new Response("nope", { status: 500 }) : okBody())) as unknown as typeof fetch, noSleep);
    const server = createApp(MockPayPalClient.fromFile(fixtures, NOW), drafter).listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${url}/api/health`)).json()).toEqual({ ok: true, paypal: "mock", drafter: "llm", llmModels: ["m"], llmExhausted: [], llmUnavailable: [], writes: "read-only" });
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

describe("LLM model fallback chain", () => {
  const chainCfg = { ...cfg, model: "a", fallbackModels: ["b", "c"] };
  const quota = () => new Response(JSON.stringify([{ error: { message: "You exceeded your current quota. * Quota exceeded for metric: generate_content_free_tier_requests" } }]), { status: 429 });
  const modelOf = (init: RequestInit) => (JSON.parse(String(init.body)) as { model: string }).model;
  /** fetch that answers per model. */
  function router(plan: Record<string, "ok" | "quota" | "404" | "badkey">, seen: string[]) {
    return (async (_u: string, init: RequestInit) => {
      const m = modelOf(init);
      seen.push(m);
      const r = plan[m];
      if (r === "ok") return okBody();
      if (r === "quota") return quota();
      if (r === "404") return new Response(JSON.stringify({ error: { message: "models/" + m + " is not found for API version v1beta" } }), { status: 404 });
      return new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 });
    }) as unknown as typeof fetch;
  }

  it("advances to the next model on a 429 and reports which model wrote the draft", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    const drafter = new LlmDrafter(chainCfg, router({ a: "quota", b: "ok", c: "ok" }, seen), noSleep);
    const result = await drafter.draft(await input("PP-D-MOCK-1001"));
    expect(result).toMatchObject({ source: "llm", model: "b" });
    expect(seen).toEqual(["a", "a", "b"]); // a: first call + one retry (no stated delay: 2 s), then b
    expect(drafter.status().llmLastError).toMatchObject({ model: "a", status: 429 });
    expect(drafter.status().llmLastError?.message).toContain("Quota exceeded for metric");
  });

  it("skips an exhausted model for 15 minutes, then tries it again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let t = Date.parse("2026-11-10T10:00:00Z");
    const seen: string[] = [];
    const plan: Record<string, "ok" | "quota"> = { a: "quota", b: "ok" };
    const drafter = new LlmDrafter({ ...cfg, model: "a", fallbackModels: ["b"] }, router(plan, seen), noSleep, () => t);
    await drafter.draft(await input("PP-D-MOCK-1001"));
    expect(seen).toEqual(["a", "a", "b"]);
    expect(drafter.status().llmExhausted).toEqual([{ model: "a", until: "2026-11-10T10:15:00.000Z" }]);
    seen.length = 0;
    t += 14 * 60_000;
    expect((await drafter.draft(await input("PP-D-MOCK-1002"))).model).toBe("b");
    expect(seen).toEqual(["b"]); // a is skipped: no wasted call
    seen.length = 0;
    t += 61_000; // 15 min 1 s after the first failure
    plan.a = "ok";
    expect((await drafter.draft(await input("PP-D-MOCK-1003"))).model).toBe("a");
    expect(seen).toEqual(["a"]);
    expect(drafter.status().llmExhausted).toEqual([]);
  });

  it("moves on when a model is not found (404 or 400 model not found), but not on a bad key", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    const nf = new LlmDrafter(chainCfg, router({ a: "404", b: "ok" }, seen), noSleep);
    expect(await nf.draft(await input("PP-D-MOCK-1001"))).toMatchObject({ source: "llm", model: "b" });
    expect(seen).toEqual(["a", "b"]);
    const seen2: string[] = [];
    const bad = new LlmDrafter(chainCfg, router({ a: "badkey", b: "ok" }, seen2), noSleep);
    expect((await bad.draft(await input("PP-D-MOCK-1001"))).source).toBe("template");
    expect(seen2).toEqual(["a"]);
    const seen3: string[] = [];
    const f400 = (async (_u: string, init: RequestInit) => {
      seen3.push(modelOf(init));
      return modelOf(init) === "a" ? new Response(JSON.stringify({ error: { message: "Invalid model name: a" } }), { status: 400 }) : okBody();
    }) as unknown as typeof fetch;
    expect((await new LlmDrafter(chainCfg, f400, noSleep).draft(await input("PP-D-MOCK-1001"))).model).toBe("b");
    expect(seen3).toEqual(["a", "b"]);
  });

  it("skips a model that answered not-found for the rest of the process and lists it as llmUnavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    const drafter = new LlmDrafter(chainCfg, router({ a: "404", b: "ok" }, seen), noSleep);
    await drafter.draft(await input("PP-D-MOCK-1001"));
    await drafter.draft(await input("PP-D-MOCK-1002"));
    expect(seen).toEqual(["a", "b", "b"]);
    expect(drafter.status().llmUnavailable).toEqual(["a"]);
    expect(drafter.status().llmExhausted).toEqual([]);
  });

  it("falls back to the template when every model fails, without a model name", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    const drafter = new LlmDrafter(chainCfg, router({ a: "quota", b: "404", c: "quota" }, seen), noSleep);
    const result = await drafter.draft(await input("PP-D-MOCK-1001"));
    expect(result.source).toBe("template");
    expect(result.model).toBeUndefined();
    expect(drafter.status().llmExhausted?.map((e) => e.model)).toEqual(["a", "c"]);
    seen.length = 0;
    expect((await drafter.draft(await input("PP-D-MOCK-1002"))).source).toBe("template");
    expect(seen).toEqual([]); // quota-exhausted and not-found models are all skipped
  });

  it("caches by dispute state, not by model; draftModel reaches the recommendation and /api/health", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const seen: string[] = [];
    const plan: Record<string, "ok" | "quota"> = { a: "quota", b: "ok" };
    const drafter = new LlmDrafter({ ...cfg, model: "a", fallbackModels: ["b"] }, router(plan, seen), noSleep);
    const k = await input("PP-D-MOCK-1001");
    await drafter.draft(k);
    seen.length = 0;
    plan.a = "ok"; // even with a recovered, the draft written by b is reused
    expect((await drafter.draft(k)).model).toBe("b");
    expect(seen).toEqual([]);
    const copilot = new DisputeCopilot(MockPayPalClient.fromFile(fixtures, NOW), drafter, () => NOW);
    const queue = await copilot.queue();
    expect(queue.every((r) => r.draftSource === "llm" && typeof r.draftModel === "string")).toBe(true);
    const server = createApp(MockPayPalClient.fromFile(fixtures, NOW), drafter).listen(0);
    try {
      const h = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/health`)).json()) as Record<string, unknown>;
      expect(h.llmModels).toEqual(["a", "b"]);
      expect(h.llmExhausted).toHaveLength(1);
      expect(h.llmLastError).toMatchObject({ model: "a", status: 429 });
    } finally {
      server.close();
    }
  });
});
