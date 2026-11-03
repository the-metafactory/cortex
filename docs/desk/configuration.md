# Desk configuration reference

The Desk configuration lives under `mc.desk` in a stack's YAML file. Mission Control must have `mc.enabled: true`. Omitting `mc.desk` uses the defaults below. The schema is [`src/common/types/config.ts`](../../src/common/types/config.ts).

You can also put Desk settings in `desk.yaml` beside the main Cortex configuration file, in either a single-file or directory layout. Set its permissions to `600`. Put the Desk fields directly at the root, without an `mc:` or `desk:` wrapper. This optional file overrides matching `mc.desk` fields after the normal configuration layers. Nested objects merge, while arrays replace the previous array. Omitted fields keep their existing values. Restart Cortex after editing this file.

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
| `conversations` | absent | Model lanes and pi settings for Ivy conversations, described below. |

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
| `writers` | `{}` | Optional commands keyed by `calendar`, `task`, `goal`, `note`, or `reminder`. Each is a nonempty argument array, or `{ command, owner }` where `command` is that array and `owner` names the system the writer saves to, in lowercase letters, digits and dashes. An Ivy conversation adds Tana notes only when the `note` writer declares `owner: tana`. |
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

To use ElevenLabs for recognition and spoken answers, put this in `desk.yaml`:

```yaml
voice:
  enabled: true
  input: elevenlabs
  output: elevenlabs
  elevenlabs:
    voiceId: replaceWithYourVoiceId
    apiKeyEnv: ELEVENLABS_API_KEY
    sttModel: scribe_v2
```

Replace `voiceId` with your ElevenLabs voice ID and make the named key available to the Cortex runtime, or set `envFile` to the protected file containing that variable. If valid ElevenLabs options already exist in the stack configuration, `desk.yaml` can contain only `voice: { input: elevenlabs }` to switch recognition while preserving those options.

ElevenLabs input records while you hold the microphone control and transcribes when you release it. It does not use the browser's speech recognition service or show a live partial transcript. Microphone recording still requires browser permission and a secure context, such as HTTPS or localhost. A failed transcription shows the provider's reason and leaves text input available.

### Local wake detection

`voice.wake` is optional and disabled by default. Wake uses the pinned Sherpa 2.0.1 detector and English GigaSpeech 3.3M model. It requires `voice.input: elevenlabs`, a secure browser context, AudioWorklet, MediaRecorder, and Web Locks. The existing output provider remains configurable.

| Key under `voice.wake` | Default | Value and meaning |
|---|---|---|
| `enabled` | `false` | Makes the opt-in wake control available. Opening Desk does not activate the microphone. |
| `assistantName` | `Assistant` | Configured assistant name. Set `phrase` separately. |
| `phrase` | `Hey Assistant` | 2 to 60 English letters and spaces. |
| `tokens` | absent | SentencePiece tokens provisioned from the matched BPE model. |
| `tokenizerSha256` | absent | Matched BPE hash emitted by the provisioner. |
| `detector` | `sherpa-2.0.1` | Only the declared pinned detector is supported. |
| `model` | `gigaspeech-3.3m-2024-01-01` | Only the declared matched model is supported. |
| `threshold` | `0.25` | Trigger threshold from 0.01 to 1. Lower values permit weaker matches. |
| `score` | `3` | Keyword boost from 0.1 to 10. |
| `preRollMs` | `2000` | Bounded local PCM buffer, 500 to 3000 milliseconds. |
| `silenceMs` | `900` | End-of-speech silence, 300 to 3000 milliseconds. |
| `maxCommandMs` | `15000` | Maximum command capture, 3000 to 30000 milliseconds. |
| `speechThreshold` | `0.015` | RMS energy threshold, 0.001 to 0.2. |

The normal dashboard build downloads and checks pinned archives, applies three exact browser-loader adaptations, and writes the runtime, model, licences, and integrity manifest to `dist/dashboard-v2/wake`. It needs HTTPS access to npm and the official Sherpa release. Downloads are cached by hash under `node_modules/.cache/desk-wake`. The server serves only declared wake asset names.

Phrase labels alone do not provision a keyword. See [Enable a wake phrase](wake.md) for the matched-token procedure. Missing assets, unsupported tokens, and mismatched phrase configuration produce an unavailable state.

Detection stays local. After a wake, one browser-recorded command clip goes through the existing transcription adapter and voice turn. Sherpa's keyword timestamp trims earlier audio from the bounded pre-roll while preserving immediate words. The clip can include the matched wake phrase. A wake-only clip can reach transcription to distinguish it from a short command contained entirely in pre-roll; a transcript containing only the configured phrase does not start a Desk action. Unmatched speech sends no transcription request.

