# Cortex Hardening Plan — response to the NWS security review

**Status:** Draft (planning only — no production code)
**Author:** Luna (with Andreas)
**Evidence base:** [`reviews/2026-07-23-nws-security-review.md`](reviews/2026-07-23-nws-security-review.md) + [`reviews/2026-07-23-nws-assessment-summary.md`](reviews/2026-07-23-nws-assessment-summary.md) (NorthWoods Sentinel Labs / Rob Chuvala, 2026-07-23, against `v6.11.0`). Every load-bearing claim in the review was re-verified against source before this plan was written.
**Deep dive:** [`../design-session-sandbox.md`](../design-session-sandbox.md) (Layers 1–3).

---

## 1. The one diagnosis under every finding

**Cortex enforces at the gate, not at execution.** Boundaries are declared and checked at *load-time* (the plugin loader) and *prompt-time* (the security preamble), but once an agent driven by untrusted content is running, most boundaries are *an instruction the model is asked to obey*, not a wall that stops it. Against prompt injection that distinction is the whole game.

| Finding | The boundary that is prose/log instead of code | Verified at |
|---|---|---|
| **F1** | File tools have no `PreToolUse` hook; `cat`/`head`/`tail` allowlisted, no path check | `cortex-hooks.json:30`; `bash-guard.hook.ts:126–128` |
| **F6** | `readOnlyDirs` write-protection is a preamble sentence | `security-preamble.ts:67–77` |
| **F3** | Sovereignty (confidential-never-reaches-frontier) audit-only by default, in BOTH consumers | `review-consumer.ts:500`, `brain-consumer.ts:390` (`?? false`) |
| **F4** | Principal-DM disables the Bash guard entirely | `bash-guard.hook.ts:150` |

> Line numbers pinned to `origin/main` @ `059f619d` (2026-07-24). The review was authored against `f6f4b06d`; the bash-guard anchors shifted +18 after #2337 (cortex#2335) tightened the same file's `gh` floor — F1/F4 remain valid, EBH-1 must coordinate with that direction.
| **F2** | Plugins run at full daemon authority, no post-load sandbox (accepted) | ADR-0024 D4 |

The plugin loader (`loader.ts`) is the counter-example the review praises — real, deterministic, code-level containment. **The plan is to make the rest of the trust surface look like the loader.**

A live corroborator the static review did not have: **#1758** — the web-gateway path bypasses `DispatchHandler`, so `agentDisallowedTools`/`strictMcpConfig` (the tool-policy control the review credits as compensating for F1) is **inert for web-bound agents**. The compensating control has a hole. This is why the fix must sit at the *lowest choke point*, not the dispatch layer.

---

## 2. The response: move each boundary from prose → code → kernel

A ladder, cheapest-and-most-owned first. Maps onto the review's Tier 0–3 (§6).

| Layer | What | Fixes | Cost | Depends on |
|---|---|---|---|---|
| **L0** | ~~**Repro** the `--add-dir` question~~ **✅ DONE 2026-07-24** — `--add-dir` is an *additive grant, not a jail*; both Read and Bash `cat` read an out-of-scope canary ([result](reviews/2026-07-24-ebh0-add-dir-repro.md)) | **F1 = clean High** (severity locked) | done | — |
| **L1** | Cortex-owned `PreToolUse` **path guard** for file tools + Bash read-command paths; reuse `loader.ts` normalize+contain | F1 (cortex-owned side), F6 | S | — |
| **L2** | **OS session jail** per `claude --print` (sandbox-exec / bwrap+landlock+seccomp) | **v1 `guarded`:** F6 by construction; F1 **only for the enumerated sensitive set** — *not* by construction. **v2 `strict`:** F1 by construction | M | choke point |
| **L3** | **Egress allowlist** (filtering proxy, deny-by-default) | exfiltration containment | M | L2 net-ns |
| **L4** | **Plugin process isolation** + registry signing | F2 | L | trigger-gated |

