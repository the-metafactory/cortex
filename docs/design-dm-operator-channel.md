# DM Principal Channel — Design Spec

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-dm-operator-channel.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Feature:** G-300: Principal DM as Elevated Privilege Channel
**Scope:** Discord DM support with role-based privilege escalation for principal, standard guards for users
**Mission:** The principal can DM Luna directly for full-privilege sessions — Write, Edit, Agent, unrestricted Bash — while user DMs maintain the same guards as guild channels.
**Stack:** discord.js (existing), PlatformAdapter (F-007), role-resolver, bash-guard hook
**Prerequisite:** PlatformAdapter (F-007) ✅, Bash Guard (v0.4.0) ✅

---

## Why This Exists

Luna can send DMs to the principal (notifications), but can't receive them. All interaction must happen in guild channels, where:

1. **Permissions are conservative** — Write/Edit/Bash are restricted because other users can see and interact in the same channel, and prompt injection via message history is a risk.
2. **The principal must use a separate terminal** for tasks requiring full tool access (code changes, deployments, file writes).

DMs solve this. A DM from the principal is **inherently trusted**:
- Only one person in the conversation — no prompt injection from other users
- No public visibility — safe to discuss sensitive operations
- Identity verified by Discord — the principal's Discord ID is already in bot.yaml

This makes DM the natural channel for elevated privileges without weakening guild security.

---

## Features

### G-300: Principal DM with Elevated Privileges

**Discord Client Changes:**

Add `GatewayIntentBits.DirectMessages` and `Partials.Channel` to the client intents. Without these, Discord's gateway never delivers DM events.

```typescript
// discord-client.ts
import { Client, GatewayIntentBits, Partials } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,    // NEW
  ],
  partials: [Partials.Channel],           // NEW — required for DM channels
});
```

**Message Detection:**

DMs don't use @mentions. In `DiscordAdapter.messageCreate`, detect DM channels and process the message directly:

```typescript
import { ChannelType } from "discord.js";

// In messageCreate handler:
const isDM = message.channel.type === ChannelType.DM;

if (isDM) {
  // No mention required — user is talking directly to the bot
  // Use message.content as-is (no mention stripping)
} else {
  // Existing guild logic: require @mention, strip mention prefix
  if (!isMentionForBot(message, client)) return;
}
```

**Role Resolution for DMs:**

```yaml
# bot.yaml — new dm section
discord:
  - instanceId: "main"
    # ... existing config ...
    dm:
      operatorRole:
        features: ["chat", "async", "team"]
        disallowedTools: []                    # Full tool access
        allowedDirs: ["~/Developer/grove", "~/Developer/meta-factory", "~/Developer/arc"]
        bashGuard: true                        # Keep bash guard active with broader rules
        bashAllowlist:                         # More permissive than guild channel
          rules:
            - pattern: "^gh\\s+"               # All gh subcommands
            - pattern: "^git\\s+"              # All git subcommands (including write ops)
            - pattern: "^bun\\s+"              # Bun commands
            - pattern: "^npm\\s+"              # npm commands
            - pattern: "^ls\\b"
            - pattern: "^pwd$"
            - pattern: "^cat\\b"
            - pattern: "^mkdir\\b"
            - pattern: "^cp\\b"
            - pattern: "^mv\\b"
            - pattern: "^rm\\b"
            - pattern: "^curl\\b"
          repos:
            - "the-metafactory/meta-factory"
            - "the-metafactory/grove"
            - "mellanon/arc"
      defaultRole: denied                      # Unknown DMs are ignored
      userRoles:                               # Optional: per-user DM roles
        - users: ["285727653603049472"]        # Jens-Christian Fischer
          features: ["chat"]
          disallowedTools: ["Write", "Edit", "NotebookEdit"]
          bashGuard: true                      # Same guards as guild channel
```

**Privilege Model:**

