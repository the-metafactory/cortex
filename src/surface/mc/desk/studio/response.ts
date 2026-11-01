import type { StudioResponse, StudioThread } from "./format";

type ResponseContext = Pick<StudioThread, "notes" | "responses">;
export function responseCoverage(thread: Pick<StudioThread, "notes">, response: StudioResponse): number {
  const note = thread.notes.find(n => !n.sample && n.at === response.re);
  return Math.max(Date.parse(response.at), note ? Date.parse(note.at) : 0);
}
export function lastResponseCoverage(thread: ResponseContext): number {
  return thread.responses.filter(r => r.text.trim()).reduce((latest, response) => Math.max(latest, responseCoverage(thread, response)), 0);
}
export function needsResponse(thread: ResponseContext & Pick<StudioThread, "state">): boolean {
  const covered = lastResponseCoverage(thread);
  return thread.state !== "closed" && thread.notes.some(n => !n.sample && Date.parse(n.at) > covered);
}
