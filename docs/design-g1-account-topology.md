# Design — G1: account-topology primitive

**Status:** design (2026-06-18)
**Author:** Luna (for Andreas)
**Drives:** cortex#1117 (G1), cortex#1116 (EPIC)
**Depends on:** audit `docs/design-onboarding-tooling-audit.md` (hotspot 1)

---

## 1. Problem statement

When a peer principal's leaf connects to the metafactory hub, the hub's
nats-server must route `federated.>` envelopes from the leaf-bound account into
the stack's own account. That cross-account hop is the silent gap that just cost
real debugging time.

**Verified state today (audit 2026-06-18):** neither `cortex` nor `arc` tools
this step. It requires running one or two raw `nsc` commands by hand on the hub,
and the commands differ depending on which of two cases applies.

---

## 2. The two account cases

### Terminology

In an operator-mode nats-server the "account" in the NATS sense is the NSC
account that holds the user JWTs (e.g. `OP_ANDREAS` or a per-stack account
like `OP_ANDREAS_STACK`). A leaf remote binds to one such account. The
`$SYS` account is special — it cannot be leaf-bound.

### Case A — leaf and destination in the same account (no export/import needed)

The leaf remote's `account:` field (`leaf-remote-renderer.ts:95–101`) and the
stack's runtime account are the **same NSC account on the same NSC operator**.
nats-server internally routes `federated.>` without any export/import because
both actors already share the same account namespace. This is the **intra-account
case**.

When does this apply? Any deployment where the hub principal also runs all the
leaf principals under a single NSC operator with a single account: one
`OP_ANDREAS`, everyone uses the `OP_ANDREAS` account. This is probably the
common case for a single-NSC-operator hub.

In this case **no nsc surgery is needed** and G1 has nothing to do beyond
verifying the account matches.

### Case B — leaf-bound account ≠ destination stack's account (export/import required)

The joining principal's leaf binds to account `A_PEER` (their own NSC operator
account), while the hub's stack lives under account `A_HUB`. Traffic that enters
via the leaf lands in `A_PEER`; for `federated.>` to reach a subscriber under
`A_HUB`, nats-server requires an NSC subject-export from `A_PEER` +
subject-import into `A_HUB`, or both accounts must live under a shared NSC operator
with `resolver_preload` that names them.

The nsc mechanics are:

```
# On the hub (run by the hub admin — the only side that can do this):
nsc add export --account A_PEER --subject "federated.>" --service
nsc push -a A_PEER

nsc add import --account A_HUB --from-account A_PEER \
    --subject "federated.>" --local-subject "federated.>"
nsc push -a A_HUB
```

Both pushes update the account JWTs on the NATS server.

**An alternative to export/import:** co-locate both accounts under the same NSC
NSC operator and add both JWTs to the hub's `resolver_preload`. The leaf then binds
to its own account (resolves from `resolver_preload`) and nats-server routes
freely within the NSC-operator universe. This requires the hub admin to issue and
maintain the peer's account JWT — a higher-trust operation that works but creates
NSC-operator-universe coupling.

### Which case does the metafactory hub hit today?

From the audit: Andreas did this by hand using `nsc add export` + `nsc add
import`. That is Case B mechanics. The metafactory hub is operator-mode
(confirmed by `leaf-remote-renderer.ts:683–703` which detects `operator:` /
`accounts` / `resolver_preload` / `system_account` as operator-mode signals).
The joining principal brings their own NSC operator (`OP_JC`, etc.), which means
their leaf-bound account (`A_JC`) is a different account than Andreas's hub
account (`A_ANDREAS`). The export/import path is the one that was done manually
and is the mechanism G1 must tool.

**Resolver_preload co-location alternative:** this would require the hub admin to
issue a new account JWT for the peer under their own NSC operator. That is a
different (and higher-trust) operation — the hub admin issues the peer's account
key, not just the leaf user credentials. It is a valid approach but architecturally
riskier: the peer's bus identity is now bound to the hub admin's NSC operator. The
export/import approach is the lower-trust default: the peer keeps their own
NSC-operator universe; the hub admin only opens a subject tunnel.

