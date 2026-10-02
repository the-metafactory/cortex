**Finding-ID convention:** the findings in this document are cited elsewhere as R1-F1..R1-F6.
# Cortex — Security & Architecture Review

**Prepared by:** NorthWoods Sentinel Labs (Rob Chuvala)
**For:** Andreas Åström / the-metafactory
**Date:** 2026-07-23
**Subject:** `the-metafactory/cortex` — M7 collaboration surface for the Myelin stack <!-- vocab-allow: verbatim external review — third-party author's original "Myelin stack" wording preserved -->

**Repository state:** commit `f6f4b06d5fdd412350225a79bc21fed3689ad87f` (`v6.11.0`, main, cloned 2026-07-23)
**Classification:** Confidential. Findings are as of the commit above and the surfaces named in §2 — not a whole-repository audit.

---

## 1. Summary

Cortex is a security-mature codebase. The trust-boundary code reviewed shows an attacker's discipline: fail-closed defaults, path-traversal and symlink-escape defenses on plugin paths, a TOCTOU-closing freeze on untrusted plugin exports, explicit rejection of spoofable trust signals, and in-code threat-model notes that name the accepted residual risk rather than hiding it. The plugin loader (`src/adapters/loader.ts`) is reference-quality defensive engineering.

The central observation of this review: **cortex owns no deterministic filesystem-confinement boundary for the Claude Code sessions it drives from untrusted inbound content.** File access is scoped by Claude Code's own `--add-dir` mechanism plus a natural-language preamble; there is no cortex-owned code that denies a read outside the allowed directories — and this holds for both the file tools (Read/Glob/Grep/Write/Edit, which have no cortex hook) and the Bash read commands (`cat`/`head`/`tail` are allowlisted with no path check).

Severity picture: nothing is a Showstopper. One filesystem-confinement finding whose top-of-band rating is repro-gated (F1); one documented, accepted High residual risk the client already owns (F2, plugin authority); a real default-to-audit-only enforcement gap on the sovereignty path (F3); a principal-DM guard-disable whose exploitability is unproven (F4); and non-trivial good marks recorded as explicitly as the gaps (F5).

---

## 2. Scope & method

**In scope (files read):** `src/adapters/loader.ts`; `src/bus/sovereignty-gate.ts`; `src/bus/review-consumer.ts`; `src/runner/security-preamble.ts`; `src/runner/hooks/bash-guard.hook.ts`; `src/runner/claude-invoker.ts`; `src/settings/cortex-hooks.json`; `src/common/policy/resolve-access.ts`; `docs/adr/0024-pluggable-surface-adapters.md`; `CLAUDE.md`, `src/bus/CLAUDE.md`; structural survey of `src/runner/` and `src/bus/`.

**Out of scope (named so coverage is honest):** the Mission Control API + CF Worker (`src/surface/mc/`, ~45k LOC — auth/RBAC/CORS, the "no bypass-everyone CF Access policy" invariant, the single largest attack surface, **not read**); the myelin wire crypto (`@the-metafactory/myelin` — envelope signing, `signed_by` chain, RFC-0004, lives upstream); the GitHub HMAC webhook validator; the NATS federation/admission path; the content-filter dependency; dependency supply chain and CI gates. The `arc` package manager is an explicit cross-repo trust dependency (see F2).

**Evidence standard (per finding).** Each finding carries: **Affected path** · **Violated invariant** · **Compensating controls considered** · **Exploit preconditions** · **Repro status** (`reproduced` / `not attempted`). Every code citation below was verified against the working tree at the commit named above.

**Severity rubric.** Three axes kept separate: **Blast radius** (what an exploit reaches), **Likelihood** (how reachable, given compensating controls), **Status** (net / accepted-by-client / repro-gated). A "High" that is a documented, accepted risk is disclosed as such — acceptance changes disclosure, not blast radius.

**Review process.** Findings were authored from a direct source read, then adversarially reviewed by three independent reasoning engines (Gemini, DeepSeek/Cloudflare Workers-AI, and GPT run read-only inside the working tree against the actual code). That pass corrected the framing and severity of three findings before this version; the results are reflected in the findings as written. Independence is not correctness — an independent engine can be wrong and a first-pass claim can be right — so findings are weighted by the code evidence, not by which engine raised them.

---

## 3. Trust architecture (as built)

Two inbound trust boundaries drive everything:

