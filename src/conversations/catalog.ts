export const CREATABLE_TYPES = [
  "graph-node", "graph-map", "balance-task", "balance-project", "balance-inbox-task", "studio-thread", "studio-capture", "studio-note", "studio-response", "studio-close",
  "flow", "routine", "calendar-event", "reminder", "soma-goal", "tana-note", "desk-note", "mail-draft",
] as const;
export type CreatableType = (typeof CREATABLE_TYPES)[number];

export const usesBalanceDestinationPicker = (type: CreatableType | null): boolean => type === "balance-task" || type === "balance-project";
export const hasBalanceLink = (type: CreatableType | null): boolean => usesBalanceDestinationPicker(type) || type === "balance-inbox-task";

export type Egress = "local" | "cloud";
export interface FieldSpec {
  name: string;
  label: string;
  kind: "text" | "long" | "list" | "date" | "datetime";
  required: boolean;
  destination?: boolean;
  options?: readonly string[];
}
export interface FixedTerm { label: string; value: string }
export interface CreatableSpec {
  row: string;
  label: string;
  owner: string;
  egress: Egress;
  fields: FieldSpec[];
  fixed?: FixedTerm[];
}
export interface UnavailableSpec { type: string; row: string; label: string; owner: string; reason: string }

const text = (name: string, label: string, required = true, destination = false): FieldSpec => ({ name, label, kind: "text", required, ...(destination ? { destination } : {}) });
export const GRAPH_AUTONOMIES = ["approve", "propose"] as const;
export const GRAPH_KINDS = ["grilling", "research", "prototype", "task", "build"] as const;
const choice = (name: string, label: string, options: readonly string[]): FieldSpec => ({ name, label, kind: "text", required: false, options });
const graphAutonomy = choice("autonomy", "Autonomy (approve or propose; empty uses approve)", GRAPH_AUTONOMIES);
const long = (name: string, label: string, required = false): FieldSpec => ({ name, label, kind: "long", required });
export const OWNER_BLOCKERS: Record<CreatableType, number> = {
  "graph-node": 3033, "graph-map": 3034,
  "balance-task": 3030, "balance-project": 3031, "balance-inbox-task": 3032,
  "studio-thread": 3141, "studio-capture": 3142, "studio-note": 3140, "studio-response": 3138, "studio-close": 3139,
  flow: 3146, routine: 3035, "calendar-event": 3036, reminder: 3037, "soma-goal": 3038, "tana-note": 3039, "desk-note": 3040, "mail-draft": 3041,
};

