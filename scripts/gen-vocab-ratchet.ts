#!/usr/bin/env bun
/**
 * gen-vocab-ratchet.ts — generator + drift-guard for scripts/vocab-ratchet.json
 * (compass#98 F17).
 *
 * The machine-readable vocabulary-ratchet manifest is the ONE source that both
 * the merge gate (scripts/check-carveouts.sh) and — in a later PR (F17-skill) —
 * the review lens read. This script GENERATES that manifest so the two carriers
 * never drift:
 *
 *   • `terms`     — the ratchet rules. Each rule's `avoid` alias-cluster is
 *                   parsed live from CONTEXT.md `_Avoid_` blocks (the deeper
 *                   single source of the domain vocabulary); the enforced subset,
 *                   the grep `pattern`, severity, and match-flags are the gate's
 *                   own tuning, embedded here. Generation FAILS if a
 *                   ratchet-enforced alias is not actually a CONTEXT.md-deprecated
 *                   term (validates the manifest against CONTEXT.md `_Avoid_`).
 *
 *   • `carveouts` — the carve-out allowlist (paths + line patterns + the
 *                   myelin-gated transition-test suppressions), migrated verbatim
 *                   from scripts/check-carveouts.sh at F17. The string values are
 *                   authoritative here; the FULL per-entry rationale + RETIRE
 *                   conditions for every carve-out live in
 *                   docs/migrations/0002-vocabulary-finish-2026-05.md and in the
 *                   pre-F17 git history of scripts/check-carveouts.sh. Entries are
 *                   grouped by carve-out CLASS below.
 *
 * DRIFT GUARD: `bun scripts/gen-vocab-ratchet.ts --check` re-derives the manifest
 * and diffs it against the committed scripts/vocab-ratchet.json — CI fails if they
 * differ (a CONTEXT.md `_Avoid_` change not regenerated, or a hand-edit of the
 * generated JSON). Regenerate with `bun scripts/gen-vocab-ratchet.ts --write`.
 *
 * Usage:
 *   bun scripts/gen-vocab-ratchet.ts            # print manifest JSON to stdout
 *   bun scripts/gen-vocab-ratchet.ts --write    # (re)write scripts/vocab-ratchet.json
 *   bun scripts/gen-vocab-ratchet.ts --check     # exit 1 if committed != generated
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..");
const CONTEXT_PATH = join(REPO_ROOT, "CONTEXT.md");
const MANIFEST_PATH = join(REPO_ROOT, "scripts", "vocab-ratchet.json");

// ─────────────────────────────────────────────────────────────────────────────
// ENFORCEMENT POLICY (the gate's own tuning). One entry per ratchet rule. The
// `avoid` alias-cluster is attached from CONTEXT.md (see contextTerm/explicitAvoid);
// `ratchetEnforced` is the subset of that cluster the `pattern` actually greps for
// and MUST be a CONTEXT.md-deprecated term (validated at generation).
// ─────────────────────────────────────────────────────────────────────────────
type Severity = "critical" | "important";
interface Rule {
  canonical: string; // the canonical term to use instead
  contextTerm: string | null; // CONTEXT.md **Term** whose _Avoid_ list is this rule's cluster
  explicitAvoid?: string[]; // used when the alias is not a _Avoid_ comma-list member
  ratchetEnforced: string[]; // aliases the pattern catches (validated ∈ CONTEXT.md corpus)
  severity: Severity;
  caseInsensitive: boolean; // per-term match flag (operator: also the all-caps form)
  optIn: boolean; // off by default; enabled by check-carveouts.sh --persona
  pattern: string; // POSIX ERE the gate greps (authoritative for the gate)
  context: string; // provenance note
}

const RULES: Rule[] = [
  {
    canonical: "principal",
    contextTerm: "Principal",
    ratchetEnforced: ["operator"],
    severity: "critical",
    caseInsensitive: true, // F18: also the SCREAMING_SNAKE all-caps form
    optIn: false,
    pattern: "[Oo]perator|OPERATOR",
    context:
      "CONTEXT.md §Principal _Avoid_ + Flagged ambiguities (operator → principal); R1/R2/R8/R13 cluster",
  },
  {
    canonical: "assistant",
    contextTerm: "Assistant",
    ratchetEnforced: ["bot"],
    severity: "critical",
    caseInsensitive: false,
    optIn: false,
    pattern: "\\bBotConfig(Schema)?\\b",
    context:
      "CONTEXT.md §Assistant/Agent _Avoid_ (bot); R7.A BotConfig daemon-config type",
  },
  {
    canonical: "Offer",
    contextTerm: null,
    explicitAvoid: ["broadcast"],
    ratchetEnforced: ["broadcast"],
    severity: "critical",
    caseInsensitive: false,
    optIn: false,
    pattern: "distribution_mode[[:space:]]*[:=][[:space:]]*[\"']broadcast",
    context:
      "CONTEXT.md Flagged ambiguities (broadcast → Offer); R5 distribution_mode emission (write-side only)",
  },
  {
    canonical: "assistant",
    contextTerm: "Assistant",
    ratchetEnforced: ["persona"],
    severity: "important",
    caseInsensitive: false,
    optIn: true, // R6: persona: field + personas/ path are carve-outs; off by default
    pattern: "\\bpersona\\b",
    context:
      "CONTEXT.md §Assistant _Avoid_ + Flagged ambiguities (persona → assistant); opt-in via --persona",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// CARVE-OUT ALLOWLIST — migrated verbatim from scripts/check-carveouts.sh (F17).
// A hit whose repo-relative path contains one of these substrings is NEVER a
// violation. Grouped by class; full per-entry rationale + RETIRE conditions:
// docs/migrations/0002-vocabulary-finish-2026-05.md + pre-F17 check-carveouts.sh.
// ─────────────────────────────────────────────────────────────────────────────
const CARVEOUT_PATHS: string[] = [
  // GROVE_* / CORTEX_* env tier (separate migration, retires MIG-8) + migrate-config legacy reader
  "src/taps/cc-events/hooks/lib/principal-env.ts",
  "src/taps/cc-events/hooks/__tests__/",
  "src/taps/cc-events/wrangler.toml",
  "src/cli/cortex/commands/migrate-config-lib.ts",
  "src/cli/cortex/commands/__tests__/migrate-config-policy.test.ts",
  "src/cli/cortex/commands/__tests__/migrate-config.test.ts",
  // Frozen SQL DDL — historical migrations, never edited
  "src/surface/mc/worker/migrations/0001",
  "src/surface/mc/worker/migrations/0002",
  "src/surface/mc/worker/migrations/0003",
  "src/surface/mc/worker/migrations/0004",
  // Vocabulary manifests + the CONTEXT.md contract (they DEFINE the deprecated terms)
  "docs/migrations/0001-vocabulary-grilled-2026-05.md",
  "docs/migrations/0002-vocabulary-finish-2026-05.md",
  "CONTEXT.md",
  // The gate's own source + CI definition necessarily NAME the deprecated terms
  "scripts/check-carveouts.sh",
  ".github/workflows/",
  // Policy authorization-role cluster — `operator` = reserved authz ROLE/capability literal
  "src/common/policy/",
  "docs/design-policy-cutover.md",
  "cortex.yaml.example",
  // MC user-auth RBAC tier `viewer|operator|admin`
  "src/surface/mc/worker/src/user-auth/",
  // EventBridge comparison OPERATOR (programming term, not the vocab)
  "src/bus/payload-filter.ts",
  "src/bus/__tests__/payload-filter.test.ts",
  // Legacy-reader config-test fixtures (flat api.operatorId slot)
  "src/common/config/__tests__/loader.test.ts",
  "src/common/config/__tests__/watcher.test.ts",
  // NSC trust/signing infrastructure — `operator` = the NATS account operator
  "src/common/agents/trust-resolver.ts",
  "src/common/agents/__tests__/trust-resolver-operator-verify.test.ts",
  "src/common/config/account-signing-key.ts",
  "src/common/config/stack-signing-key.ts",
  "src/bus/nats/connection.ts",
  "src/common/config/__tests__/account-signing-key.test.ts",
  "src/common/config/__tests__/stack-signing-key.test.ts",
  "docs/design-g1-account-topology.md",
  // NSC provision / make-live tooling + tests + design docs (NATS account-tree sense)
  "src/cli/cortex/commands/operator-provisioning.ts",
  "src/cli/cortex/commands/network-provision-lib.ts",
  "src/cli/cortex/commands/network-provision-adapters.ts",
  "src/cli/cortex/commands/network-federation-wiring.ts",
  "src/cli/cortex/commands/network-make-live-lib.ts",
  "src/cli/cortex/commands/network-make-live-adapters.ts",
  "src/cli/cortex/commands/__tests__/network-make-live.test.ts",
  "src/cli/cortex/commands/__tests__/network-make-live-cli.test.ts",
  "src/common/nats/__tests__/leaf-remote-renderer.test.ts",
  "docs/design-make-live-daemon-switch.md",
  "src/cli/cortex/commands/__tests__/operator-provisioning.test.ts",
  "src/cli/cortex/commands/__tests__/network-provision-lib.test.ts",
  "src/cli/cortex/commands/__tests__/network-provision-cli.test.ts",
  "src/cli/cortex/commands/__tests__/network-provision-integration.test.ts",
  "src/cli/cortex/commands/operator-mode-export.ts",
  "src/cli/cortex/commands/__tests__/operator-mode-export.test.ts",
  "docs/design-wrap-server-config-tooling.md",
  // NSC onboarding / ADR / runbook design docs (sovereign-federation NSC operator)
  "docs/design-own-operator-onboarding.md",
  "docs/adr/0013-sovereign-federation-model.md",
  "docs/adr/0015-two-tier-onboarding-and-admission-gate.md",
  "docs/design-admission-gate-leaf-secret.md",
  "docs/design-federation-hub-mode-and-join.md",
  "docs/runbook-leaf-cred-issuance.md",
  "docs/sop-onboard-peer-principal.md",
  // 2026-07-07 design-drop vision text (verbatim principal-authored artifact; its
  // glossary line explicitly RECORDS the operator→principal deprecation)
  "docs/mockups/mc-layouts/Vision - Internet of Agentic Work (v2).md",
  // HISTORICAL removed-field guard test (v3-REMOVED config.agent.operatorId)
  "src/__tests__/principal-identity-consistency.test.ts",
  // Legacy migration examples / fixtures / archive (demonstrate the migrate-config reader)
  "docs/migration-examples/",
  "src/cli/cortex/commands/__tests__/fixtures/",
  "docs/archive/",
  // Policy converter + normalize-config (name the legacy operator: block / home_operator key)
  "src/cli/cortex/commands/migrate-config-policy.ts",
  "src/cli/cortex/commands/normalize-config.ts",
  "src/cli/cortex/commands/__tests__/normalize-config.test.ts",
  // IAW design/plan/test — code-identifier mentions discussed as prose (#510)
  "docs/design-internet-of-agentic-work.md",
  "docs/plan-internet-of-agentic-work.md",
  "src/__tests__/iaw-phase-d-integration.test.ts",
  // F18 (compass#98): all-caps NSC operator-mode survivors + R9 env-guard + posture-rename guard
  "src/common/nats/leaf-remote-renderer.ts",
  "src/common/nats/__tests__/nats-config-bind-account.test.ts",
  "src/common/nats/__tests__/operator-mode-conversion.test.ts",
  "src/cli/cortex/commands/__tests__/network-adapters.test.ts",
  "src/cli/cortex/commands/__tests__/network-lib.test.ts",
  "src/taps/cc-events/hooks/lib/__tests__/principal-env.test.ts",
  "src/surface/mc/dashboard-v2/__tests__/mc-shell.test.tsx",
  // F17 (compass#98): the manifest + its generator NAME the deprecated terms as data —
  // same "gate's own source" class as scripts/check-carveouts.sh (keeps diff-mode clean).
  "scripts/vocab-ratchet.json",
  "scripts/gen-vocab-ratchet.ts",
];

// ─────────────────────────────────────────────────────────────────────────────
// CARVE-OUT LINE PATTERNS — a matched deprecated-term line is dropped when it ALSO
// matches one of these (POSIX ERE, OR-joined). Grouped by class; migrated verbatim
// from scripts/check-carveouts.sh (F17).
// ─────────────────────────────────────────────────────────────────────────────
const CARVEOUT_LINE_PATTERNS: string[] = [
  // Explicit historical markers
  "//[[:space:]]*historical:",
  "<!--[[:space:]]*historical",
  // NSC / NATS account operator vocabulary
  "\\bOP_[A-Z0-9]",
  "\\bnsc\\b",
  "accountSigningKey",
  "operator-account",
  "operator[[:space:]]+(NKey|JWT|account)",
  "(NKey|JWT|account)[[:space:]]+operator",
  "[Oo]peratorAccount",
  "[Oo]peratorVerifier",
  "verify[Oo]perator",
  "[Oo]peratorSign",
  "operator_pubkey",
  "operator-mode",
  "[Oo]peratorRecord",
  // O-3 NSC operator-mode-conversion vocabulary (operator JWT the leaf binds under)
  "[Oo]peratorMode",
  "operatorJwt",
  "operator_jwt",
  "--operator-jwt",
  "operator:[[:space:]]*\\$\\{?operatorJwt",
  "`operator:",
  "operator[[:space:]]+(JWT|that owns)",
  "foreign-operator",
  "operator: eyJ",
  "A_DIFFERENT_OPERATOR",
  "operator-onboarding",
  "operator\\.(nk|nkey|creds|seed)",
  // R7-gated network.operator block (operatorDiscordId/Mattermost/Slack)
  "operator(DiscordId|MattermostId|SlackId|PlatformIds|Role|RoleId)",
  // Legacy config-key tokens (R2.D/R2.I/R2.G + cortex#429 PR-C) — narrow survivors only
  "\\bapi\\.operatorId\\b",
  "operatorId:[[:space:]]*z\\.string\\(\\)\\.default\\(\"\"\\)",
  "agent\\.operatorId",
  "agent\\.operator(Id|Name)",
  "operatorId/(operatorName|Discord)",
  "operator(Id|_id)[^A-Za-z]{0,4}(→|->)[^A-Za-z]{0,4}principal",
  "legacy `operatorId:`",
  "operatorId:\"",
  "dashboard.{0,3}`?operatorId",
  "`operatorId:?`",
  "(sessions|tasks|github_events|usage_snapshots)\\.operator_id",
  "idx_sessions_operator",
  "payload\\.operator_id",
  "\\bp\\.operator_id",
  // Policy authz-role predicates
  "isOperatorPrincipal",
  "isOperator\\(",
  // R4 rename-map prose + legacy operator: config-block reader + authz-role literals
  "operator(\\.id|`)?[[:space:]]*(→|->|renamed|is being renamed)",
  "(renamed|rename)[[:space:]]*`?operator",
  "`operator:`",
  "\\boperator\\.id\\b",
  "\\braw\\.operator\\b",
  "\\bhasOperator\\b",
  "\\bnetwork\\.operator\\b",
  "operator:[[:space:]]*z\\.object",
  "operator:.*→.*principal:|`operator:`→`principal:`",
  "an operator\\?|`operator`[[:space:]]*(capability|role)",
  "'operator',?[[:space:]]*'code-reviewer'",
  "operator_\\*",
  "operator\\*Id",
  "principal/operator",
  "(role|roles|id|capability|allow)[^A-Za-z]{1,4}[\"(]operator",
  "\\broles?:[[:space:]]*\\[operator",
  // GROVE_* env tier (separate migration)
  "GROVE_OPERATOR",
  "GROVE_[A-Z]",
  // grove historical references + grove-bot NATS link name + historical filename
  "grove-v2",
  "grove-dashboard",
  "grove-bot",
  "design-dm-operator-channel",
  // Platform-bot contexts
  "trustedBotIds",
  "botUserId",
  "message\\.author\\.bot",
  "author\\.bot",
  // myelin-GATED transition shims — MUST NOT flag (wait for the myelin cut)
  "\\{org\\}",
  "orgFrom(Config|Envelope)",
  "target_assistant[[:space:]]*\\?\\?[[:space:]]*target_principal",
  "identity[[:space:]]*\\?\\?[[:space:]]*(stamp\\.|signer\\.|opts\\.signedBy.*)?principal",
  "\\.identity[[:space:]]*\\?\\?",
  "(deprecated alias|back-compat|transition schema still accepts)",
  // Reference labels (proper-name feature/vision labels, not vocab usage)
  "Operator vision",
  "[Oo]perator-driven dev-loop",
  "design-operator-driven-dev-loop",
  // F18 (compass#98): all-caps line carve-outs — fake Slack test-ID + external SOC-demo env ref
  "UOPERATOR",
  "CHANNEL_ID/OPERATOR_ID",
];

// myelin-GATED transition-test files (R5 back-compat regression suite): the bare
// fixture line `distribution_mode: "broadcast"` carries no per-line marker, so it
// is suppressed at file granularity. RETIRE at the myelin R5/R11 breaking cut.
const GATED_TEST_PATHS: string[] = [
  "src/bus/myelin/__tests__/envelope-validator.test.ts",
];
// Gated-shim terms allowed to appear in a gated transition-test file.
const GATED_TERM_PATTERN = "broadcast|target_principal|\\bprincipal\\b";

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT.md parsing — the deeper single source of the domain vocabulary.
// ─────────────────────────────────────────────────────────────────────────────
/** Map each **Term** header to the cleaned alias list from its first `_Avoid_:` line. */
function parseAvoidByTerm(md: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let term: string | null = null;
  for (const line of md.split("\n")) {
    const header = line.match(/^\*\*([^*]+)\*\*/);
    if (header?.[1] && /:\s*$/.test(line)) {
      term = header[1].trim();
      continue;
    }
    const avoid = line.match(/^_Avoid_:\s*(.*)$/);
    if (avoid?.[1] !== undefined && term && !out.has(term)) {
      out.set(term, cleanAliasList(avoid[1]));
    }
  }
  return out;
}

