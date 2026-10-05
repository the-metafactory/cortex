#!/usr/bin/env bash
#
# provision.sh — create the first off-Mac cortex host on Hetzner Cloud, headless.
# Runs on YOUR Mac. Needs: hcloud CLI with an active context (or HCLOUD_TOKEN),
# an SSH public key, and a Tailscale pre-auth key (TS_AUTHKEY).
#
# Creates: an SSH key entry, a firewall with NO inbound rules (Hetzner drops all
# inbound), and one server that joins your tailnet as tag:cortex-host. You reach
# it only over Tailscale: ssh ops@<NAME>.
#
# Dry-run by default — prints the plan. Pass --apply to create resources (this
# spends money: ~€11/month for cax21).
#
#   TS_AUTHKEY=tskey-auth-... ./provision.sh --apply
#
# TS_AUTHKEY must be: single-use (not reusable), pre-approved, tagged
# tag:cortex-host, expiry 1 hour. It ends up in user-data, which is why it must
# be one-shot (see cloud-init.yaml).
#
# Break-glass (tailnet down): there is deliberately no public SSH path, because
# ufw on the host only allows tcp/22 on tailscale0. Recover with the Hetzner
# rescue system: hcloud server enable-rescue <NAME> --ssh-key <NAME>-key, then
# hcloud server reboot <NAME>, then ssh root@<public-ip>, mount the disk and fix it.
# (Rescue needs a temporary inbound rule, which is added and removed by hand.)

set -euo pipefail

NAME="${NAME:-cortex-eu-1}"
TYPE="${TYPE:-cax21}"            # 4 vCPU ARM, 8 GB — see design §8.1 sizing
LOCATION="${LOCATION:-fsn1}"     # fsn1 Falkenstein · nbg1 Nuremberg · hel1 Helsinki
IMAGE="${IMAGE:-ubuntu-24.04}"
CORTEX_REF="${CORTEX_REF:-v6.15.0}"
SSH_PUBKEY="${SSH_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

here="$(cd "$(dirname "$0")" && pwd)"
command -v hcloud >/dev/null || { echo "hcloud CLI missing: brew install hcloud" >&2; exit 1; }
[ -f "$SSH_PUBKEY" ] || { echo "SSH public key not found: $SSH_PUBKEY" >&2; exit 1; }

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# Firewall: empty rule set = all inbound dropped.
echo '[]' > "$workdir/firewall-rules.json"
fw_desc="no inbound rules (all inbound dropped); access via Tailscale only"

echo "Plan:"
echo "  server    $NAME  type=$TYPE  location=$LOCATION  image=$IMAGE"
echo "  tailnet   joins as $NAME, tag:cortex-host (SSH via tailnet only)"
echo "  cortex    $CORTEX_REF (cloned to /opt/cortex, not started — no secrets yet)"
echo "  firewall  $NAME-fw: $fw_desc"
echo "  ssh key   $NAME-key from $SSH_PUBKEY"
if [ "$APPLY" -ne 1 ]; then
  echo
  echo "Dry run. Re-run with --apply to create (spends money)."
  exit 0
fi

hcloud ssh-key describe "$NAME-key" >/dev/null 2>&1 \
  || hcloud ssh-key create --name "$NAME-key" --public-key-from-file "$SSH_PUBKEY"

if hcloud firewall describe "$NAME-fw" >/dev/null 2>&1; then
  hcloud firewall replace-rules "$NAME-fw" --rules-file "$workdir/firewall-rules.json"
else
  hcloud firewall create --name "$NAME-fw" --rules-file "$workdir/firewall-rules.json"
fi

if hcloud server describe "$NAME" >/dev/null 2>&1; then
  echo "server $NAME already exists — not recreating (firewall rules updated)."
  exit 0
fi

: "${TS_AUTHKEY:?set TS_AUTHKEY to a single-use, pre-approved, tag:cortex-host key (1h expiry)}"
case "$TS_AUTHKEY" in tskey-auth-*) ;; *) echo "TS_AUTHKEY doesn't look like a Tailscale auth key" >&2; exit 1;; esac

# Render cloud-init. The rendered file holds the auth key; it lives only in the
# temp dir (removed on exit) and the server's user-data.
pubkey="$(cat "$SSH_PUBKEY")"
umask 077
sed -e "s|__SSH_PUBKEY__|${pubkey}|" \
    -e "s|__CORTEX_REF__|${CORTEX_REF}|" \
    -e "s|__TS_AUTHKEY__|${TS_AUTHKEY}|" \
    -e "s|__HOSTNAME__|${NAME}|" \
  "$here/cloud-init.yaml" > "$workdir/cloud-init.yaml"

hcloud server create \
  --name "$NAME" \
  --type "$TYPE" \
  --image "$IMAGE" \
  --location "$LOCATION" \
  --ssh-key "$NAME-key" \
  --firewall "$NAME-fw" \
  --user-data-from-file "$workdir/cloud-init.yaml" \
  --label role=cortex-host --label stage=phase1

echo
echo "Server $NAME created. It has no reachable public port."
echo "Wait for cloud-init (~3-5 min); it appears in your tailnet as $NAME. Then:"
echo "  ssh ops@$NAME 'test -f /var/lib/cloud/instance/cortex-host-ready && echo ready'"
echo "Next: HOST=$NAME ./push-env-and-start.sh"
