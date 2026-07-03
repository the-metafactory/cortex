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
   *
   * OPTIONAL since C-1224 (ADR-0013 Model B): a secret-authenticated leaf
   * ({@link StackLeafBinding.leafSecret}) presents its credential via the dial
   * URL's userinfo, NOT a `.creds` file — so the binding carries no creds path.
   * EITHER `credentials` OR `leafSecret` must be present; `renderLeafRemote`
   * fails loud when neither is.
   */
  credentials?: string;
  /**
   * C-1224 (ADR-0013 Model B, §Decision-1) — the **leaf shared secret** for a
   * secret-authenticated transport-pipe leaf. When present, the leaf remote
   * authenticates to the hub with this secret (the hub's `leafnodes{}` accept
   * block carries the matching `authorization { user, password: <leaf-secret> }`)
   * instead of a `.creds` JWT, and binds the link to a LOCAL NATS account
   * ({@link StackLeafBinding.account}) in the joiner's OWN operator-mode NSC
   * store. No cross-operator JWT trust.
   *
   * The secret is presented to nats-server via the dial URL's **userinfo**
   * (`tls://<user>:<secret>@host:port`) — empirically the ONLY remote-side form
   * nats-server v2.x accepts (a literal `authorization {}` / `username` /
   * `password` field inside a `remotes[]` entry is rejected at config load).
   * User + secret are URL-encoded on serialization so an `@`/`:`/`/` in the
   * secret can never break the authority boundary.
   *
   * SECURITY: a leaf secret is sensitive material (like a `.creds` file). It is
   * folded into the rendered config file's URL only — never into the structured
   * {@link LeafRemote.url} (so status/log surfaces stay secret-free). Keep the
   * rendered `leafnodes-<network>.conf` chmod 600.
   *
   * NOTE: PR4/#1224 only RENDERS a secret already present in config — the secret
   * DISTRIBUTION path (how a joiner obtains it: out-of-band today, the admission
   * gate later) is out of scope here (held PR5).
   */
  leafSecret?: string;
  /**
   * C-1224 — the userinfo USER paired with {@link StackLeafBinding.leafSecret}.
   * Matches the `user` in the hub's `authorization { user, password }` accept
   * block. Required whenever `leafSecret` is set; the caller defaults it to the
   * principal id. Ignored on the `.creds` path.
   */
  leafUser?: string;
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
  /**
   * Fully-qualified leaf dial URL, e.g. `tls://nats.meta-factory.dev:7422`.
   * Always the CLEAN url — userinfo for a secret-authenticated leaf
   * ({@link LeafRemote.secretAuth}) is NOT spliced in here; it is added only at
   * serialization time so the structured remote (status/logging) stays
   * secret-free. (C-1224)
   */
  url: string;
  /**
   * Absolute path to the `.creds` file (leaf auth). Present for the JWT-creds
   * path; ABSENT for a secret-authenticated leaf ({@link LeafRemote.secretAuth}),
   * whose credential is the URL userinfo. (C-1224 made this optional.)
   */
  credentials?: string;
  /**
   * The local NATS account (nkey-U) the leaf binds to — present ONLY in
   * operator-mode (#799). Absent (`undefined`) for a `$G`/default bus, where
   * the account binding rides in the `.creds` JWT and an `account:` line would
   * crash nats-server. When absent, {@link serializeRemote} omits the line.
   *
   * For a secret-authenticated leaf (C-1224, Model B) this is the principal's
   * OWN local federation account — the leaf binds it locally while the secret
   * authenticates the pipe. Present whenever the bus is operator-mode.
   */
  account?: string;
  /**
   * C-1224 (ADR-0013 Model B) — secret-auth material for a transport-pipe leaf.
   * Present ⇒ {@link serializeRemote} splices `user:secret` (URL-encoded) into
   * the dial URL's userinfo and emits NO `credentials:` line. Absent ⇒ the
   * JWT-creds path. Mutually exclusive with {@link LeafRemote.credentials}.
   */
  secretAuth?: { user: string; secret: string };
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

  // #799 — the account is OPTIONAL. When absent/empty the remote is rendered
  // WITHOUT an `account:` line (the `$G`/default-bus mode — binding rides in the
  // creds JWT / the secret-auth pipe). When present it must be a valid nkey-U:
  // it is emitted BARE (unquoted) into HOCON (matching local.conf), so anything
  // outside the nkey-U grammar could break out of the remotes[] block and inject
  // directives.
  const account = binding.account?.trim();
  const accountIsSet = account !== undefined && account.length > 0;
  if (accountIsSet && !NKEY_ACCOUNT.test(account)) {
    throw new Error(
      `leaf-remote-renderer: account for network "${descriptor.network_id}" is not a valid nkey-U account public key (expected ${NKEY_ACCOUNT}); got ${JSON.stringify(binding.account)}`,
    );
  }

  // C-1224 (ADR-0013 Model B) — SECRET-AUTH path. When the binding carries a
  // leaf secret, the leaf authenticates via URL userinfo (the secret-auth pipe),
  // NOT a `.creds` file. It still binds the principal's OWN local `account` (when
  // operator-mode). Mutually exclusive with the creds path: the secret wins (a
  // Model-B join carries no creds).
  const leafSecret = binding.leafSecret?.trim();
  if (leafSecret !== undefined && leafSecret.length > 0) {
    const leafUser = binding.leafUser?.trim();
    if (leafUser === undefined || leafUser.length === 0) {
      throw new Error(
        `leaf-remote-renderer: a leaf secret was supplied for network "${descriptor.network_id}" without a leaf user — secret-auth needs the userinfo USER that matches the hub's \`authorization { user, password }\` (set stack.nats_infra.leaf_user or pass --leaf-user; it defaults to the principal id)`,
      );
    }
    return {
      network_id: descriptor.network_id,
      url: resolveLeafUrl(descriptor),
      ...(accountIsSet && { account }),
      secretAuth: { user: leafUser, secret: leafSecret },
    };
  }

  // CREDS path — require an absolute creds file (the JWT-auth leaf).
  const credentials = binding.credentials?.trim();
  if (credentials === undefined || credentials.length === 0 || !credentials.startsWith("/")) {
    throw new Error(
      `leaf-remote-renderer: leaf binding for network "${descriptor.network_id}" needs either an absolute \`.creds\` path or a leaf secret — credentials must be an absolute path, got ${JSON.stringify(binding.credentials)}`,
    );
  }

  return {
    network_id: descriptor.network_id,
    url: resolveLeafUrl(descriptor),
    credentials,
    ...(accountIsSet && { account }),
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
  /** The issued account public key (nkey-U, `A…`) the leaf binds to (FED). */
  account: string;
  /** The issued account's JWT (`eyJ…`) — preloaded under `resolver_preload`. */
  accountJwt: string;
  /** OPTIONAL system account public key (nkey-U). Sets `system_account`. */
  systemAccount?: string;
  /** OPTIONAL system account JWT — preloaded alongside the issued account. */
  systemAccountJwt?: string;
  /**
   * cortex#1480 (join-1, epic #1479) — the stack's own per-stack AGENTS
   * account (`stack.nats_infra.agents_account`, ADR-0012 isolation),
   * OPTIONAL. When present (together with {@link
   * OperatorModeLeafPackage.agentsAccountJwt}), {@link renderOperatorModeBlocks}
   * preloads it ALONGSIDE the FED account (and SYS, if any) so ONE render
   * produces a `resolver_preload` carrying every account the stack actually
   * uses. Closes the gap where a bus's AGENTS account got preloaded (by
   * make-live's always-run per-account append) while its FED account never
   * did (historically only rendered on a truly-from-scratch bootstrap) —
   * producing the "does not define account <FED>" fail-closed on join.
   * Absent for callers with no AGENTS material (e.g. `cortex network join`,
   * which only ever needs FED/SYS).
   */
  agentsAccount?: string;
  /**
   * cortex#1480 — the AGENTS account's JWT, paired with {@link
   * OperatorModeLeafPackage.agentsAccount}. Required whenever `agentsAccount`
   * is set (mirrors the {@link OperatorModeLeafPackage.systemAccount} /
   * {@link OperatorModeLeafPackage.systemAccountJwt} pairing rule).
   */
  agentsAccountJwt?: string;
}

