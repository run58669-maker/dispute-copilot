import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DisputeCopilot } from "./copilot.js";
import { LlmDrafter, TemplateDrafter, type Drafter } from "./drafter.js";
import { MockPayPalClient, PayPalHttpError, SandboxPayPalClient } from "./paypal-client.js";
import type { Action, PayPalClient } from "./types.js";

const ACTIONS: readonly Action[] = ["FIGHT", "OFFER", "ACCEPT"];
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
/** Public demo: approvals made in mock mode are undone on this interval. */
export const MOCK_RESET_MS = 10 * 60_000;

export function createPayPal(env: NodeJS.ProcessEnv): PayPalClient {
  // MODE=mock forces fixtures even when sandbox credentials are present (public demo deploy).
  if (env.MODE !== "mock" && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    return new SandboxPayPalClient({
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      baseUrl: env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com",
    });
  }
  return MockPayPalClient.fromFile(resolve(root, "fixtures", "disputes.json"), new Date(), { resetEveryMs: MOCK_RESET_MS });
}

export function createDrafter(env: NodeJS.ProcessEnv): Drafter {
  if (env.LLM_API_KEY) {
    return new LlmDrafter({
      apiKey: env.LLM_API_KEY,
      baseUrl: env.LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
      model: env.LLM_MODEL || "gemini-2.5-flash",
    });
  }
  return new TemplateDrafter();
}

function parseApproval(body: unknown): { action: Action; draft: string; confirmAiChange: boolean } {
  const { action, draft, confirmAiChange } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) throw new PayPalHttpError(400, "action must be FIGHT, OFFER or ACCEPT.");
  if (typeof draft !== "string" || draft.trim().length === 0 || draft.length > 4000) throw new PayPalHttpError(400, "draft must be 1-4000 characters.");
  return { action: action as Action, draft, confirmAiChange: confirmAiChange === true };
}

export interface AppOptions {
  /** Shared secret for write actions (header `x-admin-token`). Unset = the server refuses every write. */
  adminToken?: string;
  /** Per-IP requests per minute on /api. */
  rateLimit?: { read: number; write: number; windowMs?: number };
}

/** Fixed-window per-IP limiter; reads and writes are counted in separate buckets. */
export function rateLimiter(limits: { read: number; write: number; windowMs?: number }, isWrite: (req: Request) => boolean): RequestHandler {
  const windowMs = limits.windowMs ?? 60_000;
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 10_000) for (const [key, hit] of hits) if (hit.resetAt <= now) hits.delete(key);
    const write = isWrite(req);
    const key = `${write ? "w" : "r"}|${req.ip ?? "unknown"}`;
    let hit = hits.get(key);
    if (!hit || hit.resetAt <= now) {
      hit = { count: 0, resetAt: now + windowMs };
      hits.set(key, hit);
    }
    hit.count += 1;
    const limit = write ? limits.write : limits.read;
    res.setHeader("RateLimit-Limit", String(limit));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, limit - hit.count)));
    if (hit.count > limit) {
      res.setHeader("Retry-After", String(Math.ceil((hit.resetAt - now) / 1000)));
      res.status(429).json({ error: `Too many ${write ? "write" : "read"} requests; limit ${limit}/min.` });
      return;
    }
    next();
  };
}

function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  // AG Grid's quartz theme embeds its icon font and a few images as data: URLs; nothing else is loaded.
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function createApp(paypal: PayPalClient, drafter: Drafter, options: AppOptions = {}) {
  const copilot = new DisputeCopilot(paypal, drafter);
  const adminToken = options.adminToken || undefined;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render terminates TLS in front of us; req.ip is the client from X-Forwarded-For.

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", CSP);
    next();
  });

  const isWrite = (req: Request) => req.method === "POST" && /\/approve$/.test(req.path);
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  // Health stays outside the limiter so the platform health check never trips it.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, paypal: paypal.mode, drafter: drafter.kind, writes: adminToken ? "token" : "read-only" });
  });
  app.use("/api", rateLimiter(options.rateLimit ?? { read: 30, write: 5 }, isWrite));
  app.use(express.json({ limit: "32kb" }));

  const requireAdmin: RequestHandler = (req, res, next) => {
    if (!adminToken) {
      res.status(403).json({ error: "Read-only demo: write actions are disabled on this server." });
      return;
    }
    if (!tokenMatches(adminToken, req.get("x-admin-token"))) {
      res.status(403).json({ error: "Missing or wrong admin token." });
      return;
    }
    next();
  };

  app.get("/api/disputes", async (_req, res, next) => {
    try {
      res.json({ mode: paypal.mode, drafter: drafter.kind, writes: adminToken ? "token" : "read-only", items: await copilot.queue() });
    } catch (error) {
      next(error);
    }
  });

  // Preview never touches PayPal state (it only builds the request), so it stays open in the read-only demo.
  app.post("/api/disputes/:id/preview", async (req, res, next) => {
    try {
      const { action, draft } = parseApproval(req.body);
      res.json({ request: await copilot.preview(String(req.params.id), action, draft) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/disputes/:id/approve", requireAdmin, async (req, res, next) => {
    try {
      const { action, draft, confirmAiChange } = parseApproval(req.body);
      res.json(await copilot.approve(String(req.params.id), action, draft, confirmAiChange));
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(resolve(root, "dist", "web")));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof PayPalHttpError) {
      // Upstream failures surface PayPal's status and the safe reason fields only (no bodies, no tokens).
      const status = error.status >= 500 ? 502 : error.status;
      res.status(status).json({ error: error.message, status: error.status, ...(error.reason ? { reason: error.reason } : {}) });
      return;
    }
    const status = error instanceof Error && /^(Invalid|No evidence|Draft|Offer)/.test(error.message) ? 400 : (error as { status?: number })?.status === 400 ? 400 : 500;
    // Never echo stack traces: they can carry PII or tokens.
    res.status(status).json({ error: status === 500 ? "Something went wrong." : (error as Error).message });
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const paypal = createPayPal(process.env);
  const drafter = createDrafter(process.env);
  const adminToken = process.env.ADMIN_TOKEN;
  createApp(paypal, drafter, adminToken ? { adminToken } : {}).listen(port, () => {
    console.log(`Dispute Copilot on http://localhost:${port} (paypal=${paypal.mode}, drafter=${drafter.kind}, writes=${adminToken ? "token" : "read-only"})`);
  });
}
