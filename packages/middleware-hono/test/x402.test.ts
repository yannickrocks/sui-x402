/**
 * The shared seller conformance suite run against a real Hono app, plus the
 * behaviour that is Hono's alone: routing, middleware composition, and sharing
 * one seller across mounts.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  HEADER_PAYMENT_REQUIRED,
  PaymentRequired,
  createSeller,
  decodeHeader,
  encodeHeader,
  type SellerOptions,
} from "@sui-x402/core";
import {
  type ConformanceTarget,
  runSellerConformance,
} from "../../core/test/seller-conformance.js";
import { x402 } from "../src/index.js";

const ORIGIN = "https://seller.test";

const honoTarget: ConformanceTarget = {
  name: "@sui-x402/hono",
  serve: async (options, handler) => {
    let handled = 0;
    const app = new Hono();
    app.use("/paid/*", x402(options));
    app.get("/paid/*", (c) => {
      handled += 1;
      return c.text(handler());
    });
    return {
      request: async (path, init) => app.request(new Request(`${ORIGIN}${path}`, init)),
      handlerCalls: () => handled,
      close: async () => {},
    };
  },
};

runSellerConformance(honoTarget);

// --- Hono-specific behaviour ------------------------------------------------

const TERMS = {
  payTo: "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d",
  amount: "10000",
  asset:
    "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
  network: "sui:testnet",
  facilitator: "https://facilitator.test",
} as const satisfies Omit<SellerOptions, "fetch">;

const PAYMENT_DOCUMENT: Record<string, unknown> = {
  x402Version: 2,
  accepted: {
    scheme: "exact",
    network: TERMS.network,
    amount: TERMS.amount,
    asset: TERMS.asset,
    payTo: TERMS.payTo,
    maxTimeoutSeconds: 60,
    extra: {},
  },
  payload: { signature: "AA==", transaction: "AAEC" },
};
const PAYMENT_HEADER = encodeHeader(PAYMENT_DOCUMENT);

const SETTLE_OK = {
  success: true,
  payer: "0x9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e",
  transaction: "7Fq3fJ8Qq5vJ2sX1bYtN6dZ8mW4kR9pL3cV7hT2gB5aU",
  network: TERMS.network,
  amount: TERMS.amount,
};

/** Approves and settles everything, and records which endpoints were asked. */
const payingFacilitator = () => {
  const paths: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    const json =
      path === "/settle"
        ? SETTLE_OK
        : { isValid: true, payer: SETTLE_OK.payer };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    paths,
    options: { ...TERMS, fetch: fetchImpl } satisfies SellerOptions,
  };
};

const get = async (app: Hono, path: string, headers: Record<string, string> = {}): Promise<Response> =>
  app.request(new Request(`${ORIGIN}${path}`, { headers }));

const termsOf = (response: Response): PaymentRequired => {
  const header = response.headers.get(HEADER_PAYMENT_REQUIRED);
  if (header === null) throw new Error(`no ${HEADER_PAYMENT_REQUIRED} header`);
  return decodeHeader(header, PaymentRequired);
};

describe("@sui-x402/hono routing", () => {
  it("leaves a route outside the paywall untouched", async () => {
    const { paths, options } = payingFacilitator();
    const app = new Hono();
    app.use("/paid/*", x402(options));
    app.get("/paid/quote", (c) => c.text("paid"));
    app.get("/free/quote", (c) => c.text("free"));

    const response = await get(app, "/free/quote");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("free");
    expect(response.headers.get(HEADER_PAYMENT_REQUIRED)).toBeNull();
    expect(paths).toEqual([]);
  });

  it("composes after another middleware, which keeps its headers on the 402", async () => {
    const { options } = payingFacilitator();
    const order: string[] = [];
    const app = new Hono();
    app.use("/paid/*", async (c, next) => {
      order.push("outer:before");
      c.header("x-trace", "outer");
      await next();
      order.push("outer:after");
    });
    app.use("/paid/*", x402(options));
    app.get("/paid/quote", (c) => {
      order.push("handler");
      return c.text("paid");
    });

    const response = await get(app, "/paid/quote");

    expect(response.status).toBe(402);
    expect(response.headers.get("x-trace")).toBe("outer");
    expect(order).toEqual(["outer:before", "outer:after"]);
  });

  it("reads a lowercase payment-signature header", async () => {
    const { paths, options } = payingFacilitator();
    const app = new Hono();
    app.use("/paid/*", x402(options));
    app.get("/paid/quote", (c) => c.text("paid"));

    const response = await get(app, "/paid/quote", {
      "payment-signature": PAYMENT_HEADER,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("paid");
    expect(paths).toEqual(["/verify", "/settle"]);
  });

  it("shares one seller across two mounts, echoing each route in its own terms", async () => {
    const { options } = payingFacilitator();
    const seller = createSeller(options);
    const app = new Hono();
    app.use("/a/*", x402(seller));
    app.use("/b/*", x402(seller));
    app.get("/a/quote", (c) => c.text("a"));
    app.get("/b/quote", (c) => c.text("b"));

    const [a, b] = await Promise.all([
      get(app, "/a/quote"),
      get(app, "/b/quote"),
    ]);
    expect([a.status, b.status]).toEqual([402, 402]);
    expect(termsOf(a).resource.url).toBe(`${ORIGIN}/a/quote`);
    expect(termsOf(b).resource.url).toBe(`${ORIGIN}/b/quote`);
    expect(termsOf(a).accepts).toEqual([seller.requirements]);
  });
});
