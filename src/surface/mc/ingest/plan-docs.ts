/**
 * G-1113.D.2 — Plan ingestion from repo-local plan docs.
 *
 * Parses `docs/plan-*.md` / `docs/iteration-*.md` into {@link Plan} + ordered
 * {@link PlanPhase} skeletons (design §6, plan §5.4). Deterministic + pure:
 * `parsePlanDoc` takes markdown in and yields rows out; `ingestPlanDoc`
 * persists them in a transaction via the D.1 storage layer.
 *
 * Scope boundary (honest, no-overclaim): we ingest the *skeleton* — title,
 * kind, sourceDocumentUrl, ordered phases. We do NOT infer phase progress
 * from the doc's checkboxes: those go stale (the cockpit plan still shows
 * Phase A `- [ ]` after A merged), so trusting them would assert false
 * progress. Phase status defaults to `not_started`; the real per-phase
 * rollup is computed downstream (D.3+) from the Phase-C work-item model.
 * The one non-stale signal we honour is the author-written `**Status:**`
 * line, used for the plan's own status.
 */
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import { basename, join } from "path";
import type { Plan, PlanKind, PlanPhase, PlanStatus, Provider } from "../types";
import { upsertPlan, upsertPlanPhase } from "../db/plans";

export interface PlanDocSource {
  /** Markdown body of the doc. */
  content: string;
  /**
   * Repo-relative path, e.g. `docs/plan-mission-control-cockpit.md`. Drives the
   * deterministic plan id (basename without extension) and the kind heuristic.
   */
  path: string;
  /** Canonical URL to the doc (e.g. a GitHub blob URL), when known. */
  sourceDocumentUrl?: string | null;
  /** Provider the plan is sourced from. Defaults to `internal` (a repo-local doc). */
  provider?: Provider;
}

export interface ParsedPlanDoc {
  plan: Plan;
  phases: PlanPhase[];
}

/**
 * Phase heading shapes handled across the real `docs/plan-*` / `docs/iteration-*`
 * corpus (H2–H6 ATX):
 *   `### 5.4 Phase D — Plan Lineage UI (G-1113.D)`     (cockpit: numbered, id suffix)
 *   `## 2. Phase A — Foundation (substrate harness …)`  (IoAW: numbered, descriptive paren)
 *   `## Phase A — Data foundation + local bot scaffold` (iteration: bare, em-dash)
 *   `## Phase 2A: License Foundation`                   (iteration: colon separator)
 * The optional numeric prefix (`5.4 `, `2. `) is skipped; the label (`D`, `2A`)
 * is captured non-greedily up to the first em/en-dash, hyphen, OR colon. A
 * separator is required, so subsection headings with words between the label and
 * a later dash (`### Phase A acceptance criteria — ✅ all met`) do NOT match.
 */
const PHASE_RE = /^#{2,6}\s+(?:[\d.]+\.?\s+)?Phase\s+(\S+?)\s*[—–:-]\s*(.+?)\s*$/;
/** First ATX H1 — the plan title. */
const H1_RE = /^#\s+(.+?)\s*$/;
/** Author-written status line, e.g. `**Status:** draft for review`. */
const STATUS_RE = /^\*\*Status:\*\*\s*(.+)$/im;
/**
 * Trailing parenthetical to strip from a phase title — ONLY when it's a compact
 * id token (a feature/issue id like `(G-1113.D)` or `(#42)`): no spaces, and at
 * least one digit. Descriptive parens that are part of the human title
 * (`(substrate harness + visibility consumption)`, `(NKey-signed bot↔bot)`,
 * `(Future)`) contain spaces and/or no digit, so they're preserved.
 */
