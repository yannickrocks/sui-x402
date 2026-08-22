/**
 * The seller conformance suite: one behavioural contract, run against every
 * adapter (`@sui-x402/hono`, `@sui-x402/express`, `@sui-x402/next`) and against
 * the reference target in `seller.test.ts`.
 *
 * Adapters differ only in how they read a request and write a response, so the
 * suite drives them purely over HTTP: a scripted facilitator `fetch` handed to
 * the seller through `SellerOptions`, and assertions on the `Response` that
 * comes back. It never touches seller internals — an adapter loads its own copy
 * of core, so class identity (`instanceof HeaderError`) is not shared across
 * that boundary.
 */
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  PaymentRequired,
  SettleResponse,
  decodeHeader,
  encodeHeader,
  type PaymentRequirements,
  type SellerOptions,
} from "../src/index.js";

export interface ConformanceTarget {
  name: string;
  serve(
    options: SellerOptions,
    handler: () => string,
  ): Promise<{
    request(path: string, init?: RequestInit): Promise<Response>;
    handlerCalls(): number;
    close(): Promise<void>;
  }>;
}

const fixture = PaymentRequired.parse(
  JSON.parse(readFileSync(new URL("../fixtures/demo-402.payment-required.json", import.meta.url), "utf8")),
);
const live = fixture.accepts[0];

/** What every adapter must advertise for the options below. */
const REQUIREMENTS: PaymentRequirements = {
  scheme: "exact",
  network: live.network,
  amount: live.amount,
  asset: live.asset,
  payTo: live.payTo,
  maxTimeoutSeconds: live.maxTimeoutSeconds,
  extra: {},
};

const BASE: Omit<SellerOptions, "fetch"> = {
  payTo: live.payTo,
  amount: live.amount,
  asset: live.asset,
  network: live.network,
  facilitator: "https://facilitator.test",
  maxTimeoutSeconds: live.maxTimeoutSeconds,
  description: fixture.resource.description,
  mimeType: fixture.resource.mimeType,
};

const HANDLER_BODY = '{"whales":[]}';
const PAYER = "0x9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e";
const DIGEST = "7Fq3fJ8Qq5vJ2sX1bYtN6dZ8mW4kR9pL3cV7hT2gB5aU";

const SETTLE_OK: SettleResponse = {
  success: true,
  payer: PAYER,
  transaction: DIGEST,
  network: live.network,
  amount: live.amount,
};

/**
 * A payment document carrying keys core's schema would strip (`accepted.extra.x`,
 * the unknown top-level `note`) plus the schema's own `extensions`. Whatever the
 * payer signed reaches the facilitator unchanged, so all of it must survive.
 */
const paymentDocument = (network: PaymentRequirements["network"] = live.network): Record<string, unknown> => ({
  x402Version: 2,
  resource: { url: "https://seller.test/paid/whales" },
  accepted: { ...REQUIREMENTS, network, extra: { x: "payer-supplied" } },
  payload: { signature: "AA==", transaction: "AAEC" },
  extensions: { trace: "abc" },
  note: "unknown to this schema version",
});

type Reply = { status: number; json: unknown } | { status: number; text: string } | { throws: string };

interface Script {
  verify: Reply;
  settle?: Reply;
}

const jsonReply = (json: unknown, status = 200): Reply => ({ status, json });

const must = (value: string | null): string => {
  if (value === null) throw new Error("conformance: expected header is absent");
  return value;
};

const waitUntil = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!done()) throw new Error("conformance: timed out waiting for the background settle");
};

const scriptedFacilitator = (script: Script, order: string[]) => {
  const calls: { path: string; body: unknown }[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href).pathname;
    const body: unknown = JSON.parse(String(init?.body ?? "null"));
    calls.push({ path, body });
    order.push(path);
    const reply = path === "/settle" ? script.settle : script.verify;
    if (reply === undefined) throw new Error(`conformance: nothing scripted for ${path}`);
    if ("throws" in reply) throw new TypeError(reply.throws);
    if ("text" in reply) return new Response(reply.text, { status: reply.status });
    return new Response(JSON.stringify(reply.json), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetch: fetchImpl };
};

