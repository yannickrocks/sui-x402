---
"@sui-x402/core": minor
"@sui-x402/payer-sui": minor
---

Gasless v1.1, payer side: sponsored payments through the reference
facilitator's Enoki gas station.

`@sui-x402/payer-sui` gains `gasless: "never" | "auto" | "always"` (default
`"never"` — nothing changes unless opted in) and a `gasStation` option, plus
the exported building blocks `buildSponsoredPaymentKind`, `sponsorPayment`,
`httpGasStation`, `GasStationError`, and `PROTOCOL_MAX_TX_GAS`. The exported
`PaymentBuildReason` union widens with `unsupported_sponsored_asset`,
`sponsor_altered_payment` and `sponsor_response_invalid` — a type-level
change for exhaustive matches.

`@sui-x402/core` adds the gasless conventions (`SUI_SPONSOR_EXTENSION`,
`SuiSponsorExtension`, `SUI_GAS_STATION_EXTRA`, `SuiGasStationHint`) and an
optional `SellerOptions.extra` merged into `PaymentRequirements.extra`;
sellers that omit it are byte-for-byte unchanged.

Plainly: the sponsored _settle_ path is not yet functional against the
reference facilitator — it needs a small upstream settle branch that is
drafted but not merged. Until then `gasless` is useful up to signing and
stays safely inert in production.