---

## 3. Proposed arc primitive

### Placement rationale

arc owns the NSC account tree (`arc/src/commands/nats.ts` — the `nsc()` wrapper,
`addBot`, `reissueBot`, `setupOperator`). cortex never calls `nsc` directly;
it shells to `arc nats add-bot --json` (the established `cortex creds issue`
precedent: `cortex/src/cli/cortex/commands/creds.ts:322`). G1 follows the
same pattern: the primitive lives in arc; cortex orchestrates it.

### Command name

```
arc nats add-federation-export --from-account <A_PEER> --to-account <A_HUB> \
    --subject "federated.>" [--dry-run] [--json]
```

The name is explicit about the two-party operation: it exports from the
leaf-bound account (`--from-account`) and imports into the hub account
(`--to-account`). "Federation" in the name is intentional — this is only ever
called for `federated.>` traffic.

Alternatives considered:

- `arc nats federate-account` — less precise, doesn't distinguish direction
- `arc nats bridge-accounts` — too general
- `arc nats add-export` + separate `arc nats add-import` — closer to raw `nsc`
  but callers would need two calls to achieve the atomic pair; the export without
  the import is a half-operation with no useful standalone semantics

**Decision:** keep them as a **single command** (`add-federation-export`) that
performs both the export AND the import atomically, because the pair is always
needed together for `federated.>` routing.

### Flags

| Flag | Required | Description |
|---|---|---|
| `--from-account <name>` | yes | NSC account of the joining peer (the leaf-bound account; e.g. `OP_JC`) |
| `--to-account <name>` | yes | NSC account of the hub stack (the destination; e.g. `OP_ANDREAS`) |
| `--subject <pattern>` | no (default: `federated.>`) | The subject pattern to export/import. Default `federated.>` covers all federation traffic. Parameterized for narrower grants. |
| `--service` | no (default: false) | Adds `--service` flag to `nsc add export` for request/reply patterns. Normally not needed for `federated.>` pub/sub. |
| `--dry-run` | no (default: true) | Print the `nsc` commands that would run without executing them. Pass `--apply` to mutate. |
| `--apply` | no (default: false) | Execute the nsc mutations. Mutually exclusive with `--dry-run`. |
| `--json` | no | Emit a single line of stable JSON (schema: `arc.nats.v2` — a new schema rev because this adds new result fields). |

### JSON envelope shape (`arc.nats.v2`)

Success:
```json
{
  "schema": "arc.nats.v2",
  "ok": true,
  "fromAccount": "OP_JC",
  "toAccount": "OP_ANDREAS",
  "subject": "federated.>",
  "exportAdded": true,
  "importAdded": true,
  "exportAlreadyPresent": false,
  "importAlreadyPresent": false,
  "pushResult": { "fromAccount": "ok", "toAccount": "ok" }
}
```

Failure:
```json
{
  "schema": "arc.nats.v2",
  "ok": false,
  "error": { "code": "NSC_COMMAND_FAILED", "message": "..." }
}
```

New error code to add to `ArcNatsErrorCode` (`arc/src/lib/json-response.ts:25`):
`"EXPORT_ALREADY_PRESENT"` is NOT needed — idempotency means we check and skip,
not error. But `"PUSH_FAILED"` (already present) covers the push failure case.

### NSC mechanics (what the implementation does)

The implementation lives in `arc/src/commands/nats.ts` alongside `addBot`,
following the same `nsc()` wrapper pattern (`arc/src/commands/nats.ts:66–80`).

**Step 1 — idempotency check (export):**
```
nsc describe account -n <fromAccount> -J
```
Parse the returned JWT JSON for an existing export on `federated.>`. If present,
set `exportAlreadyPresent: true` and skip the add-export step.

