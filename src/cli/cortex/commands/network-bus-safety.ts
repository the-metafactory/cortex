/**
 * cortex#1728 — three member-bus SAFETY guards for `cortex network join`
 * preflight + `cortex network doctor`, from the first live operator-mode join
 * (jc↔andreas, 2026-07-09). Each is a cheap READ that no gate detected before;
 * each caught ~90 minutes of one-off debugging on andreas's stack. PURE — every
 * function reads text/JSON in and returns a verdict; the live adapters
 * (`network-adapters.ts`) supply the fs/creds bytes, tests inject fixtures.
 *
 * ## Guard 1 — the armed F4 crash bomb (operator-mode `leafnodes.authorization`)
 *
 * The #1491-era `add-member` wrote a hub-side PSK block
 * (`leafnodes { authorization { users … } }`) into the MEMBER's local.conf. On
 * an **operator-mode** server that block is STARTUP-FATAL (`operator mode does
 * not allow specifying users in leafnode config`) — but only at the NEXT
 * restart, and `nats-server -t` PASSES it as valid (the leafnode operator-mode
 * validation doesn't run in `-t`; verified live). A deployment that ever ran
 * pre-#1491 tooling carries a bomb that detonates on its next restart.
 * {@link scanForLeafnodeAuthorizationBomb} scans the RESOLVED config (the config
 * file + every file it `include`s) for the block under an operator-mode config.
 *
 * ## Guard 2 — the plist must actually load the config
 *
 * join's ensure-plist step reported success against a plist whose
 * `ProgramArguments` was a bare `nats-server` with NO `-c` at all (the homebrew
 * default plist). {@link plistLoadsConfig} parses the plist's `ProgramArguments`
 * and confirms the config path is among them.
 *
 * ## Guard 3 — the leaf account must match the daemon's real creds account
 *
 * join derived the leaf's local account from `nats_infra.account` (the config
 * said the FED account); the daemon's real publisher account (decoded from the
 * creds' `issuer_account`) was a THIRD account → leaf up, interest visible,
 * publishes never crossing. {@link decodeCredsIssuerAccount} decodes the NATS
 * user JWT embedded in the `.creds` file; {@link checkLeafAccountMatchesCreds}
 * compares it to the account the join would render.
 */

// =============================================================================
// Shared — strip HOCON/nats config comments (line `//`/`#` + block slash-star).
// Mirrors leaf-remote-renderer.ts's private `stripConfigComments` so a commented
// -out `authorization { users }` never trips Guard 1 (a false positive here is a
// spurious join REFUSAL, not a crash — but still avoidable).
// =============================================================================

function stripConfigComments(natsConfigText: string): string {
  const noBlocks = natsConfigText.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, " "),
  );
  return noBlocks
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("#")) return "";
      return line;
    })
    .join("\n");
}

/**
 * Is `text` an operator-mode nats config? Operator-mode is signalled by an
 * `operator:`/`operator =` key or an NSC `resolver` stanza — the SAME signals the
 * "leafnode authorization is fatal" rule keys on. We deliberately do NOT treat a
 * bare `accounts { … }` block (server-config accounts, NOT NSC operator-mode) as
 * operator-mode: the fatal rule is specifically about OPERATOR mode.
 */
