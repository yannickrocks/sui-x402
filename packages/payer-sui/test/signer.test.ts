import { describe, expect, it } from "vitest";
import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import {
  ENV_PAYER_SECRET_KEY,
  KeypairSigner,
  SignerConfigError,
  ed25519Signer,
  ed25519SignerFromEnv,
} from "../src/signer.js";

const bytes = new Uint8Array([0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

describe("KeypairSigner", () => {
  it("signs transaction bytes with an ed25519 keypair the public key verifies", async () => {
    const kp = Ed25519Keypair.generate();
    const signer = new KeypairSigner(kp);
    const sig = await signer.signTransaction(bytes);

    expect(signer.address()).toBe(kp.toSuiAddress());
    expect(parseSerializedSignature(sig).signatureScheme).toBe("ED25519");
    await expect(kp.getPublicKey().verifyTransaction(bytes, sig)).resolves.toBe(true);
    await expect(kp.getPublicKey().verifyTransaction(new Uint8Array([...bytes, 1]), sig)).resolves.toBe(false);
  });

  it("adapts any other Sui signer scheme through the same seam", async () => {
    const kp = Secp256k1Keypair.generate();
    const signer = new KeypairSigner(kp);
    const sig = await signer.signTransaction(bytes);
    expect(parseSerializedSignature(sig).signatureScheme).toBe("Secp256k1");
    await expect(kp.getPublicKey().verifyTransaction(bytes, sig)).resolves.toBe(true);
  });
});

describe("ed25519Signer", () => {
  it("round-trips a bech32 suiprivkey to the same address", () => {
    const kp = Ed25519Keypair.generate();
    expect(ed25519Signer(kp.getSecretKey()).address()).toBe(kp.toSuiAddress());
  });

  it("rejects a non-ed25519 key by scheme without leaking it", () => {
    const secret = Secp256k1Keypair.generate().getSecretKey();
    let err: unknown;
    try {
      ed25519Signer(secret);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SignerConfigError);
    if (!(err instanceof Error)) throw err;
    expect(err.message).toContain("Secp256k1");
    expect(err.message).not.toContain(secret);
  });

  it("rejects garbage without echoing it", () => {
    const garbage = "suiprivkey1notarealkeyzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    let err: unknown;
    try {
      ed25519Signer(garbage);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SignerConfigError);
    if (!(err instanceof Error)) throw err;
    expect(err.message).not.toContain(garbage);
    expect(err.message).not.toContain("notarealkey");
  });
});

describe("ed25519SignerFromEnv", () => {
  it("reads the default variable from the given env", () => {
    const kp = Ed25519Keypair.generate();
    const signer = ed25519SignerFromEnv(undefined, { [ENV_PAYER_SECRET_KEY]: kp.getSecretKey() });
    expect(signer.address()).toBe(kp.toSuiAddress());
  });

  it("names the missing variable", () => {
    expect(() => ed25519SignerFromEnv("CUSTOM_KEY", {})).toThrow(/CUSTOM_KEY is not set/);
    expect(() => ed25519SignerFromEnv(ENV_PAYER_SECRET_KEY, { [ENV_PAYER_SECRET_KEY]: "" })).toThrow(SignerConfigError);
  });
});
