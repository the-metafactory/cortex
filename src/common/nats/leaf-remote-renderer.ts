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
   * The LOCAL NATS account (nkey-U `A…`) that leaf traffic binds to.
   * NSC operator-mode requires each leaf remote to declare this; it is the
   * stack's user-data account (system traffic stays on SYS). DD-8: the
   * config surface uses nkey-U; the registry stores base64 — translation
   * is the join command's job, this renderer takes the already-nkey-U value.
   */
  account: string;
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
  /** Absolute path to the `.creds` file (operator-mode leaf auth). */
  credentials: string;
  /** The local NATS account (nkey-U) the leaf binds to. */
  account: string;
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
 * leaf binding. Fails loud at the boundary on a missing/relative creds path
 * or a missing account — operator-mode cannot connect a leaf without either,
 * so a silent bad value would produce a dormant link, the exact trap S3
 * closes.
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

  const account = binding.account.trim();
  if (account.length === 0) {
    throw new Error(
      `leaf-remote-renderer: operator-mode requires a bound account (nkey-U) for network "${descriptor.network_id}"; got empty`,
    );
  }
  if (!NKEY_ACCOUNT.test(account)) {
    // The account is emitted BARE into HOCON (matching local.conf). Anything
    // outside the nkey-U grammar could break out of the remotes[] block and
    // inject directives, so reject it at the boundary — a bad account is a
    // broken/dormant leaf, the exact trap S3 closes.
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

/** Serialize one {@link LeafRemote} as a HOCON object literal (indented). */
function serializeRemote(remote: LeafRemote, indent: string): string {
  // `url` + `credentials` are quoted (they contain `:`, `/`, `.` which are
  // HOCON-significant); `account` is a bare nkey-U token (matches the live
  // local.conf, which leaves the account pubkey unquoted).
  return [
    `${indent}{`,
    `${indent}  url: ${JSON.stringify(remote.url)}`,
    `${indent}  credentials: ${JSON.stringify(remote.credentials)}`,
    `${indent}  account: ${remote.account}`,
    `${indent}}`,
  ].join("\n");
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
