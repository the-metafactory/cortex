# Desk Studio: thread files

The Desk Studio is a directory of Markdown files that holds the threads you think through with Ivy. Mission Control reads the directory on every request to `GET /api/desk/studio` and caches nothing. The files are the source of truth, so any tool that writes Markdown can read and append to them.

## Configuration

Add a `studio` block to `mc.desk` in the stack config, and give each area a model policy:

```yaml
mc:
  desk:
    studio:
      dir: ~/threads        # a git working tree; later Studio writes commit here
      maxActive: 5          # optional; default 5
    areas:
      - id: work
        label: Work
        policy: local       # local | cloud; default cloud
      - id: home
        label: Home
```

Without `desk.studio`, `GET /api/desk/studio` answers `{ "studio": null }`.

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

## Outcome

It merges into the Desk.
```

Rules:

- Front matter is YAML between two `---` lines. Unknown keys are ignored.
- `## Question` is required. The other H2 sections are optional, appear at most once, and may come in any order. Other H2 sections are ignored.
- **Ivy's notes** are append-only H3 entries. The heading is an ISO time with a zone. Below it come metadata lines, then a blank line and the note text:
  - `trigger:` (required) names what started the note.
  - `model:` (required) names the model policy or model that wrote it.
  - `kind:` is `note` (default), `stand` (a proposed change to "Where I stand"; the text is the proposed stand) or `idea`.
  - `status:` is `open` (default), `kept` or `dismissed`.
  - `because:` gives the reason for a `stand` proposal.
  - `sample: true` marks an example note that no model wrote.
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
