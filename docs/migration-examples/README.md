# migrate-config examples

Worked examples for `cortex migrate-config`. Each pair (`before-*` /
`after-*`) is a real conversion you can reproduce locally:

```bash
cortex migrate-config docs/migration-examples/before-single-adapter.yaml \
  --out /tmp/regenerated.yaml
diff /tmp/regenerated.yaml docs/migration-examples/after-single-adapter.yaml
# (expect empty diff)
```

## Examples

| Pair | Scenario |
|------|----------|
| `before-single-adapter.yaml` → `after-single-adapter.yaml` | Operator + 1 channel user + 1 external peer; one Discord adapter; no DM userRoles. Demonstrates the synthetic `operator`/`anonymous-*` principals and the external-peer warning. |

## See also

- `docs/sop-migrate-config.md` — full operator-facing SOP.
- `docs/design-policy-cutover.md` — design + algorithm reference.
- `docs/iteration-policy-cutover.md` — slice-by-slice cutover plan.
