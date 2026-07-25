/**
 * cortex#2396 — GitHub App installation-token minting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  GithubAppTokenError,
  loadGithubAppIdentities,
  loadGithubAppIdentity,
  mintInstallationToken,
  mintTokenForIdentity,
  signAppJwt,
} from "../github-app-token";

function decodeBase64url(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    input.length + ((4 - (input.length % 4)) % 4),
    "=",
  );
  return Buffer.from(padded, "base64").toString("utf8");
}

// PKCS#1 ("RSA PRIVATE KEY") — the format GitHub actually ships, so the
// fixture exercises the real code path rather than a PKCS#8 stand-in.
const { privateKey: TEST_PRIVATE_KEY_PEM, publicKey: TEST_PUBLIC_KEY_PEM } = generateKeyPairSync(
  "rsa",
  {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  },
);

describe("signAppJwt", () => {
  test("produces a header.payload.signature JWT with iss=appId", () => {
    const jwt = signAppJwt("4391087", TEST_PRIVATE_KEY_PEM, 1_800_000_000);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(decodeBase64url(parts[0] ?? ""));
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = JSON.parse(decodeBase64url(parts[1] ?? ""));
    expect(payload.iss).toBe("4391087");
    expect(payload.iat).toBe(1_800_000_000 - 60);
    expect(payload.exp).toBe(1_800_000_000 + 600);
  });

  test("signature verifies against the matching public key", () => {
    const jwt = signAppJwt("4391087", TEST_PRIVATE_KEY_PEM, 1_800_000_000);
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = Buffer.from(
      (sigB64 ?? "").replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    );

    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();
    expect(verifier.verify(TEST_PUBLIC_KEY_PEM, signature)).toBe(true);
  });

  test("a tampered payload fails verification", () => {
    const jwt = signAppJwt("4391087", TEST_PRIVATE_KEY_PEM, 1_800_000_000);
    const [headerB64, , sigB64] = jwt.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ iss: "9999999", iat: 0, exp: 999999999999 }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const signingInput = `${headerB64}.${tamperedPayload}`;
    const signature = Buffer.from((sigB64 ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(signingInput);
    verifier.end();
    expect(verifier.verify(TEST_PUBLIC_KEY_PEM, signature)).toBe(false);
  });
});

describe("mintInstallationToken", () => {
  test("returns the token + expiry on a 2xx response", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.github.com/app/installations/148931136/access_tokens");
      expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
      return new Response(
        JSON.stringify({ token: "ghs_abc123", expires_at: "2026-07-26T01:00:00Z" }),
        { status: 201 },
      );
    }) as typeof fetch;

    const result = await mintInstallationToken({
      appId: "4391087",
      installationId: "148931136",
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
      fetchImpl,
    });

    expect(result).toEqual({ token: "ghs_abc123", expiresAt: "2026-07-26T01:00:00Z" });
  });

  test("throws GithubAppTokenError on a non-2xx response", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
      })) as unknown as typeof fetch;

    await expect(
      mintInstallationToken({
        appId: "4391087",
        installationId: "148931136",
        privateKeyPem: TEST_PRIVATE_KEY_PEM,
        fetchImpl,
      }),
    ).rejects.toThrow(GithubAppTokenError);
  });

  test("throws GithubAppTokenError when the response body is missing token/expires_at", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 201 })) as unknown as typeof fetch;

    await expect(
      mintInstallationToken({
        appId: "4391087",
        installationId: "148931136",
        privateKeyPem: TEST_PRIVATE_KEY_PEM,
        fetchImpl,
      }),
    ).rejects.toThrow(/missing token\/expires_at/);
  });
});

describe("identity config", () => {
  let dir: string;
  let configPath: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "github-app-token-"));
    keyPath = join(dir, "atlas.pem");
    writeFileSync(keyPath, TEST_PRIVATE_KEY_PEM, "utf8");
    chmodSync(keyPath, 0o600);

    configPath = join(dir, "apps.yaml");
    writeFileSync(
      configPath,
      `atlas:\n  appId: "4391087"\n  installationId: "148931136"\n  keyPath: "${keyPath}"\n`,
      "utf8",
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("loadGithubAppIdentities parses a valid file", () => {
    const identities = loadGithubAppIdentities(configPath);
    expect(identities).toEqual({
      atlas: { appId: "4391087", installationId: "148931136", keyPath },
    });
  });

  test("loadGithubAppIdentity returns the named entry", () => {
    expect(loadGithubAppIdentity("atlas", configPath)).toEqual({
      appId: "4391087",
      installationId: "148931136",
      keyPath,
    });
  });

  test("loadGithubAppIdentity throws listing known identities when the name is unknown", () => {
    expect(() => loadGithubAppIdentity("luna-dev", configPath)).toThrow(/unknown.*luna-dev.*atlas/s);
  });

  test("loadGithubAppIdentities throws when the file is missing", () => {
    expect(() => loadGithubAppIdentities(join(dir, "does-not-exist.yaml"))).toThrow(
      GithubAppTokenError,
    );
  });

  test("loadGithubAppIdentities throws on malformed shape (missing installationId)", () => {
    writeFileSync(configPath, `atlas:\n  appId: "4391087"\n  keyPath: "${keyPath}"\n`, "utf8");
    expect(() => loadGithubAppIdentities(configPath)).toThrow(/malformed/);
  });

  test("mintTokenForIdentity refuses a key file that isn't chmod 600", async () => {
    chmodSync(keyPath, 0o644);
    await expect(mintTokenForIdentity("atlas", { configPath })).rejects.toThrow(/chmod 600/);
  });

  test("mintTokenForIdentity mints end-to-end given a valid identity + key", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ token: "ghs_end2end", expires_at: "2026-07-26T01:00:00Z" }),
        { status: 201 },
      )) as unknown as typeof fetch;

    const result = await mintTokenForIdentity("atlas", { configPath, fetchImpl });
    expect(result).toEqual({ token: "ghs_end2end", expiresAt: "2026-07-26T01:00:00Z" });
  });
});
