# Architecture and tracked flow

This document describes the redacted live snapshot exported on 2026-07-27 plus
the audited r3 migration tracked in this repository: flow `YR5PZ1QaD`, 36
nodes, 58 edges. The final immutable release deployed that graph on 2026-07-28;
the independent deployment, parity, and quiescence checks are recorded in the
[rollout evidence](r3-rollout-evidence-2026-07-28.md). A checkout alone is not
deployment evidence, and the controlled live terminal canary remains withheld.

The internal node normally downloads the server's cached `nodePlugins.Zip`
after custom init. That ordering was observed rolling 27 repaired node copies
back to a mixed generation while the source and persistent server copies
remained correct. The r3 init sequence now seeds the complete server catalog,
applies every pin, then creates Tdarr_Node's own
`<pluginsPath>/.git` development-preservation sentinel. Automatic download is
therefore disabled for the bundled pinned node; deliberate catalog changes
require a drained recreate and full three-copy parity proof.

## Control flow

```text
input
  -> seven-day age gate
  -> NVIDIA AV1 capability probe
  -> HDR/Dolby Vision classification
  -> grain analysis
  -> metadata enrichment
  -> sample extraction
  -> acquire GPU lock
  -> sample encodes
  -> VMAF/CAMBI scoring
  -> bracket decision ----retry----+
  -> candidate selection             |
  -> CQ range/retry decision --------+
  -> learning + result export
  -> projected-size delay/check
  -> acquire GPU lock
  -> final transcode
  -> release GPU lock
  -> candidate monitor ----retry-----+
  -> grain synthesis or FFmpeg fallback
  -> stream reorder
  -> exact delivery-candidate validation
  -> attested replacement transaction
  -> delivered-outcome finalizer
  -> notify Radarr then Sonarr
  -> unmonitor Radarr then Sonarr
  -> cleanup
```

Error and keep-original branches release the GPU lock where applicable and
route through cleanup. `onFlowError` and its release node are detached from
ordinary edge reachability because Tdarr invokes the handler specially.

### Graph routing safeguards

- `detectGPUEncoder` output 1 continues to HDR analysis; output 2 now routes
  directly to `failFlow`, so a missing AV1 NVENC encoder cannot enter the
  quality pipeline.
- `compareFileSizeRatioLive` output 1 reaches the final-transcode lock. Its
  defensive/legacy output-2 handle now routes directly to cleanup, preserving
  the original on monitor setup or threshold rejection.
- `checkCQRangeRetry` now binds `maxRetries=4`,
  `vmafHeadroomThreshold=5`, and `vmafBelowThresholdMargin=5` explicitly in
  both tracked snapshots and the guarded update script. Critical
  `checkCQBracket` inputs are likewise explicit.
- Paired-CQ remains a full-measurement shadow: shadow and force-full are
  explicitly true while acting is explicitly false. Any acting promotion must
  be a separate reviewed change that also removes the force-full interlock.

The routing correction is covered by `test-flow-routing-contract.js`; policy
bindings and updater parity are covered by
`test-deployment-parity-contract.js`. Deploy the migrated graph only after
draining active jobs.

## GPU ownership

The global lock uses one fixed configured root, defaulting to
`/temp/tdarr-vmaf-gpu-pipeline.lock`. Candidate sample encodes and final
full-title transcodes acquire it through explicit graph nodes. Its state
records token/generation ownership, heartbeat, and PID/start-time liveness.
Acquisition publishes the directory exclusion boundary first, gives an
in-progress owner record a bounded initialization grace, and writes owner and
heartbeat state atomically. A confirmed live owner is never stolen. An
established lease whose worker is gone also fails closed for manual quiescent
recovery because unseen GPU descendants cannot be ruled out. Normal release
atomically retires only the directory with the exact token, generation, and
filesystem identity.

The graph leaves `analyzeFilmGrain` before the first explicit Acquire node, but
the plugin now acquires the same fixed production lease internally around its
heavy Python/NVEncC KNN pipeline. If the calling flow already owns the exact
token/generation, it re-enters that lease without releasing somebody else's
ownership; otherwise it releases its internal lease after the stage and treats
an unconfirmed release as fatal. The GPU-heavy analysis path is therefore
serialized without holding the lease across unrelated downstream work.

`calculateVMAF` releases the GPU lock before CPU-v1 scoring only when the
generation-owned release succeeds. An unconfirmed release keeps ownership and
fails closed. It does not reacquire before CPU-only aggregation; later graph
nodes explicitly acquire the next GPU transition.

When the final grain output can use CUVID, `synthesizeFilmGrain` acquires or
borrows the same exact generation-owned lease only around the final GPU decode
validation and publishes the lease identity in Flow state. Release failure is
fatal. A software-decoder fallback runs after the narrow lease is released.

