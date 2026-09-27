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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  discoverSiblingStacks,
  observerCredsPath,
  observerMintHint,
  observerUserName,
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

      // #2536 — an empty observer dir: no sibling has an observer minted yet.
      const observerDir = join(root, "observer-creds");
      mkdirSync(observerDir);
      const result = discoverSiblingStacks({
        configRoot: root,
        selfPrincipal: "andreas",
        selfStack: "meta-factory",
        observerCredsDir: observerDir,
      });

      // self (meta-factory) excluded; work + halden present.
      expect(result.map((d) => d.stack).sort()).toEqual(["halden", "work"]);

      const work = findStack(result, "work");
      expect(work?.principal).toBe("andreas");
      expect(work?.url).toBe("nats://127.0.0.1:4222");
      // #2536 — the sibling daemon's own creds are NEVER surfaced; with no
      // observer minted the sibling is non-connectable.
      expect(work?.credential).toEqual({
        kind: "no-observer",
        reason: "missing",
        observerUser: "mc-observer-meta-factory-to-work",
        observerCredsPath: join(observerDir, "mc-observer-meta-factory-to-work.creds"),
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

  // #2536 — MC must never connect to a sibling with that sibling daemon's own
  // creds (stack A would hold stack B's full daemon user). An auto-discovered
  // sibling that declares a `credsPath` connects ONLY with a per-sibling
  // observer creds file found by convention; otherwise it is non-connectable.
  describe("#2536 per-sibling observer creds", () => {
    function setup(): { root: string; observerDir: string; daemonCreds: string } {
      const root = mkdtempSync(join(tmpdir(), "cortex-disc-obs-"));
      const observerDir = join(root, "observer-creds");
      mkdirSync(observerDir);
      const daemonCreds = join(root, "daemon-work.creds");
      writeFileSync(daemonCreds, "daemon-user-placeholder\n", { mode: 0o600 });
      writeStackDir(root, "work", {
        principal: "alice",
        stackId: "alice/work",
        url: "nats://127.0.0.1:4222",
        credsPath: daemonCreds,
      });
      return { root, observerDir, daemonCreds };
    }

    test("observer path convention: mc-observer-<self>-to-<sibling>.creds", () => {
      expect(observerUserName("default", "work")).toBe("mc-observer-default-to-work");
      expect(observerCredsPath("/creds", "default", "work")).toBe(
        "/creds/mc-observer-default-to-work.creds",
      );
    });

    test("observer file present ⇒ connects with the OBSERVER path, not the daemon's", () => {
      const { root, observerDir, daemonCreds } = setup();
      try {
        const observer = join(observerDir, "mc-observer-default-to-work.creds");
        writeFileSync(observer, "observer-user-placeholder\n", { mode: 0o600 });

        const result = discoverSiblingStacks({
          configRoot: root,
          selfPrincipal: "alice",
          selfStack: "default",
          observerCredsDir: observerDir,
        });

        const work = findStack(result, "work");
        expect(work?.credential).toEqual({ kind: "creds", credsPath: observer });
        expect(JSON.stringify(result)).not.toContain(daemonCreds);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("no observer file ⇒ `no-observer` (missing), sibling stays in the roster", () => {
      const { root, observerDir, daemonCreds } = setup();
      try {
        const result = discoverSiblingStacks({
          configRoot: root,
          selfPrincipal: "alice",
          selfStack: "default",
          observerCredsDir: observerDir,
        });

        // The sibling is still listed (the #1008 DB-read roster needs it), but
        // it carries no connectable credential.
        const work = findStack(result, "work");
        expect(work?.credential).toEqual({
          kind: "no-observer",
          reason: "missing",
          observerUser: "mc-observer-default-to-work",
          observerCredsPath: join(observerDir, "mc-observer-default-to-work.creds"),
        });
        expect(JSON.stringify(result)).not.toContain(daemonCreds);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("observer path that IS the daemon creds (symlink) ⇒ refused", () => {
      const { root, observerDir, daemonCreds } = setup();
      try {
        // A principal "shortcut": point the observer name at the daemon file.
        symlinkSync(daemonCreds, join(observerDir, "mc-observer-default-to-work.creds"));

        const result = discoverSiblingStacks({
          configRoot: root,
          selfPrincipal: "alice",
          selfStack: "default",
          observerCredsDir: observerDir,
        });

        const work = findStack(result, "work");
        expect(work?.credential).toEqual({
          kind: "no-observer",
          reason: "is-daemon-creds",
          observerUser: "mc-observer-default-to-work",
          observerCredsPath: join(observerDir, "mc-observer-default-to-work.creds"),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("observer dir IS the daemon creds location with the same name ⇒ refused", () => {
      const root = mkdtempSync(join(tmpdir(), "cortex-disc-obs-"));
      try {
        // The sibling daemon's creds file happens to sit at the observer path.
        const observerDir = join(root, "creds");
        mkdirSync(observerDir);
        const clash = join(observerDir, "mc-observer-default-to-work.creds");
        writeFileSync(clash, "daemon-user-placeholder\n", { mode: 0o600 });
        writeStackDir(root, "work", {
          principal: "alice",
          stackId: "alice/work",
          url: "nats://127.0.0.1:4222",
          credsPath: clash,
        });

        const result = discoverSiblingStacks({
          configRoot: root,
          selfPrincipal: "alice",
          selfStack: "default",
          observerCredsDir: observerDir,
        });

        expect(findStack(result, "work")?.credential).toEqual({
          kind: "no-observer",
          reason: "is-daemon-creds",
          observerUser: "mc-observer-default-to-work",
          observerCredsPath: clash,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("sibling WITHOUT a daemon credsPath keeps the noauth behaviour (open bus)", () => {
      const root = mkdtempSync(join(tmpdir(), "cortex-disc-obs-"));
      try {
        const observerDir = join(root, "observer-creds");
        mkdirSync(observerDir);
        writeStackDir(root, "work", {
          principal: "alice",
          stackId: "alice/work",
          url: "nats://127.0.0.1:4223",
        });

        const result = discoverSiblingStacks({
          configRoot: root,
          selfPrincipal: "alice",
          selfStack: "default",
          observerCredsDir: observerDir,
        });

        expect(findStack(result, "work")?.credential).toEqual({ kind: "noauth" });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("explicit stacks[] entry keeps its configured credsPath unchanged", () => {
      const { root, observerDir, daemonCreds } = setup();
      try {
        const result = discoverSiblingStacks({
          configRoot: root,
          selfPrincipal: "alice",
          selfStack: "default",
          observerCredsDir: observerDir,
          explicit: [
            {
              stack: "work",
              principal: "alice",
              url: "nats://127.0.0.1:4222",
              credential: { kind: "creds", credsPath: "~/.config/nats/pinned-observer.creds" },
            },
          ],
        });
        expect(findStack(result, "work")?.credential).toEqual({
          kind: "creds",
          credsPath: "~/.config/nats/pinned-observer.creds",
        });
        expect(JSON.stringify(result)).not.toContain(daemonCreds);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("mint hint names the exact scope and the path discovery looks for", () => {
      const hint = observerMintHint({
        principal: "alice",
        siblingStack: "work",
        observerUser: "mc-observer-default-to-work",
        observerCredsPath: "/creds/mc-observer-default-to-work.creds",
      });
      expect(hint).toContain("local.alice.work.agent.>");
      expect(hint).toContain("--deny-pub '>'");
      expect(hint).toContain(
        "arc nats add-bot mc-observer-default-to-work --account <work-account> " +
          "--sub 'local.alice.work.agent.>' --output /creds/mc-observer-default-to-work.creds",
      );
      expect(hint).toContain(
        "nsc generate creds -a <work-account> -n mc-observer-default-to-work " +
          "-o /creds/mc-observer-default-to-work.creds",
      );
    });
  });
});
