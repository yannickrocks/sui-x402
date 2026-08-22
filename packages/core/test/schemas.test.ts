import { describe, expect, it } from "vitest";
import {
  AmountString,
  Base64,
  MAX_TRANSACTION_BASE64_CHARS,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  StructTag,
  SuiAddress,
} from "../src/index.js";
import { fixture } from "./fixtures.js";

const requirements = (fixture("demo-402.body.json") as { accepts: PaymentRequirements[] }).accepts[0]!;
const payload = {
  x402Version: 2,
  accepted: requirements,
  payload: { signature: "AA==", transaction: "AA==" },
};

describe("AmountString", () => {
  it.each(["1", "10000", "999999999999999999999999"])("accepts %s", (s) => {
    expect(AmountString.safeParse(s).success).toBe(true);
  });
  it.each(["0", "-1", "1.5", "1e6", "0x10", " 1", "", "１"])("rejects %j", (s) => {
    expect(AmountString.safeParse(s).success).toBe(false);
  });
  it("rejects numbers — amounts are strings on the wire", () => {
    expect(AmountString.safeParse(10000).success).toBe(false);
  });
});

describe("StructTag", () => {
  it("accepts the testnet USDC tag", () => {
    expect(StructTag.safeParse(requirements.asset).success).toBe(true);
  });
  it("accepts short package ids and generic tags", () => {
    expect(StructTag.safeParse("0x2::sui::SUI").success).toBe(true);
    expect(StructTag.safeParse("0x2::coin::Coin<0x2::sui::SUI>").success).toBe(true);
  });
  it.each(["USDC", "usdc::USDC", "0x2::sui", "2::sui::SUI", ""])("rejects %j", (s) => {
    expect(StructTag.safeParse(s).success).toBe(false);
  });
});

describe("SuiAddress", () => {
  it("accepts full and short hex forms", () => {
    expect(SuiAddress.safeParse(requirements.payTo).success).toBe(true);
    expect(SuiAddress.safeParse("0x2").success).toBe(true);
  });
  it.each(["2", "0x", `0x${"f".repeat(65)}`, "0xZZ"])("rejects %j", (s) => {
    expect(SuiAddress.safeParse(s).success).toBe(false);
  });
});

describe("Base64", () => {
  it.each(["AA==", "AAA=", "AAAA", "", "YWJj"])("accepts %j", (s) => {
    expect(Base64.safeParse(s).success).toBe(true);
  });
  it.each(["A", "AA", "AAA", "AA=", "AA===", "AA A=", "YWJj\n", "-_-_"])("rejects %j", (s) => {
    expect(Base64.safeParse(s).success).toBe(false);
  });
});

describe("PaymentRequirements", () => {
  it("round-trips the fixture without adding or dropping fields", () => {
    expect(PaymentRequirements.parse(requirements)).toEqual(requirements);
  });
  it("does not invent `extra` or `maxTimeoutSeconds`", () => {
    const { extra: _e, ...noExtra } = requirements;
    expect(PaymentRequirements.parse(noExtra)).toEqual(noExtra);
    expect(PaymentRequirements.safeParse({ ...noExtra, maxTimeoutSeconds: undefined }).success).toBe(false);
  });
  it.each([
    ["scheme upto", { scheme: "upto" }],
    ["network devnet", { network: "sui:devnet" }],
    ["symbol as asset", { asset: "USDC" }],
    ["zero amount", { amount: "0" }],
    ["numeric amount", { amount: 10000 }],
    ["fractional timeout", { maxTimeoutSeconds: 1.5 }],
    ["negative timeout", { maxTimeoutSeconds: -1 }],
    ["payTo not hex", { payTo: "0xZZ" }],
  ])("rejects %s", (_name, patch) => {
    expect(PaymentRequirements.safeParse({ ...requirements, ...patch }).success).toBe(false);
  });
});

describe("PaymentPayload", () => {
  it("accepts a structurally valid payload without `resource`", () => {
    expect(PaymentPayload.parse(payload)).toEqual(payload);
  });
  it("accepts `resource` and `extensions` when present", () => {
    const full = { ...payload, resource: { url: "https://x.test/r" }, extensions: { a: 1 } };
    expect(PaymentPayload.parse(full)).toEqual(full);
  });
  it.each([
    ["x402Version 1", { x402Version: 1 }],
    ["empty transaction", { payload: { signature: "AA==", transaction: "" } }],
    ["empty signature", { payload: { signature: "", transaction: "AA==" } }],
    ["non-base64 transaction", { payload: { signature: "AA==", transaction: "not base64!" } }],
    ["transaction over cap", { payload: { signature: "AA==", transaction: "A".repeat(MAX_TRANSACTION_BASE64_CHARS + 4) } }],
    ["missing accepted", { accepted: undefined }],
  ])("rejects %s", (_name, patch) => {
    expect(PaymentPayload.safeParse({ ...payload, ...patch }).success).toBe(false);
  });
  it("accepts a transaction exactly at the cap", () => {
    const tx = "A".repeat(MAX_TRANSACTION_BASE64_CHARS);
    expect(PaymentPayload.safeParse({ ...payload, payload: { signature: "AA==", transaction: tx } }).success).toBe(true);
  });
});

describe("PaymentRequired", () => {
  it("requires at least one accepts entry", () => {
    const body = fixture("demo-402.body.json") as PaymentRequired;
    expect(PaymentRequired.safeParse({ ...body, accepts: [] }).success).toBe(false);
  });
  it("works without the non-spec `error` field", () => {
    const { error: _e, ...rest } = fixture("demo-402.body.json") as PaymentRequired;
    expect(PaymentRequired.parse(rest)).toEqual(rest);
  });
});
