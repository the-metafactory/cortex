# Dispatch ledger review dispositions

This record covers all twelve findings from Sage round 3 on [PR #2568](https://github.com/the-metafactory/cortex/pull/2568), reviewed at `248551c67cb7658aed64bf3f6027fe6e37b6c7e5`, for [Review findings left open by node #2558](https://github.com/the-metafactory/cortex/issues/2572). Locations below refer to that reviewed commit, so subsequent line movement does not change which finding is addressed. The checkpoint is `review-findings-2558-248551c6`.

## Goal and criteria

Every finding has a correction or an explicit decline with a reason. Runtime behavior, package identities, wire fields and existing diagnostic strings remain unchanged. The supervisor owns publication, review and the eventual close receipt; this record supplies its dispositions and does not attest that this branch has merged.

## Dispositions

| ID | Reviewed location and flagged alias | Disposition and reason |
| --- | --- | --- |
| F1 | `CONTEXT.md:189`, `node` | Corrected here: the link now names **Publish execution.run.finished for each terminal cortex dispatch**. The reference concerns a work item, but its title is clearer and removes the ambiguous bare word. |
| F2 | `CONTEXT.md:189`, `sink` | Declined: the text says **dispatch sink**, which `CONTEXT.md` explicitly defines as an architectural role and permits in the Render target entry. The funnel publishes derived envelopes; calling it a Render target would contradict that entry's render-only contract and the documented producer exception. |
| F3 | `bun.lock:102`, `node` | Declined: the occurrence is inside the literal dependency name `@nats-io/transport-node` in Myelin's dependency metadata. It names the Node.js transport package, not a Stack or Cortex runtime. Renaming it would corrupt the dependency identity; generated dependency metadata needs no glossary suppression. |
| F4 | `src/__tests__/cortex.run-ledger-boot.test.ts:3`, `path` | Declined: `import { join } from "path"` imports a filesystem utility. It is not a NATS Subject; changing the module specifier to `Subject` would break resolution. |
| F5 | `src/__tests__/cortex.run-ledger-boot.test.ts:17,24`, `run` | Declined: the test description and temporary directory prefix name the execution ledger under test. Myelin's `CONTEXT.md` defines **Execution Run** and explicitly distinguishes it from a cortex **Session**. A Session rename would misidentify the reporting contract. |
| F6 | `src/__tests__/cortex.run-ledger-boot.test.ts:38,55`, `agent` | Declined: `config.agent` configures the runtime identity, and `source.agent` identifies the publishing assistant. These are existing configuration and `SystemEventSource` fields, not Session aliases. |
| F7 | `src/__tests__/cortex.run-ledger-boot.test.ts:55`, `instance` | Declined: `source.instance` is the existing `SystemEventSource` field holding the stack slug. The fixture already supplies `stack`; changing the field name would alter the contract instead of correcting prose. |
| F8 | `src/bus/__tests__/run-ledger-funnel.test.ts:10,39,51,205`, `run` | Declined: these occurrences name the execution-ledger module, its description, the execution-ledger comment and the asserted `run-ledger-funnel` diagnostic prefix. They describe Execution Run reporting, not a substrate Session; the diagnostic assertion intentionally matches the producer's existing string. |
| F9 | `src/bus/__tests__/run-ledger-funnel.test.ts:13`, `instance` | Declined: this is the same `SystemEventSource.instance` contract field as F7. Its `default` value names the source stack; a glossary substitution would change the fixture's shape. |
| F10 | `src/bus/__tests__/run-ledger-funnel.test.ts:13`, `agent` | Declined: `SystemEventSource.agent` names the publishing runtime identity (`cortex`), not a Session. Keeping the field tests the real dispatch-event contract. |
| F11 | `src/bus/run-ledger-funnel.ts:38,69`, `run` | Declined: `run-ledger-funnel` is the producer's identifier and diagnostic prefix. It reports `execution.run.finished`, whose Execution Run vocabulary belongs to Myelin. Replacing it with Session terminology would conflate distinct concepts and change operational strings. |
| F12 | `src/cortex.ts:79`, `run` | Declined: the import references the actual `./bus/run-ledger-funnel` module and its exported factory. It is an implementation reference to Execution Run reporting, not prose naming a Session. |

## Contract evidence

- Cortex [`CONTEXT.md`](../CONTEXT.md), **Session**, **Render target**, **Dispatch ledger funnel** and **Dispatch sink**, limits the avoided aliases to their respective concepts and permits qualified **dispatch sink**.
- Myelin `CONTEXT.md`, **Execution reporting** (in the installed `@the-metafactory/myelin` package), explicitly states that an Execution Run is not a cortex Session.
- [`SystemEventSource`](../src/bus/system-events.ts) declares `agent` and `instance`; the dispatch-event constructors accept that source shape. [`run-ledger-funnel.ts`](../src/bus/run-ledger-funnel.ts) uses Myelin's execution-reporting factory.

No glossary suppressions or runtime changes are needed for the eleven declined findings.

## Settled by

[What is the Vigil contract: run-ledger envelope, tick, routing and attention budget?](https://github.com/the-metafactory/soma/issues/787) defines the execution reporting vocabulary preserved by these dispositions.

## Verification

On 2026-11-05, `bun run check` passed on the host: lint, duplication, typecheck, vocabulary, SDK, shippable hygiene, XDG, tests and branch ancestry. The test runner reported 14,380 tests across 854 files, with zero failures. A separate disposition audit confirmed F1–F12 appear exactly once, with one correction and eleven reasoned declines, and all relative source links resolve. Only this record and the glossary link label changed.
