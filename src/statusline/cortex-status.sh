#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Cortex Status Line Extension  —  see cortex#96
# ═══════════════════════════════════════════════════════════════════════════════
#
# Sourced by cortex's statusline-command.sh to display operator context:
#   - Channel/network (from GROVE_CHANNEL env var — kept during cutover)
#   - Agent identity (from GROVE_AGENT_NAME)
#   - Cloud/local mode and connection status
#
# Requires: GROVE_CHANNEL set (e.g., via cldyo-live).
# Without GROVE_CHANNEL, this extension is a no-op (returns silently).
#
# NOTE: the bot.yaml config path is read cortex-first with a `~/.config/grove/`
# fallback during the GV-1 transition (cortex#1076). The `GROVE_*` ENV VARS are
# left as-is — they are owned by the separate GROVE_* → CORTEX_* env-var shim
# (cortex#774) and are out of scope for GV-1.
#
# Install: arc lays this file down at $PAI_DIR/cortex-status.sh; the cortex
# statusline-command.sh sources it explicitly.
# ═══════════════════════════════════════════════════════════════════════════════

# Skip if no cortex/grove context is active
[ -z "$GROVE_CHANNEL" ] && return 0 2>/dev/null

# ─── Colors ───────────────────────────────────────────────────────────────────
CORTEX_GREEN='\033[38;2;74;222;128m'    # Green-400
CORTEX_LABEL='\033[38;2;148;163;184m'   # Slate-400
CORTEX_VALUE='\033[38;2;203;213;225m'   # Slate-300
CORTEX_DIM='\033[38;2;100;116;139m'     # Slate-500
CORTEX_SEP='\033[38;2;71;85;105m'       # Slate-600
CORTEX_CLOUD='\033[38;2;96;165;250m'    # Blue-400
CORTEX_LOCAL='\033[38;2;251;191;36m'    # Amber-400
CORTEX_RESET='\033[0m'

# ─── Read bot config ──────────────────────────────────────────────────────────
# cortex-first, grove-fallback (GV-1, cortex#1076 — see header note).
if [ -f "${HOME}/.config/cortex/bot.yaml" ]; then
    CORTEX_CONFIG="${HOME}/.config/cortex/bot.yaml"
else
    CORTEX_CONFIG="${HOME}/.config/grove/bot.yaml"
fi
cortex_mode=""
cortex_network=""
cortex_operator=""

if [ -f "$CORTEX_CONFIG" ]; then
    # Simple YAML parse — assumes bot.yaml structure (top-level keys, no nesting ambiguity)
    cortex_mode=$(grep -A5 '^api:' "$CORTEX_CONFIG" | grep 'mode:' | head -1 | sed 's/.*mode:\s*//' | sed 's/#.*//' | tr -d '"' | tr -d "'" | xargs)
    cortex_mode="${cortex_mode:-local}"

    # Extract operatorId
    cortex_operator=$(grep -A4 '^agent:' "$CORTEX_CONFIG" | grep 'operatorId:' | head -1 | sed 's/.*operatorId:\s*//' | sed 's/#.*//' | tr -d '"' | tr -d "'" | xargs)
fi

# Network: from env, or derive from config (default: "metafactory" for cloud, "local" otherwise)
cortex_network="${GROVE_NETWORK:-}"
if [ -z "$cortex_network" ]; then
    if [ "$cortex_mode" = "cloud" ]; then
        cortex_network="metafactory"
    else
        cortex_network="local"
    fi
fi

# ─── Render ───────────────────────────────────────────────────────────────────
# Called by the cortex statusline after sourcing. Prints the cortex context line.
# MODE is inherited from the parent statusline (nano/micro/mini/normal).

render_cortex_status() {
    local mode="${MODE:-normal}"
    local channel="${GROVE_CHANNEL}"
    local agent="${GROVE_AGENT_NAME:-${cortex_operator:-unknown}}"

    # Mode indicator
    local mode_icon mode_color mode_label
    if [ "$cortex_mode" = "cloud" ]; then
        mode_icon="cloud"
        mode_color="$CORTEX_CLOUD"
        mode_label="cloud"
    else
        mode_icon="local"
        mode_color="$CORTEX_LOCAL"
        mode_label="local"
    fi

    local network="${cortex_network}"

    case "$mode" in
        nano)
            printf "${CORTEX_GREEN}C${CORTEX_RESET} ${CORTEX_VALUE}${channel}${CORTEX_RESET}\n"
            ;;
        micro)
            printf "${CORTEX_GREEN}C${CORTEX_RESET} ${CORTEX_VALUE}${channel}${CORTEX_RESET} ${mode_color}${mode_label}${CORTEX_RESET}\n"
            ;;
        mini)
            printf "${CORTEX_GREEN}C${CORTEX_RESET} ${CORTEX_LABEL}ch:${CORTEX_RESET}${CORTEX_VALUE}${channel}${CORTEX_RESET} ${CORTEX_SEP}|${CORTEX_RESET} ${mode_color}${mode_label}${CORTEX_RESET} ${CORTEX_SEP}|${CORTEX_RESET} ${CORTEX_LABEL}op:${CORTEX_RESET}${CORTEX_VALUE}${agent}${CORTEX_RESET}\n"
            ;;
        normal)
            printf "${CORTEX_GREEN}C${CORTEX_RESET} ${CORTEX_LABEL}Channel:${CORTEX_RESET} ${CORTEX_VALUE}${channel}${CORTEX_RESET}"
            printf " ${CORTEX_SEP}|${CORTEX_RESET} ${CORTEX_LABEL}Operator:${CORTEX_RESET} ${CORTEX_VALUE}${agent}${CORTEX_RESET}"
            printf " ${CORTEX_SEP}|${CORTEX_RESET} ${CORTEX_LABEL}Mode:${CORTEX_RESET} ${mode_color}${mode_label}${CORTEX_RESET}"
            printf " ${CORTEX_SEP}|${CORTEX_RESET} ${CORTEX_LABEL}Network:${CORTEX_RESET} ${CORTEX_VALUE}${network}${CORTEX_RESET}"
            printf "\n"
            ;;
    esac
}

# Statusline contract: print to stdout when sourced.
# The cortex statusline sources this file and captures stdout.
render_cortex_status
