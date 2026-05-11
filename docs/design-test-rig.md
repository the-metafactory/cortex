# metafactory Test Rig -- Design Spec

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-test-rig.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Status:** Draft
**Author:** Luna (PAI)
**Date:** 2026-04-05
**Research:** `docs/research-2026-04-05-isolated-testing-environments.md`, `docs/research-2026-04-05-anthropic-devcontainer-and-test-rig.md`
**Design Decisions:** Pending (will register as DD-14 if approved)

---

## Problem Statement

The metafactory ecosystem consists of 7+ repos with interdependent CLI tools (arc, grove, blueprint, miner, spawn, compass) that are installed via `arc install` into a developer's home directory (`~/.claude/`, `~/.config/metafactory/`). Both developers have fully-configured PAI environments on their local machines, making it impossible to test:

1. **Fresh install flows** -- Does `arc install grove` work from zero?
2. **Dependency completeness** -- Are all dependencies declared, or does the install silently rely on something already present?
3. **Path assumptions** -- Do tools assume `~/.config/arc/` exists? That `~/bin/` is in PATH?
4. **First-run experience** -- What does a new user actually see?
5. **Upgrade paths** -- Does `arc upgrade` work across version bumps?
6. **Cross-package interactions** -- Do hooks, symlinks, and config files coexist correctly after multiple packages are installed?

This is the gap between "it works on my machine" and "it works on any machine." Without a clean-room testing capability, every `arc install` release is a gamble.

---

## The Tool Chain Under Test

### Prerequisites (external dependencies)

| Tool | Install method | Required by |
|------|---------------|-------------|
| macOS or Linux | OS | Everything |
| Git | `brew install git` or apt | Everything |
| Bun >= 1.1 | `curl -fsSL https://bun.sh/install \| bash` | All CLI tools |
| Node.js >= 20 | `brew install node` or via Bun | Claude Code |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | Grove hooks, sessions |
| gh CLI | `brew install gh` | GitHub operations |

### Arc package manager

| What | Detail |
|------|--------|
| Install | Clone the-metafactory/arc, `bun install`, symlink to ~/bin/arc |
| Config | `~/.config/metafactory/` (packages.db, sources.yaml, pkg/) |
| Provides | Package install/remove/upgrade/audit/verify lifecycle |

### Packages via arc

| Package | What it provides | Key paths |
|---------|-----------------|-----------|
| grove | Event hooks, relay, bot, Discord CLI, dashboard | `~/.claude/hooks/EventLogger.hook.ts`, `~/.claude/hooks/GroveContext.hook.ts`, `~/.claude/hooks/GroveBashGuard.hook.ts`, `~/bin/grove-bot`, `~/bin/grove-relay`, `~/bin/discord`, `~/bin/cldyo-live`, `~/.claude/skills/Discord/` |
| blueprint | Cross-repo dependency tracker | `~/bin/blueprint` |
| miner | Process mining client | `~/bin/miner`, `~/.config/pai/miner/` |
| spawn | Execution engine | Agent manifests, secret resolution |
| compass | Governance engine | SOPs, validators, templates |

### Cloud services (out of scope for local test rig)

| Service | URL | Stack |
|---------|-----|-------|
| Grove API | grove.meta-factory.ai | CF Workers + D1 |
| Grove Dashboard | grove.meta-factory.ai | CF Pages |
| Marketplace | meta-factory.ai | CF Workers + D1 |
| Miner Dashboard | miner.meta-factory.ai | CF Workers |

---

## Test Levels

### Level 1: Unit Tests (per-repo, already exists)

Each repo has `bun test` with isolated test environments. Arc uses `createTestEnv()` to simulate the full directory structure in temp dirs. This level is well-covered and not the focus of this design.

### Level 2: Install Chain Tests (THE GAP)

This is the primary gap the test rig addresses. There is no automated way to test:

