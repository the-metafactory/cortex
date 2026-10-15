/**
 * F-092: Config Hot-Reload
 * Watches bot.yaml for changes and applies safe fields without restart.
 */

import { watch, type FSWatcher, existsSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { loadConfig, loadAgentsDirectory, FragmentLoadError, expandTilde } from "./loader";
import type { AgentConfig } from "../types/config";
import type { Agent } from "../types/cortex-config";

export interface ConfigChangeEvent {
  /** Fields that were applied without requiring restart */
  applied: string[];
  /** Fields that changed but require restart */
  requiresRestart: string[];
  /** New config (already applied to the watcher's internal state) */
  config: AgentConfig;
}

export type ConfigChangeHandler = (event: ConfigChangeEvent) => void;

/**
 * Fields safe to hot-reload (no connection restart needed).
 * Changes to these fields are applied immediately.
 */
const SAFE_FIELDS = new Set([
  // Claude execution config
  "claude.timeoutMs",
  "claude.asyncTimeoutMs",
  "claude.additionalArgs",
  "claude.allowedTools",
  "claude.disallowedTools",
  "claude.bashAllowlist",
  "claude.allowedDirs",
  "claude.readOnlyDirs",

  // Discord instance config (per instance)
  "discord.contextDepth",
  "discord.enableAgentLog",
  "discord.worklogChannelId",
  "discord.roles",
  "discord.defaultRole",
  "discord.dm",

  // Mattermost instance config (per instance)
  "mattermost.channels",
  "mattermost.allowedUsers",
  "mattermost.roles",
  "mattermost.defaultRole",
  "mattermost.pollIntervalMs",

  // Attachments
  "attachments.enabled",
  "attachments.maxFileSizeBytes",
  "attachments.maxTotalSizeBytes",
  "attachments.maxAttachmentsPerMessage",

  // GitHub config
  "github.webhookSecret",
  "github.repos",
  "github.agentDetection",

  // Agent identity
  "agent.displayName",
]);

/**
 * Fields that require a full restart.
 * Changes to these fields are logged but NOT applied.
 */
const RESTART_FIELDS = new Set([
  // Connection credentials
  "discord.token",
  "discord.guildId",
  "discord.agentChannelId",
  "discord.logChannelId",
  "mattermost.apiUrl",
  "mattermost.apiToken",
  "mattermost.webhookUrl",
  "mattermost.webhookToken",

  // Agent core identity
  // cortex#429 PR-C — `agent.operatorId/Discord/Mattermost` retired from
  // schema. Principal identity lives on `principal.*` (handled by the
  // cortex-config watcher path) and platform ids on
  // `principal.discordId/mattermostId/slackId`.
  "agent.name",

  // Execution backend
  "execution.default",
  "execution.backends",

  // Paths
  "paths.publishedEventsDir",
  "paths.logDir",
]);

/**
 * Compare two config objects and determine which fields changed.
 * Returns:
 * - applied: fields safe to hot-reload
 * - requiresRestart: fields requiring restart
 */
function compareConfigs(oldConfig: AgentConfig, newConfig: AgentConfig): {
  applied: string[];
  requiresRestart: string[];
} {
  const applied: string[] = [];
  const requiresRestart: string[] = [];

  // Helper: dynamic-key access on a typed object via a structural cast.
  // `Record<string, unknown>` is structurally satisfied by every object, so
  // this avoids the `any` cast that would otherwise break type-safety on
  // surrounding code. Used for dynamic-key walks where the key set is only
  // known at runtime (e.g., diffing config blocks).
  const pickField = (obj: object, key: string): unknown =>
    (obj as Record<string, unknown>)[key];

  // Helper: deep compare two values
  const isDifferent = (a: unknown, b: unknown): boolean => {
    if (a === b) return false;
    if (typeof a !== typeof b) return true;
    if (a === null || b === null) return a !== b;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return true;
      return a.some((item, i) => isDifferent(item, b[i] as unknown));
    }
    if (typeof a === "object" && typeof b === "object") {
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return true;
      return aKeys.some((key) => isDifferent(pickField(a, key), pickField(b, key)));
    }
    return true;
  };

  // Check top-level fields
  const checkField = (path: string, oldVal: unknown, newVal: unknown) => {
    if (!isDifferent(oldVal, newVal)) return;

    if (SAFE_FIELDS.has(path)) {
      applied.push(path);
    } else if (RESTART_FIELDS.has(path)) {
      requiresRestart.push(path);
    } else {
      // Unknown field — be conservative, require restart
      requiresRestart.push(path);
    }
  };

  // Agent fields
  if (isDifferent(oldConfig.agent, newConfig.agent)) {
    for (const key of Object.keys(newConfig.agent)) {
      checkField(`agent.${key}`, pickField(oldConfig.agent, key), pickField(newConfig.agent, key));
    }
  }

  // Claude fields
  if (isDifferent(oldConfig.claude, newConfig.claude)) {
    for (const key of Object.keys(newConfig.claude)) {
      checkField(`claude.${key}`, pickField(oldConfig.claude, key), pickField(newConfig.claude, key));
    }
  }

  // Attachments fields
  if (isDifferent(oldConfig.attachments, newConfig.attachments)) {
    for (const key of Object.keys(newConfig.attachments)) {
      checkField(`attachments.${key}`, pickField(oldConfig.attachments, key), pickField(newConfig.attachments, key));
    }
  }

  // GitHub fields
  if (isDifferent(oldConfig.github, newConfig.github)) {
    for (const key of Object.keys(newConfig.github)) {
      checkField(`github.${key}`, pickField(oldConfig.github, key), pickField(newConfig.github, key));
    }
  }

  // (api.* removed in #882 — the embedded-dashboard block was retired per
  // ADR-0005/#712 and dropped from AgentConfigSchema. A stray `api:` left in a
  // config is stripped at parse, so it never surfaces as a watched field.)

  /**
   * Compare old and new instance arrays, detect added/removed/changed instances.
   */
  const compareInstanceArrays = <T extends Record<string, unknown>>(
    oldInstances: T[],
    newInstances: T[],
    platformName: string,
    getInstanceId: (inst: T) => string
  ): void => {
    const oldMap = new Map(oldInstances.map((inst) => [getInstanceId(inst), inst]));
    const newMap = new Map(newInstances.map((inst) => [getInstanceId(inst), inst]));

    for (const [id, newInst] of newMap) {
      const oldInst = oldMap.get(id);
      if (!oldInst) {
        requiresRestart.push(`${platformName}[${id}]`);
        continue;
      }
      for (const key of Object.keys(newInst)) {
        if (key === "instanceId") continue;
        checkField(`${platformName}.${key}`, pickField(oldInst, key), pickField(newInst, key));
      }
    }

    for (const id of oldMap.keys()) {
      if (!newMap.has(id)) {
        requiresRestart.push(`${platformName}[${id}] (removed)`);
      }
    }
  };

  // Discord instances
  compareInstanceArrays(
    oldConfig.discord,
    newConfig.discord,
    "discord",
    (inst) => {
      const id = pickField(inst, "instanceId");
      const guild = pickField(inst, "guildId");
      return (typeof id === "string" ? id : undefined) ??
        (typeof guild === "string" ? guild : "default");
    }
  );

  // Mattermost instances
  compareInstanceArrays(
    oldConfig.mattermost,
    newConfig.mattermost,
    "mattermost",
    (inst) => {
      const id = pickField(inst, "instanceId");
      return typeof id === "string" ? id : "default";
    }
  );

  return { applied, requiresRestart };
}

