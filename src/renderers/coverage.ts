/**
 * cortex#1893 (S12b-pre, epic #1784) — the G-1111 §4.6 renderer-coverage
 * boot HARD-FAIL guard. ADR-0024 §OQ9 (ratified 2026-07-11).
 *
 * ## Why this exists
 *
 * G-1111 §4.6 requires **≥2 distinct renderer platform classes** covering
 * `local.{principal}.system.>` so a single degraded sink cannot blind the
 * principal to system events (`src/renderers/types.ts:15-21`). Today the pair
 * is `dashboard` + `pagerduty`, both in-tree. Once `pagerduty` extracts to a
 * bundle (cortex#1894, S12b), a stack that never ran `arc install` — OR that
 * left `system.plugins.external` off (the recommended secure default for
 * ADAPTERS) — is left with ONE sink, the INERT `dashboard`. The pager then
 * SILENTLY does not page: a default that is *secure* for adapters ("don't load
 * third-party code") is *fail-OPEN* for a pager ("don't page").
 *
 * Ratified decision: move the risk from *silent no-page* → *loud no-boot*. Boot
 * HARD-FAILS when `system.>` coverage drops below two distinct platform classes
 * (with at least one EFFECTIVE sink). A stack that cannot page refuses to start
 * rather than running blind while believing it is monitored.
 *
 * ## The inert-`dashboard` interpretation (requirement #3, ADR-0024 §OQ9)
 *
 * `DashboardRenderer` is a stub superseded by ADR-0005 §4: it buffers into a
 * ring nothing reads (`getRecent()` has no production consumer), so it DELIVERS
 * NOTHING. Coverage counting must not be fooled by it — "dashboard alone" is
 * the exact fail-open being closed.
 *
 * We count it as a **class for diversity, but never as an EFFECTIVE sink**:
 *
 *   coverage is SATISFIED  ⇔  (≥2 distinct system-covering classes)
 *                         AND (≥1 of those classes is EFFECTIVE, i.e. not inert)
 *
 * This is the interpretation that makes both required truths hold at once:
 *   - `dashboard` ALONE → 1 covering class → FAILS the ≥2 clause. ✔ (acc. #3)
 *   - `dashboard` + a loaded `pagerduty` → 2 classes, `pagerduty` effective →
 *     BOOTS. ✔ (acc. #5) — this is why `dashboard` must still *count* toward
 *     diversity rather than being excluded outright: the ratified canonical
 *     pair is dashboard+pagerduty, and acceptance criterion #5 mandates it boot.
 *   - `dashboard` + a configured-but-UNLOADED `pagerduty` → at runtime only the
 *     inert `dashboard` started → FAILS, and the shortfall is attributable to
 *     an absent bundle → INSTALL-STATE error (acc. #2), not a config error.
 *
 * The guard is deliberately the OQ9-scoped rule (close "dashboard alone"), NOT
 * the stronger "≥2 EFFECTIVE sinks" ideal — the latter would false-fail the
 * canonical dashboard+pagerduty pair that acceptance #5 requires to boot.
 *
 * ## Two distinct failures (requirement #2)
 *
 *   - {@link RendererCoverageConfigError} — "you configured one sink." A pure
 *     CONFIG authoring error. Raised at config-load (`loadCortexShape`).
 *   - {@link RendererCoverageInstallStateError} — "you configured two, one's
 *     bundle isn't loaded." A fleet/INSTALL-STATE error naming the missing
 *     bundle + the exact `arc install` remedy. Raised AFTER plugin loading
 *     (S6), where "did the bundle load?" is finally answerable. It is NOT a
 *     config error and must never be reported as one.
 *
 * ## Secrets (requirement #4)
 *
 * Error text carries only renderer **kinds** (`dashboard`, `pagerduty`) and
 * **bundle names** (`metafactory-cortex-renderer-pagerduty`). It NEVER echoes a
 * renderer's `subscribe` patterns, its `routingKey` (the PagerDuty secret), or
 * any token — none of those are read into a message here.
 */

/**
 * Renderer kinds that count toward class-diversity but can NEVER be one of the
 * ≥2 EFFECTIVE sinks. `dashboard` is inert per ADR-0005 §4 (its ring buffer has
 * no production reader). If a second inert kind is ever introduced, add it here
 * with the same justification — an all-inert covering set must always fail.
 */
export const INERT_RENDERER_KINDS: ReadonlySet<string> = new Set(["dashboard"]);

