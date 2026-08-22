# Fixtures — captured from real facilitators, never hand-written

Core's Zod schemas are validated against these files (`pnpm test` in
`packages/core`). Re-capture when upstream is re-pinned (`deploy/facilitator/UPSTREAM.md`).

| file | source | captured |
|---|---|---|
| `facilitator-supported.live.json` | `GET https://sui-facilitator.onrender.com/supported` | 2026-08-22 |
| `facilitator-supported.local.json` | `GET /supported` on the pinned upstream (`node deploy/facilitator/smoke.mjs --save`) | 2026-08-22 |
| `facilitator-health.live.json` | `GET https://sui-facilitator.onrender.com/health` (`uptimeSeconds` zeroed) | 2026-08-22 |
| `demo-402.payment-required.header.txt` | raw `PAYMENT-REQUIRED` header from `GET https://sui-facilitator.onrender.com/signal/whales` (402) | 2026-08-22 |
| `demo-402.payment-required.json` | the header above, base64-decoded | 2026-08-22 |
| `demo-402.body.json` | the 402 response body — byte-identical JSON to the decoded header | 2026-08-22 |
| `facilitator-reason-codes.json` | `POST /verify` and `/settle` negative probes (garbage tx bytes, no funds) → spec §9 reason codes | 2026-08-22 |

Observations that drive schema decisions live in `docs/spec-notes.md`.
