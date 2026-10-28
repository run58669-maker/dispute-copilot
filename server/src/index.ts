import express, { type NextFunction, type Request, type Response } from "express";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DisputeCopilot } from "./copilot.js";
import { LlmDrafter, TemplateDrafter, type Drafter } from "./drafter.js";
import { MockPayPalClient, PayPalHttpError, SandboxPayPalClient } from "./paypal-client.js";
import type { Action, PayPalClient } from "./types.js";

const ACTIONS: readonly Action[] = ["FIGHT", "OFFER", "ACCEPT"];
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

export function createPayPal(env: NodeJS.ProcessEnv): PayPalClient {
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) {
    return new SandboxPayPalClient({
      clientId: env.PAYPAL_CLIENT_ID,
      clientSecret: env.PAYPAL_CLIENT_SECRET,
      baseUrl: env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com",
    });
  }
  return MockPayPalClient.fromFile(resolve(root, "fixtures", "disputes.json"));
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

function parseApproval(body: unknown): { action: Action; draft: string } {
  const { action, draft } = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) throw new PayPalHttpError(400, "action must be FIGHT, OFFER or ACCEPT.");
  if (typeof draft !== "string" || draft.trim().length === 0 || draft.length > 4000) throw new PayPalHttpError(400, "draft must be 1–4000 characters.");
  return { action: action as Action, draft };
}

export function createApp(paypal: PayPalClient, drafter: Drafter) {
  const copilot = new DisputeCopilot(paypal, drafter);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, paypal: paypal.mode, drafter: drafter.kind });
  });

  app.get("/api/disputes", async (_req, res, next) => {
    try {
      res.json({ mode: paypal.mode, drafter: drafter.kind, items: await copilot.queue() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/disputes/:id/preview", async (req, res, next) => {
    try {
      const { action, draft } = parseApproval(req.body);
      res.json({ request: await copilot.preview(String(req.params.id), action, draft) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/disputes/:id/approve", async (req, res, next) => {
    try {
      const { action, draft } = parseApproval(req.body);
      res.json(await copilot.approve(String(req.params.id), action, draft));
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(resolve(root, "dist", "web")));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof PayPalHttpError ? error.status : error instanceof Error && /^(Invalid|No evidence|Draft|Offer)/.test(error.message) ? 400 : 500;
    // Never echo upstream bodies or stack traces: they can carry PII or tokens.
    res.status(status).json({ error: status === 500 ? "Something went wrong." : (error as Error).message });
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const paypal = createPayPal(process.env);
  const drafter = createDrafter(process.env);
  createApp(paypal, drafter).listen(port, () => {
    console.log(`Dispute Copilot on http://localhost:${port} (paypal=${paypal.mode}, drafter=${drafter.kind})`);
  });
}
