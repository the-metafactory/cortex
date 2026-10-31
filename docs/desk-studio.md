# Desk Studio: thread files

The Desk Studio is a directory of Markdown files that holds the threads you think through with Ivy. Mission Control reads the directory on every request to `GET /api/desk/studio` and caches nothing. The files are the source of truth, so any tool that writes Markdown can read and append to them.

## Configuration

Add a `studio` block to `mc.desk` in the stack config, and give each area a model policy:

```yaml
mc:
  desk:
    studio:
      dir: ~/threads        # a git working tree; every Studio change is a commit here
      maxActive: 5          # optional; default 5
      yesFilter:            # optional; the questions asked when you open a thread
        - Does it keep my autonomy?
        - Is it a whole Yes?
    areas:
      - id: work
        label: Work
        policy: local       # local | cloud; default cloud
      - id: home
        label: Home
```

Without `desk.studio`, `GET /api/desk/studio` answers `{ "studio": null }`.

Without `yesFilter`, the Desk asks a default set: "Is this mine to do?", "Does it fit my capacity?" and "What will I stop doing for it?". The open dialog says which set it shows.

A thread's **effective policy** is the strictest policy of its areas: if any area is `local`, the thread stays on the local model. An area id that the config does not list counts as `local` and is reported as a problem.

## Directory layout

```text
<dir>/
  threads/<slug>.md      one file per thread
  inbox/<id>.md          captures that match no thread yet
  proposals/<id>.md      threads Ivy proposes
```

A slug or id is lowercase letters, digits and hyphens, and is the file name without `.md`. Mission Control ignores files that do not end in `.md` and files larger than 1 MB.

## Thread file

```markdown
---
type: question          # question | topic | making
areas: [work]           # one or more desk.areas ids
state: active           # active | parked | closed
opened: 2026-10-24
thinkTonight: false     # optional
closed: 2026-11-20      # optional
outcome: decided        # decided | shipped | dropped; required when closed
expect: I confirm My day on 4 of 5 weekdays.   # optional, for decided
reviewOn: 2026-12-15    # optional, for decided
---

## Question

How does the Desk become useful to someone else?

## Where I stand

Only the built-in sources count.

## Ivy's notes

### 2026-10-31T03:12:00+01:00
trigger: Stale thread: unchanged for 6 days
model: cloud

Three angles: ...

### 2026-10-31T03:14:00+01:00
trigger: Stale thread: unchanged for 6 days
model: cloud
kind: stand
because: Two of three personas have no mail adapter.

The threads are the product; the sources are the bonus.

## Material

- file: [BRIEF.md](https://example.org/brief)
- voice: Voice note, 29 Oct

## Log

- 2026-10-24: Opened

## Responses

### 2026-10-31T09:40:00+01:00
re: 2026-10-31T03:12:00+01:00

Lead with the Studio; the demo stack can wait.

## Outcome

It merges into the Desk.
```

Rules:

- Front matter is YAML between two `---` lines. Unknown keys are ignored.
- `## Question` is required. The other H2 sections are optional, appear at most once, and may come in any order. Other H2 sections are ignored.
- **Ivy's notes** are append-only H3 entries. The heading is an ISO time with a zone. Below it come metadata lines, then a blank line and the note text:
  - `trigger:` (required) names what started the note.
  - `model:` (required) names the model policy or model that wrote it.
  - `kind:` is `note` (default), `stand` (a proposed change to "Where I stand"; the text is the proposed stand), `idea` or `relation` (a proposed relation; see below).
  - `status:` is `open` (default), `kept` or `dismissed`.
  - `because:` gives the reason for a `stand` proposal.
  - `relates:` (required for `relation`) names what the thread relates to, in the material item syntax: `thread: <slug>`, `goal: G5: one post a week`, `person: Ana`, or `link: [label](href)`. The note text says why.
  - `sample: true` marks an example note that no model wrote.
- **Responses** are your answers to Ivy, as H3 entries headed by an ISO time with a zone. An optional first line `re: <time>` names the note answered; the rest is the text. **Ivy waits on you** while Ivy's latest note has `status: open` and no response is dated at or after it.
- **Material** and **Log** are bullet lists. A material item is `kind: [label](href)` or `kind: label`; without a kind it is a `link`. A log item may start with an ISO date.

## Inbox file

```markdown
---
at: 2026-10-30T18:20:00+01:00
via: voice
target:                 # optional: where Ivy would file it
  thread: open-source-desk
  reason: It is about newcomers to the Desk.
---
What if the demo stack had fake adapters?
```

## Proposal file

```markdown
---
type: question
areas: [work, home]
proposed: 2026-10-31T04:00:00+01:00
target:                 # required
  place: new
  area: work
  reason: It came up in three mails this week.
---

## Question

What should run on the local model?

## Why

It came up in 3 mails, 2 notes and one decision.
```

A `target` names either `thread: <slug>` (file into that thread) or `place: new` (open a new thread in a free place, optionally under `area`), and always a `reason`.

## API

`GET /api/desk/studio` returns:

- `maxActive` and `areas`, each with its `policy`.
- `active`: active threads, oldest-opened first. The first `maxActive` carry `place` (1 to `maxActive`); the rest carry `overCap: true`.
- `parked` (oldest-opened first) and `closed` (most recently closed first).
- `inbox` and `proposals`, oldest first. Proposals carry their effective `policy`, which also counts the `target.area`.
- `problems`: one entry per file that could not be read or parsed, with its `path` and a `reason`. A broken file never breaks the response.

