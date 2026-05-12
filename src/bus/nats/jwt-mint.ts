/**
 * Prereq A for cortex#67: thin wrapper around `@nats-io/jwt` that mints a
 * per-agent NATS user JWT + nkey seed scoped to a capability list.
 *
 * Motivation (from docs/design-arc-agent-bots.md §6.3): the cortex
 * creds-daemon (cortex#67) must issue NATS users to standalone agent bots
 * (Codex, Claude Code, pi.dev, custom) on demand. Each user's publish/
 * subscribe permissions are scoped to the agent's declared capabilities so
 * a code-review bot can't, for example, publish on a research bot's
 * subjects. The scoping rule is: each capability `cap` → pub+sub on
 * `local.{org}.{cap}.>`, plus baseline perms for capability self-register
 * and the creds-handler back-channel.
 *
 * Boundary: this module is a pure function over inputs. It does NOT touch
 * the filesystem, NATS server, or any I/O. The caller (creds-daemon) is
 * responsible for persisting the returned creds and for choosing /
 * rotating the account signing key.
 *
 * Note on the package: `@nats-io/jwt@^0.0.11` re-exports `createUser`,
 * `encodeUser`, `decode`, and `fmtCreds` from `@nats-io/nkeys`. We use
 * those primitives directly — no custom ed25519/JWT encoding here.
 */

import {
  Algorithms,
  createUser,
  encodeUser,
  fmtCreds,
  type KeyPair,
  type User,
} from "@nats-io/jwt";

export interface MintUserOpts {
  /**
   * Account (or account-signing) nkey used to sign the user JWT. The
   * caller owns lifecycle — this module never reads it from disk.
   */
  accountSigningKey: KeyPair;

  /**
   * Stable identifier for the agent. Used as the JWT `name`, as the
   * subject suffix for the capability self-register channel, and for the
   * creds-handler reply subject. Validated to avoid producing JWTs with
   * subjects that would collide with NATS wildcards.
   */
  agentId: string;

  /**
   * NATS subject-prefix capabilities scope. Each entry grants pub+sub on
   * `local.{org}.{capability}.>`. Empty array is allowed — the agent
   * still gets baseline perms (capability self-register + creds-handler
   * back-channel) so it can come online and request a re-mint, but it
   * can't publish or subscribe to any capability channel.
   */
  capabilities: string[];

  /**
   * Org slug for subject namespacing (`local.{org}.…`). Validated for the
   * same reasons as `agentId`.
   */
  org: string;
}

export interface MintedUserCreds {
  /** Signed user JWT (header.payload.sig, base64url). */
  userJwt: string;

  /** User nkey seed (starts with `SU…`). Sensitive — treat as secret. */
  userSeed: string;

  /**
   * Combined `.creds`-formatted block as emitted by `@nats-io/jwt`'s
   * `fmtCreds`. Drop directly into `~/.config/nats/creds/{agentId}.creds`.
   */
  credsFile: string;
}

/**
 * Disallowed characters in `agentId` / `org`: anything NATS uses as a
 * subject separator/wildcard. Keeping this conservative — letters,
 * digits, dash, underscore. Bots with quirky IDs should slugify upstream.
 */
const SUBJECT_TOKEN = /^[A-Za-z0-9_-]+$/;

/** Same rule for capability names; they end up as subject tokens too. */
const CAPABILITY_TOKEN = /^[A-Za-z0-9_-]+$/;

function assertSubjectToken(label: string, value: string): void {
  if (!value) {
    throw new Error(`nats-jwt-mint: ${label} is required`);
  }
  if (!SUBJECT_TOKEN.test(value)) {
    throw new Error(
      `nats-jwt-mint: ${label} "${value}" contains characters disallowed in NATS subjects ` +
        `(allowed: letters, digits, "-", "_")`,
    );
  }
}

function assertCapabilityToken(value: string): void {
  if (!value) {
    throw new Error("nats-jwt-mint: capability entries must be non-empty");
  }
  if (!CAPABILITY_TOKEN.test(value)) {
    throw new Error(
      `nats-jwt-mint: capability "${value}" contains characters disallowed in NATS subjects ` +
        `(allowed: letters, digits, "-", "_")`,
    );
  }
}

/**
 * Build the per-capability subject set. Exposed so tests can assert the
 * exact permissions shape without re-decoding the JWT, and so a future
 * caller (e.g. dashboard preview) can see what *would* be granted before
 * actually minting.
 */
export function buildUserPermissions(opts: {
  agentId: string;
  capabilities: string[];
  org: string;
}): Pick<User, "pub" | "sub"> {
  const { agentId, capabilities, org } = opts;

  const pub: string[] = [];
  const sub: string[] = [];

  for (const cap of capabilities) {
    const subjectPrefix = `local.${org}.${cap}.>`;
    pub.push(subjectPrefix);
    sub.push(subjectPrefix);
  }

  // Baseline: capability self-register. The bot publishes its capability
  // list to `local.{org}.agents.capabilities.{agentId}` on start so cortex
  // can populate the agent registry without a config file.
  pub.push(`local.${org}.agents.capabilities.${agentId}`);

  // Baseline: creds-handler back-channel. The bot needs to talk back to
  // cortex's creds daemon (e.g. to request a re-mint when its JWT expires
  // or its capability list changes). Pub-only — replies come via inbox.
  pub.push(`local.${org}.cortex.creds.>`);

  return {
    pub: { allow: pub },
    sub: { allow: sub },
  };
}

/**
 * Mint a per-agent NATS user JWT scoped to the given capabilities.
 *
 * Idempotency: NOT idempotent — every call generates a fresh user nkey.
 * That's deliberate: re-minting with the same agentId + capabilities
 * should produce a new user identity so revocation is straightforward
 * (drop the old user via the account JWT's revocation list).
 */
export async function mintUserCreds(
  opts: MintUserOpts,
): Promise<MintedUserCreds> {
  assertSubjectToken("agentId", opts.agentId);
  assertSubjectToken("org", opts.org);
  for (const cap of opts.capabilities) {
    assertCapabilityToken(cap);
  }

  const userKeyPair = createUser();

  const claims: Partial<User> = buildUserPermissions({
    agentId: opts.agentId,
    capabilities: opts.capabilities,
    org: opts.org,
  });

  const userJwt = await encodeUser(
    opts.agentId,
    userKeyPair,
    opts.accountSigningKey,
    claims,
    { algorithm: Algorithms.v2 },
  );

  const userSeed = new TextDecoder().decode(userKeyPair.getSeed());
  const credsFile = new TextDecoder().decode(fmtCreds(userJwt, userKeyPair));

  return { userJwt, userSeed, credsFile };
}
