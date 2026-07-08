#!/usr/bin/env bun
/**
 * `cortex step-up <subcommand>` — FND-3 (docs/plan-mc-future-state.md §4.0,
 * decision D-2). Enroll / inspect / test the LOCAL TOTP secret the MC daemon's
 * decider seam uses to gate high-blast (`GrantScope 'control'`) govern verbs
 * (seal / rotate-K / revoke / escalation-approve).
 *
 *   enroll            Generate a fresh RFC-6238 TOTP secret, write it `0600`
 *                     under ~/.config/cortex/, and print the one-time
 *                     `otpauth://` provisioning URI to add to an authenticator.
 *   status            Report whether a secret is enrolled (path, created-at,
 *                     digits/period) — NEVER the secret itself.
 *   verify <code>     Check a current 6-digit code against the enrolled secret
 *                     (confirm your authenticator is set up right). Prints only
 *                     valid/invalid — never the secret.
 *
 * SECRET DISCIPLINE: the only place the secret is ever displayed is the
 * `enroll` ceremony's `otpauth://` URI — the unavoidable hand-off to your
 * authenticator app. It is printed to your terminal ONCE and written to the
 * `0600` file; it is never logged, never re-printed by `status`/`verify`, and
 * never emitted by the daemon.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  DEFAULT_STEP_UP_SECRET_PATH,
  createEnrollment,
  loadEnrollment,
  writeEnrollment,
} from "../../../common/step-up/enrollment";
import { buildOtpauthUri, verifyTotp } from "../../../common/step-up/totp";
import { CliArgsError } from "./_shared/arg-error";
import { envelopeError, envelopeOk, renderJson } from "./_shared/envelope";
import { type ExitResult } from "./_shared/exit-result";
import {
  parseSubcommandArgs,
  type FlagMap,
  type SubcommandSpec,
} from "./_shared/parser";

type StepUpSubcommand = "enroll" | "status" | "verify";

const SPEC: SubcommandSpec<StepUpSubcommand> = {
  cliName: "step-up",
  subcommands: {
    enroll: {
      positionals: [],
      flags: {
        "--secret-path": "value",
        "--account": "value",
        "--issuer": "value",
        "--force": "bool",
      },
    },
    status: {
      positionals: [],
      flags: { "--secret-path": "value" },
    },
    verify: {
      positionals: ["code"],
      flags: { "--secret-path": "value" },
    },
  },
  universal: { "--json": "bool", "--help": "bool", "-h": "bool" },
};

// ============================================================================
// Helpers
// ============================================================================

function expandTildePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function optionalValueFlag(flags: FlagMap, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function resolveSecretPath(flags: FlagMap): string {
  return expandTildePath(
    optionalValueFlag(flags, "--secret-path") ?? DEFAULT_STEP_UP_SECRET_PATH,
  );
}

// ============================================================================
// Subcommand runners
// ============================================================================

function runEnroll(flags: FlagMap, json: boolean): ExitResult {
  const path = resolveSecretPath(flags);
  const force = flags["--force"] === true;

  if (existsSync(path) && !force) {
    const reason = `a step-up secret already exists at ${path}`;
    if (json) {
      return {
        exitCode: 1,
        stdout: renderJson(envelopeError(reason, { secret_path: path })),
        stderr: "",
      };
    }
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `cortex step-up: ${reason}.\n` +
        `Re-enrolling INVALIDATES the current authenticator entry. Pass --force to replace it.\n`,
    };
  }

  const account = optionalValueFlag(flags, "--account") ?? "cortex-daemon";
  const issuer = optionalValueFlag(flags, "--issuer") ?? "cortex";
  const enrollment = createEnrollment(new Date().toISOString());
  writeEnrollment(path, enrollment);

  const uri = buildOtpauthUri({
    secretBase32: enrollment.secret,
    issuer,
    account,
    digits: enrollment.digits,
    period: enrollment.period,
  });

  if (json) {
    // The URI carries the secret — emit it ONLY on the explicit enroll ceremony,
    // and only because the caller must hand it to an authenticator. `status`
    // and `verify` never do.
    return {
      exitCode: 0,
      stdout: renderJson(
        envelopeOk([{ enrolled: true }], {
          secret_path: path,
          otpauth_uri: uri,
          digits: String(enrollment.digits),
          period: String(enrollment.period),
        }),
      ),
      stderr: "",
    };
  }

  return {
    exitCode: 0,
    stdout:
      `Step-up MFA enrolled.\n\n` +
      `  Secret file : ${path} (chmod 600)\n` +
      `  Digits      : ${enrollment.digits}\n` +
      `  Period      : ${enrollment.period}s\n\n` +
      `Add this to your authenticator app NOW (shown once):\n\n` +
      `  ${uri}\n\n` +
      `Then confirm it works:  cortex step-up verify <6-digit-code>\n\n` +
      `This secret gates high-blast control verbs (seal / rotate-K / revoke).\n` +
      `Keep it out of shell history, screenshots, and shared terminals.\n`,
    stderr: "",
  };
}

function runStatus(flags: FlagMap, json: boolean): ExitResult {
  const path = resolveSecretPath(flags);
  let enrolled: ReturnType<typeof loadEnrollment>;
  try {
    enrolled = loadEnrollment(path);
  } catch (err) {
    const reason = (err as Error).message;
    if (json) {
      return {
        exitCode: 1,
        stdout: renderJson(envelopeError(reason, { secret_path: path })),
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex step-up: ${reason}\n` };
  }

  if (enrolled === null) {
    if (json) {
      return {
        exitCode: 0,
        stdout: renderJson(
          envelopeOk([{ enrolled: false }], { secret_path: path }),
        ),
        stderr: "",
      };
    }
    return {
      exitCode: 0,
      stdout:
        `Step-up MFA: NOT enrolled (no secret at ${path}).\n` +
        `High-blast control verbs on the glass will fail closed (403).\n` +
        `Enroll with:  cortex step-up enroll\n`,
      stderr: "",
    };
  }

  // NOTE: enrolled.secret is deliberately NOT included anywhere below.
  if (json) {
    return {
      exitCode: 0,
      stdout: renderJson(
        envelopeOk([{ enrolled: true }], {
          secret_path: path,
          created_at: enrolled.createdAt,
          digits: String(enrolled.digits),
          period: String(enrolled.period),
        }),
      ),
      stderr: "",
    };
  }
  return {
    exitCode: 0,
    stdout:
      `Step-up MFA: enrolled.\n` +
      `  Secret file : ${path} (chmod 600)\n` +
      `  Enrolled at : ${enrolled.createdAt || "(unknown)"}\n` +
      `  Digits      : ${enrolled.digits}\n` +
      `  Period      : ${enrolled.period}s\n`,
    stderr: "",
  };
}

function runVerify(code: string, flags: FlagMap, json: boolean): ExitResult {
  const path = resolveSecretPath(flags);
  let enrolled: ReturnType<typeof loadEnrollment>;
  try {
    enrolled = loadEnrollment(path);
  } catch (err) {
    const reason = (err as Error).message;
    if (json) {
      return {
        exitCode: 1,
        stdout: renderJson(envelopeError(reason, { secret_path: path })),
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex step-up: ${reason}\n` };
  }

  if (enrolled === null) {
    const reason = "not enrolled — nothing to verify against";
    if (json) {
      return {
        exitCode: 1,
        stdout: renderJson(envelopeError(reason, { secret_path: path })),
        stderr: "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: `cortex step-up: ${reason}.\n` };
  }

  const ok = verifyTotp(enrolled.secret, code.trim(), {
    digits: enrolled.digits,
    period: enrolled.period,
  });

  if (json) {
    return {
      exitCode: ok ? 0 : 1,
      stdout: renderJson(envelopeOk([{ valid: ok }])),
      stderr: "",
    };
  }
  return ok
    ? { exitCode: 0, stdout: "valid — this code would satisfy the step-up gate.\n", stderr: "" }
    : { exitCode: 1, stdout: "", stderr: "invalid — code not valid for the current window.\n" };
}

// ============================================================================
// Dispatch
// ============================================================================

export function dispatchStepUp(argv: string[]): Promise<ExitResult> {
  let parsed;
  try {
    parsed = parseSubcommandArgs(SPEC, argv);
  } catch (err) {
    if (err instanceof CliArgsError) {
      return Promise.resolve({
        exitCode: 2,
        stdout: "",
        stderr: `cortex step-up: ${err.message}\n${topLevelHelp()}`,
      });
    }
    throw err;
  }

  const json = parsed.flags["--json"] === true;

  if (parsed.subcommand === "help" || parsed.help) {
    return Promise.resolve({ exitCode: 0, stdout: topLevelHelp(), stderr: "" });
  }
  if (parsed.subcommand === "unknown") {
    const msg =
      parsed.rawSubcommand === ""
        ? "usage error — no subcommand specified."
        : `unknown subcommand "${parsed.rawSubcommand}".`;
    return Promise.resolve({
      exitCode: 2,
      stdout: "",
      stderr: `cortex step-up: ${msg}\n${topLevelHelp()}`,
    });
  }

  switch (parsed.subcommand) {
    case "enroll":
      return Promise.resolve(runEnroll(parsed.flags, json));
    case "status":
      return Promise.resolve(runStatus(parsed.flags, json));
    case "verify": {
      const code = parsed.positionals.code ?? "";
      if (code.trim() === "") {
        return Promise.resolve({
          exitCode: 2,
          stdout: "",
          stderr: `cortex step-up: verify requires a <code> argument.\n${topLevelHelp()}`,
        });
      }
      return Promise.resolve(runVerify(code, parsed.flags, json));
    }
  }
}

function topLevelHelp(): string {
  return `cortex step-up — enroll + manage the daemon step-up MFA secret (FND-3, D-2)

Usage:
  cortex step-up enroll [--secret-path <path>] [--account <name>] [--issuer <name>] [--force]
  cortex step-up status [--secret-path <path>] [--json]
  cortex step-up verify <code> [--secret-path <path>] [--json]

LOCAL TOTP (RFC 6238) enrolled at the daemon decider seam. Gates high-blast
'control' govern verbs (seal / rotate-K / revoke / escalation-approve). Absent
enrollment fails those verbs closed (403); the CLI remains the fallback.

Options:
  --secret-path <path>  Secret file location (default: ${DEFAULT_STEP_UP_SECRET_PATH}).
  --account <name>      Account label in the otpauth URI (default: cortex-daemon).
  --issuer <name>       Issuer label in the otpauth URI (default: cortex).
  --force               Replace an existing enrollment (invalidates the old code).
  --json                Machine-readable envelope output.

The enrolled secret is written chmod 600 and shown once (as an otpauth:// URI)
for your authenticator. It is never logged, never re-printed, never emitted by
the daemon.
`;
}
