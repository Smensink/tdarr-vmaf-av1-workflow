# Troubleshooting

## Validate plugin syntax

Run from the repository root:

```bash
for f in plugins/vmaf/*/1.0.0/index.js; do node --check "$f" || exit 1; done
```

If this fails, fix syntax before copying plugins into Tdarr. Tdarr's runtime errors are much harder to read than Node's direct syntax output.

## Validate a running Tdarr container

The first troubleshooting step should be validating the FFmpeg/libvmaf runtime. If this fails, fix the image/build before debugging plugin policy.

```bash
bash tools/validate-install.sh tdarr
```

Expected capabilities:

- `tdarr-ffmpeg` resolves to the custom build
- `libvmaf` and/or `libvmaf_cuda` filters are registered, depending on your build
- libvmaf exposes `feature=` support; CAMBI may or may not be explicitly listed in FFmpeg help
- `av1_nvenc`, `hevc_nvenc`, and `h264_nvenc` are available
- key VMAF plugin files exist in the Tdarr local-flow plugin tree

If CAMBI is not explicitly listed by `ffmpeg -h filter=libvmaf`, verify it from actual VMAF JSON/job logs after a test run. Some builds expose CAMBI only through the generic `feature=name=cambi` mechanism.

## Flow imports but a node is missing

The exported flow references `checkFileAge`, which is not included in this repo. Provide an equivalent local plugin or remove/replace that node after import.

## UI shows new plugin code but jobs run old behavior

Copy plugins to both server and node runtime paths, then restart the Tdarr container. Tdarr nodes can cache plugin code in memory, and server/node plugin roots can diverge.

Use:

```bash
bash tools/install-local-plugins.sh tdarr
```

## FFmpeg is found but VMAF jobs fail

Check:

```bash
docker exec tdarr tdarr-ffmpeg -hide_banner -filters 2>/dev/null | grep -i vmaf
docker exec tdarr tdarr-ffmpeg -hide_banner -encoders 2>/dev/null | grep -i nvenc
docker exec tdarr tdarr-ffmpeg -hide_banner -decoders 2>/dev/null | grep -i cuvid
```

Then inspect the Tdarr job report, not just the node log. Job reports usually contain the actual FFmpeg stderr.

## Output is too large or too small

Review the plugin inputs for:

- target minimum VMAF
- 1%-low frame floor
- BPP/Mbps/source-ratio guards
- CAMBI limit
- maximum/minimum CQ range
- whether seed priors or local learning data are being used

Start with a small test set before applying the flow to a large library.

## Metadata lookup is not wanted

Leave Plex/TMDB/TVDB inputs blank in `fetchMediaMetadata`, or remove that plugin from your flow. The rest of the workflow has filename/stream-metadata fallbacks, though quality decisions may be less content-aware.

## Licensing / binary image warning

If your FFmpeg configure output includes `--enable-nonfree`, do not redistribute the built binary/image unless you have independently confirmed redistribution is allowed.