/**
 * The outcome of {@link renderOperatorModeBlocks}:
 *   - `converted` — either the config was anonymous (the operator-mode blocks
 *     were rendered from scratch), OR it was ALREADY operator-mode under this
 *     package's operator but missing one or more of the accounts the package
 *     carries (cortex#1480 — those missing accounts were appended into the
 *     EXISTING `resolver_preload` block). Either way `conf` is what the
 *     orchestrator writes.
 *   - `already` — the config is ALREADY operator-mode under THIS package's
 *     operator JWT AND already preloads every account the package carries;
 *     `conf` is the unchanged bytes (a byte-stable no-op).
 *   - `refuse` — cannot convert: material absent/malformed, the config is
 *     already operator-mode under a DIFFERENT operator (never clobber it), or
 *     it is operator-mode with no locatable `resolver_preload { … }` block to
 *     append a missing account into.
 */
export type OperatorModeConversion =
  | { status: "converted"; conf: string }
  | { status: "already"; conf: string }
  | { status: "refuse"; reason: string };

/** A marker line so a reader of the converted config knows join wrote it. */
const OPERATOR_MODE_MARKER =
  "// --- operator-mode blocks rendered by cortex network join (O-3, #1053) ---";
const OPERATOR_MODE_MARKER_END =
  "// --- end operator-mode blocks ---";

