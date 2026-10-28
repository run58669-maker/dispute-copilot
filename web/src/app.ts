import { createGrid, type GridApi, type GridOptions } from "ag-grid-community";

type Action = "FIGHT" | "OFFER" | "ACCEPT";
interface Rec {
  disputeId: string;
  hoursLeft: number | null;
  amount: number;
  currency: string;
  reason: string;
  score: number;
  factors: Array<{ label: string; points: number }>;
  evidencePlan: Array<{ evidence_type: string; have: boolean; why: string }>;
  action: Action;
  actionReason: string;
  rulesAction: Action;
  actionChangedByLLM: boolean;
  needsHumanReview: boolean;
  allowedActions: Action[];
  paypalStatus: string;
  lifecycleStage?: string;
  offerAmount?: { currency_code: string; value: string };
  assessment: string;
  draft: string;
  draftSource: "llm" | "template";
  llmAdjustment?: { delta: number; why: string };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const caseEl = document.getElementById("case") as HTMLElement;
const EMPTY = '<p class="empty">Pick a dispute to see the recommendation.</p>';
let grid: GridApi<Rec> | null = null;
/** Admin token lives in memory only: never written to storage, gone on reload. */
let adminToken = "";
let serverWrites = "read-only";

async function api<T>(path: string, body?: unknown, write = false): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (write && adminToken) headers["x-admin-token"] = adminToken;
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers, body: JSON.stringify(body) });
  const json = (await res.json()) as T & { error?: string; reason?: string };
  if (!res.ok) throw new Error([json.error ?? `HTTP ${res.status}`, json.reason].filter(Boolean).join(" — "));
  return json;
}

function badges(mode: string, drafter: string): void {
  const el = document.getElementById("badges") as HTMLElement;
  const locked = serverWrites === "read-only" || !adminToken;
  el.innerHTML = [
    mode === "mock" ? '<span class="badge mock">Sample disputes — no PayPal keys</span>' : '<span class="badge live">PayPal sandbox</span>',
    drafter === "llm" ? '<span class="badge live">AI drafts on</span>' : '<span class="badge mock">Template drafts — no LLM key</span>',
    locked
      ? `<span class="badge readonly" title="${serverWrites === "read-only" ? "This server has no admin token: sending is disabled." : "Enter the admin token to send."}">Read-only${serverWrites === "read-only" ? " demo" : ""}</span>`
      : '<span class="badge live">Unlocked</span>',
  ].join("");
}

let lastMeta = { mode: "mock", drafter: "template" };
let current: Rec | null = null;
const rerender = () => { badges(lastMeta.mode, lastMeta.drafter); if (current) showCase(current); };

function setupUnlock(): void {
  const form = document.getElementById("unlock") as HTMLFormElement;
  const input = form.querySelector("input") as HTMLInputElement;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    adminToken = input.value.trim();
    input.value = "";
    (form.querySelector("button") as HTMLButtonElement).textContent = adminToken ? "Lock" : "Unlock";
    if (!adminToken) input.hidden = false;
    else input.hidden = true;
    rerender();
  });
  form.querySelector("button")?.addEventListener("click", (event) => {
    if (adminToken) {
      event.preventDefault();
      adminToken = "";
      input.hidden = false;
      (event.target as HTMLButtonElement).textContent = "Unlock";
      rerender();
    }
  });
}

