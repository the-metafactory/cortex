# Design — v2.0.0 policy cutover (cortex#243 + cortex#242)

**Status:** draft for discussion — schema extensions + CLI algorithm not yet ratified
**Owners:** Andreas + Luna
**Targets:** cortex#243 (migrate-config CLI extension), cortex#242 (breaking schema removal + role-resolver retirement)

---

## 1. Why we're writing this

The naive read of cortex#242/#243 is "lift the per-adapter `roles[]` blocks into the top-level `policy:` block and rip the legacy schema". That framing **understates the work** in three ways:

1. **The PolicyEngine doesn't currently enforce most of what role-resolver does.** Today the engine gates `dispatch.${agent_id}` capabilities only (dispatch-listener.ts:718). Adapter role-resolver code runs in parallel and gates `features` (chat/async/team), `disallowedTools`, `allowedDirs`, `allowedSkills`, `bashGuard`, `bashAllowlist`. Cutover requires deciding which of these become PolicyEngine capabilities vs. which stay adapter-side as session-construction parameters.

2. **Legacy "role" conflates identity-list + capability-set.** Each legacy role bundles `users[]` (Discord/Mattermost/Slack snowflakes — who) + `features[]` + `disallowedTools[]` + `allowedDirs[]` + `allowedSkills[]` (what they can do). The new schema separates these: `PolicyPrincipal` is identity, `PolicyRole` is capability set, but `PolicyPrincipal.id` is letter-prefix grammar — Discord snowflakes don't fit. We need a platform-id → principal-id mapping layer.

3. **Operator vs. user privilege class is a first-class distinction in the legacy DM model that has no analog in the new schema yet.** Legacy DiscordPresence.dm carries `operatorRole` (the human running the deployment, full access) + `defaultRole` (unknown DMs — `denied`/`allow-all`) + `userRoles[]` (per-user overrides). The new schema treats all principals symmetrically. We need either a privilege-class field on PolicyPrincipal or a convention (`operator-of-{operator_id}` role id).

