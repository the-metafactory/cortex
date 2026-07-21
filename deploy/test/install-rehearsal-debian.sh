#!/usr/bin/env bash
#
# deploy/test/install-rehearsal-debian.sh — the registry install-rehearsal
# bench (cortex#2287): the fresh-machine `arc install cortex` path, scripted
# as a one-command, exit-coded, multipass-driven gate.
#
#   bun run bench:install:debian                     # git mode (pre-publish)
#   deploy/test/install-rehearsal-debian.sh --keep   # leave the VM up after
#   deploy/test/install-rehearsal-debian.sh --mode registry            # D2 reuse
#   deploy/test/install-rehearsal-debian.sh --mode registry --ref cortex \
#       --source https://registry.example.invalid    # dry-published listing
#
# Modes (--mode):
#   git       (default) — pre-publish rehearsal: `arc install <repo-url>`
#             straight from the cortex git repo (--repo overrides the URL).
#             This is the leg cortex#2287 ships and gates on.
#   registry  — D2 reuse: `arc install <package-ref>` from a metafactory
#             source (--ref overrides the package ref, default `cortex`;
#             --source adds that URL as a metafactory source named
#             `rehearsal` inside the VM first). If the listing needs auth,
#             export ARC_REGISTRY_TOKEN in the OPERATOR's environment — it is
#             piped into the VM over stdin (never argv, never a staged file,
#             never committed) and written into the VM's sources.yaml. This
#             script NEVER contains a token; running the registry leg against
#             the LIVE listing is D2's manual ritual, not part of cortex#2287.
#
# What it does (fresh Ubuntu LTS VM named cortex-rehearsal, idempotent):
#   1. vm-provision       — launch VM; install git/curl/unzip, bun, Claude
#                           Code CLI, nats-server, enable systemd linger
#   2. arc-install        — install arc per its QUICKSTART (clone + bun
#                           install + bun link), `arc --version` works
#   3. cortex-install     — `arc install` per --mode (--skip-secrets: tokens
#                           are quickstart's env seam, not install-time
#                           provisioning) and the capability display is shown
#   4. depends-cascade    — `arc list --json` contains cortex + every
#                           depends_on.packages bundle (the arc#305/#306
#                           auto-install contract, incl. the Discord adapter)
#   5. symlinks           — ~/.local/bin/cortex + cortex-relay resolve to the
#                           arc-cloned repo and `cortex --help` runs
#   6. quickstart-provisioning — `cortex quickstart` with the PLACEHOLDER env
#                           fixture: steps 1-6 all ✓
#   7. quickstart-gate    — expected-fail leg: with a dummy Discord token the
#                           run must FAIL at the services/gate leg (step 7/8,
#                           nonzero exit). Steps 7-8 need real
#                           CTX_DISCORD_TOKEN (+ a real `claude` login or
#                           CLAUDE_CODE_OAUTH_TOKEN) — that full-token leg is
#                           the manual part of D2, not this script.
#
# Exit contract: 0 = all assertions pass; nonzero = first failing assertion
# named on stderr. A summary table always prints. Fail-fast: groups after the
# first failure are reported SKIP. Teardown deletes + purges the VM
# (`multipass list` shows no cortex-rehearsal) unless --keep.
#
# Fixtures are PLACEHOLDER-ONLY (fixtures/cortex.env.rehearsal): dummy tokens,
# numeric placeholder snowflakes. Never put real values there
# (confidentiality rule). Tokens reach this script ONLY via operator env.
#
# Assert-only: if an assertion exposes a product bug (arc or cortex), FILE it
# — never fix the product from here.
#
# Requirements: multipass on the host; network (VM image, apt, bun.sh,
# claude.ai, GitHub). First run downloads a VM image — this can take minutes.
#
# Flags: --keep · --mode <git|registry> · --repo <url> · --ref <name> ·
#        --source <url> · -h/--help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="${SCRIPT_DIR}/fixtures/cortex.env.rehearsal"
WORKDIR="${SCRIPT_DIR}/.work"
VM="cortex-rehearsal"
VM_HOME="/home/ubuntu"

