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

Causes observed in the historical audited deployment:

- two CPU-v1 scorers per job;
- eight threads per scorer through `maxParallelVmaf`;
- multiple simultaneous flow jobs;
- two decoder processes per scorer;
- the then-recurring deep GPU health check;
- redundant library scanning.

The live mounted healthcheck and the checked-in r3 healthcheck now use only a
cheap TCP liveness probe. Deep toolchain qualification remains an explicit
manual operation for a drained window. The checked-in remediation also sets
one CPU-v1 task per job, two threads per score, and a host-wide one-slot wrapper
semaphore. After deployment:

- confirm `VMAF_V1_MAX_PARALLEL=1` and writable lease storage;
- reserve 2–4 logical CPUs for the control plane;
- confirm `cpuV1ThreadsPerScore=2` independently of `maxParallelVmaf`;
- use the cheap health check from the example compose;
- configure the internal node to contact `127.0.0.1:8266`;
- use one primary library discovery method plus staggered reconciliation.

## Container would not start after recreation

The parity init hook is fail-closed. Compare:

- active DB flow;
- mounted `configs/flow_YR5PZ1QaD_CANONICAL.json`;
- server and internal-node plugin catalogs;
- `custom-cont-init.d` payload;
- the 23 runtime helpers.

The optional private size-shadow model is not part of startup parity; verify
its checksum separately if it is installed.

If source and persistent-server plugin hashes are current but many
internal-node files revert after the node reconnects, inspect the cached
plugin-download boundary before copying files repeatedly. The bundled node
normally downloads `nodePlugins.Zip` after custom init. The r3 hook prevents
that late replacement only after it has seeded and patched the complete node
catalog, using the exact `/app/Tdarr_Node/assets/app/plugins/.git`
development-preservation sentinel. A missing/wrong sentinel, a sentinel armed
before the complete seed, or a non-directory at that path blocks qualification.
Keep the node paused and all worker limits at zero until the sentinel and
source/server/node parity are proven.

Pre-r3 forensic evidence recorded a live 34/53 graph while the mounted host
canonical still had 35/54. That dated mismatch was reconciled. The final
tracked r3 snapshots are identical at 36 nodes and 58 edges; a live deployment
must match them exactly during a drained parity check. Do not disable parity to
force startup.

## CPU VMAF-v1 geometry failure

If CPU scoring reports unsupported coded/display dimensions or SAR/DAR:

- capture source coded width/height, sample dimensions, SAR, DAR, pixel format,
  transfer, primaries, and matrix;
- do not coerce the geometry merely to pass the parser;
- route the source to the qualified GPU metric path until an exact CPU contract
  exists.

Common unsupported cases include 1280x720, 2560x1440, SD, portrait, DCI-width
rasters, non-family crops, missing/N/A ratios, and SAR/DAR that do not exactly
reproduce the coded display ratio. The calculation plugin records
`vmafCpuV1GeometryRejected` and stays on GPU-v0 instead of activating CPU-v1.

## GPU lock appears stuck

Inspect the lock directory, token, owner metadata, heartbeat, and live process
tree read-only. Do not delete it just because its age exceeded a threshold.

The repaired helper confines the lock to the fixed production root, publishes
generation-owned lease state, checks owner-job/PID liveness, and never treats
age alone as authority to steal a same-file live lock. A valid long encode can
run beyond an arbitrary age threshold. Manual recovery still requires:

- exact lock root;
- owner job and generation;
- no live matching process;
- stale heartbeat beyond a documented lease;
- a retained forensic copy of lock metadata.

Never allow a flow input to point the lock at an arbitrary directory.
Never remove the lock merely to satisfy a deployment or trial preflight. An
API worker can appear idle while its coordinator or producer still owns the
lock; inspect `/proc` and let the workload finish.

An owner with `ownerId: grain-toolchain-runtime-selftests` and
`automaticStaleBreakDisabled: true` is a deliberate non-stealable maintenance
lease. The self-test runner uses it because a hard-killed supervisor can leave
`runuser`, a regression shell, FFmpeg, grav1synth, NVEncC, or one of their
descendants alive. Production acquisition will wait rather than infer safety
from a dead supervisor, an old heartbeat, or lock age.

For that owner, manual recovery is permitted only after all of the following
are recorded and independently verified:

1. Global admission and every node are paused, all workers are drained, and no
   new work can enter.
2. The fixed lock root, `owner.json`, `heartbeat.json`, owner token, and lease
   generation are copied to private forensic storage.
3. The recorded supervisor PID/start time is no longer live and a `/proc`
   process-tree and command-line inspection finds no matching self-test,
   `runuser`, regression shell, FFmpeg, grav1synth, NVEncC, coordinator, CUDA,
   or CUVID process. Read failures are not proof of absence.
4. GPU use is independently idle and the heartbeat is stale.
5. The lock helper’s normal `release()` is invoked against the fixed root with
   the exact recorded token and `expectedGeneration`; `force` remains false.
   The release result must report `released: true`.

Do not recursively delete the directory, use a force release, or resume nodes
after an unconfirmed release. A failed release leaves the lease authoritative
until the evidence and ownership mismatch are reviewed.

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

Inspect `grainSynthesisDecodeValidationMode` and the validation report. A
replacement-eligible direct output must record
`full_title_decode_validation_performed: true` and an exhaustive GPU or
software decode. A decode failure removes the candidate and routes the
untouched original through the fail-closed fallback.

## HDR source was retagged incorrectly

Capture original transfer, primaries, matrix, bit depth, Dolby Vision profile,
and static HDR metadata. Ambiguous high-bit-depth BT.2020 now routes to output 3
with reason `bt2020_high_bit_depth_unknown_transfer`; verify that the graph
keeps the original. Correct the source metadata before retrying rather than
forcing PQ.

## Learning or CSV disagreement

Treat SQLite terminal outcome as authority. `learnCQRange` runs before the
final transcode and now leaves its compatibility `transcode_succeeded` field
blank. Shared CSV/EMA writes are retired. Optional diagnostics are exclusive
per-job files beneath `<configured-path>.d`; do not merge them back into
SQLite as terminal outcomes.

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

## Arr unmonitor was skipped

Output 2 is the safe result when Arr identity or mutation verification is not
exact. Check the job log for:

- disagreement between `vmafOriginalFile` and the Tdarr library path;
- no Arr file record matching the source path, or more than one match;
- a Sonarr filename without one unambiguous season/episode identity;
- duplicate episode records or multiple episode-file IDs for one source;
- a post-update readback that changed identity or did not report
  `monitored=false`.

The plugin accepts exact paths or mapped-root paths sharing at least the parent
directory and filename. Correct the Arr root/path mapping or library metadata;
do not weaken the match or retry the mutation against a guessed parse result.
Keep the configured Arr host allowlisted and use HTTPS when it crosses a trust
boundary.

## Security

The example binds ports to loopback and enables auth. If remote access is
required, use a trusted reverse proxy/VPN and TLS. Integration plugins should
only contact allowlisted hosts. The repaired media-path subprocesses use
literal argv with `shell:false`; verify the live plugin catalogs match the
audited source before treating that protection as deployed.
