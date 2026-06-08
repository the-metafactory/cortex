-- cortex#787 (C-787 — per-stack pubkeys): backfill the per-stack signing key
-- onto every EXISTING principal's stacks so a principal can federate more than
-- one stack without regressing the federation it already has.
--
-- Background
-- ──────────
-- Before C-787 the registry stored ONE `principal_pubkey` per principal and a
-- `stacks` JSON array whose elements carried no key. A principal's 2nd stack
-- could not register (the rotation gate 409'd a different key) and federated
-- signatures resolved only the single principal key. C-787 adds a per-stack
-- `stack_pubkey` to each `StackIdentity` (stored INSIDE the existing `stacks`
-- JSON text column — NO column/DDL change), keeping `principal_pubkey` as the
-- principal ROOT/authority key that authorizes ADDING a stack.
--
-- What this migration does
-- ────────────────────────
-- For every existing principal, rewrite the `stacks` JSON so each element gains
-- `stack_pubkey = <that element's existing stack_pubkey, else the row's
-- principal_pubkey>`. The existing single stack therefore inherits the current
-- `principal_pubkey` as its `stack_pubkey`, so `andreas/meta-factory` (and every
-- other already-registered stack) keeps verifying byte-for-byte against the
-- same key — the existing metafactory↔jc federation is UNAFFECTED.
--
-- Idempotent + backfill-safe (HOLD-aware)
-- ───────────────────────────────────────
-- This will NOT be applied to prod in this task (the prod registry deploy is on
-- HOLD). It is written to be safe to apply LATER to the live registry:
--   * COALESCE(json_extract(value,'$.stack_pubkey'), principals.principal_pubkey)
--     means a stack that ALREADY has a stack_pubkey keeps it — re-running the
--     migration is a no-op for already-backfilled rows (idempotent).
--   * A stack with NO stack_pubkey gets the root — the exact same value the
--     register route now backfills, so a row touched by either path converges.
--   * Rows with an empty `stacks` array (`'[]'`) rebuild to `'[]'` — no-op.
--   * The route-layer backfill (principals.ts) covers any row written AFTER
--     this migration; this statement covers rows written BEFORE it. Together
--     every row ends up with a stack_pubkey on every stack.
--
-- Apply (LATER — gated ops step, prod deploy is on hold):
--   bunx wrangler d1 migrations apply cortex-network-registry-dev --env dev --remote
--   bunx wrangler d1 migrations apply cortex-network-registry      --env production --remote

UPDATE principals
SET stacks = (
  SELECT COALESCE(
    json_group_array(
      json_patch(
        elem.value,
        json_object(
          'stack_pubkey',
          COALESCE(json_extract(elem.value, '$.stack_pubkey'), principals.principal_pubkey)
        )
      )
    ),
    '[]'
  )
  FROM json_each(principals.stacks) AS elem
)
WHERE
  -- Only touch principals that have at least one stack still missing a
  -- stack_pubkey. A principal whose every stack already carries one is left
  -- untouched — this is what makes re-applying the migration a no-op.
  EXISTS (
    SELECT 1
    FROM json_each(principals.stacks) AS s
    WHERE json_extract(s.value, '$.stack_pubkey') IS NULL
  );
