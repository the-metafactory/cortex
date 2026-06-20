#!/bin/bash
# cortex#324 (v2.0.3) — stack identity auto-provisioning for arc upgrade.
#
# Walk-the-talk: stack signing should be ON by default. When a principal
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
#   5. G3 (cortex#1119): once the real pubkey is derived, idempotently
#      writes it back to ALL THREE config sites that need it:
#        a. stack.nkey_pub
#        b. policy.principals[<agent>].nkey_pub  (the signing identity)
#        c. agents[*].nkey_pub
#      Only placeholder values (UAAA…56 chars) are overwritten; a real
#      pubkey already in place is left untouched. Every patch + skip is
#      logged explicitly.
#
# Backup: before any edit, the script copies the config to
# `${config}.pre-stack-identity-$(date +%Y%m%dT%H%M%S)`. Principal can roll
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

# Detect whether the config declares stack.id under a top-level `stack:` block.
# Mirrors has_stack_seed_path. Guards against wiring signing fields into a config
# that has no stack.id — which would Zod-reject at boot and exit the service.
has_stack_id() {
  local config="$1"
  [ -f "${config}" ] || return 1
  awk '
    /^stack:/ { in_stack = 1; next }
    /^[a-zA-Z]/ && !/^stack:/ { in_stack = 0 }
    in_stack && /^[ \t]+id:/ { found = 1; exit }
    END { exit (found ? 0 : 1) }
  ' "${config}"
}

# Derive the U-prefixed public key from a seed file.
# Strategy: run `nsc inbox-keys` is heavy; we use bun + nkeys.js if
# available, otherwise return empty and skip the nkey_pub field.
# (Principal can copy from cortex boot log later.)
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

# G3 (cortex#1119) — idempotently write the real U-prefixed pubkey back to
# all three config sites that reference it.
#
# Strategy:
#   • Only patches lines whose nkey_pub value is the all-A placeholder
#     (UAAAA…56 chars). A different U-prefixed value is treated as a real
#     key already in place and is left untouched.
#   • Targets precisely:
#       1. stack.nkey_pub        (inside the top-level `stack:` block)
#       2. policy.principals[x].nkey_pub  (agent signing entries — those that
#          HAVE a nkey_pub line; human principals typically have none)
#       3. agents[*].nkey_pub   (every agent entry that has an nkey_pub line)
#   • Backs up the config before any edit (reuses the caller's backup if
#     already taken; this function creates its own if called independently).
#   • Logs each patched site AND each skipped site (already real).
#   • Never writes if pubkey is empty — caller must guard that.
#
# Args:
#   $1 config file path
#   $2 real U-prefixed pubkey (56-char base32)
#   $3 backup flag: "backup" (default) or "no-backup" when caller already
#      created one.
#
# Returns 0 always (best-effort; failures are logged, not fatal).
#
# The placeholder emitted by `cortex stack create` (NKEY_PUB_PLACEHOLDER):
#   UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
# It is a valid-FORMAT 56-char all-A nkey that parses at load but is
# semantically meaningless. Matching this exact value (U + 55 × A) is the
# safe sentinel: real pubkeys generated from actual seeds will differ.
readonly _NKEY_PLACEHOLDER="UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