/**
 * Known first-party renderer-bundle names, keyed by `rendererKind`. Used ONLY
 * to build the install-state remediation message. Follows the compass#115
 * `metafactory-cortex-renderer-<name>` standard (the renderer twin of the
 * `metafactory-cortex-adapter-<name>` adapter bundles). A kind absent from this
 * map falls back to the conventional name via {@link rendererBundleForKind}.
 */
export const RENDERER_BUNDLE_BY_KIND: Readonly<Record<string, string>> = {
  pagerduty: "metafactory-cortex-renderer-pagerduty",
};

/** The bundle name that provides `rendererKind`, per the compass#115 standard. */
export function rendererBundleForKind(kind: string): string {
  return RENDERER_BUNDLE_BY_KIND[kind] ?? `metafactory-cortex-renderer-${kind}`;
}

/**
 * Substitute the `{principal}` / `{stack}.` subject placeholders exactly as
 * {@link makeSubjectPlaceholderSubstituter} (`src/bus/myelin/runtime.ts`) does.
 *
 * DUPLICATED (not imported) on purpose: this module runs on the CONFIG-LOAD
 * path (`loadCortexShape`), and importing `runtime.ts` would drag the whole
 * NATS client (`import ... from "nats"`) into config validation. The logic is
 * three lines of pure string work; keeping it local avoids that coupling. If
 * the canonical helper's grammar changes, mirror it here.
 */
function substitutePlaceholders(
  subjects: readonly string[],
  ctx: { principal: string; stack?: string },
): string[] {
  const stackToken = ctx.stack !== undefined ? `${ctx.stack}.` : "";
  return subjects.map((s) =>
    s.replaceAll("{principal}", ctx.principal).replaceAll("{stack}.", stackToken),
  );
}

/** Tokenise a NATS subject/pattern on `.`. */
function tokenize(subject: string): string[] {
  return subject.split(".");
}

/**
 * Do two NATS subject PATTERNS share at least one concrete subject? `*` matches
 * exactly one token; `>` matches one-or-more trailing tokens. Conservative by
 * construction — it returns `true` only when a common subject provably exists,
 * so it never over-claims coverage (over-claiming would be fail-OPEN, the exact
 * hazard this guard closes).
 */
export function subjectPatternsIntersect(a: readonly string[], b: readonly string[]): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ta = a[i];
    const tb = b[j];
    // A `>` here matches the ≥1 tokens the loop guarantees remain on the other
    // side — a common subject exists from this point on.
    if (ta === ">" || tb === ">") return true;
    if (ta === "*" || tb === "*" || ta === tb) {
      i += 1;
      j += 1;
      continue;
    }
    // Two distinct literal tokens at the same position — disjoint.
    return false;
  }
  // Both fully consumed with every token reconciled → identical-length match.
  if (i === a.length && j === b.length) return true;
  // One side has tokens left while the other ended. `>` needs ≥1 token, but the
  // exhausted side offers none there — no common subject. (A trailing `>` on
  // the longer side would already have returned true inside the loop.)
  return false;
}

/**
 * The concrete `system.>` probe subject(s) for a deployment. cortex publishes
 * system events in BOTH shapes — stack-ful (`local.andreas.work.system.>`) and
 * stack-less (`local.andreas.system.>`) — depending on whether a `stack:` block
 * is declared (`src/bus/myelin/runtime.ts:685-687`), and the production
 * system-event consumer (`observability-renderer.ts`) defensively subscribes to
 * BOTH forms for every family. A renderer covering EITHER shape is therefore
 * providing a real, intentional system sink, so coverage is judged against both
 * probes.
 *
 * NON-GOAL (documented residual): this guard checks *class-level* coverage
 * diversity (is there ≥2 distinct classes intending to catch system events, and
 * did their bundles load?), NOT fine-grained subject-alignment. A principal who
 * writes a stack-LESS pagerduty pattern in a stack-FUL deployment whose runtime
 * only emits stack-ful subjects passes this guard but would not actually page —
 * a finer misconfiguration than the "a whole sink CLASS silently vanished"
 * regression this slice targets (ADR-0024 §OQ9). Matching the observability
 * renderer's both-shapes treatment keeps the guard from false-failing the
 * documented stack-less pagerduty example (`src/renderers/pagerduty.ts:11-18`).
 */
