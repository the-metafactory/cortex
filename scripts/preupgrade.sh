#!/bin/bash
set -e

# Cortex preupgrade — stop daemons before symlinks change.
# Mirrors grove-v2's preupgrade.sh under cortex names.
#
# cortex#700: records the set of stacks that were running to a temp state
# file so postupgrade.sh can restore exactly that set (no stack left down;
# none started that wasn't running before the upgrade).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# cortex#700 / cortex#1866: source the shared lib for slug discovery, the
# skip-restart PID filter, AND the arc-version guard. Sourced up-front (before
# ANY daemon is stopped) so the guard below can abort as a safe no-op.
source "${SCRIPT_DIR}/lib/plist-render.sh"

# ── Arc-version guard (cortex#1866 / arc#295) — MUST run before any stop/kill/
# unload. The bin cutover moves cortex/cortex-relay/cldyo-live to ~/.local/bin,
# where regular files (~/.local/bin/{cldyo-live,lucid}) already live. arc#295's
# no-throw createSymlink backs those up to a .pre-arc sidecar; an OLDER arc's
# createSymlink THROWS on them → provides.files aborts the upgrade AFTER this
# script has already stopped the fleet → box left DOWN. Refusing up-front makes
# an old-arc upgrade a safe no-op abort instead of a fleet-down.
require_min_arc_version 0.38.0 || exit 1

echo "Stopping Cortex services for upgrade (${PAI_OLD_VERSION:-?} → ${PAI_NEW_VERSION:-?})..."

