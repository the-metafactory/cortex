# Desk configuration reference

The Desk configuration lives under `mc.desk` in a stack's YAML file. Mission Control must have `mc.enabled: true`. Omitting `mc.desk` uses the defaults below. The schema is [`src/common/types/config.ts`](../../src/common/types/config.ts).

You can also put Desk settings in `desk.yaml` beside the main Cortex configuration file, in either a single-file or directory layout. Set its permissions to `600`. Put the Desk fields directly at the root, without an `mc:` or `desk:` wrapper. This optional file overrides matching `mc.desk` fields after the normal configuration layers. Nested objects merge, while arrays replace the previous array. Omitted fields keep their existing values. Restart Cortex after editing this file.

Command values are argument arrays, such as `[/usr/local/bin/bun, /opt/adapters/calendar.ts]`. Cortex runs them without a shell. Shell variables, pipes, and `~` in source arguments are not expanded. Absolute paths work regardless of the daemon's working directory.

## General settings

### Serving an external UI

Set `mc.ui.dir` in the stack configuration to serve an external UI in place of the bundled Desk:

```yaml
mc:
  enabled: true
  ui:
    dir: /opt/example-ui/dist
```

<!-- glossary-ignore: path -->
The directory must be an absolute path or start with `~/`, which expands to the home directory. It must exist and contain an `index.html` file. `cortex config validate` and Mission Control startup reject an invalid directory with an error naming `mc.ui.dir`; there is no fallback to the Desk.

Mission Control serves `/` and `/index.html` from this directory with the Desk's Content-Security-Policy. Static assets must be directly inside the directory and have a `js`, `css`, `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `ico`, `map`, `woff` or `woff2` extension. Nested asset paths and client-side route fallbacks are not supported. Files whose resolved paths escape the configured directory, including symlinks pointing outside it, return 404.

<!-- glossary-ignore: host -->
`/api/*`, `/ws`, `/health` and Cortex's `/wake/` assets keep their existing behavior. The UI uses the same origin and the existing Host, Origin and identity checks. Omit `mc.ui.dir` to serve the bundled Desk.

### Desk settings

| Key | Default | Value and meaning |
|---|---|---|
| `enabled` | `true` | Enables the Desk API and view. |
| `displayName` | `""` | Name used in the greeting. |
| `assistantName` | `Assistant` | The name the Desk shows for the assistant, a display label not tied to a configured agent: 1 to 60 characters on one line. `GET /api/desk` returns it as `assistantName`; the text the Desk composes, its model prompts and the bundled Desk use it. |
| `topN` | `5` | Integer from 1 to 10. Number of ranked items shown before the rest fold away. |
| `ranger.url` | `""` | Ranger API base URL. Empty disables Ranger readings. |
| `ranger.bin` | `""` | Ranger CLI executable for actions. Empty disables those actions. |
| `ranger.config` | `""` | Optional Ranger config path passed to its CLI. |
| `soma.bin` | `""` | Soma executable for recording rulings on work-graph nodes. |
| `areas` | `[]` | Area definitions described below. |
| `sources` | `[]` | Calendar and mail commands described below. |
| `studio` | absent | Optional Studio directory settings. |
| `conversations` | absent | Model lanes and pi settings for conversations, described below. |

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
| `writers` | `{}` | Optional commands keyed by `calendar`, `task`, `goal`, `note`, or `reminder`. Each is a nonempty argument array, or `{ command, owner }` where `command` is that array and `owner` names the system the writer saves to, in lowercase letters, digits and dashes. A conversation with the assistant adds Tana notes only when the `note` writer declares `owner: tana`. |
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
| `holdDuringMeetings` | `true` | Holds mail and reminder interruptions while a busy or unknown meeting runs, and pushes them once it ends. |

These keys set the stack's defaults. A reason switched on the Desk overrides its default, except that `mail: false` keeps every mail reason off and `meetingMinutes: 0` keeps meeting interruptions off. See [How the Desk interrupts](README.md#how-the-desk-interrupts).

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
| `assistantName` | `mc.desk.assistantName` | Name shown on the wake control. Without it, the Desk name is used. Set `phrase` separately. |
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
| `timeoutSeconds` | `30` | Integer from 1 to 180. Timeout per classification. |
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
      composeTimeoutSeconds: 900
      readTimeoutSeconds: 3
