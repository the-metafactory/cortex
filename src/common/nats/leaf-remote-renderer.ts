/**
 * S3 (Network Join Control Plane, #737 / epic #733) — nats-server leaf-remote
 * renderer. Spec §6 F3; DD-6 (the runtime/arc owns the nats-server leaf
 * rendering); DD-12 (hub_url/leaf_port from the registry-served descriptor).
 *
 * ## What this is
 *
 * The pure config-producing half of "join". Given a verified
 * {@link NetworkDescriptor} (the registry's `GET /networks/{id}` payload —
 * `hub_url`/`leaf_port`, DD-12) plus the stack's local leaf binding (the
 * `.creds` path it authenticates the leaf with + the NATS account that leaf
 * traffic binds to in operator-mode), this renders the nats-server leaf
 * **remote** for that network. S4's `cortex network join` writes the output;
 * this module never touches a live `~/.config/nats/*.conf` or any daemon.
 *
 * ## Include-file vs in-place merge — the decision (and why)
 *
 * The live config (`~/.config/nats/local.conf`) is an **operator-mode**
 * config (NSC operator JWT + `resolver_preload` + `system_account`). Doing
 * HOCON text-surgery on it to splice a remote is fragile and irreversible.
 * Two options were on the table (per the S3 brief):
 *
 *   1. **`include` a per-network fragment.** nats-server's `include`
 *      directive splices the included file's tokens *at the point of
 *      inclusion* — it is NOT a deep map-merge. Two top-level `leafnodes {}`
 *      blocks do not concatenate their `remotes` arrays; the later block
 *      replaces the earlier. So an `include` of a standalone
 *      `leafnodes { remotes: [...] }` fragment would only work if the main
 *      config had **no** other `leafnodes` block — and splicing array
 *      *elements* requires editing the main config to add the include point
 *      inside the array. Both reintroduce live-config surgery.
 *
 *   2. **Structured merge with a per-network idempotency key.** Render each
 *      network's remote as a structured {@link LeafRemote} keyed by
 *      `network_id`, compose the full `remotes[]` deterministically via
 *      {@link mergeLeafRemotes} (re-render REPLACES by key, never
 *      duplicates), and emit a single self-describing include file
 *      (`leafnodes-<network>.conf`, {@link leafIncludeFileName}) that the
 *      runtime composes. Idempotent, reversible (S4 `leave` deletes the
 *      keyed entry / the file), multi-network-safe (OQ3: N keyed remotes),
 *      and it never edits the live operator-mode config in place.
 *
 * **We take option 2** — the brief's documented fallback — because NATS
 * `include` does not give us safe array-element merge, and a per-network
 * keyed structure is the only shape that is simultaneously idempotent,
 * reversible, and multi-network-clean. The renderer is pure; S4 owns the
 * single-writer step (which include file path, when to write, when to
 * reload).
 *
 * ## #717-aware (config-split)
 *
 * This renders the **nats-server** infrastructure config, which is a
 * SEPARATE artifact from the cortex per-stack config-split layout
 * (`~/.config/cortex/<stack>/<stack>.yaml`, migration 0003 / #717). It makes
 * NO assumption about a monolithic cortex config and reads no cortex.yaml —
 * the descriptor + binding are passed in. The include-file path is supplied
 * by the caller (S4), so the leaf config can live per-stack alongside the
 * split layout without this module hard-coding a monolith path.
 *
 * Vocabulary (CONTEXT.md): "network" = topology; "leaf"/"hub" = the NATS
 * leaf-node layer; "account" here is the NSC NATS account the leaf binds to
 * (the one place "operator-mode" legitimately refers to the NSC account-tree
 * root, never the principal).
 */

import type { NetworkDescriptor } from "../registry/types";

/**
 * The stack's local leaf binding — the two facts the descriptor does NOT
 * carry (because they are local to the joining stack, not network-wide):
 * the `.creds` file the leaf authenticates with, and the NATS account that
 * incoming/outgoing leaf traffic binds to under operator-mode.
 */
export interface StackLeafBinding {
  /**
   * Absolute path to the NATS user `.creds` file the leaf remote
   * authenticates with (e.g. `~/.config/nats/andreas.creds`, expanded).
   * Must be absolute — nats-server resolves it relative to its working
   * directory otherwise, which under launchd is unpredictable.
   */
  credentials: string;
  /**
   * The LOCAL NATS account (nkey-U `A…`) that leaf traffic binds to —
   * OPTIONAL (#799).
   *
   *   - **Operator-mode bus** (NSC operator JWT + `accounts`/`resolver_preload`
   *     defining the account): the leaf remote MUST declare the account so
   *     nats-server can resolve it against the local account tree. Pass the
   *     nkey-U here → the rendered remote carries an `account:` line.
   *   - **`$G`/default-account bus** (a simple creds-authenticated leaf-client —
   *     no `operator:`/`accounts{}`): there is NO local account tree to resolve
   *     an `account:` against, so emitting one makes nats-server refuse to boot
   *     (`cannot find local account "<A…>"`). The account binding rides in the
   *     `.creds` JWT instead. OMIT this field (leave `undefined`) → the rendered
   *     remote has NO `account:` line, mirroring a working hand-built `$G` leaf.
   *
   * DD-8: the config surface uses nkey-U; the registry stores base64 —
   * translation is the join command's job; this renderer takes the
   * already-nkey-U value (or `undefined` for the `$G`/creds-bound case).
   */
  account?: string;
}

/**
 * A single rendered leaf remote, keyed by `network_id` so re-render of the
 * same network replaces in place ({@link mergeLeafRemotes}). The shape mirrors
 * one element of nats-server's `leafnodes.remotes[]`.
 */
export interface LeafRemote {
  /** Idempotency key — the network this remote dials. */
  network_id: string;
  /** Fully-qualified leaf dial URL, e.g. `tls://nats.meta-factory.dev:7422`. */
  url: string;
  /** Absolute path to the `.creds` file (leaf auth). */
  credentials: string;
  /**
   * The local NATS account (nkey-U) the leaf binds to — present ONLY in
   * operator-mode (#799). Absent (`undefined`) for a `$G`/default bus, where
   * the account binding rides in the `.creds` JWT and an `account:` line would
   * crash nats-server. When absent, {@link serializeRemote} omits the line.
   */
  account?: string;
}