**Step 2 — add export (if not present):**
```
nsc add export --account <fromAccount> --subject <subject> [--service]
```

**Step 3 — idempotency check (import):**
```
nsc describe account -n <toAccount> -J
```
Parse for an existing import from `<fromAccount>` on `<subject>`. If present,
set `importAlreadyPresent: true` and skip the add-import step.

**Step 4 — add import (if not present):**
```
nsc add import --account <toAccount> --from-account <fromAccount> \
    --subject <subject> --local-subject <subject>
```

**Step 5 — push both accounts:**
```
nsc push -a <fromAccount>
nsc push -a <toAccount>
```

If any step fails, `ok: false` with `NSC_COMMAND_FAILED` (the existing code,
`arc/src/lib/json-response.ts:28`). Push failure uses the existing `PUSH_FAILED`
code (`arc/src/lib/json-response.ts:31`).

**Rollback policy:** no rollback. If export succeeded but import failed, the
export remains. This is safe: an export with no matching import routes no
traffic. Re-running (idempotent) will skip the export (already present) and retry
the import. A partial state is recoverable by re-running.

**Dry-run output:** when `--dry-run` (the default), print the `nsc` commands that
would run and their expected outcome — identical to the dry-run pattern in
`cortex network join` (`network-lib.ts:147`).

### Idempotency guarantee

The command is fully idempotent: running it twice produces the same state. If
both export and import are already present, it does nothing except push (which is
also idempotent for nats-server's MEMORY resolver). The JSON envelope surfaces
`exportAlreadyPresent` / `importAlreadyPresent` so the orchestrator can log what
actually changed vs. what was already in place.

---

## 4. Cortex orchestration

### Where it's called

`cortex network join` (`src/cli/cortex/commands/network-lib.ts:147`) is the
natural home. The join flow already:
- (a) registers the stack pubkey
- (b) fetches the verified descriptor + roster
- (b.5) resolves the leaf bind mode (operator-account vs creds-only)
- (c) renders + writes the leaf include
- (d) merges the network entry
- (e) restarts nats-server + daemon

G1 adds a new step **(b.4) — account-topology ensure** between (b.5) and (c):
after confirming the bus is operator-mode and we have the leaf account, shell to
`arc nats add-federation-export --from-account <leafAccount> --to-account <hubAccount>`
before writing the leaf file. The export/import must exist before nats-server
sees the leaf config.

### What cortex passes

| Parameter | Source | How resolved |
|---|---|---|
| `--from-account` | `stack.account` (the leaf-bound NSC account, nkey-U format) | From `JoiningStack.account` (`network-lib.ts:66`) — already resolved by the bind-mode check |
| `--to-account` | The hub's stack account | **Open question — see §6** |
| `--subject` | Always `federated.>` | Hardcoded in the orchestrator call |
| `--apply` | When `join --apply` is set | Inherited from the join's dry-run/apply flag |

### The shell-to-arc pattern

cortex calls arc as a subprocess, exactly like `creds.ts`:
(`src/cli/cortex/commands/creds.ts:321–329`):

```typescript
// Conceptual — NOT implementation code
const result = await Bun.spawn(
  ["arc", "nats", "add-federation-export",
   "--from-account", leafAccount,
   "--to-account", hubAccount,
   "--subject", "federated.>",
   ...(apply ? ["--apply"] : ["--dry-run"]),
   "--json"],
  { stdout: "pipe", stderr: "pipe" }
);
const json = JSON.parse(await new Response(result.stdout).text());
```

The orchestrator (in `network-lib.ts`) parses the JSON envelope and
surface the result in `steps[]`, consistent with the existing step-log pattern.
A failed arc call (`ok: false`) becomes a `{ ok: false, reason }` join result
via the never-throws contract.

### cortex never calls nsc directly

The call chain is:

```
cortex network join --apply
  └── arc nats add-federation-export --apply --json
        └── nsc add export ...
        └── nsc add import ...
        └── nsc push ...
```

cortex stays a thin orchestrator; arc owns all NSC state mutations.

---

## 5. Restart / live-hub safety analysis

### Does export/import require a nats-server restart?

**MEMORY resolver (the common local setup):** the NATS `MEMORY` resolver keeps
account JWTs in-memory. `nsc push` pushes the updated account JWTs to the
server via the `$SYS` account's `$SYS.REQ.CLAIMS.UPDATE` subject. The server
applies the updated JWT **without a restart** — the MEMORY resolver reacts to
push in real time. This is the designed behavior of `nsc push` and is why nsc
push exists.

**Full JWT resolver (`resolver: full`):** same behavior — `nsc push` triggers a
live JWT update.

**Static `resolver_preload` (rare — config file contains literal JWT blob):**
the JWT is baked into the config file. A `nsc push` cannot update a static
preload — a nats-server `--signal reload` (or full restart) is needed. This is
the one case that requires a restart.

**Conclusion for the metafactory hub:** the hub runs with a JWT resolver (`nsc
push` works). No restart is required. The export/import is effective
immediately after `nsc push`. This makes G1 automation safe for a live hub —
no outage window needed.

### Safety on a live hub with other active accounts

`nsc add export` adds a new export to ONE account's JWT. It does NOT touch any
other account's JWT. `nsc add import` adds a new import to ONE account's JWT.
The worst-case failure of either command:

- Command fails → account JWT unchanged → no effect on routing.
- `nsc push` fails → server-side JWT unchanged → still no effect on routing
  (the export/import is local-only until pushed, so a push failure leaves things
  exactly as before).

No existing account's routing is affected by adding an export/import to a
different account. The only risk is on the accounts being modified — and the
G1 idempotency check means re-running after a partial failure is safe.

---

## 6. Open questions for Andreas

These are genuinely undecided and need a call before implementation starts:

### OQ1 — How does cortex know the hub's `--to-account`?

The biggest open question. The leaf-bound account (`--from-account`) is known from
`stack.nats_infra.account` (already resolved in the join flow at
`network-lib.ts:66`). But the destination account — the hub's NSC account under
which the stack that will receive `federated.>` traffic runs — is NOT in the
network descriptor today. The descriptor carries `hub_url` and `leaf_port`
but not the hub's NSC account name.

Options:
- **a)** Add `hub_account` to the registry's network descriptor schema. The
  network admin sets it at `cortex network create` time. This is clean but
  requires a registry schema change.
