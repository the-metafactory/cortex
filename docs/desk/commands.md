# Desk command contracts

Cortex runs Desk commands as argument arrays without a shell. Sources print one JSON object on stdout. Other commands receive one JSON object on stdin, followed by EOF, except the routine commands described below. Diagnostic messages belong on stderr.

The config reference lists [timeouts and command locations](configuration.md). Commands must be available to the daemon's user and environment. The example implementations are in [cortex-desk-adapters](https://github.com/the-metafactory/cortex-desk-adapters/blob/main/EXAMPLES.md).

## Routines

The Desk appends `--request <text> --json` to `routines.composer`. The command prints Pulse's typed compose result: `status: complete` with `yaml`, `status: no-match` with `message`, or `status: invalid` with `findings`. A complete result exits 0. Missing capabilities produce a refusal card without Confirm. The preview shows the actual composed steps and the schedule in the configured timezone.

`scripts/desk-compose.ts` wraps the shared Pulse composer with `--catalog-file`, `--model-url`, `--model` and `--api-key-env`. It reads exact active action paths from the trusted snapshot. It excludes LLM actions without a configured runtime model and action-level agent calls whose capabilities the Desk cannot inspect. It never queries Arc at runtime.

Built-in agent and tribunal steps require fresh online local capability declarations from Cortex's existing agent-presence registry. Preview, Confirm and promotion check those declarations. Targeted or federated agents, gates and research steps are refused because this presence check cannot establish their execution providers. Sovereignty fields remain unchanged in the stored YAML.

Supported schedules start with `every minute`, `every N minutes`, `every hour`, `every N hours`, or a day phrase with an explicit time. Examples include `every Friday at 17:00, …`, `every weekday at 9am, …` and `every day at 08:30, …`. Minute intervals must divide 60 evenly and stay below 60. Hour intervals must divide 24 evenly and stay below 24. Other intervals show a refusal so a cron boundary cannot shorten the frequency shown on the card.

Elapsed minute/hour intervals use UTC so daylight-saving changes do not change their duration. Named clock times use the configured timezone, which appears on the card. The schedule does not promise a delay from Confirm to its first fire.

Confirm sends the server-held proposal to `routines.reflex` through `routine add --flow-file <temporary-path>` with policy `approve` and the configured target. Reflex's JSON policy is `approval`. Composer YAML annotations stay intact. When the composer omits `input`, the Desk appends the original request as `request`, `scenario` and `text` initial fields. An explicit composer input remains unchanged.

The Desk reads `routine list --json`, `pending --json` and `history --limit 200 --json`. Approve and Deny call `approve <decision-id> --json` and `deny <decision-id> --json`. **Handle this yourself** calls `routine set-policy <id> auto --json`. **Stop** returns the policy to `approve`. **Remove** calls `routine remove <id> --json`; Reflex removes its owned flow too.

Confirm and routine controls keep durable request receipts. A definite daemon refusal permits retry after the cause is repaired. A lost reply triggers state reconciliation without resending the write. **Check pending change** retries that reconciliation. A dispatch receipt means Reflex dispatched the flow; execution outcomes appear separately in Mission Control.

### Capability writers

When `routines.capabilityBuild` is set and the principal chooses **Build this capability**, the Desk runs `capabilityBuild.writer` once per missing capability. It writes one JSON object to stdin:

| Field | Meaning |
|---|---|
| `requestId` | The Desk's request id. |
| `capability` | The missing capability, such as `compose.judgment`. |
| `steps` | The composed steps that need it: `label`, `prompt` and `sovereignty` (`model_class`, `frontier_ok`, `data_residency`, each present only when the flow sets it). |
| `request` | The text the principal typed. |
| `yaml` | The composed flow. |
| `map` | `capabilityBuild.map`. |
| `budget` | `{ tokens, invocations, minutes }` from the configuration. |
| `template` | `capabilityBuild.template`, present only when configured. |

