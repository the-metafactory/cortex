#!/usr/bin/env bun
/**
 * MIG-7.2e — `bun src/cli/cortex/commands/migrate-config.ts <input.yaml>`
 *
 * One-shot CLI that reads a grove-v2-shaped `bot.yaml` and emits a
 * cortex-shaped `cortex.yaml`. Wraps the pure conversion logic in
 * `./migrate-config-lib.ts`.
 *
 * Usage:
 *   bun src/cli/cortex/commands/migrate-config.ts <input.yaml> [--out <output.yaml>] [--check] [--strict]
 *
 * Flags:
 *   --out FILE     Write to FILE (default: stdout)
 *   --check        Validate only — print conversion table + warnings; don't write output
 *   --strict       Fail on warnings (default: warnings → stderr but exit 0)
 *
 * Exit codes:
 *   0  — conversion succeeded
 *   1  — conversion failed (invalid input, schema validation error)
 *   2  — strict-mode warnings (would have succeeded without --strict)
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import YAML from "yaml";

import {
  convertBotYaml,
  formatCheckReport,
  type LegacyBotYaml,
} from "./migrate-config-lib";

interface ParsedArgs {
  input: string | undefined;
  out: string | undefined;
  check: boolean;
  strict: boolean;
  help: boolean;
}

/**
 * Hand-rolled arg parser matching the pattern in `cloud.ts` — no Commander
 * dependency. Returns positional + flag values; the caller validates.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    input: undefined,
    out: undefined,
    check: false,
    strict: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--check") {
      args.check = true;
    } else if (a === "--strict") {
      args.strict = true;
    } else if (a === "--out") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--out requires a path argument");
      }
      args.out = next;
      i++;
    } else if (a.startsWith("--out=")) {
      args.out = a.slice("--out=".length);
    } else if (a.startsWith("--")) {
      throw new Error(`unknown flag: ${a}`);
    } else if (args.input === undefined) {
      args.input = a;
    } else {
      throw new Error(`unexpected positional argument: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log("cortex migrate-config — convert grove-v2 bot.yaml to cortex.yaml\n");
  console.log("Usage:");
  console.log("  bun src/cli/cortex/commands/migrate-config.ts <input.yaml> [options]\n");
  console.log("Options:");
  console.log("  --out FILE     Write to FILE (default: stdout)");
  console.log("  --check        Validate only — print mapping table + warnings; don't emit yaml");
  console.log("  --strict       Fail on warnings (default: warnings → stderr, exit 0)");
  console.log("  -h, --help     Show this help");
}

/**
 * Run the migrate-config workflow against argv. Exported for the in-process
 * test harness; the bottom of this file calls it from `process.argv` when
 * the script is executed directly.
 */
export async function runMigrateConfig(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error("Error:", err instanceof Error ? err.message : String(err));
    printHelp();
    return 1;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  if (!args.input) {
    console.error("Error: <input.yaml> is required\n");
    printHelp();
    return 1;
  }

  const inputPath = resolve(args.input);
  let raw: string;
  try {
    raw = readFileSync(inputPath, "utf-8");
  } catch (err) {
    console.error(`Error: cannot read ${inputPath}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let legacy: LegacyBotYaml;
  try {
    legacy = YAML.parse(raw) as LegacyBotYaml;
  } catch (err) {
    console.error(`Error: invalid YAML in ${inputPath}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  let result;
  try {
    result = convertBotYaml(legacy, { configDir: dirname(inputPath) });
  } catch (err) {
    console.error(`Error: conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  for (const w of result.warnings) {
    console.error(`warning [${w.field}] ${w.message}`);
  }

  if (args.check) {
    console.log(formatCheckReport(result));
  } else {
    const yamlOut = YAML.stringify(result.cortex, { indent: 2, lineWidth: 0 });
    if (args.out) {
      const outPath = resolve(args.out);
      writeFileSync(outPath, yamlOut, "utf-8");
      console.error(`wrote ${outPath} (${result.cortex.agents.length} agent(s), ${result.cortex.renderers.length} renderer(s))`);
    } else {
      process.stdout.write(yamlOut);
    }
  }

  if (args.strict && result.warnings.length > 0) {
    return 2;
  }
  return 0;
}

if (import.meta.main) {
  runMigrateConfig(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error("Fatal:", err);
      process.exit(1);
    },
  );
}
