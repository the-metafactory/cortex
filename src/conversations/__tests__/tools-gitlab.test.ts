import { describe, expect, test } from "bun:test";
import { ProjectSchema } from "../../common/types/desk-conversations";
import { gitlabTarget } from "../tools/gitlab";
import { toolBody } from "./fixtures/tool-host";
import { FETCHED, HEAD, HOST, PATH, REPO, URL, fail, gitlabConfig, gitlabRig, issue, job, metadata, mr, ok, pipeline } from "./fixtures/gitlab";

const base = { project: "office" };
const mrInput = { ...base, number: 7 };
const jobsPath = `${PATH}/pipelines/81/jobs`;
const pipelinePath = `${PATH}/pipelines/81`;
const status = async (r: ReturnType<typeof gitlabRig>, name: string, input: unknown = base) => toolBody((await r.call(name, input)).text);

describe("GitLab reads through conversation dispatch", () => {
  test("metadata, issue and MR preserve nested host identity and provenance", async () => {
    const r = gitlabRig();
    expect(await status(r, "gitlab_project")).toMatchObject({ status: "ok", source: { host: HOST, project: REPO, url: URL }, fetchedAt: FETCHED, project: metadata });
    expect(await status(r, "gitlab_item", { ...base, kind: "issue", number: 3 })).toMatchObject({ status: "ok", url: issue.web_url, item: { body: issue.description } });
    expect(await status(r, "gitlab_item", { ...mrInput, kind: "mr" })).toMatchObject({ status: "ok", url: mr.web_url, headSha: HEAD });
    for (const argv of r.argvs) {
      expect(argv[0]).toBe("glab");
      expect(argv[argv.indexOf("--hostname") + 1]).toBe(HOST);
      if (argv[1] === "api") {
        expect(argv.slice(4, 6)).toEqual(["--method", "GET"]);
        expect(argv.at(-1)?.startsWith(PATH)).toBe(true);
        expect(argv).not.toContain("--paginate");
      }
    }
  });

  test("unknown sources, host injection, denied operations and local cloud reads never reach the owner", async () => {
    const r = gitlabRig();
    for (const project of ["unknown", "gitlab.com/group/repo", "denied", "local"]) expect((await r.call("gitlab_project", { project })).outcome).toBe("refused");
    expect((await r.call("gitlab_project", { ...base, host: "evil.example" })).outcome).toBe("refused");
    expect(r.argvs).toHaveLength(0);
  });

  test("malicious identifiers and percent encodings are refused losslessly", async () => {
    const r = gitlabRig();
    for (const number of [0, -1, 1.5, "7%2f..", "7/../../user"]) expect((await r.call("gitlab_item", { ...base, kind: "mr", number })).outcome).toBe("refused");
    for (const repo of ["a/../b", "a/%2fb", "a/%252fb", "a/b?x", "a/b#x", "a//b", "a/\\b"]) {
      const project = { ...gitlabConfig().projects[0]!, forge: { kind: "gitlab" as const, host: HOST, repo } };
      expect(ProjectSchema.safeParse(project).success).toBe(false);
      expect(typeof gitlabTarget(project)).toBe("string");
    }
    for (const host of ["evil.example/path", "good@evil.example", "-option", "evil.example:99999", "a..b"]) expect(typeof gitlabTarget({ ...gitlabConfig().projects[0]!, forge: { kind: "gitlab", host, repo: REPO } })).toBe("string");
    expect(r.argvs).toHaveLength(0);
  });

  test("search is bounded and literal within one project; foreign hits are withheld", async () => {
    const route = `${PATH}/issues`;
    const r = gitlabRig({ [route]: argv => { expect(argv.at(-1)).toContain("search=repo%3Aother%2Fhidden%26page%3D999"); return ok([issue]); } });
    expect(await status(r, "gitlab_search", { ...base, kind: "issue", query: "repo:other/hidden&page=999", perPage: 1, page: 2 })).toMatchObject({ status: "ok", page: 2, nextPage: 3 });
    r.routes.set(route, ok([{ ...issue, project_id: 99, description: "FOREIGN CONTENT" }]));
    const foreign = await status(r, "gitlab_search", { ...base, kind: "issue" });
    expect(foreign.status).toBe("identity-mismatch");
    expect(JSON.stringify(foreign)).not.toContain("FOREIGN CONTENT");
    r.routes.set(route, ok([issue]));
    expect(await status(r, "gitlab_search", { ...base, kind: "issue", perPage: 1, page: 20 })).toMatchObject({ nextPage: null, mayHaveMore: true, pageLimitReached: true });
    expect((await r.call("gitlab_search", { ...base, kind: "mr", page: 21 })).outcome).toBe("refused");
  });

  test("project and item aliases, forged URLs and foreign notes never release content", async () => {
    const moved = gitlabRig({ [PATH]: ok({ ...metadata, path_with_namespace: "other/project" }) });
    expect((await status(moved, "gitlab_item", { ...base, kind: "issue", number: 3 })).status).toBe("identity-mismatch");
    expect(moved.argvs.filter(argv => argv[1] === "api")).toHaveLength(1);
    for (const patch of [{ project_id: 99 }, { iid: 5 }, { web_url: `${URL}.evil/-/issues/3` }]) expect((await status(gitlabRig({ [`${PATH}/issues/3`]: ok({ ...issue, ...patch }) }), "gitlab_item", { ...base, kind: "issue", number: 3 })).status).toBe("identity-mismatch");
    const r = gitlabRig({ [`${PATH}/issues/3/discussions`]: ok([{ id: "d", notes: [{ id: 1, body: "foreign", author: { username: "u" }, created_at: FETCHED, project_id: 99 }] }]) });
    expect((await status(r, "gitlab_discussions", { ...base, kind: "issue", number: 3 })).status).toBe("identity-mismatch");
  });

  test("discussion pages construct canonical note links and mark oversized threads", async () => {
    const notes = Array.from({ length: 11 }, (_, i) => ({ id: i + 1, body: "Text links are not followed https://elsewhere.example/private", author: { username: "u" }, created_at: FETCHED }));
    const r = gitlabRig({ [`${PATH}/merge_requests/7/discussions`]: ok([{ id: "thread", notes }]) });
    expect(await status(r, "gitlab_discussions", { ...mrInput, kind: "mr", perPage: 1 })).toMatchObject({ status: "ok", headSha: HEAD, nextPage: 2, discussions: [{ incomplete: true, notes: expect.arrayContaining([expect.objectContaining({ url: `${mr.web_url}#note_1` })]) }] });
    expect(await status(r, "gitlab_discussions", { ...mrInput, kind: "mr", notesPage: 2 })).toMatchObject({ notesPage: 2, discussions: [{ nextNotesPage: 3, notes: expect.arrayContaining([expect.objectContaining({ id: 4 })]) }] });
    expect(r.argvs.every(argv => argv[argv.indexOf("--hostname") + 1] === HOST)).toBe(true);
  });

  test("discussion continuation preserves exact note and page boundaries", async () => {
    for (const [count, notesPage, ids, incomplete, nextNotesPage, notesLimitReached] of [
      [3, 1, [1, 2, 3], false, null, false],
      [4, 1, [1, 2, 3], true, 2, false],
      [4, 2, [4], true, null, false],
      [60, 20, [58, 59, 60], true, null, false],
      [61, 20, [58, 59, 60], true, null, true],
    ] as const) {
      const notes = Array.from({ length: count }, (_, i) => ({ id: i + 1, body: "Note", author: { username: "u" }, created_at: FETCHED }));
      const r = gitlabRig({ [`${PATH}/issues/3/discussions`]: ok([{ id: "thread", notes }]) });
      const result = await status(r, "gitlab_discussions", { ...base, kind: "issue", number: 3, notesPage });
      expect(result).toMatchObject({ status: "ok", discussions: [{ incomplete, nextNotesPage, notesLimitReached, notes: ids.map(id => expect.objectContaining({ id })) }] });
    }
  });

  test("MR search and item reads enforce the same head and canonical identity rules", async () => {
    for (const [patch, expected] of [[{ sha: null }, "invalid-payload"], [{ project_id: 99 }, "identity-mismatch"], [{ web_url: issue.web_url }, "identity-mismatch"]] as const) {
      const r = gitlabRig({ [`${PATH}/merge_requests`]: ok([{ ...mr, ...patch }]), [`${PATH}/merge_requests/7`]: ok({ ...mr, ...patch }) });
      for (const tool of ["gitlab_search", "gitlab_item"]) {
        const result = await status(r, tool, tool === "gitlab_search" ? { ...base, kind: "mr" } : { ...mrInput, kind: "mr" });
        expect(result.status).toBe(expected);
        expect(result.items).toBeUndefined();
        expect(result.item).toBeUndefined();
      }
    }
  });

  test("changes, commits and pipelines are bounded head-pinned pages", async () => {
    const r = gitlabRig({
      [`${PATH}/merge_requests/7/diffs`]: ok([{ old_path: "a", new_path: "b", diff: "x".repeat(5000), collapsed: false }]),
      [`${PATH}/merge_requests/7/commits`]: ok([{ id: HEAD, title: "Commit", web_url: `${URL}/-/commit/${HEAD}`, committed_date: FETCHED }]),
      [`${PATH}/merge_requests/7/pipelines`]: ok([pipeline]),
    });
    expect(await status(r, "gitlab_mr_changes", { ...mrInput, perPage: 1 })).toMatchObject({ status: "ok", headSha: HEAD, nextPage: 2, entries: [{ incomplete: true }] });
    expect(await status(r, "gitlab_mr_commits", mrInput)).toMatchObject({ status: "ok", entries: [{ sha: HEAD }] });
    expect(await status(r, "gitlab_pipelines", mrInput)).toMatchObject({ status: "ok", entries: [{ status: "success", sha: HEAD }] });
    let heads = 0;
    r.routes.set(`${PATH}/merge_requests/7`, () => ok({ ...mr, sha: heads++ === 0 ? HEAD : "b".repeat(40) }));
    expect(await status(r, "gitlab_mr_changes", mrInput)).toMatchObject({ status: "head-changed" });
  });

  test("MR pages observe the final head after the page completes", async () => {
    for (const [tool, suffix] of [["gitlab_mr_changes", "diffs"], ["gitlab_mr_commits", "commits"], ["gitlab_pipelines", "pipelines"]] as const) {
      let sha = HEAD;
      const r = gitlabRig({
        [`${PATH}/merge_requests/7`]: () => ok({ ...mr, sha }),
        [`${PATH}/merge_requests/7/${suffix}`]: async () => {
          await Promise.resolve();
          sha = "b".repeat(40);
          return ok([]);
        },
      });
      const result = await status(r, tool, mrInput);
      expect(result.status).toBe("head-changed");
      expect(result.entries).toBeUndefined();
    }
  });

  test("pipeline page verification withholds evidence when the MR pipeline changes", async () => {
    const r = gitlabRig({ [`${PATH}/merge_requests/7/pipelines`]: () => {
      r.routes.set(`${PATH}/merge_requests/7`, ok({ ...mr, head_pipeline: { id: 82 } }));
      return ok([pipeline]);
    } });
    const result = await status(r, "gitlab_pipelines", mrInput);
    expect(result.status).toBe("state-changed");
    expect(result.entries).toBeUndefined();
  });

  test("job post-read checks overlap after the jobs have been read", async () => {
    let pipelineReads = 0;
    let mrReads = 0;
    let jobsRead = false;
    let pipelinePending = false;
    let overlapped = false;
    const r = gitlabRig({
      [pipelinePath]: async () => {
        if (++pipelineReads === 2) {
          expect(jobsRead).toBe(true);
          pipelinePending = true;
          await new Promise(resolve => setTimeout(resolve, 10));
          pipelinePending = false;
        }
        return ok(pipeline);
      },
      [`${PATH}/merge_requests/7`]: () => {
        if (++mrReads === 2) {
          expect(jobsRead).toBe(true);
          overlapped = pipelinePending;
        }
        return ok(mr);
      },
      [jobsPath]: () => { jobsRead = true; return ok([job]); },
    });
    expect(await status(r, "gitlab_jobs", { ...mrInput, pipeline: 81 })).toMatchObject({ status: "ok", jobs: [{ id: job.id }] });
    expect(overlapped).toBe(true);
  });

  test("jobs retain live status; stale SHA, changing head and changing pipeline withhold evidence", async () => {
    const make = () => gitlabRig({ [pipelinePath]: ok(pipeline), [jobsPath]: ok([job]) });
    const r = make();
    expect(await status(r, "gitlab_jobs", { ...mrInput, pipeline: 81, perPage: 1 })).toMatchObject({ status: "ok", headSha: HEAD, nextPage: 2, pipeline: { status: "success" }, jobs: [{ status: "success" }] });
    r.routes.set(pipelinePath, ok({ ...pipeline, sha: "b".repeat(40) }));
    expect((await status(r, "gitlab_jobs", { ...mrInput, pipeline: 81 })).status).toBe("stale");
    for (const change of ["status", "head", "project", "pipeline"]) {
      const moving = make();
      let reads = 0;
      if (change === "head") moving.routes.set(`${PATH}/merge_requests/7`, () => ok({ ...mr, sha: reads++ === 0 ? HEAD : "b".repeat(40) }));
      if (change === "status") moving.routes.set(pipelinePath, () => ok({ ...pipeline, status: reads++ === 0 ? "running" : "success" }));
      if (change === "project") moving.routes.set(jobsPath, ok([{ ...job, pipeline: { ...job.pipeline, project_id: 99 } }]));
      if (change === "pipeline") moving.routes.set(`${PATH}/merge_requests/7`, () => ok({ ...mr, head_pipeline: { id: reads++ === 0 ? 81 : 82 } }));
      const result = await status(moving, "gitlab_jobs", { ...mrInput, pipeline: 81 });
      expect(result.status).toBe(change === "head" ? "head-changed" : change === "project" ? "identity-mismatch" : "state-changed");
      expect(result.jobs).toBeUndefined();
    }
  });

  test("client, login, denied, missing, rate limit, bad payload and host outage are distinct", async () => {
    for (const [error, expected] of [["HTTP 401", "login-required"], ["HTTP 403", "permission-denied"], ["HTTP 404", "not-found"], ["HTTP 429", "rate-limited"], ["HTTP 502", "provider-failure"], ["dial tcp: network unreachable", "unavailable"]]) expect((await status(gitlabRig({ [PATH]: fail(error!) }), "gitlab_project")).status).toBe(expected);
    for (const value of [{}, null, [], { ...metadata, id: "42" }]) expect((await status(gitlabRig({ [PATH]: ok(value) }), "gitlab_project")).status).toBe("invalid-payload");
    for (const error of ["glab: command not found", "not logged in", "network unreachable"]) {
      const r = gitlabRig({ auth: fail(error) });
      const result = await r.call("gitlab_project", base);
      expect(result.outcome).toBe("error");
      expect(result.text).toContain(error === "not logged in" ? "login-required:" : "unavailable:");
      expect(r.argvs).toHaveLength(1);
    }
    const caps = await status(gitlabRig({ auth: fail("not logged in") }), "capabilities", {});
    expect(JSON.stringify(caps)).toContain("provider-unavailable");
    expect(JSON.stringify(caps)).toContain("login-required");
  });

  test("HTTP failure statuses take precedence over identifiers and response text", async () => {
    for (const [code, expected] of [[401, "login-required"], [403, "permission-denied"], [404, "not-found"], [429, "rate-limited"], [502, "provider-failure"]] as const) {
      for (const number of [401, 403, 404, 429]) {
        const error = `GET https://${HOST}/api/v4/${PATH}/issues/${number}: ${code} {message: unavailable network resource}`;
        const r = gitlabRig({ [`${PATH}/issues/${number}`]: fail(error) });
        expect((await status(r, "gitlab_item", { ...base, kind: "issue", number })).status).toBe(expected);
      }
    }
  });

  test("pipeline pages with conflicting project IDs withhold evidence", async () => {
    const r = gitlabRig({ [`${PATH}/merge_requests/7/pipelines`]: ok([{ ...pipeline, project_id: 99 }]) });
    const result = await status(r, "gitlab_pipelines", mrInput);
    expect(result.status).toBe("identity-mismatch");
    expect(result.entries).toBeUndefined();
  });

  test("minimal MR pipeline list payloads get canonical URLs without detail fields", async () => {
    const r = gitlabRig({ [`${PATH}/merge_requests/7/pipelines`]: ok([{ id: 81, sha: HEAD, ref: "main", status: "success" }]) });
    expect(await status(r, "gitlab_pipelines", mrInput)).toMatchObject({ status: "ok", headSha: HEAD, entries: [{ id: 81, sha: HEAD, status: "success", url: pipeline.web_url }] });
    r.routes.set(`${PATH}/merge_requests/7/pipelines`, ok([{ ...pipeline, web_url: "https://elsewhere.example/pipelines/81" }]));
    expect((await status(r, "gitlab_pipelines", mrInput)).status).toBe("identity-mismatch");
  });

  test("malformed JSON, malformed pages and malformed SHAs stay visible failures", async () => {
    const unreadable = { ...ok({}), stdout: "<html>unreadable</html>" };
    expect((await status(gitlabRig({ [PATH]: unreadable }), "gitlab_project")).status).toBe("invalid-payload");
    for (const value of [{}, [null], [issue, issue, issue, issue, issue, issue]]) expect((await status(gitlabRig({ [`${PATH}/issues`]: ok(value) }), "gitlab_search", { ...base, kind: "issue" })).status).toBe("invalid-payload");
    expect((await status(gitlabRig({ [`${PATH}/merge_requests/7`]: ok({ ...mr, sha: "a".repeat(41) }) }), "gitlab_item", { ...mrInput, kind: "mr" })).status).toBe("invalid-payload");
    expect((await status(gitlabRig({ [PATH]: fail("glab: command not found") }), "gitlab_project")).status).toBe("unavailable");
  });

  test("oversized output stays structured and never becomes a cut JSON response", async () => {
    const huge = { ...issue, updated_at: "x".repeat(30_000) };
    const result = await status(gitlabRig({ [`${PATH}/issues`]: ok([huge]) }), "gitlab_search", { ...base, kind: "issue" });
    expect(result).toMatchObject({ status: "result-too-large", fetchedAt: FETCHED });
    expect(result.items).toBeUndefined();
  });

  test("call and release both enforce current policy, identity and source configuration", async () => {
    for (const change of ["policy", "scope", "transport", "principal", "forge"]) {
      const r = gitlabRig();
      r.routes.set(`${PATH}/issues/3`, () => {
        if (change === "policy") r.config.projects[0]!.policy = "local";
        if (change === "scope") r.session.scope = [];
        if (change === "transport") r.session.transport = "discord";
        if (change === "principal") r.session.principal = "someone-else";
        if (change === "forge") r.config.projects[0]!.forge!.host = "elsewhere.example";
        return ok(issue);
      });
      const result = await r.call("gitlab_item", { ...base, kind: "issue", number: 3 });
      expect(result.outcome).toBe("refused");
      expect(result.text).not.toContain(issue.description);
    }
    expect((await gitlabRig({}, { session: { route: "local", policy: "local", transport: "discord" } }).call("gitlab_project", { project: "local" })).outcome).toBe("refused");
  });
});
