import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, readlink, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolsConfig } from "../../../common/types/desk-conversations";

export async function directGit(root: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const proc = Bun.spawn(["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args], { env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Synthetic Principal", GIT_AUTHOR_EMAIL: "principal@example.invalid", GIT_COMMITTER_NAME: "Synthetic Principal", GIT_COMMITTER_EMAIL: "principal@example.invalid", GIT_OPTIONAL_LOCKS: "0" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err);
  return out;
}

export async function gitFixture(dir: string) {
  const root = join(dir, "checkout");
  await mkdir(root);
  await directGit(root, ["init", "--quiet", "--initial-branch=probe"]);
  await mkdir(join(root, "restricted"));
  await mkdir(join(root, "excluded"));
  const files = { "beacon.txt": "synthetic committed beacon\n", "deleted.txt": "synthetic removed file\n", "restricted/note.txt": "SYNTHETIC_LOCAL_ONLY\n", "excluded/note.txt": "SYNTHETIC_EXCLUDED\n", ".env": "SYNTHETIC_ENV_SECRET\n" };
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  await directGit(root, ["add", "."]);
  await directGit(root, ["commit", "--quiet", "-m", "Synthetic initial state"]);
  const first = (await directGit(root, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(root, "beacon.txt"), "synthetic committed beacon\nsecond committed change\n");
  await directGit(root, ["add", "beacon.txt"]);
  await directGit(root, ["commit", "--quiet", "-m", "Synthetic beacon change"]);
  const head = (await directGit(root, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(root, "beacon.txt"), "synthetic committed beacon\nsecond committed change\nstaged change\n");
  await directGit(root, ["add", "beacon.txt"]);
  await writeFile(join(root, "beacon.txt"), "synthetic committed beacon\nsecond committed change\nstaged change\nunstaged change\n");
  await directGit(root, ["rm", "--quiet", "deleted.txt"]);
  await writeFile(join(root, "untracked.txt"), "synthetic untracked\n");
  const config: ToolsConfig = { projects: [
    { id: "sample", root, policy: "cloud", operations: ["repo.read"], exclude: ["excluded"] },
    { id: "restricted", root: join(root, "restricted"), policy: "local", operations: ["repo.read"] },
  ] };
  return { root, config, first, head };
}

export async function snapshot(root: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  const visit = async (path: string): Promise<void> => {
    const absolute = join(root, path);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) state[path] = `link:${await readlink(absolute)}`;
    else if (stat.isDirectory()) for (const child of (await readdir(absolute)).sort()) await visit(path ? `${path}/${child}` : child);
    else state[path] = createHash("sha256").update(await readFile(absolute)).digest("hex");
  };
  await visit("");
  return state;
}

export async function hostileGit(root: string, dir: string): Promise<string> {
  const marker = join(dir, "helper-ran");
  const helper = join(dir, "helper");
  await writeFile(helper, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`, { mode: 0o755 });
  await appendFile(join(root, ".git", "config"), `\n[core]\nfsmonitor = ${helper}\nhooksPath = ${dir}\npager = ${helper}\n[diff]\nexternal = ${helper}\n[diff "hostile"]\ncommand = ${helper}\ntextconv = ${helper}\n[filter "hostile"]\nclean = ${helper}\nprocess = ${helper}\nrequired = true\n[remote "origin"]\nurl = https://synthetic-user:synthetic-password@git.example.invalid/project?token=synthetic-token\n`);
  await writeFile(join(root, ".gitattributes"), "*.txt diff=hostile filter=hostile\n");
  return marker;
}
