-- cortex#1117 revert (ADR-0013 sovereign federation — Model B):
-- Drop `hub_account` from the `networks` table.
--
-- ADR-0013 adopted sovereign federation (Model B): each principal wires
-- export/import in its OWN NSC store; neither side needs the peer's account
-- pubkey in the registry descriptor. G1a's hub_account was built on the
-- rejected Model-A assumption and is now vestigial.
--
-- The registry has NOT been deployed to production with this column, so the
-- column drop is safe. This migration is appended (never edits 0005) so the
-- migration chain remains append-only.
--
-- Apply:
--   bunx wrangler d1 migrations apply cortex-network-registry-dev --env dev --remote
--   bunx wrangler d1 migrations apply cortex-network-registry      --env production --remote

ALTER TABLE networks DROP COLUMN hub_account;
