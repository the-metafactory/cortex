#!/bin/bash
# Cortex plist rendering helpers — sourced by postinstall.sh and postupgrade.sh.
#
# Both lifecycle scripts need to render the same two launchd plists from the
# in-repo `__CORTEX_DIR__` / `__BUN_PATH__` / `__HOME__` / `__AGENT_NAME__`
# templates. Holly cortex#52 round 1 major: the sed block + awk extractor
# were duplicated near-verbatim in two places, so an edit to one and not the
# other would silently diverge install-vs-upgrade behaviour. Consolidated
# here so the divergence class of bug can't happen.
#
# Usage (in the calling script):
#   source "${SCRIPT_DIR}/lib/plist-render.sh"
#   render_cortex_plists "${CORTEX_DIR}" "${LAUNCH_DIR}" "${CONFIG_DIR}"
#
# Exit codes:
#   0 — plists rendered (or non-Darwin host, skip silently from caller)
#   1 — bun not found in PATH (sed substitution would produce a broken plist)
#
# Functions never write outside `${LAUNCH_DIR}`.

# Resolve bun once with a clear error when missing. Holly cortex#52 round 1
# nit-2: unguarded `$(which bun)` would silently emit an empty <string></string>
# into the relay plist's ProgramArguments and crash-loop launchd with no
# useful error. Surface the failure here instead.
resolve_bun_path() {
  local bun_path
  bun_path="$(command -v bun 2>/dev/null || true)"
  if [ -z "${bun_path}" ]; then
    echo "  ⚠ bun not found in PATH — cannot render launchd plists" >&2
    echo "    Install bun (https://bun.sh) and re-run \`arc upgrade Cortex\`." >&2
    return 1
  fi
  printf '%s' "${bun_path}"
}

# Extract the first agent id from a cortex.yaml file. Falls back to "cortex"
# when the file is missing or the awk parse fails. Stays awk-only to avoid
# dragging in a yaml lib at install time.
#
# Output is validated against `^[a-zA-Z0-9_-]+$` — the same regex shape the
# cortex-config schema enforces on `agents[].id`. A name containing the sed
# delimiter `|`, the XML special chars `<` / `&`, or whitespace would
# silently emit a malformed plist when interpolated into the
# `<string>__AGENT_NAME__</string>` slot. Bailing here surfaces the bad
# config at install time with a pointed error message instead of letting
# launchd crash-loop a half-rendered plist (Holly cortex#52 round 3
# security warning).
extract_agent_name() {
  local cortex_yaml="$1"
  local name="cortex"
  if [ -f "${cortex_yaml}" ]; then
    name=$(awk '/^agents:/{found=1; next} found && /^[ \-]*id:/{sub(/.*id:[ ]*/, ""); gsub(/["'\'']/, ""); gsub(/#.*/, ""); print; exit}' "${cortex_yaml}" | xargs || true)
    name="${name:-cortex}"
  fi
  if ! [[ "${name}" =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo "  ⚠ refusing to render plist: agent id \"${name}\" contains characters outside [a-zA-Z0-9_-]" >&2
    echo "    Fix the first \`agents[].id\` in ${cortex_yaml} (cortex-config schema requires lowercase alphanumeric + hyphen)." >&2
    return 1
  fi
  printf '%s' "${name}"
}

# Render both plists into ${LAUNCH_DIR}. Idempotent — overwrites any
# previous render of the same filename.
#
# Args:
#   $1 CORTEX_DIR  — repo root (provides plist templates under src/services/)
#   $2 LAUNCH_DIR  — target dir (typically ${HOME}/Library/LaunchAgents)
#   $3 CONFIG_DIR  — cortex config dir (provides cortex.yaml for agent name)
render_cortex_plists() {
  local cortex_dir="$1"
  local launch_dir="$2"
  local config_dir="$3"

  if [ "$(uname)" != "Darwin" ]; then
    return 0
  fi

  local bun_path
  bun_path="$(resolve_bun_path)" || return 1
  mkdir -p "${launch_dir}"

  # Relay plist
  local relay_src="${cortex_dir}/src/services/ai.meta-factory.cortex.relay.plist"
  local relay_dst="${launch_dir}/ai.meta-factory.cortex.relay.plist"
  if [ -f "${relay_src}" ]; then
    sed -e "s|__CORTEX_DIR__|${cortex_dir}|g" \
        -e "s|__BUN_PATH__|${bun_path}|g" \
        -e "s|__HOME__|${HOME}|g" \
        "${relay_src}" > "${relay_dst}"
    echo "  ✓ Relay plist rendered → ${relay_dst}"
  fi

  # Bot plist
  local bot_src="${cortex_dir}/src/services/ai.meta-factory.cortex.bot.plist"
  local bot_dst="${launch_dir}/ai.meta-factory.cortex.bot.plist"
  local agent_name
  agent_name="$(extract_agent_name "${config_dir}/cortex.yaml")" || return 1
  if [ -f "${bot_src}" ]; then
    sed -e "s|__CORTEX_DIR__|${cortex_dir}|g" \
        -e "s|__BUN_PATH__|${bun_path}|g" \
        -e "s|__HOME__|${HOME}|g" \
        -e "s|__AGENT_NAME__|${agent_name}|g" \
        "${bot_src}" > "${bot_dst}"
    echo "  ✓ Bot plist rendered → ${bot_dst} (agent=${agent_name})"
  fi
}