- **b)** The joining principal passes `--hub-account <name>` to `cortex network
  join`. Explicit, no registry change, but one more flag to remember.
- **c)** cortex derives it from the leaf's creds JWT. The creds file the hub
  admin issued (via G2 / `cortex creds issue`) is bound to an NSC account — that
  account IS the hub's account (the one the hub admin's NSC operator issued it
  under). `nsc describe user -n <bot> -J` on the hub side already reveals
  the account. But the joining side can't run that — the creds are on the hub
  admin's machine.
- **d)** The hub account is the SAME as the leaf's `--from-account` (Case A —
  single-NSC-operator hub). If `--from-account` == `--to-account`, no export/import
  is needed and G1 is a no-op. This is the detection condition for Case A vs B
  described in §2.

**Current thinking:** option (a) is the cleanest long-term (registry is the
source of truth for topology facts). Option (b) is the pragmatic short-term.
Neither is hard to implement. The design is blocked on this decision.

### OQ2 — default: export/import vs. resolver_preload co-location?

§2 described both approaches. The design above proposes export/import as the
default because it is lower-trust (the peer keeps their own NSC-operator universe).
Resolver_preload co-location is higher-trust (the hub admin issues the peer's
account JWT).

Is export/import the right default for the metafactory hub, or should
co-location be supported (and if so, as a flag like `--strategy colocate`)?

