# Guide: gasless payments (sponsored transactions)

**Read this first.** The gas station that sponsors a payment must be the _same
facilitator deployment_ the seller settles through, and a sponsored payment
that a facilitator cannot settle is money the payer may not get back — the
USDC leaves the payer's coin if anything broadcasts the transaction, and no
party in this stack can reverse it. Keep `gasless` at its default (`"never"`)
unless you control, or explicitly trust, the deployment at both ends.

> Status: the payer side is implemented, staged for the next release, and
> inert by default. Settling a
> sponsored payment additionally needs a small upstream facilitator change
> that is not merged yet, so end-to-end sponsored settlement is not live.
> Everything below works up to (and including) signing; see the status page.

## What it does

A payer holding USDC but **zero SUI** can still pay a 402. The payer builds
the payment as a _transaction kind_ (no gas, no sender, no expiry), the
facilitator's Enoki gas station fills in sponsor gas, and the payer signs the
sponsored bytes — after validating, locally, that the sponsor changed nothing
but gas:

1. The returned bytes' kind must be byte-identical to what was submitted.
2. The sender must still be the payer, and the gas owner must _not_ be.
3. The gas budget and price must be sane, and the digest must match the bytes.
4. A fresh simulation must credit the seller with the full amount.

Only then does `PayerSigner.signTransaction` see the bytes. The sponsor pays
gas only; it cannot redirect or inflate the payment.

## Payer setup

```ts
const payer = new SuiX402Payer({
  client,
  signer: ed25519SignerFromEnv(),
  gasless: "auto", // or "always"
  gasStation: process.env.GAS_STATION_URL!, // the seller's facilitator base URL
});
```

- `"never"` (default): today's self-funded path, nothing changes.
- `"auto"`: pay with your own SUI when you have it; fall back to the gas
  station only when the SUI _gas floor_ is what failed. A USDC shortfall never
  falls back — sponsorship cannot conjure USDC.
- `"always"`: sponsored only; the payer's SUI is never touched.

## Seller advertisement (optional)

A sponsoring seller can advertise its gas station in the 402 so payers can
detect misconfiguration:

```ts
createSeller({
  ...options,
  extra: { "sui.gasStation": { url: FACILITATOR_URL } },
});
```

The payer never adopts an advertised URL. It only compares it against its own
configured `gasStation` and refuses with `deployment_mismatch` — before any
request — when they disagree. A seller that advertises nothing is not blocked;
the operator is responsible for pointing both sides at one deployment.

## Limits

- SUI-denominated payments cannot be sponsored (`unsupported_sponsored_asset`):
  a SUI payment is sourced from the gas coin, which under sponsorship belongs
  to the sponsor, leaving no payer-owned input to prove non-execution with.
- The gas station enforces per-sender and global daily caps and per-IP rate
  limits; the SDK maps each to a typed `GasStationError` and never retries
  into a cap.
- Sponsored transaction kinds carry no epoch bound; Enoki's own expiry
  applies. Uniqueness comes from a random nonce input baked into the kind.
