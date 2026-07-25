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

**A seventh round confirmed the structural limit, twice over** *(NWS swarm, 2026-07-25, both verified in-tree)*:
- **Coverage drift** — `file -flist` / `--files0-from=list`: a *bare relative* filename as a value-taking flag's value was not path-shaped by L1's heuristic, so it went unchecked and the command read out-of-scope paths listed inside it. Fixable in L1 (and being fixed), but it is the **fourth** distinct shape of the same "L1 must model the tool's own path-reading behaviour" problem.
- **TOCTOU** — *architecturally unfixable at L1.* The guard authorises a path **string**; the tool then **re-opens** that path. Nothing binds the checked object to the opened object, so a check-then-swap (replace an in-scope name with a symlink) escapes. The usual remedy — `openat2(..., RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` and passing the *fd* to the operation — is **not available to cortex at L1: we do not control the open.** Claude Code's own Read/Write/Bash perform it. Only a kernel boundary around the process can bind authorisation to the actual inode.

That second finding is the cleanest statement of why this layer exists: **L1 can be made fail-closed, but it can never be made sound.**

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

### 2.1 Linux / container probe — OQ-1 **RESOLVED** (2026-07-25)

Run in the real deployment shape: `debian:bookworm-slim` (matching `deploy/compose/Dockerfile.cortex`), non-root uid 1000, `bubblewrap` 0.8.0.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **E5** | ⚠️ **`bwrap` fails outright in the container shape — even as root** | `bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces` (identical as root and as uid 1000) | **DD-8 delegate-don't-nest is *required* on Linux-in-container, not merely preferable** |
| **E6** | `bwrap` **works and confines correctly** where userns is permitted | with userns available: in-scope `OK`; out-of-scope → path **not present at all** | `linux-bwrap` is viable on a systemd host with unprivileged userns enabled |
| **E7** | 🔴 **The two backends fail with *different* signals** | macOS denies → `EPERM` (E2). `bwrap` binds-what's-allowed, so an out-of-scope path is **absent** → `ENOENT` | **Breaks the DD-9 canary as originally written** (see below) |
| **E8** | ✅ **DD-8a's mount-table check is implementable** | scoped container → `mac /work/allowed virtiofs ro`; broad bind-mount → `mac /host virtiofs ro`. The two are cleanly distinguishable, and `/proc/mounts` is readable from inside | The DD-8a assertion can be built exactly as specified |

**E7 is the consequential one.** DD-9 (as merged) requires the canary to assert an "explicit DENY/`EPERM`" — that assertion **would fail on Linux**, where bwrap yields `ENOENT` instead. And `ENOENT` is precisely the weak signal the review warned about ("a missing file also fails"), so we cannot simply accept it. Resolution — **per-backend evidence semantics** (amends DD-9):

- **macOS (`macos-sbpl`)** — deny-rule model → require **`EPERM`** on the unresolved-alias read. Unchanged.
- **Linux (`linux-bwrap`)** — bind-mount model → `ENOENT` is the *correct* success signal, but it must be made **positive evidence**: assert (a) the out-of-scope canary is **absent**, **and** (b) a known in-scope control file **is** readable. (b) is what distinguishes "the sandbox removed it" from "the whole mount is broken / the path was never there".
- **`container-delegated`** — no canary is possible (nothing to self-test); the boundary evidence is the DD-8a mount assertion plus the DD-8b topology acceptance test.

### Still not measured (honest gaps)
- **Landlock** — `/sys/kernel/security/lsm` was unreadable from inside the container, so landlock availability is still unconfirmed on the target hosts.
- Whether a full `claude --print` session (network + MCP + hooks + `--resume`) survives a tuned profile end-to-end (§9 OQ-2).
- **Probe caveat:** the Linux kernel here was a Docker-VM kernel (OrbStack), not bare metal. E5/E6 establish the *policy dependency* (unprivileged userns), which is the decision-relevant fact; the DD-8b acceptance gate on real topology (§7) still stands and is **not** waived by this probe.

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

### DD-8 — Container isolation is **delegated, not nested** — but "already scoped" is a **programmatic check**, never an assumption
If the boot probe detects (a) we're in a container **and** (b) the mounted filesystem is already scoped to the work dirs, the backend resolves to **`container-delegated`**: no nested sandbox, and cortex records *why* the boundary is considered satisfied. If we're in a container that is **not** scoped (e.g. the host FS bind-mounted in), that is a **misconfiguration warning**, not silent acceptance.
> This is what makes dev containers "seamless": the answer is *don't sandbox twice*, and say so out loud.

