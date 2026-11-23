/** RS256 keys and JWTs for tests that need a real Access token (auth.test.ts, entry.test.ts). */
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const enc = (obj: unknown) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

export async function rsaKeys(): Promise<{ pair: CryptoKeyPair; jwk: JsonWebKey & { kid: string; alg: string } }> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", alg: "RS256" };
  return { pair, jwk };
}

export async function signJwt(privateKey: CryptoKey, payload: Record<string, unknown>, kid = "k1"): Promise<string> {
  const head = enc({ alg: "RS256", kid, typ: "JWT" });
  const body = enc(payload);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
