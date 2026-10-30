import { rangerItemKey, type RangerMap, type RangerMapNode, type RangerNeedsYou, type RangerState } from "./sources/ranger";
import { DAY_MS } from "./time";

/** The Desk actions that write to Ranger. */
export const RANGER_ACTIONS = ["ranger.approve", "ranger.retry"] as const;
export type RangerActionId = (typeof RANGER_ACTIONS)[number];

export const isRangerAction = (id: unknown): id is RangerActionId => RANGER_ACTIONS.includes(id as RangerActionId);

/** Where the Ranger CLI lives. An empty `bin` turns Ranger actions off. */
export interface RangerCli {
  bin: string;
  config: string;
}

export interface RangerRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RangerRunner = (argv: string[]) => Promise<RangerRunResult>;

export interface PlannedAction {
  argv: string[];
  claimKey: string;
  handledKey: string | null;
  done: string;
}

const NODE_ID = /^[1-9]\d*$/;
const MAP_KEY = /^[\w.-]+(?:\/[\w.-]+)+#[1-9]\d*$/;

export const approvable = (map: RangerMap, node: RangerMapNode): boolean =>
  node.approvable === true && typeof node.approvalVersion === "string" && node.approvalVersion !== "" && map.walk === "full" && map.servedOnly !== true;

export const retryable = (n: RangerNeedsYou): boolean => n.actions?.resume === true;

export const approveKey = (map: RangerMap, node: RangerMapNode): string => `approve:${map.key}/${node.id}@${node.approvalVersion ?? ""}`;
export const retryKey = (n: RangerNeedsYou): string | null => (n.endedAt ? `retry:${n.key}/${n.nodeId}@${n.endedAt}` : null);

const config = (cli: RangerCli): string[] => (cli.config ? ["-c", cli.config] : []);

/**
 * Turns a Desk item key into the Ranger CLI call that acts on it, from a fresh read of Ranger's state.
 * Every argument comes from that read, never from the page. Returns a one-line refusal when the item
 * is no longer actionable.
 */
export function planRangerAction(state: RangerState, action: RangerActionId, itemKey: string, cli: RangerCli): PlannedAction | string {
  if (action === "ranger.approve") {
    for (const map of state.maps) {
      const node = map.decisions?.find((d) => rangerItemKey(`${map.repo}#${d.id}`) === itemKey);
      if (!node) continue;
      if (!approvable(map, node) || !NODE_ID.test(node.id) || !MAP_KEY.test(map.key)) return "Ranger does not take an approval for this node.";
      return {
        argv: [cli.bin, "approve-node", node.id, "--map", map.key, "--approval-version", node.approvalVersion ?? "", ...config(cli)],
        claimKey: approveKey(map, node),
        handledKey: approveKey(map, node),
        done: `Approved "${node.title}". Ranger will start it.`,
      };
    }
    return "Ranger no longer waits for an approval on this node.";
  }
  const entry = state.needsYou.find((n) => rangerItemKey(`${n.repo}#${n.nodeId}`) === itemKey);
  if (!entry) return "Ranger no longer lists this node as stopped.";
  if (!retryable(entry) || !NODE_ID.test(entry.nodeId) || !MAP_KEY.test(entry.key)) return "Ranger does not offer a retry for this node.";
  return {
    argv: [cli.bin, "resume-node", entry.nodeId, "--map", entry.key, ...config(cli)],
    claimKey: `retry:${entry.key}/${entry.nodeId}`,
    handledKey: retryKey(entry),
    done: `Ranger is retrying "${entry.title}".`,
  };
}

/**
 * Ranger actions the Desk has sent, keyed by the node's version (approval) or stop time (retry).
 * A key here hides the item until Ranger's own state moves on, and refuses a second send of the same action.
 */
export class HandledLedger {
  private readonly handled = new Map<string, number>();
  private readonly running = new Set<string>();

  has(key: string): boolean {
    return this.handled.has(key);
  }

  add(key: string, now: number): void {
    for (const [k, at] of this.handled) if (now - at > DAY_MS) this.handled.delete(k);
    this.handled.set(key, now);
  }

  claim(key: string): boolean {
    if (this.running.has(key)) return false;
    this.running.add(key);
    return true;
  }

  release(key: string): void {
    this.running.delete(key);
  }
}

/**
 * Ranger's state without the nodes the Desk has already acted on, and those nodes' item keys,
 * so no other source brings them back while Ranger catches up.
 */
export function withoutHandled(state: RangerState, ledger: HandledLedger): { state: RangerState; hidden: Set<string> } {
  const hidden = new Set<string>();
  const keep = (handled: boolean, ref: string): boolean => {
    if (handled) hidden.add(rangerItemKey(ref));
    return !handled;
  };
  return {
    state: {
      ...state,
      needsYou: state.needsYou.filter((n) => {
        const key = retryKey(n);
        return keep(key !== null && ledger.has(key), `${n.repo}#${n.nodeId}`);
      }),
      maps: state.maps.map((m) => ({ ...m, decisions: m.decisions?.filter((d) => keep(ledger.has(approveKey(m, d)), `${m.repo}#${d.id}`)) })),
    },
    hidden,
  };
}

const ENV_KEEP = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL"];

/** Runs the Ranger CLI with a minimal environment, so no token in Cortex's environment reaches it. */
export const spawnRanger: RangerRunner = async (argv) => {
  const env: Record<string, string> = {};
  for (const k of ENV_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  const proc = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

/** The last non-empty line of a CLI's error output, trimmed for a one-line note. */
export function oneLine(text: string, fallback: string): string {
  const line = text.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop();
  if (!line) return fallback;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
