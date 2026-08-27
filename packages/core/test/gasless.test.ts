import { describe, expect, it } from "vitest";
import {
  HEADER_PAYMENT_REQUIRED,
  PaymentPayload,
  PaymentRequired,
  SUI_GAS_STATION_EXTRA,
  SUI_SPONSOR_EXTENSION,
  SuiGasStationHint,
  SuiSponsorExtension,
  createSeller,
  decodeHeader,
} from "../src/index.js";

const OPTIONS = {
  payTo: "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d",
  amount: "10000",
  asset:
    "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
  network: "sui:testnet" as const,
  facilitator: "https://facilitator.example",
};

describe("sponsor extension schemas", () => {
  it("SuiSponsorExtension accepts a digest and rejects a missing or empty one", () => {
    expect(SuiSponsorExtension.safeParse({ digest: "7QSxe8Zu" }).success).toBe(
      true
    );
    expect(SuiSponsorExtension.safeParse({ digest: "" }).success).toBe(false);
    expect(SuiSponsorExtension.safeParse({}).success).toBe(false);
    expect(SUI_SPONSOR_EXTENSION).toBe("sui.sponsor");
  });

  it("PaymentPayload accepts the sui.sponsor extension unchanged", () => {
    const payload = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        ...OPTIONS,
        maxTimeoutSeconds: 60,
        facilitator: undefined,
      },
      payload: { transaction: "AAECAw==", signature: "AAECAw==" },
      extensions: { [SUI_SPONSOR_EXTENSION]: { digest: "7QSxe8Zu" } },
    };
    const parsed = PaymentPayload.parse({
      ...payload,
      accepted: {
        scheme: "exact",
        network: OPTIONS.network,
        amount: OPTIONS.amount,
        asset: OPTIONS.asset,
        payTo: OPTIONS.payTo,
        maxTimeoutSeconds: 60,
      },
    });
    expect(parsed.extensions?.[SUI_SPONSOR_EXTENSION]).toEqual({
      digest: "7QSxe8Zu",
    });
  });

  it("SuiGasStationHint accepts a URL and rejects a non-URL", () => {
    expect(
      SuiGasStationHint.safeParse({ url: "https://facilitator.example" })
        .success
    ).toBe(true);
    expect(SuiGasStationHint.safeParse({ url: "not a url" }).success).toBe(
      false
    );
    expect(SUI_GAS_STATION_EXTRA).toBe("sui.gasStation");
  });
});

describe("SellerOptions.extra passthrough (§6.5)", () => {
  const requiredOf = async (options: Parameters<typeof createSeller>[0]) => {
    const seller = createSeller(options);
    const result = await seller.handle({
      url: "https://api.example/paid/x",
      paymentSignature: null,
    });
    if (result.kind !== "respond" || result.status !== 402)
      throw new Error(
        `expected a 402, got ${JSON.stringify({ kind: result.kind })}`
      );
    const header = result.headers[HEADER_PAYMENT_REQUIRED];
    if (header === undefined) throw new Error("no PAYMENT-REQUIRED header");
    return decodeHeader(header, PaymentRequired);
  };

  it("surfaces the gas-station hint in PaymentRequirements.extra", async () => {
    const doc = await requiredOf({
      ...OPTIONS,
      extra: {
        [SUI_GAS_STATION_EXTRA]: { url: "https://facilitator.example" },
      },
    });
    expect(doc.accepts[0]?.extra).toEqual({
      [SUI_GAS_STATION_EXTRA]: { url: "https://facilitator.example" },
    });
  });

  it("a seller that omits extra still yields extra: {} exactly as today", async () => {
    const doc = await requiredOf(OPTIONS);
    expect(doc.accepts[0]?.extra).toEqual({});
  });
});
