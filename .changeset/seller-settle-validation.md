---
"@sui-x402/core": minor
---

Sellers now check a settlement against the offer they made before releasing
the resource.

Previously a `success: true` from the facilitator was sufficient. It is the
only evidence a seller gets, and the seller already knows what it asked for,
so the claim is now verified: the settled `network` must equal the offer's,
and any reported `amount` must be at least the offer's. The amount is
validated as a positive base-10 string first, so a hex form like `"0x10"` is
rejected rather than silently widened by `BigInt`. An empty `network` on a
success is rejected too — it means the facilitator failed before resolving
one, which cannot honestly accompany a success.

This applies to strict-mode fulfilment, the fast-mode background settle, and
the `onSettled` / `onSettleFailure` split alike, so a mismatch cannot register
as a settlement in one mode and a failure in another.

**Behavioural change for existing sellers:** a settlement that does not match
the offer now yields a 402 in strict mode (and `settleAfter` resolving `null`
in fast mode) where it previously fulfilled. Against a correctly behaving
facilitator nothing changes.

**New `SettleFailure.reason` value:** `"settlement_mismatch"`, distinct from
the facilitator's own reason codes, for consumers that branch on `reason`.

This is defence in depth, and deliberately partial: `SettleResponse` carries
no `payTo`, so a settlement that credited a different payee for the same
transaction bytes remains undetectable from the seller. That case belongs to
the facilitator, which must bind a cached settle result to the caller's
requirements; it has been reported upstream.
