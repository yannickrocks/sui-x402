/**
 * accepts[] selection.
 *
 * The payer decides which of the server's offers it is willing to pay before
 * any coin is touched: scheme, network, asset, and a per-asset cap in atomic
 * units. Server order is preference order, and the winner is returned by
 * reference — the payer echoes it back as `accepted` exactly as received, so
 * nothing here rewrites what the server sent.
 */
import { normalizeStructTag } from "@mysten/sui/utils";
import { StructTag, type PaymentRequirements } from "@sui-x402/core";

/** Mainnet is never implicit: the SDK user must list it. */
export const DEFAULT_NETWORKS: readonly string[] = ["sui:testnet"];

export interface SelectOptions {
  /** CAIP-2 network ids the payer may pay on. Default `DEFAULT_NETWORKS`. */
  networks?: readonly string[];
  /** Allowed coin struct tags; compared after `normalizeStructTag`. Default: any asset. */
  assets?: readonly string[];
  /**
   * Per-asset cap in atomic units, keyed by struct tag (normalized on read).
   * Once any cap is set, an asset without one is rejected. Default: no cap.
   */
  maxAmount?: Readonly<Record<string, bigint>>;
}

export type RejectReason =
  | "unsupported_scheme"
  | "unsupported_network"
  | "unsupported_asset"
  | "amount_over_cap";

export interface RejectedRequirement {
  index: number;
  reason: RejectReason;
  requirement: PaymentRequirements;
}

const listRejections = (rejected: readonly RejectedRequirement[]): string =>
  rejected.length === 0
    ? "accepts[] was empty"
    : rejected.map((r) => `${r.index}:${r.reason}`).join(", ");

export class NoAcceptableRequirementError extends Error {
  constructor(
    readonly rejected: readonly RejectedRequirement[],
    networks: readonly string[],
    assets: readonly string[] | undefined
  ) {
    super(
      `no acceptable payment requirement (${listRejections(rejected)}); ` +
        `allowed networks: ${networks.join(", ")}; ` +
        `allowed assets: ${assets === undefined ? "any" : assets.join(", ")}`
    );
    this.name = "NoAcceptableRequirementError";
  }
}

/** A misconfigured payer must fail loudly, not silently reject every 402. */
const normalizeAssetOption = (tag: string, where: string): string => {
  if (!StructTag.safeParse(tag).success) {
    throw new RangeError(`${where} is not a coin struct tag: ${tag}`);
  }
  return normalizeStructTag(tag);
};

const withinCap = (amount: string, cap: bigint): boolean => {
  // core's AmountString validates the wire, but selectRequirement is public:
  // an unparseable amount must be rejected, never crash the payment path.
  try {
    return BigInt(amount) <= cap;
  } catch {
    return false;
  }
};

const rejectionFor = (
  requirement: PaymentRequirements,
  networks: readonly string[],
  assets: readonly string[] | undefined,
  caps: ReadonlyMap<string, bigint>
): RejectReason | undefined => {
  if (requirement.scheme !== "exact") return "unsupported_scheme";
  if (!networks.includes(requirement.network)) return "unsupported_network";
  if (assets === undefined && caps.size === 0) return undefined;

  if (!StructTag.safeParse(requirement.asset).success)
    return "unsupported_asset";
  const asset = normalizeStructTag(requirement.asset);
  if (assets !== undefined && !assets.includes(asset))
    return "unsupported_asset";

  const cap = caps.get(asset);
  if (caps.size > 0 && cap === undefined) return "unsupported_asset";
  if (cap !== undefined && !withinCap(requirement.amount, cap))
    return "amount_over_cap";
  return undefined;
};

/** First entry in server order passing every check; throws `NoAcceptableRequirementError` otherwise. */
export function selectRequirement(
  accepts: readonly PaymentRequirements[],
  options: SelectOptions = {}
): PaymentRequirements {
  const networks = options.networks ?? DEFAULT_NETWORKS;
  const assets = options.assets?.map((tag) =>
    normalizeAssetOption(tag, "assets entry")
  );
  const caps = new Map<string, bigint>();
  for (const [tag, cap] of Object.entries(options.maxAmount ?? {})) {
    caps.set(normalizeAssetOption(tag, "maxAmount key"), cap);
  }

  const rejected: RejectedRequirement[] = [];
  for (const [index, requirement] of accepts.entries()) {
    const reason = rejectionFor(requirement, networks, assets, caps);
    if (reason === undefined) return requirement;
    rejected.push({ index, reason, requirement });
  }
  throw new NoAcceptableRequirementError(rejected, networks, assets);
}