function showCase(rec: Rec): void {
  current = rec;
  const allowed = new Set(rec.allowedActions);
  caseEl.innerHTML = `
    <h2>${esc(rec.disputeId)}</h2>
    <p><span class="action ${rec.action}">${rec.action}</span> · win score ${rec.score}/100 · ${rec.amount.toFixed(2)} ${esc(rec.currency)}
      ${rec.hoursLeft === null ? "" : `· ${rec.hoursLeft} h left`}</p>
    ${rec.actionChangedByLLM ? `<p class="alert">AI changed recommendation — confirm. Rules alone said <b>${rec.rulesAction}</b>; the model's score nudge moved it to <b>${rec.action}</b>.</p>` : ""}
    ${rec.needsHumanReview ? '<p class="alert">Insufficient facts — a human must review before any response.</p>' : ""}
    <p>${esc(rec.actionReason)}</p>
    <p class="note">PayPal status ${esc(rec.paypalStatus)}${rec.lifecycleStage ? ` · stage ${esc(rec.lifecycleStage)}` : ""} · PayPal currently allows: <b>${rec.allowedActions.length ? rec.allowedActions.join(", ") : "no seller action"}</b></p>
    <h3>Assessment <span class="hint">(${rec.draftSource === "llm" ? "AI" : "template"})</span></h3>
    <p class="assessment">${esc(rec.assessment)}</p>
    ${rec.llmAdjustment ? `<p class="note">AI adjusted the score ${rec.llmAdjustment.delta > 0 ? "+" : ""}${rec.llmAdjustment.delta}: ${esc(rec.llmAdjustment.why)}</p>` : ""}
    <details><summary>Why this score</summary><ul class="factors">${rec.factors.map((f) => `<li>${esc(f.label)}: ${f.points >= 0 ? "+" : ""}${f.points}</li>`).join("")}</ul></details>
    <h3>Evidence PayPal asks for</h3>
    <ul class="plan">${rec.evidencePlan.map((p) => `<li class="${p.have ? "" : "missing"}">${p.have ? "✓" : "✗"} ${esc(p.evidence_type)} — ${esc(p.why)}</li>`).join("")}</ul>
    <h3>Draft <span class="hint">(${rec.draftSource === "llm" ? "AI" : "template"}; edit freely)</span></h3>
    <textarea id="draft">${esc(rec.draft)}</textarea>
    ${rec.actionChangedByLLM ? `<label class="confirm"><input type="checkbox" id="confirm-ai"> AI changed recommendation (${rec.rulesAction} → ${rec.action}) — confirm</label>` : ""}
    <div class="row">
      <label>Action <select id="action">${(["FIGHT", "OFFER", "ACCEPT"] as const)
        .map((a) => `<option ${a === rec.action && allowed.has(a) ? "selected" : ""} ${allowed.has(a) ? "" : "disabled"}>${a}${allowed.has(a) ? "" : " (not allowed)"}</option>`)
        .join("")}</select></label>
      <button id="preview" ${allowed.size ? "" : "disabled"}>Preview request</button>
      <button id="approve" class="primary" disabled>Approve &amp; send</button>
    </div>
    <p class="note" id="gate"></p>
    <pre id="out" hidden></pre>`;
  const out = caseEl.querySelector("#out") as HTMLPreElement;
  const gate = caseEl.querySelector("#gate") as HTMLElement;
  const approve = caseEl.querySelector("#approve") as HTMLButtonElement;
  const confirmBox = caseEl.querySelector("#confirm-ai") as HTMLInputElement | null;
  let previewed = false;
  let previewId = "";
  const read = () => ({
    action: (caseEl.querySelector("#action") as HTMLSelectElement).value,
    draft: (caseEl.querySelector("#draft") as HTMLTextAreaElement).value,
  });
  const refresh = () => {
    const reasons: string[] = [];
    if (!previewed) reasons.push("preview first");
    if (confirmBox && !confirmBox.checked) reasons.push("tick the AI-change confirmation");
    if (serverWrites === "read-only") reasons.push("this demo server is read-only");
    else if (!adminToken) reasons.push("unlock with the admin token");
    approve.disabled = reasons.length > 0;
    gate.textContent = reasons.length ? `Approve disabled: ${reasons.join("; ")}.` : "";
  };
  const invalidate = () => {
    previewed = false;
    previewId = "";
    refresh();
  };
  caseEl.querySelector("#action")?.addEventListener("change", invalidate);
  caseEl.querySelector("#draft")?.addEventListener("input", invalidate);
  confirmBox?.addEventListener("change", refresh);
  refresh();
  caseEl.querySelector("#preview")?.addEventListener("click", async () => {
    out.hidden = false;
    try {
      const preview = await api<{ request: unknown; previewId: string; actionChangedByLLM: boolean }>(`/api/disputes/${encodeURIComponent(rec.disputeId)}/preview`, read());
      out.textContent = JSON.stringify(preview.request, null, 2);
      previewId = preview.previewId;
      previewed = true; // Approve sends exactly this preview, once.
    } catch (error) {
      out.textContent = `Cannot send: ${(error as Error).message}`;
      previewed = false;
    }
    refresh();
  });
  approve.addEventListener("click", async () => {
    approve.disabled = true;
    try {
      const body = { ...read(), previewId, ...(confirmBox?.checked ? { confirmed: true } : {}) };
      const result = await api<{ status: number }>(`/api/disputes/${encodeURIComponent(rec.disputeId)}/approve`, body, true);
      current = null;
      caseEl.innerHTML = `<p class="sent">Sent ${esc(rec.disputeId)}. PayPal answered HTTP ${result.status}.</p>${EMPTY}`;
      await load();
    } catch (error) {
      out.hidden = false;
      out.textContent = `Send failed: ${(error as Error).message}`;
      invalidate(); // the server consumed or rejected this preview; preview again before retrying
    }
  });
}

async function load(): Promise<void> {
  const data = await api<{ mode: string; drafter: string; writes: string; items: Rec[] }>("/api/disputes");
  serverWrites = data.writes;
  lastMeta = { mode: data.mode, drafter: data.drafter };
  badges(data.mode, data.drafter);
  if (grid) {
    grid.setGridOption("rowData", data.items);
    return;
  }
  const options: GridOptions<Rec> = {
    rowData: data.items,
    rowSelection: "single",
    columnDefs: [
      { field: "disputeId", headerName: "Dispute", flex: 2, minWidth: 140 },
      { field: "reason", headerName: "Reason", flex: 2, minWidth: 150, valueFormatter: (p) => String(p.value ?? "").replace(/_/g, " ").toLowerCase() },
      { field: "hoursLeft", headerName: "Hours left", flex: 1, minWidth: 90, sort: "asc" },
      { field: "amount", headerName: "Amount", flex: 1, minWidth: 90, valueFormatter: (p) => (p.value as number).toFixed(2) },
      { field: "currency", headerName: "Currency", flex: 1, minWidth: 80 },
      { field: "score", headerName: "Win score", flex: 1, minWidth: 80 },
      { field: "action", headerName: "Recommends", flex: 1, minWidth: 100, cellClass: (p) => `action ${p.value as string}` },
    ],
    onRowClicked: (event) => event.data && showCase(event.data),
  };
  grid = createGrid(document.getElementById("grid") as HTMLElement, options);
}

setupUnlock();
load().catch((error: Error) => {
  caseEl.innerHTML = `<p>Could not load disputes: ${esc(error.message)}</p>`;
});
