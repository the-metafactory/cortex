/**
 * FS-7 (cortex#1839, epic #1818 Wave 0) — validate-on-write.
 *
 * Principle 5 of the federation-simplification design: *"Fail loud early, fail
 * soft late. Validate at write time, every path that touches config."* #1808
 * shipped `cortex config validate` but it is OPT-IN — nothing runs it
 * automatically, so a bad edit still reaches boot and crash-loops the daemon.
 *
 * This module is the SINGLE seam every config-writing verb (`config merge`,
 * `migrate-config`, `stack create --apply`, `network join/leave/create/secret`)
 * runs BEFORE committing a write: it composes the WHOLE resolved config and
 * feeds it through the daemon's OWN boot validator — `loadConfigWithAgents`
 * (loader.ts) — exactly as `cortex config validate` does
 * (`config.ts:160`). There is deliberately NO second validator: reusing
 * `loadConfigWithAgents` is what guarantees a write that passes here is a write
 * the daemon can boot.
 *
 * Why compose-the-whole (not the single layer): a config-split LAYER can be
 * individually valid yet compose to an invalid WHOLE — e.g. the `accept_subjects`
 * ADR-0001 scope violation that only surfaces once the layers merge. So the
 * writers stage their candidate bytes on disk (behind an existing backup/restore
 * path), point this validator at the config-split POINTER, and roll back on a
 * throw — never leaving a half-written or unloadable live config.
 */

import { ZodError } from "zod";

import { loadConfigWithAgents } from "./loader";

/**
 * Format a Zod issue the way the boot path surfaces it: dotted/bracketed path +
 * message (`policy.federated.networks[0].accept_subjects[1]: <message>`). Array
 * indices render as `[n]`, object keys as `.key`. Single source of truth for the
 * field-pathed shape principals already see when the daemon rejects a bad config
 * at boot; `cortex config validate` (config.ts) imports this same formatter so
 * write-time and boot-time errors read identically.
 */
export function formatZodIssue(issue: ZodError["issues"][number]): string {
  let path = "";
  for (const seg of issue.path) {
    if (typeof seg === "number") {
      path += `[${seg}]`;
    } else {
      path += path === "" ? String(seg) : `.${String(seg)}`;
    }
  }
  if (path === "") return issue.message;
  // Some schema `custom` issues (e.g. the ADR-0001 accept_subjects scope check)
  // already lead their message with the same field path. Don't prepend it twice
  // — surface the message verbatim when it already begins with the path.
  if (issue.message.startsWith(path)) return issue.message;
  return `${path}: ${issue.message}`;
}

/**
 * Extract the list of precise validation error strings from any error the boot
 * load path can throw. A `ZodError` (the schema-validation failure — the common
 * case, including the `accept_subjects` cross-check) yields one string per issue,
 * each field-pathed. Any other error (unreadable file, malformed YAML, chmod
 * gate) yields its single message. A nested `ZodError` cause is unwrapped so the
 * precise per-issue paths still surface rather than an opaque wrapper.
 */
export function formatConfigLoadError(err: unknown): string[] {
  if (err instanceof ZodError) {
    return err.issues.map(formatZodIssue);
  }
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof ZodError) {
      return cause.issues.map(formatZodIssue);
    }
    return [err.message];
  }
  return [String(err)];
}

/** Result of a compose-then-validate check. */
export interface ConfigValidation {
  ok: boolean;
  /** Precise, field-pathed error strings; empty when `ok`. */
  errors: string[];
}

/**
 * Compose the WHOLE resolved config at `pointerPath` and validate it through the
 * daemon's boot validator (`loadConfigWithAgents`). Never throws — a failure is
 * returned as `{ ok: false, errors }` so callers with their own restore/rollback
 * scaffolding can branch on it. `pointerPath` is the config-split pointer (or a
 * legacy single-file cortex.yaml) — the SAME path the daemon's `--config` names.
 */
export function validateConfigLoads(pointerPath: string): ConfigValidation {
  try {
    loadConfigWithAgents(pointerPath);
    return { ok: true, errors: [] };
  } catch (err) {
    return { ok: false, errors: formatConfigLoadError(err) };
  }
}

/**
 * Throw a precise, multi-line error when the composed config at `pointerPath`
 * does not load. For writers that have NO backup/restore scaffolding of their
 * own and want a single-line "abort on invalid" call — the caller's own
 * try/catch converts the throw into a clean non-zero exit + original-config
 * restore. Writers that ALREADY have a restore path (config-merge) call
 * `validateConfigLoads` and route through it instead.
 */
export function assertConfigLoads(pointerPath: string): void {
  const result = validateConfigLoads(pointerPath);
  if (!result.ok) {
    throw new Error(
      `config validation failed — refusing to write:\n${result.errors
        .map((e) => `  ${e}`)
        .join("\n")}`,
    );
  }
}
