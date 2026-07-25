#!/bin/bash
set -e

# Cortex purge (cortex#2338) — `arc purge cortex`'s scripts.purge hook.
#
# Fires via arc's `scripts.purge` (arc#359, arc/src/commands/purge.ts step 4):
# AFTER `arc remove cortex` (which already ran scripts.preremove — Linux
# instance disable, while the config dir was still intact — see
# preremove.sh) AND after arc deletes cortex's declared owns.config/
# owns.state trees. Handles the one leftover class that can't be a static
# `owns:` path AND can't rely on the (by then deleted) config dir to
# discover: LIVE supervised per-stack instances.
#
# See scripts/lib/purge-supervision.sh's header for why this is
# supervisor-native (systemctl unit-glob / launchd LaunchAgents
# filename-glob) rather than config-dir-based stack discovery.
#
# Non-aborting per the arc contract (arc's purge continues + warns regardless
# of this script's exit code) — scripted defensively anyway, matching every
# other lifecycle script in this repo.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/purge-supervision.sh
source "${SCRIPT_DIR}/lib/purge-supervision.sh"

echo "Running Cortex purge..."
purge_systemd_instances
purge_launchd_instances
# cortex#2420: name the shared-substrate dirs purge deliberately leaves behind
# (~/.claude/{events,relay}, ~/.config/nats) so a field tester who finds them
# still on disk knows they were KEPT on purpose, not missed — closing the
# arc#359 "purge left leftovers" surprise without deleting a neighbor's state.
report_intentionally_kept_shared_state
echo "✓ Cortex purge complete"
