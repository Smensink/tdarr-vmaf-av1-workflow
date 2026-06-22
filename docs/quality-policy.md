# Quality policy

The workflow does not rely on mean VMAF alone. It also considers:

- 1%-low frame VMAF floor by resolution/content tier
- projected output bitrate/BPP/source-size ratio
- CAMBI banding score
- holdout validation on a sample excluded from the sweep
- learned CQ priors with adaptive bracket width

This is intentionally conservative for hard live-action/HDR material where a high mean VMAF can hide poor gradients or collapsed dark scenes.