| Channel Type | Identity | Tools | Dirs | Bash Guard | Session Resume |
|-------------|----------|-------|------|------------|----------------|
| Guild channel | Per-role config | Restricted | Per role | Full allowlist | Per thread |
| Guild thread | Per-role config | Restricted | Per role | Full allowlist | Per thread |
| **Principal DM** | `operatorDiscordId` match | **Full** (Write, Edit, Agent, Bash) | All configured | **Broader allowlist** (git write, bun, rm, curl) | Per DM conversation |
| **User DM** | Per `dm.userRoles` | Same as guild role | Same as guild role | Same as guild | Per DM conversation |
| **Unknown DM** | Not in any role | **Denied** | — | — | — |

**Security Preamble Adjustments:**

Principal DM sessions get a lighter security preamble:
- Filesystem restriction: skipped in preamble (enforced at invocation level via `--add-dir`)
- Bash guard: active with broader allowlist (configured per DM role in bot.yaml)
- Config immutability: **still enforced** — even the principal shouldn't modify bot.yaml via the bot
- Verification rule: **still enforced** — don't hallucinate code

User DM sessions get the same security preamble as their guild role.

**Audit Logging:**

All DM access is logged for audit purposes:
- `[DM-REJECT]` — unknown user DMs logged with user ID and message preview
- `[DM-ACCESS]` — accepted DMs logged with user classification and bash guard status

**Session Management:**

DM conversations are persistent (like threads). The DM channel ID is stable per user pair, so session resume works naturally:
- Principal DM: resume enabled, session persists across messages
- User DM: resume enabled, same as guild threads

**CCSession Construction for Principal DM:**

```typescript
const session = new CCSession({
  prompt,
  groveChannel: config.agent.name,
  timeoutMs: config.claude.asyncTimeoutMs,  // Longer timeout for principal
  disallowedTools: [],                       // Nothing blocked
  allowedDirs: operatorDirs,
  bashAllowlist: dmRole.bashAllowlist,       // Broader allowlist from DM config
});
```

---

## Implementation

### Files to Change

| File | Change |
|------|--------|
| `src/bot/lib/discord-client.ts` | Add `DirectMessages` intent + `Partials.Channel` |
| `src/bot/lib/adapters/discord.ts` | Detect DM in messageCreate, skip mention check, set `isDM` flag on InboundMessage |
| `src/bot/lib/adapters/types.ts` | Add `isDM?: boolean` and `dmType?: "principal" \| "user"` to `InboundMessage` |
| `src/bot/lib/role-resolver.ts` | Add `resolveDMAccess()` — check operatorDiscordId, then dm.userRoles, then deny |
| `src/bot/lib/message-router.ts` | Use DM role when `msg.isDM`, skip bash guard for principal DM |
| `src/bot/lib/security-preamble.ts` | Accept context flag for DM-mode (relaxed preamble for principal) |
| `src/bot/types/config.ts` | Add `dm` config section to Discord instance schema |
| `~/.config/grove/bot.yaml` | Add DM role configuration |

### New Code: ~80 lines across existing files. No new files needed.

---

## Acceptance Criteria

- [ ] Bot receives DM messages (DirectMessages intent + Partials.Channel)
- [ ] DM from principal: full tool access (Write, Edit, Agent, Bash without guard)
- [ ] DM from configured user: same restrictions as guild role
- [ ] DM from unknown user: silently ignored (defaultRole: denied)
- [ ] No @mention required in DMs — just type the message
- [ ] Session resume works in DM (persistent conversation)
- [ ] Config immutability still enforced in principal DM
- [ ] Principal DM sessions use longer timeout (asyncTimeoutMs)
- [ ] Guild channel security unchanged — no regression

---

## Not In Scope

- Group DMs (only 1:1 DMs)
- DM-initiated async/team tasks (future — start with sync chat)
- Cross-platform DM (Mattermost DMs are a separate feature)
- DM notifications back to principal about DM sessions (circular)

---

## Dependencies

| Dependency | Status | Impact |
|-----------|--------|--------|
| discord.js v14 DM support | Have | `ChannelType.DM`, `Partials.Channel` |
| PlatformAdapter (F-007) | Merged | DM is just another message source |
| Bash Guard (v0.4.0) | Deployed | Principal DM bypasses it; user DM keeps it |
| Role resolver | Have | Extended for DM role resolution |
