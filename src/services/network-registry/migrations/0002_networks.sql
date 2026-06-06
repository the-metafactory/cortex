-- cortex#745 (S2.5 — Network Join Control Plane, epic #733, spec DD-12):
-- durable storage for network TOPOLOGY records (hub_url / leaf_port).
--
-- Backs `GET /networks/:id` (the signed descriptor a joining stack reads to
-- autoconfigure its leaf — DD-12, the "feel like TCP/IP" north star: no
-- out-of-band port/creds). Rows are seeded at the STORE level by an admin
-- (deploy-time seed script / direct D1 write), NOT via a public HTTP route —
-- an unauthenticated write the registry then signs would defeat DD-9
-- (descriptor poisoning → federation MITM). The secure signed-admin write API
-- is a separate follow-up.
--
-- Apply:
--   bunx wrangler d1 migrations apply cortex-network-registry-dev --env dev --remote
--   bunx wrangler d1 migrations apply cortex-network-registry      --env production --remote
--
-- Schema notes
-- ────────────
-- `networks` mirrors the NetworkRecord wire shape (src/types.ts). It holds
-- ONLY the admin-seeded topology. The descriptor's `members[]` is NOT
-- stored here — it is derived from the principal roster at read time
-- (membersFromPrincipals, the same implicit-membership rule as the roster
-- route), so a network's membership view can never drift from /roster.
--
-- `leaf_port` is an INTEGER (TCP port, validated 1..65535 at the route layer).
-- `network_id` is the PRIMARY KEY so a re-seed is a single atomic UPSERT
-- (D1RegistryStore.putNetwork uses INSERT ... ON CONFLICT DO UPDATE).

CREATE TABLE IF NOT EXISTS networks (
  network_id  TEXT PRIMARY KEY,
  hub_url     TEXT NOT NULL,
  leaf_port   INTEGER NOT NULL,
  -- ISO-8601 UTC; mirrors NetworkRecord.updated_at.
  updated_at  TEXT NOT NULL
);
