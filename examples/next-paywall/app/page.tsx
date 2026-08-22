import { encodeHeader } from "@sui-x402/core";
import { seller, sellerOptions } from "../lib/seller";

export const dynamic = "force-dynamic";

export default function Page() {
  const { requirements } = seller;
  const terms = { x402Version: 2, accepts: [requirements], resource: { url: "/api/quote" } };
  return (
    <main>
      <h1>Paid API on Sui</h1>
      <p>
        <code>GET /api/quote</code> costs {requirements.amount} atomic units of{" "}
        <code>{requirements.asset.split("::").pop()}</code> on <code>{requirements.network}</code>, paid to{" "}
        <code>{requirements.payTo}</code> and settled through <code>{sellerOptions.facilitator}</code>.
      </p>
      <h2>Try it</h2>
      <pre>{`curl -i http://localhost:3000/api/quote`}</pre>
      <p>The response is a 402 whose PAYMENT-REQUIRED header decodes to:</p>
      <pre>{JSON.stringify(terms, null, 2)}</pre>
      <p>(base64: <code style={{ wordBreak: "break-all" }}>{encodeHeader(terms)}</code>)</p>
      <h2>Pay it from an agent</h2>
      <pre>{`import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SuiX402Payer, ed25519SignerFromEnv } from "@sui-x402/payer-sui";

const client = new SuiGrpcClient({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" });
const payer = new SuiX402Payer({ client, signer: ed25519SignerFromEnv() }); // PAYER_SECRET_KEY
const { response, receipt } = await payer.fetchWithReceipt("http://localhost:3000/api/quote");
console.log(await response.json(), receipt?.digest);`}</pre>
    </main>
  );
}
