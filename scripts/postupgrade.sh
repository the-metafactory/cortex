#!/bin/bash
set -e

# Cortex postupgrade — runs after every `arc upgrade Cortex` once symlinks
# have been refreshed. Re-templates plists (via shared lib) and restarts
# daemons.
#
# arc itself handles `provides.files` symlink updates BEFORE this script
# runs, so the `ln -sf` calls below are belt-and-braces for any target arc
# doesn't yet manage (lib subdirs, relay directory).
#
# cortex#700: stacks are now discovered from cortex*.yaml globs. The daemon
# restart loop reads the state file written by preupgrade.sh and restores
# exactly the stacks that were running before the upgrade (symmetry).

CORTEX_DIR="${PAI_INSTALL_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
CONFIG_DIR="${HOME}/.config/cortex"

mkdir -p "${HOME}/bin" "${CLAUDE_DIR}/hooks/lib" "${CLAUDE_DIR}/relay" \
         "${CLAUDE_DIR}/skills" "${CONFIG_DIR}/logs"

echo "Upgrading Cortex (${PAI_OLD_VERSION:-?} → ${PAI_NEW_VERSION:-?})..."

# ─── 1. Belt-and-braces symlink refresh ───────────────────────────
# arc's provides.files already handled the primary symlinks; these are the
# nested-target ones (hook lib + relay dir) where arc's behaviour around
# directory targets has varied historically.
echo "  Refreshing nested-target symlinks..."
ln -sf "${CORTEX_DIR}/src/taps/cc-events/hooks/lib" "${CLAUDE_DIR}/hooks/lib/cortex-events"
ln -sf "${CORTEX_DIR}/src/taps/cc-events"          "${CLAUDE_DIR}/relay/cortex"
ln -sf "${CORTEX_DIR}/src/cli/discord/skill"       "${CLAUDE_DIR}/skills/Discord"
echo "  ✓ Nested symlinks refreshed"

# ─── 2. Auto-provision stack signing identity ─────────────────────
# cortex#324 / v2.0.3: stack signing is ON by default. When a config file
# lacks `stack.nkey_seed_path`, the helper generates an NKey and wires it
# in. Idempotent — skipped when the field is already set.
#
# cortex#700: loop over all discovered stacks rather than hardcoding
# cortex.yaml + cortex.work.yaml. Derive the nkey basename from the slug:
# meta-factory → "cortex", {slug} → "cortex-{slug}".
#
# cortex#717: target the file that actually carries the `stack:` block,
# layout-aware. Under the directory layout that is stacks/<slug>.yaml (the
# sentinel <slug>.yaml is a pointer with no stack block); under the legacy
# monolith it is the monolith itself. resolve_stack_agent_config_path() gives
# us that path — the same file extract_agent_name reads agents[].id from, and
# the file where stack.id lives.
echo "  Provisioning stack signing identity..."
source "${SCRIPT_DIR}/lib/stack-identity-provision.sh"
source "${SCRIPT_DIR}/lib/plist-render.sh"

while IFS= read -r slug; do
  stack_config="$(resolve_stack_agent_config_path "${CONFIG_DIR}" "${slug}")"
  # nkey basename: meta-factory → "cortex", {slug} → "cortex-{slug}".
  if [ "${slug}" = "meta-factory" ]; then
    nkey_basename="cortex"
  else
    nkey_basename="cortex-${slug}"
  fi
  if [ -f "${stack_config}" ]; then
    provision_stack_identity "${stack_config}" "${nkey_basename}" || true
  fi
done < <(discover_stack_slugs "${CONFIG_DIR}")

# ─── 2b. Audit stack-identity drift (cortex#810) ──────────────────
# stack.id is the canonical slug authority; the config dir/file name and the
# daemon label must equal its trailing segment. Warn (non-fatal, host-
# independent) on any drift so a misaligned stack — labelled one identity,
# federating as another — is surfaced every upgrade instead of shipping
# silently. Runs before the Darwin guard so Linux/systemd peers see it too.
warn_stack_identity_drift "${CONFIG_DIR}"

# ─── 3. Re-template launchd plists (shared with postinstall.sh) ──
if [ "$(uname)" = "Darwin" ]; then
  LAUNCH_DIR="${HOME}/Library/LaunchAgents"
  render_cortex_plists "${CORTEX_DIR}" "${LAUNCH_DIR}" "${CONFIG_DIR}"

  # ─── 4. Restart daemons ─────────────────────────────────────────
  # cortex#700: relay is always restarted (it was always unconditional).
  # Stacks are restarted based on the running-set recorded by preupgrade.sh.
  # This gives symmetry: no stack left down; none started that wasn't running.
  #
  # `|| true` keeps a partial upgrade non-fatal — if a daemon was already
  # unloaded by preupgrade.sh, load just re-loads cleanly.

  launchctl load "${LAUNCH_DIR}/ai.meta-factory.cortex.relay.plist" 2>/dev/null || true
  echo "  ✓ Relay daemon started"

  # Read the running-stacks state file written by preupgrade.sh.
  RUNNING_STACKS_FILE="${TMPDIR:-/tmp}/cortex-upgrade-running-stacks"
  if [ -f "${RUNNING_STACKS_FILE}" ]; then
    while IFS= read -r slug; do
      [ -z "${slug}" ] && continue
      plist="${LAUNCH_DIR}/ai.meta-factory.cortex.${slug}.plist"
      if [ -f "${plist}" ]; then
        launchctl load "${plist}" 2>/dev/null || true
        echo "  ✓ ${slug} daemon started"
      else
        echo "  ⚠ ${slug} plist not found after render — skipping restart" >&2
      fi
    done < "${RUNNING_STACKS_FILE}"
    rm -f "${RUNNING_STACKS_FILE}"
  else
    # No state file — preupgrade.sh may not have run (e.g. manual upgrade or
    # first install via arc). Fall back to starting all discovered stacks so
    # the operator doesn't end up with a silent no-daemon state.
    echo "  ⚠ No preupgrade state file found — starting all discovered stacks" >&2
    while IFS= read -r slug; do
      plist="${LAUNCH_DIR}/ai.meta-factory.cortex.${slug}.plist"
      if [ -f "${plist}" ]; then
        launchctl load "${plist}" 2>/dev/null || true
        echo "  ✓ ${slug} daemon started (fallback)"
      fi
    done < <(discover_stack_slugs "${CONFIG_DIR}")
  fi
fi

echo "  ✓ Cortex upgrade complete"
