import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReasonCode, isReasonCode, retryHint } from "../src/index.js";
import { fixture } from "./fixtures.js";

const upstreamErrTable = (): string[] => {
  const path = new URL("../../../deploy/facilitator/upstream/src/x402.ts", import.meta.url);
  if (!existsSync(path)) throw new Error("upstream submodule missing: run `git submodule update --init`");
  const src = readFileSync(path, "utf8");
  const block = src.slice(src.indexOf("export const ERR = {"), src.indexOf("} as const;"));
  return [...block.matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]!);
};

describe("ReasonCode", () => {
  it("equals the pinned upstream ERR table exactly (no missing, no extra)", () => {
    expect([...ReasonCode.options].sort()).toEqual(upstreamErrTable().sort());
  });

  it("covers every code observed live", () => {
    const { cases } = fixture("facilitator-reason-codes.json") as {
      cases: Record<string, Record<string, { body: { invalidReason?: string; errorReason?: string } }>>;
    };
    const seen = Object.values(cases)
      .flatMap((c) => Object.values(c))
      .map((c) => c.body.invalidReason ?? c.body.errorReason ?? "");
    expect(seen.length).toBeGreaterThan(0);
    for (const code of seen) expect(isReasonCode(code), code).toBe(true);
  });

  it("isReasonCode rejects unknown strings without throwing", () => {
    expect(isReasonCode("")).toBe(false);
    expect(isReasonCode("INVALID_PAYLOAD")).toBe(false);
    expect(isReasonCode("something_new")).toBe(false);
  });
});

describe("retryHint", () => {
  it.each<[string, ReturnType<typeof retryHint>]>([
    ["invalid_payment_requirements", "refetch_terms"],
    ["invalid_transaction_state", "rebuild_tx"],
    ["unexpected_verify_error", "facilitator"],
    ["unexpected_settle_error", "facilitator"],
    ["insufficient_funds", "none"],
    ["invalid_exact_sui_payload_signature", "none"],
    ["unknown_future_code", "none"],
  ])("%s → %s", (code, hint) => {
    expect(retryHint(code)).toBe(hint);
  });
});
