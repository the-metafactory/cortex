# Desk adapter cutover evidence

One strictly validated `desk-adapter-evidence/1` JSON summary per binding cutover, named `<binding>-<cutoverId>.json`. Screenshots stay with the browser CI job.

Write one with `bun scripts/write-desk-adapter-evidence.ts --input <summary.json> [--dir <directory>]`. Check the writer with `bun scripts/write-desk-adapter-evidence.ts --example`.

`bun run check test` reads every file in this directory through `readEvidenceDirectory`, so a summary that fails validation, a summary stored under a name that is not its own, or a file that is neither the readme nor a summary fails the suite.

Fields: `schema`, `commitSha`, `ciRunId`, `binding`, `cutoverId`, `matrix` (rows A1 to A14, each `pass` or `fail`), `creationTypes`, `timing`, `canary`, and an optional `readback` holding only `pass` or `fail` and a SHA-256 digest.

The writer refuses any field outside that list, free text, objects where a value is expected, email shapes and platform ID shapes, and refuses to overwrite an existing summary. A rejected summary writes nothing.
