# Desk configuration reference

The Desk configuration lives under `mc.desk` in a stack's YAML file. Mission Control must have `mc.enabled: true`. Omitting `mc.desk` uses the defaults below. The schema is [`src/common/types/config.ts`](../../src/common/types/config.ts).

Command values are argument arrays, such as `[/usr/local/bin/bun, /opt/adapters/calendar.ts]`. Cortex runs them without a shell. Shell variables, pipes, and `~` in source arguments are not expanded. Absolute paths work regardless of the daemon's working directory.

## General settings

| Key | Default | Value and meaning |
|---|---|---|
| `enabled` | `true` | Enables the Desk API and view. |
| `displayName` | `""` | Name used in the greeting. |
| `topN` | `5` | Integer from 1 to 10. Number of ranked items shown before the rest fold away. |
| `ranger.url` | `""` | Ranger API base URL. Empty disables Ranger readings. |
| `ranger.bin` | `""` | Ranger CLI executable for actions. Empty disables those actions. |
| `ranger.config` | `""` | Optional Ranger config path passed to its CLI. |
| `soma.bin` | `""` | Soma executable for recording rulings on work-graph nodes. |
| `areas` | `[]` | Area definitions described below. |
| `sources` | `[]` | Calendar and mail commands described below. |
| `studio` | absent | Optional Studio directory settings. |

`ranger.bin`, `ranger.config`, and `soma.bin` accept a leading `~`. Rulings need both Ranger actions and `soma.bin`.

Each `areas` entry has required nonempty `id` and `label` strings. Its optional fields are `color` (default `""`), `repos` and `goals` (string arrays, default `[]`), and `policy` (`local` or `cloud`, default `cloud`). Repository and goal lists associate Cortex items with an area. A source's `area` associates all its entries with that area. Studio uses the policy to choose where a thread may be processed.

`studio.dir` is a required nonempty directory path when Studio is configured. `studio.maxActive` defaults to 5 and accepts integers from 1 to 20. Optional `studio.yesFilter` contains 1 to 12 nonempty questions, each at most 200 characters after trimming. Without it, Studio asks "Is this mine to do?", "Does it fit my capacity?", and "What will I stop doing for it?" before a new commitment. See [Desk Studio: thread files](../desk-studio.md).

## Sources

Each entry in `sources` has these fields:

| Key | Default | Value and meaning |
|---|---|---|
| `id` | required | Nonempty, stable name for this source. Use a different id for each source. |
| `command` | required | Nonempty argument array. Every argument is a nonempty string. |
| `area` | absent | Area id attached to every entry from this source. |
| `everySeconds` | `300` | Integer from 30 to 86400. Minimum interval between reads. |
| `timeoutSeconds` | `30` | Integer from 1 to 300. Command timeout. |