/** Upper bound on a watcher's `waitForReady()` handshake. */
const READY_TIMEOUT_MS = 8_000;
/** How long a handshake first waits for its probe's event; doubles per unanswered probe. */
const READY_PROBE_FIRST_WAIT_MS = 100;
const READY_PROBE_MAX_WAIT_MS = 1_600;
/** Filename prefix of `AgentsDirectoryWatcher`'s probe dotfiles. */
const READY_PROBE_PREFIX = ".cortex-watch-ready-";
let readyProbeCounter = 0;

/**
 * The `waitForReady()` handshake both watchers share: call `probe`, wait for
 * `seen` (the watcher reported an event), and on silence probe again with a
 * doubling wait, until `seen` resolves (resolve), `isStopped` turns true
 * (resolve — a test timed out and cleaned up), or `timeoutMs` runs out
 * (reject with `timeoutMessage`).
 */
async function awaitWatchHandshake(opts: {
  seen: Promise<true>;
  probe: () => void;
  isStopped: () => boolean;
  timeoutMs: number;
  timeoutMessage: string;
}): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let waitMs = READY_PROBE_FIRST_WAIT_MS;
  for (;;) {
    if (opts.isStopped()) return;
    opts.probe();
    const wait = Math.max(0, Math.min(waitMs, deadline - Date.now()));
    const reported = await Promise.race([
      opts.seen,
      new Promise<false>((resolve) => setTimeout(() => { resolve(false); }, wait)),
    ]);
    if (reported) return;
    if (Date.now() >= deadline) throw new Error(opts.timeoutMessage);
    waitMs = Math.min(waitMs * 2, READY_PROBE_MAX_WAIT_MS);
  }
}

