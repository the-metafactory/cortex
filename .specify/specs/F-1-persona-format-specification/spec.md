---
id: "F-1"
feature: "Persona format specification"
status: "draft"
created: "2026-05-12"
source: "Interview answers from cortex#60 design + Ivy session 2026-05-11"
---

# Specification: Persona format specification

## Overview

Define and document the canonical persona file format for arc-installable cortex sub-bots. A persona file pairs structured YAML frontmatter (preferred model, allowed tools, behavior flags) with a markdown prose body (persona character + behavior guidance). Bot packages ship `persona.md` files; cortex consumes them at agent registration time. Persona schema is semver-versioned; bot manifests declare a supported range via `persona-format: ^1.0`.

This feature is documentation only — no runtime code. Cortex's existing config loader already accepts a `persona` field as an opaque file path; this spec defines what's inside that file.

## User Scenarios

### Scenario 1: Bot author writes a new persona

**As a** bot author packaging a code-review bot
**I want to** know the canonical persona file format before I write `persona.md`
**So that** my bot package installs cleanly into cortex without runtime schema-mismatch errors

**Acceptance Criteria:**
- [ ] `docs/persona-format.md` exists on `main` with a complete schema reference
- [ ] The doc includes a minimal worked example (~10 lines)
- [ ] The doc includes a comprehensive worked example (all optional fields populated)
- [ ] The doc declares the current version (`1.0`) and version-compatibility policy
- [ ] An author can copy the minimal example, edit `displayName` + system-prompt body, and have a valid persona without further reading

### Scenario 2: Cortex maintainer evolves the persona schema

**As a** cortex maintainer adding a new optional field to the persona format
**I want to** the version-compatibility policy to be unambiguous
**So that** my schema bump (e.g. 1.0 → 1.1) doesn't break existing bots

**Acceptance Criteria:**
- [ ] Doc declares semver rules: optional-field additions = minor bump; required-field changes = major bump; default-value changes = minor bump
- [ ] Doc names a deprecation pathway (warn for 1 minor cycle, then remove on next major)
- [ ] Doc names where the version constant lives in cortex source (`src/common/types/persona-format.ts`)

### Scenario 3: Bot installation rejects persona-format version skew

**As a** cortex operator running `arc install <bot>`
**I want to** see a clear error if the bot's declared `persona-format` range doesn't satisfy cortex's implemented version
**So that** I don't get cryptic load-time failures later

**Acceptance Criteria:**
- [ ] Doc specifies that bot manifest declares `persona-format: ^1.0` (semver range) in arc-manifest
- [ ] Doc specifies cortex's `CortexHostAdapter.detect()` includes a `persona-format-version` check against the bot's declared range
- [ ] Doc specifies install-time error wording when range fails

## Functional Requirements

### FR-1: Format structure

The persona file is a markdown file with a YAML frontmatter block. The frontmatter block is required (even if minimal) and uses the standard `---` delimiters. The body following the frontmatter is markdown prose and constitutes the agent's persona/behavior text.

```markdown
---
displayName: Echo
preferredModel: claude-opus-4-7
allowedTools: [Read, Grep, Bash]
behavior:
  pre-commit-review: true
  proactive-suggestions: false
---

# Echo — Code Review Agent

You are Echo, a meticulous senior code reviewer...
```

**Validation:** YAML frontmatter parses with `yaml` package; required fields are present; unknown fields generate a warning but don't reject.

### FR-2: Required frontmatter fields

| Field | Type | Description |
|-------|------|-------------|
| `displayName` | string | Human-readable name shown in dashboard. MUST match the `displayName` in `agents.d/<id>.yaml` if both are set (cortex warns on mismatch). |

### FR-3: Optional frontmatter fields (v1.0)

