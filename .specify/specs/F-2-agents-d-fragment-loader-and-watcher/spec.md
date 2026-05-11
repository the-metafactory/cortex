---
id: "F-2"
feature: "agents.d fragment loader and watcher"
status: "draft"
created: "2026-05-12"
source: "Interview answers from cortex#60 design + Ivy session 2026-05-11"
depends_on: "F-1 (PERSONA_FORMAT_VERSION constant)"
---

# Specification: agents.d fragment loader and watcher

## Overview

Extend cortex's config loader and watcher to recognize `~/.config/cortex/agents.d/*.yaml` files as per-agent identity fragments. Each fragment declares one agent (id, displayName, persona path, roles, trust, optional presence, runtime). Cortex merges all fragments into the in-memory `CortexConfig.agents[]` alongside inline-declared agents.

Today the loader reads `bot.yaml` plus `networks/*.yaml`. After this feature, it additionally reads `agents.d/*.yaml` and merges into the agent registry. Watcher fires on changes to the directory (debounced + atomic). A boot-time fragment failure refuses to start cortex; a mid-run failure keeps prior valid state and logs the error.

This is the central plumbing piece for arc-installable sub-bots — without it, `arc install <bot>` has nowhere to drop the bot's identity.

## User Scenarios

### Scenario 1: Bot installer drops a fragment

**As a** bot installer (arc lifecycle script)
**I want to** drop a YAML fragment into `~/.config/cortex/agents.d/`
**So that** cortex picks up the new agent without an operator-edit of `cortex.yaml`

**Acceptance Criteria:**
- [ ] After dropping `~/.config/cortex/agents.d/foo.yaml`, cortex's watcher fires within 500ms
- [ ] After watcher reload, `getAgentRegistry().getById("foo")` returns the new agent
- [ ] No restart of cortex required
- [ ] If the fragment is invalid YAML or trust references unresolvable id: prior valid state is retained; cortex logs the error naming filename + line

### Scenario 2: Operator drops a malformed fragment

**As a** cortex operator
**I want to** see a clear error if I drop a malformed fragment
**So that** I can fix the file and try again without cortex's running state being corrupted

**Acceptance Criteria:**
- [ ] Malformed YAML → reload aborts; prior `agents[]` unchanged; error log names file + parser line
- [ ] Duplicate `id` across fragments → reload aborts; error names both files + the conflicting id
- [ ] `id` collision with inline `cortex.yaml` `agents[]` → inline wins; warning log names the shadowed fragment
- [ ] Unresolvable trust reference → reload aborts; error names the source agent + the missing target id (per `AgentRegistry` rule 1)
- [ ] Missing required field (`id`, `roles`, `persona`, `runtime.{substrate,mode,capabilities}`) → reload aborts; error names file + missing field

### Scenario 3: Cortex starts with broken fragments on disk

**As a** cortex operator
**I want to** cortex to refuse to start if any fragment in `agents.d/` is invalid
**So that** I don't get a half-loaded registry that silently misses agents

**Acceptance Criteria:**
- [ ] Boot-time fragment failure → cortex exits with non-zero status; stderr names the failing fragment(s); systemd/launchd captures the error
- [ ] Boot-time success → all fragments + inline agents merged; AgentRegistry constructed; cortex.ts wires through normally

### Scenario 4: Operator explicitly triggers a reload

**As a** cortex operator
**I want to** force a reload via `cortex agents reload` or SIGHUP
**So that** I can confirm a fresh fragment was picked up without waiting for the watcher debounce

**Acceptance Criteria:**
- [ ] `cortex agents reload` triggers the same code path as the watcher
- [ ] SIGHUP triggers the same reload (signal handler registered at cortex.ts startup)
- [ ] Both emit a structured log line: `agents reload requested by <source>` where source is `watcher | sighup | cli`

## Functional Requirements

### FR-1: Fragment file format

Each `agents.d/<id>.yaml` is a YAML document parseable as a single `Agent` per `CortexConfigSchema.AgentSchema` (existing in `src/common/types/cortex-config.ts`). Required fields:

| Field | Type | Validation |
|-------|------|------------|
| `id` | string | unique across fragments AND inline; matches filename stem (warning if not) |
| `displayName` | string | non-empty |
| `roles` | string[] | non-empty; at least one role required |
| `persona` | string | filesystem path; resolved relative to fragment file's dir if relative |
| `runtime.substrate` | enum | one of `claude-code | codex | pi-dev | custom` |
| `runtime.mode` | enum | one of `in-process | standalone` |
| `runtime.capabilities` | string[] | non-empty |

