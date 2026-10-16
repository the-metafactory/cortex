import { readFileSync } from "node:fs";

export const SUPPRESSIONS = "eslint-suppressions.json";

type Suppressions = Record<string, Record<string, { count: number }>>;

export function totalsByRule(suppressions: Suppressions): Map<string, number> {
  const totals = new Map<string, number>();
  for (const rules of Object.values(suppressions)) {
    for (const [rule, { count }] of Object.entries(rules)) totals.set(rule, (totals.get(rule) ?? 0) + count);
  }
  return totals;
}

/** A rule the base config does not enable yet starts its baseline in the change that enables it. */
export function grownRules(base: Suppressions, head: Suppressions, enabledOnBase: (rule: string) => boolean = () => true): string[] {
  const before = totalsByRule(base);
  return [...totalsByRule(head)]
    .filter(([rule, n]) => enabledOnBase(rule) && n > (before.get(rule) ?? 0))
    .map(([rule, n]) => `${rule}: ${before.get(rule) ?? 0} -> ${n}`);
}

function git(args: string[]) {
  const run = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  return { ok: run.exitCode === 0, out: run.stdout.toString() };
}

if (import.meta.main) {
  const baseRef = process.env.LINT_BASE_REF ?? "origin/main";
  if (!git(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`]).ok) {
    console.error(`suppressions guard: cannot read ${baseRef}. Fetch it first: git fetch origin main`);
    process.exit(2);
  }
  const base = git(["show", `${baseRef}:${SUPPRESSIONS}`]);
  if (!base.ok) process.exit(0);
  const baseConfig = git(["show", `${baseRef}:eslint.config.js`]).out;
  const grown = grownRules(
    JSON.parse(base.out) as Suppressions,
    JSON.parse(readFileSync(SUPPRESSIONS, "utf8")) as Suppressions,
    (rule) => baseConfig.includes(JSON.stringify(rule)),
  );
  if (grown.length > 0) {
    console.error(
      `${SUPPRESSIONS} suppresses more than ${baseRef} does:\n${grown.map((g) => `  ${g}`).join("\n")}\n` +
        "Fix the new violations instead of suppressing them. A moved file keeps its rule totals, so a rename passes.",
    );
    process.exit(1);
  }
}
