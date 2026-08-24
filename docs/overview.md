# Overview

## The problem

APIs are priced for humans. A developer signs up, gets a key, and pays a
subscription whether the API is used or not. That model breaks for the newest
class of API consumer: autonomous agents that need one answer from one endpoint,
possibly once, possibly from a service they discovered a second ago. They cannot
fill in a sign-up form, and a seller cannot afford to onboard each of them.

HTTP anticipated this. Status code `402 Payment Required` was reserved in 1997
and never standardised. x402 standardises it: the server answers a request with
the price and a payee, the client retries with a signed on-chain payment
attached, and a facilitator verifies and settles it. The whole exchange is two
HTTP requests and carries no accounts, sessions or card numbers.

x402 is governed by the Linux Foundation's x402 Foundation (launched July
2026, contributed by Coinbase) and has production implementations for EVM
chains from Stripe, AWS, Cloudflare and Coinbase. Sui is a natural fit: sub-second
finality, native USDC, an explicit focus on agent payments, and an official
`exact` scheme in the spec. What existed on Sui was one open-source reference
facilitator and, on the tooling side, a marketplace-specific dialect
(`@t2000/serve`: v1-style `X-PAYMENT` headers, a custom extension, the seller
settling payments itself). There was no standards-track middleware or client
library, nothing that speaks the x402 v2 wire format as specified and works
with any compliant facilitator. Every seller wanting that would have to build
the money path from scratch, which is exactly the part that must not be built
carelessly.

## What sui-x402 is

A TypeScript SDK suite that closes that gap without rebuilding what already works:

- **Seller side.** Middleware for Hono, Express and Next.js that turns any route
  into a paid route. It answers `402` with the terms, relays the payer's signed
  payment to the facilitator, and runs your handler only after settlement.
- **Payer side.** A `fetch` that pays. It reads the terms, builds and signs a
  Sui transaction for exactly the price, and retries the request — with spend
  caps, chain checks and a strict no-double-pay rule.
- **Shared core.** Schemas derived from live facilitator responses, the header
  codec, reason codes with retry semantics, and the single seller implementation
  every adapter wraps.
- **Facilitator deployment.** The reference facilitator is the settlement
  engine. This repo pins it as a submodule and ships the Docker, Fly.io and
  Railway configuration plus a runbook, so "self-host" is a deploy, not a port.

## Why this is the right shape

**Do not build a facilitator.** Verify, settle, replay protection, idempotent
settlement, gRPC failover — these are the parts of a payment system where bugs
cost money, and the reference implementation already handles them and is live
on mainnet. Rebuilding them is weeks of risk for zero differentiation. The
product is the developer experience on top.

**Non-custodial all the way down.** The payer signs a complete transaction.
Nobody downstream can change the amount, the recipient or the asset without
invalidating the signature, and nobody holds the payer's key but the payer. The
facilitator only broadcasts; the seller only relays.

**Fail closed.** The seller never serves content it has not been paid for. When
the facilitator is unreachable, the answer is `503` with `Retry-After`, and the
payer resends the same signed bytes, which the facilitator deduplicates by
digest. When verification fails, the reason code travels back to the payer so it
can decide whether to refetch terms, rebuild, or stop.

**Identical behaviour across frameworks.** One `createSeller` makes every
decision; the Hono, Express and Next adapters only translate requests and
responses. A shared conformance suite runs against all three and against the
core itself, so "the same behaviour" is something the tests enforce.

**Evidence over assumptions.** Schemas come from captured live responses, the
reason-code enum is pinned to the vendored facilitator's source by a test, the
facilitator's real behaviour is written down where it differs from the spec
([spec-notes](spec-notes.md)), and eight payments have settled on testnet end
to end ([status](status.md)).

## Who it is for

| You are | You use | You get |
|---|---|---|
| An API seller | `@sui-x402/hono`, `express` or `next` | A paid endpoint in a few lines, settled in USDC on Sui |
| An agent builder | `@sui-x402/payer-sui` | A `fetch` that transparently pays `402`s within the limits you set |
| An operator | `deploy/facilitator` | A self-hosted facilitator with a runbook |

## Non-goals

- Building or forking the facilitator. Fixes go upstream.
- Custody of any kind.
- Browser-wallet checkout for humans. The x402 payer is a program holding its
  own key; a "Pay with wallet" button is a different product.
- EVM chains. API shapes mirror the EVM SDKs so migration is a config change,
  but the code is Sui only.

## Status

Testnet, pre-1.0, unpublished. Mainnet requires explicit opt-ins on both sides
(`allowMainnet` for sellers, a pinned chain identifier for payers). See
[status.md](status.md) for what is proven, what is still only simulated, and
the remaining steps.
