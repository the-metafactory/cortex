-- #1598 (hub-mode-aware admit — epic #1595 payload swap):
-- Add `hub_mode` + `resolver_mode` to the `networks` table so each network
-- carries an ADMIN-ATTESTED statement of how its hub authenticates leaves:
--   hub_mode      — 'operator' (NSC/JWT; admit seals a per-member scoped-user
--                   credential, v2 envelope) or 'simple' (inline leaf
--                   authorization; admit seals the shared-string secret, v1).
--   resolver_mode — for an operator hub: 'nats' (push-capable full resolver —
--                   runtime revocation) or 'memory' (preload — revocation
--                   needs a hub restart). Design §5.1; gates #1599.
--
-- Written only through the signed-admin POST /networks/{id} route (fail-closed
-- allowlist, #747); served on the registry-SIGNED descriptor so both the
-- admit-side mode branch and the member-side payload expectation read a
-- verified value.
--
-- Strictly additive: both columns are NULLABLE so existing rows remain valid
-- and read back as "unattested" (the admit tooling treats that as legacy
-- simple-hub behaviour and the creds path refuses to run).

ALTER TABLE networks ADD COLUMN hub_mode TEXT;
ALTER TABLE networks ADD COLUMN resolver_mode TEXT;