1. **Inbound content → CC session.** A Discord message or GitHub event becomes a prompt to a live `claude --print` session (`claude-invoker.ts:56`). The content is untrusted by construction. The session is launched **without** `--dangerously-skip-permissions`; cortex passes `--add-dir` for each allowed directory (`claude-invoker.ts:70`) and may pass `--allowedTools`/`--disallowedTools` (`:62`–`:67`). So the real file-access control surface is Claude Code's own `--add-dir` sandbox semantics + tool-availability policy + the natural-language preamble. There is **no cortex-owned deterministic path-containment check** in that stack.

2. **Installed bundle → daemon.** Surface plugins are third-party code dynamically `import()`-ed into the running daemon. Defense is the loader's gate stack (strong — §5). **Post-load there is no boundary — ADR-0024 D4: plugins run with full daemon authority, no sandbox** (`docs/adr/0024-pluggable-surface-adapters.md:35`). Documented, not hidden.

The governing design fact: all enforcement is at the gate, none at execution — and for the CC-session filesystem boundary, the gate cortex owns is prompt-level, with the deterministic part delegated to Claude Code's CLI.

---

## 4. Findings

### F1 — No cortex-owned deterministic filesystem confinement for CC sessions — **High (repro-gated; Medium until reproduced)**

- **Affected path:** `src/settings/cortex-hooks.json`, `src/runner/hooks/bash-guard.hook.ts:108–110,424`, `src/runner/security-preamble.ts:57–64`, `src/runner/claude-invoker.ts:70`.
- **Violated invariant:** "an agent driven by untrusted content cannot read/write outside its allowed directories" is enforced by a cortex-owned deterministic control.
- **Finding.** Cortex has no code that denies a filesystem access outside the allowed dirs. Two facts together:
  1. The file tools (Read/Glob/Grep/Write/Edit) have **no** `PreToolUse` matcher — `cortex-hooks.json` registers exactly one, `"matcher": "Bash"`. The `FILESYSTEM RESTRICTION` and `CONFIG IMMUTABILITY` rules exist only as prose in `security-preamble.ts`.
  2. The Bash guard is **not** a filesystem boundary either — its default allowlist includes `^cat\b`, `^head\b`, `^tail\b` (`bash-guard.hook.ts:108–110`) and it performs command-shape validation, **no path containment.** `cat ~/.config/metafactory/cortex/system/system.yaml` matches the allowlist.
- **Compensating controls considered:**
  - Claude Code receives `--add-dir <allowedDir>` per dir (`claude-invoker.ts:70`) — CC's own CLI sandbox scopes filesystem access.
  - Dispatch may set `--disallowedTools`/`--allowedTools` (`claude-invoker.ts:62–67`, policy in `resolve-access.ts`) — a session may deny Write/Edit or omit Read from an allowlist, so the tool isn't available.
  - Bot sessions run from generated isolated settings, not the reference `cortex-hooks.json` alone.
- **Exploit preconditions.** A payload reaches a session whose effective tool policy grants the file tool (or Bash read), and Claude Code's `--add-dir` semantics permit the targeted out-of-scope path. The open question a repro must settle: **does `claude --print` with `--add-dir` deny a read outside the added dirs, or allow it?** If it allows, F1 is a clean High. If `--add-dir` denies, the residual risk narrows to config-immutability and read-only enforcement (F6), which remain prompt-only.
- **Repro status:** **not attempted** (out of scope for a static pass).
- **Recommendation.** Add a cortex-owned deterministic `PreToolUse` matcher that enforces `allowedDirs`/`readOnlyDirs` with the same path-normalize+containment discipline `loader.ts` already applies to bundle paths — covering both the file tools and Bash read commands — or move the session into an OS sandbox (§6) so the boundary is kernel-enforced regardless of CLI semantics.

### F2 — Plugins execute with full daemon authority; no post-load sandbox — **High (accepted, documented residual risk)**

- **Affected path:** `docs/adr/0024-pluggable-surface-adapters.md:35`; `src/adapters/loader.ts:576–601`.
- **Violated invariant:** a compromised/malicious plugin is contained to less than full-stack authority.
- **Finding.** In-process plugins hold full daemon authority; a malicious plugin equals full stack compromise, and `await import()` executes arbitrary plugin code at load. ADR-0024 D4 states this directly, including "the compat gate is not a security gate." The loader's own comments document the escalation honestly: persistence-via-self-rewrite of cortex's `arc-manifest.yaml`, and the un-verifiable dependency on `arc` recording `repoUrl` as the real clone source (`loader.ts:576–601`).
- **Framing.** This is not a newly discovered vulnerability — it is an accepted High residual risk the client documented in ADR-0024 D4. The review's contribution is to confirm the load-time mitigations are strong (§5) and to recommend explicit escalation triggers.
- **Compensating controls considered:** the entire loader gate stack (org-trust regex, arc-manifest first-party allowlist, path/symlink containment, TOCTOU freeze) — all load-time; none execution-time.
- **Exploit preconditions.** A bundle that passes the load gates (org-trusted repo + first-party allowlist or `system.plugins.external` on) then runs arbitrary code. **Repro status:** not attempted (accepted risk).
- **Recommendation.** Raise priority relative to its accepted-risk status because it compounds with F1 (no execution boundary on either the plugin side or the session-filesystem side). The named escalation is the ADR's own — separate-process-over-IPC + registry signing (§6, Tier 2). Define the trigger: e.g. first non-first-party bundle, or first federated deployment.

