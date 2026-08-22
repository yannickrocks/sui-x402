# @sui-x402/core

Zod schemas, header codec and reason codes for the [x402 v2](https://github.com/x402-foundation/x402)
`exact` scheme on Sui. Shared by `@sui-x402/payer`, `@sui-x402/hono`,
`@sui-x402/express` and `@sui-x402/next`; use it directly when writing your own
integration.

Every schema describes the wire exactly as the reference facilitator emits and
accepts it — no defaults, no coercion — and is tested against captured traffic
in [`fixtures/`](./fixtures/README.md).

## Install

```sh
pnpm add @sui-x402/core zod
```

## Example — decode a 402, build terms, decode a payment

```ts
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
  HeaderError,
  PaymentPayload,
  PaymentRequired,
  decodeHeader,
  encodeHeader,
  retryHint,
} from "@sui-x402/core";

// Seller side: advertise terms. Amounts are atomic-unit strings (USDC = 6 dp).
const terms: PaymentRequired = {
  x402Version: 2,
  resource: { url: "https://api.example.com/signal/whales", mimeType: "application/json" },
  accepts: [{
    scheme: "exact",
    network: "sui:testnet",
    amount: "10000", // 0.01 USDC
    asset: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
    payTo: "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d",
    maxTimeoutSeconds: 60,
  }],
};
const headers = { [HEADER_PAYMENT_REQUIRED]: encodeHeader(terms) };

// Payer side: read the terms back.
const parsed = decodeHeader(headers[HEADER_PAYMENT_REQUIRED]!, PaymentRequired);

// Seller side: read a payment. Malformed input throws a typed HeaderError → 400.
function readPayment(header: string): PaymentPayload | { status: 400; reason: string } {
  try {
    return decodeHeader(header, PaymentPayload);
  } catch (e) {
    if (e instanceof HeaderError) return { status: 400, reason: e.reason };
    throw e;
  }
}

// After POST /verify or /settle: decide what the payer should do.
retryHint("invalid_payment_requirements"); // "refetch_terms"
retryHint("invalid_transaction_state");    // "rebuild_tx"
retryHint("insufficient_funds");           // "none"
```

## API

| Export | What |
|---|---|
| `PaymentRequirements`, `PaymentRequired`, `PaymentPayload`, `SuiExactPayload`, `FacilitatorRequest`, `VerifyResponse`, `SettleResponse`, `Supported` | Zod schemas + inferred types for every x402 document on the wire |
| `SuiNetwork`, `AmountString`, `SuiAddress`, `StructTag`, `Base64` | Primitives. `AmountString` is a positive base-10 integer string; `StructTag` rejects bare symbols like `"USDC"` |
| `HEADER_PAYMENT_REQUIRED`, `HEADER_PAYMENT_SIGNATURE`, `HEADER_PAYMENT_RESPONSE` | Header names |
| `encodeHeader(obj)` / `decodeHeader(str, schema)` | Compact JSON ⇄ base64. `decodeHeader` throws `HeaderError` with `reason` ∈ `empty \| too_large \| not_base64 \| not_json \| not_object \| schema` |
| `MAX_TRANSACTION_BASE64_CHARS` (120 000), `MAX_HEADER_CHARS` (256 KiB) | Size caps mirrored from the reference facilitator |
| `ReasonCode`, `isReasonCode`, `retryHint` | Spec §9 codes + Sui analogues; `retryHint` maps a code to `refetch_terms \| rebuild_tx \| facilitator \| none` |

## Notes

- `PaymentRequirements.payTo` and `.asset` are validated structurally only.
  Compare them with `normalizeSuiAddress` / `normalizeStructTag` from
  `@mysten/sui/utils`, never with `===` — that is what the facilitator does.
- `PaymentRequired.error` is not in the x402 spec; the reference facilitator
  sends it and we accept it. `PaymentPayload.resource` is optional because the
  facilitator does not require it.
- Node's HTTP server rejects headers over 16 KiB by default. A typical Sui
  payment is ~2 KiB encoded; raise `--max-http-header-size` only if you expect
  large transactions.
- Live-vs-spec observations: [`docs/spec-notes.md`](../../docs/spec-notes.md).