export function systemProbeSubjects(ctx: { principal: string; stack?: string }): string[] {
  // `{stack}.` collapses to "" when stack is undefined, so this is already the
  // stack-less probe for a stack-less deployment.
  const stackful = substitutePlaceholders(["local.{principal}.{stack}.system.>"], ctx)[0] ?? "";
  if (ctx.stack === undefined) return [stackful];
  const stackless = substitutePlaceholders(["local.{principal}.system.>"], {
    principal: ctx.principal,
  })[0] ?? "";
  return [stackful, stackless];
}

/**
 * Does a renderer's `subscribe` set (raw, with placeholders) overlap the
 * `local.{principal}.system.>` subtree — in either the stack-ful or stack-less
 * shape — for this deployment?
 */
export function rendererCoversSystem(
  subscribe: readonly string[],
  ctx: { principal: string; stack?: string },
): boolean {
  const probes = systemProbeSubjects(ctx).map(tokenize);
  return substitutePlaceholders(subscribe, ctx).some((s) => {
    const st = tokenize(s);
    return probes.some((probe) => subjectPatternsIntersect(st, probe));
  });
}

/** One renderer's coverage-relevant shape: its class (`kind`) + subscribe set. */
export interface RendererCoverageInput {
  kind: string;
  subscribe: readonly string[];
}

/** The outcome of evaluating a renderer set against the §4.6 fail-safe rule. */
export interface CoverageVerdict {
  /** Distinct classes (kinds) that cover `system.>`, sorted. */
  coveringKinds: string[];
  /** Distinct covering classes that are EFFECTIVE (not inert), sorted. */
  effectiveCoveringKinds: string[];
  /** Whether ANY renderer covers `system.>` — i.e. the stack opted into system
   *  alerting. When false the rule does not apply (out of scope → satisfied). */
  inScope: boolean;
  /** Whether the fail-safe rule is satisfied. */
  satisfied: boolean;
}

/**
 * Evaluate a renderer set against the G-1111 §4.6 fail-safe rule.
 *
 * SCOPE: the rule applies only to stacks that opted into system alerting —
 * i.e. that configured at least one renderer covering `system.>`. A stack with
 * NO system-covering renderer (zero renderers, or only non-system sinks) is out
 * of scope and `satisfied` is `true`. This bounds the guard's blast radius to
 * stacks that have declared a system sink; it does not newly force every stack
 * in the fleet to configure paging.
 */
export function evaluateSystemCoverage(
  renderers: readonly RendererCoverageInput[],
  ctx: { principal: string; stack?: string },
): CoverageVerdict {
  const covering = renderers.filter((r) => rendererCoversSystem(r.subscribe, ctx));
  const coveringKinds = [...new Set(covering.map((r) => r.kind))].sort();
  const effectiveCoveringKinds = [
    ...new Set(covering.filter((r) => !INERT_RENDERER_KINDS.has(r.kind)).map((r) => r.kind)),
  ].sort();
  const inScope = coveringKinds.length > 0;
  const satisfied =
    !inScope || (coveringKinds.length >= 2 && effectiveCoveringKinds.length >= 1);
  return { coveringKinds, effectiveCoveringKinds, inScope, satisfied };
}

const RULE_PREAMBLE =
  "G-1111 §4.6 requires at least two distinct renderer platform classes " +
  "covering `local.{principal}.system.>`, with at least one EFFECTIVE " +
  "(delivering) sink, so a single degraded sink cannot blind the principal to " +
  "system events. The `dashboard` renderer is INERT (ADR-0005 §4: it buffers " +
  "but delivers nothing), so it counts toward class diversity but can never be " +
  "the effective sink.";

/**
 * "You configured one sink." A pure CONFIG authoring error — the declared
 * renderers do not, on their own, meet the fail-safe floor. Raised at
 * config-load. Distinct TYPE from {@link RendererCoverageInstallStateError} so
 * callers/tests can tell a config fault from an install-state fault.
 */
export class RendererCoverageConfigError extends Error {
  readonly verdict: CoverageVerdict;
  constructor(verdict: CoverageVerdict) {
    const found =
      verdict.coveringKinds.length > 0 ? `[${verdict.coveringKinds.join(", ")}]` : "[none]";
    const effective =
      verdict.effectiveCoveringKinds.length > 0
        ? `[${verdict.effectiveCoveringKinds.join(", ")}]`
        : "[none]";
    super(
      `cortex: renderer coverage check FAILED (config). ${RULE_PREAMBLE}\n` +
        `Configured system-covering classes: ${found} (effective: ${effective}).\n` +
        `Add an effective system-covering renderer (e.g. a \`pagerduty\` renderer ` +
        `subscribed to \`local.{principal}.system.>\`) so an operational alert ` +
        `reliably reaches you. Decision: ADR-0024 §OQ9.`,
    );
    this.name = "RendererCoverageConfigError";
    this.verdict = verdict;
  }
}