- `arc install <package>` from a clean environment
- Symlinks created correctly and tools are PATH-accessible
- Hooks registered correctly in `~/.claude/settings.json`
- Config directories created with correct structure
- `arc upgrade` preserves config, updates code
- `arc remove` cleans up completely (no orphan symlinks)
- Multiple packages coexist (grove + blueprint + miner all installed)

### Level 3: Integration Tests

End-to-end flows that cross package boundaries:

- `arc install grove` followed by `grove-relay` starts, emits events, hooks fire
- `blueprint status` reads blueprint.yaml from multiple local repos
- `miner start` followed by CC session runs, then `miner stop` with events captured in JSONL

### Level 4: Cloud/Deployment Tests

Requires real Cloudflare infrastructure. Separate from local test rig. Not addressed in this design.

---

## Research Summary

Research evaluated six approaches for isolated testing: Docker/OCI containers, Tart macOS VMs, devcontainers, Nix shells, OrbStack Linux machines, and Multipass. See `docs/research-2026-04-05-isolated-testing-environments.md` for the full comparison matrix.

Key findings that inform this design:

1. **Nix provides insufficient isolation** -- It ensures "right tools available" but cannot simulate a missing `~/.config/arc/` or missing `~/bin/` symlinks. Eliminated as a primary approach. (Research section 4)
2. **Devcontainers offer the best CI integration** -- Same spec runs locally in VS Code, in GitHub Actions, and in Codespaces. Anthropic publishes an official Claude Code devcontainer with firewall whitelisting. Zero translation cost. (Research section 3)
3. **OrbStack is strictly better than Multipass on macOS** -- Faster boot (~2s vs ~30s), more distros, better integration. Persistent VMs with real init system make it ideal for interactive debugging. (Research sections 5-6)
4. **Tart is the only option for macOS fidelity** -- Built by CI engineers at Cirrus Labs for automation. VM images are OCI-pushable. Preferred over UTM which has poor scripting support. (Research section 2)
5. **Docker alone is insufficient** -- Cannot test macOS-specific paths (Homebrew, ~/bin symlinking, Keychain, launchd), but is the right foundation for CI. (Research section 1)

The research recommends a three-tier approach: devcontainers for CI, OrbStack for daily interactive testing, Tart for pre-release macOS validation.

---

## Design: Three-Tier Test Rig

### Tier 1: Shared Devcontainer + CI (automated, every push)

A `.devcontainer/devcontainer.json` in each repo, extending a shared metafactory base image. GitHub Actions builds the devcontainer, runs install chain tests inside it, reports results.

**Base image spec (shared, published to GHCR):**

```
ghcr.io/the-metafactory/devcontainer-base:latest
  Debian bookworm
  Bun >= 1.1
  Node.js 22 LTS
  Git
  gh CLI
  jq, curl, tree (debug utilities)
  Test user: "testuser" with clean $HOME
```

**Per-repo devcontainer:**

```json
{
  "name": "{repo}-dev",
  "image": "ghcr.io/the-metafactory/devcontainer-base:latest",
  "postCreateCommand": "bun install",
  "remoteEnv": {
    "ANTHROPIC_API_KEY": "${localEnv:ANTHROPIC_API_KEY}"
  }
}
```

**Install chain test suite (new, lives in arc repo):**

```
test/e2e/install-chain/
  fresh-install.test.ts      -- arc install grove from zero
  multi-package.test.ts      -- install grove + blueprint + miner
  upgrade-lifecycle.test.ts  -- install, upgrade, verify
  remove-cleanup.test.ts     -- install, remove, verify clean
  hooks-registration.test.ts -- verify settings.json hooks
  symlink-paths.test.ts      -- verify all symlinks and PATH
  helpers/
    fresh-env.ts             -- creates isolated $HOME with correct structure
```

**Key design choice:** These tests do not need a real Claude Code API key. They test the install infrastructure -- symlinks, hooks, config files, path resolution. Any step that requires API access is mocked or skipped. This keeps CI fast and free from secret management complexity for the test suite itself.

