/**
 * Signer seam. The payer only needs an address and a function
 * from transaction bytes to a serialized Sui signature; `KeypairSigner` adapts
 * any `@mysten/sui` `Signer` (Ed25519, Secp256k1/r1, MultiSig, ZkLoginSigner).
 * Secret key material never appears in error messages.
 */
import { type Signer, decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { normalizeSuiAddress } from "@mysten/sui/utils";

export interface PayerSigner {
  /** Normalized Sui address whose coins are spent. */
  address(): string;
  /** Sign complete transaction bytes; returns the base64 serialized Sui signature. */
  signTransaction(bytes: Uint8Array): Promise<string>;
}

export class KeypairSigner implements PayerSigner {
  readonly #signer: Signer;

  constructor(signer: Signer) {
    this.#signer = signer;
  }

  address(): string {
    return normalizeSuiAddress(this.#signer.toSuiAddress());
  }

  async signTransaction(bytes: Uint8Array): Promise<string> {
    const { signature } = await this.#signer.signTransaction(bytes);
    return signature;
  }
}

export const ENV_PAYER_SECRET_KEY = "PAYER_SECRET_KEY";

export class SignerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerConfigError";
  }
}

/** Ed25519 signer from a bech32 `suiprivkey…` string. */
export function ed25519Signer(secretKey: string): KeypairSigner {
  let parsed: ReturnType<typeof decodeSuiPrivateKey>;
  try {
    parsed = decodeSuiPrivateKey(secretKey);
  } catch {
    throw new SignerConfigError("secret key is not a bech32 `suiprivkey…` string");
  }
  if (parsed.scheme !== "ED25519") {
    throw new SignerConfigError(`secret key scheme is ${parsed.scheme}, expected ED25519`);
  }
  return new KeypairSigner(Ed25519Keypair.fromSecretKey(parsed.secretKey));
}

/** Ed25519 signer from `env[name]` (default `PAYER_SECRET_KEY`). */
export function ed25519SignerFromEnv(name = ENV_PAYER_SECRET_KEY, env: NodeJS.ProcessEnv = process.env): KeypairSigner {
  const value = env[name];
  if (!value) throw new SignerConfigError(`${name} is not set; export the payer's bech32 suiprivkey`);
  return ed25519Signer(value);
}
