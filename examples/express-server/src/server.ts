/**
 * Boots the example on Node. Every knob is an environment variable documented in
 * `.env.example`; no secret is read here and none is logged — the seller side of
 * x402 never holds a key.
 */
import { createServer } from "node:http";
import { SuiNetwork } from "@sui-x402/core";
import { createSeller } from "@sui-x402/express";
import { createApp } from "./app.js";

/**
 * Self-hosted facilitator (PRD §8.16). The public testnet demo instance
 * `https://sui-facilitator.onrender.com` works for a first run, but production
 * deployments run their own — see `docs/facilitator-runbook.md`.
 */
const DEFAULT_FACILITATOR_URL = "http://localhost:4402";
/** Testnet USDC, 6 decimals (packages/core/fixtures/demo-402.payment-required.json). */
const DEFAULT_ASSET =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
/** A PAYMENT-SIGNATURE header carries a base64 transaction; core caps it at 120,000 chars, far past Node's 16 KB default. */
const MAX_HEADER_BYTES = 262_144;

/** `||`, not `??`: a sourced `.env` turns an unset variable into an empty string. */
const env = (name: string, fallback: string): string => process.env[name] || fallback;

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required — see examples/express-server/.env.example`);
  return value;
};

const parseMode = (raw: string): "strict" | "fast" => {
  if (raw !== "strict" && raw !== "fast") throw new Error(`MODE must be "strict" or "fast", got "${raw}"`);
  return raw;
};

const parsePort = (raw: string): number => {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`PORT must be a TCP port, got "${raw}"`);
  return port;
};

const facilitator = env("FACILITATOR_URL", DEFAULT_FACILITATOR_URL);
const seller = createSeller({
  payTo: required("PAY_TO"),
  amount: env("AMOUNT", "10000"),
  asset: env("ASSET", DEFAULT_ASSET),
  network: SuiNetwork.parse(env("NETWORK", "sui:testnet")),
  facilitator,
  mode: parseMode(env("MODE", "strict")),
  description: "A synthetic SUI quote",
  mimeType: "application/json",
});

// PRD §8.15: a wrong network, a wrong scheme or a dead facilitator is a boot
// failure, not a 503 on every request.
await seller.assertFacilitatorSupports();

const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, createApp(seller));
const { amount, asset, payTo, network } = seller.requirements;
server.listen(parsePort(env("PORT", "8402")), () => {
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : address;
  console.log(
    `example-express-server on http://localhost:${bound} — free GET /health, ` +
      `paid GET /paid/quote costs ${amount} atomic units of ${asset} to ${payTo} ` +
      `on ${network} (${seller.mode} mode, facilitator ${facilitator})`,
  );
});
