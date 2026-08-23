/**
 * Payment transaction construction (PRD §8.2, §8.12, §8.15, §8.17 seam).
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
import {
  type CoinRef,
  type CoinSource,
  type OwnedCoin,
  InsufficientBalanceError,
  MAX_INPUT_COINS,
  discoverCoins,
  selectCoins,
  sortLargestFirst,
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

/** The slice of `SuiGrpcClient` the payer needs; structurally satisfied by it. */
export interface PaymentClient extends CoinSource {
  getCurrentSystemState(): Promise<{ systemState: { epoch: string; referenceGasPrice: string } }>;
  /** Genesis checkpoint digest (base58) of the chain the client is actually talking to. */
  getChainIdentifier(): Promise<{ chainIdentifier: string }>;
  /** Current version of an owned object; rejects when it no longer exists. */
  getObject(input: { objectId: string }): Promise<{ object: { version: string } }>;
  simulateTransaction(input: SimulateInput): Promise<SimulateResult>;
}

/**
 * Genesis checkpoint digest per network id. Only testnet is pinned (observed
 * live 2026-08-22); mainnet is an integrator's call (docs/status.md) and must be
 * supplied through `chainIdentifiers`.
 */
export const CHAIN_IDENTIFIERS: Readonly<Record<string, string>> = {
  "sui:testnet": "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD",
};

export const DEFAULT_GAS_HEADROOM_PERCENT = 20;
/** 1 SUI. A payment tx costing more than this is a gas spike, not a fee. */
export const DEFAULT_MAX_GAS_BUDGET = 1_000_000_000n;
/** Protocol `max_tx_gas` (50,000 SUI), read from the live testnet protocol config. */
const PROTOCOL_MAX_TX_GAS = 50_000_000_000_000n;
/** Same fixed overhead the Sui SDK adds to a simulated computation cost. */
const GAS_SAFE_OVERHEAD = 1000n;

export type PaymentBuildReason = "network_mismatch" | "simulation_failed" | "gas_budget_exceeded" | "self_check_failed";

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
  /** Extends or overrides `CHAIN_IDENTIFIERS`. */
  chainIdentifiers?: Readonly<Record<string, string>>;
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
  /** First gas coin: any execution of the transaction, successful or not, moves its version. */
  gasCoin: CoinRef;
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
  const expectedChain = { ...CHAIN_IDENTIFIERS, ...opts.chainIdentifiers }[requirements.network];
  if (expectedChain === undefined) {
    throw new PaymentBuildError(
      "network_mismatch",
      `no chain identifier is pinned for ${requirements.network}; pass chainIdentifiers to pay on it`,
    );
  }
  if (expectedChain !== chainIdentifier) {
    throw new PaymentBuildError(
      "network_mismatch",
      `client is connected to chain ${chainIdentifier}, but ${requirements.network} is ${expectedChain}`,
    );
  }
  const gasPrice = BigInt(systemState.referenceGasPrice);
  const epoch = BigInt(systemState.epoch);
  const payment = paysInSui ? null : selectCoins(assetCoins, amount, asset);

  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasPrice(gasPrice);
  // The network does not support timestamp expiry yet (spec-notes #8); the
  // next epoch is the tightest bound that never fails at an epoch rollover.
  tx.setExpiration({
    ValidDuring: {
      minEpoch: null,
      maxEpoch: String(epoch + 1n),
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

  // Gas coins cover the amount plus up to maxGasBudget of gas, and the same
  // set is simulated and signed, so the smashing rebate in the estimate is the
  // one the network will apply.
  const reserve = paysInSui ? amount : 0n;
  const available = sortLargestFirst(suiCoins)
    .slice(0, MAX_INPUT_COINS)
    .reduce((sum, c) => sum + BigInt(c.balance), 0n);
  const minimumGas = GAS_SAFE_OVERHEAD * gasPrice;
  if (available < reserve + minimumGas) throw new InsufficientBalanceError(SUI_TYPE_ARG, reserve + minimumGas, available);
  const gas = selectCoins(suiCoins, reserve + min(maxGasBudget, available - reserve), SUI_TYPE_ARG);
  tx.setGasPayment([gas.primary, ...gas.merge].map(ref));
  tx.setGasBudget(min(gas.total - reserve, PROTOCOL_MAX_TX_GAS));
  const simulated = await simulate(client, await tx.build());

  const gasBudget = computeGasBudget(simulated.effects.gasUsed, gasPrice, headroom);
  if (gasBudget > maxGasBudget) {
    throw new PaymentBuildError(
      "gas_budget_exceeded",
      `gas budget ${gasBudget} MIST exceeds maxGasBudget ${maxGasBudget} MIST at reference gas price ${gasPrice}`,
    );
  }
  if (gasBudget > gas.total - reserve) throw new InsufficientBalanceError(SUI_TYPE_ARG, reserve + gasBudget, gas.total);
  const credited = receivedBy(simulated.balanceChanges, payTo, asset);
  if (credited === null || credited < amount) {
    throw new PaymentBuildError(
      "self_check_failed",
      `simulation credits ${payTo} with ${credited ?? 0n} of ${asset}, expected at least ${amount}`,
    );
  }

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
    gasCoin: ref(gas.primary),
    expiresAfterEpoch: epoch + 1n,
  };
}
