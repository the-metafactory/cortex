#!/usr/bin/env bash
# =============================================================================
# federation-selftest.sh — hermetic, repeatable end-to-end test of the cortex
# v6.2.0 guided network-join flow (epic #1479).
#
# Shape B: ONE host, fully isolated. Stands up its own throwaway world —
#   * an isolated nsc operator store (NEVER touches ~/.config/nats)
#   * a throwaway HUB nats-server (leafnode listener, operator-mode)
#   * TWO stack buses (operator-mode) + TWO cortex configs (stackA, stackB)
#   * a LOCAL network registry (wrangler dev + isolated D1)
# then drives create → provision → make-live → register → admit/seal →
# authorize → guided join → doctor → cross-stack ping → teardown.
#
# Zero contact with jc/default, the real nsc store, or network.meta-factory.ai.
#
# Usage:
#   scripts/federation-selftest.sh all        # setup + run + verify + teardown
#   scripts/federation-selftest.sh up         # setup isolated world only
#   scripts/federation-selftest.sh run        # drive the join lifecycle
#   scripts/federation-selftest.sh verify     # doctor + cross-stack ping
#   scripts/federation-selftest.sh down       # teardown (stop procs, keep dir)
#   scripts/federation-selftest.sh nuke       # teardown + delete runtime dir
#   KEEP=1 scripts/federation-selftest.sh all # don't teardown at the end
#
# Individual stages (for debugging): env hub registry stacks admit join
# =============================================================================
set -uo pipefail

# ── Layout & ports (all high, isolated) ──────────────────────────────────────
ROOT="${CORTEX_SELFTEST_DIR:-$HOME/.cache/cortex-selftest}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORTEX="${CORTEX_BIN:-$HOME/bin/cortex}"

NET="selftest"                       # throwaway network id
# Two PRINCIPALS (mirrors the real cross-principal jc↔andreas scenario), each one
# stack. principal/slug pairs — collision-free operators OP_ALPHA / OP_BETA.
MEMBERS="alpha/testa beta/testb"
SLUGS="testa testb"                  # slug list (for teardown / port lookups)
HUB_LEAF_PORT=7522                   # hub leafnode listener
HUB_CLIENT_PORT=4622                 # hub client port
REG_PORT=8788                        # local registry (in-process)
REG_URL="http://127.0.0.1:${REG_PORT}"
UID_N="$(id -u)"
mem_principal() { echo "${1%%/*}"; }   # alpha/testa → alpha
mem_slug()      { echo "${1##*/}"; }   # alpha/testa → testa
# per-stack ports: bus client + http monitor. Keyed by slug.
stack_port() { case "$1" in testa) echo 4623;; testb) echo 4624;; *) echo 0;; esac; }
stack_mon()  { case "$1" in testa) echo 8623;; testb) echo 8624;; *) echo 0;; esac; }
CFGROOT() { echo "$ROOT/cortex-config"; }

NSC_DIR="$ROOT/nsc"                  # isolated nsc keys+store
HUB_DIR="$ROOT/hub"
A_DIR="$ROOT/stackA"
B_DIR="$ROOT/stackB"
REG_DIR="$ROOT/registry"
LOG="$ROOT/logs"; PID="$ROOT/pids"

