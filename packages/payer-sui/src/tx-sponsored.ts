/**
 * Sponsored payment construction (gasless v1.1).
 *
 * Builds the payment as a transaction *kind* — no sender, no gas, no expiry —
 * for a gas station to sponsor. Discovers only the payment asset, never SUI,
 * so a payer with zero SUI succeeds. The sponsor fills gas; the payer signs
 * the sponsor-filled bytes only after local validation (spec §6.3).
 */
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import {
  SUI_TYPE_ARG,
  fromBase64,
  normalizeStructTag,
  normalizeSuiAddress,
  toBase64,
} from "@mysten/sui/utils";
import type { PaymentRequirements } from "@sui-x402/core";
import { type CoinRef, coinRef, discoverCoins, selectCoins } from "./coins.js";
import type { GasStationClient } from "./gas-station.js";
import {
  PROTOCOL_MAX_TX_GAS,
  assertChainIdentifier,
  PaymentBuildError,
  type PaymentClient,
  receivedBy,
} from "./tx.js";

/** A payment serialized as a transaction *kind*: no sender, no gas, no expiry. */
export interface SponsoredPaymentKind {
  /** `build({ onlyTransactionKind: true })` output — what the gas station sponsors. */
  kindBytes: Uint8Array;
  sender: string;
  payTo: string;
  asset: string;
  amount: bigint;
  /**
   * The payer-owned coin the payment is split from, at the version pinned in
   * `kindBytes`. The non-execution proof reads this. Never null: a
   * SUI-denominated payment is refused before this object is constructed.
   */
  paymentCoin: CoinRef;
}

export interface BuildSponsoredPaymentOptions {
  client: PaymentClient;
  sender: string;
  requirements: PaymentRequirements;
  chainIdentifiers?: Readonly<Record<string, string>>;
}

/** Random u64 input so two builds of identical requirements never serialize identically. */
const kindNonce = (): bigint =>
  (BigInt((Math.random() * 0x1_0000_0000) >>> 0) << 32n) |
  BigInt((Math.random() * 0x1_0000_0000) >>> 0);

/**
 * Builds the payment as a transaction kind. A transaction kind carries no
 * `ValidDuring`, so an unused `pure.u64` nonce input is the kind's only
 * uniqueness source. Throws `PaymentBuildError("unsupported_sponsored_asset")`
 * for a SUI-denominated payment: under sponsorship the gas coin is the
 * sponsor's, leaving no payer-owned pinned input to prove non-execution with.
 */
export async function buildSponsoredPaymentKind(
  opts: BuildSponsoredPaymentOptions
): Promise<SponsoredPaymentKind> {
  const { client, requirements } = opts;
  const sender = normalizeSuiAddress(opts.sender);
  const payTo = normalizeSuiAddress(requirements.payTo);
  const asset = normalizeStructTag(requirements.asset);
  const amount = BigInt(requirements.amount);
  if (asset === SUI_TYPE_ARG) {
    throw new PaymentBuildError(
      "unsupported_sponsored_asset",
      "a SUI-denominated payment cannot be sponsored: the gas coin is the sponsor's, leaving no payer-owned input to prove non-execution with"
    );
  }

  const [assetCoins, { chainIdentifier }] = await Promise.all([
    discoverCoins(client, sender, asset),
    client.getChainIdentifier(),
  ]);
  assertChainIdentifier(requirements, chainIdentifier, opts.chainIdentifiers);

  const payment = selectCoins(assetCoins, amount, asset);
  const tx = new Transaction();
  const source = tx.objectRef(coinRef(payment.primary));
  if (payment.merge.length > 0) {
    tx.mergeCoins(
      source,
      payment.merge.map((c) => tx.objectRef(coinRef(c)))
    );
  }
  const [paid] = tx.splitCoins(source, [amount]);
  tx.transferObjects([paid], payTo);
  tx.pure.u64(kindNonce());

  const kindBytes = await tx.build({ onlyTransactionKind: true });
  return {
    kindBytes,
    sender,
    payTo,
    asset,
    amount,
    paymentCoin: coinRef(payment.primary),
  };
}

/** A gas-station-sponsored payment, validated locally, ready to sign. */
export interface BuiltSponsoredPayment {
  /** Full `TransactionData` returned by the gas station, relayed verbatim. */
  bytes: Uint8Array;
  /** Enoki's handle for these bytes; asserted equal to the local digest. */
  digest: string;
  sender: string;
  payTo: string;
  asset: string;
  amount: bigint;
  /** The sponsor's address, from `gasData.owner`. Never equal to `sender`. */
  gasOwner: string;
  gasPrice: bigint;
  gasBudget: bigint;
  /** Carried through from the kind; the non-execution proof coin for this path. */
  paymentCoin: CoinRef;
}

