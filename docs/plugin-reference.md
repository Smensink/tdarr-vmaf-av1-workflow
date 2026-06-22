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

Optionally enriches the job with media metadata from Plex/TMDB/TVDB. The quality model can use content class signals such as animation/live-action, source type, year, and genre. If API inputs are blank or lookups fail, the workflow falls back to filename and stream-derived heuristics.

### `checkHdrContent`

Inspects stream metadata for HDR-related signals such as PQ/HLG transfer characteristics, BT.2020 color primaries, Dolby Vision indicators, pixel format, mastering display metadata, and max content light level. Downstream plugins use this to choose pixel format and quality thresholds.

## Sampling and CQ-search plugins

### `detectSceneComplexity`

Uses FFmpeg scene-change analysis to estimate how variable the source is. More variable content may need more samples or a more cautious CQ search.

### `extractVideoSamples`

Creates short representative source samples for testing. It also loads learned CQ priors from previous runs so the sweep can begin near a likely-good range instead of starting from scratch.

Important details:

- avoids obvious attached-picture/cover-art streams
- reserves a holdout sample for later validation
- rejects pathological samples that are much longer than requested
- writes sample paths and learned range data into `args.variables`

### `testEncodingParameters`

Builds candidate parameter sets and encodes the extracted samples, normally using AV1 NVENC. The main variable under test is CQ. The output is a set of small encoded samples ready for quality measurement.

### `calculateVMAF`

Compares encoded samples to the original samples using FFmpeg/libvmaf. It records VMAF and related metrics, including CAMBI where the build supports it.

This is why the provided FFmpeg/libvmaf runtime matters: missing filters, model support, CUDA/NVENC support, or feature hooks will break this stage.

### `checkCQBracket`

Looks at the measured CQ sweep and asks: did the tested values actually surround the target quality? If all candidates are too good, the workflow can test higher CQ values for more compression. If all candidates are too poor, it can test lower CQ values for more bits.

### `checkCQRangeRetry`

Handles retry decisions when the CQ range or selection result is inadequate. It is VMAF-aware: retries are based on measured quality, not just on whether FFmpeg succeeded.

## Selection and transcode plugins

### `selectBestParameters`

Chooses the final candidate. This is the main policy engine.

It considers:

- mean/harmonic VMAF
- 1%-low frame VMAF
- projected output size
- projected BPP and Mbps
- output/source-size ratio
- CAMBI/banding score where available
- holdout validation
- learned risk policy for resolution/HDR/content class

The selected CQ is the most efficient candidate that still clears the quality and safety guards. If no candidate is acceptable, retry plugins get a chance to test safer values.

### `vmafOptimizedTranscode`

Runs the final full-file AV1 NVENC transcode using the chosen parameters. It preserves relevant HDR/color metadata where supported and reports progress back to Tdarr.

### `monitorTranscodeRetry`

Tracks final transcode failures and decides whether a retry should use a previously measured safer CQ. This avoids blindly retrying with a setting that already looked bad during the sweep.

## Export, learning, and cleanup plugins

### `exportVMAFResults`

Writes detailed per-candidate and per-file quality/size data to CSV. This is useful for later analysis and for improving the learning model.

### `learnCQRange`

Updates the CQ learning state from completed runs. It records what was tested, what was selected, whether targets were met, retry behavior, media/source buckets, and model-fit information.

Future files can use this state to start with narrower and better CQ ranges.

### `cleanupTempFiles`

Removes temporary samples, test encodes, and VMAF log artifacts from the work directory.
