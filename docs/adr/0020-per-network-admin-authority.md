# ADR 0020 — Per-network admin authority in the registry schema

**Status:** accepted (2026-06-29) · **Refines:** ADR-0015 (two-tier onboarding + admission gate) · **Descends:** ADR-0003 (network-join control plane), ADR-0013 (sovereign federation) · **Refs:** cortex#1321, #110, `docs/research-federation-decentralization.md`, CONTEXT.md §Network posture (admin vs member)

## Context

The federation-decentralisation research (#1319) found cortex is already
sovereign at the operator-account + leaf + export/import layer (ADR-0013, Model B = BGP
peering), but three meta-layer artifacts remained central. The first code-level
gap: the **Network-admission gate** (who is admitted to a network's roster) and
the network create/update gate both keyed on the **registry-wide**
`REGISTRY_ADMIN_PUBKEYS` allowlist. One global authority could admit peers and
write topology for *every* network. There was no per-network admin in the
schema — even though the domain model already names the concept (**Network
posture (admin vs member)**, CONTEXT.md §Network posture: an *admin* governs the
hub + the admission gate + the roster; a *member* is an admitted sovereign peer).

This is the "each AS admits to its own network" autonomy the research mapped onto
BGP/Mastodon: connectivity/admission is bilateral and self-governed, while
*allocation* (creating a network) can stay hierarchical (RIR/IANA-style).

## Decision

**Encode the existing Network-posture concept into the registry schema: a
network carries its own `admin_pubkeys`, and the admission-grant + topology-update
gates authorize against THAT network's admins OR the global allowlist.** No new
mechanism — the `register → PENDING → grant` admission gate (ADR-0015) and the
`POST /networks/{id}` create/update gate (#747) are re-sourced, not replaced.

Privilege model (anti-self-escalation):

1. **Network CREATE** → **global admin only** (`REGISTRY_ADMIN_PUBKEYS`). Creating
   a network is a hierarchical act (allocation), per the research; a global admin
   may set the initial `admin_pubkeys` at create.
2. **Network UPDATE (topology)** → **per-network admin OR global admin**. But only
   a **global** admin may set or change `admin_pubkeys` — a per-network admin
   supplying it is refused `403 admin_pubkeys_requires_global_admin`, so a
   per-network admin can neither add co-admins nor lock out the global admin.
3. **Admission GRANT (admit/reject)** → **per-network admin for the request's
   network OR global admin**. Authorization is keyed off the request's stored
   `network_id`, never off anything on the wire. A network-less request
   (`network_id` null) stays global-admin-only.
4. **Admin READS** (list/get admission requests) → **global admin only** for now
   (see Consequences — per-network read-scoping is a fast-follow).

`REGISTRY_ADMIN_PUBKEYS` is retained as the **bootstrap admin for `metafactory`**
and the always-valid super-admin — backward compatible: a network with no
`admin_pubkeys` (NULL) behaves exactly as before (global-admin-only).

This is **control-plane only**. No subject shape, no envelope field, no
`selectLink`/`source`/`originator` change — the `admin_pubkeys` set never appears
on the wire. The federation-wire-protocol SOP 5-check is unaffected.

## Consequences

- **Each network is sovereign over its own roster** — a per-network admin admits
  peers to their network without holding the global key. This completes the
  admission-gate sovereignty ADR-0015 implied.
- **Schema:** `NetworkRecord.admin_pubkeys?` (TEXT, nullable, comma-separated
  base64 — same grammar as the env var); D1 migration `0011_network_admin_pubkeys.sql`.
- **Not exposed on the public descriptor (yet):** `GET /networks/{id}` keeps the
  minimal `{network_id, hub_url, leaf_port, members}` shape. Surfacing the admin
  set for MC **Network posture** rendering (#1275/#1276) is a fast-follow (it
  touches the cortex-side `NetworkDescriptor` mirror + MC).
- **No CLI yet to set it:** a global admin sets `admin_pubkeys` via the signed
  `POST /networks/{id}` claim (`NetworkCreateClaim.admin_pubkeys`) or a store
  seed; the `cortex network create --network-admins` ergonomic flag is a
  fast-follow.
- **Per-network admin read-scoping** (letting a per-network admin LIST their
  network's pending requests) is a fast-follow — today they must be handed the
  `request_id`. The architectural unlock (grant-by-per-network-admin) does not
  depend on it.

## Alternatives considered

- **Let a per-network admin also manage `admin_pubkeys`** — fuller sovereignty,
  but opens a self-escalation / global-lockout path. Rejected for v1; admin-set
  management stays global. Can be revisited with explicit rotation rules.
- **Make network CREATE per-network-admin too** — there is no per-network set
  before a network exists, so create is necessarily global; keeping it global also
  matches the research's "allocation is hierarchical" finding. Kept.
- **Capability-based admission (Biscuit/VC) instead of an allowlist column** — the
  research's longer-term direction (#1322 follow-on). Heavier; deferred. The
  comma-separated-pubkeys column mirrors the existing grammar with zero new
  primitives.
