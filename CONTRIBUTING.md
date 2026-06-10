# Contributing to cortex

Thanks for your interest in cortex, the metafactory ecosystem's layer-7
collaboration surface. This guide is self-contained: you do not need access to
any private metafactory repository to contribute.

## Ways to contribute

- **Bug reports** : open an issue with steps to reproduce, expected vs actual
  behaviour, and your environment (OS, `bun --version`, cortex version).
- **Features and changes** : open an issue first to discuss direction before
  large PRs, so we can agree on the shape before you invest the work.
- **Docs** : corrections and clarifications to `README.md` and `docs/` are
  always welcome.

## Prerequisites

- [Bun](https://bun.sh) (the project's runtime and package manager; see
  `package.json` for the pinned version policy)
- A POSIX shell. macOS and Linux are supported; cortex runs services via
  `launchd` on macOS.
- NATS is required only for running the bus end to end; most unit tests run
  without it.

## Setup

```bash
git clone https://github.com/the-metafactory/cortex.git
cd cortex
bun install

# Copy and adapt the example config
cp cortex.yaml.example ~/.config/cortex/cortex.yaml

# Validate schema + agent registry without starting services
bun src/cli/cortex/commands/cortex.ts start \
    --config ~/.config/cortex/cortex.yaml --dry-run
```

## Development workflow

1. **Branch** off `main`. Use a descriptive name: `fix/<thing>`,
   `feat/<thing>`, `docs/<thing>`.
2. **Keep changes focused.** One logical change per pull request. Smaller PRs
   review faster.
3. **Write tests** for behaviour you add or fix. Tests live next to the code in
   `__tests__/` directories.
4. **Run the checks below** before pushing.
5. **Open a pull request** against `main`. Fill in what changed and why.

### Local checks

```bash
bun test          # run the test suite
bun run lint      # eslint (see eslint.config.js)
bun run typecheck # tsc, if your change touches types
```

(Confirm the exact script names in `package.json`; run the equivalents your
change touches.)

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Mattermost presence adapter
fix: reconnect bus subscription after NATS drop
docs: clarify dry-run validation step
chore: bump dependency
```

This keeps the changelog and version tooling meaningful.

### Working with worktrees

cortex is built by multiple parallel agents and humans. If you run several
branches at once, prefer `git worktree` over stashing, so each line of work has
an isolated checkout and conflicts surface at merge time rather than mid-edit.

## Pull request review

- `main` is protected. Every change lands through a pull request; direct pushes
  are blocked.
- `CODEOWNERS` auto-requests a maintainer review on every PR. At least one
  approving review is required before merge (maintainers may self-serve on
  routine internal changes).
- Keep the PR green: CI must pass. Address review comments by pushing new
  commits to the same branch (stale approvals are dismissed on push).

## Versioning and releases

cortex follows semantic versioning. Version bumps and releases are handled by
maintainers through the metafactory `arc` tooling; contributors do not need to
bump versions in their PRs. Note user-facing changes in your PR description and
they will be folded into `CHANGELOG.md` at release time.

## A note on `CLAUDE.md`

`CLAUDE.md` at the repo root is **generated** (`arc upgrade compass`) and must
not be hand-edited. Project rules that belong there are changed upstream, not in
a PR to this file.

## Code of conduct

By participating you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the
repository's license (see [`LICENSE`](LICENSE)). If you incorporate third-party
code or patterns, add the appropriate attribution to
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Security

Do not open public issues for security problems. See
[`SECURITY.md`](SECURITY.md) for how to report vulnerabilities privately.
