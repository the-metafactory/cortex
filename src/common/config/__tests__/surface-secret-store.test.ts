import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSurfaceSecret } from "../surface-secret-store";
import { resolveAgentPresenceTokens, surfaceSecretFixCommand } from "../resolve-env-placeholders";

const homes: string[] = [];
const name = "SAMPLE_SURFACE_SECRET";

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cortex-secret-store-"));
  homes.push(home);
  return { home, env: { CORTEX_SURFACE_SECRETS: "arc" }, platform: "linux" };
}

describe("persistent surface secret lookup", () => {
  test("reads the arc cortex file backend from the default config root", () => {
    const options = fixture();
    const store = join(options.home, ".config/metafactory/arc/secrets/cortex");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, name), "synthetic-secret\n", { mode: 0o600 });
    expect(readSurfaceSecret(name, options)).toBe("synthetic-secret\n");
  });

  test("honors XDG_CONFIG_HOME and ARC_CONFIG_ROOT including tilde expansion", () => {
    const options = fixture();
    const xdg = join(options.home, "xdg");
    const arc = join(options.home, "custom-arc");
    for (const root of [join(xdg, "metafactory/arc"), arc]) {
      const store = join(root, "secrets/cortex");
      mkdirSync(store, { recursive: true });
      writeFileSync(join(store, name), root, { mode: 0o600 });
    }
    expect(readSurfaceSecret(name, { ...options, env: { ...options.env, XDG_CONFIG_HOME: xdg } })).toBe(join(xdg, "metafactory/arc"));
    expect(readSurfaceSecret(name, { ...options, env: { ...options.env, XDG_CONFIG_HOME: xdg, ARC_CONFIG_ROOT: "~/custom-arc" } })).toBe(arc);
  });

  test("reads the arc Keychain service and account, removing only its appended newline", () => {
    const options = fixture();
    let queried: string[] = [];
    const value = readSurfaceSecret(name, {
      ...options, platform: "darwin", username: "sample-user",
      security: (args) => {
        queried = args;
        return { status: 0, stdout: "synthetic-secret\n\n" };
      },
    });
    expect(queried).toEqual(["find-generic-password", "-s", `ai.meta-factory.cortex.cortex.${name}`, "-a", "sample-user", "-w"]);
    expect(value).toBe("synthetic-secret\n");
  });

  test("does not query a persistent store without the service opt-in", () => {
    const options = fixture();
    const security = spyOn({ run: () => ({ status: 0, stdout: "secret" }) }, "run");
    expect(readSurfaceSecret(name, { ...options, env: {}, platform: "darwin", security })).toBeUndefined();
    expect(security).not.toHaveBeenCalled();
  });

  test("not-found remains fail-soft and silent", () => {
    const options = fixture();
    const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(readSurfaceSecret(name, { ...options, platform: "darwin", username: "sample-user", security: () => ({ status: 44, stdout: "" }) })).toBeUndefined();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  test("Keychain failures expose only the secret name, including thrown provider errors", () => {
    const options = fixture();
    const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(readSurfaceSecret(name, { ...options, platform: "darwin", username: "sample-user", security: () => { throw new Error("synthetic-secret"); } })).toBeUndefined();
      expect(stderr.mock.calls.flat().join(" ")).toContain(name);
      expect(stderr.mock.calls.flat().join(" ")).not.toContain("synthetic-secret");
    } finally {
      stderr.mockRestore();
    }
  });

  test("a disabled pilot surface's printed provisioning command targets the installed cortex package", () => {
    const previous = process.env[name];
    Reflect.deleteProperty(process.env, name);
    const stderr = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      resolveAgentPresenceTokens({ id: "pilot", presence: { discord: { token: `__${name}__` } } }, "agents[0]");
      expect(stderr.mock.calls.flat().join(" ")).toContain(`Fix: \`${surfaceSecretFixCommand(name)}\``);
      expect(surfaceSecretFixCommand(name)).toBe(`arc secrets set cortex ${name}`);
    } finally {
      if (previous !== undefined) process.env[name] = previous;
      stderr.mockRestore();
    }
  });
});
