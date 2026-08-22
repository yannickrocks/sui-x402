#!/usr/bin/env node
// Local smoke test for the vendored facilitator: boot upstream on a free port,
// wait for /health, fetch /supported, assert sui:testnet is advertised.
// `--save` writes the /supported body to packages/core/fixtures/.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const upstream = resolve(here, "upstream");
const fixture = resolve(here, "../../packages/core/fixtures/facilitator-supported.local.json");
const save = process.argv.includes("--save");

const port = await new Promise((ok, fail) => {
  const s = createServer();
  s.on("error", fail);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
});
const base = `http://127.0.0.1:${port}`;

const child = spawn(resolve(upstream, "node_modules/.bin/tsx"), ["src/index.ts"], {
  cwd: upstream,
  env: { ...process.env, PORT: String(port), ENABLE_MAINNET: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", (d) => (logs += d));
child.stderr.on("data", (d) => (logs += d));

const deadline = Date.now() + 20_000;
async function waitHealthy() {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`facilitator exited early (code ${child.exitCode})\n${logs}`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no /health within 20s\n${logs}`);
}

try {
  const health = await waitHealthy();
  const r = await fetch(`${base}/supported`);
  if (!r.ok) throw new Error(`/supported HTTP ${r.status}`);
  const supported = await r.json();
  const testnet = supported.kinds?.find((k) => k.network === "sui:testnet" && k.scheme === "exact" && k.x402Version === 2);
  if (!testnet) throw new Error(`/supported lacks sui:testnet exact kind: ${JSON.stringify(supported)}`);
  if (supported.kinds.some((k) => k.network === "sui:mainnet")) throw new Error("mainnet advertised but ENABLE_MAINNET is unset");
  console.log(`ok  /health  ${JSON.stringify(health)}`);
  console.log(`ok  /supported  networks=${supported.kinds.map((k) => k.network).join(",")} usdc=${testnet.extra?.usdc}`);
  if (save) {
    await mkdir(dirname(fixture), { recursive: true });
    await writeFile(fixture, JSON.stringify(supported, null, 2) + "\n");
    console.log(`saved ${fixture}`);
  }
} catch (e) {
  console.error(`FAIL ${e.message}`);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
