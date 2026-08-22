import { describe, expect, it } from "vitest";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  FacilitatorError,
  PaymentRequired,
  SellerConfigError,
  SettleResponse,
  Supported,
  createSeller,
  decodeHeader,
  encodeHeader,
  type SellerDecision,
  type SellerOptions,
} from "../src/index.js";
import { fixture } from "./fixtures.js";
import { type ConformanceTarget, runSellerConformance } from "./seller-conformance.js";

const terms = PaymentRequired.parse(fixture("demo-402.payment-required.json"));
const live = terms.accepts[0];
const supported = Supported.parse(fixture("facilitator-supported.live.json"));
const URL_UNDER_TEST = "https://seller.test/paid/whales";
const PAYER = "0x9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e";

const SETTLE_OK: SettleResponse = {
  success: true,
  payer: PAYER,
  transaction: "7Fq3fJ8Qq5vJ2sX1bYtN6dZ8mW4kR9pL3cV7hT2gB5aU",
  network: live.network,
  amount: live.amount,
};

/** Carries keys core's schema strips, so a rewritten relay is visible in the assertions. */
const PAYMENT_DOCUMENT: Record<string, unknown> = {
  x402Version: 2,
  accepted: { ...live, extra: { x: "payer-supplied" } },
  payload: { signature: "AA==", transaction: "AAEC" },
  extensions: { trace: "abc" },
  note: "unknown to this schema version",
};
const PAYMENT_HEADER = encodeHeader(PAYMENT_DOCUMENT);

// --- scripted facilitator ---------------------------------------------------

type Route = (init: RequestInit | undefined) => Promise<Response>;

const replies = (json: unknown, status = 200): Route => async () =>
  new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });

const sends = (body: string, status = 200): Route => async () => new Response(body, { status });

const refuses: Route = async () => {
  throw new TypeError("fetch failed");
};

/** Never resolves on its own; only the caller's AbortSignal can end it. */
const hangs: Route = (init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal instanceof AbortSignal) signal.addEventListener("abort", () => reject(signal.reason));
  });

const scripted = (routes: { verify?: Route; settle?: Route; supported?: Route }) => {
  const calls: { url: string; init: RequestInit | undefined; body: unknown }[] = [];
  const fetchImpl: typeof globalThis.fetch = (input, init) => {
    const url = String(input);
    calls.push({ url, init, body: JSON.parse(String(init?.body ?? "null")) });
    const route = url.endsWith("/settle") ? routes.settle : url.endsWith("/supported") ? routes.supported : routes.verify;
    if (route === undefined) throw new Error(`unscripted request to ${url}`);
    return route(init);
  };
  return { calls, fetch: fetchImpl };
};

const options = (overrides: Partial<SellerOptions> = {}): SellerOptions => ({
  payTo: live.payTo,
  amount: live.amount,
  asset: live.asset,
  network: live.network,
  facilitator: "https://facilitator.test",
  maxTimeoutSeconds: live.maxTimeoutSeconds,
  ...overrides,
});

const paid = (routes: { verify?: Route; settle?: Route }, overrides: Partial<SellerOptions> = {}) => {
  const facilitator = scripted(routes);
  const seller = createSeller(options({ ...overrides, fetch: facilitator.fetch }));
  return {
    calls: facilitator.calls,
    seller,
    decide: (paymentSignature: string | null = PAYMENT_HEADER): Promise<SellerDecision> =>
      seller.handle({ url: URL_UNDER_TEST, paymentSignature }),
  };
};

const respond = (decision: SellerDecision): Extract<SellerDecision, { kind: "respond" }> => {
  if (decision.kind !== "respond") throw new Error(`expected a respond decision, got ${decision.kind}`);
  return decision;
};

const fulfill = (decision: SellerDecision): Extract<SellerDecision, { kind: "fulfill" }> => {
  if (decision.kind !== "fulfill") throw new Error(`expected a fulfill decision, got ${decision.kind}`);
  return decision;
};

const configError = (overrides: Partial<SellerOptions>): SellerConfigError => {
  try {
    createSeller(options(overrides));
  } catch (e) {
    if (e instanceof SellerConfigError) return e;
    throw e;
  }
  throw new Error("createSeller accepted an invalid configuration");
};

const facilitatorRequest = (body: unknown) => ({
  x402Version: 2,
  paymentPayload: body,
  paymentRequirements: live,
});

// --- configuration ----------------------------------------------------------

