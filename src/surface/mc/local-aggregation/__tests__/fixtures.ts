/**
 * Shared fixtures for the local-aggregation suites: a config-split stack dir
 * writer, and a placeholder observer `.creds` writer (#2536).
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

/** Write a minimal config-split stack dir under `root/<slug>/`. */
export function writeStackDir(
  root: string,
  slug: string,
  opts: {
    principal: string;
    stackId: string;
    url: string;
    credsPath?: string;
    seedPath?: string;
  },
): void {
  const dir = join(root, slug);
  mkdirSync(join(dir, "system"), { recursive: true });
  mkdirSync(join(dir, "stacks"), { recursive: true });
  const natsLines = [
    "nats:",
    `  url: ${opts.url}`,
    `  name: ${slug}`,
    ...(opts.credsPath ? [`  credsPath: ${opts.credsPath}`] : []),
    ...(opts.seedPath
      ? ["  identity:", `    seedPath: ${opts.seedPath}`]
      : []),
  ];
  writeFileSync(join(dir, "system", "system.yaml"), natsLines.join("\n") + "\n");
  writeFileSync(
    join(dir, "stacks", `${slug}.yaml`),
    [
      "principal:",
      `  id: ${opts.principal}`,
      "stack:",
      `  id: ${opts.stackId}`,
      "",
    ].join("\n"),
  );
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/**
 * Write a `.creds` file whose user JWT carries `permissions`. The JWT is
 * UNSIGNED placeholder material (the scope check reads claims only; the bus
 * verifies signatures) and there is no seed block.
 */
export function writeCredsWithPermissions(
  path: string,
  permissions: {
    pub?: { allow?: string[]; deny?: string[] };
    sub?: { allow?: string[]; deny?: string[] };
  },
): void {
  const jwt = [
    b64url({ typ: "JWT", alg: "ed25519-nkey" }),
    b64url({ sub: "UPLACEHOLDER", iss: "APLACEHOLDER", nats: { type: "user", ...permissions } }),
    "placeholder-signature",
  ].join(".");
  writeFileSync(
    path,
    `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n`,
    { mode: 0o600 },
  );
}

/** A correctly scoped observer: sub allow the sibling presence subtree, pub deny `>`. */
export function writeObserverCreds(path: string, principal: string, sibling: string): void {
  writeCredsWithPermissions(path, {
    pub: { deny: [">"] },
    sub: { allow: [`local.${principal}.${sibling}.agent.>`] },
  });
}
