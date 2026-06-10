import type { ReviewVerdictKind } from "../bus/review-events";

/**
 * Shared verdict-block parser (cortex#888).
 *
 * The reviewing skill / substrate emits a structured verdict block as the
 * terminal artefact of its stdout (a fenced ```json block, §4.5). Two runners
 * consume it: the Claude-Code substrate path (`review-pipeline.ts`) and the
 * `pi-dev` substrate path (`substrate/pi-dev-runner.ts`, where sage's
 * `--emit-verdict-block` output lands). Extracted here so both parse the SAME
 * contract — a single field-validation table, one place to evolve.
 */

/** Internal shape of the parsed verdict block per §4.5's contract. */
export interface VerdictBlock {
  verdict: ReviewVerdictKind;
  summary: string;
  github_review_id: number;
  github_review_url: string;
  submitted_at: string;
  commit_id: string;
  findings: { blockers: number; majors: number; nits: number };
  inline_comments: number;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; detail: string };

/**
 * Extract the LAST fenced JSON block from a stream's response text.
 *
 * Per §4.5 the skill emits the verdict block at the end of its output;
 * picking the last block is robust against the skill emitting earlier
 * exploratory JSON (e.g. lens-internal scratch output) before the
 * terminal verdict. Returns the raw block text (still fenced-free) for
 * the JSON parser, or `null` if no block is present.
 *
 * The fence regex accepts both ```json and ```JSON (case-insensitive
 * tag) and tolerates a `\r\n` line-ending — Windows-line-ending output
 * is rare but cheap to support.
 */
export function extractVerdictBlock(response: string): string | null {
  const re = /```json\s*\r?\n([\s\S]*?)\r?\n```/gi;
  const matches: string[] = [];
  let m: RegExpExecArray | null = re.exec(response);
  while (m !== null) {
    if (m[1] !== undefined) matches.push(m[1]);
    m = re.exec(response);
  }
  if (matches.length === 0) return null;
  // Last block wins — §4.5 says the verdict is the terminal artefact.
  // Type assertion safe because length is checked above.
  return matches[matches.length - 1] ?? null;
}

/**
 * Parse + validate the verdict block JSON. Returns a structured error
 * detail for any failure mode (JSON parse, missing field, wrong type,
 * out-of-enum verdict). The detail flows into the `cant_do` envelope's
 * `reason.detail` so principals can see which field tripped on the
 * dashboard.
 *
 * Validation is hand-rolled (no Zod) to keep the runner dependency-free
 * and because the contract is small (8 fields).
 */
export function parseVerdictBlock(raw: string): ParseResult<VerdictBlock> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `JSON.parse failed: ${detail}` };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, detail: "expected JSON object at top level" };
  }
  const obj = value as Record<string, unknown>;

  const verdict = obj.verdict;
  if (
    verdict !== "approved" &&
    verdict !== "changes-requested" &&
    verdict !== "commented"
  ) {
    return {
      ok: false,
      detail: `verdict must be one of "approved" | "changes-requested" | "commented" (got ${JSON.stringify(verdict)})`,
    };
  }

  if (typeof obj.summary !== "string") {
    return { ok: false, detail: "summary must be a string" };
  }
  if (typeof obj.github_review_id !== "number" || !Number.isInteger(obj.github_review_id)) {
    return { ok: false, detail: "github_review_id must be an integer" };
  }
  if (typeof obj.github_review_url !== "string") {
    return { ok: false, detail: "github_review_url must be a string" };
  }
  if (typeof obj.submitted_at !== "string") {
    return { ok: false, detail: "submitted_at must be a string (ISO 8601)" };
  }
  if (typeof obj.commit_id !== "string") {
    return { ok: false, detail: "commit_id must be a string" };
  }
  if (typeof obj.inline_comments !== "number" || !Number.isInteger(obj.inline_comments)) {
    return { ok: false, detail: "inline_comments must be an integer" };
  }
  if (
    typeof obj.findings !== "object" ||
    obj.findings === null ||
    Array.isArray(obj.findings)
  ) {
    return { ok: false, detail: "findings must be an object" };
  }
  const findings = obj.findings as Record<string, unknown>;
  if (typeof findings.blockers !== "number" || !Number.isInteger(findings.blockers)) {
    return { ok: false, detail: "findings.blockers must be an integer" };
  }
  if (typeof findings.majors !== "number" || !Number.isInteger(findings.majors)) {
    return { ok: false, detail: "findings.majors must be an integer" };
  }
  if (typeof findings.nits !== "number" || !Number.isInteger(findings.nits)) {
    return { ok: false, detail: "findings.nits must be an integer" };
  }

  return {
    ok: true,
    value: {
      verdict,
      summary: obj.summary,
      github_review_id: obj.github_review_id,
      github_review_url: obj.github_review_url,
      submitted_at: obj.submitted_at,
      commit_id: obj.commit_id,
      findings: {
        blockers: findings.blockers,
        majors: findings.majors,
        nits: findings.nits,
      },
      inline_comments: obj.inline_comments,
    },
  };
}