## Sample search and scoring

`extractVideoSamples` chooses representative segments and can expand to at most
16 segments. `testEncodingParameters` encodes CQ candidates using AV1 NVENC.
`calculateVMAF` measures candidates and `checkCQBracket` decides whether to
continue searching.

Two metric paths are present:

- the custom FFmpeg/libvmaf GPU contract;
- an isolated official libvmaf 3.2.0 CPU/float scorer.

The checked-in graph requests CPU-v1 production authority for eligible SDR
content and explicitly disables provisional HDR authority. HDR therefore
retains the established GPU-v0 production contract instead of failing merely
because CPU-v1 is enabled globally. A separately reviewed canary can still
opt in to the provisional HDR path.

The resolver and scorer share one exact geometry validator: only even,
full-width or full-height 1080/2160 model-family rasters are eligible, and
coded size, SAR, and DAR must agree as exact rational values. Common 1280x720,
2560x1440, SD, portrait, DCI-width, non-family crop, missing-ratio, and
inconsistent-ratio inputs are rejected before CPU authority. Those files also
retain GPU-v0. The scorer sidecar independently requires identical
reference/candidate width, height, SAR, DAR, frame count, metric identity, and
exact VMAF/CAMBI aliases. The sole accepted VMAF name is the model-qualified
alias exactly equal to the pinned model version; the direct path passes
`name=<model version>`, and pooled plus every frame metric must carry that same
name. Bare, wrong-qualified, duplicate, and suffixed aliases fail closed.
Native-Linux FIFO publication and parsing of this contract is a required
deployment qualification, not an optional Windows-skipped check. CPU-v1 HDR
remains explicitly provisional and is not production-authorized by the
tracked policy.

CPU-v1 concurrency is now bounded at both layers:

- `maxParallelCpuV1=1` permits one CPU-v1 task per flow job;
- `cpuV1ThreadsPerScore=2` independently controls scorer threads;
- `vmaf-v1-score` takes a host-wide `flock` lease, with
  `VMAF_V1_MAX_PARALLEL=1` in the example deployment.

`maxParallelVmaf` remains the standalone pre-FGS CAMBI thread setting and no
longer leaks into CPU-v1 scorer commands. This reserves CPU for the Tdarr
control plane and decoders even when several flow jobs are active.

## Candidate selection, delivery, and terminal authority

`selectBestParameters` applies quality, frame-tail, banding, projected-size,
and holdout rules. `learnCQRange` and `exportVMAFResults` write selection and
search facts before the final title encode, but leave terminal outcome unknown.

The delivered-size contract is exact and versioned:

- the search target is 30% reduction;
- a delivered file must save at least 20%; and
- the authoritative final output/source byte ratio must be at most 80%,
  with equality accepted.

The historical 90% projected-ratio boundary is not part of this delivered
contract. It is a sample-estimate research boundary used for bounded,
reservation-backed label collection, with a separate emergency projection
cutoff. It must not be described as a validated delivered-success policy.

`vmafOptimizedTranscode` creates an authenticated post-encode checkpoint. This
allows later stages to reuse a verified exit-zero artifact after a process or
flow interruption. Its hard wall-clock watchdog is only an absolute liveness
backstop: it projects the selected parameter set's measured sample throughput
when available, otherwise allows 1/12-realtime processing, adds wide safety
slack, and clamps the result to 12–72 hours. Before it can report success,
an authoritative exact-byte post-mux check rejects any result at or above the
configured output/source cap and marks the outcome `size_failed` for bounded
retry or original-preserving cleanup. The exact authenticated checkpoint for a
rejected oversized generation is retired immediately so it cannot be reused.
If retirement fails, the original remains protected, the checkpoint record is
retained for later cleanup, and a warning/status is recorded.

`monitorTranscodeRetry` validates the base output and decides whether to retry,
keep the original, or proceed. Retries are bounded. A technically usable
candidate is not terminal success: the monitor durably records
`candidate_ready`, binds the canonical job and checkpoint identities, and
leaves all terminal success fields null. Technical failure records
`met_vmaf_target=NULL`; failure to complete delivery is not evidence that the
quality target was missed.

The final delivery boundary is deliberately split:

1. `validateDeliveryCandidate` authenticates the real checkpoint, pending
   database proof, full source/candidate identities, and the exact 30/20/80
   policy immediately before replacement.
2. `replaceOriginalFileAttested` creates the delivery transaction journal and
   compare-and-swap transitions the schema-v17 row from `candidate_ready` to
   `replacement_committing` before filesystem mutation. It uses no-overwrite
   staging, retains and authenticates the exact original backup, installs the
   candidate, then advances the row and journal to `delivery_committing`.
   Ambiguous crash recovery, a pre-existing backup, path aliasing, or identity
   drift fails closed.