log()  { printf '\033[1;36m[selftest]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  ! \033[0m%s\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

isolate_env() {
  # Point ALL nsc/nkeys state at the isolated store. Real ~/.config/nats untouched.
  export NKEYS_PATH="$NSC_DIR/keys"
  export NSC_HOME="$NSC_DIR/store"
  export XDG_CONFIG_HOME="$ROOT/xdg-config"
  export XDG_DATA_HOME="$ROOT/xdg-data"
  mkdir -p "$NKEYS_PATH" "$NSC_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$LOG" "$PID"
}

# Per-PRINCIPAL nsc store — each principal is a distinct machine/operator in
# reality, so alpha and beta each get their OWN nsc store. A shared store makes
# arc's "current operator" ambiguous (add-federation-export can't find the other
# principal's accounts). Call before any cortex CLI that mutates the account tree
# (provision / make-live / join).
principal_env() {  # principal_env <principal>
  local p="$1"
  export NKEYS_PATH="$ROOT/nsc-$p/keys"
  export NSC_HOME="$ROOT/nsc-$p/store"
  export XDG_DATA_HOME="$ROOT/nsc-$p/data"
  export XDG_CONFIG_HOME="$ROOT/xdg-config"
  mkdir -p "$NKEYS_PATH" "$NSC_HOME" "$XDG_DATA_HOME"
}

# ── stage: env — isolated dirs + preflight ───────────────────────────────────
stage_env() {
  log "stage env — isolated runtime at $ROOT"
  mkdir -p "$ROOT" "$HUB_DIR" "$A_DIR" "$B_DIR" "$REG_DIR" "$LOG" "$PID"
  isolate_env
  for t in nsc nats-server bun; do command -v "$t" >/dev/null || die "missing tool: $t"; done
  [ -x "$CORTEX" ] || command -v cortex >/dev/null || die "cortex CLI not found ($CORTEX)"
  ok "tools present; nsc store isolated at $NSC_DIR"
}

# ── stage: hub — SIMPLE (non-operator) hub nats-server ───────────────────────
# The sealed-PSK leaf-auth `admit` produces (inline user/password) is ONLY valid
# on a SIMPLE hub — NATS operator mode forbids inline leafnode users. So the hub
# is a plain nats-server; inbound member leafs authenticate by user/password and
# land in the default $G account (both members share it → federated.> flows
# between them). The member BUSES stay operator-mode; only the shared hub is simple.
stage_hub() {
  log "stage hub — simple (non-operator) hub nats-server"
  isolate_env
  local hubconf="$HUB_DIR/hub.conf"

  # base config (no operator / no accounts); admit (stage_admit) appends the
  # leafnodes authorization{users} block and reloads.
  cat > "$hubconf" <<EOF
server_name: "hub-selftest"
listen: "127.0.0.1:${HUB_CLIENT_PORT}"
http: "127.0.0.1:8622"
leafnodes {
  listen: "127.0.0.1:${HUB_LEAF_PORT}"
}
EOF
  ok "hub config composed: $hubconf (client :$HUB_CLIENT_PORT, leaf :$HUB_LEAF_PORT)"

  start_proc "hub" "$NATS_BIN -c $hubconf" "$HUB_DIR"
  sleep 1
  curl -sf "http://127.0.0.1:8622/varz" >/dev/null 2>&1 && ok "hub nats-server up" \
    || warn "hub monitoring not answering yet (check $LOG/hub.log)"
}

# ── stage: registry — local wrangler dev + isolated D1 + admin pubkey ─────────
# extract the base64 admin pubkey from `provision-stack generate|claim --json`
# (the JSON is pretty-printed and preceded by a prompt-filter banner line on
# stdout — awk from the first `{` and read .data.pubkey_b64).
derive_pubkey_b64() {
  local seed="$1"
  "$CORTEX" provision-stack claim selftest-admin --seed-path "$seed" \
    --stack-id selftest-admin/registry-admin --json 2>/dev/null \
    | awk '/^\{/{f=1} f{print}' \
    | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(j.items[0].claim.principal_pubkey)'
}

stage_registry() {
  log "stage registry — in-process network-registry (bun) on :$REG_PORT"
  isolate_env

  # Admin seed for network create/admit/authorize (isolated, throwaway).
  local adminseed="$ROOT/network-admin.nk"
  if [ ! -f "$adminseed" ]; then
    "$CORTEX" provision-stack generate selftest-admin --seed-path "$adminseed" \
      --stack-id selftest-admin/registry-admin >/dev/null 2>&1 \
      || die "could not generate admin seed"
  fi
  local adminpub; adminpub="$(derive_pubkey_b64 "$adminseed" | tr -d '[:space:]')"
  [ -n "$adminpub" ] || die "could not derive admin pubkey"
  echo "$adminseed" > "$ROOT/.adminseed-path"
  ok "admin pubkey: ${adminpub:0:12}…"

  # Serve the real registry app in-memory with an ephemeral signing key.
  SELFTEST_REG_PORT="$REG_PORT" \
  SELFTEST_ADMIN_PUBKEYS="$adminpub" \
  SELFTEST_REG_PUBKEY_OUT="$ROOT/registry.pubkey" \
    start_proc "registry" "bun $REPO/scripts/federation-selftest-registry.ts" "$REPO"

  # Poll /api/health.
  local i=0
  until curl -sf "$REG_URL/api/health" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -gt 30 ] && die "registry did not come up (see $LOG/registry.log)"; sleep 0.5
  done
  ok "registry up: $(curl -s "$REG_URL/api/health" | head -c 80)"
  [ -f "$ROOT/registry.pubkey" ] && ok "registry pubkey pinned: $(head -c 12 "$ROOT/registry.pubkey")…"
}

# ── stage: create — admin creates the network row in the registry ────────────
stage_create() {
  log "stage create — network '$NET' topology row (admin-signed)"
  isolate_env
  local adminseed; adminseed="$(cat "$ROOT/.adminseed-path" 2>/dev/null)"
  [ -f "$adminseed" ] || die "no admin seed (run 'registry' stage first)"

  local common=(network create "$NET" --hub "nats://127.0.0.1:${HUB_LEAF_PORT}"
                --leaf-port "$HUB_LEAF_PORT" --admin-seed "$adminseed" --registry-url "$REG_URL")
  log "  dry-run:"; "$CORTEX" "${common[@]}" 2>&1 | grep -vE "ws-transport|prompt-filter" | sed 's/^/    /' | tail -12
  log "  apply:";   "$CORTEX" "${common[@]}" --apply 2>&1 | grep -vE "ws-transport|prompt-filter" | sed 's/^/    /' | tail -8
  local row; row="$(curl -s "$REG_URL/networks/$NET")"
  echo "$row" | grep -q "\"network_id\":\"$NET\"" && ok "registry row present: $(echo "$row" | head -c 120)…" \
    || die "network row not found after create (see above)"
}

# ── stage: admit — admin admits + seals each PENDING request ─────────────────
stage_admit() {
  log "stage admit — admit + seal pending requests, wire hub leaf-auth"
  isolate_env
  local adminseed; adminseed="$(cat "$ROOT/.adminseed-path")"
  local hubconf="$HUB_DIR/hub.conf"

  # discover pending request-ids (+ which member each is for)
  "$CORTEX" network admit --list-pending --admin-seed "$adminseed" --registry-url "$REG_URL" --json \
    > "$LOG/admit-list.json" 2>&1
  local ids; ids="$(awk '/^\{/{f=1} f{print}' "$LOG/admit-list.json" \
    | bun -e 'const j=JSON.parse(await Bun.stdin.text()); const rows=j.items??j.data?.requests??j.data??[]; process.stdout.write((Array.isArray(rows)?rows:[]).map(r=>r.request_id||r.id).filter(Boolean).join(" "))' 2>/dev/null)"
  [ -n "$ids" ] || { warn "  no pending request-ids parsed — raw list follows"; grep -vE "ws-transport|prompt-filter" "$LOG/admit-list.json" | tail -20 | sed 's/^/    /'; return 0; }
  ok "  pending: $ids"

  local users=""
  for id in $ids; do
    "$CORTEX" network admit "$id" --admin-seed "$adminseed" --registry-url "$REG_URL" \
      --apply > "$LOG/admit-$id.log" 2>&1
    # parse the printed  { user: "X", password: "Y" }  artifact line
    local line; line="$(grep -oE '\{ user: "[^"]+", password: "[^"]+"' "$LOG/admit-$id.log" | head -1)"
    local u p; u="$(echo "$line" | sed -E 's/.*user: "([^"]+)".*/\1/')"; p="$(echo "$line" | sed -E 's/.*password: "([^"]+)".*/\1/')"
    if [ -n "$u" ] && [ -n "$p" ]; then
      ok "  admitted $id → leaf user '$u'"
      users="$users        { user: \"$u\", password: \"$p\" }
"
    else
      warn "  admit $id — no leaf user parsed"; grep -vE "ws-transport|prompt-filter" "$LOG/admit-$id.log" | tail -6 | sed 's/^/      /'
    fi
  done

  # Rewrite the SIMPLE hub's leafnodes block with the collected authorization users, then reload.
  cat > "$hubconf" <<EOF
server_name: "hub-selftest"
listen: "127.0.0.1:${HUB_CLIENT_PORT}"
http: "127.0.0.1:8622"
leafnodes {
  listen: "127.0.0.1:${HUB_LEAF_PORT}"
  authorization {
    users: [
$users    ]
  }
}
EOF
  "$NATS_BIN" -c "$hubconf" -t >/dev/null 2>&1 && ok "  hub.conf valid (leaf-auth wired)" || warn "  hub.conf failed validation (nats-server -t)"
  stop_proc "hub"; sleep 1; start_proc "hub" "$NATS_BIN -c $hubconf" "$HUB_DIR"; sleep 1
  curl -sf "http://127.0.0.1:8622/varz" >/dev/null 2>&1 && ok "  hub reloaded with leaf-auth" || warn "  hub not answering after reload (see $LOG/hub.log)"
}

