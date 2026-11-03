import { describe, expect, test } from "bun:test";
import type { OperationRecord } from "../../../conversations/types";
import { studioRequestId } from "../desk/conversation-sources";
import { directRequest, failureOf, operationOf, studioConversationRig } from "./studio-conversation-rig";

const rig = studioConversationRig("conversation-studio-thread-", "studio-thread", { alpha: "active", beta: "active", gamma: "parked" });
const SEEDED = ["alpha.md", "beta.md", "gamma.md"];

describe("Studio thread writer", () => {
  test("opens an active thread with the question, the area, the conversation in Material and the log, once", async () => {
    const r = await rig();
    try {
      const { view, reply } = await r.submit({ question: "Should the lab run a spring workshop?", area: "lab" });
      const operation = r.created(reply);
      const message = r.repo.git("log", "-n", "1", "--format=%B");
      expect(message).toContain(`Desk-Request: ${studioRequestId(operation.operationId)}`);
      expect(message).toContain("Open should-the-lab-run-a-spring-workshop from an Ivy conversation");
      const link = `?desk=conversation&conversation=${r.id}`;
      const t = r.parsed("should-the-lab-run-a-spring-workshop");
      expect(t).toMatchObject({ state: "active", type: "question", areas: ["lab"], question: "Should the lab run a spring workshop?" });
      expect(t.material.map(m => m.label)).toEqual([`Ivy conversation: ${link}`]);
      expect(t.log.map(l => l.text)).toEqual([`Opened from Ivy conversation ${link}`]);

      await r.confirmedAgain(view, operation);
      expect(r.threads()).toEqual([...SEEDED, "should-the-lab-run-a-spring-workshop.md"]);
    } finally { r.repo.clean(); }
  });

  test("parks the named thread and opens the new one in one commit when all places are in use", async () => {
    const r = await rig({ maxActive: 2 });
    try {
      const { reply } = await r.submit({ question: "Who teaches in March?", area: "lab", park: "beta" });
      expect(reply.status).toBe(200);
      expect(reply.body.proposal.feedback).toBe("created");
      expect(r.commits()).toHaveLength(2);
      expect(r.repo.git("show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["threads/beta.md", "threads/who-teaches-in-march.md"]);
      expect(r.parsed("beta").state).toBe("parked");
      expect(r.parsed("who-teaches-in-march").state).toBe("active");
    } finally { r.repo.clean(); }
  });

  test("fails with the owner's sentence and changes nothing when all places are in use and no thread is named to park", async () => {
    const r = await rig({ maxActive: 2 });
    try {
      const { reply } = await r.submit({ question: "Who teaches in March?", area: "lab" });
      expect(reply.status).toBe(409);
      expect(reply.body.proposal.feedback).toBe("failed");
      expect(failureOf(reply.body.proposal)).toBe("All 2 places are in use. Choose a thread to park first. Nothing was created.");
      expect(r.commits()).toHaveLength(1);
      expect(r.threads()).toEqual(SEEDED);
      expect(r.parsed("beta").state).toBe("active");
    } finally { r.repo.clean(); }
  });

  test("fails and writes nothing for an area the Desk does not list or a question over 200 characters", async () => {
    const r = await rig();
    try {
      const nowhere = await r.submit({ question: "Where does this go?", area: "nowhere" });
      expect(nowhere.reply.status).toBe(409);
      expect(failureOf(nowhere.reply.body.proposal)).toBe("The Desk config lists no area nowhere. Nothing was created.");
      const long = await r.submit({ question: "x".repeat(201), area: "lab" });
      expect(failureOf(long.reply.body.proposal)).toBe("The question is longer than 200 characters. Nothing was created.");
      expect(r.commits()).toHaveLength(1);
      expect(r.threads()).toEqual(SEEDED);
    } finally { r.repo.clean(); }
  });

  test("replays the earlier commit when the writer is called again and reads it back from the Desk-Request trailer", async () => {
    const r = await rig();
    try {
      await r.replayed({ question: "Is the Studio the product?", area: "lab" });
      expect(r.threads()).toEqual([...SEEDED, "is-the-studio-the-product.md"]);
    } finally { r.repo.clean(); }
  });

  test("lists studio-thread as ready with question, area and park, and blocked without a Studio", async () => {
    const r = await rig();
    const bare = await rig({ studio: false });
    try {
      const listed = (await r.types()).find(t => t.type === "studio-thread");
      expect(listed?.status).toBe("ready");
      expect(listed?.fields.map(f => [f.name, f.required, f.destination ?? false])).toEqual([["question", true, false], ["area", true, true], ["park", false, true]]);
      expect(await bare.status("studio-thread")).toBe("blocked:3141");
    } finally {
      r.repo.clean();
      bare.repo.clean();
    }
  });
});