/**
 * cortex#1480 — the shared "an OPTIONAL package account must be well-formed AND
 * paired with its JWT" validator, used for BOTH the SYS and AGENTS package
 * accounts (a half-specified account would emit a preload / `system_account`
 * line the server can't resolve). Absent (undefined/empty) pubkey ⇒ ok (the
 * account is optional). Extracted so the two rules cannot drift.
 */
function validateOptionalPackageAccount(
  short: "SYS" | "AGENTS",
  pubkey: string | undefined,
  jwt: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (pubkey === undefined || pubkey.length === 0) return { ok: true };
  const noun = short === "SYS" ? "system account" : "agents account";
  if (!NKEY_ACCOUNT.test(pubkey)) {
    return { ok: false, reason: `${noun} ${JSON.stringify(pubkey)} is not an nkey-U account public key` };
  }
  if (jwt === undefined || jwt.length === 0 || !JWT_SHAPE.test(jwt)) {
    return {
      ok: false,
      reason:
        `${short === "SYS" ? "a" : "an"} ${noun} was offered without a valid ${noun} JWT — ` +
        `\`resolver_preload\` must carry the ${short} account's JWT too.`,
    };
  }
  return { ok: true };
}

/**
 * cortex#1480 — true iff `natsConfigText` carries a top-level `system_account:`
 * directive (comments stripped, so a commented-out one does not count).
 */
function hasSystemAccountDirective(natsConfigText: string): boolean {
  return /^[ \t]*system_account[ \t]*[:=]/m.test(stripConfigComments(natsConfigText));
}

/**
 * cortex#1480 — append a top-level `system_account: <pubkey>` directive. The
 * pubkey is a validated nkey-U (emitted bare, matching the from-scratch render).
 */
function appendSystemAccountDirective(natsConfigText: string, sysPubkey: string): string {
  const base = natsConfigText.replace(/\n+$/, "");
  return `${base}\nsystem_account: ${sysPubkey}\n`;
}

