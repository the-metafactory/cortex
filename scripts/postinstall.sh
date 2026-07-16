#!/bin/bash
set -e

# Cortex postinstall — first-time install setup.
# Runs once when `arc install cortex` succeeds for the first time on a host.
# Symlinks are created by arc via provides.files BEFORE this script runs.
#
# This script handles:
#   1. Runtime directory creation
#   2. Executable bits on bot/relay binaries
#   3. Relay policy template (conditional copy — never clobbers)
#   4. Launchd plist rendering (via scripts/lib/plist-render.sh)
#
# It does NOT clobber an existing ~/.config/cortex/cortex.yaml. Operators
# migrating from grove run `cortex migrate-config ~/.config/grove/bot.yaml`
# (MIG-7.2e / MIG-7.9) themselves; this script intentionally stays out of
# their way so a re-install can't blow away a working config.

CORTEX_DIR="${PAI_INSTALL_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
EVENTS_DIR="${CLAUDE_DIR}/events"
# plist-render.sh provides resolve_config_dir + the render/slug helpers used in
# §4. Sourced up-front so CONFIG_DIR resolves canonical-first (all function
# definitions — no source-time side effects).
# shellcheck source=scripts/lib/plist-render.sh
source "${SCRIPT_DIR}/lib/plist-render.sh"
# systemd-render.sh (cortex#2071) provides the Linux twin of §4's plist
# rendering. Also all function definitions — no source-time side effects.
# shellcheck source=scripts/lib/systemd-render.sh
source "${SCRIPT_DIR}/lib/systemd-render.sh"
# XDG wave-4 (cortex#1869): resolve the active config dir (canonical
# ~/.config/metafactory/cortex once migrated, legacy trees during transition, or
# $CORTEX_CONFIG_DIR). On a fresh install none exist yet → resolves to the
# canonical path, so a first install writes/renders canonical-side directly.
CONFIG_DIR="$(resolve_config_dir)"

echo "Running Cortex postinstall..."

# ─── 1. Runtime directories ──────────────────────────────────────
# NOTE: daemon logs + pidfiles/state are STATE-class and NO LONGER scaffolded
# under the CONFIG root — the config root holds config only. The canonical XDG
# state tree (~/.local/state/metafactory/cortex/) is established in §1b below.
mkdir -p "${EVENTS_DIR}/raw" "${EVENTS_DIR}/published" \
         "${CLAUDE_DIR}/logs" "${CLAUDE_DIR}/relay" \
         "${HOME}/.local/bin"
chmod 700 "${EVENTS_DIR}/raw"
chmod 755 "${EVENTS_DIR}/published"
echo "  ✓ Runtime directories created (~/.claude/events — hook event buffer; ~/.claude/{logs,relay}; ~/.local/bin)"

# ─── 1b. Fresh-install canonical state bootstrap (cortex#2030) ────
# On a GENUINELY FRESH box (no legacy grove/cortex state tree, no relay pidfile,
# no prior completion marker), establish the canonical XDG state tree
# ~/.local/state/metafactory/cortex/ (+ logs/) and write the state-migration
# completion marker, so the completion-gated resolvers (src/common/state-path.ts)
# resolve canonical everywhere — a fresh install is then fully XDG (epic #1867
# DoD). On an UPGRADE box (legacy state present) this writes NOTHING; the gated
# migration (cortex#1903) owns that cutover. The TS driver carries BOTH the
# fresh-vs-upgrade decision AND the marker writer (never hand-rolled in bash).
# Best-effort + non-fatal: a driver/bun hiccup must not abort the whole install
# (the state tree is otherwise created on first daemon boot).
if command -v "${BUN_BIN:-bun}" >/dev/null 2>&1; then
  "${BUN_BIN:-bun}" "${SCRIPT_DIR}/migrate-state-dir-exec.ts" || \
    echo "  ⚠ state bootstrap skipped (driver error) — canonical state is created on first daemon boot"
else
  echo "  ⚠ bun not found — skipped state bootstrap; canonical state tree is created on first daemon boot"
fi

