import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileCapabilityNode, parseMap, parseWriterFlags, renderBrief, runWriter, type SomaRunner, type WriterInput } from "../desk-capability-node";

const INPUT: WriterInput = {
  requestId: "request-0001",
  capability: "compose.judgment",
  steps: [{ label: "Ask an agent to derive", prompt: "Judge\n{text}", sovereignty: { model_class: "local-only", frontier_ok: false, data_residency: "CH" } }],
  request: "every minute, derive a result",
  yaml: "name: F_AGENT\nactions: []\n",
  map: "example/maps#12",
  budget: { tokens: 200_000, invocations: 40, minutes: 60 },
};
const TEMPLATE_PATH = join(import.meta.dir, "..", "desk-capability-template.md");
const MARKER = "desk-capability:compose.judgment";
const PROBES = [JSON.stringify({ type: "artifact-exists", path: "capabilities/{slug}/index.ts", atRef: "main" })];

interface Node { id: string; status: string; parent: string | null }
function fakeSoma(existing: Node[]) {
  const calls: string[][] = [];
  const bodies: string[] = [];
  const nodes = new Map(existing.map((n) => [n.id, n]));
  const run: SomaRunner = async (argv) => {
    calls.push(argv);
    const [, verb] = argv;
    if (verb === "node") {
      const node = nodes.get(argv[2] ?? "");
      if (!node) return { code: 1, stdout: "", stderr: "no such node" };
      return { code: 0, stdout: JSON.stringify({ repo: "example/maps", status: node.status, url: `https://example.test/${node.id}`, parent: node.parent ? { id: node.parent } : null }), stderr: "" };
    }
    const body = await readFile(argv[argv.indexOf("--body-file") + 1] ?? "", "utf8");
    if (argv.includes("--dry-run")) {
      if (existing.length === 0) return { code: 0, stdout: JSON.stringify({ found: false }), stderr: "" };
      if (existing.length === 1) return { code: 0, stdout: JSON.stringify({ found: true, node: existing[0]?.id, parent: existing[0]?.parent }), stderr: "" };
      return { code: 1, stdout: "", stderr: JSON.stringify({ error: "once-ambiguous", marker: MARKER, nodes: existing.map((n) => n.id) }) };
    }
    bodies.push(body);
    const id = "500";
    nodes.set(id, { id, status: "open", parent: "12" });
    return { code: 0, stdout: JSON.stringify({ repo: "example/maps", node: id, parent: "12", existing: false }), stderr: "" };
  };
  return { run, calls, bodies, adds: () => calls.filter((c) => c[1] === "add" && !c.includes("--dry-run")) };
}

describe("the default brief", () => {
  it("has the sections soma audit requires and carries each step prompt and sovereignty as a criterion", async () => {
    const brief = renderBrief(await readFile(TEMPLATE_PATH, "utf8"), INPUT);
    for (const heading of ["## Deliverable", "## Acceptance criteria"]) expect(brief).toContain(`${heading}\n`);
    const acceptance = brief.slice(brief.indexOf("## Acceptance criteria"));
    expect(acceptance).toMatch(/^Live probe: \S/m);
    expect(brief).not.toContain("[NEEDS CLARIFICATION]");
    expect(brief).not.toContain("{{");
    expect(acceptance).toContain('"Judge {text}"');
    expect(acceptance).toContain("model class local-only, frontier model allowed no, data residency CH");
    expect(brief).toContain("name: F_AGENT");
  });

  it("renders values once and never as template syntax", () => {
    const brief = renderBrief("{{request}} / {{flow}}", { ...INPUT, request: "{{flow}}", yaml: "{{capability}}" });
    expect(brief).toBe("{{flow}} / {{capability}}");
  });
});

