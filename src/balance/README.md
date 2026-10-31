# Balance engine

This deterministic TypeScript module schedules work from an outline, completion log, settings and scheduling history. Import its public functions and types from `index.ts`. It has no runtime dependencies or imports from other Cortex modules. The core and `test/` directory can move together.

Pass the date (`YYYY-MM-DD`) to the scheduler, recurrence and goal functions. Pass an optional time (`HH:MM`) for context hours. The engine never reads the clock or randomness. `applyRecurrence` mutates its supplied outline; the other scheduling functions return derived results. Callers own state and persistence.

The core and four original suites were imported from Balance commit `7fc44936f99f48fe626de74f932bd8a1f207dc85`. Comments were removed to meet Cortex lint; non-null assertions became checked required values. Shared candidate scoring and result mapping were extracted to meet the duplication gate. History lookups use only own properties, so arbitrary IDs such as `constructor` and `__proto__` work without inherited values. Scheduling policies and the original test assertions are preserved. Existing defaults are engine defaults, not a decision about the Desk UI.

In Cortex, run `bun run test src/balance`. In a standalone checkout with Bun, run `bun test test`.

Mission Control persistence lives outside this module, in `src/surface/mc/desk/balance-store.ts`. It stores one validated state snapshot per stack database, atomically including outline, completions, scheduling history and the day contract. No UI or endpoint is part of this module.

## Preserved scheduling rules

Weekly recurrences with `weekdays` pin the calendar: they use the next matching weekday and intentionally ignore `interval`. Without weekday pins, `interval` controls the number of weeks.

When non-due work exists and the cap exceeds one, the first-stage due reservations stop at cap minus one. The remaining slot uses area weights and carried deficits, followed by within-area urgency and aging. That balanced choice may itself be due work; the engine does not impose a daily non-due quota. This preserves Balance’s selection contract and original suite.

## Licence and credit

This code is distributed under Cortex’s GNU Affero General Public License, version 3 only (AGPL-3.0-only; see the repository LICENSE). The principal authorised importing the Balance core under that licence on 2026-10-31 in cortex#2870.

The balance concept originates with **Life Balance, Llamagraphics, 1996–2016**. This module incorporates the Balance implementation of that concept, not the proprietary Life Balance source code.
