import { readFileSync } from "node:fs";
import type { WriterResult, WriterRunner } from "../../../../surface/mc/desk/create";

export const GRAPH_NODE_NOW = Date.parse("2026-11-01T12:00:00.000Z");
export const GRAPH_NODE_REPOSITORY = "github:github.com/example/desk";

export interface FiledNode { node: string; repo: string; parent: string | null; argv: string[] }

export interface SyntheticSoma {
  readonly run: WriterRunner;
  readonly calls: string[][];
  readonly nodes: Map<string, FiledNode>;
  mode: "normal" | "exit-after-file" | "unattached" | "exit-no-file" | "file-under-other-parent";
}

const flag = (argv: string[], name: string): string => argv[argv.indexOf(name) + 1] ?? "";
const ok = (data: unknown): WriterResult => ({ code: 0, stdout: JSON.stringify(data), stderr: "" });

export function syntheticSoma(): SyntheticSoma {
  const nodes = new Map<string, FiledNode>();
  const calls: string[][] = [];
  let next = 40;
  const soma: SyntheticSoma = {
    calls,
    nodes,
    mode: "normal",
    run: argv => {
      calls.push(argv);
      const marker = flag(argv, "--once");
      const shown = (repo: string): string => repo.replace(/^github:github\.com\//, "");
      if (argv.includes("--dry-run")) {
        const hit = nodes.get(marker);
        return Promise.resolve(ok(hit ? { found: true, repo: hit.repo, node: hit.node, parent: hit.parent } : { found: false }));
      }
      readFileSync(flag(argv, "--body-file"), "utf8");
      const prior = nodes.get(marker);
      if (prior) return Promise.resolve(ok({ repo: prior.repo, node: prior.node, parent: prior.parent, existing: true }));
      if (soma.mode === "exit-no-file") return Promise.resolve({ code: 2, stdout: "", stderr: "soma: graph unavailable\n" });
      const node = String(next++);
      const repo = shown(flag(argv, "--repo"));
      const parent = soma.mode === "file-under-other-parent" ? "999" : argv[3] ?? "";
      nodes.set(marker, { node, repo, parent, argv });
      if (soma.mode === "unattached") return Promise.resolve({ code: 1, stdout: "", stderr: JSON.stringify({ node, attached: false }) });
      if (soma.mode === "exit-after-file" || soma.mode === "file-under-other-parent") return Promise.resolve({ code: 3, stdout: "", stderr: "soma: lost the connection\n" });
      return Promise.resolve(ok({ repo, node, parent, existing: false }));
    },
  };
  return soma;
}
