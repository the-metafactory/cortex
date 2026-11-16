## Implementation Workflow

cortex uses one feature numbering scheme during MIG-0..MIG-8 and adds a second one after cutover:

- **C-series** (e.g., C-108): cortex features and migration phases. Tracked in `blueprint.yaml` + GitHub issues (`cortex#1` umbrella for C-100, `cortex#2..#10` for C-101..C-109 migration phases).
- **MIG-N.x** (e.g., MIG-7.10): per-phase checklist items in `docs/plan-cortex-migration.md`. Each MIG-N maps to one C-NNN feature.
- **F-/G-series** (post-MIG-8): inherited from grove-v2 design specs that migrate at MIG-7.11. Activate after the migration plan retires.

**Workflow (migration mode — MIG-0..MIG-8):**

```
1. Read docs/plan-cortex-migration.md — pick the next phase + checklist item
2. Check blueprint.yaml: `blueprint ready` shows what's unblocked
3. Create feature branch via worktree:
     git worktree add ../cortex-{slug} -b feat/c-{id}-{slug} origin/main
4. Implement the move/refactor (most files are ports from grove-v2; few new)
5. Push + open PR with title `feat(cortex): C-NNN.X — {scope} (MIG-N.Y)`
6. Drive PR through pilot-loop review (Echo for code review, Luna for design review)
7. After merge: tick the checkbox on BOTH docs/plan-cortex-migration.md AND the GitHub issue
8. Close the phase issue when all its phase items tick
```

**Workflow (post-MIG-8, normal feature mode):**

```
1. Read the design spec (e.g., docs/design-collaboration-surface.md)
2. Pick next feature by dependency order from the iteration plan
3. Create feature branch: feat/c-{id}-{slug} (or feat/f-{id}-{slug}, feat/g-{id}-{slug})
4. Work the checkboxes against acceptance criteria in the design spec
5. PR → review → merge to main
6. Tick checkboxes in BOTH the iteration plan AND the GitHub tracking issue
```

**Sync rule:** Iteration plans exist in two places — `docs/iteration-*.md` (repo artifact, agents read it) and a GitHub Issue (trackable, commentable). When a checkbox is completed, update both.

**Migration artefacts:**
- `docs/plan-cortex-migration.md` — Per-phase migration plan (MIG-0..MIG-8). Drives all current work; retires at MIG-8.
- `docs/architecture.md` — Canonical M1–M7 stack + cortex internal componentisation. Static reference.

**Design + iteration docs** (lifted from grove-v2 at MIG-7.11):
- `docs/design-collaboration-surface.md` + `docs/iteration-collaboration-surface.md`
- `docs/design-mission-control.md` + `docs/iteration-mission-control.md`
- See `docs/` for the full set.
