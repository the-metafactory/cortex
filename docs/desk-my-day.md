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

## Choose your caps

`desk.myDay.cap` sets the My day baseline, from 1 to 7. `desk.topN` sets the Needs you baseline, from 1 to 10. Both default to 5, ratified by the principal in cortex#2871.

The two on-screen dials save an explicit per-stack override. The Desk labels those saved caps. They survive reload and restart, including later YAML changes. **Reset** removes the override and immediately uses the current YAML values. Without an override, YAML changes take effect when the running stack reloads them. Changing a cap preserves the started day. A smaller cap trims an unconfirmed draft; **Refresh proposal** fills a new draft using the effective cap.

## Storage and writes

Mission Control keeps the validated engine state in `desk_balance` and the draft, intake, source fingerprints, caps and request receipts in `desk_my_day`. With a Balance adapter connection enabled, the panel renders its outline from the Cortex runtime's current Balance observation projection after the Balance sync step; a failed poll keeps the last observed values, shows a stale marker and offers Refresh, and a task the projection has not observed still shows from the saved outline. Commands still go through the native My Day route, and disabling the connection returns the panel to the store-only read. The Balance sync step projects Studio notes, applies recurrence and retires old drafts inside a SQLite immediate transaction. Desk routes perform that step before reading. Reading My Day or Balance itself never saves state or metadata. Automatic proposals are computed until the person chooses a draft; a chosen draft is preserved for that day. Repeating sync without a Balance or Studio change keeps the revision unchanged. Commands read and write both stores inside one SQLite immediate transaction. Retrying the same request id returns its receipt; reusing it for different input is rejected. Outline edits compare the version of the fields captured when the editor opened. Undo changes only the deferral it owns.

The My day endpoint uses Mission Control’s existing Host, Origin and identity gates. It derives source metadata from current Desk readings. It never accepts client-supplied task titles or deadlines for a source move.