The first Desk request waits for the first read. Later requests use the cached reading while an expired source refreshes. A failed command keeps the previous entries and reports the error. Invalid entries are dropped individually, with a field path in the system line. See [Source output](commands.md#source-output).

## Command bar

| Key under `ask` | Default | Value and meaning |
|---|---|---|
| `parser` | `[]` | Argument array for an optional text parser. Empty uses the built-in rules. |
| `timeoutSeconds` | `30` | Integer from 1 to 120. Timeout for the parser and writers. |
| `routing` | absent | Optional `{ permitted: [claude, codex, pi] }`. Enables required version 1 routing metadata. Request and area restrictions narrow this list before selection. |
| `writers` | `{}` | Optional commands keyed by `calendar`, `task`, `goal`, `note`, or `reminder`. Each is a nonempty argument array. |
| `taskMaps` | `[]` | Allowed task destinations, each with `ref` and `label`. A ref has the form `owner/repo#123`. |

Notes and reminders stay in the Mission Control database when no writer is configured for their kind. A configured writer replaces that local storage. Calendar entries, tasks, and goal drafts need writers. Legacy parser failure falls back to the built-in rules. Routed parser failure returns an unavailable explanation. See [Parsers and writers](commands.md#parsers-and-writers).

## Interruptions

All keys below are under `interruptions`.

| Key | Default | Value and meaning |
|---|---|---|
| `transport` | `none` | `none`, `discord`, or `command`. Discord uses the stack's Discord adapter to notify its principal. |
| `command` | absent | Required nonempty argument array when transport is `command`. |
| `timeoutSeconds` | `10` at runtime | Integer from 1 to 120. Command transport timeout. |
| `meetingMinutes` | `10` | Integer from 0 to 120. Meetings starting within this window interrupt. Zero disables meeting interruptions. |
| `mail` | `true` | Allows fresh mail ranked for today to interrupt. |
| `reminders` | `true` | Allows due reminders to interrupt. |
| `maxAgeMinutes` | `60` | Integer from 1 to 1440. Maximum age of interrupting mail or reminders. |
| `everySeconds` | `60` | Integer from 15 to 3600. Background push interval. |
| `chime` | `true` | Plays a sound in the Desk tab for a new interrupting item. |
| `notifications` | `true` | Allows browser notifications after the person grants permission. |

Browser notifications require a secure context such as HTTPS or localhost. Push delivery is recorded per item. A failed delivery is shown on the Desk rather than retried automatically. The command's JSON input is in [Transports](commands.md#transports).

## Voice

| Key under `voice` | Default | Value and meaning |
|---|---|---|
| `enabled` | `true` | Enables push-to-talk controls. |
| `input` | `browser` | `browser` or `elevenlabs`. |
| `output` | `browser` | `browser` or `elevenlabs`. |
| `elevenlabs.voiceId` | required for ElevenLabs | 8 to 64 ASCII letters or digits. |
| `elevenlabs.apiKeyEnv` | `ELEVENLABS_API_KEY` | Environment variable containing the API key. |
| `elevenlabs.envFile` | absent | Optional file from which Cortex reads the named key. |
| `elevenlabs.ttsModel` | `eleven_turbo_v2_5` | Nonempty speech output model name. |
| `elevenlabs.sttModel` | `scribe_v1` | Nonempty transcription model name. |
| `elevenlabs.timeoutSeconds` | `20` | Integer from 1 to 120. Provider timeout. |

The `elevenlabs` object is required if either direction uses ElevenLabs. Browser input depends on speech recognition support and microphone permission in the browser. The API key stays on the server.

## Mail

`mail.classifier` is optional. It accepts exactly one of two forms: `command`, or `baseUrl` with `model`. Without a classifier, fixed rules rank mail.

| Classifier key | Default | Value and meaning |
|---|---|---|
| `command` | absent | Nonempty argument array for a classifier command. |
| `baseUrl` | absent | OpenAI-compatible API base URL, normally ending in `/v1`. Requires HTTPS except on loopback. Cortex appends `/chat/completions`. |
| `model` | absent | Nonempty model name for the endpoint form. |
| `apiKeyEnv` | absent | Environment variable containing the key. Mutually exclusive with `apiKeyFile`. |
| `apiKeyFile` | absent | File containing the key. Mutually exclusive with `apiKeyEnv`. |
| `caFile` | absent | PEM CA file for the endpoint form. For a command, pass its CA option in `command` instead. |
| `timeoutSeconds` | `30` | Integer from 1 to 120. Timeout per classification. |
| `maxPerPass` | `10` | Integer from 1 to 100. Maximum unclassified mail items processed per pass. |

A configured key reaches a command as `DESK_CLASSIFIER_KEY`. A classifier failure leaves rule-based ranking in place and permits another attempt after ten minutes. The command form can return summaries and evidence in addition to a category. See [Mail classifiers](commands.md#mail-classifiers).

`mail.actions.trash` and `mail.actions.draft` are optional nonempty command arrays. `mail.actions.timeoutSeconds` defaults to 30 and accepts integers from 1 to 120. Both actions require the mail source to supply `account`. A draft command saves the person's reply to Drafts and never sends it. **Unimportant** records the sender and invokes `trash` when configured. Without `trash`, it hides the item locally.

`mail.links.mail` and `mail.links.note` are optional URL templates for classifier evidence. Each must contain `{ref}` and start with a URL scheme. Cortex replaces `{ref}` with the encoded reference. `javascript:`, `data:`, `vbscript:`, and `file:` are refused.

VIP senders, unimportant senders, and ranking corrections are managed on the Desk and stored in its database. They are not YAML fields.

## Goal actions

`goals.somaBin` defaults to `""`. Setting it enables goal status reads and pausing through Soma. It is separate from `soma.bin`, which records rulings.

`goals.check` defaults to `{}`. It maps a goal id to a command definition. A key starts with a letter and contains at most 64 letters, digits, underscores, dots, or hyphens. Each definition has a required nonempty `command` array, optional `env` object (default `{}`), and `timeoutSeconds` (default 60, integer from 1 to 300). Environment keys must be valid variable names. The executable and environment values accept a leading `~`.

```yaml
mc:
  desk:
    goals:
      somaBin: /usr/local/bin/soma
      check:
        G1:
          command: [/opt/checks/check-goal, G1]
          timeoutSeconds: 60
```

The goal check must publish its reading through its own mechanism. Exit 0 only reports that the command ran successfully. See [Goal checks](commands.md#goal-checks).
