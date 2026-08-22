# Spec notes — where live behaviour and the spec diverge (hard rule 9)

Live = `https://sui-facilitator.onrender.com`; pinned = submodule commit in
`deploy/facilitator/UPSTREAM.md`. Fixtures in `packages/core/fixtures/`.

## 2026-08-22 — M0 capture

1. **402 body == decoded `PAYMENT-REQUIRED` header.** The demo resource sends
   the same JSON in both places. Top-level keys: `x402Version`, `error`,
   `resource { url, description, mimeType }`, `accepts[]`. The `error` string
   ("PAYMENT-SIGNATURE header is required") is not in our scaffold's
   `PaymentRequired` shape — schema must allow it (M1.1).
2. **`accepts[].extra` is `{}`** on the demo; `/supported` carries
   `extra: { usdc, decimals }` per kind. Two different `extra` shapes —
   keep both as open records.
3. **Live instance advertises `sui:mainnet`**, the pinned upstream with
   `ENABLE_MAINNET` unset advertises `sui:testnet` only. Our configs never
   set it (hard rule 3); schemas must accept either list.
4. **Live `/health` shape ≠ pinned `src/index.ts` shape.** Live returns
   `{ ok, facilitator: {...}, demo: {...}, uptimeSeconds }` (the Render deploy
   muxes the demo API via a `serve-all.ts` not in the repo); pinned returns
   `{ ok, service, networks, custody, fees, terms, uptimeSeconds }`. Don't
   depend on `/health` fields beyond `ok`.
5. **HTTP status semantics confirmed:** unparseable JSON → 400 with
   `{ isValid:false, invalidReason:"invalid_payload" }` (verify) or
   `{ success:false, errorReason:"invalid_payload", transaction:"", network:"" }`
   (settle). Every semantic rejection → 200. `{}` body → 200
   `invalid_x402_version` (version check runs first).
6. **Reason codes observed live:** `invalid_payload`, `invalid_x402_version`,
   `unsupported_scheme`, `invalid_network`, `invalid_payment_requirements`
   (accepted ≠ requirements), `invalid_transaction_state` (garbage bytes —
   the digest/dry-run path, not a dedicated "malformed tx" code). Upstream
   `src/x402.ts` `ERR` also defines `insufficient_funds`,
   `unexpected_verify_error`, `unexpected_settle_error`,
   `invalid_exact_sui_payload_signature`, `_recipient_mismatch`,
   `_value_mismatch` — not provoked (would need real signed txs).
7. **Settle failure always carries `transaction` and `network` strings**
   (empty when nothing was broadcast); `payer` and `amount` optional.
   Matches the scaffold's `SettleResponse`.
