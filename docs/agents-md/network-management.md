## Network Management

`cortex network` is the control plane for a stack's network lifecycle (the "feel like TCP/IP" join, #738). A **network** is a federation of principals whose stacks interconnect at the NATS leaf-node layer.

| Command | Purpose |
|---|---|
| `cortex network create <id> --hub <tls-url> --leaf-port <port> --admin-seed <path> [--apply]` | Network admin stands up a NEW network's topology row in the registry — a signed-admin claim, **no raw SQL** (#747). Dry-run by default. |
| `cortex network join <id> [--principal-seed <root>] [--apply]` | A principal joins one of their stacks to a network. Derives inputs from `cortex.yaml` (#753). Idempotent. Dry-run by default. |
| `cortex network status --principal <id>` | Read-only: joined networks, leaf link state, peers, accept-subjects, counters. |
| `cortex network leave <id> [--apply]` | Reverse a join cleanly + idempotently. Dry-run by default. |
| `cortex provision-stack register <principal> --seed-path <p> --registry-url <u> [--principal-seed <root>]` | Register a stack's pubkey + capabilities with the registry (proof-of-possession). |

The one-rule essentials:

- **Networks are created with `cortex network create`, not SQL.** The registry's `POST /networks/<id>` is fail-closed: the admin pubkey must be on `REGISTRY_ADMIN_PUBKEYS` or it returns `503 admin_not_configured` / `403 admin_not_authorized`.
- **A principal's 2nd+ stack joins with `--principal-seed <root>`** (the FIRST stack's seed, #791). The add-stack claim is root-signed and fetch-merges the principal's existing stacks so they survive; on the standalone `provision-stack register` path the pinned `--registry-pubkey` is also required. Omit `--principal-seed` for a first-stack join.
- **A federating stack's bus must be operator-mode** — it must define the NSC operator + the account the leaf binds to (mirror `~/.config/nats/local.conf`). An **anonymous / hard-isolated** bus (the `halden` / `community` pattern) **cannot federate**: the leaf remote names an account the server doesn't know and `nats-server` crashes. The #794 fix makes `cortex network join` refuse (fail-fast) on such a bus rather than taking it offline — convert the bus to operator-mode first.
- **`join` / `leave` / `create` default to dry-run** — they print the intended actions and touch nothing. Pass `--apply` to mutate the live deployment.

SOPs: [`docs/sop-network-join.md`](docs/sop-network-join.md) (join / multi-stack / status / leave), [`docs/sop-stack-onboarding.md`](docs/sop-stack-onboarding.md) (stand up a stack + federate it; §B0.1 operator-mode bus), [`docs/sop-federation-onboarding.md`](docs/sop-federation-onboarding.md) (peer-principal onboarding).