3. `finalizeDeliveredOutcome` verifies the journal, database row, installed
   file, retained backup, candidate validation, and replacement attestation.
   It attempts to retire only the authenticated backup. If bounded retirement
   fails but the exact backup still revalidates, the immutable outcome records
   `replacement_backup_retained=1`; otherwise it records removal after parent
   directory fsync. It then compare-and-swap commits the `delivered` row and
   publishes the finalization proof. It is the sole authority for delivered
   success.

The durable database path is therefore:

```text
candidate_ready
  -> replacement_committing
  -> delivery_committing
  -> delivered
```

The transaction journal has corresponding filesystem phases so a flow restart
does not have to trust transient Flow variables. Cleanup requires the delivered
database/finalization/journal proofs before it can retire the authenticated
post-encode checkpoint. Before removing the journal or checkpoint artifacts it
atomically publishes permanent `delivery-retirement-v1.json` evidence under
schema `vmaf-delivery-retirement-tombstone/v1`. It embeds the current
finalization-v2 evidence, replacement proof, exact terminal database
critical-field projection, and authenticated checkpoint inventory, plus
digests of the delivered journal, finalization, replacement, database
projection, and tombstone itself. The tombstone remains after retirement,
makes retries idempotent, and prevents an absent checkpoint from being
mistaken for unauthenticated success.

## Film grain

`analyzeFilmGrain` runs the pinned direct pipeline and produces a versioned,
source-scoped artifact. The pipeline combines the required NVEncC KNN analysis
with grav1synth fitting.

`synthesizeFilmGrain` applies the artifact after a successful base encode.
After the direct bitstream rewrite and final ancillary mux, it validates
structure, metadata, semantic grain headers, and then decodes the complete AV1
title before the candidate can be promoted. NVDEC/CUVID is used when its
one-frame capability preflight succeeds. If the GPU decoder is unavailable,
the complete title is decoded in software; decode errors and timeouts route
through the untouched-original fallback and never publish the rewritten file.

Both grain plugins compare canonical `realpath` values with canonical,
allowlisted media and artifact roots. Lexical containment is checked before
resolution and canonical containment after it, so a symlink cannot escape the
configured scope merely because `stat` follows it.

## Persistence

### Tdarr application database

Tdarr's live SQL directory is mounted from a named Docker volume over
`/app/server/Tdarr/DB2/SQL`. A same-named host directory is therefore a stale
shadow, not a reliable backup source. Back up the active volume with SQLite's
online backup API during a quiescent/consistent operation.

### Learning database

`/app/configs/vmaf_training.db` is the row-level learning authority. Its
`jobs` and `sweep_points` tables contain media-identifying fields and are
private. SQLite is authoritative. CSV telemetry is disabled by default; an
opt-in export writes exclusive per-job files beneath a `.d` bundle directory
and never appends to a shared CSV.

Schema version 17 enforces the delivery state machine and exact policy fields
with database guards. `delivered` outcomes are immutable and include the
transaction/checkpoint identities, exact-byte size result, final timestamp,
and replacement attestation. Pre-delivery and technical outcomes cannot
masquerade as success.

The public database under `data/public/` is built from scratch. It contains
only aggregate buckets with a minimum cohort size and never copies raw pages,
row identifiers, paths, titles, release groups, or exact timestamps.
The private live database uses runtime schema 17; the independently constructed
aggregate artifact uses public export schema
`tdarr-vmaf-public-learning/v3`. These are separate schemas and their version
numbers are not expected to match.

### Deployment source

The init hook copies pinned plugin files to both the persistent server catalog
and the ephemeral internal-node catalog. It also exposes shared helpers from
`/custom-cont-init.d/vmaf-plugin-patches/_lib`, because existing plugins use
that absolute fallback.

The init-pinned subset of the review tree (`plugins/`) and deployment mirror
must stay identical. Inactive reference plugins are not necessarily mirrored
or startup-pinned. `manifest.json`, the checkout source-parity verifier, and
the in-container deployment verifier exist to detect drift in the pinned
runtime set.

## Trust boundaries

- Media filenames and paths are untrusted input.
- Flow inputs may be edited through Tdarr and must not select arbitrary
  deletion/lock roots.
- Plex/TMDB/TVDB/Radarr/Sonarr credentials belong in environment variables,
  never the tracked flow.
- Arr unmonitor operations are external state changes. The pinned plugin binds
  the parsed Arr ID to exactly one file record using consistent Tdarr
  original/library path evidence, rejects ambiguity, and reads back both the
  same file identity and explicit `monitored=false` after mutation.
- Custom init, FFmpeg, CUDA, grav1synth, grain-pipeline, and NVEncC artifacts
  are privileged deployment inputs and must be checksum-pinned.
