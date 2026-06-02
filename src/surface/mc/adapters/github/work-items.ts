/**
 * G-1113.D.5b — GitHub WorkItemSource: the FIRST adapter against the
 * provider-neutral {@link WorkItemSource} contract (adapters/work-item-source.ts).
 *
 * A plan's work items are the sub-issues of its umbrella issue. This adapter
 * reads the umbrella ref off `plan.umbrellaWorkItemId` (canonical `owner/repo#N`),
 * fetches the sub-issues via the GitHub adapter's `fetchSubIssues`, and
 * normalizes each into a provider-neutral {@link WorkItem}. All GitHub specifics
 * — the `gh` CLI, the `owner/repo#N` shape, the `G-1113.<PHASE>.<n>` slice-id
 * convention used to map a sub-issue to a phase — stay behind this boundary.
 *
 * Honest no-op: if the plan carries no umbrella link (doc-ingested plans from
 * D.2 have `umbrellaWorkItemId === null`), or the link doesn't parse, the source
 * returns `[]` — it never guesses. Wiring the umbrella link onto a plan is a
 * separate concern (a D.2 enhancement or principal action).
 */
import type { Plan, PlanPhase, Provider, WorkItem } from "../../types";
import type { WorkItemSource, WorkItemSourceContext } from "../work-item-source";
import { parseGitHubRef, isParseError } from "./ref";
import { fetchSubIssues, type GhSpawnFn, type GitHubSubIssue } from "./fetch";

export interface GithubWorkItemSourceOptions {
  /** Injected `gh` spawn for tests; defaults to the real CLI inside fetchSubIssues. */
  spawn?: GhSpawnFn;
  timeoutMs?: number;
}

/**
 * Map a sub-issue to one of the plan's phases via the phase label embedded in
 * the slice-id convention (`G-1113.<PHASE>.<n>` → phase label `<PHASE>`). The
 * labels come from the plan's OWN phases (`{planId}-phase-{label}`, set by D.2),
 * so this isn't hardcoded to one plan — it matches whatever labels the plan has.
 *
 * Matching is deliberately STRICT to avoid mis-filing: phase labels are often
 * single letters (a–e), so a loose token match would mis-attribute incidental
 * letters in prose (label `c` ⊂ "fix the c compiler"). We accept only:
 *   - the dotted slice-id form `<…>.<LABEL>.<n>` (or `<LABEL>.<n>` at the start), and
 *   - the explicit prose form `Phase <LABEL>` (the word "phase" must precede).
 * If MORE THAN ONE phase label matches, the title is ambiguous → returns null
 * (work item stays unphased — honest rather than guessing). Returns null when no
 * label matches.
 */
function mapPhaseId(title: string, phases: PlanPhase[], planId: string): string | null {
  const prefix = `${planId}-phase-`;
  let found: string | null = null;
  let count = 0;
  for (const ph of phases) {
    if (!ph.id.startsWith(prefix)) continue;
    const label = ph.id.slice(prefix.length);
    if (!label) continue;
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Slice-id form: label dot-bounded (or at string start) + a numeric slice
    // index — `.D.4` / leading `D.4`. Prose form: the word "phase" then the label.
    const sliceForm = new RegExp(`(?:^|\\.)${esc}\\.\\d`, "i");
    const proseForm = new RegExp(`\\bphase\\s+${esc}\\b`, "i");
    if (sliceForm.test(title) || proseForm.test(title)) {
      found = ph.id;
      count += 1;
    }
  }
  // Exactly one phase label matched → file under it; zero or ambiguous → null.
  return count === 1 ? found : null;
}

function subIssueToWorkItem(
  sub: GitHubSubIssue,
  plan: Plan,
  phases: PlanPhase[],
  owner: string,
  repo: string
): WorkItem {
  const externalId = `${owner}/${repo}#${sub.number}`;
  return {
    // id == externalId: a stable owner/repo#N bijection (matches the PR adapter
    // convention) so re-ingestion is idempotent.
    id: externalId,
    planId: plan.id,
    phaseId: mapPhaseId(sub.title, phases, plan.id),
    parentId: null,
    title: sub.title,
    description: null,
    // WorkItem.status is an open string (§6) — GitHub's open/closed verbatim.
    status: sub.state,
    priority: "",
    provider: "github",
    externalId,
    url: sub.html_url,
  };
}

/** GitHub implementation of the provider-neutral {@link WorkItemSource}. */
export class GithubWorkItemSource implements WorkItemSource {
  readonly provider: Provider = "github";

  constructor(private readonly opts: GithubWorkItemSourceOptions = {}) {}

  async fetchWorkItems(ctx: WorkItemSourceContext): Promise<WorkItem[]> {
    const { plan, phases } = ctx;
    if (plan.umbrellaWorkItemId === null) return []; // no umbrella link → nothing to ingest
    const ref = parseGitHubRef(plan.umbrellaWorkItemId);
    if (isParseError(ref)) return []; // unparseable link → honest no-op (never guess)

    const subs = await fetchSubIssues(
      { owner: ref.owner, repo: ref.repo, number: ref.number },
      { spawn: this.opts.spawn, timeoutMs: this.opts.timeoutMs }
    );
    if (!Array.isArray(subs)) {
      // fetchSubIssues returns an array on success, a GitHubFetchError otherwise.
      // Surface the failure to stderr rather than silently swallowing (CLAUDE.md:
      // no empty catches). Ingestion is best-effort — an empty result lets the
      // orchestrator persist nothing this run.
      process.stderr.write(
        `[github-work-items] fetchSubIssues failed for ${plan.umbrellaWorkItemId}: ${subs.kind} — ${subs.message}\n`
      );
      return [];
    }

    return subs.map((sub) => subIssueToWorkItem(sub, plan, phases, ref.owner, ref.repo));
  }
}