L1–L3 are designed in [`design-session-sandbox.md`](../design-session-sandbox.md). L1 (in-process guard) and L2 (kernel jail) are **not redundant** — L1 is the precise, observable, agent-visible boundary for the common case; L2 is the un-bypassable floor that holds even when L1 is missing or bypassed (which #1758 proves happens). L3 ensures a read that clears both still can't leave the box.

> **⚠️ What L2 v1 does NOT close (measured, 2026-07-26, EBH-3a review).** The v1 `guarded`
> posture is `(allow default)` + an enumerated denylist, because E4 measured that a strict
> `(deny default)` SIGABRTs the session. So **F1 is narrowed, not closed**: everything not
> named is still readable. Probing the generated profile on a real host read **11** credential
> stores straight through it — `~/.gnupg`, `~/.docker/config.json`, `~/.config/gh/hosts.yml`,
> `~/Library/Keychains`, `~/.gitconfig`, shell histories, `~/.claude.json`, `~/.soma`, … (only
> `~/.ssh`, `~/.aws` and the cortex config tree are denied).
>
> **A denylist cannot be completed by adding entries** — that is the structural point, not a
> backlog item. Enumerating more paths raises the cost of the attack; it never establishes a
> boundary. The boundary arrives with v2 `strict` (deny-default + explicit allow), and only
> there is "by construction" an honest phrase.
>
> Practical consequence: **do not describe L2 v1 as "the session is jailed."** It is
> "these specific secrets are protected, and read-only means read-only." The sensitive-set
> gap must be closed before `mode: audit` is ever enabled anywhere — tracked as **#2409**.

---

## 3. Cross-cutting decisions (not sandboxing, but owed a call)

- **F3 — Sovereignty posture. Resolved (EBH-6b, cortex#2380).** The EBH-6 investigation (`docs/security/ebh-6-posture-findings.md`) found the deeper gap: `sovereigntyEnforce` wasn't just defaulted off, it was **constructor-only** — no `cortex.yaml` / config-split field could reach it in either consumer, so no principal action could turn it on. EBH-6b promoted it to a real config key, `policy.sovereignty.enforce` (boolean, **default `false`**), threaded to BOTH `review-consumer.ts` and `brain-consumer.ts`'s `sovereigntyEnforce` option from the SAME resolved value in `cortex.ts`. The decision core (`sovereignty-gate.ts`) is sound and fail-closed. **This is posture-visibility, not enforcement:** every deployment today still runs audit-only (violations are detected and logged via `system.access.denied`, never denied) until a principal explicitly sets the key — and setting it before the model-class↔signing-identity binding lands (#2117; PR #2201, open, CI-red as of EBH-6) buys less than it appears to, because `runtime.modelClass` is self-declared and spoofable until then. No default, template, or example ships `enforce: true`.
- **F4 — Principal-DM integrity.** The guard-off DM context is only as safe as (a) no relay path forwarding untrusted content into it and (b) the principal↔platform-ID mapping being immutable config. Treat the mapping as security-critical. (The review's compensating-control citation here — "land G-301 (#42 lineage)" — was stale: `#42` is an unrelated, already-merged migration PR, and G-301 has no design section, blueprint entry, or issue anywhere in the repo; see `docs/security/ebh-6-posture-findings.md` §F4-4. The real follow-up is **#2377** (F4 residual — Bash guard-off path-awareness).)
- **F4 residual — EBH-1g (cortex#2377), DECIDED.** The EBH-6 investigation (`ebh-6-posture-findings.md` §F4) found that `bash-guard.hook.ts`'s guard-off (`disabled`) branch returned `pass()` *before* EBH-1's rounds 7-9 path-containment logic — Bash had zero cortex-owned protection in a guard-off session even though the file tools (via `path-guard.hook.ts`) were already containment-checked in the same session. Principal decision (2026-07-25): **option (b)** — keep the command-shape allowlist off (G-300's whole point), but run the SAME path-containment machinery, in a lenient mode that still permits an uncataloged command to run. Landed; see the hook's own "Guard-off (G-300, principal DM) posture" doc block for the full protected/not-protected breakdown. The realistic residual this closes is indirect prompt injection into an already-legitimate guard-off session (the trigger itself cannot be forged); L2 (EBH-2/EBH-3) remains the actual boundary regardless of this L1 choice.
- **Structural posture as CI (swarm-posture).** cortex spawns multi-agent teams (`agent-team.ts`: moderator + participants) — a real invoke-graph where composed escalation can hide ("security doesn't compose"). Wire a structural least-privilege + attack-path check as a continuous gate on the fleet's tool grants. Rob's paid horizon — behavioral simulation / intent-fidelity measurement under live injection — is the dynamic complement; this static review is half one.

---

## 4. Epic breakdown (ready to execute)

Epic: **Execution-boundary hardening (NWS review response)**. Sub-issues:

| # | Layer | Title | Type | Priority |
|---|---|---|---|---|
| EBH-0 | L0 | Repro: does `claude --print --add-dir` deny an out-of-scope read? | infrastructure | now |
| EBH-1 | L1 | Cortex-owned `PreToolUse` path guard (file tools + Bash read paths) | feature | now |
| EBH-2 | L2 | `SessionSandbox` interface + `none` backend (choke point + `sandbox-unavailable` event) | feature | next |
| EBH-3 | L2 | `macos-sbpl` + `linux-bwrap` backends in `audit` mode | feature | next |
| EBH-4 | L3 | Egress allowlist via filtering proxy (extends #1192) | feature | next |
| EBH-5 | L4 | Plugin process isolation + registry signing (F2) — trigger-gated | infrastructure | future |
| EBH-6 | X | Sovereignty posture (F3) + principal-map integrity (F4) decisions | documentation | next |
| EBH-7 | X | swarm-posture structural check as CI gate | infrastructure | future |

Sequencing: **L0 → L1 → L2 (`none` → `audit` → `enforce`) → L3**, with L4 trigger-gated (first non-first-party bundle, or first federated deployment) and EBH-6/7 in parallel.

---

## 5. What this plan explicitly does NOT claim

- Nothing here is a Showstopper; the review found no auth bypass and rates the core security-mature. This is "where a strong system thins out," not "a broken one."
- The session sandbox (L1–L3) does **not** contain plugins (F2) — plugins run in the daemon, not the session. L4 is a separate mechanism.
- The sandbox bounds **blast radius**, not **intent** — an injection that abuses in-scope access is a behavioral-simulation problem, out of scope for structural confinement.
- The largest untested surface (Mission Control API + CF Worker auth/RBAC/CORS) was out of the review's scope and is out of this plan's; it needs its own pass.