### F3 — Sovereignty enforcement defaults to audit-only on the review-consumer path — **Low if staged intentionally; Medium if believed-enforcing**

- **Affected path:** `src/bus/review-consumer.ts:500` (`this.sovereigntyEnforce = opts.sovereigntyEnforce ?? false`), `:878`–`:881` (deny gated on the flag); `src/bus/sovereignty-gate.ts:69–111` (the pure decision core).
- **Violated invariant:** "confidential (local-only) payload never reaches a frontier model" is enforced, not merely observed.
- **Finding.** The `evaluateSovereignty` decision core is sound and fail-closed (verified: missing block denies `:74`; missing `frontier_ok` treated as not-cleared `:80`; demand-first `#1023` logic correct `:90–97`). But on the review-consumer path, `sovereigntyEnforce` defaults to `false` — because `modelClass` is self-declared/spoofable until bound to a signing identity — so a sovereignty violation is logged (`enforced: false`, `:878`) and not denied unless an operator turns enforcement on (`:881`).
- **Compensating controls considered:** the audit event is emitted (observable); enforcement is a config flip once model-class↔identity binding lands.
- **Exploit preconditions.** Production runs with `sovereigntyEnforce` off (the default) and an operator or the client believes the sovereignty guarantee is live. **Repro status:** not attempted — the default is confirmed in code.
- **Recommendation.** State explicitly, in the deployment's security posture, whether production has `sovereigntyEnforce` on. If the audit-only default is a conscious staging step (pending model-class↔signing binding), document it so no one mistakes observe-and-log for enforcement.

### F4 — Principal-DM mode disables the Bash guard; the identity basis is the principal-mapping — **Medium (exploitability unproven)**