Optional fields: `trust: string[]` (defaults to []), `presence: { discord?, mattermost? }` (defaults to {}).

### FR-2: Loader extension

`src/common/config/loader.ts` gains a new helper:

```typescript
export function loadAgentsDirectory(dir: string): Agent[]
```

- Globs `dir/*.yaml` (alphabetical order — stable)
- Parses each via `AgentSchema.parse()` from `cortex-config.ts`
- Returns parsed agents in load order
- Throws `FragmentLoadError` (new error class) on any failure, naming the failing file
- Returns empty array if `dir` doesn't exist (operator hasn't created it yet)
- Skips non-`.yaml` files and dotfiles silently

The main `loadCortexConfig()` (or equivalent — name may evolve during the bot.yaml→cortex.yaml migration) merges:
1. Inline `agents[]` from the primary config file
2. Fragments from `agents.d/`
3. Resolves collisions per the rules:
   - frag↔frag same id → throw `DuplicateAgentIdError` (existing class in registry.ts)
   - inline↔frag same id → inline wins; log warning
4. Validates trust references via `new AgentRegistry(mergedAgents)` (existing class throws `UnknownAgentReferenceError` on unresolved trust)

### FR-3: Watcher extension

`src/common/config/watcher.ts` gains a new watch target — the `agents.d/` directory.

- Uses `fs.watch(dir, { recursive: false })`
- Debounces events: 200ms quiet period before firing reload
- On reload: invokes the full loader; if loader throws, emits a `ConfigChangeEvent` with `failed: true` + the error; prior in-memory config remains active
- On success: emits `ConfigChangeEvent` with the new merged config; downstream subscribers (AgentRegistry consumers) rebuild from it

Filesystem events watched: file create, modify, delete. Atomic save (write-temp + rename) counts as create+delete pair; debouncing handles this naturally.

### FR-4: Boot-time strictness

`cortex.ts` (startup path) calls `loadCortexConfig()`; if any fragment fails, the function throws and cortex exits with non-zero status. No partial-load mode. Operator must fix or remove the bad fragment.

This matches the locked design decision (interview answer for F-2.Q2): "Strict — refuse to start if any fragment fails."

### FR-5: Mid-run reload behavior

When the watcher (or `cortex agents reload` CLI, or SIGHUP) triggers a reload at runtime, and the load fails:

- The current in-memory `CortexConfig` + `AgentRegistry` stay live
- A structured error log names the failing fragment(s) + reason
- A `ConfigChangeEvent` with `failed: true` is emitted to subscribers (dashboard can surface "reload failed" badge)
- No exit. Cortex keeps serving with the prior config.

This is the safer interpretation of "Strict — refuse to start if any fragment fails": at boot it refuses; mid-run it keeps prior valid state rather than crashing operating cortex.

### FR-6: Reload event payload

`ConfigChangeEvent` (existing in watcher.ts) gains optional fields:

```typescript
interface ConfigChangeEvent {
  // existing fields preserved
  applied: string[];
  requiresRestart: string[];
  config: CortexConfig;
  // new fields
  source: "watcher" | "sighup" | "cli";
  failed?: boolean;
  error?: { file: string; reason: string };
  agentsAdded?: string[];      // newly-registered agent ids
  agentsRemoved?: string[];    // agent ids no longer in fragments
  agentsChanged?: string[];    // ids whose definition changed
}
```

Agents diff is computed against the prior in-memory `agents[]` so consumers (e.g. dashboard) can render incremental updates.

## Non-Functional Requirements

- **Performance:**
  - Load time per fragment: < 5ms (YAML parse + Zod validate)
  - Full reload (≤ 50 fragments): < 200ms wall clock including filesystem scan
  - Watcher debounce: 200ms (configurable via `cortex.yaml` `agentsDirectory.debounceMs`)
- **Security:**
  - Loader uses `yaml.parse()` (NOT `parseAllDocuments` — single-doc only); rejects multi-doc files
  - No shell expansion in `persona:` paths; only `~` → `$HOME` and relative→absolute resolution
  - Fragment files must be `chmod 644` or stricter; loader does NOT chmod-check in v1 (operator responsibility)
- **Failure Behavior:**
  - Fragment with invalid YAML → reject (boot exit / mid-run keep prior)
  - Fragment with unresolvable trust → reject
  - Duplicate id across fragments → reject
  - Filesystem permission denied → reject; error names the file + EACCES
  - Watcher loses inotify handle (rare on macOS) → cortex logs warning, watcher rebound on next event

