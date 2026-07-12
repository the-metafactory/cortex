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
# drifted stack is a principal rename, not an automatic rewrite (high blast
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
# principal rename of the dir/file to match stack.id; we surface it loudly every
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
  # G-30 (cortex#1866, XDG wave 3): render atomically. A bare `sed > dst`
  # onto a live LaunchAgents path leaves a truncated/partial plist visible if
  # the render is interrupted — launchd would then load garbage. Render to a
  # same-dir temp and `mv` (atomic rename within one filesystem) so the
  # installed plist only ever transitions whole-old → whole-new.
  sed -e "s|__CORTEX_DIR__|${cortex_dir}|g" \
      -e "s|__BUN_PATH__|${bun_path}|g" \
      -e "s|__HOME__|${HOME}|g" \
      -e "s|__STACK_SLUG__|${slug}|g" \
      -e "s|__CONFIG_PATH__|${config_yaml}|g" \
      "${src}" > "${dst}.tmp"
  mv -f "${dst}.tmp" "${dst}"
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
    # G-30: atomic render (same rationale as render_stack_plist).
    sed -e "s|__CORTEX_DIR__|${cortex_dir}|g" \
        -e "s|__BUN_PATH__|${bun_path}|g" \
        -e "s|__HOME__|${HOME}|g" \
        "${relay_src}" > "${relay_dst}.tmp"
    mv -f "${relay_dst}.tmp" "${relay_dst}"
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

# ── Bin cutover helpers (cortex#1866, XDG wave 3) ────────────────────────────

# Leave a legacy ~/bin/<name> in place as a forward-symlink → ~/.local/bin/<name>.
#
# The bin cutover moved cortex/cortex-relay/cldyo-live from ~/bin to
# ~/.local/bin (arc-manifest provides.files + arc#293 host-adapter defaults).
# Already-installed launchd plists may still exec ~/bin/<name> until they are
# re-rendered + reloaded. To guarantee ~/bin/<name> keeps resolving through ANY
# interrupt in that window, the legacy path is converted to a forward-symlink
# pointing at the new location.
#
# INTERRUPT-WINDOW RULE (cortex#1866 T13, non-negotiable): we NEVER delete
# ~/bin/<name> here — deletion is wave 6 (#1904). Deleting it in the same
# operation that re-renders plists would, on any interrupt (pull conflict,
# missing bun, reboot), leave every plist execing a missing binary under
# KeepAlive:true → throttled respawn forever.
#
# Safety:
#   - Only bridge when the ~/.local/bin target exists — never create a dangling
#     forward-symlink.
#   - An existing symlink at ~/bin/<name> is replaced atomically (`ln -sfn`).
#   - A REAL file/dir at ~/bin/<name> is backed up to <path>.pre-arc rather than
#     clobbered (mirrors arc's occupied-destination preflight, arc#293).
#
# Host-independent: both macOS (launchd) and Linux (systemd) now exec
# ~/.local/bin, so the bridge is created regardless of platform.
#
# Args: $1 binary basename (e.g. cortex, cortex-relay, cldyo-live)
forward_link_legacy_bin() {
  local name="$1"
  local target="${HOME}/.local/bin/${name}"
  local link="${HOME}/bin/${name}"

  # Nothing to point at → do not create a dangling forward-symlink.
  [ -e "${target}" ] || return 0

  mkdir -p "${HOME}/bin"

  if [ -L "${link}" ]; then
    : # existing symlink (possibly stale) — ln -sfn replaces it atomically
  elif [ -e "${link}" ]; then
    # A real regular file / directory occupies the legacy path — preserve it.
    # Never clobber an earlier backup: if `<link>.pre-arc` already holds a prior
    # preserved file, fall back to a timestamped `<link>.pre-arc.<epoch>[.n]`
    # sidecar (mirrors arc createSymlink's resolveBackupPath — data-loss nit).
    local sidecar="${link}.pre-arc"
    if [ -e "${sidecar}" ]; then
      local stamp
      stamp="$(date +%s)"
      sidecar="${link}.pre-arc.${stamp}"
      local n=1
      while [ -e "${sidecar}" ]; do
        sidecar="${link}.pre-arc.${stamp}.${n}"
        n=$((n + 1))
      done
    fi
    mv -f "${link}" "${sidecar}"
    echo "  ↪ backed up existing ${link} → ${sidecar}"
  fi

  ln -sfn "${target}" "${link}"
  echo "  ✓ forward-symlink ${link} → ${target}"
}

