/**
 * GitHub App installation-token minting (cortex#2396, vision#11).
 *
 * cortex is the sole runtime hosting the `atlas` and `luna-dev` bot
 * identities (both are cortex agent bundles per `docs/design-arc-agent-bots.md`),
 * so the minting capability lives here rather than in a separate ecosystem
 * repo. Mirrors the shape of `cortex creds issue/revoke/rotate` (per-identity
 * credential lifecycle) but for GitHub instead of NATS — same precedent,
 * different wire.
 *
 * Flow: App ID + PKCS#1 RSA private key (`.pem`, chmod 600) + installation ID
 * → sign a short-lived (10min) JWT (RS256) → exchange it for a ~1hr
 * installation access token via the GitHub Apps REST API. The installation
 * token is what a caller sets as `GH_TOKEN` for `gh`/`git` to act as the bot
 * identity instead of the principal's own account.
 *
 * Uses `node:crypto` (not WebCrypto) deliberately — unlike
 * `common/auth/cf-access-jwt.ts`, this module has no CF Worker portability
 * requirement (it only ever runs in the Bun daemon / CLI), and `node:crypto`
 * signs PKCS#1 PEM directly without a PKCS#1→PKCS#8 DER conversion step.
 */

import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";
import { expandTilde } from "../config/loader";
import { enforceChmod600 } from "../config/file-permissions";

// =============================================================================
// Errors
// =============================================================================

export class GithubAppTokenError extends Error {
  /** Structured context (identity name, path, HTTP status, etc.) for logging. */
  public readonly context?: Record<string, string>;

  constructor(message: string, context?: Record<string, string | number>) {
    super(message);
    this.name = "GithubAppTokenError";
    this.context = context
      ? Object.fromEntries(Object.entries(context).map(([k, v]) => [k, String(v)]))
      : undefined;
  }
}

// =============================================================================
// JWT signing (App-level auth)
// =============================================================================

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Sign a GitHub App JWT (RS256). `iat` is backdated 60s to tolerate clock
 * skew between this host and GitHub's, per GitHub's own documented
 * recommendation; `exp` is capped at 10 minutes — GitHub rejects longer.
 *
 * @param nowSeconds Clock override (seconds since epoch) for deterministic tests.
 */
export function signAppJwt(appId: string, privateKeyPem: string, nowSeconds?: number): string {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 600, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem);

  return `${signingInput}.${base64url(signature)}`;
}

// =============================================================================
// Installation-token exchange
// =============================================================================

export interface MintInstallationTokenOptions {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  /** `fetch` override for tests (defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Clock override (seconds since epoch) for deterministic tests. */
  nowSeconds?: number;
}

export interface InstallationToken {
  token: string;
  /** ISO-8601 timestamp — GitHub caps installation tokens at ~1hr. */
  expiresAt: string;
}

/**
 * Exchange a freshly-signed App JWT for a short-lived installation access
 * token. Fail-closed: any non-2xx response or a malformed body throws
 * `GithubAppTokenError` rather than returning a partial/empty token.
 */
