export const CREATABLE_TYPES = [
  "graph-node", "graph-map", "balance-task", "balance-project", "balance-inbox-task", "studio-thread", "studio-capture", "studio-note", "studio-outcome",
  "flow", "routine", "calendar-event", "reminder", "soma-goal", "tana-note", "desk-note", "mail-draft",
] as const;
export type CreatableType = (typeof CREATABLE_TYPES)[number];

export type Egress = "local" | "cloud";
export interface FieldSpec {
  name: string;
  label: string;
  kind: "text" | "long" | "list" | "date" | "datetime";
  required: boolean;
  destination?: boolean;
}
export interface FixedTerm { label: string; value: string }
export interface CreatableSpec {
  row: string;
  label: string;
  owner: string;
  egress: Egress;
  blockedBy: number;
  fields: FieldSpec[];
  fixed?: FixedTerm[];
}
export interface UnavailableSpec { type: string; row: string; label: string; owner: string; reason: string }

const text = (name: string, label: string, required = true, destination = false): FieldSpec => ({ name, label, kind: "text", required, ...(destination ? { destination } : {}) });
const long = (name: string, label: string, required = false): FieldSpec => ({ name, label, kind: "long", required });
const OWNER_COVERAGE = 2972;
const FLOW_DESTINATION = 3014;

export const CREATION_CATALOG: Record<CreatableType, CreatableSpec> = {
  "graph-node": { row: "O01", label: "Graph node", owner: "Soma work graph", egress: "cloud", blockedBy: OWNER_COVERAGE, fields: [
    text("repository", "Repository", true, true), text("parent", "Parent node", true, true), text("title", "Title"), long("body", "Body"), text("checkpoint", "Checkpoint"),
    { name: "dependencies", label: "Blocked by", kind: "list", required: false },
  ], fixed: [{ label: "Claim and close", value: "Not done here; the node is only filed." }] },
  "graph-map": { row: "O02", label: "Graph map", owner: "Soma work graph", egress: "cloud", blockedBy: OWNER_COVERAGE, fields: [
    text("repository", "Repository", true, true), text("title", "Title"), long("body", "Destination and constraints", true), text("checkpoint", "Checkpoint"),
  ] },
  "balance-task": { row: "O04", label: "Balance task", owner: "Balance", egress: "local", blockedBy: OWNER_COVERAGE, fields: [
    text("area", "Area", true, true), text("project", "Parent project", false, true), text("title", "Title"), long("note", "Note"), { name: "due", label: "Due", kind: "date", required: false },
  ] },
  "balance-project": { row: "O05", label: "Balance project", owner: "Balance", egress: "local", blockedBy: OWNER_COVERAGE, fields: [
    text("area", "Area", true, true), text("title", "Title"), long("note", "Note"),
  ] },
  "balance-inbox-task": { row: "O06", label: "Inbox task from a Day item", owner: "Balance", egress: "local", blockedBy: OWNER_COVERAGE, fields: [
    text("item", "Day item", true, true), text("title", "Title"),
  ] },
  "studio-thread": { row: "O07", label: "Studio thread", owner: "Studio", egress: "local", blockedBy: OWNER_COVERAGE, fields: [
    text("from", "Proposal or capture to open", true, true), text("area", "Area", true, true), text("question", "Question"),
  ] },
  "studio-capture": { row: "O08", label: "Studio capture", owner: "Studio", egress: "local", blockedBy: OWNER_COVERAGE, fields: [
    long("text", "Capture", true), text("thread", "Thread (empty files it to the Studio inbox)", false, true),
  ] },
  "studio-note": { row: "O10", label: "Studio note, idea or stand", owner: "Studio", egress: "local", blockedBy: OWNER_COVERAGE, fields: [
    text("thread", "Thread", true, true), text("kind", "Kind (note, idea or stand)"), long("text", "Text", true),
  ] },
  "studio-outcome": { row: "O11", label: "Studio response or decision", owner: "Studio", egress: "local", blockedBy: OWNER_COVERAGE, fields: [
    text("thread", "Thread", true, true), long("text", "Response or outcome", true), { name: "review", label: "Review date (decisions)", kind: "date", required: false },
  ] },
  flow: { row: "O14", label: "Flow", owner: "Pulse", egress: "local", blockedBy: FLOW_DESTINATION, fields: [
    text("destination", "Package or directory", true, true), text("name", "Name"), long("definition", "Flow definition", true),
  ], fixed: [{ label: "Run", value: "Saved without running. Running it is a separate decision." }] },
  routine: { row: "O15", label: "Routine", owner: "Reflex", egress: "local", blockedBy: OWNER_COVERAGE, fields: [
    text("name", "Name"), text("target", "Target", true, true), text("schedule", "Schedule"), text("timezone", "Time zone"),
  ], fixed: [{ label: "Schedule", value: "Created paused. Resuming it is a separate decision." }] },
  "calendar-event": { row: "O16", label: "Calendar event", owner: "Calendar", egress: "cloud", blockedBy: OWNER_COVERAGE, fields: [
    text("calendar", "Calendar (empty uses the default)", false, true), text("title", "Title"), { name: "start", label: "Start", kind: "datetime", required: true }, { name: "end", label: "End", kind: "datetime", required: true }, long("notes", "Notes"),
  ] },
  reminder: { row: "O17", label: "Reminder", owner: "Reminders", egress: "cloud", blockedBy: OWNER_COVERAGE, fields: [
    text("list", "List (empty uses the default)", false, true), text("title", "Title"), { name: "due", label: "Due", kind: "datetime", required: false },
  ] },
  "soma-goal": { row: "O18", label: "Goal", owner: "Soma goals", egress: "local", blockedBy: OWNER_COVERAGE, fields: [long("wording", "Wording", true)], fixed: [{ label: "Status", value: "Created as a draft goal." }] },
  "tana-note": { row: "O19", label: "Tana note", owner: "Tana", egress: "cloud", blockedBy: OWNER_COVERAGE, fields: [text("target", "Target node (empty uses the inbox)", false, true), long("text", "Note", true)] },
  "desk-note": { row: "O20", label: "Keep-in-mind note", owner: "Desk", egress: "local", blockedBy: OWNER_COVERAGE, fields: [long("text", "Note", true)] },
  "mail-draft": { row: "O21", label: "Reply draft", owner: "Mail", egress: "cloud", blockedBy: OWNER_COVERAGE, fields: [text("mail", "Listed mail", true, true), long("body", "Reply", true)], fixed: [{ label: "Send", value: "Saved as a draft; never sent." }] },
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

export const isCreatable = (type: string): type is CreatableType => (CREATABLE_TYPES as readonly string[]).includes(type);