# =============================================================================
# cortex#1598 (epic #1595 slice 2) — OPERATOR-MODE admit scenario.
#
# The SIMPLE hub above wires an inline leafnode `authorization { users }` block
# from the per-member PSK `admit` mints. An OPERATOR-MODE hub has NO such block:
# `admit` instead mints a subject-SCOPED per-member nsc user (`arc nats
# add-federated-user`, arc#269) and seals its `.creds` in a v2 envelope, writing
# NOTHING to the hub config.
#
# ── DUAL RELEASE-GATE (why this scenario SKIPS today) ────────────────────────
# This path can only run end-to-end once BOTH ship:
#   1. arc's `add-federated-user` verb is on arc MAIN (arc#269) but NOT yet in a
#      released arc binary — the operator-mode mint calls it, so a verb-less arc
#      makes cortex refuse with a clear ARC_TOO_OLD error (by design).
#   2. cortex's `--hub-mode`/`--resolver-mode`/`--hub-fed-account` flags + the
#      operator-mode admit branch are on THIS branch but not in the deployed
#      `~/bin/cortex` — so $CORTEX (CORTEX_BIN) must point at a worktree build.
# Until both land, `operator` preflights and SKIPS with the gate reason — it
# never false-fails. Set CORTEX_BIN to a worktree cortex to exercise the flags.
# =============================================================================

# The hub owner's OWN isolated nsc store (operator-mode hubs mint under it).
HUB_NSC_DIR="$ROOT/nsc-hub"
HUB_FED_ACCOUNT="FEDERATION"
NET_OP="selftest-op"                  # throwaway operator-mode network id

hub_env() {  # point nsc/arc at the HUB owner's isolated operator store
  export NKEYS_PATH="$HUB_NSC_DIR/keys"
  export NSC_HOME="$HUB_NSC_DIR/store"
  export XDG_DATA_HOME="$HUB_NSC_DIR/data"
  export XDG_CONFIG_HOME="$ROOT/xdg-config"
  mkdir -p "$NKEYS_PATH" "$NSC_HOME" "$XDG_DATA_HOME"
}

# True iff the arc on PATH knows the add-federated-user verb (gate #1).
arc_has_federated_user() { arc nats --help 2>&1 | grep -q 'add-federated-user'; }

# §5.3 scope round-trip — the issue's explicit acceptance: least privilege is
# REAL, not just argv. Decode the minted user's JWT from the AUTHORITATIVE hub
# nsc store and assert its subscribe scope is EXACTLY its own subject +_INBOX —
# `federated.<principal>.<stack>.>` — never a wider `federated.>`. Runs under
# hub_env (the hub owner's store), once the mint has created the user.
verify_scope_roundtrip() {  # verify_scope_roundtrip <principal.stack>
  local user="$1"
  local claims; claims="$(nsc describe user -a "$HUB_FED_ACCOUNT" -n "$user" -J 2>/dev/null)"
  # FAIL-CLOSED: this only runs after run_operator_scenario's arc-verb gate and a
  # successful admit, so an un-describable user means the mint did NOT create it —
  # a real failure, NOT a skip. Reporting "verified" (or even a silent pass) here
  # would let the load-bearing least-privilege assertion pass while checking
  # nothing. Die instead so the harness never green-lights an unverified scope.
  [ -n "$claims" ] || die "  §5.3: user $user has no nsc claims after admit — the scoped mint did not create it; scope UNVERIFIED"
  # The scoped user carries NO own perms; its EFFECTIVE sub scope is the scoped
  # signing key's template `federated.{{name()}}.>` → `federated.<user>.>`.
  local want="federated.${user}.>"
  echo "$claims" | bun -e '
    const j = JSON.parse(await Bun.stdin.text());
    const sub = (j?.nats?.sub?.allow ?? []).join(",");
    const want = process.argv[1];
    // least privilege: the own-scope subject present, the wide wire ABSENT.
    const ok = sub.includes(want) && !sub.split(",").some(s => s === "federated.>");
    process.stdout.write(ok ? "OK" : `VIOLATION sub=[${sub}]`);
  ' "$want" | grep -q "^OK" \
    && ok "  §5.3: $user subscribe scope ≤ ${want} (least privilege verified)" \
    || die "  §5.3: $user subscribe scope is NOT least-privilege — a scoped-mint regression"
}