/**
 * Watches bot.yaml for changes and triggers reload events.
 */
export class ConfigWatcher {
  private configPath: string;
  private config: AgentConfig;
  private handler: ConfigChangeHandler;
  private watcher: FSWatcher | null = null;
  private reloadTimeout: NodeJS.Timeout | null = null;
  /** Set while `waitForReady()` probes: every event resolves it instead of reloading. */
  private readyProbeSeen: (() => void) | null = null;

  constructor(configPath: string, initialConfig: AgentConfig, handler: ConfigChangeHandler) {
    this.configPath = configPath.replace(/^~/, process.env.HOME ?? "~");
    this.config = initialConfig;
    this.handler = handler;
  }

  start(): void {
    if (!existsSync(this.configPath)) {
      console.error(`config-watcher: config file not found at ${this.configPath}`);
      return;
    }

    console.log(`config-watcher: watching ${this.configPath} for changes`);

    // Debounced reload: wait 200ms after last change before reloading
    const triggerReload = () => {
      if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
      this.reloadTimeout = setTimeout(() => {
        this.reload();
      }, 200);
    };

    this.watcher = watch(this.configPath, { persistent: false }, (eventType: string) => {
      if (this.readyProbeSeen) {
        this.readyProbeSeen();
        return;
      }
      if (eventType === "change") {
        triggerReload();
      }
    });
  }

