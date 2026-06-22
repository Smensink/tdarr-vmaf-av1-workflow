# Installation

The recommended installation path is to run this workflow with the **provided FFmpeg/libvmaf image or build recipe**. The plugins assume capabilities that are not present in many stock Tdarr/FFmpeg installs.

## Why the provided image/build matters

This is not just a set of Tdarr plugins. The plugins call FFmpeg in specific ways and expect support for:

- AV1 hardware encoding via `av1_nvenc`
- NVIDIA decode paths such as CUVID/NVDEC where available
- `libvmaf`
- optionally `libvmaf_cuda`
- libvmaf model support
- libvmaf `feature=` support for CAMBI-style banding checks
- FFprobe/FFmpeg wrappers named the way Tdarr expects, especially `tdarr-ffmpeg` and `tdarr-ffprobe`

If you run the flow against a random FFmpeg binary, failures will often appear deep inside Tdarr job reports. Using the provided image/build path makes the runtime match what the workflow expects.

## 1. Clone the repository

```bash
git clone https://github.com/Smensink/tdarr-vmaf-av1-workflow.git
cd tdarr-vmaf-av1-workflow
```

## 2. Choose runtime path

### Recommended: provided image/build path

Use the Docker assets under `docker/` so Tdarr, FFmpeg, libvmaf, and the init hooks are kept together.

```text
docker/docker-compose.example.yml
docker/Dockerfile
docker/build-ffmpeg-libvmaf.sh
docker/custom-cont-init.d/
```

If a prebuilt image is published for your platform, prefer that. Otherwise build locally from the provided recipe. Either way, validate the result with `tools/validate-install.sh` before processing real media.

### Advanced: bring your own FFmpeg

Only do this if you can reproduce the expected FFmpeg/libvmaf capabilities yourself. At minimum, the following checks should pass inside the Tdarr container:

```bash
tdarr-ffmpeg -hide_banner -filters 2>/dev/null | grep -iE 'libvmaf|vmaf'
tdarr-ffmpeg -hide_banner -encoders 2>/dev/null | grep -iE 'av1_nvenc|hevc_nvenc|h264_nvenc'
tdarr-ffmpeg -hide_banner -h filter=libvmaf 2>&1 | grep -i feature
```

## 3. Configure Docker Compose

Copy the example and edit it:

```bash
cp docker/docker-compose.example.yml docker-compose.yml
```

Set your own:

- timezone
- `PUID` / `PGID`
- media-library mounts
- persistent `server`, `configs`, `logs`, and `cache` paths
- Tdarr auth setting
- image tag or build target, depending on how you are using the provided image/build assets

The example file keeps media mounts commented out on purpose. Do not expose an unauthenticated Tdarr UI to the public internet.

## 4. Start Tdarr

```bash
docker compose up -d
```

Wait for the container to finish startup. The init hooks install FFmpeg wrappers and copy local plugin patches when configured.

## 5. Install local plugins

With a running Tdarr container named `tdarr`:

```bash
bash tools/install-local-plugins.sh tdarr
```

This copies every plugin under `plugins/vmaf/` to both Tdarr runtime plugin roots and restarts the container.

Why both paths matter:

```text
/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf/...
/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/vmaf/...
```

The server/UI and node worker can otherwise disagree about which plugin code is current.

## 6. Import the flow

Import this file in the Tdarr UI:

```text
flow/tdarr-flow-vmaf-av1.json
```

After import:

1. Open the flow in the UI.
2. Review each plugin input.
3. Set metadata API inputs only if you want Plex/TMDB/TVDB lookup.
4. Confirm output and library behavior for your setup.
5. Confirm the included `checkFileAge` age gate is present and configured for your preferred minimum age.

## 7. Configure the included `checkFileAge` gate

The flow includes `plugins/filter/checkFileAge/1.0.0/index.js`. It prevents Tdarr from processing files that may still be downloading, importing, or being modified.

After import, review its inputs in the Tdarr UI:

- **Minimum Age (Days)** — default age threshold before processing.
- **Date Type** — creation time, modification time, or Tdarr-added time.

If you do not want an age gate, you can remove this node from the flow. Be aware that newly added files may then be processed immediately.

## 8. Validate the deployment

Run:

```bash
bash tools/validate-install.sh tdarr
```

The script checks:

- local plugin JavaScript syntax
- container availability
- FFmpeg version and filters
- VMAF/libvmaf support
- NVENC encoders
- key plugin runtime files

## 9. Start conservatively

Before pointing this at a whole library:

1. Test on a few known files.
2. Read the Tdarr job reports.
3. Confirm VMAF/CAMBI scores are being emitted.
4. Confirm output size and quality are acceptable.
5. Confirm learning files are being updated in your own `configs/` directory.
6. Only then scale worker concurrency.

## Binary/image licensing note

The FFmpeg build path may use GPL/nonfree configuration flags for NVIDIA workflows. Use the provided image/build path for operational compatibility, but do a separate licensing review before redistributing a prebuilt image.