const TRAILING_PAREN_RE = /\s*\((?=[\w.#-]*\d)[\w.#-]+\)\s*$/;

/** Slug used as the plan id — the doc basename without its `.md` extension. */
function planIdFromPath(path: string): string {
  return basename(path).replace(/\.md$/i, "");
}

/** Infer {@link PlanKind} from the filename + title. Generic plans default to `design`. */
function inferKind(path: string, title: string): PlanKind {
  const name = basename(path).toLowerCase();
  if (name.startsWith("iteration-")) return "iteration";
  const hay = `${name} ${title.toLowerCase()}`;
  if (/\bmigration\b/.test(hay)) return "migration";
  if (/\brollout\b/.test(hay)) return "rollout";
  if (/\brelease\b/.test(hay)) return "release";
  if (/\bincident\b|\bpost-?mortem\b/.test(hay)) return "incident";
  if (/\bresearch\b/.test(hay)) return "research";
  return "design";
}

/** Map the author-written `**Status:**` line to {@link PlanStatus}; absent → `active`. */
function inferStatus(content: string): PlanStatus {
  const raw = STATUS_RE.exec(content)?.[1];
  if (raw !== undefined) {
    // Match keywords against the LEADING CLAUSE only. Status lines often run on
    // into narrative prose (`Active campaign. … ~75% done already`) that would
    // poison a whole-line scan — the "done" in the narrative must not beat the
    // leading "Active". Word boundaries keep `closed` out of `disclosed` etc.
    const head = (raw.split(/[.,;:—–]/)[0] ?? "").toLowerCase().trim();
    if (/\bcancel(?:l?ed)?\b/.test(head)) return "cancelled";
    if (/\b(?:done|complete|completed|shipped|closed|merged)\b/.test(head)) return "done";
    if (/\bblock(?:ed)?\b/.test(head)) return "blocked";
    if (/\b(?:draft|proposed|review|planned|backlog)\b/.test(head)) return "draft";
    if (/\b(?:active|progress|in[- ]flight|current)\b/.test(head)) return "active";
  }
  // A plan doc that exists and isn't marked otherwise is treated as active work.
  return "active";
}

function extractTitle(content: string, fallback: string): string {
  for (const line of content.split("\n")) {
    const title = H1_RE.exec(line)?.[1];
    if (title !== undefined) return title.trim();
  }
  return fallback;
}

/** Parse a plan/iteration markdown doc into a {@link Plan} + ordered phases. Pure. */
export function parsePlanDoc(src: PlanDocSource): ParsedPlanDoc {
  const id = planIdFromPath(src.path);
  const title = extractTitle(src.content, id);
  const plan: Plan = {
    id,
    title,
    kind: inferKind(src.path, title),
    sourceDocumentUrl: src.sourceDocumentUrl ?? null,
    provider: src.provider ?? "internal",
    externalId: null,
    umbrellaWorkItemId: null,
    status: inferStatus(src.content),
  };

  const phases: PlanPhase[] = [];
  const lines = src.content.split("\n");
  let order = 0;
  for (const line of lines) {
    const m = PHASE_RE.exec(line);
    const label = m?.[1];
    const rawTitle = m?.[2];
    if (label === undefined || rawTitle === undefined) continue;
    const phaseTitle = rawTitle.replace(TRAILING_PAREN_RE, "").trim();
    // Phase id is derived from the label; real plan docs use unique labels
    // (A/B/C…). If a doc ever repeated a label, parsePlanDoc still yields both
    // rows (distinct order), but ingestPlanDoc's upsert would collapse them onto
    // one row by id (last writer wins) — acceptable given the corpus, noted here.
    phases.push({
      id: `${id}-phase-${label.toLowerCase()}`,
      planId: id,
      title: phaseTitle,
      order: order++,
      // Honest default — real per-phase progress is rolled up downstream (D.3+)
      // from the work-item model, not inferred from (stale) doc checkboxes.
      status: "not_started",
    });
  }

  return { plan, phases };
}

/** Parse + persist a single plan doc (plan + phases) in one transaction. Idempotent by id. */
export function ingestPlanDoc(db: Database, src: PlanDocSource): ParsedPlanDoc {
  const parsed = parsePlanDoc(src);
  const persist = db.transaction(() => {
    upsertPlan(db, parsed.plan);
    for (const phase of parsed.phases) upsertPlanPhase(db, phase);
  });
  persist();
  return parsed;
}

/** Matches the in-scope doc families: `plan-*.md` and `iteration-*.md`. */
const PLAN_DOC_FILE_RE = /^(plan|iteration)-.*\.md$/i;

export interface IngestDirOptions {
  /** Absolute path to the directory holding the plan/iteration docs (e.g. `<repo>/docs`). */
  docsDir: string;
  /** Repo-relative prefix recorded in each plan's `path`. Default `"docs"`. */
  repoRelDir?: string;
  /** Build a `sourceDocumentUrl` from a repo-relative path; return null when unknown. */
  urlForPath?: (repoRelPath: string) => string | null;
}

/**
 * Ingest every `plan-*.md` / `iteration-*.md` under {@link IngestDirOptions.docsDir}.
 * Thin I/O wrapper around {@link ingestPlanDoc}; sorted for deterministic order.
 */
export function ingestPlanDocsFromDir(db: Database, opts: IngestDirOptions): ParsedPlanDoc[] {
  const repoRelDir = opts.repoRelDir ?? "docs";
  const files = readdirSync(opts.docsDir)
    .filter((f) => PLAN_DOC_FILE_RE.test(f))
    .sort();
  const out: ParsedPlanDoc[] = [];
  for (const f of files) {
    const content = readFileSync(join(opts.docsDir, f), "utf8");
    const repoRel = `${repoRelDir}/${f}`;
    out.push(
      ingestPlanDoc(db, {
        content,
        path: repoRel,
        sourceDocumentUrl: opts.urlForPath?.(repoRel) ?? null,
      })
    );
  }
  return out;
}