The writer prints one JSON object, `{ "ref": "owner/repo#123", "url": "https://…", "existing": false }`, and exits 0. `existing: true` means an open node for that capability was already on the map and nothing new was filed. A non-zero exit, a timeout (`routines.timeoutSeconds`) or output that does not match this shape records nothing for that capability. The card names the capability and the reason, and a retry with the same request id may file it. The Desk stores each returned `ref` on the routine draft. A second confirm of the same request id calls no writer and returns the stored result.

`scripts/desk-capability-node.ts` is the shipped writer. It finds an open node by the exact last body line `desk-capability:<capability>` under the label `desk-capability`, and otherwise files a node with `soma graph add <root> --kind build --autonomy auto --once desk-capability:<capability> --label desk-capability` plus the budget flags. A closed node with the marker is never reused. The body comes from the template, which accepts `{{capability}}`, `{{request}}`, `{{criteria}}` and `{{flow}}`. soma files an `auto` node only with a probe, so the writer needs at least one `--probe <json>` argument, and it can take several. Each one is a soma probe in which `{capability}` becomes the capability and `{slug}` becomes the capability in lowercase with dashes. For example, `--probe '{"type":"artifact-exists","path":"capabilities/{slug}/index.ts","atRef":"main"}'` is met once the capability is merged on `main`. `--template <path>` overrides `capabilityBuild.template`. Which probe proves a capability depends on the target repository, so it belongs to the configuration. `soma` must be on the daemon's PATH, or set `SOMA_BIN`. The request text goes into the node body, so file nodes only on a map that you control.

### Build start and status commands

<!-- glossary-ignore: node -->
<!-- glossary-ignore: agent -->
<!-- glossary-ignore: daemon -->
<!-- glossary-ignore: path -->
<!-- glossary-ignore: message -->
<!-- glossary-ignore: run -->

`capabilityBuild.start` runs after the writer files a node that was not already filed. A node that the writer reused (`existing: true`) is not started again. Exit code 0 means the build was started. Any other exit, a timeout or a failure to run the command leaves the filing in place and shows **Not started: <reason>** on the routine draft. The reason is the last line of the command's output. The node stays on the map's frontier, so the next walk can pick it up. The command runs with `routines.timeoutSeconds`. With Ranger it is `ranger build-now {id} --map {map}`.

`capabilityBuild.status` runs once for each filed node on every routine read, with `routines.readTimeoutSeconds` and at most four at a time. A node that several drafts share is read once. It prints one JSON object on stdout and exits 0:

| Field | Meaning |
|---|---|
| `state` | One of `filed`, `building`, `in-review`, `merged`, `failed`. |
| `reason` | Optional text. The Desk shows it for `failed`. |
| `pr` | Optional pull request number or URL. |

If the command exits non-zero, times out, prints invalid JSON or prints another `state`, the draft shows **State unknown** with the error. The Desk never guesses a state. It shows `merged` as **Live** once the capability is in the local agent presence. Installing a merged capability is a separate step.

`scripts/desk-capability-status.ts <owner/repo#node>` is the shipped status command for Ranger. It reads `ranger journal --node <id> --repo <repo>` and maps the node's newest worker: no worker is `filed`; a claimed or running worker is `building`; a worker with an open pull request or waiting at the merge desk is `in-review`; a worker that succeeded in the close phase is `merged`; a failed, parked or released worker is `failed` with the journal's outcome as the reason. The adapter never reads `merged` from outcome text. It exits 1 with a message when the journal shows a status it cannot map. Set `RANGER_BIN` when `ranger` is not on the daemon's PATH.

A routine refused for a missing capability stays a draft. The Desk does not install it, and a gate, research, targeted or federated step is never offered for building.

## Capability installation commands

With `capabilityBuild.bundle`, `install`, `uninstall`, and `status` configured, a merged build shows **Merged, install?**. Choosing **Install** opens a confirmation. Confirming runs the configured `install` argument array, replacing `{bundle}` in each argument with `capabilityBuild.bundle`. The command receives no shell expansion or stdin. It runs with `routines.timeoutSeconds`.

