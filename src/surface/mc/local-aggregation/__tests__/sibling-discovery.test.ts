/**
 * #989 part-1 — sibling-bus DISCOVERY tests (TDD, RED-first).
 *
 * The aggregator must auto-discover the principal's OTHER local stacks by
 * scanning a config root (`<root>/<slug>/system/system.yaml` +
 * `<slug>/stacks/<name>.yaml`), yielding one {stack, bus url, credential}
 * descriptor per sibling. Coverage axes:
 *
 *   1. Happy path — N stack dirs → N descriptors, each carrying url + creds +
 *      the stack's `{principal}/{stack}` identity.
 *   2. Self-exclusion — the SERVING stack (by config dir) is never in the result.
 *   3. Same-principal filter — a stack owned by a DIFFERENT principal is excluded
 *      (this is a LOCAL same-principal aggregation, never cross-principal).
 *   4. Loopback filter — a stack whose `nats.url` is NOT a 127.0.0.1 loopback is
 *      excluded (we only read the principal's own local buses).
 *   5. No-creds degrade — a stack whose bus needs a credential we can't resolve
 *      (no `credsPath`, only an account-signing NKey) is surfaced with
 *      `credential: { kind: "unresolved", … }` so the subscriber can degrade it
 *      to absent rather than crash.
 *   6. Malformed / partial dirs — a dir with no `system/system.yaml`, or an
 *      unparseable yaml, is skipped (logged) — never throws.
 *   7. Explicit-config override — an explicit stack list takes precedence over
 *      discovery (precedence is documented + tested here).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  discoverSiblingStacks,
  type SiblingStackDescriptor,
} from "../sibling-discovery";

/** Write a minimal config-split stack dir under `root/<slug>/`. */
function writeStackDir(
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

function findStack(
  list: SiblingStackDescriptor[],
  stack: string,
): SiblingStackDescriptor | undefined {
  return list.find((d) => d.stack === stack);
}

describe("#989 sibling-discovery", () => {
  test("discovers sibling stacks (url + creds + identity), excluding self", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-disc-"));
    try {
      writeStackDir(root, "meta-factory", {
        principal: "andreas",
        stackId: "andreas/meta-factory",
        url: "nats://127.0.0.1:4222",
        credsPath: "~/.config/nats/cortex.creds",
      });
      writeStackDir(root, "work", {
        principal: "andreas",
        stackId: "andreas/work",
        url: "nats://127.0.0.1:4222",
        credsPath: "~/.config/nats/cortex-work.creds",
      });
      writeStackDir(root, "halden", {
        principal: "andreas",
        stackId: "andreas/halden",
        url: "nats://127.0.0.1:4223",
        credsPath: "~/.config/nats/cortex-halden.creds",
      });

      const result = discoverSiblingStacks({
        configRoot: root,
        selfPrincipal: "andreas",
        selfStack: "meta-factory",
      });

      // self (meta-factory) excluded; work + halden present.
      expect(result.map((d) => d.stack).sort()).toEqual(["halden", "work"]);

      const work = findStack(result, "work");
      expect(work?.principal).toBe("andreas");
      expect(work?.url).toBe("nats://127.0.0.1:4222");
      expect(work?.credential).toEqual({
        kind: "creds",
        credsPath: "~/.config/nats/cortex-work.creds",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes a stack owned by a different principal", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-disc-"));
    try {
      writeStackDir(root, "work", {
        principal: "andreas",
        stackId: "andreas/work",
        url: "nats://127.0.0.1:4222",
        credsPath: "~/.config/nats/cortex-work.creds",
      });
      writeStackDir(root, "jc-default", {
        principal: "jc",
        stackId: "jc/default",
        url: "nats://127.0.0.1:4225",
        credsPath: "~/.config/nats/jc.creds",
      });

      const result = discoverSiblingStacks({
        configRoot: root,
        selfPrincipal: "andreas",
        selfStack: "meta-factory",
      });

      expect(result.map((d) => d.stack)).toEqual(["work"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("excludes a stack whose bus url is not loopback", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-disc-"));
    try {
      writeStackDir(root, "work", {
        principal: "andreas",
        stackId: "andreas/work",
        url: "nats://127.0.0.1:4222",
        credsPath: "~/.config/nats/cortex-work.creds",
      });
      writeStackDir(root, "remote", {
        principal: "andreas",
        stackId: "andreas/remote",
        url: "nats://10.0.0.5:4222",
        credsPath: "~/.config/nats/remote.creds",
      });

      const result = discoverSiblingStacks({
        configRoot: root,
        selfPrincipal: "andreas",
        selfStack: "meta-factory",
      });

      expect(result.map((d) => d.stack)).toEqual(["work"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("surfaces a creds-less (NKey-only) stack as a noauth credential (try-and-see)", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-disc-"));
    try {
      writeStackDir(root, "community", {
        principal: "andreas",
        stackId: "andreas/community",
        url: "nats://127.0.0.1:4224",
        seedPath: "~/.config/nats/cortex-community.nk",
      });

      const result = discoverSiblingStacks({
        configRoot: root,
        selfPrincipal: "andreas",
        selfStack: "meta-factory",
      });

      const community = findStack(result, "community");
      expect(community).toBeDefined();
      // No declared credsPath ⇒ attempt no-auth; the bus decides at connect time
      // (an open bus connects, a locked one degrades).
      expect(community?.credential.kind).toBe("noauth");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips a dir with no system.yaml and an unparseable yaml (no throw)", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-disc-"));
    try {
      // A bare dir with no system/system.yaml — not a stack.
      mkdirSync(join(root, "logs"), { recursive: true });
      // A dir whose system.yaml is unparseable.
      mkdirSync(join(root, "broken", "system"), { recursive: true });
      writeFileSync(
        join(root, "broken", "system", "system.yaml"),
        "nats: : : not valid yaml: [",
      );
      writeStackDir(root, "work", {
        principal: "andreas",
        stackId: "andreas/work",
        url: "nats://127.0.0.1:4222",
        credsPath: "~/.config/nats/cortex-work.creds",
      });

      const result = discoverSiblingStacks({
        configRoot: root,
        selfPrincipal: "andreas",
        selfStack: "meta-factory",
      });

      expect(result.map((d) => d.stack)).toEqual(["work"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit stack list overrides discovery (precedence: explicit > discovery)", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-disc-"));
    try {
      // Discovery would find work + halden, but the explicit list pins ONLY work.
      writeStackDir(root, "work", {
        principal: "andreas",
        stackId: "andreas/work",
        url: "nats://127.0.0.1:4222",
        credsPath: "~/.config/nats/cortex-work.creds",
      });
      writeStackDir(root, "halden", {
        principal: "andreas",
        stackId: "andreas/halden",
        url: "nats://127.0.0.1:4223",
        credsPath: "~/.config/nats/cortex-halden.creds",
      });

      const result = discoverSiblingStacks({
        configRoot: root,
        selfPrincipal: "andreas",
        selfStack: "meta-factory",
        explicit: [
          {
            stack: "work",
            principal: "andreas",
            url: "nats://127.0.0.1:4222",
            credential: {
              kind: "creds",
              credsPath: "~/.config/nats/cortex-work.creds",
            },
          },
        ],
      });

      expect(result.map((d) => d.stack)).toEqual(["work"]);
      expect(findStack(result, "halden")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit list still excludes self by stack name", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-disc-"));
    try {
      const result = discoverSiblingStacks({
        configRoot: root,
        selfPrincipal: "andreas",
        selfStack: "meta-factory",
        explicit: [
          {
            stack: "meta-factory",
            principal: "andreas",
            url: "nats://127.0.0.1:4222",
            credential: { kind: "creds", credsPath: "~/.config/nats/cortex.creds" },
          },
          {
            stack: "work",
            principal: "andreas",
            url: "nats://127.0.0.1:4222",
            credential: {
              kind: "creds",
              credsPath: "~/.config/nats/cortex-work.creds",
            },
          },
        ],
      });
      expect(result.map((d) => d.stack)).toEqual(["work"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
