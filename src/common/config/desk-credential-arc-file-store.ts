import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isSurfaceSecretName } from "./surface-secret-store";

export interface ArcSecretStore {
  readonly id: string;
  available(): Promise<boolean>;
  writeIfAbsent(identity: string, value: string): Promise<"created" | "exists">;
  matches(identity: string, value: string): Promise<boolean>;
  present(identity: string): Promise<boolean>;
}

const SECRETS_PACKAGE = "cortex";

export function arcSecretPath(configRoot: string, identity: string): string {
  if (!isSurfaceSecretName(identity)) throw new Error("Invalid secret identity.");
  return join(configRoot, "secrets", SECRETS_PACKAGE, identity);
}

export function createArcFileSecretStore(options: { configRoot: string; id?: string }): ArcSecretStore {
  const directory = join(options.configRoot, "secrets", SECRETS_PACKAGE);
  const pathOf = (identity: string): string => arcSecretPath(options.configRoot, identity);
  return {
    id: options.id ?? "arc-file",
    async available() {
      try { await mkdir(directory, { recursive: true, mode: 0o700 }); return (await stat(directory)).isDirectory(); }
      catch (_err) { return false; }
    },
    async writeIfAbsent(identity, value) {
      const path = pathOf(identity);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const staging = `${path}.${randomUUID()}.partial`;
      try {
        const handle = await open(staging, "wx", 0o600);
        try { await handle.writeFile(value, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await chmod(staging, 0o600);
        try { await link(staging, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists"; throw error; }
      } catch (error) { throw new Error("Secret store write failed.", { cause: error }); }
      finally { await unlink(staging).catch((_err: unknown) => undefined); }
      return "created";
    },
    async matches(identity, value) {
      try { return (await readFile(pathOf(identity), "utf8")) === value; }
      catch (_err) { return false; }
    },
    async present(identity) {
      try { return (await stat(pathOf(identity))).isFile(); }
      catch (_err) { return false; }
    },
  };
}
