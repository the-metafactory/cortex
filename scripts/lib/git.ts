/** A file's contents at `ref`, or undefined when the ref or the path does not exist there. */
export function gitShow(ref: string, path: string): string | undefined {
  const run = Bun.spawnSync(["git", "show", `${ref}:${path}`], { stdout: "pipe", stderr: "pipe" });
  return run.exitCode === 0 ? run.stdout.toString() : undefined;
}

/** Exits 2 with a fetch hint when `ref` is not a commit here, so a ratchet never passes by skipping its base. */
export function requireBaseRef(ref: string, tool: string): void {
  const run = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode === 0) return;
  console.error(`${tool}: cannot read ${ref}. Fetch it first: git fetch origin main`);
  process.exit(2);
}

/** The base ref a ratchet compares against: `$envVar`, else origin/main. Exits 2 when it cannot be read. */
export function resolveBaseRef(envVar: string, tool: string): string {
  const ref = process.env[envVar] ?? "origin/main";
  requireBaseRef(ref, tool);
  return ref;
}
