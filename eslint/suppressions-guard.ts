import { readFileSync } from "node:fs";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { gitShow, resolveBaseRef } from "../scripts/lib/git.ts";

export const SUPPRESSIONS = "eslint-suppressions.json";
const CONFIG = "eslint.config.js";

type Suppressions = Record<string, Record<string, { count: number }>>;

export function totalsByRule(suppressions: Suppressions): Map<string, number> {
  const totals = new Map<string, number>();
  for (const rules of Object.values(suppressions)) {
    for (const [rule, { count }] of Object.entries(rules)) totals.set(rule, (totals.get(rule) ?? 0) + count);
  }
  return totals;
}

/** Rules the presets eslint.config.js extends switch on: @eslint/js recommended, strictTypeChecked, stylisticTypeChecked. */
export function presetRules(): Set<string> {
  const rules = new Set(Object.keys(js.configs.recommended.rules));
  for (const config of [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked]) {
    for (const [rule, level] of Object.entries(config.rules ?? {})) if (level !== "off" && level !== 0) rules.add(rule);
  }
  return rules;
}

/**
 * Only a rule this change switches on, by naming it in the config for the first time, may start a
 * baseline. A rule base had on, by name or through a preset, counts as enabled however head names it.
 */
export function enabledOnBaseFrom(baseConfig: string, headConfig: string, presets: ReadonlySet<string> = new Set()): (rule: string) => boolean {
  return (rule) => {
    const named = JSON.stringify(rule);
    return presets.has(rule) || !(headConfig.includes(named) && !baseConfig.includes(named));
  };
}

export function grownRules(base: Suppressions, head: Suppressions, enabledOnBase: (rule: string) => boolean = () => true): string[] {
  const before = totalsByRule(base);
  return [...totalsByRule(head)]
    .filter(([rule, n]) => (before.has(rule) || enabledOnBase(rule)) && n > (before.get(rule) ?? 0))
    .map(([rule, n]) => `${rule}: ${before.get(rule) ?? 0} -> ${n}`);
}

if (import.meta.main) {
  const baseRef = resolveBaseRef("LINT_BASE_REF", "suppressions guard");
  const base = gitShow(baseRef, SUPPRESSIONS);
  if (base === undefined) process.exit(0);
  const grown = grownRules(
    JSON.parse(base) as Suppressions,
    JSON.parse(readFileSync(SUPPRESSIONS, "utf8")) as Suppressions,
    enabledOnBaseFrom(gitShow(baseRef, CONFIG) ?? "", readFileSync(CONFIG, "utf8"), presetRules()),
  );
  if (grown.length > 0) {
    console.error(
      `${SUPPRESSIONS} suppresses more than ${baseRef} does:\n${grown.map((g) => `  ${g}`).join("\n")}\n` +
        "Fix the new violations instead of suppressing them. A moved file keeps its rule totals, so a rename passes.",
    );
    process.exit(1);
  }
}
