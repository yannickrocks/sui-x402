import { describe, expect, it } from "vitest";
import { TransactionError } from "@mysten/sui/client";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { bcs } from "@mysten/sui/bcs";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { SUI_TYPE_ARG, fromBase64, normalizeSuiAddress, toBase58 } from "@mysten/sui/utils";
import type { PaymentRequirements } from "@sui-x402/core";
import { InsufficientBalanceError, type OwnedCoin } from "../src/coins.js";
import {
  type BalanceChange,
  type GasCostSummary,
  type PaymentClient,
  type SimulateInput,
  DEFAULT_MAX_GAS_BUDGET,
  PaymentBuildError,
  buildPaymentTransaction,
  computeGasBudget,
  receivedBy,
} from "../src/tx.js";

const USDC = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const SENDER = "0x1111111111111111111111111111111111111111111111111111111111111111";
const PAY_TO = "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d";
const GAS_USED: GasCostSummary = { computationCost: "1000000", storageCost: "2000000", storageRebate: "500000" };
/** computeGasBudget(GAS_USED, 1000, 20): max(2_000_000, 3_500_000) * 1.2 */
const EXPECTED_BUDGET = 4_200_000n;

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

const credit = (amount: bigint, asset = USDC, address = PAY_TO): BalanceChange[] => [
  { coinType: asset, address, amount: amount.toString() },
];

/** A chain identifier is the genesis checkpoint digest: 32 bytes base58, or BCS rejects it. */
const CHAIN_ID = toBase58(new Uint8Array(32).fill(9));
const EPOCH = "1199";
const NO_CALLS = { listCoins: 0, getCurrentSystemState: 0, getChainIdentifier: 0, getTransaction: 0, simulateTransaction: 0 };

interface MockOptions {
  sui: OwnedCoin[];
  asset?: OwnedCoin[];
  gasPrice?: string;
  gasUsed?: GasCostSummary;
  balanceChanges?: BalanceChange[];
  failWith?: string;
  throwWith?: string;
  chainIdentifier?: string;
}

function mockClient(o: MockOptions) {
  const simulations: Uint8Array[] = [];
  const calls = { ...NO_CALLS };
  const client: PaymentClient = {
    async listCoins(input) {
      calls.listCoins++;
      const objects = input.coinType === SUI_TYPE_ARG ? o.sui : (o.asset ?? []);
      return { objects, hasNextPage: false, cursor: null };
    },
    async getCurrentSystemState() {
      calls.getCurrentSystemState++;
      return { systemState: { epoch: EPOCH, referenceGasPrice: o.gasPrice ?? "1000" } };
    },
    async getTransaction({ digest }) {
      calls.getTransaction++;
      throw new TransactionError("notFound", digest);
    },
    async getChainIdentifier() {
      calls.getChainIdentifier++;
      return { chainIdentifier: o.chainIdentifier ?? CHAIN_ID };
    },
    async simulateTransaction(input: SimulateInput) {
      calls.simulateTransaction++;
      simulations.push(input.transaction);
      if (o.throwWith !== undefined) throw new Error(o.throwWith);
      if (o.failWith !== undefined) {
        return { $kind: "FailedTransaction", FailedTransaction: { status: { error: { message: o.failWith } } } };
      }
      return {
        $kind: "Transaction",
        Transaction: { effects: { gasUsed: o.gasUsed ?? GAS_USED }, balanceChanges: o.balanceChanges ?? credit(10000n) },
      };
    },
  };
  return { client, simulations, calls };
}

const decode = (bytes: Uint8Array) => Transaction.from(bytes).getData();

function validDuring(data: ReturnType<typeof decode>) {
  const v = data.expiration?.ValidDuring;
  if (!v) throw new Error(`expected a ValidDuring expiration, got ${JSON.stringify(data.expiration)}`);
  return v;
}

const at = <T>(xs: readonly T[], i: number): T => {
  const v = xs[i];
  if (v === undefined) throw new Error(`missing index ${i}`);
  return v;
};

