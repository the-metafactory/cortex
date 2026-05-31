# F-11 — Discord notifications (pre-implementation addendum)

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/design-mc-f11-discord-notifications.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Addendum to:** `docs/design-mission-control.md` §4 (Notification system) — specifically §4.1 (channels), §4.2 (routing), §4.3 (opt-in toggle), §4.4 (deep links).
**Date:** 2026-04-24.
**Status:** Decided. Resolves the open questions enumerated below before F-11 implementation begins.

## Why this addendum

§4 is deliberately compact: Discord only, a ~10-line hardcoded `shouldNotify` priority map, a one-bit `bot.yaml` toggle, deep links keyed off `grove.baseUrl`. That is correct posture — "don't build a traffic-shaping system before there is traffic" (§4.2) — but the concrete shape of the DM-vs-channel split, the coalescing behaviour, the payload format, the interaction with the existing grove-bot v1 channel routing SOP, and the full transition matrix have all been deferred to implementation time. F-6 / F-7 / F-8 / F-9 / F-10 / image-input each shipped with a pre-implementation addendum; F-11 follows the same discipline so code review can focus on code against decided criteria rather than rediscovering the design at PR time.

Crucially: the notification *hook points* already exist. `applyTransition` in `src/mission-control/db/transitions.ts` is called from two production sites — `src/mission-control/api/handlers.ts:347` (principal-driven transitions) and `src/mission-control/session/stdout-dispatcher.ts:157` (stream-json-driven transitions). Both call `broadcastTransition` from `src/mission-control/notifications.ts` immediately after. F-11 adds a **third** call at the same two sites: `maybeNotifyDiscord(...)`. No new dispatcher, no new pipeline, no new daemon — one more function call where the truth is already in hand. This addendum keeps the scope honest to that reality.

**Invariant the implementer must absorb — call-site is fired twice per spawn, coalesce in the hook, not in the loop.** `handlers.ts:347` sits inside `for (const action of [{ type: "dispatch" }, { type: "start" }])` — a single POST to create a session drives two consecutive transitions (`queued → dispatched` and `dispatched → running`), each followed by its own `broadcastTransition`. When F-11's `maybeNotifyDiscord(...)` is added after `broadcastTransition` at the ~354 call site, it will be invoked **twice** per spawn. Decision 1's matrix already marks both of those transitions as ❌ Notify=No, so the default output is zero DMs and zero channel posts. This is correct, and the implementer must not try to "fix" the double-fire by hoisting the call outside the loop or by adding a per-spawn guard at the call site — doing so would desynchronise F-11 from the canonical transition stream and silently drop any future transition that *does* opt into notification from that site. Coalescing / dedup is the `discord-sink`'s job (Decision 7's 5 s per-assignment window), not the loop's.

## Decision 1 — Transition matrix: the exact set that triggers a notification

§4.2's `shouldNotify` sketch branches on `event.to` and `event.blockReason?.kind`. Enumerated concretely, for every `(from, to)` pair the state machine can produce:

