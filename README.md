# Dispute Copilot

An AI copilot for small PayPal sellers. It pulls every open dispute from the PayPal Disputes API, ranks them by deadline and money at risk, and for each one recommends **fight with evidence**, **offer a partial refund**, or **accept** — with the score broken down, the evidence PayPal asks for, and a drafted response. Nothing reaches PayPal until the seller previews the exact request and clicks **Approve & send**.

Built for the PayPal AI Hackathon (2026). Sandbox only: the client refuses any non-sandbox PayPal URL.

## Run it (no keys needed)

```bash
npm install
npm start          # builds, then serves http://localhost:3000
npm test           # vitest
```

Without keys the app runs on `fixtures/disputes.json` (five sample disputes) and a template drafter; badges at the top say so.

## Use your PayPal sandbox and an LLM

Copy `.env.example` to `.env` (or set the variables in your shell):

| Variable | Purpose |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Sandbox REST app from developer.paypal.com → Apps & Credentials → Sandbox |
| `PAYPAL_BASE_URL` | Must be `https://api-m.sandbox.paypal.com` |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | Any OpenAI-compatible chat endpoint. Default: Gemini 2.5 Flash (free tier) |

## How it decides

1. **Evidence plan** — maps the dispute `reason` to PayPal `evidence_type` values and marks which ones the order facts already cover.
2. **Win score (0–100)** — a transparent rule score; every point is a labelled factor.
3. **LLM review** — the model may move the score by at most ±15 and must say why; it drafts the note using only the listed facts. Bad or failed model output falls back to the template.
4. **Action** — FIGHT ≥ 60, OFFER 30–59 (half the amount), ACCEPT < 30 or amount under 15.
5. **Human gate** — preview → approve → `provide-evidence` / `make-offer` / `accept-claim`.

## PayPal APIs used

`POST /v1/oauth2/token`, `GET /v1/customer/disputes`, `GET /v1/customer/disputes/{id}`, `POST /v1/customer/disputes/{id}/provide-evidence`, `POST /v1/customer/disputes/{id}/make-offer`, `POST /v1/customer/disputes/{id}/accept-claim`.

## Stack

TypeScript, Express, AG Grid Community (dispute queue), esbuild, vitest.

## License

MIT