<!-- glossary-ignore: agent -->
The installer must install or upgrade the bundle and reload its agents before exiting 0. An Arc wrapper can choose `arc install <repository>` for the first installation and `arc upgrade <bundle>` afterwards. If the bundle's postinstall reloads Cortex's agents, the wrapper needs no extra reload. Otherwise, it must call `cortex agents reload`. The configured `uninstall` command must remove the bundle and reload its agents.

A nonzero exit shows **install failed: <reason>**, using the last nonempty line of stderr or stdout, and keeps **Install** available. Each confirmation has a durable request ID. Repeating that request returns its recorded result. A new confirmation after a failed exit creates a new attempt. If a command throws or times out, its outcome remains uncertain and the Desk refuses another install until the bundle is checked. Refreshing or restarting Cortex never resends an uncertain command.

Unconfirmed bundle commands appear under Routines, including after their draft is discarded or the stack's install configuration changes. Choose **Check bundle**, then check that the command has stopped. Choose **Confirm installed** if the bundle is installed and its definitions have reloaded, or **Confirm absent** if the bundle is absent. This records the checked outcome without executing either command. A command interrupted by a Cortex restart can be checked after the configured command timeout. A confirmation from an older command state is refused.

Confirming absent retires all successful installation receipts for the bundle and removes their **Done for you** entries. An uncertain install attempt remains recorded as failed. Eligible merged drafts offer **Install** again when their configuration matches. Confirming installed restores a promoted installation's **Done for you** entry. **Undo** requires the installation's original routine configuration, including its uninstall command. If that configuration changes or is removed, the Desk refuses Undo until the original configuration is restored. Local presence still determines when a capability becomes **Live**.

An installation covers the currently merged builds across drafts for the configured bundle. Commands for the same bundle cannot overlap. A successful command shows **Installed, waiting for local presence**. Each capability becomes **Live** when it appears in fresh online local presence. After 90 seconds without presence, the draft shows **installed, not in presence yet** and keeps checking. Installing the routine itself remains a separate confirmation.

**Install merged capabilities** is an ordinary promotable Desk action (`capability.install`). With **Handle it yourself** enabled, the Desk checks merged drafts every 30 seconds and installs without another confirmation. Each attempt appears in **Done for you**. Successful attempts offer **Undo**, which runs the configured `uninstall` command for the whole bundle, including capabilities shared by other drafts. Undo remains available after discarding or installing the routine draft. **Stop doing this on your own** restores ask-first behavior. Failed attempts remain visible and require a new manual confirmation.

## Source output

A source exits 0 and prints an object with optional `events` and `items` arrays. An empty source can print `{}`. Unknown object fields are ignored. `items` currently accepts mail only. Source adapters do not declare UI actions in their output: Cortex adds actions from the item kind and configured commands.

```json
{
  "events": [
    {
      "id": "planning-2026-11-02",
      "start": "2026-11-02T09:00:00+01:00",
      "end": "2026-11-02T09:30:00+01:00",
      "title": "Planning",
      "url": "https://meet.example.org/planning"
    }
  ],
  "items": [
    {
      "kind": "mail",
      "id": "budget@example.org",
      "from": { "name": "Ada", "address": "ada@example.org" },
      "subject": "Budget draft",
      "receivedAt": "2026-11-02T08:30:00+01:00",
      "unread": true,
      "firstParagraph": "Could you review the draft today?",
      "account": "work"
    }
  ]
}
```

Event fields:

| Field | Required | Value |
|---|---|---|
| `id` | yes | Nonempty string, stable across reads. Keep it unique within the source. Recurring instances need distinct ids. |
| `start` | yes | Date and time string. Use ISO 8601 with a timezone. |
| `title` | yes | Nonempty string. |
| `calendar` | no | Nonempty calendar name, at most 200 characters. Settings scope visibility and colour by source id and this name. Without it, the source is treated as one calendar. |
| `end` | no | Date and time string, in the same format as `start`. |
| `allDay` | no | Boolean. |
| `location` | no | String. |
| `online` | no | Boolean. An online event with a URL offers a Join action. |
| `url` | no | Link beginning with `http:`, `https:`, or `message:`. |

