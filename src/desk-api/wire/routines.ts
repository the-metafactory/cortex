import type { DeskProposal } from "./ask";

interface RoutineRequest<A> { requestId: string; action: A; target: string }

export type RoutineAction =
  | RoutineRequest<"install" | "discard" | "remove" | "auto" | "stop" | "approve" | "deny">
  | (RoutineRequest<"schedule"> & { schedule: string; timezone: string | null; revision: string; proposedRevision: string })
  | (RoutineRequest<"pause" | "resume"> & { revision: string; proposedRevision: string })
  | (RoutineRequest<"delete"> & { revision: string });

interface CapabilityStep {
  label: string;
  prompt: string;
  sovereignty: { model_class?: "local-only" | "frontier" | "any"; frontier_ok?: boolean; data_residency?: string };
}

export interface MissingCapability {
  capability: string;
  steps: CapabilityStep[];
}

export interface CapabilityRefusal {
  proposalId: string;
  missing: MissingCapability[];
  offer: boolean;
  nodes: Record<string, { ref: string; url: string; existing: boolean; notStarted?: string }>;
}

export interface InstalledRoutine {
  id: string;
  schedule: string;
  timezone: string | null;
  policy: "approval" | "auto" | "disabled";
  paused: boolean;
  runtimeConfirmed: boolean;
  target: string;
  file: string;
  lastDecision: { id: string; outcome: string; at: string; reason: string | null } | null;
}

export interface PendingRoutine {
  decisionId: string;
  blueprintId: string;
  matchedAt: string;
  expiresAt: string;
  impulseSummary: string;
}

export const BUILD_STATES = ["filed", "building", "in-review", "merged", "failed"] as const;

export type BuildState =
  | { state: (typeof BUILD_STATES)[number] | "live"; reason?: string; pr?: string }
  | { state: "unknown"; error: string };

export interface CapabilityInstallView { id: string; bundle: string; state: "running" | "installed" | "failed" | "undoing" | "undone"; error: string | null; at: number }

export interface DraftNodeView { capability: string; ref: string; url: string; notStarted?: string; build: BuildState | null; install?: CapabilityInstallView; canInstall?: boolean; presenceLate?: boolean }

export interface RoutineDraftView { proposalId: string; title: string; nodes: DraftNodeView[]; missing: MissingCapability[]; proposal?: DeskProposal; error?: string }

export interface RoutineView {
  installed: (InstalledRoutine & { title: string; words: string })[];
  pending: PendingRoutine[];
  done: { routineId: string; title: string; decisionId: string; at: string }[];
  changes: RoutineAction[];
  drafts?: RoutineDraftView[];
  capabilityInstalls?: CapabilityInstallView[];
  error?: string;
}

export type RoutineDisplayMode = "scheduled" | "background";

export type RoutineDisplayChoice = "automatic" | RoutineDisplayMode;

export type RoutineDisplaySource = "stored" | "frequency" | "unknown";

/** How one routine shows on the calendar: the stored choice, the mode its frequency suggests, and the effective mode with where it came from. */
export interface RoutineDisplayEntry {
  routineId: string;
  stored: RoutineDisplayMode | null;
  automatic: RoutineDisplayMode | null;
  maxDailyStarts: number | null;
  mode: RoutineDisplayMode;
  source: RoutineDisplaySource;
}

/** The body of a routine display change that succeeded. `entry` is the effective display afterwards. */
export interface RoutineDisplayResult {
  owner: "reflex";
  principal: string;
  stack: string;
  routineId: string;
  mode: RoutineDisplayChoice;
  entry: RoutineDisplayEntry;
}