- **Affected path:** `src/runner/security-preamble.ts:11–27`; `bash-guard.hook.ts:131,392`; `src/common/policy/resolve-access.ts:269,323`.
- **Violated invariant:** the highest-privilege (guard-disabled) session context cannot be reached or influenced by untrusted content.
- **Finding.** Principal-DM sessions disable the Bash guard entirely (`{"disabled":true}` → `bash-guard.hook.ts:131`). The identity basis is the principal-mapping, not a bare `operatorDiscordId`: policy resolves `(platform, authorId)` to a principal (`resolve-access.ts:269`) and checks the `operator` capability (`:323`). The residual risk is two-part: (1) untrusted forwarded/channel content must not be injectable into the trusted, guard-off DM context; (2) the principal↔platform-ID mapping must be config-integrity protected.
- **Compensating controls considered:** the DM channel is 1:1; the principal is a deliberately trusted identity; G-301 (issue #42) is the client's own planned hardening.
- **Exploit preconditions.** A path that relays untrusted content into a principal-DM session, or a way to corrupt the principal mapping. **Repro status:** not attempted; exploitability unproven.
- **Recommendation.** Treat the principal mapping as security-critical (immutable config source); ensure no relay path forwards untrusted content into a guard-off DM; land G-301.

### F5 — Good marks (recorded as explicitly as the gaps)

- **Plugin loader trust gates (`loader.ts`) — reference quality.** Org-trust regex applied unconditionally (`:947`); first-party exemption keyed on cortex's own PR-reviewed manifest, with the two spoofable signals (`kind`/`id`, arc `tier`) explicitly rejected and why documented (`:375–404`,`:481–519`); path-traversal + symlink-escape containment on install dir and manifest file (`:262–309`); entry-path containment (`:709–730`); and a TOCTOU-closing frozen sanitized copy of the untrusted export (`:1081–1119`) — the code found and fixed its own shadow-via-platform adversarial case.
- **Bash guard is a well-built command-shape allowlist.** Metacharacter scan on the raw command (`:467`); fail-closed gh repo pin (`:500`); fail-open goes to CC's normal permission gate, never auto-approve (`:554–558`). **Caveat:** it is a command-shape allowlist, not a path sandbox — do not credit it as filesystem containment (see F1).
- **Fail-closed is the consistent default** — every read/parse-failure branch narrows trust (`:603–608`,`:630–632`).
- **Honest in-code threat notes** — persistence-via-self-rewrite and the arc-`repoUrl` cross-repo dependency documented at the point of risk.

### F6 — `readOnlyDirs` are not deterministically read-only at the cortex layer — **Low**

- **Affected path:** `claude-invoker.ts:70` (dirs → `--add-dir`), `security-preamble.ts:67–77` (read-only rule is prose).
- **Finding.** `readOnlyDirs` are appended to `--add-dir` (which grants access) while write-prevention is delivered only by the preamble — unless Write/Edit are denied via tool policy for that session. So a read-only directory is not deterministically write-protected at the cortex layer.
- **Repro status:** not attempted. **Recommendation.** Fold into the F1 deterministic path-guard: enforce read-only as a code check on Write/Edit/Bash-write targets, not prose.

---

## 5. Findings summary

| ID | Finding | Severity | Repro |
|----|---------|----------|-------|
| F1 | No cortex-owned deterministic filesystem confinement (file tools + Bash read) | High (repro-gated) → Medium until proven | not attempted |
| F2 | Plugins run with full daemon authority, no post-load sandbox | High (accepted, documented) | n/a |
| F3 | Sovereignty enforcement defaults to audit-only (`sovereigntyEnforce ?? false`) | Low / Medium | default confirmed in code |
| F4 | Principal-DM disables Bash guard; risk is content-relay + principal-map integrity | Medium (unproven) | not attempted |
| F5 | Loader gates, bash guard, fail-closed defaults, honest threat notes | Good | — |
| F6 | `readOnlyDirs` not deterministically read-only | Low | not attempted |

---

## 6. Sandbox recommendations

F1, F2, and F6 share one root cause: cortex has no execution-time boundary — only load-time gates and CLI/prompt-level scoping. Sandboxing addresses all three. Cheapest-first:

**Tier 0 — close the cortex-owned gap in-code.** A deterministic `PreToolUse` matcher for the file tools and for Bash read commands (`cat`/`head`/`tail` argument paths), enforcing `allowedDirs`/`readOnlyDirs` with the path-normalize+containment discipline `loader.ts` already uses. This gives cortex a boundary it owns, independent of Claude Code's `--add-dir` semantics. No new infrastructure. It does not address F2.

**Tier 1 — OS-level confinement of each CC session.** Run each dispatched `claude --print` inside a kernel-enforced jail so the filesystem/exec boundary is the OS, not a hook or a CLI flag:
- **macOS:** `sandbox-exec` with a `.sb` profile scoping filesystem reads/writes to the session's allowed dirs and denying network except required endpoints.
- **Linux:** `bubblewrap` (rootless, bind-mount only allowed dirs, `--unshare-all`, `--die-with-parent`), the `landlock` LSM for filesystem scoping, or a minimal `nsjail` + seccomp profile.
- This makes the preamble defense-in-depth with a kernel boundary underneath, and settles F1's repro question by construction.

**Tier 2 — separate-process plugin isolation (the F2 fix ADR-0024 D4 already names).** Load each bundle in a child process with a narrow IPC surface (the exact SDK calls, nothing else) so a compromised bundle owns a sandboxed child, not the daemon. Pair with registry signing so the org-trust gate rests on a signature, not the arc-`repoUrl` assumption the loader itself flags as un-verifiable.

**Tier 3 — network egress allowlist.** Deny-by-default outbound from CC sessions and plugins, allow only the API + git endpoints. This converts a successful file-read into a contained incident (can read, cannot exfiltrate).

**Sequencing.** Tier 0 first (it is the boundary cortex actually owns); Tier 1 next (largest boundary-per-effort, and macOS `sandbox-exec` is available today, retiring F1's open repro question); Tier 2/3 as the D4 escalation lands. Tier 0 + Tier 3 together convert F1 from possible silent exfiltration to a contained, observable, logged event.

---

## 7. Coverage & limitations

This is a targeted review of the trust-boundary surfaces named in §2, not a whole-repository audit. The largest untested surface is the Mission Control API and CF Worker (auth, RBAC, CORS, the CF Access policy invariant); the myelin wire crypto (envelope signing, `signed_by` chain) is upstream and unaudited here; the GitHub HMAC webhook path and the NATS federation/admission path were not read. F1's top-of-band severity depends on a reproduction that was not attempted in a static pass — the specific test is whether `claude --print` with `--add-dir` denies or permits an out-of-scope read.

— NorthWoods Sentinel Labs
