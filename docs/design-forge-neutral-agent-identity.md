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

M1–M2 are near-free now and expensive later; they should land first regardless of when M3+ follows.

---

## 7. Open questions

| # | Question | Bias |
|---|---|---|
| Q1 | Does any real agent need forge-**API** calls across two orgs in one dispatch (§4.3's excluded case)? | defer until observed; fail loudly meanwhile |
| Q2 | Cache in the helper process, or a short-lived daemon-side cache shared across a session's operations? | start in-process; measure before adding shared state |
| Q3 | Should `gitIdentity` be per-agent only, or also declarable per-stack as a default? | per-agent only in v1 — matches how `env:`/`github` already scope, and avoids an inheritance rule nobody asked for |
| Q4 | Do SSH remotes need equivalent treatment (signing keys / deploy keys), or is HTTPS-only acceptable for v1? | HTTPS-only v1; SSH is a separate credential class |
| Q5 | Does `arc` need to provision identity registry entries at bundle install, or stays principal-managed? | principal-managed v1 (mirrors `stack.nkey_seed_path`) |

---

## 8. Out of scope

- Rotating or revoking the underlying App private keys (principal-managed, as today).
- Signing commits as the bot identity (separate concern; see `commit-signing.ts`).
- Any change to `DevForge` itself — this spec supplies credentials *to* that seam, it does not alter it.
- Retroactive attribution of existing history (settled on vision#11: leave it).