  /**
   * Resolves once fs.watch is delivering events for the config file —
   * immediately if the watcher is not watching. Bun binds the watch
   * asynchronously after `start()` returns, and a write that lands before it
   * binds is never reported; under load that takes far longer than any fixed
   * grace (node #2576). So this is a handshake: it touches the file's times
   * (content unchanged), backing off, until the watcher reports a touch.
   * Events seen while probing do not reload. Rejects after
   * `timeoutMs`. Tests await it before writing the change they assert on;
   * production does not need it.
   */
  async waitForReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    if (this.watcher === null) return;
    const seen = new Promise<true>((resolve) => {
      this.readyProbeSeen = () => {
        resolve(true);
      };
    });
    try {
      await awaitWatchHandshake({
        seen,
        probe: () => {
          const now = new Date();
          utimesSync(this.configPath, now, now);
        },
        isStopped: () => this.watcher === null,
        timeoutMs,
        timeoutMessage: `config-watcher: fs.watch on ${this.configPath} reported no event within ${timeoutMs}ms`,
      });
    } finally {
      this.readyProbeSeen = null;
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
      this.reloadTimeout = null;
    }
  }

  /**
   * Reload config from disk, validate, compare, and trigger handler.
   */
  private reload(): void {
    try {
      console.log("config-watcher: reloading config...");

      const newConfig = loadConfig(this.configPath);
      const changes = compareConfigs(this.config, newConfig);

      // Apply the new config (handler is responsible for updating its own state)
      this.config = newConfig;

      // Log what changed
      if (changes.applied.length > 0) {
        console.log(`config-watcher: applied ${changes.applied.length} change(s):`, changes.applied.join(", "));
      }
      if (changes.requiresRestart.length > 0) {
        console.warn(
          `config-watcher: ${changes.requiresRestart.length} field(s) require restart:`,
          changes.requiresRestart.join(", ")
        );
      }
      if (changes.applied.length === 0 && changes.requiresRestart.length === 0) {
        console.log("config-watcher: no changes detected");
      }

      // Trigger handler
      this.handler({
        applied: changes.applied,
        requiresRestart: changes.requiresRestart,
        config: newConfig,
      });
    } catch (err) {
      console.error("config-watcher: reload failed:", err instanceof Error ? err.message : err);
    }
  }

  /** Get current config (reflects last successful reload) */
  getConfig(): AgentConfig {
    return this.config;
  }
}

// =============================================================================
// F-2 — AgentsDirectoryWatcher (cortex#60 §6.1)
// =============================================================================

/**
 * Event emitted by `AgentsDirectoryWatcher` when fragments under
 * `~/.config/cortex/agents.d/` change. Separate shape from `ConfigChangeEvent`
 * because the agents-d surface is independent of the bot.yaml loader (today)
 * and will stay separable when the loader migrates to cortex.yaml.
 */
export interface AgentsChangeEvent {
  /** Source that triggered the reload. */
  source: "watcher" | "sighup" | "cli";
  /**
   * `true` if the reload threw `FragmentLoadError`. When true, `agents` is
   * the PRIOR valid set (not the failed one) — caller keeps using it.
   */
  failed: boolean;
  /** Populated only when `failed: true`. */
  error?: { file: string; reason: string };
  /** Currently active agent set. On success: the fresh load. On failure:
   *  the last-known-good set. */
  agents: Agent[];
  /** Agent ids in the new set that were not in the prior set. */
  agentsAdded: string[];
  /** Agent ids in the prior set that are no longer in the new set. */
  agentsRemoved: string[];
  /** Agent ids whose definition (JSON-stringified shape) changed. */
  agentsChanged: string[];
}

export type AgentsChangeHandler = (event: AgentsChangeEvent) => void;

/**
 * Watches an `agents.d/` directory for fragment file changes and reloads
 * via `loadAgentsDirectory()` on a 200ms debounce. Emits `AgentsChangeEvent`
 * to the handler.
 *
 * Mid-run failure handling (cortex#60 spec §FR-5): when a reload throws
 * `FragmentLoadError`, the watcher retains the prior `Agent[]` and emits a
 * `failed: true` event. The handler can render a "reload failed" badge but
 * the in-memory state stays consistent.
 *
 * The watcher does NOT enforce boot-time strictness — that's the loader's
 * job at startup (caller invokes `loadAgentsDirectory()` directly + lets
 * `FragmentLoadError` propagate; the watcher only starts AFTER a successful
 * initial load).
 */
export class AgentsDirectoryWatcher {
  private agentsDir: string;
  private agents: Agent[];
  private handler: AgentsChangeHandler;
  private debounceMs: number;
  private watcher: FSWatcher | null = null;
  private reloadTimeout: NodeJS.Timeout | null = null;

