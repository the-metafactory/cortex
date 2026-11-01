# Routines management UX study

Decision: should schedule, routine management and execution evidence live primarily in a calendar, a routine workspace or an agenda?

1. Name the decision the prototype settles. No decision → Feature card.
2. Build 2–3 throwaway variants with the `prototype` skill, outside production source. UI variants go behind one switcher.
3. Drive each variant through `verify-<project>` (or `run`). Capture a screenshot for each, or the measured number for behaviour or timing.
4. Compare on that evidence. Give tradeoffs and a recommendation, and add an unasked variant when it earns a place.
5. The principal picks. The choice and the rejected variants go into the run's decisions. Capture the prototype on a throwaway branch, per the `prototype` skill.
6. Hand off to Feature, or to Planning when it needs several PRs.

Three throwaway renderings of the same Routines surface in the existing Desk UX sandbox:

- A: calendar first, with a persistent routine inspector.
- B: library and routine workspace; overview is a separate workspace tab.
- C: agenda first, with a routine drawer and monthly density view.

Shared sample state, in memory only. No production API calls. Clock is Monday 2 November 2026, 10:20 Europe/Zurich. Simulated executions/logs are deliberately illustrative. Reload/reset restores the sample.

All variants exercise schedule editing with next-occurrence preview, pause/resume, delete confirmation, execution selection/log viewing/download and day/week/month navigation. Paused routines remain discoverable; pause affects future occurrences and does not stop an already-running execution. Proposed deletion retains execution evidence. Both semantics are design proposals for the principal to judge, not ratified product decisions.

Keep the existing calm, light Desk visual language. The layouts, hierarchy and primary task differ, rather than just their colors. Keep flow inspection present so this study extends the existing page.

Run: `PORT=4716 bun ux/serve.ts`, then open `/routines-prototype.html?variant=A`.

Principal choice: combine A’s calendar and B’s routine workspace as two tabs. The principal approved the combined prototype and requested build nodes on 2026-11-01. This session files the work without starting implementation.

## Influence of #2837

Read the live issue and its shipped resolution. Preserve its recurring-request → schedule/steps preview → explicit Confirm creation path; new routines ask before runs; pending run requests have separate Approve/Deny; automatic handling is an independent policy; Stop automatic handling restores approval; removal deletes the routine's owned definition. The follow-up must not make Pause a synonym for Stop automatic handling. Prototype pause/resume preserves the selected handling policy. Completed execution outcomes remain distinct from dispatch or running states. History retention after deletion is a proposed UX policy, explicitly shown in the deletion confirmation and exercised through the activity view.

## Comparison and browser evidence

| Variant | Strongest use | Tradeoff |
| --- | --- | --- |
| A — Schedule first | Understanding timing, recurrence and a busy week; edit without leaving the overview. | The narrow inspector is less comfortable for deep log work. A week grid is dense on a phone; Day is clearer. |
| B — Routine workspace | Maintaining a selected routine and reading its execution evidence. | The all-routine calendar needs a deliberate switch to Schedule overview. |
| C — Agenda first | Reading today's plan and making an approval decision, especially on a phone. | Precise time spacing and overlaps are less visible; detail opens in a drawer. |

Initial recommendation: A for the overview and B’s dedicated workspace for deeper routine work. The principal subsequently requested the combined direction above.

## Principal's selected combination

The principal requested: “combine the calendar from Schedule first with the Routine workspace tab as two tabs in the routines page”.

The combined prototype is `/routines-combined-prototype.html`: two top-level page tabs, Schedule and Routine workspace. Schedule uses A's full day/week/month calendar; Routine workspace uses B's library and full detail surface. Clicking an occurrence opens its routine in the workspace. Returning to Schedule preserves the calendar range, viewed dates and filters; edits are shared across the two tabs. Top-level selection has URL state and browser history. Original A/B/C remain available as primary design-study artifacts. The principal approved this combined prototype and requested its build nodes. Production implementation has not started.

Browser walkthrough: `.audit/routines-ux-20261101/verification.json`. All three variants exercised day/week/month and date navigation, schedule preview/save, pause/resume with handling policy unchanged, separate handling-policy changes, execution logs and sample downloads, deletion with retained execution evidence, and narrow-screen overflow checks. Creation preview/Confirm and approval → dispatch (not completion) also passed. No page errors or external requests were observed. Desktop and mobile screenshots for A/B/C, plus month, schedule-dialog and log-view details, are in the same evidence directory. These are fixture UX checks, not production capability verification.

Combined verification: `.audit/routines-ux-20261101/combined-verification.json` passed two-page-tab structure, calendar selection opening the chosen workspace, date/range retention, edited schedules and pause state reflected on the calendar, URL back/forward/reload, keyboard page tabs, log access and mobile overflow checks. Desktop/mobile captures use `combined-*.png`. No page errors or external requests were observed.
