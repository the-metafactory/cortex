/**
 * FND-3 (docs/plan-mc-future-state.md §4.0, decision D-2) — persistence of the
 * step-up MFA (LOCAL TOTP) enrollment secret.
 *
 * Shared by BOTH sides of the gate so there is one file format, one path
 * convention, one permission discipline:
 *  - the `cortex step-up enroll` CLI WRITES the secret here;
 *  - the MC daemon decider seam (`src/surface/mc/api/step-up-mfa.ts`) READS it
 *    to verify a high-blast control verb.
 *
 * SECRET DISCIPLINE: the secret lives ONLY in this `0600` file (and in memory
 * for the length of a verify / an enrollment ceremony). Nothing in this module
 * logs it. The one legitimate on-screen disclosure is the `otpauth://` URI the
 * enroll CLI prints once (see `totp.buildOtpauthUri`) — every other path
 * (status, the daemon, errors) carries only the PATH, never the secret.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { enforceChmod600 } from "../config/file-permissions";
import { resolveConfigFilePath } from "../config/config-path";
import { TOTP_DEFAULTS, generateTotpSecret } from "./totp";

/**
 * Display default for the enrolled step-up secret, shown in help (canonical,
 * XDG wave-4). Runtime read-sites resolve via {@link defaultStepUpSecretPath}
 * so an un-migrated host still finds the secret in the legacy tree.
 */
export const DEFAULT_STEP_UP_SECRET_PATH = "~/.config/metafactory/cortex/step-up-totp.json";

/**
 * The default step-up secret path resolved at CALL time — fallback-aware
 * (canonical `~/.config/metafactory/cortex` → legacy `~/.config/cortex` →
 * `~/.config/grove`). This is a chmod-600 secret at rest, so a fresh install
 * lands it canonical-side while a not-yet-migrated host keeps reading its legacy
 * copy (cortex#1869, XDG wave-4).
 */
export function defaultStepUpSecretPath(home?: string): string {
  return resolveConfigFilePath("step-up-totp.json", home);
}

/** The persisted enrollment record. Version-stamped for forward migration. */
export interface StepUpEnrollment {
  version: 1;
  /** RFC 4648 base32 TOTP secret. NEVER logged or returned to a client. */
  secret: string;
  digits: number;
  period: number;
  /** ISO-8601 enrollment timestamp (audit only; carries no secret). */
  createdAt: string;
}

/**
 * Build a fresh enrollment record with a cryptographically-random secret.
 * `createdAt` is caller-supplied so the value is deterministic in tests and the
 * module stays free of an ambient clock.
 */
export function createEnrollment(createdAtIso: string): StepUpEnrollment {
  return {
    version: 1,
    secret: generateTotpSecret(),
    digits: TOTP_DEFAULTS.digits,
    period: TOTP_DEFAULTS.period,
    createdAt: createdAtIso,
  };
}

/**
 * Persist an enrollment `0600`. Creates the parent dir (`0700`) if absent,
 * writes with `mode: 0o600`, then re-chmods (umask can strip creation bits) and
 * asserts the mode via the shared gate — a botched write fails loudly rather
 * than leaving a group/world-readable secret.
 */
export function writeEnrollment(path: string, enrollment: StepUpEnrollment): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path, JSON.stringify(enrollment, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  enforceChmod600(path);
}

/**
 * Load the enrolled secret from disk.
 *
 *  - File absent ⇒ `null` (NOT enrolled — the caller fails closed with 403).
 *  - File present ⇒ enforce `0600`, parse, validate shape. A present-but-
 *    malformed or wrong-permission file THROWS (loud failure — a broken secret
 *    must never silently read as "not enrolled" and downgrade the gate).
 *
 * The returned object carries the secret; callers MUST NOT log it.
 */
export function loadEnrollment(path: string): StepUpEnrollment | null {
  if (!existsSync(path)) return null;
  // Wrong permissions on a present secret file is a hard error.
  enforceChmod600(path);
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`step-up enrollment at ${path} is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`step-up enrollment at ${path} must be a JSON object`);
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.version !== 1) {
    throw new Error(`step-up enrollment at ${path} has unsupported version`);
  }
  if (typeof rec.secret !== "string" || rec.secret.trim() === "") {
    throw new Error(`step-up enrollment at ${path} is missing its secret`);
  }
  const digits = typeof rec.digits === "number" ? rec.digits : TOTP_DEFAULTS.digits;
  const period = typeof rec.period === "number" ? rec.period : TOTP_DEFAULTS.period;
  const createdAt = typeof rec.createdAt === "string" ? rec.createdAt : "";
  return { version: 1, secret: rec.secret.trim(), digits, period, createdAt };
}
