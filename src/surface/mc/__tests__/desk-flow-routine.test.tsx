import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeskSavedFlows, SavedFlowRow } from "../dashboard-v2/components/desk-saved-flows";
import { ApiFailure } from "../dashboard-v2/lib/api";
import { makeRoutineFromFlow, newRoutineStart, routineNameFromFlow } from "../dashboard-v2/lib/desk-flows";

const routine = { target: "@fixture/pulse-flow", timeZone: "Europe/Zurich" };
const flow = { name: "F_DAILY_DIGEST", sha256: "a".repeat(64), savedAt: "2026-11-06T09:00:00Z", origin: "cli" as const, conversationId: null };
const now = Date.parse("2026-11-06T10:00:00Z");

const seam = (failProposal = false) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const send = <T,>(path: string, body: unknown): Promise<T> => {
    calls.push({ path, body: body as Record<string, unknown> });
    if (path === "/api/conversations") return Promise.resolve({ conversation: { id: "c-1" } } as T);
    return failProposal ? Promise.reject(new ApiFailure({ status: 500, message: "The proposal was not saved." })) : Promise.resolve({ proposal: {} } as T);
  };
  return { calls, send };
};

describe("Make a routine from a saved flow", () => {
  it("names the routine in words", () => { expect(routineNameFromFlow("F_DAILY_DIGEST")).toBe("Daily digest"); });

  it("posts a conversation and a routine proposal with no schedule, both with client ids", async () => {
    const { calls, send } = seam();
    const start = newRoutineStart();
    const result = await makeRoutineFromFlow(flow.name, routine, start, send);
    expect(result).toEqual({ status: "opened", conversationId: "c-1" });
    expect(calls[0]?.body).toMatchObject({ title: "Routine from Daily digest", requestId: start.requestId });
    expect(calls[1]?.path).toBe("/api/conversations/c-1/proposals");
    expect(calls[1]?.body).toEqual({ proposalId: start.proposalId, type: "routine", fields: { flow: "F_DAILY_DIGEST", name: "Daily digest", target: routine.target, timezone: routine.timeZone } });
  });

  it("keeps the conversation and returns the error when the proposal fails; a retry reuses the same ids", async () => {
    const { calls, send } = seam(true);
    const start = newRoutineStart();
    const failed = await makeRoutineFromFlow(flow.name, routine, start, send);
    expect(failed).toEqual({ status: "failed", error: "The proposal was not saved.", conversationId: "c-1" });
    await makeRoutineFromFlow(flow.name, routine, start, send);
    const creates = calls.filter((c) => c.path === "/api/conversations").map((c) => c.body.requestId);
    expect(creates).toEqual([start.requestId, start.requestId]);
  });

  it("does not navigate when the conversation post fails", async () => {
    const send = <T,>(): Promise<T> => Promise.reject(new ApiFailure({ status: 503, message: "Conversations are not set up on this stack." }));
    expect(await makeRoutineFromFlow(flow.name, routine, newRoutineStart(), send)).toEqual({ status: "failed", error: "Conversations are not set up on this stack." });
  });

  it("renders the button only when desk.routines is configured", () => {
    const withRoutines = renderToStaticMarkup(<DeskSavedFlows state={{ status: "ready", flows: [flow], routine }} now={now} />);
    const without = renderToStaticMarkup(<DeskSavedFlows state={{ status: "ready", flows: [flow] }} now={now} />);
    expect(withRoutines).toContain("Make a routine");
    expect(without).not.toContain("Make a routine");
  });

  it("shows the error with a link to the created conversation", () => {
    const html = renderToStaticMarkup(<SavedFlowRow flow={flow} now={now} state={{ status: "closed" }} onToggle={() => undefined} routine={{ busy: false, error: "The proposal was not saved.", conversationId: "c-1", onMake: () => undefined, onOpen: () => undefined }} />);
    expect(html).toContain("The proposal was not saved.");
    expect(html).toContain("Open the conversation to try again");
  });
});