/** A network id may only be a single path segment of safe characters. */
const SAFE_NETWORK_ID = /^[a-z][a-z0-9-]*$/;

/**
 * A NATS nkey-U account public key: `A` + 55 base32 (RFC 4648, upper, no pad)
 * characters. This is the ONE field {@link serializeRemote} emits BARE
 * (unquoted) into the HOCON fragment — to match the live `local.conf` shape,
 * which leaves the account pubkey unquoted. An unquoted token that contained
 * whitespace/braces/newlines would break out of the `remotes[]` block and let
 * a malformed (or hostile) account inject arbitrary nats-server directives, so
 * we constrain it to the exact nkey-U grammar before serialization. (url +
 * credentials are quoted, so HOCON's JSON-style escapes already contain them.)
 */
const NKEY_ACCOUNT = /^A[A-Z2-7]{55}$/;

/**
 * Build the fully-qualified leaf dial URL from the descriptor. `hub_url` may
 * already be a full `tls://host:port` URL (the common case, DD-12) or a bare
 * host; `leaf_port` is the authority when the URL carries no port. We never
 * double-append a port already present in the URL.
 */
function resolveLeafUrl(descriptor: NetworkDescriptor): string {
  const raw = descriptor.hub_url.trim();
  if (raw.length === 0) {
    throw new Error(
      `leaf-remote-renderer: descriptor for "${descriptor.network_id}" has an empty hub_url (DD-12: the hub url is registry-served and required)`,
    );
  }

  const hasScheme = /^[a-z]+:\/\//i.test(raw);
  const withScheme = hasScheme ? raw : `tls://${raw}`;

  // Parse to decide whether a port is already present. URL needs a scheme to
  // parse a host:port authority, which `withScheme` guarantees.
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch (err) {
    throw new Error(
      `leaf-remote-renderer: descriptor for "${descriptor.network_id}" has an unparseable hub_url ${JSON.stringify(descriptor.hub_url)}`,
      { cause: err },
    );
  }

  if (parsed.port.length > 0) {
    // URL already carries an explicit port — honor it, never append again.
    return withScheme;
  }

  if (
    !Number.isInteger(descriptor.leaf_port) ||
    descriptor.leaf_port <= 0 ||
    descriptor.leaf_port > 65535
  ) {
    throw new Error(
      `leaf-remote-renderer: descriptor for "${descriptor.network_id}" has hub_url without a port and an invalid leaf_port ${String(descriptor.leaf_port)}`,
    );
  }

  // Reconstruct host:port. Strip any trailing slash the URL parser added.
  const scheme = parsed.protocol.replace(/:$/, "");
  return `${scheme}://${parsed.hostname}:${descriptor.leaf_port}`;
}

/**
 * Render a single {@link LeafRemote} from a verified descriptor + the stack's
 * leaf binding. Fails loud at the boundary on a missing/relative creds path —
 * a leaf cannot authenticate to the hub without creds, so a silent bad value
 * would produce a dormant link, the exact trap S3 closes.
 *
 * The `account` is OPTIONAL (#799):
 *   - present → operator-mode; the nkey-U is validated (grammar + HOCON-injection
 *     guard) and the rendered remote carries an `account:` line.
 *   - absent → a `$G`/default bus; the rendered remote has NO `account:` line
 *     and the account binding rides in the `.creds` JWT. (The caller — the join
 *     orchestrator — decides which mode applies via the bus-type detection in
 *     {@link natsConfigCanBindAccount}: it passes the account only for an
 *     operator-mode bus that defines it, and omits it for a `$G`+creds bus.)
 */
export function renderLeafRemote(
  descriptor: NetworkDescriptor,
  binding: StackLeafBinding,
): LeafRemote {
  if (!SAFE_NETWORK_ID.test(descriptor.network_id)) {
    throw new Error(
      `leaf-remote-renderer: invalid network_id ${JSON.stringify(descriptor.network_id)} (must match ${SAFE_NETWORK_ID})`,
    );
  }

  const credentials = binding.credentials.trim();
  if (credentials.length === 0 || !credentials.startsWith("/")) {
    throw new Error(
      `leaf-remote-renderer: credentials must be an absolute path, got ${JSON.stringify(binding.credentials)}`,
    );
  }

  // #799 — the account is OPTIONAL. When absent/empty the remote is rendered
  // WITHOUT an `account:` line (the `$G`/default-bus mode — binding rides in the
  // creds JWT). When present it must be a valid nkey-U: it is emitted BARE
  // (unquoted) into HOCON (matching local.conf), so anything outside the nkey-U
  // grammar could break out of the remotes[] block and inject directives.
  const account = binding.account?.trim();
  if (account !== undefined && account.length > 0) {
    if (!NKEY_ACCOUNT.test(account)) {
      throw new Error(
        `leaf-remote-renderer: account for network "${descriptor.network_id}" is not a valid nkey-U account public key (expected ${NKEY_ACCOUNT}); got ${JSON.stringify(binding.account)}`,
      );
    }
    return {
      network_id: descriptor.network_id,
      url: resolveLeafUrl(descriptor),
      credentials,
      account,
    };
  }

  // No account → `$G`/default mode: omit `account:` entirely.
  return {
    network_id: descriptor.network_id,
    url: resolveLeafUrl(descriptor),
    credentials,
  };
}

/**
 * Compose a leaf remote into an existing set, keyed by `network_id`. A
 * re-render of the same network REPLACES the existing entry (the hub may have
 * relocated, DD-12) rather than duplicating it — this is the idempotency
 * guarantee. Distinct networks accumulate (OQ3 multi-network). Pure: the
 * input array is never mutated; output order is deterministic (existing order
 * preserved, replacement in place, new entries appended).
 */
export function mergeLeafRemotes(
  existing: readonly LeafRemote[],
  next: LeafRemote,
): LeafRemote[] {
  const out = existing.map((r) => ({ ...r }));
  const idx = out.findIndex((r) => r.network_id === next.network_id);
  if (idx >= 0) {
    out[idx] = { ...next };
  } else {
    out.push({ ...next });
  }
  return out;
}

/**
 * The deterministic file name for a network's leaf include fragment, e.g.
 * `leafnodes-metafactory.conf`. The caller (S4) decides the directory; this
 * only owns the leaf name and guarantees the network id cannot escape it.
 */