export interface SponsorPaymentOptions {
  client: PaymentClient;
  gasStation: GasStationClient;
  kind: SponsoredPaymentKind;
  /**
   * Full network id, e.g. `"sui:testnet"` — sent to `/gas-station` verbatim.
   * The facilitator, not the SDK, derives the bare id Enoki wants; splitting
   * it here produces `400 unsupported network`.
   */
  network: string;
}

const invalid = (detail: string): PaymentBuildError =>
  new PaymentBuildError(
    "sponsor_response_invalid",
    `sponsor response rejected: ${detail}`
  );

/**
 * Sponsors `kind` via the gas station and validates the returned bytes before
 * they are ever signed (spec §6.3). The sponsor is untrusted: the returned
 * kind must be byte-identical to the submitted one, the gas owner must not be
 * the payer, the digest must match the bytes, and a fresh simulation must
 * credit `payTo` with the full amount. Throws `GasStationError` for
 * transport/policy failures and `PaymentBuildError` for a response that fails
 * validation. The bytes are relayed verbatim — never re-encoded or rebuilt.
 */
export async function sponsorPayment(
  opts: SponsorPaymentOptions
): Promise<BuiltSponsoredPayment> {
  const { client, gasStation, kind } = opts;
  const result = await gasStation.sponsor({
    sender: kind.sender,
    transactionKindBytes: toBase64(kind.kindBytes),
    network: opts.network,
    recipients: [kind.payTo],
  });
  // The sponsor's bytes are untrusted input: a body that is not valid
  // base64/BCS TransactionData must surface as the typed error, not a raw throw.
  let bytes: Uint8Array;
  let returnedKind: Uint8Array;
  let data: ReturnType<typeof TransactionDataBuilder.fromBytes>;
  try {
    bytes = fromBase64(result.bytes);
    returnedKind = await Transaction.from(bytes).build({
      onlyTransactionKind: true,
    });
    data = TransactionDataBuilder.fromBytes(bytes);
  } catch (e) {
    throw invalid(
      `bytes are not a decodable TransactionData: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  // 1. Kind identity: the sponsor may add sender/gas/expiry, never touch commands or inputs.
  if (toBase64(returnedKind) !== toBase64(kind.kindBytes)) {
    throw new PaymentBuildError(
      "sponsor_altered_payment",
      "sponsor returned bytes whose transaction kind differs from the submitted kind"
    );
  }

  if (
    data.sender === null ||
    normalizeSuiAddress(data.sender) !== kind.sender
  ) {
    throw invalid(
      `sender is ${data.sender ?? "unset"}, expected ${kind.sender}`
    );
  }
  const owner = data.gasData.owner;
  if (owner === null || normalizeSuiAddress(owner) === kind.sender) {
    throw invalid("gas owner is the payer; the transaction is not sponsored");
  }
  const gasOwner = normalizeSuiAddress(owner);
  if (data.gasData.budget === null || data.gasData.price === null)
    throw invalid("gas budget or price is unset");
  const gasBudget = BigInt(data.gasData.budget);
  const gasPrice = BigInt(data.gasData.price);
  if (gasBudget <= 0n || gasBudget > PROTOCOL_MAX_TX_GAS) {
    throw invalid(
      `gas budget ${gasBudget} is outside (0, ${PROTOCOL_MAX_TX_GAS}]`
    );
  }
  if (gasPrice <= 0n) throw invalid(`gas price ${gasPrice} is not positive`);
  const digest = TransactionDataBuilder.getDigestFromBytes(bytes);
  if (digest !== result.digest) {
    throw invalid(
      `sponsor digest ${result.digest} does not match the bytes' digest ${digest}`
    );
  }

  // The payTo self-check, preserved: same assertion as the self-funded build.
  const simulated = await client.simulateTransaction({
    transaction: bytes,
    include: { effects: true, balanceChanges: true },
  });
  if (simulated.$kind === "FailedTransaction") {
    const detail =
      simulated.FailedTransaction.status.error?.message ??
      "unknown execution error";
    throw new PaymentBuildError(
      "simulation_failed",
      `sponsored payment simulation failed: ${detail}`
    );
  }
  const credited = receivedBy(
    simulated.Transaction.balanceChanges,
    kind.payTo,
    kind.asset
  );
  if (credited === null || credited < kind.amount) {
    throw new PaymentBuildError(
      "self_check_failed",
      `simulation credits ${kind.payTo} with ${credited ?? 0n} of ${
        kind.asset
      }, expected at least ${kind.amount}`
    );
  }

  return {
    bytes,
    digest,
    sender: kind.sender,
    payTo: kind.payTo,
    asset: kind.asset,
    amount: kind.amount,
    gasOwner,
    gasPrice,
    gasBudget,
    paymentCoin: kind.paymentCoin,
  };
}