/**
 * Insert `insertion` immediately before the closing brace of the
 * `resolver_preload { … }` block in `text`. Uses a brace-matched scan so a
 * nested object inside the block can't confuse the close detection. Returns the
 * new text, or null when no resolver_preload block is found.
 *
 * cortex#1480 (join-1, epic #1479) — lives here (rather than
 * network-make-live-adapters.ts, its original home) so {@link
 * renderOperatorModeBlocks} can reuse it PURELY when ENSURING a missing
 * account into an ALREADY operator-mode config (the "same operator, missing
 * account" branch) — the same text-splice make-live's `appendAccount` adapter
 * already used for the AGENTS account, now the single source for BOTH join's
 * O-3 conversion path and make-live's bootstrap/ensure path.
 * `network-make-live-adapters.ts` re-exports this name so its existing
 * importers are unaffected.
 */
export function insertIntoResolverPreload(text: string, insertion: string): string | null {
  const key = /resolver_preload\s*[:=]?\s*\{/.exec(text);
  if (key === null) return null;
  const open = key.index + key[0].length - 1; // index of the `{`
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        // Insert before this closing brace (which sits at column 0 of its line).
        const lineStart = text.lastIndexOf("\n", i) + 1;
        return text.slice(0, lineStart) + insertion + text.slice(lineStart);
      }
    }
  }
  return null; // unbalanced braces — refuse to edit
}

