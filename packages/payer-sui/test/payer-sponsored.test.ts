import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { SUI_TYPE_ARG, fromBase64, toBase64 } from "@mysten/sui/utils";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  PaymentPayload,
  PaymentRequired,
  decodeHeader,
  encodeHeader,
  type PaymentRequirements,
  type SettleResponse,
} from "@sui-x402/core";
import type { OwnedCoin } from "../src/coins.js";
import type { GasStationClient, SponsorRequest } from "../src/gas-station.js";
import { GasStationError } from "../src/gas-station.js";
import { KeypairSigner } from "../src/signer.js";
import {
  type BalanceChange,
  type PaymentClient,
  CHAIN_IDENTIFIERS,
} from "../src/tx.js";
import { SuiX402Payer } from "../src/payer.js";

const fixture = PaymentRequired.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../core/fixtures/demo-402.payment-required.json",
        import.meta.url
      ),
      "utf8"
    )
  )
);
const liveOffer = fixture.accepts[0];
if (liveOffer === undefined) throw new Error("fixture has no offers");
const live: PaymentRequirements = liveOffer;
const USDC = live.asset;
const PAY_TO = live.payTo;
const URL_UNDER_TEST = fixture.resource.url;
const CHAIN_ID = CHAIN_IDENTIFIERS["sui:testnet"] ?? "";
const SPONSOR =
  "0x2222222222222222222222222222222222222222222222222222222222222222";

const keypair = new Ed25519Keypair();
const signerCalls = { count: 0 };
class CountingSigner extends KeypairSigner {
  override signTransaction(bytes: Uint8Array): Promise<string> {
    signerCalls.count++;
    return super.signTransaction(bytes);
  }
}
const signer = () => {
  signerCalls.count = 0;
  return new CountingSigner(keypair);
};

const terms = (over: Partial<PaymentRequirements> = {}): PaymentRequired => ({
  ...fixture,
  accepts: [{ ...live, ...over }],
});

const required = (t: PaymentRequired): Response =>
  new Response(JSON.stringify(t), {
    status: 402,
    headers: { [HEADER_PAYMENT_REQUIRED]: encodeHeader(t) },
  });

const settled = (digest: string): Response => {
  const settle: SettleResponse = {
    success: true,
    transaction: digest,
    network: "sui:testnet",
  };
  return new Response("content", {
    status: 200,
    headers: { [HEADER_PAYMENT_RESPONSE]: encodeHeader(settle) },
  });
};

let nextId = 1;
const coin = (balance: bigint, inner: string): OwnedCoin => {
  const i = nextId++;
  return {
    objectId: `0x${i.toString(16).padStart(64, "0")}`,
    version: String(i),
    digest: "11111111111111111111111111111111",
    type: `0x2::coin::Coin<${inner}>`,
    balance: balance.toString(),
  };
};

interface ClientOptions {
  suiBalance?: bigint;
  usdcBalance?: bigint;
  paymentCoinMoved?: boolean;
}

function mockClient(o: ClientOptions = {}) {
  const sui =
    o.suiBalance === undefined || o.suiBalance === 0n
      ? []
      : [coin(o.suiBalance, "0x2::sui::SUI")];
  const usdc = [coin(o.usdcBalance ?? 10_000_000n, USDC)];
  const credited: BalanceChange[] = [
    { coinType: USDC, address: PAY_TO, amount: live.amount },
  ];
  const client: PaymentClient = {
    async listCoins(input) {
      return {
        objects: input.coinType === SUI_TYPE_ARG ? sui : usdc,
        hasNextPage: false,
        cursor: null,
      };
    },
    async getCurrentSystemState() {
      return { systemState: { epoch: "1199", referenceGasPrice: "1000" } };
    },
    async getObject({ objectId }) {
      const found = [...sui, ...usdc].find((c) => c.objectId === objectId);
      if (found === undefined) throw new Error(`object ${objectId} not found`);
      const moved = o.paymentCoinMoved === true && found.type.includes("usdc");
      return {
        object: {
          version: moved ? String(Number(found.version) + 1) : found.version,
        },
      };
    },
    async getChainIdentifier() {
      return { chainIdentifier: CHAIN_ID };
    },
    async simulateTransaction() {
      return {
        $kind: "Transaction",
        Transaction: {
          effects: {
            gasUsed: {
              computationCost: "1000000",
              storageCost: "0",
              storageRebate: "0",
            },
          },
          balanceChanges: credited,
        },
      };
    },
  };
  return client;
}

