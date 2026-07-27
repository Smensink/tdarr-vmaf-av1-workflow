# SQLite learning handoff

This historical handoff has been superseded by the maintained documentation:

- [Architecture](docs/architecture.md)
- [Quality policy](docs/quality-policy.md)
- [Privacy and data handling](docs/privacy-and-data.md)
- [2026-07-27 deployment and plugin audit](docs/audit-2026-07-27.md)

The runtime database is `vmaf_training.db`. It contains row-level media and
execution history and is private operational state. It must not be committed,
copied from an active WAL database with filesystem copy, or treated as a
portable seed.

For public warm-start data, use the aggregate-only snapshot under
`data/public/`. It is created from a consistent SQLite online backup by
`tools/export-live-state.py` and contains no raw job or sweep rows.
