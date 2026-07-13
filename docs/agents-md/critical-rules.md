- During migration phases (MIG-0..MIG-8), every PR cites a phase + checklist item from `docs/plan-cortex-migration.md`. The plan is the ground truth for what moves where; if the plan and reality disagree, update the plan first, then the code.
- The architecture spec (`docs/architecture.md`) is **static reference** — when the plan and architecture disagree on what cortex IS, the architecture wins. When the plan and reality disagree on migration mechanics, the plan wins (or is updated, never silently).
- NEVER add CF Access bypass-everyone policies or disable authentication on any endpoint. If cross-origin auth fails, fix the architecture (same-subdomain routing, proper CORS), don't bypass auth. If you encounter a bypass-everyone policy during any investigation, immediately flag it as a SEV-1 security finding.
- cortex does NOT have: ProcessManager, ManagedProcess, FileWatcher, `grove.config.ts`, or any process orchestration. The runtime is a single `src/cortex.ts` entrypoint plus relay + CLIs; daemons are launchd plists, not bot-side orchestration.
- NEVER use empty catch blocks. Every catch must either: (a) log the error via `process.stderr.write()` or the event pipeline (`system.error` event), (b) handle it meaningfully (e.g., return a fallback value with a comment explaining why), or (c) name the variable with `_err` and add a comment explaining why it's safe to ignore. Silently swallowing errors hides bugs.
- Hooks must stay non-blocking. The cc-events EventLogger writes JSONL to `~/.claude/events/raw/` and returns; the cortex-relay process picks up files asynchronously. Never call out to the bot, the bus, or any network endpoint from inside a hook.
- Migration moves preserve behavior. MIG-1..MIG-7 PRs are file moves + minimal import-path rewrites unless the plan explicitly calls for a refactor. If a move tempts you to "fix something while I'm in here", file a follow-up issue instead.
- Surface plugins (adapters + renderers) load with **full daemon authority** — there is no sandbox (ADR-0024 D4). The default-off `system.plugins.external` flag is the trust boundary: NEVER load an unsigned/untrusted (third-party) bundle by default, and never widen the loader's **first-party bundle exemption** past its anchor. "First-party" is a *checkable, un-spoofable* property — a bundle whose arc-recorded `repoUrl` matches a dependency in cortex's OWN `arc-manifest.yaml`, narrowed by `ADAPTER_BUNDLE_DEP_NAME_RE` / `RENDERER_BUNDLE_DEP_NAME_RE`. Never key the exemption on the bundle's own manifest, its arc `tier`, or a name prefix (all author-controlled); those are the exact spoof vectors PR #1942 closed. cortex core ships ZERO in-tree platform adapters and exactly one in-tree renderer (`dashboard`, the fail-safe anchor) — don't re-add an in-tree adapter/renderer copy of an extracted bundle (D2: no plugin has two sources of truth).
- Deployment-specific identifiers NEVER ship in a committed path — real platform ids (Discord/Slack snowflakes), internal-domain emails, real principal/seed identities, tokens, and secrets belong only in `~/.config/cortex/`, never in the repo. Two CI gates cover this with DIFFERENT scopes; don't conflate them. (1) `scripts/check-shippable-hygiene.ts` (BLOCKING `shippable-hygiene` job) fails the build on config identity-SHAPES in shippable agent fragments (`agents.d/*.yaml`, `personas/*.md`, `arc-manifest*.yaml`) and seeds/migrations — live 17–20-digit Discord/Slack snowflakes, internal `@meta-factory.*` emails, non-placeholder seed identities, and presence-bearing fragments not marked `# audience: generic` (a fragment must be a `.example` template or carry that marker with every id an `__ENV__` placeholder or zeroed sentinel). It is SCOPED to those shapes: it does NOT detect arbitrary tokens, API keys, or general third-party identities. (2) Tokens, API keys, and high-entropy secrets are the `confidentiality-gate` caller's domain (gitleaks tier-1) — WARN-ONLY during the burn-in window, blocking only after a principal flips enforcement. Practice: ship `.example` placeholders + generic identifiers; never a live snowflake, internal email, real seed identity, or secret. If either gate flags something real, REMOVE it; do not allowlist it. Root-cause class of the cortex#1312 leak (design doc §4 L1/L2, compass#87).

## CLAUDE.md Management

**CLAUDE.md is fully generated — NEVER hand-edit it.** It is produced by `arc upgrade compass` from:

- **Template:** `compass/templates/CLAUDE.md.template` (shared ecosystem template; the installed copy lives at `~/.config/metafactory/pkg/repos/compass/templates/CLAUDE.md.template`)
- **Config:** `agents-md.yaml` (repo-specific placeholders and section list)
- **Section files:** `docs/agents-md/*.md` (repo-specific content injected at marked positions)

**To change agent rules:**

1. Edit the appropriate section file in `docs/agents-md/`:
   - `architecture.md` — System architecture overview + migration provenance
   - `critical-rules.md` — Repo-specific rules (injected after the standard Critical Rules block)
   - `implementation-workflow.md` — Migration + feature workflow, blueprint integration
   - `dashboard-deployment.md` — CF Pages / wrangler deploy instructions
   - `message-keywords.md` — Bot message keyword reference
   - `discord-routing.md` — Discord channel routing SOP
   - `pai-integration.md` — PAI session instrumentation and Discord CLI
2. Update `agents-md.yaml` if adding a new section file (specify `position` and `file`)
3. Regenerate: `arc upgrade compass` (regenerates CLAUDE.md for every repo under `~/Developer/` that has an `agents-md.yaml`)
4. Commit both the source files AND the regenerated `CLAUDE.md`

**Injection positions:** `after:description`, `after:critical-rules`, `after:sop-table`, `after:versioning`

## Open Source Attribution

When incorporating open-source code, UX patterns, or significant ideas from other projects:

1. Add an entry to `THIRD-PARTY-NOTICES.md` with: repository URL, author, license type, full license text, and a note explaining what was incorporated (code import vs pattern inspiration)
2. If the source project has no LICENSE file but declares a license in README, note this discrepancy
3. The dashboard footer links to `THIRD-PARTY-NOTICES.md` on GitHub for end-user visibility

## Generated images

All AI-generated images (architecture diagrams, infographics, etc.) for cortex follow the ecosystem rule:

- **Source of truth** lives in **`~/Documents/andreas_brain/assets/`** following the naming convention `YYYY-MM-DD-{topic}/YYYY-MM-DD-{descriptive-name}.{ext}`.
- **Repo copy** at `docs/diagrams/` is for inline rendering in `docs/architecture.md`, README, and design specs. Treat the repo copy as a render artifact; the andreas_brain copy is the source.
- The art skill outputs to `~/Downloads/` first for preview; once approved, move to andreas_brain (not directly into the repo).
- Existing example: `docs/diagrams/cortex-architecture.jpg` + source at `~/Documents/andreas_brain/assets/2026-05-09-cortex-architecture/2026-05-09-cortex-architecture.jpg`.

When updating or regenerating a diagram, update both the andreas_brain canonical copy and the in-repo render copy.
