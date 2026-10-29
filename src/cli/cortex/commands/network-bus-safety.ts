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
 * validation doesn't run in `-t`; verified live). Pinned on nats-server v2.14.0
 * (cortex#2747, `network-bus-safety.nats-server.test.ts`): fatal at startup with
 * or without a `leafnodes` `listen` port, and with only `remotes`; a SIGHUP
 * reload rejects it and keeps the old config, so a reloaded-only bus looks
 * healthy until it restarts. A deployment that ran pre-#1491 tooling, or
 * `secret add-member` on an operator hub whose network was not attested
 * `hub_mode: operator` (closed by cortex#2747), carries a bomb that detonates
 * on its next restart.
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
 * user JWT embedded in the `.creds` file; {@link decideLeafAccountGuard}
 * compares it to the account the join would render. Since cortex#2760 a
 * foreign-operator leaf creds file (issued under the hub's operator JWT) is not
 * compared with the local account; the guard checks the daemon's own creds.
 * The local accounts are the ones the operator-mode config defines.
 */

import { hasManagedLeafAuthorizationRegion } from "../../../common/nats/hub-leaf-authorization";
import { decodeJwtClaims, extractUserJwt } from "../../../common/nats/jwt";

// =============================================================================
// Shared — strip HOCON/nats config comments (line `//`/`#` + block slash-star).
// Mirrors leaf-remote-renderer.ts's private `stripConfigComments` so a commented
// -out `authorization { users }` never trips Guard 1 (a false positive here is a
// spurious join REFUSAL, not a crash — but still avoidable).
// =============================================================================

export function stripConfigComments(natsConfigText: string): string {
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
export function isOperatorModeConfig(text: string): boolean {
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
      bombs.push({ path: file.path, fix: bombFix(file.path, file.text) });
    }
  }
  return bombs;
}

/**
 * The removal fix for one offending file. cortex#2747: when the block sits in
 * the cortex-managed region, the message names the tool that owns it and why
 * removing the region by hand is safe, instead of only saying "remove it".
 */
function bombFix(path: string, text: string): string {
  const fatal =
    `On an operator-mode bus nats-server refuses to start with it ("operator mode does not allow ` +
    `specifying users in leafnode config"), whether or not \`leafnodes\` has a \`listen\` port. ` +
    `\`nats-server -t\` passes it, and a SIGHUP reload rejects it but keeps the old config running, ` +
    `so a bus that has only been reloaded looks healthy until its next restart.`;
  if (hasManagedLeafAuthorizationRegion(text)) {
    return (
      `delete the cortex-managed leaf authorization region from ${path}: every line from ` +
      `"# >>> cortex-managed leaf authorization" through "# <<< cortex-managed leaf authorization", ` +
      `markers included. \`cortex network secret add-member\` wrote it on the PSK path, which an ` +
      `operator-mode bus cannot use: its leaves authenticate with \`.creds\`, so no member depends on ` +
      `these users. To stop add-member writing it again, set \`hub_mode: operator\` on this network's ` +
      `\`networks[]\` entry. ${fatal} (cortex#2747)`
    );
  }
  return (
    `remove the \`leafnodes { authorization { users … } }\` block from ${path}; it is a hand-written ` +
    `or pre-#1491 hub-side PSK block, and the leaf authenticates via its own remote block, not this ` +
    `one. ${fatal}`
  );
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

/** Guard 3's decision for one join: refuse with a reason, or proceed (with an
 *  optional step line for the join log). */
export type LeafAccountGuardDecision =
  | { kind: "refuse"; reason: string }
  | { kind: "proceed"; step?: string };

/** A creds file Guard 3 inspected: its path, the decoded issuer account, and
 *  whether the local nats config defines that account. */
export interface InspectedCreds {
  path: string;
  account: string | undefined;
  definedLocally: boolean;
}

/**
 * cortex#2760 — Guard 3's full decision rule. The leaf creds file authenticates
 * the leaf to the HUB, so its issuer account is an account signed by the hub's
 * operator JWT. Two topologies follow:
 *
 * 1. **Local account** — the leaf creds' issuer account is defined in the local
 *    nats config. This is the cortex#1728 case: the leaf binds `rendered` while
 *    those creds publish on another local account, so publishes never cross.
 *    Compare and refuse on a mismatch.
 * 2. **A foreign-operator leaf** — the issuer account is not defined locally, so
 *    the hub's operator JWT signed it. It can never equal the local
 *    account the remote binds, and comparing them proves nothing. The guard
 *    checks the DAEMON instead: the account its own creds (`nats.credsPath`)
 *    publish on must be the leaf's local account, or the declared
 *    `stack.nats_infra.agents_account` that provision bridges with the
 *    `federated.>` export/import. Any other locally defined account refuses.
 *
 * Undecodable creds, a daemon with no separate creds file, or a daemon account
 * the local config does not define cannot be judged; those proceed with a note.
 * A refusal never recommends binding the leaf to an account the local config
 * does not define.
 */
export function decideLeafAccountGuard(params: {
  rendered: string;
  leafCreds: InspectedCreds;
  daemonCreds: InspectedCreds | undefined;
  agentsAccount: string | undefined;
}): LeafAccountGuardDecision {
  const { rendered, leafCreds, daemonCreds: daemon, agentsAccount } = params;
  const tag = "(cortex#1728 Guard 3)";
  const proceed = (step: string): LeafAccountGuardDecision => ({ kind: "proceed", step: `${step} ${tag}` });
  const refuseMismatch = (
    who: "leaf" | "daemon",
    path: string,
    account: string,
    remedy: string,
  ): LeafAccountGuardDecision => ({
    kind: "refuse",
    reason:
      `refusing to render a leaf into account ${rendered} — the ${who} creds (${path}) ` +
      `publish on a DIFFERENT local account ${account} (decoded from the ` +
      `creds' issuer_account). A leaf bound to one account while the creds publish on another comes up ` +
      `with visible interest, but publishes never cross (out=0). ${remedy} ${tag}`,
  });
  const leafAccount = leafCreds.account;
  if (leafAccount === undefined) return { kind: "proceed" };
  if (leafCreds.definedLocally) {
    if (leafAccount === rendered) {
      return proceed(`verified leaf account ${rendered} matches the leaf creds' issuer_account`);
    }
    return refuseMismatch(
      "leaf",
      leafCreds.path,
      leafAccount,
      `Set stack.nats_infra.account to ${leafAccount} (defined in the local nats config), or wire a ` +
        `cross-account export/import between them.`,
    );
  }
  const foreignLeaf =
    `the leaf creds' issuer_account ${leafAccount} is not defined in the local nats config, so this is ` +
    `treated as a foreign-operator leaf and the account is not compared; the leaf binds ` +
    `local account ${rendered}`;
  if (daemon === undefined || daemon.path === leafCreds.path) {
    return proceed(`${foreignLeaf}; no separate daemon creds (nats.credsPath) to check`);
  }
  const daemonAccount = daemon.account;
  if (daemonAccount === undefined || !daemon.definedLocally) {
    return proceed(`${foreignLeaf}; could not resolve a local account from the daemon creds (${daemon.path})`);
  }
  if (daemonAccount === rendered) {
    return proceed(`${foreignLeaf}; the daemon publishes on the same account`);
  }
  if (daemonAccount === agentsAccount) {
    return proceed(
      `${foreignLeaf}; the daemon publishes on the declared agents_account ${agentsAccount}, which ` +
        `network provision bridges with the federated.> export/import (the bridge itself is not checked here)`,
    );
  }
  return refuseMismatch(
    "daemon",
    daemon.path,
    daemonAccount,
    `It is not the declared stack.nats_infra.agents_account either. Set stack.nats_infra.account to ` +
      `${daemonAccount}, or declare it as stack.nats_infra.agents_account and wire the federated.> ` +
      `export/import (cortex network provision). The leaf creds' account ${leafAccount} is not defined ` +
      `locally and must not be bound.`,
  );
}