| Transition | Notify? | Channel | Urgency | Rationale |
|---|---|---|---|---|
| `* → blocked` (kind=`permission.request`, risk=`high`) | ✅ | DM + channel ping | high | Principal is the bottleneck; high-risk tool use wants a second of attention before approval |
| `* → blocked` (kind=`permission.request`, risk=`medium`/`low`, priority ≤ 1) | ✅ | DM | high | Lower-risk but P0/P1 — principal still needs to unblock |
| `* → blocked` (kind=`permission.request`, risk=`medium`/`low`, priority ≥ 2) | ✅ | DM | normal | Default permission block — DM, no ping |
| `* → blocked` (kind=`tool.error`, priority ≤ 1) | ✅ | DM | high | P0/P1 blocker — principal intervention likely needed |
| `* → blocked` (kind=`tool.error`, priority ≥ 2) | ✅ | DM | normal | Background failure that may still need eyes |
| `* → blocked` (kind=`review.checkpoint`) | ✅ | DM | normal | Agent asked for human sign-off explicitly |
| `* → failed` | ✅ | channel | normal | Post-mortem context, not urgent — lands in the repo thread |
| `* → completed` (priority = 0) | ✅ | channel | low | P0 deserves a silent positive signal in the repo thread |
| `* → completed` (priority ≥ 1) | ❌ | — | — | Noise; dashboard renders this, push doesn't need to |
| `* → cancelled` | ❌ | — | — | Principal-driven terminal; already knows |
| `blocked → running` | ❌ | — | — | Self-resolved block (agent retried and succeeded) — dashboard's job |
| `blocked → completed`/`failed` | ❌ | — | — | Follows the terminal rule above — if the principal cared about the block they'll see the outcome when they open the drill-down |
| `queued → dispatched` | ❌ | — | — | Mechanical progress; dashboard signal only |
| `dispatched → running` | ❌ | — | — | Ditto |
| `running → running` (no-op from state-machine perspective; doesn't happen) | ❌ | — | — | N/A |
| `principal.input.requested` event (not a transition) | ✅ | DM | normal | Surfaced as a block-reason-shaped notification — see Decision 2 |

**Decision surface.** The matrix above is what `shouldNotify` actually codifies. §4.2's sketch is a 6-line prose summary of the first three rows plus `failed` + `completed`; the above matrix is the full truth. The implementation lives in one file (`src/mission-control/notifications/should-notify.ts`, new), pure function, fully unit-testable from the transition + task inputs alone.

**`principal.input.requested` is not a state transition** — it's an event type in the `events` table (§5.1 input channel; used when an agent asks a specific question during a `running` turn without changing state). It's still notification-worthy because the principal is the addressee. F-11 adds a small shim: `maybeNotifyInputRequested(ev)` called from the same call sites that emit the event, routed through the same `shouldNotify` output shape. Same function family, different trigger.

## Decision 2 — DM vs channel: one recipient set, two audiences, two payloads

Two surfaces, two distinct jobs.

**DM** goes to `config.agent.operatorDiscordId`. Reserved for things that require principal action — blocks, permission requests, `principal.input.requested`. One audience: the principal. One payload shape: "something is waiting for you, here's the minimum context to decide if you care".

**Channel post** goes to the repo thread (Decision 5) or failing that `discord.agentChannelId`. Reserved for broadcast-worthy outcomes — failures and P0 completions. Audience: the principal AND anyone else watching the repo channel. Payload shape: "this happened, here's the link, scroll on".

**Never both for the same event.** The matrix above explicitly assigns each notification-worthy transition to one of `dm` or `channel`, not both. The single-exception is **`blocked` with risk=`high` or priority ≤ 1** — those get a DM AND a role ping (`<@&{operatorRoleId}>` if `discord.operatorRoleId` is set, no ping otherwise) in the channel. The ping is the second audience, not a duplicate notification — it's the "yes, really, look now" escalation for the subset of blocks that warrant interrupting whatever else the principal or team is doing. Channel post here is context for everyone; DM is the actionable copy. Two roles, two payloads.

**Why not always dual-post.** The noise-to-signal ratio collapses instantly. An principal with twenty `blocked` DMs stacked up has twenty actionable items. The same principal with twenty DMs AND twenty channel posts has to learn which is canonical. DM-for-action, channel-for-record is the Discord convention principals already live in (GitHub app, PagerDuty bot, everything else), so F-11 inherits it without surprise.

**No direct-mention in DMs.** DMs are 1:1 — the pinged-user-by-content pattern is pointless (the principal IS the recipient). DM copy omits `<@...>` mentions entirely.

## Decision 3 — Priority × attention-type routing table (concrete)

Decision 1's matrix covers every transition. This decision pins the **full payload shape** per cell that gets DM or channel copy. The intent is that a principal can print this table, tape it to a wall, and predict every notification Grove will send.

| priority | to-state | block-reason.kind | risk | Channel | Role ping | DM urgency heuristic |
|---|---|---|---|---|---|---|
| P0 | `blocked` | `permission.request` | `high` | DM + channel | yes | `[P0-HIGH]` prefix, vibrate-on-mobile cue (Discord "urgent" is not a real API — see below) |
| P0 | `blocked` | `permission.request` | `medium`/`low` | DM | no | `[P0]` prefix |
| P0 | `blocked` | `tool.error` | — | DM + channel | yes | `[P0-ERR]` prefix |
| P0 | `blocked` | `review.checkpoint` | — | DM | no | `[P0]` prefix |
| P0 | `failed` | — | — | channel | yes | N/A — channel only |
| P0 | `completed` | — | — | channel | no | N/A — channel only, low visual weight |
| P1 | `blocked` | `permission.request` | `high` | DM + channel | yes | `[P1-HIGH]` prefix |
| P1 | `blocked` | `permission.request` | `medium`/`low` | DM | no | `[P1]` prefix |
| P1 | `blocked` | `tool.error` | — | DM | no | `[P1-ERR]` prefix |
| P1 | `blocked` | `review.checkpoint` | — | DM | no | `[P1]` prefix |
| P1 | `failed` | — | — | channel | no | N/A |
| P2/P3 | `blocked` | `permission.request` | `high` | DM | no | `[HIGH]` prefix |
| P2/P3 | `blocked` | `permission.request` | `medium`/`low` | DM | no | (no prefix) |
| P2/P3 | `blocked` | `tool.error` | — | DM | no | (no prefix) |
| P2/P3 | `blocked` | `review.checkpoint` | — | DM | no | (no prefix) |
| P2/P3 | `failed` | — | — | channel | no | N/A |
| any | `principal.input.requested` | — | — | DM | no | `[INPUT]` prefix |

**Discord "urgent" is not a real API.** Discord has no per-message urgency flag. Mentions create the push-notification escalation; server settings (user-level) control whether DMs ping at all. F-11 sends the ping (and the principal-role ping in the channel when the matrix says "yes"), and does not try to smuggle in urgency via embeds. `[P0-HIGH]` as a text prefix is a human cue, not a protocol signal.

**Why text prefixes instead of emojis/embeds.** Embeds get collapsed on mobile Discord. Prefixes survive every render context. Matches the content-forward aesthetic of the dashboard (F-6/F-7/F-8/F-9 addenda all explicitly avoided decorative iconography).

## Decision 4 — Deep-link format

`grove.baseUrl` (§4.4) plus a single URL shape:

```
{grove.baseUrl}/?focus=assignment/{assignment_id}
```

§4.4 already specifies this exact shape. F-11 wires it in verbatim and adds one follow-up query param for channel posts that the dashboard can ignore or use for analytics later:

```
{grove.baseUrl}/?focus=assignment/{assignment_id}&from=dm         # DM link
{grove.baseUrl}/?focus=assignment/{assignment_id}&from=channel    # channel post link
```

Tier 1 default: `http://localhost:8766`. Tier 2: `https://grove.meta-factory.ai`. Tier 1 / mobile / LAN scope limits in §4.4 stand (LAN not supported in v2; Tier 1 localhost links don't open on phones) — no rework.

**No URL shortener.** `https://grove.meta-factory.ai/?focus=assignment/01HZ...` is already under 80 chars; Discord preview trimming is not a felt problem. Revisit if a future URL shape grows an additional slug.

**Deep-link landing behaviour** belongs to the dashboard router, not F-11. F-7's drill-down already keys off `location.hash` / `location.search` for focused assignments. F-11 generates the URL; the dashboard already knows what to do with it.

**The link is an index, not a credential.** `?focus=assignment/{assignment_id}` carries no token, no session id, no signed query param — nothing an attacker could harvest from a forwarded Discord DM to impersonate the principal. Authentication happens exclusively at the dashboard surface (CF Access on Tier 2, localhost-only on Tier 1 per §6) when the principal's browser reaches `grove.meta-factory.ai`. The assignment id is non-secret — the same id is logged to `events`, surfaced in the WS broadcast, and printed in principal-facing CLI output. Someone who has the link without dashboard credentials sees a login redirect, not the assignment. This is important enough to state because Discord DMs are occasionally forwarded, screenshotted, or synced into other contexts where a treat-link-as-credential design would leak access; F-11's shape explicitly does not.

## Decision 5 — Channel routing: F-11 keeps it simple; v1 SOP remains out of v2's scope

grove-bot v1 ships a per-repo channel routing SOP (`docs/sop-discord-channel-routing.md`) — `#{repo}` channels, `{repo}/{entity}/{ref}` threads, agent-created-on-first-use. That SOP is wired into the v1 chat-router (`src/bot/lib/channel-context.ts`, `message-router.ts`) but is **not** active in v2 mission-control yet. `bot.yaml.template` does ship a commented-out `github.repos` block (at the top level, not under `discord.*` — see `src/bot/bot.yaml.template` lines 45–59, and the schema in `src/bot/types/config.ts:307` for the canonical shape), but it is consumed by the v1 webhook-ingestion / chat-router pathway, not by any v2 `tasks.source_url` → `#channel-name` resolver. No such resolver exists in v2 yet; F-11 is its first reader.

**F-11 ships a deliberately narrower v2 channel-routing model** than the v1 SOP:

1. **DM recipient.** `config.agent.operatorDiscordId` — the field already exists in `bot.yaml.template` and is already surfaced to `DiscordAdapter` (see `src/bot/grove-bot.ts:195`). No new config key. If `operatorDiscordId` is unset, DM-class notifications degrade silently to channel posts (Decision 6's degradation rule), because "no principal to DM" is a config gap, not a per-event decision.
2. **Channel recipient.** For tasks with `source_system = 'github'`, F-11 attempts thread resolution by the v1 SOP's naming pattern (`{repo-short-name}/issue/{N}` or `{repo-short-name}/pr/{N}`, derived from `tasks.source_url`) if and only if the top-level `github.repos` allowlist is configured (canonical path per `src/bot/types/config.ts:307` — top-level `github.repos`, not `discord.github.repos`). If the thread does not exist, F-11 **does not create it** — it falls through to `instance.worklogChannelId ?? instance.agentChannelId`. Thread auto-creation is a v1 chat-router concern; F-11 is read-only on channel topology.
3. **For tasks with `source_system = 'internal'`** — no repo to map — F-11 posts to `instance.worklogChannelId ?? instance.agentChannelId` unconditionally.

**Why not auto-create threads.** Thread creation requires `ManageThreads` permission, a decision about archive duration, and a thread-name collision strategy. None of that is F-11's problem; the v1 SOP owns it. When the v1 channel-routing logic is ported into v2 (post-Phase-D, tracked as a separate chore), F-11's resolver swaps from `findExistingThread` to `findOrCreateThread`. One-line diff.

**First-contact degradation (expected, not a bug).** The v1 SOP's threads are **agent-created-on-first-use**: the thread `grove/issue/43` only exists after the v1 chat-router has received a message routed to that issue. F-11 is read-only on channel topology — it does not create threads. Consequence: the **very first** notification-worthy transition for a GitHub-sourced task whose thread has not yet been materialised lands in the instance fallback (`instance.worklogChannelId ?? instance.agentChannelId`), not in the per-issue thread. Subsequent notifications for that same task, after a chat-router interaction has seeded the thread, route correctly. This is expected behaviour, not a routing bug — do not flag it in review. Migrating thread auto-creation into F-11 would drag the `ManageThreads` permission story and the v1-SOP port into this PR's scope, which is exactly what Decision 5 is refusing to do. The fallback channel is still the principal's channel; the principal still gets the notification; only the thread granularity degrades for that first event.

**Principal-role ping config.** New optional key `discord.operatorRoleId` in the discord-instance block. When set, the subset of notifications the Decision 3 matrix marks "role ping: yes" render a `<@&{operatorRoleId}>` mention. When unset, those notifications render as plain channel posts with no mention. Default unset — principals opt in.

**Interaction with the v1 SOP.** The v1 SOP explicitly owns chat-routing for the live bot. F-11 notifications are a **different class of message** — they are "push" not "chat" — and this addendum's split rule pins the scope: F-11 reads from the same channel-topology config (top-level `github.repos`, per `src/bot/types/config.ts:307`) when it exists, and falls back cleanly when it doesn't. The v1 SOP is not modified by F-11; it simply gets a new reader. The single most important decision: F-11 does **not** add a new channel-topology surface, does **not** mint new channel names, and does **not** introduce a second routing table that diverges from the v1 SOP. One source of truth, one reader.

**`github.repos` config shape used by F-11.** The v1 channel-routing config (if present) is expected to expose, per repo, a short name (`grove`) and an allowlist entry (`the-metafactory/grove`). F-11 resolves `tasks.source_url` (e.g. `https://github.com/the-metafactory/grove/issues/43`) → short name `grove` → Discord thread `grove/issue/43` if it exists in the configured guild, else falls through to the instance channel default. If the v1 config does not yet exist in v2's `bot.yaml`, every F-11 channel post lands in `instance.worklogChannelId ?? instance.agentChannelId` — the system still works, just with less thread granularity. Graceful degradation is explicit.

## Decision 6 — `bot.yaml` toggle: one bit, tri-state behaviour when misconfigured

§4.3's one-bit toggle:

```yaml
grove:
  notifications:
    discord: true
```

Concrete semantics:

- `true` — F-11 runs. `shouldNotify` routes normally. Missing downstream config (e.g. unset `operatorDiscordId`, unset thread) degrades per Decision 5, not per this toggle.
- `false` — F-11 is a no-op. `shouldNotify` still runs (it's cheap and pure), the result is discarded before any Discord API call. The on-disk events and WS broadcast are unaffected — "off" means "no push", not "no observation".
- unset / key absent — treat as `false`. Explicit off-by-default avoids surprising principals with a DM torrent after a fresh install.

**What "off" does NOT silence.** The dashboard WS `state.transition` broadcast, the `events` table row, the audit log. Those are the ground truth and are orthogonal to push.

**New top-level config section.** `grove.notifications.discord` is a new key; it coexists with the existing `discord.*` (auth) and `grove.baseUrl` (deep-link) keys. Adding a second notification channel later (desktop, mobile, email) adds a sibling key (`grove.notifications.desktop`), not a refactor.

**`grove.baseUrl` is also new.** §4.4 already specified it; F-11 is the first consumer. Tier 1 default `http://localhost:8766`; Tier 2 `https://grove.meta-factory.ai`. If unset on Tier 2, deep links render the full assignment-id as plain text (`assignment/{id}`) with a one-line warning in the notification copy — "Deep link unavailable; configure `grove.baseUrl`". Degrades, doesn't block.

## Decision 7 — Rate limiting and coalescing

A fleet of 20 agents hitting permission prompts in the same second must not produce 20 DMs. Three-layer defence:

1. **Per-assignment deduplication window: 5 seconds.** If the same `assignment_id` transitions `A → blocked` twice within 5 s (for example, the state machine bounces through a transient repair path), only the first produces a notification. Sliding window, per-process in-memory `Map<assignment_id, lastSentAt>`.

2. **Coalescing window: 3 seconds.** When multiple **different** assignments for the **same principal** enter a notification-worthy state within a 3 s window, F-11 sends a single summary DM:

   ```
   [P1] 3 agents blocked
   - Luna · T-42 "fix webhook HMAC" · permission.request: tool.bash
   - rev  · T-43 "review PR #45"    · tool.error: exit 1
   - impl · T-44 "draft migration"  · permission.request: tool.edit

   Dashboard: https://grove.meta-factory.ai/?focus=assignment/01HZABC...
   ```

   The summary link points at the highest-priority assignment's focus URL. Individual assignments are listed inline so the principal can skim without opening the dashboard. Coalescing only kicks in at N ≥ 2 — single events render with the Decision 8 single-event payload unchanged.

3. **Channel-post throttle: 1 per 10 s per channel.** Failed + completed-P0 channel posts don't swarm a channel. If more than one lands in the same 10 s window per destination channel, they coalesce into a single summary post with the same shape as the DM summary above. Independent of DM coalescing — each surface has its own window because the audiences are different.

**Coalescing is a cosmetic layer, not an authority.** Every notification-worthy event still writes to `events` and broadcasts over WS individually. Coalescing only affects the Discord outbound message. Dashboard completeness does not suffer.

**In-memory state is explicitly fine.** The dedup and coalesce buffers live in grove-bot's process memory. If grove-bot restarts mid-burst, a duplicate DM or two is the worst case — a vastly better failure mode than writing to SQLite for dedup (disk contention on the hot path) or to a second daemon (introduces new deployment surface). A durable coalescer is a post-v2 upgrade if the in-memory version ever proves wrong.

## Decision 8 — Notification payload shape

Two payloads, one for DM, one for channel post. Both are copy-pasteable plain text — no embeds, no attachments.

**DM payload (single-event):**

```
[P1-ERR] Luna blocked on T-42 "fix webhook HMAC verification"
tool.error: bash exit 1 — "permission denied"
Cycle 3 · observed 2s ago

One-liner: trying to run `bun test` in src/worker/; fs sandbox rejected.

Open: https://grove.meta-factory.ai/?focus=assignment/01HZ...&from=dm
```

Field breakdown:

- **Line 1** — `[urgency-tag]` + agent name + state verb + `T-{task_id}` + task title (quoted, truncated at 80 chars)
- **Line 2** — block-reason kind + structured context from the tagged union (e.g. `permission.request` renders `action target`; `tool.error` renders `tool exit_code — "message"`; `review.checkpoint` renders `"{note}"`)
- **Line 3** — `Cycle {dispatch_count}` + relative timestamp
- **Line 4** — blank
- **Line 5** — one-line AI summary (see below)
- **Line 6** — blank
- **Line 7** — `Open: {deep_link}`

**Channel post payload (single-event, `failed` or `completed` P0):**

```
[P0-ERR] Luna failed T-42 "fix webhook HMAC verification"
Root cause: bun test exited 1 after 3 cycles — context in dashboard.

https://grove.meta-factory.ai/?focus=assignment/01HZ...&from=channel
```

Shorter because the audience is not the one taking action.

**DM coalesced payload** — see Decision 7.

**One-line AI summary (DM, line 5).** This is the "glance and decide" field. The implementation pulls from the assignment's block-reason `context` field when present (which is already a one-line rationale written by the agent, per the `block_reason` schema in §5.3.1). When the `context` field is missing — falls back to the most recent `assistant.message` event, truncated to 80 chars via miner-style extractive summarisation (no LLM in the render path; §5.4 pattern). When both are absent — the line is omitted entirely (six lines instead of seven). **No LLM call on the hot path.** §5.4 already pinned this for the dashboard summary header; F-11 inherits the same rule — a Discord DM is not the place to run an LLM call and wait.

**Task title truncation: 80 chars at word boundary, suffix `…`.** Matches F-8 task table's column clamp. An principal who sees `"fix webhook HMAC verification with rotating secret…"` knows which task without needing the full title.

**No agent avatars / thumbnails / rich embeds.** §4 is deliberately low-chrome. Rich embeds in DMs render weirdly on mobile Discord; plain text ships consistently.

**Structured fields hinted for future consumers.** The message body is plain text. The `context.footer` (invisible) can later carry machine-readable fields if a future Maestro-style "Approve from Discord" interactive flow lands — noted here, not shipped. F-11's message is human-consumed, nothing else.

**Data handling posture — DM body is untrusted-string passthrough.** The DM's line-2 (`block_reason.context`) and line-5 (extractive summary of the most recent `assistant.message`) are both agent-generated free-form strings. F-11 does **not** sanitise, escape, redact, or rewrite them. The rationale is deliberate: (a) Discord's DM surface renders plain text — no HTML evaluation, no active markdown rendering beyond bold/italic/code which are cosmetic, no link auto-unfurl that exfiltrates content to a third party — so there is no injection attack surface to defend against on the render side; (b) the principal is the addressee and is already the trust boundary for everything the agent produces (the dashboard shows the same strings verbatim, CLI output shows them verbatim, the `events` row stores them verbatim); (c) any sanitisation pass would drop useful signal — `block_reason.context` often includes stack traces, file paths, tool invocations, and shell command fragments that the principal needs literally to diagnose. Posture: the principal sees exactly what the agent sent, on a surface that renders as text. No more, no less. The same rule applies to channel posts — they render agent strings verbatim as well, and the broader audience is a design choice (Decision 2's "channel-for-record" role) that the principal opts into by naming a channel at all. If an agent produces genuinely hostile content, the containment is principal-facing (revoke the agent's token, pause its queue) not notification-facing.

## Decision 9 — Auth posture: reuse the existing bot's Discord client

**No new bot, no new token, no new login.** The existing `DiscordAdapter` (`src/bot/lib/adapters/discord.ts` — instantiated in `src/bot/grove-bot.ts:186`) owns the Discord.js `Client`. F-11 imports a single helper, `notifyViaDiscord({ operatorDiscordId, channelId, payload, roleIdToPing? })`, which resolves `operatorDiscordId → DMChannel` and `channelId → TextChannel` via the existing `client.users.createDM(...)` / `client.channels.fetch(...)` surfaces that `response-poster.ts` already uses.

**Why this is not a design waffle.** The alternative — a second bot token with its own login — would require (a) a second Discord app registration, (b) a second token in `bot.yaml`, (c) a second user-facing bot name in every server, (d) guild invites and permission grants for the new bot, and (e) a second authentication lifecycle to monitor. For zero user-visible benefit. One bot, one token, one gateway connection, two classes of outbound message (chat and push).

**Rate-limiting within Discord's API envelope.** Discord DMs are rate-limited (~5/5s per bot-user pair; channel posts ~5/5s per channel). Decision 7's coalescing windows are sized comfortably inside those limits for Phase D scale (single principal, low-tens of daily push events). If the coalescer ever runs hot, the v1 chat-router's existing queue/backoff infrastructure (`response-poster.ts` splitting logic) is the blueprint for a more sophisticated outbound queue — not in F-11.

**Error handling.** Discord API failures (network, rate-limit, permissions) are logged via `process.stderr.write()` + an `system.error` event in the `events` table (per the repo-wide "never swallow errors" rule in `CLAUDE.md`). The assignment state and the dashboard are unaffected — notification send is a best-effort side-channel, never in the critical path of the state machine.

## Decision 10 — Scope: what F-11 does NOT do

Explicitly out of scope so the PR review stays tight:

- **Interactive buttons in Discord (Approve/Deny).** Discord Components v2 (buttons, select menus, modal responses) would allow a principal to approve a permission request directly from the DM. That is a Maestro-style interaction and a **post-v2 Phase D+** feature — requires (a) a Discord slash-command or message-component framework wired into grove-bot, (b) an authenticated webhook endpoint on grove-bot that maps component-click → assignment action, (c) principal-identity verification per §6.5 (the DM recipient is trusted, but a button-click in a server channel is not), and (d) a second path into the state machine that duplicates the dashboard Approve/Deny path. Too much for F-11.
- **Slash commands (`/grove`, `/block`, `/approve`).** Same class of scope as interactive buttons; same deferral. The existing `~/bin/discord` CLI handles the "notify from terminal" direction already; inbound slash-command ingestion is a new surface.
- **SMS / email / OS desktop notification fallback.** §4.1 is Discord-only in v1. Every other channel is post-MVP and gates on the event-back-in automation pipeline (§4.1 rationale).
- **Per-principal notification preferences UI.** Mute windows, quiet hours, per-priority mute, per-agent mute. All add UI, all add config state, all require a preferences persistence story. Principal can mute at the Discord level (server notification settings) until this lands post-Phase-D.
- **Notification history view in the dashboard.** "Show me everything that was pushed today" — nice to have, but every notification-worthy event is already a row in `events` and renders on the F-7 drill-down. A dedicated history view is additive, not critical path.
- **Multi-principal / team-wide fanout.** F-11 is single-principal — one `operatorDiscordId`. Tier 2's multi-principal fanout (where several principals need DMs for their own agents) is a §7.3 concern that grows out of principal identity becoming a first-class key on `tasks.operator_id`. Out of scope for v2.
- **A v1-SOP-style `github.repos` config migration into `bot.yaml`.** Decision 5 uses the v1 SOP's config *if it is already present* and falls through cleanly when it is not. Migrating v1's channel-routing config into v2's `bot.yaml` is a separate chore with its own PR.
- **Channel-post reaction handling.** "React with ✅ to acknowledge" is an interactive flow; see first bullet.
- **Retry queue for failed sends.** Best-effort is the posture (Decision 9). A durable retry queue would need SQLite + a sweeper + a reconciliation story — deferred unless observable loss rate shows it's needed.

## Scope summary — what F-11 SHIPS

- New pure-function module: `src/mission-control/notifications/should-notify.ts` — implements the Decision 1 matrix as a transition → `NotificationIntent | null` function with no I/O. Unit-tested from truth-table inputs.
- New module: `src/mission-control/notifications/render.ts` — renders the `NotificationIntent + assignment + task + blockReason` inputs into a DM payload string or channel-post payload string per Decision 8.
- New module: `src/mission-control/notifications/discord-sink.ts` — owns the dedup + coalesce buffers (Decision 7) and the `notifyViaDiscord` call into the existing `DiscordAdapter`. Exports `maybeNotifyDiscord(db, ctx, transition)` — the one entry point called from both transition sites.
- Two new call sites: `src/mission-control/api/handlers.ts` (after `broadcastTransition` at line 354) and `src/mission-control/session/stdout-dispatcher.ts` (after `broadcastTransition` at line 174). Each adds one `await maybeNotifyDiscord(...)` line.
- New config keys: `grove.notifications.discord` (one-bit toggle, default `false`), `grove.baseUrl` (string, Tier 1 default `http://localhost:8766`), `discord.operatorRoleId` (optional string per discord instance). Added to `src/bot/bot.yaml.template` with inline comments.
- Config plumbing: `src/bot/types/config.ts` grows the `grove.notifications` and `grove.baseUrl` fields; `config-loader.ts` reads them; `notifications/discord-sink.ts` consumes them.
- Tests: `__tests__/should-notify.test.ts` covers every row of the Decision 1 matrix as a pure-function case; `__tests__/notification-render.test.ts` covers Decision 8's payload shape (single and coalesced); `__tests__/discord-sink.test.ts` covers Decision 7's dedup window + coalescer with a fake Discord client.
- Forward-link from `docs/design-mission-control.md` §4 to this addendum.
- Iteration tracker bullet updated to point at this addendum.

## Scope summary — what F-11 DEFERS

- Interactive Discord components (buttons, slash commands, modal responses) — Decision 10.
- Additional notification channels (desktop, SMS, email) — Decision 10.
- Per-principal preferences UI — Decision 10.
- Multi-principal fanout — Decision 10.
- Thread auto-creation in v2 — Decision 5 (inherits when v1 SOP ports in).
- Durable retry queue + persistent coalescer — Decision 7 / Decision 9.
- Notification history view in the dashboard — Decision 10.
- **`principal.input.requested` notification wiring.** Decision 1's matrix (last row) and Decision 3's `[INPUT]`-prefix routing both contemplate this path, but the underlying event is not yet emitted by Mission Control v2 — no caller writes the `principal.input.requested` event type. The PR #23 sweep removed the unwired `maybeNotifyInputRequested` helper and `shouldNotifyInputRequested` policy stub to keep this PR free of dead exports (W2 in PR #23 review). When a follow-up feature emits the event, restore both functions and wire the call from the new emitter site; the routing decision (DM, `[INPUT]` tag, silent severity) is already pinned by Decision 3 and does not need re-deciding.

## Acceptance criteria

- [ ] `shouldNotify(transition, task, blockReason)` returns the exact `NotificationIntent | null` from Decision 1's matrix for every `(priority × to-state × block-reason.kind × risk)` cross.
- [ ] `render(intent, ctx)` produces the single-event DM and channel payloads from Decision 8 with the field order and truncation pinned.
- [ ] Multi-event coalescing triggers at N ≥ 2 within 3 s per principal and renders the Decision 7 summary payload.
- [ ] Per-assignment dedup suppresses duplicate notifications within 5 s.
- [ ] Channel-post throttle of 1 per 10 s per destination channel collapses bursts into a single summary.
- [ ] `grove.notifications.discord = false` or unset — zero Discord API calls, all other behaviour unchanged.
- [ ] `operatorDiscordId` unset — DM-class notifications fall through to channel post with a one-line warning; no crash.
- [ ] `grove.baseUrl` unset on Tier 2 — notifications render with plain-text assignment id and a configure-hint; no crash.
- [ ] `discord.operatorRoleId` unset — Decision 3's "role ping" rows render as plain channel posts with no mention.
- [ ] Discord API failure — logged via stderr + `system.error` event; state machine unaffected; no unhandled rejection.
- [ ] Existing `broadcastTransition` + `broadcastEvent` behaviour unchanged; new `maybeNotifyDiscord` is additive.
- [ ] All existing mission-control tests still pass; new unit tests for `should-notify`, `render`, and `discord-sink` ship green.

## Where this goes

- New modules:
  - `src/mission-control/notifications/should-notify.ts` (pure)
  - `src/mission-control/notifications/render.ts` (pure)
  - `src/mission-control/notifications/discord-sink.ts` (I/O + in-memory buffers)
- Existing-file edits:
  - `src/mission-control/api/handlers.ts` — one `await maybeNotifyDiscord(...)` after `broadcastTransition` at the ~354 call site.
  - `src/mission-control/session/stdout-dispatcher.ts` — one `await maybeNotifyDiscord(...)` after `broadcastTransition` at the ~174 call site.
  - `src/bot/bot.yaml.template` — three new commented keys (`grove.notifications.discord`, `grove.baseUrl`, `discord.operatorRoleId`).
  - `src/bot/types/config.ts` — type additions mirroring the new keys.
  - `src/bot/lib/config-loader.ts` — read the new keys.
- Tests: `src/mission-control/__tests__/should-notify.test.ts` (new), `src/mission-control/__tests__/notification-render.test.ts` (new), `src/mission-control/__tests__/discord-sink.test.ts` (new).
- No schema changes. No new DB tables. No new endpoints. No new WS message types.

Forward-link from the main spec §4 added in the same PR that lands this addendum.
