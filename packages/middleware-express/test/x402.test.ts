import { createServer, type Server } from "node:http";
import express, { type ErrorRequestHandler, type Express } from "express";
import { describe, expect, it } from "vitest";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  PaymentRequired,
  SettleResponse,
  decodeHeader,
  encodeHeader,
  type PaymentRequirements,
  type SellerOptions,
} from "@sui-x402/core";
import {
  type ConformanceTarget,
  runSellerConformance,
} from "../../core/test/seller-conformance.js";
import { createSeller, x402 } from "../src/index.js";

const listen = async (
  app: Express
): Promise<{ server: Server; origin: string }> => {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("expected a TCP address");
  return { server, origin: `http://127.0.0.1:${address.port}` };
};

/** Undici holds the socket open, so a bare `close()` would never resolve. */
const close = (server: Server): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((e) => (e ? reject(e) : resolve()));
  });

const expressTarget: ConformanceTarget = {
  name: "@sui-x402/express",
  serve: async (options, handler) => {
    let handled = 0;
    const app = express();
    app.use(x402(options));
    app.use((_req, res) => {
      handled += 1;
      res.send(handler());
    });
    const { server, origin } = await listen(app);
    return {
      request: (path, init) => globalThis.fetch(`${origin}${path}`, init),
      handlerCalls: () => handled,
      close: () => close(server),
    };
  },
};

runSellerConformance(expressTarget);

// --- express-specific behaviour ---------------------------------------------

const REQUIREMENTS: PaymentRequirements = {
  scheme: "exact",
  network: "sui:testnet",
  amount: "10000",
  asset:
    "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
  payTo: "0x9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e4a3d1f9c1e",
  maxTimeoutSeconds: 60,
  extra: {},
};

const PAYMENT_HEADER = encodeHeader({
  x402Version: 2,
  accepted: REQUIREMENTS,
  payload: { signature: "AA==", transaction: "AAEC" },
});

const SETTLE_OK: SettleResponse = {
  success: true,
  payer: REQUIREMENTS.payTo,
  transaction: "7Fq3fJ8Qq5vJ2sX1bYtN6dZ8mW4kR9pL3cV7hT2gB5aU",
  network: REQUIREMENTS.network,
  amount: REQUIREMENTS.amount,
};

const facilitator = (replies: Record<string, unknown>) => {
  const paths: string[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    const reply = replies[path];
    if (reply === undefined) throw new Error(`nothing scripted for ${path}`);
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { paths, fetch: fetchImpl };
};

const options = (fetchImpl: typeof globalThis.fetch): SellerOptions => ({
  ...REQUIREMENTS,
  facilitator: "https://facilitator.test",
  fetch: fetchImpl,
});

const serving = async (build: (app: Express) => void) => {
  const app = express();
  build(app);
  const { server, origin } = await listen(app);
  return { origin, stop: () => close(server) };
};

describe("@sui-x402/express", () => {
  it("guards the routes it is mounted on and no others", async () => {
    const scripted = facilitator({});
    const app = await serving((a) => {
      a.use("/paid", x402(options(scripted.fetch)));
      a.get("/free", (_req, res) => {
        res.send("free");
      });
    });

    const free = await globalThis.fetch(`${app.origin}/free`);
    const paid = await globalThis.fetch(`${app.origin}/paid/whales`);

    expect(free.status).toBe(200);
    expect(await free.text()).toBe("free");
    expect(free.headers.get(HEADER_PAYMENT_REQUIRED)).toBeNull();
    expect(paid.status).toBe(402);
    expect(paid.headers.get(HEADER_PAYMENT_REQUIRED)).not.toBeNull();
    expect(scripted.paths).toEqual([]);
    await app.stop();
  });

  it("hands a failure inside handle() to the express error chain", async () => {
    const seller = {
      ...createSeller(options(facilitator({}).fetch)),
      handle: () => Promise.reject(new Error("seller exploded")),
    };
    const onError: ErrorRequestHandler = (error, _req, res, _next) => {
      res
        .status(500)
        .send(
          JSON.stringify({
            caught: error instanceof Error ? error.message : String(error),
          })
        );
    };
    const app = await serving((a) => {
      a.use(x402(seller));
      a.use((_req, res) => {
        res.send("content");
      });
      a.use(onError);
    });

    const response = await globalThis.fetch(`${app.origin}/paid/whales`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ caught: "seller exploded" });
    await app.stop();
  });

  it("reads a lowercase payment-signature header", async () => {
    const scripted = facilitator({
      "/verify": { isValid: true },
      "/settle": SETTLE_OK,
    });
    const app = await serving((a) => {
      a.use(x402(options(scripted.fetch)));
      a.use((_req, res) => {
        res.send("whales");
      });
    });

    const response = await globalThis.fetch(`${app.origin}/paid/whales`, {
      headers: { "payment-signature": PAYMENT_HEADER },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("whales");
    const settled = response.headers.get(HEADER_PAYMENT_RESPONSE);
    expect(
      settled === null ? null : decodeHeader(settled, SettleResponse)
    ).toEqual(SETTLE_OK);
    expect(scripted.paths).toEqual(["/verify", "/settle"]);
    await app.stop();
  });

  it("echoes the requested URL, query string included, in the 402 document", async () => {
    const scripted = facilitator({});
    const app = await serving((a) => {
      a.use("/paid", x402(options(scripted.fetch)));
    });

    const response = await globalThis.fetch(
      `${app.origin}/paid/whales?since=2026-08-01`
    );

    expect(response.status).toBe(402);
    const document = PaymentRequired.parse(await response.json());
    expect(document.resource.url).toBe(
      `${app.origin}/paid/whales?since=2026-08-01`
    );
    await app.stop();
  });
});