  constructor(
    agentsDir: string,
    initialAgents: Agent[],
    handler: AgentsChangeHandler,
    options: { debounceMs?: number } = {},
  ) {
    // Echo M1 — single source-of-truth tilde expansion shared with the loader.
    this.agentsDir = expandTilde(agentsDir);
    this.agents = initialAgents;
    this.handler = handler;
    this.debounceMs = options.debounceMs ?? 200;
  }

  /** Set while `waitForReady()` waits: any event resolves it. */
  private readySeen: (() => void) | null = null;
  /** Every probe `waitForReady()` wrote; removed by `stop()`. */
  private readyProbePaths: string[] = [];
  /** {@link fragmentSignature} as of `start()` / the last reload. */
  private loadedSignature = "";

  start(): void {
    if (!existsSync(this.agentsDir)) {
      // Principal hasn't created agents.d/ yet. The watcher noops — when arc
      // first drops a fragment, fs.watch on the parent dir would catch it
      // but that widens scope. For v1: log + return. Principal restarts cortex
      // after creating the dir, or invokes `cortex agents reload` (F-3).
      console.warn(`agents-watcher: agents.d directory not found at ${this.agentsDir} — watcher idle`);
      return;
    }

    console.log(`agents-watcher: watching ${this.agentsDir} for fragment changes`);
    this.loadedSignature = this.fragmentSignature();

    const triggerReload = (source: "watcher" | "sighup" | "cli" = "watcher") => {
      if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
      this.reloadTimeout = setTimeout(() => {
        this.reload(source);
      }, this.debounceMs);
    };

    this.watcher = watch(this.agentsDir, { persistent: false }, (eventType: string, filename: string | null) => {
      // Only react to YAML file events. Don't fire on dotfile flutter.
      // Any event shows the watch is live (see waitForReady).
      this.readySeen?.();
      if (!filename) return;
      if (filename.startsWith(READY_PROBE_PREFIX)) {
        // A probe write can be reported after its handshake ended (twice, or
        // late under an fseventsd backlog). Bun 1.3 reports only the first
        // filename of a coalesced batch, so that event may be all that is left
        // of a fragment write in the same batch: reload if fragments changed.
        if (this.readySeen === null && this.fragmentSignature() !== this.loadedSignature) {
          triggerReload("watcher");
        }
        return;
      }
      if (filename.startsWith(".")) return;
      if (!filename.endsWith(".yaml") && !filename.endsWith(".yml")) return;
      // eventType is "rename" (create/delete) or "change" — both warrant a reload.
      if (eventType === "rename" || eventType === "change") {
        triggerReload("watcher");
      }
    });
  }

  /**
   * Resolves once fs.watch is delivering events for agents.d/ — immediately
   * if the watcher is idle (no agents.d/) or not started. Bun binds the watch
   * asynchronously after `start()` returns, and a write that lands before it
   * binds is never reported; under load that takes far longer than any fixed
   * grace (node #2576). So this is a handshake, not a sleep: it writes dotfile
   * probes (never a reload), backing off, until the watcher reports any event.
   * A probe's event that arrives after the handshake is handled in the watch
   * callback. The probes stay until `stop()`, since removing one would emit
   * another such event. Rejects after `timeoutMs`. Tests await it before
   * writing fixtures; production does not need it.
   */
  async waitForReady(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    if (this.watcher === null) return;
    const seen = new Promise<true>((resolve) => {
      this.readySeen = () => {
        resolve(true);
      };
    });
    try {
      await awaitWatchHandshake({
        seen,
        probe: () => {
          const probePath = join(this.agentsDir, `${READY_PROBE_PREFIX}${process.pid}-${++readyProbeCounter}`);
          writeFileSync(probePath, "");
          this.readyProbePaths.push(probePath);
        },
        isStopped: () => this.watcher === null,
        timeoutMs,
        timeoutMessage: `agents-watcher: fs.watch on ${this.agentsDir} reported no event within ${timeoutMs}ms`,
      });
    } finally {
      this.readySeen = null;
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.reloadTimeout) {
      clearTimeout(this.reloadTimeout);
      this.reloadTimeout = null;
    }
    for (const probePath of this.readyProbePaths) rmSync(probePath, { force: true });
    this.readyProbePaths = [];
  }

