import { describe, expect, it } from "vitest";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { SUI_TYPE_ARG, fromBase64, toBase64 } from "@mysten/sui/utils";
import type { PaymentRequirements } from "@sui-x402/core";
import type { OwnedCoin } from "../src/coins.js";
import type { GasStationClient, SponsorRequest } from "../src/gas-station.js";
import {
  CHAIN_IDENTIFIERS,
  type BalanceChange,
  type PaymentClient,
  type SimulateInput,
} from "../src/tx.js";
import {
  type SponsoredPaymentKind,
  buildSponsoredPaymentKind,
  sponsorPayment,
} from "../src/tx-sponsored.js";

const USDC =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const SENDER =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const SPONSOR =
  "0x2222222222222222222222222222222222222222222222222222222222222222";
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

const credit = (amount: bigint): BalanceChange[] => [
  { coinType: USDC, address: PAY_TO, amount: amount.toString() },
];

function mockClient(assetCoins: OwnedCoin[], balanceChanges?: BalanceChange[]) {
  const simulations: Uint8Array[] = [];
  const client: PaymentClient = {
    async listCoins(input) {
      return {
        objects: input.coinType === SUI_TYPE_ARG ? [] : assetCoins,
        hasNextPage: false,
        cursor: null,
      };
    },
    async getCurrentSystemState() {
      throw new Error("not needed");
    },
    async getObject() {
      throw new Error("not needed");
    },
    async getChainIdentifier() {
      return { chainIdentifier: CHAIN_ID };
    },
    async simulateTransaction(input: SimulateInput) {
      simulations.push(input.transaction);
      return {
        $kind: "Transaction",
        Transaction: {
          effects: {
            gasUsed: {
              computationCost: "1000000",
              storageCost: "0",
              storageRebate: "0",
            },
          },
          balanceChanges: balanceChanges ?? credit(10000n),
        },
      };
    },
  };
  return { client, simulations };
}

/** A well-behaved sponsor: fills sender + sponsor gas onto the submitted kind. */
async function sponsorFill(
  kindBytes: Uint8Array,
  over: { sender?: string; gasOwner?: string; budget?: bigint } = {}
): Promise<Uint8Array> {
  const tx = Transaction.fromKind(kindBytes);
  tx.setSender(over.sender ?? SENDER);
  tx.setGasOwner(over.gasOwner ?? SPONSOR);
  tx.setGasPayment([
    {
      objectId: `0x${"9".repeat(64)}`,
      version: "7",
      digest: "11111111111111111111111111111111",
    },
  ]);
  tx.setGasPrice(1000n);
  tx.setGasBudget(over.budget ?? 5_000_000n);
  return tx.build();
}

function station(
  bytesFor: (req: SponsorRequest) => Promise<{ bytes: string; digest: string }>
) {
  const requests: SponsorRequest[] = [];
  const client: GasStationClient = {
    baseUrl: "https://facilitator.example",
    async sponsor(request) {
      requests.push(request);
      return bytesFor(request);
    },
  };
  return { client, requests };
}