export async function mintInstallationToken(
  opts: MintInstallationTokenOptions,
): Promise<InstallationToken> {
  const jwt = signAppJwt(opts.appId, opts.privateKeyPem, opts.nowSeconds);
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(
    `https://api.github.com/app/installations/${opts.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GithubAppTokenError(
      `installation token exchange failed: ${res.status} ${res.statusText}`,
      { status: res.status, body: body.slice(0, 500) },
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new GithubAppTokenError("installation token response was not valid JSON");
  }

  const parsed = z
    .object({ token: z.string().min(1), expires_at: z.string().min(1) })
    .safeParse(data);
  if (!parsed.success) {
    throw new GithubAppTokenError("installation token response missing token/expires_at");
  }

  return { token: parsed.data.token, expiresAt: parsed.data.expires_at };
}

// =============================================================================
// Identity config — ~/.config/metafactory/github-apps/apps.yaml
// =============================================================================

// GitHub App IDs and installation IDs are always numeric on the wire — both
// get interpolated straight into the JWT `iss` claim and the installation-
// token URL path. Constraining the format here catches a config typo/paste
// error at load time instead of surfacing it as a confusing GitHub 404/401,
// and keeps the interpolation points working only with values that can
// never contain path or claim-breaking characters.
const NUMERIC_ID_REGEX = /^\d+$/;

const GithubAppIdentitySchema = z.object({
  appId: z.string().regex(NUMERIC_ID_REGEX, "appId must be numeric (GitHub App ID)"),
  installationId: z
    .string()
    .regex(NUMERIC_ID_REGEX, "installationId must be numeric (GitHub installation ID)"),
  /** Path to the PKCS#1 private key (`.pem`). Tilde-expanded, must be chmod 600. */
  keyPath: z.string().min(1),
});

export type GithubAppIdentityConfig = z.infer<typeof GithubAppIdentitySchema>;

const GithubAppIdentitiesFileSchema = z.record(z.string().min(1), GithubAppIdentitySchema);

export const DEFAULT_GITHUB_APP_IDENTITIES_PATH = "~/.config/metafactory/github-apps/apps.yaml";

/**
 * Load the full identity map. Deliberately NOT baked into cortex's main
 * `AgentSchema`/`agents.d/` fragment system yet (cortex#2396 scopes this to
 * the minting capability only) — a flat, principal-owned YAML file outside
 * any committed path, consistent with compass-core's leak policy: App IDs /
 * installation IDs / key paths are config-driven, never hardcoded.
 */
export function loadGithubAppIdentities(
  configPath: string = DEFAULT_GITHUB_APP_IDENTITIES_PATH,
): Record<string, GithubAppIdentityConfig> {
  const path = expandTilde(configPath);
  if (!existsSync(path)) {
    throw new GithubAppTokenError(`no GitHub App identities configured — expected ${path}`, {
      path,
    });
  }
  const raw: unknown = parseYaml(readFileSync(path, "utf8"));
  const parsed = GithubAppIdentitiesFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new GithubAppTokenError(`malformed GitHub App identities file at ${path}`, {
      path,
      issues: parsed.error.issues.map((i) => i.message).join("; "),
    });
  }
  return parsed.data;
}

export function loadGithubAppIdentity(
  name: string,
  configPath: string = DEFAULT_GITHUB_APP_IDENTITIES_PATH,
): GithubAppIdentityConfig {
  const identities = loadGithubAppIdentities(configPath);
  const identity = identities[name];
  if (!identity) {
    const known = Object.keys(identities).join(", ") || "(none)";
    throw new GithubAppTokenError(`unknown GitHub App identity "${name}" — configured: ${known}`, {
      name,
    });
  }
  return identity;
}

// =============================================================================
// End-to-end convenience: identity name → installation token
// =============================================================================

export interface MintTokenForIdentityOptions {
  configPath?: string;
  fetchImpl?: typeof fetch;
  nowSeconds?: number;
}

/**
 * Load an identity by name, read + permission-check its private key, and
 * mint an installation token in one call. This is the entry point runner
 * wiring (cortex#2396's tracked follow-up) and the CLI both use.
 */
export async function mintTokenForIdentity(
  name: string,
  opts: MintTokenForIdentityOptions = {},
): Promise<InstallationToken> {
  const identity = loadGithubAppIdentity(name, opts.configPath);
  const keyPath = expandTilde(identity.keyPath);
  enforceChmod600(keyPath); // throws if the key isn't owner-only readable
  const privateKeyPem = readFileSync(keyPath, "utf8");

  return mintInstallationToken({
    appId: identity.appId,
    installationId: identity.installationId,
    privateKeyPem,
    fetchImpl: opts.fetchImpl,
    nowSeconds: opts.nowSeconds,
  });
}
