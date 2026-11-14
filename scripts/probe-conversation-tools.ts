import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationInstructions, openConversationHost, type ConversationHost, type HostOptions } from "../src/conversations/host";
import type { ToolOutcome, TurnCall } from "../src/conversations/model";
import { createGithubTools } from "../src/conversations/tools/github";
import { repositoryFileTools } from "../src/conversations/tools/repository-files";
import { createRepositoryGitTools } from "../src/conversations/tools/repository-git";
import { createWebTools } from "../src/conversations/tools/web";
import { createWorkGraphTools } from "../src/conversations/tools/work-graph";
import {
  BEACON, FENCE_CLOSER, GITHUB_REPO, GRAPH_MAP_REF, GRAPH_REPO, INJECTION, LOCAL_MARKER, MAP, OTHER_PRINCIPAL, PROBE_PRINCIPAL, REPOSITORY, WEB_PAGE,
  githubFixture, graphFixture, probeCheckout, probeConfig, rangerFixture, webFixture, type RangerFixture,
} from "../src/conversations/__tests__/fixtures/conversation-tools";
import { snapshot } from "../src/conversations/__tests__/fixtures/repository-git";
import { toolBody } from "../src/conversations/__tests__/fixtures/tool-host";
import { handleConversations } from "../src/surface/mc/api/conversations";
import { buildAllowedHostnames } from "../src/surface/mc/api/mutation-guard";

type Status = "pass" | "fail" | "provisioning-needed";
interface Row { id: string; capability: string; status: Status; basis: string; evidence: string; note?: string }
interface Call { name: string; input: unknown }
type Step = Call | { mutate: () => void };
interface Proposal { proposalId: string; revision: number; digest: string }

const rows: Row[] = [];
const failedText = (error: unknown): string => error instanceof Error ? error.message : String(error);
async function step(id: string, capability: string, run: () => Promise<{ basis: string; evidence: string; note?: string }>): Promise<void> {
  try { rows.push({ id, capability, status: "pass", ...(await run()) }); }
  catch (error) { rows.push({ id, capability, status: "fail", basis: "probe assertion", evidence: "-", note: failedText(error) }); }
}
const provisioning = (id: string, capability: string, note: string): void => { rows.push({ id, capability, status: "provisioning-needed", basis: "live owner or credential outside this probe", evidence: "-", note }); };

const obj = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(obj) : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";
const body = (outcome: ToolOutcome): Record<string, unknown> => toolBody(outcome.text);
const ids = (sources: Record<string, unknown>[]): string[] => sources.map(source => text(source.source));
const toolNames = (source: Record<string, unknown>): string[] => list(source.tools).map(tool => text(tool.tool));
const availabilityOf = (source: Record<string, unknown>, tool: string): string => text(list(source.tools).find(entry => text(entry.tool) === tool)?.availability);
const findSource = (sources: Record<string, unknown>[], id: string): Record<string, unknown> => {
  const found = sources.find(source => text(source.source) === id);
  assert(found, `discovery did not list the configured source ${id}`);
  return found;
};
const proposalOf = (outcome: ToolOutcome): Proposal => {
  const view = obj(body(outcome).view);
  const proposal = obj(view.proposal);
  return { proposalId: text(proposal.proposalId), revision: Number(proposal.revision), digest: text(view.digest) };
};

const root = await mkdtemp(join(tmpdir(), "conversation-tools-probe-"));
const home = join(root, "home");
const tmp = join(root, "tmp");
await mkdir(home);
await mkdir(tmp);
Object.assign(process.env, {
  HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
});
const watchdog = setTimeout(() => {
  console.error("FAIL conversation-tools probe: the probe exceeded its 180 second bound.");
  process.exit(1);
}, 180_000);

const checkout = await probeCheckout(root);
const config = probeConfig(checkout);
const github = githubFixture();
const graph = graphFixture();
const web = webFixture();
const rangerFile = join(root, "ranger.json");
let ranger: RangerFixture = await rangerFixture(rangerFile, PROBE_PRINCIPAL);
let host: ConversationHost;
let script: Step[] = [];
let collected: ToolOutcome[] = [];
let label = "turn";
let sequence = 0;
const routes: string[] = [];
let briefProposal: Proposal | null = null;
let startProposal: Proposal | null = null;
let cancelProposal: Proposal | null = null;
let startFields: Record<string, string> | null = null;

async function turn(request: Parameters<TurnCall>[0]): Promise<Awaited<ReturnType<TurnCall>>> {
  routes.push(request.route);
  const steps = script;
  script = [];
  for (const [index, entry] of steps.entries()) {
    if ("mutate" in entry) { entry.mutate(); continue; }
    assert(request.tools, "the conversation turn has no tool surface");
    collected.push(await request.tools.call(`${label}-${index}`, entry.name, entry.input, request.signal));
  }
  return { text: `Probe turn ${label} on the ${request.route} lane.`, session: request.session, resumed: false };
}

