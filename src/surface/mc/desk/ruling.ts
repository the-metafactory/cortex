import { rangerItemKey, type RangerNeedsYou, type RangerState } from "./sources/ranger";
import { retryable } from "./actions";
import { DAY_MS } from "./time";

export const RULING_ACTION = "ranger.rule";

export const MAX_RULING_LENGTH = 4000;

export interface AgentQuestion {
  condition: string | null;
  reason: string;
}

const RESUME_ONCE = /^resume once: ([\s\S]*?) — ([\s\S]*)$/;

/** Splits Ranger's blocked detail ("resume once: <condition> — <reason>") into the agent's question. */
export function agentQuestion(detail: string | undefined): AgentQuestion | null {
  const text = detail?.trim();
  if (!text) return null;
  const m = RESUME_ONCE.exec(text);
  if (!m) return { condition: null, reason: text };
  return { condition: (m[1] ?? "").trim().replace(/,$/, "") || null, reason: (m[2] ?? "").trim() };
}

export const isBlocked = (n: RangerNeedsYou): boolean => n.reason?.class === "blocked";

export const needsYouEntry = (state: RangerState, itemKey: string): RangerNeedsYou | undefined =>
  state.needsYou.find((n) => rangerItemKey(`${n.repo}#${n.nodeId}`) === itemKey);

/** The blocked Ranger entry a Desk item key names, or a one-line refusal. */
export function blockedEntry(state: RangerState, itemKey: string): RangerNeedsYou | string {
  const entry = needsYouEntry(state, itemKey);
  if (!entry) return "Ranger no longer lists this node as waiting for you.";
  if (!isBlocked(entry)) return "Ranger no longer waits for a ruling on this node.";
  if (!retryable(entry)) return "Ranger does not offer a resume for this node.";
  return entry;
}

const NODE_ID = /^[1-9]\d*$/;
const BARE_REPO = /^[\w.-]+\/[\w.-]+$/;
const QUALIFIED_REPO = /^[a-z]+:[\w.-]+(?:\/[\w.-]+)+$/;

/** Soma's `--repo` form for a Ranger repo: `owner/name` is a GitHub repo; a qualified ref passes as is. */
export function somaRepo(repo: string): string | null {
  if (BARE_REPO.test(repo)) return `github:github.com/${repo}`;
  if (QUALIFIED_REPO.test(repo)) return repo;
  return null;
}

/** `soma graph rule` with the ruling in a file, so no part of the ruling becomes an argument; a refusal when Soma cannot address the node. */
export function ruleCommand(somaBin: string, entry: RangerNeedsYou): ((textFile: string) => string[]) | string {
  const repo = somaRepo(entry.repo);
  if (!repo || !NODE_ID.test(entry.nodeId)) return "Soma cannot address this node.";
  return (textFile) => [somaBin, "graph", "rule", entry.nodeId, "--text-file", textFile, "--repo", repo, "--json"];
}

/**
 * Rulings the Desk has recorded, by request id, so a second Confirm of the same ruling only retries the
 * resume. A request id in flight is refused, so two Confirms at the same time record once.
 */
export class RulingLedger {
  private readonly recorded = new Map<string, { itemKey: string; at: number }>();
  private readonly running = new Set<string>();

  recordedFor(requestId: string, itemKey: string): boolean {
    return this.recorded.get(requestId)?.itemKey === itemKey;
  }

  add(requestId: string, itemKey: string, now: number): void {
    for (const [k, v] of this.recorded) if (now - v.at > DAY_MS) this.recorded.delete(k);
    this.recorded.set(requestId, { itemKey, at: now });
  }

  claim(requestId: string): boolean {
    if (this.running.has(requestId)) return false;
    this.running.add(requestId);
    return true;
  }

  release(requestId: string): void {
    this.running.delete(requestId);
  }
}