/**
 * Render the SOP §B0.1 operator-mode blocks INTO `currentConf` from a leaf
 * package. PURE (text in, text out): no filesystem, no daemon. The orchestrator
 * (network-lib joinNetwork) calls this through the LeafFilePort, decides whether
 * to write the result, then proceeds with the existing leaf-remote render.
 *
 * Conversion rules:
 *   - **anonymous bus + complete package** → `converted`: append the four blocks
 *     (operator + optional system_account + resolver + resolver_preload for
 *     FED [+ AGENTS, if the package carries one] [+ SYS]), KEEPING the stack's
 *     own identity/ports/JS domain verbatim, NOT touching any `leafnodes`/
 *     `include` (the join renders its own per-network leaf).
 *   - **already operator-mode under THIS operator, every package account
 *     already preloaded** → `already` (idempotent no-op: re-running a
 *     converted bus must not duplicate or drift).
 *   - **already operator-mode under THIS operator, but MISSING one or more of
 *     the package's accounts** (cortex#1480) → `converted`: append ONLY the
 *     missing `<pubkey>: <jwt>` entries into the EXISTING `resolver_preload`
 *     block. This is the fix for the real "does not define account <FED>"
 *     fail-closed: a bus bootstrapped before its FED account existed (or
 *     hand-converted carrying only AGENTS) stayed "already operator-mode"
 *     forever under the old operator-JWT-only check, so FED was never
 *     preloaded. Presence is checked with {@link natsConfigCanBindAccount} —
 *     the SAME token-boundary-safe check #794 uses — so a merely-embedded or
 *     comment-only mention never counts as "already there".
 *   - **already operator-mode under a DIFFERENT operator** → `refuse`: never
 *     clobber a bus standing on someone else's account tree.
 *   - **already operator-mode under THIS operator but no `resolver_preload`
 *     block can be located to append a missing account into** → `refuse` with
 *     an actionable reason (never silently drop the missing account).
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
  const agentsAccount = pkg.agentsAccount?.trim();
  const agentsAccountJwt = pkg.agentsAccountJwt?.trim();

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
  // A SYS and an AGENTS account are each OPTIONAL, but if one is offered it must
  // be well-formed AND paired with its JWT (a half-specified account would emit a
  // preload / `system_account` line nats-server can't resolve). One shared
  // validator so the two rules can't drift (cortex#1480).
  const sysValid = validateOptionalPackageAccount("SYS", systemAccount, systemAccountJwt);
  if (!sysValid.ok) return { status: "refuse", reason: sysValid.reason };
  const agentsValid = validateOptionalPackageAccount("AGENTS", agentsAccount, agentsAccountJwt);
  if (!agentsValid.ok) return { status: "refuse", reason: agentsValid.reason };

  // The accounts THIS package wants preloaded — FED always, AGENTS/SYS when
  // the package carries them. Shared by BOTH the "already, ensure missing"
  // branch (2) and the "anonymous, render from scratch" branch (3) below so
  // the two paths can never preload a different account set.
  const wantedAccounts: { label: string; pubkey: string; jwt: string }[] = [
    { label: "FED", pubkey: account, jwt: accountJwt },
  ];
  if (agentsAccount !== undefined && agentsAccount.length > 0) {
    wantedAccounts.push({ label: "AGENTS", pubkey: agentsAccount, jwt: agentsAccountJwt ?? "" });
  }
  if (systemAccount !== undefined && systemAccount.length > 0) {
    wantedAccounts.push({ label: "SYS", pubkey: systemAccount, jwt: systemAccountJwt ?? "" });
  }

  // 2) Already operator-mode? Decide between idempotent no-op, an ENSURE of any
  // MISSING package account, and a clobber-refuse.
  if (natsConfigHasAccountTree(currentConf)) {
    const stripped = stripConfigComments(currentConf);
    const existingOperatorJwt = /^[ \t]*operator[ \t]*[:=][ \t]*(\S+)/m.exec( // operator-mode block line
      stripped,
    );
    if (existingOperatorJwt?.[1] === operatorJwt) {
      // SAME operator JWT already present. cortex#1480 — that alone is NOT
      // sufficient to call it "already done": a bus bootstrapped before its
      // FED account existed (or hand-converted carrying only AGENTS) is
      // STILL operator-mode under the SAME operator, yet resolver_preload may
      // be missing one or more of the accounts THIS package carries. Presence
      // is checked with natsConfigCanBindAccount — the SAME token-boundary-safe
      // check #794 uses — so a merely-embedded or comment-only mention never
      // counts as "present".
      const missing = wantedAccounts.filter(
        (w) => !natsConfigCanBindAccount(currentConf, w.pubkey).canBind,
      );
      // cortex#1480 — an operator-mode config needs BOTH the SYS account
      // PRELOADED (resolver_preload) AND a top-level `system_account: <SYS>`
      // directive naming it: the preload lets nats-server RESOLVE the account,
      // the directive tells it to USE that account as the system account (the
      // `docs/config-layout/nats-server.conf.example` template documents both as
      // required together for a JetStream bus). The from-scratch branch (3) below
      // emits both, so this ensure-branch must match — otherwise a config that
      // gains its SYS account here would know the account but never treat it as
      // the system account. Add the directive idempotently: only when the package
      // carries a SYS and the config has no `system_account:` directive yet
      // (never clobber an existing one).
      const sysDirectiveNeeded =
        systemAccount !== undefined &&
        systemAccount.length > 0 &&
        !hasSystemAccountDirective(currentConf);
      if (missing.length === 0 && !sysDirectiveNeeded) {
        // Byte-stable no-op (the orchestrator may skip the write).
        return { status: "already", conf: currentConf };
      }
      let next = currentConf;
      if (missing.length > 0) {
        // One terse provenance marker for the whole appended run — this writes
        // into the caller's LIVE nats config, so no per-line commentary.
        const insertion =
          "  // added by cortex network join/make-live (cortex#1480)\n" +
          missing.map((w) => `  ${w.pubkey}: ${w.jwt}\n`).join("");
        const inserted = insertIntoResolverPreload(next, insertion);
        if (inserted === null) {
          return {
            status: "refuse",
            reason:
              "the nats config is operator-mode under this operator but has no " +
              "resolver_preload { … } block to add the missing account(s) into " +
              `(${missing.map((w) => `${w.label} ${w.pubkey}`).join(", ")}) — convert/repair the ` +
              "bus by hand (docs/sop-stack-onboarding.md §B0.1).",
          };
        }
        next = inserted;
      }
      if (sysDirectiveNeeded) {
        // sysDirectiveNeeded ⇒ systemAccount is defined (TS narrows the aliased
        // const condition), so no non-null assertion is needed.
        next = appendSystemAccountDirective(next, systemAccount);
      }
      return { status: "converted", conf: next };
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
  const preload: string[] = wantedAccounts.map((w) => `  ${w.pubkey}: ${w.jwt}`);

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
 * cortex#1265 (PR8) — the minimal per-stack nats-server **base** identity used to
 * synthesise a hard-isolated bus config when none exists yet, so make-live can
 * bootstrap the operator-mode blocks onto it (see {@link renderBaseIsolatedConfig}).
 *
 * Every field is DERIVED from the stack's own config (never fabricated): `listen`
 * is the host:port the stack's own daemon already dials (`nats.url`), and the
 * names are the canonical `<slug>-<principal>` identity. This is the distinction
 * the make-live adapter holds onto — it synthesises a base from the stack's OWN
 * declared truth, it does NOT invent an arbitrary (collision-prone) server.
 */
