import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const revision = "d658def06dbcdc403445da0b7d08ab5bba2c9d3d";
const checkout = process.argv[2];
if (!checkout) throw new Error("Usage: bun scripts/build-reflex-consumer-fixture.ts <reflex-checkout>");
const destination = resolve(import.meta.dir, "fixtures/reflex-consumer.mjs");
const staging = mkdtempSync(join(tmpdir(), "cortex-reflex-consumer-"));
try {
  for (const file of ["src/pipeline/evaluate.ts", "src/pipeline/guards.ts", "src/pipeline/impulse.ts", "src/sources/run-outcome.ts"]) {
    const source = Bun.spawnSync(["git", "-C", checkout, "show", `${revision}:${file}`]);
    if (source.exitCode !== 0) throw new Error(source.stderr.toString());
    mkdirSync(dirname(join(staging, file)), { recursive: true });
    writeFileSync(join(staging, file), source.stdout);
  }
  writeFileSync(join(staging, "index.ts"), 'export { Pipeline } from "./src/pipeline/evaluate"; export { readRunFinished, runOutcomeSubject } from "./src/sources/run-outcome";');
  const result = await Bun.build({
    entrypoints: [join(staging, "index.ts")],
    target: "bun",
    external: ["@the-metafactory/myelin/edge"],
    minify: { whitespace: true, syntax: false, identifiers: false },
  });
  if (!result.success) throw new AggregateError(result.logs, "Reflex fixture build failed");
  mkdirSync(dirname(destination), { recursive: true });
  await Bun.write(destination, result.outputs[0]!);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
