# Architecture and active flow

This document describes the redacted live snapshot exported on 2026-07-27:
flow `YR5PZ1QaD`, 34 nodes, 53 edges. It distinguishes current behavior from
recommended changes.

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
  -> terminal monitor ----retry------+
  -> grain synthesis or FFmpeg fallback
  -> stream reorder
  -> replace source
  -> notify Radarr then Sonarr
  -> unmonitor Radarr then Sonarr
  -> cleanup
```

Error and keep-original branches release the GPU lock where applicable and
route through cleanup. `onFlowError` and its release node are detached from
ordinary edge reachability because Tdarr invokes the handler specially.

### Known graph defects

- `detectGPUEncoder` output 2 is documented as no-GPU/failure, but both outputs
  currently continue into HDR analysis.
- `compareFileSizeRatioLive` has only output 1, while the graph retains an edge
  from output handle 2.
- Several important policy defaults are inherited rather than explicitly bound.
- The graph sets paired-CQ acting true and force-full true; force-full disables
  acting, so the configuration is internally misleading.

The tracked graph remains a faithful redacted snapshot. These corrections
should be applied as a versioned migration and deployed only after a drain.

## GPU ownership

The current global lock is a directory under `/temp`. Candidate sample encodes
and final full-title transcodes acquire it through explicit graph nodes. The
lock contains a token and heartbeat, and the normal release plugin requires
token ownership.

Film-grain analysis currently occurs before the first graph lock. Its NVEncC
KNN stage can therefore overlap another job's GPU work. A prior desired
canonical graph put the entire analysis plugin under the lock, but that would
also serialize several minutes of mostly CPU fitting. The design decision is
not resolved by measurement.

Recommended redesign:

1. keep the live graph unchanged while jobs run;
2. measure KNN/encode overlap on a drained canary;
3. move lock acquisition into the narrow GPU-using section of grain analysis,
   or split that section into a dedicated node;
4. change the graph, deployment canonical, parity tests, and operations
   documentation atomically.

`calculateVMAF` can release the GPU lock while CPU-v1 scoring runs, but its
internal handoff currently ignores release failure, then synchronously
reacquires the lock before CPU-only aggregation and selection. Later graph
nodes already acquire the lock before subsequent GPU work. The internal
reacquire should be removed after its ownership contract is repaired.

## Sample search and scoring

`extractVideoSamples` chooses representative segments and can expand to at most
16 segments. `testEncodingParameters` encodes CQ candidates using AV1 NVENC.
`calculateVMAF` measures candidates and `checkCQBracket` decides whether to
continue searching.

Two metric paths are present:

- the custom FFmpeg/libvmaf GPU contract;
- an isolated official libvmaf 3.2.0 CPU/float scorer.

The active graph enables CPU-v1 production authority and provisional HDR.
This is a deployment fact, not a validation claim. The CPU helper accepts only
narrow full-width/full-height 1080/4K geometry bands, while the upstream
contract resolver accepts a much broader set. Unsupported 720p, 1440p, SD,
portrait, DCI/cropped, or missing-aspect-ratio sources can therefore fail after
CPU authority is selected.

Concurrency is also local rather than global:

- `maxParallelCpuV1=2` permits two CPU scorers per flow job;
- `maxParallelVmaf=8` is also used as threads per CPU-v1 scorer;
- multiple active flow jobs multiply both values.

A host-wide semaphore and a dedicated `cpuV1ThreadsPerScore` input should
reserve CPU for the Tdarr server, node, Docker, and decoders.

## Candidate selection and terminal encode

`selectBestParameters` applies quality, frame-tail, banding, projected-size,
and holdout rules. `learnCQRange` and `exportVMAFResults` write search outcomes
before the final title encode. The terminal monitor is the appropriate source
of truth for transcode success/failure; the older CSV success label written
before transcode is semantically wrong.

`vmafOptimizedTranscode` creates an authenticated post-encode checkpoint. This
allows later stages to reuse a verified exit-zero artifact after a process or
flow interruption. It also enforces a hard wall-clock timeout of twice the
source duration, clamped to 30 minutes–4 hours.

`monitorTranscodeRetry` validates the terminal output and decides whether to
retry search/transcode, keep the original, or proceed. Retries are bounded.

## Film grain

`analyzeFilmGrain` runs the pinned direct pipeline and produces a versioned,
source-scoped artifact. The pipeline combines the required NVEncC KNN analysis
with grav1synth fitting.

`synthesizeFilmGrain` applies the artifact after a successful base encode.
The direct production path validates structure and metadata, but the audit
found that it does not perform bounded full-title decode validation after the
bitstream rewrite. That validation must be restored before replacement.

Both grain plugins should compare canonical `realpath` values with a canonical
media root. Their current regex checks occur on uncanonicalized paths while
`stat` follows symlinks.

## Persistence

### Tdarr application database

Tdarr's live SQL directory is mounted from a named Docker volume over
`/app/server/Tdarr/DB2/SQL`. A same-named host directory is therefore a stale
shadow, not a reliable backup source. Back up the active volume with SQLite's
online backup API during a quiescent/consistent operation.

### Learning database

`/app/configs/vmaf_training.db` is the row-level learning authority. Its
`jobs` and `sweep_points` tables contain media-identifying fields and are
private. SQLite is authoritative; CSV outputs are best-effort sidecars and
have unlocked append races.

The public database under `data/public/` is built from scratch. It contains
only aggregate buckets with a minimum cohort size and never copies raw pages,
row identifiers, paths, titles, release groups, or exact timestamps.

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
- Arr unmonitor operations are external state changes and need stronger
  identity verification.
- Custom init, FFmpeg, CUDA, grav1synth, grain-pipeline, and NVEncC artifacts
  are privileged deployment inputs and must be checksum-pinned.
