/**
 * The conventional directory for per-user NATS `.creds` files cortex reads or
 * asks the principal to mint (agent bots via `cortex creds`, MC sibling
 * observers via #2536). Tilde-prefixed; callers `expandTilde` it at use time.
 *
 * One definition so the `cortex creds` CLI and the MC sibling-observer
 * convention cannot drift apart.
 */
export const DEFAULT_NATS_CREDS_DIR = "~/.config/nats/creds";
