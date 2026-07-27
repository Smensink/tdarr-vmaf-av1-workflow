# Security and disclosure

Do not commit private Tdarr state, row-level media history, logs, reports,
databases/WAL files, credentials, media paths, or generated binaries.

Before publication:

```bash
python tools/audit-for-secrets.py .
git status --short
git diff --cached --stat
```

Review automated findings manually. Also inspect generated flow JSON and SQLite
schemas directly; `.gitignore` and scanners are not a security boundary.

The 2026-07-27 audit identified shell-command construction from media paths in
three active plugins. Until those subprocesses use explicit argv with
`shell:false`, treat filenames as untrusted and do not broaden deployment.

For a private disclosure, contact the maintainer without putting credentials,
media names, paths, or raw database extracts in a public issue. If a secret was
published, revoke/rotate it before history cleanup.

See [the audit](docs/audit-2026-07-27.md) and
[privacy policy](docs/privacy-and-data.md).