function objectIdOfInput(data: ReturnType<typeof decode>, arg: { $kind: string; Input?: number }): string {
  if (arg.$kind !== "Input" || arg.Input === undefined) throw new Error(`expected Input arg, got ${arg.$kind}`);
  const input = data.inputs[arg.Input];
  const id = input?.Object?.ImmOrOwnedObject?.objectId;
  if (!id) throw new Error(`input ${arg.Input} is not an owned object ref`);
  return id;
}

function pureBytes(data: ReturnType<typeof decode>, arg: { $kind: string; Input?: number }): Uint8Array {
  if (arg.$kind !== "Input" || arg.Input === undefined) throw new Error(`expected Input arg, got ${arg.$kind}`);
  const b64 = data.inputs[arg.Input]?.Pure?.bytes;
  if (!b64) throw new Error(`input ${arg.Input} is not pure`);
  return fromBase64(b64);
}

async function rejectsWith<E extends Error>(p: Promise<unknown>, cls: new (...a: never[]) => E): Promise<E> {
  try {
    await p;
  } catch (e) {
    if (e instanceof cls) return e;
    throw e;
  }
  throw new Error(`expected ${cls.name}`);
}

describe("PaymentClient", () => {
  it("is satisfied by SuiGrpcClient", () => {
    const c: PaymentClient = new SuiGrpcClient({ network: "testnet", baseUrl: "http://127.0.0.1:9" });
    expect(typeof c.simulateTransaction).toBe("function");
  });
});

describe("computeGasBudget", () => {
  it("adds net storage when positive, then headroom", () => {
    expect(computeGasBudget(GAS_USED, 1000n, 20)).toBe(EXPECTED_BUDGET);
    expect(computeGasBudget(GAS_USED, 1000n, 0)).toBe(3_500_000n);
  });

  it("falls back to computation + overhead when the rebate exceeds storage", () => {
    const g: GasCostSummary = { computationCost: "1000000", storageCost: "100", storageRebate: "5000000" };
    expect(computeGasBudget(g, 1000n, 20)).toBe(2_400_000n);
  });

  it("scales the overhead by gas price", () => {
    const g: GasCostSummary = { computationCost: "0", storageCost: "0", storageRebate: "0" };
    expect(computeGasBudget(g, 750n, 0)).toBe(750_000n);
  });

  it("rejects fractional or negative headroom", () => {
    expect(() => computeGasBudget(GAS_USED, 1000n, 1.5)).toThrow(RangeError);
    expect(() => computeGasBudget(GAS_USED, 1000n, -1)).toThrow(RangeError);
  });
});

describe("receivedBy", () => {
  it("sums matching entries after normalizing address and struct tag", () => {
    const changes: BalanceChange[] = [
      { coinType: USDC, address: PAY_TO, amount: "4000" },
      { coinType: USDC, address: PAY_TO.toUpperCase().replace("0X", "0x"), amount: "6000" },
      { coinType: "0x2::sui::SUI", address: PAY_TO, amount: "1" },
      { coinType: USDC, address: SENDER, amount: "-10000" },
    ];
    expect(receivedBy(changes, PAY_TO, USDC)).toBe(10000n);
    expect(receivedBy(changes, PAY_TO, SUI_TYPE_ARG)).toBe(1n);
    expect(receivedBy(changes, SENDER, SUI_TYPE_ARG)).toBeNull();
  });
});

