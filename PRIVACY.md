# Privacy policy for exported learning data

This project should only publish aggregate, de-identified learning priors.

Allowed public fields include broad resolution tier, codec bucket, source-type bucket, animation/live-action class, sample counts, and rounded distribution statistics for CQ/VMAF/SSIM/CAMBI/BPP/output ratio.

Disallowed public fields include raw rows, file paths, filenames, titles, release groups, exact timestamps, Plex/TMDB/TVDB identifiers, API tokens, job reports, media-library mounts, and Tdarr databases.

The sanitizer is allowlist-based: columns not explicitly used by the aggregation code are ignored.