**Detection must be verified, not inferred** *(NWS review, 2026-07-25)*. If the "already scoped" judgement is wrong, `container-delegated` means **unsandboxed execution labelled as protected** — the worst possible fail-open, and the same failure shape as E3. So:

- **(a) Assert scoping from the mount table.** Inspect `/proc/mounts` / `findmnt` and require that **only** `allowedDirs`/`readOnlyDirs` are host-mounted and the container root is isolated. A broad host bind-mount (e.g. `/` or `$HOME`) resolves to **misconfiguration-warning, NOT delegated**.
- **(b) Linux is gated on Linux.** `linux-bwrap` and `container-delegated` may only report a satisfied boundary after an acceptance test **in the real systemd/container topology** proves an out-of-scope host path stays unreadable. **macOS-green must never imply Linux-safe** — every finding in §2 is macOS-only (see OQ-1).

### DD-9 — Every profile path is `realpath`-resolved, and the profile is **self-tested against the E3 failure specifically**
Directly from E3. Resolution happens before profile generation. At session start in `enforce` mode the backend runs a **canary check** and **fails closed** (refuses to launch) unless it passes.

**The canary must exercise the symlink-alias failure, not a proxy for it** *(NWS review of this spec, 2026-07-25)*. A canary that authors its deny rule on a realpath-resolved target and then reads *that same resolved path* proves only that **something** was denied — it would still pass while every other rule in the profile silently failed open on symlinks, which is exactly E3. Required shape:

1. author the deny rule against the **resolved** path (`/private/tmp/<canary>`);
2. attempt the read via the **unresolved symlink alias** (`/tmp/<canary>`);
3. require an **explicit DENY / `EPERM`** — "the read did not succeed" is **not** sufficient evidence (a missing file also fails).

Only then has symlink-aware rule matching been proven, for the profile actually in use, at runtime, every session.

**The success signal is per-backend (E7, §2.1).** macOS asserts `EPERM`; `linux-bwrap` asserts *absence* **plus** a readable in-scope control (absence alone is the weak "missing file" signal); `container-delegated` has no canary and rests on the DD-8a/DD-8b evidence instead. A canary that hard-codes `EPERM` fails on Linux; one that accepts bare `ENOENT` proves nothing.

