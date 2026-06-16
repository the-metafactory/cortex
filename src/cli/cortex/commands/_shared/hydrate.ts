/**
 * Type-safe accessors for the `flags` map returned by
 * `parseSubcommandArgs`. Echo cortex#66 round-1 M2 — the per-CLI
 * hydration step used to do `as string | undefined` casts that would
 * silently let a `bool` flag's `true` value through as a "string."
 * These helpers do the kind-check at runtime so a spec mistake (or
 * future spec evolution) surfaces immediately rather than passing the
 * literal `true` to downstream code that expects a string.
 *
 * Usage:
 *
 * ```ts
 * const parsed = parseSubcommandArgs(SPEC, argv);
 * return {
 *   config: valueFlag(parsed.flags, "--config"),  // string | undefined
 *   json:   boolFlag(parsed.flags, "--json"),     // boolean
 * };
 * ```
 */

export function valueFlag(
  flags: Record<string, string | true | string[]>,
  name: string,
): string | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (v === true) {
    throw new Error(
      `internal: flag ${name} declared as bool in spec but accessed via valueFlag. Spec / hydration mismatch.`,
    );
  }
  if (Array.isArray(v)) {
    throw new Error(
      `internal: flag ${name} declared as value-list in spec but accessed via valueFlag. Spec / hydration mismatch.`,
    );
  }
  return v;
}

export function boolFlag(
  flags: Record<string, string | true | string[]>,
  name: string,
): boolean {
  const v = flags[name];
  if (v === undefined) return false;
  if (v === true) return true;
  throw new Error(
    `internal: flag ${name} declared as ${Array.isArray(v) ? "value-list" : "value"} in spec but accessed via boolFlag. Spec / hydration mismatch.`,
  );
}

/**
 * Accessor for `value-list` flags (cortex#1057). Returns the accumulated
 * array, or `[]` when the flag was absent. Throws if the flag was declared
 * as `value` (single string) or `bool` (`true`) — a spec/hydration mismatch.
 */
export function listFlag(
  flags: Record<string, string | true | string[]>,
  name: string,
): string[] {
  const v = flags[name];
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  throw new Error(
    `internal: flag ${name} declared as ${v === true ? "bool" : "value"} in spec but accessed via listFlag. Spec / hydration mismatch.`,
  );
}
