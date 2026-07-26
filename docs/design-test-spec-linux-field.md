# Test Spec — Linux field validation of the execution-boundary hardening

**Status:** Draft for review
**Tester:** Vincent Zontini (fresh-install / bring-up, Debian/Linux)
**Author:** Luna (with Andreas)
**Refs:** epic [cortex#2341](https://github.com/the-metafactory/cortex/issues/2341) · [vision#4 §4](https://github.com/the-metafactory/vision/issues/4) (trust & hardening) · [cortex#2424](https://github.com/the-metafactory/cortex/issues/2424) (Phase-0 field-test hardening) · `docs/design-session-sandbox-platforms.md` · `docs/security/hardening-plan.md`

---

## 1. Problem

Seven slices of execution-boundary hardening landed between 2026-07-24 and 2026-07-26 (see §Appendix). **All of it was built and verified on macOS.** The Linux half is undischarged, and one specific gate cannot be answered from a Mac at all:

> **DD-8b — does a kernel-level sandbox actually work in the real Linux deployment topology?**

Measured on this developer machine (`-platforms.md` E5/E6): `bubblewrap` **fails inside a container even as root**, and works only where user namespaces are permitted. A Docker probe established the dependency but ran on a VM kernel, so it explicitly does **not** discharge the gate. Until a real Debian host answers it, the Linux sandbox backend (EBH-3b) is unstartable — we do not know which backend to build.

**This spec asks a Linux field tester to answer that**, alongside the normal install/bring-up walkthrough.

### What this spec does NOT ask for

Vincent is a **usability and bring-up** tester, not a security reviewer. Nothing here requires security expertise, exploit-writing, or adversarial thinking. The adversarial re-test is a **separate** engagement for Rob Chuvala (NWS), scheduled in vision#4 §4 as *"second NWS swarm attack round after EBH-1 + audit-mode backends land"*.

---

## 2. Design decision

**DD-TS1 — the hardening ships OFF; this test validates that it stays invisible.**

Every boundary built in #2341 is **disabled by default**: `sandboxMode` defaults `"off"`, `sandboxPosture` defaults `"guarded"`, `plugins.signing` defaults `"off"`, `sovereignty.enforce` defaults `false`. No caller sets any of them.

So the **primary success criterion is a non-event**: a fresh Linux install must behave exactly as it did before this work. A tester noticing *anything* is a finding.

The secondary criterion is **capability reporting** — what the host *could* enforce, which is the input EBH-3b needs.

---

## 3. Test classes

| Class | Question | Needs security expertise? |
|---|---|---|
| **A — Regression** | Did the hardening break the normal install/bring-up path? | No |
| **B — Capability** | What sandbox primitives does this host actually support? | No |
| **C — Observability** | Does cortex correctly *report* that no boundary is enforced? | No |

Class B is the one that unblocks EBH-3b.

---

## 4. Harness contract

- **Run on a real Debian/Linux host**, not a container, unless a scenario says otherwise. Containerisation is the variable under test in T-B3.
- **Read-only and reversible.** No scenario asks you to enable enforcement, edit live config, or run anything destructive. If a step seems to want that, stop and say so — that is a spec bug.
- **Report what you observe, not what you conclude.** "Command X printed Y" is worth more than "the sandbox works". If something is ambiguous, say it was ambiguous.
- **A failure is a result.** T-B1 returning "not supported" is a *successful test* — it tells us which backend to build. There is no wrong answer.
- Paste actual command output. Exit codes matter; so does stderr.

---

## 5. Scenarios

### Class A — Regression (does it still just work?)

**T-A1 — Fresh install.** Install cortex on a clean Debian host per the standard onboarding SOP. Record any step that differs from your previous runs (#1678, #1737, #2331), any new prompt, warning, or delay.
*Pass:* install completes as before, no new friction.

**T-A2 — First boot.** Start the stack. Capture full boot output.
*Pass:* boots to healthy. **Any hard failure mentioning `plugin`, `signing`, `renderer coverage`, or `sandbox` is a priority finding** — those are new code paths and they are supposed to be inert.

**T-A3 — Normal session.** Run whatever your usual bring-up smoke test is (dispatch a message, get a response).
*Pass:* unchanged behaviour, no new latency.

**T-A4 — Uninstall/reinstall.** Per #2424's install/uninstall path.
*Pass:* clean, as before.

### Class B — Capability (the EBH-3b gate — the valuable part)

Run these directly in a shell. They are diagnostics, not cortex commands.

**T-B1 — Is `bubblewrap` available and functional?**
```bash
which bwrap || echo "NOT INSTALLED"
bwrap --ro-bind / / --dev /dev true 2>&1; echo "exit=$?"
```
Report both. If not installed, also report `apt-cache policy bubblewrap`.

**T-B2 — Are unprivileged user namespaces permitted?**
```bash
cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo "(knob absent)"
cat /proc/sys/user/max_user_namespaces
unshare --user --map-root-user true 2>&1; echo "exit=$?"
```

**T-B3 — Same three commands, inside a container**, if you can run one (`docker run -it debian` or equivalent). This is the case that failed on the developer's machine; we need to know whether that reproduces on a real host.

**T-B4 — Is Landlock present?**
```bash
uname -r
grep -i landlock /boot/config-$(uname -r) 2>/dev/null || echo "(no config file)"
```

**T-B5 — systemd hardening.** If running cortex under systemd:
```bash
systemd-analyze security cortex@<your-stack>.service 2>&1 | head -30
```
Report the overall exposure score and any directive listed as unsafe.

### Class C — Observability

**T-C1 — Does cortex say it has no boundary?** With the stack running, search the boot log for `sandbox-unavailable`.
*Pass:* a line appears stating no kernel boundary is enforcing the session, naming backend `none`.
*This is the correct and expected state on Linux today* — the macOS backend exists, the Linux one does not yet. We are verifying cortex is **honest about it** rather than silently pretending to be protected.

---

## 6. SOP

1. Work from a clean Debian host at the current cortex release.
2. Run Class A first — if install is broken, stop and report; B and C need a working install (except T-B1..B4, which are pure shell and can run regardless).
3. File one issue per finding against `the-metafactory/cortex`, labelled `bug` + `now`, referencing this file.
4. Post a single summary comment on **#2341** with the Class B results table — that is the EBH-3b input.

---

## 7. Non-goals

- **Not a security assessment.** No exploit attempts, no adversarial probing. That is Rob's engagement.
- **Not a test of enforcement.** Nothing is enabled; there is nothing to enforce yet.
- **Not a performance benchmark.**
- **Not macOS.** Covered already.

---

## 8. Open questions (each with a recommendation)

**OQ-TS1 — Should Vincent run T-B3 (container case) at all, given the added setup?**
*Recommendation: yes, but mark it optional.* It is the single most informative result — it decides whether the Linux backend can be `linux-bwrap` or must be `container-delegated` (DD-8, delegate-don't-nest). If it costs him more than ~15 minutes, skip it and we accept a slower EBH-3b.

**OQ-TS2 — Should this spec wait for the next cortex release?**
*Recommendation: yes.* v2 `strict` (`8ed20b62`) is currently unreleased, and one egress fix is in flight. Testing a version that isn't a release makes findings hard to attribute. Cut the release first, then hand this over.

**OQ-TS3 — Is `systemd-analyze security` (T-B5) meaningful given the unit hardening merged in OQ-5?**
*Recommendation: yes, and record the score as a baseline.* We applied `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=read-only` and traced `ReadWritePaths` — but only ever validated them in CI, never on a real Debian host under a real workload.

---

## 9. Delivery

- **Deliverable from Vincent:** the Class B results table on #2341, plus one issue per Class A/C finding.
- **What it unblocks:** EBH-3b (Linux backend) — currently unstartable.
- **Estimated effort:** ~45 min for Classes A + C alongside a normal bring-up run; ~15 min for Class B; +15 min if T-B3 is attempted.

---

## Appendix — what landed (for context only; no action required)

| Slice | What | Default |
|---|---|---|
| EBH-1 (×8 rounds) | Path guard for file tools + Bash read paths | **live** |
| EBH-2 | Session-sandbox choke point | off |
| EBH-3a | macOS `sandbox-exec` backend | off |
| EBH-4 | Egress allowlist proxy | off |
| #2409 pt1/pt2 | Sensitive set + deny-default `strict` posture | off |
| EBH-5 | Plugin bundle signature verification | off |
| EBH-6/6b | Sovereignty posture made configurable | off (audit-only) |
| #2386 | Persona `allowedTools` enforced at dispatch | **live** |
