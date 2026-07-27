# Public learning snapshot

`vmaf-learning-public.sqlite3` is an aggregate-only database generated from a
consistent read-only SQLite online backup. It is not a redacted copy of raw
pages.

Schema:

- `snapshot_metadata` — export schema, timestamp, source row counts, and
  minimum bucket size;
- `cq_priors` — broad resolution/codec/source/content cohorts with rounded CQ,
  VMAF, CAMBI, source-BPP, target-VMAF, and output-ratio statistics;
- `sweep_priors` — the same broad cohorts plus half-step CQ and rounded
  VMAF/SSIM/CAMBI statistics.

Every published cohort contains at least 25 accepted observations. The
database contains no raw job or sweep rows, job IDs, paths, filenames, titles,
release groups, provider identifiers, credentials, or exact event timestamps.

Regenerate with `tools/export-live-state.py`; review
`docs/privacy-and-data.md` before publication.
