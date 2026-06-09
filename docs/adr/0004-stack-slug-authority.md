# ADR 0004 — `stack.id` is the canonical stack-slug authority

**Status:** Accepted (2026-06-09)
**Relates:** `CONTEXT.md` §"Stack slug" / §"Flagged ambiguities", [ADR-0001](./0001-federated-subject-grammar.md) (federated subject grammar — the wire half of this authority), [ADR-0003](./0003-network-join-control-plane.md) (network join control plane), [`compass/sops/federation-wire-protocol.md`](https://github.com/the-metafactory/compass/blob/main/sops/federation-wire-protocol.md) §3 (the canonical DID `did:mf:{principal}-{stack}` = `stack.id` with `/`→`-`), [`scripts/lib/plist-render.sh`](../../scripts/lib/plist-render.sh) (`extract_stack_id_slug`, `warn_stack_identity_drift`, `config_file_to_slug`).
**Tracks:** cortex#810 (the principal-side reconciliation of an already-drifted stack).

## Context

A cortex **stack** is referred to by a short **slug** in four places:

1. The **federation identity** — the `{stack}` segment of `local`/`federated.{principal}.{stack}.…` and the canonical DID `did:mf:{principal}-{stack}`. This comes from **`stack.id`** (`{principal}/{slug}`) inside the config.
2. The **`cortex network join` write path** — where join writes resolved policy.
3. The **config locator** — the filename (`cortex.yaml`, `cortex.{slug}.yaml`) or, under the config-split layout, the directory name (`<config_dir>/<slug>/`). The lifecycle scripts (`discover_stack_slugs`, `config_file_to_slug`) derive a slug from this name to find the config.
4. The **launchd/systemd label** — `ai.meta-factory.cortex.{slug}` — rendered by `render_stack_plist` from the locator slug, and used by `preupgrade`/`postupgrade` to stop/restart the right daemon.

Nothing reconciled (1)+(2) — driven by `stack.id` — against (3)+(4) — driven by the filename/dirname. The `config_file_to_slug` mapping even hard-codes `cortex.yaml → meta-factory`. As long as the principal happens to name the config dir/file the same as their `stack.id` slug (Andreas's four stacks all do), the four agree by luck and nothing is wrong.

When they *don't* agree, the stack **drifts**: it federates as one identity but is labelled as another, and the join writes to a third path. JC's stack surfaced this — a single-file `cortex.yaml` (→ locator slug `meta-factory`, plist `ai.meta-factory.cortex.meta-factory`, agent `fern`) whose `stack.id` is `jc/default` (→ federation identity `jc/default`, DID `did:mf:jc-default`). One stack, three names. It passed every test and every prior review because no layer — code, CI, or review — stated that these names must agree, so there was nothing to check against. This is the same class as the CONTEXT.md-drift cases the code-review **ArchitectureDocs** lens was built for (cortex#483/#484): a rule everyone assumed but no artifact asserted.

## Decision

**`stack.id`'s trailing segment is the single authority for the stack slug.** The federation subject segment, the canonical DID, the `cortex network join` write path, the config dir/file name, and the launchd/systemd label all derive from — and MUST equal — it. This is the local-tooling extension of the wire-side authority already binding in `compass/sops/federation-wire-protocol.md` §3 (where `stack.id` is the DID); this ADR walks that same authority down into cortex's deployment tooling.

Binding consequences:

- **DA-1 — The filename/dirname is a cosmetic locator, not the authority.** `config_file_to_slug` and the config-split dir basename remain how the lifecycle scripts *find* a config, but they are subordinate to `stack.id`. The `cortex.yaml → meta-factory` mapping is a single-file convenience, explicitly not an identity source.

- **DA-2 — Drift is detected and surfaced at `arc upgrade`/install time, never shipped silently.** `warn_stack_identity_drift` (in `plist-render.sh`, called once by `postupgrade.sh` and `postinstall.sh`) reads each discovered stack's `stack.id` via `extract_stack_id_slug` and warns to stderr when the trailing segment ≠ the locator slug, naming both the mislabel and the remediation. It runs **before** the Darwin guard so a Linux/systemd peer sees it too.

- **DA-3 — Drift warns; it does not fail.** A hard error would brick `arc upgrade` for a drifted stack — unacceptable blast radius on a live review pipeline (the explicit concern in #810). The warning fires every upgrade until reconciled. Escalation to a hard gate is deferred until known drifts are reconciled and a deprecation window has passed.

- **DA-4 — Reconciliation is a principal rename, not an automatic rewrite.** Because the on-disk artifacts (the dir, the sentinel `<slug>.yaml`, `stacks/<slug>.yaml`, the rendered plist, the daemon PID/label) are all keyed on the locator name, the tool cannot safely re-key them to `stack.id` underneath a running daemon. The fix is the principal renaming the config dir/file onto `stack.id` on a calm day, off the live pipeline (cortex#810). The tool's job is to *detect and instruct*, not to mutate.

## Consequences

- **The gap that let JC's stack drift silently is closed at the tooling layer.** `arc upgrade` now reports the exact mismatch and the one-line fix; the same invariant, stated in `CONTEXT.md` §"Stack slug", arms the code-review **ArchitectureDocs** lens to catch a re-introduction at review time. Authority (CONTEXT.md) → decision (this ADR) → guard (tooling warning + review lens).
- **Andreas's stacks are unaffected** — all four locator names already equal their `stack.id` slug, so `warn_stack_identity_drift` is silent and the rendered labels are unchanged. Purely additive: no behavior change to discovery, rendering, or restart.
- **JC's stack will warn until reconciled**, then go quiet once his dir/file is renamed onto `jc/default` (the cortex#810 cleanup). No migration is forced by this ADR; the warning is advisory.
- **Known residual locator hard-codes are documented, not yet removed:** the `cortex.yaml → meta-factory` case in `config_file_to_slug`/`slug_to_config_file`, and the `meta-factory → "cortex"` nkey-basename special case in `postupgrade.sh`. Removing them requires the inverse-mapping + PID-rename work that DA-4 defers; they are safe while the locator-equals-`stack.id` invariant holds and drift is surfaced. Tracked as the deeper slice of cortex#810.

## Out of scope

- Automatically renaming a drifted stack's on-disk layout or plist label (DA-4 — principal action, #810).
- Removing the legacy filename hard-codes (the deeper #810 slice; needs the inverse-mapping rework).
- Any change to the `federated.*` wire grammar — that authority is already binding (ADR-0001, the wire-protocol SOP) and is unchanged here.