### DD-10 — Posture per platform: start denylist, graduate to allowlist
E4 makes strict deny-default costly on macOS. Ship in two stages:
- **v1 `guarded`** — `(allow default)` + explicit denies of the sensitive set (config dir, `~/.ssh`, `~/.aws`, other stacks, everything outside allowedDirs' parents). Cheap, robust, immediately kills the L1 bypass class for the paths that matter.
- **v2 `strict`** — true deny-default allowlist once the compatibility contract (§5) is empirically pinned.
Linux `bwrap` starts at v2-equivalent natively (bind-mount only what's allowed), so the platforms converge from opposite directions. **Posture is reported, never guessed.**

### DD-11 — Sandbox unavailability splits on **input trust** — ✅ DECIDED (principal, 2026-07-25, OQ-3)

When no backend resolves, behaviour keys on **whether the stack processes input from someone other than the principal** — not on platform. Both signals already exist in config:

| Stack shape | Signal | Behaviour |
|---|---|---|
| **Untrusted input** | `policy.federated.networks[]` non-empty **or** `openOnboarding: true` | **REFUSE to dispatch.** Untrusted content with no execution boundary is exactly the F1 threat; that session does not run. |
| **Principal-driven** | neither signal | **RUN**, with a **persistent degraded state** (below). |

**"Loud" means persistent, not a log line.** A one-shot boot event scrolls away, and a sandbox that is off-forever-but-nobody-noticed is the same failure shape as E3 — looks protected, isn't. So the degraded state MUST surface as standing status (`cortex stack list`/status **and** the dashboard) in addition to the `system.security.sandbox_unavailable` event, and persist for as long as no backend resolves.

**Why not the alternatives.** *Always-refuse* goes dark on any host without `bubblewrap` (a package, not in-box — E5/E6), which invites the classic failure: set `mode: off` permanently to get work done, losing the sandbox everywhere. *Always-run* lets a federated stack sit on L1-only indefinitely.

**What the fallback actually is.** "No sandbox" is **not** "no protection" — L1 (the path guard) is in-process and still runs. But L1 is fail-closed, **not sound**: TOCTOU is unfixable there (§1), and rounds 7–8 were both *coverage drift* (`file -flist`, `git diff --no-index` — path-reading commands that weren't on the checked list). That list's completeness cannot be proven, which is why an untrusted-input stack refuses rather than leaning on it.

**Deferred (not v1):** capability-degrade for federated stacks — run with the filesystem/Bash tools stripped, so the session still answers but cannot touch files. Revisit if refusing proves operationally too harsh.

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
- The **canary self-test** (DD-9) fails the session when the sandbox is inert — asserted via the **unresolved-alias read returning an explicit DENY/`EPERM`**, not merely a failed read.
- **Linux-topology gate (DD-8b):** `linux-bwrap` and `container-delegated` each proved, **in the real systemd/container topology**, that an out-of-scope host path is unreadable. macOS-green does not satisfy this.
- **Container mis-scoping test (DD-8a):** a container with a broad host bind-mount resolves to *misconfiguration-warning*, **not** `container-delegated`.
- **TOCTOU harness (§1):** a check-then-swap race that escapes the L1 string guard is **denied** under the kernel boundary.
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
| ~~**OQ-1**~~ | ~~Run a **Linux probe** before EBH-3 commits?~~ | ✅ **RESOLVED 2026-07-25 — see §2.1 (E5–E8).** bwrap fails in-container even as root (userns), works where userns is permitted, and fails with `ENOENT` not `EPERM` (→ DD-9 amended). DD-8a mount check confirmed implementable. **Landlock still unconfirmed**; DD-8b real-topology gate still stands. |
| **OQ-2** | Empirically map what `claude --print --resume` touches (fs-usage/strace)? | The compatibility contract is currently partly assumed. Without it, `audit` burn-in is guesswork. **Recommend: yes, fold into EBH-3a.** |
| ~~**OQ-3**~~ | ~~On no-backend-available: run+loud or refuse?~~ | ✅ **DECIDED 2026-07-25 (principal) — see DD-11.** Split on input trust: federated/`openOnboarding` → **refuse**; principal-driven → **run + persistent degraded state** (not a one-shot event). Capability-degrade deferred. |
| **OQ-4** | MCP servers inside the session jail or their own? | Simpler shared profile vs tighter per-server scoping. **Lean: inside, shared.** |
| ~~**OQ-5**~~ | ~~Add systemd hardening (`ProtectHome=`, `ReadOnlyPaths=`) to `cortex@.service` as a cheap complementary layer?~~ | ✅ **RESOLVED — shipped.** `src/services/cortex@.service` now carries `NoNewPrivileges=yes`, `PrivateTmp=yes`, `ProtectSystem=strict` + `ProtectHome=read-only` (chosen over `true`/`tmpfs` — the daemon reads broadly under `$HOME` and a full hide/replace risked breaking an unenumerated legitimate read) with `ReadWritePaths=` punched for the three trees it actually writes (`~/.config/metafactory/cortex`, `~/.local/share/metafactory/cortex`, `~/.local/state/metafactory/cortex`) plus `~/.claude/events/raw` (the hook-substrate write target), `ProtectKernelTunables/Modules/ControlGroups=yes`, `RestrictSUIDSGID=yes`. Two directives were deliberately **not** set: `MemoryDenyWriteExecute` stays `no` (explicit, not omitted) — bun/node's JIT needs W+X pages, `yes` would SIGSYS the runtime; `RestrictNamespaces=` is **omitted entirely** — the not-yet-built `linux-bwrap` backend (E5/E6) will need to create its own namespaces as a child of this same daemon, and its exact minimal set isn't pinned yet, so guessing a value now risks silently blocking L2 the day it ships. Revisit `RestrictNamespaces=` alongside EBH-3b once that set is known. **Not yet verified on a real Linux boot** — `systemd-analyze verify` and functional testing were not available from the macOS environment this shipped from. |

---

## 10. Summary answer to "can we make this seamless?"

**Yes — but only by not treating every environment the same.**

- **macOS:** works today (E1/E2, verified) — with realpath discipline (E3) as the make-or-break detail.
- **Linux (systemd host):** **probed — works** where unprivileged userns is permitted (E6); confines by absence rather than denial (E7). Plus free unit-level hardening — **shipped (OQ-5)**, unverified on a real Linux boot.
- **Linux in a container:** **probed — `bwrap` cannot run at all** (E5, fails even as root). `container-delegated` (DD-8) is the *only* viable posture there, and its mount-table check is confirmed implementable (E8).
- **Containers / dev containers:** seamless *by delegation* — the container already is the boundary; detect it, don't nest it (DD-8).
- **CI:** unaffected.
- **Anywhere else / degraded:** loud and explicit, never silently unprotected (DD-7/DD-11).

The seam is already right: everything projects from one resolved policy at `cc-session` (DD-1), so L2 plugs in beside the L1 env var with no new dispatch plumbing — **provided EBH-1b lands the `readOnlyDirs` wiring first.**
