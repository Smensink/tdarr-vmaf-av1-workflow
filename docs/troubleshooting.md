# Troubleshooting

## Validate plugin syntax

```bash
for f in plugins/vmaf/*/1.0.0/index.js; do node --check "$f" || exit 1; done
```

## Validate a running Tdarr container

```bash
bash tools/validate-install.sh tdarr
```

Expected capabilities:

- `tdarr-ffmpeg` resolves to the custom build
- `libvmaf`/`libvmaf_cuda` filter is registered as appropriate for your build
- CAMBI support is available either as an explicit help entry or through libvmaf `feature=` support; confirm actual CAMBI values in job JSON/logs for your FFmpeg/libvmaf build
- `av1_nvenc`, `hevc_nvenc`, and `h264_nvenc` are available
- VMAF plugin files exist in the Tdarr local-flow plugin tree

## Licensing / binary image warning

If your FFmpeg configure output includes `--enable-nonfree`, do not redistribute the built binary/image unless you have independently confirmed redistribution is allowed.
