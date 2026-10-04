#!/usr/bin/env bash
#
# provision.sh — create the first off-Mac cortex host on Hetzner Cloud, headless.
# Runs on YOUR Mac. Needs: hcloud CLI, an active hcloud context (or HCLOUD_TOKEN),
# and an SSH public key. Creates: an SSH key entry, a firewall (SSH from your IP
# only, nothing else inbound), and one server with secret-free cloud-init.
#
# Dry-run by default — prints the plan. Pass --apply to create resources (this
# spends money: ~€11/month for cax21).
#
#   ./provision.sh                 # show what would be created
#   ./provision.sh --apply         # create it
#
# Override defaults with env vars:
#   NAME=cortex-eu-1 TYPE=cax21 LOCATION=fsn1 CORTEX_REF=v6.15.0 \
#   SSH_PUBKEY=~/.ssh/id_ed25519.pub ./provision.sh --apply

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

MY_IP="$(curl -fsS https://api.ipify.org)"
[ -n "$MY_IP" ] || { echo "could not determine your public IP" >&2; exit 1; }

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# Render cloud-init (public key + pinned ref only — no secrets).
pubkey="$(cat "$SSH_PUBKEY")"
sed -e "s|__SSH_PUBKEY__|${pubkey}|" -e "s|__CORTEX_REF__|${CORTEX_REF}|" \
  "$here/cloud-init.yaml" > "$workdir/cloud-init.yaml"

cat > "$workdir/firewall-rules.json" <<EOF
[
  { "direction": "in", "protocol": "tcp", "port": "22",
    "source_ips": ["${MY_IP}/32"], "description": "SSH from principal only" }
]
EOF

echo "Plan:"
echo "  server    $NAME  type=$TYPE  location=$LOCATION  image=$IMAGE"
echo "  cortex    $CORTEX_REF (cloned to /opt/cortex, not started — no secrets yet)"
echo "  firewall  $NAME-fw: inbound tcp/22 from ${MY_IP}/32 only; everything else dropped"
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
  echo "server $NAME already exists — not recreating."
else
  hcloud server create \
    --name "$NAME" \
    --type "$TYPE" \
    --image "$IMAGE" \
    --location "$LOCATION" \
    --ssh-key "$NAME-key" \
    --firewall "$NAME-fw" \
    --user-data-from-file "$workdir/cloud-init.yaml" \
    --label role=cortex-host --label stage=phase1
fi

IP="$(hcloud server ip "$NAME")"
echo
echo "Server: $NAME at $IP"
echo "Wait for cloud-init (~3-5 min), then:"
echo "  ssh ops@$IP 'test -f /var/lib/cloud/instance/cortex-host-ready && echo ready'"
echo "Next: HOST=$IP ./push-env-and-start.sh"
