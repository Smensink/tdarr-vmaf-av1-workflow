# Privacy and database handling

The deployment has two sensitive SQLite data sets:

- the Tdarr application database, which contains flows, libraries, settings,
  job state, and potentially plaintext integration credentials;
- `vmaf_training.db`, whose row-level jobs and sweep points include paths,
  filenames/titles, release groups, exact timestamps, and detailed media facts.

Neither raw database belongs in a public Git repository. The same rule applies
to WAL/SHM files, automatic backups, flow JSON backups, job reports, logs, and
the host shadow directory hidden by the live named volume.

The exported `size_failure_shadow_hgb.json` model is also private. Its sklearn
category vocabulary contains row-derived media titles, release groups,
providers, and network names. The repository tracks the model runner, but
ignores the trained model in both source and init-mirror locations. Supply it
locally only when that advisory shadow is needed.

## What is published

`flow/tdarr-flow-vmaf-av1.json` is a recursive allowlist/redaction export of one
flow. Credential-shaped keys are replaced with environment placeholders or
redacted values.

`data/public/vmaf-learning-public.sqlite3` is a new database created from
scratch under export schema `tdarr-vmaf-public-learning/v3`. That public schema
is separate from the private live learning database's runtime schema 17. It
contains:

- `snapshot_metadata`;
- `cq_priors`;
- `sweep_priors`.

Allowed bucket keys:

- resolution tier: `4k`, `1440p`, `1080p`, `720p`, or `sd`;
- broad source codec;
- broad source type;
- `animation` or `live` content class;
- half-step CQ for sweep aggregates.

Allowed values:

- cohort count;
- rounded CQ quantiles;
- rounded VMAF, low-frame VMAF, SSIM, and CAMBI statistics;
- rounded source BPP, target VMAF, and final output-ratio statistics.

Each bucket must have at least 25 observations. No raw job/sweep row, job ID,
path, title, release group, provider ID, or exact event timestamp is copied.

## Export procedure

The exporter opens source SQLite read-only, runs `PRAGMA quick_check`, uses the
SQLite online backup API to create a consistent temporary snapshot, aggregates
from that snapshot, writes a new allowlisted schema, verifies integrity, and
atomically replaces the public output.

```bash
python tools/export-live-state.py \
  --learning-db /private/runtime/vmaf_training.db \
  --public-learning-out data/public/vmaf-learning-public.sqlite3 \
  --minimum-bucket-samples 25
```

For a flow stored in the active Tdarr database, stream only the selected JSON
row from the container into the exporter. Do not copy the database:

```bash
docker exec tdarr sqlite3 /app/server/Tdarr/DB2/SQL/database.db \
  "SELECT json_data FROM flowsjsondb WHERE id='YR5PZ1QaD';" \
  | python tools/export-live-state.py \
      --flow-json-stdin \
      --flow-id YR5PZ1QaD \
      --flow-out flow/tdarr-flow-vmaf-av1.json
```

Verify the actual table/column names before using that example against a
different Tdarr release.

## Private backup procedure

Back up the active named-volume DB and learning DB to private encrypted storage
using SQLite online backup. Do not:

- copy only `database.db` while a WAL is active;
- copy the host `server/.../SQL` shadow and assume it is live;
- run `VACUUM`, prune backups, or stop the server while jobs are active;
- put private backups under the Git checkout.

After backup, record `PRAGMA quick_check`, file hashes, schema version, and
restore instructions. Test restoration separately.

## Credentials

Prefer environment variables:

```text
TDARR_PLEX_URL
TDARR_PLEX_TOKEN
TDARR_TMDB_API_KEY
TDARR_TVDB_API_KEY
TDARR_RADARR_API_KEY
TDARR_SONARR_API_KEY
```

The flow exporter derives each `arr_api_key` placeholder from unambiguous
Radarr/Sonarr input evidence. It writes `TDARR_RADARR_API_KEY` or
`TDARR_SONARR_API_KEY` for both notification and unmonitor nodes, rejects
conflicting or unknown service identity, and never emits one shared Arr
placeholder. Placeholders are not secrets and are not guaranteed to be
expanded by Community plugins. Configure those nodes deliberately and verify
their private readback.

If a raw DB, backup, or flow export was ever pushed:

1. revoke and rotate every affected token;
2. remove the artifact from current and historical Git objects;
3. invalidate caches/releases;
4. document the incident privately.

## Release privacy checks

Before staging:

```bash
python tools/audit-for-secrets.py .
git status --short
git ls-files
```

Also inspect ignored and untracked files. Automated scanning complements, but
does not replace, a human review of flow inputs, docs, example paths, and
generated SQLite schemas.
