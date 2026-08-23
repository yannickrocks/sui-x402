/**
 * The full loop against the live testnet facilitator (roadmap M3.4): the example
 * server answers 402, `@sui-x402/payer-sui` pays it, the replay returns 200 with
 * a settlement receipt — and an unpaid request afterwards is still 402.
 *
 * Runs only with `E2E=1`, a funded `PAYER_SECRET_KEY` and a `PAY_TO` address
 * that is not the payer's own (docs/status.md). Nothing runs at import time:
 * no server, no client, no signer, no network.
 */
import { type Server, createServer } from "node:http";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { HEADER_PAYMENT_REQUIRED } from "@sui-x402/core";
import {
  ENV_PAYER_SECRET_KEY,
  SuiX402Payer,
  ed25519SignerFromEnv,
} from "@sui-x402/payer-sui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

/** The public testnet demo facilitator, for the e2e only; a deployment runs its own (PRD §8.16). */
const DEFAULT_FACILITATOR_URL = "https://sui-facilitator.onrender.com";
const DEFAULT_ASSET =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const DEFAULT_GRPC_URL = "https://fullnode.testnet.sui.io:443";
/** Matches the limit `src/server.ts` sets: a signed transaction does not fit in Node's default header buffer. */
const MAX_HEADER_BYTES = 262_144;
const TIMEOUT_MS = 120_000;

/** `||`, not `??`: a sourced `.env` turns an unset variable into an empty string. */
const env = (name: string, fallback: string): string =>
  process.env[name] || fallback;

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const ASSET = env("ASSET", DEFAULT_ASSET);
const AMOUNT = env("AMOUNT", "10000");

const missing = ["E2E", ENV_PAYER_SECRET_KEY, "PAY_TO"].filter(
  (name) => !process.env[name]
);
if (missing.length > 0) {
  console.log(
    `e2e skipped: ${missing.join(" and ")} not set — see docs/status.md`
  );
}

describe.skipIf(missing.length > 0)("express example: 402 → pay → 200", () => {
  let server: Server | undefined;
  let base: string;

  beforeAll(async () => {
    const app = createApp({
      payTo: required("PAY_TO"),
      amount: AMOUNT,
      asset: ASSET,
      network: "sui:testnet",
      facilitator: env("FACILITATOR_URL", DEFAULT_FACILITATOR_URL),
    });
    const listening = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, app);
    await new Promise<void>((resolve) => {
      listening.listen(0, "127.0.0.1", resolve);
    });
    server = listening;
    const address = listening.address();
    if (typeof address !== "object" || address === null)
      throw new Error("server did not bind a TCP port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => {
    // Optional because a failed `beforeAll` (a bad PAY_TO, say) never bound one,
    // and a TypeError here would bury the real error.
    // `close` alone waits on the payer's keep-alive sockets; `unref` lets the run end.
    server?.close();
    server?.unref();
  });

  it(
    "pays the guarded route and still charges the next caller",
    async () => {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      const payer = new SuiX402Payer({
        client: new SuiGrpcClient({
          network: "testnet",
          baseUrl: env("SUI_GRPC_URL", DEFAULT_GRPC_URL),
        }),
        signer: ed25519SignerFromEnv(),
        // Fail safe if the terms drifted above what this test agreed to pay:
        // selection throws before anything is signed rather than overpaying.
        select: { assets: [ASSET], maxAmount: { [ASSET]: BigInt(AMOUNT) } },
      });

      const { response, receipt } = await payer.fetchWithReceipt(
        `${base}/paid/quote`
      );
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toMatchObject({
        symbol: "SUI",
        quote: expect.any(String),
        paidAt: expect.any(String),
      });

      if (receipt === null)
        throw new Error("200 answer carried no PAYMENT-RESPONSE header");
      expect(receipt.settle.success).toBe(true);
      expect(receipt.digest).not.toBe("");
      console.log(
        `e2e settled: https://testnet.suivision.xyz/txblock/${receipt.digest}`
      );

      // A paid request buys one response, not a session.
      const unpaid = await fetch(`${base}/paid/quote`);
      expect(unpaid.status).toBe(402);
      expect(unpaid.headers.get(HEADER_PAYMENT_REQUIRED)).not.toBeNull();
      expect(await unpaid.json()).toMatchObject({ x402Version: 2 });
    },
    TIMEOUT_MS
  );
});
