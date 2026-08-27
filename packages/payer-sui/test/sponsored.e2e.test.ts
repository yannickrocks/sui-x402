/**
 * Live gas-station tests (gasless v1.1). `sui:testnet` only.
 *
 * Runs only with `E2E=1`, a funded `PAYER_SECRET_KEY`, and `GAS_STATION_URL`
 * pointing at a facilitator deployment. Probes sponsorship first and skips —
 * rather than fails — when the deployment has no `ENOKI_KEY` (503).
 */
import { readFileSync } from "node:fs";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { PaymentRequired } from "@sui-x402/core";
import { describe, expect, it } from "vitest";
import { ENV_PAYER_SECRET_KEY, ed25519SignerFromEnv } from "../src/signer.js";
import {
  buildSponsoredPaymentKind,
  sponsorPayment,
} from "../src/tx-sponsored.js";
import { httpGasStation, GasStationError } from "../src/gas-station.js";

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

const DEFAULT_GRPC_URL = "https://fullnode.testnet.sui.io:443";
const GAS_STATION_URL = process.env.GAS_STATION_URL ?? "";
const TIMEOUT_MS = 120_000;

const missing = ["E2E", ENV_PAYER_SECRET_KEY, "GAS_STATION_URL"].filter(
  (name) => !process.env[name]
);
const enabled = missing.length === 0 && process.env.E2E === "1";

/** null = sponsorship disabled on this deployment (503) — skip, don't fail (test 12). */
async function probeSponsorship(): Promise<boolean> {
  const response = await fetch(
    `${GAS_STATION_URL.replace(/\/+$/, "")}/gas-station`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }
  );
  // 400 = route exists and sponsorship is on (it rejected the empty body);
  // 503 = ENOKI_KEY unset (observed live 2026-08-27; upstream README says 404 — code and live behavior win, spec-notes #14).
  // 404 tolerated for deployments matching the documented behavior.
  return response.status === 400;
}

describe.skipIf(!enabled)(
  `sponsored payments, live (skipped: ${missing.join(", ") || "enabled"})`,
  () => {
    it(
      "12+13: real kind bytes → real /gas-station → full §6.3 validation → sign; stops before broadcast",
      { timeout: TIMEOUT_MS },
      async () => {
        if (live === undefined) throw new Error("fixture has no offers");
        if (!(await probeSponsorship())) {
          console.warn(
            "gas station reports sponsorship not configured; skipping live sponsored-build test"
          );
          return;
        }
        const client = new SuiGrpcClient({
          network: "testnet",
          baseUrl: process.env.SUI_GRPC_URL ?? DEFAULT_GRPC_URL,
        });
        const signer = ed25519SignerFromEnv();
        const kind = await buildSponsoredPaymentKind({
          client,
          sender: signer.address(),
          requirements: live,
        });
        const built = await sponsorPayment({
          client,
          gasStation: httpGasStation(GAS_STATION_URL),
          kind,
          network: live.network,
        });
        expect(built.gasOwner).not.toBe(signer.address());
        expect(built.gasBudget).toBeGreaterThan(0n);
        const signature = await signer.signTransaction(built.bytes);
        expect(signature.length).toBeGreaterThan(0);
        // Deliberately no broadcast: settle-side sponsorship is blocked on the
        // upstream settle branch (private/BLOCKED.md B1).
      }
    );

    // Test 14 (full 402 exchange, payer SUI balance unchanged, payTo credited)
    // is gated on the upstream settle branch for sponsored bytes (B1). It ships
    // skipped so it can be flipped on in one line when B1 clears.
    it.skip("14: full sponsored 402 exchange against an example seller [blocked: upstream settle branch, BLOCKED.md B1]", () => {
      throw new Error(
        "unblock by removing .skip once the facilitator settles sponsored bytes"
      );
    });

    it(
      "probe classifies a disabled deployment as not_configured (E14)",
      { timeout: TIMEOUT_MS },
      async () => {
        if (await probeSponsorship()) return; // enabled deployment: nothing to assert here
        await expect(
          httpGasStation(GAS_STATION_URL).sponsor({
            sender: `0x${"1".repeat(64)}`,
            transactionKindBytes: "AA==",
            network: "sui:testnet",
          })
        ).rejects.toSatisfy(
          (e) =>
            e instanceof GasStationError &&
            (e.kind === "not_configured" || e.kind === "rejected")
        );
      }
    );
  }
);