patch_nkey_pub_sites() {
  local config="$1"
  local pubkey="$2"
  local backup_flag="${3:-backup}"

  [ -f "${config}" ] || return 0
  [ -n "${pubkey}" ] || return 0

  # Validate pubkey format: U + exactly 55 uppercase base32 chars.
  if ! printf '%s' "${pubkey}" | grep -qE '^U[A-Z2-7]{55}$'; then
    echo "  ⚠ patch_nkey_pub_sites: pubkey '${pubkey}' does not match U[A-Z2-7]{55} — skipping" >&2
    return 0
  fi

  # Check whether any placeholder sites exist at all. If not, nothing to do.
  local placeholder_count
  placeholder_count="$(grep -c "${_NKEY_PLACEHOLDER}" "${config}" 2>/dev/null || true)"
  if [ "${placeholder_count}" -eq 0 ]; then
    echo "  ⊘ No placeholder nkey_pub values found in ${config##*/} — all sites already set"
    return 0
  fi

  # Backup before edit (skip if caller already created one).
  if [ "${backup_flag}" != "no-backup" ]; then
    local backup
    backup="${config}.pre-stack-identity-$(date +%Y%m%dT%H%M%S)"
    cp "${config}" "${backup}"
    echo "  ✓ Config backup → ${backup##*/}"
  fi

  # G3 patch strategy: replace ALL occurrences of the placeholder on `nkey_pub:`
  # lines. The placeholder is the exact 56-char all-A value emitted by
  # `cortex stack create` — it is semantically unique and cannot legitimately
  # appear in any other context (it is an invalid-key-material value used solely
  # as a FORMAT placeholder so the config file passes schema validation before the
  # real key is provisioned). Any nkey_pub line carrying a DIFFERENT U-prefixed
  # value is left untouched (it is either a real key or a legitimately distinct
  # placeholder the operator supplied).
  #
  # Implementation: awk in record-per-line mode. For each line, if it is a
  # `nkey_pub:` line whose first value token equals the placeholder, swap in
  # the real pubkey while preserving leading whitespace and any trailing inline
  # comment. All other lines (including nkey_pub lines with real keys) pass
  # through unchanged.
  #
  # Note: we write the awk program to a tmpfile instead of passing it inline to
  # avoid bash's heredoc/single-quote parser misidentifying $0 and function-call
  # syntax as shell constructs when the script is sourced in strict mode.
  local awkprog
  awkprog="$(mktemp)"
  # Write awk program as a separate file — avoids bash single-quote parse issues.
  printf '%s\n' \
    'BEGIN { patched = 0; skipped = 0 }' \
    '/^[[:space:]]*nkey_pub:[[:space:]]/ {' \
    '  # Extract the value token (first non-whitespace token after "nkey_pub: ").'\
    '  val = $0' \
    '  sub(/^[[:space:]]*nkey_pub:[[:space:]]*/, "", val)' \
    '  # Strip inline comment and trailing whitespace to get the bare value.' \
    '  gsub(/[[:space:]].*$/, "", val)' \
    '  if (val == placeholder) {' \
    '    # Preserve leading whitespace (indent) from the original line.' \
    '    lead = $0' \
    '    sub(/nkey_pub:.*$/, "", lead)' \
    '    # Preserve any trailing inline comment (everything after the value token).' \
    '    comment = $0' \
    '    sub(/^[[:space:]]*nkey_pub:[[:space:]]*[^[:space:]]+/, "", comment)' \
    '    printf "%snkey_pub: %s%s\n", lead, pub, comment' \
    '    patched++' \
    '    print "  [G3] patch: nkey_pub " val " patched" | "cat >&2"' \
    '  } else {' \
    '    print' \
    '    skipped++' \
    '    print "  [G3] skip:  nkey_pub " val " (real key — left untouched)" | "cat >&2"' \
    '  }' \
    '  next' \
    '}' \
    '{ print }' \
    'END {' \
    '  if (patched > 0 || skipped > 0) {' \
    '    msg = "  [G3] summary: " patched " site(s) patched"' \
    '    if (skipped > 0) msg = msg ", " skipped " already real (left untouched)"' \
    '    print msg | "cat >&2"' \
    '  }' \
    '}' \
    > "${awkprog}"

  local tmpfile
  tmpfile="$(mktemp)"
  awk -v pub="${pubkey}" -v placeholder="${_NKEY_PLACEHOLDER}" -f "${awkprog}" "${config}" > "${tmpfile}"
  rm -f "${awkprog}"
  mv "${tmpfile}" "${config}"

  echo "  ✓ G3 nkey_pub write-back complete (${placeholder_count} placeholder(s) replaced in ${config##*/})"
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
  # cortex#1106 — `nsc generate nkey -u` prints THREE lines: the seed (`SU…`),
  # the public key (`U…`), and a trailing blank. Writing all three breaks the
  # stack signing loader: cortex does `fromSeed(content.trim())`, and trim()
  # cannot strip the INTERIOR pubkey line, so the file fails to parse
  # ("nkeys: invalid encoded key") and the stack boots unsigned (seen on the
  # dev-loop + tender stacks). Extract ONLY the seed line (the `S`-prefixed
  # one) and write it bare (no trailing newline), matching the bun fallback
  # above and the single-token format `derive_pubkey_from_seed` + cortex expect.
  local nsc_seed
  nsc_seed="$("${nsc_path}" generate nkey -u 2>/dev/null | awk '/^S/ { print; exit }')"
  [ -n "${nsc_seed}" ] || return 1
  # umask 077 so the seed file is born 600 — no world-readable window between
  # create and the chmod below (it IS signing-key material). chmod stays as
  # belt-and-suspenders for an inherited-odd-umask environment.
  ( umask 077; printf '%s' "${nsc_seed}" > "${seed_path}" ) || return 1
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
    # cortex#1101 — the config DECLARES stack.nkey_seed_path (e.g. written by
    # `cortex stack create`), but the seed FILE may not exist yet. The old
    # behaviour returned here on the declared key alone, so a stack created via
    # `cortex stack create` never got its seed generated by `arc upgrade` —
    # leaving the stack unable to sign / connect. Idempotency must key on the
    # FILE, not the config key: if the declared seed exists, skip; if it's
    # missing, generate it at the declared (convention) path. The config already
    # carries nkey_seed_path, so we do NOT re-edit it here.
    local declared_seed
    declared_seed="$(nkey_path_for "${nkey_basename}")"
    if [ -f "${declared_seed}" ]; then
      echo "  ⊘ Stack identity configured + seed file present in ${config##*/}"
      # G3 (cortex#1119): seed is present but placeholder nkey_pub values may
      # still be in the config (e.g. after `cortex stack create` + first arc
      # upgrade that generated the seed but predates G3). Derive the pubkey and
      # write it back to any placeholder sites — idempotent if already correct.
      local existing_pub
      existing_pub="$(derive_pubkey_from_seed "${declared_seed}" || true)"
      if [ -n "${existing_pub}" ]; then
        patch_nkey_pub_sites "${config}" "${existing_pub}"
      fi
      return 0
    fi
    echo "  ⊕ ${config##*/} declares nkey_seed_path but the seed file is missing — generating at ${declared_seed} (cortex#1101)..."
    if ! generate_nkey_seed "${declared_seed}"; then
      echo "  ⚠ Could not generate NKey (install nsc or ensure bun is in PATH); cortex will publish unsigned." >&2
      return 0
    fi
    echo "  ✓ Seed generated (chmod 600)."
    local declared_pub
    declared_pub="$(derive_pubkey_from_seed "${declared_seed}" || true)"
    if [ -n "${declared_pub}" ]; then
      # G3 (cortex#1119): write the real pubkey back to all 3 config sites.
      # The config already carries nkey_seed_path — we only patch nkey_pub
      # placeholder values; the seed path wiring is already correct.
      patch_nkey_pub_sites "${config}" "${declared_pub}"
    else
      echo "    ⓘ Could not derive pubkey from ${declared_seed##*/}; cortex will log it at boot."
    fi
    return 0
  fi

  # cortex#563 (JC v4 snag): never wire signing fields into a config that lacks
  # stack.id. The awk editor below would otherwise emit / extend a `stack:` block
  # carrying nkey_seed_path but no id — which Zod-rejects at the next boot
  # ("stack.id: expected string, received undefined") and EXITS the service
  # (crashed clawbox once during a fresh signed deploy). Refuse loudly with
  # actionable guidance instead; the daemon keeps booting (publishes unsigned)
  # and the principal fixes the gap deliberately rather than via a crash loop.
  if ! has_stack_id "${config}"; then
    {
      echo "  ⚠ ${config##*/} has no stack.id — refusing to wire signing identity."
      echo "    Writing nkey_seed_path without stack.id Zod-rejects at boot and exits"
      echo "    the service. Add the stack block first, e.g.:"
      echo "        stack:"
      echo "          id: {principal}/{stack}   # e.g. jc/default"
      echo "    to ${config}, then re-run. Skipping for now (cortex publishes unsigned)."
    } >&2
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
  # and let cortex log it at boot for the principal to copy in manually.
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
    # G3 (cortex#1119): the awk above wired stack.nkey_pub. Now patch the two
    # remaining sites (policy.principals[].nkey_pub and agents[].nkey_pub).
    # The backup was already taken above — pass "no-backup" to avoid a second one.
    patch_nkey_pub_sites "${config}" "${pubkey}" "no-backup"
  else
    echo "  ✓ Stack identity wired: nkey_seed_path (nkey_pub will be logged at next boot)"
  fi
}
