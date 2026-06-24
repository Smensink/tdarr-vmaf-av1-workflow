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

## `checkFileAge` blocks processing

The included `checkFileAge` plugin intentionally fails the flow for files newer than its configured age threshold. This is useful for avoiding half-written downloads/imports. If this is too conservative for your setup, lower the **Minimum Age (Days)** input or remove the node from the flow.

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

## Verifying Phase 4 ACTING is active in a job report

After the June 2026 promotion, the predictor runs in full acting mode. Confirm it in a completed job report by grepping for these markers:

```
[ACTING] Predictor-seeded                           ← selectBestParameters acting (not SHADOW)
[PREDICT] learned metadata importance              ← η² weights computed from live DB
Sequential sampling ON (randomised clip order)     ← calculateVMAF sequential early-stop
Sequential stop … at N clips                      ← early-stop fired
Source CAMBI baseline: …  (encode-delta: …)        ← holdout self-comparison active
vmaf_min>vmaf_max rows excluded: N                 ← data integrity filter active
```

If instead you see `[SHADOW]`, the container is still running pre-June-2026 plugin code — restart the container after checking the plugin source is in `/custom-cont-init.d/vmaf-plugin-patches/`.

## High CPU on the host but GPU VMAF is working

Investigated June 2026: job reports show `vmafGpuVmafFallbackUsed=false` in all recent jobs, and server logs show zero GPU→CPU VMAF fallback events. The high CPU is from FFmpeg AV1 NVENC encoding, not VMAF:

- Quality-maximising NVENC settings (`-tune uhq -multipass fullres -spatial-aq 1 -temporal-aq 1 -rc-lookahead 48`) push significant CPU work even when the encode itself is on the GPU.
- HDR→SDR tonemapping runs on CPU.
- Software audio transcoding (EAC3→AAC) is CPU-bound.

To reduce CPU: lower `-rc-lookahead` (e.g. 24 instead of 48), or simplify the HDR flow if you're transcoding to SDR output.
