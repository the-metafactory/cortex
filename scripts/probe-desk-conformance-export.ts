import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hermeticTestEnv } from "./lib/test-home";

const ROOT = resolve(import.meta.dir, "..");
const FIXTURES = join(ROOT, "src/conversations/domain-adapters/__tests__/fixtures/conformance-packages");

export async function probeConformanceExport(fixtureDir = join(FIXTURES, "greenhouse"), typecheck = false): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "desk-conformance-export-"));
  const packageDir = join(root, "adapter");
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  try {
    await cp(resolve(fixtureDir), packageDir, { recursive: true, dereference: false });
    await cp(join(import.meta.dir, "fixtures/desk-conformance-export/run.ts"), join(packageDir, "run.ts"));
    await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "external-desk-adapter-probe", private: true, type: "module" }));
    await mkdir(join(packageDir, "node_modules/@the-metafactory"), { recursive: true });
    await symlink(ROOT, join(packageDir, "node_modules/@the-metafactory/cortex"));
    await mkdir(home);
    await mkdir(tmp);
    const env = hermeticTestEnv(process.env, { home, tmp });
    if (typecheck) {
      const compiler = Bun.spawn([process.execPath, join(ROOT, "node_modules/typescript/bin/tsc"), "--noEmit", "--skipLibCheck", "--module", "preserve", "--moduleResolution", "bundler", "--target", "esnext", "--types", join(ROOT, "node_modules/@types/bun"), "run.ts"], { cwd: packageDir, env, stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([compiler.exited, new Response(compiler.stdout).text(), new Response(compiler.stderr).text()]);
      if (exitCode !== 0) return { exitCode, stdout, stderr };
    }
    const child = Bun.spawn([process.execPath, "run.ts"], {
      cwd: packageDir, env, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode, stdout, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await probeConformanceExport(process.argv[2]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}
