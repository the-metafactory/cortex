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
 * **Never the sibling stack's own creds (#2536).** A sibling's
 * `nats.credsPath` is that sibling STACK's full user in the sibling's
 * account. Connecting with it would put a process of THIS stack inside the
 * sibling's account with everything the sibling stack may read and publish,
 * which defeats per-stack account isolation. The aggregator needs only
 * `local.{principal}.{sibling}.agent.>`, so a sibling that declares a
 * `credsPath` connects with a per-sibling OBSERVER creds file found by
 * convention ({@link observerCredsPath}):
 *
 *     <observerCredsDir>/mc-observer-<selfStack>-to-<siblingStack>.creds
 *
 * (`observerCredsDir` defaults to {@link DEFAULT_NATS_CREDS_DIR}.) The file is
 * a sub-only user minted in the SIBLING's account (sub allow
 * `local.{principal}.{sibling}.agent.>`, pub deny `>`; see
 * {@link observerMintHint}). Discovery decodes the file's user JWT (claims
 * only; the bus verifies the signature) and accepts it only when publish is
 * denied `>` with no publish allow, and every subscribe allow sits inside that
 * sibling's presence subtree ({@link checkObserverScope}). Anything else is
 * `credential.kind: "no-observer"` and the aggregator never connects to that
 * sibling: no file (`missing`), a path that resolves to the sibling stack's own
 * creds file (`is-stack-creds`), a wider scope such as a copy of the stack's
 * creds (`over-scoped`), or no decodable JWT (`unreadable`).
 *
 * Per-bus auth varies (#989 probe findings on the live machine):
 *   - meta-factory / work → a stack `nats.credsPath` → the per-sibling
 *     observer `credential.kind: "creds"`, or `"no-observer"` (#2536).
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
 *     absent. Pin an observer for it via `mc.aggregateLocalStacks.stacks[]`
 *     (a non-empty list REPLACES discovery, so list every sibling).
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

import { readdirSync, readFileSync, existsSync, realpathSync, statSync } from "fs";
import { join, resolve } from "path";
import { parse as parseYaml } from "yaml";
import { expandTilde } from "../../../common/config/loader";
import { DEFAULT_NATS_CREDS_DIR } from "../../../common/nats/creds-dir";
import { decodeJwtClaims, extractUserJwt } from "../../../common/nats/jwt";

/**
 * How to authenticate a read-only subscriber to a sibling bus.
 *
 *   - `creds` — a `.creds` file path (expanded + chmod-gated by the NATS
 *     connection layer). For a DISCOVERED sibling this is always the
 *     per-sibling observer file, never the sibling stack's `credsPath`
 *     (#2536). For an explicit `stacks[]` entry it is the configured path.
 *   - `noauth` — the stack declares NO `credsPath`. We attempt an
 *     unauthenticated connect and let the BUS decide: an OPEN loopback bus
 *     (e.g. halden's `nats-server -js`) connects; a LOCKED NSC bus (e.g.
 *     community) fails the connect with an Authorization Violation and the
 *     aggregator degrades it to absent (logged). This avoids a fragile
 *     config heuristic for "open vs locked" — the connect attempt is the ground
 *     truth, and a failed read-only connect is already harmless.
 *   - `no-observer` — the sibling declares a stack `credsPath` (its bus
 *     isolates accounts) but no usable observer creds exist. NON-connectable:
 *     the aggregator degrades it to absent without a connect attempt and logs
 *     {@link observerMintHint}. `reason` says why (see
 *     {@link NoObserverReason}). The sibling stays in the roster so the #1008
 *     DB-read path still sees it.
 *
 * (There is no `unresolved` kind: an undecidable config no longer guesses — it
 * tries `noauth` and degrades on failure, which is strictly more capable than
 * pre-judging it un-connectable.)
 */
export type SiblingCredential =
  | { kind: "creds"; credsPath: string }
  | { kind: "noauth" }
  | {
      kind: "no-observer";
      reason: NoObserverReason;
      /** The observer NATS user name to mint ({@link observerUserName}). */
      observerUser: string;
      /** Where discovery looked for the observer creds. */
      observerCredsPath: string;
    };

/**
 * #2536 — why a sibling has no usable observer:
 *   - `missing` — no file at the convention path.
 *   - `is-stack-creds` — the path resolves to the sibling stack's own creds
 *     file (same path, or a symlink to it).
 *   - `over-scoped` — the user JWT may publish, or may subscribe outside
 *     `local.{principal}.{sibling}.agent.>` (e.g. a copy of the stack's creds).
 *   - `unreadable` — the file can't be read or carries no decodable user JWT.
 */
export type NoObserverReason = "missing" | "is-stack-creds" | "over-scoped" | "unreadable";

/** One sibling stack the serving daemon should subscribe to read-only. */
export interface SiblingStackDescriptor {
  /** The sibling's `{stack}` slug (last segment of `stack.id`, or the dir name). */
  stack: string;
  /** The sibling's `{principal}` — always equal to the serving principal. */
  principal: string;
  /** The sibling bus url (a 127.0.0.1 loopback). */
  url: string;
  /** How to connect read-only. `no-observer` ⇒ degrade to absent. */
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
  /**
   * #2536 — directory holding per-sibling observer creds. Leading `~` is
   * expanded. Default {@link DEFAULT_NATS_CREDS_DIR}.
   */
  observerCredsDir?: string;
}

/**
 * #2536 — the observer NATS user name for `selfStack` watching `siblingStack`.
 * Stack slugs are lowercase-hyphen, so the name satisfies `arc nats add-bot`'s
 * naming rule.
 */
export function observerUserName(selfStack: string, siblingStack: string): string {
  return `mc-observer-${selfStack}-to-${siblingStack}`;
}

/**
 * #2536 — the convention path of the observer creds `selfStack` uses to read
 * `siblingStack`'s presence: `<dir>/mc-observer-<self>-to-<sibling>.creds`.
 * `dir` is returned as given (no tilde expansion).
 */
export function observerCredsPath(
  dir: string,
  selfStack: string,
  siblingStack: string,
): string {
  return join(dir, `${observerUserName(selfStack, siblingStack)}.creds`);
}

/**
 * #2536 — the principal-facing hint for minting a sibling observer. Names the
 * exact scope (sub allow `local.<principal>.<sibling>.agent.>`, pub deny `>`).
 * `arc nats add-bot` has allow flags only, so the deny is a separate `nsc edit`
 * and the creds are regenerated afterwards to carry it. The account is the
 * SIBLING's account (the one its stack user lives in).
 */
export function observerMintHint(args: {
  principal: string;
  siblingStack: string;
  observerUser: string;
  observerCredsPath: string;
}): string {
  const { principal, siblingStack, observerUser, observerCredsPath: path } = args;
  const subject = `local.${principal}.${siblingStack}.agent.>`;
  const account = `<${siblingStack}-account>`;
  return (
    `mint a read-only observer in the "${siblingStack}" stack's NATS account ` +
    `(sub allow ${subject}, pub deny >), then restart this stack:\n` +
    `  arc nats add-bot ${observerUser} --account ${account} --sub '${subject}' --output ${path}\n` +
    `  nsc edit user -a ${account} -n ${observerUser} --deny-pub '>'\n` +
    `  nsc generate creds -a ${account} -n ${observerUser} -o ${path}\n`
  );
}

/** Canonical path for a same-file comparison: tilde-expanded, absolute, symlinks resolved. */
function canonicalPath(p: string): string {
  const abs = resolve(expandTilde(p));
  try {
    return realpathSync(abs);
  } catch (_err) {
    // The file doesn't exist (or a parent isn't readable) — compare the
    // absolute path as-is; a missing file can't alias the stack creds.
    return abs;
  }
}

/** A string array claim, or `undefined` when absent / not a string array. */
function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.every((x): x is string => typeof x === "string") ? v : undefined;
}

/**
 * #2536 — is this `.creds` text a correctly scoped observer for
 * `{principal}/{sibling}`? Reads the user JWT's permission claims (never the
 * seed; the signature is the bus's job). `ok` only when:
 *   - publish: deny contains `>` and there is no publish allow, and
 *   - subscribe: allow is non-empty and every entry is
 *     `local.{principal}.{sibling}.agent.>` or a subject under
 *     `local.{principal}.{sibling}.agent.`.
 * No permissions claim means an unrestricted user, which is `over-scoped`.
 */
export function checkObserverScope(
  credsText: string,
  principal: string,
  sibling: string,
): "ok" | "over-scoped" | "unreadable" {
  const jwt = extractUserJwt(credsText);
  const claims = jwt === undefined ? undefined : decodeJwtClaims(jwt);
  if (claims === undefined) return "unreadable";
  const nats = claims.nats;
  const perms = nats !== null && typeof nats === "object" ? (nats as Record<string, unknown>) : {};
  const pub = (perms.pub ?? {}) as Record<string, unknown>;
  const sub = (perms.sub ?? {}) as Record<string, unknown>;

  const pubAllow = stringList(pub.allow) ?? [];
  const pubDeny = stringList(pub.deny) ?? [];
  if (pubAllow.length > 0 || !pubDeny.includes(">")) return "over-scoped";

  const prefix = `local.${principal}.${sibling}.agent.`;
  const subAllow = stringList(sub.allow) ?? [];
  if (subAllow.length === 0) return "over-scoped";
  if (!subAllow.every((s) => s.startsWith(prefix) && s.length > prefix.length)) {
    return "over-scoped";
  }
  return "ok";
}

/**
 * #2536 — resolve a discovered sibling's credential. No stack `credsPath` ⇒
 * `noauth` (open bus; unchanged). Otherwise the per-sibling observer file when
 * it exists, isn't the stack's own creds file, and is scoped to the sibling's
 * presence subtree; else `no-observer`. The stack `credsPath` itself is never
 * returned.
 */
function resolveSiblingCredential(args: {
  stackCredsPath: string | undefined;
  principal: string;
  selfStack: string;
  siblingStack: string;
  observerCredsDir: string;
}): SiblingCredential {
  const { stackCredsPath, principal, selfStack, siblingStack, observerCredsDir } = args;
  if (stackCredsPath === undefined) return { kind: "noauth" };

  const observerUser = observerUserName(selfStack, siblingStack);
  const path = observerCredsPath(observerCredsDir, selfStack, siblingStack);
  const refuse = (reason: NoObserverReason): SiblingCredential => ({
    kind: "no-observer",
    reason,
    observerUser,
    observerCredsPath: path,
  });
  if (canonicalPath(path) === canonicalPath(stackCredsPath)) return refuse("is-stack-creds");
  if (!existsSync(path)) return refuse("missing");

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    process.stderr.write(
      `sibling-discovery: cannot read observer creds for "${siblingStack}": ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return refuse("unreadable");
  }
  const scope = checkObserverScope(text, principal, siblingStack);
  return scope === "ok" ? { kind: "creds", credsPath: path } : refuse(scope);
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

/** What {@link readStackDir} reads from one stack dir (before credential resolution). */
interface StackDirInfo {
  stack: string;
  principal: string;
  url: string;
  /** The stack's own `nats.credsPath`, when declared. Never connected with. */
  stackCredsPath: string | undefined;
}

/**
 * Read one stack dir's `{principal, stack, url, stackCredsPath}` from its
 * `system/system.yaml` + `stacks/*.yaml`. Returns `null` (logged) when the dir
 * is not a parseable config-split stack — never throws.
 */
function readStackDir(
  configRoot: string,
  dirName: string,
): StackDirInfo | null {
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

  // The stack's credsPath is recorded only to pick the credential KIND and to
  // refuse an observer that aliases it (#2536). It is never connected with.
  const credsPath = typeof nats?.credsPath === "string" ? nats.credsPath : undefined;
  const stackCredsPath =
    credsPath !== undefined && credsPath.length > 0 ? credsPath : undefined;

  return { stack, principal, url, stackCredsPath };
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
  const observerCredsDir = expandTilde(opts.observerCredsDir ?? DEFAULT_NATS_CREDS_DIR);

  // PRECEDENCE: explicit config wins. A non-empty explicit list IS the roster;
  // discovery is skipped. Self is still excluded by stack slug. Explicit
  // entries keep their configured credential untouched (principal intent).
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

    const info = readStackDir(configRoot, name);
    if (info === null) continue;

    // FILTER 1 — same principal only.
    if (info.principal !== selfPrincipal) continue;
    // FILTER 2 — local loopback bus only.
    if (!isLoopbackUrl(info.url)) continue;
    // FILTER 3 — exclude self.
    if (info.stack === selfStack) continue;

    siblings.push({
      stack: info.stack,
      principal: info.principal,
      url: info.url,
      credential: resolveSiblingCredential({
        stackCredsPath: info.stackCredsPath,
        principal: info.principal,
        selfStack,
        siblingStack: info.stack,
        observerCredsDir,
      }),
    });
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
