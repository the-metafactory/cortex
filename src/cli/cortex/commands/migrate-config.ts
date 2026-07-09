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

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import YAML from "yaml";

import { validateConfigLoads } from "../../../common/config/validate-on-write";
import {
  convertBotYaml,
  formatCheckReport,
  type LegacyBotYaml,
} from "./migrate-config-lib";

interface ParsedArgs {
  input: string | undefined;
  out: string | undefined;
  labels: string | undefined;
  check: boolean;
  strict: boolean;
  /**
   * cortex#324 (v2.0.3) — when set, the migrator reuses the legacy
   * `nats.identity` block (seedPath + publicKey) for `stack.nkey_seed_path`
   * + `stack.nkey_pub`. Off by default; without the flag, the migrator
   * only emits a warning that stack signing is not configured.
   */
  autoStackKey: boolean;
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
    labels: undefined,
    check: false,
    strict: false,
    autoStackKey: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--check") {
      args.check = true;
    } else if (a === "--strict") {
      args.strict = true;
    } else if (a === "--auto-stack-key") {
      args.autoStackKey = true;
    } else if (a === "--out") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--out requires a path argument");
      }
      args.out = next;
      i++;
    } else if (a.startsWith("--out=")) {
      args.out = a.slice("--out=".length);
    } else if (a === "--labels") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("--labels requires a path argument");
      }
      args.labels = next;
      i++;
    } else if (a.startsWith("--labels=")) {
      args.labels = a.slice("--labels=".length);
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
  console.log("cortex migrate-config — convert grove-v2 bot.yaml or cortex.yaml to cortex.yaml + policy block\n");
  console.log("Usage:");
  console.log("  cortex migrate-config <input.yaml> [options]\n");
  console.log("Options:");
  console.log("  --out FILE     Write to FILE (default: stdout)");
  console.log("  --labels FILE  Principal-id label overrides ({\"<platform>:<id>\": \"<principal-id>\"})");
  console.log("  --check        Validate + emit pre-flight gap report; exits 1 if gaps found");
  console.log("  --strict       Fail on warnings (default: warnings → stderr, exit 0)");
  console.log("  --auto-stack-key  Reuse nats.identity NKey for stack.nkey_seed_path (cortex#324)");
  console.log("  -h, --help     Show this help");
}

/**
 * Run the migrate-config workflow against argv. Exported for the in-process
 * test harness; the bottom of this file calls it from `process.argv` when
 * the script is executed directly.
 */
// eslint-disable-next-line @typescript-eslint/require-await
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

  let labels: Map<string, string> | undefined;
  if (args.labels) {
    const labelsPath = resolve(args.labels);
    try {
      const labelsRaw = readFileSync(labelsPath, "utf-8");
      const parsed = YAML.parse(labelsRaw) as unknown;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("labels file must be a YAML mapping");
      }
      labels = new Map();
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new Error(`labels: value for "${k}" must be a string`);
        }
        labels.set(k, v);
      }
    } catch (err) {
      console.error(`Error: cannot read labels file ${labelsPath}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  let result;
  try {
    result = convertBotYaml(legacy, {
      configDir: dirname(inputPath),
      labels,
      autoStackKey: args.autoStackKey,
    });
  } catch (err) {
    console.error(`Error: conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  // cortex#295 / #296 — `--check` is the principal pre-flight for
  // parallel-mode activation. The legacy mapping table is still useful
  // diagnostically (principals eyeballing the conversion), so emit it
  // alongside the preflight gap report. Exit non-zero ONLY when there
  // are preflight gaps so CI / a future automated activator can gate on it.
  if (args.check) {
    for (const w of result.warnings) {
      process.stderr.write(`warning [${w.field}] ${w.message}\n`);
    }
    console.log(formatCheckReport(result));
    if (result.preflightGaps.length > 0) {
      process.stderr.write(
        `\nmigrate-config --check: ${result.preflightGaps.length} pre-flight gap(s) — parallel-mode activation BLOCKED. ` +
        `See policy preflight section above for the field-level breakdown.\n`,
      );
      return 1;
    }
    // `--strict` keeps its pre-existing semantic in --check mode too:
    // any warnings → exit 2 (legacy migrate-config.test.ts pins this).
    if (args.strict && result.warnings.length > 0) {
      return 2;
    }
    return 0;
  }

  for (const w of result.warnings) {
    console.error(`warning [${w.field}] ${w.message}`);
  }

  const yamlOut = YAML.stringify(result.cortex, { indent: 2, lineWidth: 0 });
  if (args.out) {
    const outPath = resolve(args.out);
    // cortex#88 item 5: a fresh host has no `~/.config/cortex/`, so
    // writeFileSync ENOENTs unless we ensure the parent exists. mkdir
    // recursive is idempotent — pre-existing dirs are a no-op.
    mkdirSync(dirname(outPath), { recursive: true });
    // FS-7 (cortex#1839) — validate-on-write: capture any pre-existing bytes so
    // a validation failure can restore the target byte-identical (or remove a
    // freshly-created file), never leaving a written-but-unloadable config.
    const preExisted = existsSync(outPath);
    const originalBytes = preExisted ? readFileSync(outPath, "utf-8") : undefined;
    // 0600 — a migrated cortex.yaml is a single-file config carrying inline
    // platform tokens, so it is a secret-at-rest AND the single-file loader
    // enforces chmod-600 (which the FS-7 validation below re-reads through). The
    // create mode is umask-masked, so chmod explicitly.
    writeFileSync(outPath, yamlOut, { encoding: "utf-8", mode: 0o600 });
    chmodSync(outPath, 0o600);
    // Run the daemon's OWN boot validator against the just-written file. On a
    // throw we restore/remove and exit non-zero with the precise error — the
    // same seam `cortex config validate` + the boot path use.
    const validation = validateConfigLoads(outPath);
    if (!validation.ok) {
      if (originalBytes !== undefined) {
        writeFileSync(outPath, originalBytes, { encoding: "utf-8", mode: 0o600 });
        chmodSync(outPath, 0o600);
      } else {
        rmSync(outPath, { force: true });
      }
      process.stderr.write(
        `migrate-config: converted config failed validation — ${
          originalBytes !== undefined ? "restored original" : "removed the written file"
        }; NOT leaving an unloadable config.\n  ${validation.errors.join("\n  ")}\n`,
      );
      return 1;
    }
    const policySummary = result.cortex.policy
      ? `, ${result.cortex.policy.principals.length} principal(s), ${result.cortex.policy.roles.length} role(s)`
      : "";
    console.error(`wrote ${outPath} (${result.cortex.agents.length} agent(s), ${result.cortex.renderers.length} renderer(s)${policySummary})`);
  } else {
    process.stdout.write(yamlOut);
  }

  if (args.strict && result.warnings.length > 0) {
    return 2;
  }
  return 0;
}

if (import.meta.main) {
  runMigrateConfig(process.argv.slice(2)).then(
    (code) => { process.exit(code); },
    (err: unknown) => {
      console.error("Fatal:", err);
      process.exit(1);
    },
  );
}