export function leafIncludeFileName(networkId: string): string {
  if (!SAFE_NETWORK_ID.test(networkId)) {
    throw new Error(
      `leaf-remote-renderer: invalid network_id ${JSON.stringify(networkId)} for include file name (must match ${SAFE_NETWORK_ID})`,
    );
  }
  return `leafnodes-${networkId}.conf`;
}

// =============================================================================
// #754 — wiring the include directive into the main nats config.
//
// S3 rendered the per-network `leafnodes-<network>.conf` and S4 ensured the
// launchd plist loads `local.conf` — but NOTHING made `local.conf` actually
// `include` the rendered leaf file, so nats-server loaded a config that never
// referenced the leaf → dormant leaf (the exact DD-6 trap S3 set out to kill).
//
// These two pure helpers mirror the plist `ensureConfigArg`/`dropConfigArg`
// idempotent-ensure pattern, but at the nats-config TEXT level: ensure the
// `include "leafnodes-<network>.conf"` directive is present (byte-stable
// no-op when already there), and remove exactly that one directive on leave.
//
// HOCON `include "file"` is a top-level statement; the included file's tokens
// are spliced at the point of inclusion. We append the directive on its own
// top-level line (column 0) so it sits OUTSIDE any `{ ... }` block — appending
// at end-of-file is always at top level. For the single-network case (the
// common onboarding path) the included `leafnodes { remotes: [...] }` becomes
// the config's `leafnodes` block; for multi-network the OQ3 note in the module
// header still holds (the runtime composes), but each network's include is
// tracked independently and idempotently here.
// =============================================================================

/**
 * The literal include directive a config carries for `networkId`. Quoted (the
 * file name carries a `.`, and quoting is the canonical HOCON form). Uses
 * {@link leafIncludeFileName} so the directive and the written file can never
 * drift apart.
 */
function leafIncludeDirective(networkId: string): string {
  return `include "${leafIncludeFileName(networkId)}"`;
}

/**
 * A matcher for an EXISTING include of `networkId`'s leaf file, tolerant of the
 * hand-written shapes a human might have typed: single OR double quotes, and
 * any run of horizontal whitespace between `include` and the file name. Used so
 * we never add a duplicate directive for a network already wired by hand.
 */
function leafIncludeDirectiveRegex(networkId: string): RegExp {
  // leafIncludeFileName validates the id; escape the literal `.` in `.conf`.
  const file = leafIncludeFileName(networkId).replace(/\./g, "\\.");
  return new RegExp(`^[ \\t]*include[ \\t]+["']${file}["'][ \\t]*$`, "m");
}

/**
 * True iff `natsConfigText` already includes `networkId`'s leaf file (any
 * quote/whitespace shape). The predicate callers gate on before a rewrite.
 */
export function leafIncludeDirectivePresent(
  natsConfigText: string,
  networkId: string,
): boolean {
  return leafIncludeDirectiveRegex(networkId).test(natsConfigText);
}

/**
 * Return `natsConfigText` with a top-level `include "leafnodes-<network>.conf"`
 * directive ensured. Mirrors {@link ensureConfigArg}'s idempotent contract:
 *
 *   - directive already present (any quote/whitespace shape) → returned
 *     UNCHANGED (byte-stable no-op).
 *   - directive absent → the canonical double-quoted directive is appended as
 *     its own top-level line (with a single trailing newline), so it sits
 *     outside any `{ ... }` block.
 *
 * Pure: the input string is never mutated. Throws on an invalid network id
 * (delegated to {@link leafIncludeFileName}) — a bad id must never reach disk.
 */
export function ensureLeafInclude(
  natsConfigText: string,
  networkId: string,
): string {
  const directive = leafIncludeDirective(networkId); // validates the id

  if (leafIncludeDirectivePresent(natsConfigText, networkId)) {
    return natsConfigText; // idempotent no-op (byte-stable).
  }

  // Append as a fresh top-level line. Normalise so there is exactly one
  // newline before the directive and one after — byte-stable on re-render
  // because the present-check above short-circuits the second call.
  const base = natsConfigText.replace(/\n*$/, "");
  const prefix = base.length === 0 ? "" : `${base}\n`;
  return `${prefix}${directive}\n`;
}

/**
 * Return `natsConfigText` with `networkId`'s include directive removed. Removes
 * exactly the matching line(s) (any quote/whitespace shape) and nothing else;
 * a config that never had the directive is returned UNCHANGED. The inverse of
 * {@link ensureLeafInclude}: ensure→remove round-trips to the original bytes.
 *
 * Pure. Throws on an invalid network id.
 */
export function removeLeafInclude(
  natsConfigText: string,
  networkId: string,
): string {
  const re = leafIncludeDirectiveRegex(networkId);
  if (!re.test(natsConfigText)) {
    return natsConfigText; // idempotent no-op.
  }
  // Drop the matching line AND the newline it owns, so removing the directive
  // we appended in ensureLeafInclude restores the pre-ensure bytes exactly.
  const global = new RegExp(re.source + "\\n?", "gm");
  return natsConfigText.replace(global, "");
}

// =============================================================================
// #794 — pre-flight: can this nats config BIND the leaf account?
//
// `cortex network join` renders a leaf remote with `account: <A…>` (the leaf
// creds' account) and restarts nats-server. nats-server resolves that account
// against the LOCAL config's account tree. If the config is operator-mode and
// defines the account (e.g. via `resolver_preload`/`accounts`), the leaf binds.
// If the config is anonymous + hard-isolated (no `operator:` and no account
// tree — the halden/community pattern), the account is unknown and nats-server
// CRASHES on startup with `cannot find local account "<A…>" specified in
// leafnode remote`, taking the whole bus DOWN.
//
// So before the join writes the leaf include + restarts nats, the orchestrator
// pre-validates with {@link natsConfigCanBindAccount}. The check is a targeted
// text heuristic (documented below) rather than a full HOCON+JWT parse: a
// false "cannot bind" only blocks a join (recoverable — the principal converts
// the bus or passes a config that defines the account), whereas the failure we
// must never produce is a leaf render that crashes the server.
// =============================================================================

