## Platform Management

`cortex stack` + `cortex network` are the control plane for a stack's full lifecycle: stand one up locally (`stack`), then federate it onto a network (`network`).

### Standing up a stack

`cortex stack create <slug>` scaffolds a config-split stack skeleton **born aligned** — the dir basename, the slug, and the trailing segment of `stack.id` are all the same — so the slug↔`stack.id` drift the install-time `warn_stack_identity_drift` detector catches ([ADR-0004](docs/adr/0004-stack-slug-authority.md)) can never form for a stack created this way. It is the prevent-side complement to that detector.

| Command | Purpose |
|---|---|
| `cortex stack create <slug> [--principal <id>] [--apply]` | Scaffold a born-aligned (dir==slug==`stack.id` trailing segment), unique-within-principal config-split stack from the `docs/config-layout/` template (#808). Sets `stack.nkey_seed_path` to the conventional path — `arc upgrade Cortex` auto-provisions the seed. Dry-run by default; never overwrites an existing dir. |
| `cortex stack list [--config-dir <path>]` | List discovered stacks with their `stack.id` and an aligned/DRIFT flag. |

### Network lifecycle

A **network** is a federation of principals whose stacks interconnect at the NATS leaf-node layer ("feel like TCP/IP" join, #738).

| Command | Purpose |
|---|---|
| `cortex network create <id> --hub <tls-url> --leaf-port <port> --admin-seed <path> [--apply]` | Network admin stands up a NEW network's topology row in the registry — a signed-admin claim, **no raw SQL** (#747). Dry-run by default. |
| `cortex network join <id> [--principal-seed <root>] [--apply]` | A principal joins one of their stacks to a network. Derives inputs from `cortex.yaml` (#753). Idempotent. Dry-run by default. |
| `cortex network status --principal <id>` | Read-only: joined networks, leaf link state, peers, accept-subjects, counters. |
| `cortex network leave <id> [--apply]` | Reverse a join cleanly + idempotently. Dry-run by default. |
| `cortex provision-stack register <principal> --seed-path <p> --registry-url <u> [--principal-seed <root>]` | Register a stack's pubkey + capabilities with the registry (proof-of-possession). |

The one-rule essentials:

- **Stacks are scaffolded with `cortex stack create`** — born aligned (dir==slug==`stack.id` trailing segment) so drift can't form, and unique within the principal (it refuses a dir collision OR a duplicate `stack.id`). Dry-run by default; pass `--apply` to write.
- **Networks are created with `cortex network create`, not SQL.** The registry's `POST /networks/<id>` is fail-closed: the admin pubkey must be on `REGISTRY_ADMIN_PUBKEYS` or it returns `503 admin_not_configured` / `403 admin_not_authorized`.
- **A principal's 2nd+ stack joins with `--principal-seed <root>`** (the FIRST stack's seed, #791). The add-stack claim is root-signed and fetch-merges the principal's existing stacks so they survive; on the standalone `provision-stack register` path the pinned `--registry-pubkey` is also required. Omit `--principal-seed` for a first-stack join.
- **A federating stack's bus must be operator-mode** — it must define the NSC operator + the account the leaf binds to (mirror `~/.config/nats/local.conf`). An **anonymous / hard-isolated** bus (the `halden` / `community` pattern) **cannot federate**: the leaf remote names an account the server doesn't know and `nats-server` crashes. The #794 fix makes `cortex network join` refuse (fail-fast) on such a bus rather than taking it offline — convert the bus to operator-mode first.
- **`stack create` / network `join` / `leave` / `create` default to dry-run** — they print the intended actions and touch nothing. Pass `--apply` to mutate the live deployment.

SOPs: [`docs/sop-stack-onboarding.md`](docs/sop-stack-onboarding.md) (stand up a stack with `cortex stack create`, then federate it; §B0.1 operator-mode bus), [`docs/sop-network-join.md`](docs/sop-network-join.md) (join / multi-stack / status / leave), [`docs/sop-federation-onboarding.md`](docs/sop-federation-onboarding.md) (peer-principal onboarding).