| Field | Type | Description |
|-------|------|-------------|
| `preferredModel` | string | Claude model id (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`). Cortex's runner uses this if set; falls back to operator default. |
| `allowedTools` | string[] | Tool allowlist for the agent. If unset, cortex applies the role's default allowlist. Subset of cortex's known tools (Read/Edit/Write/Grep/Bash/Agent/Skill/…). |
| `behavior` | object | Free-form key-value flags for persona-specific behavior toggles. Cortex passes through to the agent runtime opaquely (no schema enforcement on this object's interior). |
| `temperature` | number | Sampling temperature override (0.0–1.0). Falls back to cortex default. |
| `maxTokens` | number | Max output tokens per turn. Falls back to cortex default. |
| `tags` | string[] | Free-form labels for filtering/discovery in dashboard. |

### FR-4: Prose body

The markdown body following the frontmatter is the agent's persona/behavior text — passed to the model as the system prompt prefix at session start. No schema enforcement on body content; bot author owns this prose.

**Convention (not enforced):** the body should open with a one-paragraph identity statement (who the agent is, what they do) followed by behavior guidance, examples, and tone notes. Examples below show the convention.

### FR-5: Version declaration

The persona format itself is versioned via the cortex codebase, not the persona file. A bot's `arc-manifest.yaml` declares the persona-format version range the bot supports:

```yaml
# arc-manifest.yaml
runtime:
  persona-format: ^1.0   # semver range (npm-compatible)
```

Cortex's current persona-format version is exported as a constant: `src/common/types/persona-format.ts` → `export const PERSONA_FORMAT_VERSION = "1.0.0";`. The `CortexHostAdapter.detect()` checks the bot's declared range against this constant at install time and rejects the install (with a clear error) if the range is not satisfied.

**Why arc-manifest, not frontmatter:** the bot package is the source of truth (cortex#58 D5). Putting the version in arc-manifest keeps the answer in one place; putting it in frontmatter would let the bot's manifest and persona file drift.

### FR-6: Versioning policy

| Change type | Version bump |
|-------------|--------------|
| Add optional field | Minor (1.0 → 1.1) |
| Change default value of optional field | Minor |
| Add required field | Major (1.0 → 2.0) |
| Remove field | Major |
| Tighten type/validation on existing field | Major |
| Loosen type/validation on existing field | Minor |

**Deprecation pathway:** when removing a field, mark it deprecated in the prior minor release (warn at load), then remove in the next major. Cortex emits load-time warnings naming the deprecated field, the version it'll be removed in, and the replacement (if any).

## Non-Functional Requirements

- **Performance:** persona file load is one-off at agent registration; no per-message cost. File size MUST be under 100KB (warn at 50KB; reject above 100KB).
- **Security:** persona file contents are passed to the model verbatim — bot authors are trusted with what they write here. Frontmatter is parsed with `yaml` package's `parse()` (NOT `parseAllDocuments` — single doc only).
- **Failure Behavior:**
  - On missing file: cortex rejects agent registration with a clear error naming the expected path.
  - On unparseable frontmatter: cortex rejects registration; error names line number.
  - On missing `displayName`: rejected.
  - On unknown frontmatter field: warning logged with the field name; agent still registers.
  - On `persona-format` range unsatisfied: cortex's `CortexHostAdapter.detect()` rejects install before any files are dropped.

## Key Entities

| Entity | Description | Key Attributes |
|--------|-------------|----------------|
| Persona file | Markdown file with YAML frontmatter | `displayName` (required), optional `preferredModel`, `allowedTools`, `behavior`, `temperature`, `maxTokens`, `tags` + prose body |
| Persona format version | Semver string constant in cortex source | `PERSONA_FORMAT_VERSION` exported from `src/common/types/persona-format.ts` |
| Bot persona-format declaration | Semver range in arc-manifest | `runtime.persona-format: ^1.0` |

## Success Criteria

- [ ] `docs/persona-format.md` exists on `main`
- [ ] Doc has: schema reference, minimal example, comprehensive example, versioning policy section, error-handling section
- [ ] A bot author can author a valid `persona.md` in under 5 minutes by copy-editing the minimal example
- [ ] Echo review (1 round) approves with 0 blockers / 0 majors
- [ ] `src/common/types/persona-format.ts` exists with `PERSONA_FORMAT_VERSION = "1.0.0"` constant + JSDoc pointing at the doc

## Assumptions

| Assumption | What Would Invalidate It | Detection Strategy |
|-----------|-------------------------|-------------------|
| Bot authors are humans (not generated bots) | Auto-generated bot packages | n/a for v1 — accept; revisit if 50%+ bots are generated |
| Markdown + YAML frontmatter is universally familiar | Bot ecosystem shifts to a different format | Watch agentic-skill spec evolution; revisit if mainstream shifts |
| Semver in npm syntax is the right range syntax | Bot ecosystem uses a different range syntax | Match arc#117's chosen syntax (assume npm semver per current arc docs) |
| Frontmatter parsing is fast enough to never be a bottleneck | Bot has 100+ agents | Load timing in F-2's tests; revisit if >50ms per agent at startup |

## System Context

### Upstream Dependencies

| System | What We Get | What Breaks If It Changes | Version/Contract |
|--------|-------------|---------------------------|------------------|
| `yaml` npm package | YAML parser | Frontmatter parsing breaks | ^2.8.3 (current cortex pin) |

### Downstream Consumers

| System | What They Expect | Breaking Change Threshold |
|--------|-----------------|--------------------------|
| F-2 `agents.d/` loader | Persona file at the path declared in fragment's `persona:` field, parseable per this spec | Any required-field addition would break existing personas |
| `CortexHostAdapter` (F-5) | `persona-format` semver range field in arc-manifest | Range syntax change |
| Bot packages (claude-review-bot, codex-review-bot, …) | Stable schema; clear evolution policy | Major version bumps |

### Adjacent Systems (Implicit Coupling)

| System | Implicit Dependency | Risk |
|--------|---------------------|------|
| cortex dashboard | `displayName` from persona file vs from `agents.d/<id>.yaml` fragment | Mismatched display in two places; mitigated by warn-on-mismatch |
| Agent runtime (cortex's runner) | `preferredModel`, `temperature`, `maxTokens` from persona feed into Claude API params | Format change requires runtime change |

## [NEEDS CLARIFICATION]

- None for v1 — interview answers locked all decision points. Open items rolled to future minor versions.

## Out of Scope

- **Persona file inheritance** — no `extends: parent-persona.md` mechanism in v1. Each persona is self-contained.
- **Multi-language personas** — single-locale only. Bot packages targeting non-English deployments ship locale-specific persona files (`persona-de.md`, `persona-fr.md`) and the manifest pins the locale; cortex picks one at install based on operator preference. This is bot-author convention, not schema feature.
- **Live persona reload** — persona changes require `arc upgrade <bot>` (cortex#58 §12). Live watch is a future enhancement.
- **Tool-allowlist enforcement** — `allowedTools` is advisory in v1; actual enforcement lives in the agent runner (not in this doc).
- **Behavior flag schema** — `behavior:` is an opaque object in v1. Specific flags are documented per-bot by the bot author, not by cortex.
