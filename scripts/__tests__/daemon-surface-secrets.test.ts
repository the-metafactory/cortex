import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const homes: string[] = [];
const secret = "synthetic-surface-credential";

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(platform: "Darwin" | "Linux") {
  const home = mkdtempSync(join(tmpdir(), "cortex-render-secret-"));
  homes.push(home);
  const config = join(home, "config");
  const destination = join(home, "services");
  const mockBin = join(home, "mock-bin");
  for (const dir of [config, destination, mockBin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(config, "cortex.sample.yaml"), "agents:\n  - id: pilot\n    presence:\n      discord:\n        enabled: true\n        token: __SAMPLE_DISCORD_TOKEN__\n");
  for (const [name, body] of Object.entries({ uname: `echo ${platform}`, systemctl: "exit 0", loginctl: "echo yes" })) {
    writeFileSync(join(mockBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  }
  const env = { ...process.env, HOME: home, ARC_CONFIG_ROOT: "", XDG_CONFIG_HOME: "", PATH: `${mockBin}:${process.env.PATH}`, SYSTEMD_HOST_MARKER: destination };
  const path = join(destination, platform === "Darwin" ? "ai.meta-factory.cortex.sample.plist" : "cortex@.service");
  function render() {
    return spawnSync("bash", ["-c", 'set -e; source "$1/scripts/lib/systemd-render.sh"; if [ "$4" = Darwin ]; then render_cortex_plists "$1" "$2" "$3"; else render_cortex_systemd_units "$1" "$2" "$3"; fi', "--", root, destination, config, platform], { env, encoding: "utf8" });
  }
  return { home, config, destination, env, path, render };
}

describe("daemon surface secrets across service re-render", () => {
  for (const platform of ["Darwin", "Linux"] as const) {
    test(`${platform}: declared arc secret loads after two renders without entering the service or output`, () => {
      const f = fixture(platform);
      const store = join(f.home, ".config/metafactory/arc/secrets/cortex");
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, "SAMPLE_DISCORD_TOKEN"), secret, { mode: 0o600 });
      for (let attempt = 0; attempt < 2; attempt++) {
        const rendered = f.render();
        expect(rendered.status).toBe(0);
        expect(`${rendered.stdout}${rendered.stderr}`).not.toContain(secret);
        const service = readFileSync(f.path, "utf8");
        expect(service).not.toContain(secret);
        expect(service).toContain("CORTEX_SURFACE_SECRETS");
        const probe = join(f.home, "boot.ts");
        writeFileSync(probe, `import { readFileSync } from "node:fs";
import { parse } from ${JSON.stringify(join(root, "node_modules/yaml/dist/index.js"))};
import { resolveSurfaceTokensInRawConfig } from ${JSON.stringify(join(root, "src/common/config/resolve-env-placeholders.ts"))};
const raw = parse(readFileSync(${JSON.stringify(join(f.config, "cortex.sample.yaml"))}, "utf8"));
resolveSurfaceTokensInRawConfig(raw);
const value = readFileSync(${JSON.stringify(join(store, "SAMPLE_DISCORD_TOKEN"))}, "utf8");
if (raw.agents[0].presence.discord.enabled !== true || raw.agents[0].presence.discord.token !== value || process.env.SAMPLE_DISCORD_TOKEN !== value) process.exit(1);
console.log("surface enabled");
`);
        const environment = spawnSync("python3", ["-c", `import json, plistlib, shlex, sys
text = open(sys.argv[2]).read()
if sys.argv[1] == "Darwin":
    env = plistlib.loads(text.encode())["EnvironmentVariables"]
else:
    env = dict(assignment.split("=", 1) for line in text.splitlines() if line.startswith("Environment=") for assignment in shlex.split(line.split("=", 1)[1]))
    env = {key: value.replace("%h", sys.argv[3]) for key, value in env.items()}
json.dump(env, sys.stdout)
`, platform, f.path, f.home], { encoding: "utf8" });
        expect(environment.status).toBe(0);
        const serviceEnv: unknown = JSON.parse(environment.stdout);
        if (typeof serviceEnv !== "object" || serviceEnv === null) throw new Error("No service environment");
        const boot = spawnSync(process.execPath, [probe], { env: { ...f.env, ...serviceEnv, SAMPLE_DISCORD_TOKEN: "" }, encoding: "utf8" });
        expect(boot.status).toBe(0);
        expect(boot.stdout).toBe("surface enabled\n");
        expect(boot.stderr).toBe("");
      }
    });

    test(`${platform}: hand-added keys abort re-render without exposing values or replacing the old service`, () => {
      const f = fixture(platform);
      expect(f.render().status).toBe(0);
      const original = readFileSync(f.path, "utf8");
      const customized = platform === "Darwin"
        ? original.replace("<key>HOME</key>", `<key>SAGE_SUBSTRATE</key><string>${secret}</string><key>SAGE_GITLAB_HOST</key><string>synthetic-host</string><key>HOME</key>`)
        : original.replace("[Service]", `[Service]\nEnvironment="SAGE_SUBSTRATE=${secret}" SAGE_GITLAB_HOST=synthetic-host`);
      writeFileSync(f.path, customized);
      const rendered = f.render();
      expect(rendered.status).not.toBe(0);
      expect(rendered.stderr).toContain("SAGE_SUBSTRATE");
      expect(rendered.stderr).toContain("SAGE_GITLAB_HOST");
      expect(`${rendered.stdout}${rendered.stderr}`).not.toContain(secret);
      expect(readFileSync(f.path, "utf8")).toBe(customized);
    });
  }
});