describe("createSeller fails loudly at startup (PRD §8.15)", () => {
  it.each<[string, Partial<SellerOptions>, string]>([
    ["a bare symbol asset", { asset: "USDC" }, "asset"],
    ["a zero amount", { amount: "0" }, "amount"],
    ["a fractional amount", { amount: "1.5" }, "amount"],
    ["an amount in float notation", { amount: "1e3" }, "amount"],
    ["an address that is not hex", { payTo: "sui:alice" }, "payTo"],
    ["a negative timeout", { maxTimeoutSeconds: -1 }, "maxTimeoutSeconds"],
    ["a fractional timeout", { maxTimeoutSeconds: 1.5 }, "maxTimeoutSeconds"],
  ])("rejects %s, naming the field", (_name, overrides, field) => {
    expect(configError(overrides).message).toContain(field);
  });

  it.each<[string, Partial<SellerOptions>]>([
    ["a bare host", { facilitator: "facilitator.test" }],
    ["an empty string", { facilitator: "" }],
    ["a non-http protocol", { facilitator: "ftp://facilitator.test" }],
  ])("rejects a facilitator given as %s", (_name, overrides) => {
    expect(configError(overrides).message).toContain("facilitator");
  });

  it.each<[string, Partial<SellerOptions>, string]>([
    ["retryAfterSeconds", { retryAfterSeconds: 0 }, "retryAfterSeconds"],
    ["verifyTimeoutMs", { verifyTimeoutMs: -1 }, "verifyTimeoutMs"],
    ["settleTimeoutMs", { settleTimeoutMs: 1.5 }, "settleTimeoutMs"],
  ])("rejects a %s that is not a positive integer", (_name, overrides, field) => {
    expect(configError(overrides).message).toContain(field);
  });

  it("refuses sui:mainnet unless the seller opts in", () => {
    expect(configError({ network: "sui:mainnet" }).message).toContain("allowMainnet");
    expect(createSeller(options({ network: "sui:mainnet", allowMainnet: true })).requirements.network).toBe(
      "sui:mainnet",
    );
  });

  it("accepts maxTimeoutSeconds 0, which the wire schema allows", () => {
    expect(createSeller(options({ maxTimeoutSeconds: 0 })).requirements.maxTimeoutSeconds).toBe(0);
  });

  it("exposes the advertised requirements and defaults to strict mode", () => {
    const seller = createSeller(options());
    expect(seller.mode).toBe("strict");
    expect(seller.requirements).toEqual(live);
    expect(createSeller(options({ mode: "fast" })).mode).toBe("fast");
  });

  it("tolerates a trailing slash on the facilitator URL", async () => {
    const facilitator = scripted({ verify: replies({ isValid: false }) });
    const seller = createSeller(
      options({ facilitator: "https://facilitator.test/api/", fetch: facilitator.fetch }),
    );
    await seller.handle({ url: URL_UNDER_TEST, paymentSignature: PAYMENT_HEADER });
    expect(facilitator.calls[0].url).toBe("https://facilitator.test/api/verify");
  });
});

// --- 402 document -----------------------------------------------------------

describe("paymentRequired", () => {
  it("puts the identical JSON in the header and the body (spec-notes #1)", () => {
    const seller = createSeller(options({ description: "whale signal", mimeType: "application/json" }));
    const { header, body } = seller.paymentRequired(URL_UNDER_TEST, "PAYMENT-SIGNATURE header is required");

    expect(header).toBe(encodeHeader(body));
    expect(decodeHeader(header, PaymentRequired)).toEqual(body);
    expect(body).toEqual({
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: { url: URL_UNDER_TEST, description: "whale signal", mimeType: "application/json" },
      accepts: [live],
    });
  });

  it("omits description and mimeType when the seller did not configure them", () => {
    const { body } = createSeller(options()).paymentRequired(URL_UNDER_TEST, "insufficient_funds");
    expect(body.resource).toEqual({ url: URL_UNDER_TEST });
    expect(Object.keys(body.resource)).toEqual(["url"]);
  });
});

// --- handle -----------------------------------------------------------------