export interface NatsBaseIdentity {
  /** `server_name` + jetstream `domain` — canonically `<slug>-<principal>`. */
  serverName: string;
  /** `listen` host:port — the stack's own `nats.url` minus the scheme. */
  listen: string;
  /** jetstream `store_dir` — canonically `~/.config/nats/<slug>-jetstream`. */
  jetstreamStoreDir: string;
}

/**
 * Parse a stack's own `nats.url` into a SAFE loopback `host:port` for a
 * synthesised hard-isolated base `listen` (cortex#1265). Returns `undefined` when
 * the URL is absent, malformed, carries userinfo/a path, names a non-numeric or
 * out-of-range port, or resolves to a NON-loopback host — so the make-live caller
 * DECLINES to synthesise and falls back to its refuse-floor (you supply
 * `--nats-config` or fix `nats.url`) instead of binding an over-exposed
 * (`0.0.0.0`) or unbindable address that would only fail at nats-server start.
 *
 * Security (review #1302): a from-scratch isolated bus MUST bind loopback only —
 * the whole point is a private, process-local bus (cortex#692). Allowlist
 * `127.0.0.1` / `localhost` / `::1`; reject everything else (incl. `0.0.0.0`,
 * `::`, any routable host). Stricter than the old "strip the scheme" derivation,
 * which would have passed a non-loopback `nats.url` straight through.
 */
export function parseLoopbackListen(natsUrl: string | undefined): string | undefined {
  if (natsUrl === undefined) return undefined;
  const stripped = natsUrl.replace(/^(?:nats|tls):\/\//, "").trim();
  // userinfo (`user:pass@`) or a path/query are not valid in a bare `host:port`.
  if (stripped === "" || stripped.includes("@") || stripped.includes("/")) return undefined;

  let host: string;
  let port: string;
  const v6 = /^\[([0-9a-fA-F:]+)\]:(\d+)$/.exec(stripped);
  if (v6 !== null) {
    host = v6[1] ?? "";
    port = v6[2] ?? "";
  } else {
    const idx = stripped.lastIndexOf(":");
    if (idx <= 0) return undefined; // need a `host:port`
    host = stripped.slice(0, idx);
    port = stripped.slice(idx + 1);
  }
  if (!/^\d+$/.test(port)) return undefined;
  const portNum = Number(port);
  if (portNum < 1 || portNum > 65535) return undefined;

  const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!LOOPBACK.has(host)) return undefined;
  return host === "::1" ? `[::1]:${portNum}` : `${host}:${portNum}`;
}

