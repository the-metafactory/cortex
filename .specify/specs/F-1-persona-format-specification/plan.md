---
feature: "Persona format specification"
spec: "./spec.md"
status: "draft"
---

# Technical Plan: Persona format specification

## Architecture Overview

This is a documentation feature with one tiny code artifact: a version constant. Two deliverables land in the cortex repo:

```
1. docs/persona-format.md            ── the schema reference doc
2. src/common/types/persona-format.ts ── PERSONA_FORMAT_VERSION = "1.0.0" constant
```

The constant is the runtime source-of-truth that `CortexHostAdapter.detect()` (F-5) and the agents.d loader (F-2) compare bot-declared ranges against. Today nothing reads the constant — it lands now so downstream features can import it without circular dependency.

```
┌─────────────────────────────────┐
│ docs/persona-format.md          │
│ ── schema reference             │
│ ── examples (minimal + full)    │
│ ── versioning policy            │
│ ── error handling               │
└──────────────┬──────────────────┘
               │ semver constant referenced from doc
               ▼
┌─────────────────────────────────┐
│ src/common/types/persona-       │
│ format.ts                       │
│ ── PERSONA_FORMAT_VERSION       │
│ ── (later) Zod schema for       │
│    frontmatter                  │
└──────────────┬──────────────────┘
               │ (future, in F-2)
               ▼
┌─────────────────────────────────┐
│ F-2 agents.d loader             │
│ F-5 CortexHostAdapter           │
│ (out of scope here)             │
└─────────────────────────────────┘
```

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | cortex standard |
| Runtime | Bun | cortex standard |
| Doc format | Markdown | cortex `docs/design-*.md` convention |
| Version constant pattern | `export const X = "..."` | matches existing cortex pattern (e.g. arc-manifest version handling) |

## Constitutional Compliance

- [x] **CLI-First:** N/A — no new CLI surface; the doc is the artifact.
- [x] **Library-First:** the version constant is a pure module import — consumable by any cortex component.
- [x] **Test-First:** the constant gets a unit test verifying semver shape (`/^\d+\.\d+\.\d+$/`). The doc is verified via existence + structural grep in tests.
- [x] **Deterministic:** the constant is literal; no probabilistic behavior.
- [x] **Code Before Prompts:** no prompts involved.

## Data Model

### Persona file (markdown with frontmatter)

```typescript
// Conceptual — actual Zod schema lands in F-2 (agents.d loader is the consumer)
interface PersonaFile {
  frontmatter: {
    displayName: string;                  // required
    preferredModel?: string;              // optional
    allowedTools?: string[];              // optional
    behavior?: Record<string, unknown>;   // optional, opaque
    temperature?: number;                 // optional, 0..1
    maxTokens?: number;                   // optional, >0
    tags?: string[];                      // optional
  };
  body: string;                           // markdown prose (used as system prompt prefix)
}
```

### Version constant module

```typescript
// src/common/types/persona-format.ts
/**
 * Current persona-format version implemented by this cortex build.
 * Bot manifests declare a supported range via `runtime.persona-format: ^1.0`
 * in arc-manifest. See docs/persona-format.md §Versioning.
 */
export const PERSONA_FORMAT_VERSION = "1.0.0" as const;
```

That is the entire module. No types. No exports beyond the constant.

## API Contracts

No new API surface beyond the constant.

## Implementation Strategy

### Phase 1: Foundation (this feature, entirely)

The single phase. Three artifacts:
1. `src/common/types/persona-format.ts` — the version constant
2. `src/common/types/__tests__/persona-format.test.ts` — unit test for the constant
3. `docs/persona-format.md` — the human-readable schema reference

Phases 2 and 3 do not exist in this feature — consumers (F-2, F-5) take the next steps.

## File Structure

```
src/common/types/
├── persona-format.ts             # NEW — single export PERSONA_FORMAT_VERSION
└── __tests__/
    └── persona-format.test.ts    # NEW — semver shape test + doc-existence test

docs/
└── persona-format.md             # NEW — schema reference (~250 lines)
```

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Doc and code drift (constant says 1.0.0; doc says 1.1.0) | Low (no consumers yet at merge time) | Med (real risk once F-2 lands) | Test asserts the constant matches what doc declares in its `## Current version` section. |
| Bot ecosystem demands a different versioning model | Med (would require a v1 rewrite) | Low (no bots ship yet) | Watch arc#117 + agent-skills spec evolution; revisit before B.1 bot package ships. |
| YAML frontmatter parsing edge case breaks F-2 | Med (downstream) | Low (yaml package is mature) | F-2's tests will catch; this feature explicitly defers parser implementation. |

## Failure Mode Analysis

### How This Code Can Fail

| Failure Mode | Trigger | Detection | Degradation | Recovery |
|-------------|---------|-----------|-------------|----------|
| Constant export removed/renamed | Refactor accident | F-2's import fails at build | TypeScript compile error | Restore export |
| Doc deleted | Cleanup accident | Test asserts doc exists | Test failure on next CI | Restore from git |
| Version constant out of semver shape | Manual edit error | Unit test regex | Test failure | Fix constant |

### Assumptions That Could Break

| Assumption | What Would Invalidate It | Detection Strategy |
|-----------|-------------------------|-------------------|
| `^1.0` is the syntax operators will write in arc-manifest | arc#117 lands a different range syntax | arc-side audit before F-5 lands |
| `yaml` package's `parse()` is acceptable for v1 frontmatter | Spec adopts a non-YAML alternative (TOML?) | Watch agent-skills spec |
| Markdown body is treated as opaque text by runtime | Runtime evolves to need structured markdown sections | Surface in cortex runner PRs |

### Blast Radius

- **Files touched:** 3 new files (1 source, 1 test, 1 doc); 0 modified
- **Systems affected:** none at merge time (F-2 + F-5 will consume on landing)
- **Rollback strategy:** revert the PR — no dependents yet

## Dependencies

### External

None.

### Internal

None — fresh file in `src/common/types/`.

## Migration/Deployment

- No DB migrations
- No env vars
- No breaking changes (additive — feature didn't exist before)

## Estimated Complexity

- **New files:** 3
- **Modified files:** 0
- **Test files:** 1
- **Estimated tasks:** 4 (constant, constant-test, doc, doc-test)
- **Debt score:** 1 (minimal — well-scoped, documented, tested)

## Longevity Assessment

### Maintainability Indicators

| Indicator | Status | Notes |
|-----------|--------|-------|
| Readability: Can a developer understand this in 6 months? | Yes | Single-export module + Markdown doc |
| Testability: Can changes be verified without manual testing? | Yes | Unit test + grep test |
| Documentation: Is the "why" captured, not just the "what"? | Yes | spec.md captures why; doc captures what + how |

### Evolution Vectors

| What Might Change | Preparation | Impact |
|------------------|-------------|--------|
| Schema bump 1.0 → 1.1 (new optional field) | Bump constant + update doc + bump bot manifests' ranges | Low (semver compatible) |
| Schema bump 1.0 → 2.0 (breaking) | Major bump + deprecation cycle | Med (bot package migrations) |
| Runtime adds enforcement of `allowedTools` | Separate runner-side feature; doc gains "enforced" note | Med |

### Deletion Criteria

When should this code be deleted?

- [ ] Feature superseded by: an upstream standard (e.g. Agent Skills spec) that fully replaces this schema
- [ ] Dependency deprecated: `yaml` package no longer maintained → migration to alternative
- [ ] User need eliminated: no more bot packages → unlikely
- [ ] Maintenance cost exceeds value when: schema versioning bureaucracy outweighs ecosystem benefit (unlikely while ecosystem grows)
