import { withX402 } from "@sui-x402/next";
import { seller } from "../../../lib/seller";

// The header codec needs Buffer; the edge runtime has none (PRD §8.14).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withX402(seller)(async () =>
  Response.json({ symbol: "SUI", quote: "1.00", paidAt: new Date().toISOString() }),
);
