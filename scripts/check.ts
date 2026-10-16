export interface Gate {
  name: string;
  steps: string[][];
  localOnly?: true;
}

export const GATES: Gate[] = [
  { name: "lint", steps: [["bun", "run", "lint:errors"]] },
  { name: "duplication", steps: [["bun", "scripts/check-duplication.ts"]] },
  { name: "typecheck", steps: [["bunx", "tsc", "--noEmit"]] },
  { name: "vocab", steps: [["bash", "scripts/check-carveouts.sh"], ["bun", "scripts/check-wire-vocab.ts"]] },
  { name: "sdk", steps: [["bun", "run", "sdk:dts:check"], ["bun", "scripts/check-release-pins.ts"]] },
  { name: "shippable", steps: [["bun", "scripts/check-shippable-hygiene.ts"]] },
  { name: "xdg", steps: [["bun", "scripts/xdg-audit.ts", "--repos", "."]] },
  { name: "test", steps: [["bun", "run", "test"]] },
  { name: "up-to-date", steps: [["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"]], localOnly: true },
];

const HINTS: Record<string, string> = {
  "up-to-date": "the branch is behind origin/main: git fetch origin main && git merge origin/main, then run bun run check again",
};

function runGate(gate: Gate): boolean {
  for (const argv of gate.steps) {
    console.log(`\n── ${gate.name}: ${argv.join(" ")}`);
    const run = Bun.spawnSync(argv, { stdio: ["inherit", "inherit", "inherit"] });
    if (run.exitCode !== 0) {
      console.error(`── ${gate.name} FAILED (exit ${run.exitCode})${HINTS[gate.name] ? `: ${HINTS[gate.name]}` : ""}`);
      return false;
    }
  }
  return true;
}

if (import.meta.main) {
  const requested = process.argv.slice(2);
  const unknown = requested.filter((name) => !GATES.some((g) => g.name === name));
  if (unknown.length > 0) {
    console.error(`unknown gate(s): ${unknown.join(", ")}. Gates: ${GATES.map((g) => g.name).join(", ")}`);
    process.exit(2);
  }
  const selected = requested.length > 0 ? GATES.filter((g) => requested.includes(g.name)) : GATES;
  const failed = selected.filter((gate) => !runGate(gate)).map((g) => g.name);
  console.log(`\n${failed.length === 0 ? "all gates passed" : `failed: ${failed.join(", ")}`} (${selected.map((g) => g.name).join(", ")})`);
  process.exit(failed.length === 0 ? 0 : 1);
}