### Tier 2: OrbStack Throwaway VMs (interactive, developer-triggered)

Quick Linux VMs for interactive debugging and exploratory testing. Not automated in CI -- this is a developer tool for investigating install failures and testing edge cases.

**Usage pattern:**

```bash
# Create clean environment (boots in ~2 seconds)
orb create ubuntu test-grove

# SSH in and run install script
orb run test-grove -- bash -c "$(cat test/e2e/install-chain/setup.sh)"

# Poke around, debug issues interactively
orb shell test-grove

# Tear down when done
orb delete test-grove
```

**Setup script (`test/e2e/install-chain/setup.sh`):**

```bash
#!/bin/bash
set -euo pipefail

# Install Bun
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"

# Install Node.js (for Claude Code)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install gh CLI
(type -p wget >/dev/null || sudo apt-get install wget -y) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) \
  && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update \
  && sudo apt install gh -y

# Clone and install arc
git clone https://github.com/the-metafactory/arc.git ~/.config/metafactory/arc
cd ~/.config/metafactory/arc && bun install
mkdir -p ~/bin
ln -s ~/.config/metafactory/arc/src/cli.ts ~/bin/arc
export PATH="$HOME/bin:$PATH"

# Test: arc install grove
arc install grove

# Validate
echo "=== Checking symlinks ==="
ls -la ~/bin/grove-bot ~/bin/grove-relay ~/bin/discord ~/bin/cldyo-live
echo "=== Checking hooks ==="
cat ~/.claude/settings.json | jq '.hooks'
echo "=== Checking skills ==="
ls -la ~/.claude/skills/Discord/
echo "=== ALL CHECKS PASSED ==="
```

### Tier 3: Tart macOS VMs (pre-release, on-demand)

Full macOS VMs for testing macOS-specific behavior. Used before major releases only -- macOS VMs are slower to provision and more resource-intensive.

**Golden image:** macOS Sequoia + Xcode CLI tools. No Homebrew, no Bun, no Node.js. This is the "empty Mac" baseline that simulates what a new Author-Builder (DD-12) would have.

```bash
# Build golden image (one-time setup)
tart create --from-ipsw sequoia-clean
tart run sequoia-clean  # install Xcode CLI tools manually
tart stop sequoia-clean

# For each test run: clone, test, discard
tart clone sequoia-clean test-grove
tart run test-grove
# SSH in, run full install flow from Homebrew through arc install grove
tart delete test-grove
```

**When Tier 3 is required:**

- Before any version bump that changes install paths or symlink structure
- Before the first Author-Builder onboarding (DD-12 milestone)
- When Tier 1/2 pass but a macOS-specific bug is reported

---

## Test Matrix

Each tier covers different aspects of the install chain. The matrix shows what is validated where.

| Test | Tier 1 (CI) | Tier 2 (OrbStack) | Tier 3 (Tart) |
|------|:-----------:|:------------------:|:--------------:|
| `arc install grove` from clean env | Yes | Yes | Yes |
| All symlinks created and PATH-accessible | Yes | Yes | Yes |
| Hooks registered in settings.json | Yes | Yes | Yes |
| Skills directories populated | Yes | Yes | Yes |
| `arc upgrade grove` preserves config | Yes | Yes | Yes |
| `arc remove grove` cleans up fully | Yes | Yes | Yes |
| Multi-package install (grove + blueprint + miner) | Yes | Yes | No |
| Homebrew prerequisite install flow | No | No | Yes |
| macOS Keychain / launchd integration | No | No | Yes |
| ~/bin PATH setup on fresh macOS shell | No | No | Yes |
| Interactive debugging of failures | No | Yes | Yes |
| Runs in GitHub Actions | Yes | No | No |

---

## Acceptance Criteria

