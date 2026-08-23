# example-next-paywall

A Next.js App Router app with one paid route, `GET /api/quote`, guarded by
`@sui-x402/next`, and a page that shows the terms and how an agent pays them.

## Run

```sh
cp examples/next-paywall/.env.example examples/next-paywall/.env.local   # set PAY_TO
pnpm --filter example-next-paywall dev                                   # http://localhost:3000 (build:next / start for production)
curl -i http://localhost:3000/api/quote                                  # 402 + PAYMENT-REQUIRED
```

`dev`/`start` raise Node's header limit (`--max-http-header-size=262144`): a
signed payment is up to 120 KB of base64 in one header.

## Where the paywall is

- `lib/seller.ts` — one `createSeller(...)` from env; throws at import on bad config.
- `app/api/quote/route.ts` — `export const GET = withX402(seller)(handler)`, `runtime = "nodejs"`.
- `app/page.tsx` — renders the terms and the payer snippet. No client-side wallet: the
  payer in x402 is an agent holding its own key, not a browser.

## Test

`pnpm --filter example-next-paywall test` drives the route in-process against a
scripted facilitator. The live 402→pay→200 loop is exercised by the hono and
express examples' `E2E=1` tests; this route behaves identically (same seller core,
same conformance suite in `@sui-x402/next`).
