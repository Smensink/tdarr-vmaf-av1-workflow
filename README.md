# Tdarr VMAF AV1 Workflow

**GitHub description:** Tdarr AV1 NVENC workflow with FFmpeg/libvmaf CUDA container, VMAF/CAMBI-guided CQ sweeps with per-file sequential sampling, η²-learned metadata similarity weights, holdout CAMBI self-comparison, constraint-aware optimum bracketing, same-file re-encode prior, known-failed CQ avoidance, retry graceful fallback (max 4), and data-integrity-filtered SQLite learning.

This project is a Tdarr workflow for people who want **measured, per-title AV1 quality decisions** instead of a fixed CRF/CQ preset. It extends the usual Tdarr pattern of "if file matches rules, run one transcode command" into a quality-search pipeline:

1. inspect the source file
2. extract representative samples
3. encode those samples at several candidate CQ values
4. score each candidate against the source with Netflix VMAF and CAMBI-style banding signals
5. reject candidates that are too small, too low-quality, or risky on a holdout sample
6. transcode the full file using the selected parameters
7. record the result so future files start with better CQ guesses

The recommended path is to use the **provided container image/build assets for FFmpeg and libvmaf** rather than a stock Tdarr image with whatever FFmpeg happens to be present. The plugins expect a specific capability set: AV1 NVENC, NVIDIA decode support, libvmaf, VMAF model support, and libvmaf feature support for CAMBI-style banding checks. Using the provided image/build keeps those pieces aligned.

## What is different from a usual Tdarr install?

A typical Tdarr flow usually applies static rules: check codec/size/path, then run a predetermined transcode preset. That works, but it cannot know whether CQ 31, 35, or 39 is enough for a specific film or episode.

This workflow adds a feedback loop:

| Usual Tdarr flow | This workflow |
|---|---|
| One preset per rule/library | Per-file CQ search |
| Trusts encoder settings | Measures sample output against source |
| Usually checks size/codec after transcode | Predicts output size before final transcode |
| No objective quality feedback | Uses VMAF, CAMBI, 1%-low frame quality, and holdout validation |
| No memory between files | Learns CQ priors from completed runs; same-file re-encode priors |
| Any FFmpeg build might be used | Expects the provided FFmpeg/libvmaf capability set |

## Why VMAF and CAMBI?

