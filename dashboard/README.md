# Tdarr VMAF dashboard

This optional standalone dashboard ingests the best-effort CSV sidecars:

- `configs/vmaf_results.csv`
- `configs/vmaf_cq_learning.csv`

It maintains a private local SQLite index at
`dashboard/state/vmaf.sqlite`. The index contains raw paths, filenames,
release groups, and detailed run history. `dashboard/state/` is ignored and
must not be published or exposed.

SQLite `vmaf_training.db` and terminal monitor state are the workflow's
authoritative persistence. The dashboard CSVs have unlocked append races and
the learning CSV currently contains a premature `transcode_succeeded` label,
so dashboard results are observational and may disagree with terminal truth.

## Run locally

From the repository root:

```bash
docker compose -f dashboard/docker-compose.dashboard.yml up -d --build
```

Open `http://127.0.0.1:8686`. The example binds only to loopback and has no
authentication; do not expose it directly to a LAN or the internet.

The compose file mounts:

- `../configs` read-only at `/data`;
- `../server/Tdarr/DB2/JobReports` read-only at `/tdarr-jobreports`;
- `./state` read/write at `/state`.

Change those mounts if runtime data lives elsewhere. Remember that a Docker
named volume may shadow the host Tdarr SQL directory; the dashboard reads job
reports and CSVs, not the live application DB.

## Behavior

The importer incrementally reads append-only CSV growth and rebuilds its local
tables if an input is rewritten or shrunk. The UI provides:

- run/result summaries;
- CQ-learning summaries;
- sample/encode activity;
- a configurator that approximates historical range and sampling logic;
- local exclusions stored only in the dashboard database;
- optional read-only job-report recovery for missing sample metadata.

The configurator is a convenience model, not a guaranteed byte-for-byte copy
of current production plugin policy. Revalidate it whenever
`extractVideoSamples`, `vmafpredict`, the SQLite schema, or quality policy
changes.

Exclusions do not modify Tdarr CSVs or SQLite. Historical helper commands that
patched CSVs in place are not included in this repository.

## Stop

```bash
docker compose -f dashboard/docker-compose.dashboard.yml down
```

Retain or delete `dashboard/state/` according to your private data-retention
policy. Never add that directory to Git.
