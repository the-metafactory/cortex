#!/bin/bash
set -e

# Cortex preupgrade — stop daemons before symlinks change.
# Mirrors grove-v2's preupgrade.sh under cortex names.
#
# cortex#700: records the set of stacks that were running to a temp state
# file so postupgrade.sh can restore exactly that set (no stack left down;
# none started that wasn't running before the upgrade).

echo "Stopping Cortex services for upgrade (${PAI_OLD_VERSION:-?} → ${PAI_NEW_VERSION:-?})..."

if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="${HOME}/Library/LaunchAgents"
  CONFIG_DIR="${HOME}/.config/cortex"
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

  # Kill running cortex agent processes before upgrading symlinks.
  # Holly cortex#52 round 1 nit-3: previous `pgrep -f "cortex start"` matched
  # any commandline containing that substring (`grep cortex start`, vim
  # buffers, other users' editors on shared hosts). Constrain to the
  # `~/bin/cortex` symlink path so only the actual daemon is matched.
  CORTEX_PIDS=$(pgrep -f "${HOME}/bin/cortex start" 2>/dev/null || true)
  if [ -n "${CORTEX_PIDS}" ]; then
    echo "  Killing existing cortex processes: ${CORTEX_PIDS}"
    kill ${CORTEX_PIDS} 2>/dev/null || true
    sleep 1
    kill -9 ${CORTEX_PIDS} 2>/dev/null || true
    echo "  ✓ Old cortex agent processes terminated"
  fi

  # Kill running cortex-relay processes — anchor to ~/bin path for the same
  # specificity reason. Also catches the legacy grove-relay binary path
  # (`~/bin/grove-relay`) during the cutover window.
  RELAY_PIDS=$(pgrep -f "${HOME}/bin/(cortex-relay|grove-relay)" 2>/dev/null || true)
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
  # (operator pre-flight should have run `arc uninstall Grove` already; this
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

  # cortex#700: source slug-discovery helpers from plist-render.sh.
  # Only the discovery functions are used here — no plist is rendered.
  source "${SCRIPT_DIR}/lib/plist-render.sh"

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
      launchctl unload "${plist}" 2>/dev/null || true
      printf '%s\n' "${slug}" >> "${RUNNING_STACKS_FILE}"
      echo "  ✓ ${slug} daemon stopped (recorded for restart)"
    else
      echo "  ⊘ ${slug} daemon not running — will not be restarted by postupgrade"
    fi
  done < <(discover_stack_slugs "${CONFIG_DIR}")

  echo "  ✓ Running stacks recorded → ${RUNNING_STACKS_FILE}"
fi

echo "  ✓ Services stopped — safe to upgrade"