describe("buildPaymentTransaction — non-SUI asset", () => {
  it("splits from a single covering coin and transfers to payTo", async () => {
    const usdc = coin(50_000n, USDC);
    const sui = [coin(3_000_000n, "0x2::sui::SUI"), coin(2_000_000n, "0x2::sui::SUI"), coin(100n, "0x2::sui::SUI")];
    const { client, simulations } = mockClient({ sui, asset: [usdc] });

    const built = await buildPaymentTransaction({ client, sender: SENDER, requirements: req() });
    const data = decode(built.bytes);

    expect(data.sender).toBe(SENDER);
    expect(String(data.gasData.price)).toBe("1000");
    expect(String(data.gasData.budget)).toBe(EXPECTED_BUDGET.toString());
    expect(data.gasData.payment?.map((p) => p.objectId)).toEqual([sui[0]?.objectId, sui[1]?.objectId]);
    expect(data.commands.map((c) => c.$kind)).toEqual(["SplitCoins", "TransferObjects"]);

    const split = data.commands[0]?.SplitCoins;
    const transfer = data.commands[1]?.TransferObjects;
    if (!split || !transfer) throw new Error("unexpected commands");
    expect(objectIdOfInput(data, split.coin)).toBe(usdc.objectId);
    expect(bcs.U64.parse(pureBytes(data, at(split.amounts, 0)))).toBe("10000");
    expect(bcs.Address.parse(pureBytes(data, transfer.address))).toBe(PAY_TO);
    expect(transfer.objects[0]).toMatchObject({ $kind: "NestedResult", NestedResult: [0, 0] });

    expect(built.digest).toBe(TransactionDataBuilder.getDigestFromBytes(built.bytes));
    expect(built).toMatchObject({ sender: SENDER, payTo: PAY_TO, asset: USDC, amount: 10000n, gasPrice: 1000n, gasBudget: EXPECTED_BUDGET });
    expect(simulations).toHaveLength(1);
  });

  it("estimates gas on the smallest coin set that can back a simulation", async () => {
    const sui = [coin(3_000_000n, "0x2::sui::SUI"), coin(100n, "0x2::sui::SUI"), coin(2_000_000n, "0x2::sui::SUI")];
    const { client, simulations } = mockClient({ sui, asset: [coin(50_000n, USDC)] });
    const built = await buildPaymentTransaction({ client, sender: SENDER, requirements: req() });
    const sim = decode(at(simulations, 0));
    expect(sim.gasData.payment?.map((p) => p.objectId)).toEqual([sui[0]?.objectId]);
    expect(String(sim.gasData.budget)).toBe("3000000");
    expect(decode(built.bytes).gasData.payment?.map((p) => p.objectId)).toEqual([sui[0]?.objectId, sui[2]?.objectId]);
  });

  it("only ever signs with a superset of the simulated gas coins", async () => {
    const sui = Array.from({ length: 4 }, () => coin(1_500_000n, "0x2::sui::SUI"));
    const { client, simulations } = mockClient({ sui, asset: [coin(50_000n, USDC)] });
    const built = await buildPaymentTransaction({ client, sender: SENDER, requirements: req() });
    const simulatedGas = decode(at(simulations, 0)).gasData.payment?.map((p) => p.objectId) ?? [];
    const signedGas = decode(built.bytes).gasData.payment?.map((p) => p.objectId) ?? [];
    expect(simulatedGas).toHaveLength(1);
    expect(signedGas).toHaveLength(3);
    expect(signedGas).toEqual(expect.arrayContaining(simulatedGas));
  });

  it("caps the provisional budget at the protocol maximum", async () => {
    const sui = [coin(80_000_000_000n, "0x2::sui::SUI")];
    const { client, simulations } = mockClient({ sui, asset: [coin(50_000n, USDC)] });
    await buildPaymentTransaction({ client, sender: SENDER, requirements: req() });
    expect(String(decode(at(simulations, 0)).gasData.budget)).toBe("50000000000");
  });

  it("merges fragmented coins into the largest before splitting", async () => {
    const frags = [coin(4_000n, USDC), coin(3_000n, USDC), coin(4_000n, USDC)];
    const { client } = mockClient({ sui: [coin(10_000_000n, "0x2::sui::SUI")], asset: frags });
    const data = decode((await buildPaymentTransaction({ client, sender: SENDER, requirements: req() })).bytes);
    expect(data.commands.map((c) => c.$kind)).toEqual(["MergeCoins", "SplitCoins", "TransferObjects"]);
    const merge = data.commands[0]?.MergeCoins;
    const split = data.commands[1]?.SplitCoins;
    if (!merge || !split) throw new Error("unexpected commands");
    expect(objectIdOfInput(data, merge.destination)).toBe(frags[0]?.objectId);
    expect(merge.sources.map((s) => objectIdOfInput(data, s))).toEqual([frags[2]?.objectId, frags[1]?.objectId]);
    expect(objectIdOfInput(data, split.coin)).toBe(frags[0]?.objectId);
  });

  it("fails pre-sign on insufficient asset balance without simulating", async () => {
    const { client, simulations } = mockClient({ sui: [coin(10_000_000n, "0x2::sui::SUI")], asset: [coin(9_999n, USDC)] });
    const err = await rejectsWith(buildPaymentTransaction({ client, sender: SENDER, requirements: req() }), InsufficientBalanceError);
    expect(err).toMatchObject({ asset: USDC, required: 10000n, available: 9999n });
    expect(simulations).toHaveLength(0);
  });

  it("fails pre-sign when the wallet holds no SUI for gas", async () => {
    const { client, simulations } = mockClient({ sui: [], asset: [coin(50_000n, USDC)] });
    const err = await rejectsWith(buildPaymentTransaction({ client, sender: SENDER, requirements: req() }), InsufficientBalanceError);
    expect(err.asset).toBe(SUI_TYPE_ARG);
    expect(err.available).toBe(0n);
    expect(simulations).toHaveLength(0);
  });

  it("fails readably when gas coins cannot back the budget", async () => {
    const { client } = mockClient({ sui: [coin(4_000_000n, "0x2::sui::SUI")], asset: [coin(50_000n, USDC)] });
    const err = await rejectsWith(buildPaymentTransaction({ client, sender: SENDER, requirements: req() }), InsufficientBalanceError);
    expect(err).toMatchObject({ asset: SUI_TYPE_ARG, required: EXPECTED_BUDGET, available: 4_000_000n });
  });

  it("wraps a rejected simulation call as simulation_failed", async () => {
    const { client } = mockClient({ sui: [coin(10_000_000n, "0x2::sui::SUI")], asset: [coin(50_000n, USDC)], throwWith: "INVALID_ARGUMENT: Could not find the referenced object" });
    const err = await rejectsWith(buildPaymentTransaction({ client, sender: SENDER, requirements: req() }), PaymentBuildError);
    expect(err.reason).toBe("simulation_failed");
    expect(err.message).toContain("Could not find the referenced object");
  });

  it("surfaces a simulation failure with the node's message", async () => {
    const { client } = mockClient({ sui: [coin(10_000_000n, "0x2::sui::SUI")], asset: [coin(50_000n, USDC)], failWith: "InsufficientCoinBalance in command 0" });
    const err = await rejectsWith(buildPaymentTransaction({ client, sender: SENDER, requirements: req() }), PaymentBuildError);
    expect(err.reason).toBe("simulation_failed");
    expect(err.message).toContain("InsufficientCoinBalance in command 0");
  });

  it("refuses a gas spike above maxGasBudget", async () => {
    const { client } = mockClient({ sui: [coin(10_000_000_000n, "0x2::sui::SUI")], asset: [coin(50_000n, USDC)] });
    const err = await rejectsWith(
      buildPaymentTransaction({ client, sender: SENDER, requirements: req(), maxGasBudget: 4_000_000n }),
      PaymentBuildError,
    );
    expect(err.reason).toBe("gas_budget_exceeded");
    expect(err.message).toContain("4200000");
    expect(err.message).toContain("4000000");
  });

  it("defaults maxGasBudget to 1 SUI", async () => {
    const spike: GasCostSummary = { computationCost: (DEFAULT_MAX_GAS_BUDGET + 1n).toString(), storageCost: "0", storageRebate: "0" };
    const { client } = mockClient({ sui: [coin(100_000_000_000n, "0x2::sui::SUI")], asset: [coin(50_000n, USDC)], gasUsed: spike });
    const err = await rejectsWith(buildPaymentTransaction({ client, sender: SENDER, requirements: req() }), PaymentBuildError);
    expect(err.reason).toBe("gas_budget_exceeded");
  });

  it("honours a custom headroom", async () => {
    const { client } = mockClient({ sui: [coin(10_000_000n, "0x2::sui::SUI")], asset: [coin(50_000n, USDC)] });
    const built = await buildPaymentTransaction({ client, sender: SENDER, requirements: req(), gasHeadroomPercent: 0 });
    expect(built.gasBudget).toBe(3_500_000n);
  });

  it.each([
    ["short", credit(9_999n)],
    ["wrong asset", credit(10_000n, "0x2::sui::SUI")],
    ["wrong recipient", credit(10_000n, USDC, SENDER)],
    ["nothing", []],
  ])("self-check rejects a simulation that credits payTo with %s", async (_, balanceChanges) => {
    const { client } = mockClient({ sui: [coin(10_000_000n, "0x2::sui::SUI")], asset: [coin(50_000n, USDC)], balanceChanges });
    const err = await rejectsWith(buildPaymentTransaction({ client, sender: SENDER, requirements: req() }), PaymentBuildError);
    expect(err.reason).toBe("self_check_failed");
  });

  it("self-check accepts credits split across entries", async () => {
    const balanceChanges = [...credit(4_000n), ...credit(6_000n)];
    const { client } = mockClient({ sui: [coin(10_000_000n, "0x2::sui::SUI")], asset: [coin(50_000n, USDC)], balanceChanges });
    await expect(buildPaymentTransaction({ client, sender: SENDER, requirements: req() })).resolves.toBeDefined();
  });

  it("normalizes short-form payTo and sender", async () => {
    const { client } = mockClient({ sui: [coin(10_000_000n, "0x2::sui::SUI")], asset: [coin(50_000n, USDC)], balanceChanges: credit(10_000n, USDC, "0x1") });
    const built = await buildPaymentTransaction({ client, sender: "0x2", requirements: req({ payTo: "0x1" }) });
    const data = decode(built.bytes);
    expect(data.sender).toBe(normalizeSuiAddress("0x2"));
    const transfer = data.commands[1]?.TransferObjects;
    if (!transfer) throw new Error("unexpected commands");
    expect(bcs.Address.parse(pureBytes(data, transfer.address))).toBe(normalizeSuiAddress("0x1"));
  });
});