# NOTE (cortex#1909): the entire stop/kill block below — including the
# CORTEX_UPGRADE_SKIP_RESTART skip-restart + its fail-safe abort — is Darwin/
# launchctl only. The principal's production `work` stack is macOS (launchd), so
# this PR covers it. Linux/systemd skip-restart + abort PARITY is NOT built here
# and rides with cortex#1909 — do not assume the skip/abort protects a Linux box.
if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="${HOME}/Library/LaunchAgents"
  CONFIG_DIR="${HOME}/.config/cortex"

  # Kill running cortex agent processes before upgrading symlinks.
  # Holly cortex#52 round 1 nit-3: previous `pgrep -f "cortex start"` matched
  # any commandline containing that substring (`grep cortex start`, vim
  # buffers, other users' editors on shared hosts). Constrain to the
  # `cortex` symlink path so only the actual daemon is matched. cortex#1866:
  # the symlink target moved from `~/bin/cortex` to `~/.local/bin/cortex`;
  # match both so a host mid-upgrade (daemon still running from the old
  # location) is still caught.
  CORTEX_PIDS=$(pgrep -f "${HOME}/(bin|\.local/bin)/cortex start" 2>/dev/null || true)
  # cortex#1866 skip-restart (advw3b 3a): reclassify the kill-list by SLUG —
  # resolved from each live daemon's argv --config — and drop any skip-listed
  # stack's PID so a spared production stack (e.g. `work`) keeps running. Keying
  # by slug (not path substring) matches postupgrade's reload side exactly, so
  # config-path drift can't kill a daemon here that postupgrade then skips.
  # FAIL-SAFE: if a running daemon's slug is unresolvable while a skip-list is
  # set, filter_out_skipped_pids returns non-zero → abort BEFORE any kill rather
  # than risk stopping an unclassifiable stack. (`if !` keeps set -e happy and
  # still captures the survivors on the success path.)
  if ! CORTEX_PIDS=$(filter_out_skipped_pids "${CORTEX_PIDS}" "${CONFIG_DIR}"); then
    exit 1
  fi
  if [ -n "${CORTEX_PIDS}" ]; then
    echo "  Killing existing cortex processes: ${CORTEX_PIDS}"
    kill ${CORTEX_PIDS} 2>/dev/null || true
    sleep 1
    kill -9 ${CORTEX_PIDS} 2>/dev/null || true
    echo "  ✓ Old cortex agent processes terminated"
  fi

  # Kill running cortex-relay processes — anchor to the bin path for the same
  # specificity reason. Also catches the legacy grove-relay binary path
  # (`~/bin/grove-relay`) during the cutover window. cortex#1866: cortex-relay
  # moved from `~/bin` to `~/.local/bin`; match both locations.
  RELAY_PIDS=$(pgrep -f "${HOME}/(bin/(cortex-relay|grove-relay)|\.local/bin/cortex-relay)" 2>/dev/null || true)
  if [ -n "${RELAY_PIDS}" ]; then
    echo "  Killing existing relay processes: ${RELAY_PIDS}"
    kill ${RELAY_PIDS} 2>/dev/null || true
    sleep 1
    kill -9 ${RELAY_PIDS} 2>/dev/null || true
    echo "  ✓ Old relay processes terminated"
  fi

  # Belt: kill any lingering legacy grove-bot processes anchored to the
  # legacy ~/bin/grove-bot path. The launchctl unload further down is the
  # braces; this catches a grove-bot that was started outside launchd or
  # whose plist was hand-removed.
  GROVE_BOT_PIDS=$(pgrep -f "${HOME}/bin/grove-bot" 2>/dev/null || true)
  if [ -n "${GROVE_BOT_PIDS}" ]; then
    echo "  Killing legacy grove-bot processes: ${GROVE_BOT_PIDS}"
    kill ${GROVE_BOT_PIDS} 2>/dev/null || true
    sleep 1
    kill -9 ${GROVE_BOT_PIDS} 2>/dev/null || true
    echo "  ✓ Legacy grove-bot processes terminated"
  fi

  # Clean up legacy grove-bot symlink if it's still owned by a stale install
  # (principal pre-flight should have run `arc uninstall Grove` already; this
  # is a belt-and-braces clean-up so the deprecation shim install step has a
  # clean slate to work with).
  if [ -L "${HOME}/bin/grove-bot" ]; then
    LEGACY_TARGET=$(readlink "${HOME}/bin/grove-bot" || true)
    if [ -n "${LEGACY_TARGET}" ] && [[ "${LEGACY_TARGET}" != *"cortex"* ]]; then
      rm -f "${HOME}/bin/grove-bot"
      echo "  ✓ Removed stale legacy ~/bin/grove-bot symlink (→ ${LEGACY_TARGET})"
    fi
  fi

  # MIG-7.8 + cortex#251 — legacy launchd plist cutover.
  #
  # - `com.grove.bot` / `com.grove.relay`: grove-v2 era plists that may
  #   linger if grove's uninstall lifecycle didn't run.
  # - `ai.meta-factory.cortex.bot`: pre-cortex#251 name for the
  #   metafactory dev stack plist (renamed to `.meta-factory` to make
  #   the identity legible alongside the `andreas/work` sibling). First
  #   `arc upgrade cortex` after merge unloads + removes the stale
  #   `.bot` plist so the renamed one owns launchd cleanly.
  #
  # Idempotent: short-circuits when the legacy plist is absent.
  for legacy_label in com.grove.bot com.grove.relay ai.meta-factory.cortex.bot; do
    legacy_plist="${LAUNCH_DIR}/${legacy_label}.plist"
    if [ ! -e "${legacy_plist}" ]; then
      continue
    fi
    # Anchor to label name to avoid partial matches (e.g. `com.grove.bot`
    # vs a hypothetical `com.grove.bot.dev`). launchctl list column 3 is
    # the registered label.
    if launchctl list 2>/dev/null | awk '{print $3}' | grep -qx "${legacy_label}"; then
      launchctl unload "${legacy_plist}" 2>/dev/null || true
      echo "  ✓ Legacy ${legacy_label} daemon stopped"
    fi
    rm -f "${legacy_plist}"
    echo "  ✓ Removed legacy ${legacy_plist}"
  done

  # cortex#700: slug-discovery + skip-restart helpers come from plist-render.sh,
  # already sourced at the top of this script (before the arc-version guard).

  # Write running-stacks state to a well-known temp path so postupgrade.sh
  # can restore exactly the stacks that were running before the upgrade.
  # Symmetry guarantee: no stack left down; none started that wasn't running.
  # One slug per line (e.g. "meta-factory", "work", "halden").
  RUNNING_STACKS_FILE="${TMPDIR:-/tmp}/cortex-upgrade-running-stacks"
  : > "${RUNNING_STACKS_FILE}"

  # Relay — handled separately (always stopped/started; not included in the
  # per-stack state file; postupgrade always restarts it unconditionally).
  if launchctl list 2>/dev/null | awk '{print $3}' | grep -qx "ai.meta-factory.cortex.relay"; then
    launchctl unload "${LAUNCH_DIR}/ai.meta-factory.cortex.relay.plist" 2>/dev/null || true
    echo "  ✓ Relay daemon stopped"
  fi

  # cortex#700: enumerate discovered stacks and stop each that is currently
  # registered with launchd. Replace the three hardcoded unload calls (meta-
  # factory / work and the now-removed halden gap) with a single loop driven
  # by discover_stack_slugs. cortex#717: discover_stack_slugs is now config-
  # split-aware (per-stack dirs win over retained root monoliths), so the
  # recorded running-set matches what postupgrade renders + restarts. Any new
  # stack (dir or monolith) is automatically included — no script edit needed.
  while IFS= read -r slug; do
    label="ai.meta-factory.cortex.${slug}"
    plist="${LAUNCH_DIR}/${label}.plist"
    if launchctl list 2>/dev/null | awk '{print $3}' | grep -qx "${label}"; then
      if stack_restart_skipped "${slug}"; then
        # cortex#1866 skip-restart: record it as running (so postupgrade knows
        # it was up) but do NOT unload it — it keeps serving on its live
        # process. postupgrade re-renders its plist but skips the reload; the
        # stack migrates to ~/.local/bin on its next bootout+bootstrap (reboot /
        # logout / manual reload) — NOT on a KeepAlive relaunch, which keeps the
        # old in-memory exec path.
        printf '%s\n' "${slug}" >> "${RUNNING_STACKS_FILE}"
        echo "  ⏸ ${slug} daemon left running (CORTEX_UPGRADE_SKIP_RESTART) — recorded, not stopped"
      else
        launchctl unload "${plist}" 2>/dev/null || true
        printf '%s\n' "${slug}" >> "${RUNNING_STACKS_FILE}"
        echo "  ✓ ${slug} daemon stopped (recorded for restart)"
      fi
    else
      echo "  ⊘ ${slug} daemon not running — will not be restarted by postupgrade"
    fi
  done < <(discover_stack_slugs "${CONFIG_DIR}")

  echo "  ✓ Running stacks recorded → ${RUNNING_STACKS_FILE}"
fi

echo "  ✓ Services stopped — safe to upgrade"