/**
 * "You configured two, one's bundle isn't loaded." A fleet/INSTALL-STATE error:
 * the config declares enough classes, but the bundle(s) providing one or more
 * of them did not load, so effective runtime coverage dropped below the floor.
 * Names the missing bundle(s) + the exact `arc install` remedy. Raised AFTER
 * plugin loading (S6). NOT a config error and must never be reported as one.
 */
export class RendererCoverageInstallStateError extends Error {
  /** Renderer kinds whose bundle is absent/unloaded. */
  readonly missingKinds: string[];
  /** Bundle names that would restore coverage. */
  readonly missingBundles: string[];
  constructor(missingKinds: string[]) {
    const kinds = [...new Set(missingKinds)].sort();
    const bundles = kinds.map(rendererBundleForKind);
    const installLines = bundles.map((b) => `    arc install ${b}`).join("\n");
    super(
      `cortex: renderer coverage check FAILED (install-state). ${RULE_PREAMBLE}\n` +
        `The config declares enough classes, but the bundle(s) providing ` +
        `[${kinds.join(", ")}] did not load — effective coverage of ` +
        `\`local.{principal}.system.>\` dropped below the floor and the pager ` +
        `would silently not page. This is a fleet/install-state failure, NOT a ` +
        `config error. Install the missing renderer bundle(s) and restart:\n` +
        `${installLines}\n` +
        `Missing bundle(s): ${bundles.join(", ")}. Decision: ADR-0024 §OQ9 ` +
        `(boot hard-fails rather than run blind).`,
    );
    this.name = "RendererCoverageInstallStateError";
    this.missingKinds = kinds;
    this.missingBundles = bundles;
  }
}

/**
 * CONFIG-LOAD guard: assert the CONFIGURED renderer set meets the §4.6 floor.
 * Throws {@link RendererCoverageConfigError} on a pure-config shortfall
 * (e.g. `dashboard` alone). No-op when the stack is out of scope (no
 * system-covering renderer declared).
 */
export function assertConfiguredSystemCoverage(
  renderers: readonly RendererCoverageInput[],
  ctx: { principal: string; stack?: string },
): void {
  const verdict = evaluateSystemCoverage(renderers, ctx);
  if (!verdict.satisfied) throw new RendererCoverageConfigError(verdict);
}

/**
 * POST-S6 (install-state) guard: assert the renderers that ACTUALLY STARTED
 * still meet the §4.6 floor, now that plugin loading has run and "did the
 * bundle load?" is answerable.
 *
 * @param started renderers that started successfully (kind + already-resolved
 *   subscribe subjects).
 * @param skippedForMissingBundle renderer config entries that could NOT start
 *   because their kind is unregistered — i.e. their bundle isn't loaded
 *   (`UnimplementedRendererKindError`). This is the install-state signal.
 *
 * Throws {@link RendererCoverageInstallStateError} when the runtime shortfall is
 * attributable to an absent covering bundle; falls back to
 * {@link RendererCoverageConfigError} if the started set is insufficient for a
 * reason no unloaded bundle explains (normally pre-empted at config-load, but
 * kept correct for callers that construct `startCortex` inputs directly).
 */
export function assertRuntimeSystemCoverage(
  opts: {
    started: readonly RendererCoverageInput[];
    skippedForMissingBundle: readonly RendererCoverageInput[];
  },
  ctx: { principal: string; stack?: string },
): void {
  const startedVerdict = evaluateSystemCoverage(opts.started, ctx);
  if (startedVerdict.satisfied) return;

  const absentCoveringKinds = [
    ...new Set(
      opts.skippedForMissingBundle
        .filter((r) => rendererCoversSystem(r.subscribe, ctx))
        .map((r) => r.kind),
    ),
  ];

  if (absentCoveringKinds.length > 0) {
    throw new RendererCoverageInstallStateError(absentCoveringKinds);
  }
  // No unloaded covering bundle explains the shortfall → treat as a config
  // insufficiency. At boot this is unreachable (config-load already asserted
  // configured coverage); it stays correct for direct `startCortex` callers.
  throw new RendererCoverageConfigError(startedVerdict);
}