describe("handle without a usable payment header", () => {
  it("answers 402 with the terms when the header is absent", async () => {
    const { decide, seller, calls } = paid({});
    const decision = respond(await decide(null));

    expect(decision.status).toBe(402);
    expect(decision.headers).toEqual({
      [HEADER_PAYMENT_REQUIRED]: seller.paymentRequired(URL_UNDER_TEST, "PAYMENT-SIGNATURE header is required").header,
      "content-type": "application/json",
    });
    expect(decision.body).toEqual(
      seller.paymentRequired(URL_UNDER_TEST, "PAYMENT-SIGNATURE header is required").body,
    );
    expect(calls).toEqual([]);
  });

  it.each<[string, string, string]>([
    ["an empty header", "", "empty"],
    ["non-base64 characters", "not base64!", "not_base64"],
    ["base64 of non-JSON", Buffer.from("hello").toString("base64"), "not_json"],
    ["a JSON array", encodeHeader([PAYMENT_DOCUMENT]), "not_object"],
    ["a document of the wrong shape", encodeHeader({ hello: "world" }), "schema"],
  ])("answers 400 for %s without asking the facilitator", async (_name, header, reason) => {
    const { decide, calls } = paid({});
    const decision = respond(await decide(header));

    expect(decision.status).toBe(400);
    expect(decision.headers).toEqual({ "content-type": "application/json" });
    expect(decision.body).toEqual({ error: "malformed PAYMENT-SIGNATURE", reason });
    expect(calls).toEqual([]);
  });
});

