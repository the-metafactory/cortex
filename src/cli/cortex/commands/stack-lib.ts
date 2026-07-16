/**
 * `cortex stack` pure logic (C-808, closes #808) — discovery, the born-aligned
 * scaffold renderer, and the alignment self-check.
 *
 * This is the PREVENT-side complement to v5.3.8's `warn_stack_identity_drift`
 * (the DETECT side, `scripts/lib/plist-render.sh` + ADR-0004). That detector
 * warns when a stack's filesystem locator (dir basename / `cortex.<slug>.yaml`
 * filename) drifts from `stack.id`'s trailing segment. This module makes that
 * drift STRUCTURALLY IMPOSSIBLE for a stack created via `cortex stack create`:
 * it derives `stack.id = {principal}/{slug}`, writes the dir as `<slug>`, and
 * asserts dir == slug == trailing-segment BEFORE writing (`assertAligned`).
 *
 * Discovery (`discoverStacks`) is a faithful TS replica of the shell discovery
 * in `plist-render.sh` (`discover_stack_slugs` + `extract_stack_id_slug` +
 * `config_file_to_slug`), used for the uniqueness scan and `stack list`. Kept
 * deliberately dependency-light (no YAML parser) so it matches the install-time
 * awk extraction byte-for-byte on the `stack.id` it reads.
 *
 * No I/O beyond reading for discovery — the actual writes live in `stack.ts`
 * so this module stays pure + trivially testable (mirrors the network-lib /
 * network.ts split).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { parse as parseYaml } from "yaml";
import { stackSlugFromStackId } from "../../../common/stack-id";
import { DEFAULT_STREAM_MAX_BYTES } from "../../../common/types/cortex-config";

// =============================================================================
// Discovery
// =============================================================================

/** A stack discovered under a config dir, with its alignment verdict. */
export interface DiscoveredStack {
  /** The filesystem LOCATOR slug — dir basename, or the cortex.<slug>.yaml
   *  filename slug (cosmetic; ADR-0004 DA-1). */
  slugLocator: string;
  /** `stack.id` (`{principal}/{slug}`) read from the config, or undefined when
   *  absent/unparseable (a degenerate stack the detector skips). */
  stackId?: string;
  /** Layout the stack was found under. */
  layout: "split" | "monolith";
  /** Absolute path of the stack's config file that carries `stack.id`. */
  configPath: string;
  /** True when the locator slug == `stack.id`'s trailing segment (ADR-0004).
   *  Undefined `stackId` ⇒ undefined verdict (nothing to compare). */
  aligned?: boolean;
}

/**
 * Replica of `config_file_to_slug` (plist-render.sh): map a `cortex*.yaml`
 * filename to its locator slug. `cortex.yaml` → `meta-factory` (the single-file
 * default-stack special case); `cortex.<slug>.yaml` → `<slug>`. Anything else
 * returns undefined (caller skips the file).
 */
function configFileToSlug(filename: string): string | undefined {
  if (filename === "cortex.yaml") return "meta-factory";
  const m = /^cortex\.(.+)\.yaml$/.exec(filename);
  return m?.[1];
}

/**
 * Replica of `extract_stack_id_slug` (plist-render.sh) — extract `stack.id`
 * scoped to the top-level `stack:` block so the sibling `principal.id` /
 * `agents[].id` keys are never mistaken for it. Returns the full
 * `{principal}/{slug}` literal, or undefined when absent/unparseable.
 *
 * Deliberately a line scan (not a YAML parse) to match the install-time awk
 * extraction on every well-formed config — the same `stack.id` the drift
 * detector reads. (Both this scan and the awk converge to undefined on the
 * degenerate cases — flow-style `stack: {id: …}`, an empty `id:` — and the real
 * loader rejects those configs anyway, so neither is a reachable dup bypass.)
 */
