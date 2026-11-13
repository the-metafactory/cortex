import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { handleDeskRuling } from "../api/desk-ruling";
import { HandledLedger, type RangerRunResult } from "../desk/actions";
import { composeDesk, type DeskOptions } from "../desk/compose";
import { agentQuestion, explainRuling, githubRef, readNodeBody, RULING_FALLBACK, RulingExplainLoop, RulingLedger, somaRepo } from "../desk/ruling";
import { fetchGitlabIssue, type GitLabFetchErrorKind } from "../adapters/gitlab/fetch";
import { GLAB_STATUS_ARGV } from "../adapters/gitlab/hosts";
import { CommandTimeout, runCommand, type CommandResult } from "../common/spawn";
import { GITLAB_BLOCKED, GITLAB_BODY, GITLAB_EXPLAINED } from "./fixtures/gitlab-ruling";
import type { RangerNeedsYou, RangerState } from "../desk/sources/ranger";
import { McSchema } from "../../../common/types/config";
import { initDatabase } from "../db/init";

const NOW = Date.parse("2026-10-31T09:00:00.000Z");
const KEY = "ranger:example/app#12";

const DESK: DeskOptions = {
  enabled: true,
  displayName: "Ada",
  topN: 5,
  rangerUrl: "http://127.0.0.1:7311",
  rangerCli: { bin: "/opt/ranger/bin/ranger", config: "" },
  somaBin: "/opt/soma/bin/soma",
  areas: [],
  sources: [],
};

function rangerState(): RangerState {
  return {
    current: [],
    needsYou: [{
      key: "example/app#1", repo: "example/app", nodeId: "12", title: "Pick the export format", status: "parked",
      url: "https://github.com/example/app/issues/12", endedAt: "2026-10-31T08:00:00.000Z",
      reason: { class: "blocked", detail: "resume once: the principal picks CSV or JSON, — Blocked: the spec names both formats." },
      actions: { resume: true },
    }, {
      key: "example/app#1", repo: "example/app", nodeId: "13", title: "Fix the login timeout", status: "failed",
      endedAt: "2026-10-31T07:00:00.000Z", reason: { class: "worker failed" }, actions: { resume: true },
    }],
    maps: [],
  };
}

const fetchRanger = (state: RangerState) => async () => Response.json(state);