  /**
   * Public entry point for non-watcher-triggered reloads. F-3's CLI
   * (`cortex agents reload`) and the SIGHUP handler will call this with
   * the appropriate `source` value.
   */
  triggerReload(source: "sighup" | "cli"): void {
    if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
    // Skip debounce for explicit triggers — principal wants the reload now.
    this.reload(source);
  }

  /** Get the current agent set (reflects last successful reload). */
  getAgents(): Agent[] {
    return this.agents;
  }

  /**
   * Name, size and mtime of every fragment file the reload reads (the same
   * dotfile / extension filter as the fs.watch callback) — enough to tell
   * whether fragments changed since the last load without loading them.
   */
  private fragmentSignature(): string {
    let names: string[];
    try {
      names = readdirSync(this.agentsDir);
    } catch (_err) {
      // agents.d/ removed under the watcher: no fragments to compare.
      return "";
    }
    return names
      .filter((n) => !n.startsWith(".") && (n.endsWith(".yaml") || n.endsWith(".yml")))
      .sort()
      .map((n) => {
        try {
          const s = statSync(join(this.agentsDir, n));
          return `${n}:${s.size}:${s.mtimeMs}`;
        } catch (_err) {
          // Removed between readdir and stat — absent from the signature.
          return "";
        }
      })
      .join("|");
  }

  private reload(source: "watcher" | "sighup" | "cli"): void {
    try {
      this.loadedSignature = this.fragmentSignature();
      const fresh = loadAgentsDirectory(this.agentsDir);
      const diff = diffAgents(this.agents, fresh);
      this.agents = fresh;
      this.handler({
        source,
        failed: false,
        agents: fresh,
        agentsAdded: diff.added,
        agentsRemoved: diff.removed,
        agentsChanged: diff.changed,
      });
    } catch (err) {
      if (err instanceof FragmentLoadError) {
        // Mid-run failure: keep prior agents alive, surface the error.
        this.handler({
          source,
          failed: true,
          error: { file: err.file, reason: err.reason },
          agents: this.agents,
          agentsAdded: [],
          agentsRemoved: [],
          agentsChanged: [],
        });
      } else {
        // Unexpected error — log + emit a failed event with a synthetic file
        // path. Doesn't crash the watcher.
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`agents-watcher: unexpected reload error: ${reason}`);
        this.handler({
          source,
          failed: true,
          error: { file: this.agentsDir, reason },
          agents: this.agents,
          agentsAdded: [],
          agentsRemoved: [],
          agentsChanged: [],
        });
      }
    }
  }
}

/** Compute the agent-id diff between two Agent arrays. */
function diffAgents(
  prior: Agent[],
  next: Agent[],
): { added: string[]; removed: string[]; changed: string[] } {
  const priorById = new Map(prior.map((a) => [a.id, a]));
  const nextById = new Map(next.map((a) => [a.id, a]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const id of nextById.keys()) {
    if (!priorById.has(id)) {
      added.push(id);
    } else if (!deepEqual(priorById.get(id), nextById.get(id))) {
      // Echo N4 on cortex#62 — was JSON.stringify which depends on field
      // ordering. `deepEqual` is order-independent.
      changed.push(id);
    }
  }
  for (const id of priorById.keys()) {
    if (!nextById.has(id)) {
      removed.push(id);
    }
  }

  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * Order-independent structural equality. Handles plain objects, arrays, and
 * scalars — the shapes Agent values actually inhabit. Doesn't try to be a
 * general deep-equal (no Date/RegExp/Map/Set support); kept narrow on
 * purpose so it stays auditable.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  if (b === undefined) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}
