/**
 * G1d / T1 (cortex#1139) — LIVE signing-identity adapter tests.
 *
 * Regression cover for cortex#1236 BLOCKER: the live adapter must expand the
 * portable `~` seed path at the fs boundary so the O_EXCL write and the
 * existence probe target the SAME `$HOME`-rooted path. The CLI tests inject a
 * fake signing port, so this is the only test that exercises the real adapter
 * with a tilde path. HOME is pinned to a tmpdir; the signing port is NOT mocked.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readFileSync, writeFileSync } from "fs";
import { parseDocument } from "yaml";

import { buildSigningIdentityAdapter, buildProvisionConfigWriteAdapter } from "../network-provision-adapters";

describe("buildSigningIdentityAdapter — live, tilde expansion (cortex#1236)", () => {
  let home: string;
  let prevHome: string | undefined;
  const RAW_SEED = "~/.config/nats/andreas-research.seed";

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cortex-provision-home-"));
    process.env.HOME = home;
    // generateStackIdentity writes the seed but does NOT mkdir -p; the real
    // arc-provisioned tree already has ~/.config/nats — mirror that here.
    mkdirSync(join(home, ".config", "nats"), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("generate writes the seed under $HOME, NOT a literal ~ dir", () => {
    const adapter = buildSigningIdentityAdapter();
    const res = adapter.generate({ seedPath: RAW_SEED, force: false });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.nkeyPub).toMatch(/^U/);
      expect(res.fingerprint.length).toBeGreaterThan(0);
    }

    // The seed landed at the EXPANDED path…
    const expanded = join(home, ".config", "nats", "andreas-research.seed");
    expect(existsSync(expanded)).toBe(true);
    // …and NOT in a literal "~" directory under cwd (the bug).
    expect(existsSync(join(process.cwd(), "~"))).toBe(false);
  });

  test("exists agrees with generate on the expanded path (idempotent re-run, no EEXIST)", () => {
    const adapter = buildSigningIdentityAdapter();

    // Before generate: the probe sees nothing.
    expect(adapter.exists(RAW_SEED)).toBe(false);

    const first = adapter.generate({ seedPath: RAW_SEED, force: false });
    expect(first.ok).toBe(true);

    // After generate: the probe (expanded) sees the file the write (expanded)
    // produced. Because they agree, the orchestrator's `signingNeeded =
    // !signingSeedExists` short-circuits on a re-run → generate is never called
    // again → no O_EXCL EEXIST. The divergence this asserts against is the
    // cortex#1236 bug (probe expanded, write literal `~`).
    expect(adapter.exists(RAW_SEED)).toBe(true);
  });
});

// cortex#1265 — the config write-back persists the operator-mode JWTs.
describe("buildProvisionConfigWriteAdapter — operator-mode JWT write-back (cortex#1265)", () => {
  let dir: string;
  const FED = "A" + "B".repeat(55);
  const AGENTS = "A" + "C".repeat(55);
  const SYS = "A" + "S".repeat(55);
  const OP_JWT = "eyJ.op.sig";
  const FED_JWT = "eyJ.fed.sig";
  const SYS_JWT = "eyJ.sys.sig";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-provision-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes operator_jwt/account_jwt/system_account[_jwt] under stack.nats_infra", () => {
    const path = join(dir, "research.yaml");
    writeFileSync(path, "stack:\n  id: andreas/research\n", "utf-8");
    const adapter = buildProvisionConfigWriteAdapter(path);

    const r = adapter.write({
      account: FED,
      agentsAccount: AGENTS,
      credsPath: "~/.config/nats/research.creds",
      configPath: "~/.config/nats/research.conf",
      seedPath: "~/.config/nats/andreas-research.seed",
      operatorJwt: OP_JWT,
      accountJwt: FED_JWT,
      systemAccount: SYS,
      systemAccountJwt: SYS_JWT,
    });
    expect(r.ok).toBe(true);

    const doc = parseDocument(readFileSync(path, "utf-8"));
    expect(doc.getIn(["stack", "nats_infra", "operator_jwt"])).toBe(OP_JWT);
    expect(doc.getIn(["stack", "nats_infra", "account_jwt"])).toBe(FED_JWT);
    expect(doc.getIn(["stack", "nats_infra", "system_account"])).toBe(SYS);
    expect(doc.getIn(["stack", "nats_infra", "system_account_jwt"])).toBe(SYS_JWT);
    // The pre-existing account-tree fields are written too.
    expect(doc.getIn(["stack", "nats_infra", "account"])).toBe(FED);
    // cortex#1265 (PR8) — the per-stack nats-server config path make-live reads.
    expect(doc.getIn(["stack", "nats_infra", "config_path"])).toBe("~/.config/nats/research.conf");
  });

  test("omitted JWT fields are NOT written (never clobber a hand-tuned value)", () => {
    const path = join(dir, "research.yaml");
    writeFileSync(path, "stack:\n  id: andreas/research\n  nats_infra:\n    system_account: AKEEPME\n", "utf-8");
    const adapter = buildProvisionConfigWriteAdapter(path);

    // No system fields passed (SYS absent) — the existing system_account survives.
    adapter.write({
      account: FED,
      agentsAccount: AGENTS,
      credsPath: "~/c.creds",
      configPath: "~/.config/nats/research.conf",
      seedPath: "~/s.seed",
      operatorJwt: OP_JWT,
      accountJwt: FED_JWT,
    });

    const doc = parseDocument(readFileSync(path, "utf-8"));
    expect(doc.getIn(["stack", "nats_infra", "operator_jwt"])).toBe(OP_JWT);
    // The pre-existing system_account was NOT clobbered.
    expect(doc.getIn(["stack", "nats_infra", "system_account"])).toBe("AKEEPME");
    expect(doc.getIn(["stack", "nats_infra", "system_account_jwt"])).toBeUndefined();
  });
});
