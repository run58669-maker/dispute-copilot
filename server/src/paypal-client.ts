import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Dispute, DisputeCase, OrderFacts, OutboundRequest, PayPalClient } from "./types.js";

export class PayPalHttpError extends Error {
  /** `reason` carries only safe fields from a PayPal error body (name, message, details[].issue). */
  constructor(readonly status: number, message: string, readonly reason?: string) {
    super(message);
  }
}

/** Extracts the safe, non-PII fields of a PayPal error body: name, message and details[].issue. */
export function paypalErrorReason(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { name, message, details } = body as { name?: unknown; message?: unknown; details?: unknown };
  const issues = Array.isArray(details)
    ? details.map((d) => (typeof d === "object" && d !== null ? (d as { issue?: unknown }).issue : undefined)).filter((i): i is string => typeof i === "string")
    : [];
  const parts = [typeof name === "string" ? name : "", typeof message === "string" ? message : "", issues.length ? `issues: ${issues.join(", ")}` : ""]
    .map((p) => p.replace(/[^\x20-\x7E]/g, "").slice(0, 200))
    .filter(Boolean);
  return parts.length ? parts.join(" | ") : undefined;
}

export interface MockOptions {
  /** Public demo: restore every resolved case on this interval so visitors never find an empty queue. */
  resetEveryMs?: number;
  clock?: () => number;
}

/** Fixture-backed client: same interface, no network. Sends are recorded so the UI and tests can show them. */
export class MockPayPalClient implements PayPalClient {
  readonly mode = "mock" as const;
  readonly sent: Array<{ disputeId: string; request: OutboundRequest }> = [];
  private readonly cases: Map<string, DisputeCase>;
  private readonly resolved = new Set<string>();
  private lastReset: number;

  constructor(cases: DisputeCase[], private readonly opts: MockOptions = {}) {
    this.cases = new Map(cases.map((kase) => [kase.dispute.dispute_id, kase]));
    this.lastReset = this.now();
  }

