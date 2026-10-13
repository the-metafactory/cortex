#!/usr/bin/env bash
#
# push-env-and-start.sh — deliver the stack's .env over SSH (never via cloud-init)
# and start the compose stack. Runs on YOUR Mac. Headless: no console, no
# interactive login on the server.
#
#   HOST=<server-ip> ENV_FILE=./cortex-eu-1.env ./push-env-and-start.sh
#
# ENV_FILE is your filled copy of deploy/compose/.env.example. Keep it OUTSIDE
# any git repo (e.g. ~/.config/metafactory/cortex/hosts/), chmod 600.

set -euo pipefail

HOST="${HOST:?set HOST=<server ip>}"
ENV_FILE="${ENV_FILE:?set ENV_FILE=<path to filled .env>}"
REMOTE_DIR="/opt/cortex/deploy/compose"
# Must match the tag cloud-init cloned: compose's own default is older (v6.10.3).
CORTEX_REF="${CORTEX_REF:-v6.15.0}"

[ -f "$ENV_FILE" ] || { echo "no such file: $ENV_FILE" >&2; exit 1; }
if grep -q "<REPLACE_ME>" "$ENV_FILE"; then
  echo "$ENV_FILE still has <REPLACE_ME> placeholders" >&2; exit 1
fi
for k in CTX_DISCORD_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do
  grep -Eq "^${k}=.+" "$ENV_FILE" || { echo "$k is empty in $ENV_FILE" >&2; exit 1; }
done

ssh "ops@$HOST" 'test -f /var/lib/cloud/instance/cortex-host-ready' \
  || { echo "cloud-init not finished on $HOST yet" >&2; exit 1; }

# Stream the file over SSH into a 0600 file (umask 077 before it exists, so it is
# never world-readable, not even briefly). Contents never touch argv or the terminal.
# shellcheck disable=SC2029  # REMOTE_DIR is meant to expand locally
ssh "ops@$HOST" "umask 077 && cat > $REMOTE_DIR/.env" < "$ENV_FILE"

# shellcheck disable=SC2029
# Build on the host (ARM64; the Dockerfile follows TARGETARCH) and start.
ssh "ops@$HOST" "cd $REMOTE_DIR && CORTEX_REF=$CORTEX_REF docker compose build && CORTEX_REF=$CORTEX_REF docker compose up -d"

echo "Started. Check with:"
echo "  ssh ops@$HOST 'cd $REMOTE_DIR && docker compose ps'"
echo "  ssh ops@$HOST 'cd $REMOTE_DIR && docker compose logs cortex | grep -E \"Stack:|connected|quickstart\"'"