function honestStation() {
  const requests: SponsorRequest[] = [];
  const client: GasStationClient = {
    baseUrl: "https://facilitator.example",
    async sponsor(request) {
      requests.push(request);
      const tx = Transaction.fromKind(fromBase64(request.transactionKindBytes));
      tx.setSender(request.sender);
      tx.setGasOwner(SPONSOR);
      tx.setGasPayment([
        {
          objectId: `0x${"9".repeat(64)}`,
          version: "7",
          digest: "11111111111111111111111111111111",
        },
      ]);
      tx.setGasPrice(1000n);
      tx.setGasBudget(5_000_000n);
      const bytes = await tx.build();
      return {
        bytes: toBase64(bytes),
        digest: TransactionDataBuilder.getDigestFromBytes(bytes),
      };
    },
  };
  return { client, requests };
}

function scriptFetch(script: Response[] | ((digest: () => string) => void)) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const queue = Array.isArray(script) ? [...script] : [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const header = new Headers(init?.headers).get(HEADER_PAYMENT_SIGNATURE);
    if (header === null) return required(terms());
    const payload = decodeHeader(header, PaymentPayload);
    const digest = TransactionDataBuilder.getDigestFromBytes(
      fromBase64(payload.payload.transaction)
    );
    const next = queue.shift();
    return next ?? settled(digest);
  };
  return { fetchImpl, calls };
}

const paymentOf = (call: { init: RequestInit | undefined }): PaymentPayload => {
  const header = new Headers(call.init?.headers).get(HEADER_PAYMENT_SIGNATURE);
  if (header === null) throw new Error("no PAYMENT-SIGNATURE");
  return decodeHeader(header, PaymentPayload);
};