describe("buildPaymentTransaction — SUI asset", () => {
  const suiReq = req({ asset: "0x2::sui::SUI", amount: "1000000" });

  it("splits the payment from the gas coin", async () => {
    const sui = [coin(3_000_000n, "0x2::sui::SUI"), coin(2_500_000n, "0x2::sui::SUI")];
    const { client, simulations } = mockClient({ sui, balanceChanges: credit(1_000_000n, SUI_TYPE_ARG) });
    const built = await buildPaymentTransaction({ client, sender: SENDER, requirements: suiReq });
    const data = decode(built.bytes);

    expect(data.commands.map((c) => c.$kind)).toEqual(["SplitCoins", "TransferObjects"]);
    expect(data.commands[0]?.SplitCoins?.coin.$kind).toBe("GasCoin");
    expect(data.gasData.payment?.map((p) => p.objectId)).toEqual(sui.map((c) => c.objectId));
    expect(String(data.gasData.budget)).toBe(EXPECTED_BUDGET.toString());
    expect(built.asset).toBe(SUI_TYPE_ARG);
    expect(String(decode(at(simulations, 0)).gasData.budget)).toBe("2000000");
  });

  it("uses only the coins needed for amount plus budget", async () => {
    const sui = [coin(6_000_000n, "0x2::sui::SUI"), coin(2_500_000n, "0x2::sui::SUI")];
    const { client } = mockClient({ sui, balanceChanges: credit(1_000_000n, SUI_TYPE_ARG) });
    const data = decode((await buildPaymentTransaction({ client, sender: SENDER, requirements: suiReq })).bytes);
    expect(data.gasData.payment?.map((p) => p.objectId)).toEqual([sui[0]?.objectId]);
  });

  it("fails when SUI covers the amount but not amount plus gas", async () => {
    const { client } = mockClient({ sui: [coin(3_000_000n, "0x2::sui::SUI")], balanceChanges: credit(1_000_000n, SUI_TYPE_ARG) });
    const err = await rejectsWith(buildPaymentTransaction({ client, sender: SENDER, requirements: suiReq }), InsufficientBalanceError);
    expect(err).toMatchObject({ asset: SUI_TYPE_ARG, required: 5_200_000n, available: 3_000_000n });
  });

  it("fails before simulating when SUI does not even cover the amount", async () => {
    const { client, simulations } = mockClient({ sui: [coin(1_000_000n, "0x2::sui::SUI")] });
    const err = await rejectsWith(buildPaymentTransaction({ client, sender: SENDER, requirements: suiReq }), InsufficientBalanceError);
    expect(err.asset).toBe(SUI_TYPE_ARG);
    expect(err.available).toBe(1_000_000n);
    expect(err.required).toBeGreaterThan(1_000_000n);
    expect(simulations).toHaveLength(0);
  });
});