function isOperatorModeConfig(text: string): boolean {
  const stripped = stripConfigComments(text);
  return (
    /^[ \t]*operator[ \t]*[:=]/m.test(stripped) || // NSC operator JWT key
    // `resolver:` / `resolver =` / `resolver { … }` — the NSC JWT resolver.
    /^[ \t]*resolver[ \t]*(?:[:={]|[ \t]+\{)/m.test(stripped) ||
    /^[ \t]*resolver_preload[ \t]*[:={]/m.test(stripped)
  );
}

// =============================================================================
// Config resolution — follow `include` directives so a split config is scanned
// whole. HOCON/nats `include "file"` is relative to the including file's dir.
// =============================================================================

/** A file the resolver can read. `read` returns the file's text, or `undefined`
 *  when the path does not exist / cannot be read. `dirname`/`join` are supplied
 *  so the pure resolver never imports `path`/`fs` directly (testable). */
export interface ConfigFileReader {
  read(path: string): string | undefined;
  dirname(path: string): string;
  join(dir: string, file: string): string;
}

/**
 * The RESOLVED config: the root file's text plus every file it transitively
 * `include`s, each tagged with the path it came from. `include` directives are
 * followed depth-first; a cycle or a missing include is skipped (a missing
 * include is nats-server's own error to raise at boot — we only scan what
 * resolves). The join's OWN per-network leaf fragments (`leafnodes-<net>.conf`)
 * ARE followed too: a stale PSK block can hide in one of them.
 */
export interface ResolvedConfig {
  /** Each resolved file: its path + full text. Root first, then includes. */
  files: { path: string; text: string }[];
}

const INCLUDE_RE = /^[ \t]*include[ \t]+["']([^"']+)["']/gm;

/**
 * Resolve `rootPath` + its transitive `include`s into a flat file list. Pure over
 * {@link ConfigFileReader}. Cycle-safe (a path is read at most once) and
 * missing-include-safe (an unreadable include is skipped, not thrown).
 */
export function resolveConfigIncludes(
  rootPath: string,
  io: ConfigFileReader,
): ResolvedConfig {
  const files: { path: string; text: string }[] = [];
  const seen = new Set<string>();

  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const text = io.read(path);
    if (text === undefined) return; // missing / unreadable — nats-server's error.
    files.push({ path, text });

    const dir = io.dirname(path);
    const stripped = stripConfigComments(text);
    INCLUDE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INCLUDE_RE.exec(stripped)) !== null) {
      const target = m[1];
      if (target === undefined || target.length === 0) continue;
      // Absolute include stays as-is; relative include resolves against the
      // including file's directory (nats-server's own resolution rule).
      const resolved = target.startsWith("/") ? target : io.join(dir, target);
      visit(resolved);
    }
  };

  visit(rootPath);
  return { files };
}

// =============================================================================
// Guard 1 — the armed F4 crash bomb.
// =============================================================================

/** The offending file + a human-readable removal instruction. */
export interface LeafnodeAuthorizationBomb {
  /** The resolved config file that carries the fatal block. */
  path: string;
  /** The exact removal fix, naming the file. */
  fix: string;
}

/**
 * Does `text` carry a `leafnodes { … authorization { … users … } }` block? On an
 * operator-mode server this is startup-fatal. We do NOT need a full HOCON parser:
 * the fatal shape is a `leafnodes` block that CONTAINS both an `authorization`
 * key and a `users` key. A regex over the (comment-stripped) text that finds a
 * `leafnodes` block and looks for `authorization` + `users` inside its braces is
 * sufficient and errs SAFE — a false positive is a recoverable join refusal.
 *
 * Exported for direct unit testing of the block-shape detector in isolation.
 */
