/**
 * Payment transaction construction (PRD §8.2, §8.17 seam).
 *
 * Everything that decides what leaves the payer's wallet lives here:
 * coin → merge → split → transfer, gas coins, gas budget. The transaction is
 * built offline from fully resolved object refs, simulated once to size the
 * gas budget, self-checked against the simulated balance changes, and only
 * then returned for signing.
 */
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { SUI_TYPE_ARG, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import type { PaymentRequirements } from "@sui-x402/core";
import {
  type CoinRef,
  type CoinSource,
  type OwnedCoin,
  InsufficientBalanceError,
  MAX_INPUT_COINS,
  discoverCoins,
  selectCoins,
} from "./coins.js";

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

/** The slice of `SuiGrpcClient` payment construction needs; structurally satisfied by it. */
export interface PaymentClient extends CoinSource {
  getReferenceGasPrice(): Promise<{ referenceGasPrice: string }>;
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

const byBalanceDesc = (a: OwnedCoin, b: OwnedCoin): number => {
  const diff = BigInt(b.balance) - BigInt(a.balance);
  return diff > 0n ? 1 : diff < 0n ? -1 : 0;
};

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

export async function buildPaymentTransaction(opts: BuildPaymentOptions): Promise<BuiltPayment> {
  const { client, requirements } = opts;
  const headroom = opts.gasHeadroomPercent ?? DEFAULT_GAS_HEADROOM_PERCENT;
  const maxGasBudget = opts.maxGasBudget ?? DEFAULT_MAX_GAS_BUDGET;
  const sender = normalizeSuiAddress(opts.sender);
  const payTo = normalizeSuiAddress(requirements.payTo);
  const asset = normalizeStructTag(requirements.asset);
  const amount = BigInt(requirements.amount);
  const paysInSui = asset === SUI_TYPE_ARG;

  const [suiCoins, assetCoins, gasPriceResponse] = await Promise.all([
    discoverCoins(client, sender, SUI_TYPE_ARG),
    paysInSui ? Promise.resolve<OwnedCoin[]>([]) : discoverCoins(client, sender, asset),
    client.getReferenceGasPrice(),
  ]);
  const gasPrice = BigInt(gasPriceResponse.referenceGasPrice);
  const payment = paysInSui ? null : selectCoins(assetCoins, amount, asset);

  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasPrice(gasPrice);
  const source = payment === null ? tx.gas : tx.objectRef(ref(payment.primary));
  if (payment !== null && payment.merge.length > 0) {
    tx.mergeCoins(
      source,
      payment.merge.map((c) => tx.objectRef(ref(c))),
    );
  }
  const [paid] = tx.splitCoins(source, [amount]);
  tx.transferObjects([paid], payTo);

  // Estimate with every SUI coin as gas (a superset of the final set, so the
  // estimate is conservative) and the largest budget the wallet can back.
  const reserve = paysInSui ? amount : 0n;
  const gasCandidates = [...suiCoins].sort(byBalanceDesc).slice(0, MAX_INPUT_COINS);
  const gasAvailable = gasCandidates.reduce((s, c) => s + BigInt(c.balance), 0n);
  if (gasAvailable <= reserve) {
    throw new InsufficientBalanceError(SUI_TYPE_ARG, reserve + GAS_SAFE_OVERHEAD * gasPrice, gasAvailable);
  }
  tx.setGasPayment(gasCandidates.map(ref));
  tx.setGasBudget(min(gasAvailable - reserve, PROTOCOL_MAX_GAS));
  const simulated = await client.simulateTransaction({
    transaction: await tx.build(),
    include: { effects: true, balanceChanges: true },
  });
  if (simulated.$kind === "FailedTransaction") {
    const detail = simulated.FailedTransaction.status.error?.message ?? "unknown execution error";
    throw new PaymentBuildError("simulation_failed", `payment simulation failed: ${detail}`);
  }

  const gasBudget = computeGasBudget(simulated.Transaction.effects.gasUsed, gasPrice, headroom);
  if (gasBudget > maxGasBudget) {
    throw new PaymentBuildError(
      "gas_budget_exceeded",
      `gas budget ${gasBudget} MIST exceeds maxGasBudget ${maxGasBudget} MIST at reference gas price ${gasPrice}`,
    );
  }
  const credited = receivedBy(simulated.Transaction.balanceChanges, payTo, asset);
  if (credited === null || credited < amount) {
    throw new PaymentBuildError(
      "self_check_failed",
      `simulation credits ${payTo} with ${credited ?? 0n} of ${asset}, expected at least ${amount}`,
    );
  }

  const gas = selectCoins(suiCoins, gasBudget + reserve, SUI_TYPE_ARG);
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
  };
}
