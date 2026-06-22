# Installation

This repository provides the workflow, plugins, seed priors, and build/deploy helpers. It does not ship a private Tdarr database or a guaranteed-redistributable FFmpeg binary.

## 1. Prepare Tdarr

Use either an existing Tdarr container or the example compose file:

```bash
cp docker/docker-compose.example.yml docker-compose.yml
```

Before starting it, edit `docker-compose.yml` and set:

- your timezone
- `PUID` / `PGID`
- media-library mounts
- persistent paths for `server`, `configs`, `logs`, and `cache`
- whether Tdarr auth should be enabled

The example compose file keeps media mounts commented out on purpose. Do not expose an unauthenticated Tdarr UI to the public internet.

## 2. Provide compatible FFmpeg/libvmaf

The flow expects an FFmpeg build with NVIDIA hardware encoding and VMAF support.

Minimum practical checks:

```bash
tdarr-ffmpeg -hide_banner -filters 2>/dev/null | grep -iE 'libvmaf|vmaf'
tdarr-ffmpeg -hide_banner -encoders 2>/dev/null | grep -iE 'av1_nvenc|hevc_nvenc|h264_nvenc'
tdarr-ffmpeg -hide_banner -h filter=libvmaf 2>&1 | grep -i feature
```

The build recipe is in:

```text
docker/build-ffmpeg-libvmaf.sh
```

It is a recipe for local builds. If your FFmpeg configure output includes `--enable-nonfree`, do not redistribute the resulting image/binary unless you have independently confirmed that redistribution is allowed.

## 3. Install local plugins

With a running Tdarr container named `tdarr`:

```bash
bash tools/install-local-plugins.sh tdarr
```

This copies each plugin under `plugins/vmaf/` into both local-flow plugin paths used by Tdarr's server and node, then restarts the container.

Why both paths matter: Tdarr can show plugins from the server path while the node executes its own cached/runtime copy. If only one path is updated, the UI and worker can silently disagree.

## 4. Import the flow

Import this file in the Tdarr UI:

```text
flow/tdarr-flow-vmaf-av1.json
```

After import:

1. Open the flow in the UI.
2. Review every plugin input.
3. Add your own Plex/TMDB/TVDB credentials only if you want metadata lookup.
4. Confirm output paths and codec policy match your library.
5. Resolve the `checkFileAge` caveat below.

## 5. Resolve the `checkFileAge` caveat

The exported flow references a local plugin named `checkFileAge`, but that plugin was not present in the exported VMAF plugin tree.

Choose one:

- provide your own `checkFileAge` local plugin
- remove that node from the flow
- replace it with an equivalent Tdarr/community age gate

If you remove it, newly downloaded files may be processed immediately. That may be fine, but it can race with downloads/imports if your media manager is still writing files.

## 6. Validate the deployment

Run:

```bash
bash tools/validate-install.sh tdarr
```

This checks local plugin syntax, the running Tdarr container, FFmpeg/VMAF filters, NVENC encoders, and the presence of key runtime plugin files.

## 7. Start conservatively

Before pointing this at a whole library:

1. Test on a small library or a few known files.
2. Read job reports for VMAF/CAMBI output.
3. Confirm output size and quality are acceptable.
4. Confirm learning files are being updated in your own `configs/` directory.
5. Only then scale concurrency.
