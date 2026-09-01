#!/usr/bin/env node
// Verify every endpoint in a SUI_MAINNET_RPC / SUI_TESTNET_RPC list really
// answers gRPC-Web and is on the chain you expect.
//
// Why this exists: the facilitator only logs "rpc endpoint N failed ... trying
// next" when it falls over, so a broken or wrong-chain SECOND endpoint stays
// invisible until the primary dies. It also cannot send auth headers, so a
// header-authenticated provider silently fails the same way. Run this against
// each base URL before the service takes traffic.
//
// Zero dependencies: speaks gRPC-Web directly over fetch.
//
//   node verify-rpc-endpoints.mjs mainnet "https://a,https://b"
//   node verify-rpc-endpoints.mjs testnet "$SUI_TESTNET_RPC"

// Genesis checkpoint digests, used here ONLY as an operator-side assertion that
// an endpoint is on the chain you think it is. This is not a payment trust
// anchor: the payer's is `CHAIN_IDENTIFIERS` in packages/payer-sui/src/tx.ts,
// which per decision D15 deliberately carries no repo-wide mainnet pin. Pass a
// third argument to supply your own value instead of trusting these.
//   testnet — same value as packages/payer-sui/src/tx.ts (observed live).
//   mainnet — two-source verified 2026-09-01 (issue #5): Mysten's fullnode and
//             an independent node agreed byte-for-byte; see docs/status.md.
const CHAIN_IDS = {
  mainnet: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  testnet: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD",
};

const [network, list, expectedOverride] = process.argv.slice(2);
if (!network || !CHAIN_IDS[network] || !list) {
  console.error(
    'usage: node verify-rpc-endpoints.mjs <mainnet|testnet> "<comma-separated base urls>" [expected-chain-id]'
  );
  process.exit(2);
}
const expected = expectedOverride || CHAIN_IDS[network];
const urls = list
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (urls.length === 0) {
  console.error(
    "no endpoints given — an empty list means the facilitator has NO rpc urls"
  );
  process.exit(1);
}

// gRPC-Web request frame: 1 flag byte + 4-byte big-endian length + message.
// GetServiceInfo takes an empty message, so the body is five zero bytes.
const EMPTY_FRAME = new Uint8Array([0, 0, 0, 0, 0]);

// grpc-message is percent-encoded, but a server may send a bare '%'. Decoding
// must not throw, or a real "returned status N" result gets mislabelled.
const decodeMaybe = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

async function check(baseUrl) {
  const url = `${baseUrl.replace(
    /\/$/,
    ""
  )}/sui.rpc.v2.LedgerService/GetServiceInfo`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/grpc-web+proto",
      "x-grpc-web": "1",
    },
    body: EMPTY_FRAME,
  });

  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.startsWith("application/grpc-web")) {
    return {
      ok: false,
      reason: `not gRPC-Web (HTTP ${res.status}, content-type ${
        ctype || "none"
      })`,
    };
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  // grpc-status arrives either as a header or inside the trailer frame.
  const status =
    res.headers.get("grpc-status") ??
    text.match(/grpc-status:\s*(\d+)/)?.[1] ??
    null;
  if (status !== null && status !== "0") {
    const msg = decodeMaybe(
      res.headers.get("grpc-message") ??
        text.match(/grpc-message:\s*([^\r\n]+)/)?.[1] ??
        ""
    );
    return {
      ok: false,
      reason: `gRPC-Web reachable but returned status ${status}${
        msg ? ` (${msg})` : ""
      }`,
    };
  }

  // The chain identifier is a base58 string carried verbatim in the response.
  if (!text.includes(expected)) {
    const seen = Object.entries(CHAIN_IDS).find(([, id]) => text.includes(id));
    return {
      ok: false,
      reason: seen
        ? `WRONG CHAIN — endpoint is ${seen[0]} (${seen[1]}), expected ${expected}`
        : `expected chain id ${expected} not found in response`,
    };
  }
  return { ok: true, reason: `gRPC-Web OK, chain id matches ${expected}` };
}

let failed = 0;
for (const [i, baseUrl] of urls.entries()) {
  const role = i === 0 ? "primary" : `failover ${i}`;
  let out;
  try {
    out = await check(baseUrl);
  } catch (e) {
    out = { ok: false, reason: `unreachable: ${String(e?.message ?? e)}` };
  }
  if (!out.ok) failed++;
  console.log(
    `${out.ok ? "PASS" : "FAIL"}  [${role}] ${baseUrl}\n      ${out.reason}`
  );
}

if (urls.length === 1) {
  console.log("\nNOTE: only one endpoint configured — there is no failover.");
}
console.log(`\n${urls.length - failed}/${urls.length} endpoint(s) usable.`);
process.exit(failed === 0 ? 0 : 1);