describe("SuiX402Payer gasless", () => {
  it('falls back to sponsored exactly once under "auto" when the SUI gas floor fails (E2)', async () => {
    const station = honestStation();
    const { fetchImpl, calls } = scriptFetch([]);
    const payer = new SuiX402Payer({
      client: mockClient({ suiBalance: 0n }),
      signer: signer(),
      fetch: fetchImpl,
      gasless: "auto",
      gasStation: station.client,
    });
    const { response, receipt } = await payer.fetchWithReceipt(URL_UNDER_TEST);
    expect(response.status).toBe(200);
    expect(receipt).not.toBeNull();
    expect(station.requests).toHaveLength(1);
    expect(signerCalls.count).toBe(1);
    const payload = paymentOf(calls[1] as { init: RequestInit | undefined });
    const ext = payload.extensions?.["sui.sponsor"] as { digest: string };
    expect(ext.digest).toBe(
      TransactionDataBuilder.getDigestFromBytes(
        fromBase64(payload.payload.transaction)
      )
    );
  });

  it("does NOT fall back on a payment-asset shortfall — sponsor never called, original error propagates (E2)", async () => {
    const station = honestStation();
    const { fetchImpl } = scriptFetch([]);
    const payer = new SuiX402Payer({
      client: mockClient({ suiBalance: 0n, usdcBalance: 1n }),
      signer: signer(),
      fetch: fetchImpl,
      gasless: "auto",
      gasStation: station.client,
    });
    await expect(payer.fetch(URL_UNDER_TEST)).rejects.toMatchObject({
      name: "InsufficientBalanceError",
      asset: USDC,
    });
    expect(station.requests).toHaveLength(0);
    expect(signerCalls.count).toBe(0);
  });

  it('uses the sponsored path directly under "always", leaving the payer\'s SUI untouched (E3)', async () => {
    const station = honestStation();
    const { fetchImpl } = scriptFetch([]);
    const payer = new SuiX402Payer({
      client: mockClient({ suiBalance: 100_000_000n }),
      signer: signer(),
      fetch: fetchImpl,
      gasless: "always",
      gasStation: station.client,
    });
    const response = await payer.fetch(URL_UNDER_TEST);
    expect(response.status).toBe(200);
    expect(station.requests).toHaveLength(1);
  });

  it('surfaces the SUI shortfall under "auto" when the station is not configured on the deployment (E14)', async () => {
    const dead: GasStationClient = {
      baseUrl: "https://facilitator.example",
      async sponsor() {
        throw new GasStationError(
          "not_configured",
          "gas station refused: 503 sponsorship not configured",
          503
        );
      },
    };
    const { fetchImpl } = scriptFetch([]);
    const payer = new SuiX402Payer({
      client: mockClient({ suiBalance: 0n }),
      signer: signer(),
      fetch: fetchImpl,
      gasless: "auto",
      gasStation: dead,
    });
    await expect(payer.fetch(URL_UNDER_TEST)).rejects.toMatchObject({
      name: "GasStationError",
      kind: "not_configured",
    });
    expect(signerCalls.count).toBe(0);
  });

  it("requires a gasStation unless gasless is never", () => {
    expect(
      () =>
        new SuiX402Payer({
          client: mockClient(),
          signer: signer(),
          gasless: "auto",
        })
    ).toThrowError(/gasStation/);
    expect(
      () => new SuiX402Payer({ client: mockClient(), signer: signer() })
    ).not.toThrow();
  });

  it("version-checks the payment coin, not a gas coin, before a sponsored retry (E10)", async () => {
    const station = honestStation();
    const retryTerms = { ...terms(), error: "invalid_transaction_state" };
    const { fetchImpl } = scriptFetch([required(retryTerms)]);
    const payer = new SuiX402Payer({
      client: mockClient({ suiBalance: 0n, paymentCoinMoved: true }),
      signer: signer(),
      fetch: fetchImpl,
      sleep: async () => {},
      gasless: "auto",
      gasStation: station.client,
    });
    await expect(payer.fetch(URL_UNDER_TEST)).rejects.toMatchObject({
      name: "PaymentRejectedError",
      retryHint: "none",
    });
    // one signature: the retry was refused because the payment coin moved
    expect(signerCalls.count).toBe(1);
  });

  it("advertised gas station differing from the configured one is a local deployment_mismatch (E21)", async () => {
    const station = honestStation();
    const advertised = terms({
      extra: { "sui.gasStation": { url: "https://other.example" } },
    });
    const { fetchImpl } = scriptFetch([]);
    const fetchWithAd: typeof globalThis.fetch = async (input, init) => {
      const header = new Headers(init?.headers).get(HEADER_PAYMENT_SIGNATURE);
      if (header === null) return required(advertised);
      return fetchImpl(input, init);
    };
    const payer = new SuiX402Payer({
      client: mockClient({ suiBalance: 0n }),
      signer: signer(),
      fetch: fetchWithAd,
      gasless: "always",
      gasStation: station.client,
    });
    await expect(payer.fetch(URL_UNDER_TEST)).rejects.toMatchObject({
      kind: "deployment_mismatch",
    });
    expect(station.requests).toHaveLength(0);
  });

  it("matching advertised URL (trailing slash, origin case) proceeds (§6.5)", async () => {
    const station = honestStation();
    const advertised = terms({
      extra: { "sui.gasStation": { url: "https://FACILITATOR.example/" } },
    });
    const { fetchImpl } = scriptFetch([]);
    const fetchWithAd: typeof globalThis.fetch = async (input, init) => {
      const header = new Headers(init?.headers).get(HEADER_PAYMENT_SIGNATURE);
      if (header === null) return required(advertised);
      return fetchImpl(input, init);
    };
    const payer = new SuiX402Payer({
      client: mockClient({ suiBalance: 0n }),
      signer: signer(),
      fetch: fetchWithAd,
      gasless: "always",
      gasStation: station.client,
    });
    expect((await payer.fetch(URL_UNDER_TEST)).status).toBe(200);
  });
});
