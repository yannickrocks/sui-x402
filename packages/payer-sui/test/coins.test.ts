import { describe, expect, it } from "vitest";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  type CoinSource,
  type ListCoinsInput,
  type OwnedCoin,
  InsufficientBalanceError,
  MAX_COIN_PAGES,
  MAX_INPUT_COINS,
  discoverCoins,
  selectCoins,
} from "../src/coins.js";

const USDC = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const SUI_LONG = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const OWNER = "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d";

const coin = (i: number, balance: bigint, inner = USDC): OwnedCoin => ({
  objectId: `0x${i.toString(16).padStart(64, "0")}`,
  version: String(i),
  digest: `digest-${i}`,
  type: `0x2::coin::Coin<${inner}>`,
  balance: balance.toString(),
});

function source(pages: OwnedCoin[][], endless = false) {
  const calls: ListCoinsInput[] = [];
  const client: CoinSource = {
    async listCoins(input) {
      calls.push(input);
      const idx = input.cursor ? Number(input.cursor) : 0;
      const last = !endless && idx >= pages.length - 1;
      return {
        objects: pages[idx] ?? [],
        hasNextPage: !last,
        cursor: last ? null : String(idx + 1),
      };
    },
  };
  return { client, calls };
}

describe("CoinSource", () => {
  it("is satisfied by SuiGrpcClient", () => {
    const c: CoinSource = new SuiGrpcClient({ network: "testnet", baseUrl: "http://127.0.0.1:9" });
    expect(typeof c.listCoins).toBe("function");
  });
});

describe("discoverCoins", () => {
  it("walks every page and concatenates", async () => {
    const { client, calls } = source([[coin(1, 10n)], [coin(2, 20n)], [coin(3, 30n)]]);
    const coins = await discoverCoins(client, OWNER, USDC);
    expect(coins.map((c) => c.balance)).toEqual(["10", "20", "30"]);
    expect(calls.map((c) => c.cursor ?? null)).toEqual([null, "1", "2"]);
  });

  it("queries with normalized owner and full struct tag, never a symbol", async () => {
    const { client, calls } = source([[]]);
    await discoverCoins(client, "0x2", "0x2::sui::SUI");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.owner).toBe(`0x${"2".padStart(64, "0")}`);
    expect(calls[0]?.coinType).toBe(SUI_LONG);
  });

  it("drops coins whose object type does not match the asset", async () => {
    const { client } = source([[coin(1, 10n), coin(2, 99n, "0x2::sui::SUI"), coin(3, 30n)]]);
    const coins = await discoverCoins(client, OWNER, USDC);
    expect(coins.map((c) => c.balance)).toEqual(["10", "30"]);
  });

  it("matches the asset by normalized struct tag", async () => {
    const { client } = source([[coin(1, 10n, "0x2::sui::SUI")]]);
    const coins = await discoverCoins(client, OWNER, SUI_LONG);
    expect(coins).toHaveLength(1);
  });

  it("stops after MAX_COIN_PAGES on an endless cursor", async () => {
    const { client, calls } = source([[coin(1, 1n)]], true);
    await discoverCoins(client, OWNER, USDC);
    expect(calls).toHaveLength(MAX_COIN_PAGES);
  });

  it("rejects a symbol instead of a struct tag before touching the network", async () => {
    const { client, calls } = source([[]]);
    await expect(discoverCoins(client, OWNER, "USDC")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("selectCoins", () => {
  it("uses the single largest coin when it covers the amount, no merge", () => {
    const s = selectCoins([coin(1, 5n), coin(2, 100n), coin(3, 30n)], 40n, USDC);
    expect(s.primary.balance).toBe("100");
    expect(s.merge).toEqual([]);
    expect(s.total).toBe(100n);
  });

  it("accepts a coin whose balance equals the amount exactly", () => {
    const s = selectCoins([coin(1, 40n)], 40n, USDC);
    expect(s.primary.balance).toBe("40");
    expect(s.merge).toEqual([]);
  });

  it("merges largest-first until covered, nothing more", () => {
    const s = selectCoins([coin(1, 5n), coin(2, 30n), coin(3, 30n), coin(4, 10n)], 60n, USDC);
    expect(s.primary.balance).toBe("30");
    expect(s.merge.map((c) => c.balance)).toEqual(["30"]);
    expect(s.total).toBe(60n);
  });

  it("fails pre-sign with asset, required and available as bigint", () => {
    let err: unknown;
    try {
      selectCoins([coin(1, 5n), coin(2, 10n)], 100n, USDC);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InsufficientBalanceError);
    if (!(err instanceof InsufficientBalanceError)) throw err;
    expect(err.asset).toBe(USDC);
    expect(err.required).toBe(100n);
    expect(err.available).toBe(15n);
    expect(err.message).toContain("100");
    expect(err.message).toContain("15");
    expect(err.message).toContain(USDC);
  });

  it("reports zero available on an empty wallet", () => {
    expect(() => selectCoins([], 1n, USDC)).toThrow(InsufficientBalanceError);
  });

  it("rejects non-positive amounts", () => {
    expect(() => selectCoins([coin(1, 5n)], 0n, USDC)).toThrow(RangeError);
    expect(() => selectCoins([coin(1, 5n)], -1n, USDC)).toThrow(RangeError);
  });

  it("never selects more than MAX_INPUT_COINS inputs", () => {
    const dust = Array.from({ length: MAX_INPUT_COINS + 50 }, (_, i) => coin(i + 1, 1n));
    const ok = selectCoins(dust, BigInt(MAX_INPUT_COINS), USDC);
    expect(ok.merge).toHaveLength(MAX_INPUT_COINS - 1);
    expect(ok.total).toBe(BigInt(MAX_INPUT_COINS));
    expect(() => selectCoins(dust, BigInt(MAX_INPUT_COINS) + 1n, USDC)).toThrow(InsufficientBalanceError);
  });

  it("does not mutate the input order", () => {
    const coins = [coin(1, 5n), coin(2, 100n)];
    selectCoins(coins, 1n, USDC);
    expect(coins.map((c) => c.balance)).toEqual(["5", "100"]);
  });
});