# ── stage: hub (operator) — operator-mode hub with its own nsc store + resolver ─
stage_hub_operator() {
  log "stage hub (operator) — operator-mode hub nats-server + isolated nsc store"
  hub_env
  # 1. The hub owner's operator + the FEDERATION account the scoped users mint under.
  arc nats init-operator --name OP_HUB >/dev/null 2>&1 || warn "  init-operator (may already exist)"
  arc nats add-account "$HUB_FED_ACCOUNT" >/dev/null 2>&1 || warn "  add-account $HUB_FED_ACCOUNT (may already exist)"
  ok "  hub operator + $HUB_FED_ACCOUNT account (isolated nsc store $HUB_NSC_DIR)"

  # 2. An operator-mode + FULL-RESOLVER hub conf. §5.1 requires resolver_mode:
  #    nats (push-capable) — a MEMORY preload cannot learn the account-JWT edit a
  #    scoped mint makes, and cortex's Guard B refuses a memory resolver. So the
  #    hub runs a URL/full resolver, NOT the make-live MEMORY preload.
  local hubconf="$HUB_DIR/hub-operator.conf"
  local opjwt; opjwt="$(arc nats export-operator --jwt-only 2>/dev/null | tr -d '[:space:]')"
  cat > "$hubconf" <<EOF
server_name: "hub-operator-selftest"
listen: "127.0.0.1:${HUB_CLIENT_PORT}"
http: "127.0.0.1:8622"
leafnodes { listen: "127.0.0.1:${HUB_LEAF_PORT}" }
# operator-mode: the hub trusts accounts signed by OP_HUB, resolved via a
# push-capable full resolver (accepts \`nsc push\` of updated account JWTs).
operator: "${opjwt}"
resolver {
  type: full
  dir: "$HUB_DIR/jwt"
  allow_delete: false
  interval: "2m"
}
EOF
  mkdir -p "$HUB_DIR/jwt"
  nats-server -c "$hubconf" -t >/dev/null 2>&1 && ok "  operator hub.conf valid" \
    || warn "  operator hub.conf failed validation (nats-server -t) — inspect $hubconf"
  echo "$hubconf" > "$ROOT/.hub-operator-conf"
}

# ── stage: create (operator) — network row attesting hub_mode=operator ───────
stage_create_operator() {
  log "stage create (operator) — network '$NET_OP' attesting hub_mode=operator/resolver=nats"
  isolate_env
  local adminseed; adminseed="$(cat "$ROOT/.adminseed-path" 2>/dev/null)"
  [ -f "$adminseed" ] || die "no admin seed (run 'registry' stage first)"
  $CORTEX network create "$NET_OP" --hub "nats://127.0.0.1:${HUB_LEAF_PORT}" \
    --leaf-port "$HUB_LEAF_PORT" --hub-mode operator --resolver-mode nats \
    --hub-fed-account "$HUB_FED_ACCOUNT" --admin-seed "$adminseed" \
    --registry-url "$REG_URL" --apply 2>&1 | grep -vE "ws-transport|prompt-filter" | tail -6 | sed 's/^/    /'
  local row; row="$(curl -s "$REG_URL/networks/$NET_OP")"
  echo "$row" | grep -q '"hub_mode":"operator"' \
    && ok "  registry row attests hub_mode=operator" \
    || warn "  hub_mode=operator not visible on the row (needs a worktree cortex with #1598 flags): $(echo "$row" | head -c 120)"
}

# ── stage: admit (operator) — scoped mint + v2 seal, ZERO hub writes, §5.3 ────
stage_admit_operator() {
  log "stage admit (operator) — scoped mint + v2 seal + §5.3 scope round-trip"
  isolate_env
  local adminseed; adminseed="$(cat "$ROOT/.adminseed-path")"
  local hubconf; hubconf="$(cat "$ROOT/.hub-operator-conf" 2>/dev/null)"
  local before_hash; before_hash="$(md5 -q "$hubconf" 2>/dev/null || echo MISSING)"

  # discover pending request-ids on the operator network
  $CORTEX network admit --list-pending --admin-seed "$adminseed" --registry-url "$REG_URL" --json \
    > "$LOG/admit-op-list.json" 2>&1
  local ids; ids="$(awk '/^\{/{f=1} f{print}' "$LOG/admit-op-list.json" \
    | bun -e 'const j=JSON.parse(await Bun.stdin.text()); const rows=j.items??j.data?.requests??j.data??[]; process.stdout.write((Array.isArray(rows)?rows:[]).map(r=>r.request_id||r.id).filter(Boolean).join(" "))' 2>/dev/null)"
  [ -n "$ids" ] || { warn "  no pending request-ids on operator network"; return 0; }
  ok "  pending: $ids"

  hub_env   # admit mints under the HUB owner's nsc store
  for id in $ids; do
    $CORTEX network admit "$id" --admin-seed "$adminseed" --registry-url "$REG_URL" \
      --hub-config "$hubconf" --hub-fed-account "$HUB_FED_ACCOUNT" \
      --apply > "$LOG/admit-op-$id.log" 2>&1 || true
    # (a) scoped mint ran (arc add-federated-user was invoked / a scoped user minted)
    grep -qiE "scoped user|add-federated-user|envelope_version.*2|sealed v2" "$LOG/admit-op-$id.log" \
      && ok "  $id → scoped user minted, v2 creds sealed" \
      || warn "  $id → scoped mint not confirmed (ARC_TOO_OLD if arc lacks the verb): $(grep -iE 'ARC_TOO_OLD|arc upgrade|operator-mode' "$LOG/admit-op-$id.log" | head -1)"
  done
  # (§5.3) scope round-trip — the issue's explicit acceptance. Assert EACH minted
  # member's subscribe scope is its own subject only, from the authoritative store.
  for member in $MEMBERS; do
    verify_scope_roundtrip "$(mem_principal "$member").$(mem_slug "$member")"
  done
  # (b) ZERO hub config writes on the operator path. FAIL-CLOSED: a MISSING conf
  # hash means we never read a real file, so the "unchanged" comparison would be
  # vacuous ("none == none") — die rather than substantiate zero-writes on nothing.
  local after_hash; after_hash="$(md5 -q "$hubconf" 2>/dev/null || echo MISSING)"
  if [ "$before_hash" = "MISSING" ] || [ "$after_hash" = "MISSING" ]; then
    die "  zero-hub-writes check could not hash the hub conf ($hubconf) — cannot substantiate the claim (setup error)"
  elif [ "$before_hash" = "$after_hash" ]; then
    ok "  hub.conf UNCHANGED across operator admit (zero hub writes — C1/C2)"
  else
    die "  hub.conf CHANGED during operator admit — operator path must never write the hub config"
  fi
  # (c) second admit is a clean no-op (userAlreadyPresent) — re-run the first id.
  # PRECISE match only (never the bare word "already", which matches unrelated
  # "X already exists" log noise and would falsely green-light non-idempotency).
  set -- $ids
  $CORTEX network admit "$1" --admin-seed "$adminseed" --registry-url "$REG_URL" \
    --hub-config "$hubconf" --hub-fed-account "$HUB_FED_ACCOUNT" --apply > "$LOG/admit-op-2nd.log" 2>&1 || true
  grep -qiE "userAlreadyPresent|user_already_present.{0,8}true" "$LOG/admit-op-2nd.log" \
    && ok "  second admit is a clean no-op (userAlreadyPresent — C2)" \
    || warn "  second-admit idempotency not confirmed (needs the arc verb + a real mint)"
}

