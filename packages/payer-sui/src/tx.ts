/**
 * Payment transaction construction (PRD §8.2, §8.12, §8.17 seam).
 *
 * Everything that decides what leaves the payer's wallet lives here:
 * coin → merge → split → transfer, gas coins, gas budget, expiration. The
 * transaction is built offline from fully resolved object refs, simulated once
 * to size the gas budget, self-checked against the simulated balance changes,
 * and only then returned for signing.
 */
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { SUI_TYPE_ARG, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import type { PaymentRequirements } from "@sui-x402/core";
import { type CoinRef, type CoinSource, type OwnedCoin, discoverCoins, selectCoins } from "./coins.js";

export interface GasCostSummary {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}

export interface BalanceChange {
  coinType: string;
  address: string;
  amount: string;
}

export interface SimulateInput {
  transaction: Uint8Array;
  include: { effects: true; balanceChanges: true };
}

export type SimulateResult =
  | {
      $kind: "Transaction";
      Transaction: { effects: { gasUsed: GasCostSummary }; balanceChanges: BalanceChange[] };
    }
  | {
      $kind: "FailedTransaction";
      FailedTransaction: { status: { error: { message: string } | null } };
    };

/** The slice of `SuiGrpcClient` the payer needs; structurally satisfied by it. */
export interface PaymentClient extends CoinSource {
  getCurrentSystemState(): Promise<{ systemState: { epoch: string; referenceGasPrice: string } }>;
  /** Genesis checkpoint digest (base58) — what `ValidDuring.chain` must carry. */
  getChainIdentifier(): Promise<{ chainIdentifier: string }>;
  /** Resolves when the digest is on chain; rejects with `TransactionError("notFound")` otherwise. */
  getTransaction(input: { digest: string }): Promise<unknown>;
  simulateTransaction(input: SimulateInput): Promise<SimulateResult>;
}

export const DEFAULT_GAS_HEADROOM_PERCENT = 20;
/** 1 SUI. A payment tx costing more than this is a gas spike, not a fee. */
export const DEFAULT_MAX_GAS_BUDGET = 1_000_000_000n;
/** Protocol `max_tx_gas` (50 SUI). */
const PROTOCOL_MAX_GAS = 50_000_000_000n;
/** Same fixed overhead the Sui SDK adds to a simulated computation cost. */
const GAS_SAFE_OVERHEAD = 1000n;

export type PaymentBuildReason = "simulation_failed" | "gas_budget_exceeded" | "self_check_failed";

export class PaymentBuildError extends Error {
  constructor(
    readonly reason: PaymentBuildReason,
    message: string,
  ) {
    super(message);
    this.name = "PaymentBuildError";
  }
}

export interface BuildPaymentOptions {
  client: PaymentClient;
  sender: string;
  requirements: PaymentRequirements;
  gasHeadroomPercent?: number;
  maxGasBudget?: bigint;
}

export interface BuiltPayment {
  bytes: Uint8Array;
  digest: string;
  sender: string;
  payTo: string;
  asset: string;
  amount: bigint;
  gasPrice: bigint;
  gasBudget: bigint;
  /** Last epoch in which the network accepts the transaction. */
  expiresAfterEpoch: bigint;
}

/** Sui SDK budget formula (computation + overhead, plus net storage if positive) with percentage headroom. */
export function computeGasBudget(gasUsed: GasCostSummary, gasPrice: bigint, headroomPercent: number): bigint {
  if (!Number.isInteger(headroomPercent) || headroomPercent < 0) {
    throw new RangeError(`gasHeadroomPercent must be a non-negative integer, got ${headroomPercent}`);
  }
  const base = BigInt(gasUsed.computationCost) + GAS_SAFE_OVERHEAD * gasPrice;
  const withStorage = base + BigInt(gasUsed.storageCost) - BigInt(gasUsed.storageRebate);
  const budget = withStorage > base ? withStorage : base;
  return (budget * (100n + BigInt(headroomPercent))) / 100n;
}

/** Sum credited to `payTo` in `asset`; null when no entry matches (mirrors the facilitator's check). */
export function receivedBy(changes: readonly BalanceChange[], payTo: string, asset: string): bigint | null {
  let found = false;
  let sum = 0n;
  for (const bc of changes) {
    if (normalizeSuiAddress(bc.address) !== payTo || normalizeStructTag(bc.coinType) !== asset) continue;
    found = true;
    sum += BigInt(bc.amount);
  }
  return found ? sum : null;
}

const ref = (c: OwnedCoin): CoinRef => ({ objectId: c.objectId, version: c.version, digest: c.digest });

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/** Random u32 so a rebuilt payment is a new transaction, not a replay of the old digest. */
const expirationNonce = (): number => (Math.random() * 0x1_0000_0000) >>> 0;

type Simulated = Extract<SimulateResult, { $kind: "Transaction" }>["Transaction"];

async function simulate(client: PaymentClient, transaction: Uint8Array): Promise<Simulated> {
  let result: SimulateResult;
  try {
    result = await client.simulateTransaction({ transaction, include: { effects: true, balanceChanges: true } });
  } catch (e) {
    // A stale or unknown object ref is a gRPC INVALID_ARGUMENT, not a failed simulation.
    throw new PaymentBuildError("simulation_failed", `payment simulation rejected: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (result.$kind === "FailedTransaction") {
    const detail = result.FailedTransaction.status.error?.message ?? "unknown execution error";
    throw new PaymentBuildError("simulation_failed", `payment simulation failed: ${detail}`);
  }
  return result.Transaction;
}

export async function buildPaymentTransaction(opts: BuildPaymentOptions): Promise<BuiltPayment> {
  const { client, requirements } = opts;
  const headroom = opts.gasHeadroomPercent ?? DEFAULT_GAS_HEADROOM_PERCENT;
  const maxGasBudget = opts.maxGasBudget ?? DEFAULT_MAX_GAS_BUDGET;
  const sender = normalizeSuiAddress(opts.sender);
  const payTo = normalizeSuiAddress(requirements.payTo);
  const asset = normalizeStructTag(requirements.asset);
  const amount = BigInt(requirements.amount);
  const paysInSui = asset === SUI_TYPE_ARG;

  const [suiCoins, assetCoins, { systemState }, { chainIdentifier }] = await Promise.all([
    discoverCoins(client, sender, SUI_TYPE_ARG),
    paysInSui ? Promise.resolve<OwnedCoin[]>([]) : discoverCoins(client, sender, asset),
    client.getCurrentSystemState(),
    client.getChainIdentifier(),
  ]);
  const gasPrice = BigInt(systemState.referenceGasPrice);
  const epoch = BigInt(systemState.epoch);
  const payment = paysInSui ? null : selectCoins(assetCoins, amount, asset);

  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasPrice(gasPrice);
  // The network does not support timestamp expiry yet (spec-notes #8); the
  // current epoch is the tightest bound it enforces.
  tx.setExpiration({
    ValidDuring: {
      minEpoch: null,
      maxEpoch: String(epoch),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainIdentifier,
      nonce: expirationNonce(),
    },
  });
  const source = payment === null ? tx.gas : tx.objectRef(ref(payment.primary));
  if (payment !== null && payment.merge.length > 0) {
    tx.mergeCoins(
      source,
      payment.merge.map((c) => tx.objectRef(ref(c))),
    );
  }
  const [paid] = tx.splitCoins(source, [amount]);
  tx.transferObjects([paid], payTo);

  // Gas is estimated on the smallest coin set that can back a simulation. The
  // final set is a superset (largest-first prefixes nest), so the rebate from
  // smashing extra gas coins can only make the estimate conservative.
  const reserve = paysInSui ? amount : 0n;
  const estimate = selectCoins(suiCoins, reserve + GAS_SAFE_OVERHEAD * gasPrice, SUI_TYPE_ARG);
  tx.setGasPayment([estimate.primary, ...estimate.merge].map(ref));
  tx.setGasBudget(min(estimate.total - reserve, PROTOCOL_MAX_GAS));
  const simulated = await simulate(client, await tx.build());

  const gasBudget = computeGasBudget(simulated.effects.gasUsed, gasPrice, headroom);
  if (gasBudget > maxGasBudget) {
    throw new PaymentBuildError(
      "gas_budget_exceeded",
      `gas budget ${gasBudget} MIST exceeds maxGasBudget ${maxGasBudget} MIST at reference gas price ${gasPrice}`,
    );
  }
  const credited = receivedBy(simulated.balanceChanges, payTo, asset);
  if (credited === null || credited < amount) {
    throw new PaymentBuildError(
      "self_check_failed",
      `simulation credits ${payTo} with ${credited ?? 0n} of ${asset}, expected at least ${amount}`,
    );
  }

  const gas = selectCoins(suiCoins, reserve + gasBudget, SUI_TYPE_ARG);
  tx.setGasPayment([gas.primary, ...gas.merge].map(ref));
  tx.setGasBudget(gasBudget);
  const bytes = await tx.build();
  return {
    bytes,
    digest: TransactionDataBuilder.getDigestFromBytes(bytes),
    sender,
    payTo,
    asset,
    amount,
    gasPrice,
    gasBudget,
    expiresAfterEpoch: epoch,
  };
}
