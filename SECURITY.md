# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately using one of:

- GitHub's [private vulnerability reporting](https://github.com/the-metafactory/cortex/security/advisories/new)
  (preferred), or
- Email **jens-christian.fischer@switch.ch** with the subject line
  `[cortex security]`.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof of concept.
- Affected version(s) or commit, and any relevant configuration.

You will receive an acknowledgement within **5 business days**. We will keep you
informed of progress toward a fix and may ask for additional detail. We aim to
disclose and patch responsibly, and will credit reporters who wish to be named
once a fix is released.

## Supported versions

cortex is pre-1.0 and under active migration. Security fixes are applied to the
latest released version on `main`. Until `v1.0.0`, only the current `main` line
is supported.

| Version        | Supported          |
| -------------- | ------------------ |
| `main` (latest)| :white_check_mark: |
| older tags     | :x:                |

## Scope

cortex runs as a networked service (Discord/Mattermost adapters, a NATS bus
client, a webhook proxy, and a dashboard). Reports of particular interest:

- Authentication/authorization bypass in adapters, the bus client, or the
  dashboard.
- Injection or unsafe handling of inbound platform messages or webhook payloads.
- Secret or credential exposure in logs, events, or rendered output.
- mTLS / transport validation weaknesses in the CC event pipeline.

Test fixtures in the repository (for example mTLS material under `__tests__/`)
are non-secret by design and are not in scope.
