# Forge-Neutral Agent Identity — Design Spec

**Status:** Draft — supersedes the transport and schema shape shipped in #2396 / #2399 / #2408.
**Date:** 2026-07-26
**Driver:** Andreas (principal), from two requirements stated after #2408 merged.
**Tracking:** vision#11 (the identity decision), #2406 (the shipped wiring), #2419 (scope-mismatch warning — folded in here).

**Related:**
- `docs/design-arc-agent-bots.md` — per-agent credential lifecycle precedent (`cortex creds issue/revoke/rotate` for NATS). This spec is the same pattern for git forges.
- `src/runner/dev-consumer.ts` §`DevForge` — the **existing** forge seam this spec aligns to.
- `src/common/auth/github-app-token.ts` — the minting library, which survives unchanged.

---

## 1. Why this supersedes what just shipped

#2408 landed `AgentSchema.github: { identityName }` → mint a GitHub App installation token per dispatch → inject as `GH_TOKEN`. It is tested, fail-closed, and works for the case it was built for. Two requirements surfaced immediately after merge that its **shape** cannot satisfy.

### R1 — One agent, multiple orgs, one stack

`GH_TOKEN` is a single environment variable carrying a single credential. A GitHub App installation token is scoped to **one installation**, i.e. one org. An agent whose stack spans two orgs needs two credentials simultaneously.

This is not a tuning problem. No amount of installation-resolution logic makes a single-valued channel carry two values. **The transport is wrong**, not the resolution.