/**
 * Render the SOP §B0.1 **hard-isolated base** nats-server config from a stack's
 * own derived identity. PURE (data in, text out). Emits exactly the isolation-wall
 * base — `server_name` / `listen` / `jetstream { store_dir, domain }` — and
 * DELIBERATELY no `leafnodes` / `cluster` / `gateway` block (that absence IS the
 * isolation wall, cortex#692; a spoke stack needs no accept block — `cortex
 * network join` renders its own per-network leaf REMOTE include later). No `http`
 * monitor either: it is optional for nats-server and has no collision-safe source
 * to derive (you pick a non-colliding `82xx` by hand if you want one).
 *
 * The result is a complete, nats-server-loadable anonymous bus; make-live then
 * appends the operator-mode blocks via {@link renderOperatorModeBlocks} to make
 * it operator-mode. `listen` is HOCON-quoted; it is derived from the stack's own
 * `nats.url`, never attacker-controlled, but quoting keeps a stray space/`#` from
 * breaking the line.
 */
export function renderBaseIsolatedConfig(identity: NatsBaseIdentity): string {
  const serverName = identity.serverName.trim();
  const listen = identity.listen.trim();
  const storeDir = identity.jetstreamStoreDir.trim();
  return [
    "// --- hard-isolated base config rendered by cortex network make-live (cortex#1265) ---",
    `server_name: "${serverName}"`,
    `listen: "${listen}"`,
    "jetstream {",
    `  store_dir: "${storeDir}"`,
    "  max_mem: 64mb",
    "  max_file: 1gb",
    `  domain: "${serverName}"`,
    "}",
    "// NO leafnodes{} / cluster{} / gateway{} — that absence IS the isolation wall (cortex#692).",
    "// `cortex network join` renders this stack's per-network leaf REMOTE include itself.",
    "",
  ].join("\n");
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
 * cortex#1495 v2/v3 — the parsed nats-server CLIENT listen address (HOST + PORT).
 * `host` is the RAW host as written in the config (`""` when only a bare port was
 * given); the caller maps a wildcard/empty host to the right loopback for the
 * connect (v3 important: probing a hardcoded `127.0.0.1` would false-rollback a
 * bus that listens on a specific non-loopback address like `10.0.0.5:4222`).
 */
export interface NatsClientListen {
  /** Raw listen host (`10.0.0.5`, `0.0.0.0`, `::`, `localhost`, or `""` for a bare port). */
  host: string;
  /** Client listen port. */
  port: number;
}

/**
 * cortex#1495 v2/v3 — parse the nats-server CLIENT listen HOST+PORT from a config,
 * so a bus with NO HTTP monitor can still be liveness-probed by a plain TCP
 * connect to its client listen address (the #1476 community bus class: no
 * `http_port`, so the `/healthz` probe was inconclusive and auto-rollback went
 * inert). Order:
 *   1. `listen: <host:port | [ipv6]:port | port>` (the explicit listen directive), then
 *   2. `port: <n>` (+ optional top-level `host:`) — the split-directive form.
 * Returns `{ host, port }`, or `undefined` when neither is present (the caller
 * then applies the NATS default `127.0.0.1:4222`, or — if the config is unreadable
 * — falls back to the inconclusive-healthy disclosure). Comments are stripped
 * first; only a line-anchored `port`/`host` matches, so `http_port`/`monitor_port`
 * never false-hit.
 */
export function natsConfigClientListen(natsConfigText: string): NatsClientListen | undefined {
  const text = stripConfigComments(natsConfigText);

  // `listen: <value>` — value may be `host:port` (`10.0.0.5:4222`), bracketed
  // IPv6 (`[::]:4222`), a bare port, or quoted, optionally with an inline comment.
  const listen = /^[ \t]*listen[ \t]*[:=][ \t]*(.+)$/m.exec(text);
  if (listen?.[1] !== undefined) {
    const value = stripInlineComment(listen[1]).replace(/["']/g, "").trim();
    const hp = splitHostPort(value);
    if (hp !== undefined) return hp;
  }

  // `port: <n>` — the top-level client-port directive (line-anchored so it never
  // matches `http_port`/`monitor_port`, which start with a different token). Pair
  // it with an optional top-level `host:` directive when present.
  const port = /^[ \t]*port[ \t]*[:=][ \t]*(\d{1,5})\b/m.exec(text);
  if (port?.[1] !== undefined) {
    const hostDirective = /^[ \t]*host[ \t]*[:=][ \t]*(.+)$/m.exec(text);
    const host =
      hostDirective?.[1] !== undefined
        ? stripInlineComment(hostDirective[1]).replace(/["']/g, "").trim()
        : "";
    return { host, port: Number.parseInt(port[1], 10) };
  }

  return undefined;
}

/**
 * Split a listen VALUE into `{ host, port }`. Handles bracketed IPv6
 * (`[::]:4222`), `host:port` with a single colon (IPv4 / hostname), and a bare
 * port (host `""`). Returns `undefined` when no port can be recovered.
 */
function splitHostPort(value: string): NatsClientListen | undefined {
  // Bracketed IPv6 + port: `[::]:4222`, `[::1]:4222`, `[2001:db8::1]:4222`.
  const bracket = /^\[([^\]]+)\]:(\d{1,5})$/.exec(value);
  if (bracket?.[1] !== undefined && bracket[2] !== undefined) {
    return { host: bracket[1], port: Number.parseInt(bracket[2], 10) };
  }
  // `host:port` with exactly one colon (IPv4 / hostname) — reject a bare
  // multi-colon IPv6 without brackets (ambiguous; NATS uses the bracketed form).
  const hostPort = /^(.+):(\d{1,5})$/.exec(value);
  if (hostPort?.[1] !== undefined && hostPort[2] !== undefined && !hostPort[1].includes(":")) {
    return { host: hostPort[1], port: Number.parseInt(hostPort[2], 10) };
  }
  // Bare port — no host specified.
  if (/^\d{1,5}$/.test(value)) return { host: "", port: Number.parseInt(value, 10) };
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

/**
 * C-1224 (ADR-0013 Model B) — splice `user:secret` into a clean dial URL's
 * userinfo, URL-encoding both components so an `@`/`:`/`/`/space in the secret
 * cannot break the authority boundary (and so nats-server — Go `url.Parse`,
 * which DECODES userinfo — recovers the exact secret). This is the ONLY
 * remote-side form nats-server v2.x accepts for user/password leaf auth (a
 * literal `authorization {}` / `username` / `password` field inside a remote is
 * rejected at config load — verified empirically).
 */
function buildSecretAuthUrl(url: string, user: string, secret: string): string {
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(secret);
  return u.toString();
}

/** Serialize one {@link LeafRemote} as a HOCON object literal (indented). */
function serializeRemote(remote: LeafRemote, indent: string): string {
  // `url` + `credentials` are quoted (they contain `:`, `/`, `.` which are
  // HOCON-significant); `account` is a bare nkey-U token (matches the live
  // local.conf, which leaves the account pubkey unquoted).
  //
  // C-1224 — for a SECRET-AUTH leaf the credential rides in the URL userinfo
  // (`tls://user:secret@host:port`), so the emitted `url` carries it and there
  // is NO `credentials:` line. For the JWT-creds leaf the `url` is clean and a
  // `credentials:` line points at the `.creds` file. Exactly one of the two.
  const emittedUrl =
    remote.secretAuth !== undefined
      ? buildSecretAuthUrl(remote.url, remote.secretAuth.user, remote.secretAuth.secret)
      : remote.url;

  const lines = [
    `${indent}{`,
    `${indent}  url: ${JSON.stringify(emittedUrl)}`,
  ];
  if (remote.credentials !== undefined && remote.credentials.length > 0) {
    lines.push(`${indent}  credentials: ${JSON.stringify(remote.credentials)}`);
  }
  // #799 — `account:` is OMITTED entirely for a `$G`/default-bus remote (no
  // account on the binding). A working hand-built `$G` leaf has no `account:`
  // line — the binding rides in the creds JWT — and emitting one would crash
  // nats-server (`cannot find local account "<A…>"`). Only an operator-mode
  // remote (account present) carries the line. A Model-B secret-auth leaf on an
  // operator-mode bus carries BOTH the userinfo secret AND the local `account:`.
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
