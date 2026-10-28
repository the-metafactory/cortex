/**
 * ADR-0018 PR5b (#1240) — hub-side leaf `authorization` user management (PURE).
 *
 * The hub end of the per-member leaf PSK (ADR-0018 Q2). A member's nats-server
 * leaf authenticates to the hub by presenting `user:secret` in the dial URL
 * userinfo (rendered by `leaf-remote-renderer.ts`); the hub matches it against
 * a `leafnodes { authorization { users: [{ user, password }] } }` entry. This
 * module is the pure text transform that ADDS / REMOVES one such per-member
 * entry on the hub's config — the hub-admin authority (Q5).
 *
 * ## Why a cortex-managed marker region (not free HOCON surgery)
 *
 * nats-server has exactly ONE `leafnodes {}` block (two do not merge — see
 * `leaf-remote-renderer.ts` §"include-file vs in-place merge"). So the per-member
 * users CANNOT live in a separate included file; they must edit the live
 * `leafnodes.authorization.users` array. To keep that edit idempotent + reversible
 * + safe, cortex owns a MARKER-DELIMITED region inside the leafnodes block:
 *
 *     leafnodes {
 *       # >>> cortex-managed leaf authorization (network secret tooling) — do not hand-edit
 *       authorization {
 *         users: [
 *           { user: "alice", password: "…" }
 *         ]
 *       }
 *       # <<< cortex-managed leaf authorization
 *       …the hub's own leafnodes directives (listen, tls, …) untouched…
 *     }
 *
 * The functions parse the managed region's entries into a map keyed by `user`,
 * mutate one entry, and re-render — so add/remove/rotate are idempotent and a
 * remove of the last entry tears the region down to nothing. The hub's own
 * own `leafnodes` directives (listen/tls/etc.) are never touched.
 *
 * ## Injection safety
 *
 * Both `user` and `password` are emitted as JSON-quoted HOCON strings, and the
 * `user` is validated against a strict grammar before it is ever written, so a
 * value carrying `"`/`{`/`}`/newline can never break out of the `users[]` array
 * and inject nats-server directives. The PSK is base64url (see `leaf-psk.ts`),
 * so quoting is belt-and-braces. The password value is NEVER logged by callers.
 *
 * Pure: text in, text out. The live file read/write + the SIGHUP reload are the
 * adapter's job (`network-secret-adapters.ts`).
 */

/** Leaf `user` grammar — the userinfo USER (defaults to the principal id). */
const LEAF_USER_RE = /^[a-z][a-z0-9_-]*$/;

const MANAGED_START =
  "# >>> cortex-managed leaf authorization (network secret tooling) — do not hand-edit";
const MANAGED_END = "# <<< cortex-managed leaf authorization";

/**
 * True iff `conf` carries the cortex-managed leaf authorization region (both
 * markers, start before end). The join/doctor crash-bomb guard uses it to name
 * the tool that wrote a block it refuses (cortex#2747).
 */
export function hasManagedLeafAuthorizationRegion(conf: string): boolean {
  return extractManagedRegion(conf) !== undefined;
}

/** One hub leaf-authorization user entry. */
export interface HubLeafUser {
  user: string;
  /** The PSK (base64url). The matching `password` in the hub config. */
  secret: string;
}

/**
 * Thrown when the hub config carries a NON-cortex-managed `authorization {}`
 * block inside `leafnodes` — we refuse to clobber a hand-written one.
 */
export class HubAuthConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubAuthConflictError";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return `conf` with the leaf `authorization` user `user` ⇒ `secret` ensured
 * (added or replaced). Idempotent: re-rendering the same (user, secret) is a
 * byte-stable no-op once present; a new secret for an existing user REPLACES it
 * (rotate). Validates `user`; throws on a malformed user or a hand-written
 * (non-managed) `authorization` block inside leafnodes.
 */
export function upsertHubLeafUser(conf: string, user: string, secret: string): string {
  assertValidUser(user);
  if (secret.length === 0) {
    throw new Error("hub-leaf-authorization: refusing to write an empty leaf secret");
  }
  const users = parseManagedUsers(conf);
  const next = users.filter((u) => u.user !== user);
  next.push({ user, secret });
  next.sort((a, b) => a.user.localeCompare(b.user)); // deterministic order
  return writeManagedUsers(conf, next);
}