```

`composer` and `reflex` are nonempty argument arrays. `target` names the configured principal's `pulse-flow` process. `timeZone` is an IANA timezone. `timeoutSeconds` accepts integers from 1 to 300 and bounds writes. `composeTimeoutSeconds` accepts integers from 1 to 1800 and defaults to 900. It bounds composing a routine, which can take a read of the delivery plus three attempts on a slow local model, and the card then says the routine command timed out. It also bounds a routine edit, though `scripts/desk-compose.ts` holds one edit call to 600 s, and an edit that runs out reports that the model could not prepare a valid edit. A killed compose does not stop a local model's reply: `mlx_lm.server` writes a non-streaming reply only when it is done, so it keeps generating to its length limit. `readTimeoutSeconds` accepts numbers from 0.01 to 5 and bounds state reads separately. The Desk refreshes routine state in the background.

`capabilityBuild` is optional. Without it, a routine refused for a missing capability shows the missing capability and the steps that need it, and offers no action. With it, the refusal offers **Build this capability**.

```yaml
mc:
  desk:
    routines:
      capabilityBuild:
        writer: [bun, /opt/cortex/scripts/desk-capability-node.ts, --probe, '{"type":"artifact-exists","path":"capabilities/{slug}/index.ts","atRef":"main"}']
        map: example-org/example-maps#12
        template: /opt/desk/capability-brief.md
        start: [ranger, build-now, '{id}', --map, '{map}']
        status: [bun, /opt/cortex/scripts/desk-capability-status.ts, '{ref}']
        bundle: example-capabilities
        install: [/opt/desk/install-capabilities, '{bundle}']
        uninstall: [/opt/desk/uninstall-capabilities, '{bundle}']
        budget:
          tokens: 200000
          invocations: 40
          minutes: 60
```

`writer` is a nonempty argument array. `map` is the map root where the build nodes are filed, written as `owner/repo#123` (GitHub), `github:host/owner/repo#123` or `gitlab:host/group/project#123`. `template` is optional and names a brief template file that replaces the shipped `scripts/desk-capability-template.md`. `budget` sets the `tokens`, `invocations` and `minutes` limits of each filed node; all three are required positive integers. The map belongs to the stack's configuration and never to Cortex's code. See [capability writers](commands.md#capability-writers).

