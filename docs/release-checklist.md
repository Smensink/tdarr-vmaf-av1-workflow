# Release checklist

Use this before pushing changes or publishing a release.

## Privacy checks

```bash
python3 tools/audit-for-secrets.py .
```

Confirm the repo does not include:

- raw Tdarr CSV rows
- logs or job reports
- databases or backups
- media paths or filenames
- API keys, tokens, cookies, or `.env` files
- built FFmpeg/CUDA/libvmaf binaries

## Syntax and data checks

```bash
for f in plugins/vmaf/*/1.0.0/index.js; do node --check "$f" || exit 1; done
python3 -m json.tool flow/tdarr-flow-vmaf-av1.json >/dev/null
python3 -m json.tool data/seed/vmaf_cq_priors.seed.json >/dev/null
python3 -m json.tool data/seed/ema_cq_state.seed.json >/dev/null
git diff --check
```

## Runtime validation

With a local Tdarr container running:

```bash
bash tools/validate-install.sh tdarr
```

## Optional external secret scanners

If installed, also run:

```bash
gitleaks detect --source . --no-git --redact
trufflehog filesystem . --only-verified
```

## Binary/image publishing

Before publishing a prebuilt image, inspect FFmpeg's configure flags:

```bash
tdarr-ffmpeg -version | sed -n '1,5p'
```

If it includes `--enable-nonfree`, treat the image as local-use only unless you have done a separate licensing review.

## Release notes

For each release, mention:

- plugin changes
- FFmpeg/libvmaf expectations
- schema changes to seed files or learning CSVs
- migration/import notes for existing Tdarr users
- any known caveats, especially `checkFileAge` or metadata lookup behavior
