# The Desk

The Desk is the landing page of Mission Control, the dashboard that a Cortex stack serves. It answers one question for one person: what needs me now? It shows three to five ranked items, each with one sentence on why it matters today, today's timeline with a Now marker, the next days, and what agents did on their own. You act on an item from the Desk, and you start new work from its command bar by text or voice.

## Pages

| Page | Read it when |
|---|---|
| [Get started with the Desk](getting-started.md) | You have a Cortex stack and want to see the Desk, first on Cortex data alone, then with a calendar and mail. |
| [Write a source adapter](write-a-source.md) | You want your own calendar, mail or task tool on the Desk. |
| [Write a Desk domain adapter](write-a-domain-adapter.md) | You want to package domain objects, queries, observations, and confirmed actions through the Desk SDK. |
| [Configuration reference](configuration.md) | You look up a key under `mc.desk`. |
| [Command contracts](commands.md) | You write or debug a command that Cortex runs for the Desk: a source, a parser, a writer, the mail classifier, a mail action, a transport or a goal check. |
| [Desk Studio: thread files](../desk-studio.md) | You turn on the Studio, the Desk's board of threads you think through. |

Example adapters that need no personal tools live in [cortex-desk-adapters](https://github.com/the-metafactory/cortex-desk-adapters/blob/main/EXAMPLES.md): an ICS calendar reader, an IMAP mail lister and an ntfy transport.

## What the Desk reads

Without any `mc.desk` configuration, the Desk shows what Cortex knows itself:

- **Vigil**: goal checks and their readings, escalations from agents, and the goals in the right margin. Vigil feeds the Desk on the stack named `default` when `vigil.enabled` is true.
- **Ranger**: agents that stopped, are blocked on a decision, or wait for an approval or a grilling. The Desk reads Ranger when `mc.desk.ranger.url` is set.
- **Notes and reminders** that you make in the command bar. Cortex keeps them in the Mission Control database.

Everything personal comes from **sources**: commands that you list under `mc.desk.sources` and that print the Desk's JSON. A calendar source adds meetings to the timeline. A mail source adds unread mail as items. Cortex runs each command on a timer, without a shell, and drops each entry that does not match the contract. A dropped entry shows on the Desk as a system line that names the field.

The Desk never hard-wires a provider. A calendar, a mail account, a model that sorts mail, a place to write notes and a push channel all plug in as commands in the stack config. Each contract is in [Command contracts](commands.md).

## How the Desk ranks items

Fixed rules rank the items, and each reason comes from a template:

- A meeting that starts within `interruptions.meetingMinutes` ranks first.
- A blocked agent, a failed agent task and a goal check that stopped working rank high, with the repo or goal named in the reason.
- Mail from a VIP ranks above other mail. Mail that the classifier sorts as `action` or `reply`, or that seems to be about a meeting in the next three days, ranks above `fyi` and `bulk` mail. Each day of age lowers a mail item.
- Items beyond the top `topN` fold into one line, such as "61 more, nothing urgent", that opens into groups by kind.

You correct the ranking from an item's **⋯** menu. **Less like this** puts every item of that kind from that source below the items you have not marked. **Always show this** puts them above. The Desk keeps corrections in its database and lists them under **Ranking** in the right margin, where **×** undoes one. Mail corrections also go to the mail classifier as examples.

## How the Desk acts

The Desk prepares, and you confirm. Every write goes through Mission Control's rebind and identity gates. A Desk action needs no step-up code.

- **Ranger actions** (approve a node, retry a failed task) run the Ranger CLI set in `mc.desk.ranger.bin`. You can let the Desk retry failed tasks on its own. Those retries then show under **Done for you**.
- **Rulings**: a blocked agent asks a question. You answer it on the Desk. The Desk records your ruling in the work-graph node with Soma and resumes the agent through Ranger.
- **Goals**: **Run the check now** runs the goal's configured check. **Pause this goal** pauses a Soma goal.
- **Mail**: **Delete**, **Unimportant** and **Draft a reply** run the commands in `mc.desk.mail.actions`. A draft is saved in your Drafts folder and never sent.
- **Attach to a task**: `POST /api/desk/mail {action: "attach", key, requestId, to: {kind: "task", id}}` attaches a mail to a task in your outline or Balance inbox as material. The card leaves the Desk, the mailbox is not touched, and the task is not edited: My day lists the link with the task, with the mail's subject, sender, received time and a link to open it in Mail. A mail has one attachment at a time, and **Add to thread** counts as one. `{action: "attach.undo", link}` brings the card back (for a thread, it also removes the capture). If the task is removed later, the mail comes back with the reason.
- **Hide a mail**: `POST /api/desk/mail {action: "hide", key}` takes a mail off the Desk for good. A hide is a snooze that never wakes, so rule passes, sweeps, digests and attach rules skip it too. The mailbox is not touched and no mail command runs. The Desk logs it as `ignored`, which counts against an archive rule for that sender, and a new mail from the sender does not bring the hidden one back. `GET /api/desk` lists hidden mail as `mailHidden: [{key, subject, sender, at}]`. `{action: "hide.undo", key}` brings the card back without a "Back because" line. Hiding a hidden mail changes nothing; a key without `mail:` is a 400, and `hide.undo` on a mail that is not hidden is a 409.
- **Link to a meeting**: `{action: "attach", key, requestId, to: {kind: "meeting", event}}` on `/api/desk/mail` links a mail to a meeting that has not ended, and `POST /api/desk/links {op: "link", requestId, from: {kind: "task", id} | {kind: "thread", slug} | {kind: "note", id}, to: {kind: "meeting", event}}` links a task, Studio thread or note to any meeting the Desk lists, past ones included. Each meeting in `today[]` and `ahead[]` carries its `links`. A link follows a meeting that moves; a linked mail stays off the Desk after the meeting ends and comes back only when the meeting is cancelled or you undo the link (`{op: "unlink", link}`, or `attach.undo` for a mail).
- **Link mail to its meeting on its own**: the autonomy setting `mail.link-meeting` is off by default. When it is on and the mail classifier answers `suggestedAction: "link-meeting"` with a `meetingKey`, the classifier pass links that mail to the meeting as if you had linked it, with `origin: "auto"`. Only a meeting the Desk still lists and that has not ended counts. When the calendar source lists the meeting's `organizer` or `attendees`, the mail's sender must be one of them, compared without regard to case; otherwise the mail stays on the Desk and nothing is recorded under **Done for you**. A meeting without either is linked as before. Suspicious mail, a VIP's mail and a mail that was ever linked before are left alone. Linking by hand and rules do not check attendees. Each link shows under **Done for you** with Undo, which ends exactly that link and brings the mail back; the Desk does not link that mail on its own again. An auto-link is logged with where `auto` and does not count toward rule proposals. Only a command classifier returns `suggestedAction`, so the setting is offered only when one is configured.
- **Rules that attach**: a mail rule with `action: "attach"` and a fixed `target` (`{kind: "task", id}` or `{kind: "thread", slug}` on `POST /api/desk/mail/rules` `create` or `edit`) links each matching unread mail to that task, or files it in that Studio thread, without touching the mailbox. Each run shows under **Done for you** with Undo and Stop. When your recent attaches by hand of one sender's mail all went to the same task or thread (Add to thread counts as an attach), the Desk proposes such a rule after as many attaches as a move proposal needs. If the task is done or gone, or the thread is closed, the run fails, the rule turns itself off and the mail stays on the Desk. Attach and digest rules work without the move command.
- **The command bar** (⌘K, or the microphone) turns what you say into a card: a reminder, a note, an agent task, a goal draft or a calendar entry. You confirm the card, and Cortex runs the writer for that kind. An open question or a request to think something over becomes a proposal to start a conversation with Ivy instead.

## Conversation draft setup limit

The programmatic `MissionControlViews` options accepted by `startServer` and
`startMissionControl` deliberately serve one draft editor per Mission Control
instance. Configure at most one of `drafts`, `graphDrafts`, `balanceDrafts` or
`flowDrafts`; startup rejects combinations before initializing an editor.

Each owner convenience setup (`graphDrafts`, `balanceDrafts`, `flowDrafts`) offers
one connection and capability. A single instance using these setups therefore
cannot offer Make for graph nodes, Balance tasks and Flows together. This limit
keeps destination resolution, confirmation and receipt release tied to the
configured owner while those integrations migrate independently.

The generic `drafts` option accepts a host-supplied `DeskDraftAccess` editor. Its
`targets()` may list multiple targets, but the host must also provide matching
bindings, destination resolution, confirmation routing and policy-safe receipt
release. The convenience setups do not compose these responsibilities; a
composed owner-setup API is deferred to a separate integration change.

## How the Desk interrupts

Only some items interrupt you: a meeting about to start, fresh mail ranked for today (including mail whose deadline is today), and a reminder that is due. A blocked agent, or a deadline on a later day, goes into the briefing instead. A broken system never interrupts.

Every interruption has a reason, and each reason is a switch:

| Reason | Fires when | Default |
|---|---|---|
| `meeting.soon` | a meeting starts within `meetingMinutes` | on when `meetingMinutes` is above 0 |
| `reminder.due` | a reminder is due and fresh | `reminders` |
| `mail.meeting-today` | fresh mail the classifier linked to a meeting that starts later today | on |
| `mail.deadline-today` | fresh mail whose deadline falls on today's local date, from the mail source's `dueAt` or, failing that, a deadline the classifier read from the mail; an overdue deadline from an earlier day does not fire | on |
| `mail.vip` | fresh mail from a VIP; one switch per VIP address or domain | on |
| `mail.ranked` | any other fresh mail ranked for today | on |

Mail is checked in the order of the table. The first reason that fires and is switched on is the item's reason, shown as `interrupt.reason` (`code`, plus `target` for a VIP and `eventKey` for a meeting). When every reason that fires is off, the item stays in the list without interrupting. `interruptions.mail: false` turns every mail reason off for the stack, and `meetingMinutes: 0` turns `meeting.soon` off, whatever their switches say; such reasons read `available: false`.

A mail's deadline is on its item as `dueAt`, with `dueFrom` set to `source` or `classifier`. A deadline today puts the mail on today's list even when `mail.deadline-today` is switched off.

The switches are stored per stack. `GET /api/desk/interruptions` lists the reasons with `on`, `available`, `setBy` (`default`, `switch` or `feedback`) and `changedAt`; `GET /api/desk` carries the same list as `interruptions`. `POST /api/desk/interruptions` with `{ code, target?, on }` switches one reason; switching it back to its default removes the stored switch. Removing a VIP removes its switch.

`POST /api/desk/interruptions/feedback` with `{ key, code, target?, important }` records the answer to "Was that important enough?" for an item, using the reason from its `interrupt.reason`. A no switches that reason off at once; a yes changes nothing. A second answer for the same item replaces the first, and the switch follows it unless you have switched the reason away from its default by hand since the earlier answer. The item then carries `interrupt.feedback`, so another device does not ask again. Answers are kept for 30 days. Whether to ask is up to the UI.

During a meeting the Desk holds interruptions. Mail and reminders that arrive while a meeting runs (a `meeting` on today's calendar with an end, marked busy or unknown, not free) are marked `delivery: "held"` with `held: { eventKey, title, until }`, and are neither pushed nor chimed. Back-to-back meetings hold until the last one ends. A meeting about to start is never held, nor is mail about the meeting that is running. On the first check after the meeting ends, the item is pushed once with the sentence that it waited; its age counts from the meeting's end, and `held` stays on the item. A moved or cancelled meeting releases on the next check; the Desk keeps no record of the hold, so the item's age then counts from its arrival again, and an item older than `maxAgeMinutes` by then stays in the list without a push. `interruptions.holdDuringMeetings: false` turns the hold off.

An interrupting item can reach you three ways. Each one is configured under `mc.desk.interruptions`:

- a chime in the open Desk tab (`chime`)
- a browser notification while the tab is in the background (`notifications`). Browsers allow notifications only on https or `localhost`.
- a push through a transport: a Discord DM through the stack's Discord adapter, or any command you name (`transport: command`)
