#!/bin/bash
# cortex#324 (v2.0.3) — stack identity auto-provisioning for arc upgrade.
#
# Walk-the-talk: stack signing should be ON by default. When an operator
# runs `arc upgrade Cortex` and their cortex.yaml lacks
# `stack.nkey_seed_path`, this helper:
#
#   1. Detects the canonical NKey path for the stack (default
#      `~/.config/nats/cortex.nk` for the main config,
#      `~/.config/nats/cortex-work.nk` for the work stack).
#   2. If the NKey file is missing, generates one via `nsc` (or skips
#      with a warning when nsc is not installed).
#   3. Appends `nkey_seed_path` + (when derivable) `nkey_pub` to the
#      existing `stack:` block — or creates a new `stack:` block when
#      none exists.
#   4. Idempotent: skipped entirely if `stack.nkey_seed_path` is already
#      declared in the file.
#
# Backup: before any edit, the script copies the config to
# `${config}.pre-stack-identity-$(date +%Y%m%dT%H%M%S)`. Operator can roll
# back by restoring the backup.
#
# Usage (in postupgrade.sh):
#   source "${SCRIPT_DIR}/lib/stack-identity-provision.sh"
#   provision_stack_identity "${CONFIG_DIR}/cortex.yaml"      "cortex"
#   provision_stack_identity "${CONFIG_DIR}/cortex.work.yaml" "cortex-work"
#
# Args:
#   $1 config file path (e.g. ~/.config/cortex/cortex.yaml)
#   $2 NKey basename — `cortex` → ~/.config/nats/cortex.nk
#
# Exit code: always 0 (provisioning is best-effort; failures emit a
# warning and the boot path's stderr WARNING surfaces the gap).

# Resolve a canonical NKey path under ~/.config/nats/ for a given basename.
# Centralised so callers can mirror the convention without hardcoding paths.
nkey_path_for() {
  local basename="$1"
  echo "${HOME}/.config/nats/${basename}.nk"
}

# Detect whether the config already declares stack.nkey_seed_path. Uses awk
# to walk the file line by line; the gate is intentionally conservative —
# it only matches the literal `nkey_seed_path:` key under a top-level
# `stack:` block (no nested stack: blocks in our schema, so this is safe).
has_stack_seed_path() {
  local config="$1"
  [ -f "${config}" ] || return 1
  awk '
    /^stack:/ { in_stack = 1; next }
    /^[a-zA-Z]/ && !/^stack:/ { in_stack = 0 }
    in_stack && /^[ \t]+nkey_seed_path:/ { found = 1; exit }
    END { exit (found ? 0 : 1) }
  ' "${config}"
}

# Derive the U-prefixed public key from a seed file.
# Strategy: run `nsc inbox-keys` is heavy; we use bun + nkeys.js if
# available, otherwise return empty and skip the nkey_pub field.
# (Operator can copy from cortex boot log later.)
derive_pubkey_from_seed() {
  local seed_path="$1"
  [ -f "${seed_path}" ] || return 1
  local bun_path
  bun_path="$(command -v bun 2>/dev/null || true)"
  if [ -z "${bun_path}" ]; then
    return 1
  fi
  # Run a tiny bun one-liner that reads the seed and prints the pubkey.
  # All output is captured; on parse failure (wrong prefix etc.) bun
  # exits non-zero and we return empty.
  "${bun_path}" -e "
    import { fromSeed } from 'nkeys.js';
    import { readFileSync } from 'fs';
    const seed = readFileSync('${seed_path}', 'utf-8').trim();
    const kp = fromSeed(new TextEncoder().encode(seed));
    process.stdout.write(kp.getPublicKey());
  " 2>/dev/null
}