describe("reading a ruling body from its forge", () => {
  const result = (stdout: string, code = 0, stderr = ""): CommandResult => ({ stdout, code, stderr, signal: null });
  const knownHost = (run: (argv: string[], timeoutMs: number) => Promise<CommandResult>) => async (argv: string[], timeoutMs: number) =>
    argv[1] === "auth" ? result("", 1, "✓ Logged in to gitlab.example.org as example\n") : run(argv, timeoutMs);
  const readGitlab = (run: (argv: string[], timeoutMs: number) => Promise<CommandResult>) =>
    readNodeBody(GITLAB_BLOCKED.repo, GITLAB_BLOCKED.nodeId, { gitlab: (ref) => fetchGitlabIssue(ref, { run: knownHost(run) }) });

  it("never sends an API request to a host absent from glab logins", async () => {
    for (const status of [result(""), result("", 1, "HTTP 401: no token"), result("✓ Logged in to other.example.org as example"), result("not a status response")]) {
      const calls: string[][] = [];
      const body = await readNodeBody(GITLAB_BLOCKED.repo, GITLAB_BLOCKED.nodeId, {
        gitlab: ref => fetchGitlabIssue(ref, { run: async argv => { calls.push(argv); return status; } }),
      });
      expect(body).toBeNull();
      expect(calls).toEqual([GLAB_STATUS_ARGV]);
      expect(await explainRuling(GITLAB_BLOCKED, body, async () => { throw new Error("must not explain unread body"); })).toEqual({ kind: "unexplained", line: RULING_FALLBACK });
    }
  });

  it("classifies missing or timed-out host discovery without calling the API", async () => {
    for (const [error, kind] of [[new Error("ENOENT: glab"), "spawn_failed"], [new CommandTimeout("timeout"), "timeout"]] as const) {
      const calls: string[][] = [];
      expect(await fetchGitlabIssue({ host: "gitlab.example.org", path: "group/app", number: 12 }, {
        run: async argv => { calls.push(argv); throw error; },
      })).toMatchObject({ kind });
      expect(calls).toEqual([GLAB_STATUS_ARGV]);
    }
  });

  it("only calls the issue API after discovering the named login", async () => {
    const calls: string[][] = [];
    expect(await fetchGitlabIssue({ host: "gitlab.example.org", path: "group/app", number: 12 }, {
      run: async argv => {
        calls.push(argv);
        return argv[1] === "auth"
          ? result("✓ Logged in to other.example.org as example", 1, "✓ Logged in to gitlab.example.org as example")
          : result(JSON.stringify({ iid: 12, description: GITLAB_BODY }));
      },
    })).toEqual({ body: GITLAB_BODY });
    expect(calls).toEqual([GLAB_STATUS_ARGV, ["glab", "api", "--hostname", "gitlab.example.org", "--method", "GET", "projects/group%2Fapp/issues/12"]]);
  });

  it("reads the validated GitLab project on the named host and explains its body", async () => {
    const body = await readGitlab(async (argv, timeoutMs) => {
      expect(argv).toEqual(["glab", "api", "--hostname", "gitlab.example.org", "--method", "GET", "projects/group%2Fsubgroup%2Fapp/issues/12"]);
      expect(timeoutMs).toBe(30_000);
      return result(JSON.stringify({ iid: 12, description: GITLAB_BODY }));
    });
    expect(body).toBe(GITLAB_BODY);
    let request = "";
    const explanation = await explainRuling(GITLAB_BLOCKED, body, async (prompt) => {
      request = prompt;
      return GITLAB_EXPLAINED;
    });
    expect(JSON.parse(request)).toMatchObject({ repo: GITLAB_BLOCKED.repo, node: "12", body: GITLAB_BODY.trim() });
    expect(explanation).toEqual({ kind: "explained", explanation: GITLAB_EXPLAINED });
  });

  it("still reads bare GitHub repositories through the existing reader", async () => {
    const calls: unknown[] = [];
    const body = await readNodeBody("example/app", "12", { github: async (ref) => {
      calls.push(ref);
      return { type: "issue", state: "open", title: "Export", labels: [], body: "GitHub body", html_url: "https://github.com/example/app/issues/12" };
    }, gitlab: async () => { throw new Error("GitLab must not read GitHub"); } });
    expect(body).toBe("GitHub body");
    expect(calls).toEqual([{ owner: "example", repo: "app", number: 12 }]);
  });

  it("reads nothing for malformed repositories and invalid GitLab node ids", async () => {
    const calls: unknown[] = [];
    const unreadable = async (ref: unknown) => { calls.push(ref); return { kind: "not_found" as const, message: "unreadable" }; };
    for (const repo of ["--repo", "https://gitlab.example.org/group/app", "gitlab:--hostname/group/app", "gitlab:gitlab.example.org/group/../app", "gitlab:gitlab.example.org/group/app?x=1", "gitlab:gitlab.example.org/group/app;echo", "gitlab:gitlab.example.org/group//app", "gitlab:gitlab.example.org/app", " gitlab:gitlab.example.org/group/app", "other:gitlab.example.org/group/app"]) {
      expect(await readNodeBody(repo, "12", { github: unreadable, gitlab: unreadable })).toBeNull();
    }
    for (const nodeId of ["0", "-1", "12;echo", "12/notes", "1.5", "01", "9007199254740993"]) {
      expect(await readNodeBody(GITLAB_BLOCKED.repo, nodeId, { github: unreadable, gitlab: unreadable })).toBeNull();
    }
    expect(calls).toEqual([]);
    expect(await fetchGitlabIssue({ host: "--hostname", path: "group/app", number: 12 }, { run: async () => { throw new Error("must not run"); } })).toMatchObject({ kind: "invalid_ref" });
  });

  const failures: { name: string; kind: GitLabFetchErrorKind; run: () => Promise<CommandResult> }[] = [
    { name: "no token", kind: "unauthorized", run: async () => result("", 1, "glab auth login: no token") },
    { name: "401", kind: "unauthorized", run: async () => result("", 1, "HTTP 401: Unauthorized") },
    { name: "403", kind: "unauthorized", run: async () => result("", 1, "HTTP 403: Forbidden") },
    { name: "404", kind: "not_found", run: async () => result("", 1, "HTTP 404: Not Found") },
    { name: "rate limit", kind: "rate_limited", run: async () => result("", 1, "HTTP 429: rate limit") },
    { name: "upstream", kind: "upstream", run: async () => result("", 1, "HTTP 500") },
    { name: "missing glab", kind: "spawn_failed", run: async () => { throw new Error("ENOENT: glab"); } },
    { name: "timeout", kind: "timeout", run: async () => { throw new CommandTimeout("timeout"); } },
    ...["not JSON", "null", "[]", "{}", '{"iid":13,"description":"wrong issue"}', '{"iid":12,"description":42}'].map(stdout => ({ name: stdout, kind: "parse_error" as const, run: async () => result(stdout) })),
  ];
  for (const failure of failures) {
    it(`falls back without asking the explainer after ${failure.name}`, async () => {
      expect(await fetchGitlabIssue({ host: "gitlab.example.org", path: "group/app", number: 12 }, { run: knownHost(failure.run) })).toMatchObject({ kind: failure.kind });
      const body = await readGitlab(failure.run);
      expect(body).toBeNull();
      let asked = false;
      expect(await explainRuling(GITLAB_BLOCKED, body, async () => { asked = true; return GITLAB_EXPLAINED; })).toEqual({ kind: "unexplained", line: RULING_FALLBACK });
      expect(asked).toBe(false);
    });
  }

  it("uses the bounded runner to time out a stalled process", async () => {
    expect(await fetchGitlabIssue({ host: "gitlab.example.org", path: "group/app", number: 12 }, {
      timeoutMs: 20,
      run: knownHost((_argv, timeoutMs) => runCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], timeoutMs, undefined, undefined, true)),
    })).toMatchObject({ kind: "timeout" });
  });

  it("keeps a null or empty GitLab description on the fallback path", async () => {
    for (const description of [null, ""]) {
      const body = await readGitlab(async () => result(JSON.stringify({ iid: 12, description })));
      expect(body).toBe(description);
      expect(await explainRuling(GITLAB_BLOCKED, body, async () => GITLAB_EXPLAINED)).toEqual({ kind: "unexplained", line: RULING_FALLBACK });
    }
  });
});