  static fromFile(path: string, now: Date = new Date(), opts: MockOptions = {}): MockPayPalClient {
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
      opts,
    );
  }

  private now(): number {
    return this.opts.clock ? this.opts.clock() : Date.now();
  }

  private maybeReset(): void {
    if (this.opts.resetEveryMs && this.now() - this.lastReset >= this.opts.resetEveryMs) {
      this.resolved.clear();
      this.sent.length = 0;
      this.lastReset = this.now();
    }
  }

  async listOpenDisputes(): Promise<Dispute[]> {
    this.maybeReset();
    return [...this.cases.values()].filter((kase) => !this.resolved.has(kase.dispute.dispute_id)).map((kase) => kase.dispute);
  }

  async getDispute(id: string): Promise<Dispute> {
    this.maybeReset();
    const kase = this.cases.get(id);
    if (!kase) throw new PayPalHttpError(404, `Dispute ${id} not found.`);
    return kase.dispute;
  }

  async getFacts(dispute: Dispute): Promise<OrderFacts> {
    return this.cases.get(dispute.dispute_id)?.facts ?? { unknown: true, unknownReason: "No order facts on file." };
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
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number;
  /** Backoff before the single retry on 429/5xx (default 1 s; Retry-After honoured up to 5 s). */
  retryDelayMs?: number;
  /** Pagination cap for the dispute list (default 4 pages of 50). */
  maxPages?: number;
}

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** PayPal REST (sandbox) client: OAuth client-credentials, Disputes v1 reads, order facts and the three seller actions. */
export class SandboxPayPalClient implements PayPalClient {
  readonly mode = "sandbox" as const;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: SandboxConfig, private readonly fetchImpl: typeof fetch = fetch) {
    if (!/^https:\/\/api-m\.sandbox\.paypal\.com\/?$/.test(config.baseUrl)) {
      // Guard: this project is sandbox-only; refuse live endpoints outright.
      throw new Error("PAYPAL_BASE_URL must be https://api-m.sandbox.paypal.com");
    }
  }

  private base(): string {
    return this.config.baseUrl.replace(/\/$/, "");
  }

  /** One HTTP exchange with a hard timeout. Timeouts and network failures become PayPalHttpError(504/502). */
  private async exchange(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new PayPalHttpError(504, "PayPal request timed out.", "timeout");
      throw new PayPalHttpError(502, "PayPal unreachable.", (error as Error).name);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sends once; on 429/5xx waits and retries exactly once. Returns the final response. */
  private async withRetry(url: string, init: () => RequestInit): Promise<Response> {
    let response = await this.exchange(url, init());
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5_000) : (this.config.retryDelayMs ?? 1_000);
      await response.text().catch(() => "");
      await sleep(wait);
      response = await this.exchange(url, init());
    }
    return response;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const response = await this.withRetry(`${this.base()}/v1/oauth2/token`, () => ({
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    }));
    const text = await response.text();
    const body = text ? safeJson(text) : null;
    if (!response.ok) {
      const oauthError = (body as { error?: unknown } | null)?.error;
      throw new PayPalHttpError(response.status, "PayPal OAuth failed.", paypalErrorReason(body) ?? (typeof oauthError === "string" ? oauthError.slice(0, 80) : undefined));
    }
    const json = (body ?? {}) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new PayPalHttpError(502, "PayPal OAuth returned no token.");
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 0) * 1000 };
    return json.access_token;
  }

  private async call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const method = init.method ?? "GET";
    // Idempotency key shared by the retry, so a POST that PayPal applied but answered with 5xx is not applied twice.
    const requestId = method === "GET" ? undefined : randomUUID();
    const build = (token: string) => (): RequestInit => ({
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        ...((init.headers as Record<string, string> | undefined) ?? {}),
      },
    });
    let response = await this.withRetry(`${this.base()}${path}`, build(await this.accessToken()));
    if (response.status === 401) {
      // Token revoked or expired early: refresh once.
      await response.text().catch(() => "");
      this.token = null;
      response = await this.withRetry(`${this.base()}${path}`, build(await this.accessToken()));
    }
    const text = await response.text();
    const body = text ? safeJson(text) : null;
    if (!response.ok) throw new PayPalHttpError(response.status, `PayPal ${method} ${path.split("?")[0]} -> ${response.status}`, paypalErrorReason(body));
    return { status: response.status, body };
  }

  async listOpenDisputes(): Promise<Dispute[]> {
    const ids: string[] = [];
    let path: string | null = "/v1/customer/disputes?dispute_state=REQUIRED_ACTION&page_size=50";
    for (let page = 0; path && page < (this.config.maxPages ?? 4); page += 1) {
      const { body } = await this.call(path);
      const parsed = (body ?? {}) as { items?: Array<{ dispute_id: string }>; links?: Array<{ rel?: string; href?: string }> };
      for (const item of parsed.items ?? []) if (ID_RE.test(item.dispute_id)) ids.push(item.dispute_id);
      const next = parsed.links?.find((l) => l.rel === "next")?.href;
      path = next ? this.sameOriginPath(next) : null;
    }
    // The list endpoint returns summaries; fetch details for due dates, amounts, messages and allowed actions.
    return Promise.all([...new Set(ids)].map((id) => this.getDispute(id)));
  }

  /** Only follow pagination links that point back at the sandbox disputes API. */
  private sameOriginPath(href: string): string | null {
    try {
      const url = new URL(href, this.base());
      if (url.origin !== new URL(this.base()).origin || !url.pathname.startsWith("/v1/customer/disputes")) return null;
      return `${url.pathname}${url.search}`;
    } catch {
      return null;
    }
  }

  async getDispute(id: string): Promise<Dispute> {
    if (!ID_RE.test(id)) throw new PayPalHttpError(400, "Invalid dispute id.");
    const { body } = await this.call(`/v1/customer/disputes/${id}`);
    return body as Dispute;
  }

  /**
   * Order facts from the disputed transaction: capture -> order (items, digital/physical, shipment trackers)
   * -> tracker detail (carrier, number, status). Anything PayPal does not say stays undefined.
   * If fulfilment cannot be established, returns `unknown: true` so the policy routes to human review instead of guessing.
   */
  async getFacts(dispute: Dispute): Promise<OrderFacts> {
    const txn = dispute.disputed_transactions?.find((t) => t.seller_transaction_id)?.seller_transaction_id;
    const itemTitle = dispute.disputed_transactions?.[0]?.items?.[0]?.item_description;
    const base: OrderFacts = itemTitle ? { itemTitle } : {};
    if (!txn || !ID_RE.test(txn)) return { ...base, unknown: true, unknownReason: "Dispute has no seller transaction id." };

    const readable = async <T>(path: string, what: string): Promise<T | string> => {
      try {
        return (await this.call(path)).body as T;
      } catch (error) {
        if (error instanceof PayPalHttpError && (error.status === 404 || error.status === 403)) return `${what} not readable (HTTP ${error.status}).`;
        throw error;
      }
    };

    const capture = await readable<{ supplementary_data?: { related_ids?: { order_id?: string } } }>(`/v2/payments/captures/${txn}`, `Capture ${txn}`);
    if (typeof capture === "string") return { ...base, unknown: true, unknownReason: capture };
    const orderId = capture?.supplementary_data?.related_ids?.order_id;
    if (!orderId || !ID_RE.test(orderId)) return { ...base, unknown: true, unknownReason: "Capture has no linked order; fulfilment unknown." };

    type Order = {
      purchase_units?: Array<{
        items?: Array<{ name?: string; category?: string }>;
        shipping?: { trackers?: Array<{ id?: string; status?: string }> };
      }>;
    };
    const order = await readable<Order>(`/v2/checkout/orders/${orderId}`, `Order ${orderId}`);
    if (typeof order === "string") return { ...base, unknown: true, unknownReason: order };
    const unit = order?.purchase_units?.[0];
    const items = unit?.items ?? [];
    const facts: OrderFacts = { ...base };
    if (items[0]?.name) facts.itemTitle = items[0].name;
    if (items.length > 0 && items.every((i) => i.category === "DIGITAL_GOODS")) facts.digitalGood = true;
    if (facts.digitalGood) return { ...facts, unknown: true, unknownReason: "Digital delivery proof is not recorded in PayPal." };

    const tracker = unit?.shipping?.trackers?.find((t) => t.id && t.status !== "CANCELLED");
    if (!tracker?.id) return { ...facts, unknown: true, unknownReason: "No shipment tracking recorded on the PayPal order." };
    const detail = await readable<{ carrier?: string; carrier_name_other?: string; tracking_number?: string; status?: string }>(
      `/v1/shipping/trackers/${encodeURIComponent(tracker.id)}`,
      "Tracker",
    );
    if (typeof detail === "string") return { ...facts, trackingStatus: "IN_TRANSIT" }; // shipped, location unknown
    const carrier = detail.carrier === "OTHER" ? detail.carrier_name_other : detail.carrier;
    if (carrier) facts.carrier = carrier;
    if (detail.tracking_number) facts.trackingNumber = detail.tracking_number;
    facts.trackingStatus = detail.status === "DELIVERED" ? "DELIVERED" : "IN_TRANSIT";
    return facts;
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