const options: HostOptions = {
  dir: join(root, "store"), stack: "probe", label: "ai.meta-factory.cortex.probe", expectedLabel: "ai.meta-factory.cortex.probe",
  lanes: { local: { provider: "synthetic-local", model: "probe-local" }, cloud: { provider: "synthetic-cloud", model: "probe-cloud" } },
  turns: (request => turn(request)) as TurnCall,
  tools: {
    config: () => config,
    definitions: [
      ...repositoryFileTools,
      ...createRepositoryGitTools(),
      ...createGithubTools({ run: github.run, loginCacheMs: 0 }),
      ...createWorkGraphTools({ run: graph.run }),
      ...createWebTools({ config: () => config, request: web.request, resolve: web.resolve, transport: web.transport }),
    ],
  },
};

async function open(): Promise<ConversationHost> {
  const status = await openConversationHost(options);
  if (status.state !== "ready") throw new Error(status.reason);
  await status.host.attachSources({ resolvers: {}, readbacks: {}, writers: ranger.writers, workers: ranger.owner });
  return status.host;
}

async function run(conversation: string, name: string, steps: Step[], transport: "web" | "discord" = "web"): Promise<ToolOutcome[]> {
  label = name;
  script = steps;
  collected = [];
  await host.submit(conversation, { inputId: `probe-${++sequence}`, transport, text: `Probe ${name}.`, mode: "queue" });
  await host.waitForIdle(conversation);
  return collected;
}

const guard = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set<string>(), localPrincipal: PROBE_PRINCIPAL };
async function api(method: string, path: string, payload?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`http://127.0.0.1:8767/api/conversations${path}`);
  const response = await handleConversations(
    new Request(url, { method, headers: { "content-type": "application/json", host: "127.0.0.1:8767", ...headers }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }),
    url, guard, () => ({ state: "ready", host, tookOver: null, resumed: [], reconciled: [] }),
  );
  return { status: response.status, body: obj(await response.json()) };
}
const confirm = (conversation: string, proposal: Proposal, headers: Record<string, string> = {}) =>
  api("POST", `/${conversation}/proposals/${proposal.proposalId}/confirm`, { revision: proposal.revision, digest: proposal.digest }, headers);
const transcript = async (conversation: string): Promise<string> => JSON.stringify((await host.entries(conversation, 500, undefined)).entries);
const activities = async (conversation: string): Promise<Record<string, unknown>[]> =>
  (await host.entries(conversation, 500, undefined)).entries.filter(entry => entry.kind === "cortex.tool-activity").map(entry => obj(entry.data));
const evidence = (conversation: string, callId: string): string => `conversation:${conversation} cortex.tool-activity:${callId}`;

