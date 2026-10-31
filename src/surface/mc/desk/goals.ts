import { runCommand } from "./spawn";

export const GOAL_ACTIONS = ["goal.check", "goal.pause"] as const;
export type GoalActionId = (typeof GOAL_ACTIONS)[number];

export const isGoalAction = (id: unknown): id is GoalActionId => GOAL_ACTIONS.includes(id as GoalActionId);

export const SOMA_GOAL_ID = /^G[1-9]\d*$/;

export interface GoalCheck {
  command: string[];
  env: Record<string, string>;
  timeoutSeconds: number;
}

export interface DeskGoalOptions {
  check: Record<string, GoalCheck>;
  somaBin: string;
}

export interface GoalRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GoalRunner = (argv: string[], env: Record<string, string>, timeoutMs: number) => Promise<GoalRunResult>;

export const spawnGoalCommand: GoalRunner = async (argv, env, timeoutMs) => {
  const { code, stdout, stderr } = await runCommand(argv, timeoutMs, undefined, { ...process.env, ...env });
  return { code, stdout, stderr };
};

export const goalCheckFor = (goals: DeskGoalOptions | undefined, goal: string): GoalCheck | undefined =>
  goals && Object.hasOwn(goals.check, goal) ? goals.check[goal] : undefined;

export const CHECK_PENDING_MS = 5 * 60_000;

/**
 * Goal checks the Desk has started and whose new reading Vigil has not reported yet.
 * A goal's check counts as running until a reading newer than its start arrives, or for five minutes at most.
 */
export class GoalChecks {
  private readonly started = new Map<string, number>();

  pending(goal: string, now: number): boolean {
    const at = this.started.get(goal);
    if (at === undefined) return false;
    if (now - at <= CHECK_PENDING_MS) return true;
    this.started.delete(goal);
    return false;
  }

  start(goal: string, now: number): boolean {
    if (this.pending(goal, now)) return false;
    this.started.set(goal, now);
    return true;
  }

  settle(goal: string, readingAt: number): void {
    const at = this.started.get(goal);
    if (at !== undefined && readingAt > at) this.started.delete(goal);
  }

  cancel(goal: string): void {
    this.started.delete(goal);
  }
}

const STATUS_LINE = /^(G[1-9]\d*)\t([a-z]+)\t/;
export const GOAL_STATUS_TTL_MS = 60_000;

export function parseGoalList(stdout: string): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const m = STATUS_LINE.exec(line);
    if (m?.[1] && m[2]) statuses.set(m[1], m[2]);
  }
  return statuses;
}

/**
 * Each goal's status from `soma goal list`, read at most once a minute. The last reading is served while
 * the next one runs; a failed read keeps the last one. A status the Desk set itself wins over a read
 * that started before it.
 */
export class GoalStatuses {
  private known = new Map<string, string>();
  private readAt = Number.NEGATIVE_INFINITY;
  private running: Promise<void> | null = null;
  private generation = 0;

  constructor(private readonly run: GoalRunner = spawnGoalCommand) {}

  async read(somaBin: string, now: number): Promise<ReadonlyMap<string, string>> {
    if (!somaBin) return new Map();
    if (now - this.readAt < GOAL_STATUS_TTL_MS) return this.known;
    const first = this.readAt === Number.NEGATIVE_INFINITY;
    this.running ??= this.refresh(somaBin, now);
    if (first) await this.running;
    return this.known;
  }

  mark(goal: string, status: string): void {
    this.generation += 1;
    this.known = new Map(this.known).set(goal, status);
  }

  private async refresh(somaBin: string, now: number): Promise<void> {
    const generation = this.generation;
    const result = await this.run([somaBin, "goal", "list"], {}, 10_000).catch(() => null);
    if (result?.code === 0 && generation === this.generation) this.known = parseGoalList(result.stdout);
    this.readAt = now;
    this.running = null;
  }
}

/** Hides a goal's items while Soma lists the goal as anything but active. A goal Soma does not list stays. */
export const goalListed = (statuses: ReadonlyMap<string, string>, goal: string | undefined): boolean => {
  if (goal === undefined) return true;
  const status = statuses.get(goal);
  return status === undefined || status === "active";
};
