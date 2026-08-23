/**
 * Live testnet payment against the demo resource (roadmap M2.7).
 *
 * Runs only with `E2E=1` and a funded `PAYER_SECRET_KEY`; the wallet is funded
 * by a human (docs/status.md), so by default this file skips and says why.
 * Nothing but the captured 402 fixture the expectations derive from is read at
 * import time: no client, no signer, no network.
 */
import { readFileSync } from "node:fs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { PaymentRequired } from "@sui-x402/core";
import { describe, expect, it } from "vitest";
import { SuiX402Payer } from "../src/payer.js";
import { ENV_PAYER_SECRET_KEY, ed25519SignerFromEnv } from "../src/signer.js";

const fixture = PaymentRequired.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../core/fixtures/demo-402.payment-required.json",
        import.meta.url
      ),
      "utf8"
    )
  )
);
const live = fixture.accepts[0];
// The public demo seller is broken today (spec-notes #12); point this at any
// seller advertising the fixture's terms, e.g. examples/hono-server.
const RESOURCE_URL = process.env.X402_RESOURCE_URL || fixture.resource.url;
const USDC = live.asset;
const AMOUNT = live.amount;

const DEFAULT_GRPC_URL = "https://fullnode.testnet.sui.io:443";
const TIMEOUT_MS = 120_000;
const explorerUrl = (digest: string): string =>
  `https://testnet.suivision.xyz/txblock/${digest}`;

const missing = ["E2E", ENV_PAYER_SECRET_KEY].filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.log(
    `e2e skipped: ${missing.join(" and ")} not set — see docs/status.md`
  );
}

describe.skipIf(missing.length > 0)("live testnet payment", () => {
  it(
    "pays the demo resource and the settlement digest executes on chain",
    async () => {
      const client = new SuiGrpcClient({
        network: "testnet",
        // `??` would keep an empty `SUI_GRPC_URL=` from a sourced .env.
        baseUrl: process.env.SUI_GRPC_URL || DEFAULT_GRPC_URL,
      });
      const signer = ed25519SignerFromEnv();
      const owner = signer.address();

      // `balance.balance` also counts the address balance, which the payment
      // path cannot spend: it builds from `Coin<T>` objects only.
      const { balance } = await client.getBalance({ owner, coinType: USDC });
      const held = BigInt(balance.coinBalance);
      expect(
        held >= BigInt(AMOUNT),
        `payer ${owner} holds ${held} atomic units of ${USDC} in coin objects, needs ${AMOUNT}. ` +
          `Fund the wallet as described in docs/status.md.`
      ).toBe(true);

      // Fail safe if the live terms have drifted above the fixture: selection
      // throws before anything is signed rather than overpaying.
      const payer = new SuiX402Payer({
        client,
        signer,
        select: { assets: [USDC], maxAmount: { [USDC]: BigInt(AMOUNT) } },
      });
      const { response, receipt } = await payer.fetchWithReceipt(RESOURCE_URL);

      expect(response.status).toBe(200);
      if (receipt === null)
        throw new Error("200 answer carried no PAYMENT-RESPONSE header");
      expect(receipt.settle.success).toBe(true);
      expect(receipt.digest).not.toBe("");
      expect(receipt.amount).toBe(AMOUNT);
      console.log(`e2e settled: ${explorerUrl(receipt.digest)}`);

      const executed = await client.waitForTransaction({
        digest: receipt.digest,
      });
      if (executed.$kind !== "Transaction") {
        throw new Error(
          `settlement ${receipt.digest} failed on chain: ` +
            `${
              executed.FailedTransaction.status.error?.message ??
              "unknown execution error"
            }`
        );
      }
      expect(executed.Transaction.status.success).toBe(true);
    },
    TIMEOUT_MS
  );
});
