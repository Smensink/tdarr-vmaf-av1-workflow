# Tdarr VMAF AV1 Workflow

A Tdarr local-flow workflow for AV1 NVENC transcoding with VMAF/CAMBI-guided CQ selection, adaptive sampling, learned CQ priors, output-size guards, and holdout validation.

This repository is a clean public export. It intentionally excludes private Tdarr state: databases, logs, job reports, media paths, raw learning rows, API keys, and cache/work directories.

## What is included

- Local Tdarr flow plugins under `plugins/vmaf/`
- A Tdarr flow export under `flow/`
- Container/init scripts under `docker/`
- Aggregate-only learning warm-start data under `data/seed/`
- Sanitization, audit, and validation tools under `tools/`
- Documentation under `docs/`

## Privacy model

The seed data is aggregate-only. It does **not** include file paths, filenames, titles, release groups, exact timestamps, Plex/TMDB/TVDB identifiers, API tokens, raw job reports, or raw CSV rows.

If you have your own learning CSVs, place them outside the repo or under `data/private/` and run:

```bash
python3 tools/sanitize-learning-data.py \
  --learning-csv /path/to/vmaf_cq_learning.csv \
  --ema-json /path/to/ema_cq_state.json \
  --out-dir data/seed
```

## Important licensing note

The included FFmpeg build script can enable GPL/nonfree options for CUDA/NVENC workflows. A locally built image is fine for personal use, but prebuilt binary redistribution may not be. Treat the Dockerfile/build script as a reproducible recipe unless you have independently checked the exact license implications of your FFmpeg configuration.

## Quick start

1. Review `docker/docker-compose.example.yml` and add your own media-library mounts.
2. Build or provide a custom FFmpeg/libvmaf install.
3. Start Tdarr.
4. Import `flow/tdarr-flow-vmaf-av1.json` in the Tdarr UI.
5. Run validation:

```bash
bash tools/validate-install.sh tdarr
```

## Known import note

The exported flow references a `checkFileAge` local plugin that was not found in the exported local VMAF plugin tree. Either install/provide that plugin separately or remove that node from the flow after import.

## Repository layout

```text
docker/     container recipe, compose example, init hooks, FFmpeg build script
plugins/    Tdarr LocalFlowPlugins/vmaf plugin source
flow/       Tdarr flow JSON export
data/seed/  aggregate-only warm-start priors
tools/      sanitizer, secret/privacy audit, install validation
docs/       architecture, policy, privacy, troubleshooting
```
