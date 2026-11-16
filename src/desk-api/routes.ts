type DeskApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface DeskApiRoute {
  readonly method: DeskApiMethod;
  readonly path: string;
}

const route = (method: DeskApiMethod, ...paths: string[]): DeskApiRoute[] => paths.map((path) => ({ method, path }));

/** The Desk routes an external UI may rely on; `{name}` marks a parameter of the URL. A removal needs a major bump of DESK_API_VERSION, an addition a minor one. */
export const DESK_API_ROUTES: readonly DeskApiRoute[] = [
  ...route("GET", "/api/desk", "/api/desk/contract", "/api/desk/search", "/api/desk/studio", "/api/desk/studio/relations", "/api/desk/outline/history", "/api/desk/flows", "/api/desk/flows/card", "/api/desk/flows/{name}", "/api/desk/graph-surfaces/destinations", "/api/desk/graph-surfaces/node", "/api/desk/balance-surfaces/destinations", "/api/desk/balance-surfaces/task", "/api/desk/graph-repositories", "/api/desk/graph-repositories/{ref}/nodes", "/api/desk/routine-history", "/api/desk/routine-log", "/api/desk/routine-occurrences", "/api/desk/routine-removal", "/api/vigil/subjects"),
  ...route("GET", "/api/desk/my-day", "/api/desk/calendars", "/api/desk/vips", "/api/desk/unimportant", "/api/desk/mail/rules", "/api/desk/mail/dmarc", "/api/desk/corrections", "/api/desk/interruptions", "/api/desk/meeting-brief", "/api/desk/routine-display", "/api/desk/routine-editor", "/api/desk/routine-lifecycle", "/api/desk/routine-schedule", "/api/desk/connections", "/api/desk/drafts", "/api/desk/drafts/{id}", "/api/desk/drafts/{id}/details"),
  ...route("POST", "/api/desk/plan", "/api/desk/my-day", "/api/desk/action", "/api/desk/adapter", "/api/desk/autonomy", "/api/desk/vips", "/api/desk/unimportant", "/api/desk/mail", "/api/desk/items/defer", "/api/desk/mail/round", "/api/desk/task-handoff", "/api/desk/links", "/api/desk/meeting-brief", "/api/desk/meeting-brief/previous", "/api/desk/mail/rules", "/api/desk/mail/dmarc", "/api/desk/corrections", "/api/desk/interruptions", "/api/desk/interruptions/feedback", "/api/desk/ask", "/api/desk/capture/undo", "/api/desk/create", "/api/desk/routines", "/api/desk/routine-capability", "/api/desk/routine-display", "/api/desk/routine-editor", "/api/desk/routine-lifecycle", "/api/desk/routine-schedule", "/api/desk/voice/speak", "/api/desk/voice/transcribe", "/api/desk/notes/done", "/api/desk/goal", "/api/desk/ruling", "/api/desk/studio/act", "/api/desk/studio/session", "/api/desk/outline/ask", "/api/desk/balance/read", "/api/desk/connections", "/api/desk/connections/{id}/provision", "/api/desk/connections/{id}/enable", "/api/desk/connections/{id}/disable", "/api/desk/drafts", "/api/desk/drafts/{id}/references", "/api/desk/drafts/{id}/destination", "/api/desk/drafts/{id}/refresh", "/api/desk/drafts/{id}/confirm"),
  ...route("PATCH", "/api/desk/calendars", "/api/desk/drafts/{id}"),
  ...route("PUT", "/api/desk/graph-repositories/{ref}"),
  ...route("DELETE", "/api/desk/vips", "/api/desk/unimportant", "/api/desk/corrections"),

  ...route("GET", "/api/conversations", "/api/conversations/overview", "/api/conversations/source", "/api/conversations/capabilities", "/api/conversations/grants", "/api/conversations/{id}", "/api/conversations/{id}/stream", "/api/conversations/{id}/discord", "/api/conversations/{id}/entries", "/api/conversations/{id}/entries/{entryId}", "/api/conversations/{id}/inputs/{inputId}", "/api/conversations/{id}/proposals"),
  ...route("POST", "/api/conversations", "/api/conversations/asks", "/api/conversations/starts", "/api/conversations/imports", "/api/conversations/{id}/inputs", "/api/conversations/{id}/links", "/api/conversations/{id}/discord", "/api/conversations/{id}/outcome", "/api/conversations/{id}/attachments", "/api/conversations/{id}/proposals", "/api/conversations/{id}/proposals/{proposalId}/check", "/api/conversations/{id}/proposals/{proposalId}/confirm"),
  ...route("PATCH", "/api/conversations/{id}", "/api/conversations/{id}/proposals/{proposalId}"),
  ...route("PUT", "/api/conversations/{id}/draft"),
  ...route("DELETE", "/api/conversations/grants/{grantId}"),
];
