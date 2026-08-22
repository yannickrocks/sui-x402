import { describe, expect, it } from "vitest";
import {
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  Supported,
  VerifyResponse,
  decodeHeader,
} from "../src/index.js";
import { fixture, fixtureText } from "./fixtures.js";

type ReasonCases = {
  cases: Record<"verify" | "settle", Record<string, { http: number; body: unknown }>>;
};

describe("schemas accept every captured facilitator document", () => {
  it("GET /supported — live (testnet + mainnet) and pinned-local (testnet only)", () => {
    const live = Supported.parse(fixture("facilitator-supported.live.json"));
    const local = Supported.parse(fixture("facilitator-supported.local.json"));
    expect(live.kinds.map((k) => k.network)).toEqual(["sui:testnet", "sui:mainnet"]);
    expect(local.kinds.map((k) => k.network)).toEqual(["sui:testnet"]);
    expect(local.kinds[0]?.extra).toMatchObject({ decimals: 6 });
  });

  it("402 body parses as PaymentRequired (carries the non-spec `error` field)", () => {
    const body = PaymentRequired.parse(fixture("demo-402.body.json"));
    expect(body.error).toBe("PAYMENT-SIGNATURE header is required");
    expect(body.accepts).toHaveLength(1);
  });

  it("PAYMENT-REQUIRED header decodes to exactly the 402 body", () => {
    const header = decodeHeader(fixtureText("demo-402.payment-required.header.txt"), PaymentRequired);
    expect(header).toEqual(fixture("demo-402.body.json"));
    expect(header).toEqual(fixture("demo-402.payment-required.json"));
  });

  it("accepts[0] is a full PaymentRequirements with no fields invented by parsing", () => {
    const raw = (fixture("demo-402.body.json") as { accepts: unknown[] }).accepts[0];
    expect(PaymentRequirements.parse(raw)).toEqual(raw);
  });

  it("every captured /verify and /settle body parses as its response schema", () => {
    const { cases } = fixture("facilitator-reason-codes.json") as ReasonCases;
    for (const { body } of Object.values(cases.verify)) {
      const r = VerifyResponse.parse(body);
      expect(r.isValid).toBe(false);
      expect(r.invalidReason).toMatch(/^[a-z0-9_]+$/);
    }
    for (const { body } of Object.values(cases.settle)) {
      const r = SettleResponse.parse(body);
      expect(r.success).toBe(false);
      expect(r.transaction).toBe("");
    }
  });

  it("only unparseable JSON yields HTTP 400; semantic rejections are 200", () => {
    const { cases } = fixture("facilitator-reason-codes.json") as ReasonCases;
    for (const ep of ["verify", "settle"] as const) {
      for (const [name, c] of Object.entries(cases[ep])) {
        expect(c.http, `${ep}.${name}`).toBe(name === "unparseable_body" ? 400 : 200);
      }
    }
  });
});