export function textHasLeafnodeAuthorizationUsers(text: string): boolean {
  const stripped = stripConfigComments(text);
  // Find a `leafnodes {` opener, then scan its balanced-brace body for both
  // `authorization` and `users`. Multiple leafnodes blocks are each checked.
  const opener = /(^|[^A-Za-z0-9_])leafnodes[ \t]*\{/g;
  while (opener.exec(stripped) !== null) {
    const bodyStart = opener.lastIndex; // just after the `{`
    const body = extractBracedBody(stripped, bodyStart - 1); // include the `{`
    if (body === undefined) continue;
    const hasAuthorization = /(^|[^A-Za-z0-9_])authorization[ \t]*\{/.test(body);
    const hasUsers = /(^|[^A-Za-z0-9_])users[ \t]*[:={[]/.test(body);
    if (hasAuthorization && hasUsers) return true;
  }
  return false;
}

/**
 * Given `text` and the index of an opening `{`, return the substring BETWEEN
 * that brace and its matching close (exclusive), respecting nesting. `undefined`
 * when the brace is unbalanced (truncated config) — the caller then skips it.
 */
function extractBracedBody(text: string, openBraceIdx: number): string | undefined {
  let depth = 0;
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(openBraceIdx + 1, i);
    }
  }
  return undefined; // unbalanced.
}

/**
 * Guard 1 — scan a RESOLVED operator-mode config for the armed F4 crash bomb.
 * Returns the offending file(s), or `undefined` when clean / not operator-mode.
 *
 * The operator-mode gate is evaluated over the CONCATENATION of every resolved
 * file: the `operator:` stanza may live in the root while the fatal
 * `leafnodes.authorization` block lives in an include (or vice versa). We flag
 * ONLY when the config is operator-mode AND some resolved file carries the block
 * — on a NON-operator-mode ($G / server-config) bus the block is legal, so we
 * stay silent (no false alarm on a hard-isolated community bus).
 */
export function scanForLeafnodeAuthorizationBomb(
  resolved: ResolvedConfig,
): LeafnodeAuthorizationBomb[] {
  const combined = resolved.files.map((f) => f.text).join("\n");
  if (!isOperatorModeConfig(combined)) return [];
  const bombs: LeafnodeAuthorizationBomb[] = [];
  for (const file of resolved.files) {
    if (textHasLeafnodeAuthorizationUsers(file.text)) {
      bombs.push({
        path: file.path,
        fix:
          `remove the \`leafnodes { authorization { users … } }\` block from ${file.path} — ` +
          `on an operator-mode bus it is startup-fatal ("operator mode does not allow specifying ` +
          `users in leafnode config"), and \`nats-server -t\` does NOT catch it. This is a stale ` +
          `hub-side PSK block written by pre-#1491 \`add-member\` tooling (cortex#1728/#1491); the ` +
          `leaf authenticates via its own remote block, not this one.`,
      });
    }
  }
  return bombs;
}

// =============================================================================
// Guard 2 — the plist must actually load the config.
// =============================================================================

/** The result of the plist ProgramArguments check. */
export interface PlistConfigCheck {
  /** True iff the target config path is present in `ProgramArguments` (`-c`). */
  loadsConfig: boolean;
  /** The ProgramArguments as parsed (for the failure detail). */
  programArguments: string[];
}

/**
 * Parse a launchd plist's `<key>ProgramArguments</key><array>…</array>` into its
 * string entries. Returns `[]` when the key/array is absent or the plist can't be
 * parsed (a bare-`nats-server` homebrew plist with no ProgramArguments array
 * reads as `[]` — which correctly fails {@link plistLoadsConfig}).
 *
 * We do a light XML extraction rather than a full plist parse: launchd plists are
 * a fixed dialect and the ProgramArguments array is always a flat list of
 * `<string>…</string>`. Exported for direct unit testing.
 */
export function parseProgramArguments(plistXml: string): string[] {
  // Locate the ProgramArguments key, then its following <array>…</array>.
  const keyIdx = plistXml.search(/<key>\s*ProgramArguments\s*<\/key>/);
  if (keyIdx < 0) return [];
  const after = plistXml.slice(keyIdx);
  const arrayMatch = /<array>([\s\S]*?)<\/array>/.exec(after);
  const body = arrayMatch?.[1];
  if (body === undefined) return [];
  const out: string[] = [];
  const strRe = /<string>([\s\S]*?)<\/string>/g;
  let m: RegExpExecArray | null;
  while ((m = strRe.exec(body)) !== null) {
    out.push(decodeXmlEntities((m[1] ?? "").trim()));
  }
  return out;
}

/** Decode the handful of XML entities a plist path can carry. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Guard 2 — does the launchd plist's `ProgramArguments` actually load
 * `configPath`? The homebrew-default nats-server plist runs a bare `nats-server`
 * with no `-c`, so a join that "restarts the bus" against it kicks a service that
 * never reads the edited config. We accept the config as loaded when it appears
 * as a ProgramArguments entry — either as the value AFTER a `-c`/`--config`
 * token, OR as a `-c=<path>` / `--config=<path>` joined form. A bare presence of
 * the path with no config flag does NOT count (it would be a stray argument).
 */
export function plistLoadsConfig(
  plistXml: string,
  configPath: string,
): PlistConfigCheck {
  const args = parseProgramArguments(plistXml);
  const target = configPath.trim();
  let loadsConfig = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    // `-c <path>` / `--config <path>` — the value is the NEXT token.
    if ((arg === "-c" || arg === "--config") && args[i + 1] === target) {
      loadsConfig = true;
      break;
    }
    // `-c=<path>` / `--config=<path>` — joined form.
    if (arg === `-c=${target}` || arg === `--config=${target}`) {
      loadsConfig = true;
      break;
    }
  }
  return { loadsConfig, programArguments: args };
}

// =============================================================================
// Guard 3 — the leaf account must match the daemon's real creds account.
// =============================================================================

/**
 * Decode the `issuer_account` (falling back to `iss`) from the NATS user JWT
 * embedded in a `.creds` file. A `.creds` file is a decorated block:
 *
 *   -----BEGIN NATS USER JWT-----
 *   eyJ0eXAiOiJKV1Qi…            ← the JWT (3 base64url segments, dot-separated)
 *   ------END NATS USER JWT------
 *   …
 *   -----BEGIN USER NKEY SEED-----
 *   SU…                          ← the private seed (NOT read here)
 *   ------END USER NKEY SEED------
 *
 * The JWT's middle segment (base64url) is a JSON claims object whose
 * `.nats.issuer_account` (for a user issued by a signing key) names the ACCOUNT
 * the user publishes on. When absent (a user issued directly by the account key,
 * not a signing key), the `iss` claim IS the account. Returns `undefined` when
 * the creds text carries no decodable user JWT.
 *
 * Reads PUBLIC claim material only (never the seed). Pure.
 */
export function decodeCredsIssuerAccount(credsText: string): string | undefined {
  const jwt = extractUserJwt(credsText);
  if (jwt === undefined) return undefined;
  const claims = decodeJwtClaims(jwt);
  if (claims === undefined) return undefined;
  const nats = claims.nats;
  if (nats !== null && typeof nats === "object") {
    const issuerAccount = (nats as Record<string, unknown>).issuer_account;
    if (typeof issuerAccount === "string" && issuerAccount.length > 0) {
      return issuerAccount;
    }
  }
  // Fall back to `iss`: a user issued directly by the account key carries no
  // `issuer_account`, and `iss` IS that account.
  const iss = claims.iss;
  return typeof iss === "string" && iss.length > 0 ? iss : undefined;
}

/** Pull the user-JWT body out of a decorated `.creds` file. */
function extractUserJwt(credsText: string): string | undefined {
  const m =
    /-----BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*-----?END NATS USER JWT-----?/.exec(
      credsText,
    );
  const body = m?.[1];
  if (body === undefined) return undefined;
  // The JWT may be wrapped across lines in the block; collapse whitespace.
  const jwt = body.replace(/\s+/g, "");
  return jwt.length > 0 ? jwt : undefined;
}

/** Decode a JWT's middle (claims) segment as JSON. `undefined` on any failure. */
function decodeJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (payload === undefined) return undefined;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = new TextDecoder().decode(base64ToBytes(b64));
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object") return undefined;
    return parsed as Record<string, unknown>;
  } catch (_err) {
    // Malformed base64url / JSON — treat as no decodable claims (fail closed:
    // the caller then cannot verify the account, and warns rather than binding
    // a wrong account silently).
    return undefined;
  }
}

