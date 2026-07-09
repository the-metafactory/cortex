#!/bin/bash
# Cortex plist rendering helpers — sourced by postinstall.sh and postupgrade.sh.
#
# Both lifecycle scripts need to render the same launchd plists from the
# in-repo `__CORTEX_DIR__` / `__BUN_PATH__` / `__HOME__` templates. Holly
# cortex#52 round 1 major: the sed block + awk extractor were duplicated
# near-verbatim in two places, so an edit to one and not the other would
# silently diverge install-vs-upgrade behaviour. Consolidated here so the
# divergence class of bug can't happen.
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
    echo "    Install bun (https://bun.sh) and re-run \`arc upgrade cortex\`." >&2
    return 1
  fi
  printf '%s' "${bun_path}"
}

# Extract the CANONICAL stack slug from a cortex config's `stack.id`.
#
# `stack.id` is `{principal}/{slug}` (e.g. `andreas/community` → `community`).
# Per CONTEXT.md §"Stack slug" + ADR-0004, this slug is the ONE authority: the
# federation subject segment, the launchd/systemd label, the config dir/file
# name, and the join's write path all derive from it. The filename/dirname the
# lifecycle scripts use as a *locator* (config_file_to_slug / the dir basename)
# is COSMETIC and MUST equal it; drift is surfaced by warn_stack_identity_drift.
#
# Stays awk-only (no yaml dep at install time). Scans only inside the
# top-level `stack:` block so the sibling `principal.id`
# and `agents[].id` keys are never mistaken for `stack.id`. Prints the trailing
# segment after the last slash. Returns non-zero (prints nothing) when
# `stack.id` is absent/unparseable — callers fall back to the filename locator.
extract_stack_id_slug() {
  local config_file="$1"
  [ -f "${config_file}" ] || return 1
  local id
  id=$(awk '
    /^stack:[[:space:]]*\r?$/ { instack=1; next }
    instack && /^[^[:space:]#]/ { instack=0 }        # dedent → left the stack: block
    instack && /^[[:space:]]+id:[[:space:]]*/ {
      sub(/.*id:[[:space:]]*/, ""); gsub(/\r/, ""); gsub(/["'\'']/, ""); gsub(/#.*/, ""); print; exit
    }' "${config_file}" | xargs || true)
  # xargs only trims surrounding whitespace here (CR is already stripped in-awk
  # above); a valid slug is [a-zA-Z0-9_-], so there is no quoting/word-split
  # hazard and the value is never eval'd — it is pure data for the comparison.
  [ -n "${id}" ] || return 1
  printf '%s' "${id##*/}"
}

# Derive the stack slug from a cortex config FILENAME (the cosmetic locator).
#
#   cortex.yaml          → meta-factory   (special case — bare name is the default stack)
#   cortex.{slug}.yaml   → {slug}
#
# NOTE: this is a *locator* mapping, NOT the identity authority. The canonical
# slug is `stack.id`'s trailing segment (see extract_stack_id_slug + ADR-0004);
# this filename/dirname convention MUST equal it. We deliberately do NOT
# re-derive the locator from stack.id here: the on-disk files (the sentinel,
# stacks/<slug>.yaml, the dir itself) are keyed on this name, so reconciling a
# drifted stack is an operator rename, not an automatic rewrite (high blast
# radius on a live pipeline — see cortex#810). cortex#700: centralised so
# preupgrade/postupgrade/plist-render all agree on the locator.
config_file_to_slug() {
  local filename
  filename="$(basename "$1")"
  case "${filename}" in
    cortex.yaml)
      printf '%s' "meta-factory"
      ;;
    cortex.*.yaml)
      # Strip leading "cortex." and trailing ".yaml"
      local slug="${filename#cortex.}"
      slug="${slug%.yaml}"
      printf '%s' "${slug}"
      ;;
    *)
      # Unrecognised filename — caller should skip this file.
      return 1
      ;;
  esac
}

# Inverse of config_file_to_slug: derive the config filename from a slug.
#
#   meta-factory → cortex.yaml   (special case)
#   {slug}       → cortex.{slug}.yaml
#
# Used by render_stack_plist and postupgrade.sh to map slugs back to config
# paths without repeating the branch logic in multiple callers.
slug_to_config_file() {
  local slug="$1"
  if [ "${slug}" = "meta-factory" ]; then
    printf '%s' "cortex.yaml"
  else
    printf '%s' "cortex.${slug}.yaml"
  fi
}

# Resolve the `--config` path a stack's plist should point at, layout-aware
# (cortex#717 / migration 0003).
#
# Two layouts coexist during the config-split transition:
#   - Directory layout: <config_dir>/<slug>/system/system.yaml exists. The
#     plist must point at the per-stack SENTINEL <config_dir>/<slug>/<slug>.yaml
#     (the loader resolves configDir = dirname(<sentinel>) and composes the
#     dir). This preserves the unique cortex-<slug>.pid naming — the
#     PID-collision lesson from migration 0003.
#   - Legacy monolith: no per-stack dir. The plist points at the root monolith
#     <config_dir>/cortex[.<slug>].yaml.
#
# Prints the absolute config path. Directory layout takes precedence.
#
# Args:
#   $1 CONFIG_DIR — cortex config dir
#   $2 SLUG       — stack slug
resolve_stack_config_path() {
  local config_dir="$1"
  local slug="$2"
  if [ -f "${config_dir}/${slug}/system/system.yaml" ]; then
    # Directory layout — point at the per-stack sentinel.
    printf '%s' "${config_dir}/${slug}/${slug}.yaml"
  else
    # Legacy monolith.
    printf '%s' "${config_dir}/$(slug_to_config_file "${slug}")"
  fi
}

# Resolve the config file the agent id should be read FROM, layout-aware.
#
# Under the directory layout the sentinel <slug>/<slug>.yaml is a pointer and
# carries no agents; `agents[].id` lives in <slug>/stacks/<slug>.yaml. Under
# the legacy monolith the agents block is in the monolith itself.
#
# Prints the absolute path of the file to parse for the agent id / stack.id.
# Callers must tolerate a missing file (e.g. extract_stack_id_slug returns
# non-zero and its caller falls back to the filename locator).
#
# Args:
#   $1 CONFIG_DIR — cortex config dir
#   $2 SLUG       — stack slug
resolve_stack_agent_config_path() {
  local config_dir="$1"
  local slug="$2"
  if [ -f "${config_dir}/${slug}/system/system.yaml" ]; then
    # Directory layout — agents[].id lives in stacks/<slug>.yaml.
    printf '%s' "${config_dir}/${slug}/stacks/${slug}.yaml"
  else
    # Legacy monolith.
    printf '%s' "${config_dir}/$(slug_to_config_file "${slug}")"
  fi
}

# Discover all stack slugs under CONFIG_DIR. Prints one slug per line, sorted,
# deduplicated. Never includes the relay daemon.
#
# cortex#717 / migration 0003 — two layouts coexist during the config-split
# transition, and a stack may appear in BOTH (the split retains the root
# monolith as a rollback anchor):
#
#   1. Directory layout: a subdir <config_dir>/<slug>/ containing
#      system/system.yaml (the directory-layout marker). slug = dir basename.
#   2. Legacy monolith: a root <config_dir>/cortex[.<slug>].yaml file.
#
# Precedence: the DIRECTORY LAYOUT WINS. If <config_dir>/<slug>/ exists for a
# slug, the retained root monolith for that same slug is ignored (not double-
# discovered) so `arc upgrade` doesn't re-point a split stack at its monolith.
#
# Args:
#   $1 CONFIG_DIR — cortex config dir
discover_stack_slugs() {
  local config_dir="$1"

  # Pass 1: per-stack directories (the split layout). These take precedence.
  # Marker: <config_dir>/<slug>/system/system.yaml. slug = the dir basename
  # (parent of system/). find + sort gives deterministic ordering (glob order
  # is filesystem-dependent on some macOS versions).
  local dir_slugs=""
  local marker slug
  while IFS= read -r marker; do
    [ -z "${marker}" ] && continue
    slug="$(basename "$(dirname "$(dirname "${marker}")")")"
    dir_slugs="${dir_slugs}${slug}"$'\n'
    printf '%s\n' "${slug}"
  done < <(find "${config_dir}" -mindepth 3 -maxdepth 3 -path '*/system/system.yaml' 2>/dev/null | sort)

  # Pass 2: legacy root monoliths. Emit a monolith's slug ONLY when no per-stack
  # dir already claimed it (dir wins → dedupe).
  local cfg
  while IFS= read -r cfg; do
    [ -z "${cfg}" ] && continue
    if slug="$(config_file_to_slug "${cfg}")"; then
      # Skip if a per-stack dir already emitted this slug. -F: treat the slug
      # as a fixed string (a slug is [a-zA-Z0-9_-] so this is belt-and-braces
      # against any regex metachar leaking through).
      if printf '%s' "${dir_slugs}" | grep -qxF "${slug}"; then
        continue
      fi
      printf '%s\n' "${slug}"
    fi
  done < <(find "${config_dir}" -maxdepth 1 -name 'cortex*.yaml' 2>/dev/null | sort)
}

# Audit every discovered stack for slug↔stack.id drift and warn (cortex#810).
#
# `stack.id` ({principal}/{slug}) is the canonical identity (CONTEXT.md
# §"Stack slug" + ADR-0004). The filesystem LOCATOR — the dir basename, or the
# cortex.<slug>.yaml filename — and the rendered launchd/systemd label MUST
# equal its trailing segment. When they drift, the daemon federates as one
# identity but is labelled another (JC's case: dir/plist say `meta-factory`,
# stack.id says `jc/default`), so the network roster, the `--config` locator,
# and the process label disagree. Nothing flagged this before — this is the
# arc-upgrade-time analog of the code-review ArchitectureDocs lens.
#
# WARN, do not fail: a hard error would brick `arc upgrade` for a drifted stack
# (high blast radius on a live review pipeline — #810). The fix is a one-time
# operator rename of the dir/file to match stack.id; we surface it loudly every
# upgrade until reconciled. Emitted to STDERR so it never pollutes the slug list
# that discover_stack_slugs streams on stdout to its callers.
#
# Host-independent (no Darwin guard) so a Linux/systemd peer (e.g. clawbox)
# sees it too. Call ONCE per lifecycle run, not from the hot discover_ helper.
#
# Args:
#   $1 CONFIG_DIR — cortex config dir
warn_stack_identity_drift() {
  local config_dir="$1"
  local slug stack_cfg id_slug
  while IFS= read -r slug; do
    [ -z "${slug}" ] && continue
    stack_cfg="$(resolve_stack_agent_config_path "${config_dir}" "${slug}")"
    # stack.id absent/unparseable → nothing to compare against, skip silently
    # (the filename locator stands as the fallback identity).
    id_slug="$(extract_stack_id_slug "${stack_cfg}")" || continue
    # Slug-scoped by design: we compare only stack.id's trailing segment to the
    # locator slug, because the launchd/systemd label is ai.meta-factory.cortex
    # .{slug} (no principal). The principal half of stack.id is validated on the
    # wire (the DID + subject), not here — this is the label/locator check.
    if [ "${id_slug}" != "${slug}" ]; then
      echo "  ⚠ stack-identity drift: locator slug '${slug}' (label ai.meta-factory.cortex.${slug}) ≠ stack.id slug '${id_slug}' (federation identity '…/${id_slug}')." >&2
      echo "    The daemon federates as '…/${id_slug}' but is labelled '${slug}'. Reconcile onto stack.id — rename the config dir/file to '${id_slug}' (calm-day cleanup; see cortex#810 / docs/adr/0004-stack-slug-authority.md)." >&2
    fi
  done < <(discover_stack_slugs "${config_dir}")
}

# Render the plist for a single stack slug into LAUNCH_DIR. Idempotent —
# overwrites any previous render of the same filename.
#
# Slug-to-template mapping: every slug (including meta-factory and work) is
# rendered from the single generic template:
#   src/services/ai.meta-factory.cortex.stack.plist
#   (uses __STACK_SLUG__ + __CONFIG_PATH__)
#
# cortex#1848: this used to special-case `meta-factory` and `work` onto two
# committed plists that hardcoded a real personal deployment's identity
# (CORTEX_AGENT_NAME/CORTEX_AGENT_ID) into a public repo. Those templates and
# the special-case branches are gone — CORTEX_AGENT_NAME/CORTEX_AGENT_ID are
# vestigial in this unit anyway (src/runner/cc-session.ts derives them from
# config-driven opts, not from the daemon's own env), so there is nothing to
# re-parameterise; every slug just gets the generic template.
#
# The template carries __CONFIG_PATH__ — the layout-aware absolute --config
# path (cortex#717): the per-stack sentinel under the directory layout, or the
# legacy root monolith. This is what stops `arc upgrade` reverting the
# config-split.
#
# For any slug: if the resolved config yaml is absent the plist is removed
# (same stale-plist guard as the original cortex#244 work-stack logic, now
# generalised to all stacks).
#
# Args:
#   $1 CORTEX_DIR — repo root
#   $2 LAUNCH_DIR — target dir (typically ${HOME}/Library/LaunchAgents)
#   $3 CONFIG_DIR — cortex config dir
#   $4 SLUG       — stack slug (e.g. meta-factory, work, halden)
#   $5 BUN_PATH   — pre-resolved bun binary path
render_stack_plist() {
  local cortex_dir="$1"
  local launch_dir="$2"
  local config_dir="$3"
  local slug="$4"
  local bun_path="$5"

  local dst="${launch_dir}/ai.meta-factory.cortex.${slug}.plist"

  # Resolve the layout-aware --config path (cortex#717): per-stack sentinel
  # when the directory layout exists, else the legacy root monolith. This is
  # the path stamped into the plist's --config arg and the path whose
  # existence gates the stale-plist guard below.
  local config_yaml
  config_yaml="$(resolve_stack_config_path "${config_dir}" "${slug}")"

  # If the config no longer exists, remove any stale rendered plist so
  # launchd doesn't crash-loop trying to start a daemon whose --config
  # target is missing. Idempotent: rm -f swallows no-such-file.
  if [ ! -f "${config_yaml}" ]; then
    if [ -f "${dst}" ]; then
      launchctl unload "${dst}" 2>/dev/null || true
      rm -f "${dst}"
      echo "  ⊘ ${slug} plist removed — ${config_yaml} not present (stack un-scaffolded)"
    else
      echo "  ⊘ ${slug} plist skipped — ${config_yaml} not present"
    fi
    return 0
  fi

  # Every slug renders from the generic, parameterised stack template.
  local src="${cortex_dir}/src/services/ai.meta-factory.cortex.stack.plist"
  if [ ! -f "${src}" ]; then
    echo "  ⚠ Template missing: ${src}" >&2
    return 1
  fi
  sed -e "s|__CORTEX_DIR__|${cortex_dir}|g" \
      -e "s|__BUN_PATH__|${bun_path}|g" \
      -e "s|__HOME__|${HOME}|g" \
      -e "s|__STACK_SLUG__|${slug}|g" \
      -e "s|__CONFIG_PATH__|${config_yaml}|g" \
      "${src}" > "${dst}"
  echo "  ✓ ${slug} plist rendered → ${dst} (config=${config_yaml})"
}

# Render plists for relay + all discovered stacks into ${LAUNCH_DIR}.
# Idempotent — overwrites any previous render of the same filename.
#
# cortex#700: stacks are discovered, not a hardcoded list. cortex#717:
# discovery is config-split-aware — per-stack dirs (<slug>/system/system.yaml)
# take precedence over retained root monoliths, and each plist's --config
# points at the per-stack sentinel under the dir layout. Adding a new stack =
# adding its config (dir or monolith); no script edit needed.
#
# Args:
#   $1 CORTEX_DIR  — repo root (provides plist templates under src/services/)
#   $2 LAUNCH_DIR  — target dir (typically ${HOME}/Library/LaunchAgents)
#   $3 CONFIG_DIR  — cortex config dir (per-stack dirs and/or cortex*.yaml)
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

  # Relay plist — always present, separate from the stack loop.
  local relay_src="${cortex_dir}/src/services/ai.meta-factory.cortex.relay.plist"
  local relay_dst="${launch_dir}/ai.meta-factory.cortex.relay.plist"
  if [ -f "${relay_src}" ]; then
    sed -e "s|__CORTEX_DIR__|${cortex_dir}|g" \
        -e "s|__BUN_PATH__|${bun_path}|g" \
        -e "s|__HOME__|${HOME}|g" \
        "${relay_src}" > "${relay_dst}"
    echo "  ✓ Relay plist rendered → ${relay_dst}"
  fi

  # Stack plists — one per discovered stack (cortex#700 + cortex#717).
  # Per-stack dirs (<slug>/system/system.yaml) win over root monoliths.
  local rendered_count=0
  while IFS= read -r slug; do
    render_stack_plist "${cortex_dir}" "${launch_dir}" "${config_dir}" "${slug}" "${bun_path}" || true
    rendered_count=$((rendered_count + 1))
  done < <(discover_stack_slugs "${config_dir}")

  if [ "${rendered_count}" -eq 0 ]; then
    echo "  ⚠ No stacks discovered in ${config_dir} (no per-stack dirs or cortex*.yaml) — no stack plists rendered" >&2
  fi
}