<!-- glossary-ignore: node -->
`start` and `status` are optional argument arrays. Each must contain `{ref}` or `{id}`, and the Desk replaces these placeholders in every argument: `{ref}` is the node reference (`owner/repo#123`), `{repo}` is `owner/repo`, `{id}` is the node number and `{map}` is `capabilityBuild.map`. With `start`, the Desk runs the command once for each node it newly filed, right after filing. With `status`, the Desk reads the build state of every filed node each time it refreshes routines. See [build start and status commands](commands.md#build-start-and-status-commands).

<!-- glossary-ignore: agent -->
`bundle`, `install`, and `uninstall` are optional as a group and require `status`. Both command arrays must contain `{bundle}`, which becomes the configured bundle name. The install command owns first installation, later upgrades, and agent reload. The uninstall command owns removal and reload. No package manager or repository is built into Cortex. See [capability installation commands](commands.md#capability-installation-commands).

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

## Conversations with the assistant

The assistant answers conversation turns through [pi](https://pi.dev) (`pi --mode json`). Without `conversations`, or without a lane for a conversation's policy, a turn is refused and nothing is sent. No other engine is used as a fallback.

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

- The first lane in the list is the default. New conversations, Studio conversations and Hand to the assistant use it.
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

### Communication tools

<!-- glossary-ignore: host -->
<!-- glossary-ignore: message -->
<!-- glossary-ignore: owner -->
<!-- glossary-ignore: data -->

Conversations discover the principal's installed communication tools through `communication_discover` and read them through `communication_read`. The tools exist only when the host registers connectors (`HostSources.communications`); a connector is a trusted host registration, not something the model or a message can add.

A connector declares its service, family (`email`, `calendar`, `reminders`, `discord`, `mattermost` or any other id), the explicitly configured scopes (accounts, mailboxes, calendars, reminder lists, workspaces, channels) with a `cloud` or `local` policy each, the read operations with their input schemas, and the actions it can only propose. Discovery always lists the five required families. A family with no connector reports `not-installed` and names the owner build still needed. A connector that is installed but signed out reports `not-authenticated` and advertises no operations.

Each read checks the owner's `authorize(principal, scope)` and the scope policy before the call, and again before the result is released; a revoked grant or a policy change in between withholds the result. Local-only scopes are invisible to cloud models and to Discord, and reading one tightens the conversation to local-only. Results are bounded (a connector returns at most 20 items per page and a larger page is refused; overflow stays behind `next`; 2000 characters per text), redacted, fenced as untrusted data and carry `observedAt`, `freshness`, `next` and `truncated`. Statuses are `ok`, `no-match`, `stale`, `denied`, `not-installed`, `not-authenticated` and `provider-failure`; connector error text is never passed on.

Sending, inviting or changing data stays with the creation tools: `creation_propose` prepares an editable proposal (for example a `mail-draft`) and the principal confirms it. An action whose owner has no operation shows `unavailable` with its follow-up. No connector ships in-tree; each owner adapter is a separate build.

### Hand a mail to the assistant

<!-- glossary-ignore: run -->
<!-- glossary-ignore: body -->
The same lanes and pi settings run **Hand to** (the assistant's name) on a mail card. The action is offered when `conversations` has a lane, `ask.writers.task` and at least one `ask.taskMaps` entry are set, and `mail.actions.draft` is set. It files an agent task on the first task map with the mail's sender, subject, classifier summary, link and your optional instruction, never the mail body; keep that map private. The assistant then gets one pi turn with the subject, summary and the mail's first paragraph, and answers with findings and a reply draft. A mail from a `local`-policy area runs only on the `local` lane; any other mail runs on the default `cloud` lane, or on `local` when `cloud` is absent. Suspicious mail is never handed over.

While the assistant works, the mail card shows "With" and its name, "since" and the time. The result arrives as a card in Catch-up: **Approve** saves the draft through `mail.actions.draft`, **Edit** opens it in the reply editor first, and **Discard** closes it. Nothing is sent. A failed turn shows its reason with **Ask (the assistant's name) again**; the hand-off is kept in `desk_mail_handoffs`. pi sessions for hand-offs live under the stack's `mail-handoff` directory. The task on the map stays open; the Desk does not close it.

### Hand a task to an agent

<!-- glossary-ignore: agent -->
<!-- glossary-ignore: run -->

`dispatch` is optional. Without it, or without the local bus (`nats`), `POST /api/desk/task-handoff` answers 409: "Handing tasks to an agent is not set up on this stack".

```yaml
mc:
  desk:
    dispatch:
      agents:
        - { id: luna, policy: cloud }
        - { id: scout, policy: local }
      startTimeoutSeconds: 120
      runTimeoutMinutes: 60
```

`agents` lists 1 to 10 agents. Each `id` must name an agent in the stack's `agents`, or `cortex config validate` rejects it. `policy` says whether the agent's model is local or cloud. A task in a `local`-policy area goes only to a `local` agent. `startTimeoutSeconds` accepts 10 to 600 (default 120), and `runTimeoutMinutes` accepts 1 to 1440 (default 60). Each agent must be registered as a local task receiver. Receivers are a boot snapshot, so a new one needs a restart (see `docs/task-receivers.md`). The receiver's policy must let the stack's signer dispatch to the agent.

The route takes one action per request:

| action | request | response |
|---|---|---|
| `preview` | `taskId`, `agent?`, `instruction?` (at most 1000 characters) | `{ ok, preview: { task, agent, agents, brief, briefHash, leaves } }`. Nothing is written. |
| `hand` | `requestId` (uuid), `taskId`, `agent`, `instruction?`, `briefHash` | `{ ok, id, message }` |
| `retry` | `requestId`, `id` | `{ ok, id, message }` |
| `discard` | `id` | `{ ok, message }` |
| `accept` | `id`, `done`, `requestId` | `{ ok, message, receipt? }` |

`taskId` is a Balance task id under a configured area. The Desk reads the task's title, notes, area and due date from the Balance store, never from the page. Inbox tasks are filed into an area first. `briefHash` is the SHA-256 of the brief the preview showed. `hand` rebuilds the brief and refuses a mismatch ("The task changed since the preview. Preview it again."), so the approval binds to the text that was shown. A repeated `requestId` answers the first receipt.

`hand` records the hand-off in `desk_task_handoffs` and publishes one signed task on `local.{principal}.{stack}.tasks.@{agent}.desk-task`. The attempt id is both the `task_id` and the `correlation_id`. Mission Control's `dispatch.task.*` projection matches the agent's lifecycle to the attempt. While the agent works, `myDay.handoffs[taskId]` and `agents.working` carry the line, either "Sent to Luna, waiting for it to start" or "With Luna since 14:05". A finished hand-off shows as a `task-handoff` card with the agent's answer, capped at 4000 characters and shown as the agent wrote it, plus the brief that was sent. Its actions are **Done**, **Keep open** and **Discard**. A failed hand-off shows the reason with **Retry** and **Discard**. A hand-off fails when the agent reports a failure, when nobody starts it within `startTimeoutSeconds`, or when no result arrives within `runTimeoutMinutes` of the start. Retry publishes a new attempt with a fresh correlation id, and a late answer to an older attempt is dropped. When the bus refuses the publish, the route answers 502 and keeps the hand-off for Retry.

**Done** marks the task done through `outline-complete` and returns an undo `receipt`. My Day's `undo` command with that receipt reopens the task. The day's completion log entry stays after a reopen. **Keep open** closes the card and leaves the task open. **Discard** while the agent works only stops waiting: the agent may still finish, and its answer is dropped. The result stays on the card; the Desk does not copy it into the task's notes.

### Implementation handoffs

<!-- glossary-ignore: agent -->
<!-- glossary-ignore: host -->
<!-- glossary-ignore: owner -->
<!-- glossary-ignore: node -->
<!-- glossary-ignore: run -->
<!-- glossary-ignore: body -->

`workers` is optional. Without it implementation brief filing, starting and stopping work report that handoff is not set up on this stack. Filing requires a configured registered map and an enabled graph repository.

```yaml
mc:
  desk:
    workers:
      maps: [example/maps#12]
      start: [ranger, build-now, '{id}', --map, '{map}']
      stop: [ranger, stop-node, '{id}', --map, '{map}', '--generation', '{generation}']
      status: [bun, /opt/cortex/scripts/desk-worker-status.ts, '{ref}']
      timeoutSeconds: 120
```

`maps` lists the registered map roots on which a conversation may start implementation work. Each of them lives in the stack's configuration, never in Cortex's code. `start`, `stop` and `status` are argument arrays. Cortex replaces `{ref}` with the recorded node reference, `{repo}` with its repository, `{id}` with the node number, `{map}` with the recorded map root and `{generation}` with the recorded worker generation. `start` must contain `{id}` and `{map}`; `stop` must contain the node, `{map}` and `{generation}`; `status` must contain `{ref}` or `{id}`. `timeoutSeconds` defaults to 120 and accepts integers from 1 to 600.

The four conversation tools follow the same authority rule as every other owner write. **worker_brief** prepares a brief with the repository, map, parent node, scope, acceptance checks, checkpoint, optional probes, blocked-by nodes and budget, and files it as a `work-brief` proposal. The node is filed as one that needs approval: a conversation never files an automatic node and never changes a node's autonomy. **worker_start** asks to start one exact recorded node through `start`; without a scoped standing permission the principal confirms it first. Ranger's own gates decide — dependencies, ownership, pause and drain, lane, provisioning, budget, approvals and its spawn cap — and a node Ranger will not run automatically is reported as awaiting approval, with the node left as it was. **worker_status** reads the recorded state through `status`. **worker_cancel** asks to stop the exact recorded generation through `stop`; it refuses a node with no recorded generation, a generation the owner no longer records, and a worker that already stopped. No tool edits a journal, kills a process, merges, deploys or sends.

`status` may be omitted; Cortex then uses `routines.capabilityBuild.status` when that is configured, so one adapter can serve both. The command prints one JSON object with `state` and optional `reason`, `pr`, `result`, `generation`, `url` and `prUrl`. States Cortex reads are `prepared`, `queued`, `running`, `stopping`, `waiting`, `review`, `merged`, `failed` and `cancelled`; the capability-build states `filed`, `building` and `in-review` map to `prepared`, `running` and `review`. A state the build does not map keeps the recorded state and reports the reason instead of guessing. `merged` means the pull request merged; it never means deployed or live, and the worker status view reports `deployed: false`.

The recorded handoff lives in `desk_worker_handoffs`, one row per node, with the originating conversation and entry, the proposal and operation ids, the map, the generation, the pull request and the last state. A retried start reconciles the recorded worker instead of starting a second one. Before dispatch, the status baseline identifies the next worker generation for response recovery; if that baseline is unavailable and the start response is lost, the request stays uncertain and is not dispatched again. An empty journal while a supervisor starts preserves the queued handoff. A stop Ranger acknowledges but has not confirmed stays `accepted` until a later read confirms it; `stop-requested` becomes `cancelled` only after both recorded process identifiers are null.