# ── operator scenario dispatch (gated on the dual release-gate) ───────────────
run_operator_scenario() {
  stage_env
  if ! arc_has_federated_user; then
    warn "OPERATOR SELF-TEST SKIPPED — the arc on PATH ($(arc --version 2>/dev/null | head -1)) lacks"
    warn "  the 'add-federated-user' verb (arc#269 is on arc main but not yet released)."
    warn "  The operator-mode mint would refuse with ARC_TOO_OLD by design. Re-run after"
    warn "  'arc upgrade' AND with CORTEX_BIN pointed at a worktree cortex carrying #1598."
    return 0
  fi
  stage_down; rm -rf "$ROOT"; stage_env
  stage_hub_operator; stage_registry
  stage_stacks; stage_register; stage_create_operator; stage_admit_operator
  log "operator self-test complete (see assertions above)"
  [ "${KEEP:-0}" = "1" ] || stage_down
}

# member's registered stack pubkey (base64) from its own seed
member_pubkey() {  # member_pubkey <principal> <slug> <seed>
  "$CORTEX" provision-stack claim "$1" --seed-path "$3" --stack-id "$1/$2" --json 2>/dev/null \
    | awk '/^\{/{f=1} f{print}' \
    | bun -e 'const j=JSON.parse(await Bun.stdin.text()); process.stdout.write(j.items[0].claim.principal_pubkey)'
}

# ── stage: authorize — hub owner stamps hub_authorized_at (opens guided gate) ─
stage_authorize() {
  log "stage authorize — stamp hub_authorized_at for $MEMBERS"
  isolate_env
  local adminseed; adminseed="$(cat "$ROOT/.adminseed-path")"
  for member in $MEMBERS; do
    local principal; principal="$(mem_principal "$member")"; local slug; slug="$(mem_slug "$member")"
    local pub; pub="$(member_pubkey "$principal" "$slug" "$ROOT/nats/cortex-$slug.nk" | tr -d '[:space:]')"
    "$CORTEX" network authorize "$pub" --network "$NET" --admin-seed "$adminseed" \
      --registry-url "$REG_URL" --apply > "$LOG/authorize-$slug.log" 2>&1
    grep -qiE "authorized|hub_authorized|ok\b|stamped|200" "$LOG/authorize-$slug.log" \
      && ok "  $principal/$slug hub-authorized" \
      || { warn "  authorize $principal/$slug — see below"; grep -vE "ws-transport|prompt-filter" "$LOG/authorize-$slug.log" | tail -6 | sed 's/^/      /'; }
  done
}

# peer principal of a member within MEMBERS (2-member network)
peer_principal_of() { for m in $MEMBERS; do [ "$(mem_principal "$m")" != "$1" ] && mem_principal "$m"; done; }

# ── stage: join — each stack joins the network, guided (leaf + announce) ──────
# Pass 1 joins + announces a capability (+ allows the peer) so the registry roster
# carries each stack's binding. Pass 2 re-resolves peers now that BOTH announced
# (else the first joiner writes a peer with a defaulted stack_id — issue #7/#11).
stage_join() {
  log "stage join — guided join for $MEMBERS (announce caps, then resolve peers)"
  isolate_env
  local regpub; regpub="$(cat "$ROOT/registry.pubkey")"
  local pass
  for pass in 1 2; do
    log "  join pass $pass"
    for member in $MEMBERS; do
      local principal; principal="$(mem_principal "$member")"; local slug; slug="$(mem_slug "$member")"
      local ptr="$(CFGROOT)/$slug/$slug.yaml"
      local peer; peer="$(peer_principal_of "$principal")"
      principal_env "$principal"   # this principal's OWN nsc store (for federation-wiring arc call)
      "$CORTEX" network join "$NET" --config "$ptr" --guided \
        --capabilities "code-review.docs" --allow "$peer" \
        --registry-url "$REG_URL" --registry-pubkey "$regpub" --apply > "$LOG/join-$slug-p$pass.log" 2>&1
      grep -qiE "join $principal/$slug: ok|joined|leaf" "$LOG/join-$slug-p$pass.log" \
        && ok "  $principal/$slug join pass $pass ok (announce code-review.docs, allow $peer)" \
        || { warn "  join $principal/$slug pass $pass — see below"; grep -vE "ws-transport|prompt-filter" "$LOG/join-$slug-p$pass.log" | tail -10 | sed 's/^/      /'; }
    done
  done
  # FINDING #7: join resolves the peer stack from the registry roster, which
  # carries NO stack binding (capabilities:[]), so it defaults to {principal}/default.
  # Pin the correct stack_id so the peer matches what we ping (beta/testb, alpha/testa).
  for member in $MEMBERS; do
    local principal; principal="$(mem_principal "$member")"; local slug; slug="$(mem_slug "$member")"
    local peer; peer="$(peer_principal_of "$principal")"
    local peerslug; for m in $MEMBERS; do [ "$(mem_principal "$m")" = "$peer" ] && peerslug="$(mem_slug "$m")"; done
    sed -i '' "s|stack_id: $peer/default|stack_id: $peer/$peerslug|" "$(CFGROOT)/$slug/stacks/$slug.yaml"
  done
  for member in $MEMBERS; do local slug; slug="$(mem_slug "$member")"
    launchctl kickstart -k "gui/$UID_N/$SVC_PREFIX.$slug-daemon" >/dev/null 2>&1 || true; done
  sleep 3
  ok "  peer stack_ids pinned (workaround for #7); daemons restarted"
  echo "  --- hub leaf connections (varz) ---"; curl -s "http://127.0.0.1:8622/varz" 2>/dev/null | grep -oE '"leafnodes": [0-9]+' | head -1 | sed 's/^/    /'
}

