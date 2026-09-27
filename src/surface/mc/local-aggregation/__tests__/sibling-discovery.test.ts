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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  discoverSiblingStacks,
  observerCredsPath,
  observerMintHint,
  observerUserName,
  type DiscoverSiblingStacksOptions,
  type NoObserverReason,
  type SiblingCredential,
  type SiblingStackDescriptor,
} from "../sibling-discovery";
import {
  writeCredsWithPermissions,
  writeObserverCreds,
  writeStackDir,
} from "./fixtures";

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

  // #2536 — MC must never connect to a sibling with that sibling stack's own
  // creds (stack A would hold stack B's full user). An auto-discovered sibling
  // that declares a `credsPath` connects ONLY with a per-sibling observer creds
  // file found by convention AND scoped to its presence subtree; otherwise it
  // is non-connectable.
  describe("#2536 per-sibling observer creds", () => {
    const OBSERVER_USER = "mc-observer-default-to-work";

    interface Fixture {
      root: string;
      observerDir: string;
      observer: string;
      stackCreds: string;
      discover(extra?: Partial<DiscoverSiblingStacksOptions>): SiblingStackDescriptor[];
      noObserver(reason: NoObserverReason): SiblingCredential;
    }

    /** A `work` sibling (principal `alice`) whose bus uses creds; self = `default`. */
    function setup(): Fixture {
      const root = mkdtempSync(join(tmpdir(), "cortex-disc-obs-"));
      const observerDir = join(root, "observer-creds");
      mkdirSync(observerDir);
      const stackCreds = join(root, "stack-work.creds");
      // The sibling stack's own user: unrestricted (no permissions in the JWT).
      writeCredsWithPermissions(stackCreds, {});
      writeStackDir(root, "work", {
        principal: "alice",
        stackId: "alice/work",
        url: "nats://127.0.0.1:4222",
        credsPath: stackCreds,
      });
      const observer = join(observerDir, `${OBSERVER_USER}.creds`);
      return {
        root,
        observerDir,
        observer,
        stackCreds,
        discover: (extra) =>
          discoverSiblingStacks({
            configRoot: root,
            selfPrincipal: "alice",
            selfStack: "default",
            observerCredsDir: observerDir,
            ...extra,
          }),
        noObserver: (reason) => ({
          kind: "no-observer",
          reason,
          observerUser: OBSERVER_USER,
          observerCredsPath: observer,
        }),
      };
    }

    function withFixture(fn: (f: Fixture) => void): void {
      const f = setup();
      try {
        fn(f);
      } finally {
        rmSync(f.root, { recursive: true, force: true });
      }
    }

    test("observer path convention: mc-observer-<self>-to-<sibling>.creds", () => {
      expect(observerUserName("default", "work")).toBe(OBSERVER_USER);
      expect(observerCredsPath("/creds", "default", "work")).toBe(
        `/creds/${OBSERVER_USER}.creds`,
      );
    });

    test("scoped observer present ⇒ connects with the OBSERVER path, not the stack's", () => {
      withFixture((f) => {
        writeObserverCreds(f.observer, "alice", "work");
        const result = f.discover();
        expect(findStack(result, "work")?.credential).toEqual({
          kind: "creds",
          credsPath: f.observer,
        });
        expect(JSON.stringify(result)).not.toContain(f.stackCreds);
      });
    });

    test("a narrower sub allow inside the presence subtree is accepted", () => {
      withFixture((f) => {
        writeCredsWithPermissions(f.observer, {
          pub: { deny: [">"] },
          sub: { allow: ["local.alice.work.agent.online", "local.alice.work.agent.heartbeat"] },
        });
        expect(findStack(f.discover(), "work")?.credential.kind).toBe("creds");
      });
    });

    test("no observer file ⇒ `no-observer` (missing), sibling stays in the roster", () => {
      withFixture((f) => {
        const result = f.discover();
        // Still listed (the #1008 DB-read roster needs it), but not connectable.
        expect(findStack(result, "work")?.credential).toEqual(f.noObserver("missing"));
        expect(JSON.stringify(result)).not.toContain(f.stackCreds);
      });
    });

    test("observer symlinked to the sibling stack's creds ⇒ refused (is-stack-creds)", () => {
      withFixture((f) => {
        symlinkSync(f.stackCreds, f.observer);
        expect(findStack(f.discover(), "work")?.credential).toEqual(
          f.noObserver("is-stack-creds"),
        );
      });
    });

    test("the sibling stack's creds file sitting AT the observer path ⇒ refused", () => {
      const root = mkdtempSync(join(tmpdir(), "cortex-disc-obs-"));
      try {
        const observerDir = join(root, "creds");
        mkdirSync(observerDir);
        const clash = join(observerDir, `${OBSERVER_USER}.creds`);
        writeObserverCreds(clash, "alice", "work");
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
          reason: "is-stack-creds",
          observerUser: OBSERVER_USER,
          observerCredsPath: clash,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test("a byte copy of the sibling stack's (unrestricted) creds ⇒ refused (over-scoped)", () => {
      withFixture((f) => {
        writeFileSync(f.observer, readFileSync(f.stackCreds), { mode: 0o600 });
        expect(findStack(f.discover(), "work")?.credential).toEqual(
          f.noObserver("over-scoped"),
        );
      });
    });

    test("over-scoped observers are refused", () => {
      const cases: {
        name: string;
        pub?: { allow?: string[]; deny?: string[] };
        sub?: { allow?: string[]; deny?: string[] };
      }[] = [
        { name: "no pub deny", sub: { allow: ["local.alice.work.agent.>"] } },
        {
          name: "pub allow alongside deny",
          pub: { allow: ["local.alice.work.>"], deny: [">"] },
          sub: { allow: ["local.alice.work.agent.>"] },
        },
        { name: "no sub allow (subscribe anything)", pub: { deny: [">"] } },
        {
          name: "sub wider than the presence subtree",
          pub: { deny: [">"] },
          sub: { allow: ["local.alice.work.>"] },
        },
        {
          name: "sub on ANOTHER sibling's subtree",
          pub: { deny: [">"] },
          sub: { allow: ["local.alice.research.agent.>"] },
        },
        {
          name: "extra sub outside the subtree",
          pub: { deny: [">"] },
          sub: { allow: ["local.alice.work.agent.>", "dispatch.task.>"] },
        },
      ];
      for (const c of cases) {
        withFixture((f) => {
          writeCredsWithPermissions(f.observer, {
            ...(c.pub !== undefined && { pub: c.pub }),
            ...(c.sub !== undefined && { sub: c.sub }),
          });
          expect({ case: c.name, cred: findStack(f.discover(), "work")?.credential }).toEqual({
            case: c.name,
            cred: f.noObserver("over-scoped"),
          });
        });
      }
    });

    test("an observer file with no decodable user JWT ⇒ refused (unreadable)", () => {
      withFixture((f) => {
        writeFileSync(f.observer, "not a creds file\n", { mode: 0o600 });
        expect(findStack(f.discover(), "work")?.credential).toEqual(
          f.noObserver("unreadable"),
        );
      });
    });

    test("sibling WITHOUT a stack credsPath keeps the noauth behaviour (open bus)", () => {
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
      withFixture((f) => {
        const result = f.discover({
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
        expect(JSON.stringify(result)).not.toContain(f.stackCreds);
      });
    });

    test("mint hint names the exact scope and the path discovery looks for", () => {
      const path = `/creds/${OBSERVER_USER}.creds`;
      const hint = observerMintHint({
        principal: "alice",
        siblingStack: "work",
        observerUser: OBSERVER_USER,
        observerCredsPath: path,
      });
      expect(hint).toContain("local.alice.work.agent.>");
      expect(hint).toContain(
        `arc nats add-bot ${OBSERVER_USER} --account <work-account> ` +
          `--sub 'local.alice.work.agent.>' --output ${path}`,
      );
      expect(hint).toContain(`nsc edit user -a <work-account> -n ${OBSERVER_USER} --deny-pub '>'`);
      expect(hint).toContain(`nsc generate creds -a <work-account> -n ${OBSERVER_USER} -o ${path}`);
    });
  });
});
