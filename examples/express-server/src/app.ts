/**
 * The example app: one free route and one paid route, and nothing else.
 *
 * `createApp` takes either seller options or a `Seller`, so `src/server.ts` can
 * build the seller first (to check the facilitator at boot) and the e2e test can
 * pass options straight through. Everything payment-related is decided by
 * `@sui-x402/core`'s seller behind `x402()`; this file only serves content.
 */
import { x402, type Seller, type SellerOptions } from "@sui-x402/express";
import express, { type Express } from "express";

/** Synthetic: the example sells a fixed number, not market data. */
const QUOTE = "1.8400";

export function createApp(options: SellerOptions | Seller): Express {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/paid/quote", x402(options), (_req, res) => {
    res.json({ symbol: "SUI", quote: QUOTE, paidAt: new Date().toISOString() });
  });

  return app;
}
