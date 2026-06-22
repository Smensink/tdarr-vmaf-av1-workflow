# FFmpeg/libvmaf runtime

The workflow should be run with the provided FFmpeg/libvmaf runtime image or build recipe.

## Why this matters

The plugins are not generic FFmpeg wrappers. They expect specific features to exist:

| Capability | Why it is needed |
|---|---|
| `av1_nvenc` | final AV1 transcode and sample encodes |
| `h264_nvenc` / `hevc_nvenc` | intermediate compatibility and test paths |
| NVIDIA decode/CUVID/NVDEC support | efficient decode paths for samples and scoring |
| `libvmaf` | perceptual quality scoring |
| `libvmaf_cuda` where available | GPU-accelerated VMAF paths |
| libvmaf model support | VMAF model selection without missing model-file errors |
| libvmaf `feature=` support | CAMBI-style banding feature integration |
| `tdarr-ffmpeg` / `tdarr-ffprobe` wrappers | Tdarr plugin compatibility |

A normal Tdarr image may not have this combination. If one feature is missing, the failure often appears much later as a confusing FFmpeg or Tdarr job-report error.

## Recommended path

Use one of these, in order:

1. A project-provided prebuilt runtime image for your platform, if available.
2. A locally built image/runtime using the scripts in `docker/`.
3. A custom FFmpeg/libvmaf runtime you have validated yourself with `tools/validate-install.sh`.

Avoid running the flow against an arbitrary system FFmpeg just because Tdarr can see it.

## Validation

Inside the running Tdarr container, the important checks are:

```bash
tdarr-ffmpeg -hide_banner -filters 2>/dev/null | grep -iE 'libvmaf|vmaf'
tdarr-ffmpeg -hide_banner -encoders 2>/dev/null | grep -iE 'av1_nvenc|hevc_nvenc|h264_nvenc'
tdarr-ffmpeg -hide_banner -h filter=libvmaf 2>&1 | grep -i feature
```

Or run the bundled validator from the repository root:

```bash
bash tools/validate-install.sh tdarr
```

## About CAMBI

Some FFmpeg/libvmaf builds do not list CAMBI explicitly in `ffmpeg -h filter=libvmaf`, even though `feature=name=cambi` can still be routed through libvmaf's generic feature interface. The reliable proof is a real VMAF JSON/job report that includes CAMBI values.

## Binary redistribution

NVIDIA/FFmpeg builds can involve GPL and nonfree configure flags. A local image can be useful operationally while still being unsuitable for public binary redistribution. Check the actual FFmpeg configure line before publishing an image.
