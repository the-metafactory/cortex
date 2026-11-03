export const TEST_KID = "test-kid";

const RSA_PARAMS = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

export interface CfAccessSigningKeys {
  signKey: CryptoKey;
  wrongKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlStr(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

export async function createCfAccessSigningKeys(): Promise<CfAccessSigningKeys> {
  const kp = await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"]);
  const offJwks = await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"]);
  const exported = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return {
    signKey: kp.privateKey,
    wrongKey: offJwks.privateKey,
    jwk: { ...exported, kid: TEST_KID, alg: "RS256" },
  };
}

export async function mintCfAccessJwt(
  key: CryptoKey,
  claims: Record<string, unknown>,
  kid = TEST_KID,
): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = b64urlStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

export function jwksFetch(jwk: JsonWebKey): typeof fetch {
  return ((): Promise<Response> =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ keys: [jwk] }) } as unknown as Response)) as unknown as typeof fetch;
}
