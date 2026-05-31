# Bus Review SOP

Operational checklist for Cortex's `tasks.code-review.*` path.

## Boot Lifecycle

1. Cortex starts `MyelinRuntime` from `nats.url`.
2. With `nats.subjects: []`, the runtime enters pull-only mode: no broad push subscribers, but `publish`, `jetstreamManager`, and `subscribePull` are live.
3. Cortex provisions the `bus.review.stream.name` stream, default `CODE_REVIEW`, for `local.{principal}.{stack}.tasks.code-review.>`.
4. Cortex provisions one durable per code-review-capable agent: `cortex-review-consumer-{principal}-{agent}`.
5. `ReviewConsumer.start()` binds a pull subscriber to that durable.
6. A healthy boot logs `cortex: review consumer ready ...`; a dormant boot logs `cortex: review consumer DORMANT ...`.

## Verify

```bash
arc nats provision-streams --network <principal> --agent <agent>
nats stream info CODE_REVIEW
nats consumer info CODE_REVIEW cortex-review-consumer-<principal>-<agent>
```

Expected signals:

- Stream subject includes `local.<principal>.<stack>.tasks.code-review.>`, or a deliberately broader existing subject such as `local.>`.
- Consumer exists with explicit ack policy and `max_deliver` matching `bus.review.consumer.maxDeliver`.
- Cortex log contains `review consumer ready` for the agent.

## Common Failures

- `DORMANT`: NATS is not configured, connection failed, or `subscribePull` is unavailable. Check `nats.url`, credentials, and the preceding `myelin-runtime` log lines.
- Stream missing: run `arc nats provision-streams --network <principal> --agent <agent>` or restart Cortex with a working `nats.url`.
- Durable missing: same provisioning command; durable names are principal and agent scoped.
- Subject mismatch: confirm publishers use `local.<principal>.<stack>.tasks.code-review.<flavor>` and cortex logs the same stack id at boot.
- Payload rejection: Cortex emits `dispatch.task.failed` with `reason.kind: cant_do`; check that the request payload has `repo`, numeric `pr`, and `reviewer`.

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