describe("filing a capability node", () => {
  it("files one auto build node through soma graph add with the marker, label and budget when none exists", async () => {
    const soma = fakeSoma([]);
    const answer = await fileCapabilityNode(INPUT, await readFile(TEMPLATE_PATH, "utf8"), soma.run, PROBES);
    expect(answer).toEqual({ ref: "example/maps#500", url: "https://example.test/500", existing: false });
    const [add] = soma.adds();
    expect(add).toBeDefined();
    const flag = (name: string): string | undefined => add?.[add.indexOf(name) + 1];
    expect(add?.slice(0, 5)).toEqual(["graph", "add", "12", "--repo", "github:github.com/example/maps"]);
    expect(flag("--kind")).toBe("build");
    expect(flag("--autonomy")).toBe("auto");
    expect(flag("--label")).toBe("desk-capability");
    expect(flag("--once")).toBe(MARKER);
    expect([flag("--budget-tokens"), flag("--budget-invocations"), flag("--budget-minutes")]).toEqual(["200000", "40", "60"]);
    expect(flag("--checkpoint")).toBe("desk-capability-compose-judgment");
    expect(JSON.parse(flag("--probe") ?? "")).toEqual({ type: "artifact-exists", path: "capabilities/compose-judgment/index.ts", atRef: "main" });
  });

  it("refuses to file without a probe, because soma files an auto node only with one, and before calling soma", async () => {
    const soma = fakeSoma([]);
    await expect(fileCapabilityNode(INPUT, "template", soma.run, [])).rejects.toThrow("--probe");
    await expect(fileCapabilityNode(INPUT, "template", soma.run, ['{"path": "{capability}"'])).rejects.toThrow("not JSON");
    expect(soma.calls).toHaveLength(0);
  });

  it("returns an open node already under the marker without filing, also beside a closed one", async () => {
    for (const existing of [[{ id: "77", status: "open", parent: "12" }], [{ id: "70", status: "closed", parent: "12" }, { id: "77", status: "open", parent: "12" }]]) {
      const soma = fakeSoma(existing);
      const answer = await fileCapabilityNode(INPUT, "template", soma.run, PROBES);
      expect(answer).toEqual({ ref: "example/maps#77", url: "https://example.test/77", existing: true });
      expect(soma.adds()).toHaveLength(0);
    }
  });

  it("reattaches an open node without a parent through the same once marker", async () => {
    const soma = fakeSoma([{ id: "77", status: "open", parent: null }]);
    const answer = await fileCapabilityNode(INPUT, "template", soma.run, PROBES);
    expect(answer.existing).toBe(true);
    expect(soma.adds()).toHaveLength(1);
    expect(soma.adds()[0]).toContain("--once");
  });

  it("does not reuse a closed node: it files a new one whose body ends with the marker", async () => {
    const soma = fakeSoma([{ id: "77", status: "closed", parent: "12" }]);
    const answer = await fileCapabilityNode(INPUT, "template", soma.run, PROBES);
    expect(answer).toEqual({ ref: "example/maps#500", url: "https://example.test/500", existing: false });
    expect(soma.adds()[0]).not.toContain("--once");
    expect(soma.bodies[0]?.trimEnd().split("\n").at(-1)).toBe(MARKER);
  });

  it("refuses two open nodes under one marker", async () => {
    const soma = fakeSoma([{ id: "70", status: "open", parent: "12" }, { id: "77", status: "open", parent: "12" }]);
    await expect(fileCapabilityNode(INPUT, "template", soma.run, PROBES)).rejects.toThrow("all open");
  });

  it("fails with soma's own message when it cannot add", async () => {
    const run: SomaRunner = async (argv) => argv.includes("--dry-run") ? { code: 0, stdout: JSON.stringify({ found: false }), stderr: "" } : { code: 1, stdout: "", stderr: "label desk-capability is not allowed\n" };
    await expect(fileCapabilityNode(INPUT, "template", run, PROBES)).rejects.toThrow("label desk-capability is not allowed");
  });
});

describe("the writer entry point", () => {
  it("reads the Desk's JSON, falls back to the shipped template and rejects input that is not a capability request", async () => {
    const soma = fakeSoma([]);
    expect((await runWriter(JSON.stringify(INPUT), { probes: PROBES }, soma.run)).existing).toBe(false);
    expect(soma.bodies[0]).toContain("## Deliverable");
    await expect(runWriter(JSON.stringify({ ...INPUT, capability: "bad capability;" }), { probes: PROBES }, soma.run)).rejects.toThrow();
  });

  it("reads a template and repeated probes from its arguments and refuses anything else", () => {
    expect(parseWriterFlags(["--template", "/t.md", "--probe", "{}", "--probe", "[]"])).toEqual({ template: "/t.md", probes: ["{}", "[]"] });
    expect(() => parseWriterFlags(["--probe"])).toThrow("needs a value");
    expect(() => parseWriterFlags(["--map", "x"])).toThrow("unknown argument");
  });

  it("maps a bare owner/repo to GitHub and keeps an explicit forge", () => {
    expect(parseMap("a/b#3")).toEqual({ repo: "github:github.com/a/b", root: "3" });
    expect(parseMap("gitlab:gitlab.example/g/p#9")).toEqual({ repo: "gitlab:gitlab.example/g/p", root: "9" });
  });
});