# Defaults (overridable by flags — see header).
MODE="git"
REPO_URL="https://github.com/the-metafactory/cortex"
PKG_REF="cortex"
SOURCE_URL=""
ARC_REPO_URL="https://github.com/the-metafactory/arc"

# The depends_on.packages auto-install contract (arc-manifest.yaml, cortex#2028):
# `arc install cortex` must cascade-install every one of these bundles.
CASCADE_PKGS=(
  metafactory-cortex-adapter-web
  metafactory-cortex-adapter-slack
  metafactory-cortex-adapter-mattermost
  metafactory-cortex-adapter-discord
  metafactory-cortex-renderer-pagerduty
)

# shellcheck source=deploy/test/lib.sh
. "${SCRIPT_DIR}/lib.sh"

KEEP=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --mode)
      MODE="${2:?--mode needs git|registry}"; shift
      case "${MODE}" in git|registry) ;; *) warn "--mode must be git or registry (got: ${MODE})"; exit 2 ;; esac
      ;;
    --repo) REPO_URL="${2:?--repo needs a URL}"; shift ;;
    --ref) PKG_REF="${2:?--ref needs a package ref}"; shift ;;
    --source) SOURCE_URL="${2:?--source needs a URL}"; shift ;;
    -h|--help)
      sed -n '2,71p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) warn "unknown argument: $1 (supported: --keep --mode --repo --ref --source -h)"; exit 2 ;;
  esac
  shift
done

vexec() { # run a command in the VM (non-login shell; scripts set PATH themselves)
  multipass exec "${VM}" -- "$@"
}

teardown() {
  if [ "${KEEP}" -eq 1 ]; then
    log "--keep: leaving VM ${VM} up for debugging."
    log "  inspect:  multipass shell ${VM}"
    log "  teardown: multipass delete --purge ${VM}"
    return 0
  fi
  log "teardown: multipass delete --purge ${VM}…"
  multipass delete --purge "${VM}" >/dev/null 2>&1 || true
}

finish() { # exit-code
  local rc="$1"
  teardown
  print_summary
  if [ "${rc}" -ne 0 ]; then
    warn "rehearsal FAILED — first failing assertion: ${BENCH_FAILED:-unknown}"
    warn "logs: ${WORKDIR}/"
  else
    log "rehearsal PASSED — all assertion groups green."
  fi
  exit "${rc}"
}

# ── Staged VM-side scripts ───────────────────────────────────────────────────
# All VM-side logic is staged into .work/ (git-ignored, recreated each run)
# and transferred — nothing is quoted inline through `multipass exec`, and the
# staged files are placeholder-only (the fixture is a byte-copy).

