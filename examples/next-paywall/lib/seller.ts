/**
 * One seller for the whole app, configured from the environment.
 */
import { createSeller, type Seller } from "@sui-x402/next";
import { SuiNetwork } from "@sui-x402/core";

/** Circle's testnet USDC. */
const TESTNET_USDC =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
};

export const sellerOptions = {
  payTo: required("PAY_TO"),
  amount: process.env.AMOUNT || "10000",
  asset: process.env.ASSET || TESTNET_USDC,
  network: SuiNetwork.parse(process.env.NETWORK || "sui:testnet"),
  // Your self-hosted facilitator (docs/facilitator-runbook.md). This project's
  // testnet instance, https://facilitator-production-1e79.up.railway.app, works for
  // trying it out.
  facilitator: process.env.FACILITATOR_URL || "http://localhost:4402",
  description: "A SUI price quote, paid per request",
  mimeType: "application/json",
} as const;

export const seller: Seller = createSeller(sellerOptions);
