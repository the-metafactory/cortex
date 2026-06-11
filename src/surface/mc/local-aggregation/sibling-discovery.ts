/**
 * #989 part-1 — sibling-stack DISCOVERY.
 *
 * The principal runs SEVERAL cortex stacks on one machine, each on its own
 * local loopback NATS bus (e.g. `andreas`: meta-factory + work on :4222,
 * community on :4224, halden on :4223). The localhost MC pane should show ALL
 * of them as distinct stack-hubs on the Network view — not just the one whose
 * daemon serves the dashboard.
 *
 * This module finds the OTHER stacks. It scans a config root
 * (`~/.config/cortex/`) for config-split stack dirs, reads each one's
 * `system/system.yaml` (bus url + credential) and `stacks/*.yaml`
 * (`{principal}/{stack}` identity), and yields one {@link SiblingStackDescriptor}
 * per sibling the serving daemon should subscribe to read-only.
 *
 * ## Filters (all must hold for a stack to be a sibling)
 *
 *   1. **Same principal** — `principal.id` MUST equal the serving stack's
 *      principal. This is a LOCAL same-principal aggregation (ADR-0005: the
 *      principal sees their OWN interiors). A different-principal stack is NEVER
 *      a sibling — that is federation, out of scope here.
 *   2. **Local loopback bus** — `nats.url` host MUST be a 127.0.0.1 loopback.
 *      The principal owns every loopback bus + its auth on this machine; a
 *      non-loopback url is a remote bus (federation territory) and is excluded.
 *   3. **Not self** — the SERVING stack (by its `{stack}` slug) is excluded so a
 *      stack never re-subscribes to its own presence (the B.3 local registry
 *      already folds that).
 *
 * ## Credential resolution
 *
 * Per-bus auth varies (#989 probe findings on the live machine):
 *   - meta-factory / work → a `nats.credsPath` (operator-account `.creds`) →
 *     `credential.kind: "creds"`.
 *   - halden → an OPEN bus (`nats-server -js`, no operator-account config) that
 *     accepts an unauthenticated connection. Its `system.yaml` declares only an
 *     account-signing NKey seed (no `credsPath`), so config alone can't tell it
 *     apart from a locked NSC bus. We surface no-credsPath as
 *     `credential.kind: "noauth"` (try connecting with no credential) — and let
 *     the BUS decide: an open bus connects, a locked one fails the connect and
 *     the aggregator degrades that sibling to absent.
 *   - community → a true operator-account (NSC) bus that REQUIRES a minted user. With only
 *     an account-signing NKey (not a connectable user), the `noauth` attempt
 *     fails with an Authorization Violation, so the aggregator degrades it to
 *     absent. Minting a read-only observer user for it is a #989 follow-up.
 *
 * Rationale for "try no-auth, let the bus decide": config can't reliably
 * distinguish an open loopback bus from a locked one (both lack `credsPath`),
 * but the connect attempt itself is the ground truth — and a failed read-only
 * connect already degrades gracefully (the bus is never harmed). This connects
 * the buses that CAN be read (halden) without a fragile config heuristic, and
 * cleanly flags the ones that genuinely need a credential (community).
 *
 * ## Discovery vs explicit-config PRECEDENCE
 *
 * **Explicit config wins.** When the caller supplies an `explicit` list (from
 * `mc.aggregateLocalStacks.stacks[]`), that list IS the sibling set — discovery
 * is skipped entirely. This lets a principal pin an exact roster (e.g. add a bus
 * the auto-scan can't see, or exclude one) without fighting the scanner.
 * Discovery is the DEFAULT (no explicit list ⇒ scan the config root). Either
 * path still excludes self by stack slug.
 *
 * Pure + side-effect-free beyond reading the filesystem; never throws on a
 * malformed dir (logs + skips), so a half-written sibling config can't take down
 * the serving daemon's boot.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

/**
 * How to authenticate a read-only subscriber to a sibling bus.
 *
 *   - `creds` — an operator-mode `.creds` file path (expanded + chmod-gated by
 *     the NATS connection layer). The declared-credential case (meta-factory /
 *     work).
 *   - `noauth` — the stack declares NO `credsPath`. We attempt an
 *     unauthenticated connect and let the BUS decide: an OPEN loopback bus
 *     (e.g. halden's `nats-server -js`) connects; a LOCKED NSC bus (e.g.
 *     community) fails the connect with an Authorization Violation and the
 *     aggregator degrades it to absent (logged). This avoids a fragile
 *     config heuristic for "open vs locked" — the connect attempt is the ground
 *     truth, and a failed read-only connect is already harmless.
 *
 * (There is no `unresolved` kind: an undecidable config no longer guesses — it
 * tries `noauth` and degrades on failure, which is strictly more capable than
 * pre-judging it un-connectable.)
 */
