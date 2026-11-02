import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function gitIn(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

export function seedStudioRepo(prefix: string, threads: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, "threads"));
  for (const [slug, text] of Object.entries(threads)) writeFileSync(join(dir, `threads/${slug}.md`), text);
  gitIn(dir, "init", "-q");
  gitIn(dir, "config", "user.name", "Test");
  gitIn(dir, "config", "user.email", "test@example.org");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-qm", "seed");
  return dir;
}
