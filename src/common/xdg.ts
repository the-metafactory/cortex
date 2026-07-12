/**
 * XDG wave-2 (cortex#1870, EPIC cortex#1867) — shared env plumbing for the
 * `{home,env}` path seams (`CORTEX_CONFIG_DIR` / `CORTEX_EVENTS_DIR` /
 * `CORTEX_STATE_DIR`) and the Fallback Contract.
 *
 * Three tiny, dependency-free primitives, extracted so the seam modules don't
 * drift:
 *
 *   1. {@link readDirEnv} — the single dir-override env read. `cortexConfigDir`
 *      and `eventsDir` each inlined "read env, empty ⇒ unset" and diverged: the
 *      config seam left a whitespace-only value as a literal relative dir, the
 *      events seam the same (PR#1920 nit a+b). One helper: trim, and treat a
 *      value that is empty *after trimming* as unset — so `CORTEX_EVENTS_DIR="  "`
 *      is unset, not a relative `"  "` directory.
 *
 *   2. {@link xdgStrict} — the `CORTEX_XDG_STRICT` read. Strict mode is the
 *      fresh-install failure-class killer (#1870 invariant (v)): a scratch
 *      `$HOME` with NO legacy trees, `CORTEX_XDG_STRICT=1`, must complete the
 *      full flow emitting ZERO `xdg-fallback:` lines. This is the env read half.
 *
 *   3. {@link noteXdgFallback} — the ONE structured fallback log line, emitted
 *      at each legacy-fallback site (today: the `~/.config/grove` config
 *      read-fallback the #1908 seam kept). It fires ONLY under strict mode, so
 *      production on an upgraded machine stays byte-identical/silent while a
 *      fresh strict run makes any silent reliance on the legacy net LOUD and
 *      grep-able. This is the MINIMAL hook to make invariant (v) real+green on
 *      origin/main today; the full Fallback Contract (refuse-vs-warn policy,
 *      every classified site) is later-wave work.
 */

/** Structured prefix every fallback diagnostic carries (the guard greps this). */
export const XDG_FALLBACK_PREFIX = "xdg-fallback:";

/**
 * Read a directory-override env var, normalized: returns the TRIMMED value, or
 * `undefined` when the var is unset OR empty/whitespace-only. Trimming means a
 * stray `CORTEX_CONFIG_DIR="  "` (or a value with accidental surrounding
 * whitespace) never resolves as a literal relative directory — it reads as
 * unset, preserving today's default-path behavior.
 */
export function readDirEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const v = raw.trim();
  return v.length > 0 ? v : undefined;
}

/**
 * Whether XDG strict mode is on (`CORTEX_XDG_STRICT` set to a truthy value:
 * `1` / `true` / `yes`, case-insensitive, trimmed). In strict mode any reliance
 * on the legacy path net is surfaced via {@link noteXdgFallback}.
 */
export function xdgStrict(): boolean {
  const v = process.env.CORTEX_XDG_STRICT?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Emit the ONE structured `xdg-fallback:` diagnostic for a legacy-path
 * fallback that just fired — but ONLY under {@link xdgStrict}. Non-strict
 * (i.e. every upgraded machine that legitimately leans on the fallback net)
 * stays silent and byte-identical to before, so this adds no production noise;
 * a fresh strict run turns every fallback into a grep-able line so the #1870
 * guard can assert ZERO of them.
 *
 * @param site  Short stable site tag, e.g. `"config"`.
 * @param detail Human context, e.g. `"cli.yaml resolved from ~/.config/grove"`.
 */
export function noteXdgFallback(site: string, detail: string): void {
  if (!xdgStrict()) return;
  process.stderr.write(`${XDG_FALLBACK_PREFIX} ${site} — ${detail}\n`);
}
