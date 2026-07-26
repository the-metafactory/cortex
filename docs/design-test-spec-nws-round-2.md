# Test Spec — NWS adversarial round 2 (response to the 2026-07-23 review)

**Status:** Draft for review
**Reviewer:** Robert Chuvala — NorthWoods Sentinel Labs
**Author:** Luna (with Andreas)
**Refs:** [`reviews/2026-07-23-nws-security-review.md`](security/reviews/2026-07-23-nws-security-review.md) · [`hardening-plan.md`](security/hardening-plan.md) · epic [cortex#2341](https://github.com/the-metafactory/cortex/issues/2341) · [vision#4 §4](https://github.com/the-metafactory/vision/issues/4)

---

## 1. Purpose

Round 1 produced one diagnosis under every finding:

> **Cortex enforces at the gate, not at execution.** Boundaries were declared at load-time and prompt-time, but once an agent driven by untrusted content was running, most boundaries were *an instruction the model was asked to obey*, not a wall that stopped it.

Seven slices have since landed. This round asks whether that is actually true now, or whether we have merely built a more convincing description of a boundary.

**The most useful thing you can do is prove a claim in §4 false.** Those are our load-bearing assertions. We would rather learn they are wrong from you than from an incident.

---

## 2. Read this before you start — what ships OFF

This matters more than anything else in the spec, and it will shape what a runtime probe finds.

**Almost all of the new enforcement is disabled by default.** `sandboxMode` defaults `"off"`, `sandboxPosture` defaults `"guarded"`, `plugins.signing` defaults `"off"`, `sovereignty.enforce` defaults `false`. **No caller sets any of them.** This was deliberate: build the boundary, verify it, enable it as a separate decision with a separate blast radius.

Consequence: **a black-box probe of a default deployment will find roughly what you found in round 1**, because at runtime little has changed. That is not a finding — it is the documented posture.

Two things *are* live and worth attacking directly:

| Live control | What it does |
|---|---|
| **L1 path guard** (`src/runner/hooks/path-guard.hook.ts`, `bash-guard.hook.ts`) | Cortex-owned `PreToolUse` containment for file tools **and** Bash read-command paths |
| **Persona `allowedTools`** (`src/bus/dispatch-handler.ts`) | A declared tool allowlist is now enforced at dispatch |

Everything else should be assessed as **code review of a boundary that is not yet switched on** — which is exactly the moment it is cheapest to fix.

---

## 3. What changed, mapped to your findings

| Your finding | What landed | Default | Where |
|---|---|---|---|
| **F1** file tools have no `PreToolUse` hook | Cortex-owned path guard; **nine** adversarial rounds (see §5) | **live** | `path-guard.hook.ts`, `bash-guard.hook.ts` |
| **F1** (kernel) | macOS `sandbox-exec` backend; `guarded` (denylist) + `strict` (deny-default) postures | off | `session-sandbox-macos.ts` |
| **F6** `readOnlyDirs` is a preamble sentence | Wired through the dispatch seam; read-only enforced at the kernel layer | live (L1) / off (L2) | `cc-session.ts` |
| **F3** sovereignty audit-only, unreachable | Promoted to a real config key, threaded to both consumers | off — still audit-only | `policy.sovereignty.enforce` |
| **F4** principal-DM disables the Bash guard | Path containment now applies in guard-off sessions (lenient mode) | live | `bash-guard.hook.ts` |
| **F2** plugins at full daemon authority | Bundle signature verification before `import()`; `off`/`permissive`/`enforce` | off | `plugin-signing.ts`, `loader.ts` |
| — (new) | L3 egress allowlist proxy, deny-by-default | off | `egress-proxy.ts` |
| **#1758** web-gateway bypasses `DispatchHandler` | **Still open.** Documented, not fixed | — | `bus-inbound-sink.ts:186` |

---

## 4. Claims we are making — please try to refute these

Each is a specific, falsifiable assertion. Breaking any one is a high-value finding.

**C1 — L1 containment has no remaining bypass.** Nine rounds closed: blacklist→whitelist inversion, `~user` expansion, brace expansion, bare-relative flag values, `git diff --no-index` arbitrary-file dump, `gh --body-file` remote exfil, `file -flist`, coverage-drift via an opt-in command list, and the guard-off residual. We believe the class is closed. *We think this is the claim most likely to be false.*

**C2 — L2 `strict` denies out-of-scope reads by construction, not enumeration.** Under `(deny default)`, a path is denied because nothing allows it. Verified: out-of-scope file, read-only-dir write, and `~/.ssh/id_ed25519` all refused with `EPERM` while no rule names any of them.

**C3 — L2 `guarded` is NOT a boundary and we do not claim it is.** It is `(allow default)` + a denylist. Eleven secret-bearing stores read straight through it before we extended the set. *A denylist cannot be completed by adding entries.* If you find our docs anywhere implying otherwise, that is a finding.

**C4 — The plugin signing gate cannot be bypassed.** Verification runs from bytes on disk before `await import()`. Our own adversarial pass found and fixed a complete bypass via `cortex plugin reload` (a second `import()` site that skipped verification). We audited for a third; we may have missed one.

**C5 — L3 egress holds only for cooperating clients.** A process that ignores proxy env vars and opens a raw socket defeats it. We state this rather than claiming containment.

**C6 — The keychain cannot be protected from the session.** Denying `~/Library/Keychains` read kills the session (`Not logged in`). `claude` authenticates through it. We believe this is permanent; if you see a way around it, we want to know.

**C7 — `mode: off` is a byte-identical no-op.** All the new machinery is genuinely inert by default.

---

## 5. Where we think we are weakest

Offered honestly, so you can spend effort where it counts rather than rediscovering what we already know.

- **#1758 — the web-gateway path bypasses `DispatchHandler` entirely**, so per-agent tool policy is inert for web-bound agents. Known, open, documented. The persona `allowedTools` work inherits this hole.
- **Coverage completeness.** Twice now we fixed a control at the call site in front of us and left a second one open (L1's nine rounds; plugin reload). **Assume there is a third.**
- **TOCTOU at L1.** Unfixable there — cortex does not control the `open()`; Claude Code's tools re-open the path. L2 is the real answer.
- **Plugin process isolation (F2) is NOT built.** ADR-0024 D4 still stands as an accepted risk. Signing narrows *which* code loads; it does nothing about what loaded code can do.
- **Linux is unvalidated.** All of L2 is macOS-only. The Linux backend is unstartable pending a capability gate (see the companion Linux field-test spec).
- **The `strict` real-session e2e could not be re-run at merge** (account quota). It passed during development. Treat `strict`'s real-world compatibility as *asserted, not currently re-verified*.

---

## 6. Suggested method

1. **Code review over black-box probing**, for the reasons in §2 — most controls are off, so runtime probing under-tests them.
2. **Attack the claims in §4 directly.** A refutation with a reproduction beats a broad sweep.
3. **For the live controls (L1, persona tools), black-box is fair game** and welcome.
4. If you want to assess enforcement behaviour, enable it explicitly in a **throwaway** deployment — `sandboxMode: "audit"`, then `"enforce"`. Please do not enable on anything real; these paths have never run in production.
5. The nine L1 rounds are in `EBH-HARDENING-LEDGER.md` with the bypass and the fix for each — useful for finding round ten.

---

## 7. Non-goals

- Not a re-audit of what round 1 already covered and we did not touch.
- Not a performance or availability assessment.
- Not the paid behavioural/intent-fidelity work — that remains a separate proposal.

---

## 8. Open questions for you

**OQ-N1 — Is "build it, verify it, ship it off" the right posture?** We chose it to separate correctness risk from availability risk. The cost is that little is enforced today. Would you rather see audit mode enabled by default?

**OQ-N2 — Is the enumerated sensitive set worth maintaining at all**, given a denylist cannot be completed? Or should we go straight to `strict` everywhere and delete `guarded`?

**OQ-N3 — Does the swarm-posture structural check** (`docs/security/swarm-posture/`) measure anything you consider meaningful, or is it security theatre?

---

## 9. Delivery

- **Format:** whatever suits you; round 1's review document worked well.
- **Filing:** findings as issues on `the-metafactory/cortex` referencing #2341, or one document — your preference.
- **What we will do with it:** the same as round 1 — verify every claim against source before planning, and tell you which ones did not survive verification.