/**
 * Strip comments from a nats config so a commented-out account-tree directive or
 * account string can't produce a false positive.
 *
 * #821 MAJOR-2 — we strip BOTH line comments (`//` and `#`) AND HOCON/C-style
 * block comments (slash-star … star-slash, including multi-line). The earlier
 * code stripped only line comments and called a block-commented account
 * "benign" — that was WRONG: a false-positive bind is exactly the #821 crash (an
 * account named only inside a block comment would make
 * {@link natsConfigCanBindAccount} return canBind:true → an account-bound remote
 * → `cannot find local account`). Block comments are replaced with whitespace
 * (newlines preserved) so line structure — which the operator-mode line-anchored
 * regexes depend on — is unchanged.
 */
function stripConfigComments(natsConfigText: string): string {
  // Strip block comments first (they may span lines), preserving newlines so the
  // line-anchored operator-mode detectors keep their line structure. Then strip
  // whole-line `//` / `#` comments.
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

/** The result of the #794 pre-flight bind check. */
export interface AccountBindCheck {
  /** True iff the config is operator-mode AND names the account (can bind). */
  canBind: boolean;
  /** Present when `canBind` is false — why the config can't bind the account. */
  reason?: string;
}

/**
 * Decide whether `natsConfigText` can bind a leaf to `account` (an nkey-U
 * public key, `A…`) WITHOUT crashing nats-server (#794).
 *
 * Heuristic (deliberately simple + robust; a full HOCON+JWT parse is not worth
 * the dependency and the failure mode of the heuristic is a recoverable refusal,
 * never a crash):
 *
 *   - The config must be **operator-mode** — it contains a top-level
 *     `operator:` / `operator =` key (the NSC operator JWT reference) OR an
 *     account tree (`accounts` / `resolver_preload`). A config with NONE of
 *     these is **anonymous + hard-isolated**: it defines no accounts, so the
 *     account the leaf binds can never be found → `canBind: false`.
 *   - AND the `account` nkey-U must appear as a standalone TOKEN naming the
 *     account in `resolver_preload`/`accounts` — NOT embedded in a longer token,
 *     and NOT only as the `system_account` value (the SYS account is not
 *     leaf-bindable). An operator-mode config that does not name THIS account as
 *     a bindable account cannot bind it → `canBind: false` (#821 MAJOR-2: a
 *     false-positive bind IS the crash, so the match is token-bounded, not a
 *     bare substring).
 *
 * Comments — line (`//`/`#`) AND block (slash-star … star-slash) — are stripped
 * first so a commented-out directive or account string never counts (MAJOR-2).
 *
 * Pure: reads the text, writes nothing. The caller (the join orchestrator)
 * passes the resolved `config_path` contents and refuses BEFORE any mutation
 * when `canBind` is false.
 */
export function natsConfigCanBindAccount(
  natsConfigText: string,
  account: string,
): AccountBindCheck {
  const trimmedAccount = account.trim();
  if (trimmedAccount.length === 0 || !NKEY_ACCOUNT.test(trimmedAccount)) {
    // A malformed/empty account can't be reasoned about — treat as un-bindable
    // (the renderer would reject it anyway; refuse early with a clear reason).
    return {
      canBind: false,
      reason: `account ${JSON.stringify(account)} is not a valid nkey-U account public key`,
    };
  }

  const text = stripConfigComments(natsConfigText);

  // operator-mode signal: an NSC operator JWT key OR an account-tree directive
  // (`accounts` / `resolver_preload`). Shared with {@link natsConfigHasAccountTree}
  // so the #794 guard and the #799 bind-mode decision cannot drift.
  if (!natsConfigHasAccountTree(natsConfigText)) {
    return {
      canBind: false,
      reason:
        "config is anonymous/hard-isolated (no operator-mode account tree: " +
        "no NSC operator JWT key, `accounts`, or `resolver_preload`)",
    };
  }

  // operator-mode, but does it name THIS account as a BINDABLE account?
  //
  // #821 MAJOR-2 — a bare `text.includes()` is unsafe (a false-positive bind IS
  // the crash). We require the nkey-U to appear at a TOKEN BOUNDARY (not embedded
  // inside a longer base32/alnum run — e.g. a JWT body), AND we EXCLUDE the
  // `system_account` value (the SYS account is not leaf-bindable). nkey grammar
  // is `A[A-Z2-7]{55}`, so the "token" charset to bound against is `[A-Za-z0-9]`
  // (base32 ⊂ alnum); the account must not be flanked by another alnum char.
  const tokenBoundary = new RegExp(
    `(?<![A-Za-z0-9])${trimmedAccount}(?![A-Za-z0-9])`,
  );
  if (!tokenBoundary.test(text)) {
    return {
      canBind: false,
      reason: `config is operator-mode but does not define account ${trimmedAccount}`,
    };
  }

  // The account appears as a standalone token — but if its ONLY appearance is as
  // the `system_account` value, it is the SYS account, which a leaf cannot bind.
  // Strip the system_account line(s) and re-test: if the token survives, there is
  // a genuine (non-SYS) definition; if not, this account is only the SYS account.
  const withoutSysAccount = text.replace(
    /^[ \t]*system_account[ \t]*[:=].*$/gm,
    "",
  );
  if (!tokenBoundary.test(withoutSysAccount)) {
    return {
      canBind: false,
      reason:
        `config is operator-mode but account ${trimmedAccount} is only the ` +
        `system_account (SYS) — a leaf cannot bind the system account`,
    };
  }

  return { canBind: true };
}

// =============================================================================
// #799 — choose the leaf-remote BIND MODE by bus type.
//
// #794 added `natsConfigCanBindAccount` to refuse a join that would render an
// `account:`-bound leaf onto a bus with no matching account (→ nats-server
// crash). But that conflated two distinct un-bindable shapes:
//
//   1. An operator-mode bus that doesn't DEFINE the account → genuinely
//      un-joinable with that account (still refuse).
//   2. A `$G`/default-account bus (a simple creds-authenticated leaf-client,
//      no `operator:`/`accounts{}`) → joinable WITHOUT an `account:` line; the
//      binding rides in the creds JWT (the working hand-built-leaf shape).
//
// Case 2 was wrongly refused. {@link resolveLeafBindMode} is the corrected
// decision: it returns the bind MODE the renderer should use, given the bus
// config + the candidate account + whether creds are available.
// =============================================================================

/** The leaf-remote bind mode {@link resolveLeafBindMode} selects (#799). */
export type LeafBindMode =
  /** operator-mode bus that defines the account → render `{ url, creds, account }`. */
  | { mode: "operator-account"; account: string }
  /** `$G`/default bus with creds → render `{ url, creds }` (omit `account:`). */
  | { mode: "creds-only" }
  /** Un-joinable (no creds, or operator-mode bus missing the account). */
  | { mode: "refuse"; reason: string };

/**
 * Decide how a leaf remote for this bus should bind (#799), WITHOUT crashing
 * nats-server. Pure: reads the config text + the candidate account, writes
 * nothing.
 *
 *   - **operator-mode bus that defines `account`** → `operator-account` (the
 *     #794-safe account-bound remote; unchanged behaviour).
 *   - **`$G`/default bus (no operator-mode account tree) WITH creds** →
 *     `creds-only`: render a no-account remote; the creds JWT binds it. This is
 *     the case #794 wrongly refused.
 *   - **no creds at all** → `refuse`: a leaf cannot authenticate to the hub
 *     without creds, so neither mode is possible.
 *   - **operator-mode bus that does NOT define `account`** → `refuse`: rendering
 *     an account-bound remote there crashes nats-server, and there is no creds-
 *     only fallback for an operator-mode bus (operator-mode leaves are
 *     account-bound by construction).
 *
 * `hasCreds` is supplied by the caller (the orchestrator knows the resolved
 * creds path); an absent/empty account is treated as "no account offered"
 * (the `$G` path).
 */
export function resolveLeafBindMode(
  natsConfigText: string,
  account: string | undefined,
  hasCreds: boolean,
): LeafBindMode {
  if (!hasCreds) {
    return {
      mode: "refuse",
      reason:
        "no leaf creds available — a leaf cannot authenticate to the hub " +
        "without a `.creds` file (set stack.nats_infra.creds_path or pass --creds)",
    };
  }

  const trimmedAccount = account?.trim();
  const hasAccount = trimmedAccount !== undefined && trimmedAccount.length > 0;

  // When an account is offered, reuse the #794 detection: if the operator-mode
  // bus binds it, render account-bound. (canBindAccount also validates the
  // nkey-U grammar.)
  if (hasAccount) {
    const bind = natsConfigCanBindAccount(natsConfigText, trimmedAccount);
    if (bind.canBind) {
      return { mode: "operator-account", account: trimmedAccount };
    }
    // The bus can't bind the offered account. If it's an OPERATOR-MODE bus that
    // simply doesn't define this account, refuse (no creds-only fallback for
    // operator-mode — its leaves are account-bound). If it's a `$G`/default bus
    // (no account tree at all), fall through to the creds-only path: the offered
    // account is moot because the binding rides in the creds JWT.
    if (natsConfigHasAccountTree(natsConfigText)) {
      return {
        mode: "refuse",
        reason: bind.reason ?? `operator-mode bus does not define account ${trimmedAccount}`,
      };
    }
  }

  // #821 — THE CRASH GUARD. No account offered. A `$G`/default bus binds via the
  // creds JWT (creds-only). But an operator-mode bus REQUIRES every leaf remote
  // to declare an account nkey — nats-server exits 1 at runtime (it rejects a
  // remote with no `account:` line as requiring "account nkeys in remotes") and
  // the bus goes DOWN. The pre-#821 code returned `creds-only` here regardless
  // of bus type, so an operator-mode `cortex network join` run without
  // `--account` rendered a no-account ($G) remote onto the operator-mode bus and
  // crashed nats-server. Refuse instead, with the same actionable message as the
  // missing-account case.
  if (natsConfigHasAccountTree(natsConfigText)) {
    return {
      mode: "refuse",
      reason:
        "operator-mode bus requires the leaf remote to declare an account nkey, " +
        "but none was offered (no --account and no stack.nats_infra.account). " +
        "Rendering a no-account remote would crash nats-server (an operator-mode " +
        "bus rejects remotes with no account nkey). Pass --account <A…> (or set " +
        "stack.nats_infra.account).",
    };
  }

  // `$G`/default bus + creds present → bind via the creds JWT, no `account:` line.
  return { mode: "creds-only" };
}

/**
 * True iff the config is OPERATOR-MODE — it carries any signal of an NSC
 * account tree. The negation is a `$G`/default-account bus (a simple
 * creds-authenticated leaf-client). Mirrors the operator-mode signal inside
 * {@link natsConfigCanBindAccount} (comments stripped first) so the two cannot
 * drift. (#799)
 *
 * #821 MAJOR-1 — the detector must recognise the FULL set of valid operator-mode
 * shapes, not just the canonical `operator:`/`accounts`/`resolver_preload`.
 * Missing a valid operator-mode config misclassifies it as `$G` → renders a
 * no-account remote → the #821 crash. So we add:
 *
 *   - `resolver:` / `resolver {` — an NSC JWT resolver (e.g. `resolver: MEMORY`,
 *     `resolver { type: full … }`). Present ⇒ JWT-based accounts ⇒ operator-mode.
 *   - `system_account:` — names the SYS account; only operator-mode (account-mode)
 *     configs declare one.
 *   - `include "<file>"` — the account tree may be split into an included file
 *     this pure text scanner cannot resolve. FAIL CLOSED: an `include` ⇒ assume
 *     operator-mode ⇒ require an account. Erring toward operator-mode only
 *     OVER-refuses (recoverable — the principal passes `--account`), and never
 *     renders the no-account remote that crashes nats-server.
 *
 * Erring toward operator-mode is the SAFE direction: a false "operator-mode"
 * blocks a join (recoverable); a false "$G" crashes the server.
 */
export function natsConfigHasAccountTree(natsConfigText: string): boolean {
  const text = stripConfigComments(natsConfigText);
  return (
    /^[ \t]*operator[ \t]*[:=]/m.test(text) || // NSC operator JWT key
    /^[ \t]*accounts[ \t]*[:={]/m.test(text) ||
    /^[ \t]*resolver_preload[ \t]*[:={]/m.test(text) ||
    // #821 MAJOR-1 — `resolver:` / `resolver =` / `resolver {` (NSC JWT
    // resolver). The `[ \t]+{` alt catches `resolver { … }` with a space before
    // the brace; `resolver_preload` is excluded because `_` is not in [ \t:={].
    /^[ \t]*resolver[ \t]*(?:[:={]|[ \t]+\{)/m.test(text) ||
    /^[ \t]*system_account[ \t]*[:=]/m.test(text) || // names the SYS account
    // #821 MAJOR-1 — fail-closed on a split config: an `include "<file>"` may
    // pull in the account tree we cannot scan here. Treat as operator-mode.
    // EXCLUDE the join's OWN per-network leaf includes (`leafnodes-<net>.conf`,
    // {@link leafIncludeFileName}) — those carry the leaf REMOTE, never an
    // account tree, and `ensureLeafInclude` adds one on the first join. Counting
    // them would flip a genuine $G bus to "operator-mode" on RE-join and
    // over-refuse it (a #803 regression). Only a NON-leafnodes include counts.
    hasNonLeafInclude(text)
  );
}

/**
 * True iff `text` carries an `include "<file>"` directive whose target is NOT a
 * join-managed `leafnodes-<network>.conf` leaf fragment. Used by
 * {@link natsConfigHasAccountTree} so the join's own leaf include (added by
 * {@link ensureLeafInclude}) never trips the fail-closed operator-mode signal on
 * re-join. (#821 MAJOR-1)
 */
function hasNonLeafInclude(text: string): boolean {
  const re = /^[ \t]*include[ \t]+["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const file = m[1] ?? "";
    // The join's own leaf fragments are `leafnodes-<network>.conf` — skip them.
    if (/^leafnodes-[a-z][a-z0-9-]*\.conf$/.test(file)) continue;
    return true; // a non-leaf include — the account tree may live there.
  }
  return false;
}

// =============================================================================
// O-3 (cortex#1053, epic #1050, spec docs/design-automated-operator-onboarding.md  // operator-mode
// §4-D2) — CONVERT an anonymous/hard-isolated bus to operator-mode, in place,
// instead of fail-fasting (#794) and telling a human to hand-edit `<slug>.conf`.
//
// #794 made `cortex network join` REFUSE on an anonymous bus (rendering an
// account-bound leaf there crashes nats-server). That refusal is the right
// last-resort, but it blocks automation: the human had to copy the four
// operator-mode blocks out of `~/.config/nats/local.conf` by hand (SOP §B0.1).
//
// O-3 makes join render those blocks itself FROM THE LEAF PACKAGE (the
// register→issue handshake of O-4 supplies it; O-3 is the renderer + the
// conversion seam). The blocks are exactly SOP §B0.1's four:
//   - `operator: <JWT>`        — the NSC operator JWT
//   - `system_account: <A…>`   — OPTIONAL (only when the package carries a SYS)
//   - `resolver: MEMORY`
//   - `resolver_preload { <account>: <JWT> [, <sys>: <JWT>] }`
// while KEEPING the stack's own `server_name`/`listen`/`http`/`jetstream` and
// NOT adding a meta-factory leaf include (join renders its own per-network one).
// =============================================================================

/**
 * The "leaf package" — the operator-mode material join needs to convert an
 * anonymous bus. O-4 (the register→issue handshake) SUPPLIES this; O-3 only
 * consumes + renders it. Public-repo-safe: it is JWT + nkey-U text, never a
 * seed.
 */
export interface OperatorModeLeafPackage {
  /** The NSC operator JWT (`eyJ…`) — the root of the local account tree. */
  operatorJwt: string;
  /** The issued account public key (nkey-U, `A…`) the leaf binds to. */
  account: string;
  /** The issued account's JWT (`eyJ…`) — preloaded under `resolver_preload`. */
  accountJwt: string;
  /** OPTIONAL system account public key (nkey-U). Sets `system_account`. */
  systemAccount?: string;
  /** OPTIONAL system account JWT — preloaded alongside the issued account. */
  systemAccountJwt?: string;
}

/**
 * The outcome of {@link renderOperatorModeBlocks}:
 *   - `converted` — the config was anonymous; the rendered operator-mode config
 *     is in `conf` (the orchestrator writes it).
 *   - `already` — the config is ALREADY operator-mode under THIS package's
 *     operator JWT; `conf` is the unchanged bytes (a byte-stable no-op).
 *   - `refuse` — cannot convert: material absent/malformed, OR the config is
 *     already operator-mode under a DIFFERENT operator (never clobber it).
 */
export type OperatorModeConversion =
  | { status: "converted"; conf: string }
  | { status: "already"; conf: string }
  | { status: "refuse"; reason: string };

/** A marker line so a human reading the converted config knows join wrote it. */
const OPERATOR_MODE_MARKER =
  "// --- operator-mode blocks rendered by cortex network join (O-3, #1053) ---";
const OPERATOR_MODE_MARKER_END =
  "// --- end operator-mode blocks ---";

/**
 * Render the SOP §B0.1 operator-mode blocks INTO `currentConf` from a leaf
 * package. PURE (text in, text out): no filesystem, no daemon. The orchestrator
 * (network-lib joinNetwork) calls this through the LeafFilePort, decides whether
 * to write the result, then proceeds with the existing leaf-remote render.
 *
 * Conversion rules:
 *   - **anonymous bus + complete package** → `converted`: append the four blocks,
 *     KEEPING the stack's own identity/ports/JS domain verbatim, NOT touching
 *     any `leafnodes`/`include` (the join renders its own per-network leaf).
 *   - **already operator-mode under THIS operator** → `already` (idempotent
 *     no-op: re-running a converted bus must not duplicate or drift).
 *   - **already operator-mode under a DIFFERENT operator** → `refuse`: never
 *     clobber a bus standing on someone else's account tree.
 *   - **material absent/malformed** → `refuse` with an actionable reason (this
 *     is the #794 fail-fast, preserved for the genuinely-unconvertible case).
 *
 * The account nkey-U is validated against {@link NKEY_ACCOUNT} before it is
 * emitted, and the operator JWT + account JWTs are emitted ONLY as bare `eyJ…` tokens
 * matching the live `local.conf` shape — both guards prevent HOCON injection
 * (a value carrying whitespace/braces/newlines would break out of the block).
 */
export function renderOperatorModeBlocks(
  currentConf: string,
  pkg: OperatorModeLeafPackage,
): OperatorModeConversion {
  // 1) Validate the package — the genuinely-unconvertible cases fail fast (#794).
  const operatorJwt = pkg.operatorJwt.trim();
  const account = pkg.account.trim();
  const accountJwt = pkg.accountJwt.trim();
  const systemAccount = pkg.systemAccount?.trim();
  const systemAccountJwt = pkg.systemAccountJwt?.trim();

  if (operatorJwt.length === 0) {
    return {
      status: "refuse",
      reason:
        "leaf package is missing the operator JWT — cannot render operator-mode " +
        "(pass --operator-jwt or set stack.nats_infra.operator_jwt; O-4 supplies it " +
        "via the register→issue handshake).",
    };
  }
  if (!JWT_SHAPE.test(operatorJwt)) {
    return {
      status: "refuse",
      reason: `operator JWT ${JSON.stringify(pkg.operatorJwt)} is not a JWT (expected an \`eyJ…\` token)`,
    };
  }
  if (account.length === 0) {
    return {
      status: "refuse",
      reason:
        "leaf package is missing the issued account public key — cannot bind the " +
        "leaf (pass --account or set stack.nats_infra.account).",
    };
  }
  if (!NKEY_ACCOUNT.test(account)) {
    return {
      status: "refuse",
      reason: `account ${JSON.stringify(pkg.account)} is not an nkey-U account public key (\`A…\`)`,
    };
  }
  if (accountJwt.length === 0 || !JWT_SHAPE.test(accountJwt)) {
    return {
      status: "refuse",
      reason:
        "leaf package is missing a valid account JWT — `resolver_preload` needs the " +
        "issued account's JWT (pass --account-jwt or set stack.nats_infra.account_jwt).",
    };
  }
  // A SYS account is OPTIONAL, but if one is offered it must be well-formed
  // AND paired with its JWT (a half-specified SYS account would emit a
  // `system_account` line with no preload → nats-server can't resolve it).
  if (systemAccount !== undefined && systemAccount.length > 0) {
    if (!NKEY_ACCOUNT.test(systemAccount)) {
      return {
        status: "refuse",
        reason: `system account ${JSON.stringify(pkg.systemAccount)} is not an nkey-U account public key`,
      };
    }
    if (
      systemAccountJwt === undefined ||
      systemAccountJwt.length === 0 ||
      !JWT_SHAPE.test(systemAccountJwt)
    ) {
      return {
        status: "refuse",
        reason:
          "a system account was offered without a valid system account JWT — " +
          "`resolver_preload` must carry the SYS account's JWT too.",
      };
    }
  }

  // 2) Already operator-mode? Decide between idempotent no-op and clobber-refuse.
  if (natsConfigHasAccountTree(currentConf)) {
    const stripped = stripConfigComments(currentConf);
    const existingOperatorJwt = /^[ \t]*operator[ \t]*[:=][ \t]*(\S+)/m.exec( // operator-mode block line
      stripped,
    );
    // SAME operator JWT already present → this package already converted it.
    // Byte-stable no-op (the orchestrator may skip the write).
    if (existingOperatorJwt?.[1] === operatorJwt) {
      return { status: "already", conf: currentConf };
    }
    // Operator-mode under a DIFFERENT (or unreadable) operator JWT — NEVER clobber.
    return {
      status: "refuse",
      reason:
        "the nats config is ALREADY operator-mode under a different operator — " +
        "refusing to overwrite its account tree. Convert/clean the bus by hand " +
        "or join with the operator that owns this bus (cortex#1053).",
    };
  }

  // 3) Anonymous bus + complete package → render the four §B0.1 blocks.
  // We APPEND them (KEEPING the stack's own identity/ports/JS domain verbatim,
  // and never touching any leafnodes/include). The trailing newline of the
  // source config is normalised so the appended block sits on its own lines.
  const preload: string[] = [
    `  ${account}: ${accountJwt}`,
  ];
  if (systemAccount !== undefined && systemAccount.length > 0) {
    preload.push(`  ${systemAccount}: ${systemAccountJwt ?? ""}`);
  }

  const blocks: string[] = [
    OPERATOR_MODE_MARKER,
    `operator: ${operatorJwt}`,
  ];
  if (systemAccount !== undefined && systemAccount.length > 0) {
    blocks.push(`system_account: ${systemAccount}`);
  }
  // Security-review NIT-2 (#1058) — `resolver_preload:` with the COLON form
  // (not the brace-only `resolver_preload {`): this matches the production hub's
  // `~/.config/nats/local.conf` shape (which uses the colon form), so a converted
  // bus looks identical to a hand-built operator-mode one. Both forms are valid
  // HOCON; we pick the colon form deliberately to match local.conf.
  blocks.push("resolver: MEMORY", "resolver_preload: {", ...preload, "}");
  blocks.push(OPERATOR_MODE_MARKER_END);

  const base = currentConf.replace(/\n+$/, "");
  const conf = `${base}\n\n${blocks.join("\n")}\n`;
  return { status: "converted", conf };
}

/**
 * A JWT shape guard for the operator JWT + account JWTs emitted bare into the config.
 * NSC JWTs are `eyJ…` (a base64url-encoded `{"alg":…}` header) — EXACTLY three
 * base64url segments joined by `.` (header.payload.signature). We require the
 * `eyJ` prefix + exactly two more dot-separated base64url segments (no
 * whitespace/braces/newlines) so a hostile or malformed value cannot break out
 * of the rendered block. (Validated, never cryptographically verified —
 * verification is O-4's handshake.)
 *
 * Security-review NIT-1 (#1058) — `{2}` (exactly two trailing segments), not
 * `{1,2}`: a 2-segment value is not a valid NSC JWT, and accepting one would let
 * nats-server reject it at RUNTIME (bus restart) instead of failing fast here.
 */
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}$/;

// =============================================================================
// O-4b (cortex#1063) — reusable shape guards for the leaf-package consumer.
//
// O-4b's `--from-package` source (network-leaf-package.ts) must fail-fast on a
// malformed package with EXACTLY the same nkey-U / JWT-shape grammar O-3 uses to
// validate before rendering — never a second, drifting copy. The two predicates
// below expose `NKEY_ACCOUNT` / `JWT_SHAPE` (the module-private regexes above)
// as named functions so the consumer reuses them rather than re-deriving the
// grammar. Keeping the regexes private (only the predicates are exported)
// preserves this module as the single source of the grammar.
// =============================================================================

/**
 * True iff `value` is a NATS nkey-U account public key (`A` + 55 base32 chars).
 * The exact grammar {@link renderOperatorModeBlocks} validates the package
 * account/system-account against before emitting it bare into HOCON. (O-4b reuse)
 */
export function isNkeyAccountPubkey(value: string): boolean {
  return NKEY_ACCOUNT.test(value);
}

/**
 * True iff `value` has the NSC JWT shape (`eyJ…` header + exactly three
 * dot-separated base64url segments) {@link renderOperatorModeBlocks} requires of
 * the operator JWT and the account JWTs before emitting them. Validated, never
 * cryptographically verified — verification is O-4's handshake. (O-4b reuse)
 */
export function isNscJwtShape(value: string): boolean {
  return JWT_SHAPE.test(value);
}

/**
 * #821 MAJOR (code-review) — derive the nats-server HTTP MONITOR url from its
 * config, so the post-restart health probe targets THIS bus's monitor port (the
 * community bus monitors on :8224), not a hardcoded :8222. Returns the loopback
 * monitor url (`http://127.0.0.1:<port>`) parsed from the config's `http_port` /
 * `monitor_port` / `http` directive, or `undefined` when none is present (the
 * caller falls back to an explicit `--monitor-url` then the default).
 *
 * We always probe LOOPBACK (`127.0.0.1`) regardless of the bind host the config
 * names (`0.0.0.0`, a LAN ip, a hostname) — the join runs on the same host as
 * nats-server, so loopback is the correct, security-tight probe target; we take
 * only the PORT from the config. Comments are stripped first.
 */
export function natsConfigMonitorUrl(natsConfigText: string): string | undefined {
  const text = stripConfigComments(natsConfigText);

  // `http_port: <n>` / `monitor_port: <n>` — the port-only directives.
  const portDirective = /^[ \t]*(?:http_port|monitor_port)[ \t]*[:=][ \t]*(\d{1,5})\b/m.exec(
    text,
  );
  if (portDirective?.[1] !== undefined) {
    return monitorUrlForPort(portDirective[1]);
  }

  // `http: <value>` — value may be a bare port (`8224`), `host:port`
  // (`0.0.0.0:8224`), or quoted (`"localhost:8224"`), optionally followed by an
  // INLINE trailing comment (`# mon` / `// mon`). Capture the rest of the line,
  // then strip the inline comment + quotes before taking the trailing port.
  // #821 item-3 — without stripping the inline comment the end-anchored port
  // match failed (→ undefined → false-fallback to :8222 → false-trip rollback).
  const httpDirective = /^[ \t]*http[ \t]*[:=][ \t]*(.+)$/m.exec(text);
  if (httpDirective?.[1] !== undefined) {
    const value = stripInlineComment(httpDirective[1]).replace(/["']/g, "").trim();
    // Trailing port: either `:<port>` at the end, or the whole value is a port.
    const portMatch = /(?::|^)(\d{1,5})$/.exec(value);
    if (portMatch?.[1] !== undefined) {
      return monitorUrlForPort(portMatch[1]);
    }
  }

  return undefined;
}

/**
 * Strip a trailing inline `#` or `//` comment from a single config-line value.
 * `0.0.0.0:8224 # mon` → `0.0.0.0:8224`. Conservative: only cuts at a `#` or
 * `//` that is preceded by whitespace or start-of-string, so a `#`/`//` inside a
 * value (unusual for a monitor host:port) is left alone.
 */
function stripInlineComment(value: string): string {
  return value.replace(/(^|[ \t])(#|\/\/).*$/, "").trimEnd();
}

/** Build a loopback monitor url for `port`, or `undefined` if out of range. */
function monitorUrlForPort(port: string): string | undefined {
  const n = Number.parseInt(port, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return undefined;
  return `http://127.0.0.1:${n.toString()}`;
}

/** Serialize one {@link LeafRemote} as a HOCON object literal (indented). */
function serializeRemote(remote: LeafRemote, indent: string): string {
  // `url` + `credentials` are quoted (they contain `:`, `/`, `.` which are
  // HOCON-significant); `account` is a bare nkey-U token (matches the live
  // local.conf, which leaves the account pubkey unquoted).
  //
  // #799 — `account:` is OMITTED entirely for a `$G`/default-bus remote (no
  // account on the binding). A working hand-built `$G` leaf has no `account:`
  // line — the binding rides in the creds JWT — and emitting one would crash
  // nats-server (`cannot find local account "<A…>"`). Only an operator-mode
  // remote (account present) carries the line.
  const lines = [
    `${indent}{`,
    `${indent}  url: ${JSON.stringify(remote.url)}`,
    `${indent}  credentials: ${JSON.stringify(remote.credentials)}`,
  ];
  if (remote.account !== undefined && remote.account.length > 0) {
    lines.push(`${indent}  account: ${remote.account}`);
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

/**
 * Render the per-network include file: a complete `leafnodes { remotes: [...] }`
 * fragment for a single network, self-describing as generated + reversible so
 * a human reading it knows not to hand-edit. Byte-stable for the same inputs
 * (idempotent re-render). S4 writes this to {@link leafIncludeFileName}'s path
 * and composes it into the running config; `leave` deletes it.
 *
 * NOTE: this single-network file is the on-disk unit. When a stack joins
 * multiple networks, the runtime composes the per-network {@link LeafRemote}s
 * via {@link mergeLeafRemotes} into one `remotes[]` array rather than relying
 * on nats-server to merge multiple `leafnodes` blocks (which it does not).
 */
export function renderLeafIncludeFile(
  descriptor: NetworkDescriptor,
  binding: StackLeafBinding,
): string {
  const remote = renderLeafRemote(descriptor, binding);
  return [
    `// GENERATED by cortex network join — leaf remote for network "${remote.network_id}".`,
    `// Do not hand-edit: re-rendered on join, deleted on leave (S3/S4, #737).`,
    `// Idempotency key: network_id = ${remote.network_id}.`,
    "leafnodes {",
    "  remotes: [",
    serializeRemote(remote, "    "),
    "  ]",
    "}",
    "",
  ].join("\n");
}
