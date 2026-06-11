/**
 * W5.0 (cortex#924) — signed-commit enforcement for the dev-loop.
 *
 * ## Policy
 *
 * Every commit the loop produces MUST be signed; signing is NEVER disabled.
 * Two enforcement surfaces, both fail-closed:
 *
 *   1. `assertSigningConfig` — a precondition guard. Before a dev/release
 *      session is allowed to commit, the git signing config must be ON
 *      (`commit.gpgsign=true`, a `user.signingkey` set, a `gpg.format`), and
 *      for the SSH signer the agent socket must be present (`SSH_AUTH_SOCK` —
 *      proof the key was loaded, e.g. via `ssh-add --apple-load-keychain`).
 *      A missing/false knob throws {@link SigningDisabledError} rather than
 *      silently producing unsigned commits.
 *
 *   2. `verifyCommitsSigned` — a postcondition check at the push boundary
 *      (`DevForge.openPr` / `ReleaseExecutor.cutRelease`). It reads
 *      `git log --format=%G?` over the commits about to be pushed and PASSES
 *      iff EVERY commit's signature trust is `G` (a good, fully-trusted
 *      signature). Anything short — `N` (unsigned), `B` (bad), `E` (cannot
 *      check), or the good-but-lower `U`/`X`/`Y`/`R` — fails closed. The push
 *      is refused; the loop NEVER lands an unsigned commit.
 *
 * `%G?` legend (git pretty-format): G=good, B=bad, U=good-untrusted,
 * X=good-expired, Y=good-expired-key, R=good-revoked-key, E=cannot-check,
 * N=no-signature. We require the strictest `G` — a dev-loop commit on a
 * protected branch should carry a fully-trusted signature, not a "good but
 * unverifiable" one.
 *
 * ## What this module does NOT do
 *
 * It never *creates* a commit and never passes `--no-gpg-sign` — there is no
 * code path here that can disable signing. Disabling is the prohibited
 * operation; this module's only verbs are *assert* and *verify*. The commit
 * itself is made by the CC session (which inherits the signing config from its
 * env); the runner enforces the policy around it.
 *
 * Pure where it can be: `parseSignatureTrust` + `verifyCommitsSigned` +
 * `assertSigningConfig` take plain inputs and return values / throw. The
 * git-spawning wrapper (`readCommitSignatures`) is the thin IO seam.
 */

/**
 * A `%G?` signature-trust token. The known git levels are G=good-trusted,
 * B=bad, U=good-untrusted, X=good-expired, Y=good-expired-key,
 * R=good-revoked-key, E=cannot-check, N=no-signature. Typed as `string` (not a
 * literal union) so an unknown/future token parses without a cast and is
 * treated defensively as not-`G` by {@link verifyCommitsSigned}.
 */
export type SignatureTrust = string;

/**
 * Parse `git log --format=%G?` output into one trust char per commit. Blank
 * lines are dropped (a trailing newline is normal). Pure.
 */
export function parseSignatureTrust(stdout: string): SignatureTrust[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Result of {@link verifyCommitsSigned}. */
export type VerifyResult =
  | { ok: true; count: number }
  | { ok: false; reason: string; badCount: number };

/**
 * True iff EVERY commit carries a good, fully-trusted signature (`G`). An
 * empty set fails closed — "nothing to verify" is not "all signed", and the
 * caller should never reach the push with zero commits on the branch. Pure.
 */
export function verifyCommitsSigned(
  trusts: readonly SignatureTrust[],
): VerifyResult {
  if (trusts.length === 0) {
    return {
      ok: false,
      reason: "no commits to verify — refusing to push (fail-closed)",
      badCount: 0,
    };
  }
  const bad = trusts.filter((t) => t !== "G");
  if (bad.length > 0) {
    // Summarize the distinct offending trust levels for the failure detail.
    const distinct = [...new Set(bad)].join(",");
    return {
      ok: false,
      reason: `${bad.length} of ${trusts.length} commits not fully-signed (trust levels: ${distinct}; require G)`,
      badCount: bad.length,
    };
  }
  return { ok: true, count: trusts.length };
}

/** Thrown when the signing config is off/incomplete — fail-closed precondition. */
export class SigningDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningDisabledError";
  }
}

/** The signing-relevant git config + env, as plain strings (caller reads them). */
export interface SigningConfig {
  /** `git config commit.gpgsign` — must be "true". */
  gpgSign: string | undefined;
  /** `git config gpg.format` — "ssh" or "openpgp". */
  gpgFormat: string | undefined;
  /** `git config user.signingkey` — must be non-empty. */
  signingKey: string | undefined;
  /** `SSH_AUTH_SOCK` from the env — required for the ssh signer. */
  sshAuthSock: string | undefined;
}

/**
 * Assert the environment is configured to sign commits. Throws
 * {@link SigningDisabledError} (naming the offending knob) when:
 *   - `commit.gpgsign` is not "true" (signing is off);
 *   - `user.signingkey` is unset/empty (no key to sign with);
 *   - the signer is `ssh` but `SSH_AUTH_SOCK` is absent — the key was never
 *     loaded into the agent (the `ssh-add --apple-load-keychain` step the
 *     dev-loop env MUST run; its absence is the "key-reload lesson").
 *
 * Never disables anything; the only outcomes are pass (return) or refuse
 * (throw). Pure.
 */
export function assertSigningConfig(cfg: SigningConfig): void {
  if (cfg.gpgSign?.trim().toLowerCase() !== "true") {
    throw new SigningDisabledError(
      `commit signing is disabled: commit.gpgsign=${JSON.stringify(cfg.gpgSign)} (must be "true") — NEVER run the dev-loop with signing off`,
    );
  }
  if (!cfg.signingKey || cfg.signingKey.trim() === "") {
    throw new SigningDisabledError(
      "commit signing is misconfigured: user.signingkey is unset — no key to sign commits with",
    );
  }
  const format = cfg.gpgFormat?.trim().toLowerCase();
  if (format === "ssh" && (!cfg.sshAuthSock || cfg.sshAuthSock.trim() === "")) {
    throw new SigningDisabledError(
      "ssh commit signing configured but SSH_AUTH_SOCK is unset — the signing key was not loaded into the agent (run `ssh-add --apple-load-keychain` in the dev-loop env)",
    );
  }
}

/** IO seam — runs `git log --format=%G?` over the commit range. */
export interface CommitSigningIO {
  /**
   * Return the raw stdout of `git -C <cwd> log --format=%G? <range>`. `range`
   * selects the commits about to be pushed (e.g. `origin/main..HEAD`). Throws
   * on a non-zero git exit (the caller maps the throw to a refusal).
   */
  gitSignatureLog: (cwd: string, range: string) => Promise<string>;
}

/**
 * Read + verify the signatures of the commits in `range` at `cwd`. Composes
 * the IO seam with the two pure functions. Returns the {@link VerifyResult};
 * the caller refuses the push on `ok: false`.
 */
export async function readCommitSignatures(
  io: CommitSigningIO,
  cwd: string,
  range: string,
): Promise<VerifyResult> {
  const out = await io.gitSignatureLog(cwd, range);
  return verifyCommitsSigned(parseSignatureTrust(out));
}
