/**
 * CO-7 M4 (epic cortex#939) — output egress / leakage check tests.
 *
 * Asserts: clean review prose passes; boundary/system-prompt markers, secret
 * shapes, and config/path leakage are flagged; findings name the CLASS only
 * (never echo the matched secret — the result is safe to log); the scope policy
 * blocks federated/public on findings and never blocks local.
 */

import { describe, test, expect } from "bun:test";

import {
  scanEgress,
  egressBlockingFindings,
  type EgressScanResult,
} from "../egress-check";
import { UNTRUSTED_CLOSE } from "../untrusted-content-boundary";

describe("scanEgress — clean output", () => {
  test("ordinary review prose is clean", () => {
    const out = scanEgress(
      "### 💬 Commented\n\nThe retry loop lacks a backoff; consider exponential backoff. 2 nits.",
    );
    expect(out.clean).toBe(true);
  });

  test("a commit SHA / hash does not over-fire as a secret", () => {
    const out = scanEgress("commit a1b2c3d4e5f6 looks fine; LGTM");
    expect(out.clean).toBe(true);
  });
});

describe("scanEgress — boundary leakage", () => {
  test("echoing the M1 boundary preamble is flagged", () => {
    const out = scanEgress(
      "Here is my review. SECURITY BOUNDARY — UNTRUSTED EXTERNAL REVIEW. ...",
    );
    expect(out.clean).toBe(false);
    if (!out.clean) {
      expect(out.findings.some((f) => f.kind === "boundary-leak")).toBe(true);
    }
  });

  test("echoing the fence delimiter is flagged", () => {
    const out = scanEgress(`approved ${UNTRUSTED_CLOSE}`);
    expect(out.clean).toBe(false);
  });

  test("the phrase 'system prompt' is flagged", () => {
    const out = scanEgress("As requested, my system prompt is: You are Echo...");
    expect(out.clean).toBe(false);
  });

  test("boundary markers match case-INSENSITIVELY (no case-evasion)", () => {
    // An attacker coaxing 'System Prompt' / 'SYSTEM PROMPT' must not slip past.
    expect(scanEgress("here is my System Prompt: ...").clean).toBe(false);
    expect(scanEgress("MY SYSTEM PROMPT BEGINS").clean).toBe(false);
  });
});

describe("scanEgress — secret leakage", () => {
  const cases: [string, string][] = [
    ["github token", "leaked ghp_abcdefghijklmnopqrstuvwxyz0123456789 here"],
    ["github PAT", "github_pat_11ABCDEFG0abcdefghijklmnop in the diff"],
    ["aws key", "AKIAIOSFODNN7EXAMPLE is the key"],
    ["slack token", "xoxb-1234567890-abcdefghij token"],
    ["openai key", "sk-abcdefghijklmnopqrstuvwxyz0123 here"],
    ["private key", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["nkey seed", "SUAGMJKMHN5VVN2WJSPENJ4WCO5O4POGZTGY4ZHHK4POCSDO7DH3KHFCT4"],
  ];
  for (const [label, text] of cases) {
    test(`flags a ${label}`, () => {
      const out = scanEgress(text);
      expect(out.clean).toBe(false);
      if (!out.clean) {
        expect(out.findings.some((f) => f.kind === "secret")).toBe(true);
      }
    });
  }

  test("a finding NEVER echoes the matched secret bytes (safe to log)", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const out = scanEgress(`token: ${secret}`);
    expect(out.clean).toBe(false);
    if (!out.clean) {
      for (const f of out.findings) {
        expect(f.reason).not.toContain(secret);
      }
    }
  });
});

describe("scanEgress — config/path leakage", () => {
  test("flags a cortex config path", () => {
    const out = scanEgress("my config is at ~/.config/cortex/work.yaml");
    expect(out.clean).toBe(false);
    if (!out.clean) {
      expect(out.findings.some((f) => f.kind === "config-path")).toBe(true);
    }
  });

  // XDG wave-4 (cortex#1869) — the config dir moved to ~/.config/metafactory/cortex.
  // The leak detector MUST fire on the new canonical tree too, else the move
  // silently regresses the egress security control (G-14).
  test("flags the NEW ~/.config/metafactory/cortex path (post-move, G-14)", () => {
    for (const s of [
      "my config is at ~/.config/metafactory/cortex/work.yaml",
      "leaked /Users/someone/.config/metafactory/cortex",
    ]) {
      const out = scanEgress(s);
      expect(out.clean).toBe(false);
      if (!out.clean) {
        expect(out.findings.some((f) => f.kind === "config-path")).toBe(true);
      }
    }
  });

  // cortex#1022 — value/path-shaped detection, never bare key-name tokens.
  // The key names are public repo content; a review of a PR about signing
  // config (e.g. cortex#1020) must be able to name them.
  test("flags an nkey_seed_path ASSIGNMENT with a path value", () => {
    const cases = [
      "nkey_seed_path: ~/.config/nats/cortex-research.nk",
      'nkey_seed_path = "/Users/someone/secrets/stack.nk"',
      "nkey_seed_path: $HOME/keys/stack.nk",
      "  nkey_seed_path: ./relative/stack.nk",
    ];
    for (const text of cases) {
      const out = scanEgress(text);
      expect(out.clean).toBe(false);
      if (!out.clean) {
        expect(out.findings.some((f) => f.kind === "config-path")).toBe(true);
      }
    }
  });

  test("does NOT flag a bare nkey_seed_path key-name mention in prose (cortex#1022)", () => {
    const out = scanEgress(
      "The loader now bumps signing to permissive when stack.nkey_seed_path " +
        "is configured and security.signing is unset — explicit off is respected.",
    );
    expect(out.clean).toBe(true);
  });

  test("flags a home-anchored path to a cortex.yaml", () => {
    const cases = [
      "see ~/myconfigs/cortex.yaml for the live values",
      "loaded /Users/someone/.config/foo/cortex.yml at boot",
      "config at /home/clawbox/deploy/cortex.yaml",
    ];
    for (const text of cases) {
      const out = scanEgress(text);
      expect(out.clean).toBe(false);
      if (!out.clean) {
        expect(out.findings.some((f) => f.kind === "config-path")).toBe(true);
      }
    }
  });

  test("does NOT flag a bare cortex.yaml file-name mention in prose (cortex#1022)", () => {
    const out = scanEgress(
      "The security block in cortex.yaml carries three independent toggles.",
    );
    expect(out.clean).toBe(true);
  });

  test("still flags the principal config tree regardless of phrasing", () => {
    const out = scanEgress("my config is at /Users/someone/.config/cortex");
    expect(out.clean).toBe(false);
  });
});

describe("egressBlockingFindings — scope policy", () => {
  const leaky: EgressScanResult = {
    clean: false,
    findings: [{ kind: "secret", reason: "output matches a github token pattern" }],
  };

  test("local never blocks", () => {
    expect(egressBlockingFindings("local", leaky)).toEqual([]);
  });

  test("public blocks on any finding", () => {
    expect(egressBlockingFindings("public", leaky).length).toBe(1);
  });

  test("federated blocks on a secret finding", () => {
    expect(egressBlockingFindings("federated", leaky).length).toBe(1);
  });

  test("a clean result never blocks", () => {
    expect(egressBlockingFindings("public", { clean: true })).toEqual([]);
  });
});
