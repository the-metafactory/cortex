import type { ToolsConfig } from "../../../common/types/desk-conversations";
import type { CommandResult } from "../../../surface/mc/common/spawn";
import type { ToolSession } from "../../tools/capabilities";
import { createGitlabTools, type GitlabRunner } from "../../tools/gitlab";
import { toolRig } from "./tool-host";

export const HOST = "gitlab.example.org:8443";
export const REPO = "group/nested/project.name";
export const URL = `https://${HOST}/${REPO}`;
export const PATH = `projects/${encodeURIComponent(REPO)}`;
export const HEAD = "a".repeat(40);
export const FETCHED = "2026-11-14T08:00:00.000Z";
export const ok = (value: unknown): CommandResult => ({ code: 0, signal: null, stdout: JSON.stringify(value), stderr: "" });
export const fail = (stderr: string): CommandResult => ({ code: 1, signal: null, stdout: "", stderr });
export const metadata = { id: 42, path_with_namespace: REPO, web_url: URL, visibility: "private", default_branch: "main" };
export const issue = { iid: 3, project_id: 42, web_url: `${URL}/-/issues/3`, title: "Fixture issue", description: "Authorized issue", state: "opened" };
export const mr = { iid: 7, project_id: 42, web_url: `${URL}/-/merge_requests/7`, title: "Fixture MR", description: "Authorized MR", state: "opened", sha: HEAD, head_pipeline: { id: 81 } };
export const pipeline = { id: 81, project_id: 42, sha: HEAD, web_url: `${URL}/-/pipelines/81`, status: "success", updated_at: FETCHED };
export const job = { id: 91, name: "test", stage: "test", status: "success", web_url: `${URL}/-/jobs/91`, pipeline: { id: 81, project_id: 42, sha: HEAD }, commit: { id: HEAD } };
export const gitlabConfig = (): ToolsConfig => ({ projects: [
  { id: "office", root: "/tmp/gitlab-fixture", forge: { kind: "gitlab", host: HOST, repo: REPO }, policy: "cloud", operations: ["forge.read"] },
  { id: "denied", root: "/tmp/gitlab-denied", forge: { kind: "gitlab", host: HOST, repo: "group/denied" }, policy: "cloud", operations: ["repo.read"] },
  { id: "local", root: "/tmp/gitlab-local", forge: { kind: "gitlab", host: HOST, repo: "group/private" }, policy: "local", operations: ["forge.read"] },
] });
export type Answer = CommandResult | ((argv: string[]) => CommandResult | Promise<CommandResult>);
export function gitlabRig(routes: Record<string, Answer> = {}, setup: { config?: ToolsConfig; session?: Partial<ToolSession> } = {}) {
  const config = setup.config ?? gitlabConfig();
  const session: ToolSession = { principal: "fixture", conversationId: "c", transport: "web", route: "cloud", policy: "cloud", scope: ["office", "denied", "local"], ...setup.session };
  const argvs: string[][] = [];
  const table = new Map<string, Answer>(Object.entries({ auth: ok({}), [PATH]: ok(metadata), [`${PATH}/issues/3`]: ok(issue), [`${PATH}/merge_requests/7`]: ok(mr), ...routes }));
  const run: GitlabRunner = async argv => {
    argvs.push(argv);
    const key = argv[1] === "auth" ? "auth" : argv.at(-1) ?? "";
    const answer = table.get(key) ?? table.get(key.split("?")[0] ?? "");
    if (!answer) throw new Error(`Unrecorded fixture request: ${key}`);
    return typeof answer === "function" ? answer(argv) : answer;
  };
  const { call } = toolRig({ route: session.route, config: () => config, session: () => Promise.resolve(session), tools: createGitlabTools({ run, now: () => new Date(FETCHED) }) });
  return { call, argvs, routes: table, config, session, run };
}
