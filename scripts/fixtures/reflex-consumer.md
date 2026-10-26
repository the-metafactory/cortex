# Reflex consumer fixture

`reflex-consumer.mjs` contains the unmodified runtime code of `Pipeline`,
`readRunFinished` and `runOutcomeSubject`, bundled from
[the-metafactory/reflex at d658def06dbcdc403445da0b7d08ab5bba2c9d3d](https://github.com/the-metafactory/reflex/tree/d658def06dbcdc403445da0b7d08ab5bba2c9d3d).
The upstream package declares the MIT license. The inputs are
`src/pipeline/{evaluate,guards,impulse}.ts` and `src/sources/run-outcome.ts`.

Regenerate with Bun v1.4.2 from a Reflex checkout containing that commit:

```sh
bun scripts/build-reflex-consumer-fixture.ts /path/to/reflex
git diff -- scripts/fixtures/reflex-consumer.mjs
```

The builder reads committed blobs, never working-tree edits. It strips types and
bundles relative imports; it does not rewrite the consumer logic. Myelin stays
external, resolved to Cortex's pinned v0.12.0 release, matching Reflex's dependency
at that commit. Tests need neither a sibling checkout nor network access.

The process funnel tests call the real `Pipeline.evaluate` to stamp a fired
correlation and engage the lock, then pass the published envelope through the
real `readRunFinished` and `Pipeline.onRunCompleted`. The in-memory repository
and bus are test adapters; the contract reader and pipeline are upstream code.
