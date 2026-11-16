## Changing CLAUDE.md

`CLAUDE.md` is generated. Never edit it by hand. It is produced by `arc upgrade compass` from:

- **Template:** `compass/templates/CLAUDE.md.template`, the shared ecosystem template. The installed copy is at `~/.local/share/metafactory/arc/repos/compass/templates/CLAUDE.md.template`.
- **Config:** `agents-md.yaml`, which holds the repo's placeholders and section list.
- **Section files:** `docs/agents-md/*.md`, injected at marked positions.

To change an agent rule:

1. Edit the section file in `docs/agents-md/`:
   - `architecture.md`: what cortex is, and the table of task guides in `docs/agent-guide/`.
   - `critical-rules.md`: repo rules, injected after the standard Critical Rules block.
   - `wire-grounding.md`: the RFC routing table for `src/bus/**`. `scripts/check-wire-vocab.ts` reads it, so it stays in `docs/agents-md/`.
2. Put material that only some tasks need in `docs/agent-guide/` and add a row to the table in `architecture.md`, rather than adding a section to `CLAUDE.md`.
3. Update `agents-md.yaml` when adding a section file (set `position` and `file`).
4. Regenerate with `arc upgrade compass`. It regenerates `CLAUDE.md` for every repo that has an `agents-md.yaml`.
5. Commit the source files and the regenerated `CLAUDE.md` together.

Injection positions: `after:domain-context`, `after:description`, `after:critical-rules`, `after:sop-table`, `after:versioning`.

## Shippable-path gates

Two CI gates keep deployment-specific identifiers out of committed paths. Their scopes differ; don't conflate them.

1. `scripts/check-shippable-hygiene.ts` (the blocking `shippable-hygiene` job) fails the build on config identity shapes in shippable agent fragments (`agents.d/*.yaml`, `personas/*.md`, `arc-manifest*.yaml`) and in seeds and migrations: live 17–20-digit Discord or Slack snowflakes, internal `@meta-factory.*` emails, non-placeholder seed identities, and presence-bearing fragments not marked `# audience: generic`. A fragment must be a `.example` template, or carry that marker with every id an `__ENV__` placeholder or zeroed sentinel. It does not detect arbitrary tokens, API keys or general third-party identities.
2. Tokens, API keys and high-entropy secrets belong to the `confidentiality-gate` caller (gitleaks tier 1). It warns only during the burn-in window and blocks once a principal flips enforcement.

If either gate flags something real, remove it; never allowlist it. This is the root-cause class of the cortex#1312 leak (design doc §4 L1/L2, compass#87).

## Open source attribution

When incorporating open-source code, UX patterns or significant ideas from other projects:

1. Add an entry to `THIRD-PARTY-NOTICES.md` with the repository URL, author, license type, full license text, and a note on what was incorporated (code import or pattern inspiration).
2. If the source project has no LICENSE file but declares a license in its README, note the discrepancy.
3. The dashboard footer links to `THIRD-PARTY-NOTICES.md` on GitHub for end users.

## Generated images

AI-generated images (architecture diagrams, infographics) follow the ecosystem rule:

- The source of truth lives in `~/Documents/andreas_brain/assets/`, named `YYYY-MM-DD-{topic}/YYYY-MM-DD-{descriptive-name}.{ext}`.
- The repo copy in `docs/diagrams/` is a render artifact for inline use in `docs/architecture.md`, the README and design specs.
- The art skill writes to `~/Downloads/` for preview. Once approved, move the image to andreas_brain, not directly into the repo.
- Example: `docs/diagrams/cortex-architecture.jpg`, with its source at `~/Documents/andreas_brain/assets/2026-05-09-cortex-architecture/2026-05-09-cortex-architecture.jpg`.

When updating a diagram, update both copies.
