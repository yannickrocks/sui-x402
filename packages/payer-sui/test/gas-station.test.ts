import { describe, expect, it } from "vitest";
import { GasStationError, httpGasStation } from "../src/gas-station.js";

const PAY_TO =
  "0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d";

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function stubFetch(status: number, body: unknown) {
  const requests: { url: string; body: unknown }[] = [];
  const fetchStub: typeof globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return jsonResponse(status, body);
  };
  return { fetchStub, requests };
}

const okBody = {
  bytes: "AAECAw==",
  digest: "7QSxe8Zuu4FkWMPLLEy6uczUwBZH62A2xMC9Res3S1k1",
};

describe("httpGasStation", () => {
  it("posts sender, base64 kind bytes, the UNSPLIT network id, and recipients including payTo (E4, E18)", async () => {
    const { fetchStub, requests } = stubFetch(200, okBody);
    const station = httpGasStation("https://facilitator.example", {
      fetch: fetchStub,
    });
    const result = await station.sponsor({
      sender: "0x1",
      transactionKindBytes: "AAECAw==",
      network: "sui:testnet",
      recipients: [PAY_TO],
    });
    expect(result).toEqual(okBody);
    expect(requests).toHaveLength(1);
    const sent = requests[0];
    expect(sent?.url).toBe("https://facilitator.example/gas-station");
    expect(sent?.body).toMatchObject({
      network: "sui:testnet",
      recipients: [PAY_TO],
    });
  });

  it("exposes its base URL for deployment-mismatch checks", () => {
    expect(httpGasStation("https://facilitator.example/").baseUrl).toBe(
      "https://facilitator.example/"
    );
  });

  const cases: [number, string, string][] = [
    [503, "sponsorship not configured", "not_configured"],
    [503, "sponsorship temporarily unavailable", "global_cap"],
    [429, "daily sponsorship limit reached", "sender_cap"],
    [429, "rate limited", "rate_limited"],
    [400, "unsupported network", "rejected"],
    [502, "sponsor request failed", "rejected"],
  ];
  for (const [status, error, kind] of cases) {
    it(`maps ${status} "${error}" to ${kind}`, async () => {
      const { fetchStub } = stubFetch(status, { error });
      const station = httpGasStation("https://facilitator.example", {
        fetch: fetchStub,
      });
      await expect(
        station.sponsor({
          sender: "0x1",
          transactionKindBytes: "AA==",
          network: "sui:testnet",
        })
      ).rejects.toMatchObject({ name: "GasStationError", kind, status });
    });
  }

  it("maps an unknown 429 body to the coarser rate_limited and an unknown 503 to not_configured", async () => {
    for (const [status, kind] of [
      [429, "rate_limited"],
      [503, "not_configured"],
    ] as const) {
      const { fetchStub } = stubFetch(status, { error: "something new" });
      await expect(
        httpGasStation("https://x.example", { fetch: fetchStub }).sponsor({
          sender: "0x1",
          transactionKindBytes: "AA==",
          network: "sui:testnet",
        })
      ).rejects.toMatchObject({ kind, status });
    }
  });

  it("maps a network failure to unreachable and a non-JSON success to unparseable", async () => {
    const down: typeof globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(
      httpGasStation("https://x.example", { fetch: down }).sponsor({
        sender: "0x1",
        transactionKindBytes: "AA==",
        network: "sui:testnet",
      })
    ).rejects.toMatchObject({ kind: "unreachable" });

    const garbled: typeof globalThis.fetch = async () =>
      new Response("not json", { status: 200 });
    await expect(
      httpGasStation("https://x.example", { fetch: garbled }).sponsor({
        sender: "0x1",
        transactionKindBytes: "AA==",
        network: "sui:testnet",
      })
    ).rejects.toMatchObject({ kind: "unparseable" });
  });

  it("GasStationError carries kind, message, and optional status", () => {
    const e = new GasStationError(
      "timeout",
      "gas station timed out after 10000ms"
    );
    expect(e.kind).toBe("timeout");
    expect(e.status).toBeUndefined();
    expect(e.name).toBe("GasStationError");
  });
});