# Generate a fresh SU-prefixed NKey at the given path, chmod 600.
# Returns 0 on success, 1 if nsc is not installed (caller skips).
generate_nkey_seed() {
  local seed_path="$1"
  local nsc_path
  nsc_path="$(command -v nsc 2>/dev/null || true)"
  if [ -z "${nsc_path}" ]; then
    # Fallback: try bun + nkeys.js to generate a user-class seed.
    local bun_path
    bun_path="$(command -v bun 2>/dev/null || true)"
    if [ -z "${bun_path}" ]; then
      return 1
    fi
    mkdir -p "$(dirname "${seed_path}")"
    "${bun_path}" -e "
      import { createUser } from 'nkeys.js';
      import { writeFileSync, chmodSync } from 'fs';
      const kp = createUser();
      const seed = new TextDecoder().decode(kp.getSeed());
      writeFileSync('${seed_path}', seed);
      chmodSync('${seed_path}', 0o600);
    " 2>/dev/null || return 1
    return 0
  fi
  mkdir -p "$(dirname "${seed_path}")"
  # nsc generate nkey -u prints the seed on stdout.
  "${nsc_path}" generate nkey -u > "${seed_path}" 2>/dev/null || return 1
  chmod 600 "${seed_path}" 2>/dev/null
  return 0
}

# Main entrypoint. Idempotent — multiple runs leave the config unchanged
# once the first run wired up the field.
provision_stack_identity() {
  local config="$1"
  local nkey_basename="$2"

  if [ ! -f "${config}" ]; then
    # No config yet — first-install case. Nothing to annotate.
    return 0
  fi

  if has_stack_seed_path "${config}"; then
    echo "  ⊘ Stack identity already configured in ${config##*/}"
    return 0
  fi

  local seed_path
  seed_path="$(nkey_path_for "${nkey_basename}")"

  # Generate the NKey if missing. Skip-with-warning when neither nsc nor
  # bun+nkeys.js can produce one (extremely unlikely — bun is a hard
  # cortex dep so it's always there in practice).
  if [ ! -f "${seed_path}" ]; then
    echo "  ⊕ Generating stack signing NKey at ${seed_path}..."
    if ! generate_nkey_seed "${seed_path}"; then
      echo "  ⚠ Could not generate NKey (install nsc or ensure bun is in PATH)" >&2
      echo "    Falling back to boot-time WARNING; cortex will publish unsigned." >&2
      return 0
    fi
    echo "  ✓ NKey generated (chmod 600)"
  else
    echo "  ⊘ NKey already exists at ${seed_path} — reusing"
  fi

  # Best-effort pubkey derivation. Empty result means we skip nkey_pub
  # and let cortex log it at boot for the operator to copy in manually.
  local pubkey
  pubkey="$(derive_pubkey_from_seed "${seed_path}" || true)"

  # Backup before edit.
  local backup
  backup="${config}.pre-stack-identity-$(date +%Y%m%dT%H%M%S)"
  cp "${config}" "${backup}"
  echo "  ✓ Config backup → ${backup##*/}"

  # Edit: append fields under existing stack: block, or create one.
  # Use awk so the rewrite is deterministic regardless of yaml lib presence.
  local tmpfile
  tmpfile="$(mktemp)"
  local seed_path_value="${seed_path/#${HOME}/~}"
  awk -v seed="${seed_path_value}" -v pub="${pubkey}" '
    BEGIN { in_stack = 0; injected = 0 }
    /^stack:/ {
      in_stack = 1
      print
      next
    }
    # Leaving the stack block — inject before the next top-level key.
    /^[a-zA-Z]/ && in_stack && !injected {
      print "  nkey_seed_path: " seed
      if (pub != "") {
        print "  nkey_pub: " pub
      }
      injected = 1
      in_stack = 0
    }
    { print }
    END {
      # File ended while we were still inside stack:.
      if (in_stack && !injected) {
        print "  nkey_seed_path: " seed
        if (pub != "") {
          print "  nkey_pub: " pub
        }
        injected = 1
      }
      # No stack: block existed at all — append one.
      if (!injected) {
        print ""
        print "stack:"
        print "  nkey_seed_path: " seed
        if (pub != "") {
          print "  nkey_pub: " pub
        }
      }
    }
  ' "${config}" > "${tmpfile}"

  mv "${tmpfile}" "${config}"
  if [ -n "${pubkey}" ]; then
    echo "  ✓ Stack identity wired: nkey_seed_path + nkey_pub (${pubkey:0:8}…)"
  else
    echo "  ✓ Stack identity wired: nkey_seed_path (nkey_pub will be logged at next boot)"
  fi
}
