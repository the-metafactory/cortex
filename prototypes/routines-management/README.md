# Approved Routines management prototype

The principal approved this combined prototype on 2026-11-01 and requested build nodes. It extends the shipped Routines page from Cortex issue 2934 and preserves the creation, approval and automatic-handling contract from issue 2837.

Run from the repository root:

```sh
bun prototypes/routines-management/serve.mjs
```

Open http://127.0.0.1:4717/.

The approved page has two tabs. Schedule uses A's day, week and month calendar. Routine workspace uses B's library and detail view. Selecting a calendar occurrence opens that routine's workspace. Returning preserves the date, view and filters. Changes appear in both tabs.

The workspace includes schedule preview and save, pause and resume, deletion confirmation, execution history and log files. Pause stops future triggers and preserves approval or automatic handling. Existing approval requests and running executions remain separate decisions. Deletion retains execution history and logs in Activity. New routines use request, preview and explicit Confirm, with approval as the default. Dispatch is not shown as completed execution.

All data is illustrative and all changes stay in memory. This is a visual and interaction reference, not production code. The production build must use the existing owners, authorization and validation contracts. It must not copy the sample scheduling or request-parsing logic.

The combined screenshots are [Schedule](images/combined-schedule.png) and [Routine workspace](images/combined-workspace.png). The earlier A, B and C studies are retained in this directory and open at `/routines-prototype.html?variant=A`, `B` or `C`. They are source material for the approved combination, not three production modes.

`ROUTINES-PROTOTYPE-BRIEF.md` records the study and the principal's choice. The final approval is: “approved! file the build nodes”.