export type SiblingCredential =
  | { kind: "creds"; credsPath: string }
  | { kind: "noauth" };

/** One sibling stack the serving daemon should subscribe to read-only. */
export interface SiblingStackDescriptor {
  /** The sibling's `{stack}` slug (last segment of `stack.id`, or the dir name). */
  stack: string;
  /** The sibling's `{principal}` — always equal to the serving principal. */
  principal: string;
  /** The sibling bus url (a 127.0.0.1 loopback). */
  url: string;
  /** How to connect read-only. `unresolved` ⇒ degrade to absent. */
  credential: SiblingCredential;
}

/** Options for {@link discoverSiblingStacks}. */
export interface DiscoverSiblingStacksOptions {
  /** Config root to scan (e.g. `~/.config/cortex`). Already tilde-expanded. */
  configRoot: string;
  /** The SERVING stack's principal — the same-principal filter pivot. */
  selfPrincipal: string;
  /** The SERVING stack's `{stack}` slug — excluded from the result. */
  selfStack: string;
  /**
   * Explicit sibling list. When supplied + non-empty, it OVERRIDES discovery
   * (precedence: explicit > discovery). Self is still excluded by stack slug.
   */
  explicit?: SiblingStackDescriptor[];
}

/** Hosts treated as the principal's own local loopback bus. */
function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    // nats:// urls parse fine with the URL constructor (the protocol is opaque).
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  // IPv6 loopback (`[::1]`) → URL.hostname yields `::1`.
  if (host === "::1") return true;
  if (host === "localhost") return true;
  // 127.0.0.0/8 — any 127.x.y.z is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Last `/`-segment of a `stack.id` (`andreas/work` → `work`), else the input. */
function stackSlugOf(stackId: string): string {
  const idx = stackId.lastIndexOf("/");
  return idx >= 0 ? stackId.slice(idx + 1) : stackId;
}

/**
 * Read one stack dir's `{principal, stack, url, credential}` from its
 * `system/system.yaml` + `stacks/*.yaml`. Returns `null` (logged) when the dir
 * is not a parseable config-split stack — never throws.
 */