const honest = (
  mutate?: (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array,
  digestOf?: (bytes: Uint8Array) => string
) =>
  station(async (request) => {
    let bytes = await sponsorFill(fromBase64(request.transactionKindBytes));
    if (mutate) bytes = await mutate(bytes);
    return {
      bytes: toBase64(bytes),
      digest: (digestOf ?? TransactionDataBuilder.getDigestFromBytes)(bytes),
    };
  });

async function kindFor(client: PaymentClient): Promise<SponsoredPaymentKind> {
  return buildSponsoredPaymentKind({
    client,
    sender: SENDER,
    requirements: req(),
  });
}

describe("sponsorPayment (§6.3 validation)", () => {
  it("accepts an honest sponsor response and returns the validated payment", async () => {
    const { client, simulations } = mockClient([coin(50_000n, USDC)]);
    const kind = await kindFor(client);
    const { client: gasStation, requests } = honest();
    const built = await sponsorPayment({
      client,
      gasStation,
      kind,
      network: "sui:testnet",
    });
    expect(built.sender).toBe(SENDER);
    expect(built.gasOwner).toBe(SPONSOR);
    expect(built.amount).toBe(10000n);
    expect(built.paymentCoin).toEqual(kind.paymentCoin);
    expect(built.digest).toBe(
      TransactionDataBuilder.getDigestFromBytes(built.bytes)
    );
    // request shape (E4, E18): recipients include payTo, network unsplit
    expect(requests[0]?.recipients).toEqual([PAY_TO]);
    expect(requests[0]?.network).toBe("sui:testnet");
    expect(requests[0]?.transactionKindBytes).toBe(toBase64(kind.kindBytes));
    // the returned full bytes were simulated for the payTo self-check
    expect(
      simulations.some((s) => Buffer.from(s).equals(Buffer.from(built.bytes)))
    ).toBe(true);
  });

  it("rejects bytes whose kind differs from the submitted kind (E5)", async () => {
    const { client } = mockClient([coin(50_000n, USDC)]);
    const kind = await kindFor(client);
    const { client: gasStation } = station(async (request) => {
      // sponsor swaps in a different kind: same coin, doubled amount
      const other = await buildSponsoredPaymentKind({
        client,
        sender: SENDER,
        requirements: req({ amount: "20000" }),
      });
      void request;
      const bytes = await sponsorFill(other.kindBytes);
      return {
        bytes: toBase64(bytes),
        digest: TransactionDataBuilder.getDigestFromBytes(bytes),
      };
    });
    await expect(
      sponsorPayment({ client, gasStation, kind, network: "sui:testnet" })
    ).rejects.toMatchObject({
      name: "PaymentBuildError",
      reason: "sponsor_altered_payment",
    });
  });

  it("rejects gasData.owner === sender (E6)", async () => {
    const { client } = mockClient([coin(50_000n, USDC)]);
    const kind = await kindFor(client);
    const { client: gasStation } = station(async (request) => {
      const bytes = await sponsorFill(
        fromBase64(request.transactionKindBytes),
        { gasOwner: SENDER }
      );
      return {
        bytes: toBase64(bytes),
        digest: TransactionDataBuilder.getDigestFromBytes(bytes),
      };
    });
    await expect(
      sponsorPayment({ client, gasStation, kind, network: "sui:testnet" })
    ).rejects.toMatchObject({
      reason: "sponsor_response_invalid",
    });
  });

  it("rejects a digest that does not match the bytes (E11)", async () => {
    const { client } = mockClient([coin(50_000n, USDC)]);
    const kind = await kindFor(client);
    const { client: gasStation } = honest(
      undefined,
      () => "3vk2GDBW11ZLCVpBEMg8pFa32sdGvDaDGr9CU2kX52NB"
    );
    await expect(
      sponsorPayment({ client, gasStation, kind, network: "sui:testnet" })
    ).rejects.toMatchObject({
      reason: "sponsor_response_invalid",
    });
  });

  it("rejects a wrong sender and an over-protocol gas budget (§6.3 items 2 and 4)", async () => {
    const { client } = mockClient([coin(50_000n, USDC)]);
    const kind = await kindFor(client);
    const wrongSender = station(async (request) => {
      const bytes = await sponsorFill(
        fromBase64(request.transactionKindBytes),
        { sender: SPONSOR, gasOwner: `0x${"3".repeat(64)}` }
      );
      return {
        bytes: toBase64(bytes),
        digest: TransactionDataBuilder.getDigestFromBytes(bytes),
      };
    });
    await expect(
      sponsorPayment({
        client,
        gasStation: wrongSender.client,
        kind,
        network: "sui:testnet",
      })
    ).rejects.toMatchObject({ reason: "sponsor_response_invalid" });

    const hugeBudget = station(async (request) => {
      const bytes = await sponsorFill(
        fromBase64(request.transactionKindBytes),
        { budget: 50_000_000_000_001n }
      );
      return {
        bytes: toBase64(bytes),
        digest: TransactionDataBuilder.getDigestFromBytes(bytes),
      };
    });
    await expect(
      sponsorPayment({
        client,
        gasStation: hugeBudget.client,
        kind,
        network: "sui:testnet",
      })
    ).rejects.toMatchObject({ reason: "sponsor_response_invalid" });
  });

  it("rejects when the simulation credits payTo below amount (E7), with the existing reason code", async () => {
    const { client } = mockClient([coin(50_000n, USDC)], credit(9_999n));
    const kind = await kindFor(client);
    const { client: gasStation } = honest();
    await expect(
      sponsorPayment({ client, gasStation, kind, network: "sui:testnet" })
    ).rejects.toMatchObject({
      reason: "self_check_failed",
    });
  });
});

describe("sponsorPayment malformed bytes", () => {
  it("maps non-BCS sponsor bytes to a typed sponsor_response_invalid, not a raw throw", async () => {
    const { client } = mockClient([coin(50_000n, USDC)]);
    const kind = await kindFor(client);
    const { client: gasStation } = station(async () => ({ bytes: "bm90IGEgdHJhbnNhY3Rpb24=", digest: "x" }));
    await expect(sponsorPayment({ client, gasStation, kind, network: "sui:testnet" })).rejects.toMatchObject({
      name: "PaymentBuildError",
      reason: "sponsor_response_invalid",
    });
  });
});
