# Privacy policy for repository exports

This public repository may contain only credential-redacted flow definitions
and aggregate, de-identified learning priors.

Allowed learning dimensions are broad resolution, codec, source-type, and
animation/live-action buckets. Allowed values are cohort counts and rounded
CQ, VMAF, SSIM, CAMBI, BPP, target-VMAF, and output-ratio distribution
statistics. Every published cohort must contain at least 25 observations.

Disallowed data includes raw rows or database pages, paths, filenames, titles,
release groups, exact event timestamps, media/provider identifiers, API
credentials, job reports, logs, mounts, private backups, and Tdarr application
databases/WAL files.

Exports must be created from a consistent SQLite online backup into a new
database with an explicit schema. Filesystem-copying an active database and
then deleting columns is not an acceptable sanitizer.

See [Privacy and data handling](docs/privacy-and-data.md).
