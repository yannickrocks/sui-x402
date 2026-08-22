/**
 * @sui-x402/hono — seller middleware. Makes any Hono route x402-payable.
 *
 * Flow: no PAYMENT-SIGNATURE header → 402 + PAYMENT-REQUIRED (base64 terms).
 * With header → POST facilitator /verify → (strict mode) POST /settle →
 * run handler → attach PAYMENT-RESPONSE (settlement digest).
 *
 * Modes:
 *  - "strict"  (default): settle BEFORE fulfilling. No free content on
 *    settle failure (equivocation-safe).
 *  - "fast": verify → fulfill → settle. Lower latency; accepts the
 *    verify→settle gap risk. Document the tradeoff to sellers.
 */
import type { MiddlewareHandler } from "hono";
import {
  PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse,
  HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_SIGNATURE, HEADER_PAYMENT_RESPONSE,
  encodeHeader, decodeHeader,
} from "@sui-x402/core";

export interface X402Options {
  payTo: string;
  amount: string;              // atomic units (USDC has 6 dp)
  asset: string;               // full struct tag
  network: "sui:mainnet" | "sui:testnet";
  facilitator: string;         // base URL
  mode?: "strict" | "fast";
  maxTimeoutSeconds?: number;
  description?: string;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`facilitator ${url} -> HTTP ${r.status}`);
  return (await r.json()) as T;
}

export function x402(opts: X402Options): MiddlewareHandler {
  const mode = opts.mode ?? "strict";
  const requirements = PaymentRequirements.parse({
    scheme: "exact",
    network: opts.network,
    amount: opts.amount,
    asset: opts.asset,
    payTo: opts.payTo,
    maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
    extra: {},
  });

  return async (c, next) => {
    const sig = c.req.header(HEADER_PAYMENT_SIGNATURE);
    if (!sig) {
      c.header(HEADER_PAYMENT_REQUIRED, encodeHeader({
        x402Version: 2,
        accepts: [requirements],
        resource: { url: c.req.url, description: opts.description },
      }));
      return c.json({ error: "payment required" }, 402);
    }

    let payload: PaymentPayload;
    try {
      payload = decodeHeader(sig, PaymentPayload);
    } catch {
      return c.json({ error: "malformed PAYMENT-SIGNATURE" }, 400);
    }

    const body = { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements };

    const v = await post<VerifyResponse>(`${opts.facilitator}/verify`, body);
    if (!v.isValid) return c.json({ error: "invalid payment", reason: v.invalidReason }, 402);

    if (mode === "strict") {
      const s = await post<SettleResponse>(`${opts.facilitator}/settle`, body);
      if (!s.success) return c.json({ error: "settlement failed", reason: s.errorReason }, 402);
      c.header(HEADER_PAYMENT_RESPONSE, encodeHeader(s));
      await next();
      return;
    }

    // fast mode: fulfill first, settle after response is produced
    await next();
    const s = await post<SettleResponse>(`${opts.facilitator}/settle`, body).catch((e) => {
      console.error("post-fulfill settle failed:", e);
      return null;
    });
    if (s) c.header(HEADER_PAYMENT_RESPONSE, encodeHeader(s));
  };
}
