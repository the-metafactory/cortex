# Vigil core review dispositions (node #2579)

Goal: account for all four glossary findings from Sage round 2 on
[PR #2577](https://github.com/the-metafactory/cortex/pull/2577), reviewed at
`c79d6f11d21edfeec8e50af52a5908d9af34d781`.

Each finding below has a disposition and source evidence. This record supplies
the supervisor's close receipt for checkpoint `review-findings-2557-c79d6f11`;
it does not close the graph node.

| Finding | Disposition | Reason and evidence |
| --- | --- | --- |
| F1: `bun.lock:102`, "node" | Declined | The matched text is the upstream dependency identifier `@nats-io/transport-node`, also declared in myelin's `package.json`. It names the Node.js transport package, not a Stack or Cortex runtime. Renaming a generated lockfile identifier would misrepresent the dependency. No glossary suppression or dependency change is warranted. |
| F2: `src/bus/jetstream/provision.ts:273`, "message" | Declined | The comment on `jsm.streams.add` describes JetStream's `Interest` retention policy and acknowledgement semantics. A NATS message is the transport record retained by JetStream; an Envelope is the application wrapper and a Payload is its inner content. This provisioning operation does not validate either. Keeping the transport term preserves the scope of the explanation. The installed `@nats-io/jetstream/lib/jsapi_types.d.ts` documents `RetentionPolicy.Interest` using the same term. |
| F3: `src/vigil/ingest.ts:12`, "data" | Already addressed in merged PR #2717 | Commit `179cba405ac1a45777eef34dc429635e42f96ce1` removed the entire `runHealthKey` comment containing "visible in the data" when keys became stack-scoped. The current function has no such comment. No additional edit is needed. |
| F4: `src/vigil/ingest.ts:19`, "instance" | Already addressed in merged PR #2725 | Commit `c07052b49200bac35637823dca8bbc44fd1fdac6` removed the source-format comment containing `{instance}` when `stackOfEnvelope` began deriving the Stack from the received Subject. The current function and its validation errors no longer use "instance". No additional edit is needed. |

The earlier "run" finding restated under F4 does not require replacing the
Execution Run contract with Session terminology. The myelin glossary and the
current cortex `ingestLedgerEnvelope` documentation explicitly distinguish an
Execution Run from a Cortex Session.

Source checks for reproducing the dispositions:

```sh
git show c79d6f11:bun.lock
git show c79d6f11:src/bus/jetstream/provision.ts
git show c79d6f11:src/vigil/ingest.ts
git show 179cba40 -- src/vigil/ingest.ts
git show c07052b4 -- src/vigil/ingest.ts
rg -n 'transport-node' bun.lock node_modules/@the-metafactory/myelin/package.json
rg -n -A12 'const RetentionPolicy' node_modules/@nats-io/jetstream/lib/jsapi_types.d.ts
rg -n 'runHealthKey|stackOfEnvelope|instance|\bdata\b' src/vigil/ingest.ts
```

## Validation

This change records dispositions only; runtime behavior and dependency
resolution are unchanged.

On 2026-11-05, host-side `bun run check` ran once with Bun 1.4.2. Lint,
duplication, typecheck, vocabulary, SDK, shippable hygiene, XDG and up-to-date
gates passed. The test gate stalled with a CPU-active worker and no new test
results for several minutes. After stopping that worker with SIGTERM, Bun
identified `src/cli/studio-overseer.test.ts` as the interrupted file and
reported 14,118 pass, 30 skip, 201 todo and 1 fail in 375.18 seconds. This is
an interrupted suite, not a passing full check; its underlying stall remains
unexplained.

At execution time, both HEAD and `origin/main` were
`62ad0a7dfa05cfb3990b60f13efb62a190198a54`, with no tracked source or test
changes. The only addition was this Markdown record. A subsequent isolated
`bun run test src/cli/studio-overseer.test.ts` on the same unchanged base
passed all 24 tests, with 106 assertions, in 30.28 seconds. No test or runtime
workaround was applied.

The full log is `/tmp/cortex-node-2579-check.log`; the worker sample is
`/tmp/cortex-node-2579-test-worker.sample.txt`; the isolated test log is
`/tmp/cortex-node-2579-base-overseer-file.log`.