- [ ] Shared devcontainer base image builds and publishes to GHCR
- [ ] Arc repo has install chain test suite (`test/e2e/install-chain/`) that passes in devcontainer
- [ ] `arc install grove` succeeds in clean devcontainer environment
- [ ] All symlinks verified (grove-bot, grove-relay, discord, cldyo-live, blueprint, miner)
- [ ] All hooks verified in `~/.claude/settings.json`
- [ ] `arc upgrade grove` succeeds and preserves existing config
- [ ] `arc remove grove` cleans up all symlinks and hooks (no orphans)
- [ ] GitHub Actions workflow runs install chain tests on push to arc
- [ ] OrbStack setup script (`setup.sh`) works end-to-end on Ubuntu
- [ ] Tart golden image documented and reproducible
- [ ] Documentation for running test rig locally (README in `test/e2e/`)

---

## Dependencies

| Dependency | Status | Blocks |
|-----------|--------|--------|
| `arc install` working end-to-end | In progress | Everything |
| `arc-manifest.yaml` in all repos | Done | Install chain tests |
| GitHub Actions for arc repo | Not started | CI automation (Tier 1) |
| GHCR access for the-metafactory org | Not verified | Base image publishing |
| OrbStack installed on dev machines | Not verified | Tier 2 |
| Tart installed on dev machines | Not started | Tier 3 |

---

## Implementation Path

Phased rollout aligned with the research recommendation of week-by-week delivery.

### Phase 1 (Week 1): Devcontainer + First Test

1. Create `ghcr.io/the-metafactory/devcontainer-base` Dockerfile
2. Add `.devcontainer/devcontainer.json` to arc and grove repos
3. Write `fresh-install.test.ts` -- the single most valuable test (arc install grove from zero)
4. Validate it passes in the devcontainer locally

### Phase 2 (Week 2): CI + OrbStack

1. Add GitHub Actions workflow to arc that runs install chain tests in devcontainer
2. Write remaining test suite (multi-package, upgrade, remove, hooks, symlinks)
3. Create `setup.sh` for OrbStack interactive testing
4. Add to pre-release checklist in compass

### Phase 3 (Week 3, if needed): Tart macOS

1. Build Tart golden image (bare macOS Sequoia)
2. Document the full macOS install flow from scratch
3. Run once before Author-Builder onboarding begins

---

## Open Questions

1. **Claude Code in CI:** Do we need CC installed for install chain tests, or can we mock it? Recommendation: mock it. We test the install infrastructure, not the AI. CC presence can be simulated with a stub binary that exits 0.

2. **Secret management in CI:** GitHub Actions secrets for GHCR publishing. Standard approach -- org-level `GITHUB_TOKEN` with `packages:write` scope.

3. **Test frequency:** Every push to arc? Only on PRs? Recommendation: on PR to arc plus nightly for cross-repo. Nightly catches breakage from other repos updating their `arc-manifest.yaml`.

4. **macOS CI runners:** Do we need Tart in CI, or is it developer-only? Recommendation: developer-only for now. GitHub macOS runners are expensive. Add macOS CI only when Author-Builder onboarding (DD-12) makes it worth the cost.

5. **Test user permissions:** Should the devcontainer test user have sudo? Recommendation: no. The install flow should work without elevated privileges. If a test needs sudo, that is a bug in the install flow.

---

## Non-Goals

- **Testing cloud services** -- CF Workers, D1, Pages deployment are tested separately via their own CI. The test rig covers local-only install and integration.
- **Performance benchmarking** -- The test rig validates correctness, not speed.
- **Multi-OS CI matrix** -- Start with Linux (devcontainer). Add macOS CI only when justified by DD-12 timelines.
- **Automated Tart in CI** -- Tart stays developer-local until we have budget for macOS runners.

---

*Design spec grounded in research from `docs/research-2026-04-05-isolated-testing-environments.md` and design session decisions DD-11 (dog-fooding) and DD-12 (Author-Builder beachhead). See `docs/meeting-2026-04-05-design-session.md` for full context.*