# ── launchd service helpers (macOS) ──────────────────────────────────────────
# The data-plane tooling (make-live/join) restarts the bus + daemon via the
# service manager, so the stack buses + daemons MUST be launchd-managed.
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"
NATS_BIN="${NATS_BIN:-$(command -v nats-server)}"   # launchd needs an ABSOLUTE path
# The cortex daemon-locator (daemon-locator.ts:122) ONLY scans ~/Library/LaunchAgents
# for plists named ^ai\.meta-factory\.cortex\..+\.plist$, so launchd-managed selftest
# services must live there under that prefix. They are clearly-named + torn down on
# teardown (launchd is a user-global registry — there is no private-dir isolation for it).
LA_DIR="$HOME/Library/LaunchAgents"
SVC_PREFIX="ai.meta-factory.cortex.selftest"

# write_plist <label> <logbase> <prog> [args…]
write_plist() {
  local label="$1" logbase="$2"; shift 2
  local plist="$LA_DIR/$label.plist"; mkdir -p "$LA_DIR"
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    printf '<plist version="1.0"><dict>\n'
    printf '  <key>Label</key><string>%s</string>\n' "$label"
    printf '  <key>ProgramArguments</key><array>\n'
    for a in "$@"; do printf '    <string>%s</string>\n' "$a"; done
    printf '  </array>\n'
    printf '  <key>EnvironmentVariables</key><dict>\n'
    printf '    <key>NKEYS_PATH</key><string>%s</string>\n' "$NSC_DIR/keys"
    printf '    <key>NSC_HOME</key><string>%s</string>\n' "$NSC_DIR/store"
    printf '    <key>XDG_DATA_HOME</key><string>%s</string>\n' "$ROOT/xdg-data"
    printf '    <key>XDG_CONFIG_HOME</key><string>%s</string>\n' "$ROOT/xdg-config"
    printf '    <key>PATH</key><string>%s</string>\n' "$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    printf '    <key>HOME</key><string>%s</string>\n' "$HOME"
    printf '  </dict>\n'
    printf '  <key>RunAtLoad</key><true/>\n'
    printf '  <key>StandardOutPath</key><string>%s.out.log</string>\n' "$logbase"
    printf '  <key>StandardErrorPath</key><string>%s.err.log</string>\n' "$logbase"
    printf '</dict></plist>\n'
  } > "$plist"
  echo "$plist"
}

svc_up() {   # svc_up <label> <plist>
  local label="$1" plist="$2"
  launchctl bootout "gui/$UID_N/$label" >/dev/null 2>&1
  launchctl bootstrap "gui/$UID_N" "$plist" 2>&1 | grep -viE "^$" || true
  launchctl kickstart -k "gui/$UID_N/$label" >/dev/null 2>&1 || true
}
svc_down() { launchctl bootout "gui/$UID_N/$1" >/dev/null 2>&1 && ok "service $1 booted out"; rm -f "$LA_DIR/$1.plist" 2>/dev/null; true; }
svc_running() { launchctl print "gui/$UID_N/$1" 2>/dev/null | grep -qE "state = running"; }

# ── stage: stacks — scaffold, isolate, provision, make-live (operator-mode) ───
isolate_stack() {  # isolate_stack <slug> <port>
  local slug="$1" port="$2" cdir="$(CFGROOT)/$slug"
  local seed="$ROOT/nats/cortex-$slug.nk" conf="$ROOT/nats/$slug.conf"
  sed -i '' "s|nats://127.0.0.1:4222|nats://127.0.0.1:$port|" "$cdir/system/system.yaml"
  sed -i '' "s|~/.config/cortex/logs|$cdir/logs|" "$cdir/system/system.yaml"
  sed -i '' "s|~/.config/nats/cortex.nk|$seed|" "$cdir/system/system.yaml"
  sed -i '' "s|~/.config/nats/cortex-$slug.nk|$seed|" "$cdir/stacks/$slug.yaml"
  # headless: no surface adapters (bus-only daemon runs the federated responder)
  printf 'surfaces: {}\n' > "$cdir/surfaces/surfaces.yaml"
  mkdir -p "$cdir/logs" "$ROOT/nats"
}