stage_scripts() {
  rm -rf "${WORKDIR}"
  mkdir -p "${WORKDIR}"
  cp "${FIXTURE}" "${WORKDIR}/cortex.env"

  # provision.sh — deps + arc, per arc's QUICKSTART (clone + install + link).
  cat >"${WORKDIR}/provision.sh" <<PROVISION
#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -q
sudo apt-get install -y -q git curl unzip ca-certificates >/dev/null

# bun (arc QUICKSTART prerequisite)
curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
export PATH="\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH"
bun --version

# Claude Code CLI (cortex quickstart step-1 preflight requires it on PATH)
curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 \
  || bun install -g @anthropic-ai/claude-code >/dev/null
claude --version

# nats-server (quickstart step-1 preflight)
ARCH="\$(dpkg --print-architecture)"
VER="\$(curl -fsSL https://api.github.com/repos/nats-io/nats-server/releases/latest \
  | grep -o '"tag_name": *"[^"]*"' | head -n1 | cut -d'"' -f4)"
curl -fsSLo /tmp/nats-server.deb \
  "https://github.com/nats-io/nats-server/releases/download/\${VER}/nats-server-\${VER}-\${ARCH}.deb"
sudo dpkg -i /tmp/nats-server.deb >/dev/null
nats-server --version

# systemd linger (quickstart step-1 preflight; step 7 user units survive logout)
sudo loginctl enable-linger "\$USER"
echo "rehearsal: deps ok"

# arc, per its QUICKSTART: clone + bun install + bun link
git clone -q ${ARC_REPO_URL} "\$HOME/arc"
cd "\$HOME/arc"
bun install --silent
bun link >/dev/null
echo "rehearsal: arc ok (\$(arc --version))"
PROVISION

  # install-cortex.sh — the mode-dependent `arc install` leg. Deliberately NOT
  # -y: the capability display only prints on the interactive path, and the
  # rehearsal asserts it is shown. arc's non-TTY guard (src/cli.ts) hard-exits
  # without -y when stdin isn't a terminal, so the install runs under
  # script(1) to allocate a pty. The interactive path DOES block on hook
  # registration ("Allow? [y/N]" per hook-declaring package on
  # community/custom tier, arc install-transaction.ts), so a bounded stream
  # of "y" answers is piped through the pty — 40 covers cortex + every
  # cascade bundle with headroom; never `yes` (unbounded pty echo spam).
  # ({1..40} reaches the VM literally: heredocs do not brace-expand.)
  # --skip-secrets: install-time secret provisioning is out of scope
  # (quickstart's env seam carries the tokens).
  local install_target
  if [ "${MODE}" = "git" ]; then
    install_target="${REPO_URL}"
  else
    install_target="${PKG_REF}"
  fi
  local install_cmd="printf 'y\\n%.0s' {1..40} | script -qec \"arc install ${install_target} --skip-secrets\" /dev/null"
  cat >"${WORKDIR}/install-cortex.sh" <<INSTALL
#!/usr/bin/env bash
set -euo pipefail
export PATH="\$HOME/.bun/bin:\$HOME/.local/bin:\$PATH"

if [ "${MODE}" = "registry" ]; then
  if [ -n "${SOURCE_URL}" ]; then
    arc source add rehearsal "${SOURCE_URL}" --type metafactory --tier community
  fi
  # Operator token (if any) was piped into ~/.arc-rehearsal-token over stdin.
  if [ -s "\$HOME/.arc-rehearsal-token" ]; then
    python3 - <<'PY' || true
import pathlib, re
home = pathlib.Path.home()
tok = (home / ".arc-rehearsal-token").read_text().strip()
src = home / ".config/metafactory/sources.yaml"
if tok and src.exists():
    text = src.read_text()
    if "token:" not in text:
        # append a token line under every metafactory-type source entry
        text = re.sub(r"(?m)^(    type: metafactory)$", r"\1\n    token: " + tok, text)
        src.write_text(text)
PY
    rm -f "\$HOME/.arc-rehearsal-token"
  fi
  arc source update || true
fi

${install_cmd}
INSTALL

  # run-quickstart.sh — placeholder-env quickstart. Never uses set -e around
  # the quickstart call: the gate leg is EXPECTED to fail with dummy tokens;
  # the exit code is captured as a marker line for the host-side assertions.
  cat >"${WORKDIR}/run-quickstart.sh" <<'QUICKSTART'
#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
# multipass exec is a non-login shell: point at the lingering user manager so
# quickstart step 7 can reach `systemctl --user`.
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
set -a; . "$HOME/cortex.env"; set +a
cortex quickstart
rc=$?
echo "rehearsal-quickstart-exit=${rc}"
exit 0
QUICKSTART

  chmod +x "${WORKDIR}/provision.sh" "${WORKDIR}/install-cortex.sh" "${WORKDIR}/run-quickstart.sh"
}

# ── Assertion groups ─────────────────────────────────────────────────────────

# 1. Fresh VM + host deps (bun, claude, nats-server, linger).
group_vm_provision() {
  log "launching fresh Ubuntu LTS VM ${VM} (this can take minutes)…"
  if ! multipass launch --name "${VM}" --cpus 2 --memory 4G --disk 16G lts \
      >"${WORKDIR}/launch.log" 2>&1; then
    record_fail "vm-provision" "multipass launch failed (see .work/launch.log)"
    return 1
  fi
  multipass transfer "${WORKDIR}/provision.sh" "${VM}:${VM_HOME}/provision.sh"
  log "provisioning deps + arc inside the VM (apt, bun, claude, nats-server, arc)…"
  if ! vexec bash "${VM_HOME}/provision.sh" >"${WORKDIR}/provision.log" 2>&1; then
    record_fail "vm-provision" "provision.sh failed (see .work/provision.log)"
    return 1
  fi
  if ! grep -qF "rehearsal: deps ok" "${WORKDIR}/provision.log"; then
    record_fail "vm-provision" "'rehearsal: deps ok' marker missing (see .work/provision.log)"
    return 1
  fi
  record_pass "vm-provision" "fresh ${VM}: git+bun+claude+nats-server+linger ready"
}

# 2. arc installed per its QUICKSTART (same provision.log, own marker).
group_arc_install() {
  local marker
  marker="$(grep -F "rehearsal: arc ok" "${WORKDIR}/provision.log" || true)"
  if [ -z "${marker}" ]; then
    record_fail "arc-install" "'rehearsal: arc ok' marker missing (see .work/provision.log)"
    return 1
  fi
  record_pass "arc-install" "${marker#rehearsal: }"
}

# 3. `arc install` per --mode; capability display shown.
group_cortex_install() {
  multipass transfer "${WORKDIR}/install-cortex.sh" "${VM}:${VM_HOME}/install-cortex.sh"
  if [ "${MODE}" = "registry" ] && [ -n "${ARC_REGISTRY_TOKEN:-}" ]; then
    # stdin pipe only: the token never appears on any argv or staged file.
    printf '%s' "${ARC_REGISTRY_TOKEN}" \
      | vexec bash -c "umask 077; cat > ${VM_HOME}/.arc-rehearsal-token"
  fi
  log "arc install (${MODE} mode) — clones cortex + cascade bundles, runs bun install + postinstall…"
  if ! vexec bash "${VM_HOME}/install-cortex.sh" >"${WORKDIR}/arc-install.log" 2>&1; then
    record_fail "cortex-install" "arc install failed (see .work/arc-install.log)"
    return 1
  fi
  if ! grep -qF "Capabilities:" "${WORKDIR}/arc-install.log"; then
    record_fail "cortex-install" "capability display ('Capabilities:') not shown (see .work/arc-install.log)"
    return 1
  fi
  record_pass "cortex-install" "${MODE} mode install succeeded, capability display shown"
}

# 4. depends_on.packages cascade all present in `arc list --json`.
group_depends_cascade() {
  vexec bash -c 'export PATH="$HOME/.bun/bin:$PATH"; arc list --json' \
    >"${WORKDIR}/arc-list.json" 2>/dev/null || true
  local pkg missing=""
  for pkg in cortex "${CASCADE_PKGS[@]}"; do
    if ! grep -qF "\"${pkg}\"" "${WORKDIR}/arc-list.json"; then
      missing="${missing}${pkg} "
    fi
  done
  if [ -n "${missing}" ]; then
    record_fail "depends-cascade" "missing from arc list --json: ${missing% }(depends_on contract, cortex#2028)"
    return 1
  fi
  record_pass "depends-cascade" "cortex + ${#CASCADE_PKGS[@]} depends_on bundles in arc list --json"
}

# 5. provides.files symlinks resolve and the CLI runs.
group_symlinks() {
  local bin
  for bin in cortex cortex-relay; do
    if ! vexec bash -c "readlink -e \"\$HOME/.local/bin/${bin}\" >/dev/null"; then
      record_fail "symlinks" "~/.local/bin/${bin} missing or dangling"
      return 1
    fi
  done
  if ! vexec bash -c 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; cortex --help >/dev/null 2>&1'; then
    record_fail "symlinks" "cortex --help failed (symlink resolves but CLI does not run)"
    return 1
  fi
  record_pass "symlinks" "cortex + cortex-relay resolve; cortex --help runs"
}

# 6. Placeholder-env quickstart: provisioning steps 1-6 all ✓.
group_quickstart_provisioning() {
  multipass transfer "${WORKDIR}/cortex.env" "${VM}:${VM_HOME}/cortex.env"
  multipass transfer "${WORKDIR}/run-quickstart.sh" "${VM}:${VM_HOME}/run-quickstart.sh"
  log "cortex quickstart with the placeholder env fixture (gate leg expected to fail)…"
  vexec bash "${VM_HOME}/run-quickstart.sh" >"${WORKDIR}/quickstart.log" 2>&1 || true
  local n
  for n in 1 2 3 4 5 6; do
    if ! grep -Eq "── ${n}\. .* ✓ ──" "${WORKDIR}/quickstart.log"; then
      record_fail "quickstart-provisioning" "step ${n} missing or not ✓ (see .work/quickstart.log)"
      return 1
    fi
  done
  record_pass "quickstart-provisioning" "steps 1-6 ✓ on placeholder env"
}

# 7. Expected-fail gate leg: dummy Discord token ⇒ nonzero exit at step 7/8.
#    (An exit-0 here would mean the gate passed on a token that cannot log in
#    — a gate-honesty regression: FILE it, don't trust it.)
group_quickstart_gate() {
  local exit_line rc failing
  exit_line="$(grep -o 'rehearsal-quickstart-exit=[0-9]*' "${WORKDIR}/quickstart.log" | head -n1 || true)"
  if [ -z "${exit_line}" ]; then
    record_fail "quickstart-gate" "quickstart exit marker missing (see .work/quickstart.log)"
    return 1
  fi
  rc="${exit_line#rehearsal-quickstart-exit=}"
  if [ "${rc}" = "0" ]; then
    record_fail "quickstart-gate" "quickstart exited 0 with a PLACEHOLDER Discord token — gate honesty regression, file it"
    return 1
  fi
  failing="$(grep -E '── [78]\. .* ✗ ──' "${WORKDIR}/quickstart.log" | head -n1 || true)"
  if [ -z "${failing}" ]; then
    record_fail "quickstart-gate" "exit ${rc} but no ✗ at step 7/8 — failed earlier than the token leg (see .work/quickstart.log)"
    return 1
  fi
  record_pass "quickstart-gate" "expected fail: exit ${rc} at ${failing} (steps 7-8 need real tokens — D2 manual leg)"
}

# ── Scenario ─────────────────────────────────────────────────────────────────

main() {
  command -v multipass >/dev/null 2>&1 || { warn "multipass not found on PATH"; exit 2; }
  [ -f "${FIXTURE}" ] || { warn "fixture missing: ${FIXTURE}"; exit 2; }
  if [ "${MODE}" = "git" ] && [ -n "${ARC_REGISTRY_TOKEN:-}" ]; then
    log "note: ARC_REGISTRY_TOKEN is set but --mode git never uses it."
  fi

  log "install-rehearsal bench (cortex#2287) — VM ${VM}, mode ${MODE}"
  stage_scripts

  # Idempotent start: a leftover VM from a --keep / crashed run is purged.
  if multipass info "${VM}" >/dev/null 2>&1; then
    log "found existing ${VM} — deleting for a fresh run (idempotent start)…"
    multipass delete --purge "${VM}" >/dev/null 2>&1 || true
  fi

  local groups=(group_vm_provision group_arc_install group_cortex_install
                group_depends_cascade group_symlinks group_quickstart_provisioning
                group_quickstart_gate)
  local names=(vm-provision arc-install cortex-install depends-cascade
               symlinks quickstart-provisioning quickstart-gate)
  local i failed=0
  for i in "${!groups[@]}"; do
    if [ "${failed}" -eq 1 ]; then
      record_skip "${names[$i]}" "not reached (fail-fast)"
      continue
    fi
    if ! "${groups[$i]}"; then
      failed=1
    fi
  done

  finish "${failed}"
}

main "$@"
