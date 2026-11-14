# Shape your day on the Desk

My day sits beside Needs you. The Balance engine chooses its proposed list from your outline, weights, due dates, focus projects and scheduling history. Each item includes the engine’s reason and trace. Ivy does not rerank the list. The visible briefing and spoken briefing end with the same proposed list and confirmation choices. After you close the day, both start with your wins.

Use **Swap** to choose from up to three engine alternates. **Just one thing** keeps the first item. **Refresh proposal** asks the engine for a new draft. **Start the day** confirms the current list once. The confirmation and its scheduling history survive reload and restart. Completing a task records one win per day, including recurring tasks whose next occurrence already falls in their lead window. **Done for today** closes the contract and shows those wins first.

**Not today** defers one task until tomorrow. **Undo** survives reload and removes that deferral alone. It preserves other edits and completions. If someone changes that deferral again, Undo refuses to replace their change. A change from yesterday cannot mutate today’s contract.

## Turn a request into a task

Open an item’s menu or detail panel and choose **→ todo**. The Desk creates an Inbox task with the source link and any reported deadline. It hides that source episode from the Day without changing the original mail or Ranger node. Repeating the move does not duplicate the task. The move is bound to the episode you saw. If the source changes before your click arrives, the Desk asks you to refresh. Mail classification can change its wording without creating a new source episode. A new stopped episode on the same Ranger node can appear again.

Open **Edit outline** to find Inbox. Choose **File into…** and select an area or project. The task then becomes eligible for the engine’s next proposal. Intake is separate from configured areas. Removing an area from configuration preserves its tasks but excludes it from scheduling and refuses new edits or filing into it until the area returns.

## Edit your outline

The top areas come from `desk.areas`. Add projects and tasks below them. Weights are relative to siblings. Zero weight sets an item aside. Set a deadline on a task or project. Choose at most three focus projects per month. A new focus uses the configured Yes-filter, or the same generic questions used in Studio.

If another window changes the item you are editing, Save refuses the stale edit and preserves your draft. Close and reopen the editor to load the current values.

In `GET /api/desk/my-day`, every outline row with a `repeat` rule also carries `recurrence: { returnsOn, finished, reappearsOn }`. For a done row, `returnsOn` is its next occurrence and `reappearsOn` is that date minus the row's lead days, the day the row opens again. `finished` is true when the repeat is exhausted; both dates are then null. An open repeating row has `finished: false` and null dates. The Balance engine's recurrence rule computes all three, so a client never recomputes them. Rows without `repeat` have no `recurrence`, and the stored outline never holds it.

Each Studio thread is copied into the outline as a project row. `studioProjects` in `GET /api/desk/my-day` maps those rows to their threads: each entry is `{ id, slug, state, openNotes }`, where `id` is the outline row, `state` is the thread's `active`, `parked` or `closed`, and `openNotes` counts the thread's notes with status `open`, sample notes included. A client reads a thread's state here, not from the row's `done`. An entry whose thread is no longer in the Studio is left out. When the Studio is turned off or cannot be read for this request (`studioStatus` is `disabled` or `unavailable`), every entry keeps its `id` and `slug` and carries `state: null` and `openNotes: null`.

## Ask the assistant about a row

`POST /api/desk/outline/ask` answers a question about one outline row at once and stores nothing. The client holds the answer as a draft; to keep it, write it into the row's note with `outline-edit`.

- `{ requestId, row, kind: "answer", question, passage? }` answers `{ ok: true, reply }`.
- `{ requestId, row, kind: "shorten", passage, question? }` answers `{ ok: true, reply, replacement }`. `replacement` is the passage rewritten shorter, and `reply` says in one sentence what changed.

`requestId` is a UUID. Sending the same request again returns the first answer without asking the model again; the same id with a different question is a 409. A failed ask is not remembered, so a retry asks again.

The model reads the row's title, its note, the titles of the rows above it, the question and the passage, as data in the prompt. It has no tools and starts no action. The row's area chooses the model with the rule a Studio session uses: a `local` area uses only `studio.filer.local`, a `cloud` area (or one with no `policy`) uses `studio.filer`. There is no cloud fallback for a local area.

| Status | When |
| --- | --- |
| 400 | The body is not a valid ask, the `question` is over 4,000 characters, the `passage` is over 10,000 characters, `answer` has no question or `shorten` has no passage. |
| 404 | The row is not in the outline. |
| 409 | The Desk is off, or the request id belongs to another ask. |
| 502 | The model failed or did not answer the expected JSON. Nothing is stored. |
| 503 | No model serves the row's policy (`No local model is configured. Nothing was sent; no cloud fallback is used.` or `No conversation model is configured. Nothing was sent.`), or the row's area is not in `desk.areas`. Nothing is sent. |

Every refusal is `{ ok: false, error }`. The route changes no outline state and bumps no revision. It sits behind the same Host, Origin and identity checks as the other `/api/desk` writes.

## Choose your caps

`desk.myDay.cap` sets the My day baseline, from 1 to 7. `desk.topN` sets the Needs you baseline, from 1 to 10. Both default to 5, ratified by the principal in cortex#2871.

The two on-screen dials save an explicit per-stack override. The Desk labels those saved caps. They survive reload and restart, including later YAML changes. **Reset** removes the override and immediately uses the current YAML values. Without an override, YAML changes take effect when the running stack reloads them. Changing a cap preserves the started day. A smaller cap trims an unconfirmed draft; **Refresh proposal** fills a new draft using the effective cap.

## Storage and writes

Mission Control keeps the validated engine state in `desk_balance` and the draft, intake, source fingerprints, caps and request receipts in `desk_my_day`. With a Balance adapter connection enabled, the panel renders its outline from the Cortex runtime's current Balance observation projection after the Balance sync step; a failed poll keeps the last observed values, shows a stale marker and offers Refresh, and a task the projection has not observed still shows from the saved outline. Commands still go through the native My Day route, and disabling the connection returns the panel to the store-only read. The Balance sync step projects Studio notes, applies recurrence and retires old drafts inside a SQLite immediate transaction. Desk routes perform that step before reading. Reading My Day or Balance itself never saves state or metadata. Automatic proposals are computed until the person chooses a draft; a chosen draft is preserved for that day. Repeating sync without a Balance or Studio change keeps the revision unchanged. Commands read and write both stores inside one SQLite immediate transaction. Retrying the same request id returns its receipt; reusing it for different input is rejected. Outline edits compare the version of the fields captured when the editor opened. Undo changes only the deferral it owns.

The My day endpoint uses Mission Control’s existing Host, Origin and identity gates. It derives source metadata from current Desk readings. It never accepts client-supplied task titles or deadlines for a source move.