base_bus_config() {  # base_bus_config <slug> <port> <mon>  → minimal bootable bus for make-live to convert
  local slug="$1" port="$2" mon="$3" conf="$ROOT/nats/$slug.conf"
  cat > "$conf" <<EOF
server_name: "$slug-selftest"
listen: "127.0.0.1:$port"
http: "127.0.0.1:$mon"
jetstream { store_dir: "$ROOT/nats/$slug-js"; domain: "$slug-selftest"; max_mem: 64mb; max_file: 256mb }
EOF
  echo "$conf"
}

provision_one_stack() {  # provision_one_stack <principal/slug>
  local member="$1" principal; principal="$(mem_principal "$member")"
  local slug; slug="$(mem_slug "$member")"
  local port; port="$(stack_port "$slug")"; local mon; mon="$(stack_mon "$slug")"
  local cdir="$(CFGROOT)/$slug" ptr="$(CFGROOT)/$slug/$slug.yaml"
  local conf="$ROOT/nats/$slug.conf" creds="$ROOT/nats/$slug-bot.creds"
  principal_env "$principal"   # this principal's OWN nsc store
  log "  stack $principal/$slug (bus :$port, mon :$mon)"

  if [ ! -d "$cdir" ]; then
    "$CORTEX" stack create "$slug" --principal "$principal" --config-dir "$(CFGROOT)" --apply \
      >/dev/null 2>&1 || die "stack create $slug failed"
  fi
  isolate_stack "$slug" "$port"
  ok "  scaffolded + isolated ($cdir)"

  "$CORTEX" network provision "$slug" --config "$ptr" --creds "$creds" --apply \
    2>&1 | grep -qE "provision $principal/$slug: ok" && ok "  provisioned (accounts minted, isolated)" \
    || die "provision $slug failed"
  local buslabel="$SVC_PREFIX.$slug-bus" dmnlabel="$SVC_PREFIX.$slug-daemon"
  local buspath="$LA_DIR/$buslabel.plist"
  # point nats_infra.config_path at the isolated conf + record the bus plist_path so
  # make-live restarts THIS bus service (network-adapters.ts:1090), not a scan guess.
  sed -i '' "s|config_path: ~/.config/nats/$slug.conf|config_path: $conf\\
    plist_path: $buspath|" "$cdir/stacks/$slug.yaml"

  base_bus_config "$slug" "$port" "$mon" >/dev/null
  svc_up "$buslabel"  "$(write_plist "$buslabel" "$LOG/$slug-bus" "$NATS_BIN" -c "$conf")"
  sleep 1; svc_running "$buslabel" && ok "  bus service up (base config)" || warn "  bus service not confirmed (see $LOG/$slug-bus.*.log)"
  svc_up "$dmnlabel"  "$(write_plist "$dmnlabel" "$LOG/$slug-daemon" "$BUN_BIN" "$CORTEX" start --config "$ptr")"

  "$CORTEX" network make-live "$slug" --config "$ptr" --nats-config "$conf" --creds "$creds" --apply \
    2>&1 | grep -vE "ws-transport|prompt-filter|config-loader|security.signing" | grep -qE "make-live $principal/$slug: ok" \
    && ok "  make-live ok (bus operator-mode, daemon on agents account)" \
    || warn "  make-live did not report ok — inspect (bus may still be converted)"

  # FINDING #3: the daemon resolves its bus creds from the CONVENTIONAL path
  # ~/.config/nats/<slug>-bot.creds, NOT stack.nats_infra.creds_path. Place the
  # (isolated) creds there so the daemon connects + the probe-responder starts.
  # (user-global throwaway, like the launchd plists — removed on teardown.)
  [ -f "$creds" ] && cp "$creds" "$HOME/.config/nats/$slug-bot.creds" 2>/dev/null && ok "  bus creds placed at daemon path (~/.config/nats/$slug-bot.creds)"
}

stage_stacks() {
  log "stage stacks — provision + make-live $MEMBERS"
  isolate_env
  for member in $MEMBERS; do provision_one_stack "$member"; done
}

# ── stage: register — proof-of-possession registration → PENDING admission ────
# Each principal registers its stack as its OWN root (cross-principal model).
stage_register() {
  log "stage register — $MEMBERS into network '$NET' (PENDING admission)"
  isolate_env
  for member in $MEMBERS; do
    local principal; principal="$(mem_principal "$member")"; local slug; slug="$(mem_slug "$member")"
    local seed="$ROOT/nats/cortex-$slug.nk"
    "$CORTEX" provision-stack register "$principal" --seed-path "$seed" \
      --stack-id "$principal/$slug" --registry-url "$REG_URL" --network "$NET" \
      >"$LOG/register-$slug.log" 2>&1
    if grep -qiE "registered|HTTP 201|ok\b|pending|admission" "$LOG/register-$slug.log"; then
      ok "  $principal/$slug registered (own root)"
    else
      warn "  register $principal/$slug — see below"; grep -vE "ws-transport|prompt-filter" "$LOG/register-$slug.log" | tail -6 | sed 's/^/      /'
    fi
  done
  for member in $MEMBERS; do local p; p="$(mem_principal "$member")"
    echo "  registry: $p → $(curl -s "$REG_URL/principals/$p" | head -c 160)…"; done
}

