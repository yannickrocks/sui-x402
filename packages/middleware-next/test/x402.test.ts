/**
 * The shared seller conformance suite run against a wrapped route handler,
 * plus what is this adapter's alone: the handler's own response survives,
 * the route context is forwarded, and one seller can guard several routes.
 */
import { describe, expect, it } from "vitest";
import {
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  SettleResponse,
  createSeller,
  decodeHeader,
  encodeHeader,
  type SellerOptions,
} from "@sui-x402/core";
import { type ConformanceTarget, runSellerConformance } from "../../core/test/seller-conformance.js";
import { type RouteHandler, withX402 } from "../src/index.js";

const ORIGIN = "https://seller.test";
const CONTEXT = { params: Promise.resolve({ id: "42" }) };

const nextTarget: ConformanceTarget = {
  name: "@sui-x402/next",
  serve: async (options, handler) => {
    let handled = 0;
    const GET = withX402(options)<typeof CONTEXT>(() => {
      handled += 1;
      return new Response(handler());
    });
    return {
      request: async (path, init) => GET(new Request(`${ORIGIN}${path}`, init), CONTEXT),
      handlerCalls: () => handled,
      close: async () => {},
    };
  },
};

runSellerConformance(nextTarget);

// --- Next-specific behaviour ------------------------------------------------

const TERMS = {
  payTo: "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d",
  amount: "10000",
  asset: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
  network: "sui:testnet",
  facilitator: "https://facilitator.test",
} as const satisfies Omit<SellerOptions, "fetch">;

const PAYMENT_HEADER = encodeHeader({
  x402Version: 2,
  accepted: { scheme: "exact", network: TERMS.network, amount: TERMS.amount, asset: TERMS.asset, payTo: TERMS.payTo, maxTimeoutSeconds: 60 },
  payload: { transaction: "AAECAw==", signature: "AAECAw==" },
});

const SETTLE: SettleResponse = {
  success: true,
  transaction: "7Fq3fJ8Qq5vJ2sX1bYtN6dZ8mW4kR9pL3cV7hT2gB5aU",
  network: "sui:testnet",
  amount: "10000",
};

/** A facilitator that accepts and settles everything. */
const facilitator: typeof globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/verify")) return Response.json({ isValid: true, payer: TERMS.payTo });
  if (url.endsWith("/settle")) return Response.json(SETTLE);
  throw new Error(`unexpected facilitator call ${url}`);
};

const paid = (path = "/api/quote") =>
  new Request(`${ORIGIN}${path}`, { headers: { [HEADER_PAYMENT_SIGNATURE]: PAYMENT_HEADER } });

describe("withX402", () => {
  it("keeps the handler's status, headers and streamed body, adding PAYMENT-RESPONSE", async () => {
    const GET = withX402({ ...TERMS, fetch: facilitator })(
      () =>
        new Response(new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode("quote")); c.close(); } }), {
          status: 201,
          headers: { "x-quote-source": "cache", "content-type": "text/plain" },
        }),
    );

    const response = await GET(paid(), CONTEXT);

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("quote");
    expect(response.headers.get("x-quote-source")).toBe("cache");
    expect(response.headers.get("content-type")).toBe("text/plain");
    const header = response.headers.get(HEADER_PAYMENT_RESPONSE);
    expect(header).not.toBeNull();
    expect(decodeHeader(header ?? "", SettleResponse)).toEqual(SETTLE);
  });

  it("forwards the route context to the handler", async () => {
    const seen: unknown[] = [];
    const handler: RouteHandler<typeof CONTEXT> = async (_request, context) => {
      seen.push(await context.params);
      return new Response("ok");
    };
    await withX402({ ...TERMS, fetch: facilitator })(handler)(paid(), CONTEXT);
    expect(seen).toEqual([{ id: "42" }]);
  });

  it("never runs the handler on a 402", async () => {
    let ran = 0;
    const GET = withX402({ ...TERMS, fetch: facilitator })(() => {
      ran += 1;
      return new Response("ok");
    });
    const response = await GET(new Request(`${ORIGIN}/api/quote`), CONTEXT);
    expect(response.status).toBe(402);
    expect(ran).toBe(0);
  });

  it("returns the response before settling in fast mode and reports the settlement through onSettled", async () => {
    const order: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowFacilitator: typeof globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/settle") await gate;
      order.push(path);
      return facilitator(input, init);
    };
    const settled: SettleResponse[] = [];
    const GET = withX402({ ...TERMS, mode: "fast", fetch: slowFacilitator, onSettled: (s) => settled.push(s) })(() => {
      order.push("handler");
      return new Response("ok");
    });

    const response = await GET(paid(), CONTEXT);
    expect(order).toEqual(["/verify", "handler"]);
    expect(response.headers.get(HEADER_PAYMENT_RESPONSE)).toBeNull();

    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["/verify", "handler", "/settle"]);
    expect(settled).toEqual([SETTLE]);
  });

  it("shares one seller across routes", async () => {
    const seller = createSeller({ ...TERMS, fetch: facilitator });
    const guard = withX402(seller);
    const quote = guard(() => new Response("quote"));
    const report = guard(() => new Response("report"));
    expect(await (await quote(paid("/api/quote"), CONTEXT)).text()).toBe("quote");
    expect(await (await report(paid("/api/report"), CONTEXT)).text()).toBe("report");
    expect((await quote(new Request(`${ORIGIN}/api/quote`), CONTEXT)).status).toBe(402);
  });
});