/**
 * Return `conf` with the leaf `authorization` user `user` REMOVED. Idempotent:
 * removing an absent user is a no-op. Removing the last user tears the managed
 * region down (leaving the hub's own leafnodes directives intact).
 */
export function removeHubLeafUser(conf: string, user: string): string {
  // No grammar assertion on remove — a caller cleaning up a legacy/odd user id
  // should still be able to drop it.
  const users = parseManagedUsers(conf);
  if (!users.some((u) => u.user === user)) return conf; // idempotent no-op
  const next = users.filter((u) => u.user !== user);
  return writeManagedUsers(conf, next);
}

/** True iff the hub config carries a cortex-managed leaf user named `user`. */
export function hubLeafUserPresent(conf: string, user: string): boolean {
  return parseManagedUsers(conf).some((u) => u.user === user);
}

/** Read the cortex-managed leaf users from a hub config (for status/tests). */
export function listHubLeafUsers(conf: string): HubLeafUser[] {
  return parseManagedUsers(conf);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function assertValidUser(user: string): void {
  if (!LEAF_USER_RE.test(user)) {
    throw new Error(
      `hub-leaf-authorization: leaf user ${JSON.stringify(user)} must be letter-prefixed lowercase (${LEAF_USER_RE})`,
    );
  }
}

/**
 * Locate the cortex-managed region (between the markers) and parse its user
 * entries. Returns [] when no managed region exists yet.
 */
function parseManagedUsers(conf: string): HubLeafUser[] {
  const region = extractManagedRegion(conf);
  if (region === undefined) return [];
  const users: HubLeafUser[] = [];
  // Each entry is rendered `{ user: "x", password: "y" }`. The values cortex
  // writes (grammar-checked user, base64url PSK) never contain `"`, so a
  // non-greedy quoted-capture is exact for our own shape.
  const re = /\{\s*user:\s*"([^"]*)",\s*password:\s*"([^"]*)"\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region)) !== null) {
    users.push({ user: m[1] ?? "", secret: m[2] ?? "" });
  }
  return users;
}

/** The text between the managed markers (exclusive), or undefined if absent. */
function extractManagedRegion(conf: string): string | undefined {
  const start = conf.indexOf(MANAGED_START);
  if (start < 0) return undefined;
  const end = conf.indexOf(MANAGED_END, start);
  if (end < 0) return undefined;
  return conf.slice(start + MANAGED_START.length, end);
}

/** Render the managed region body (markers + authorization block) at `indent`. */
function renderManagedRegion(users: HubLeafUser[], indent: string): string {
  const inner = `${indent}  `;
  const userInner = `${inner}    `;
  const lines = [
    `${indent}${MANAGED_START}`,
    `${inner}authorization {`,
    `${inner}  users: [`,
    ...users.map(
      (u) => `${userInner}{ user: ${JSON.stringify(u.user)}, password: ${JSON.stringify(u.secret)} }`,
    ),
    `${inner}  ]`,
    `${inner}}`,
    `${indent}${MANAGED_END}`,
  ];
  return lines.join("\n");
}

/**
 * Write the managed user set back into `conf`, creating the leafnodes block /
 * managed region as needed. When `users` is empty the managed region is removed
 * entirely (and an empty leafnodes block cortex itself created is cleaned up).
 */
