---
"@sui-x402/payer-sui": patch
"@sui-x402/hono": patch
"@sui-x402/express": patch
---

Update runtime dependencies: `@mysten/sui` to ^2.38.0 (payer-sui) and `hono` to ^4.13.14 (hono middleware). The express middleware's `express` peer range now also accepts Express 5 (`^4.21.0 || ^5.0.0`); its tests run against Express 5.