# Reload a (freshly re-rendered) installed plist so a CHANGED ProgramArguments
# actually takes effect — specifically the ~/bin → ~/.local/bin exec-path move.
#
# Uses the modern launchctl domain API: `bootout` the plist if currently
# loaded, then `bootstrap` it back from disk. The legacy `launchctl load`/
# `unload` pair is unreliable for a repoint — `load` can silently no-op when the
# label is already registered, leaving the OLD exec path live under launchd.
# bootout+bootstrap forces launchd to re-read the plist, so the daemon comes
# back on the new binary path. Also self-healing: if preupgrade's stop somehow
# left the old service registered, bootout evicts it before bootstrap.
#
# Domain: gui/<uid> — the per-user Aqua session that owns ~/Library/LaunchAgents.
# Both calls are `|| true`: bootout errors when the label isn't loaded (fine),
# bootstrap errors (code 5) when it somehow already is.
#
# ⚠ #1904 PREREQUISITE: the `bootstrap … || true` swallows a code-5 ("service
# already loaded") failure. That failure would leave the daemon on its OLD
# ~/bin exec path — harmless TODAY *only* because the forward-symlink bridge
# (forward_link_legacy_bin) keeps ~/bin/<name> resolving. When wave 6 (#1904)
# DELETES ~/bin, that masking disappears and a swallowed code-5 becomes a
# daemon execing a missing binary. Before #1904 prunes ~/bin, this needs a
# settle-then-verify/retry here (bootout, wait for teardown, bootstrap, assert
# the new exec path is live) — NOT built now, deliberately, to keep this wave's
# blast radius minimal. Tracked as a #1904 gate.
#
# Args: $1 plist path
reload_plist() {
  local plist="$1"
  [ -f "${plist}" ] || return 0
  local domain
  domain="gui/$(id -u)"
  launchctl bootout "${domain}" "${plist}" 2>/dev/null || true
  launchctl bootstrap "${domain}" "${plist}" 2>/dev/null || true
}

# ── Skip-restart: spare a production stack (cortex#1866 principal req.) ──────
#
# CORTEX_UPGRADE_SKIP_RESTART is a comma-list of stack slugs whose LIVE daemon
# must NOT be force-restarted by `arc upgrade cortex` (verified live: the `work`
# stack serves production). A skipped stack:
#   - is NOT stopped by preupgrade (its PID is excluded from the pgrep kill and
#     it is not launchctl-unloaded), so it keeps running on its live process;
#   - has its binary moved + forward-symlink bridged + plist re-rendered as
#     normal, but is NOT bootout/bootstrapped by postupgrade;
#   - migrates to ~/.local/bin on its NEXT bootout+bootstrap (reboot / logout /
#     manual `launchctl` reload / maintenance window), when the re-rendered plist
#     takes effect. A KeepAlive relaunch of the SAME job does NOT migrate it — a
#     relaunched process keeps launchd's in-memory ProgramArguments (the OLD
#     ~/bin exec path); the forward-symlink (forward_link_legacy_bin) keeps that
#     ~/bin path valid until the job is bootstrapped from the new plist on disk.
# Relay is never routed through the skip check — it always reloads.
#
# KEY UNIFICATION (advw3b 3a): BOTH sides key on SLUG. preupgrade's kill-filter
# resolves each running daemon's slug from its argv `--config` (canonicalized
# via realpath, then the repo's filename→slug map), NOT by path-substring — so a
# daemon whose argv spells its config differently (relative path, or the
# cortex#717 monolith-vs-dir-layout coexistence) can't desync the kill side from
# postupgrade's slug-keyed reload side and get killed-but-never-restarted.

# True if $1 (a slug) is in CORTEX_UPGRADE_SKIP_RESTART. Word-splitting on the
# comma-normalized list trims incidental whitespace; slugs are [a-zA-Z0-9_-] so
# there is no quoting hazard.
stack_restart_skipped() {
  local slug="$1"
  local list="${CORTEX_UPGRADE_SKIP_RESTART:-}"
  [ -n "${list}" ] || return 1
  local entry
  for entry in $(printf '%s' "${list}" | tr ',' ' '); do
    [ "${entry}" = "${slug}" ] && return 0
  done
  return 1
}

# Reload ONE stack's plist unless its slug is skip-listed. Encapsulates the
# postupgrade reload decision so the recorded-running loop and the discover-all
# fallback loop stay identical (and both honor the skip list).
#
# Args: $1 launch_dir  $2 slug
reload_stack_unless_skipped() {
  local launch_dir="$1" slug="$2"
  local plist="${launch_dir}/ai.meta-factory.cortex.${slug}.plist"
  if [ ! -f "${plist}" ]; then
    echo "  ⚠ ${slug} plist not found after render — skipping restart" >&2
    return 0
  fi
  if stack_restart_skipped "${slug}"; then
    echo "  ⏸ ${slug} left running on its live process (CORTEX_UPGRADE_SKIP_RESTART) — plist re-rendered to ~/.local/bin; migrates on its next bootout+bootstrap (reboot / logout / manual reload)"
    return 0
  fi
  reload_plist "${plist}"
  echo "  ✓ ${slug} daemon reloaded"
}

