#!/bin/bash
set -e

# Cortex postupgrade — runs after every `arc upgrade cortex` once symlinks
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
# plist-render.sh provides resolve_config_dir plus the render/reload/slug/
# forward-symlink helpers used below. Sourced up-front so CONFIG_DIR can resolve
# canonical-first (it is all function definitions — no source-time side effects).
# shellcheck source=scripts/lib/plist-render.sh
source "${SCRIPT_DIR}/lib/plist-render.sh"
# XDG wave-4 (cortex#1869): resolve the ACTIVE config dir (canonical
# ~/.config/metafactory/cortex once migrated, the legacy trees during transition,
# or $CORTEX_CONFIG_DIR) instead of hardcoding the pre-move `~/.config/cortex` —
# so the plists re-rendered below stamp the MOVED --config and daemons never
# boot a stale tree (split-brain traps T7′/T13/T17).
CONFIG_DIR="$(resolve_config_dir)"

mkdir -p "${HOME}/.local/bin" "${CLAUDE_DIR}/relay" \
         "${CLAUDE_DIR}/skills" "${CONFIG_DIR}/logs"

echo "Upgrading Cortex (${PAI_OLD_VERSION:-?} → ${PAI_NEW_VERSION:-?})..."

# ─── 1. Belt-and-braces symlink refresh ───────────────────────────
# arc's provides.files already handled the primary symlinks; this is the
# nested-target one (relay dir) where arc's behaviour around directory
# targets has varied historically.
# cortex#1676: the vestigial `hooks/lib/` link that used to be refreshed
# here was removed — nothing resolved through it (hook imports are relative
# to their own file and resolve via realpath; see arc-manifest.yaml).
echo "  Refreshing nested-target symlinks..."
ln -sf "${CORTEX_DIR}/src/taps/cc-events"          "${CLAUDE_DIR}/relay/cortex"
# The ~/.claude/skills/Discord symlink is no longer cortex's to manage: the
# Discord CLI + skill were extracted to the metafactory-bundle-discord arc bundle
# (ADR-0017, epic #1171). That bundle now installs ~/bin/discord and the
# Discord skill; cortex declares it as a dependency in arc-manifest.yaml.
echo "  ✓ Nested symlinks refreshed"

# ─── 1b. Forward-symlink bridge for the bin cutover (cortex#1866 T13) ──────
# arc's provides.files now installs cortex/cortex-relay/cldyo-live at
# ~/.local/bin (was ~/bin). Any plist not yet re-rendered below still execs
# ~/bin/<name>, so we leave ~/bin/<name> as a forward-symlink → ~/.local/bin so
# it keeps resolving through any interrupt in the render+reload window. We NEVER
# delete ~/bin/<name> here — deletion is wave 6 (#1904). Host-independent (both
# launchd and systemd exec ~/.local/bin now); the helper comes from the shared
# plist-render lib, already sourced up-front (for resolve_config_dir).
echo "  Bridging legacy ~/bin entries → ~/.local/bin (forward-symlinks)..."
for bin_name in cortex cortex-relay cldyo-live; do
  forward_link_legacy_bin "${bin_name}"
done

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
# us that path — the file where agents[].id and stack.id live.
echo "  Provisioning stack signing identity..."
source "${SCRIPT_DIR}/lib/stack-identity-provision.sh"
# plist-render.sh already sourced up-front (for resolve_config_dir).

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
  # cortex#1866: reload via bootout+bootstrap (reload_plist), NOT `launchctl
  # load`. The plists were just re-rendered to exec ~/.local/bin/<name> instead
  # of ~/bin/<name>; `load` can silently no-op on an already-registered label
  # and leave the OLD exec path live. bootout+bootstrap forces launchd to re-read
  # from disk so the daemon comes back on the new binary path.

  reload_plist "${LAUNCH_DIR}/ai.meta-factory.cortex.relay.plist"
  echo "  ✓ Relay daemon reloaded"

  # Read the running-stacks state file written by preupgrade.sh.
  RUNNING_STACKS_FILE="${TMPDIR:-/tmp}/cortex-upgrade-running-stacks"
  # cortex#1866 skip-restart: reload_stack_unless_skipped honors the
  # CORTEX_UPGRADE_SKIP_RESTART list — a skip-listed slug's plist was already
  # re-rendered above (via render_cortex_plists), but it is NOT bootout/
  # bootstrapped here, so it keeps running on its live process and migrates to
  # ~/.local/bin on its next bootout+bootstrap (reboot / logout / manual reload),
  # NOT on a KeepAlive relaunch (which keeps the old in-memory exec path). All
  # other recorded-running stacks (and the relay, above) reload normally.
  if [ -f "${RUNNING_STACKS_FILE}" ]; then
    while IFS= read -r slug; do
      [ -z "${slug}" ] && continue
      reload_stack_unless_skipped "${LAUNCH_DIR}" "${slug}"
    done < "${RUNNING_STACKS_FILE}"
    rm -f "${RUNNING_STACKS_FILE}"
  else
    # No state file — preupgrade.sh may not have run (e.g. manual upgrade or
    # first install via arc). Fall back to starting all discovered stacks so
    # the principal doesn't end up with a silent no-daemon state. The skip list
    # is still honored here.
    echo "  ⚠ No preupgrade state file found — starting all discovered stacks" >&2
    while IFS= read -r slug; do
      reload_stack_unless_skipped "${LAUNCH_DIR}" "${slug}"
    done < <(discover_stack_slugs "${CONFIG_DIR}")
  fi
fi

echo "  ✓ Cortex upgrade complete"