[VMAF](https://github.com/Netflix/vmaf) is Netflix's perceptual video quality metric. It combines multiple lower-level image features into a score that better tracks human perception than simple metrics like PSNR. Netflix originally described this direction in [Toward a Practical Perceptual Video Quality Metric](https://netflixtechblog.com/toward-a-practical-perceptual-video-quality-metric-653f208b9652).

VMAF is useful, but a high average VMAF can still miss specific failure modes. Banding is one of them: smooth gradients can become visibly stair-stepped even when the overall VMAF score looks acceptable. Netflix introduced [CAMBI](https://netflixtechblog.com/cambi-a-new-video-quality-metric-for-hdr-1ba3aefc0f44), a banding-focused metric, to help detect that kind of artifact.

This workflow uses those ideas practically inside Tdarr: VMAF estimates perceptual quality, CAMBI helps flag banding risk, and extra guards prevent the encoder from choosing an output that is statistically good but visually suspicious.

## How the project is organized

- `docker/` — compose example, Dockerfile, init hooks, and FFmpeg/libvmaf build recipe
- `plugins/vmaf/_lib/` — shared Node.js libraries: `vmafdb.js` (SQLite data layer, v5 schema with clip_vmafs, data-integrity filters, same-file history queries, self-healing DB handle), `vmafpredict.js` (CQ predictor with η²-learned weights, sequential sampling, correlationRatio, same-file prior merging), `backfill_metadata.js`, `recover_sweep_aggregates.js`, backfill scripts, and analysis tools
- `scripts/` — patch scripts applied during development (`patch_learning_holdout.py`, `patch_meanmin_sampling.py`, `patch_quality_guard.py`, `remove_hard_sample_floor.py`)
- `plugins/vmaf/` — Tdarr Local Flow Plugins (`vmaf/` category)
- `plugins/filter/checkFileAge/` — age-gate plugin (`filter/` category)
- `flow/` — importable Tdarr flow (`tdarr-flow-vmaf-av1.json`) plus alternative templates (`vmafOptimization.js`, `vmafOptimizationAdvanced.js`)
- `data/seed/` — aggregate warm-start CQ priors
- `tools/` — install, validation, and data-sanitization helpers
- `docs/` — detailed architecture, plugin reference, quality policy, and troubleshooting

## Recommended installation path

Use the provided FFmpeg/libvmaf image/build path first. The workflow is designed around that environment; a stock Tdarr FFmpeg build is unlikely to expose everything the plugins expect.

1. Clone the repo.
2. Use the provided image/build assets in `docker/`.
3. Start Tdarr with NVIDIA GPU passthrough.
4. Install the local plugins.
5. Import the flow.
6. Validate the running container.

```bash
git clone https://github.com/Smensink/tdarr-vmaf-av1-workflow.git
cd tdarr-vmaf-av1-workflow

# Validate the checked-out plugin source.
for f in plugins/vmaf/*/1.0.0/index.js; do node --check "$f" || exit 1; done

# After Tdarr is running:
bash tools/install-local-plugins.sh tdarr
bash tools/validate-install.sh tdarr
```

See [Installation](docs/installation.md) for the full setup path.

## Flow overview

At a high level:

```text
preflight checks
  → optional metadata lookup
  → HDR / stream metadata detection
  → representative sample extraction
  → candidate AV1 NVENC sample encodes
  → VMAF/CAMBI scoring with sequential sampling (per-file early-stop)
  → constraint-aware bracket check (optimum bounded by 1%-low/CAMBI floor, not VMAF crossing)
  → CQ range expansion if the target is not bracketed
  → candidate selection with quality and size guards
  → holdout validation (self-comparing source CAMBI)
  → retry logic with known-failed CQ avoidance (caps bracket below previous misses)
  → final AV1 NVENC transcode
  → result export to SQLite (primary) + CSV sidecar with per-clip VMAF logging
  → CQ learning
  → cleanup
```

Each plugin's exact role is documented in [Plugin reference](docs/plugin-reference.md).

## Quality decision summary

The final CQ is not chosen from VMAF mean alone. A candidate must survive several layers:

- mean/harmonic VMAF target
- 1%-low frame VMAF floor
- projected BPP, bitrate, and output/source-size ratio
- CAMBI/banding threshold (dynamic per source — self-comparing on holdout)
- **constraint-aware bracket**: when all candidates meet quality constraints but a higher-CQ candidate fails one, the optimum is bracketed without VMAF-mean expansion
- holdout sample validation (CAMBI delta from source, not job-global floor)
- same-file history: re-queued files cap their bracket below known-failed CQs from prior runs
- retry graceful fallback (max 4 retries) — sweep data preserved for future re-queues
- **GPU VMAF without HDR tonemap**: the GPU's 8-bit requirement is met via `format=yuv420p` only — no tonemapping that would band gradients and create false CAMBI signals

See [Quality policy](docs/quality-policy.md) for the decision model.

## Learning and warm starts

The workflow writes learning data to an **SQLite database** (`vmaf_training.db`) after successful runs. Future files use that history to start with a better CQ bracket instead of cold-starting from the same wide range every time.

The library `plugins/vmaf/_lib/vmafdb.js` manages two tables: `jobs` (source facts, decision, outcome) and `sweep_points` (the CQ→VMAF curve for each job). The predictor `plugins/vmaf/_lib/vmafpredict.js` pools sweep curves from similar past jobs to predict a CQ centre, then runs a sequential root-finding sweep — converging in ~2–3 transcodes.

**Same-file re-encode prior:** When a file is re-queued (manual or automatic), the predictor merges its own previous sweep curves into the similarity pool with artificially-elevated timestamps (+1 day future), giving them maximum recency weight. This makes re-encodes converge faster because the exact CQ→VMAF curve already exists.

**Schema v5 — clip_vmafs:** Every sweep point now stores the raw per-clip VMAF scores as a JSON array. This enables backtesting the sequential sampler's stopping rule (mean CI, 1%-low coverage) against measured clip distributions — the key enabler for data-driven CQ budget optimisation.

Legacy CSV files (`vmaf_results.csv`, `vmaf_cq_learning.csv`) are retained as sidecars; SQLite is the primary store.

`data/seed/` contains aggregate warm-start priors. They are intentionally broad summaries, not raw transcode history. The seed priors help new installs avoid a completely blank model; your own local learning data should gradually become more important.

## Changelog

See [HANDOFF_vmaf_sqlite.md](HANDOFF_vmaf_sqlite.md) for a detailed change history.

## Documentation

- [Installation](docs/installation.md)
- [FFmpeg/libvmaf runtime](docs/runtime-image.md)
- [Architecture](docs/architecture.md)
- [Plugin reference](docs/plugin-reference.md)
- [Quality policy](docs/quality-policy.md)
- [Adaptive Tdarr workflow vs FileFlows](docs/fileflows-comparison.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release checklist](docs/release-checklist.md)
- [Privacy and data handling](docs/privacy-and-data.md)

## Licensing note

The FFmpeg/libvmaf build path can involve GPL and nonfree FFmpeg configuration flags for NVIDIA workflows. Use the provided image/build assets for operational compatibility, but do your own licensing review before redistributing any prebuilt binary image.
