/**
 * Coin discovery and selection for the payer (PRD §8.1, §8.4).
 *
 * Pure money-path helpers: every balance is a bigint or an atomic-unit
 * string; the asset is matched by normalized struct tag, never by symbol.
 */
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

export interface CoinRef {
  objectId: string;
  version: string;
  digest: string;
}

export interface OwnedCoin extends CoinRef {
  /** Full object type, `0x2::coin::Coin<T>`. */
  type: string;
  /** Atomic units. */
  balance: string;
}

export interface ListCoinsInput {
  owner: string;
  coinType: string;
  cursor?: string | null;
  limit?: number;
}

export interface ListCoinsPage {
  objects: OwnedCoin[];
  hasNextPage: boolean;
  cursor: string | null;
}

/** The slice of `SuiGrpcClient` coin discovery needs; structurally satisfied by it. */
export interface CoinSource {
  listCoins(input: ListCoinsInput): Promise<ListCoinsPage>;
}

export const COIN_PAGE_SIZE = 100;
export const MAX_COIN_PAGES = 10;
/** Upper bound on coin objects fed into one payment tx (merge sources + primary). */
export const MAX_INPUT_COINS = 128;

export class InsufficientBalanceError extends Error {
  constructor(
    readonly asset: string,
    readonly required: bigint,
    readonly available: bigint,
  ) {
    super(`insufficient balance of ${asset}: required ${required}, available ${available} (atomic units)`);
    this.name = "InsufficientBalanceError";
  }
}

/** All `Coin<asset>` objects owned by `owner`, up to `MAX_COIN_PAGES` pages. */
export async function discoverCoins(client: CoinSource, owner: string, asset: string): Promise<OwnedCoin[]> {
  const coinType = normalizeStructTag(asset);
  const objectType = normalizeStructTag(`0x2::coin::Coin<${coinType}>`);
  const ownerAddress = normalizeSuiAddress(owner);
  const coins: OwnedCoin[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_COIN_PAGES; page++) {
    const result = await client.listCoins({ owner: ownerAddress, coinType, cursor, limit: COIN_PAGE_SIZE });
    for (const c of result.objects) {
      if (normalizeStructTag(c.type) === objectType) coins.push(c);
    }
    if (!result.hasNextPage || result.cursor === null) break;
    cursor = result.cursor;
  }
  return coins;
}

export interface CoinSelection {
  /** Coin the payment is split from; `merge` is merged into it first. */
  primary: OwnedCoin;
  merge: OwnedCoin[];
  total: bigint;
}

const byBalanceDesc = (a: OwnedCoin, b: OwnedCoin): number => {
  const diff = BigInt(b.balance) - BigInt(a.balance);
  return diff > 0n ? 1 : diff < 0n ? -1 : 0;
};

/** A copy of `coins` sorted largest-first — the order every selection here walks. */
export const sortLargestFirst = (coins: readonly OwnedCoin[]): OwnedCoin[] => [...coins].sort(byBalanceDesc);

/** Smallest largest-first set of coins covering `amount`; throws `InsufficientBalanceError` pre-sign. */
export function selectCoins(coins: readonly OwnedCoin[], amount: bigint, asset: string): CoinSelection {
  if (amount <= 0n) throw new RangeError(`payment amount must be positive, got ${amount}`);
  const candidates = sortLargestFirst(coins).slice(0, MAX_INPUT_COINS);
  let primary: OwnedCoin | undefined;
  const merge: OwnedCoin[] = [];
  let total = 0n;
  for (const c of candidates) {
    if (primary === undefined) primary = c;
    else merge.push(c);
    total += BigInt(c.balance);
    if (total >= amount) break;
  }
  if (primary === undefined || total < amount) {
    throw new InsufficientBalanceError(normalizeStructTag(asset), amount, total);
  }
  return { primary, merge, total };
}