One Desk tab owns the microphone through detection, command capture, and playback. Manual capture in that tab disables wake before taking ownership. Another tab reports that the microphone is in use. Disable wake there before enabling it elsewhere. Recognition pauses during assistant playback and resumes with an empty buffer. Disabled wake, navigation, and page exit release capture resources. No native service is installed.

Minimizing alone does not stop listening. A suspended AudioContext, stale processing, or lost microphone produces an unavailable state on detection or when the page resumes execution. Enable wake again to recover. Browser shutdown ends capture.

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

`mail.log.retentionDays` defaults to 180 and accepts integers from 1 to 3650. The Desk logs every decision on a mail in `desk_mail_log`: sender and domain, List-Id, the classifier's category, the subject and a short summary (never the body), the action, and whether it happened on the Desk or in the mail client. A Desk action is logged only after its command succeeds. When a mail the Desk listed as unread is read or leaves the inbox without a Desk action, the next source reading logs it as a client decision: read and kept, or moved to Archive, Junk or Trash, found with the move command's `locate` request. A mail the move command reports in none of those folders is logged as `gone`; a lookup that fails is tried again with the next readings and never logged as a guess. Without a move command, only read-and-kept is logged. Decisions older than the retention are deleted. A mail's decisions show in its detail history.

`mail.links.mail` and `mail.links.note` are optional URL templates for classifier evidence. Each must contain `{ref}` and start with a URL scheme. Cortex replaces `{ref}` with the encoded reference. `javascript:`, `data:`, `vbscript:`, and `file:` are refused.

VIP senders, unimportant senders, and ranking corrections are managed on the Desk and stored in its database. They are not YAML fields.

## Routines

`routines` is optional. Without it, recurring requests show a setup message.

```yaml
mc:
  desk:
    routines:
      composer: [/opt/desk/compose-installed-flow]
      reflex: [/opt/desk/reflex-personal]
      target: "@example/pulse-flow"
      timeZone: Europe/Zurich
      timeoutSeconds: 120
      readTimeoutSeconds: 3
```

`composer` and `reflex` are nonempty argument arrays. `target` names the configured principal's `pulse-flow` process. `timeZone` is an IANA timezone. `timeoutSeconds` accepts integers from 1 to 300 and bounds composition and writes. `readTimeoutSeconds` accepts numbers from 0.01 to 5 and bounds state reads separately. The Desk refreshes routine state in the background.

`capabilityBuild` is optional. Without it, a routine refused for a missing capability shows the missing capability and the steps that need it, and offers no action. With it, the refusal offers **Build this capability**.

```yaml
mc:
  desk:
    routines:
      capabilityBuild:
        writer: [bun, /opt/cortex/scripts/desk-capability-node.ts]
        map: example-org/example-maps#12
        template: /opt/desk/capability-brief.md
        budget:
          tokens: 200000
          invocations: 40
          minutes: 60
```