function extractStackId(configPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(configPath, "utf-8");
  } catch (_err) {
    // A discovered config that can't be read carries no comparable id — the
    // shell detector skips it too (the filename locator stands). Safe to ignore.
    return undefined;
  }
  let inStack = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (/^stack:\s*$/.test(line)) {
      inStack = true;
      continue;
    }
    // A non-indented, non-comment line dedents out of the `stack:` block.
    if (inStack && /^[^\s#]/.test(line)) inStack = false;
    if (inStack) {
      const m = /^\s+id:\s*(.+)$/.exec(line);
      if (m?.[1] !== undefined) {
        // Strip quotes + trailing comment, trim.
        const value = m[1].replace(/["']/g, "").replace(/#.*$/, "").trim();
        return value.length > 0 ? value : undefined;
      }
    }
  }
  return undefined;
}

/**
 * Discover all stacks under `configDir` — split-layout dirs (with the
 * `system/system.yaml` marker) and legacy `cortex*.yaml` monoliths. Mirrors
 * `discover_stack_slugs`: the directory layout WINS over a same-slug monolith
 * (the split retains the root monolith as a rollback anchor, so it must not be
 * double-discovered). Returns each with its `stack.id` + alignment verdict.
 */
export function discoverStacks(configDir: string): DiscoveredStack[] {
  if (!existsSync(configDir)) return [];

  const found: DiscoveredStack[] = [];
  const dirSlugs = new Set<string>();

  // Pass 1: split-layout dirs — <configDir>/<slug>/system/system.yaml marker.
  let entries: string[];
  try {
    entries = readdirSync(configDir);
  } catch (_err) {
    // Unreadable config dir → nothing to discover; an empty list is the safe,
    // truthful answer (callers treat it as "no stacks present"). Safe to ignore.
    return [];
  }
  for (const entry of entries.sort()) {
    const dir = join(configDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch (_err) {
      // A racing unlink between readdir and stat — skip this entry. Safe to ignore.
      continue;
    }
    if (!existsSync(join(dir, "system", "system.yaml"))) continue;
    // Agents/stack.id live in stacks/<slug>.yaml under the split layout.
    const configPath = join(dir, "stacks", `${entry}.yaml`);
    const stackId = existsSync(configPath) ? extractStackId(configPath) : undefined;
    dirSlugs.add(entry);
    found.push(buildDiscovered(entry, stackId, "split", configPath));
  }

  // Pass 2: legacy monoliths — emit only when no split dir already claimed the
  // slug (dir wins → dedupe).
  for (const entry of entries.sort()) {
    if (!/^cortex.*\.yaml$/.test(entry)) continue;
    const file = join(configDir, entry);
    try {
      if (!statSync(file).isFile()) continue;
    } catch (_err) {
      // racing unlink between readdir and stat — skip. Safe to ignore.
      continue;
    }
    const slug = configFileToSlug(entry);
    if (slug === undefined) continue;
    if (dirSlugs.has(slug)) continue;
    const stackId = extractStackId(file);
    found.push(buildDiscovered(slug, stackId, "monolith", file));
  }

  return found;
}

function buildDiscovered(
  slugLocator: string,
  stackId: string | undefined,
  layout: "split" | "monolith",
  configPath: string,
): DiscoveredStack {
  return {
    slugLocator,
    ...(stackId !== undefined && { stackId }),
    layout,
    configPath,
    ...(stackId !== undefined && { aligned: stackSlugFromStackId(stackId) === slugLocator }),
  };
}

// =============================================================================
// Teardown (C-1351 Slice 1 — `cortex stack delete`, local teardown)
// =============================================================================
//
// The DEATH story that complements `create` (the birth story). Pure path
// resolution + read-only inspection live here; the effectful teardown (plist
// unload, fs removal, seed retire) lives in `stack.ts` — mirroring the
// create-side lib/command split so this module stays trivially testable.
//
// SCOPE (Slice 1): local artifacts ONLY. Registry-side deregistration
// (`provision-stack retire`) is Slice 2 — deferred (depends on #832 + a
// tombstone-vs-delete design call). Nothing here touches the registry or the
// bus; the joined-network read below is READ-ONLY.

/** The three filesystem roots teardown spans. Overridable (tests point them at
 *  tmp dirs; a principal with non-standard paths can override too). */
export interface TeardownRoots {
  /** Cortex config dir (`~/.config/cortex`). Holds the config-split stack dir. */
  configDir: string;
  /** NATS material dir (`~/.config/nats`). Holds the rendered `<slug>.conf`,
   *  leaf includes, and the signing seed. */
  natsDir: string;
  /** launchd LaunchAgents dir (`~/Library/LaunchAgents`) — the daemon + nats
   *  plists. On Linux this is the systemd user-unit dir; the caller decides. */
  launchAgentsDir: string;
}

/** Resolved absolute paths of every local artifact a stack owns. Pure — computed
 *  from the slug + roots by CONVENTION (the same paths `stack create` /
 *  sop-stack-onboarding.md Step 2/4 write), so teardown finds them without a
 *  config parse. Existence is checked by the caller (missing pieces are skipped
 *  — teardown is idempotent). */
export interface StackArtifacts {
  /** The config-split stack dir (`<configDir>/<slug>/`) — contains system/,
   *  surfaces/, stacks/<slug>.yaml, personas/, and the `<slug>.yaml` pointer, so
   *  removing this dir removes the pointer with it. */
  configStackDir: string;
  /** The policy-bearing file (`<configStackDir>/stacks/<slug>.yaml`) — where
   *  `policy.federated.networks[]` lives under the split layout (mirrors
   *  `network-adapters.ts` `stackConfigPath`). Read-only here (the joined gate). */
  policyConfigFile: string;
  /** Rendered nats-server config (`<natsDir>/<slug>.conf`, sop Step 2). */
  natsConf: string;
  /** The stack's signing seed (`<natsDir>/cortex-<slug>.nk`). RETIRED (renamed),
   *  never deleted, unless `--purge-seeds` (key destruction is a conscious act). */
  seed: string;
  /** Cortex daemon plist (`ai.meta-factory.cortex.<slug>.plist`, sop Step 4). */
  daemonPlist: string;
  /** Dedicated nats-server plist (`ai.meta-factory.nats.<slug>.plist`, sop Step 2). */
  natsPlist: string;
}

export function resolveStackArtifacts(roots: TeardownRoots, slug: string): StackArtifacts {
  const configStackDir = join(roots.configDir, slug);
  return {
    configStackDir,
    policyConfigFile: join(configStackDir, "stacks", `${slug}.yaml`),
    natsConf: join(roots.natsDir, `${slug}.conf`),
    seed: join(roots.natsDir, `cortex-${slug}.nk`),
    daemonPlist: join(roots.launchAgentsDir, `ai.meta-factory.cortex.${slug}.plist`),
    natsPlist: join(roots.launchAgentsDir, `ai.meta-factory.nats.${slug}.plist`),
  };
}

/**
 * READ-ONLY: the network ids this stack is currently joined to
 * (`policy.federated.networks[].id`), read from its policy-bearing config file.
 * Mirrors `network-adapters.ts` `ConfigStorePort.readNetworks` byte-for-byte
 * (`raw?.policy?.federated?.networks ?? []`) so the delete gate reads exactly
 * what `network join`/`leave` wrote. Empty when the file is absent/unparseable
 * (a stack with no config can't be joined). NEVER mutates.
 *
 * This is the ONLY point teardown inspects federated state, and it is read-only
 * — the network.ts / network-lib.ts lane is untouched (C-1351 stays out of it).
 */
export function readJoinedNetworkIds(policyConfigFile: string): string[] {
  if (!existsSync(policyConfigFile)) return [];
  let raw: { policy?: { federated?: { networks?: { id?: string }[] } } } | null;
  try {
    raw = parseYaml(readFileSync(policyConfigFile, "utf-8")) as typeof raw;
  } catch (_err) {
    // Unparseable config carries no resolvable join state — treat as not-joined
    // (a broken config can't be a live roster member). Safe to ignore.
    return [];
  }
  const networks = raw?.policy?.federated?.networks ?? [];
  return networks
    .map((n) => n.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * The leaf-include files a stack's rendered nats config references — the
 * `include "leafnodes-<network>.conf"` directives `network join` wrote
 * (`leaf-remote-renderer.ts` #754). Returned as absolute paths in the conf's own
 * dir so teardown removes exactly the includes THIS stack's conf pulls in (never
 * another stack's). Empty when the conf is absent/unreadable. Read-only.
 */
export function parseLeafIncludeFiles(natsConfPath: string): string[] {
  if (!existsSync(natsConfPath)) return [];
  let text: string;
  try {
    text = readFileSync(natsConfPath, "utf-8");
  } catch (_err) {
    // Unreadable conf → no includes to resolve; the conf itself is still removed
    // by the caller. Safe to ignore.
    return [];
  }
  const dir = dirname(natsConfPath);
  const out: string[] = [];
  const re = /^\s*include\s+"(leafnodes-[^"]+\.conf)"/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const file = m[1];
    if (file !== undefined) out.push(join(dir, file));
  }
  return out;
}

/**
 * The retire target for a signing seed: `<seed>.retired-<stamp>`. Renaming
 * (not deleting) the seed is the default — destroying key material is a separate
 * conscious act (`--purge-seeds`). `stamp` is supplied by the caller (a
 * filesystem-safe timestamp) so this stays pure/deterministic in tests.
 */
export function retiredSeedPath(seedPath: string, stamp: string): string {
  return `${seedPath}.retired-${stamp}`;
}

// =============================================================================
// Alignment self-check (the #808 structural guarantee)
// =============================================================================

/**
 * Assert dir basename == slug == trailing segment of the stack.id about to be
 * written. The whole point of `cortex stack create` (#808): a stack born this
 * way CANNOT drift, because we refuse to write unless all three agree. Throws
 * on a mismatch — a programming error in the command, never a principal input
 * error (those are validated + rejected upstream as usage errors).
 */
export function assertAligned(slug: string, stackId: string): void {
  const trailing = stackSlugFromStackId(stackId);
  if (trailing !== slug) {
    throw new Error(
      `alignment self-check failed (#808): stack.id "${stackId}" trailing segment "${trailing}" != slug "${slug}"`,
    );
  }
}

// =============================================================================
// Scaffold renderer
// =============================================================================

/** Inputs for the born-aligned scaffold. All resolved + validated upstream. */
export interface ScaffoldInputs {
  slug: string;
  principal: string;
  stackId: string;
  agentId: string;
  displayName: string;
  /** Conventional seed path (`~/.config/nats/cortex-<slug>.nk`). NOT generated
   *  here — `arc upgrade cortex` auto-provisions the seed on first install. */
  seedPath: string;
}

/** A scaffold file to write, relative to the new stack's dir. */
export interface ScaffoldFile {
  relPath: string;
  contents: string;
}

/**
 * Render the full born-aligned config-split skeleton for a new stack. Derived
 * from `docs/config-layout/` with the `research`/`andreas`/`ivy` placeholders
 * substituted for the real slug / principal / agent, keeping `<REPLACE_ME>`
 * only for true secrets (Discord token/guild/channel ids + the post-first-boot
 * `nkey_pub`). NEVER emits private key material — the seed is auto-provisioned
 * later (see `arc upgrade cortex` / postupgrade.sh §2).
 */
export function renderScaffold(inputs: ScaffoldInputs): ScaffoldFile[] {
  const { slug, principal, stackId, agentId, displayName, seedPath } = inputs;
  const Display = displayName;

  return [
    { relPath: "system/system.yaml", contents: systemYaml(slug, seedPath) },
    { relPath: "surfaces/surfaces.yaml", contents: surfacesYaml(agentId, stackId) },
    { relPath: `stacks/${slug}.yaml`, contents: stackYaml(slug, principal, stackId, agentId, Display, seedPath) },
    { relPath: `${slug}.yaml`, contents: pointerYaml(slug) },
    { relPath: `personas/${agentId}.md`, contents: personaStub(agentId, Display, stackId) },
  ];
}

function systemYaml(slug: string, seedPath: string): string {
  // The cross-cutting substrate layer — substituted from
  // docs/config-layout/system/system.yaml. NO active `identity:` block: the
  // authoritative, auto-provisioned signing identity is per-stack and lives in
  // stacks/<slug>.yaml (`stack.nkey_seed_path`/`nkey_pub`), not in this shared
  // machine-wide file. Shipping a per-stack key here left a non-slug seedPath
  // and a placeholder pubkey the provisioner never reconciled (cortex#2052).
  return `# =============================================================================
# system.yaml — the cross-cutting machine / substrate layer (IAW CFG.b)
# =============================================================================
# Generated by \`cortex stack create\` (#808). BASE layer of the config-split
# layout: the dangerous transport knobs (claude / execution / attachments /
# paths / nats / bus) live HERE, one layer up from the per-stack stacks/*.yaml,
# reviewed as a transport change. See docs/config-layout/system/system.yaml for
# the fully-annotated reference.

claude:
  timeoutMs: 300000
  asyncTimeoutMs: 900000
  additionalArgs: []
  allowedTools: []
  disallowedTools:
    - Write
  # workspaceDir — the dispatched CC session's cwd when no allowedDirs/
  # dirRestrictions resolve one (a bare stack — cortex#2097). Scoped to this
  # stack so its dispatched sessions never inherit the daemon's own cwd
  # ($HOME / the cortex install repo). \`cortex stack create\` already
  # created this dir (0700) for you; uncomment only to point it somewhere
  # else.
  # workspaceDir: ~/.local/share/metafactory/cortex/${slug}/workspace

execution:
  default: local
  backends: []

attachments:
  enabled: true
  maxFileSizeBytes: 10485760
  maxTotalSizeBytes: 26214400
  maxAttachmentsPerMessage: 10

paths:
  publishedEventsDir: ~/.local/share/metafactory/cortex/events/published
  logDir: ~/.local/state/metafactory/cortex/logs

# nats — M2 transport. nats.subjects is the SINGLE place subject overrides live
# (IAW CFG.b.2). KEEP IT EMPTY ([]) unless you know exactly why — a duplicate
# pattern double-binds the boot subscriber (the double-message problem,
# cortex#491). The dispatch-listener self-subscribes its own interest at start.
nats:
  url: nats://127.0.0.1:4222   # review host:port for your NATS server (default: local 4222)
  # NATS *client* connection label (how this daemon identifies itself to the
  # server — visible in \`nats server report connections\`). Slug-scoped so
  # multiple stacks on one host are distinguishable (cortex#2055). This is NOT
  # the nats-server's own \`server_name\` in ~/.config/nats/<slug>.conf — that
  # names the server process; the two play different roles and needn't match.
  name: cortex-${slug}
  subjects: []
  # credsPath — the daemon's OWN bus/bot creds, minted under the \`agents\` account
  # by \`cortex network make-live\` (via add-bot). The \`-bot\` suffix is LOAD-BEARING:
  # it keeps this path DISTINCT from stacks/${slug}.yaml's
  # \`stack.nats_infra.creds_path\` (the FEDERATION creds, minted at
  # \`cortex network join\` under a DIFFERENT account, conventional default
  # \`~/.config/nats/${slug}.creds\`). Two different NATS accounts MUST be two
  # different files — a shared path would clobber on the second mint.
  credsPath: ~/.config/nats/${slug}-bot.creds
  # NKey identity for envelope signing is PER-STACK and lives in
  # stacks/${slug}.yaml — \`stack.nkey_seed_path\` + \`stack.nkey_pub\`, which
  # \`arc upgrade cortex\` auto-provisions on first install (seed at
  # ${seedPath}, chmod 600) and which the runtime signer actually reads.
  # This machine-wide layer intentionally ships NO \`identity:\` block: a
  # per-stack key does not belong in the shared substrate file, and a
  # placeholder here is never reconciled by provisioning (cortex#2052).
  # Uncomment ONLY to force a machine-wide override you fully understand —
  # and paste a REAL U-prefixed pubkey, never a placeholder:
  # identity:
  #   seedPath: ${seedPath}
  #   publicKey: U...   # the real U-prefixed pubkey (56 chars), NOT a placeholder

bus:
  review:
    stream:
      name: CODE_REVIEW
      maxAgeSeconds: 86400
      maxBytes: ${DEFAULT_STREAM_MAX_BYTES}
    consumer:
      maxDeliver: 5
`;
}

function surfacesYaml(agentId: string, stackId: string): string {
  // The shared surface-gateway binding map (IAW CFG.c). Substituted from
  // docs/config-layout/surfaces/surfaces.yaml with the real agent + stack id.
  // Secrets stay <REPLACE_ME> (Discord token/guild/channel ids).
  return `# =============================================================================
# surfaces/surfaces.yaml — the shared surface-gateway binding map (IAW CFG.c)
# =============================================================================
# Generated by \`cortex stack create\` (#808). Holds the per-platform surface
# bindings (Discord/Slack/Mattermost token/guild/channels), folded into the
# matching agent's presence.{platform} at load. OPTIONAL — per-stack inline
# presence is always the fallback. See docs/config-layout/surfaces/surfaces.yaml.

surfaces:
  discord:
    - agent: ${agentId}
      stack: ${stackId}
      binding:
        token: "<REPLACE_ME>"            # the bot token (chmod 600 the file)
        guildId: "<REPLACE_ME>"
        agentChannelId: "<REPLACE_ME>"
        logChannelId: "<REPLACE_ME>"

  # slack:
  #   - agent: ${agentId}
  #     stack: ${stackId}
  #     binding:
  #       botToken: xoxb-REPLACE
  #       appToken: xapp-REPLACE
  #       workspaceId: T01234567

  # mattermost:
  #   - agent: ${agentId}
  #     stack: ${stackId}
  #     binding:
  #       apiUrl: https://mattermost.example.com
  #       apiToken: REPLACE_WITH_MATTERMOST_TOKEN
`;
}

/**
 * Valid-FORMAT NKey public-key placeholder (U-prefixed, 56 chars). The config
 * schema's `nkey_pub` fields are regex-validated at load (`/^U[A-Z2-7]{55}$/`),
 * so a bare `<REPLACE_ME>` would FAIL to parse — defeating the "every file
 * parses cleanly out of the box" guarantee. Matching `docs/config-layout/`'s
 * own convention, we emit this valid-format all-A placeholder (it parses) with
 * a REPLACE_ME comment beside it. REPLACE it with the real pubkey after first
 * boot (paste from the cortex log `stack signing key staged …`).
 */
const NKEY_PUB_PLACEHOLDER = "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function stackYaml(
  slug: string,
  principal: string,
  stackId: string,
  agentId: string,
  displayName: string,
  seedPath: string,
): string {
  // The per-deployment stack layer — substituted from
  // docs/config-layout/stacks/research.yaml. principal-only policy pattern.
  return `# =============================================================================
# stacks/${slug}.yaml — this stack's per-deployment layer (the file you EDIT daily)
# =============================================================================
# Generated by \`cortex stack create\` (#808), born aligned: this file lives at
# <config-dir>/${slug}/stacks/${slug}.yaml and its stack.id trailing segment is
# "${slug}" — dir == slug == stack.id, so the slug<->stack.id drift the install-
# time \`warn_stack_identity_drift\` detector (ADR-0004) catches can never form.
# See docs/config-layout/stacks/research.yaml for the fully-annotated reference.

# -----------------------------------------------------------------------------
# principal — who is running this stack (id + Discord identity)
# -----------------------------------------------------------------------------
principal:
  id: ${principal}
  displayName: ${principal}
  discordId: "<REPLACE_ME>"   # your numeric Discord snowflake

# -----------------------------------------------------------------------------
# stack — identity of THIS deployment within the principal (signing identity)
# -----------------------------------------------------------------------------
# \`arc upgrade cortex\` auto-provisions the seed at nkey_seed_path on first
# install if it is missing — do NOT generate it by hand. After first boot, paste
# the U-prefixed pubkey from the cortex log line \`stack signing key staged …\`
# into nkey_pub to pin it.
stack:
  id: ${stackId}
  nkey_seed_path: ${seedPath}   # SU…-prefixed NATS user seed, chmod 600 (auto-provisioned)
  # Valid-FORMAT placeholder so this file loads; REPLACE with the real U-prefixed
  # pubkey after first boot (cortex log: "stack signing key staged …").
  nkey_pub: ${NKEY_PUB_PLACEHOLDER}  # <REPLACE_ME>

# -----------------------------------------------------------------------------
# capabilities — STACK CATALOG (source of truth for capability-dispatch)
# -----------------------------------------------------------------------------
capabilities:
  - id: chat
    description: Conversational dispatch (no-prefix synchronous chat)
    provided_by: [${agentId}]

# -----------------------------------------------------------------------------
# policy — PRINCIPAL-ONLY pattern (CRITICAL for any guild others can join)
# -----------------------------------------------------------------------------
# List ONLY the human principal in principals[] with their Discord id. A
# non-principal's @mention resolves to authorIsPrincipal=false → hard-blocked
# silently. The assistant answers the principal and no one else.
policy:
  principals:
    - id: ${agentId}                  # the stack's own signing identity (the agent)
      home_principal: ${principal}
      home_stack: ${stackId}
      nkey_pub: ${NKEY_PUB_PLACEHOLDER}  # <REPLACE_ME>: ${agentId}'s U-prefixed pubkey (matches agents[].nkey_pub)
      role:
        - principal-role
      trust: []
      platform_ids: {}
    - id: ${principal}                # the human — the ONLY human principal
      home_principal: ${principal}
      home_stack: ${stackId}
      role:
        - principal-role
      trust: []
      platform_ids:
        discord:
          - "<REPLACE_ME>"            # your numeric Discord id
  roles:
    - id: principal-role
      capabilities:
        - dispatch.${agentId}
        - keyword.chat
        - keyword.async
        - keyword.team
        - tool.bash
        - tool.read
        - tool.glob
        - tool.grep

# -----------------------------------------------------------------------------
# agents — first-class agents on this stack
# -----------------------------------------------------------------------------
agents:
  - id: ${agentId}
    displayName: ${JSON.stringify(displayName)}
    persona: ./personas/${agentId}.md
    nkey_pub: ${NKEY_PUB_PLACEHOLDER}  # <REPLACE_ME>: ${agentId}'s U-prefixed pubkey
    roles: []
    trust: []
    runtime:
      substrate: claude-code
      mode: in-process
      capabilities:
        - chat
    # EMPTY — the Discord binding folds in from surfaces/surfaces.yaml.
    presence: {}

# -----------------------------------------------------------------------------
# github — webhook ingestion + which repos this stack is scoped to
# -----------------------------------------------------------------------------
github:
  webhookSecret: ""                   # paste the GitHub App HMAC secret once wired; empty = off
  repos: []                           # e.g. [{ short: cortex, full: the-metafactory/cortex }]
`;
}

function pointerYaml(slug: string): string {
  // The sentinel pointer — contents ignored; dirname selects the layout, basename
  // names the per-stack PID file. Per-stack name (not uniform cortex.yaml) avoids
  // the PID-collision landmine (migration 0003).
  return `# =============================================================================
# ${slug}.yaml — the POINTER (sentinel) file (IAW CFG / migration 0003)
# =============================================================================
# Generated by \`cortex stack create\` (#808). Point your daemon's --config here:
#
#     cortex start --config ~/.config/cortex/${slug}/${slug}.yaml
#
# Its CONTENTS ARE IGNORED. The loader uses only its DIRNAME to select the
# config-split layout (the system/system.yaml marker beside it), and its
# BASENAME to name the single-instance PID file (cortex-${slug}.pid) — which is
# why every stack's pointer MUST be per-stack-named, never a uniform
# cortex.yaml (the PID-collision landmine, migration 0003).
pointer: true   # cosmetic marker only — the loader never reads this value
`;
}

function personaStub(agentId: string, displayName: string, stackId: string): string {
  return `# ${displayName}

You are **${displayName}** (\`${agentId}\`), the assistant on the \`${stackId}\` cortex stack.

<!-- Generated by \`cortex stack create\` (#808) — a minimal persona stub. -->

## Role

Collaborate with the principal in this stack's Discord guild. Answer questions,
run tasks, and surface results. You answer the principal and no one else (the
principal-only policy in \`stacks/${stackId.split("/")[1] ?? agentId}.yaml\`).

## Repo scope

<!-- Append your allowed repo slugs here so you know them without being told,
     e.g. "You work in the \`cortex\` repo (the-metafactory/cortex)." -->

## Style

Be concise, accurate, and verify before claiming. Read before you describe code.
`;
}
