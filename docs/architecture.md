# Architecture

This project is a Tdarr Local Flow Plugin chain plus a matching FFmpeg/libvmaf runtime. The main idea is simple: **measure a few candidate encodes before committing to the full-file transcode**.

A usual Tdarr install often applies a static preset. This workflow instead builds a small per-file experiment, scores the outputs, and chooses the final transcode parameters from the evidence.

## System components

```text
┌──────────────────────┐
│ Tdarr flow JSON       │  Defines plugin order and edges in the Tdarr UI
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ Local Flow Plugins    │  JavaScript plugins under plugins/vmaf/
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ FFmpeg/libvmaf image  │  Expected encoders, decoders, VMAF filters, wrappers
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ Tdarr config state    │  SQLite + CSV learning data and result history
└──────────────────────┘
```

The plugin code communicates through `args.variables`. Longer-lived learning state is stored in Tdarr's config directory as CSV/JSON files.

## High-level flow

```text
preflight checks
  → optional metadata lookup
  → HDR / stream metadata detection
  → sample extraction
  → candidate CQ range selection
  → sample encodes with AV1 NVENC
  → VMAF/CAMBI scoring
  → bracket expansion if needed
  → best-candidate selection
  → holdout validation
  → final full-file transcode
  → result export
  → CQ-learning update
  → cleanup / retry bookkeeping
```

## Decision loop

The decision loop has three phases.

### 1. Predict a useful CQ range

`extractVideoSamples` and `testEncodingParameters` use existing learning data and source metadata to avoid testing every possible CQ. The initial range is a guess, not a commitment.

### 2. Measure candidate encodes

The workflow encodes short samples at candidate CQ values, then compares each encoded sample to the original sample with VMAF and related metrics. The result is a small quality/size curve for that specific source file.

### 3. Select or retry

`selectBestParameters` picks the most efficient acceptable candidate. If the tested range does not bracket the target, or if quality guards reject every candidate, retry plugins expand or shift the range and test again.

## Runtime paths

Source in this repo is grouped by Local Flow Plugin category:

```text
plugins/vmaf/<plugin>/1.0.0/index.js
plugins/filter/checkFileAge/1.0.0/index.js
```

Typical Tdarr runtime paths:

```text
/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf/<plugin>/1.0.0/index.js
/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/vmaf/<plugin>/1.0.0/index.js
```

The plugin code communicates through `args.variables`. Longer-lived learning state is stored in Tdarr's config directory as an SQLite database (`vmaf_training.db`) for new data, with legacy CSV files (`vmaf_results.csv`, `vmaf_cq_learning.csv`) retained for backward compatibility.

## Learning state

The learning system uses **SQLite as the primary store** for new transcode data. The library (`plugins/vmaf/_lib/vmafdb.js`) manages two tables:

- **jobs** — one row per transcode: source facts (resolution, codec, bitrate, source CAMBI, bit depth), the CQ decision made, and the measured outcome (actual VMAF, CAMBI, output size).
- **sweep_points** — one row per (job, CQ) pair: the measured CQ→VMAF/CAMBI/size curve for that file. These curves are content-independent and are pooled across dissimilar sources to predict a good CQ centre before a sweep runs.

### Phase 4 — ACTING (June 2026)

The A/B-shadow predictor has been promoted to full acting mode. The current active system includes:

- **Learned similarity weights (η² correlation ratios)** — `vmafpredict.learnFeatureWeights` computes each metadata covariate's η² on the optimal-CQ distribution. Live empirical findings: `release_group` and `genre` (η²≈0.23 each) are the top predictors; `network` ≈0.19; `type`/`year`/`language`/`codec` ≈0. These are recomputed from the live DB on every prediction call, so they self-update as more data accrues.

- **Sequential sampling with early stop** — `calculateVMAF` now measures clips in randomised order (shared permutation across CQs so curves remain comparable) and stops a CQ once its mean CI ≤ 0.5 VMAF and the worst clip clears `floor+2` margin. Per-file sigma is plausibility-bounded (0.05–6) and fed back for future clips. Disabled via `args.variables.vmafSequentialSampling=false`.

- **Holdout CAMBI self-comparison** — the holdout validation now compares the holdout segment's own source CAMBI to the encode-introduced CAMBI delta, rather than gating against a job-global floor. Fixes VMAF-100/CAMBI-high false-fails where source banding was already elevated.

- **Data integrity filter** — `getSimilarSweepCurves` (v4 schema) excludes physically-impossible rows (`vmaf_min>vmaf_max` or `vmaf_mean` outside `[min,max]`) by default. ~92% of historical CSV-backfill rows had these misalignments; `recover_sweep_aggregates.js` recomputed correct aggregates from per-sample columns, reducing violations from 17,956 to 107 (auto-excluded).

- **Per-file sigma bounding** — `selectSampleCount` now plausibility-bounds per-clip sigma to [0.05, 6] with a floor of 3 clips. Previously inert despite being wired in; now actively adapts clip count to content variance.

### Additional _lib utilities

- `backfill_metadata.js` — enriches historical jobs with metadata covariates (genre, release_group, network, codec) for the η² feature learning.
- `recover_sweep_aggregates.js` — recomputes corrupted aggregate columns (`vmaf_mean`, `vmaf_min`, `vmaf_max`) from per-sample data already stored in `sweep_points`.

### Legacy state

The legacy CSV files are not cross-linked with new SQLite jobs (they shared no common key). New jobs are unified by `vmafJobId`, a shared variable seeded by `extractVideoSamples` and propagated through the full flow.

## Why the FFmpeg/libvmaf runtime is part of the architecture

The plugins are tightly coupled to FFmpeg capabilities. They expect AV1 NVENC encoders, VMAF filters, FFprobe behavior, and wrapper names used by Tdarr. That is why the recommended path is the provided FFmpeg/libvmaf image/build, not a stock Tdarr image with arbitrary FFmpeg.

See [Installation](installation.md) and [Plugin reference](plugin-reference.md).
