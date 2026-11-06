# Vigil subject-stack review dispositions

<!-- glossary-ignore: run -->

This record covers all 16 findings from Sage round 1 on [PR #2725](https://github.com/the-metafactory/cortex/pull/2725), reviewed at `b5b49effe5a67a8d70213b7d000283f243a3a1fb`, for [Review findings from cortex#2724](https://github.com/the-metafactory/cortex/issues/2727). Reviewed locations below identify that commit. The checkpoint is `review-findings-2724-b5b49eff`. Execution Run terminology and literal `run` identifiers below refer to Myelin's reporting contract.

The supervisor owns publication, review and the eventual close receipt. This record supplies the dispositions; it does not attest that this branch has merged.

## Dispositions

| ID | Reviewed location and finding | Disposition and reason |
| --- | --- | --- |
| F1 | `ingest.ts:81`, mismatch counted before commit | Corrected: live ingest counts after its transaction succeeds. Replay defers counting until its outer transaction, including event reconnection, succeeds. Failure-and-retry regressions cover both transaction boundaries. |
| F2 | `db.ts:199`, provenance is separate caller bookkeeping | Corrected: `writeVigilSubject` writes the observation and provenance in one transaction, including when called without an outer transaction. Ingest and notification-outage writers no longer confirm separately. Migration retains explicit confirmation when preserving an existing row. Direct insert/upsert and provenance-failure rollback are covered. Legacy fixtures now explicitly remove provenance. |
| F3 | `stack-scope.ts:15`, full scan per replayed envelope | Corrected: replay passes observation identity to `unverifiedVigilSubjects`; SQL selects matching kind/reference or vocabulary/reference before returning rows. Both pairs have indexes. Tests cover unrelated kinds, references, vocabularies and already verified rows. |
| F4 | `stack-scope.ts:67`, repeated ordering comparison | Corrected: both TypeScript replay guards and `isNewObservation` share `isOlderObservation`. The requested linking comment is declined because the repository prohibits new explanatory comments. A parameterized regression instead checks the helper, row guard and SQL completeness predicate against the same timestamp/identifier ordering cases. |
| F5 | `stack-scope.ts:94`, duplicated event re-key update | Corrected: `moveVigilEvents` owns the update and optional identifier filter; reconnection and replay completion call it. Existing replay tests cover selective movement, remaining events, attention and text-receipt reconnection. |
| F6 | `db.ts:196`, repeated unverified predicate | Corrected: one `UNVERIFIED` constant serves full and matched selection and both reset statements. |
| F7 | `ingest.ts:99`, nested attention-direction ternary | Corrected: `replayDirection` uses early returns for reset, state, unchanged value and health direction. Replay and attention regressions retain the behavior. |
| F8 | `fixtures.ts:85`, fixture shadows production ingest | Corrected: the fixture is `ingestFromSourceStack`; all callers use that name. Production `ingestLedgerEnvelope` retains its explicit received-subject argument. |
| F9 | `stack-scope.test.ts:46`, isolation test derives subject from source | Corrected: both envelopes name the default source stack, while production ingest receives default and work subjects explicitly. The test checks separate state, health and attention rows. |
| F10 | `fixtures.ts:14`, `subscriber` alias | Corrected with a glossary directive: the imported `MyelinSubscriber` type and module name identify the existing bus contract. A Render target substitution would change the import identity. |
| F11 | `ingest.test.ts:105`, `run` alias | Corrected: descriptions explicitly say **Execution Run**. Myelin defines this reporting contract separately from a cortex Session. Wire fields and subject keys retain their contract spelling. |
| F12 | `stack-from-subject.test.ts:16`, `agent` alias | Corrected with a glossary directive: `config.agent` configures the bus runtime identity and is an existing configuration field, not a Session alias. |
| F13 | `stack-from-subject.test.ts:40,112`, `run` alias | Corrected with a glossary directive: literal subjects, keys and identifiers belong to the Execution Run contract. Renaming them to Session would change the contract under test. |
| F14 | `stack-from-subject.test.ts:156`, `subscriber` alias | Corrected with a glossary directive: this is the live bus subscription receiving envelopes, not a Render target. |
| F15 | `stack-scope.test.ts:46`, `run` alias | Corrected with a glossary directive: the test compares Execution Run references and health keys, distinct from Session identity. |
| F16 | `stack-scope.ts:16,20,66`, `run` alias | Corrected with a glossary directive: `subject_kind = 'run'` and the associated keys are persistent Execution Run contract values. The matching logic now lives in SQL. |

## Settled by

[What is the Vigil contract: run-ledger envelope, tick, routing and attention budget?](https://github.com/the-metafactory/soma/issues/787) defines the reporting and attention behavior preserved here. Cortex `CONTEXT.md` defines Session and Render target; the installed Myelin `CONTEXT.md` defines Execution Run and explicitly distinguishes it from Session.

## Verification

The initial regressions reproduced three failures: pre-commit mismatch counting, missing provenance on a direct write, and missing atomic rollback when provenance fails. The affected-test run passed 590 tests across 30 files; after the additional replay rollback and ordering coverage, the focused regression run passed 65 tests across four files. SQLite's query plan reported `MULTI-INDEX OR` using `idx_vigil_subjects_run_ref` and `idx_vigil_subjects_vocab_ref`, plus the provenance primary-key index.

On 2026-11-06, the first full check on this machine passed every gate except branch ancestry. After merging the available `origin/main` by fast-forward, `bun run check` passed all gates: lint, duplication, typecheck, vocabulary, SDK, shippable hygiene, XDG, tests and branch ancestry. The final runner reported 14,153 passing tests, 71 skipped, 201 TODO and zero failures across 857 files. The disposition audit confirmed F1–F16 each occur exactly once.

## Follow-up review

The follow-up Sage round on `0fa30f6f` raised one option simplification and four terminology nits. Ingest now uses `replay` alone to defer mismatch counting to replay's outer transaction; its replay caller no longer passes an unused logger. The terminology corrections above preserve the Execution Run contract and clarify the prose. No follow-up finding is declined.