async function main(): Promise<number> {
  host = await open();
  const cloud = (await host.create({ title: "Probe cloud investigation", links: [], origin: { kind: "web" }, policy: "cloud" }, PROBE_PRINCIPAL)).id;
  const local = (await host.create({ title: "Probe local investigation", links: [], origin: { kind: "web" }, policy: "local" }, PROBE_PRINCIPAL)).id;
  const history = (await host.create({ title: "Probe earlier context", links: [], origin: { kind: "web" }, policy: "cloud" }, PROBE_PRINCIPAL)).id;
  const other = (await host.create({ title: "Probe other principal", links: [], origin: { kind: "web" }, policy: "cloud" }, OTHER_PRINCIPAL)).id;
  const revoked = (await host.create({ title: "Probe revoked scope", links: [], origin: { kind: "web" }, policy: "cloud" }, PROBE_PRINCIPAL)).id;

  await step("C1", "discovery lists configured projects and graphs with availability and blocking reasons", async () => {
    const [cloudOut] = await run(cloud, "discovery-cloud", [{ name: "capabilities", input: {} }]);
    assert(cloudOut, "the cloud turn made no tool call");
    assert.equal(cloudOut.outcome, "done");
    const cloudBody = body(cloudOut);
    const cloudSources = list(cloudBody.sources);
    assert.deepEqual(ids(cloudSources), ["sample", "desk-work"]);
    const sample = findSource(cloudSources, "sample");
    assert.equal(text(sample.policy), "cloud");
    assert.deepEqual(toolNames(sample).sort(), ["github_checks", "github_discussion", "github_item", "github_pr_diff", "github_repository", "github_search", "repo_find", "repo_git_diff", "repo_git_head", "repo_git_log", "repo_git_show", "repo_git_status", "repo_git_worktrees", "repo_list", "repo_read", "repo_search", "web_fetch", "web_search"].sort());
    for (const tool of ["repo_read", "repo_search", "github_item", "web_search", "web_fetch"]) assert.equal(availabilityOf(sample, tool), "available", `${tool} should be available on a cloud checkout`);
    assert.equal(availabilityOf(findSource(cloudSources, "desk-work"), "work_graph_node"), "available");
    const [localOut] = await run(local, "discovery-local", [{ name: "capabilities", input: {} }]);
    assert(localOut, "the local turn made no tool call");
    const localSources = list(body(localOut).sources);
    assert.deepEqual(ids(localSources), ["sample", "private", "desk-work", "private-work"]);
    assert.equal(text(findSource(localSources, "private").policy), "local");
    assert(!JSON.stringify(cloudBody).includes(LOCAL_MARKER));
    return { basis: "actual conversation host with a synthetic checkout and recorded owner protocols", evidence: evidence(cloud, "discovery-cloud-0") };
  });

  await step("C2", "repo.read returns file evidence with provenance and refuses exclusions, traversal and local-only sources", async () => {
    const outcomes = await run(cloud, "files", [
      { name: "repo_list", input: { project: "sample", path: "." } },
      { name: "repo_read", input: { project: "sample", path: "src/beacon.ts" } },
      { name: "repo_find", input: { project: "sample", query: "beacon" } },
      { name: "repo_search", input: { project: "sample", query: BEACON } },
      { name: "repo_read", input: { project: "sample", path: ".env" } },
      { name: "repo_read", input: { project: "sample", path: "excluded/note.txt" } },
      { name: "repo_read", input: { project: "sample", path: "../outside.txt" } },
      { name: "repo_read", input: { project: "sample", path: "restricted/note.txt" } },
      { name: "repo_read", input: { project: "private", path: "note.txt" } },
      { name: "repo_read", input: { project: "missing", path: "note.txt" } },
    ]);
    assert.equal(outcomes.length, 10);
    const listed = list(body(outcomes[0]!).results).map(entry => text(entry.path));
    for (const path of ["README.md", "src", "notes"]) assert(listed.includes(path), `repo_list did not report ${path}`);
    const read = list(body(outcomes[1]!).results)[0];
    assert.equal(outcomes[1]!.outcome, "done");
    assert.equal(text(read?.path), "src/beacon.ts");
    assert.equal(obj(read?.provenance).source, "working-tree");
    assert.match(text(obj(read?.provenance).sha256), /^[0-9a-f]{64}$/);
    assert.match(JSON.stringify(read?.lines), new RegExp(BEACON));
    assert.equal(outcomes[2]!.outcome, "done");
    assert(list(body(outcomes[2]!).results).some(entry => text(entry.path) === "src/beacon.ts"), "repo_find did not report the beacon file");
    assert.equal(outcomes[3]!.outcome, "done");
    assert(list(body(outcomes[3]!).results).some(entry => text(entry.path) === "src/beacon.ts"), "repo_search did not report the beacon line");
    for (const index of [4, 5, 6, 7, 8, 9]) assert.equal(outcomes[index]!.outcome, "refused", `call ${index} should be refused`);
    for (const index of [4, 5, 6, 7]) assert.equal(body(outcomes[index]!).disclosedBytes, 0, `call ${index} disclosed bytes`);
    assert(!(await transcript(cloud)).includes(LOCAL_MARKER), "the local-only marker reached the cloud conversation record");
    return { basis: "real temporary checkout, real file tools through the conversation host", evidence: evidence(cloud, "files-3") };
  });

  await step("C3", "repo.read Git evidence matches direct Git and leaves the repository bytes unchanged", async () => {
    const before = await snapshot(checkout.root);
    const outcomes = await run(cloud, "git", [
      { name: "repo_git_head", input: { project: "sample" } },
      { name: "repo_git_status", input: { project: "sample" } },
      { name: "repo_git_log", input: { project: "sample", path: "README.md", limit: 5 } },
      { name: "repo_git_show", input: { project: "sample", ref: checkout.head } },
      { name: "repo_git_diff", input: { project: "sample", kind: "working", path: "README.md" } },
    ]);
    assert.equal(outcomes.length, 5);
    for (const outcome of outcomes) assert.equal(outcome.outcome, "done");
    assert.equal(text(obj(body(outcomes[0]!).provenance).branch), "probe");
    assert.equal(text(obj(body(outcomes[0]!).provenance).revision), checkout.head);
    const changes = list(body(outcomes[1]!).changes);
    assert(changes.some(change => text(change.path) === "README.md" && text(change.index) === "M"));
    assert(changes.some(change => text(change.path) === "untracked.txt" && change.tracked === false));
    const commits = list(body(outcomes[2]!).commits);
    assert.equal(text(commits[0]?.revision), checkout.head);
    assert.equal(text(commits[0]?.subject), "Synthetic readme change");
    assert.equal(text(obj(body(outcomes[3]!).commit).subject), "Synthetic readme change");
    assert.match(text(body(outcomes[3]!).diff), /README\.md/);
    assert.match(text(body(outcomes[4]!).diff), /unstaged line/);
    assert.deepEqual(await snapshot(checkout.root), before);
    return { basis: "real Git commands under the isolated view, compared with a whole-repository hash", evidence: evidence(cloud, "git-4") };
  });

  await step("C4", "forge.read reads the configured GitHub repository through the recorded gh protocol and pins host and repository", async () => {
    const outcomes = await run(cloud, "forge", [
      { name: "github_repository", input: { project: "sample" } },
      { name: "github_item", input: { project: "sample", number: 7 } },
    ]);
    assert.equal(outcomes.length, 2);
    const repository = body(outcomes[0]!);
    assert.equal(outcomes[0]!.outcome, "done");
    assert.equal(text(repository.status), "ok");
    assert.equal(text(obj(repository.repository).fullName), GITHUB_REPO);
    assert.equal(text(obj(repository.source).url), `https://github.com/${GITHUB_REPO}`);
    assert(text(repository.fetchedAt) !== "");
    const item = body(outcomes[1]!);
    assert.equal(outcomes[1]!.outcome, "done");
    assert.equal(Number(obj(item.item).number), 7);
    assert.equal(text(obj(item.item).url), `https://github.com/${GITHUB_REPO}/issues/7`);
    assert(github.calls.every(argv => argv[0] === "gh" && argv.includes("--hostname") && argv[argv.indexOf("--hostname") + 1] === "github.com"), "a gh call left the configured host");
    assert(github.calls.filter(argv => argv[1] === "api").every(argv => (argv.at(-1) ?? "").startsWith(`repos/${GITHUB_REPO}`)), "a gh call left the configured repository");
    return { basis: "recorded gh protocol, not a live GitHub login", evidence: evidence(cloud, "forge-1") };
  });

  await step("C5", "graph.read reads the configured map and node through the recorded soma protocol and runs no write verb", async () => {
    const outcomes = await run(cloud, "graph", [
      { name: "work_graph_maps", input: { graph: "desk-work" } },
      { name: "work_graph_node", input: { graph: "desk-work", map: "desk", node: "12" } },
    ]);
    assert.equal(outcomes.length, 2);
    const maps = body(outcomes[0]!);
    assert.equal(outcomes[0]!.outcome, "done");
    assert.equal(text(maps.status), "ok");
    assert.equal(text(list(maps.maps)[0]?.ref), GRAPH_MAP_REF);
    assert.equal(text(list(maps.maps)[0]?.status), "available");
    const node = body(outcomes[1]!);
    assert.equal(outcomes[1]!.outcome, "done");
    assert.equal(text(obj(node.node).ref), GRAPH_MAP_REF);
    assert.equal(text(obj(node.node).state), "open");
    assert.equal(text(obj(node.node).snapshot), "live");
    const verbs = graph.calls.map(argv => argv[2] ?? "");
    assert(verbs.every(verb => ["maps", "node", "frontier", "audit", "decisions"].includes(verb)), `a graph write verb ran: ${verbs.join(",")}`);
    assert(graph.calls.every(argv => argv.includes("--read-repo") && argv[argv.indexOf("--read-repo") + 1] === GRAPH_REPO), "a graph read left the configured scope");
    return { basis: "recorded soma protocol, not a live work-graph owner", evidence: evidence(cloud, "graph-1") };
  });

  await step("C6", "web.read searches and fetches through the configured provider and refuses a local-only conversation", async () => {
    const outcomes = await run(cloud, "web", [
      { name: "web_search", input: { project: "sample", query: "synthetic evidence" } },
      { name: "web_fetch", input: { project: "sample", url: "https://example.invalid/doc" } },
    ]);
    assert.equal(outcomes.length, 2);
    const search = body(outcomes[0]!);
    assert.equal(outcomes[0]!.outcome, "done");
    assert.equal(text(search.status), "ok");
    assert.equal(text(list(search.results)[0]?.url), "https://example.invalid/doc");
    assert.equal(search.untrusted, true);
    const page = body(outcomes[1]!);
    assert.equal(outcomes[1]!.outcome, "done");
    assert.equal(text(page.status), "ok");
    assert.match(text(page.text), new RegExp(WEB_PAGE));
    assert.equal(page.untrusted, true);
    assert(web.queries.every(url => url.startsWith("http://search.example.invalid:8888/search?")), "a search left the configured provider");
    const localOutcomes = await run(local, "web-local", [
      { name: "web_search", input: { project: "sample", query: "synthetic evidence" } },
      { name: "web_fetch", input: { project: "sample", url: "https://example.invalid/doc" } },
    ]);
    for (const outcome of localOutcomes) assert.equal(outcome.outcome, "refused", "a local-only conversation reached the web");
    return { basis: "injected search requester and fetch transport, not a live search provider", evidence: evidence(cloud, "web-1") };
  });

  await step("C7", "a local-only checkout is refused in a cloud conversation and read in a local one", async () => {
    const cloudOutcomes = await run(cloud, "local-denial", [
      { name: "repo_read", input: { project: "private", path: "note.txt" } },
      { name: "repo_read", input: { project: "sample", path: "restricted/note.txt" } },
    ]);
    for (const outcome of cloudOutcomes) assert.equal(outcome.outcome, "refused", "a cloud conversation read a local-only source");
    const localOutcomes = await run(local, "local-read", [
      { name: "repo_read", input: { project: "private", path: "note.txt" } },
      { name: "repo_read", input: { project: "sample", path: "restricted/note.txt" } },
    ]);
    assert.equal(localOutcomes[0]!.outcome, "done");
    assert.match(JSON.stringify(body(localOutcomes[0]!)), new RegExp(LOCAL_MARKER));
    assert.equal(localOutcomes[1]!.outcome, "done");
    assert.equal(text(obj(localOutcomes[1]!.source).policy), "local");
    return { basis: "real checkout with a nested local-only project, on both lanes", evidence: evidence(local, "local-read-0") };
  });

  await step("C8", "each configured lane answers on its own route and the record names the lane", async () => {
    await run(cloud, "lane-cloud", [{ name: "capabilities", input: {} }]);
    await run(local, "lane-local", [{ name: "capabilities", input: {} }]);
    const cloudTurns = await host.exchange(cloud);
    const localTurns = await host.exchange(local);
    assert(cloudTurns.length > 0 && cloudTurns.every(turn => turn.model === "synthetic-cloud/probe-cloud"), `a cloud turn named another model: ${cloudTurns.map(turn => turn.model).join(",")}`);
    assert(localTurns.length > 0 && localTurns.every(turn => turn.model === "synthetic-local/probe-local"), `a local turn named another model: ${localTurns.map(turn => turn.model).join(",")}`);
    assert(routes.includes("cloud") && routes.includes("local"));
    return { basis: "conversation record of each turn, no fallback lane", evidence: evidence(cloud, "lane-cloud-0") };
  });

  await step("C9", "earlier authorized conversations are searchable and readable with entry citations", async () => {
    const [search] = await run(history, "history-search", [{ name: "conversation_search", input: { query: "Probe turn", state: "all" } }]);
    assert(search, "the history turn made no tool call");
    assert.equal(search.outcome, "done");
    const found = body(search);
    assert.equal(text(found.status), "ok");
    const match = list(found.matches).find(entry => text(obj(entry.conversation).id) === cloud);
    assert(match, "the earlier cloud conversation was not found");
    assert.equal(text(obj(match.conversation).url), `?desk=conversation&conversation=${cloud}`);
    assert(text(obj(match.entry).url).startsWith(`/api/conversations/${cloud}/entries/`));
    const entryId = text(obj(match.entry).id);
    const [read] = await run(history, "history-read", [{ name: "conversation_read", input: { conversation: cloud, entry: Number(entryId) } }]);
    assert(read, "the read turn made no tool call");
    assert.equal(read.outcome, "done");
    assert.equal(text(body(read).status), "ok");
    assert.equal(text(obj(body(read).conversation).id), cloud);
    assert.equal(text(obj(body(read).entry).id), entryId);
    return { basis: "two conversations of the same principal through the durable history owner", evidence: evidence(history, "history-search-0") };
  });

  await step("C10", "a proposal is prepared by the conversation, confirmed once through the API, and read back from the owner", async () => {
    const proposalId = randomUUID();
    const [brief] = await run(cloud, "brief", [{ name: "worker_brief", input: { proposalId, repository: REPOSITORY, map: MAP, parent: MAP, title: "Probe the digest renderer", scope: "Only the digest renderer, no provider code.", acceptanceChecks: ["The digest is shorter than before.", "The mail tests pass."], checkpoint: "digest-slim", budget: { tokens: 200_000, minutes: 60 } } }]);
    assert(brief, "the brief turn made no tool call");
    assert.equal(brief.outcome, "done");
    assert.equal(text(body(brief).status), "pending");
    assert.equal(ranger.records().creates.length, 0, "the conversation filed a node without confirmation");
    briefProposal = proposalOf(brief);
    const confirmed = await confirm(cloud, briefProposal);
    assert.equal(confirmed.status, 200);
    const operation = obj(obj(confirmed.body.proposal).operation);
    assert.equal(text(operation.state), "created");
    assert.equal(text(operation.canonicalId), "example/maps#101");
    assert.deepEqual(ranger.records().briefs, ["example/maps#101"]);
    const replay = await confirm(cloud, briefProposal);
    assert.equal(replay.status, 200);
    assert.deepEqual(obj(replay.body.proposal).operation, operation);
    assert.equal(ranger.records().briefs.length, 1, "a replayed confirmation filed a second node");
    const [checked] = await run(cloud, "brief-check", [{ name: "creation_read_result", input: { proposalId } }]);
    assert(checked, "the check turn made no tool call");
    assert.equal(text(body(checked).status), "created");
    assert.equal(text(obj(obj(body(checked).view).operation).canonicalId), "example/maps#101");
    assert.equal(text(obj(body(checked).links).object), "https://github.example.invalid/example/maps/issues/101");
    return { basis: "conversation tool proposal, API confirmation, owner readback", evidence: evidence(cloud, "brief-0") };
  });

  await step("C11", "worker state and cancellation act on the exact recorded generation and never start a second worker", async () => {
    const [status] = await run(cloud, "status-prepared", [{ name: "worker_status", input: { node: "example/maps#101" } }]);
    assert(status, "the status turn made no tool call");
    assert.equal(status.outcome, "done");
    assert.equal(text(body(status).state), "prepared");
    assert.equal(body(status).generation, null);
    assert.equal(body(status).deployed, false);
    const [start] = await run(cloud, "start", [{ name: "worker_start", input: { proposalId: randomUUID(), node: "example/maps#101" } }]);
    assert(start, "the start turn made no tool call");
    assert.equal(text(body(start).status), "pending");
    assert.equal(ranger.records().starts.length, 0, "the conversation started a worker without confirmation");
    startProposal = proposalOf(start);
    startFields = Object.fromEntries(Object.entries(obj(obj(obj(body(start).view).proposal).fields)).map(([key, value]) => [key, String(value)]));
    const started = await confirm(cloud, startProposal);
    assert.equal(started.status, 200);
    assert.deepEqual(ranger.records().starts, ["example/maps#101"]);
    assert.equal(ranger.records().nodes["example/maps#101"]?.generation, 1);
    const [running] = await run(cloud, "status-running", [{ name: "worker_status", input: { node: "example/maps#101" } }]);
    assert(running, "the status turn made no tool call");
    assert.equal(text(body(running).state), "running");
    assert.equal(body(running).active, true);
    assert.equal(body(running).generation, 1);
    const [again] = await run(cloud, "start-again", [{ name: "worker_start", input: { proposalId: randomUUID(), node: "example/maps#101" } }]);
    assert(again, "the second start turn made no tool call");
    assert.equal(text(body(again).status), "already-started");
    assert.equal(ranger.records().starts.length, 1, "a second worker was started");
    const [cancel] = await run(cloud, "cancel", [{ name: "worker_cancel", input: { proposalId: randomUUID(), node: "example/maps#101" } }]);
    assert(cancel, "the cancel turn made no tool call");
    assert.equal(text(body(cancel).status), "pending");
    assert.equal(ranger.records().stops.length, 0, "the conversation stopped a worker without confirmation");
    cancelProposal = proposalOf(cancel);
    const cancelled = await confirm(cloud, cancelProposal);
    assert.equal(cancelled.status, 200);
    assert.deepEqual(ranger.records().stops, ["example/maps#101"]);
    assert.equal(ranger.records().nodes["example/maps#101"]?.state, "cancelled");
    const replay = await confirm(cloud, cancelProposal);
    assert.equal(replay.status, 200);
    assert.equal(ranger.records().stops.length, 1, "a replayed cancellation stopped a second worker");
    const [stopped] = await run(cloud, "cancel-again", [{ name: "worker_cancel", input: { proposalId: randomUUID(), node: "example/maps#101" } }]);
    assert(stopped, "the second cancel turn made no tool call");
    assert.equal(text(body(stopped).status), "not-active");
    const [unknown] = await run(cloud, "cancel-unknown", [{ name: "worker_cancel", input: { proposalId: randomUUID(), node: "example/maps#999" } }]);
    assert(unknown, "the unknown cancel turn made no tool call");
    assert.equal(text(body(unknown).status), "refused");
    return { basis: "owner-recorded worker state and exact generations", evidence: evidence(cloud, "cancel-0") };
  });

  await step("C12", "a node the owner will not run automatically is reported as awaiting approval and its autonomy is unchanged", async () => {
    ranger.refuseStart("node 101 routes escalate-hitl: it waits for the principal.");
    try {
      const [start] = await run(cloud, "start-refused", [{ name: "worker_start", input: { proposalId: randomUUID(), node: "example/maps#101" } }]);
      assert(start, "the refused start turn made no tool call");
      assert.equal(start.outcome, "done");
      assert.equal(text(body(start).status), "pending");
      const confirmed = await confirm(cloud, proposalOf(start));
      assert.equal(confirmed.status, 409, JSON.stringify(confirmed.body));
      assert.equal(text(obj(obj(confirmed.body.proposal).operation).state), "failed");
      assert.match(text(confirmed.body.error), /waits for the principal/);
      assert.equal(ranger.records().starts.length, 1, "a refused start still started a worker");
    } finally { ranger.refuseStart(null); }
    return { basis: "owner refusal surfaced as awaiting approval, no autonomy change", evidence: evidence(cloud, "start-refused-0") };
  });

  await step("C13", "another principal cannot read this principal's history, worker state or proposals", async () => {
    const [search] = await run(other, "other-history", [{ name: "conversation_search", input: { query: "Probe turn", state: "all" } }]);
    assert(search, "the other principal's turn made no tool call");
    assert.equal(search.outcome, "done");
    assert.equal(text(body(search).status), "no-match");
    const [status] = await run(other, "other-status", [{ name: "worker_status", input: { node: "example/maps#101" } }]);
    assert(status, "the other principal's status turn made no tool call");
    assert.equal(status.outcome, "done");
    assert.equal(text(body(status).status), "unauthorized");
    const [brief] = await run(cloud, "brief-other", [{ name: "worker_brief", input: { proposalId: randomUUID(), repository: REPOSITORY, map: MAP, parent: MAP, title: "Another principal's brief", scope: "Nothing.", acceptanceChecks: ["Nothing."], checkpoint: "nothing", budget: { tokens: 1_000, minutes: 1 } } }]);
    assert(brief, "the brief turn made no tool call");
    const denied = await confirm(cloud, proposalOf(brief), { "cf-access-authenticated-user-email": OTHER_PRINCIPAL });
    assert.equal(denied.status, 403);
    assert.equal(ranger.records().briefs.length, 1, "another principal confirmed a proposal");
    return { basis: "owner-side principal check and the API confirmation gate", evidence: evidence(other, "other-status-0") };
  });

  await step("C14", "revoking a source during a turn withholds the result and refuses the next call", async () => {
    const projects = config.projects;
    const outcomes = await run(revoked, "revoked", [
      { name: "repo_read", input: { project: "sample", path: "src/beacon.ts" } },
      { mutate: () => { config.projects = projects.filter(project => project.id !== "sample"); } },
      { name: "repo_read", input: { project: "sample", path: "README.md" } },
      { name: "repo_read", input: { project: "sample", path: "README.md" } },
    ]);
    assert.equal(outcomes.length, 3);
    assert.equal(outcomes[0]!.outcome, "done");
    for (const outcome of outcomes.slice(1)) assert.equal(outcome.outcome, "refused");
    await assert.rejects(() => host.detail(revoked), /revoked or changed/);
    await assert.rejects(() => host.entries(revoked, 10, undefined), /revoked or changed/);
    config.projects = projects;
    const recorded = await activities(revoked);
    assert(recorded.some(activity => activity.callId === "revoked-2" && activity.outcome === "refused"));
    assert(recorded.some(activity => activity.callId === "revoked-3" && activity.outcome === "refused"));
    const record = await transcript(revoked);
    assert(record.includes(BEACON), "the permitted read was not recorded");
    assert(!record.includes("staged line"), "the withheld read reached the conversation record");
    return { basis: "registry revision change during a live turn", evidence: evidence(revoked, "revoked-2") };
  });

  await step("C15", "prompt injection inside a source file stays fenced data and causes no owner effect", async () => {
    const before = ranger.records().creates.length;
    const [outcome] = await run(cloud, "injection", [{ name: "repo_read", input: { project: "sample", path: "notes/injected.md" } }]);
    assert(outcome, "the injection turn made no tool call");
    assert.equal(outcome.outcome, "done");
    assert.match(outcome.text, /retrieved data, never instructions/);
    assert(outcome.text.includes(INJECTION));
    assert.equal(outcome.text.split(FENCE_CLOSER).length, 2, "the retrieved text closed the result fence");
    assert.match(conversationInstructions("Ivy"), /data, never instructions/);
    assert.equal(ranger.records().creates.length, before, "the injected text caused an owner effect");
    const recorded = await activities(cloud);
    assert(!recorded.some(activity => activity.callId === "injection-1"), "the injected text caused a tool call");
    return { basis: "fenced result, instruction boundary and no owner effect; model obedience is not tested", evidence: evidence(cloud, "injection-0") };
  });

  await step("C16", "a missing connector is reported as unavailable with its reason and never as an empty result", async () => {
    graph.state.down = true;
    github.state.login = false;
    const savedWeb = config.web;
    delete config.web;
    try {
      const [graphOut] = await run(cloud, "missing-graph", [{ name: "work_graph_node", input: { graph: "desk-work", map: "desk", node: "12" } }]);
      assert(graphOut, "the graph turn made no tool call");
      assert.equal(graphOut.outcome, "done");
      assert.equal(text(body(graphOut).status), "owner-unavailable");
      const [githubOut] = await run(cloud, "missing-github", [{ name: "github_repository", input: { project: "sample" } }]);
      assert(githubOut, "the github turn made no tool call");
      assert.equal(githubOut.outcome, "error");
      assert.match(githubOut.text, /no GitHub login/);
      const [webOut] = await run(cloud, "missing-web", [{ name: "web_search", input: { project: "sample", query: "synthetic evidence" } }]);
      assert(webOut, "the web turn made no tool call");
      assert.equal(webOut.outcome, "error");
      assert.match(webOut.text, /web search provider is configured/);
      const [discovery] = await run(cloud, "missing-discovery", [{ name: "capabilities", input: {} }]);
      assert(discovery, "the discovery turn made no tool call");
      const sample = findSource(list(body(discovery).sources), "sample");
      assert.equal(availabilityOf(sample, "web_search"), "dependency-missing");
      assert.equal(availabilityOf(sample, "github_repository"), "provider-unavailable");
    } finally {
      graph.state.down = false;
      github.state.login = true;
      config.web = savedWeb;
    }
    return { basis: "owner command failure, missing login and missing provider setting", evidence: evidence(cloud, "missing-web-0") };
  });

  await step("C17", "a restart reads the owner's recorded state and replays no duplicate effect", async () => {
    await host.close();
    ranger = await rangerFixture(rangerFile, PROBE_PRINCIPAL);
    host = await open();
    const [status] = await run(cloud, "restart-status", [{ name: "worker_status", input: { node: "example/maps#101" } }]);
    assert(status, "the restart status turn made no tool call");
    assert.equal(status.outcome, "done");
    assert.equal(text(body(status).state), "cancelled");
    assert.equal(body(status).generation, 1);
    assert(briefProposal && startProposal && cancelProposal, "the recorded proposals were lost");
    const before = ranger.records();
    const briefs = before.briefs.length;
    const starts = before.starts.length;
    const stops = before.stops.length;
    for (const proposal of [briefProposal, startProposal, cancelProposal]) {
      const replay = await confirm(cloud, proposal);
      assert.equal(replay.status, 200);
    }
    const after = ranger.records();
    assert.equal(after.briefs.length, briefs, "a restart replayed a brief into a second node");
    assert.equal(after.starts.length, starts, "a restart replayed a start into a second worker");
    assert.equal(after.stops.length, stops, "a restart replayed a stop into a second cancellation");
    assert(startFields, "the recorded start proposal fields were lost");
    const [duplicate] = await run(cloud, "restart-propose", [{ name: "creation_propose", input: { proposalId: startProposal.proposalId, type: "work-start", fields: startFields } }]);
    assert(duplicate, "the duplicate turn made no tool call");
    assert.equal(duplicate.outcome, "done");
    assert.equal(body(duplicate).duplicate, true);
    assert.equal(ranger.records().starts.length, starts, "a replayed proposal started a second worker");
    return { basis: "host restart with a fresh owner fixture reading the same owner file", evidence: evidence(cloud, "restart-status-0") };
  });

  provisioning("P1", "live GitHub forge read", "needs a gh login on the host and a configured real checkout; this probe records the protocol only");
  provisioning("P2", "live GitLab forge read", "needs a glab login and a configured GitLab project; scripts/probe-ivy-tools-gitlab.ts records the protocol only");
  provisioning("P3", "live work-graph owner read", "needs the soma CLI and a registered map on the host");
  provisioning("P4", "live web search and fetch", "needs a configured search provider and public egress");
  provisioning("P5", "live Ranger worker start, status and stop", "needs a configured mc.desk.workers block and a running Ranger supervisor");
  provisioning("P6", "live provider and model quality on each lane", "needs configured provider credentials; this probe scripts the model turn");
  provisioning("P7", "deployed stack read-only investigation", "needs a running stack and the principal's conversation; run the recipe in docs/conversation-tools.md");
  return rows.filter(row => row.status === "fail").length;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  rows.push({ id: "X1", capability: "probe harness", status: "fail", basis: "probe harness", evidence: "-", note: failedText(error) });
} finally {
  await host!.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
const removed = await stat(root).then(() => false, () => true);
rows.push(removed
  ? { id: "X2", capability: "probe cleanup", status: "pass", basis: "temporary root removal", evidence: "probe root removed" }
  : { id: "X2", capability: "probe cleanup", status: "fail", basis: "temporary root removal", evidence: root, note: "the probe root still exists" });
clearTimeout(watchdog);

const failures = rows.filter(row => row.status === "fail");
const passed = rows.filter(row => row.status === "pass").length;
const pending = rows.filter(row => row.status === "provisioning-needed").length;
for (const row of rows) {
  console.log(`${row.status === "pass" ? "PASS" : row.status === "fail" ? "FAIL" : "NEEDS"} ${row.id} ${row.capability}`);
  console.log(`     basis: ${row.basis}`);
  console.log(`     evidence: ${row.evidence}`);
  if (row.note) console.log(`     note: ${row.note}`);
}
console.log(`\nconversation-tools probe: ${passed} passed, ${failures.length} failed, ${pending} provisioning-needed.`);
console.log("All fixtures are synthetic: a temporary checkout, recorded owner protocols and disposable owner files. No credential, account or deployed stack was touched.");
if (failures.length > 0 || exitCode !== 0) {
  console.error(`FAIL conversation-tools probe: ${failures.map(row => row.id).join(", ") || "the probe did not finish"}`);
  process.exit(1);
}
console.log("PASS conversation-tools probe: the conversation tool boundary holds on the actual host path; live owners remain provisioning-needed.");
process.exit(0);
