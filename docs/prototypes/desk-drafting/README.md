# Conversation-prefilled drafting prototype — #3291

The question is whether a conversation can become a useful task or research node without making the person learn the integration machinery. The normal screen is the accepted conversation: ask “turn this into a task” or “make this a research node”, then Approve or Edit the proposed card.

Run from this throwaway branch:

```sh
bun install --frozen-lockfile
bun run prototype:desk-drafting
```

Open <http://127.0.0.1:33592/?desk=adapter-ui-prototype>. Port33593 is an isolated boundary receiver retained from the accepted UI experiment; the conversation never contacts it. The accepted #3290 prototype remains on33590. Restart the command after changing source because the runner builds once at startup.

The initial synthetic discussion covers receipt preservation across restart, crash cases and a regression-test outcome. The task gets a useful title and note, plus the selected Reliability project. The research node gets its own description, selected map/repository and a suggested completion check. “Why these details?” links fields to the exact discussion messages. Fixture schema metadata supplies domain labels, field requirements and drafting guidance; the host shares field ownership, edit merging, provenance and approval rules.

Try this sequence:

1. Ask “turn this into a task”. Edit its title and deliberately clear its note. Save changes.
2. Add “Also include a receipt stored before the process exits.” The card is marked outdated without changing its fields.
3. Ask “update the task”. Your title and empty note remain yours.
4. Ask “make this a research node”. Its untouched description includes the new detail. Add another fact and ask “update the research node” to demonstrate regeneration.
5. Approve. Repeating the request, double clicking approval or returning through Conversations preserves the same draft/result. “New draft task” is the explicit way to get a new draft after the outstanding result is settled.

Additional ordinary conversation fixtures use URL parameters, with no scenario selector in the product:

| URL suffix | Question demonstrated |
| --- | --- |
| `&case=missing` | Where should the work go? Choose Reliability/Inbox or the Lifecycle map. |
| `&case=ambiguous` | Two Platform projects require a choice. A manual valid destination also resolves it. |
| `&case=failed` | Definitive failure retains the draft; Try again is an explicit new attempt. |
| `&case=uncertain` | The owner accepted but the answer was lost. Check result reads the original result without another creation. |
| `&case=uncertain-missing` | The historic result remains saved even when the current object cannot be shown. |
| `&case=slow` | Editing during a pending update wins over its late response. |
| `&case=local-only` | Unavailable drafting leaves manual editing; there is no cloud fallback. |

A discussion addition containing both Friday and Monday asks for an explicit date or no due date. The fixture's reference date is2026-11-08. A manually chosen date/destination remains resolved on subsequent updates. Deliberately clearing a required title is preserved, with approval blocked until corrected; blank optional fields are valid.

Verification:

```sh
bun scripts/probe-desk-drafting.ts --origin http://127.0.0.1:33592
```

The probe uses staged Chromium with a temporary HOME/profile and records desktop/mobile captures plus `probe.json`. It exercises both types, actual discussion updates, cleared fields, manual ambiguity resolution, stale-response races, navigation, duplicate prevention, definitive failure and uncertain canonical readback. The older `probe-desk-adapter-ui.ts` entrypoint delegates to this probe.

This is a controlled synthetic drafter and in-memory owner, not general natural-language understanding, a live model, a production adapter SDK or a real Balance/GitHub connection. Only the supplied fixture destinations resolve to canonical fixture references. No credentials, accounts, provider APIs, environmental integration configuration or real owner objects are read or mutated. Navigation preserves state; reloading starts a fresh example. Receipts bind the approved revision's exact field snapshot and known fixture references. The off-route `&lab=1` UI-boundary experiment is retained unchanged from #3290 and is not the proposed product flow.

Evidence: [task](desktop-task.png), [research node](desktop-graph.png), [mobile](mobile-task.png), [saved](desktop-saved.png), [uncertain](uncertain.png), [probe results](probe.json).