### OQ3 — new schema `arc.nats.v2` vs. extend `arc.nats.v1`?

`add-federation-export` returns fields not in any existing `arc.nats.v1`
envelope shape. The cleanest option is a new schema string (`arc.nats.v2`) to
avoid confusion with `arc.nats.v1` consumers (cortex's `creds.ts` guards on the
schema string: `ARC_NATS_SCHEMA_V1`, `creds.ts:78`). The alternative is a
separate schema namespace (`arc.nats.federation.v1`) to keep the federation
commands cleanly separated from the user-management commands.

### OQ4 — `add-federation-export` + symmetric `remove-federation-export` for `leave`?

`cortex network leave` (`network-lib.ts:568`) tears down the leaf config. Should
it also remove the export/import? Arguments for yes: clean symmetric teardown.
Arguments against: the hub admin may have other principals still using the same
export; removing it would break them. Probably leave (pun intended) as an
explicit `arc nats remove-federation-export` call, NOT wired into `network leave`
automatically. Worth deciding upfront because it affects the `leave` flow design.

### OQ5 — where in the network-lib.ts flow does the G1 step sit?

The above proposes **(b.4)** (after bind-mode resolution, before leaf write).
The export/import must exist before nats-server loads the leaf config — but
since `nsc push` updates the JWT without a restart, it could also go AFTER the
leaf write but BEFORE the restart. The key constraint is: the push must complete
before `nats-server` is restarted (or `--signal reload`-ed), otherwise the
server's in-memory account JWTs are stale at the moment the leaf connects.

Between (b.4) and the restart step is fine. Between the leaf write (c) and
the restart (e.1) is also fine. Putting it before (c) is marginally cleaner
because the join fails before touching any live config if arc is not installed or
the nsc commands fail.

---

## 7. File references

Key files this design is grounded in:

- `arc/src/commands/nats.ts` — the `nsc()` wrapper, `addBot`, `reissueBot`,
  `setupOperator`; where `addFederationExport` would live
- `arc/src/lib/json-response.ts:16–39` — `ARC_NATS_SCHEMA`, `ArcNatsErrorCode`;
  new codes + schema version land here
- `arc/src/cli.ts:1394–1539` — the `arc nats` commander block; new subcommand
  registration goes here
- `cortex/src/cli/cortex/commands/creds.ts:321–329` — the shell-to-arc pattern
  cortex already uses; G1 orchestration follows this exactly
- `cortex/src/cli/cortex/commands/network-lib.ts:147–515` — `joinNetwork()`; the
  new step (b.4) inserts here, before `ports.leafFile.write()`
- `cortex/src/common/nats/leaf-remote-renderer.ts:595–656` — `resolveLeafBindMode`;
  the leaf-bound account (`bindMode.account`) is the value passed to
  `--from-account`
- `docs/design-onboarding-tooling-audit.md` — source audit; hotspot 1 is what
  G1 closes
- `docs/sop-federation-onboarding.md:§6` — "The leaf hub is operator-mode" — the
  hub model assumption

---

## 8. Summary of proposed design

| Concern | Owner | Primitive |
|---|---|---|
| NSC export/import mechanics | **arc** | `arc nats add-federation-export --from-account … --to-account … [--apply] [--json]` |
| Orchestration call site | **cortex** | Step (b.4) in `network-lib.ts:joinNetwork()`, after bind-mode resolved, before leaf write |
| Shell-to-arc pattern | **cortex** | `Bun.spawn(["arc", "nats", "add-federation-export", …, "--json"])` — identical to `creds.ts` |
| Restart required? | Neither | No — `nsc push` updates JWTs live on the MEMORY/full-JWT resolver |
| Idempotent? | arc | Yes — describe→check→skip or add, both export and import sides |
| Dry-run safe? | arc | Yes — default is dry-run; `--apply` required to mutate |
| Fail-closed? | arc | Yes — partial state (export without import) routes no traffic; re-run converges |
