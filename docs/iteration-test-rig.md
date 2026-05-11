# Iteration Plan: metafactory Test Rig

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-test-rig.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Design Spec:** `docs/design-test-rig.md`
**Research:** `docs/research-2026-04-05-isolated-testing-environments.md`, `docs/research-2026-04-05-anthropic-devcontainer-and-test-rig.md`
**GitHub Issue:** TBD (create after PR merge)

---

## Devcontainer Base Image

Build and publish a shared base image that all ecosystem repos can extend.

- [ ] Create `Dockerfile.devcontainer` with Debian bookworm + Bun + Node.js 22 + gh CLI + jq/tree
- [ ] Create `.devcontainer/devcontainer.json` for grove repo (extends base image)
- [ ] Build base image locally and verify `bun --version`, `node --version`, `gh --version`
- [ ] Publish to `ghcr.io/the-metafactory/devcontainer-base:latest`
- [ ] Document base image contents and build process in `test/e2e/README.md`

## Install Chain Test Suite (arc repo)

Write the tests that validate the full install lifecycle in a clean environment.

- [ ] Create `test/e2e/install-chain/helpers/fresh-env.ts` — isolated $HOME with correct structure
- [ ] Create `fresh-install.test.ts` — `arc install grove` from zero, validates all symlinks and hooks
- [ ] Create `multi-package.test.ts` — install grove + blueprint + miner, verify coexistence
- [ ] Create `upgrade-lifecycle.test.ts` — install → upgrade → verify preserved config
- [ ] Create `remove-cleanup.test.ts` — install → remove → verify no orphan symlinks or hooks
- [ ] Create `hooks-registration.test.ts` — verify all hooks registered in `~/.claude/settings.json`
- [ ] Create `symlink-paths.test.ts` — verify all symlinks exist and targets are valid files
- [ ] Create Claude Code stub binary for mocking (exits 0, creates ~/.claude/ structure)

## CI Pipeline (GitHub Actions)

Automate the install chain tests to run on every PR to arc.

- [ ] Create `.github/workflows/install-chain.yml` in arc repo
- [ ] Workflow builds devcontainer, runs install chain tests inside it
- [ ] Add nightly schedule for cross-repo validation (install latest from all repos)
- [ ] Configure GHCR authentication for base image pulling
- [ ] Add test result badges to arc README

## OrbStack Interactive Testing

Developer-triggered testing for debugging and exploratory work.

- [ ] Create `test/e2e/install-chain/setup.sh` — full install from scratch on Ubuntu
- [ ] Test script end-to-end with `orb create ubuntu test-grove`
- [ ] Document OrbStack workflow in `test/e2e/README.md`
- [ ] Add to pre-release checklist in compass

## Tart macOS Validation (deferred)

Full macOS VM testing for pre-release validation. Implement when Author-Builder onboarding (DD-12) begins.

- [ ] Build Tart golden image (bare macOS Sequoia + Xcode CLI tools)
- [ ] Document full macOS install flow from Homebrew through `arc install grove`
- [ ] Create test script for Tart VM
- [ ] Push golden image to GHCR for team sharing

## Per-Repo Devcontainer Rollout

Add devcontainer config to all ecosystem repos.

- [ ] grove `.devcontainer/devcontainer.json`
- [ ] arc `.devcontainer/devcontainer.json`
- [ ] blueprint `.devcontainer/devcontainer.json`
- [ ] miner `.devcontainer/devcontainer.json`
- [ ] spawn `.devcontainer/devcontainer.json`
- [ ] compass `.devcontainer/devcontainer.json`

---

## Priority Order

1. **Devcontainer Base Image** — foundation for everything else
2. **Install Chain Test Suite** — the core value (Level 2 tests that fill the gap)
3. **CI Pipeline** — automate so tests run on every PR
4. **OrbStack Interactive Testing** — developer tooling for debugging
5. **Per-Repo Devcontainer Rollout** — consistency across ecosystem
6. **Tart macOS Validation** — defer until DD-12 Author-Builder milestone

---

## Dependencies

```
Devcontainer Base Image
  └── Install Chain Test Suite
        └── CI Pipeline
  └── Per-Repo Devcontainer Rollout

OrbStack Interactive Testing (independent, can start anytime)

Tart macOS Validation (deferred, depends on DD-12 timeline)
```

---

*Iteration plan for design spec `docs/design-test-rig.md`. Tracks implementation of the three-tier test rig.*