Mail fields:

| Field | Required | Value |
|---|---|---|
| `kind` | yes | The literal `mail`. |
| `id` | yes | Nonempty string. Use the Message-ID when available. Mail ids must distinguish messages across sources and accounts. |
| `from.address` | yes | String of at least 3 characters. Use the sender's address. |
| `from.name` | no | String. |
| `subject` | yes | String. An empty subject is accepted. |
| `receivedAt` | yes | Date and time string. Use ISO 8601 with a timezone. |
| `unread` | yes | Boolean. Only unread mail appears as ranked mail items. |
| `firstParagraph` | no | String for the item's preview and classifier. |
| `url` | no | Link beginning with `http:`, `https:`, or `message:`. |
| `account` | no | Account name understood by the mail action commands. Required to trash or draft a reply. |

The date validator accepts strings that JavaScript's `Date.parse` can read. ISO 8601 with an explicit timezone avoids host-dependent interpretation. The link validator checks the scheme prefix.

The validator drops invalid entries and keeps valid siblings. Diagnostics name the array index and field, such as `events[0].start` or `items[0].unread`. A non-array `events` or `items` value produces an array-level diagnostic. Invalid JSON or a non-object result fails the source read and preserves its previous reading.

The command-line checker uses the same validator:

```sh
cortex desk check-source docs/desk/examples/source-calendar.json
cortex desk check-source docs/desk/examples/source-mail.json
cortex desk check-source docs/desk/examples/source-broken.json
cat docs/desk/examples/source-mail.json | cortex desk check-source
```

Valid output exits 0 with the number of accepted events and mail items. Invalid output exits 1 and names the problems on stderr. The broken example names `events[0].start` and `items[0].unread`. A file argument of `-`, or no argument, reads stdin.

## Parsers and writers

A parser interprets command-bar text before the person confirms a card. Its stdin is:

```json
{
  "text": "remind me to stretch in 10 minutes",
  "now": "2026-11-02T09:00:00Z",
  "timeZone": "Europe/Zurich",
  "kinds": ["reminder", "note"],
  "maps": [{ "ref": "example/project#1", "label": "Project" }]
}
```

It exits 0 and prints `{ "kind": "reminder", "fields": { "text": "Stretch", "due": "2026-11-02T09:10:00Z" } }`, or `{ "kind": "none", "reason": "A plain explanation" }`. It can choose only a kind listed in `kinds`, and a task map listed in `maps`. An invalid answer, timeout, or command failure falls back to the built-in parser.

`kinds` includes `conversation` when the stack has Ivy conversations. A parser answers `{ "kind": "conversation" }` for a question or a request to think, discuss, brainstorm, decide or explore that is not something to save or schedule; Cortex ignores any `fields` and carries the typed text unchanged. When the stack has conversations, a `none` answer (or no rules match) also becomes a conversation proposal instead of a refusal, and every other card offers "Talk it over with Ivy instead". Confirming either posts `{ startId, text, area? }` to `POST /api/conversations/asks`, which creates one conversation per `startId` and sends the text as its first message; a retry with the same `startId` opens the same conversation. No writer runs for this kind. Without conversations, such a request is refused with HTTP 422 and the text stays in the command bar.

### Routed parsers

Optional `ask.routing.permitted` enables the version 1 routed result contract. It lists `codex` and `pi`, with no duplicates. An empty list permits none. Claude is not a Desk parser provider. Remove `claude` from existing Desk routing permissions and the adapter's configured providers before upgrading. The configured parser command must support this contract, such as `desk-parse --routing-config /path/to/routing.json` from cortex-desk-adapters. Provider commands, models, Ranger configuration, and timeouts belong in that adapter's configuration.

