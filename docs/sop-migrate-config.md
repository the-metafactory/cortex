# SOP — `cortex migrate-config`

> Principal-facing standard operating procedure for running the
> `migrate-config` CLI before the v2.0.0 policy cutover (cortex#296).
>
> **Related:** [design-policy-cutover.md](./design-policy-cutover.md) (the why),
> [iteration-policy-cutover.md](./iteration-policy-cutover.md) (the slice plan).

## When to run

You need to run `migrate-config` once per cortex stack before the v2.0.0
cutover. The CLI is **idempotent** — re-running it on an already-migrated
file produces byte-identical output, so it's safe to run repeatedly while
hand-editing the result.

You should run it in three modes during the cutover window:

| Mode | Command | Outcome |
|------|---------|---------|
| **Preview** | `cortex migrate-config <file>` | Print converted YAML + warnings to stdout. Inspect before writing. |
| **Write** | `cortex migrate-config <file> --out <new>` | Write to disk. The CLI never overwrites the input. |
| **Pre-flight** | `cortex migrate-config <migrated-file> --check` | Validate the migrated file has no policy gaps. Exits non-zero if it does. |

The `--check` mode is the gate the cortex#296 adapter parallel-mode
activation runs at startup; if it fails, the adapter falls back to the
legacy code path silently. Get it to pass before enabling parallel mode.

## Inputs the CLI accepts

The CLI accepts three input shapes (auto-detected by content):

1. **Legacy grove-v2 `bot.yaml`** — pre-MIG-7 schema with a singular
   `agent:` block and top-level `discord[]`/`mattermost[]` instance
   arrays. The CLI lifts this into the cortex `agents[]` shape and
   synthesises a `policy:` block from the per-instance `roles[]`
   declarations.
2. **Cortex-shape `cortex.yaml` with no `policy:` block** — the
   post-MIG-7 cortex schema, but pre-cutover. The CLI keeps the
   `agents[]`/`principal:`/`renderers:` blocks verbatim and ADDS a
   synthesised `policy:` block.
3. **Cortex-shape `cortex.yaml` WITH a `policy:` block** — the
   post-cutover shape. The CLI normalises the existing policy block
   (rewrites bare-string capabilities `chat`/`async`/`team` to the
   namespaced form `keyword.chat`/`keyword.async`/`keyword.team`) and
   merges in any missing principals/roles synthesised from the
   `agents[].presence.<platform>.roles[]` declarations. Already-defined
   principals are preserved untouched.

## Output

Generated principals follow §6 of `design-policy-cutover.md`:

- **One principal per unique platform user id** — if the same Discord
  user appears in multiple agents' `roles[].users[]`, they collapse to
  one principal. The principal id is synthesised from the platform user
  id (`user-` + a hash) unless you override it with `--labels` (see
  below).
- **One principal for the declared stack principal** — id `operator` <!-- historical: synthesised principal-id literal emitted by migrate-config-policy.ts; code identifier, not human-operator prose --> (or
  `operator-<id>` for multi-principal deployments), <!-- historical: `operator-<id>` is the same code-emitted id literal --> populated from the
  legacy `agent.operatorDiscordId`/`operatorMattermostId`/`operatorSlackId`
  and tagged with the broadest `session_config.dm` from the legacy
  `dm.operatorRole` block.
- **One synthetic anonymous principal per agent-instance** — id
  `anonymous-<platform>-<agentId>`, used as the fall-through when an
  incoming user matches no other principal. The `defaultRole` from the
  legacy presence config drives whether this principal carries the
  `allow-all` role (legacy `defaultRole: allow-all`), an empty role list
  (legacy `defaultRole: denied`), or a named role from the legacy
  `roles[]`.
- **One principal per external-peer reference** — every `agent-<X>` role
  in the legacy `roles[]` where `X` is NOT a declared local agent gets
  surfaced as a principal with `home_principal: "unknown"` and
  `home_stack: "unknown/unknown"`. **You must hand-edit these** with the
  correct peer-stack identity before the cortex#296 parallel-mode
  activation — they emit warnings on every run, by design.
- **One PolicyRole per unique role name** — synthesised from the
  capabilities legacy `features[]` declares (plus the inverse of
  `disallowedTools[]` from the canonical Claude tool inventory in
  cortex#294, plus per-agent `dispatch.<agent>` capabilities). When the
  same role name appears in multiple presences (Discord+Mattermost+Slack)
  with DIFFERENT field bundles, the CLI emits a single role with the
  UNION of capabilities and warns you to tighten it manually.

## `--check` exit codes

```text
0 — preflight OK: every legacy user resolves through the new policy.
1 — preflight FAIL: gaps exist. stderr lists each gap with a fix hint.
2 — input error: file not found, malformed YAML, schema validation failure.
```

Each failure mode is structured:

```text
policy preflight: 2 gap(s) — parallel-mode activation BLOCKED:
  [1/2] principal-missing-for-platform-user: legacy discord user "1234..." (referenced by agent luna's presence role "user") has no principal claiming this id via platform_ids.discord[]. parallel-mode would silently deny authorisation for this user.
  [2/2] role-missing-for-default-role: legacy defaultRole "user" (agent echo, platform discord) has no matching policy.roles[].id. parallel-mode would silently deny the synthetic anonymous principal.
```

Fix each gap by hand-editing the migrated file, then re-run `--check`.

## `--labels` overrides

By default the CLI synthesises principal ids like `user-d049472` (a hash
of the Discord user id). To use stable human-readable ids, pass a labels
file:

```yaml
# labels.yaml
discord:222222222222222222: mike
discord:333333333333333333: andreas
mattermost:abc123: mike
```

```bash
cortex migrate-config cortex.yaml --labels labels.yaml --out cortex.new.yaml
```

The label takes precedence over the synthesised id; if you don't
override a user, the synthesised id is used. Labels are NOT persisted —
they're a translation-layer convenience, applied per `migrate-config`
invocation.

## `--strict` mode

By default warnings go to stderr and the CLI exits 0. Pass `--strict` to
treat warnings as errors (exits 1 on any warning). Useful in CI; don't
use it during the cutover window because the external-peer warnings
(item 4 above) are expected and fixed by hand.

## Recommended cutover workflow

```bash
# 1. Preview — eyeball the warnings, get a sense of scope.
cortex migrate-config ~/.config/cortex/cortex.yaml

# 2. Write the candidate.
cortex migrate-config ~/.config/cortex/cortex.yaml \
  --labels ~/.config/cortex/labels.yaml \
  --out ~/.config/cortex/cortex.policy.yaml

# 3. Pre-flight the candidate.
cortex migrate-config ~/.config/cortex/cortex.policy.yaml --check

# 4. If --check exits non-zero, fix the gaps by hand, then re-check.
#    Hand-edit principles you need to add (external peers), then:
cortex migrate-config ~/.config/cortex/cortex.policy.yaml --check

# 5. Once --check exits 0, swap the file in (with backup).
cp ~/.config/cortex/cortex.yaml ~/.config/cortex/cortex.yaml.pre-policy-cutover-$(date +%Y%m%d)
mv ~/.config/cortex/cortex.policy.yaml ~/.config/cortex/cortex.yaml

# 6. The cortex#296 parallel-mode runner will pick up the new shape
#    on next restart and run BOTH the legacy and new code paths,
#    comparing decisions for an observation window.
```

## Capability namespace

The v2.0.0 schema namespaces every capability. Legacy keyword caps in
your `policy.roles[].capabilities` get rewritten in place:

| Legacy | v2.0.0 |
|--------|--------|
| `chat` | `keyword.chat` |
| `async` | `keyword.async` |
| `team` | `keyword.team` |
| (any other already-namespaced cap) | (preserved verbatim) |

Tool-deny semantics live as role-level capabilities. `disallowedTools:
[Bash, Edit]` from the legacy shape becomes `tool.*` for every tool in
the canonical inventory MINUS `tool.bash` and `tool.edit`. See cortex#294
for the inventory and cortex#293 for the inversion helper.

## See also

- `docs/design-policy-cutover.md` — full architectural design, including
  the migration algorithm (§6), the principal pre-flight requirement
  (§9.1), and the resolved design questions (§13).
- `docs/iteration-policy-cutover.md` — slice plan, including which
  slice landed which behaviour.
- `src/cli/cortex/commands/migrate-config-policy.ts` — implementation
  reference; the JSDoc on `buildPolicy` and `policyPreflight` is the
  canonical algorithm description.