# ─── 2. Executable permissions ──────────────────────────────────
# Idempotent: skip chmod when the file is already executable. Both entry
# points are tracked as mode 100755 in git (cortex#101), so on a normal
# `git clone`/`git pull` host this loop is a no-op and the pkg dir stays
# clean — which means the next `arc upgrade cortex` can `git pull` without
# "local changes would be overwritten" aborting the upgrade.
# Belt-and-braces: on hosts where the executable bit somehow doesn't survive
# (alternate filesystem, copy-not-clone, archived tarball install), the
# chmod still fires.
for f in "${CORTEX_DIR}/src/cortex.ts" "${CORTEX_DIR}/src/taps/cc-events/relay.ts"; do
  if [ ! -x "$f" ]; then
    chmod +x "$f"
  fi
done
echo "  ✓ Executables marked (src/cortex.ts, src/taps/cc-events/relay.ts — made executable for direct invocation)"

# ─── 3. Relay policy (conditional copy — never overwrites) ──────
if [ ! -f "${CLAUDE_DIR}/relay/relay-policy.yaml" ]; then
  if [ -f "${CORTEX_DIR}/src/taps/cc-events/relay-policy.yaml" ]; then
    cp "${CORTEX_DIR}/src/taps/cc-events/relay-policy.yaml" \
       "${CLAUDE_DIR}/relay/relay-policy.yaml"
    echo "  ✓ Default relay policy created (~/.claude/relay/relay-policy.yaml — controls which session events the relay forwards)"
  fi
else
  echo "  ⊘ Relay policy exists (~/.claude/relay/relay-policy.yaml — not overwriting)"
fi

# ─── 4. Service-unit rendering (launchd on macOS, systemd on Linux) ─
# Holly cortex#52 round 1 major: the sed-templating block + awk agent-name
# extractor lived here AND in postupgrade.sh. Extracted to a shared lib
# (already sourced up-front, for resolve_config_dir).
# Audit stack-identity drift (cortex#810) — warn (non-fatal, host-independent)
# when a stack's locator slug ≠ its stack.id slug. Before the Darwin guard so
# Linux/systemd installs see it too.
warn_stack_identity_drift "${CONFIG_DIR}"
if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="${HOME}/Library/LaunchAgents"
  render_cortex_plists "${CORTEX_DIR}" "${LAUNCH_DIR}" "${CONFIG_DIR}"
elif [ "$(uname)" = "Linux" ]; then
  # cortex#2071: render the systemd user units (nats@.service, cortex@.service —
  # community-validated on Debian 13, README-AGENTS.md Appendix A). No-ops
  # silently on a systemd-less host (see systemd_host_detected in the lib).
  UNIT_DIR="${HOME}/.config/systemd/user"
  render_cortex_systemd_units "${CORTEX_DIR}" "${UNIT_DIR}" "${CONFIG_DIR}"
fi

echo ""
echo "✓ Cortex postinstall complete"
echo ""
echo "  What was installed into ~/.claude:"
echo "    • hooks/CortexSkillGuard.hook.ts — installed but NOT registered globally by"
echo "      design; used per-session by bot sessions carrying skill grants (cortex#710)"
echo "    • statusline-command.sh, cortex-status.sh — status line renderer + data source;"
echo "      wiring is optional/manual — add to ~/.claude/settings.json:"
echo "      \"statusLine\": {\"type\": \"command\", \"command\": \"~/.claude/statusline-command.sh\"}"
echo "    • relay/cortex/, relay/relay-policy.yaml — relay tap source + forwarding policy"
echo "    • Events buffer locally to ~/.claude/events; run the relay to forward them"
echo "      (optional)"
echo ""
echo "  Note: Claude Code hooks are auto-registered into ~/.claude/settings.json"
echo "  by arc from this manifest's provides.hooks. The reference JSON at"
echo "  ${CORTEX_DIR}/src/settings/cortex-hooks.json is documentation only —"
echo "  do NOT manually copy it into settings.json (would double-fire hooks)."
echo ""
echo "  Next: getting started → https://github.com/the-metafactory/cortex/blob/main/docs/getting-started.md"
echo "    Fresh install (no cortex config yet)? Start with 'cortex stack create'."
echo "    Migrating from grove? See the doc's 'Migrating from grove' section instead."
