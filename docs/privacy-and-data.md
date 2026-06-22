# Privacy and data handling

Never publish raw Tdarr CSVs, job reports, databases, logs, or media-derived filenames. Use `tools/sanitize-learning-data.py` to create aggregate-only priors.

The sanitizer groups rows into broad buckets and emits quantiles/counts only. It drops exact timestamps, file paths, filenames, release groups, titles, API identifiers, and raw rows.