/** Registers the suite. Every adapter must call this with its own target. */
export function runSellerConformance(target: ConformanceTarget): void {
  describe(`seller conformance: ${target.name}`, () => {
    const opened: { close(): Promise<void> }[] = [];
    afterAll(async () => {
      for (const server of opened) await server.close();
      opened.length = 0;
    });

    const start = async (script: Script, overrides: Partial<SellerOptions> = {}) => {
      const order: string[] = [];
      const facilitator = scriptedFacilitator(script, order);
      const server = await target.serve({ ...BASE, ...overrides, fetch: facilitator.fetch }, () => {
        order.push("handler");
        return HANDLER_BODY;
      });
      opened.push(server);
      return { server, calls: facilitator.calls, order };
    };

    /** Terms are identical in the header and the body (spec-notes #1), on every 402. */
    const expectTerms = async (response: Response, path: string): Promise<PaymentRequired> => {
      const header = must(response.headers.get(HEADER_PAYMENT_REQUIRED));
      const text = await response.text();
      expect(text).toBe(Buffer.from(header, "base64").toString("utf8"));
      const document = PaymentRequired.parse(JSON.parse(text));
      expect(document.accepts[0]).toEqual(REQUIREMENTS);
      expect(new URL(document.resource.url).pathname).toBe(path);
      return document;
    };

    const facilitatorBody = (document: Record<string, unknown>) => ({
      x402Version: 2,
      paymentPayload: document,
      paymentRequirements: REQUIREMENTS,
    });

    it("answers 402 with the terms when the payment header is absent", async () => {
      const { server, calls, order } = await start({ verify: jsonReply({ isValid: true }) });
      const response = await server.request("/paid/whales");

      expect(response.status).toBe(402);
      const document = await expectTerms(response, "/paid/whales");
      expect(document.error).toBe("PAYMENT-SIGNATURE header is required");
      expect(server.handlerCalls()).toBe(0);
      expect(calls).toEqual([]);
      expect(order).toEqual([]);
    });

    it("answers 400 with the header reason when PAYMENT-SIGNATURE is malformed, without calling the facilitator", async () => {
      const { server, calls } = await start({ verify: jsonReply({ isValid: true }) });
      // Lowercase on purpose: HTTP header names are case-insensitive.
      const response = await server.request("/paid/whales", { headers: { "payment-signature": "not base64!" } });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "malformed PAYMENT-SIGNATURE", reason: "not_base64" });
      expect(server.handlerCalls()).toBe(0);
      expect(calls).toEqual([]);
    });

    it("answers 402 carrying the facilitator's reason when verify rejects the payment", async () => {
      const { server } = await start({ verify: jsonReply({ isValid: false, invalidReason: "insufficient_funds" }) });
      const response = await server.request("/paid/whales", {
        headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(paymentDocument()) },
      });

      expect(response.status).toBe(402);
      const document = await expectTerms(response, "/paid/whales");
      expect(document.error).toBe("insufficient_funds");
      expect(server.handlerCalls()).toBe(0);
    });

    it.each<[string, Script, string]>([
      ["unreachable", { verify: { throws: "connect ECONNREFUSED" } }, "unreachable"],
      ["HTTP 500", { verify: { status: 500, text: "upstream boom" } }, "http"],
      ["unreadable body", { verify: { status: 200, text: "<html>maintenance</html>" } }, "unparseable"],
      ["unexpected shape", { verify: jsonReply({ ok: "yes" }) }, "unparseable"],
    ])("answers 503 + Retry-After when the facilitator is %s, never content", async (_name, script, kind) => {
      const { server } = await start(script);
      const response = await server.request("/paid/whales", {
        headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(paymentDocument()) },
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(await response.json()).toEqual({ error: "facilitator unavailable", kind });
      expect(server.handlerCalls()).toBe(0);
    });

    it("strict: settles before the handler runs and reports the settlement in PAYMENT-RESPONSE", async () => {
      const document = paymentDocument();
      const { server, calls, order } = await start({
        verify: jsonReply({ isValid: true, payer: PAYER }),
        settle: jsonReply(SETTLE_OK),
      });
      // Mixed case on purpose: HTTP header names are case-insensitive.
      const response = await server.request("/paid/whales", {
        headers: { "Payment-Signature": encodeHeader(document) },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(HANDLER_BODY);
      expect(decodeHeader(must(response.headers.get(HEADER_PAYMENT_RESPONSE)), SettleResponse)).toEqual(SETTLE_OK);
      expect(server.handlerCalls()).toBe(1);
      expect(order).toEqual(["/verify", "/settle", "handler"]);
      // Verbatim relay: keys this schema version strips are still on the wire.
      expect(calls).toEqual([
        { path: "/verify", body: facilitatorBody(document) },
        { path: "/settle", body: facilitatorBody(document) },
      ]);
    });

    it("strict: answers 402 with the settle reason and withholds the content when settlement fails", async () => {
      const { server } = await start({
        verify: jsonReply({ isValid: true, payer: PAYER }),
        settle: jsonReply({
          success: false,
          errorReason: "invalid_transaction_state",
          transaction: "",
          network: live.network,
        }),
      });
      const response = await server.request("/paid/whales", {
        headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(paymentDocument()) },
      });

      expect(response.status).toBe(402);
      const document = await expectTerms(response, "/paid/whales");
      expect(document.error).toBe("invalid_transaction_state");
      expect(server.handlerCalls()).toBe(0);
    });

    it("strict: answers 503 and withholds the content when settle cannot be reached", async () => {
      const { server, order } = await start({
        verify: jsonReply({ isValid: true, payer: PAYER }),
        settle: { throws: "socket hang up" },
      });
      const response = await server.request("/paid/whales", {
        headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(paymentDocument()) },
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
      expect(server.handlerCalls()).toBe(0);
      expect(order).toEqual(["/verify", "/settle"]);
    });

    it("fast: serves the content after verify, settles afterwards, and reports the settlement only through onSettled", async () => {
      const document = paymentDocument();
      const settled: SettleResponse[] = [];
      const { server, calls, order } = await start(
        { verify: jsonReply({ isValid: true, payer: PAYER }), settle: jsonReply(SETTLE_OK) },
        { mode: "fast", onSettled: (settle) => settled.push(settle) },
      );
      const response = await server.request("/paid/whales", {
        headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(document) },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(HANDLER_BODY);
      expect(response.headers.get(HEADER_PAYMENT_RESPONSE)).toBeNull();
      expect(server.handlerCalls()).toBe(1);
      await waitUntil(() => settled.length === 1);
      expect(order).toEqual(["/verify", "handler", "/settle"]);
      expect(calls[1]).toEqual({ path: "/settle", body: facilitatorBody(document) });
      expect(settled).toEqual([SETTLE_OK]);
    });

    it("redeems a payment that already settled: verify says invalid_transaction_state, settle reconstructs it", async () => {
      const settled: SettleResponse[] = [];
      const { server, order } = await start(
        {
          verify: jsonReply({ isValid: false, invalidReason: "invalid_transaction_state" }),
          settle: jsonReply(SETTLE_OK),
        },
        { onSettled: (settle) => settled.push(settle) },
      );
      const response = await server.request("/paid/whales", {
        headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(paymentDocument()) },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(HANDLER_BODY);
      expect(decodeHeader(must(response.headers.get(HEADER_PAYMENT_RESPONSE)), SettleResponse)).toEqual(SETTLE_OK);
      expect(order).toEqual(["/verify", "/settle", "handler"]);
      expect(settled).toEqual([SETTLE_OK]);
    });

    it("fast: an already-settled payment is confirmed through settle before the handler runs", async () => {
      const { server, order } = await start(
        {
          verify: jsonReply({ isValid: false, invalidReason: "invalid_transaction_state" }),
          settle: jsonReply(SETTLE_OK),
        },
        { mode: "fast" },
      );
      const response = await server.request("/paid/whales", {
        headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(paymentDocument()) },
      });

      expect(response.status).toBe(200);
      expect(order).toEqual(["/verify", "/settle", "handler"]);
    });

    it("withholds the content when verify and settle both reject a stale transaction", async () => {
      const failures: { reason: string; payer: string | null; digest: string | null }[] = [];
      const { server, order } = await start(
        {
          verify: jsonReply({ isValid: false, invalidReason: "invalid_transaction_state" }),
          settle: jsonReply({
            success: false,
            errorReason: "invalid_transaction_state",
            payer: PAYER,
            transaction: DIGEST,
            network: live.network,
          }),
        },
        { onSettleFailure: (failure) => failures.push(failure) },
      );
      const response = await server.request("/paid/whales", {
        headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(paymentDocument()) },
      });

      expect(response.status).toBe(402);
      const document = await expectTerms(response, "/paid/whales");
      expect(document.error).toBe("invalid_transaction_state");
      expect(server.handlerCalls()).toBe(0);
      expect(order).toEqual(["/verify", "/settle"]);
      expect(failures).toEqual([{ reason: "invalid_transaction_state", payer: PAYER, digest: DIGEST }]);
    });

    it("fast: reports a failed settlement to onSettleFailure and still serves the content", async () => {
      const failures: { reason: string; payer: string | null; digest: string | null }[] = [];
      const { server } = await start(
        {
          verify: jsonReply({ isValid: true, payer: PAYER }),
          settle: jsonReply({
            success: false,
            errorReason: "invalid_transaction_state",
            payer: PAYER,
            transaction: "",
            network: live.network,
          }),
        },
        { mode: "fast", onSettleFailure: (failure) => failures.push(failure) },
      );
      const response = await server.request("/paid/whales", {
        headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(paymentDocument()) },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(HANDLER_BODY);
      await waitUntil(() => failures.length === 1);
      expect(failures[0]).toEqual({ reason: "invalid_transaction_state", payer: PAYER, digest: null });
    });

    it("relays a payment whose accepted terms name another network — the facilitator decides, not the seller", async () => {
      const document = paymentDocument("sui:mainnet");
      const { server, calls } = await start({
        verify: jsonReply({ isValid: false, invalidReason: "invalid_payment_requirements" }),
      });
      const response = await server.request("/paid/whales", {
        headers: { [HEADER_PAYMENT_SIGNATURE]: encodeHeader(document) },
      });

      expect(calls).toEqual([{ path: "/verify", body: facilitatorBody(document) }]);
      expect(response.status).toBe(402);
      expect((await expectTerms(response, "/paid/whales")).error).toBe("invalid_payment_requirements");
      expect(server.handlerCalls()).toBe(0);
    });
  });
}