export const CREATION_CATALOG: Record<CreatableType, CreatableSpec> = {
  "graph-node": { row: "O01", label: "Graph node", owner: "Soma work graph", egress: "cloud", fields: [
    text("repository", "Repository", true, true), text("parent", "Parent node", true, true), text("title", "Title"), long("body", "Body"), text("checkpoint", "Checkpoint"),
    { name: "dependencies", label: "Blocked by", kind: "list", required: false },
    graphAutonomy, choice("kind", "Kind (research, grilling, prototype, task or build; empty uses grilling)", GRAPH_KINDS),
  ], fixed: [{ label: "Claim and close", value: "Not done here; the node is only filed." }] },
  "graph-map": { row: "O02", label: "Graph map", owner: "Soma work graph", egress: "cloud", fields: [
    text("repository", "Repository", true, true), text("title", "Title"), long("body", "Destination and constraints", true), text("checkpoint", "Checkpoint"),
    graphAutonomy, text("serves", "Serves goal (G<n>, optional)", false),
  ] },
  "balance-task": { row: "O04", label: "Balance task", owner: "Balance", egress: "local", fields: [
    text("area", "Area", true, true), text("project", "Parent project", false, true), text("title", "Title"), long("note", "Note"), { name: "due", label: "Due", kind: "date", required: false },
  ] },
  "balance-project": { row: "O05", label: "Balance project", owner: "Balance", egress: "local", fields: [
    text("area", "Area", true, true), text("title", "Title"), long("note", "Note"),
  ] },
  "balance-inbox-task": { row: "O06", label: "Inbox task from a Day item", owner: "Balance", egress: "local", fields: [
    text("item", "Day item", true, true), text("title", "Title"),
  ] },
  "studio-thread": { row: "O07", label: "Studio thread", owner: "Studio", egress: "local", fields: [
    text("question", "Question"), text("area", "Area", true, true), text("park", "Thread to park when all places are in use", false, true),
  ] },
  "studio-capture": { row: "O08", label: "Studio capture", owner: "Studio", egress: "local", fields: [
    long("text", "Capture", true), text("thread", "Thread (empty files it to the Studio inbox)", false, true),
  ] },
  "studio-note": { row: "O10", label: "Studio note, idea or stand", owner: "Studio", egress: "local", fields: [
    text("thread", "Thread", true, true), text("kind", "Kind (note, idea or stand; empty is note)", false), long("text", "Text", true),
  ] },
  "studio-response": { row: "O11", label: "Studio response", owner: "Studio", egress: "local", fields: [
    text("thread", "Thread", true, true), long("text", "Response", true),
  ] },
  "studio-close": { row: "O11", label: "Studio close", owner: "Studio", egress: "local", fields: [
    text("thread", "Thread", true, true), text("outcome", "Outcome (decided, shipped or dropped)"), long("text", "Outcome text", true),
    long("expect", "What you expect to happen"), { name: "reviewOn", label: "Review date", kind: "date", required: false },
  ] },
  flow: { row: "O14", label: "Flow", owner: "Pulse", egress: "local", fields: [
    text("name", "Name"), long("definition", "Flow definition", true),
  ], fixed: [{ label: "Run", value: "Saved to this stack's flows. Running it is a separate decision." }] },
  routine: { row: "O15", label: "Routine", owner: "Reflex", egress: "local", fields: [
    text("name", "Name"), text("target", "Target", true, true), text("schedule", "Schedule"), text("timezone", "Time zone"),
    text("flow", "Saved flow (name)", false),
  ], fixed: [{ label: "Schedule", value: "Created paused. Resuming it is a separate decision." }] },
  "calendar-event": { row: "O16", label: "Calendar event", owner: "Calendar", egress: "cloud", fields: [
    text("calendar", "Calendar (empty uses the default)", false, true), text("title", "Title"), { name: "start", label: "Start", kind: "datetime", required: true }, { name: "end", label: "End", kind: "datetime", required: true }, long("notes", "Notes"),
  ] },
  reminder: { row: "O17", label: "Reminder", owner: "Reminders", egress: "cloud", fields: [
    text("list", "List (empty uses the default)", false, true), text("title", "Title"), { name: "due", label: "Due", kind: "datetime", required: true },
  ] },
  "soma-goal": { row: "O18", label: "Goal", owner: "Soma goals", egress: "local", fields: [long("wording", "Wording", true)], fixed: [{ label: "Status", value: "Created as a draft goal." }] },
  "tana-note": { row: "O19", label: "Tana note", owner: "Tana", egress: "cloud", fields: [text("target", "Target node (empty uses the inbox)", false, true), long("text", "Note", true)] },
  "desk-note": { row: "O20", label: "Keep-in-mind note", owner: "Desk", egress: "local", fields: [long("text", "Note", true)] },
  "mail-draft": { row: "O21", label: "Reply draft", owner: "Mail", egress: "cloud", fields: [text("mail", "Listed mail", true, true), long("body", "Reply", true)], fixed: [{ label: "Send", value: "Saved as a draft; never sent." }] },
};

export const UNAVAILABLE_TYPES: UnavailableSpec[] = [
  { type: "ranger-intake", row: "O03", label: "Ranger intake card", owner: "Ranger", reason: "Ranger drafts intake cards from a mention in its configured Discord thread; it offers no conversation entry point." },
  { type: "studio-material", row: "O09", label: "Studio material or link", owner: "Studio", reason: "The Studio has no general material writer; material arrives only through a capture." },
  { type: "studio-session", row: "O12", label: "Studio discussion session", owner: "Mission Control", reason: "A conversation takes the place of a short Studio session." },
  { type: "studio-projection", row: "O13", label: "Studio-derived Balance project or task", owner: "Studio", reason: "Balance derives these from the Studio; they cannot be created on their own." },
  { type: "desk-source-card", row: "O22", label: "Source-backed Desk card", owner: "Desk sources", reason: "Observation only: these cards show a source such as mail or a meeting and are never created directly." },
  { type: "ranger-job", row: "O24", label: "Ranger job", owner: "Ranger", reason: "Starting a job is execution, not creation; it needs its own authority." },
  { type: "settings", row: "O25", label: "Settings and status views", owner: "Configuration", reason: "Observation only: settings and status change through their own controls." },
];

export const SUBJECT_FIELDS = ["title", "name", "question", "wording", "text", "body"] as const;

export const isCreatable = (type: string): type is CreatableType => (CREATABLE_TYPES as readonly string[]).includes(type);
