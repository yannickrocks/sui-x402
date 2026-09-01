# RPC proxy — a trusted second endpoint for a keyed provider

> **Not part of the current deployment.** The provider in use (Chainstack)
> accepts its key as a URL path segment, so the facilitator points straight at
> it and needs no proxy — see [D16](../../docs/decisions.md). This directory is
> kept for the providers that are header-only (Ankr, BlockPi, ZAN, QuickNode):
> if you switch to one of those, or Chainstack stops accepting path auth, this
> is the way back. Deploy it only if `deploy/verify-rpc-endpoints.mjs` cannot
> authenticate your provider from a URL alone.

## Why this exists

`SUI_MAINNET_RPC` should hold **two** endpoints you trust, because the
facilitator believes whatever a node tells it (dry-run results, balance changes,
digest lookups) when validating real-money payments.

Finding the second one is constrained by protocol, not just trust:

- The facilitator constructs `new SuiGrpcClient({ network, baseUrl })`
  (`upstream/src/rpc.ts:78-79`) — **a base URL and no headers.**
- That client speaks **gRPC-Web**, not native gRPC. Endpoints serving only
  native gRPC are unusable. `sui-grpc.publicnode.com` is one: it answers
  `HTTP 415 / content-type application/grpc` to a gRPC-Web request.
- Every commercial Sui gRPC provider measured (Ankr, Chainstack, BlockPi, ZAN,
  QuickNode, Triton paid tiers) authenticates with an **`x-token` header**,
  which the facilitator cannot send.

gRPC-Web is ordinary HTTP POST, so a reverse proxy can add the header. This
service is that proxy: the facilitator points at it by URL, it injects the key.
Verified with the pinned `@mysten/sui@2.17.0`: a header-injecting HTTP proxy in
front of a Sui node returns correct `getChainIdentifier` and `getCoinMetadata`
results to the SDK.

Not needed if your second endpoint is a **self-hosted Sui fullnode** — a stock
node serves gRPC-Web unconditionally and needs no auth, so point the facilitator
straight at it.

## Deploy

1. Create the provider account and API key (Chainstack's Developer plan is free
   and confirmed gRPC-Web; Ankr and BlockPi also work).
2. New Railway service from this directory. Do **not** give it a public domain —
   it should be reachable only on private networking, so the key never faces the
   internet.
3. Set on **this** service (platform secrets, never committed):
   - `RPC_UPSTREAM_HOST` — e.g. `sui-mainnet.core.chainstack.com`
   - `RPC_PROVIDER_TOKEN` — the API key
   - `RPC_AUTH_HEADER` — only if the provider uses something other than `x-token`
4. On the **facilitator** service, list the proxy as the second endpoint:
   ```
   SUI_MAINNET_RPC=https://fullnode.mainnet.sui.io,http://<proxy-service>.railway.internal:8080
   ```

## Verify — do not skip

The facilitator logs `rpc endpoint N failed … trying next` only when it falls
over, so a broken or wrong-chain second endpoint is **invisible until the
primary dies**. Prove both endpoints answer:

```sh
node ../verify-rpc-endpoints.mjs mainnet "$SUI_MAINNET_RPC"
```

Every endpoint must report PASS. A `not gRPC-Web` failure means the provider
speaks only native gRPC; a `status 16 / Access token missing` means the header
injection is not reaching the provider; `WRONG CHAIN` means the endpoint is on a
different network than you think.

## Trade-offs

- Adds a hop and a failure point. It is the _second_ endpoint, so if it dies the
  facilitator still runs on the Mysten primary — but you are then back to one
  endpoint, which the verify script will tell you.
- You now trust the proxy as well as the provider. It is your service, on
  private networking, with a single upstream — keep it that way.
- A cleaner long-term fix is upstream support for per-endpoint headers, which
  would delete this service entirely. Worth requesting alongside the hardening
  findings.
