# Tdarr VMAF AV1 Workflow

A Tdarr local-flow workflow for AV1 NVENC transcoding with VMAF/CAMBI-guided CQ selection, adaptive sample extraction, learned CQ priors, output-size guards, and holdout validation.

This repository is a **clean public export** of a custom workflow. It is meant to be a reproducible starting point, not a dump of someone else's Tdarr install. Private Tdarr state is intentionally excluded: databases, logs, job reports, media paths, raw learning rows, API keys, and cache/work directories.

## Who this is for

This project is useful if you want to:

- run AV1 NVENC transcodes through Tdarr
- choose CQ values from measured VMAF/CAMBI outcomes instead of fixed presets
- avoid obvious over-compression with BPP/bitrate/source-ratio guards
- warm-start learning from aggregate priors without importing someone else's raw media history
- inspect or adapt a complex VMAF-based Tdarr flow

It is **not** a one-click generic Tdarr replacement. You still need a working Tdarr deployment, NVIDIA GPU support, media mounts, and a compatible FFmpeg/libvmaf build.

## What is included

- `plugins/vmaf/` — Tdarr local flow plugin source
- `flow/tdarr-flow-vmaf-av1.json` — exported Tdarr flow JSON
- `docker/` — example compose file, init hooks, Dockerfile, and FFmpeg/libvmaf build recipe
- `data/seed/` — aggregate-only warm-start priors
- `tools/` — sanitizer, privacy audit, install helper, and validation script
- `docs/` — architecture, installation notes, quality policy, privacy notes, release checklist, and troubleshooting

## What is intentionally excluded

- Tdarr databases and backups
- raw `vmaf_results.csv` / `vmaf_cq_learning.csv` rows
- job reports and application logs
- media paths, filenames, titles, release groups, Plex/TMDB/TVDB IDs
- API keys, tokens, `.env` files, and host-specific config
- built FFmpeg/CUDA/libvmaf binaries and runtime cache files

## Requirements

Expected runtime shape:

- Tdarr with Local Flow Plugins
- NVIDIA GPU with NVENC/CUVID support
- Docker with NVIDIA GPU passthrough, if using the example compose file
- custom FFmpeg exposing the filters/encoders used by the flow:
  - `libvmaf`
  - optionally `libvmaf_cuda`
  - `av1_nvenc`, `hevc_nvenc`, `h264_nvenc`
- Node.js available locally if you want to run plugin syntax checks
- Python 3.10+ for the sanitizer/audit tools

See [Installation](docs/installation.md) for the full setup path.

## Quick start

```bash
git clone https://github.com/Smensink/tdarr-vmaf-av1-workflow.git
cd tdarr-vmaf-av1-workflow

# Check the public export for obvious private data before changing/publishing it.
python3 tools/audit-for-secrets.py .

# Check plugin syntax.
for f in plugins/vmaf/*/1.0.0/index.js; do node --check "$f" || exit 1; done
```

Then:

1. Review `docker/docker-compose.example.yml` and add your own media-library mounts.
2. Build or mount a compatible FFmpeg/libvmaf install.
3. Start Tdarr.
4. Install/copy the local plugins.
5. Import `flow/tdarr-flow-vmaf-av1.json` in the Tdarr UI.
6. Review every plugin input in the Tdarr UI before processing real media.
7. Validate the running container:

```bash
bash tools/validate-install.sh tdarr
```

## Installing the local plugins

For an already-running Tdarr container named `tdarr`, you can copy the exported plugins into both Tdarr local-plugin runtime locations:

```bash
bash tools/install-local-plugins.sh tdarr
```

The script restarts the container after copying. If you install manually, copy each plugin to both the server and node local-flow plugin roots; otherwise the UI and worker can disagree about which code is running.

## Importing the flow

Import:

```text
flow/tdarr-flow-vmaf-av1.json
```

Known import caveat: the exported flow references a `checkFileAge` local plugin that was not found in the exported VMAF plugin tree. After import, either provide your own `checkFileAge` plugin or remove/replace that node in the Tdarr UI.

`fetchMediaMetadata` supports optional Plex/TMDB/TVDB lookups. Leave those inputs blank if you do not want metadata API calls. If you do use them, enter your own local endpoint/API keys in the Tdarr UI; none are included here.

## Learning data and privacy

The files in `data/seed/` are aggregate priors only. They do **not** include raw rows, titles, paths, timestamps, release groups, or API identifiers.

To generate your own seed files from private local data:

```bash
python3 tools/sanitize-learning-data.py \
  --learning-csv /path/to/vmaf_cq_learning.csv \
  --ema-json /path/to/ema_cq_state.json \
  --out-dir data/seed
```

The sanitizer is allowlist-based: only broad buckets and rounded summary statistics are emitted.

## Important licensing note

The included FFmpeg build recipe can enable GPL/nonfree options for CUDA/NVENC workflows. A locally built image may be fine for personal use, but **prebuilt binary/image redistribution may not be**. Treat this repository as a source/build recipe unless you have independently checked the exact license implications of your FFmpeg configuration.

## Documentation

- [Installation](docs/installation.md)
- [Architecture](docs/architecture.md)
- [Quality policy](docs/quality-policy.md)
- [Privacy and data handling](docs/privacy-and-data.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release checklist](docs/release-checklist.md)

## Repository layout

```text
docker/     container recipe, compose example, init hooks, FFmpeg build script
plugins/    Tdarr LocalFlowPlugins/vmaf plugin source
flow/       Tdarr flow JSON export
data/seed/  aggregate-only warm-start priors
tools/      sanitizer, privacy audit, install validation
docs/       installation, architecture, policy, privacy, troubleshooting
```

## Current status

This repo has been validated against the original local Tdarr container with:

```bash
python3 tools/audit-for-secrets.py .
for f in plugins/vmaf/*/1.0.0/index.js; do node --check "$f" || exit 1; done
bash tools/validate-install.sh tdarr
```

Your own FFmpeg build, GPU, Tdarr version, flow import, and media paths still need local validation.
