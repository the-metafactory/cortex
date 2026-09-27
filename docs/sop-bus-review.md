# Bus Review SOP

Operational checklist for Cortex's `tasks.code-review.*` path.

## Boot Lifecycle

1. Cortex starts `MyelinRuntime` from `nats.url`.
2. With `nats.subjects: []`, the runtime enters pull-only mode: no broad push subscribers, but `publish`, `jetstreamManager`, and `subscribePull` are live.
3. Cortex provisions the `bus.review.stream.name` stream, default `CODE_REVIEW`, for `local.{principal}.{stack}.tasks.code-review.>`.
4. Cortex provisions one durable per code-review-capable agent: `cortex-review-consumer-{principal}_{stack}-{agent}` (cortex#1503). Federated consumers use `cortex-review-consumer-federated-…` and `cortex-review-consumer-federated-direct-…` with the same `{principal}_{stack}-{agent}` suffix.
5. `ReviewConsumer.start()` binds a pull subscriber to that durable.
6. A healthy boot logs `cortex: review consumer ready ...`; a dormant boot logs `cortex: review consumer DORMANT ...`.

## Verify

```bash
arc nats provision-streams --network <principal> --agent <agent>
nats stream info CODE_REVIEW
nats consumer info CODE_REVIEW cortex-review-consumer-<principal>_<stack>-<agent>
```

Expected signals:

- Stream subject includes `local.<principal>.<stack>.tasks.code-review.>`, or a deliberately broader existing subject such as `local.>`.
- Consumer exists with explicit ack policy and `max_deliver` matching `bus.review.consumer.maxDeliver`.
- Cortex log contains `review consumer ready` for the agent.

## Common Failures

- `DORMANT`: NATS is not configured, connection failed, or `subscribePull` is unavailable. Check `nats.url`, credentials, and the preceding `myelin-runtime` log lines.
- Stream missing: run `arc nats provision-streams --network <principal> --agent <agent>` or restart Cortex with a working `nats.url`.
- Durable missing: restart Cortex with a working `nats.url`; durable names are principal, stack and agent scoped. (`arc nats provision-consumer` still builds the pre-#1503 `cortex-review-consumer-<principal>-<agent>` name.)
- Subject mismatch: confirm publishers use `local.<principal>.<stack>.tasks.code-review.<flavor>` and cortex logs the same stack id at boot.
- Payload rejection: Cortex emits `dispatch.task.failed` with `reason.kind: cant_do`; check that the request payload has `repo`, numeric `pr`, and `reviewer`.

## Stacks sharing one NATS account

Two stacks of one principal on one NATS account (`$G`, or a single agents account) share the fixed-name streams (`CODE_REVIEW`, `REVIEW_LIFECYCLE`, `DEV_IMPLEMENT`, `BRAIN_TASKS`, `RELEASE`). Each stack's boot adds its own `local.<principal>.<stack>.…` subjects to the stream. It never removes subjects, and it logs `extended stream "<name>" subjects`. Each stack binds its own `…<principal>_<stack>-<agent>` durables.

Upgrading from the unscoped `cortex-review-consumer-<principal>-<agent>` durables (cortex#1503):

- **The legacy durable's filter is this stack's own pattern and it is idle** (no ack-pending messages, no live pull requests). The new durable starts right after the legacy's last delivery, so nothing is replayed and nothing stored afterwards is lost. The legacy durable is then deleted.
- **The legacy durable's filter is this stack's own pattern, but it is busy.** For example, a review was in flight when the old runtime stopped, or an old-version runtime of this stack is still pulling. The legacy durable stays bound this boot (`binding legacy JetStream durable … migration … deferred`), so in-flight requests redeliver as on any restart and a live puller keeps competing-consumer semantics. The first idle boot migrates.
- **The legacy durable's filter belongs to another stack, or is empty.** It is left in place and logged. The new durable starts from `New`. The owning stack removes the legacy durable when it upgrades.
- Upgrade all runtimes of a stack together. If an old-version runtime recreates the legacy durable after migration, both durables receive that stack's requests until it is upgraded. A warning naming it is logged.

Remove a leftover legacy durable by hand only after checking its filter: `nats consumer info CODE_REVIEW cortex-review-consumer-<principal>-<agent>`.

## Config

`cortex.yaml`:

```yaml
bus:
  review:
    stream:
      name: CODE_REVIEW
      maxAgeSeconds: 86400
      maxBytes: 536870912
    consumer:
      maxDeliver: 5

nats:
  url: nats://127.0.0.1:4222
  name: cortex
  subjects: []
```

Leave `nats.subjects` empty for pull-only capability dispatch. Add broad push-mode subjects only when you need legacy fan-out subscribers.
