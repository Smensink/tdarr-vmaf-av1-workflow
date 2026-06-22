# Privacy and data handling

This repository is structured so the public project contains workflow logic and aggregate priors, not a personal media-library history.

## Public data policy

Only publish aggregate, de-identified learning priors.

Allowed public fields:

- broad resolution tier, e.g. `4k`, `1080p`, `720p`
- codec bucket, e.g. `hevc`, `h264`, `av1`, `other`
- broad source-type bucket, e.g. `web`, `bluray/remux`, `unknown`
- content class, e.g. `animation` or `live`
- sample counts
- rounded quantiles/statistics for CQ, VMAF, SSIM, CAMBI, BPP, and output ratio

Do **not** publish:

- raw rows from Tdarr CSVs
- file paths
- filenames, show/movie titles, episode names, or release groups
- exact timestamps
- Plex/TMDB/TVDB identifiers
- API keys or tokens
- job reports
- Tdarr logs
- Tdarr databases or backups
- media-library mount paths

## Sanitizer behavior

`tools/sanitize-learning-data.py` is allowlist-based. Columns not explicitly used by the aggregation code are ignored.

Example:

```bash
python3 tools/sanitize-learning-data.py \
  --learning-csv /private/path/vmaf_cq_learning.csv \
  --ema-json /private/path/ema_cq_state.json \
  --out-dir data/seed
```

The output is suitable for review, but still run the audit before publishing:

```bash
python3 tools/audit-for-secrets.py .
```

## Why raw learning data is unsafe

Even if filenames are removed, row-level transcoding data can fingerprint a media library through combinations of duration, resolution, bitrate, codec, year, genre, source type, release group, and timestamp. Aggregation reduces that risk and is sufficient for warm-start CQ priors.

## Local private data

If you want to keep raw CSVs near the repo while experimenting, put them under:

```text
data/private/
```

That directory is ignored by git.
