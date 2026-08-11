/**
 * cortex#1893 (S12b-pre, epic #1784) — the ADR-0024 §OQ9 renderer-coverage
 * boot HARD-FAIL guard. ADR-0024 §OQ9 (ratified 2026-07-11).
 *
 * ## Why this exists
 *
 * ADR-0024 §OQ9 requires **≥2 distinct renderer platform classes** covering
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
 * cortex#2503 — the **platform class** of each renderer kind (ADR-0024 §OQ9
 * → *Platform classes*).
 *
 * ## Why this map has to exist
 *
 * The rule is "≥2 distinct **platform classes**", and a platform class groups
 * kinds by *shared vendor-outage risk*. Counting distinct `kind` STRINGS —
 * which is what this module did before — satisfies the floor with
 * `discord` + `slack`, two kinds that are one class: when that vendor has a
 * bad day BOTH sinks die and the principal is blind, which is the precise
 * failure §OQ9 exists to prevent. Kind-counting is fail-open in a guard whose
 * whole design is to fail loud.
 *
 * ## `mattermost` maps to TWO classes, on purpose
 *
 * A mattermost renderer is a `chat-gateway` in bot mode and a `webhook-out`
 * in incoming-webhook mode, and the config does not tell us which. It
 * therefore contributes an AMBIGUOUS class: it can pair with something from
 * either class, but it can NEVER satisfy the diversity floor against
 * *itself* (see {@link evaluateSystemCoverage}) — two mattermost renderers
 * are one vendor no matter which modes they run in.
 */
export const PLATFORM_CLASS_BY_KIND: Readonly<Record<string, readonly string[]>> = {
  discord: ["chat-gateway"],
  slack: ["chat-gateway"],
  mattermost: ["chat-gateway", "webhook-out"],
  // NAME COLLISION, deliberate: cortex ships `webhook-out` as a renderer KIND
  // (`RendererSchema`, `src/common/types/cortex-config.ts`) while the retired
  // spec used the same token for the CLASS. They are the same concept at two
  // levels here, so the kind maps to the like-named class. `webhook-generic`
  // is the spec's own name for the kind and is accepted as a synonym.
  "webhook-out": ["webhook-out"],
  "webhook-generic": ["webhook-out"],
  pagerduty: ["paging"],
  opsgenie: ["paging"],
  dashboard: ["local-projection"],
  "cli-tail": ["local-projection"],
};

/**
 * Platform class(es) for a renderer kind, or `undefined` when the kind is not
 * in the curated map.
 *
 * An unknown kind is **not** given a class of its own. Doing that would
 * reintroduce the exact fail-open this fix closes: since S4/ADR-0024 D5
 * `RendererKindSchema` is an open `z.string().min(1)`, so any two arbitrary
 * plugin kinds would once again read as "two classes". Callers must treat
 * `undefined` as *refuse*, not as *allow*.
 */
