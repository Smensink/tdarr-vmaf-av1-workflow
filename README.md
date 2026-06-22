# Tdarr VMAF AV1 Workflow

**GitHub description:** Tdarr AV1 NVENC workflow with a matching FFmpeg/libvmaf container, VMAF/CAMBI-guided CQ sweeps, adaptive quality guards, holdout validation, and learned CQ priors.

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
| No memory between files | Learns CQ priors from completed runs |
| Any FFmpeg build might be used | Expects the provided FFmpeg/libvmaf capability set |

## Why VMAF and CAMBI?

[VMAF](https://github.com/Netflix/vmaf) is Netflix's perceptual video quality metric. It combines multiple lower-level image features into a score that better tracks human perception than simple metrics like PSNR. Netflix originally described this direction in [Toward a Practical Perceptual Video Quality Metric](https://netflixtechblog.com/toward-a-practical-perceptual-video-quality-metric-653f208b9652).

VMAF is useful, but a high average VMAF can still miss specific failure modes. Banding is one of them: smooth gradients can become visibly stair-stepped even when the overall VMAF score looks acceptable. Netflix introduced [CAMBI](https://netflixtechblog.com/cambi-a-new-video-quality-metric-for-hdr-1ba3aefc0f44), a banding-focused metric, to help detect that kind of artifact.

This workflow uses those ideas practically inside Tdarr: VMAF estimates perceptual quality, CAMBI helps flag banding risk, and extra guards prevent the encoder from choosing an output that is statistically good but visually suspicious.

## How the project is organized

- `docker/` — compose example, Dockerfile, init hooks, and FFmpeg/libvmaf build recipe
- `plugins/` — Tdarr Local Flow Plugins used by the workflow (`vmaf/` and `filter/`)
- `flow/tdarr-flow-vmaf-av1.json` — importable Tdarr flow
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
  → VMAF/CAMBI scoring
  → CQ range expansion if the target is not bracketed
  → candidate selection with quality and size guards
  → holdout validation
  → final AV1 NVENC transcode
  → result export and CQ learning
  → cleanup
```

Each plugin's exact role is documented in [Plugin reference](docs/plugin-reference.md).

## Quality decision summary

The final CQ is not chosen from VMAF mean alone. A candidate must survive several layers:

- mean/harmonic VMAF target
- 1%-low frame VMAF floor
- projected BPP, bitrate, and output/source-size ratio
- CAMBI/banding threshold where available
- holdout sample validation
- retry logic if every candidate is too risky

See [Quality policy](docs/quality-policy.md) for the decision model.

## Learning and warm starts

The workflow writes learning data after successful runs. Future files use that history to start with a better CQ bracket instead of cold-starting from the same wide range every time.

`data/seed/` contains aggregate warm-start priors. They are intentionally broad summaries, not raw transcode history. The seed priors help new installs avoid a completely blank model; your own local learning data should gradually become more important.

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
