// Read a coin's on-chain metadata from one or more Sui nodes, for the
// "mainnet asset confirmed" box in docs/facilitator-runbook.md (checklist
// item 3): the coin type must exist, report `decimals` 6, and agree across
// two independent nodes before it is trusted for real-money settlement.
// Prints each node's chain identifier alongside, so a wrong-network answer is
// obvious. Read-only.
//
//   node coin-metadata.mjs <coinType> <baseUrl> [baseUrl...]
//
// Endpoints must speak gRPC-Web (see D16) — a native-gRPC-only node errors
// here with an "invalid gRPC request content-type" message rather than a
// metadata mismatch. To check endpoint reachability and chain identity alone,
// use deploy/verify-rpc-endpoints.mjs instead.
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeStructTag } from "@mysten/sui/utils";

const [coinType, ...endpoints] = process.argv.slice(2);
if (!coinType || endpoints.length === 0) {
  console.error(
    "usage: node coin-metadata.mjs <coinType> <baseUrl> [baseUrl...]"
  );
  process.exit(2);
}

for (const baseUrl of endpoints) {
  const c = new SuiGrpcClient({ network: "mainnet", baseUrl });
  try {
    const chainId = await c.getChainIdentifier();
    const { coinMetadata } = await c.getCoinMetadata({ coinType });
    console.log(JSON.stringify({ baseUrl, chainId, coinMetadata }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ baseUrl, error: String(e.message ?? e) }));
  }
}
console.log("normalized:", normalizeStructTag(coinType));