function readStackDir(
  configRoot: string,
  dirName: string,
): SiblingStackDescriptor | null {
  const dir = join(configRoot, dirName);
  const systemPath = join(dir, "system", "system.yaml");
  if (!existsSync(systemPath)) {
    // Not a stack dir (logs/, state/, …) — silently skip (no log: these are
    // expected siblings of stack dirs under the config root).
    return null;
  }
  let systemRaw: unknown;
  try {
    systemRaw = parseYaml(readFileSync(systemPath, "utf8"));
  } catch (err) {
    process.stderr.write(
      `sibling-discovery: skipping "${dirName}" — system.yaml parse failed: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
  const nats = (systemRaw as { nats?: Record<string, unknown> } | null)?.nats;
  const url = typeof nats?.url === "string" ? nats.url : undefined;
  if (url === undefined || url.length === 0) {
    process.stderr.write(
      `sibling-discovery: skipping "${dirName}" — no nats.url in system.yaml\n`,
    );
    return null;
  }

  // Identity comes from the first stacks/*.yaml that declares principal + stack.
  const stacksDir = join(dir, "stacks");
  let principal: string | undefined;
  let stackId: string | undefined;
  if (existsSync(stacksDir)) {
    let stackFiles: string[];
    try {
      stackFiles = readdirSync(stacksDir)
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .sort();
    } catch {
      stackFiles = [];
    }
    for (const f of stackFiles) {
      let parsed: unknown;
      try {
        parsed = parseYaml(readFileSync(join(stacksDir, f), "utf8"));
      } catch {
        continue; // a bad stack file is skipped; try the next.
      }
      const obj = parsed as
        | { principal?: { id?: unknown }; stack?: { id?: unknown } }
        | null;
      const pid = obj?.principal?.id;
      const sid = obj?.stack?.id;
      if (typeof pid === "string" && pid.length > 0) principal = pid;
      if (typeof sid === "string" && sid.length > 0) stackId = sid;
      if (principal !== undefined && stackId !== undefined) break;
    }
  }
  if (principal === undefined) {
    process.stderr.write(
      `sibling-discovery: skipping "${dirName}" — no principal.id in any stacks/*.yaml\n`,
    );
    return null;
  }

  const stack = stackId !== undefined ? stackSlugOf(stackId) : dirName;

  // Credential: a declared credsPath ⇒ creds auth; otherwise attempt no-auth
  // (open loopback bus) and let the connect decide (a locked bus degrades).
  const credsPath = typeof nats?.credsPath === "string" ? nats.credsPath : undefined;
  const credential: SiblingCredential =
    credsPath !== undefined && credsPath.length > 0
      ? { kind: "creds", credsPath }
      : { kind: "noauth" };

  return { stack, principal, url, credential };
}

/**
 * Discover the principal's OTHER local stacks for read-only presence
 * aggregation. See the module docstring for the filter + precedence rules.
 *
 * Returns siblings sorted by stack slug for stable boot logs. Self is excluded
 * in BOTH the explicit and discovery paths.
 */
export function discoverSiblingStacks(
  opts: DiscoverSiblingStacksOptions,
): SiblingStackDescriptor[] {
  const { configRoot, selfPrincipal, selfStack, explicit } = opts;

  // PRECEDENCE: explicit config wins. A non-empty explicit list IS the roster;
  // discovery is skipped. Self is still excluded by stack slug.
  if (explicit !== undefined && explicit.length > 0) {
    return explicit
      .filter((d) => d.stack !== selfStack)
      .slice()
      .sort((a, b) => a.stack.localeCompare(b.stack));
  }

  // DISCOVERY (default): scan the config root for stack dirs.
  let entries: string[];
  try {
    entries = readdirSync(configRoot);
  } catch (err) {
    process.stderr.write(
      `sibling-discovery: cannot read config root "${configRoot}" — no siblings discovered: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }

  const siblings: SiblingStackDescriptor[] = [];
  for (const name of entries) {
    let isDir: boolean;
    try {
      isDir = statSync(join(configRoot, name)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const desc = readStackDir(configRoot, name);
    if (desc === null) continue;

    // FILTER 1 — same principal only.
    if (desc.principal !== selfPrincipal) continue;
    // FILTER 2 — local loopback bus only.
    if (!isLoopbackUrl(desc.url)) continue;
    // FILTER 3 — exclude self.
    if (desc.stack === selfStack) continue;

    siblings.push(desc);
  }

  // De-dupe by stack slug (two dirs claiming the same stack — keep the first
  // by sorted dir order) and sort for stable output.
  const byStack = new Map<string, SiblingStackDescriptor>();
  for (const s of siblings) {
    if (!byStack.has(s.stack)) byStack.set(s.stack, s);
  }
  return Array.from(byStack.values()).sort((a, b) =>
    a.stack.localeCompare(b.stack),
  );
}