describe("buildPaymentTransaction — expiration (PRD §8.12)", () => {
  const wallet = (): MockOptions => ({ sui: [coin(10_000_000n, "0x2::sui::SUI")], asset: [coin(50_000n, USDC)] });

  it("bounds every payment to the current epoch in the bytes the node dry-runs", async () => {
    const { client, simulations, calls } = mockClient(wallet());
    const built = await buildPaymentTransaction({ client, sender: SENDER, requirements: req() });
    const v = validDuring(decode(at(simulations, 0)));
    expect(v.maxEpoch).toBe(EPOCH);
    expect(v.chain).toBe(CHAIN_ID);
    expect([v.minEpoch, v.minTimestamp, v.maxTimestamp]).toEqual([null, null, null]);
    expect(built.expiresAfterEpoch).toBe(1199n);
    expect(calls.getChainIdentifier).toBe(1);
    expect(calls.getCurrentSystemState).toBe(1);
  });

  it("carries the identical expiration into the final bytes handed to the signer", async () => {
    const chainIdentifier = toBase58(new Uint8Array(32).fill(3));
    const { client, simulations } = mockClient({ ...wallet(), chainIdentifier });
    const built = await buildPaymentTransaction({ client, sender: SENDER, requirements: req() });
    const final = validDuring(decode(built.bytes));
    const simulated = validDuring(decode(at(simulations, 0)));
    expect(final.chain).toBe(chainIdentifier);
    expect(final.maxEpoch).toBe(EPOCH);
    expect(final.nonce).toBe(simulated.nonce);
  });

  it("picks a nonce inside the u32 range", async () => {
    const fixed = wallet();
    for (let i = 0; i < 25; i++) {
      const { client } = mockClient(fixed);
      const built = await buildPaymentTransaction({ client, sender: SENDER, requirements: req() });
      const { nonce } = validDuring(decode(built.bytes));
      expect(Number.isInteger(nonce)).toBe(true);
      expect(nonce).toBeGreaterThanOrEqual(0);
      expect(nonce).toBeLessThan(2 ** 32);
    }
  });

  it("gives a rebuild a distinct digest, which is what makes the resigned payment a new transaction", async () => {
    const fixed = wallet();
    const build = () => buildPaymentTransaction({ client: mockClient(fixed).client, sender: SENDER, requirements: req() });
    const [a, b] = [await build(), await build()];
    expect(a.digest).not.toBe(b.digest);
    expect(validDuring(decode(a.bytes)).nonce).not.toBe(validDuring(decode(b.bytes)).nonce);
  });
});