## Key Entities

| Entity | Description | Key Attributes |
|--------|-------------|----------------|
| Agent fragment | YAML file at `~/.config/cortex/agents.d/<id>.yaml` | Single `Agent` per `AgentSchema` |
| `FragmentLoadError` | New error class in loader | `{ file: string, reason: string, cause?: Error }` |
| `loadAgentsDirectory(dir)` | New loader function | Returns `Agent[]` |
| `ConfigChangeEvent` | Extended | Adds `source`, `failed`, `error`, `agentsAdded/Removed/Changed` |

## Success Criteria

- [ ] `loadAgentsDirectory()` exists in `src/common/config/loader.ts` and is exported
- [ ] Watcher in `src/common/config/watcher.ts` includes `agents.d/` as a watched target
- [ ] Boot-time fragment failure → cortex exits non-zero
- [ ] Mid-run fragment failure → prior config retained; warning logged
- [ ] frag↔frag dup id → reject with named error
- [ ] inline↔frag dup id → inline wins; warning logged
- [ ] Unresolvable trust → reject with named error
- [ ] 50+ unit tests + at least 5 integration tests with a temp-dir filesystem
- [ ] `bunx tsc --noEmit` clean
- [ ] Full `bun test` passes (modulo known mission-control React shell test)
- [ ] Echo review approves with 0 blockers / 0 majors

## Assumptions

| Assumption | What Would Invalidate It | Detection Strategy |
|-----------|-------------------------|-------------------|
| Fragment file count stays under ~50 | Some operator runs hundreds of bots | Watcher performance test at 100 / 500 fragments; revisit when real deployments approach 50 |
| `fs.watch` is reliable on macOS + Linux for the target directory | Operator's filesystem doesn't fire events (NFS, FUSE) | Document the failure mode; provide `cortex agents reload` as escape hatch (F-3) |
| Inline `agents[]` + fragments cover all real configurations | Some operator needs additional config sources (URL fetch, KV store) | Future enhancement; deferred |

## System Context

### Upstream Dependencies

| System | What We Get | What Breaks If It Changes | Version/Contract |
|--------|-------------|---------------------------|------------------|
| `yaml` npm package | YAML parser | Fragment parsing breaks | ^2.8.3 |
| `zod/v4` | Schema validation via `AgentSchema` | Type validation breaks | ^4.3.6 |
| F-1 `PERSONA_FORMAT_VERSION` | (Imported but not yet used at load time) | F-2 builds cleanly | Future F-5 will use it |

### Downstream Consumers

| System | What They Expect | Breaking Change Threshold |
|--------|-----------------|--------------------------|
| F-3 `cortex agents reload` CLI | Calls into the same code path the watcher uses | Function signature change |
| F-5 `CortexHostAdapter` | Drops fragments into the watched dir; expects watcher to pick them up | Dir path or naming convention change |
| Dashboard | `ConfigChangeEvent` emission with `agentsAdded/Removed/Changed` | Event payload structure |
| `cortex.ts` startup | `loadCortexConfig()` throws on fragment failure | Strict boot-time behavior |

### Adjacent Systems

| System | Implicit Dependency | Risk |
|--------|---------------------|------|
| `AgentRegistry` (existing — registry.ts) | Throws `UnknownAgentReferenceError` on unresolved trust; loader catches and translates to `FragmentLoadError` | Registry contract change |
| `bot.yaml` → `cortex.yaml` migration | Loader currently reads `bot.yaml`; agents.d/ design assumes `cortex.yaml` is the primary | Coordinate naming — keep loader function-name-stable across the rename |

## [NEEDS CLARIFICATION]

- None. Interview locked all four key decisions (reload trigger, atomicity, required fields). Implementation choices (debounce window 200ms, glob alphabetical, error class naming) self-decided per code-quality conventions in the existing cortex codebase.

## Out of Scope

- **fragments-d subdirectories** — only `agents.d/*.yaml` flat; no recursive scan
- **Cross-fragment shared config** — each fragment is fully self-contained; no `extends:` mechanism
- **Hot-swap watcher implementation** — `fs.watch` only; no chokidar / file polling alternatives in v1
- **Persona file content validation** — loader resolves the path + checks existence; deep parse of persona frontmatter happens elsewhere (F-2 only checks the file exists; F-5 / runner does the parse)
- **`cortex agents reload` CLI** — separate feature (F-3); F-2 ships the underlying function only
- **Watch on `personas/` directory** — persona changes need an `arc upgrade <bot>` per cortex#58 §12. Not in v1.
