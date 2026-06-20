-- cortex#1117 (G1a — hub_account on the signed network descriptor):
-- Add `hub_account` to the `networks` table so the network descriptor can carry
-- the hub's NSC account pubkey (nkey-U, A…). This is the OQ1 decision: the
-- hub's account rides the SIGNED descriptor (authoritative, like hub_url, DD-12).
--
-- Strictly additive: the column is NULLABLE so existing rows remain valid
-- (absent hub_account = "no cross-account wiring needed"). Only new writes
-- that supply the field persist it; existing network-create calls without it
-- continue to work exactly as before.
--
-- Apply:
--   bunx wrangler d1 migrations apply cortex-network-registry-dev --env dev --remote
--   bunx wrangler d1 migrations apply cortex-network-registry      --env production --remote
--
-- Grammar:  /^A[A-Z2-7]{55}$/ — the same nkey-U shape O-4b/registry
-- use for leaf package accounts. Enforced at the route layer via
-- isNkeyAccountPubkeyRegistry(); the SQL column is TEXT (D1 has no regex
-- constraint syntax). Malformed values are rejected before they reach the store.

ALTER TABLE networks ADD COLUMN hub_account TEXT;
