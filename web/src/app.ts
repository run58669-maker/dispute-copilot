import { createGrid, type GridApi, type GridOptions } from "ag-grid-community";

type Action = "FIGHT" | "OFFER" | "ACCEPT";
interface Rec {
  disputeId: string;
  hoursLeft: number | null;
  amount: number;
  currency: string;
  score: number;
  factors: Array<{ label: string; points: number }>;
  evidencePlan: Array<{ evidence_type: string; have: boolean; why: string }>;
  action: Action;
  actionReason: string;
  offerAmount?: { currency_code: string; value: string };
  assessment: string;
  draft: string;
  draftSource: "llm" | "template";
  llmAdjustment?: { delta: number; why: string };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
const caseEl = document.getElementById("case") as HTMLElement;
let grid: GridApi<Rec> | null = null;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function badges(mode: string, drafter: string): void {
  const el = document.getElementById("badges") as HTMLElement;
  el.innerHTML = [
    mode === "mock" ? '<span class="badge mock">Sample disputes — no PayPal keys</span>' : '<span class="badge live">PayPal sandbox</span>',
    drafter === "llm" ? '<span class="badge live">AI drafts on</span>' : '<span class="badge mock">Template drafts — no LLM key</span>',
  ].join("");
}

function showCase(rec: Rec): void {
  caseEl.innerHTML = `
    <h2>${esc(rec.disputeId)}</h2>
    <p><span class="action ${rec.action}">${rec.action}</span> · win score ${rec.score}/100 · ${rec.amount.toFixed(2)} ${esc(rec.currency)}
      ${rec.hoursLeft === null ? "" : `· ${rec.hoursLeft} h left`}</p>
    <p>${esc(rec.actionReason)}</p>
    <h3>Assessment <span class="hint">(${rec.draftSource === "llm" ? "AI" : "template"})</span></h3>
    <p class="assessment">${esc(rec.assessment)}</p>
    ${rec.llmAdjustment ? `<p class="note">AI adjusted the score ${rec.llmAdjustment.delta > 0 ? "+" : ""}${rec.llmAdjustment.delta}: ${esc(rec.llmAdjustment.why)}</p>` : ""}
    <details><summary>Why this score</summary><ul class="factors">${rec.factors.map((f) => `<li>${esc(f.label)}: ${f.points >= 0 ? "+" : ""}${f.points}</li>`).join("")}</ul></details>
    <h3>Evidence PayPal asks for</h3>
    <ul class="plan">${rec.evidencePlan.map((p) => `<li class="${p.have ? "" : "missing"}">${p.have ? "✓" : "✗"} ${esc(p.evidence_type)} — ${esc(p.why)}</li>`).join("")}</ul>
    <h3>Draft <span class="hint">(${rec.draftSource === "llm" ? "AI" : "template"}; edit freely)</span></h3>
    <textarea id="draft">${esc(rec.draft)}</textarea>
    <div class="row">
      <label>Action <select id="action">${(["FIGHT", "OFFER", "ACCEPT"] as const).map((a) => `<option ${a === rec.action ? "selected" : ""}>${a}</option>`).join("")}</select></label>
      <button id="preview">Preview request</button>
      <button id="approve" class="primary" disabled>Approve &amp; send</button>
    </div>
    <pre id="out" hidden></pre>`;
  const out = caseEl.querySelector("#out") as HTMLPreElement;
  const approve = caseEl.querySelector("#approve") as HTMLButtonElement;
  const read = () => ({ action: (caseEl.querySelector("#action") as HTMLSelectElement).value, draft: (caseEl.querySelector("#draft") as HTMLTextAreaElement).value });
  const invalidate = () => { approve.disabled = true; };
  caseEl.querySelector("#action")?.addEventListener("change", invalidate);
  caseEl.querySelector("#draft")?.addEventListener("input", invalidate);
  caseEl.querySelector("#preview")?.addEventListener("click", async () => {
    out.hidden = false;
    try {
      const { request } = await api<{ request: unknown }>(`/api/disputes/${encodeURIComponent(rec.disputeId)}/preview`, read());
      out.textContent = JSON.stringify(request, null, 2);
      approve.disabled = false; // Approve only what was previewed.
    } catch (error) {
      out.textContent = `Cannot send: ${(error as Error).message}`;
    }
  });
  approve.addEventListener("click", async () => {
    approve.disabled = true;
    try {
      const result = await api<{ status: number }>(`/api/disputes/${encodeURIComponent(rec.disputeId)}/approve`, read());
      out.textContent = `Sent. PayPal answered HTTP ${result.status}.\n\n${out.textContent}`;
      await load();
    } catch (error) {
      out.textContent = `Send failed: ${(error as Error).message}`;
    }
  });
}

async function load(): Promise<void> {
  const data = await api<{ mode: string; drafter: string; items: Rec[] }>("/api/disputes");
  badges(data.mode, data.drafter);
  if (grid) {
    grid.setGridOption("rowData", data.items);
    return;
  }
  const options: GridOptions<Rec> = {
    rowData: data.items,
    rowSelection: "single",
    columnDefs: [
      { field: "disputeId", headerName: "Dispute", flex: 2 },
      { field: "hoursLeft", headerName: "Hours left", flex: 1, sort: "asc" },
      { field: "amount", headerName: "Amount", flex: 1, valueFormatter: (p) => (p.value as number).toFixed(2) },
      { field: "score", headerName: "Win score", flex: 1 },
      { field: "action", headerName: "Recommends", flex: 1, cellClass: (p) => `action ${p.value as string}` },
    ],
    onRowClicked: (event) => event.data && showCase(event.data),
  };
  grid = createGrid(document.getElementById("grid") as HTMLElement, options);
}

load().catch((error: Error) => {
  caseEl.innerHTML = `<p>Could not load disputes: ${esc(error.message)}</p>`;
});