Each thread carries its parsed front matter, `question`, `stand`, `notes`, `material`, `log`, `outcomeText` and its effective `policy`.

## Thread page

Opening a thread on the board zooms the card into its thread page; `?desk=studio&thread=<slug>` holds the open thread, so reload and the browser's back button work. With `prefers-reduced-motion`, the page opens and closes without animation. Keep, Dismiss, Close with an outcome, Park, Bring back, Think tonight and the response box write to the files (see Changes). Discuss stays disabled until live sessions with Ivy arrive.

**Relates to** is derived on every render, never stored:

- **Threads**: active or parked threads that share a material item (equal `href`, or equal labels after normalisation). A related thread opens in place.
- **Goal it serves**: material items of kind `goal`. A label that starts with a goal id (`G5: one post a week`) takes its name and state from the Desk's goals.
- **Coming up**: upcoming calendar events from the Desk's calendar sources whose title (at least 4 characters) appears as whole words in a material label or in the question. At most five, soonest first.
- **People**: material items of kind `person`, `people` or `contact`. Free text is never searched for names.
- **Decision journal**: closed threads that share a material item or an area. A decision opens in place.
- **Ivy proposes**: open `relation` notes, each with Keep and Dismiss. A kept relation joins its group (`thread`, `goal`, `person`/`people`/`contact`) or **Also related** for any other kind; a dismissed one disappears.

Goals, events and people link to their `href` when the material or the event has one.

## Changes

`POST /api/desk/studio/act` changes the Studio. It passes Mission Control's rebind and identity gates like every Desk write; it needs no step-up code. The body names an `act`, its fields, and a `requestId` (8 to 64 letters, digits, `_` or `-`):

| act | fields | writes |
| --- | --- | --- |
| `respond` | `thread`, `text` | a Responses entry; clears "Ivy waits on you" |
| `keep`, `dismiss` | `thread`, `note` (the note's heading time) | the note's `status:`; keeping a `stand` also replaces "Where I stand" |
| `park` | `thread` | `state: parked` |
| `unpark` | `thread`, `park` when every place is in use | `state: active` |
| `think` | `thread`, `on` | `thinkTonight` |
| `close` | `thread`, `outcome`, `text`; `expect` and `reviewOn` when decided | `state: closed`, `closed`, `outcome`, the Outcome section |
| `open` | `from` (`proposal` or `capture`), `id`, `area`, `park` when every place is in use, optional `answers` | a new `threads/<slug>.md`; removes the proposal or capture |

Rules:

- Each act changes the files and makes one commit whose subject names the act (`Studio: Answer Ivy on desk-open-source`) and whose body carries `Desk-Request: <requestId>`. Each changed thread's Log gains one line.
- A request id that is already in the history is answered with that commit, and nothing is written again, also after a restart.
- A directory that is not a git working tree, or that has uncommitted changes, is refused with a 409 and a clear error; nothing is written. A failed commit puts the files back.
- Opening or bringing back a thread while `maxActive` threads are active needs `park`, an active thread to park; without it the answer is a 409 with `needsPark: true`.
- `open` from a proposal keeps the proposal's areas, with the chosen `area` first; an `area` outside them replaces them. A capture becomes a `question` thread in the chosen `area` with the capture as material. Yes-filter `answers` map a question from the filter to an answer of up to 300 characters; the page sends `yes`, `not sure` or `no` for each question but the last, and free text for the last one. Answers to questions the filter does not ask are ignored. They land in a `## Yes-filter` section, and the Log line counts the yes, not sure and no answers.
- The answer is `{ ok, message, commit, replayed, studio }`, where `studio` is the fresh `GET /api/desk/studio` view, so the page redraws without waiting for its next poll.

## Capture filing

The command bar recognises `capture: <thought>`, `thought: <thought>`, and `studio: <thought>` as a Studio capture. Confirmation files the capture. When File thoughts in the Studio is promoted to Handle this yourself, the command bar files captures immediately. Stop doing this on your own restores confirmation.

The optional `mc.desk.studio.filer` uses an OpenAI-compatible endpoint:

```yaml
filer:
  baseUrl: https://models.example.org/v1
  model: capture-model
  apiKeyEnv: CAPTURE_MODEL_KEY
  timeoutSeconds: 30
  local:
    baseUrl: http://127.0.0.1:8080/v1
    model: local-capture-model
```

The endpoint fields match the mail classifier's endpoint form: `baseUrl`, `model`, optional `apiKeyEnv` or `apiKeyFile`, optional `caFile`, and `timeoutSeconds`. The `local` block accepts the same fields. The filer sends only the capture and each active thread's slug, question, and stand. If any active thread has a local policy, it uses `local` exclusively. A missing local endpoint never falls back to the other endpoint.

The model returns `{ "thread": "slug or null", "match": true, "reason": "one sentence" }`. A clear match appends one Material bullet and a Log entry. No match, an unknown slug, a missing endpoint, or a model failure saves `inbox/capture-<id>.md`. A valid thread suggestion with `match: false` becomes the inbox file's `target`.

Every successful filing appears in Done for you, with the reason and Undo. Undo removes that capture in a new commit and preserves later thread changes. A capture that has moved or changed cannot be undone automatically. Filing and Undo share the Studio's clean-tree checks, request replay, and write lock.

`POST /api/desk/create` accepts `{ "requestId": "...", "kind": "capture", "fields": { "text": "..." } }`. `POST /api/desk/capture/undo` accepts `{ "requestId": "...", "id": "capture-..." }`. Both pass the same identity and rebind gates as other Desk writes.