Evidence this is real, not hypothetical: the principal runs one Luna assistant across stacks bound to different orgs (`aastroemgroup/*` on the `halden` stack, `the-metafactory/*` on others). Verified live: the `luna-dev` App's `/app/installations` returns exactly one installation (`the-metafactory`), while halden's Luna has its `gh` bash rule pinned to three `aastroemgroup` repos — zero overlap, and cortex accepted the config silently (#2419).

### R2 — Forge neutrality

cortex **already decided to be forge-neutral** and #2408 broke that consistency:

- `src/runner/dev-consumer.ts:141` defines `DevForge` as the push/open-PR seam.
- `src/runner/sage-runner.ts:296` branches on `forge === "github" || forge === "gitlab"`.
- `src/runner/review-prompt.ts:103-104` selects `gh pr review` vs `glab` from the same value.

So the codebase models forges as a variable, and #2408 introduced a field named `github` with a GitHub-App-shaped value and a `GH_TOKEN`-shaped output. That is a GitHub-shaped hole in a forge-aware tree. The principal's requirement is explicit: the standard approach must work for GitLab and self-hosted git, not only GitHub.

### R3 — there are already THREE mechanisms; this must unify, not add a fourth

Discovered while scoping this spec. `src/runner/dev-consumer-boot.ts:242` reads a scoped forge token from **`CORTEX_DEV_GH_TOKEN`** (`DEFAULT_TOKEN_ENV`, `:196`; overridable via `devGhTokenEnv`) **at boot**, injects it as `GH_TOKEN` for push + `gh pr create` (`:493`, `:651`), and on absence emits a loud warning then **falls back to the principal's ambient `gh` authority** — verified: when `scopedToken` is unset the child env is `{...opts.env}` with no `GH_TOKEN` override (`:491-494`), so whatever ambient credential the daemon holds applies. The in-code comment names it "the warned ambient-fallback path" (`:489-490`); recorded as the accepted F-2 residual in `docs/design-agentic-dev-pipeline.md` §3.5b.

Its own warning text says *"Set `<tokenEnv>` to a repo-scoped machine-user token"* — §3.5b anticipated precisely this problem and reached for the machine-account answer that vision#11 later superseded with GitHub Apps.

So the tree now holds three answers to one question:

| Mechanism | Resolution | Failure mode | Multi-org |
|---|---|---|---|
| §3.5b `devGhTokenEnv` | boot-time env read | **fail-OPEN** (ambient fallback, warned) | no |
| #2408 `AgentSchema.github` | per-dispatch mint | fail-closed | no |
| This spec | per-operation resolve | fail-closed | yes |

**DD-0 — one mechanism. Not three, and not four.**

This is a **standing invariant, not a one-time consolidation.** There is exactly one way an agent's git credential is resolved, and any new path must REPLACE it rather than sit beside it. That rule binds this spec first: added alongside §3.5b and #2408 it would simply be the fourth mechanism, and the fourth is worse than the third for the same reason the third was worse than the second.

The problem DD-0 exists to prevent, concretely: today the credential an agent ends up with depends on **how the work reached it**, not on its config. The same agent, on the same stack, against the same forge, resolves its identity differently through the dev loop than through chat — and one of those paths silently resolves to *the principal*. A reader looking at `agents[]` cannot tell which applies; it is decided by plumbing three files away.

That is strictly worse than either mechanism alone. A single fail-open path is a known risk you can reason about. Two paths with **opposite failure modes**, selected invisibly, is a system where "does this agent act as itself?" has no answer without tracing the dispatch route.

So: §3.5b's boot-time read and ambient fallback are retired (M8), and #2408's per-dispatch env injection is rewired to this spec's resolution (M4). One question, one answer, regardless of route.

### Why now

**Zero agents declare the field in production.** The switching cost is a schema edit. After the first live agent depends on it, it is a migration across live stacks. This is the cheapest moment in the feature's life to change its shape, and the cost only rises.

---

## 2. What survives

Most of the work is transport-independent and is **not** rebuilt:

| Component | Fate |
|---|---|
| `signAppJwt` / `mintInstallationToken` (`github-app-token.ts`) | **survives** — becomes the `github-app` backend |
| `enforceChmod600` on key material | **survives** |
| Fail-closed-on-mint-failure semantics + refusal envelopes | **survives** — same rule, new call site |
| Identity config file (`~/.config/metafactory/github-apps/apps.yaml`) | **generalises** — becomes forge-neutral, renamed |
| `cortex github-token mint/list` CLI | **survives**, gains forge-neutral naming |
| Both dispatch injection points (direct + bus-mediated) | **survive structurally** — what they inject changes |
| `GH_TOKEN` as the injection transport | **replaced** (§4) |
| `AgentSchema.github: { identityName }` | **replaced** (§3) |
| `GH_TOKEN` in `ALLOWED_AGENT_ENV_KEYS` | **retained** — still needed for `gh` (§4.3) |

---

## 3. Schema: forge-neutral identity declaration

Replace the GitHub-specific field with one that names an identity whose *backend* is a detail of the identity, not of the agent:

```yaml
# agents[] entry
gitIdentity: luna-dev        # a key in the identity registry (§3.1)
```

`gitIdentity` (not `github`) so the field name never implies a provider. The agent declares **who it is**, never **how the credential is obtained** — that indirection is what makes a GitLab or self-hosted identity a config change rather than a schema change.

### 3.1 Identity registry — `~/.config/metafactory/git-identities/identities.yaml`

Renamed from `github-apps/apps.yaml`; each entry is **discriminated by backend**:

```yaml
luna-dev:
  displayName: "Luna (dev)"          # for diagnostics only
  backend: github-app
  appId: "4391156"
  keyPath: "~/.config/metafactory/git-identities/luna-dev.pem"
  installations:                      # R1: MANY, not one
    - host: github.com
      account: the-metafactory
      installationId: "148931116"
    - host: github.com
      account: aastroemgroup
      installationId: "<second install>"

atlas:
  displayName: "Atlas (plan steward)"
  backend: github-app
  appId: "4391087"
  keyPath: "~/.config/metafactory/git-identities/atlas.pem"
  installations:
    - host: github.com
      account: the-metafactory
      installationId: "148931136"

# A non-GitHub identity is a config change, not a code change:
luna-gitlab:
  displayName: "Luna (dev, GitLab)"
  backend: token-ref
  host: gitlab.example.com
  accounts: ["some-group"]
  tokenRef: "env:LUNA_GITLAB_TOKEN"   # resolved at call time, never stored
```

**DD-1 — `installations[]` is a list.** The 1:1 identity→installation binding is the specific thing that made R1 unrepresentable. One App, many installations, is GitHub's actual model (verified: `/app/installations` is plural). The list makes one identity span orgs while keeping **one bot name** in every org, because the App name is global — so `luna-dev[bot]` attributes consistently everywhere. One identity, many scopes.

**DD-2 — backends are a closed, discriminated set.** `github-app` | `token-ref` initially. Adding `gitlab-app`, or a self-hosted variant, adds a backend; it never touches `AgentSchema`. A malformed/unknown backend fails at config load (fail-closed, per the `agent-env.ts` precedent).

### 3.2 Where forge code lives — adapters, and the line they don't cross

cortex extracts every platform surface to a bundle (`metafactory-cortex-adapter-{discord,slack,mattermost,web}`), loaded through `src/adapters/` registry+loader against the versioned `src/surface-sdk/` contract, with ZERO in-tree platform adapters (ADR-0024 D2). The obvious question is whether git forges should follow that shape. **Partly — and the dividing line is a trust boundary, not a taste call.**

**DD-4 — forge OPERATIONS are bundle-pluggable.** `DevForge` is already an interface, and `review-prompt.ts` already selects `gh pr review` vs `glab`. A `metafactory-cortex-forge-gitlab` bundle implementing open-PR / comment / review is directly analogous to a surface adapter: same registry and loader machinery, same versioned-SDK discipline, provider specifics out of core. This is the right shape and should reuse the existing plugin infrastructure rather than inventing a parallel one.

**DD-5 — credential and key material stay in core. A forge adapter receives a resolved credential, never a key, and never the minting path.**

The blast radii are not comparable. Surface plugins load with **full daemon authority and no sandbox** (ADR-0024 D4), and plugin process isolation is EBH-5 — **trigger-gated and unbuilt**. A compromised chat adapter posts bad messages. A compromised forge adapter holding an App private key exfiltrates write access to every repo in the installation (71 today) *and* the ability to mint fresh credentials on demand, indefinitely, until a human notices and rotates the key.

So: `ForgeAdapter.openPr(...)` is handed a credential by core; the credential helper, `backend: github-app` resolution, and every `.pem` read stay in `src/common/auth/`. Adding GitLab is then a bundle plus a `token-ref` registry entry — no plugin ever touches key material.

This is not a new principle, which is the strongest argument for it: it is exactly D8 in `design-arc-agent-bots.md`, where `cortex creds` shells out to `arc nats` specifically so the operator account signing key is never loaded into cortex daemon memory. Same reasoning, same shape — *the thing that can mint stays smaller and less pluggable than the thing that acts*. Symmetry of shape is not symmetry of authority: the plugin architecture that is correct for chat surfaces is not automatically correct for credential material, and reasoning by analogy from one to the other is the specific trap this decision exists to name.

**Proposed for `compass/ecosystem/principles.md` §Authority** (which today constrains *how much* scope a component gets, but is silent on *what form* crosses a trust boundary — so it can be fully satisfied while still handing a plugin a private key):

> **Capabilities cross trust boundaries; keys don't.** A component that acts on a credential receives the credential — scoped, short-lived, revocable. The thing that can *mint* stays smaller and less pluggable than the thing that *acts*. Symmetry of shape is not symmetry of authority.

---

## 4. Transport: a git credential helper, not an env var

The load-bearing change. Instead of resolving one credential at dispatch and injecting it, cortex configures the session to **ask** for a credential per operation.

### 4.1 Why this is the right seam

Git's credential-helper protocol passes the helper `protocol`, `host`, and `path` on stdin and reads `username`/`password` back. That gives, by construction:

- **R1 (multi-org)** — the helper sees the *actual repo* and resolves the matching installation. Two orgs in one session is no longer a conflict, because there is no longer a single shared slot.
- **R2 (forge neutrality)** — it is a **git** protocol, not a GitHub one. `gitlab.com`, self-hosted GitLab, Gitea, and any HTTPS remote work through the same seam with no new transport.
- **Per-repo least privilege** — a credential is minted for the repo being touched, not for everything the agent might touch.
- **Shorter exposure** — no long-lived value sitting in the process environment for the session's lifetime, readable by any child process.

### 4.2 Shape

```
cortex git-credential get      # reads protocol/host/path on stdin
  → resolve host+path → identity's matching installation/account
  → mint (cached, §4.4) → emit username/password
cortex git-credential store    # no-op (cortex is the source of truth)
cortex git-credential erase    # drop cache entry
```

Wired per session via git config env (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`) so it is **session-scoped** and never mutates the principal's global `~/.gitconfig` — the same isolation discipline `scopeSessionEnv` already applies.

**DD-3 — fail closed, unchanged.** No credential for a requested host/path ⇒ the helper emits nothing and exits non-zero. Git then fails the operation rather than silently falling through to the principal's ambient credential. This is the #2408 rule preserved verbatim at the new call site; it is the whole reason the feature exists.

### 4.3 The `gh` wrinkle — stated plainly

`git` uses credential helpers. **`gh api` does not** — it reads `GH_TOKEN`/`GITHUB_TOKEN`. So a session doing forge-API work (opening PRs, commenting) still needs an env-var credential, and a single one cannot span two orgs.

Resolution: **both mechanisms, each for what it can do.**
- `git` operations → credential helper (multi-org, multi-forge).
- Forge-API operations → inject a token for the session's **primary** repo context, which cortex already knows (`groveProject` / `entity` / the dispatch's repo). Retains the #2408 behaviour for the common single-repo-per-task case.
- An agent needing forge-API calls across two orgs in **one** dispatch is explicitly **out of scope for v1** and must fail loudly rather than silently using the wrong identity. Recorded as a known limitation, not papered over.

This is an honest boundary, not a complete solution. Pretending one env var can serve two orgs is what produced this redesign.

### 4.4 Caching

A single `git clone` triggers several credential lookups; minting per lookup would be wasteful and rate-limit-exposed. Cache keyed by `(identity, host, account)`, honouring `expires_at` with a safety margin, in-memory in the helper's parent where possible. Cache entries are credentials: never logged, never written world-readable, dropped on `erase`.

---

## 5. Validation (absorbs #2419)

At first successful resolution per `(agent, identity)`, warn when the identity's reachable repo set does not intersect the repos the agent's `bashAllowlist` rules pin. The live failure that prompted this: an agent holding a credential valid for `the-metafactory` while permitted only `aastroemgroup` repos — clean boot, no warning, every operation doomed.

**Compare against ALL of an identity's installations**, not just one. Checking a single declared installation would false-positive on exactly the multi-org topology DD-1 exists to support — a check that is wrong for the intended configuration is worse than no check.

Warn, don't fail: the intersection can legitimately be empty (SSH-only remotes, dynamic repo sets).

---

## 6. Migration

Nothing in production declares `AgentSchema.github`, so this is a rename plus a transport swap, not a data migration.

- [ ] **M1** — Registry: `github-apps/apps.yaml` → `git-identities/identities.yaml`, `installationId` → `installations[]`, add `backend`. Loader accepts the old shape for one release with a deprecation warning.
- [ ] **M2** — `AgentSchema.github` → `gitIdentity`. Old key accepted + warned for one release (nothing uses it; the shim is cheap insurance, not a requirement).
- [ ] **M3** — `cortex git-credential` helper + cache + tests.
- [ ] **M4** — Session wiring: git-config env instead of bare `GH_TOKEN`; retain primary-repo `GH_TOKEN` for forge-API per §4.3.
- [ ] **M5** — Validation warning (§5, closes #2419).
- [ ] **M6** — Docs: config-layout template + `sop-stack-onboarding.md` gain the field, the multi-org example, and the pairing rule. Explicitly disambiguate from the **existing** top-level `github:` key in `stacks/*.yaml`, which is webhook/repo scoping and unrelated.
- [ ] **M7** — `token-ref` backend + one real non-GitHub target, to prove R2 rather than assert it.
- [ ] **M8** — Retire §3.5b (DD-0): remove the boot-time `devGhTokenEnv` read and its **ambient fallback** from `dev-consumer-boot.ts`; the dev consumer resolves through this spec's path like every other consumer. Update `design-agentic-dev-pipeline.md` §3.5b, which currently records the machine-user-token plan vision#11 superseded.
- [ ] **M9** — `ForgeAdapter` extraction (DD-4/DD-5): forge operations move behind the surface-plugin registry as a bundle contract; credential resolution stays in `src/common/auth/`. Sequence AFTER M3–M4 — extracting operations before the credential seam is stable would bake the current `GH_TOKEN` assumption into a versioned SDK contract, which is the expensive mistake to make here.
- [ ] **M10** — Land the Authority principle in `compass/ecosystem/principles.md` (§3.2). Separate repo, separate PR; not a cortex blocker.

M1–M2 are near-free now and expensive later; they should land first regardless of when M3+ follows. **M9 is deliberately last of the code items** — DD-4 is the right destination, but a versioned plugin contract is the worst place to discover the credential shape was wrong.

---

## 7. Open questions

| # | Question | Bias |
|---|---|---|
| Q1 | ~~Does any real agent need forge-**API** calls across two orgs in one dispatch (§4.3's excluded case)?~~ | **DECIDED 2026-07-26 (principal): leave as-is, fail loud.** §4.3's exclusion stands for v1 — the case is not known to occur, stacks are org-aligned, and a loud failure surfaces it if it ever does. Revisit only on an observed instance, not in anticipation. |
| Q2 | Cache in the helper process, or a short-lived daemon-side cache shared across a session's operations? | start in-process; measure before adding shared state |
| Q3 | Should `gitIdentity` be per-agent only, or also declarable per-stack as a default? | per-agent only in v1 — matches how `env:`/`github` already scope, and avoids an inheritance rule nobody asked for |
| Q4 | Do SSH remotes need equivalent treatment (signing keys / deploy keys), or is HTTPS-only acceptable for v1? | HTTPS-only v1; SSH is a separate credential class |
| Q5 | Does `arc` need to provision identity registry entries at bundle install, or stays principal-managed? | principal-managed v1 (mirrors `stack.nkey_seed_path`) |
| Q6 | Does a third-party (non-first-party) forge adapter ever get loaded? DD-5 bounds the damage, but EBH-5 plugin isolation is still unbuilt, and `system.plugins.external` is the only gate. | no third-party forge adapters until EBH-5 ships — the first one is arguably EBH-5's trigger |
| Q7 | ~~§3.5b's ambient fallback (DD-0/M8) is a live fail-open path. Retire it with this spec, or sooner?~~ | **DECIDED 2026-07-26 (principal): fix now, standalone.** Confirmed live on the `meta-factory` stack — the warning has fired 62×, most recently today, and `CORTEX_DEV_GH_TOKEN` is set in no plist, so `dev.implement` currently pushes and opens PRs as the principal. Split out of this spec and landed independently; DD-0's §3.5b half is thereby settled ahead of M3–M4. |

---

## 8. Out of scope

- Rotating or revoking the underlying App private keys (principal-managed, as today).
- Signing commits as the bot identity (separate concern; see `commit-signing.ts`).
- Any change to `DevForge` itself — this spec supplies credentials *to* that seam, it does not alter it.
- Retroactive attribution of existing history (settled on vision#11: leave it).
