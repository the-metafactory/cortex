# Session Sandbox — Design Spec

**Status:** Draft (design only — no implementation)
**Author:** Luna (with Andreas), in response to the NWS security review (2026-07-23)
**Evidence base:** [`docs/security/reviews/2026-07-23-nws-security-review.md`](security/reviews/2026-07-23-nws-security-review.md) (F1, F2, F6, §6 Tiers 0–3); this repo's source at `v6.11.0`.
**Related:** [`docs/security/hardening-plan.md`](security/hardening-plan.md) (the umbrella ladder this spec is Layer 1–3 of), ADR-0024 (plugin authority, F2), issues #1192 (egress), #1758 (web-path tool-policy bypass).

---

## 0. Implementation status — EBH-4 (cortex#2346, epic #2341)

**§4.3's Layer-3 egress design is now implemented — `src/runner/egress-proxy.ts`
— with one deliberate scope narrowing worth stating plainly (claim hygiene,
per the epic's own §"three times now" lesson):**

- **Built:** a per-session, deny-by-default HTTP `CONNECT` filtering proxy.
  `SandboxProfile.egressAllow` (seeded since EBH-2) is now genuinely
  enforced: `mode: "audit"` observes+logs denials without blocking
  (`system.security.egress-denial`), `mode: "enforce"` blocks them. Fail-
  closed on ambiguity (a malformed/unparseable proxy request is denied in
  EVERY mode, never just `enforce`). Ships with the SAME HARD HOLD as every
  prior EBH-2/3a slice: `mode: "off"` everywhere by default, no template/
  example/dispatch path flips it.
- **NOT built (this slice):** the §4.3 "physically unable to reach anything
  but the proxy" story — no Linux network-namespace, no macOS PF anchor.
  Building either needs root and/or the `linux-bwrap` topology, both
  explicitly out of scope for EBH-4 (no Linux-specific dependency; macOS-only
  target). **What actually ships is a cooperating-client proxy**: it works
  because `cc-session.ts` points the child at it via `HTTP_PROXY`/
  `HTTPS_PROXY` env vars, and because well-behaved HTTP clients honor those
  vars. **A process that opens a raw socket and ignores the proxy env vars
  bypasses this completely** — there is no kernel rule forcing egress
  through it. Do not read "egress-denial events exist" as "egress is
  contained" without that qualifier. Full rationale + the exact bypass
  surface: the module doc at the top of `src/runner/egress-proxy.ts`.
- This is the SAME shape as every other layer in this epic: FS confinement
  (L1) is a string-parsing guard that can be made fail-closed but not sound;
  L2 is a real kernel boundary on macOS but denylist-posture (v1 `guarded`,
  not deny-default) and PF-anchor-less on the network side; L3 (this doc)
  is deny-by-default on the hosts it filters, but only for traffic that
  goes through it in the first place. Defense in depth, not a single
  silver-bullet boundary — see §5 below, which this note extends rather
  than replaces.

---

## 1. Problem statement

Cortex drives `claude --print` child processes from **untrusted inbound content** (Discord messages, GitHub events). Today the filesystem/exec/network boundary for those sessions is:

1. `--add-dir <dir>` per allowed dir (Claude Code's own additive scoping) — `claude-invoker.ts:72`
2. optional `--allowedTools`/`--disallowedTools` — `claude-invoker.ts:62–67`
3. a natural-language **security preamble** — `security-preamble.ts:33–121`
4. a Bash-only `PreToolUse` guard — `cortex-hooks.json`, `bash-guard.hook.ts`

Every one of these is a **gate-time or prompt-time** control. Against prompt injection, an instruction the model is *asked* to obey is not a boundary (review §3–§4). Three concrete gaps follow:

- **F1** — no cortex-owned code denies a filesystem read/write outside the allowed dirs. File tools have no `PreToolUse` hook; `cat`/`head`/`tail` are allowlisted with no path check (`bash-guard.hook.ts:126–128`, current `main` @ `059f619d`).
- **F6** — `readOnlyDirs` are appended to `--add-dir` (which *grants* access); write-prevention is prose only (`security-preamble.ts:67–77`).
- **#1758** — the web-gateway path bypasses `DispatchHandler`, so even `--disallowedTools`/`strictMcpConfig` (the control the review credits as compensating for F1) is **inert** for web-bound agents.

The review names the fix directly (§6): a cortex-owned deterministic path guard (Tier 0) **and** an OS-level jail per session (Tier 1), with an egress allowlist (Tier 3) so a read that slips through cannot leave the box.

**This spec designs that jail.** It is the kernel-enforced floor that holds *even when the prompt-level and tool-policy layers are bypassed or absent* — which #1758 proves is a real, not hypothetical, condition.

---

## 2. Design decisions

> Numbered so the roadmap and issues can trace back to them. If code contradicts a DD, the DD wins.

### DD-1 — One resolved policy, three coordinated projections

The sandbox profile, the tool policy, and the prompt preamble MUST all be derived from the **same** resolved access policy (`resolve-access.ts`). Today the preamble asserts a boundary that nothing enforces; they can drift because they are authored independently. The fix is structural: `resolveAccess()` produces one `AccessPolicy` object; from it we project (a) the advisory preamble text, (b) the CC tool flags, (c) the kernel sandbox profile. A reviewer changes the policy once; all three move together.

### DD-2 — Enforce at the lowest choke point (the child spawn), not at dispatch

The sandbox wraps the `claude` child-process spawn in `claude-invoker.ts` — the single point **every** dispatch path funnels through. #1758 shows higher layers (DispatchHandler) are bypassable by an alternate path (the web gateway). A boundary at the spawn point holds regardless of which dispatch path reached it. This is the whole reason to prefer a kernel jail over another prompt/dispatch-level check.

### DD-3 — Kernel boundary is the security control; `--add-dir` becomes advisory

Once the profile is the real boundary, `--add-dir` is retained for Claude Code's own UX/scoping behavior but is **no longer relied on for security**. This retires F1's open repro question (does `claude --print --add-dir` deny an out-of-scope read?) *by construction* — the kernel denies it whether or not `--add-dir` does. (The EBH-0 repro on 2026-07-24 confirmed the premise: `--add-dir` is an additive grant, **allows** out-of-scope reads for both Read and Bash — [result](security/reviews/2026-07-24-ebh0-add-dir-repro.md). So the kernel boundary is not merely belt-and-suspenders; it is the *only* real filesystem boundary.)

### DD-4 — Pluggable backend behind a `SessionSandbox` interface

macOS and Linux need different mechanisms, and macOS `sandbox-exec` is officially deprecated (still functional on Darwin 25, and the mechanism Chromium/others still use). Abstract the backend so the security semantics are defined once and the mechanism is swappable:

| Backend | Platform | Mechanism |
|---|---|---|
| `macos-sbpl` | Darwin | `sandbox-exec -f <profile>.sb` (Seatbelt / SBPL) |
| `linux-bwrap` | Linux | `bubblewrap` bind-mounts + `--unshare-all --die-with-parent`, `landlock` FS ruleset where available (≥5.13), `seccomp-bpf` syscall filter |
| `none` | any | opt-out / unsupported host — **logs a loud `system.security.sandbox-unavailable` event** so an un-jailed host is never silent |

Deprecation of any one mechanism is then a backend swap, not a redesign.

### DD-5 — Ship in staged modes: `off → audit → enforce`

Matching how cortex already stages enforcement (the `sovereigntyEnforce` flag, the confidentiality-gate burn-in window):

- **`off`** — no sandbox (today's behavior).
- **`audit`** — profile is computed and the sandbox runs **report-only**: denials are logged as events, nothing is blocked. Gather real dispatch data to find legitimate accesses the profile forgot, *before* they become outages.
- **`enforce`** — denials are real.

Per-stack config, default `off`, promoted deliberately. This de-risks "the jail broke a real workflow" — the #1 reason sandboxes get disabled and never re-enabled.

### DD-6 — Every denial is an observable event

A denied syscall is otherwise an opaque failure. Each backend's denial signal (macOS unified-log sandbox violations; Linux seccomp/landlock audit) is parsed and emitted as `system.security.sandbox-denial` onto the bus → dashboard. This does double duty: operational debuggability **and** the measurement signal the behavioral-simulation layer (Rob's intent-fidelity tier) consumes. A denial spike under a given inbound message *is* an injection-attempt indicator.

**Naming — hyphens, never underscores, in the leaf (cortex#1935).** The vendored myelin envelope schema pins `/type` to `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,4}$` — hyphens only. `validateEnvelope` runs on the *subscriber* (delivery) side, so an underscore-typed `system.*` type PUBLISHES without error and is then silently dropped by every standard subscriber — the event looks shipped and never reaches a soul. `system.security.sandbox-unavailable` and `system.security.sandbox-denial` are the only correct spellings; a CI regression gate (`src/bus/__tests__/envelope-type-no-underscore.test.ts`) enforces this across every non-test publisher/matcher.

---

## 3. What the sandbox must not break (compatibility contract)

The profile is deny-by-default, so the hard part is the **allow-list of legitimate accesses**. Enumerated from how the runner actually works (`claude-invoker.ts`, cc-events taps, session-manager):

| Needs to keep working | Profile grant |
|---|---|
| Reach the model API | egress allow `api.anthropic.com` (+ configured model gateway) |
| Event pipeline (hooks → raw JSONL) | **write** `~/.claude/events/raw/` |
| Hook execution | **read+exec** `~/.claude/hooks/` |
| `--resume` session continuity | **read+write** the per-project CC session/todos state dir |
| Claude CLI runtime | **read+exec** the `claude`/`bun`/`node` binaries + system libs |
| Agent's actual work | **read+write** `allowedDirs`; **read-only** `readOnlyDirs` |
| `git`/`gh` (bash-guard-allowed) | egress allow `github.com`, `api.github.com`, `codeload.github.com`; read git/gh config (see §5 residual) |
| MCP servers (if configured) | egress allow configured MCP hosts; exec MCP server binaries |

| MUST be denied | Why |
|---|---|
| **write** anywhere outside `allowedDirs` | F1/F6 blast-radius |
| **read+write** `~/.config/metafactory/cortex/` | CONFIG IMMUTABILITY (F1) — holds tokens |
| **write** `~/.claude/settings.json`, `~/.claude/hooks/` | self-modification / persistence |
| read `~/.ssh`, `~/.aws`, other principals' repos, other stacks' config | arbitrary-secret read (F1) |
| egress to any host not on the allowlist | exfiltration (Layer 3) |

---

## 4. Architecture

```
 inbound (untrusted)
      │
      ▼
 DispatchHandler / gateway BusInboundSink   ← #1758: two paths, only one applies tool policy
      │
      ▼
 claude-invoker.ts  ── resolveAccess() ──►  AccessPolicy  ──┬─► preamble text     (advisory)
      │                                                     ├─► --allow/disallowTools (CC-level)
      │                                                     └─► SandboxProfile     (kernel-level)  ◄── DD-1
      ▼
 SessionSandbox.spawn(argv, profile)        ◄── DD-2: the one choke point
      │
      ├─ macos-sbpl:  sandbox-exec -f prof.sb claude --print …
      ├─ linux-bwrap: bwrap --ro-bind … --bind … --unshare-all -- claude --print …
      └─ none:        spawn claude … + emit sandbox-unavailable
      │
      ▼
   jailed `claude` child ─┬─ file tools → kernel-scoped FS
                          ├─ Bash subprocs → kernel-scoped FS + exec
                          └─ all egress → forced through filtering proxy (§4.3)
```

### 4.1 `SessionSandbox` interface

```ts
interface SandboxProfile {
  readWrite:  string[];   // normalized, contained (reuse loader.ts discipline)
  readOnly:   string[];
  execAllow:  string[];   // binaries the session may exec
  egressAllow: string[];  // hostnames (+ ports) the proxy permits
  mode: "off" | "audit" | "enforce";
}
interface SessionSandbox {
  readonly backend: "macos-sbpl" | "linux-bwrap" | "none";
  spawn(argv: string[], profile: SandboxProfile, opts: SpawnOpts): ChildProcess;
  // denials surfaced via an async iterator the invoker pipes to the event tap
  denials(): AsyncIterable<SandboxDenial>;
}
```

`SandboxProfile` paths are normalized and containment-checked with the **same code `loader.ts` already uses** for bundle paths (`loader.ts:262–309` path-traversal + symlink-escape). We are not inventing path hygiene; we are reusing the one place in the repo that already got it right.

### 4.2 Filesystem confinement

- **macos-sbpl** — generated `.sb` with `(deny default)`, then `(allow file-read* (subpath "…"))` / `(allow file-write* (subpath "…"))` per profile entry, `(allow process-exec (literal "…"))` per exec entry. Symlink resolution done *before* profile generation (SBPL matches on resolved paths).
- **linux-bwrap** — `--ro-bind` for read-only, `--bind` for read-write, `--tmpfs /tmp`, `--proc /proc`, `--dev /dev`, `--unshare-all` (no net ns yet — see §4.3), `--die-with-parent`. Where the kernel is ≥5.13, add a **landlock** ruleset as belt-and-suspenders FS scoping (unprivileged, survives even if a bind is misconfigured). `seccomp-bpf` drops `mount`, `ptrace`, `keyctl`, module ops, etc.

### 4.3 Network egress (Layer 3)

Per-host packet filtering is awkward on both platforms (SBPL host filtering is coarse/unreliable; bwrap does no egress filtering itself). The robust, cross-platform mechanism is a **filtering forward proxy**:

- A small deny-by-default HTTP **CONNECT** proxy holds the `egressAllow` hostname allowlist.
- The session is forced through it: `HTTPS_PROXY`/`HTTP_PROXY` set in the child env, **and direct egress blocked** so the proxy can't be bypassed —
  - **Linux:** run the child in its own network namespace whose only route is a veth to the proxy (no default route to the internet). The session is *physically unable* to reach anything but the proxy. Unprivileged child never holds `CAP_NET_ADMIN`, so it cannot re-namespace out.
  - **macOS:** a PF anchor scoped to the child's uid/group denying outbound except to the proxy, plus the proxy env. (Weaker than the Linux ns approach — documented as a backend limitation, DD-4.)
- Allowlist seed: `api.anthropic.com`, `github.com`, `api.github.com`, `codeload.github.com`, configured MCP + model-gateway hosts. **Package registries are denied by default** (an agent that needs to `bun install` is an explicit, logged exception, not a standing grant).

This converts F1's worst case from **silent exfiltration** to a **contained, logged, blocked CONNECT** — the review's stated goal for Tier 0 + Tier 3 (§6).

---

## 5. Threat model — what it stops, what it accepts

**Stops (kernel-enforced, injection cannot argue its way past):**

- Injected content → agent `cat`s `~/.config/metafactory/cortex/system/system.yaml` → **read denied** (not in profile). [F1 config-immutability]
- Injected content → agent reads `~/.ssh/id_ed25519` or another stack's repo → **read denied**. [F1 arbitrary read]
- Injected content → agent writes into a `readOnlyDir` or the config dir → **write denied**. [F6]
- Injected content → agent `curl`s a secret to an attacker host → **CONNECT denied** by the proxy, event emitted. [Layer 3]

**Accepts (documented residual):**

- **Intent within scope.** An injection that makes the agent corrupt the repo it *is* allowed to work in is not a filesystem-confinement problem. The sandbox bounds *blast radius*, not *intent fidelity* — that is the behavioral-simulation layer (Rob's paid tier), explicitly out of scope here.
- **The `gh`/`git` credential file.** `gh` needs to read its token (`~/.config/gh/hosts.yml`) to work; at the FS layer we cannot distinguish "`gh` reads it" from "`cat` reads it" — same uid inside the jail. So the token file stays readable inside the jail. **Compensating control:** the egress allowlist means a read token still **cannot be exfiltrated** to an attacker host. **Deeper fix (deferred):** broker `git`/`gh` credentials through a helper that injects them only into the tool's process env, so the raw token is never file-readable — this ties directly to #1192 (credential-injection). Flagged, not solved, here.
- **F2 (plugins) is NOT covered.** Surface plugins run inside the **daemon**, not inside a session child. This session sandbox does nothing for a malicious plugin. F2 is Layer 4 (separate-process plugin isolation) — a distinct mechanism, tracked separately. Stating this so no one over-credits the session jail.
- **macOS egress is weaker than Linux** (PF-anchor vs network-namespace). Production Linux hosts get the strong form; macOS dev hosts get the best-effort form + the loud `none`/limitation events.
- **Side channels** (timing, resource) — out of scope.

---

## 6. Rollout

1. **Land `SessionSandbox` interface + `none` backend** (emits `sandbox-unavailable`). Zero behavior change; establishes the choke point (DD-2) and the event.
2. **`macos-sbpl` + `linux-bwrap` in `audit` mode.** Profiles computed and applied report-only. Run a burn-in on real dispatch traffic; every denial is a candidate missing-grant. Tune profiles until the audit log is quiet on legitimate traffic.
3. **Flip `enforce` per stack**, most-trusted-last (personal DM stacks first, federated/community stacks earliest need — decide with F4's principal-map work).
4. **Egress proxy** (Layer 3) lands alongside step 2 in `audit`, enforced in step 3.

Exit criterion for `enforce`: a full burn-in window with zero legitimate-traffic denials, and the four §5 "stops" demonstrated as blocked+logged in a test harness (this is also F1's repro, now answered by construction — DD-3).

---

## 7. Open questions

1. **CC state-dir shape under `--resume`.** Exact set of paths the `claude` CLI writes for session continuity must be enumerated empirically (strace/fs-usage during a real resumed session) before the `audit` profile is trustworthy. Assumption in §3 is a starting point, not verified.
2. **MCP server processes.** If a session uses MCP servers, those are additional child processes with their own FS/egress needs — do they run *inside* the same jail (simpler, shared profile) or their own? Leaning: inside, sharing the profile, since they act on the session's behalf.
3. **Proxy for the model API and streaming.** Confirm `claude --print --output-format stream-json` tolerates an HTTPS proxy without breaking the SSE stream. Low risk, must be verified before enforce.
4. **`sandbox-exec` longevity.** Deprecated; still present on Darwin 25. If Apple removes it, the `macos-sbpl` backend needs a successor (App Sandbox via a signed helper, or a Linux VM for the daemon). DD-4 makes this a contained swap.