# Extract the `--config` argument value from a process command line. Handles
# both `--config <path>` (two tokens) and `--config=<path>`. Prints the value,
# or nothing if there is no --config. Word-splits on whitespace — cortex config
# paths live under ~/.config/cortex and contain no spaces.
extract_config_arg() {
  local cmdline="$1" tok take_next=0
  for tok in ${cmdline}; do
    if [ "${take_next}" = "1" ]; then printf '%s' "${tok}"; return 0; fi
    case "${tok}" in
      --config=*) printf '%s' "${tok#--config=}"; return 0 ;;
      --config)   take_next=1 ;;
    esac
  done
  return 0
}

# Resolve the canonical stack SLUG from a daemon's argv `--config` value.
#
# Canonicalizes with realpath (so a relative / non-canonical / symlinked argv
# path resolves to the same absolute path discover_stack_slugs sees), then maps
# filename → slug the SAME way discovery does:
#   - monolith: cortex.yaml → meta-factory, cortex.<slug>.yaml → <slug>
#     (config_file_to_slug — the repo's canonical filename map);
#   - dir-layout sentinel <config_dir>/<slug>/<slug>.yaml → <slug>, validated by
#     requiring the parent-dir basename to equal the file stem (the exact shape
#     resolve_stack_config_path stamps and discover_stack_slugs derives from).
# Returns non-zero (prints nothing) when the path is empty or unclassifiable —
# the caller treats that as a fail-safe abort when a skip-list is set.
#
# PRECEDENCE MIRROR (advw3c Attack 1): discover_stack_slugs treats the DIRECTORY
# LAYOUT as authoritative — the presence of the <config_dir>/<slug>/system/
# system.yaml marker means slug == the dir basename, and dir wins over any root
# monolith. This function must mirror that precedence: check the marker FIRST,
# BEFORE config_file_to_slug's filename map. Without it, a dir-layout stack
# literally slugged `cortex` (sentinel <config_dir>/cortex/cortex.yaml) would be
# argv-hijacked to `meta-factory` by the cortex.yaml special-case while discovery
# calls it `cortex` — re-opening the exact kill/reload desync 3a closed. The
# marker disambiguates cleanly because `~/.config/cortex/cortex.yaml` (the real
# meta-factory monolith) has NO sibling system/system.yaml, so it still maps to
# meta-factory.
slug_from_config_arg() {
  local raw="$1" path base slug parent dir
  [ -n "${raw}" ] || return 1
  path="$(realpath "${raw}" 2>/dev/null || printf '%s' "${raw}")"
  dir="$(dirname "${path}")"
  # 1. Dir-layout marker wins (mirrors discover_stack_slugs precedence). The
  #    argv --config is the sentinel <config_dir>/<slug>/<slug>.yaml, whose
  #    sibling system/system.yaml is the layout marker; slug = the dir basename.
  if [ -f "${dir}/system/system.yaml" ]; then
    printf '%s' "$(basename "${dir}")"
    return 0
  fi
  base="$(basename "${path}")"
  # 2. Monolith: the repo's canonical filename→slug map (cortex.yaml → meta-
  #    factory, cortex.<slug>.yaml → <slug>).
  if slug="$(config_file_to_slug "${base}")"; then
    printf '%s' "${slug}"
    return 0
  fi
  # 3. Dir-layout sentinel whose marker is not on disk (transient / partially
  #    removed config): accept the <slug>/<slug>.yaml shape (parent basename ==
  #    file stem) as a weaker signal.
  slug="${base%.yaml}"
  parent="$(basename "${dir}")"
  if [ -n "${slug}" ] && [ "${base}" != "${slug}" ] && [ "${slug}" = "${parent}" ]; then
    printf '%s' "${slug}"
    return 0
  fi
  return 1
}

