import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { enforceChmod600 } from "./file-permissions";

interface SecurityResult {
  status: number | null;
  stdout: string;
}

export interface SurfaceSecretStoreOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  username?: string;
  security?: (args: string[]) => SecurityResult;
}

function runSecurity(args: string[]): SecurityResult {
  return spawnSync("security", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
}

export function readSurfaceSecret(name: string, options: SurfaceSecretStoreOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  if (env.CORTEX_SURFACE_SECRETS !== "arc") return undefined;
  if (!/^[A-Z0-9_]+$/.test(name)) throw new Error("Invalid surface secret name");
  const home = options.home ?? homedir();
  const xdg = env.XDG_CONFIG_HOME;
  const override = env.ARC_CONFIG_ROOT;
  const configRoot = override
    ? override.replace(/^~(?=\/|$)/, home)
    : join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), "metafactory/arc");
  const path = join(configRoot, "secrets/cortex", name);
  try {
    if (existsSync(path)) {
      enforceChmod600(path);
      return readFileSync(path, "utf8");
    }
    if ((options.platform ?? process.platform) !== "darwin") return undefined;
    const result = (options.security ?? runSecurity)([
      "find-generic-password", "-s", `ai.meta-factory.cortex.cortex.${name}`,
      "-a", options.username ?? userInfo().username, "-w",
    ]);
    if (result.status === 44) return undefined;
    if (result.status !== 0) throw new Error("Keychain read failed");
    return result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout;
  } catch {
    process.stderr.write(`cortex config WARN: could not read stored surface secret ${name}; check arc secret-store access and permissions.\n`);
    return undefined;
  }
}
