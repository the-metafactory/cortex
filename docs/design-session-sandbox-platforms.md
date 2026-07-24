# L2 Session Sandbox — Platform & Feasibility Spec

**Status:** Draft for principal review (design only — no implementation)
**Author:** Luna, 2026-07-25
**Extends:** [`design-session-sandbox.md`](design-session-sandbox.md) (DD-1…DD-6, the architecture). That doc says *what* the sandbox is; **this doc answers "can it be seamless on macOS, Linux, dev containers, and CI — and what does it cost?"**
**Evidence:** empirical probes run 2026-07-25 on macOS 26.5.1 (§2), plus the EBH-1 outcome (6 adversarial bypass rounds) that motivates L2.
**Tracks:** epic #2341 · EBH-2 (#2344, choke point) · EBH-3 (#2345, backends)

---

## 1. Why this spec exists

EBH-1 (merged, PR #2355) gave cortex an in-process path guard. Getting it safe took **six adversarial rounds**, each closing a real secret-read bypass: `~`/`$VAR` → `~user` → brace expansion → shell quote-removal → backslash escaping → `file -f<path>` flag-value exfil. Five of the six were the *same underlying problem*: **a guard that inspects command strings is trying to predict shell word-evaluation, and loses.**

L2 exists because a kernel boundary **does not parse anything**. It doesn't care whether the path was written `~root/.ssh/id_rsa`, `{/etc,x}/passwd`, `/a/""/../secret`, or `$HOME/x` — the read is denied at the syscall. That is the property L1 structurally cannot have.

**This is a major change** — it changes how every dispatched session is executed, on every platform we deploy to. This spec is the "understand the implications before we build" artifact.

---

## 2. Empirical findings (measured, not assumed)

All probes run on **macOS 26.5.1**, `/usr/bin/sandbox-exec` present.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **E1** | `sandbox-exec` **works** — deprecated but functional | `(allow default)` profile exec'd cleanly (`exit=0`) | macOS backend is viable today |
| **E2** | **Enforcement is real and reaches the runtime, not just the shell** | `cat` → `Operation not permitted`; `bun` `readFileSync` → **`EPERM`** | Kills the whole L1 bypass class by construction |
| **E3** | ⚠️ **A profile written with unresolved symlinks silently does NOTHING** | `(deny file-read* (subpath "/tmp/sb/secret"))` → secret **read successfully**. Same rule as `/private/tmp/...` → correctly denied. (`/tmp` → `private/tmp`) | **The #1 project risk.** Fails *open*, and looks enforced. |
| **E4** | Strict `(deny default)` profiles are hard: process won't even start without extensive dyld/mach allowances | `deny default` + `/usr/lib`,`/System`,`/private/var/db/dyld`,`mach-lookup` still `SIGABRT` (exit 134) | Allowlist posture needs real engineering; denylist is the cheap start |

**E3 is the headline.** A silently-ineffective sandbox is *worse than no sandbox*, because we'd stop looking. Every path entering a profile must be `realpath`-resolved, and the build must **self-test** (§7).

### Not yet measured (honest gaps)
- Linux `bubblewrap`/`landlock`/`seccomp` behaviour — **cannot be tested from macOS**. Needs a Linux probe before EBH-3 commits (§9 OQ-1).
- Whether a full `claude --print` session (network + MCP + hooks + `--resume`) survives a tuned profile end-to-end (§9 OQ-2).

---

## 3. Deployment reality — the environments we must not break

Verified in-repo. **Cortex deploys three different ways, and the existing design doc only considered one.**

| Environment | How cortex runs | Sandbox availability |
|---|---|---|
| **macOS (dev + principal stacks)** | `launchd` plists (`ai.meta-factory.cortex.stack.plist`) | `sandbox-exec` ✅ (E1), deprecated |
| **Linux host (systemd)** | `cortex@.service` — **currently no hardening directives** | `bwrap`/`landlock` likely; **plus** free systemd primitives (`ProtectHome=`, `ReadOnlyPaths=`, `PrivateTmp=`, `NoNewPrivileges=`) |
| **Container** | `deploy/compose/Dockerfile.cortex` — `debian:bookworm-slim`, non-root `USER cortex` | ⚠️ `bwrap` commonly **fails** here: needs unprivileged userns / setuid, which Docker's default seccomp + non-root often block |
| **Dev container / Codespaces** | same container shape | Same constraint as above |
| **CI** | `ubuntu-latest` runners | Sandbox not needed (no untrusted dispatch) |

### The container insight (this is the seamlessness answer)

**A container is already a sandbox.** If cortex runs in a container with only its work dirs mounted, the *container boundary already provides the filesystem confinement L2 wants*. Trying to nest `bwrap` inside it is both likely-to-fail and largely redundant.

So the correct design is **not** "make bwrap work everywhere." It is: **detect the isolation you already have, and only add a boundary where one is missing.**

---

## 4. Design decisions (extending DD-1…DD-6)

### DD-7 — Capability **detection at boot**, never assumption
Cortex probes at startup (and caches): does `sandbox-exec` exist and can it exec a trivial process? does `bwrap --version` work *and* can it actually unshare? is landlock present? am I already in a container? The resolved backend is logged and exposed on the dashboard. **We never assume a platform capability** — E4 shows even "present" ≠ "works with our profile."

### DD-8 — Container isolation is **delegated, not nested**
If the boot probe detects (a) we're in a container **and** (b) the mounted filesystem is already scoped to the work dirs, the backend resolves to **`container-delegated`**: no nested sandbox, and cortex records *why* the boundary is considered satisfied. If we're in a container that is **not** scoped (e.g. the host FS bind-mounted in), that is a **misconfiguration warning**, not silent acceptance.
> This is what makes dev containers "seamless": the answer is *don't sandbox twice*, and say so out loud.

### DD-9 — Every profile path is `realpath`-resolved, and the profile is **self-tested**
Directly from E3. Resolution happens before profile generation. Additionally, at session start in `enforce` mode, the backend runs a **canary check**: attempt one read that *must* fail. If the canary is NOT denied, the sandbox is not working → **fail closed** (refuse to launch the session) rather than run an unprotected session believing it is protected.

### DD-10 — Posture per platform: start denylist, graduate to allowlist
E4 makes strict deny-default costly on macOS. Ship in two stages:
- **v1 `guarded`** — `(allow default)` + explicit denies of the sensitive set (config dir, `~/.ssh`, `~/.aws`, other stacks, everything outside allowedDirs' parents). Cheap, robust, immediately kills the L1 bypass class for the paths that matter.
- **v2 `strict`** — true deny-default allowlist once the compatibility contract (§5) is empirically pinned.
Linux `bwrap` starts at v2-equivalent natively (bind-mount only what's allowed), so the platforms converge from opposite directions. **Posture is reported, never guessed.**

### DD-11 — Sandbox unavailability is a **loud, policy-driven** decision (principal's call)
If no backend resolves, cortex can (a) run unsandboxed + loud `system.security.sandbox_unavailable` event, or (b) refuse to dispatch. Default proposed: **(a) for dev/personal stacks, (b) for federated/community stacks** — an untrusted-input deployment should not silently lose its boundary. See OQ-3.

### DD-12 — L1 stays. Defense in depth, and it's the *observable* layer
L2 denials are opaque kernel `EPERM`s; L1 denials carry a reason string back to the agent and the relay. Keep both: L1 for precise, explainable, agent-visible refusals; L2 as the wall that holds when L1's parser is out-predicted.

---

## 5. Compatibility contract — what must keep working

The hard part of a sandbox isn't denying; it's **not breaking the legitimate 95%**. Refined from the design doc §3, with the container/CI cases added:

| Must keep working | Requirement |
|---|---|
| Model API + streaming | egress to `api.anthropic.com` (+ gateway); **verify SSE survives** (`--output-format stream-json`) |
| Event pipeline | **write** `~/.claude/events/raw/` (hooks write JSONL here — the dashboard depends on it) |
| Hook execution | **read+exec** `~/.claude/hooks/` (incl. our own L1 guards) |
| `--resume` continuity | read+write the CC session/todos state dir (**exact shape unmeasured — OQ-2**) |
| Runtime | read+exec `claude`, `bun`/`node`, system libs, dyld cache (E4) |
| Agent work | read+write `allowedDirs`; read-only `readOnlyDirs` (needs **EBH-1b** wiring first) |
| `git`/`gh` | egress to GitHub; read git/gh config (token file — see residual) |
| MCP servers | exec + egress per configured server (**OQ-4**: same jail or their own?) |

| Must be denied |
|---|
| Anything outside `allowedDirs` (read **and** write) |
| `~/.config/metafactory/cortex/**` — config immutability + tokens |
| `~/.ssh`, `~/.aws`, other principals' repos, other stacks' config |
| Self-modification: `~/.claude/settings.json`, `~/.claude/hooks/**` |
| Egress to non-allowlisted hosts (L3/EBH-4) |

---

## 6. Seamlessness — what a principal actually experiences

**Goal: zero action required on a healthy host.** Concretely:

1. **Install/upgrade** — nothing new to install on macOS (`sandbox-exec` is in-box). Linux hosts may need `bubblewrap` (a package); if absent, cortex says so at boot with the exact install command instead of failing mysteriously.
2. **Config** — one new block, defaulted off:
   ```yaml
   system:
     sandbox:
       mode: off | audit | enforce     # default: off
       backend: auto                   # auto | macos-sbpl | linux-bwrap | container-delegated | none
   ```
   `auto` + `audit` is the intended shipping default for a release cycle.
3. **Dev containers / Codespaces** — resolves to `container-delegated`; **no behaviour change, no nested sandbox, no surprise failures.**
4. **CI** — untouched (no untrusted dispatch).
5. **Diagnostics** — `cortex stack list`/status shows the resolved backend + mode per stack, so "is my sandbox on?" is answerable without reading logs. Every denial is a `system.security.sandbox_denial` event on the dashboard.
6. **When it breaks a legitimate workflow** — `audit` mode is exactly for this: it logs what *would* have been denied without blocking, so we tune the profile against real traffic before enforcing.

---

## 7. Rollout + verification (how we avoid shipping a fake boundary)

1. **EBH-2** — `SessionSandbox` interface + `none` backend + boot capability probe (DD-7). Zero behaviour change; establishes the choke point and the events.
2. **EBH-3a** — `macos-sbpl` (`guarded` posture, DD-10 v1) in **`audit`** mode + the **canary self-test** (DD-9).
3. **EBH-3b** — `linux-bwrap` + `container-delegated` detection, `audit`.
4. **Burn-in** — a full window on real dispatch traffic with **zero legitimate-traffic denials** before any `enforce`.
5. **`enforce`** — per stack, principal-flipped (**HELD** — never auto-flipped by an agent).

**Acceptance for `enforce` (each must be demonstrated, not argued):**
- The four "must be denied" classes (§5) are blocked **and logged** in a test harness.
- The **E3 regression test**: a deliberately symlinked path is still denied (proves realpath normalization held).
- The **canary self-test** fails the session when the sandbox is inert.
- A real dispatched session completes end-to-end: streaming, `--resume`, hooks, event pipeline, `gh`.

---

## 8. Implications & costs (the honest ledger)

| Implication | Assessment |
|---|---|
| **Kills the L1 bypass class** | The reason to do it. No path-string parsing involved. |
| **Engineering cost** | Moderate-high. Two backends + detection + profile generation + burn-in. Bigger than any slice so far. |
| **Breakage risk** | Real but **managed by `audit` mode**; the risk is over-denial (visible, fixable), not silent leakage. |
| **Silent-ineffectiveness risk (E3)** | The dangerous one → mitigated by DD-9 canary + regression test. Non-negotiable. |
| **macOS deprecation** | `sandbox-exec` is deprecated; still functional (E1). DD-4's pluggable backend makes replacement a swap, not a redesign. Watch item. |
| **Debuggability** | Kernel denials are opaque → DD-6 events + keeping L1's explanatory denials (DD-12) are what keep it debuggable. |
| **Performance** | Expected negligible (process-launch wrapper). Must be measured, not asserted. |
| **Does NOT cover** | Plugins (F2 — they run in the daemon, not the session → EBH-5) and intent-level abuse *within* scope (behavioural, not structural). |

---

## 9. Open questions — principal decisions needed

| # | Question | Why it matters |
|---|---|---|
| **OQ-1** | Run a **Linux probe** (bwrap/landlock/seccomp + in-container behaviour) before EBH-3 commits? | The macOS findings don't transfer; container behaviour is the biggest unknown. **Recommend: yes, cheap, do it first.** |
| **OQ-2** | Empirically map what `claude --print --resume` touches (fs-usage/strace)? | The compatibility contract is currently partly assumed. Without it, `audit` burn-in is guesswork. **Recommend: yes, fold into EBH-3a.** |
| **OQ-3** | On no-backend-available: run unsandboxed+loud, or refuse to dispatch? (DD-11) | Availability vs security posture. **Recommend: loud for personal/dev, refuse for federated.** |
| **OQ-4** | MCP servers inside the session jail or their own? | Simpler shared profile vs tighter per-server scoping. **Lean: inside, shared.** |
| **OQ-5** | Add systemd hardening (`ProtectHome=`, `ReadOnlyPaths=`) to `cortex@.service` as a cheap complementary layer? | Free daemon-level defence on Linux, independent of per-session work. **Recommend: yes, separate small slice.** |

---

## 10. Summary answer to "can we make this seamless?"

**Yes — but only by not treating every environment the same.**

- **macOS:** works today (E1/E2, verified) — with realpath discipline (E3) as the make-or-break detail.
- **Linux (systemd host):** expected to work, **needs a probe (OQ-1)**; plus free unit-level hardening (OQ-5).
- **Containers / dev containers:** seamless *by delegation* — the container already is the boundary; detect it, don't nest it (DD-8).
- **CI:** unaffected.
- **Anywhere else / degraded:** loud and explicit, never silently unprotected (DD-7/DD-11).

The seam is already right: everything projects from one resolved policy at `cc-session` (DD-1), so L2 plugs in beside the L1 env var with no new dispatch plumbing — **provided EBH-1b lands the `readOnlyDirs` wiring first.**