function runner(result: RangerRunResult = { code: 0, stdout: "", stderr: "" }) {
  const calls: { argv: string[]; file: string | null }[] = [];
  return {
    calls,
    run: async (argv: string[]) => {
      const at = argv.indexOf("--text-file");
      calls.push({ argv, file: at >= 0 ? readFileSync(argv[at + 1] ?? "", "utf8") : null });
      return result;
    },
  };
}

const post = (body: unknown): Request =>
  new Request("http://localhost/api/desk/ruling", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

interface Setup {
  soma?: ReturnType<typeof runner>;
  ranger?: ReturnType<typeof runner>;
  state?: RangerState;
  desk?: DeskOptions;
}

function setup({ soma = runner(), ranger = runner(), state = rangerState(), desk = DESK }: Setup = {}) {
  const runtime = { options: desk, ledger: new HandledLedger(), rulings: new RulingLedger() };
  const rule = (body: unknown) => handleDeskRuling(post(body), runtime, { soma: soma.run, ranger: ranger.run, fetchImpl: fetchRanger(state), now: () => NOW });
  return { runtime, soma, ranger, rule };
}

const RULING = { key: KEY, text: "--repo evil\nUse JSON; CSV can follow later.", requestId: "req-00000001" };

describe("agentQuestion", () => {
  it("splits Ranger's resume condition from the worker's reason", () => {
    expect(agentQuestion("resume once: the principal picks CSV or JSON, — Blocked: the spec names both formats.")).toEqual({
      condition: "the principal picks CSV or JSON",
      reason: "Blocked: the spec names both formats.",
    });
  });

  it("keeps a reason without a resume condition whole, and has nothing to show for an empty detail", () => {
    expect(agentQuestion("Blocked: no lane for this repo")).toEqual({ condition: null, reason: "Blocked: no lane for this repo" });
    expect(agentQuestion(undefined)).toBeNull();
  });
});

describe("somaRepo", () => {
  it("qualifies a bare GitHub repo, passes a qualified one, and refuses anything else", () => {
    expect(somaRepo("example/app")).toBe("github:github.com/example/app");
    expect(somaRepo("gitlab:gitlab.example.com/group/app")).toBe("gitlab:gitlab.example.com/group/app");
    expect(somaRepo("--repo")).toBeNull();
  });

  it("names the GitHub ref whose body the explainer reads, and refuses a ref GitHub cannot address", () => {
    expect(githubRef("the-metafactory/soma", "913")).toEqual({ owner: "the-metafactory", repo: "soma", number: 913 });
    expect(githubRef("gitlab:gitlab.example.com/group/app", "7")).toBeNull();
    expect(githubRef("example/app", "0")).toBeNull();
  });
});

describe("a ruling given on the Desk", () => {
  it("records the ruling from a file, then resumes the node through Ranger", async () => {
    const { soma, ranger, rule } = setup();
    const res = await rule(RULING);
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe('Recorded your ruling and resumed "Pick the export format".');
    expect(soma.calls).toHaveLength(1);
    const argv = soma.calls[0]?.argv ?? [];
    expect([argv[0], ...argv.slice(1, 4)]).toEqual(["/opt/soma/bin/soma", "graph", "rule", "12"]);
    expect([argv[4], ...argv.slice(6)]).toEqual(["--text-file", "--repo", "github:github.com/example/app", "--json"]);
    expect(argv.some((a) => a.includes("Use JSON"))).toBe(false);
    expect(soma.calls[0]?.file).toBe("--repo evil\nUse JSON; CSV can follow later.");
    expect(existsSync(argv[5] ?? "")).toBe(false);
    expect(ranger.calls.map((c) => c.argv)).toEqual([["/opt/ranger/bin/ranger", "resume-node", "12", "--map", "example/app#1"]]);
  });

  it("hides the item until Ranger moves on", async () => {
    const { runtime, rule } = setup();
    await rule(RULING);
    const db = initDatabase(":memory:");
    const view = await composeDesk(db, DESK, undefined, { now: NOW, fetchImpl: fetchRanger(rangerState()), handled: runtime.ledger });
    expect(view.items.map((i) => i.key)).not.toContain(KEY);
    db.close();
  });

  it("keeps the ruling when Ranger refuses the resume, and records it once across a second Confirm", async () => {
    const ranger = runner({ code: 1, stdout: "", stderr: "ranger resume-node: lane soma is held by #900\n" });
    const { soma, rule } = setup({ ranger });
    const first = await rule(RULING);
    expect(first.status).toBe(502);
    expect(await first.json()).toEqual({ ok: false, recorded: true, error: "Your ruling is recorded; Ranger did not resume: ranger resume-node: lane soma is held by #900" });
    const second = await rule({ ...RULING, text: "a changed ruling" });
    expect(second.status).toBe(502);
    expect(soma.calls).toHaveLength(1);
    expect(ranger.calls).toHaveLength(2);
  });

  it("resumes nothing when recording fails, and says why in one line", async () => {
    const soma = runner({ code: 1, stdout: "", stderr: "warning\nsoma graph rule refused: node 12 is closed, so nothing was written.\n" });
    const { ranger, rule } = setup({ soma });
    const res = await rule(RULING);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Your ruling was not recorded: soma graph rule refused: node 12 is closed, so nothing was written.");
    expect(ranger.calls).toEqual([]);
  });

  it("refuses an empty ruling, a node that is not blocked, and a stack without Soma, before anything runs", async () => {
    const { soma, ranger, rule } = setup();
    const empty = await rule({ ...RULING, text: "   " });
    const failed = await rule({ ...RULING, key: "ranger:example/app#13" });
    const noId = await rule({ key: KEY, text: "x" });
    const unset = await setup({ soma, ranger, desk: { ...DESK, somaBin: "" } }).rule(RULING);
    expect([empty.status, failed.status, noId.status, unset.status]).toEqual([400, 409, 400, 409]);
    expect((await failed.json()).error).toBe("Ranger no longer waits for a ruling on this node.");
    expect([...soma.calls, ...ranger.calls]).toEqual([]);
  });
});

describe("a blocked item on the Desk", () => {
  it("offers Give your ruling with the agent's question, wired only when Soma and Ranger's CLI are set", async () => {
    const db = initDatabase(":memory:");
    const blocked = async (desk: DeskOptions) => {
      const view = await composeDesk(db, desk, undefined, { now: NOW, fetchImpl: fetchRanger(rangerState()) });
      return view.items.find((i) => i.key === KEY);
    };
    const wired = await blocked(DESK);
    expect(wired?.actions[0]).toEqual({ id: "ranger.rule", label: "Give your ruling", role: "primary", wired: true });
    expect(wired?.question).toEqual({ condition: "the principal picks CSV or JSON", reason: "Blocked: the spec names both formats." });
    expect(wired?.detail.links).toEqual([{ label: "Issue", url: "https://github.com/example/app/issues/12" }]);
    const unwired = await blocked({ ...DESK, somaBin: "" });
    expect(unwired?.actions[0]).toMatchObject({ id: "open", label: "Give your ruling", url: "https://github.com/example/app/issues/12" });
    db.close();
  });

  it("carries the plain explanation once the explainer has answered, and none while it has not", async () => {
    const db = initDatabase(":memory:");
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new RulingExplainLoop(
      async () => {
        await gate;
        return EXPLAINED;
      },
      async () => BODY,
      () => NOW,
    );
    const cold = await composeDesk(db, DESK, undefined, { now: NOW, fetchImpl: fetchRanger(somaState()), rulingExplain: loop });
    expect(cold.items.find((i) => i.key === SOMA_KEY)?.explanation).toBeUndefined();
    release();
    await loop.warm([BLOCKED]);
    const warm = await composeDesk(db, DESK, undefined, { now: NOW, fetchImpl: fetchRanger(somaState()), rulingExplain: loop });
    expect(warm.items.find((i) => i.key === SOMA_KEY)?.explanation).toEqual(EXPLAINED);
    const plain = await composeDesk(db, DESK, undefined, { now: NOW, fetchImpl: fetchRanger(somaState()) });
    expect(plain.items.find((i) => i.key === SOMA_KEY)?.explanation).toBeUndefined();
    db.close();
  });
});

const SOMA_KEY = "ranger:the-metafactory/soma#913";

const BODY = [
  "## Deliverable",
  "The `retro` skill's canonical source, `~/.soma/skills/retro/SKILL.md`, reads the Errata first.",
  "## Touches",
  "- `~/.soma/skills/retro/SKILL.md` (canonical; `~/.claude/skills/retro` is a symlink to it).",
].join("\n");

const BLOCKED: RangerNeedsYou = {
  key: "the-metafactory/soma#1",
  repo: "the-metafactory/soma",
  nodeId: "913",
  title: "/retro reads the session's Errata before the transcript: the canonical skill edit",
  status: "parked",
  url: "https://github.com/the-metafactory/soma/issues/913",
  endedAt: "2026-10-31T08:00:00.000Z",
  reason: {
    class: "blocked",
    detail: "resume once: provide an authorized implementation lane in the soma-home repository, — Blocked: the canonical retro skill belongs to a separate repository, and this worker may commit only on its assigned node branch. Evidence: `git -C /Users/fischer/.soma rev-parse --show-toplevel` returns `/Users/fi…`",
  },
  actions: { resume: true },
};

const somaState = (): RangerState => ({ current: [], needsYou: [BLOCKED], maps: [] });

const EXPLAINED = {
  sentence: "The agent wants to edit ~/.soma/skills/retro/SKILL.md in your soma home repository, but it may only commit on its own node branch in the-metafactory/soma.",
  choices: [
    {
      label: "Allow the edit",
      consequence: "The agent may edit ~/.soma/skills/retro/SKILL.md, and the node is resumed.",
      ruling: "Allow the edit to ~/.soma/skills/retro/SKILL.md in the soma home repository; resume the node in the-metafactory/soma.",
    },
    {
      label: "Keep it parked",
      consequence: "Nothing is granted, and the node stays parked with the work undone.",
      ruling: "Do not grant the lane; keep the node parked in the-metafactory/soma.",
    },
  ],
};

const RELATIVE_BODY = "## Deliverable\nEdit README.md only.\n";

const RELATIVE_EXPLAINED = {
  sentence: "The agent wants to edit README.md in the-metafactory/soma, but it may only commit on its own node branch.",
  choices: [
    {
      label: "Allow the edit",
      consequence: "The agent may edit README.md, and the node is resumed.",
      ruling: "Allow the edit to README.md in the-metafactory/soma; resume the node.",
    },
    {
      label: "Keep it parked",
      consequence: "Nothing is granted, and the node stays parked with the work undone.",
      ruling: "Do not grant the lane; keep the node parked in the-metafactory/soma.",
    },
  ],
};

describe("explaining a blocked node", () => {
  it("reads a repository-relative path and a bare file name, and refuses one the inputs do not carry", async () => {
    expect(await explainRuling(BLOCKED, RELATIVE_BODY, async () => RELATIVE_EXPLAINED)).toEqual({ kind: "explained", explanation: RELATIVE_EXPLAINED });
    const inventedSentence = { ...RELATIVE_EXPLAINED, sentence: "The agent wants to edit src/billing.ts in the-metafactory/soma, but it may only commit on its own node branch." };
    const inventedRuling = { ...RELATIVE_EXPLAINED, choices: [RELATIVE_EXPLAINED.choices[0], { ...RELATIVE_EXPLAINED.choices[1], ruling: "Allow the edit to src/billing.ts; keep the node parked in the-metafactory/soma." }] };
    for (const answer of [inventedSentence, inventedRuling]) {
      expect(await explainRuling(BLOCKED, RELATIVE_BODY, async () => answer)).toEqual({ kind: "unexplained", line: RULING_FALLBACK });
    }
  });

  it("turns a well-formed answer into the sentence and the choices that fill the ruling box", async () => {
    expect(await explainRuling(BLOCKED, BODY, async () => EXPLAINED)).toEqual({ kind: "explained", explanation: EXPLAINED });
    const ended = { ...EXPLAINED, sentence: "The agent wants to edit ~/.soma/skills/retro/SKILL.md." };
    expect(await explainRuling(BLOCKED, BODY, async () => ended)).toEqual({ kind: "explained", explanation: ended });
  });

  it("refuses an unreadable answer and a missing explainer, and shows the fallback line instead", async () => {
    const oneChoice = { ...EXPLAINED, choices: EXPLAINED.choices.slice(0, 1) };
    expect(await explainRuling(BLOCKED, BODY, async () => oneChoice)).toEqual({ kind: "unexplained", line: RULING_FALLBACK });
    expect(await explainRuling(BLOCKED, BODY, null)).toEqual({ kind: "unexplained", line: RULING_FALLBACK });
  });

  it("invents no path Ranger's evidence alone carries, and opens with no Resume once and no shell command", async () => {
    const evidencePath = { ...EXPLAINED, sentence: "The agent wants to edit /Users/fischer/.soma in the soma home repository, but it may only commit on its own branch." };
    const resumeOnce = { ...EXPLAINED, sentence: "Resume once: provide a lane for ~/.soma/skills/retro/SKILL.md." };
    const command = { ...EXPLAINED, sentence: "The agent wants to run `soma graph rule` on ~/.soma/skills/retro/SKILL.md." };
    for (const answer of [evidencePath, resumeOnce, command]) {
      expect(await explainRuling(BLOCKED, BODY, async () => answer)).toEqual({ kind: "unexplained", line: RULING_FALLBACK });
    }
  });

  it("falls back when the inputs do not say what the agent wants, or the explainer fails", async () => {
    const failed = async (): Promise<unknown> => {
      throw new Error("the ruling explainer answered HTTP 500");
    };
    expect(await explainRuling(BLOCKED, "", async () => EXPLAINED)).toEqual({ kind: "unexplained", line: RULING_FALLBACK });
    expect(await explainRuling(BLOCKED, BODY, async () => ({ explain: false }))).toEqual({ kind: "unexplained", line: RULING_FALLBACK });
    expect(await explainRuling(BLOCKED, BODY, failed)).toEqual({ kind: "unexplained", line: RULING_FALLBACK });
  });
});

describe("the ruling explainer config", () => {
  const parse = (explainer: unknown): boolean => McSchema.safeParse({ desk: { ruling: { explainer } } }).success;

  it("takes a command, or an endpoint with a model, and refuses a half-written endpoint", () => {
    expect(parse({ command: ["/opt/explain"] })).toBe(true);
    expect(parse({ baseUrl: "https://api.example/v1", model: "m" })).toBe(true);
    expect(parse({ baseUrl: "https://api.example/v1" })).toBe(false);
    expect(parse({ baseUrl: "http://llm.example/v1", model: "m" })).toBe(false);
  });
});
