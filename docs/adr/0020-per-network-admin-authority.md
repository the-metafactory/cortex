# ADR 0020 — Per-network admin authority in the registry schema

**Status:** accepted (2026-06-29) · **Amended:** 2026-07-07 (FND-5 — admin read-scoping, see Amendment below) · **Refines:** ADR-0015 (two-tier onboarding + admission gate) · **Descends:** ADR-0003 (network-join control plane), ADR-0013 (sovereign federation) · **Refs:** cortex#1321, #110, `docs/research-federation-decentralization.md`, CONTEXT.md §Network posture (admin vs member)

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
4. **Admin READS** (list/get admission requests) → **per-network admin for the
   network they NAME in the signed read claim, OR global admin** (the FND-5
   amendment below; at acceptance this was global-admin-only). Authorization is
   keyed off the claimed `network_id` — bound INTO the signature — checked
   against THAT network's `admin_pubkeys`: a per-network admin is authorised for,
   and FORCED to, their own network's rows; a global admin sees all (and MAY
   narrow to one network). Unsigned/unauthorized ⇒ 403. A network-less request
   (`network_id` null) stays global-admin-only.

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
  network's pending requests) — DELIVERED by the FND-5 amendment below (it was a
  fast-follow at acceptance time, when a per-network admin had to be handed the
  `request_id` out-of-band). The grant-by-per-network-admin unlock never depended
  on it.

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

## Amendment — FND-5: per-network admin read-scoping (2026-07-07)

**Refs:** FND-5 (`docs/plan-mc-future-state.md` §4.0), unblocks FLG-5 (MC pier
request-id). **Descends:** this ADR §Decision point 4 (Admin READS).

At acceptance, decision point 4 kept **admin READS** (`GET /admission-requests`
list + single-row GET) **global-admin-only**, with per-network read-scoping named
as a fast-follow. That gap hard-blocked a per-network admin's daemon from
fetching its OWN network's pending `request_id`s (it had to be handed them
out-of-band), which in turn blocked the MC pier request-id feature (FLG-5).

**Change.** The read gate now resolves the signed reader to a **read scope**,
mirroring the admission-GRANT authority already shipped for admit/reject
(point 3):

- The read claim (`AdmissionReadClaim`, carried in the `x-admin-signed` header)
  gains an **OPTIONAL `network_id`**, **bound INTO the signed bytes** so a token
  minted to read network A cannot be replayed to read network B.
- **Global admin** (`REGISTRY_ADMIN_PUBKEYS`) → reads **all** networks' rows
  (incl. network-less rows), and MAY pass `network_id` to narrow to one. This is
  backward-compatible: the pre-FND-5 two-field claim (no `network_id`) still
  reads everything.
- **Per-network admin** → MUST name a `network_id`; authorised **only** as an
  admin of THAT network (its stored `admin_pubkeys`), and the result is **FORCED**
  to that one network's rows. Naming a network they do not administer, or omitting
  the scope, ⇒ **403**.
- Gate order is unchanged and fail-closed: `503 admin_not_configured` → `429`
  rate-limit → `400` header/skew → `401 signature_invalid` → `403
  admin_not_authorized`, then the scope filter. Single-row cross-network reads
  return **404** (not 403) so a non-owning admin gets no existence oracle.

**Security-critical invariant (test-enforced):** a per-network admin can NEVER
read another network's rows — not by naming it, not by omitting the scope, not
through the single-row GET. Authorization is keyed off the claimed `network_id`
checked against that network's `admin_pubkeys`, never off anything a caller could
forge past the signature.

**Unchanged.** Control-plane only — no subject/envelope/`source`/`originator`
change; the `admin_pubkeys` set never appears on the wire. Network CREATE stays
global-only; a per-network admin still cannot manage `admin_pubkeys`
(anti-self-escalation, point 2). A network-less request (`network_id` null) stays
global-admin-only.
