import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bcs } from "@mysten/sui/bcs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { SUI_TYPE_ARG, fromBase64 } from "@mysten/sui/utils";
import {
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  HEADER_PAYMENT_SIGNATURE,
  HeaderError,
  PaymentPayload,
  PaymentRequired,
  decodeHeader,
  encodeHeader,
  type PaymentRequirements,
  type SettleResponse,
} from "@sui-x402/core";
import { InsufficientBalanceError, type OwnedCoin } from "../src/coins.js";
import { NoAcceptableRequirementError, type SelectOptions } from "../src/select.js";
import { KeypairSigner, type PayerSigner } from "../src/signer.js";
import { type BalanceChange, type GasCostSummary, type PaymentClient, CHAIN_IDENTIFIERS } from "../src/tx.js";
import { PaymentRejectedError, SuiX402Payer } from "../src/payer.js";

const fixture = PaymentRequired.parse(
  JSON.parse(readFileSync(new URL("../../core/fixtures/demo-402.payment-required.json", import.meta.url), "utf8")),
);
const live = fixture.accepts[0];
const USDC = live.asset;
const PAY_TO = live.payTo;
const URL_UNDER_TEST = fixture.resource.url;
const NOW = 1_760_000_000_000;

const terms = (accepts: PaymentRequirements[] = [live], error = fixture.error): PaymentRequired => ({
  ...fixture,
  error,
  accepts,
});

/** `"exact" & string` reduces to `"exact"`, so this widens the value without a cast. */
const withRaw = (base: PaymentRequirements, raw: Record<string, string>): PaymentRequirements =>
  Object.assign({}, base, raw);

const required = (t: PaymentRequired, where: "header" | "body" | "both" = "both"): Response => {
  const headers = new Headers();
  if (where !== "body") headers.set(HEADER_PAYMENT_REQUIRED, encodeHeader(t));
  return new Response(where === "header" ? null : JSON.stringify(t), { status: 402, headers });
};

const settled = (settle: SettleResponse, body: string): Response =>
  new Response(body, { status: 200, headers: { [HEADER_PAYMENT_RESPONSE]: encodeHeader(settle) } });

// --- scripted fetch ---------------------------------------------------------

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** A thunk lets a test move the clock at the moment a request goes out. */
type Scripted = Response | (() => Response);

function scriptFetch(script: Scripted[]) {
  const calls: FetchCall[] = [];
  const queue = [...script];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unscripted fetch call #${calls.length}`);
    return typeof next === "function" ? next() : next;
  };
  return { fetchImpl, calls };
}

const signatureHeader = (call: FetchCall): string => {
  const header = new Headers(call.init?.headers).get(HEADER_PAYMENT_SIGNATURE);
  if (header === null) throw new Error("request carried no PAYMENT-SIGNATURE");
  return header;
};

const paymentOf = (call: FetchCall): PaymentPayload => decodeHeader(signatureHeader(call), PaymentPayload);

const digestOf = (call: FetchCall): string =>
  TransactionDataBuilder.getDigestFromBytes(fromBase64(paymentOf(call).payload.transaction));

/** The header before any schema touches it, to prove the payer relays verbatim. */
const rawPaymentOf = (call: FetchCall): unknown =>
  JSON.parse(Buffer.from(signatureHeader(call), "base64").toString("utf8"));

// --- mocked gRPC client -----------------------------------------------------

const GAS_USED: GasCostSummary = { computationCost: "1000000", storageCost: "2000000", storageRebate: "500000" };
const CHAIN_ID = CHAIN_IDENTIFIERS["sui:testnet"] ?? "";
const EPOCH = "1199";
const NO_CALLS = { listCoins: 0, getCurrentSystemState: 0, getChainIdentifier: 0, getObject: 0, simulateTransaction: 0 };

type OnChain = "present" | "absent" | "error";

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