/** base64 (standard alphabet, `+`/`/`) → bytes, tolerating missing padding. */
function base64ToBytes(b64: string): Uint8Array {
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The verdict of the leaf-account-vs-creds check. */
export type LeafAccountCheck =
  | {
      /** The rendered leaf `account:` agrees with the creds' issuer_account. */
      status: "match";
      account: string;
    }
  | {
      /** The rendered account and the creds' issuer_account DISAGREE — fatal:
       *  the leaf would bind an account the daemon does not publish on. */
      status: "mismatch";
      renderedAccount: string;
      credsAccount: string;
    }
  | {
      /** Could not determine one side (no creds account decodable, or no
       *  rendered account) — cannot verify; the caller degrades to a warn. */
      status: "indeterminate";
      reason: string;
    };

/**
 * Guard 3 — compare the account the join would render into the leaf
 * (`renderedAccount`, from `nats_infra.account`) against the account the daemon
 * actually publishes on (`credsIssuerAccount`, decoded from the creds JWT). A
 * mismatch is FATAL: the leaf comes up, interest is visible, but publishes never
 * cross because the daemon publishes on a DIFFERENT account than the leaf binds.
 *
 * The comparison is exact-string on the account public key (nkey-U `A…`). We do
 * NOT decode-normalise here — both sides are already nkey-U account pubkeys in
 * this path (the config `account:` and the creds `issuer_account`), so a raw
 * inequality is a real divergence.
 *
 * `renderedAccount === undefined` (a $G/creds-only bus renders no `account:`
 * line) → `indeterminate` (there is nothing to mismatch; the creds JWT binds the
 * leaf on its own). `credsIssuerAccount === undefined` → `indeterminate` (a
 * secret-auth leaf carries no creds; or the creds JWT was undecodable).
 */
export function checkLeafAccountMatchesCreds(params: {
  renderedAccount: string | undefined;
  credsIssuerAccount: string | undefined;
}): LeafAccountCheck {
  const { renderedAccount, credsIssuerAccount } = params;
  if (renderedAccount === undefined || renderedAccount.trim().length === 0) {
    return {
      status: "indeterminate",
      reason:
        "no leaf account: line to render (a $G/default or secret-auth bus binds via the creds JWT / URL userinfo) — nothing to compare",
    };
  }
  if (credsIssuerAccount === undefined || credsIssuerAccount.trim().length === 0) {
    return {
      status: "indeterminate",
      reason:
        "could not decode issuer_account from the daemon creds (no .creds JWT, a secret-auth leaf, or an undecodable creds file)",
    };
  }
  if (renderedAccount.trim() === credsIssuerAccount.trim()) {
    return { status: "match", account: renderedAccount.trim() };
  }
  return {
    status: "mismatch",
    renderedAccount: renderedAccount.trim(),
    credsAccount: credsIssuerAccount.trim(),
  };
}