function writeManagedUsers(conf: string, users: HubLeafUser[]): string {
  const hasRegion = extractManagedRegion(conf) !== undefined;

  // Empty set → drop the region.
  if (users.length === 0) {
    if (!hasRegion) return conf;
    return stripManagedRegion(conf);
  }

  const region = renderManagedRegion(users, "  ");

  if (hasRegion) {
    // Replace the existing managed region (markers inclusive) in place.
    const start = conf.indexOf(MANAGED_START);
    const endMarker = conf.indexOf(MANAGED_END, start);
    const end = endMarker + MANAGED_END.length;
    // Preserve the leading indentation already on the start-marker line.
    const lineStart = conf.lastIndexOf("\n", start) + 1;
    const leading = conf.slice(lineStart, start);
    const renderedNoLeadFirst = region.replace(/^ {2}/, ""); // region rendered at indent "  "
    return conf.slice(0, lineStart) + leading + renderedNoLeadFirst + conf.slice(end);
  }

  // No managed region yet — find / create the leafnodes block and insert it.
  const leaf = findLeafnodesBlock(conf);
  if (leaf === undefined) {
    // No leafnodes block at all → append a fresh one carrying only our region.
    const base = conf.replace(/\n*$/, "");
    const prefix = base.length === 0 ? "" : `${base}\n\n`;
    return `${prefix}leafnodes {\n${region}\n}\n`;
  }

  // A leafnodes block exists. Refuse to collide with a hand-written authorization.
  if (hasNonManagedAuthorization(conf, leaf)) {
    throw new HubAuthConflictError(
      "hub-leaf-authorization: the hub config's `leafnodes` block already has a hand-written " +
        "`authorization {}` — refusing to clobber it. Remove or convert it to the cortex-managed " +
        "marker region first.",
    );
  }

  // Insert the managed region just after the leafnodes opening brace.
  const insertAt = leaf.openBraceIndex + 1;
  return conf.slice(0, insertAt) + `\n${region}` + conf.slice(insertAt);
}

/** Remove the managed region (markers inclusive) + a leafnodes block cortex left empty. */
function stripManagedRegion(conf: string): string {
  const start = conf.indexOf(MANAGED_START);
  const endMarker = conf.indexOf(MANAGED_END, start);
  if (start < 0 || endMarker < 0) return conf;
  const end = endMarker + MANAGED_END.length;
  // Drop the whole region lines (including the newline before the start marker
  // and the trailing newline after the end marker).
  const lineStart = conf.lastIndexOf("\n", start); // index of the \n before the region (or -1)
  const after = conf.indexOf("\n", end);
  const cutStart = lineStart < 0 ? start : lineStart;
  const cutEnd = after < 0 ? end : after;
  let out = conf.slice(0, cutStart) + conf.slice(cutEnd);
  // If this leaves an EMPTY `leafnodes { }` block cortex created, drop it too.
  out = out.replace(/\n*leafnodes \{\s*\}\n?/g, (match) =>
    // Only collapse a truly empty block (whitespace-only between braces).
    /\{\s*\}/.test(match) ? "\n" : match,
  );
  return out;
}

interface LeafnodesBlock {
  /** Index of the `{` opening the leafnodes block. */
  openBraceIndex: number;
  /** Index just past the matching `}`. */
  closeBraceIndex: number;
}

/**
 * Find the top-level `leafnodes { … }` block by brace matching. Tolerates
 * `leafnodes {`, `leafnodes:{`, `leafnodes = {` and intervening whitespace.
 * Returns undefined when no such block exists.
 */
function findLeafnodesBlock(conf: string): LeafnodesBlock | undefined {
  const kw = /(^|\n)[ \t]*leafnodes[ \t]*[:=]?[ \t]*\{/;
  const m = kw.exec(conf);
  if (!m) return undefined;
  const openBraceIndex = conf.indexOf("{", m.index);
  if (openBraceIndex < 0) return undefined;
  // Brace-match from the opening brace.
  let depth = 0;
  for (let i = openBraceIndex; i < conf.length; i++) {
    const ch = conf[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { openBraceIndex, closeBraceIndex: i + 1 };
    }
  }
  return undefined; // unbalanced — treat as no usable block
}

/**
 * True iff the leafnodes block carries an `authorization {` that is NOT inside
 * the cortex-managed region. Used to refuse clobbering a hand-written auth.
 */
function hasNonManagedAuthorization(conf: string, leaf: LeafnodesBlock): boolean {
  const block = conf.slice(leaf.openBraceIndex, leaf.closeBraceIndex);
  const authRe = /(^|\n)[ \t]*authorization[ \t]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = authRe.exec(block)) !== null) {
    // Absolute index of this authorization keyword in the full conf.
    const abs = leaf.openBraceIndex + m.index + (m[1]?.length ?? 0);
    if (!isInsideManagedRegion(conf, abs)) return true;
  }
  return false;
}

function isInsideManagedRegion(conf: string, index: number): boolean {
  const start = conf.indexOf(MANAGED_START);
  if (start < 0 || index < start) return false;
  const end = conf.indexOf(MANAGED_END, start);
  if (end < 0) return false;
  return index < end;
}
