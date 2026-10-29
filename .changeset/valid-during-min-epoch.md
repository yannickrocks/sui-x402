---
"@sui-x402/payer-sui": minor
---

Conform to the updated Sui exact spec (x402-foundation/x402#3081):

- Payments set `ValidDuring` with both `minEpoch` (current epoch) and `maxEpoch` (next epoch).
- `sponsorPayment` rejects a gas-station response whose expiration is not a compliant `ValidDuring` on the verified chain (`sponsor_response_invalid`). `SponsoredPaymentKind` gains a required `chainIdentifier` field.
- A seller's `extra.nonce` is added as a raw `Pure` input holding its decoded bytes; a non-string, empty or malformed nonce fails with the new `invalid_nonce` reason.
