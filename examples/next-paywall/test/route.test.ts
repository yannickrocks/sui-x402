/**
 * The paid route, driven in-process: the real `withX402` wrapper around the
 * real handler, with the facilitator scripted. Running `next dev` is not
 * needed to prove the paywall; the hono/express examples cover the live loop.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { HEADER_PAYMENT_REQUIRED, PaymentRequired, decodeHeader } from "@sui-x402/core";

process.env.PAY_TO = "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d";
process.env.FACILITATOR_URL = "https://facilitator.test";

describe("GET /api/quote", () => {
  let GET: (typeof import("../app/api/quote/route.js"))["GET"];
  beforeAll(async () => {
    ({ GET } = await import("../app/api/quote/route.js"));
  });

  it("answers 402 with the terms until paid", async () => {
    const response = await GET(new Request("http://localhost:3000/api/quote"), { params: Promise.resolve({}) });
    expect(response.status).toBe(402);
    const terms = decodeHeader(response.headers.get(HEADER_PAYMENT_REQUIRED) ?? "", PaymentRequired);
    expect(terms.accepts[0]?.payTo).toBe(process.env.PAY_TO);
    expect(terms.accepts[0]?.amount).toBe("10000");
    expect(terms.resource.url).toBe("http://localhost:3000/api/quote");
    expect(await response.json()).toMatchObject({ x402Version: 2 });
  });
});
