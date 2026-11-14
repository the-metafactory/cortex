import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openConversationHost } from "../src/conversations/host";
import type { ToolOutcome } from "../src/conversations/model";
import { createGitlabTools } from "../src/conversations/tools/gitlab";
import { FETCHED, HEAD, HOST, PATH, REPO, URL, fail, gitlabRig } from "../src/conversations/__tests__/fixtures/gitlab";
import { toolBody } from "../src/conversations/__tests__/fixtures/tool-host";

const dir = await mkdtemp(join(tmpdir(), "ivy-gitlab-probe-"));
const fixture = gitlabRig();
const outcomes: ToolOutcome[] = [];
const status = await openConversationHost({
  dir, stack: "fixture", label: "fixture", expectedLabel: "fixture",
  lanes: { cloud: { provider: "fixture", model: "recorded-gitlab" } },
  tools: { config: () => fixture.config, definitions: createGitlabTools({ run: fixture.run, now: () => new Date(FETCHED) }) },
  turns: async request => {
    assert(request.tools);
    const call = async (name: string, input: unknown) => {
      const result = await request.tools!.call(`probe-${outcomes.length}`, name, input, request.signal);
      outcomes.push(result);
      return result;
    };
    await call("gitlab_item", { project: "office", kind: "issue", number: 3 });
    await call("gitlab_item", { project: "office", kind: "mr", number: 7 });
    const beforeDenied = fixture.argvs.length;
    await call("gitlab_project", { project: "unknown" });
    await call("gitlab_project", { project: "denied" });
    await call("gitlab_project", { project: "office", host: "unconfigured.example" });
    assert.equal(fixture.argvs.length, beforeDenied);
    fixture.routes.set("auth", () => { throw Object.assign(new Error("glab missing"), { code: "ENOENT" }); });
    await call("gitlab_project", { project: "office" });
    fixture.routes.set("auth", fail("dial tcp: laptop unreachable"));
    await call("gitlab_project", { project: "office" });
    return { text: "GitLab fixture probe completed.", session: request.session, resumed: false };
  },
});
try {
  if (status.state !== "ready") throw new Error(status.reason);
  const host = status.host;
  try {
    const conversation = await host.create({ title: "GitLab fixture probe", links: [], origin: { kind: "web" }, policy: "cloud" }, "fixture-principal");
    await host.submit(conversation.id, { inputId: "fixture-read", transport: "web", text: "Read the recorded issue and MR", mode: "queue" });
    await host.waitForIdle(conversation.id);
    assert.equal((await host.input(conversation.id, "fixture-read")).answer, "GitLab fixture probe completed.");
    assert.equal(outcomes.length, 7);
    for (const [index, suffix] of [[0, "/-/issues/3"], [1, "/-/merge_requests/7"]] as const) {
      const result = outcomes[index]!;
      assert.equal(result.outcome, "done");
      assert.equal(result.source?.id, "office");
      assert(result.source?.revision);
      const body = toolBody(result.text);
      assert.equal(body.status, "ok");
      assert.equal(body.url, `${URL}${suffix}`);
      assert.equal(body.fetchedAt, FETCHED);
      assert.deepEqual(body.source, { host: HOST, project: REPO, url: URL });
    }
    assert.equal(toolBody(outcomes[1]!.text).headSha, HEAD);
    for (const result of outcomes.slice(2, 5)) assert.equal(result.outcome, "refused");
    for (const result of outcomes.slice(5)) {
      assert.equal(result.outcome, "error");
      assert.match(result.text, /unavailable/);
    }
    assert(fixture.argvs.every(argv => argv[0] === "glab" && argv[argv.indexOf("--hostname") + 1] === HOST));
    assert(fixture.argvs.filter(argv => argv[1] === "api").every(argv => argv.at(-1)?.startsWith(PATH)));
    const transcript = JSON.stringify(await host.entries(conversation.id, 100, undefined));
    assert(transcript.includes("gitlab_item"));
    assert(transcript.includes(HEAD));
    console.log("PASS GitLab conversation fixture probe: issue/MR provenance, scope denials, missing client and unreachable host; no fallback.");
  } finally { await host.close(); }
} finally { await rm(dir, { recursive: true, force: true }); }