/** Split a `_Avoid_:` value into simple aliases (drop trailing prose + parentheticals). */
function cleanAliasList(s: string): string[] {
  const sentenceBreak = s.search(/\.\s/);
  const head = sentenceBreak >= 0 ? s.slice(0, sentenceBreak) : s;
  return head
    .split(",")
    .map((t) => t.replace(/\(.*?\)/g, "").replace(/\.$/, "").trim())
    .filter((t) => t.length > 0);
}

/** All CONTEXT.md-deprecated terms: every `_Avoid_` alias + every Flagged-ambiguity rename source. */
function buildCorpus(md: string, avoidByTerm: Map<string, string[]>): Set<string> {
  const corpus = new Set<string>();
  for (const aliases of avoidByTerm.values())
    for (const a of aliases) corpus.add(a.toLowerCase());
  for (const m of md.matchAll(/^_Avoid_:\s*(.*)$/gm)) {
    const value = m[1] ?? "";
    for (const t of value.split(",")) {
      const c = (t.replace(/\(.*?\)/g, "").split(/[.;:]/)[0] ?? "")
        .trim()
        .toLowerCase();
      if (/^[a-z][a-z0-9 _-]*$/.test(c)) corpus.add(c);
    }
  }
  // Flagged-ambiguity renames: **`x` → `y`.**  (x is the deprecated term)
  for (const m of md.matchAll(/\*\*`([^`]+)`\s*(?:→|->)/g)) {
    const dep = m[1];
    if (dep) corpus.add(dep.trim().toLowerCase());
  }
  return corpus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the manifest.
// ─────────────────────────────────────────────────────────────────────────────
function buildManifest(): unknown {
  const md = readFileSync(CONTEXT_PATH, "utf8");
  const avoidByTerm = parseAvoidByTerm(md);
  const corpus = buildCorpus(md, avoidByTerm);

  const terms = RULES.map((r) => {
    let avoid: string[];
    if (r.explicitAvoid) {
      avoid = r.explicitAvoid;
    } else {
      const list = avoidByTerm.get(r.contextTerm!);
      if (!list || list.length === 0) {
        throw new Error(
          `gen-vocab-ratchet: CONTEXT.md has no _Avoid_ cluster for term "${r.contextTerm}" ` +
            `(rule canonical="${r.canonical}", pattern=${r.pattern})`,
        );
      }
      avoid = list;
    }
    // VALIDATE: every ratchet-enforced alias must be a CONTEXT.md-deprecated term.
    for (const enforced of r.ratchetEnforced) {
      if (!corpus.has(enforced.toLowerCase())) {
        throw new Error(
          `gen-vocab-ratchet: ratchet-enforced alias "${enforced}" is not in CONTEXT.md ` +
            `_Avoid_ / Flagged-ambiguity corpus — manifest would drift from CONTEXT.md.`,
        );
      }
    }
    return {
      canonical: r.canonical,
      avoid,
      ratchetEnforced: r.ratchetEnforced,
      severity: r.severity,
      caseInsensitive: r.caseInsensitive,
      optIn: r.optIn,
      pattern: r.pattern,
      context: r.context,
    };
  });

  return {
    _comment:
      "GENERATED by scripts/gen-vocab-ratchet.ts — DO NOT hand-edit. `terms` are " +
      "parsed from CONTEXT.md _Avoid_; `carveouts` are the check-carveouts.sh allowlist. " +
      "Regenerate: bun scripts/gen-vocab-ratchet.ts --write. CI asserts gen == committed.",
    terms,
    carveouts: {
      paths: CARVEOUT_PATHS,
      linePatterns: CARVEOUT_LINE_PATTERNS,
      gatedTestPaths: GATED_TEST_PATHS,
      gatedTermPattern: GATED_TERM_PATTERN,
    },
  };
}

function render(): string {
  return JSON.stringify(buildManifest(), null, 2) + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
const arg = process.argv[2] ?? "";
const generated = render();

if (arg === "--write") {
  writeFileSync(MANIFEST_PATH, generated);
  process.stdout.write(`wrote ${MANIFEST_PATH}\n`);
} else if (arg === "--check") {
  let committed = "";
  try {
    committed = readFileSync(MANIFEST_PATH, "utf8");
  } catch {
    process.stderr.write(
      `gen-vocab-ratchet: committed manifest missing at ${MANIFEST_PATH}\n`,
    );
    process.exit(1);
  }
  if (committed !== generated) {
    process.stderr.write(
      "gen-vocab-ratchet: DRIFT — scripts/vocab-ratchet.json is out of date.\n" +
        "Run: bun scripts/gen-vocab-ratchet.ts --write\n",
    );
    process.exit(1);
  }
  process.stdout.write("gen-vocab-ratchet: OK — committed manifest matches generator.\n");
} else {
  process.stdout.write(generated);
}