`POST /api/desk/ask` accepts optional `area` and `routing.permitted` restrictions alongside `text`. The browser sends the selected area for text and voice requests. Before invocation, Cortex intersects configured permissions with request restrictions and the selected area's policy. A local area permits only `pi`; the principal must configure that adapter with a local endpoint. Unknown areas and malformed restrictions are rejected before parsing. A local request on a legacy parser is refused. With All selected, no area restriction applies.

Parser stdin adds `routing: { permitted: [...] }`. The adapter intersects these permissions with its own configuration and delegates selection to Ranger. Cortex does not implement quota thresholds or select providers.

The parser result adds `routing`, with `version: 1`, `kind: selected`, `provider`, `reason`, `attempted`, `candidates`, `fallbackReasons`, and `capabilityExclusions`. `reason` is `most-headroom` or `pi-fallback`. Candidates retain Ranger's three-provider eligibility evidence, including the excluded Claude candidate. Only Codex and Pi can be selected or attempted. Every attempt must be permitted by the request, including attempts reported in unavailable results. A dispatch-time quota failure appears in `fallbackReasons` as `{ provider, reason: "quota-exhausted" }` for an attempted provider. The validated metadata reaches `proposal.routing`, and the card displays the selected provider and reasons.

An unavailable result has `kind: none` and `routing.kind: unavailable`, with a reason and the same evidence arrays. Cortex returns HTTP 503 with a plain explanation and routing diagnostics. Invalid or missing routed output also returns HTTP 503 and never falls back to rules. Proposal fields and task-map membership are validated independently. Routed proposals always require confirmation, including captures with an existing automatic-capture grant.

Without `ask.routing`, legacy parser output and rules fallback remain supported. Output that includes routing metadata is validated even in legacy mode.

A writer runs only after confirmation. Its stdin contains `kind`, `fields`, and `requestId`:

```json
{
  "kind": "reminder",
  "fields": { "text": "Stretch", "due": "2026-11-02T09:10:00Z" },
  "requestId": "desk-request-0001"
}
```

Fields depend on the kind. Required text values are trimmed and nonempty.

| Kind | Required fields | Optional fields |
|---|---|---|
| `reminder` | `text` (at most 300 characters), `due` (date and time) | none |
| `note` | `text` (at most 1000 characters) | none |
| `task` | `title` and `map` (each at most 200 characters) | `details` (at most 4000 characters) |
| `goal` | `wording` (at most 300 characters) | none |
| `calendar` | `title` (at most 200 characters), `start` (date and time) | `end` (date and time), `allDay` (boolean), `location` (at most 200 characters), `notes` (at most 2000 characters) |

`requestId` contains 8 to 64 letters, digits, underscores, or hyphens. Retries of one confirmed card reuse it. Writers must avoid creating a second object when a request id has already succeeded.

A successful writer exits 0 and prints `{ "id": "created-id", "url": "https://example.org/item", "message": "Created the reminder." }`. `id` is required and nonempty. `url` is optional and starts with `http:` or `https:`. `message` is optional and at most 300 characters. On refusal or failure, exit nonzero with a plain explanation on the last stderr line. On a timeout or unreadable success answer, the Desk warns that the object may already exist.

Notes and reminders without a writer are stored on the Desk. Configuring a writer replaces that local creation, so the destination tool becomes responsible for displaying or notifying about the object.

## Mail classifiers

A classifier command receives:

```json
{
  "mail": {
    "id": "budget@example.org",
    "from": { "name": "Ada", "address": "ada@example.org" },
    "subject": "Budget draft",
    "firstParagraph": "Could you review this?",
    "receivedAt": "2026-11-02T08:30:00Z",
    "account": "work"
  },
  "meetings": [{ "key": "cal:calendar:planning", "title": "Planning", "start": "2026-11-03T09:00:00Z" }],
  "vips": ["ada@example.org"],
  "unimportant": ["@news.example.org"],
  "corrections": [{ "kind": "mail", "source": "work-mail", "mode": "always", "label": "Work mail" }]
}
```

