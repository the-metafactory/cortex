export function runIsolated(source: string): { exitCode: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync([process.execPath, "--eval", source], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}