function mockClient(usdcBalance = 1_000_000n, onChain: OnChain = "absent") {
  const calls = { ...NO_CALLS };
  const sui = [coin(100_000_000n, "0x2::sui::SUI")];
  const usdc = [coin(usdcBalance, USDC)];
  const credited: BalanceChange[] = [{ coinType: USDC, address: PAY_TO, amount: "1000000" }];
  const client: PaymentClient = {
    async listCoins(input) {
      calls.listCoins++;
      return { objects: input.coinType === SUI_TYPE_ARG ? sui : usdc, hasNextPage: false, cursor: null };
    },
    async getCurrentSystemState() {
      calls.getCurrentSystemState++;
      return { systemState: { epoch: EPOCH, referenceGasPrice: "1000" } };
    },
    async getObject({ objectId }) {
      calls.getObject++;
      if (onChain === "error") throw new Error("UNAVAILABLE: node unreachable");
      const found = [...sui, ...usdc].find((c) => c.objectId === objectId);
      if (found === undefined) throw new Error(`object ${objectId} not found`);
      return { object: { version: onChain === "present" ? String(Number(found.version) + 1) : found.version } };
    },
    async getChainIdentifier() {
      calls.getChainIdentifier++;
      return { chainIdentifier: CHAIN_ID };
    },
    async simulateTransaction() {
      calls.simulateTransaction++;
      return {
        $kind: "Transaction",
        Transaction: { effects: { gasUsed: GAS_USED }, balanceChanges: credited },
      };
    },
  };
  return { client, calls };
}

function countingSigner() {
  const keypair = Ed25519Keypair.generate();
  const inner = new KeypairSigner(keypair);
  let signed = 0;
  const signer: PayerSigner = {
    address: () => inner.address(),
    signTransaction: async (bytes) => {
      signed++;
      return inner.signTransaction(bytes);
    },
  };
  return { keypair, signer, signed: () => signed };
}

interface SetupOptions {
  now?: () => number;
  select?: SelectOptions;
  usdcBalance?: bigint;
  onChain?: OnChain;
}

function setup(script: Scripted[], options: SetupOptions = {}) {
  const { fetchImpl, calls } = scriptFetch(script);
  const { client, calls: clientCalls } = mockClient(options.usdcBalance, options.onChain);
  const { keypair, signer, signed } = countingSigner();
  const delays: number[] = [];
  const payer = new SuiX402Payer({
    client,
    signer,
    fetch: fetchImpl,
    now: options.now ?? (() => NOW),
    sleep: async (ms) => {
      delays.push(ms);
    },
    select: options.select,
  });
  return { payer, calls, clientCalls, signed, keypair, delays, address: signer.address() };
}

// --- decoding helpers -------------------------------------------------------

const decodeTx = (transaction: string) => Transaction.from(fromBase64(transaction)).getData();

const at = <T>(xs: readonly T[], i: number): T => {
  const v = xs[i];
  if (v === undefined) throw new Error(`missing index ${i}`);
  return v;
};

const pureInput = (data: ReturnType<typeof decodeTx>, arg: { $kind: string; Input?: number }): Uint8Array => {
  if (arg.$kind !== "Input" || arg.Input === undefined) throw new Error(`expected a pure input, got ${arg.$kind}`);
  const encoded = data.inputs[arg.Input]?.Pure?.bytes;
  if (encoded === undefined) throw new Error(`input ${arg.Input} is not pure`);
  return fromBase64(encoded);
};

const transferTo = (transaction: string): string => {
  const data = decodeTx(transaction);
  const transfer = data.commands[1]?.TransferObjects;
  if (!transfer) throw new Error(`expected TransferObjects second, got ${data.commands[1]?.$kind}`);
  return bcs.Address.parse(pureInput(data, transfer.address));
};

const splitAmount = (transaction: string): string => {
  const data = decodeTx(transaction);
  const split = data.commands[0]?.SplitCoins;
  if (!split) throw new Error(`expected SplitCoins first, got ${data.commands[0]?.$kind}`);
  const amount = split.amounts[0];
  if (amount === undefined) throw new Error("SplitCoins carries no amount");
  return bcs.U64.parse(pureInput(data, amount));
};

async function rejectsWith<E extends Error>(p: Promise<unknown>, cls: new (...a: never[]) => E): Promise<E> {
  try {
    await p;
  } catch (e) {
    if (e instanceof cls) return e;
    throw e;
  }
  throw new Error(`expected ${cls.name}`);
}

// --- tests ------------------------------------------------------------------

