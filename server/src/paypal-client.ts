import { readFileSync } from "node:fs";
import type { Dispute, DisputeCase, OrderFacts, OutboundRequest, PayPalClient } from "./types.js";

export class PayPalHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Fixture-backed client: same interface, no network. Sends are recorded so the UI and tests can show them. */
export class MockPayPalClient implements PayPalClient {
  readonly mode = "mock" as const;
  readonly sent: Array<{ disputeId: string; request: OutboundRequest }> = [];
  private readonly cases: Map<string, DisputeCase>;
  private readonly resolved = new Set<string>();

  constructor(cases: DisputeCase[]) {
    this.cases = new Map(cases.map((kase) => [kase.dispute.dispute_id, kase]));
  }

  static fromFile(path: string, now: Date = new Date()): MockPayPalClient {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Array<DisputeCase & { dueInHours?: number }>;
    // Fixtures store due dates relative to "now" so the demo never shows every case as overdue.
    return new MockPayPalClient(
      raw.map(({ dueInHours, ...kase }) => ({
        ...kase,
        dispute: {
          ...kase.dispute,
          ...(dueInHours !== undefined ? { seller_response_due_date: new Date(now.getTime() + dueInHours * 3_600_000).toISOString() } : {}),
        },
      })),
    );
  }

  async listOpenDisputes(): Promise<Dispute[]> {
    return [...this.cases.values()].filter((kase) => !this.resolved.has(kase.dispute.dispute_id)).map((kase) => kase.dispute);
  }

  async getDispute(id: string): Promise<Dispute> {
    const kase = this.cases.get(id);
    if (!kase) throw new PayPalHttpError(404, `Dispute ${id} not found.`);
    return kase.dispute;
  }

  async getFacts(dispute: Dispute): Promise<OrderFacts> {
    return this.cases.get(dispute.dispute_id)?.facts ?? {};
  }

  async send(disputeId: string, request: OutboundRequest): Promise<{ ok: true; status: number; body: unknown }> {
    if (!this.cases.has(disputeId)) throw new PayPalHttpError(404, `Dispute ${disputeId} not found.`);
    this.sent.push({ disputeId, request });
    this.resolved.add(disputeId);
    return { ok: true, status: 200, body: { mock: true, links: [{ rel: "self", href: `${request.path}` }] } };
  }
}

export interface SandboxConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

/** PayPal REST (sandbox) client: OAuth client-credentials, Disputes v1 reads and the three seller actions. */
export class SandboxPayPalClient implements PayPalClient {
  readonly mode = "sandbox" as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: SandboxConfig, private readonly fetchImpl: typeof fetch = fetch) {
    if (!/^https:\/\/api-m\.sandbox\.paypal\.com\/?$/.test(config.baseUrl)) {
      // Guard: this project is sandbox-only; refuse live endpoints outright.
      throw new Error("PAYPAL_BASE_URL must be https://api-m.sandbox.paypal.com");
    }
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const response = await this.fetchImpl(`${this.base()}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) throw new PayPalHttpError(response.status, "PayPal OAuth failed.");
    const json = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  private base(): string {
    return this.config.baseUrl.replace(/\/$/, "");
  }

  private async call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const token = await this.accessToken();
    const response = await this.fetchImpl(`${this.base()}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.headers ?? {}) },
    });
    const text = await response.text();
    const body = text ? safeJson(text) : null;
    if (!response.ok) throw new PayPalHttpError(response.status, `PayPal ${init.method ?? "GET"} ${path} → ${response.status}`);
    return { status: response.status, body };
  }

  async listOpenDisputes(): Promise<Dispute[]> {
    const { body } = await this.call("/v1/customer/disputes?dispute_state=REQUIRED_ACTION&page_size=50");
    const items = ((body as { items?: Array<{ dispute_id: string }> })?.items ?? []).slice(0, 50);
    // The list endpoint returns summaries; fetch details for due dates, amounts and messages.
    return Promise.all(items.map((item) => this.getDispute(item.dispute_id)));
  }

  async getDispute(id: string): Promise<Dispute> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new PayPalHttpError(400, "Invalid dispute id.");
    const { body } = await this.call(`/v1/customer/disputes/${id}`);
    return body as Dispute;
  }

  /** TODO(sandbox day): enrich from GET /v2/payments/captures/{id} and a tracking source. Unknown stays unknown. */
  async getFacts(_dispute: Dispute): Promise<OrderFacts> {
    return {};
  }

  async send(_disputeId: string, request: OutboundRequest): Promise<{ ok: true; status: number; body: unknown }> {
    let init: RequestInit;
    if (request.contentType === "multipart/form-data") {
      const form = new FormData();
      form.append("input", new Blob([JSON.stringify(request.body.input)], { type: "application/json" }));
      init = { method: "POST", body: form };
    } else {
      init = { method: "POST", body: JSON.stringify(request.body), headers: { "Content-Type": "application/json" } };
    }
    const result = await this.call(request.path, init);
    return { ok: true, ...result };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