`writer` is a nonempty argument array. `map` is the map root where the build nodes are filed, written as `owner/repo#123` (GitHub), `github:host/owner/repo#123` or `gitlab:host/group/project#123`. `template` is optional and names a brief template file that replaces the shipped `scripts/desk-capability-template.md`. `budget` sets the `tokens`, `invocations` and `minutes` limits of each filed node; all three are required positive integers. The map belongs to the stack's configuration and never to Cortex's code. See [capability writers](commands.md#capability-writers).

The composer command uses the installed Pulse composer with an explicitly configured model and trusted installed-action catalog. Reflex owns activation files and flow files. The Desk stores the reviewed proposal and supplies a private temporary flow input to Reflex. See the [routine command contract](commands.md#routines).

## Flows

`flows` is optional. Without it, a conversation cannot save a flow, and the `flow` type shows as unavailable.

```yaml
mc:
  desk:
    flows:
      pulse: [/opt/desk/pulse]
```

`pulse` is a nonempty argument array for the Pulse CLI. When the principal confirms a `flow` proposal, the Desk writes the definition to a private temporary file and runs `pulse flow save --file <file> --request-id <id> --conversation <id> --exchange <id> --json`. Pulse stores the flow in its saved-flows directory and records the conversation as provenance. Pulse uses `$XDG_CONFIG_HOME/pulse/flows`, and the flow name is unique within it. When several stacks share a host, give each stack its own directory by setting `XDG_CONFIG_HOME` in its command, for example `[env, XDG_CONFIG_HOME=/srv/stack/config, /opt/desk/pulse]`. The Desk reads a save back with `pulse flow show --request-id <id> --json`. It never runs, schedules or enables a flow.

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

## Ivy conversations

Ivy answers conversation turns through [pi](https://pi.dev) (`pi --mode json`). Without `conversations`, or without a lane for a conversation's policy, a turn is refused and nothing is sent. No other engine is used as a fallback.

```yaml
mc:
  desk:
    conversations:
      local: { provider: spark, model: longctx }
      cloud: { provider: anthropic, model: claude-sonnet-5-5 }
      pi:
        bin: ~/.local/bin/pi
        extensions: [~/.pi/agent/extensions/soma.ts]
        tools: [soma_context, read, grep, find, ls]
        timeoutSeconds: 300
        passEnv: []
```

`local` and `cloud` are lanes: a pi `provider` and `model`, and optional `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`). A local-only conversation runs only on `local`. A cloud-allowed conversation uses `cloud`, or `local` when `cloud` is absent. Only you can decide which provider counts as local; Cortex does not infer it.

To offer more than one cloud model, write `cloud` as a list of lanes, each with an `id` (lower-case letters, digits and dashes, unique in the list):

```yaml
mc:
  desk:
    conversations:
      local: { provider: spark, model: longctx }
      cloud:
        - { id: codex, provider: openai-codex, model: gpt-6.1-sol }
        - { id: claude, provider: anthropic, model: claude-opus-5-5 }
```

These rules decide which cloud model answers:

- The first lane in the list is the default. New conversations, Studio conversations and Hand to Ivy use it.
- In the conversation view, **Cloud model** chooses another lane for that conversation. The choice applies from the next turn. The record shows that the context was reconstructed for the new model.
- A local-only conversation ignores the choice and runs only on `local`.
- If the chosen model fails, the turn shows the failure, names the model and offers **Retry**. Cortex never switches to another model or provider on its own.
- If the chosen lane is removed from the config, the conversation refuses new turns and says so until you choose another model.

Each answer in the conversation record names the provider and model that produced it, for example `openai-codex/gpt-6.1-sol`. A single `cloud` lane keeps working unchanged; it is the only cloud model and has no choice in the view.

<!-- glossary-ignore: agent -->
`pi.bin` defaults to `pi` on the Cortex runtime's `PATH`, then `~/.local/bin/pi`. `pi.extensions` defaults to `soma.ts` in pi's agent directory (`PI_CODING_AGENT_DIR`, else `~/.pi/agent/extensions`) when that file exists. These are the only pi extensions loaded: Cortex passes `--no-extensions`, `--no-mcp` and `--no-context-files`, so installed packages, MCP servers and other extensions are not loaded inside a conversation. Without a projection, Cortex logs "no Soma projection found" at start and turns have no Soma tools.

pi gets only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `TERM`, `TZ`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and variables starting with `PI_`, `SOMA_`, `XDG_` or `LC_` from the Cortex environment. Add the names of other variables it needs, such as a provider key variable, to `pi.passEnv`.

`pi.tools` can only narrow the read-only tools `soma_context`, `read`, `grep`, `find` and `ls`. Cortex passes them as an explicit `--tools` allowlist, so write, edit, shell, web, task and routing tools, and any tool installed later, stay unavailable. A turn on a cloud lane gets no file read or search. Every tool call and its result is recorded in the conversation. A call to a tool outside the allowlist is recorded as refused when pi answers that the tool was not found; any other result stops the turn with an error.

pi keeps one session per conversation and lane under the stack's conversation directory (`pi-sessions`). If that session is missing, or the lane or engine changed, the next turn starts a new session with the earlier exchange from the conversation record, and the record shows that the context was reconstructed.

### Hand a mail to Ivy

<!-- glossary-ignore: run -->
<!-- glossary-ignore: body -->
The same lanes and pi settings run **Hand to Ivy** on a mail card. The action is offered when `conversations` has a lane, `ask.writers.task` and at least one `ask.taskMaps` entry are set, and `mail.actions.draft` is set. It files an agent task on the first task map with the mail's sender, subject, classifier summary, link and your optional instruction, never the mail body; keep that map private. Ivy then gets one pi turn with the subject, summary and the mail's first paragraph, and answers with findings and a reply draft. A mail from a `local`-policy area runs only on the `local` lane; any other mail runs on the default `cloud` lane, or on `local` when `cloud` is absent. Suspicious mail is never handed over.

While Ivy works, the mail card shows "With Ivy since" and the time. The result arrives as a card in Catch-up: **Approve** saves the draft through `mail.actions.draft`, **Edit** opens it in the reply editor first, and **Discard** closes it. Nothing is sent. A failed turn shows its reason with **Ask Ivy again**; the hand-off is kept in `desk_mail_handoffs`. pi sessions for hand-offs live under the stack's `mail-handoff` directory. The task on the map stays open; the Desk does not close it.