describe("SuiX402Payer.fetch — no payment", () => {
  it("returns a non-402 response untouched, without touching the wallet", async () => {
    const ok = new Response("free", { status: 200 });
    const { payer, calls, clientCalls, signed } = setup([ok]);

    const response = await payer.fetch(URL_UNDER_TEST);

    expect(response).toBe(ok);
    expect(await response.text()).toBe("free");
    expect(calls).toHaveLength(1);
    expect(clientCalls).toEqual(NO_CALLS);
    expect(signed()).toBe(0);
  });

  it("returns a 402 that carries no readable terms, body intact", async () => {
    const { payer, calls, clientCalls, signed } = setup([new Response("<html>nope</html>", { status: 402 })]);

    const response = await payer.fetch(URL_UNDER_TEST);

    expect(response.status).toBe(402);
    expect(await response.text()).toBe("<html>nope</html>");
    expect(calls).toHaveLength(1);
    expect(clientCalls).toEqual(NO_CALLS);
    expect(signed()).toBe(0);
  });

  it("surfaces a malformed PAYMENT-REQUIRED header as a HeaderError", async () => {
    const bad = new Response(null, { status: 402, headers: { [HEADER_PAYMENT_REQUIRED]: "!!not base64!!" } });
    const { payer, signed } = setup([bad]);

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), HeaderError);

    expect(err.reason).toBe("not_base64");
    expect(signed()).toBe(0);
  });

  it("refuses to sign when no offer is acceptable", async () => {
    const mainnet = withRaw(live, { network: "sui:mainnet" });
    const { payer, calls, clientCalls, signed } = setup([required(terms([mainnet]))]);

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), NoAcceptableRequirementError);

    expect(err.rejected).toEqual([{ index: 0, reason: "unsupported_network", requirement: mainnet }]);
    expect(calls).toHaveLength(1);
    expect(clientCalls).toEqual(NO_CALLS);
    expect(signed()).toBe(0);
  });

  it("forwards the caller's select options", async () => {
    const { payer, signed } = setup([required(terms())], { select: { maxAmount: { [USDC]: 1n } } });

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), NoAcceptableRequirementError);

    expect(err.rejected[0]?.reason).toBe("amount_over_cap");
    expect(signed()).toBe(0);
  });

  it("propagates an insufficient balance without signing", async () => {
    const { payer, calls, signed } = setup([required(terms())], { usdcBalance: 9_999n });

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), InsufficientBalanceError);

    expect(err).toMatchObject({ asset: USDC, required: 10_000n, available: 9_999n });
    expect(calls).toHaveLength(1);
    expect(signed()).toBe(0);
  });
});