Migrate-config alone can't make these decisions — they're product/schema decisions that the breaking PR (cortex#242) commits us to. **This doc decides them, then the CLI is mechanical.**

---

## 2. Inventory — what each shape carries today

### 2.1 Legacy per-adapter `roles[]` (channel-based)

`RoleSchema` in `src/common/types/config.ts:34`. Same shape for Discord, Mattermost, Slack:

| Field | Type | Semantic |
|---|---|---|
| `name` | string | Role id within this adapter |
| `users` | string[] | Platform user IDs (Discord snowflake, Mattermost UUID, Slack `U…`) that hold this role |
| `features` | (`chat` \| `async` \| `team`)[] | Message-keyword gating |
| `disallowedTools` | string[] | Claude tool deny-list, merged with `claude.disallowedTools` globally |
| `allowedDirs` | string[]? | Claude session `--add-dir` allow-list |
| `allowedSkills` | string[]? | Skill invocation allow-list (G-121). undefined → all; [] → none; [...] → only listed |

Plus per-instance:
- `defaultRole` (string) — what happens when a user isn't in any role. Values: `"allow-all"`, `"denied"`, or a named role id.

### 2.2 Legacy DM model (Discord only, separate from channel roles)

`DMConfigSchema` in `src/common/types/config.ts:100`:

| Field | Type | Semantic |
|---|---|---|
| `operatorRole` | DMRoleSchema | Applied to DMs from the operator (identified by `agent.operatorDiscordId`). Defaults to full features + bashGuard on |
| `defaultRole` | `"denied"` \| `"allow-all"` | Unknown DMs |
| `userRoles[]` | DMUserRoleSchema[] | Per-user overrides — each has `users[]` + the same field bundle |

DMRoleSchema and DMUserRoleSchema carry the same five fields as channel roles, **plus**:
- `bashGuard` (boolean, default true)
- `bashAllowlist` (object: `{ rules: [{pattern, repos?}], repos: [] }`)

### 2.3 Operator identity surface (lives on the agent, not roles)

`AgentSchema` in `src/common/types/config.ts:335`:
- `operatorDiscordId` — operator's Discord user id
- `operatorMattermostId` — operator's Mattermost user id
- `operatorSlackId` — operator's Slack user id
- `operatorId` — abstract operator id used elsewhere

The DM `operatorRole` only fires when `message.author.id === agent.operatorDiscordId`.

### 2.4 New `policy:` block (C.2a — shipped in PR #219)

`PolicySchema` in `src/common/types/cortex-config.ts:1402`:

`PolicyPrincipal`:
- `id` — letter-prefix lowercase alphanumeric + hyphen
- `home_operator` — operator id (same grammar)
- `home_stack` — `{operator_id}/{stack_id}`
- `nkey_pub?` — federated identity verification anchor
- `role[]` — role ids
- `trust[]` — peer principal ids

`PolicyRole`:
- `id`
- `capabilities[]` — opaque strings matched literally against `Intent.capability`

What's enforced today (dispatch-listener.ts:498-560): the engine gates `dispatch.${agent_id}` only. Adapter role-resolver runs parallel and gates everything else.

---

## 3. Gap analysis — what the new schema doesn't yet cover

| Legacy concern | New schema coverage today | Gap |
|---|---|---|
| `features[]` (chat/async/team) | ❌ no capability surface | Add capability ids: `keyword.chat`, `keyword.async`, `keyword.team` |
| `disallowedTools[]` | ❌ no representation | **Question:** capability per tool denial (`tool.deny.bash`)? Or carry the list verbatim on the role? See §5.2 |
| `allowedDirs[]` | ❌ no representation | Session-construction parameter, not really a capability gate. See §5.3 |
| `allowedSkills[]` | ❌ no representation | Same as allowedDirs — session-construction parameter. See §5.3 |
| `bashGuard` (boolean) | ❌ no representation | DM-only field. See §5.4 |
| `bashAllowlist` | ❌ no representation | Per-role override of global `claude.bashAllowlist`. See §5.4 |
| Platform user IDs → principal | ❌ principal.id is letter-prefix; snowflakes don't fit | Add `platform_ids: { discord?: [], mattermost?: [], slack?: [] }` to PolicyPrincipal. See §5.1 |
| Operator vs. user privilege class | ❌ no representation | Convention: an `operator` role id + reserved capability `operator` |
| `defaultRole` semantic (allow-all / denied / named-role) | ❌ no representation | Per-adapter fallback for unmatched users. See §5.5 |
| `dm.operatorRole` (operator gets full DM access) | ❌ no representation | Becomes principal with `operator` role, see §5.6 |
| `dm.defaultRole` (denied / allow-all for unknown DMs) | ❌ no representation | Adapter-side policy: see §5.5 |

**Verdict:** v2.0.0 cutover requires 6 schema extensions plus the migration CLI plus the adapter retirement. cortex#243 is the CLI; cortex#242 is the schema extension + breaking removal + role-resolver retirement.

---

## 4. Proposed conceptual model

**Principle:** PolicyEngine becomes the single decision point for **authorization** (yes/no). Adapter retains **session-construction parameters** that aren't authorization decisions (`allowedDirs`, `allowedSkills`, `bashAllowlist` — these shape *how* a granted capability is exercised, not *whether* it is).

This means:
- `features` → capabilities (authorization)
- `disallowedTools` → capabilities (authorization; deny-by-omission of `tool.<name>` capability)
- `allowedDirs` → **principal attribute** (session config, not authorization)
- `allowedSkills` → **principal attribute** (session config)
- `bashGuard` + `bashAllowlist` → **principal attribute** (session config)
- Platform user IDs → **principal attribute** (`platform_ids`)
- Operator class → **role** (`operator` role with reserved capabilities)
- `defaultRole` semantic → **principal** (`anonymous-{platform}-{instance_id}` principal with default role)

This puts everything authorization-shaped into capabilities, and everything session-shape into a richer principal — keeping the PolicyEngine's `Intent.capability` matching mechanism unchanged while preserving every legacy semantic.

---

## 5. Concrete proposals

### 5.1 Extend `PolicyPrincipal` with `platform_ids`

```ts
PolicyPrincipalSchema = z.object({
  id: ...,
  home_operator: ...,
  home_stack: ...,
  nkey_pub: ...,
  role: ...,
  trust: ...,
  // NEW
  platform_ids: z.object({
    discord: z.array(z.string()).default([]),
    mattermost: z.array(z.string()).default([]),
    slack: z.array(z.string()).default([]),
  }).default({}),
})
```

Adapter resolves inbound `message.author.id` → principal via reverse lookup. If multiple principals claim the same platform_id, schema cross-validation rejects at parse time (analogous to the existing dangling-ref `.refine()`).

### 5.2 Capability ontology — feature/tool conventions

Reserved capability ids:
- `keyword.chat`, `keyword.async`, `keyword.team` — replace `features[]`
- `tool.<lowercase-tool-name>` — granted means tool is allowed; absent means denied. `disallowedTools: ["Bash"]` migrates to: omit `tool.bash` from the role's capabilities.
- `operator` — special capability granted only to the operator role. Used by adapter to short-circuit DM gating (operator gets full access).
- `dispatch.<agent_id>` — already used by dispatch-listener.ts:718, unchanged.

Tool deny migration is interesting: legacy `disallowedTools: ["Bash", "Edit"]` becomes role.capabilities = full tool set MINUS those two. The migrate-config CLI needs a canonical tool list to invert. **Open question:** do we keep the canonical tool list in cortex, or do we change the schema to allow `tool.deny.<name>` as a deny capability that the adapter checks for explicitly?

**Recommended:** keep it allow-list. Capabilities are positive grants. The CLI converts `disallowedTools` → omit-from-list using a canonical tool inventory in `src/common/policy/tool-inventory.ts` (new file). Operators can edit the resulting `capabilities[]` after migration to be more selective.

### 5.3 Session-construction attributes on PolicyPrincipal

Andreas's config exercises real divergence between channel-context and DM-context session config (see §12.2 for the full case). The schema represents both — `default` is the channel/group context baseline; `dm` is an optional override when the principal is interacting via a 1:1 DM:

```ts
const SessionConfigShape = z.object({
  allowed_dirs: z.array(z.string()).optional(),
  allowed_skills: z.array(z.string()).optional(),
  bash_guard: z.boolean().default(true),
  bash_allowlist: z.object({...}).optional(),
});

PolicyPrincipalSchema = z.object({
  ...,
  // NEW — session config, not capabilities
  session_config: z.object({
    default: SessionConfigShape,
    dm: SessionConfigShape.optional(),
  }).optional(),
})
```

When dispatch-listener constructs a CC session for a verified principal, it picks `session_config.dm` if present and the message arrived via DM context, else `session_config.default`. Adapter no longer makes these decisions; the picking lives one place (the dispatch path) so the channel-vs-DM choice is visible in audit envelopes too.

### 5.4 `defaultRole` → "anonymous principal" convention

Each adapter instance gets a synthetic principal id like `anonymous-discord-{instanceId}` with `platform_ids: {}` (matches no one). The principal's `role[]` carries whatever defaultRole was set to:
- `"allow-all"` → `role: ["allow-all"]` (a reserved role with all keyword/tool capabilities)
- `"denied"` → `role: []` (no capabilities)
- `"some-role"` → `role: ["some-role"]` (named-role passthrough)

When `resolveRole` would fall through to defaultRole today, the new model resolves to this anonymous principal's grants.

### 5.5 Operator → reserved `operator` role + capability

Adapter at DM resolution time checks `message.author.id === agent.operatorDiscordId`. If yes, the adapter asks PolicyEngine to authorise against a special intent: `intent.capability = "operator"`. If granted (via the operator role), full access applies. The operator-only `bashGuard` / `bashAllowlist` migrate to the operator principal's `session_config`.

This preserves the legacy semantic exactly: operator gets a distinct privilege class, identified at runtime by their platform id matching `agent.operatorDiscordId`.

### 5.6 Capability namespace summary

| Capability | Meaning | Replaces |
|---|---|---|
| `dispatch.<agent_id>` | Allowed to dispatch tasks to this agent | (unchanged from C.1) |
| `keyword.chat` | Sync chat keyword | `features: ["chat"]` |
| `keyword.async` | Async keyword | `features: ["async"]` |
| `keyword.team` | Team-spawn keyword | `features: ["team"]` |
| `tool.<name>` | Allowed to use this Claude tool | inversion of `disallowedTools[]` |
| `operator` | Short-circuits DM gating to full access | `dm.operatorRole` |
| `network.<network_id>.dispatch` | Federation slice (existing, unchanged) | (Phase D) |

---

## 6. Migration mapping (cortex#243 CLI behaviour)

For each `presence.<platform>[instance].roles[]` entry:

1. **Role definition** — emit a `PolicyRole` with:
   - `id = role.name` (validate against `LETTER_PREFIX_ID_REGEX`; warn + slugify if mismatch)
   - `capabilities = [...features].map(f => "keyword." + f) + invertTools(disallowedTools) + ["dispatch." + agent.id]`

2. **Principals** — for each user in `role.users[]`:
   - Synthesize a principal id from the platform user id (algorithm in §6.1)
   - Set `platform_ids.<platform> = [user_id]`
   - Set `role = [role.name]`
   - Set `session_config` from the legacy `allowedDirs` / `allowedSkills`
   - `home_operator`, `home_stack` filled from the stack config

3. **defaultRole handling** — emit one synthetic anonymous principal per instance:
   - `id = "anonymous-" + platform + "-" + instanceId`
   - `platform_ids = {}` (no actual matches)
   - `role = [...]` per §5.4

4. **DM operator role** — emit one operator principal:
   - `id = "operator-" + operator_id` (or just `"operator"` when single-operator deployment)
   - `platform_ids = { discord: [operatorDiscordId], mattermost: [operatorMattermostId], slack: [operatorSlackId] }` (filtered to those present)
   - `role = ["operator"]`
   - `session_config` from `dm.operatorRole`'s `bashGuard` / `bashAllowlist` / `disallowedTools` / etc.

5. **Cross-adapter consistency check** — if `roles[name = X]` appears in both Discord and Mattermost with **different** field bundles → emit warning + union the capabilities + flag for operator review.

### 6.1 Principal id synthesis from platform IDs

Discord snowflake `1487123456789012345` doesn't fit letter-prefix grammar. The CLI generates a synthetic id:
- Use existing display name if reachable (CLI prompts operator to label each platform id during migration)
- Otherwise `user-{platform[0]}{last-6-of-id}` → e.g. `user-d567890`

**Open question:** should the migrate-config CLI prompt for friendly names interactively? Or generate synthetic ids and let the operator edit post-migration? Echo's earlier framing on cortex#243 said "Idempotent: running twice produces the same output" — interactive prompting breaks idempotency. Recommendation: synthetic-by-default, optional `--labels labels.yaml` flag for operator-curated names.

---

## 7. cortex#242 (breaking removal) scope

Once cortex#243 ships and operators have a migration path:

1. Drop `roles[]` from DiscordInstanceSchema / MattermostInstanceSchema / SlackInstanceSchema (cortex-config.ts:130/205/236)
2. Drop `defaultRole` from same
3. Drop entire DMConfigSchema (config.ts:100) — operator handling moves to the operator principal
4. Drop `dm.operatorRole`, `dm.defaultRole`, `dm.userRoles[]`
5. Retire `src/adapters/discord/role-resolver.ts` (~125 LOC) — replaced by PolicyEngine calls
6. Update DiscordAdapter to call PolicyEngine for each inbound message:
   - Lookup principal by `(platform, authorId)`
   - For each gating decision, `engine.check(principalId, { capability: "keyword.chat" })` etc.
   - Read `session_config` for CC session construction parameters
7. Mirror for MattermostAdapter, SlackAdapter
8. Bump `arc-manifest.yaml` → v2.0.0
9. Schema validation rejects legacy `roles[]` configs at parse time with a clear error referencing the migrate-config CLI

---

## 8. Open questions (need decisions before coding)

1. **Synthetic principal ids — interactive prompt or batch with optional labels file?** Recommendation: synthetic + optional `--labels`.
2. **Tool inventory — canonical list in repo, or invert-via-deny-capabilities?** Recommendation: canonical list in `src/common/policy/tool-inventory.ts`.
3. **`bash_allowlist` and `bash_guard` — principal attribute or role attribute?** Recommendation: principal attribute on `session_config`. Roles are pure capability sets.
4. **Cross-adapter role conflict (same `role.name` with different fields) — warn + union, warn + reject, or warn + pick-first?** Recommendation: warn + conservative union (preserves access; operator must tighten manually after migration if they want to).
5. **`defaultRole = "allow-all"` migration — emit the synthetic anonymous principal with all capabilities, or carry forward as a top-level `policy.default_grant: "allow-all"` flag?** Recommendation: synthetic principal — keeps PolicyEngine's "one principal, one decision" mental model and the migrate-config CLI doesn't need to invent a new schema field.
6. **`operatorDiscordId` field — keep on AgentSchema (legacy) or move to PolicyPrincipal.platform_ids?** Recommendation: move. Once `platform_ids` exists on the operator principal, the legacy `operatorDiscordId` field is redundant and should retire with the same v2.0.0 bump.

---

## 9. Suggested PR sequence

1. **cortex#243a (schema extension)** — add `platform_ids` + `session_config` to PolicyPrincipal. Additive; no behavioural change yet. Capability conventions documented but adapters still consult legacy roles.
2. **cortex#243b (canonical tool inventory)** — add `src/common/policy/tool-inventory.ts`. Used by migrate-config to invert `disallowedTools`.
3. **cortex#243c (migrate-config CLI extension)** — implement the conversion in §6. Idempotent. Sample inputs/outputs in `docs/migration-examples/`. SOP in `docs/sop-migrate-config.md`.
4. **cortex#242a (adapter PolicyEngine wiring)** — DiscordAdapter / MattermostAdapter / SlackAdapter call PolicyEngine for each authorization decision. Legacy role-resolver still runs in parallel as a sanity check (logs disagreements but trusts PolicyEngine when present).
5. **cortex#242b (legacy schema removal)** — drop `roles[]` + `defaultRole` + `dm` from per-adapter schemas. Drop role-resolver.ts. Bump v2.0.0. Strict-mode parse error on legacy configs with a pointer to migrate-config.

Five PRs, deliberately small, in a strict dependency order. The intermediate parallel-mode in 242a lets us catch any disagreements between legacy and new gates before committing irrevocably to PolicyEngine-only.

---

## 10. What this design does NOT change

- PolicyEngine internals (the `check()` algorithm)
- Federation policy slicing (Phase D — `policy.federated.networks[]` is orthogonal)
- Audit envelope shape (C.4 — `system.access.{allowed,denied}` already carry capability strings)
- Dispatch lifecycle envelopes (Phase A / B contracts unchanged)
- Anything in the bus / NATS / myelin layer

The cutover is a config-schema and adapter-internal change. The bus, federation, and audit surfaces are unaffected.

---

## 11. Reality-check — what Andreas's current cortex.yaml actually contains

Anchoring the design in operational config. Two files: `~/.config/cortex/cortex.yaml` (meta-factory stack) and `~/.config/cortex/cortex.work.yaml` (work stack).

### 11.1 meta-factory stack (the one this migration targets)

**Stack identity** — `andreas/meta-factory`, operator `andreas`, residency NZ.

**Three agents — Luna, Echo, Forge** — each with a Discord presence carrying its own `roles[]` list. The role lists are structurally near-identical across all three; differences are documented below.

**Distinct user/role principals across the stack:**

| Role name | Identity | Discord IDs | Cross-agent agreement |
|---|---|---|---|
| `operator` | Andreas (the operator human) | `1134325176796987522` | ✓ identical on all 3 agents — features `[chat, async, team]` |
| `user` | Mike (restricted human user) | `285727653603049472` | ✓ identical on all 3 agents — features `[chat]`, deny `[Write, Edit, NotebookEdit]` |
| `agent-restricted` | template, no users assigned | `[]` | ✓ same shape, no holders — could be retired in migration |
| `agent-luna` | Luna's bot | `1487180524542890144` | ⚠ Luna has it empty (self); Echo + Forge declare it |
| `agent-echo` | Echo's bot | `1497872105067253800` | ⚠ Luna + Forge declare it with bare `features: [chat]`; Echo's view of itself has tighter tool denies + `allowedSkills: [code-review]` (dead config — self-loop guarded) |
| `agent-forge` | Forge's bot | `1497954389736947876` | ⚠ Luna declares it with extra `allowedDirs` + `allowedSkills`; Echo declares minimally; Forge's view of itself is dead config |
| `agent-ivy` | external Ivy bot | `1487024060411023491` | ✓ identical bare `features: [chat]` on all 3 |
| `agent-holly` | external Holly bot | `1497898452351455393` | ✓ identical bare `features: [chat]` on all 3 |
| `agent-pilot` | external Pilot bot | `1498571063582392390` | ✓ identical bare `features: [chat]` on all 3 |
| `agent-juniper` | external Juniper bot | `1498328127259021404` | ✓ identical bare `features: [chat]` on all 3 |

**Total distinct principals after unification: 12** (3 local agents + 2 humans + 6 external bots + 1 unused template role).

**DM model on Luna only carries real depth:**
- `operatorRole` — features `[chat, async, team]`, no tool denies, rich `allowedDirs` (24 repos), `bashGuard: true`, custom `bashAllowlist` (broader patterns + 40 repos)
- `defaultRole: denied`
- `userRoles: [{users: [285...], features: [chat], disallowedTools: [Write, Edit, NotebookEdit], bashGuard: true}]` — Mike's DM scope, matches his channel `user` role exactly

**DM model on Echo + Forge is minimal:**
- `operatorRole` — features `[chat, async, team]`, no tool denies, `bashGuard: true` (no custom `allowedDirs` or `bashAllowlist` — falls back to global `claude.*`)
- `defaultRole: denied`
- `userRoles: []`

**No Mattermost or Slack roles configured with real values.** Mattermost section present but `enabled: false`. Slack absent.

### 11.2 work stack (the design's target shape — already C.2a)

`cortex.work.yaml` already uses the **new** `policy:` block. It's a one-principal, one-role config — instructive because it shows what a post-cutover meta-factory stack would look like:

```yaml
policy:
  principals:
    - id: luna
      home_operator: andreas
      home_stack: andreas/work
      role: [operator]
      trust: []
      nkey_pub: UDEQUP3NU...
  roles:
    - id: operator
      capabilities:
        - dispatch.luna
        - code-review.typescript
        - chat
        - async
        - team
```

**Critical: capabilities are bare strings (`chat`, `async`, `team`), NOT namespaced `keyword.chat`.** This contradicts §5.2's earlier proposal — the design must align with what's already shipped on the work stack. **Revision required (see §12.1).**

### 11.3 What this reality-check changes

**Principal count is much smaller than per-agent-roles count.** Three agents × ten roles = 30 role declarations in the legacy config, but only 12 distinct principals after deduplication. The CLI's first job is unification, not direct transcription.

**Cross-agent role drift is mostly noise.** Where role definitions differ across the three agents, it's almost always (a) self-references that the self-loop guard makes inert, or (b) one agent forgetting to mirror an `allowedDirs` list that another agent declared. The conservative union (§8 Q4) is the right default here — no real operator decision will be lost.

**The DM model carries the most unique information.** Luna's DM `operatorRole` has a substantial `bashAllowlist` (broader pattern list + 40 repos) that no channel role declares. This isn't fungible with channel access — it's specifically what the operator gets in private 1:1s. The migration must preserve it; §5.3's `session_config` on the operator principal is the natural home, **but** the legacy model permits the operator's channel-context session config and DM-context session config to differ (they happen to be identical here). The new model doesn't represent context-dependent session config. See §12.2.

**The `agent-restricted` template role with no users[]** is a real schema feature operators use to declare a "potential" role that no one currently holds but `defaultRole` could reference. Migration must preserve the PolicyRole even with zero principals pointing at it — empty `users[]` doesn't mean delete.

**External agent peers (ivy, holly, pilot, juniper)** appear with bare Discord IDs and no `agent_id` declaration anywhere in cortex.yaml — they're peer bots in other operators' stacks. The CLI can't infer their `home_stack`; it should emit them as principals with `home_operator: "unknown"` + a warning + `platform_ids.discord` set, and let the operator label `home_stack` post-migration.

---

## 12. Revisions to §5 based on reality check

### 12.1 Capability namespace — keep the dotted-domain prefix

Earlier draft retreated to bare strings (`chat`, `async`, `team`) because the work stack already ships that shape. **Reconsidered:** the work stack is a one-config update at cutover time, not a constraint. With ~12 principals and ~5 distinct capability concepts in operational use today, the namespace overhead is trivial and the payoff (collision-free, explicit domain, future-extension-safe) is large.

Final capability namespace:

| Capability | Domain | Replaces |
|---|---|---|
| `dispatch.<agent_id>` | dispatch | (unchanged — already in C.1) |
| `keyword.chat` | message routing | `features: ["chat"]` |
| `keyword.async` | message routing | `features: ["async"]` |
| `keyword.team` | message routing | `features: ["team"]` |
| `tool.<lowercase-name>` | claude tool | inversion of `disallowedTools[]` |
| `operator` | reserved class | `dm.operatorRole` short-circuit |
| `code-review.typescript`, etc. | product capability | (Phase A.6 conventions — domain.entity) |

The dotted-domain convention (`<domain>.<entity>`) is what `code-review.typescript` and `dispatch.luna` already follow — `keyword.chat` and `tool.bash` extend the same pattern. `operator` stays single-segment because it's a reserved privilege-class capability, not a domain action.

**Migration side effect:** the work stack's `policy.roles[id=operator].capabilities = [dispatch.luna, code-review.typescript, chat, async, team]` rewrites to `[dispatch.luna, code-review.typescript, keyword.chat, keyword.async, keyword.team]`. One line, one config, no operator pain.

### 12.2 New schema decision — channel vs. DM session_config

Andreas's config exercises **divergent session_config between channel and DM**:
- Operator in a channel: inherits global `claude.allowedDirs` (40 repos) + global `claude.bashAllowlist` (narrow rules + 40 repos)
- Operator in a DM: gets a separately-declared `dm.operatorRole.allowedDirs` (24 repos) + a broader `dm.operatorRole.bashAllowlist` (17 patterns + 40 repos)

These aren't the same. The DM bashAllowlist permits `rm`, `mv`, `cp`, `curl`, `jq`, `mkdir` etc. that the channel-default doesn't. **The migration must preserve this divergence.**

Options:

**(a) Single `session_config` on the principal — channel rule prevails, DM divergence lost.**
Rejected: loses operator's broader DM tool access.

**(b) Single `session_config` — union of channel + DM rules.**
Rejected: makes channel access more permissive than the operator declared. Privilege expansion is the wrong direction.

**(c) Split `session_config: { default: {...}, dm: {...} }`** — principal carries baseline + optional DM override.
Accepted: matches legacy semantic exactly. Adapter picks `dm` when `message.author` is in DM context, `default` otherwise.

**(d) Drop DM differentiation — make operator declare it manually as a separate principal.**
Rejected: principal == identity. Splitting one human into two principals based on routing context breaks the identity model.

**Recommended: (c).** Updates the schema proposal in §5.3:

```ts
session_config: z.object({
  default: SessionConfigShape,
  dm: SessionConfigShape.optional(),
}).optional()
```

Where `SessionConfigShape` is the previously-proposed `{allowed_dirs, allowed_skills, bash_guard, bash_allowlist}`. Adapter picks `.dm` when present and routing-context is DM, falls back to `.default`.

### 12.3 New §6 step — emit external-peer principals with operator review markers

Add to the migration algorithm (§6):

**6.6 External peer principals** — for each `agent-<X>` role where X is NOT a declared agent in this cortex.yaml:
- Emit principal with `id: <X>`, `home_operator: "unknown"` (operator must label post-migration), `home_stack: "unknown/unknown"`, `platform_ids.discord: [<bot_id>]`
- Emit warning: `external peer "<X>" found in agents[].presence.discord.roles[].agent-<X>; please set home_operator + home_stack manually in policy.principals[<X>]`
- The principal still parses + works at runtime; the placeholders just make the gap legible to the operator.

---

## 13. Updated open question list

Replacing §8's open questions with the post-reality-check version:

1. **~~Synthetic principal ids for unmapped users~~** — *Resolved: synthetic + optional `--labels labels.yaml` flag. The CLI is idempotent; operators can label post-migration by editing the policy block or re-running with a labels file.*

2. **~~Tool capability namespace~~** — *Resolved in §12.1 — full namespace adopted (`keyword.*`, `tool.*`, `dispatch.*`, `<domain>.<entity>`). Work stack's bare-string caps get rewritten in the same cutover (one line).*

3. **~~Session config — single block or `{default, dm}` split~~** — *Resolved: split. §5.3 and §12.2 hold the schema; §14 sanity-check confirms every legacy DM-vs-channel divergence in cortex.yaml maps cleanly through it.*

4. **~~Cross-agent role conflict~~** — *Resolved: warn + conservative union. Real-world config audit (§11.1) shows the differences are mostly noise — Echo's self-restrictive `agent-echo` role is dead config because self-loop is guarded; cross-agent declarations of the same role name agree in 90%+ of cases. Where they differ, the union preserves access (the safe direction for migration; operators tighten manually if needed).*

5. **~~`defaultRole = "allow-all"` migration~~** — *Resolved: synthetic anonymous principal with all capabilities. Andreas's config uses `defaultRole: denied` everywhere, so the "allow-all" branch is dormant; making it ugly in the new shape discourages reaching for it.*

6. **~~`operatorDiscordId` field on AgentSchema~~** — *Resolved: retire at v2.0.0. The migration CLI moves `agent.operatorDiscordId/Mattermost/Slack` into the operator principal's `platform_ids` block. The legacy fields become parse-time errors with a pointer to migrate-config.*

7. **~~`agent-restricted` template roles with empty `users[]`~~** — *Resolved: emit as PolicyRole even with no principal references. The operator declared it for future assignment via `defaultRole`; the migration preserves that intent. Emit a comment in the rendered cortex.yaml: `# template role — currently no principals; reference via defaultRole or attach to a principal`.*

8. **~~External-peer principals (ivy/holly/pilot/juniper)~~** — *Resolved: emit with `home_operator: "unknown"` + `home_stack: "unknown/unknown"` placeholders + warning. Skipping would break the `(platform, authorId) → principal` lookup that the new adapter dispatch path depends on. The placeholders make the gap legible — operator labels them post-migration as they discover which operator each external peer belongs to.*

---

## 14. Sanity check — does the design preserve every legacy semantic?

Walking through Andreas's cortex.yaml line by line against the proposed mapping:

| Legacy | Maps to | Preserved? |
|---|---|---|
| `agent.id: luna` | `policy.principals[id=luna].home_stack=andreas/meta-factory` | ✓ |
| `presence.discord.token` | (unchanged — token stays adapter-side) | ✓ |
| `presence.discord.guildId/agentChannelId/logChannelId` | (unchanged — adapter routing) | ✓ |
| `presence.discord.trustedBotIds[]` | (unchanged — adapter-side allowlist) | ✓ |
| `presence.discord.surfaceSubjects[]` | (unchanged — adapter routing) | ✓ |
| `presence.discord.roles[].operator` | `policy.principals[id=operator-of-andreas].role=[operator]`, `platform_ids.discord=[1134...]`, role `operator` carries caps `[keyword.chat, keyword.async, keyword.team, dispatch.luna, dispatch.echo, dispatch.forge, operator]` | ✓ unified across 3 agents |
| `presence.discord.roles[].user` (Mike) | `policy.principals[id=mike].role=[user]`, `platform_ids.discord=[285...]`, role `user` carries caps `[keyword.chat, dispatch.luna, dispatch.echo, dispatch.forge, tool.read, tool.bash, ...]` (inverted from disallowedTools) | ✓ |
| `presence.discord.roles[].agent-luna/echo/forge` | Each → existing local agent principal; `platform_ids.discord` populated | ✓ |
| `presence.discord.roles[].agent-ivy/holly/pilot/juniper` | External principals with `home_operator: unknown` markers + warning | ✓ (with caveat) |
| `presence.discord.roles[].agent-restricted` (empty users) | `policy.roles[id=agent-restricted]` declared, no principal references | ✓ |
| `presence.discord.defaultRole: denied` | `policy.principals[id=anonymous-discord-<instanceId>].role=[]` (no caps) | ✓ |
| `presence.discord.dm.operatorRole` | `policy.principals[id=operator-of-andreas].session_config.dm = {allowed_dirs, bash_guard, bash_allowlist}` | ✓ via §12.2 split |
| `presence.discord.dm.defaultRole: denied` | anonymous DM principal — but DMs from unknown users are blocked at adapter layer (channel-context same logic) | ✓ |
| `presence.discord.dm.userRoles[mike]` | `policy.principals[id=mike].session_config.dm = {features: [chat], deny: [Write, Edit, NotebookEdit], bash_guard: true}` | ✓ via §12.2 split |
| `claude.disallowedTools / allowedDirs / bashAllowlist` | (unchanged — global default for principals without overrides) | ✓ |
| `nats.*`, `github.*`, `renderers.*`, `attachments.*`, `execution.*`, `paths.*` | (unchanged — none of these are auth-related) | ✓ |

**Verdict: yes, the design preserves every legacy semantic in Andreas's config.** The only places where information is reshaped, not lost:
- Three near-identical role lists become one set of canonical roles + 12 principals
- Mike's channel role and DM role become one principal with split session_config
- External peer principals carry `unknown` markers until labeled

No semantic is dropped. Every Discord ID, every tool deny, every bashAllowlist pattern, every allowedDir routes into the new shape with a deterministic mapping.

---

## 15. Pressure-test against IoAW future surfaces

The cortex.yaml audit confirms backward compatibility. Forward compatibility is a separate question: does the proposed schema **block** future IoAW work, or compose with it cleanly? Walking through the surfaces that show up in `docs/design-internet-of-agentic-work.md`:

### 15.1 Orchestrator agent (§3.6 — Phase E)

**Scenario:** Andreas's "main digital assistant" Luna runs on stack `andreas/research`. Luna's job is to delegate — when a user pings her with "review this PR" she routes to network `code-review-net` where Echo + sage + cedar compete on the queue group. When the user asks for "literature search" she routes to network `literature-net`. The orchestrator reads the capability registry, picks the network, emits the federated envelope.

**Does the proposed schema express this?**

```yaml
policy:
  principals:
    - id: luna
      home_operator: andreas
      home_stack: andreas/research
      role: [orchestrator]
      platform_ids:
        discord: ["1487..."]
  roles:
    - id: orchestrator
      capabilities:
        - dispatch.luna
        - keyword.chat
        - keyword.async
        - keyword.team
        - tool.bash
        - tool.read
        - tool.write
        - federated.code-review-net.dispatch
        - federated.literature-net.dispatch
        - federated.deployment-net.dispatch
```

✓ **Composes.** Capability strings are open; `federated.<network_id>.dispatch` is a natural pattern. PolicyEngine.check() against `intent.capability = "federated.code-review-net.dispatch"` matches literally. The orchestrator decision logic (which network to call) is application code on top — the schema doesn't constrain it.

**One gap:** The capability `federated.<network_id>.dispatch` doesn't currently exist anywhere — it would be a Phase E addition. Today's PolicyEngine federation gate (Phase D.3, per-network slicing) checks `source_network` against `policy.federated.networks[]` membership; it doesn't consult per-principal capability strings for federation gating. Pre-condition for clean orchestrator support: Phase E extends the engine to consult `federated.<network>.dispatch` capabilities on outbound federation calls. **Schema change required at that point: none.** The capability string convention slots into the existing `capabilities[]` array.

### 15.2 Inbound federated dispatch from another operator

**Scenario:** sage's stack (`jcfischer/sage-host`) publishes `federated.metafactory-net.tasks.code-review.typescript` for Echo to consume. Envelope is signed by sage's stack NKey. Echo's PolicyEngine should authorize the dispatch.

**Walk-through:**
1. Echo's MyelinSubscriber receives the envelope on the federated subject
2. `verifySignedByChain` confirms the signature against sage's `nkey_pub` (looked up from `policy.federated.networks[metafactory-net].peers[].operator_pubkey`)
3. dispatch-listener builds `Intent { capability: "code-review.typescript", source_network: "metafactory-net" }`
4. PolicyEngine.check("sage", intent) is called
5. **Gap:** sage is NOT in Echo's `policy.principals[]`. sage is in `policy.federated.networks[metafactory-net].peers[]`. The engine has no principal record to check `role[]` / capabilities against.

**Today (Phase D)** the engine resolves this with a network-level accept-subjects gate: "this subject matches `accept_subjects[]` for this network, and the principal is a declared peer of the network, so allow." Per-principal capability checking on federated dispatches is **not yet in PolicyEngine**.

**For IoAW Phase E** the gap closes via one of:
- **(a)** Auto-promote federation peers to principals at parse time. `policy.federated.networks[].peers[]` entries create synthetic principals with `home_operator` from the peer record and `role = [<network_id>-peer]` where the role's capabilities are the network's `announce_capabilities`.
- **(b)** Extend `PolicyFederatedPeer` schema with `role[]` so peers explicitly declare their capabilities within the network.
- **(c)** Have the operator manually declare federation peers as both a principal AND a network peer (duplicates the operator/stack info but keeps schemas clean).

**Recommendation for v2.0.0 cutover:** keep the Phase D behaviour (network-level accept-subjects gate). Don't try to solve per-principal federated capability in this cutover. The schema doesn't block any of (a)/(b)/(c) — all three can land as a follow-up Phase E extension. **No schema change required for cortex#242/#243 to leave this door open.**

### 15.3 Q2's `capabilities:` block (stack capability advertisement)

**Scenario:** Andreas declares his stack's capabilities so other operators can discover them via the network registry. Per Q2:

```yaml
capabilities:
  - id: code-review.typescript
    description: "Code review for TypeScript projects"
    tags: [typescript, code-review, ecosystem-metafactory]
    provided_by: [echo]
    rate: { requests_per_hour: 100 }
    cost: { tokens_per_request: 8000 }
```

**Conceptual collision check:** The `capabilities:` block is the ADVERTISEMENT side — "what this stack can do for the network." `PolicyRole.capabilities[]` is the AUTHORIZATION side — "what this principal has permission to do." These are different concerns: a principal can be **authorized** for a capability they don't **advertise** (e.g. tool.bash is authorized but not advertised), and a stack can **advertise** a capability that not every principal is authorized for.

**Does the proposed schema collide with Q2's `capabilities:` block?** No. They're orthogonal namespaces:
- `policy.principals[].role[]` and `policy.roles[].capabilities[]` — authorization
- top-level `capabilities[]` (NEW, Q2, Phase A-or-later) — advertisement, indexed by network registry

They CAN share capability id strings — that's good ergonomics — but they don't have to. The migration CLI doesn't synthesize the `capabilities:` block (no legacy field to lift). It's a separate, additive operator-curated declaration.

**Scope decision:** the `capabilities:` block is **OUT OF SCOPE for cortex#242/#243.** It's Phase E (or later) work. Schema-wise, the v2.0.0 cutover leaves it open — adding `capabilities[]` to `CortexConfigSchema` later doesn't conflict with `policy:` block.

### 15.4 Multi-stack identity continuity

**Scenario:** Luna runs on both `andreas/meta-factory` and `andreas/work`. The Discord bot user ID is the same (it's the same bot). Federated traffic carries `did:mf:luna` — which Luna?

**Walk-through:**
- Within `cortex.yaml`, `policy.principals[]` has ONE entry for `luna` with `home_stack: andreas/meta-factory`
- Within `cortex.work.yaml`, separate file, ONE entry for `luna` with `home_stack: andreas/work`
- The Discord bot id `1487180524542890144` appears in `platform_ids.discord` in both files
- Each stack reads its own config — there's no cross-file collision detection needed
- Federated envelopes carry `signed_by[].principal` AND the chain identifies the originating stack via the stack NKey — the receiving cortex resolves which Luna by `(principal_id, originating_stack)` not just principal_id

✓ **Composes naturally.** The `home_stack` field on the principal does the disambiguation work. The wire format's signed chain carries the resolving context.

### 15.5 Non-Discord/Mattermost/Slack adapter surfaces

**Scenarios that arrive eventually:**
- **MCP server** — Claude Desktop connects via Model Context Protocol; client identity is an OAuth client id or session token
- **HTTP API** — external service calls cortex's REST API; identity is bearer token / API key fingerprint
- **Email / SMS** — inbound message identity is email address or phone number
- **Voice/video** (Discord voice channel, Slack huddle) — utterance identity is a speaker ID after diarization
- **Webhook receivers** — GitHub already, others to come; identity is the source system + signature
- **Cron / scheduled triggers** — synthetic system principal, no real user

**Schema decision required:** The §5.1 proposal types `platform_ids` as:
```ts
platform_ids: z.object({
  discord: z.array(z.string()).default([]),
  mattermost: z.array(z.string()).default([]),
  slack: z.array(z.string()).default([]),
}).default({})
```

This is **closed-enum and will block every future adapter.** Each new adapter would require a schema PR + migration. For a system designed around IoAW heterogeneity, that's the wrong direction.

**Revised proposal (decision §15.5):** Open `platform_ids` to arbitrary platform names:

```ts
platform_ids: z.record(
  z.string().regex(LETTER_PREFIX_ID_REGEX, "platform name must be lowercase alphanumeric + hyphen, starting with a letter"),
  z.array(z.string()).default([])
).default({}),
```

Cross-validation: no `(platform_name, id)` tuple appears in two principals (existing dangling-ref `.refine()` pattern). Adapter-side: each adapter declares its platform name when constructed; the dispatch path looks up `(adapter.platform_name, message.author_id) → principal`. Today's discord/mattermost/slack are reserved names by convention but not by schema.

This change is **better made now, in the v2.0.0 cutover**, than deferred — flipping a closed-enum to an open record is a breaking schema change.

### 15.6 Capability marketplace (Phase F+, public mesh)

**Scenario:** The §3.5 "public mesh" — operators advertise capabilities on `public.operator.*.capability.>` and consumers discover via the network registry. Capability marketplace dynamics.

**Schema collision check:** Out of scope today and explicitly so per §3.5 — public mesh requires myelin#9 (L5 discovery) + a marketplace economics model. The proposed `policy:` schema doesn't block it; when public mesh ships, it'll layer on top of the principal/role/capabilities triad with marketplace-specific fields (cost, rate, SLA, etc.) elsewhere.

✓ Doesn't block.

### 15.7 Orchestrator-of-orchestrators / nested delegation

**Scenario (Phase E+):** Andreas's research orchestrator on `andreas/research` delegates to sage's code-review orchestrator on `jcfischer/sage-host` which delegates to cedar's TypeScript specialist on `cedar/ts-host`. Chain-of-stamps grows long; capability composition spans 3+ stacks.

**Walk-through:**
- The orchestrator pattern at each hop is identical — principal with capability `federated.<network>.dispatch`
- Each hop adds a `signed_by[]` stamp
- The chain-of-stamps grows linearly with hop depth
- PolicyEngine doesn't need to know the chain depth — it only checks per-envelope authorization at each hop

✓ **Composes.** No schema change needed; the design supports unbounded hop depth.

### 15.8 Stack-level isolation (private stack, no federation)

**Scenario (§3.5 "bank private"):** A bank runs a single cortex stack with no federation. `policy.federated.networks[] = []`.

**Walk-through:**
- All capabilities are local — no `federated.*` capability strings needed
- `platform_ids` carries internal-only platform identifiers (e.g. SSO bearer fingerprints)
- The `capabilities:` block (if present) advertises nothing externally

✓ **Composes.** The schema's federation block is optional/empty — private stacks don't carry overhead.

### 15.9 Pressure-test summary

| Surface | Composes? | Schema change required in v2.0.0 cutover? |
|---|---|---|
| Orchestrator agent (Phase E) | ✓ | No (capability strings are open) |
| Inbound federated dispatch with per-principal caps | ⚠ Phase D gap, not blocking | No (deferred to Phase E extension) |
| Q2 `capabilities:` block (stack advertisement) | ✓ | No (additive, Phase E) |
| Multi-stack identity continuity | ✓ | No (`home_stack` disambiguates) |
| MCP / HTTP API / email / SMS / voice / webhook / cron adapters | ⚠ closed-enum `platform_ids` blocks | **YES — change `platform_ids` to open record** |
| Capability marketplace (Phase F+) | ✓ | No |
| Nested orchestrator chains | ✓ | No |
| Private stacks (no federation) | ✓ | No |

**The one pressure-test finding that demands action in this cutover:** §15.5 — flip `platform_ids` from closed-enum to open `Record<platform_name, string[]>`. Doing this now costs nothing extra; deferring it locks in a schema that will need a breaking flip later.

Every other future surface composes with the proposed schema. The cutover doesn't trap us into a v3.0.0 down the line.

---

## 16. Final schema delta (locked-in for cortex#242/#243)

Summarising every schema change committed by §§1–15:

**Additions to `PolicyPrincipalSchema`:**
```ts
{
  // existing: id, home_operator, home_stack, nkey_pub?, role, trust

  // NEW (cortex#243a)
  platform_ids: z.record(
    z.string().regex(LETTER_PREFIX_ID_REGEX),
    z.array(z.string()).default([])
  ).default({}),

  // NEW (cortex#243a)
  session_config: z.object({
    default: SessionConfigShape,
    dm: SessionConfigShape.optional(),
  }).optional(),
}

const SessionConfigShape = z.object({
  allowed_dirs: z.array(z.string()).optional(),
  allowed_skills: z.array(z.string()).optional(),
  bash_guard: z.boolean().default(true),
  bash_allowlist: z.object({...}).optional(),
});
```

**Capability namespace convention (no schema change — convention only):**
- `dispatch.<agent_id>`
- `keyword.{chat,async,team}`
- `tool.<lowercase-name>`
- `operator` (reserved, single-segment)
- `<domain>.<entity>` (open extension, e.g. `code-review.typescript`)
- `federated.<network>.dispatch` (Phase E, no schema change required now)

**Removals at v2.0.0 (cortex#242):**
- `DiscordInstanceSchema.roles[]` + `defaultRole`
- `MattermostInstanceSchema.roles[]` + `defaultRole`
- `SlackInstanceSchema.roles[]` + `defaultRole`
- Entire `DMConfigSchema` (operator + DM userRoles → operator principal's `session_config.dm`)
- `AgentSchema.operatorDiscordId/Mattermost/Slack` → operator principal's `platform_ids`

**New canonical artifact:**
- `src/common/policy/tool-inventory.ts` — canonical list of Claude tool names for `disallowedTools[]` inversion

**Reserved capability IDs documented in the policy schema's JSDoc:**
- `operator` — short-circuits DM access gating, only granted by operator role
- `keyword.{chat,async,team}` — message-keyword authorization
- `tool.<name>` — Claude tool authorization

**No schema changes outside the policy block.** Bus, federation, audit envelope, dispatch lifecycle all unchanged.
