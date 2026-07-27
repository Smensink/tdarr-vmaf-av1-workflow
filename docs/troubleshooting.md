# Troubleshooting and operations

Never restart/recreate Tdarr, rebuild FFmpeg, mutate the graph, prune reports,
or vacuum databases merely to investigate a problem while jobs are running.
Start with read-only process, log, flow, and database checks.

## Server/node contact timeouts

Symptoms include server-contact failures, job-report POST timeouts,
worker-limit poll timeouts, or an internal node configured against
`http://0.0.0.0:8266`.

Check:

```bash
docker stats --no-stream tdarr
docker top tdarr
docker logs --tail 500 tdarr
```

Likely causes in this deployment:

- two CPU-v1 scorers per job;
- eight threads per scorer through `maxParallelVmaf`;
- multiple simultaneous flow jobs;
- two decoder processes per scorer;
- a deep recurring GPU health check;
- redundant library scanning.

Remediation after drain:

- add a host-wide CPU scoring semaphore;
- reserve 2–4 logical CPUs for the control plane;
- split `cpuV1ThreadsPerScore` from GPU concurrency;
- use the cheap health check from the example compose;
- configure the internal node to contact `127.0.0.1:8266`;
- use one primary library discovery method plus staggered reconciliation.

## Container would not start after recreation

The parity init hook is fail-closed. Compare:

- active DB flow;
- mounted `configs/flow_YR5PZ1QaD_CANONICAL.json`;
- server and internal-node plugin catalogs;
- `custom-cont-init.d` payload;
- the 19 runtime helpers.

The optional private size-shadow model is not part of startup parity; verify
its checksum separately if it is installed.

The deployment audited on 2026-07-27 had a live 34/53 graph while the mounted
host canonical still had 35/54. Reconcile during a drained window; do not
disable parity to force startup.

## CPU VMAF-v1 geometry failure

If CPU scoring reports unsupported coded/display dimensions or SAR/DAR:

- capture source coded width/height, sample dimensions, SAR, DAR, pixel format,
  transfer, primaries, and matrix;
- do not coerce the geometry merely to pass the parser;
- route the source to the qualified GPU metric path until an exact CPU contract
  exists.

Common unsupported cases include 720p, 1440p, SD, DCI/cropped, portrait, and
missing/N/A aspect ratios.

## GPU lock appears stuck

Inspect the lock directory, token, owner metadata, heartbeat, and live process
tree read-only. Do not delete it just because its age exceeded a threshold.

The current helper can break a same-file live lock without proving the owner
dead and treats any lock older than eight hours as stale. A valid long encode
can exceed that assumption. Manual recovery should require:

- exact lock root;
- owner job and generation;
- no live matching process;
- stale heartbeat beyond a documented lease;
- a retained forensic copy of lock metadata.

Never allow a flow input to point the lock at an arbitrary directory.

## `/temp/vmaf-v1-score.*` cache warnings

CPU scorer scratch under `/temp` is seen by Tdarr's cache scanner. The tracked
wrapper now honors `VMAF_V1_WORK_ROOT`; the example compose maps it to a
dedicated named volume.

Old orphan directories may remain after forced process termination. Inventory
them after the queue drains and confirm no live process references them before
cleanup.

## Grain synthesis produced an invalid title

Do not replace the source. Retain:

- source-scoped analysis artifact;
- base encode;
- rewritten candidate;
- plugin log and manifest;
- ffprobe JSON;
- tool versions/hashes.

Run bounded full-title decode and stream/colour/duration comparison. The active
direct synthesis path does not currently perform the required full-title
decode after rewriting, so a successful plugin return is insufficient proof.

## HDR source was retagged incorrectly

Capture original transfer, primaries, matrix, bit depth, Dolby Vision profile,
and static HDR metadata. Ambiguous BT.2020 with unknown transfer should preserve
source signalling or stop for review; it should not be forcibly labeled PQ.

## Learning or CSV disagreement

Treat SQLite terminal outcome as authority. `learnCQRange` writes before the
final transcode and its CSV success label is premature. CSV and EMA files have
unlocked concurrent writes. Preserve them for diagnosis, but do not use them
to overwrite SQLite.

Validate privately:

```bash
sqlite3 /private/vmaf_training.db "PRAGMA quick_check;"
```

Never paste row-level output into a public issue.

## Job reports or SQL backups near limits

At audit time, job reports were roughly 98.5% of the configured 10 GiB limit,
and the SQL volume held about 2.8 GB across 45 files, many one-off rollback
databases.

Do not prune during active jobs. First:

1. archive/compress reports to private storage;
2. verify checksums and restore/readability;
3. define age/count/incident-hold retention;
4. identify active DB/WAL and rollback dependencies;
5. delete only in a maintenance window.

## Security

The example binds ports to loopback and enables auth. If remote access is
required, use a trusted reverse proxy/VPN and TLS. Integration plugins should
only contact allowlisted hosts. Media names must be treated as untrusted until
the shell-command construction findings in the audit are fixed.