describe("SuiX402Payer.fetchWithReceipt — happy path", () => {
  const SETTLE: SettleResponse = {
    success: true,
    transaction: "8pQZ1kqVJ2xLdA3sHwYqRk9nT2bFcM1vXyZ4pQ7sN6aD",
    network: "sui:testnet",
    payer: "0x9f2c4b1e0d8a7365c4b2a1908f7e6d5c4b3a29180f7e6d5c4b3a29180f7e6d5c",
    amount: "10000",
  };

  it("pays the seller's offer and reports the settlement", async () => {
    const headers = new Headers({ authorization: "Bearer caller-token" });
    const script: Scripted[] = [required(terms()), () => settled({ ...SETTLE, transaction: digestOf(at(calls, 1)) }, "paid")];
    const { payer, calls, keypair, address } = setup(script);

    const { response, receipt, sent } = await payer.fetchWithReceipt(URL_UNDER_TEST, { headers });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("paid");
    expect(calls).toHaveLength(2);

    const payload = paymentOf(calls[1]);
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(live);
    expect(payload.resource).toEqual(fixture.resource);

    const bytes = fromBase64(payload.payload.transaction);
    expect(await keypair.getPublicKey().verifyTransaction(bytes, payload.payload.signature)).toBe(true);
    const data = decodeTx(payload.payload.transaction);
    expect(data.sender).toBe(address);
    expect(data.expiration?.ValidDuring?.maxEpoch).toBe(String(Number(EPOCH) + 1));
    expect(splitAmount(payload.payload.transaction)).toBe("10000");

    const digest = digestOf(calls[1]);
    expect(sent).toEqual({ digest, accepted: live });
    expect(receipt).toEqual({
      digest,
      payer: SETTLE.payer,
      amount: "10000",
      network: "sui:testnet",
      accepted: live,
      settle: { ...SETTLE, transaction: digest },
    });

    expect(headers.get(HEADER_PAYMENT_SIGNATURE)).toBeNull();
    expect([...headers.keys()]).toEqual(["authorization"]);
    expect(new Headers(calls[1].init?.headers).get("authorization")).toBe("Bearer caller-token");
  });

  it("echoes the offer as the seller wrote it, normalizing only the transaction", async () => {
    const offer = { ...live, payTo: PAY_TO.toUpperCase().replace("0X", "0x"), extra: { usdc: USDC, decimals: 6 } };
    const { payer, calls } = setup([required(terms([offer])), new Response(null, { status: 200 })]);

    await payer.fetch(URL_UNDER_TEST);

    // The facilitator compares `accepted` against the seller's own requirements,
    // so the payer must not rewrite it, however unnormalized it arrived.
    expect(rawPaymentOf(calls[1])).toMatchObject({ accepted: { payTo: offer.payTo, extra: offer.extra } });
    expect(paymentOf(calls[1]).accepted).toEqual(offer);
    expect(transferTo(paymentOf(calls[1]).payload.transaction)).toBe(PAY_TO);
  });

  it("replays the caller's method and body on the paid request", async () => {
    const body = JSON.stringify({ query: "whales" });
    const { payer, calls } = setup([required(terms()), new Response(null, { status: 200 })]);

    await payer.fetch(URL_UNDER_TEST, { method: "POST", body, headers: { "content-type": "application/json" } });

    expect(calls[1].init?.method).toBe("POST");
    expect(calls[1].init?.body).toBe(body);
    expect(new Headers(calls[1].init?.headers).get("content-type")).toBe("application/json");
    expect(calls[1].url).toBe(URL_UNDER_TEST);
  });

  it("pays a 402 whose terms are only in the body", async () => {
    const { payer, calls } = setup([required(terms(), "body"), new Response(null, { status: 200 })]);

    const response = await payer.fetch(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(paymentOf(calls[1]).accepted).toEqual(live);
  });

  it("bounds every payment to the next epoch on chain, even when the offer sets no timeout", async () => {
    const offer = withRaw(live, {});
    offer.maxTimeoutSeconds = 0;
    const { payer, calls } = setup([required(terms([offer])), new Response(null, { status: 200 })]);

    await payer.fetch(URL_UNDER_TEST);

    const expiration = decodeTx(paymentOf(calls[1]).payload.transaction).expiration?.ValidDuring;
    expect(expiration?.maxEpoch).toBe(String(Number(EPOCH) + 1));
    expect(expiration?.chain).toBe(CHAIN_ID);
  });

  it("returns a null receipt when the seller sends no PAYMENT-RESPONSE", async () => {
    const { payer } = setup([required(terms()), new Response("paid", { status: 200 })]);

    const { response, receipt } = await payer.fetchWithReceipt(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(receipt).toBeNull();
  });

  it("returns a null receipt and no sent payment when nothing was paid", async () => {
    const { payer } = setup([new Response("free", { status: 200 })]);

    const { receipt, sent } = await payer.fetchWithReceipt(URL_UNDER_TEST);
    expect(receipt).toBeNull();
    expect(sent).toBeNull();
  });

  it("returns a null receipt when a successful settlement names a digest this payer never signed", async () => {
    const { payer, calls } = setup([required(terms()), settled(SETTLE, "paid")]);

    const { receipt, sent } = await payer.fetchWithReceipt(URL_UNDER_TEST);
    expect(receipt).toBeNull();
    expect(sent?.digest).toBe(digestOf(calls[1]));
  });

  it("still reports a failed settlement, whose digest is empty", async () => {
    const failed: SettleResponse = { success: false, errorReason: "unexpected_settle_error", transaction: "", network: "sui:testnet" };
    const { payer } = setup([required(terms()), settled(failed, "")]);

    const { receipt } = await payer.fetchWithReceipt(URL_UNDER_TEST);
    expect(receipt?.digest).toBe("");
    expect(receipt?.settle).toEqual(failed);
  });

  it("treats an oversized 402 body as no terms", async () => {
    const huge = new Response(`{"pad":"${"x".repeat(300_000)}"}`, { status: 402 });
    const { payer, clientCalls } = setup([huge]);

    expect(await payer.fetch(URL_UNDER_TEST)).toBe(huge);
    expect(clientCalls).toEqual(NO_CALLS);
  });

  it("returns a null receipt on a malformed PAYMENT-RESPONSE, never losing the paid response", async () => {
    const script: Scripted[] = [
      required(terms()),
      new Response("paid", { status: 200, headers: { [HEADER_PAYMENT_RESPONSE]: "!!not base64!!" } }),
    ];
    const { payer } = setup(script);

    const { response, receipt } = await payer.fetchWithReceipt(URL_UNDER_TEST);

    expect(receipt).toBeNull();
    expect(await response.text()).toBe("paid");
  });
});

describe("SuiX402Payer — a second 402 (PRD §8.11, §8.12)", () => {
  const drifted = withRaw(live, { amount: "20000" });

  it("refetches drifted terms once and pays the new amount", async () => {
    const script: Scripted[] = [
      required(terms()),
      required(terms([drifted], "invalid_payment_requirements")),
      new Response("paid", { status: 200 }),
    ];
    const { payer, calls, clientCalls, signed, delays } = setup(script);

    const response = await payer.fetch(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(signed()).toBe(2);
    expect(clientCalls.getObject).toBe(2);
    expect(delays).toEqual([1_500]);
    expect(paymentOf(calls[1]).accepted.amount).toBe("10000");
    const second = paymentOf(calls[2]);
    expect(second.accepted).toEqual(drifted);
    expect(splitAmount(second.payload.transaction)).toBe("20000");
  });

  it("gives up after the second payment is rejected in turn", async () => {
    const script: Scripted[] = [
      required(terms()),
      required(terms([drifted], "invalid_payment_requirements")),
      required(terms([drifted], "invalid_payment_requirements")),
    ];
    const { payer, calls, signed } = setup(script);

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), PaymentRejectedError);

    expect(err.reason).toBe("invalid_payment_requirements");
    expect(err.retryHint).toBe("refetch_terms");
    expect(err.response.status).toBe(402);
    expect(calls).toHaveLength(3);
    expect(signed()).toBe(2);
  });

  it("rebuilds and resigns on invalid_transaction_state", async () => {
    const script: Scripted[] = [
      required(terms()),
      required(terms(undefined, "invalid_transaction_state")),
      new Response("paid", { status: 200 }),
    ];
    const { payer, calls, clientCalls, signed } = setup(script);

    const response = await payer.fetch(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(signed()).toBe(2);
    expect(clientCalls.getObject).toBe(2);
    const [first, second] = [paymentOf(calls[1]), paymentOf(calls[2])];
    expect(second.payload.transaction).not.toBe(first.payload.transaction);
    expect(second.accepted).toEqual(first.accepted);
  });

  it("rebuilds before sending when the local window closed during the build (§8.12)", async () => {
    const clock = [NOW, NOW + 61_000];
    const { payer, calls, clientCalls, signed } = setup([required(terms()), new Response("paid", { status: 200 })], {
      now: () => clock.shift() ?? NOW + 61_000,
    });

    const response = await payer.fetch(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(signed()).toBe(1);
    expect(clientCalls.simulateTransaction).toBe(2);
  });

  it("never pays again on a facilitator-side reason, however late the answer arrives", async () => {
    let clock = NOW;
    const late = () => {
      clock = NOW + 61_000;
      return required(terms(undefined, "unexpected_settle_error"));
    };
    const { payer, calls, signed, delays } = setup([required(terms()), late, late, late], { now: () => clock });

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), PaymentRejectedError);

    expect(err.reason).toBe("unexpected_settle_error");
    expect(err.retryHint).toBe("facilitator");
    expect(signed()).toBe(1);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.slice(1).map(signatureHeader)).size).toBe(1);
    expect(delays).toEqual([1_000, 3_000]);
  });

  it("refuses to rebuild when the rejected payment is already on chain", async () => {
    const script: Scripted[] = [required(terms()), required(terms(undefined, "invalid_transaction_state"))];
    const { payer, calls, clientCalls, signed } = setup(script, { onChain: "present" });

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), PaymentRejectedError);

    expect(err.message).toContain("may have executed");
    expect(err.retryHint).toBe("none");
    expect(clientCalls.getObject).toBe(1);
    expect(calls).toHaveLength(2);
    expect(signed()).toBe(1);
  });

  it("refuses to refetch terms when the first payment's gas coin has moved", async () => {
    const script: Scripted[] = [required(terms()), required(terms([drifted], "invalid_payment_requirements"))];
    const { payer, signed, calls } = setup(script, { onChain: "present" });

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), PaymentRejectedError);

    expect(err.reason).toBe("invalid_payment_requirements");
    expect(err.message).toContain("may have executed");
    expect(signed()).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("hands back a second 402 whose PAYMENT-REQUIRED header is unreadable, instead of throwing", async () => {
    const broken = new Response(null, { status: 402, headers: { [HEADER_PAYMENT_REQUIRED]: "!!!not base64!!!" } });
    const { payer, signed } = setup([required(terms()), broken]);

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), PaymentRejectedError);

    expect(err.response).toBe(broken);
    expect(err.reason).toBe("");
    expect(signed()).toBe(1);
  });

  it("refuses to rebuild when the chain lookup fails", async () => {
    const script: Scripted[] = [required(terms()), required(terms(undefined, "invalid_transaction_state"))];
    const { payer, signed } = setup(script, { onChain: "error" });

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), PaymentRejectedError);

    expect(err.message).toContain("could not confirm");
    expect(err.retryHint).toBe("rebuild_tx");
    expect(signed()).toBe(1);
  });

  it("throws on a terminal reason code, leaving the seller's response readable", async () => {
    const rejection = required(terms(undefined, "insufficient_funds"));
    const { payer, calls, signed } = setup([required(terms()), rejection]);

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), PaymentRejectedError);

    expect(err.reason).toBe("insufficient_funds");
    expect(err.retryHint).toBe("none");
    expect(err.response).toBe(rejection);
    expect(PaymentRequired.parse(await err.response.json()).error).toBe("insufficient_funds");
    expect(calls).toHaveLength(2);
    expect(signed()).toBe(1);
  });

  it("throws when the second 402 carries no reason code at all", async () => {
    const { payer, calls } = setup([required(terms()), new Response(null, { status: 402 })]);

    const err = await rejectsWith(payer.fetch(URL_UNDER_TEST), PaymentRejectedError);

    expect(err.reason).toBe("");
    expect(err.message).toContain("402 carried no reason code");
    expect(calls).toHaveLength(2);
  });

  it("resends the identical payload after a 503, honouring Retry-After (PRD §8.7, §8.9)", async () => {
    const boom = new Response("facilitator down", { status: 503, headers: { "retry-after": "5" } });
    const { payer, calls, signed, delays } = setup([required(terms()), boom, new Response("paid", { status: 200 })]);

    const response = await payer.fetch(URL_UNDER_TEST);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(signed()).toBe(1);
    expect(signatureHeader(calls[2])).toBe(signatureHeader(calls[1]));
    expect(delays).toEqual([5_000]);
  });

  it("hands back the outage after two resends, without a second payment", async () => {
    const boom = () => new Response("facilitator down", { status: 503, headers: { "retry-after": "999" } });
    const { payer, calls, signed, delays } = setup([required(terms()), boom(), boom(), boom()]);

    const response = await payer.fetch(URL_UNDER_TEST);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("facilitator down");
    expect(calls).toHaveLength(4);
    expect(signed()).toBe(1);
    expect(delays).toEqual([30_000, 30_000]);
  });

  it("returns any other non-402 answer to a paid request untouched", async () => {
    const teapot = new Response("no", { status: 418 });
    const { payer, calls, delays } = setup([required(terms()), teapot]);

    expect(await payer.fetch(URL_UNDER_TEST)).toBe(teapot);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([]);
  });
});
