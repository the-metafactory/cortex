# macOS install-rehearsal runbook (cortex#2287)

The manual twin of `install-rehearsal-debian.sh`: a fresh-machine rehearsal of
the `arc install cortex` path on macOS, run by a HUMAN operator (the
principal, or a cohort tester) on a **fresh macOS user account**. Every step
is copy-pasteable and states its expected output; fill in the results table at
the end as you go.

**Ground rules**

- **Tokens only via your own environment or prompts — never write a real
  token, guild id, or slug into any file in this repo.** Everything you paste
  back into an issue/PR must use placeholders (`<REPLACE_ME>`,
  `100000000000000001`-style snowflakes).
- This is a rehearsal, not a fix session: if a step's observed output differs
  from the expected output, **record it in the results table and file an
  issue** — do not patch arc/cortex mid-run.
- Time budget: 30-45 minutes cold (downloads dominate).

**What you need before starting**

| Item | Where it comes from |
|------|---------------------|
| Fresh macOS user account (or a Mac with no `~/.claude`, `~/.config/metafactory`, `~/.local/share/metafactory`) | you |
| A Claude Code login (subscription or `CLAUDE_CODE_OAUTH_TOKEN`) | claude.com/claude-code |
| A Discord bot token + guild/channel/user ids for a test guild | Discord Developer Portal (manual — no API for this) |
| Network access to github.com, bun.sh, claude.ai, meta-factory.ai | — |

---

## 1. Install prerequisites

`cortex quickstart` preflight (step 1) requires `bun`, `claude`, and
`nats-server` on PATH.

```sh
# 1a. Command Line Tools (provides git). Skip if git already works.
xcode-select --install

# 1b. bun
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
bun --version

# 1c. Claude Code CLI + login
curl -fsSL https://claude.ai/install.sh | bash
claude --version        # any exit-0 version print is a pass
claude                  # complete the login flow once, then quit

# 1d. nats-server (Homebrew; or download a release binary from
#     github.com/nats-io/nats-server/releases and put it on PATH)
brew install nats-server
nats-server --version
```

**Expected:** each `--version` prints a version and exits 0. Record the four
versions in the results table.

## 2. Install arc (per arc's QUICKSTART)

```sh
git clone https://github.com/the-metafactory/arc "$HOME/arc"
cd "$HOME/arc"
bun install
bun link
arc --version
```

**Expected:** `arc --version` prints arc's version (e.g. `0.40.x`) and exits 0.

## 3. Install cortex via arc

Two modes — use **registry mode** if the cortex listing is published (D2
onward); **git mode** is the pre-publish fallback and always works.

```sh
# Registry mode (published listing; may require login first):
arc login                      # device flow against the default `metafactory` source
arc install cortex --skip-secrets

# Git mode (pre-publish fallback):
arc install https://github.com/the-metafactory/cortex --skip-secrets
```

Notes:
- `--skip-secrets` is deliberate: cortex's tokens flow through quickstart's
  `CTX_*` env contract in step 5, not arc's install-time secret provisioning.
- Do NOT pass `-y`: you want to see the capability display (that's part of
  what this rehearsal verifies).

**Expected output (in order — record any deviation):**

1. A capability display block:
   ```
   Install: cortex v6.x.y
   Source: … [community]   (git mode shows: ⚠️  UNKNOWN SOURCE … [custom])
   Risk: …
   Capabilities:
     …filesystem / network / secrets lines…
   ```
2. depends_on cascade installs — one install block per bundle:
   `metafactory-cortex-adapter-web`, `metafactory-cortex-adapter-slack`,
   `metafactory-cortex-adapter-mattermost`,
   `metafactory-cortex-adapter-discord`,
   `metafactory-cortex-renderer-pagerduty`.
3. Postinstall lines, including `Running Cortex postinstall...`, runtime
   directory creation, and a launchd section. On a FRESH account expect:
   ```
   ⚠ No stacks discovered in … — no stack plists rendered
   ```
   That warning is **normal here** — the stack doesn't exist until
   quickstart step 4 creates it (step 6 below re-renders).

## 4. Verify the install landed

```sh
arc list --json | grep -E '"name"' | sort
readlink "$HOME/.local/bin/cortex" && readlink "$HOME/.local/bin/cortex-relay"
cortex --help >/dev/null && echo CLI-OK
```

**Expected:** `arc list --json` names **cortex plus all five bundles** from
step 3.2; both readlinks resolve into
`~/.local/share/metafactory/arc/repos/cortex/…`; `CLI-OK` prints.

## 5. Build your env contract

Copy the placeholder template out of the repo clone and fill in **real**
values (this file lives in your HOME, never in a repo):

```sh
cp "$HOME/.local/share/metafactory/arc/repos/cortex/deploy/test/fixtures/cortex.env.rehearsal" "$HOME/cortex.env"
chmod 600 "$HOME/cortex.env"
open -e "$HOME/cortex.env"    # replace every placeholder with your real values
```

Real values needed: `CTX_PRINCIPAL`, `CTX_SLUG` (lowercase, letter-first),
your four Discord snowflakes, and `CTX_DISCORD_TOKEN`.
`CLAUDE_CODE_OAUTH_TOKEN` may be **deleted** on a Mac where `claude` is logged
in (step 1c) — quickstart's preflight accepts the existing login.

## 6. First quickstart run

```sh
set -a; . "$HOME/cortex.env"; set +a
cortex quickstart
```

**Expected:** steps 1-6 each end `✓`:

```
── 1. Preflight ✓ ──
── 2. Validate env contract ✓ ──
── 3. nats conf ✓ ──
── 4. Scaffold ✓ ──
── 5. Patch configs from env ✓ ──
── 6. Seed provisioning ✓ ──
── 7. Services ✓ ──
  ○ non-Linux host — launchd is handled by arc; skip
```

Step 7's `○ … skip` is correct on macOS (launchd ownership is arc's).
Step 8 will **fail on this first run** — the daemon isn't loaded yet (the
stack plist didn't exist at install time). That's the expected first-run
shape, not a bug. Continue to step 7 of this runbook.

## 7. Render + load the launchd services

The stack now exists, so re-run the (idempotent) postinstall to render its
plist, then bootstrap it:

```sh
bash "$HOME/.local/share/metafactory/arc/repos/cortex/scripts/postinstall.sh"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.meta-factory.cortex.$CTX_SLUG.plist"
launchctl print "gui/$(id -u)/ai.meta-factory.cortex.$CTX_SLUG" | grep -E "state|pid"
```

**Expected:** postinstall now prints a stack-plist rendered line (the step-3
"No stacks discovered" warning is gone); `launchctl print` shows
`state = running` with a pid.

## 8. A1 check — healthy-boot gate passes on macOS

> **Requires cortex#2282** (merged to main 2026-07-21). If your installed
> cortex predates it (no `.local/state/metafactory/cortex/logs` paths in
> `~/Library/LaunchAgents/ai.meta-factory.cortex.$CTX_SLUG.plist`), **skip
> this step** and note "pre-#2282" in the results table.

Re-run quickstart against the now-running daemon:

```sh
set -a; . "$HOME/cortex.env"; set +a
cortex quickstart
```

**Expected:** steps 1-7 as before (each ✓ / verified-skip), then a **passing**
gate reading the unified log path:

```
── 8. Healthy-boot gate ✓ ──
healthy-boot gate:
  ✓ Stack:
  ✓ connected to nats
  ✓ policy-engine active
  ✓ connected as
  ✓ Guild:
  ✓ nats /healthz
cortex quickstart: complete ✓
```

Exit code 0 (`echo $?`).

## 9. A2 check — recovery re-run restarts the daemon

> **Requires cortex#2283** (OPEN at time of writing — **skip this step if
> your installed cortex doesn't include it** and note "pre-#2283". Without
> A2, a re-run is a documented no-op on macOS: step 7 skips and the running
> daemon never picks up your fix.)

Simulate the documented recovery flow — break config, observe failure, fix,
re-run:

```sh
# 9a. Break: put an unreachable NATS port into the env and re-provision.
OLD_PID=$(launchctl print "gui/$(id -u)/ai.meta-factory.cortex.$CTX_SLUG" | awk '/pid =/{print $3}')
sed -i '' 's/^CTX_NATS_PORT=.*/CTX_NATS_PORT=4229/' "$HOME/cortex.env"
set -a; . "$HOME/cortex.env"; set +a
cortex quickstart --force        # --force: allow step 3 to overwrite the nats conf
echo "exit=$?"                   # expected: nonzero — gate fails on the broken port

# 9b. Fix: restore the real port and re-run.
sed -i '' 's/^CTX_NATS_PORT=.*/CTX_NATS_PORT=4222/' "$HOME/cortex.env"
set -a; . "$HOME/cortex.env"; set +a
cortex quickstart --force
echo "exit=$?"                   # expected: 0

# 9c. Restart observed?
NEW_PID=$(launchctl print "gui/$(id -u)/ai.meta-factory.cortex.$CTX_SLUG" | awk '/pid =/{print $3}')
echo "old=$OLD_PID new=$NEW_PID" # expected: DIFFERENT pids
```

**Expected:** 9a exits nonzero; 9b's step 7 names the action taken (A2's
output-honesty line, e.g. `restarted (config re-applied)`), the gate passes,
and 9c shows a **different pid** — the re-run actually restarted the daemon
so the fixed config took effect, with no manual `launchctl` surgery.

## 10. Results table

Copy into your sign-off comment on the rehearsal issue/PR. Placeholders only.

| # | Step | Expected | Observed | Pass? | Notes |
|---|------|----------|----------|-------|-------|
| 1 | Prereqs | 4 version prints, exit 0 | | | bun/claude/nats/git versions: |
| 2 | arc install (QUICKSTART) | `arc --version` exit 0 | | | arc version: |
| 3 | `arc install cortex` | capability display + 5-bundle cascade + postinstall | | | mode used (git/registry): |
| 4 | Verify | 6 names in `arc list --json`; symlinks resolve; CLI-OK | | | |
| 5 | Env contract | file written, chmod 600, placeholders replaced | | | |
| 6 | First quickstart | steps 1-6 ✓, step 7 skip, step 8 fails (expected) | | | |
| 7 | launchd load | plist rendered; `state = running` | | | |
| 8 | A1 gate pass | step 8 ✓ + `complete ✓`, exit 0 | | | skip if pre-#2282 |
| 9 | A2 recovery | break→fail, fix→pass, pid changed | | | skip if pre-#2283 |

## 11. Cleanup (leave the account as you found it)

```sh
launchctl bootout "gui/$(id -u)/ai.meta-factory.cortex.$CTX_SLUG" 2>/dev/null
arc remove cortex -y        # preremove unloads services + removes symlinks
rm -f "$HOME/cortex.env"    # contains real tokens — do not leave behind
```

**Expected:** `arc list` no longer shows cortex or the bundles;
`~/.local/bin/cortex` is gone; no `ai.meta-factory.cortex.*` in
`launchctl list`.