export function platformClassesForKind(kind: string): readonly string[] | undefined {
  // `hasOwnProperty`, not a bare index: `RendererKindSchema` is an open string,
  // so a kind of `constructor` / `toString` / `__proto__` would otherwise
  // resolve to an `Object.prototype` member and sail past the unknown-kind
  // refusal as if it were a classified kind.
  if (!Object.prototype.hasOwnProperty.call(PLATFORM_CLASS_BY_KIND, kind)) return undefined;
  return PLATFORM_CLASS_BY_KIND[kind];
}

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
 * cortex#1894 (S12b) — is `kind` a KNOWN first-party renderer whose schema +
 * class ship in a separately-installed bundle (not the in-tree
 * `createDefaultSurfacePluginRegistry`)? Used by the CONFIG-LOAD renderer pass
 * (`loadCortexShape`) to TOLERATE an `UnimplementedRendererKindError` for such
 * a kind at config-load — the bundle only registers post-S6 at daemon boot, so
 * "is it loaded?" is not answerable at config-load and is deferred to
 * {@link assertRuntimeSystemCoverage}. A genuine typo (a kind absent from
 * {@link RENDERER_BUNDLE_BY_KIND}) is NOT tolerated — it still fails loudly at
 * config-load exactly as before. This is the curated, PR-reviewed set (the
 * inverse of `rendererBundleForKind`'s explicit map), so it can never
 * self-widen from config or bundle content.
 */
export function isKnownFirstPartyRendererKind(kind: string): boolean {
  return Object.prototype.hasOwnProperty.call(RENDERER_BUNDLE_BY_KIND, kind);
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
  /** Distinct renderer KINDS that cover `system.>`, sorted. */
  coveringKinds: string[];
  /** Distinct covering kinds that are EFFECTIVE (not inert), sorted. */
  effectiveCoveringKinds: string[];
  /**
   * cortex#2503 — distinct PLATFORM CLASSES reachable from the covering set,
   * sorted. This is what the rule actually counts; `coveringKinds` is kept for
   * message text and back-compat.
   */
  coveringClasses: string[];
  /**
   * Covering kinds with no entry in {@link PLATFORM_CLASS_BY_KIND}.
   *
   * These are never COUNTED toward diversity — that is the fail-open this
   * closes. They do not on their own refuse the verdict: if the classified
   * renderers already satisfy the floor, an unclassified kind is simply an
   * extra sink and the stack boots (ADR-0024 D5 ships out-of-tree renderers).
   * It only blocks when the decision would otherwise rest on it.
   */
  unclassifiedKinds: string[];
  /** Whether ANY renderer covers `system.>` — i.e. the stack opted into system
   *  alerting. When false the rule does not apply (out of scope → satisfied). */
  inScope: boolean;
  /** Whether the fail-safe rule is satisfied. */
  satisfied: boolean;
}

/**
 * Evaluate a renderer set against the ADR-0024 §OQ9 fail-safe rule.
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

  // cortex#2503 — classes, not kind strings.
  const unclassifiedKinds = coveringKinds.filter(
    (k) => platformClassesForKind(k) === undefined,
  );
  const coveringClasses = [
    ...new Set(coveringKinds.flatMap((k) => platformClassesForKind(k) ?? [])),
  ].sort();

  // A pair proves diversity only when its class sets are DISJOINT — i.e. no
  // assignment of modes could put both renderers in the same class.
  //
  // Disjointness rather than "some distinct assignment exists" because the
  // guard is fail-CLOSED: `mattermost` may be a `chat-gateway` OR a
  // `webhook-out` and the config does not say which, so `mattermost` +
  // `discord` must NOT pass — if that mattermost is running in bot mode both
  // sinks are chat gateways and one vendor outage takes out both. Ambiguity
  // resolves against the config, never in its favour.
  const classifiedKinds = coveringKinds.filter((k) => platformClassesForKind(k) !== undefined);
  const hasTwoDisjointClasses = classifiedKinds.some((kindA, i) =>
    classifiedKinds.slice(i + 1).some((kindB) => {
      const a = platformClassesForKind(kindA) ?? [];
      const b = platformClassesForKind(kindB) ?? [];
      return !a.some((ca) => b.includes(ca));
    }),
  );

  // An unclassified kind only BLOCKS when the classified renderers do not
  // already satisfy the floor on their own. ADR-0024 D5 exists so third-party
  // renderer bundles can ship; refusing every stack that installs one would
  // break that outright. What must never happen is an unclassified kind being
  // COUNTED toward diversity — so it is ignored when coverage already holds,
  // and refused when the decision would otherwise rest on it.
  const blockedByUnclassified = unclassifiedKinds.length > 0 && !hasTwoDisjointClasses;

  const satisfied =
    !inScope ||
    (!blockedByUnclassified && hasTwoDisjointClasses && effectiveCoveringKinds.length >= 1);

  return {
    coveringKinds,
    effectiveCoveringKinds,
    coveringClasses,
    unclassifiedKinds,
    inScope,
    satisfied,
  };
}

/**
 * The class table, rendered FROM {@link PLATFORM_CLASS_BY_KIND} rather than
 * hand-written beside it — a duplicated list drifts the moment a kind is
 * added, and this one already had.
 */
function renderClassTable(): string {
  const byClass = new Map<string, string[]>();
  for (const [kind, classes] of Object.entries(PLATFORM_CLASS_BY_KIND)) {
    for (const c of classes) byClass.set(c, [...(byClass.get(c) ?? []), kind]);
  }
  return [...byClass.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([c, kinds]) => `\`${c}\` (${kinds.sort().join(", ")})`)
    .join(", ");
}

const RULE_PREAMBLE =
  "ADR-0024 §OQ9 requires at least two renderer PLATFORM CLASSES covering " +
  "`local.{principal}.system.>` whose class sets cannot overlap, with at least " +
  "one EFFECTIVE (delivering) sink, so one platform going down cannot blind " +
  "the principal to system events. Classes group kinds by shared outage risk: " +
  `${renderClassTable()}. ` +
  "Two kinds in the SAME class (e.g. discord + slack) are one class, not two. " +
  "The `dashboard` renderer is INERT (ADR-0005 §4: it buffers but delivers " +
  "nothing), so it counts toward class diversity but can never be the " +
  "effective sink.\n" +
  "LIMIT: class is derived from the renderer KIND, which does not identify the " +
  "VENDOR behind it — a `webhook-out` posting to PagerDuty and a `pagerduty` " +
  "renderer read as two classes but are one vendor. Class diversity is a floor, " +
  "not a guarantee; choosing genuinely independent sinks is still yours.";


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
    const classes =
      verdict.coveringClasses.length > 0 ? `[${verdict.coveringClasses.join(", ")}]` : "[none]";
    // A mode-ambiguous kind (`mattermost` → chat-gateway OR webhook-out)
    // contributes >1 class while still failing, so "fewer than two classes"
    // would read as a contradiction against the list printed above it. Say
    // what actually failed: no PAIR with disjoint class sets.
    const ambiguous = verdict.coveringClasses.length >= 2;
    const diagnosis = ambiguous
      ? `No two of those renderers have DISJOINT class sets, so none of them ` +
        `provably covers a different vendor than the others. A kind that could ` +
        `belong to more than one class (e.g. \`mattermost\`, chat-gateway in bot ` +
        `mode and webhook-out in webhook mode) is resolved conservatively — it ` +
        `cannot be assumed to be in whichever class would make the config pass.`
      : `Those resolve to a single platform class — fewer than the two required.`;
    const unclassifiedNote =
      verdict.unclassifiedKinds.length > 0
        ? `\nNOT COUNTED — cortex has no platform class for: ` +
          `[${verdict.unclassifiedKinds.join(", ")}]. An unknown kind is never ` +
          `assumed to be a class of its own (that is how every sink ends up ` +
          `sharing one platform), so it cannot help satisfy this rule. It does ` +
          `NOT have to be removed: once your other renderers meet the floor on ` +
          `their own, it is simply an extra sink. To have it counted, add its ` +
          `mapping to PLATFORM_CLASS_BY_KIND (src/renderers/coverage.ts).`
        : "";
    super(
      `cortex: renderer coverage check FAILED (config). ${RULE_PREAMBLE}\n` +
        `Configured system-covering kinds: ${found} (effective: ${effective}).\n` +
        `Platform class(es) present: ${classes}.\n` +
        `${diagnosis}${unclassifiedNote}\n` +
        `Add a system-covering renderer whose class CANNOT overlap the ones you ` +
        `have (e.g. a \`pagerduty\` renderer — class \`paging\` — subscribed to ` +
        `\`local.{principal}.system.>\`). Decision: ADR-0024 §OQ9.`,
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
  if (verdict.satisfied) return;
  // ONE error, carrying both facts. An earlier cut raised a separate
  // "unclassified kind" error and preferred it whenever any unclassified kind
  // was present — which MASKED the real failure (a same-class classified pair)
  // and told the principal they could not fix it by adding a renderer. Both
  // are false: adding a disjoint classified pair fixes either case, since an
  // unclassified kind stops mattering once coverage holds without it.
  throw new RendererCoverageConfigError(verdict);
}

/**
 * cortex#2504 — would a runtime mutation drop `system.>` coverage below the
 * floor? Returns `null` when the prospective set is fine, or a refusal string
 * naming what would break.
 *
 * ## Why a runtime check exists at all
 *
 * The boot guards answer "is this stack covered *right now*". ADR-0024 D8 then
 * made renderers hot-reloadable, so a live stack can drop below the floor
 * without ever restarting: detach the only `paging` renderer and what remains
 * is an inert `local-projection` that delivers nothing. The stack keeps
 * running, reports healthy, and silently cannot page — which is exactly the
 * *silent no-page* failure §OQ9 ratified moving away from, re-entering through
 * the reload door instead of the boot door.
 *
 * The invariant otherwise holds only until the next mutation and is repaired
 * only by a restart.
 *
 * ## Refuse the mutation, do not fail the process
 *
 * Boot's answer to a shortfall is to hard-fail, because there is no prior good
 * state to keep. At runtime there is: the configuration currently serving the
 * principal. So the mutation is REJECTED and the live set is left untouched —
 * killing a running daemon because someone typo'd an unload would replace a
 * monitoring gap with an outage.
 */
export function refuseIfMutationBreaksCoverage(
  current: readonly RendererCoverageInput[],
  prospective: readonly RendererCoverageInput[],
  ctx: { principal: string; stack?: string },
): string | null {
  // BEFORE/AFTER, not after-alone. `evaluateSystemCoverage` reports
  // `satisfied: true` for an out-of-scope stack (no system-covering renderer
  // at all), which is right at boot — a stack that never opted into system
  // alerting is not in breach. Judging only the prospective set therefore
  // ALLOWED the worst mutation of all: detaching the LAST covering renderer
  // empties the set, reads as out-of-scope, and passes. Total loss of paging
  // permitted while partial loss was refused — the exact inversion of the
  // rule. A stack that WAS in scope must stay in scope.
  const before = evaluateSystemCoverage(current, ctx);
  if (!before.inScope) return null; // never opted in; nothing to erode.

  const verdict = evaluateSystemCoverage(prospective, ctx);
  if (!verdict.inScope) {
    return (
      `refused — this would remove the LAST renderer covering ` +
      `\`local.{principal}.system.>\`, leaving the stack with no system sink at ` +
      `all. It would then read as "never opted into system alerting" rather than ` +
      `"broken", which is how a silent loss of paging looks healthy. The live ` +
      `configuration is unchanged. Attach a replacement sink FIRST, then retry.`
    );
  }
  if (verdict.satisfied) return null;
  const classes =
    verdict.coveringClasses.length > 0 ? `[${verdict.coveringClasses.join(", ")}]` : "[none]";
  return (
    `refused — this would drop \`local.{principal}.system.>\` coverage below the ` +
    `ADR-0024 §OQ9 floor. Remaining system-covering kinds would be ` +
    `[${verdict.coveringKinds.join(", ") || "none"}], resolving to platform ` +
    `class(es) ${classes} with effective sink(s) ` +
    `[${verdict.effectiveCoveringKinds.join(", ") || "none"}]. The stack would keep ` +
    `running while silently unable to page. The live configuration is unchanged. ` +
    `Attach a replacement sink from a non-overlapping class FIRST, then retry.`
  );
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