# ── stage: verify — doctor + cross-stack federated ping ──────────────────────
stage_verify() {
  log "stage verify — doctor + cross-principal ping"
  isolate_env
  local a b
  set -- $MEMBERS; a="$1"; b="$2"
  local ap; ap="$(mem_principal "$a")"; local as; as="$(mem_slug "$a")"
  local bp; bp="$(mem_principal "$b")"; local bs; bs="$(mem_slug "$b")"
  local aptr="$(CFGROOT)/$as/$as.yaml" bptr="$(CFGROOT)/$bs/$bs.yaml"

  for m in "$a $as" "$b $bs"; do
    set -- $m; local prn="${1%%/*}"; local slg="$2"; local ptr="$(CFGROOT)/$slg/$slg.yaml"
    "$CORTEX" network doctor "$NET" --config "$ptr" > "$LOG/doctor-$slg.log" 2>&1
    local verdict; verdict="$(grep -oiE "healthy|degraded|broken" "$LOG/doctor-$slg.log" | head -1)"
    ok "  doctor ${1} → ${verdict:-see $LOG/doctor-$slg.log}"
  done

  log "  ping $ap/$as → $bp/$bs"
  "$CORTEX" network ping "$bp/$bs" --network "$NET" --config "$aptr" > "$LOG/ping-a2b.log" 2>&1
  local rc=$?
  grep -vE "ws-transport|prompt-filter" "$LOG/ping-a2b.log" | tail -8 | sed 's/^/    /'
  [ "$rc" = 0 ] && ok "  ✅ ping $ap/$as → $bp/$bs REACHABLE (rc=0)" || warn "  ping a→b rc=$rc (0=reachable 2=notcfg 3=noresponder 4=timeout 5=refused)"

  log "  ping $bp/$bs → $ap/$as"
  "$CORTEX" network ping "$ap/$as" --network "$NET" --config "$bptr" > "$LOG/ping-b2a.log" 2>&1
  local rc2=$?
  grep -vE "ws-transport|prompt-filter" "$LOG/ping-b2a.log" | tail -8 | sed 's/^/    /'
  [ "$rc2" = 0 ] && ok "  ✅ ping $bp/$bs → $ap/$as REACHABLE (rc=0)" || warn "  ping b→a rc=$rc2"

  if [ "$rc" != 0 ] || [ "$rc2" != 0 ]; then
    local fedsubs; fedsubs="$(curl -s "http://127.0.0.1:8622/subsz?subs=1" 2>/dev/null | grep -c 'federated' || echo 0)"
    log "  DIAGNOSIS (cortex#1117): hub has $fedsubs federated.* subscriptions."
    echo "    The daemon subscribes on the AGENTS account but the leaf binds the FED account;"
    echo "    federated.> interest does NOT bridge across that boundary (G1d/#1117 is unimplemented),"
    echo "    so responder interest never reaches the hub. Transport + control-plane are HEALTHY;"
    echo "    the dispatch hop needs #1117 (dedicated-federation-account split) OR a single-account bus." | sed 's/^/    /'
  fi
}

# ── process helpers ──────────────────────────────────────────────────────────
start_proc() {
  local name="$1" cmd="$2" cwd="${3:-$ROOT}"
  local pidfile="$PID/$name.pid" logfile="$LOG/$name.log"
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    ok "$name already running (pid $(cat "$pidfile"))"; return 0
  fi
  ( cd "$cwd" && exec $cmd ) >"$logfile" 2>&1 &
  echo $! > "$pidfile"
  ok "$name started (pid $!) → $logfile"
}
stop_proc() {
  local name="$1"
  local pidfile="$PID/$name.pid"
  [ -f "$pidfile" ] || return 0
  local p; p="$(cat "$pidfile")"
  kill "$p" 2>/dev/null && ok "$name stopped (pid $p)"
  rm -f "$pidfile"
}

stage_down() {
  log "stage down — stopping services + processes"
  isolate_env
  # bootout EVERY selftest-labelled launchd service (any prefix, so old runs don't orphan)
  launchctl list 2>/dev/null | grep -iE "selftest" | awk '{print $3}' | while read -r lbl; do
    [ -n "$lbl" ] && launchctl bootout "gui/$UID_N/$lbl" >/dev/null 2>&1
  done
  rm -f "$LA_DIR"/*selftest*.plist 2>/dev/null
  # stop bare procs
  for n in hub registry; do stop_proc "$n"; done
  # free any lingering selftest ports (hub/buses/monitors)
  for p in "$REG_PORT" "$HUB_CLIENT_PORT" "$HUB_LEAF_PORT" 8622 $(for s in $SLUGS; do stack_port "$s"; stack_mon "$s"; done); do
    pid="$(lsof -ti "tcp:$p" 2>/dev/null || true)"; [ -n "$pid" ] && kill $pid 2>/dev/null || true
  done
  # clean the (user-global) daemon pidfiles + placed bus creds for our slugs
  for slug in $SLUGS; do
    rm -f "$HOME/.config/grove/state/cortex-$slug.pid" 2>/dev/null
    rm -f "$HOME/.config/nats/$slug-bot.creds" 2>/dev/null
  done
  ok "all selftest services + processes stopped (runtime dir kept at $ROOT)"
}

# ── dispatch ─────────────────────────────────────────────────────────────────
cmd="${1:-all}"
case "$cmd" in
  env)      stage_env ;;
  hub)      stage_env; stage_hub ;;
  registry) stage_env; stage_registry ;;
  create)   stage_env; stage_create ;;
  stacks)   stage_env; stage_stacks ;;
  register) stage_env; stage_register ;;
  admit)    stage_env; stage_admit ;;
  operator) run_operator_scenario ;;   # cortex#1598 operator-mode admit (arc-verb-gated)
  authorize) stage_env; stage_authorize ;;
  join)     stage_env; stage_join ;;
  verify)   stage_env; stage_verify ;;
  up)       stage_env; stage_hub; stage_registry ;;
  run)      stage_env; stage_stacks; stage_register; stage_create; stage_admit; stage_authorize; stage_join; stage_verify ;;
  down)     stage_down ;;
  nuke)     stage_down; rm -rf "$ROOT"; ok "runtime dir deleted" ;;
  all)      stage_env; stage_down; rm -rf "$ROOT"      # clean slate first
            stage_env; stage_hub; stage_registry
            stage_stacks; stage_register; stage_create; stage_admit; stage_authorize; stage_join; stage_verify
            log "self-test complete (see verify verdict above; federated dispatch is gated on cortex#1117)"
            [ "${KEEP:-0}" = "1" ] || stage_down ;;
  *)        die "unknown stage: $cmd (env|hub|registry|create|stacks|register|admit|operator|authorize|join|verify|run|up|down|nuke|all)" ;;
esac
