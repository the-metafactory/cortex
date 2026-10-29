# LEDGER archive reference

Cortex's default stack archives the entire `LEDGER` stream, including records from other stacks in the same account. The archive starts with the bus, independently of Vigil and Mission Control. It runs continuously in the cortex process. If the archiver cannot start, cortex logs `ledger archive startup failed` and keeps running without it, so watch for that line and run `verify` before history expires.

## Configuration

Set the archive directory in the stack's configuration:

```yaml
ledger:
  archive_dir: /path/to/ledger-archive
```

Without `ledger.archive_dir`, the directory is `<cortex-data-dir>/ledger`. The data directory follows `CORTEX_DATA_DIR` and otherwise defaults to `~/.local/share/metafactory/cortex`.

## Files and restart behavior

Each `<YYYY-MM-DD>.jsonl` file uses the stream timestamp's UTC date. Each line contains `sequence`, `subject`, `timestamp`, and `data`. The `data` field holds the exact envelope bytes as base64, including records that fail envelope validation.

The writer syncs each row before acknowledging delivery, and syncs the directory when it creates a day file. On restart, the archive determines the next sequence. Redelivery of an archived sequence does not append another row. A SQLite sidecar holds an exclusive writer lock. It stores no archive cursor, and the operating system releases the lock after a crash.

Committed rows remain unchanged. A restart discards an incomplete final line left by an interrupted append, logs the byte count, and requests that sequence again. Corrupt complete lines and duplicate sequences stop startup. An internal archive gap that the stream still holds is logged at startup; `verify` reports it and exits non-zero.

A write error stops consumption and logs the error. Later sequences are not acknowledged. After correcting the failure, restart cortex to resume. A delivery that skips sequences the stream still holds also stops consumption. When the skipped sequences have expired or were deleted from the stream, the archiver logs the range and continues, so an outage longer than retention does not halt it permanently. An initial archive can begin with the oldest retained record. History that expired before archiving began cannot be recovered from JetStream.

## Verification command

```sh
cortex ledger archive verify --config /path/to/default/cortex.yaml
```

The command reads the archive and a stream sequence snapshot. It prints the first and last archived sequence and every missing range between the archive and stream bounds. Missing ranges say whether the stream still holds them. The command exits with status 1 when any missing sequence remains in the stream, or when reading either source fails. Gaps that have expired from the stream are reported without failing verification.

Verification does not create a consumer or modify the stream or archive. It ignores an incomplete final line in the newest day file, which an append in progress can leave. Run it after the archive catches up with new publications. Vigil replay continues to read JetStream.
