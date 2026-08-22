import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PaymentRequired, type PaymentRequirements } from "@sui-x402/core";
import {
  DEFAULT_NETWORKS,
  NoAcceptableRequirementError,
  selectRequirement,
} from "../src/select.js";

const fixture = PaymentRequired.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../core/fixtures/demo-402.payment-required.json",
        import.meta.url
      ),
      "utf8"
    )
  )
);
const live = fixture.accepts[0];

const USDC =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const SUI_SHORT = "0x2::sui::SUI";
const SUI_LONG =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

const requirement = (
  over: Partial<PaymentRequirements> = {}
): PaymentRequirements => ({
  scheme: "exact",
  network: "sui:testnet",
  amount: "10000",
  asset: USDC,
  payTo: "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d",
  maxTimeoutSeconds: 60,
  ...over,
});

/** `"exact" & string` reduces to `"exact"`, so this widens the value without a cast. */
const withRaw = (
  base: PaymentRequirements,
  raw: Record<string, string>
): PaymentRequirements => Object.assign({}, base, raw);

describe("selectRequirement", () => {
  it("accepts the live fixture requirement with default options", () => {
    expect(selectRequirement(fixture.accepts)).toBe(live);
  });

  it("returns the first entry that passes, in server order", () => {
    const cheap = requirement({ amount: "1" });
    const accepts = [requirement({ network: "sui:mainnet" }), live, cheap];
    expect(selectRequirement(accepts)).toBe(live);
  });

  it("returns the original object reference, unnormalized", () => {
    const short = requirement({ asset: SUI_SHORT });
    const picked = selectRequirement([short], { assets: [SUI_LONG] });
    expect(picked).toBe(short);
    expect(picked.asset).toBe(SUI_SHORT);
  });

  it("rejects a non-exact scheme", () => {
    const other = withRaw(requirement(), { scheme: "upto" });
    expect(() => selectRequirement([other])).toThrow(
      NoAcceptableRequirementError
    );
    try {
      selectRequirement([other]);
    } catch (e) {
      expect(e).toBeInstanceOf(NoAcceptableRequirementError);
      if (e instanceof NoAcceptableRequirementError) {
        expect(e.rejected).toEqual([
          { index: 0, reason: "unsupported_scheme", requirement: other },
        ]);
      }
    }
  });

  it("rejects mainnet by default", () => {
    const mainnet = requirement({ network: "sui:mainnet" });
    expect(DEFAULT_NETWORKS).toEqual(["sui:testnet"]);
    try {
      selectRequirement([mainnet]);
      expect.unreachable();
    } catch (e) {
      if (!(e instanceof NoAcceptableRequirementError)) throw e;
      expect(e.rejected.map((r) => r.reason)).toEqual(["unsupported_network"]);
    }
  });

  it("accepts mainnet only when the caller lists it", () => {
    const mainnet = requirement({ network: "sui:mainnet" });
    expect(selectRequirement([mainnet], { networks: ["sui:mainnet"] })).toBe(
      mainnet
    );
  });

  it("matches networks by exact string, not prefix", () => {
    const mainnet = requirement({ network: "sui:mainnet" });
    try {
      selectRequirement([mainnet], { networks: ["sui:main"] });
      expect.unreachable();
    } catch (e) {
      if (!(e instanceof NoAcceptableRequirementError)) throw e;
      expect(e.rejected.map((r) => r.reason)).toEqual(["unsupported_network"]);
    }
  });

  it("rejects an asset outside the allow list", () => {
    try {
      selectRequirement([live], { assets: [SUI_SHORT] });
      expect.unreachable();
    } catch (e) {
      if (!(e instanceof NoAcceptableRequirementError)) throw e;
      expect(e.rejected.map((r) => r.reason)).toEqual(["unsupported_asset"]);
    }
  });

  it("normalizes assets on both sides: short option matches long requirement", () => {
    const long = requirement({ asset: SUI_LONG });
    const short = requirement({ asset: SUI_SHORT });
    expect(selectRequirement([long], { assets: [SUI_SHORT] })).toBe(long);
    expect(selectRequirement([short], { assets: [SUI_LONG] })).toBe(short);
  });

  it("normalizes maxAmount keys", () => {
    const long = requirement({ asset: SUI_LONG, amount: "1000" });
    expect(
      selectRequirement([long], { maxAmount: { [SUI_SHORT]: 1000n } })
    ).toBe(long);
    try {
      selectRequirement([long], { maxAmount: { [SUI_SHORT]: 999n } });
      expect.unreachable();
    } catch (e) {
      if (!(e instanceof NoAcceptableRequirementError)) throw e;
      expect(e.rejected.map((r) => r.reason)).toEqual(["amount_over_cap"]);
    }
  });

  it("passes at the cap and fails at cap + 1", () => {
    const atCap = requirement({ amount: "10000" });
    const overCap = requirement({ amount: "10001" });
    expect(selectRequirement([atCap], { maxAmount: { [USDC]: 10_000n } })).toBe(
      atCap
    );
    expect(() =>
      selectRequirement([overCap], { maxAmount: { [USDC]: 10_000n } })
    ).toThrow(NoAcceptableRequirementError);
  });

  it("rejects an asset without a cap once any cap is set", () => {
    const sui = withRaw(live, { asset: SUI_SHORT, amount: "1" });
    try {
      selectRequirement([sui], { maxAmount: { [USDC]: 1n } });
      throw new Error("expected NoAcceptableRequirementError");
    } catch (e) {
      if (!(e instanceof NoAcceptableRequirementError)) throw e;
      expect(e.rejected.map((r) => r.reason)).toEqual(["unsupported_asset"]);
    }
  });

  it("ignores a malformed amount when no cap applies, rejects it when one does", () => {
    const bad = withRaw(requirement(), { amount: "1e6" });
    expect(selectRequirement([bad])).toBe(bad);
    try {
      selectRequirement([bad], { maxAmount: { [USDC]: 10_000_000n } });
      expect.unreachable();
    } catch (e) {
      if (!(e instanceof NoAcceptableRequirementError)) throw e;
      expect(e.rejected.map((r) => r.reason)).toEqual(["amount_over_cap"]);
    }
  });

  it("does not inspect the asset when no asset restriction is configured", () => {
    const junk = withRaw(requirement(), { asset: "USDC" });
    expect(selectRequirement([junk])).toBe(junk);
  });

  it("rejects an unparseable asset when an asset restriction is configured", () => {
    const junk = withRaw(requirement(), { asset: "USDC" });
    try {
      selectRequirement([junk], { maxAmount: { [USDC]: 1n } });
      expect.unreachable();
    } catch (e) {
      if (!(e instanceof NoAcceptableRequirementError)) throw e;
      expect(e.rejected.map((r) => r.reason)).toEqual(["unsupported_asset"]);
    }
  });

  it("reports every rejection in server order with its own reason", () => {
    const accepts = [
      withRaw(requirement(), { scheme: "upto" }),
      requirement({ network: "sui:mainnet" }),
      requirement({ asset: SUI_LONG }),
      requirement({ amount: "10001" }),
    ];
    try {
      selectRequirement(accepts, {
        assets: [USDC],
        maxAmount: { [USDC]: 10_000n },
      });
      expect.unreachable();
    } catch (e) {
      if (!(e instanceof NoAcceptableRequirementError)) throw e;
      expect(e.rejected).toEqual([
        { index: 0, reason: "unsupported_scheme", requirement: accepts[0] },
        { index: 1, reason: "unsupported_network", requirement: accepts[1] },
        { index: 2, reason: "unsupported_asset", requirement: accepts[2] },
        { index: 3, reason: "amount_over_cap", requirement: accepts[3] },
      ]);
    }
  });

  it("throws with an empty rejected list on empty accepts", () => {
    try {
      selectRequirement([]);
      expect.unreachable();
    } catch (e) {
      if (!(e instanceof NoAcceptableRequirementError)) throw e;
      expect(e.rejected).toEqual([]);
      expect(e.name).toBe("NoAcceptableRequirementError");
      expect(e.message).toContain("accepts[] was empty");
    }
  });

  it("names the rejections and the allowed networks and assets in the message", () => {
    try {
      selectRequirement(
        [
          requirement({ network: "sui:mainnet" }),
          requirement({ amount: "10001" }),
        ],
        {
          maxAmount: { [USDC]: 10_000n },
        }
      );
      expect.unreachable();
    } catch (e) {
      if (!(e instanceof NoAcceptableRequirementError)) throw e;
      expect(e.message).toContain("0:unsupported_network");
      expect(e.message).toContain("1:amount_over_cap");
      expect(e.message).toContain("sui:testnet");
      expect(e.message).toContain("any");
    }
  });

  it("lists the allowed assets in the message when they are restricted", () => {
    try {
      selectRequirement([live], { assets: [SUI_SHORT] });
      expect.unreachable();
    } catch (e) {
      if (!(e instanceof NoAcceptableRequirementError)) throw e;
      expect(e.message).toContain(SUI_LONG);
    }
  });

  it("throws RangeError naming an assets entry that is not a struct tag", () => {
    expect(() => selectRequirement([live], { assets: ["USDC"] })).toThrow(
      RangeError
    );
    expect(() => selectRequirement([live], { assets: ["USDC"] })).toThrow(
      /USDC/
    );
  });

  it("throws RangeError naming a maxAmount key that is not a struct tag", () => {
    expect(() => selectRequirement([live], { maxAmount: { SUI: 1n } })).toThrow(
      RangeError
    );
    expect(() => selectRequirement([live], { maxAmount: { SUI: 1n } })).toThrow(
      /SUI/
    );
  });

  it("validates options before looking at accepts", () => {
    expect(() => selectRequirement([], { assets: ["nope"] })).toThrow(
      RangeError
    );
  });
});