`meetings` contains timed meetings in the next 14 days. `corrections` contains at most 10 recorded mail-ranking corrections. Mail and event text is untrusted data. A configured API key is passed in `DESK_CLASSIFIER_KEY`, not in argv.

The command exits 0 and prints one object:

```json
{
  "category": "reply",
  "reason": "Ada asks for your review.",
  "summary": "Review the budget before the planning meeting.",
  "suggestedAction": "reply",
  "evidence": [{ "kind": "mail", "ref": "budget@example.org", "title": "Budget draft" }]
}
```

`category` is required: `action`, `reply`, `meeting`, `fyi`, or `bulk`. `reason` is required, nonempty, and at most 200 characters. Optional `meetingKey` must be one of the supplied keys. Bulk classifications discard it. Optional command-only details are `summary` (at most 600 characters), `suggestedAction` (`reply`, `archive`, `link-meeting`, `task`, or `none`), and `evidence` (at most 5 entries). Each evidence entry has `kind` (`mail`, `event`, or `note`), nonempty `ref` (at most 300 characters), and nonempty `title` (at most 200 characters).

The endpoint form of the classifier uses OpenAI-compatible chat completions and reads the base category, reason, and meeting key. Command-only details are validated for command classifiers. Invalid output or nonzero exit leaves fixed-rule ranking in use and schedules a later retry.

## Mail actions

A trash command receives `{ "action": "trash", "account": "work", "messageId": "budget@example.org" }`. It must move that one message to Trash. Exit 0 means success. Cortex then hides the item locally. Nonzero exit shows the last stderr line and leaves the item listed.

A draft command receives:

```json
{
  "action": "draft",
  "account": "work",
  "messageId": "budget@example.org",
  "to": "ada@example.org",
  "subject": "Re: Budget draft",
  "body": "I will review it this afternoon."
}
```

The recipient and subject come from the cached source reading. The person writes `body`, which must be nonempty and at most 20000 characters. Exit 0 means the reply was saved in Drafts. The command must never send it. Nonzero exit reports the last stderr line. The original item stays on the Desk after a draft.

Both commands require `account` on the source mail item. Their stdout is not a structured result contract. On a timeout, Cortex warns that the operation may have completed. A command should independently validate the account, message id, and operation before changing anything.

## Transports

With `interruptions.transport: command`, the transport receives:

```json
{
  "key": "meeting:cal:calendar:planning@1793606400000",
  "title": "Planning starts at 09:00.",
  "why": "It starts in 10 minutes.",
  "action": { "label": "Join", "url": "https://meet.example.org/planning" }
}
```

`key`, `title`, and `why` are strings. `action` is optional. Cortex includes an action only when its URL is a valid HTTP or HTTPS URL without whitespace or angle brackets. The command exits 0 after accepting the notification. Its stdout is ignored. Nonzero exit or timeout becomes a failed delivery shown on the Desk. Cortex records delivery per item, so a transport must not rely on automatic retries.

For example, the `desk-ntfy` adapter in cortex-desk-adapters posts this notification to an ntfy topic:

```yaml
mc:
  desk:
    interruptions:
      transport: command
      command: [/opt/cortex-desk-adapters/bin/desk-ntfy.ts, --server, https://ntfy.example.org, --topic, private-desk]
      timeoutSeconds: 10
```

The ntfy endpoint receives the notification text and optional action link. Use a topic and server appropriate for the information being sent.

## Goal checks

A `goals.check.<goal>.command` receives its configured argv and environment, without JSON stdin. Exit 0 reports that the check ran. Nonzero exit displays its last stderr or stdout line. The command publishes the resulting goal reading to Vigil through its own mechanism; stdout is not parsed as a source reading. The Desk waits up to five minutes for a newer Vigil reading before allowing another check.

`goals.somaBin` is the Soma executable. Cortex invokes `goal list` to read statuses and `goal set-status <goal> paused` to pause an active goal. These are Soma CLI contracts rather than replaceable JSON commands.
