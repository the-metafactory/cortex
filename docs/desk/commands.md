# Desk command contracts

Cortex runs Desk commands as argument arrays without a shell. Sources print one JSON object on stdout. Other commands receive one JSON object on stdin, followed by EOF. Diagnostic messages belong on stderr.

The config reference lists [timeouts and command locations](configuration.md). Commands must be available to the daemon's user and environment. The example implementations are in [cortex-desk-adapters](https://github.com/the-metafactory/cortex-desk-adapters/blob/main/EXAMPLES.md).

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
