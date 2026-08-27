import { describe, expect, it } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_TYPE_ARG } from "@mysten/sui/utils";
import type { PaymentRequirements } from "@sui-x402/core";
import type { OwnedCoin } from "../src/coins.js";
import {
  CHAIN_IDENTIFIERS,
  type PaymentClient,
  type SimulateInput,
} from "../src/tx.js";
import { buildSponsoredPaymentKind } from "../src/tx-sponsored.js";

const USDC =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const SENDER =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const PAY_TO =
  "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d";
const CHAIN_ID = CHAIN_IDENTIFIERS["sui:testnet"] ?? "";

const req = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "sui:testnet",
  amount: "10000",
  asset: USDC,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
  ...over,
});

let nextId = 1;
const coin = (balance: bigint, inner: string): OwnedCoin => {
  const i = nextId++;
  return {
    objectId: `0x${i.toString(16).padStart(64, "0")}`,
    version: String(i),
    digest: "11111111111111111111111111111111",
    type: `0x2::coin::Coin<${inner}>`,
    balance: balance.toString(),
  };
};

/** A payer that owns USDC and zero SUI; records which coin types are listed. */
function mockClient(assetCoins: OwnedCoin[]) {
  const listedTypes: string[] = [];
  const client: PaymentClient = {
    async listCoins(input) {
      listedTypes.push(input.coinType);
      return {
        objects: input.coinType === SUI_TYPE_ARG ? [] : assetCoins,
        hasNextPage: false,
        cursor: null,
      };
    },
    async getCurrentSystemState() {
      throw new Error("kind build must not read system state");
    },
    async getObject() {
      throw new Error("kind build must not read objects");
    },
    async getChainIdentifier() {
      return { chainIdentifier: CHAIN_ID };
    },
    async simulateTransaction(_input: SimulateInput) {
      throw new Error("kind build must not simulate");
    },
  };
  return { client, listedTypes };
}

describe("buildSponsoredPaymentKind", () => {
  it("builds kind bytes for a payer holding zero SUI, without ever listing SUI coins", async () => {
    const { client, listedTypes } = mockClient([coin(50_000n, USDC)]);
    const kind = await buildSponsoredPaymentKind({
      client,
      sender: SENDER,
      requirements: req(),
    });
    expect(kind.kindBytes.length).toBeGreaterThan(0);
    expect(kind.sender).toBe(SENDER);
    expect(kind.amount).toBe(10000n);
    expect(kind.paymentCoin.objectId).toBeDefined();
    expect(listedTypes).not.toContain(SUI_TYPE_ARG);
    const data = Transaction.fromKind(kind.kindBytes).getData();
    expect(data.sender).toBeNull();
  });

  it("round-trips as a kind: no gas data, merge/split/transfer to payTo, and an extra pure input", async () => {
    const { client } = mockClient([coin(6_000n, USDC), coin(5_000n, USDC)]);
    const kind = await buildSponsoredPaymentKind({
      client,
      sender: SENDER,
      requirements: req(),
    });
    const data = Transaction.fromKind(kind.kindBytes).getData();
    expect(data.gasData.payment).toBeNull();
    expect(data.gasData.owner).toBeNull();
    const kinds = data.commands.map(
      (c) => Object.keys(c).filter((k) => k !== "$kind")[0]
    );
    expect(kinds).toEqual(["MergeCoins", "SplitCoins", "TransferObjects"]);
    const pureInputs = data.inputs.filter(
      (i) => "Pure" in i && i.Pure !== undefined
    );
    // the split amount and the transfer recipient are pure too; the nonce adds one more
    expect(pureInputs.length).toBeGreaterThanOrEqual(3);
  });

  it("two builds from identical requirements produce different kind bytes (E20)", async () => {
    const c1 = coin(50_000n, USDC);
    const kindA = await buildSponsoredPaymentKind({
      client: mockClient([c1]).client,
      sender: SENDER,
      requirements: req(),
    });
    const kindB = await buildSponsoredPaymentKind({
      client: mockClient([c1]).client,
      sender: SENDER,
      requirements: req(),
    });
    expect(
      Buffer.from(kindA.kindBytes).equals(Buffer.from(kindB.kindBytes))
    ).toBe(false);
  });

  it("refuses a SUI-denominated payment before touching any coin (E9)", async () => {
    const { client, listedTypes } = mockClient([]);
    await expect(
      buildSponsoredPaymentKind({
        client,
        sender: SENDER,
        requirements: req({ asset: SUI_TYPE_ARG }),
      })
    ).rejects.toMatchObject({
      name: "PaymentBuildError",
      reason: "unsupported_sponsored_asset",
    });
    expect(listedTypes).toEqual([]);
  });
});
