import { describe, expect, test } from "bun:test";
import { runStudioAct } from "../desk/studio/writer";
import { directRequest, failureOf, studioConversationRig } from "./studio-conversation-rig";

const rig = studioConversationRig("conversation-studio-close-", "studio-close", { alpha: "active", beta: "active", gamma: "parked", omega: "closed" });
const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function failsUnchanged(cases: [Record<string, string>, string][]): Promise<void> {
  const r = await rig();
  try {
    for (const [fields, sentence] of cases) {
      const { reply } = await r.submit(fields);
      expect(reply.status).toBe(409);
      expect(reply.body.proposal.feedback).toBe("failed");
      expect(failureOf(reply.body.proposal)).toBe(sentence);
    }
    expect(r.commits()).toHaveLength(1);
    expect(r.parsed("alpha").state).toBe("active");
  } finally { r.repo.clean(); }
}

describe("Studio close writer", () => {
  test("closes an active thread as decided with its expectation and review date, once, naming the conversation", async () => {
    const r = await rig();
    try {
      const reviewOn = inDays(7);
      const { view, reply } = await r.submit({ thread: "alpha", outcome: "decided", text: "Run it in spring.", expect: "Twelve people sign up.", reviewOn });
      const operation = r.created(reply);
      const t = r.parsed("alpha");
      expect(t).toMatchObject({ state: "closed", outcome: "decided", expect: "Twelve people sign up.", reviewOn, outcomeText: "Run it in spring." });
      expect(t.log.at(-1)?.text).toBe(`Closed as decided from conversation ?desk=conversation&conversation=${r.id}`);

      await r.confirmedAgain(view, operation);
      expect(r.parsed("alpha").log.filter(l => l.text.startsWith("Closed as"))).toHaveLength(1);
    } finally { r.repo.clean(); }
  });

  test("closes as shipped without an expectation, and a parked thread as dropped", async () => {
    const r = await rig();
    try {
      r.created((await r.submit({ thread: "beta", outcome: "shipped", text: "It went out.", expect: "", reviewOn: "" })).reply);
      const shipped = r.parsed("beta");
      expect(shipped).toMatchObject({ state: "closed", outcome: "shipped", outcomeText: "It went out." });
      expect(shipped.expect).toBeUndefined();
      expect(shipped.reviewOn).toBeUndefined();

      r.created((await r.submit({ thread: "gamma", outcome: " dropped ", text: "Not now." })).reply);
      expect(r.parsed("gamma")).toMatchObject({ state: "closed", outcome: "dropped" });
    } finally { r.repo.clean(); }
  });

  test("fails a decision without a review date, with one in the past or without an expectation with the owner's sentence, and leaves the thread unchanged", async () => {
    await failsUnchanged([
      [{ thread: "alpha", outcome: "decided", text: "Run it.", expect: "Twelve sign up." }, "A decision needs a review date. Nothing was created."],
      [{ thread: "alpha", outcome: "decided", text: "Run it.", expect: "Twelve sign up.", reviewOn: "2020-01-01" }, "The review date is in the past. Nothing was created."],
      [{ thread: "alpha", outcome: "decided", text: "Run it.", reviewOn: inDays(7) }, "A decision needs what you expect to happen, so the review has something to check. Nothing was created."],
    ]);
  });

  test("fails an unknown outcome before the Studio is called, and refuses a closed or missing thread", async () => {
    await failsUnchanged([
      [{ thread: "alpha", outcome: "abandoned", text: "Gone." }, "abandoned is not an outcome; use decided, shipped or dropped. Nothing was created."],
      [{ thread: "omega", outcome: "dropped", text: "Again." }, "“What about omega” is closed. Nothing was created."],
      [{ thread: "no-such-thread", outcome: "dropped", text: "Hello?" }, "No readable thread is called no-such-thread. Nothing was created."],
    ]);
  });

  test("replays the earlier commit when the writer is called again and reads it back from the Desk-Request trailer", async () => {
    const r = await rig();
    try {
      await r.replayed({ thread: "alpha", outcome: "dropped", text: "Not worth it." });
      expect(r.parsed("alpha").state).toBe("closed");
    } finally { r.repo.clean(); }
  });

  test("says the outcome is missing when the writer is called without one, and the studio/act close keeps its plain log line", async () => {
    const r = await rig();
    try {
      expect(await r.writer().create(directRequest("studio-close", { thread: "alpha", outcome: " ", text: "Gone." }))).toEqual({ state: "failed", error: "The outcome is missing; use decided, shipped or dropped. Nothing was created." });
      const closed = await runStudioAct({ options: { dir: r.repo.dir, maxActive: 5 }, areas: [{ id: "lab", label: "Lab", color: "#7c3aed", policy: "local" }], requestId: "studio-act-close-xyz", act: { act: "close", thread: "beta", outcome: "dropped", text: "Not now." } });
      expect(closed).toMatchObject({ ok: true });
      expect(r.parsed("beta").log.at(-1)?.text).toBe("Closed as dropped");
    } finally { r.repo.clean(); }
  });

  test("lists studio-close as ready with its fields, and blocked without a Studio", async () => {
    const r = await rig();
    const bare = await rig({ studio: false });
    try {
      const listed = (await r.types()).find(t => t.type === "studio-close");
      expect(listed?.status).toBe("ready");
      expect(listed?.fields.map(f => [f.name, f.required, f.destination ?? false])).toEqual([["thread", true, true], ["outcome", true, false], ["text", true, false], ["expect", false, false], ["reviewOn", false, false]]);
      expect(await bare.status("studio-close")).toBe("blocked:3139");
    } finally {
      r.repo.clean();
      bare.repo.clean();
    }
  });
});
