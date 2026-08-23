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
8. **Timestamp-based transaction expiry is not live.** A `ValidDuring`
   expiration with `maxTimestamp` set is rejected by the testnet full node at
   input check (`simulateTransaction` → gRPC `INVALID_ARGUMENT`: "Feature is
   not supported: Timestamp-based transaction expiration is not yet
   supported"; observed 2026-08-22, epoch 1199). Epoch-bounded `ValidDuring`
   (`minEpoch`/`maxEpoch`, including `maxEpoch` alone) and the legacy `Epoch`
   form are accepted. The payer therefore bounds every payment to the current
   epoch and treats `maxTimeoutSeconds` as a local deadline only.
9. **Reason codes on a seller's repeat 402 (our convention).** The spec does
   not say how a seller reports a rejected payment. Our middleware answers
   402 with a `PaymentRequired` document whose non-spec `error` field carries
   the facilitator's reason code (the live demo uses the same field for its
   "header is required" message), and our payer reads it through
   `retryHint`. Other sellers may differ; an unreadable reason degrades to
   `retryHint → "none"`.
10. **`getTransaction` "not found" is not proof of non-execution.** The public
    testnet full node answers `NOT_FOUND` for transactions that provably
    executed but fell out of its retention (observed 2026-08-22 for the
    `previousTransaction` digests of live coin objects). Upstream's own
    `rpc.ts` comment says the same. Any "did my payment land?" check must be
    a positive one — the payer reads the version of the gas coin it signed.
11. **Live testnet protocol limits (2026-08-22):** `max_tx_gas` =
    50,000,000,000,000 MIST (50,000 SUI), `max_gas_price` = 50 SUI,
    `max_gas_payment_objects` = 256, `max_input_objects` = 2048. The payer
    caps gas inputs at 128.
12. **The public demo seller cannot settle today (2026-08-23).** Paying
    `GET https://sui-facilitator.onrender.com/signal/whales` with a valid
    payload returns HTTP 500 `{"error":"Method not found. JSON-RPC on public
    fullnodes has been deprecated. Please migrate to gRPC or GraphQL
    endpoints. …"}` before anything is broadcast (payer balances unchanged).
    The deployed demo/seller layer (`serve-all.ts`, not in the repo) still
    calls JSON-RPC; the pinned facilitator itself is gRPC-only and settles
    fine when run locally. Reported upstream to the facilitator's author.
13. **First live settlements (2026-08-23, testnet, epoch 1200)** through the
    pinned facilitator run locally: `GE85dg3wNUdfRKJpFW9bBz2qkk4qgvgihWxMrFzDfc4T`
    (hono example), `CKYr3pP6Amrg62C9kxZX5w2UVfitDTBJeE2zjdfjnZZU` (payer-sui
    e2e), `5MGrTQ82xhYeciurZssjTcnLvRn4rdp1wkorEJaA7bAB` (express example). Each:
    `status.success`, `ValidDuring{maxEpoch: 1201, chain: 69WiPg…}` as built,
    balance changes exactly +10000/−10000 USDC, gas 2,345,504 MIST at price
    1000 for split + transfer of USDC from a single coin (budget 4,014,604 —
    the simulation-derived budget carries ~70 % headroom over the real cost).
    `/settle` answered `success: true` with the digest and `amount: "10000"`.
