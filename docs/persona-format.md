# Persona Format Specification

**Status:** v1.0 — first release of the persona file schema for arc-installable cortex sub-bots.
**Date:** 2026-05-12
**Driver:** F-1 — see `.specify/specs/F-1-persona-format-specification/spec.md`
**Related docs:**
- `docs/design-arc-agent-bots.md` (§4 manifest, D5 persona-ownership-by-bot-package)
- `docs/design-pi-dev-review-agent.md` (substrate/presence decoupling that motivates this)
- `docs/architecture.md` §9 (agent + presence/renderer model)

---

## What is a persona file?

A persona file is the system prompt prefix + per-agent configuration that a cortex sub-bot ships in its arc package. When cortex registers an agent, it reads the persona file at the path declared in the agent's `agents.d/<id>.yaml` fragment and uses it to build the runtime context for that agent's Claude Code (or other substrate) sessions.

Personas are owned by the **bot package** (cortex#58 D5). The bot author edits `persona.md` in the bot's source repo; `arc install <bot>` drops it under `~/.config/cortex/personas/<id>.md`. Cortex's `personas/` directory is rendered output, not a source of truth.

## Schema

A persona file is a markdown file with a single YAML frontmatter block followed by markdown prose. The frontmatter is required (even if minimal). The prose body is passed to the substrate as the agent's system prompt prefix.

### Frontmatter — required fields

| Field | Type | Description |
|-------|------|-------------|
| `displayName` | string | Human-readable name shown in the cortex dashboard. If the agent's `agents.d/<id>.yaml` fragment also declares `displayName`, the two MUST match; cortex logs a warning on mismatch. |

That's the only required frontmatter field. Everything else is optional.

### Frontmatter — optional fields (v1.0)

| Field | Type | Description |
|-------|------|-------------|
| `preferredModel` | string | Claude model id. **Free-form string in v1** — cortex does not validate against a closed enum. Both short aliases (`claude-opus-4-7`) and fully-qualified ids (`claude-opus-4-7-20251022`) are accepted. The runner passes the value through to the Anthropic SDK verbatim; if the model id is unknown to Anthropic, the SDK returns an error at first API call (operator-debuggable, not install-time). Non-Anthropic substrates (Codex, pi.dev, custom) interpret the field per their own runtime contract. When unset, cortex falls back to the operator default declared in `cortex.yaml`. Future cortex versions MAY tighten this to an enum; that would be a major version bump per §Versioning. |
| `allowedTools` | string[] | Tool allowlist for the agent. **Free-form string list in v1** — cortex does not validate against a closed enum. The canonical v1.0 tool names cortex knows about are: `Read`, `Edit`, `Write`, `Grep`, `Bash`, `Glob`, `Agent`, `Skill`, `WebFetch`, `WebSearch`, `NotebookEdit`, `TodoWrite`, `BashOutput`, `KillShell`. Future tool additions land via additive enum extension (minor bump). Field is advisory in v1 — runtime enforcement (filtering the substrate's tool palette to this allowlist) lands in a future cortex release; until then the runner ignores the field with an info-level log. Unknown tool names in v1: warning logged with the name; field is preserved on the agent for future enforcement. |
| `behavior` | object | Free-form key-value flags for persona-specific behavior toggles. Cortex passes the object through to the substrate opaquely — no schema enforcement on the interior. Bot author documents its keys in the bot's own README. |
| `temperature` | number | Sampling temperature override, `0.0` to `1.0` **inclusive** on both bounds. Falls back to the cortex default if unset. |
| `maxTokens` | number | Max output tokens per turn (positive integer). Falls back to the cortex default if unset. |
| `tags` | string[] | Free-form labels for filtering / discovery in the dashboard (e.g. `[code-review, typescript]`). No semantic meaning to cortex; convention only. |

### Body

The markdown body following the closing `---` is the agent's persona / behavior text. It is passed to the substrate verbatim as the system prompt prefix at session start. Cortex applies no schema enforcement on body content — the bot author owns this prose.

**Convention (not enforced):**
- Open with a one-paragraph identity statement (who the agent is, what they do).
- Follow with behavior guidance: voice, tone, when to push back, when to escalate.
- Optionally include worked examples of the agent's expected output format.
- Close with explicit constraints or anti-patterns the agent should avoid.

This is the format Echo, Holly, Luna, and Ivy follow today inside cortex; the same shape extends to sub-bots.

## Examples

### Minimal (~10 lines)

```markdown
---
displayName: Echo
---

# Echo

You are Echo, a senior code reviewer. Apply the cortex review lenses
(CodeQuality, Security, Architecture, EcosystemCompliance) in order.
Surface findings as blockers / majors / suggestions / nits with clear
file:line references and proposed fixes.
```

This is enough to ship a working sub-bot. `arc install` drops this file at `~/.config/cortex/personas/echo.md`; cortex picks it up via the `persona:` path in the agent's `agents.d/echo.yaml` fragment.

### Comprehensive (all optional fields populated)

```markdown
---
displayName: Codex-Rev
preferredModel: claude-opus-4-7
allowedTools: [Read, Grep, Bash]
behavior:
  pre-commit-review: true
  proactive-suggestions: false
  cite-line-numbers: always
temperature: 0.2
maxTokens: 4096
tags: [code-review, typescript, security]
---

# Codex-Rev — Codex CLI Review Substrate

You are Codex-Rev, a Codex-CLI-substrate code reviewer running standalone
under cortex's bus. You're a peer of cortex's in-process Echo agent: same
review discipline, different substrate.

## Voice

- Direct. No filler.
- Cite `file:line` for every finding.
- Quote the offending snippet inline; show the proposed fix as a diff.

## Lenses

Apply in order. Stop at the first verdict-determining finding.

1. **CodeQuality** — duplication, naming, dead code
2. **Security** — input validation, auth, secret handling
3. **Architecture** — coupling, layering, dependency direction
4. **EcosystemCompliance** — conventional commits, SOPs, label hygiene

## Anti-patterns (refuse to do)

- Do NOT request blocker-level changes for stylistic preferences.
- Do NOT recommend abstractions for code that has one consumer.
- Do NOT defer to "could be" — every finding is "this is" with evidence.

## When to escalate

If you find a finding that crosses repos (e.g. cortex change needs a
matching myelin change), surface it explicitly in the review summary
under `### Cross-repo coordination` and tag the relevant operator.
```

This is the kind of persona file a substrate-specific sub-bot would ship.

## Versioning

The persona format itself is versioned via a constant in cortex's source — `src/common/types/persona-format.ts` exports `PERSONA_FORMAT_VERSION`. Bot packages declare a supported semver range in their `arc-manifest.yaml`:

```yaml
# arc-manifest.yaml
runtime:
  persona-format: ^1.0   # npm-style semver range
```

Cortex's `CortexHostAdapter.detect()` (F-5) compares the bot's range against `PERSONA_FORMAT_VERSION` at install time. If the range is not satisfied, `arc install` aborts with a clear error before any files are dropped.

### Semver policy

| Change type | Version bump |
|-------------|--------------|
| Add optional field | Minor (1.0 → 1.1) |
| Change default value of optional field — **case A:** new default is operator-overridable (cortex.yaml-level fallback) | Minor — operator can intervene to preserve old behavior |
| Change default value of optional field — **case B:** new default observably alters per-bot output (e.g. a temperature default change) | Major — bots that relied on the prior default see different runtime behavior with no version of their own to bump |
| Add required field | Major (1.0 → 2.0) |
| Remove field | Major |
| Tighten type / validation on existing field | Major |
| Loosen type / validation on existing field | Minor |
| Add an entry to a known-tool list (`allowedTools` canonical names) or a known-model list | Minor — additive only |

### Deprecation pathway

When removing a field:

1. Mark it deprecated in the next minor release. Cortex emits a load-time warning naming the field, the version it will be removed in, and the replacement (if any).
2. Wait one full minor cycle so bot authors can update.
3. Remove the field in the next major. Bots declaring an old range silently keep working until they bump.

### Changelog (this file's own version)

| Version | Date | Change |
|---------|------|--------|
| 1.0.0 | 2026-05-12 | Initial release — `displayName` required; optional fields `preferredModel`, `allowedTools`, `behavior`, `temperature`, `maxTokens`, `tags`; markdown body free-form. |

## Error handling

| Scenario | Cortex behavior |
|----------|-----------------|
| Persona file missing at declared path | Reject agent registration. Error names the expected path. |
| Persona file present but **no `---` frontmatter block at all** (pure markdown body, no delimiters) | Reject registration. Error distinguishes from "file missing" — names the file path and shows the minimal required frontmatter: `displayName: <name>`. |
| Frontmatter unparseable (bad YAML inside `---` delimiters) | Reject registration. Error names line + column from the YAML parser. |
| Frontmatter missing `displayName` | Reject registration. Error names the required field. |
| Frontmatter has **unknown field** (not in the v1 schema) | Warning logged with the field name; field is preserved on the agent (forwards-compatibility with future minor versions); registration succeeds. |
| Frontmatter has **known field with wrong type** (e.g. `displayName: 42`, `tags: "code-review"`, `temperature: "warm"`, `allowedTools: "Read,Edit"`) | Reject registration. Error names the field, the expected type, and the received value. This is distinct from unknown-field-warn — known fields with bad types catch the most common hand-authored-YAML mistakes and surface them at install time rather than runtime. |
| `displayName` in persona disagrees with `agents.d/<id>.yaml` fragment | Warning logged; fragment's `displayName` wins (operator-edited config takes precedence — cortex#58 §5 inline-vs-fragment rule generalizes here). |
| `temperature` out of `0.0` to `1.0` inclusive range | Reject registration. Error names the value + expected `[0.0, 1.0]` range. |
| `maxTokens` non-positive or non-integer | Reject registration. Error names the value. |
| `allowedTools` references a tool cortex doesn't know about | Warning logged; unknown tool name is preserved on the agent (advisory in v1; future enforcement may drop or reject); other tool names register normally. |
| File size > 100KB | Reject registration. Personas this large are almost certainly a misuse. |
| File size > 50KB | Warning logged; agent registers. Soft signal that the persona may be overgrown. |
| `arc-manifest.yaml`'s `runtime.persona-format` range not satisfied by `PERSONA_FORMAT_VERSION` | `arc install` aborts via `CortexHostAdapter.detect()` (F-5). No persona files are dropped on disk. |

## Current version

```typescript
// src/common/types/persona-format.ts
export const PERSONA_FORMAT_VERSION = "1.0.0" as const;
```

This constant is the source of truth. Bumping this value requires updating:

1. The constant in `src/common/types/persona-format.ts`
2. This document's `## Versioning > Changelog` section
3. The unit test in `src/common/types/__tests__/persona-format.test.ts` asserting the exact value

The unit test additionally asserts that the version string in the `## Current version` section of this doc matches the constant — a deliberate guard against drift between doc and code.

## Related docs

- `docs/design-arc-agent-bots.md` — arc-installable sub-bots design (§4 manifest, §5 fragment, §6.1 loader, D5 persona ownership)
- `docs/design-pi-dev-review-agent.md` — substrate/presence decoupling
- `docs/architecture.md` §9 — agent + presence/renderer model (roles, trust, presence per the broader cortex model)
- `arc-manifest.yaml` (cortex root) — example of where `runtime.persona-format: ^1.0` is declared by a bot package
- `.specify/specs/F-1-persona-format-specification/` — the spec / plan / tasks for this feature

---

*Schema version 1.0.0 — first release. Future revisions follow the semver policy above.*
