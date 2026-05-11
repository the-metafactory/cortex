## PAI Integration

cortex provides two ways to integrate from PAI sessions (outside of Discord):

### Session Instrumentation (live dashboard)

Any Claude Code session can pipe events to the cortex Mission Control dashboard by setting env vars:

```bash
CORTEX_CHANNEL=<name> CORTEX_AGENT_NAME=<display> CORTEX_AGENT_ID=<id> claude
```

| Env Var | Purpose | Example |
|---------|---------|---------|
| `CORTEX_CHANNEL` | **Required.** Enables the EventLogger hook. Value is the channel/identity label. | `andreas` |
| `CORTEX_AGENT_NAME` | Display name shown on dashboard agent cards. | `Andreas` |
| `CORTEX_AGENT_ID` | Agent identifier for event correlation. | `andreas` |

During the MIG-7 cutover window the legacy `GROVE_*` env vars remain accepted by the EventLogger for backward compatibility; new sessions should prefer the `CORTEX_*` names. The deprecation shim retires at MIG-8.

**Event pipeline:** CC hooks → `~/.claude/events/raw/` → cortex-relay (policy filter) → `~/.claude/events/published/` → cortex-bot → bus → dashboard API → `cortex.meta-factory.ai`

**Pre-configured wrapper:** `cldyo-live` (at `~/.local/bin/`) starts an instrumented Opus session. Plain `cldyo` stays dark (no events). Use `cldyo-live` when you want your work visible on the dashboard.

### Discord CLI (team updates)

Post messages to Discord channels from any terminal session:

```bash
discord post "PR merged, tests passing"              # Default channel
discord post --channel tasks "Deployed v0.5.0"       # Specific channel
discord post --thread 1487204875912609844 "Done"     # Specific thread
discord read                                          # Read last 10 messages
```

Useful at the end of workflows to update the team. See `discord --help` for full command list.
