import { describe, expect, it } from "vitest";
import {
  HeaderError,
  MAX_HEADER_CHARS,
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
  decodeHeader,
  decodeHeaderVerbatim,
  encodeHeader,
} from "../src/index.js";
import { fixture, fixtureText } from "./fixtures.js";

const required = fixture("demo-402.body.json") as PaymentRequired;
const requirements = required.accepts[0]!;
const payload: PaymentPayload = {
  x402Version: 2,
  resource: { url: "https://x.test/ü/資源?q=1" },
  accepted: requirements,
  payload: { signature: "AA==", transaction: "AAEC" },
};

const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof HeaderError) return e.reason;
    throw e;
  }
  throw new Error("did not throw");
};

describe("header codec round-trip", () => {
  it("encode(fixture 402 body) is byte-identical to the live PAYMENT-REQUIRED header", () => {
    expect(encodeHeader(required)).toBe(fixtureText("demo-402.payment-required.header.txt"));
  });

  it("decode(encode(x)) === x for every header-borne schema", () => {
    expect(decodeHeader(encodeHeader(required), PaymentRequired)).toEqual(required);
    expect(decodeHeader(encodeHeader(payload), PaymentPayload)).toEqual(payload);
    const settle = { success: true, transaction: "3x5M…digest", network: "sui:testnet", payer: "0x1", amount: "10000" };
    expect(decodeHeader(encodeHeader(settle), SettleResponse)).toEqual(settle);
  });

  it("preserves non-ASCII text through utf8 → base64", () => {
    const out = decodeHeader(encodeHeader(payload), PaymentPayload);
    expect(out.resource?.url).toBe(payload.resource?.url);
  });

  it("encodes compact JSON (no whitespace) so headers stay small", () => {
    expect(Buffer.from(encodeHeader({ a: 1, b: [1, 2] }), "base64").toString("utf8")).toBe('{"a":1,"b":[1,2]}');
  });
});

describe("malformed headers fail with a typed reason, never a raw throw", () => {
  it.each<[string, string, string]>([
    ["empty string", "", "empty"],
    ["unpadded base64", "AAA", "not_base64"],
    ["non-base64 characters", "not base64!", "not_base64"],
    ["url-safe alphabet", "eyJhIjoxfQ-_", "not_base64"],
    ["base64 of non-JSON", Buffer.from("hello").toString("base64"), "not_json"],
    ["base64 of truncated JSON", Buffer.from('{"x402Version":2,').toString("base64"), "not_json"],
    ["JSON null", encodeHeader(null), "not_object"],
    ["JSON array", encodeHeader([required]), "not_object"],
    ["JSON number", encodeHeader(2), "not_object"],
    ["valid JSON, wrong schema", encodeHeader({ hello: "world" }), "schema"],
    ["valid JSON, x402Version 1", encodeHeader({ ...required, x402Version: 1 }), "schema"],
  ])("%s → %s", (_name, header, reason) => {
    expect(reasonOf(() => decodeHeader(header, PaymentRequired))).toBe(reason);
  });

  it("rejects oversize headers before attempting to decode them", () => {
    const big = "A".repeat(MAX_HEADER_CHARS + 4);
    expect(reasonOf(() => decodeHeader(big, PaymentRequired))).toBe("too_large");
  });

  it("accepts a header exactly at the cap (then fails on content, not size)", () => {
    const atCap = "A".repeat(MAX_HEADER_CHARS);
    expect(reasonOf(() => decodeHeader(atCap, PaymentRequired))).toBe("not_json");
  });

  it("a transaction over the tx cap is a schema failure with the offending path", () => {
    const over = { ...payload, payload: { signature: "AA==", transaction: "A".repeat(120_004) } };
    try {
      decodeHeader(encodeHeader(over), PaymentPayload);
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HeaderError);
      expect((e as HeaderError).reason).toBe("schema");
      expect((e as HeaderError).issues?.[0]?.path).toEqual(["payload", "transaction"]);
    }
  });

  it("HeaderError is a real Error with a stable name", () => {
    const e = new HeaderError("empty");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("HeaderError");
    expect(e.message).toBe("x402 header: empty");
  });
});

describe("decodeHeaderVerbatim keeps what the schema strips", () => {
  const withUnknownKeys = {
    ...payload,
    accepted: { ...requirements, extra: { x: "payer-supplied" } },
    extensions: { trace: "abc" },
    note: "unknown to this schema version",
  };

  it("returns the raw document beside the validated one", () => {
    const { raw, value } = decodeHeaderVerbatim(encodeHeader(withUnknownKeys), PaymentPayload);

    expect(raw).toEqual(withUnknownKeys);
    expect(value).toEqual({ ...withUnknownKeys, note: undefined });
    expect(value).not.toHaveProperty("note");
  });

  it("relaying raw is byte-identical to the header the payer sent", () => {
    const header = encodeHeader(withUnknownKeys);
    expect(encodeHeader(decodeHeaderVerbatim(header, PaymentPayload).raw)).toBe(header);
  });

  it("decodeHeader is the validated half of it", () => {
    const header = encodeHeader(required);
    expect(decodeHeader(header, PaymentRequired)).toEqual(decodeHeaderVerbatim(header, PaymentRequired).value);
  });

  it.each<[string, string, string]>([
    ["empty string", "", "empty"],
    ["non-base64 characters", "not base64!", "not_base64"],
    ["base64 of non-JSON", Buffer.from("hello").toString("base64"), "not_json"],
    ["JSON array", encodeHeader([required]), "not_object"],
    ["valid JSON, wrong schema", encodeHeader({ hello: "world" }), "schema"],
  ])("fails exactly like decodeHeader on %s", (_name, header, reason) => {
    expect(reasonOf(() => decodeHeaderVerbatim(header, PaymentRequired))).toBe(reason);
    expect(reasonOf(() => decodeHeader(header, PaymentRequired))).toBe(reason);
  });

  it("rejects oversize headers before decoding them", () => {
    expect(reasonOf(() => decodeHeaderVerbatim("A".repeat(MAX_HEADER_CHARS + 4), PaymentRequired))).toBe("too_large");
  });
});
