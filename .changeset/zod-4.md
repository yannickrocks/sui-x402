---
"@sui-x402/core": minor
"@sui-x402/payer-sui": patch
---

Move to zod 4 (`^4.6.7`).

**Breaking for consumers that use core's schemas directly.** `@sui-x402/core`
exports its zod schemas (`PaymentRequirements`, `PaymentPayload`,
`PaymentRequired`, `SettleResponse`, `Supported`, …) and their declaration
files now reference zod 4 types. Code that composes them with its own schemas
(`.extend`, `.merge`, `z.object({ … PaymentPayload … })`, `z.ZodType<…>`
annotations) must itself use zod 4; mixing in zod 3 schemas no longer
typechecks. Consumers that only call the seller core, the header codec or the
middleware are unaffected.

Validation behaviour is unchanged: unknown keys are still stripped from the
validated value while `decodeHeaderVerbatim` keeps the raw document for
byte-for-byte relay, and record fields (`extra`, `extensions`, `signers`)
still accept any string keys.

`@sui-x402/payer-sui` only bumps its zod dependency; its public API is
unchanged.