describe("handle relays the payment to the facilitator", () => {
  it("posts the payer's document verbatim, keys this schema version strips included", async () => {
    const { decide, calls } = paid({ verify: replies({ isValid: true }), settle: replies(SETTLE_OK) });
    await decide();

    expect(calls.map((call) => call.url)).toEqual([
      "https://facilitator.test/verify",
      "https://facilitator.test/settle",
    ]);
    for (const call of calls) {
      expect(call.body).toEqual(facilitatorRequest(PAYMENT_DOCUMENT));
      expect(call.init?.method).toBe("POST");
      expect(new Headers(call.init?.headers).get("content-type")).toBe("application/json");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("answers 402 with the facilitator's reason when the payment is invalid", async () => {
    const { decide } = paid({ verify: replies({ isValid: false, invalidReason: "insufficient_funds" }) });
    const decision = respond(await decide());

    expect(decision.status).toBe(402);
    expect(PaymentRequired.parse(decision.body).error).toBe("insufficient_funds");
    expect(decision.headers[HEADER_PAYMENT_REQUIRED]).toBe(encodeHeader(decision.body));
  });

  it("falls back to invalid_payload when the facilitator names no reason", async () => {
    const { decide } = paid({ verify: replies({ isValid: false }) });
    expect(PaymentRequired.parse(respond(await decide()).body).error).toBe("invalid_payload");
  });

  it("treats the facilitator's 400 as its verdict, not as an outage (spec-notes #5)", async () => {
    const { decide } = paid({ verify: replies({ isValid: false, invalidReason: "invalid_payload" }, 400) });
    const decision = respond(await decide());

    expect(decision.status).toBe(402);
    expect(PaymentRequired.parse(decision.body).error).toBe("invalid_payload");
  });
});

describe("handle answers 503 rather than fulfilling unpaid content (PRD §8.7)", () => {
  it.each<[string, Route, string]>([
    ["the request never leaves", refuses, "unreachable"],
    ["the facilitator answers 500", sends("boom", 500), "http"],
    ["the body is not JSON", sends("<html>maintenance</html>"), "unparseable"],
    ["the body is JSON of another shape", replies({ ok: "yes" }), "unparseable"],
  ])("%s", async (_name, verify, kind) => {
    const { decide } = paid({ verify });
    const decision = respond(await decide());

    expect(decision.status).toBe(503);
    expect(decision.headers).toEqual({ "Retry-After": "5", "content-type": "application/json" });
    expect(decision.body).toEqual({ error: "facilitator unavailable", kind });
  });

  it("uses the configured Retry-After", async () => {
    const { decide } = paid({ verify: refuses }, { retryAfterSeconds: 30 });
    expect(respond(await decide()).headers["Retry-After"]).toBe("30");
  });

  it("aborts a verify that outlives verifyTimeoutMs", async () => {
    const { decide } = paid({ verify: hangs }, { verifyTimeoutMs: 30 });
    const started = Date.now();
    const decision = respond(await decide());

    expect(decision.status).toBe(503);
    expect(decision.body).toEqual({ error: "facilitator unavailable", kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("aborts a settle that outlives settleTimeoutMs", async () => {
    const { decide } = paid({ verify: replies({ isValid: true }), settle: hangs }, { settleTimeoutMs: 30 });
    const decision = respond(await decide());

    expect(decision.status).toBe(503);
    expect(decision.body).toEqual({ error: "facilitator unavailable", kind: "timeout" });
  });

  it("defaults verify to 10s and derives settle from maxTimeoutSeconds", async () => {
    const seen: number[] = [];
    const original = AbortSignal.timeout;
    AbortSignal.timeout = (ms: number) => {
      seen.push(ms);
      return original.call(AbortSignal, ms);
    };
    try {
      const { decide } = paid({ verify: replies({ isValid: true }), settle: replies(SETTLE_OK) });
      await decide();
      const custom = paid(
        { verify: replies({ isValid: true }), settle: replies(SETTLE_OK) },
        { verifyTimeoutMs: 1_500, settleTimeoutMs: 2_500 },
      );
      await custom.decide();
    } finally {
      AbortSignal.timeout = original;
    }

    expect(seen).toEqual([10_000, live.maxTimeoutSeconds * 1_000 + 10_000, 1_500, 2_500]);
  });
});

describe("strict mode settles before the handler may run (PRD §8.6, §8.8)", () => {
  it("fulfills with the settlement in PAYMENT-RESPONSE", async () => {
    const { decide } = paid({ verify: replies({ isValid: true }), settle: replies(SETTLE_OK) });
    const decision = fulfill(await decide());

    expect(decision.settleAfter).toBeNull();
    expect(decodeHeader(decision.headers[HEADER_PAYMENT_RESPONSE], SettleResponse)).toEqual(SETTLE_OK);
  });

  it("answers 402 with the settle reason when settlement fails", async () => {
    const { decide } = paid({
      verify: replies({ isValid: true }),
      settle: replies({
        success: false,
        errorReason: "invalid_transaction_state",
        transaction: "",
        network: live.network,
      }),
    });
    const decision = respond(await decide());

    expect(decision.status).toBe(402);
    expect(PaymentRequired.parse(decision.body).error).toBe("invalid_transaction_state");
  });

  it("falls back to unexpected_settle_error when the facilitator names no reason", async () => {
    const { decide } = paid({
      verify: replies({ isValid: true }),
      settle: replies({ success: false, transaction: "", network: "" }),
    });
    expect(PaymentRequired.parse(respond(await decide()).body).error).toBe("unexpected_settle_error");
  });

  it("answers 503 when settle cannot be reached, so the payer resends the same payload", async () => {
    const { decide } = paid({ verify: replies({ isValid: true }), settle: refuses });
    const decision = respond(await decide());

    expect(decision.status).toBe(503);
    expect(decision.body).toEqual({ error: "facilitator unavailable", kind: "unreachable" });
  });
});

describe("fast mode settles after the handler (PRD §8.6)", () => {
  it("fulfills on a valid verify and settles only when settleAfter is called", async () => {
    const { decide, calls } = paid(
      { verify: replies({ isValid: true }), settle: replies(SETTLE_OK) },
      { mode: "fast" },
    );
    const decision = fulfill(await decide());

    expect(decision.headers).toEqual({});
    expect(calls).toHaveLength(1);
    expect(decision.settleAfter).not.toBeNull();
    const settle = decision.settleAfter === null ? null : await decision.settleAfter();
    expect(settle).toEqual(SETTLE_OK);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual(facilitatorRequest(PAYMENT_DOCUMENT));
  });

  it.each<[string, Route, { reason: string; payer: string | null; digest: string | null }]>([
    [
      "a rejected settlement",
      replies({
        success: false,
        errorReason: "invalid_transaction_state",
        payer: PAYER,
        transaction: "",
        network: "sui:testnet",
      }),
      { reason: "invalid_transaction_state", payer: PAYER, digest: null },
    ],
    ["an unreachable facilitator", refuses, { reason: "unreachable", payer: null, digest: null }],
    ["a facilitator that answers 500", sends("boom", 500), { reason: "http", payer: null, digest: null }],
  ])("reports %s to onSettleFailure and resolves null", async (_name, settle, expected) => {
    const failures: { reason: string; payer: string | null; digest: string | null }[] = [];
    const { decide } = paid(
      { verify: replies({ isValid: true }), settle },
      { mode: "fast", onSettleFailure: (failure) => failures.push(failure) },
    );
    const decision = fulfill(await decide());

    expect(decision.settleAfter === null ? "missing" : await decision.settleAfter()).toBeNull();
    expect(failures).toEqual([expected]);
  });

  it("reports the settlement digest when one was broadcast before the failure", async () => {
    const failures: { reason: string; payer: string | null; digest: string | null }[] = [];
    const { decide } = paid(
      {
        verify: replies({ isValid: true }),
        settle: replies({
          success: false,
          errorReason: "unexpected_settle_error",
          transaction: SETTLE_OK.transaction,
          network: live.network,
        }),
      },
      { mode: "fast", onSettleFailure: (failure) => failures.push(failure) },
    );
    const decision = fulfill(await decide());
    if (decision.settleAfter !== null) await decision.settleAfter();

    expect(failures[0].digest).toBe(SETTLE_OK.transaction);
  });

  it("never rejects: neither a missing callback nor a throwing one escapes settleAfter", async () => {
    const silent = paid({ verify: replies({ isValid: true }), settle: refuses }, { mode: "fast" });
    const silentDecision = fulfill(await silent.decide());
    expect(silentDecision.settleAfter === null ? "missing" : await silentDecision.settleAfter()).toBeNull();

    const noisy = paid(
      { verify: replies({ isValid: true }), settle: refuses },
      {
        mode: "fast",
        onSettleFailure: () => {
          throw new Error("the seller's logger is broken");
        },
      },
    );
    const noisyDecision = fulfill(await noisy.decide());
    expect(noisyDecision.settleAfter === null ? "missing" : await noisyDecision.settleAfter()).toBeNull();
  });
});

// --- capability discovery ---------------------------------------------------

describe("assertFacilitatorSupports", () => {
  it("accepts a facilitator advertising the configured network", async () => {
    const facilitator = scripted({ supported: replies(supported) });
    await expect(createSeller(options({ fetch: facilitator.fetch })).assertFacilitatorSupports()).resolves.toBeUndefined();
    expect(facilitator.calls[0].url).toBe("https://facilitator.test/supported");
    expect(facilitator.calls[0].init?.method).toBe("GET");
  });

  it("rejects a facilitator that does not serve the configured network", async () => {
    const withoutTestnet = { ...supported, kinds: supported.kinds.filter((kind) => kind.network !== "sui:testnet") };
    const facilitator = scripted({ supported: replies(withoutTestnet) });
    const seller = createSeller(options({ fetch: facilitator.fetch }));

    await expect(seller.assertFacilitatorSupports()).rejects.toBeInstanceOf(SellerConfigError);
    await expect(seller.assertFacilitatorSupports()).rejects.toThrow("sui:testnet");
  });

  it("rejects a facilitator that serves the network under another scheme", async () => {
    const upto = { ...supported, kinds: supported.kinds.map((kind) => ({ ...kind, scheme: "upto" })) };
    const seller = createSeller(options({ fetch: scripted({ supported: replies(upto) }).fetch }));
    await expect(seller.assertFacilitatorSupports()).rejects.toBeInstanceOf(SellerConfigError);
  });

  it.each<[string, Route, string, number | null]>([
    ["is unreachable", refuses, "unreachable", null],
    ["answers 500", sends("boom", 500), "http", 500],
    ["answers something other than /supported", sends("<html>", 200), "unparseable", null],
  ])("raises a FacilitatorError when the facilitator %s", async (_name, route, kind, status) => {
    const seller = createSeller(options({ fetch: scripted({ supported: route }).fetch }));
    try {
      await seller.assertFacilitatorSupports();
      throw new Error("assertFacilitatorSupports resolved");
    } catch (e) {
      expect(e).toBeInstanceOf(FacilitatorError);
      if (!(e instanceof FacilitatorError)) throw e;
      expect(e.kind).toBe(kind);
      expect(e.status).toBe(status);
    }
  });
});

// --- the shared suite, against the seller core itself -----------------------

const referenceTarget: ConformanceTarget = {
  name: "core seller (in-process)",
  serve: async (sellerOptions, handler) => {
    const seller = createSeller(sellerOptions);
    let handled = 0;
    return {
      request: async (path, init) => {
        const headers = new Headers(init?.headers);
        const decision = await seller.handle({
          url: new URL(path, "https://seller.test").href,
          paymentSignature: headers.get(HEADER_PAYMENT_SIGNATURE),
        });
        if (decision.kind === "respond") {
          return new Response(JSON.stringify(decision.body), { status: decision.status, headers: decision.headers });
        }
        handled += 1;
        const body = handler();
        // Fire and forget, as a real adapter must: settleAfter can never reject.
        if (decision.settleAfter !== null) void decision.settleAfter();
        return new Response(body, { status: 200, headers: decision.headers });
      },
      handlerCalls: () => handled,
      close: async () => {},
    };
  },
};

runSellerConformance(referenceTarget);
