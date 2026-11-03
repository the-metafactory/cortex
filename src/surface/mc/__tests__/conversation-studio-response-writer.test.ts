import { describe, expect, test } from "bun:test";
import type { OperationRecord } from "../../../conversations/types";
import { studioRequestId } from "../desk/conversation-sources";
import { spawnGit, type GitRunner } from "../desk/studio/git";
import { directRequest, failureOf, operationOf, studioConversationRig } from "./studio-conversation-rig";

const rig = studioConversationRig("conversation-studio-response-", "studio-response", { alpha: "active", gamma: "parked", omega: "closed" });

describe("Studio response writer", () => {
  test("adds the response to an active thread once, returns the commit and names the conversation in the log", async () => {
    const r = await rig();
    try {
      const { view, reply } = await r.submit({ thread: "alpha", text: "Lead with the Studio." });
      const operation = r.created(reply);
      const t = r.parsed("alpha");
      expect(t.responses.map(x => x.text)).toEqual(["Lead with the Studio."]);
      expect(t.log.at(-1)?.text).toBe(`Answered Ivy from Ivy conversation ?desk=conversation&conversation=${r.id}`);
      await r.confirmedAgain(view, operation);
      expect(r.parsed("alpha").responses).toHaveLength(1);
    } finally { r.repo.clean(); }
  });

  test("replays the earlier commit when the writer is called again for the same operation", async () => {
    const r = await rig();
    try {
      await r.replayed({ thread: "gamma", text: "Parked, but still mine." });
      expect(r.parsed("gamma").responses).toHaveLength(1);
    } finally { r.repo.clean(); }
  });

  test("refuses a thread that does not exist or is closed, and writes nothing", async () => {
    const r = await rig();
    try {
      const missing = await r.submit({ thread: "no-such-thread", text: "Hello?" });
      expect(missing.reply.status).toBe(409);
      expect(missing.reply.body.proposal.feedback).toBe("failed");
      const error = failureOf(missing.reply.body.proposal);
      expect(error).toContain("no-such-thread");
      expect(error.endsWith("Nothing was created.")).toBe(true);

      const closed = await r.submit({ thread: "omega", text: "Too late." });
      expect(closed.reply.status).toBe(409);
      expect(failureOf(closed.reply.body.proposal)).toBe("“What about omega” is closed. Nothing was created.");

      const long = await r.submit({ thread: "alpha", text: "x".repeat(4001) });
      expect(failureOf(long.reply.body.proposal)).toBe("The response is longer than 4000 characters. Nothing was created.");
      expect(r.commits()).toHaveLength(1);
    } finally { r.repo.clean(); }
  });

  test("leaves an owner failure that may have committed uncertain, and Check settles it from the Desk-Request trailer", async () => {
    const failingCommit: GitRunner = (args, cwd) => args[0] === "commit" ? Promise.resolve({ code: 1, stdout: "", stderr: "disk full" }) : spawnGit(args, cwd);
    const r = await rig({ git: failingCommit });
    try {
      const { view, reply } = await r.submit({ thread: "alpha", text: "Lead with the Studio." });
      expect(reply.body.proposal.feedback).toBe("uncertain");
      const checked = await r.check(view);
      expect(checked.body.proposal.feedback).toBe("failed");
      expect(r.commits()).toHaveLength(1);
      expect(r.parsed("alpha").responses).toHaveLength(0);
    } finally { r.repo.clean(); }
  });

  test("lists studio-response and studio-close as ready, without studio-outcome", async () => {
    const r = await rig();
    const bare = await rig({ studio: false });
    try {
      expect(await r.status("studio-outcome")).toBeUndefined();
      expect(await r.status("studio-response")).toBe("ready");
      expect(await r.status("studio-close")).toBe("ready");
      expect(await bare.status("studio-response")).toBe("blocked:3138");
    } finally {
      r.repo.clean();
      bare.repo.clean();
    }
  });
});
