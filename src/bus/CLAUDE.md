# src/bus/ — Myelin M2–M6 wire client

This tree implements the **client side** of the myelin wire contracts. The RFC grammar is
**normative** here: code conforms to the spec; a divergence is a bug, and a spec change is a
wire change (`the-metafactory/myelin specs/rfc/rfc-bcp-0001-wire-change-control-and-versioning.md`).
Import wire primitives from `@the-metafactory/myelin` `./wire` — **do not hand-copy** the
grammar/envelope/subject code into cortex (see cortex#2034).

Governing RFCs (`the-metafactory/myelin specs/rfc/`; full trigger→RFC table in the repo-root `CLAUDE.md`):
- subjects/`deriveNatsSubject` → `rfc-0002`; envelope+validator → `rfc-0003`, signing → `rfc-0004`; identity/`signed_by` → `rfc-0001`
- sovereignty/`federated.*` → `rfc-0005`; admission → `rfc-0006`; transport → `rfc-0007`; discovery → `rfc-0008`; refusal → `rfc-0010`
