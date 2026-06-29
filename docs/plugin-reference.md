# Plugin reference

This page explains what each Local Flow Plugin contributes to the workflow. The exact Tdarr graph is in `flow/tdarr-flow-vmaf-av1.json`.

## Preflight and metadata plugins

### `checkFileAge`

Age-gates newly added files before expensive processing begins. This prevents Tdarr from transcoding files that may still be downloading, importing, unpacking, or being modified by another application. It can calculate age from file creation time, file modification time, or Tdarr's own added/discovered timestamp.

### `checkVideoCodec`

Skips files that are already in the target codec, normally AV1. This prevents accidental re-encoding of files that have already been processed.

### `checkFileLimits`

Applies basic size and duration gates before expensive sample extraction or VMAF scoring. Use this to keep unusually large or long files out of the workflow unless you explicitly want to process them.

### `detectGPUEncoder`

Checks the FFmpeg encoder list for NVIDIA hardware encoders such as `av1_nvenc`. The rest of the workflow assumes hardware encoding is available for sample encodes and final transcodes.

### `fetchMediaMetadata`

Optionally enriches the job with media metadata from Plex/TMDB/TVDB. The quality model can use content class signals such as animation/live-action, source type, year, genre, and a canonical filename-derived `media_title` used for same-show/movie curve similarity. If API inputs are blank or lookups fail, the workflow falls back to filename and stream-derived heuristics.

### `checkHdrContent`

Inspects stream metadata for HDR-related signals such as PQ/HLG transfer characteristics, BT.2020 color primaries, Dolby Vision indicators, pixel format, mastering display metadata, and max content light level. Downstream plugins use this to choose pixel format and quality thresholds.

## Sampling and CQ-search plugins

### `detectSceneComplexity`

Uses FFmpeg scene-change analysis to estimate how variable the source is. More variable content may need more samples or a more cautious CQ search.

### `extractVideoSamples`

Creates short representative source samples for testing. It also loads learned CQ priors from previous runs via `vmafdb.js` and `vmafpredict.js` (`plugins/vmaf/_lib/`) so the sweep can begin near a likely-good range instead of starting from scratch. The `vmafJobId` is seeded here and propagated through the full flow to link all records for a job together.

Important details:

- avoids obvious attached-picture/cover-art streams
- reserves a holdout sample for later validation
- rejects pathological samples that are much longer than requested
- writes sample paths and learned range data into `args.variables`

### `testEncodingParameters`

Builds candidate parameter sets and encodes the extracted samples, normally using AV1 NVENC. The main variable under test is CQ. Sample encodes run through a bounded async worker pool (`maxParallelEncodes`) and reject near-empty outputs so bad samples cannot poison later VMAF scoring.

### `calculateVMAF`

Compares encoded samples to the original samples using FFmpeg/libvmaf. It records VMAF and related metrics, including CAMBI where the build supports it.

This is why the provided FFmpeg/libvmaf runtime matters: missing filters, model support, CUDA/NVENC support, or feature hooks will break this stage.

### `checkCQBracket`

Looks at the measured CQ sweep and asks: did the tested values actually surround the target quality? If all candidates are too good, the workflow can test higher CQ values for more compression. If all candidates are too poor, it can test lower CQ values for more bits.

### `checkCQRangeRetry`

Handles retry decisions when the CQ range or selection result is inadequate. It is VMAF/1%-low/CAMBI-aware: retries are based on the measured binding quality boundary, with CAMBI extrapolation capped so a shallow high-CQ slope cannot jump to absurdly low retry CQs.

## Selection and transcode plugins

### `selectBestParameters`

Chooses the final candidate. This is the main policy engine. It considers:

- mean/harmonic VMAF
- 1%-low frame VMAF
- projected output size
- projected BPP and Mbps
- output/source-size ratio
- CAMBI/banding score where available
- holdout validation (self-comparing: encode-introduced CAMBI delta vs holdout source CAMBI baseline)
- learned risk policy for resolution/HDR/content class
- constraint-aware selectCQ from `vmafpredict.js` (`plugins/vmaf/_lib/`), which picks the cheapest CQ that satisfies all constraints simultaneously
- **learned η² similarity weights** from `learnFeatureWeights`, recomputed from the live DB on every call (self-updating)

The selected CQ is the most efficient candidate that still clears the quality and safety guards. If no candidate is acceptable, retry plugins get a chance to test safer values.

**Phase 4 ACTING (June 2026)** — `[SHADOW]` log mode has been disabled; the new constraint-aware `selectCQ` pick is now live.

### `vmafOptimizedTranscode`

Runs the final full-file AV1 NVENC transcode using the chosen parameters. It preserves relevant HDR/color metadata where supported, reports progress back to Tdarr, and uses a hard watchdog timeout (`2×` source duration, clamped 30 min–4 h) so a pathological encode cannot hold the GPU pipeline lock forever.

### `acquireGpuPipelineLock` / `releaseGpuPipelineLock`

Serialise GPU-heavy stages across multiple Tdarr GPU workers. The flow acquires the lock before sample encodes/VMAF and before final transcode, releases it immediately after final transcode, and allows post-processing/copy/notify work to overlap the next worker's pre-GPU preparation. The acquire plugin is re-entrant for the same job token so retry loops do not self-deadlock.

### `monitorTranscodeRetry`

Tracks final transcode failures and decides whether a retry should use a previously measured safer CQ. This avoids blindly retrying with a setting that already looked bad during the sweep.

## Export, learning, and cleanup plugins

### `exportVMAFResults`

Writes detailed per-candidate and per-file quality/size data to CSV (legacy path) and dual-writes the sweep curve to SQLite via `vmafdb.js`. The SQLite record includes VMAF, CAMBI, 1%-low VMAF, SSIM, clip-level VMAF arrays, `media_title`, and the source/decision context — signals the legacy CSV never stored. This is useful for later analysis and for improving the learning model.

### `learnCQRange`

Updates the CQ learning state from completed runs. It records what was tested, what was selected, whether targets were met, retry behavior, media/source buckets, and model-fit information. The `source_cambi` and `source_cambi_p95` columns are recorded to allow future CQ predictions to account for the source's banding risk. Dual-writes the job outcome to SQLite.

Future files can use this state to start with narrower and better CQ ranges.

### `learnCQRanges`

A secondary learning plugin that maintains per-resolution and per-content-class CQ tier boundaries. It aggregates successful outcomes into discrete CQ buckets (e.g. "1080p animation", "4k live-action") to provide a fast fallback when the full SQLite predictor is unavailable or has insufficient history for a new source type.

### `cleanupTempFiles`

Removes temporary samples, test encodes, and VMAF log artifacts from the work directory.