# Reclassify a kill-list by SLUG and drop skip-listed stacks, so preupgrade's
# kill never stops a spared production stack. For each PID, the slug is resolved
# from the LIVE daemon's argv `--config` (slug_from_config_arg) — identical
# keying to postupgrade's reload side.
#
# FAIL-SAFE (advw3b 3a): when CORTEX_UPGRADE_SKIP_RESTART is non-empty and a
# running daemon's slug cannot be resolved from its argv, this returns 2 (abort)
# WITHOUT printing survivors — the caller must abort the upgrade before any kill,
# rather than risk killing an unclassifiable stack that might be the spare.
#
# Prints surviving PIDs (space-separated) on stdout on success.
# Returns: 0 = ok, 2 = abort (reason on stderr).
#
# Args: $1 space/newline-separated pid list  $2 config_dir (accepted for symmetry
#       with the discovery callers; slug resolution is argv-driven).
filter_out_skipped_pids() {
  local pids="$1"
  local list="${CORTEX_UPGRADE_SKIP_RESTART:-}"
  # No skip-list requested → no reclassification, no abort: pass through so a
  # normal upgrade is never blocked and behaviour matches the pre-feature path.
  if [ -z "${list}" ] || [ -z "${pids}" ]; then
    printf '%s' "${pids}"
    return 0
  fi
  local kept="" pid cmdline cfg slug
  for pid in ${pids}; do
    cmdline="$(ps -o command= -p "${pid}" 2>/dev/null || true)"
    cfg="$(extract_config_arg "${cmdline}")"
    if ! slug="$(slug_from_config_arg "${cfg}")"; then
      echo "  ✗ cannot determine slug for running daemon PID ${pid} (config: ${cfg:-${cmdline:-<none>}}); refusing to proceed with a skip-list set, to avoid killing an unclassifiable stack — resolve or unset CORTEX_UPGRADE_SKIP_RESTART" >&2
      return 2
    fi
    stack_restart_skipped "${slug}" && continue   # spare the skip-listed stack
    kept="${kept}${kept:+ }${pid}"
  done
  printf '%s' "${kept}"
  return 0
}

# ── Arc-version guard: refuse the cutover on an arc without arc#295 ──────────
#
# The bin cutover moves cortex/cortex-relay/cldyo-live to ~/.local/bin, where
# regular files (`~/.local/bin/{cldyo-live,lucid}`) already live. arc#295's
# no-throw createSymlink backs those up to a `.pre-arc` sidecar; an OLDER arc's
# createSymlink THROWS on them and aborts the upgrade — and preupgrade has by
# then already stopped the fleet, so the box is left DOWN. This guard refuses
# up-front (BEFORE any daemon is stopped) unless the installed arc is new enough.

# Print the installed arc CLI version (bare semver), or nothing if undetectable.
detect_arc_version() {
  command -v arc >/dev/null 2>&1 || return 0
  arc --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1
}

# True if semver $1 >= semver $2 (numeric major.minor.patch; any pre-release /
# build suffix is ignored). Pure bash — no `sort -V` (BSD/macOS sort lacks it).
arc_version_ge() {
  local a b i ai bi
  local -a av=() bv=()
  # Strip anything after the numeric.dotted core (e.g. "-rc.1", "+build").
  a="${1%%[!0-9.]*}"
  b="${2%%[!0-9.]*}"
  IFS='.' read -ra av <<< "${a}"
  IFS='.' read -ra bv <<< "${b}"
  for i in 0 1 2; do
    ai="${av[i]:-0}"; bi="${bv[i]:-0}"
    [[ "${ai}" =~ ^[0-9]+$ ]] || ai=0
    [[ "${bi}" =~ ^[0-9]+$ ]] || bi=0
    # Force base-10 so a hypothetical zero-padded component (e.g. "08") can't be
    # read as octal and fail open. Unreachable with today's tags — free hardening.
    ai=$((10#${ai})); bi=$((10#${bi}))
    if (( ai > bi )); then return 0; fi
    if (( ai < bi )); then return 1; fi
  done
  return 0  # equal
}

# Preflight: REFUSE (return non-zero, clear message) unless the installed arc is
# >= $1. Call at the VERY TOP of preupgrade, BEFORE stopping any daemon.
# Args: $1 minimum arc semver (e.g. 0.38.0)
require_min_arc_version() {
  local min="$1"
  local ver
  ver="$(detect_arc_version)"
  # The mandated refuse line (verbatim; message contract for the deploy gate).
  local refuse="cortex bin cutover requires arc >= ${min} (no-throw symlink installer, arc#295). Run \`arc self-update\` first, then retry \`arc upgrade cortex\`."
  if [ -z "${ver}" ]; then
    echo "  ✗ arc not found or its version was unparseable." >&2
    echo "${refuse}" >&2
    return 1
  fi
  if ! arc_version_ge "${ver}" "${min}"; then
    echo "  ✗ installed arc is ${ver}." >&2
    echo "${refuse}" >&2
    return 1
  fi
  echo "  ✓ arc ${ver} >= ${min} — no-throw symlink installer present (arc#295)"
  return 0
}
