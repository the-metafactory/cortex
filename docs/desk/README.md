# The Desk

The Desk is the landing page of Mission Control, the dashboard that a Cortex stack serves. It answers one question for one person: what needs me now? It shows three to five ranked items, each with one sentence on why it matters today, today's timeline with a Now marker, the next days, and what agents did on their own. You act on an item from the Desk, and you start new work from its command bar by text or voice.

## Pages

| Page | Read it when |
|---|---|
| [Get started with the Desk](getting-started.md) | You have a Cortex stack and want to see the Desk, first on Cortex data alone, then with a calendar and mail. |
| [Write a source adapter](write-a-source.md) | You want your own calendar, mail or task tool on the Desk. |
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
- **The command bar** (⌘K, or the microphone) turns what you say into a card: a reminder, a note, an agent task, a goal draft or a calendar entry. You confirm the card, and Cortex runs the writer for that kind.

## How the Desk interrupts

Only some items interrupt you: a meeting about to start, fresh mail ranked for today, and a reminder that is due. A blocked agent or a deadline goes into the briefing instead. A broken system never interrupts.

An interrupting item can reach you three ways. Each one is configured under `mc.desk.interruptions`:

- a chime in the open Desk tab (`chime`)
- a browser notification while the tab is in the background (`notifications`). Browsers allow notifications only on https or `localhost`.
- a push through a transport: a Discord DM through the stack's Discord adapter, or any command you name (`transport: command`)
