# Quality policy

The workflow is designed to avoid the common failure mode where mean VMAF looks good while hard scenes, gradients, or dark areas are visibly over-compressed.

It does **not** rely on mean VMAF alone.

## Signals used during selection

The selection stage considers:

- mean/harmonic VMAF
- 1%-low frame VMAF floor by resolution/content tier
- projected output bitrate, BPP, and source-size ratio
- CAMBI banding score where available
- holdout validation on a sample excluded from the CQ sweep
- learned CQ priors and adaptive bracket width

## Why these guards exist

A high mean VMAF can hide problems when the sampled scenes are easy or when only a few hard frames collapse. The workflow adds several independent checks:

- **1%-low VMAF** catches bad tail frames.
- **BPP/Mbps/ratio guards** catch implausibly tiny outputs.
- **CAMBI** catches banding/gradient damage that VMAF may not penalize enough.
- **Holdout validation** tests a reserved sample that was not used when choosing the CQ.
- **Learning priors** make future CQ ranges faster and less likely to miss the target.

## Conservative by design

For difficult live-action, high-resolution, HDR, or grainy content, the workflow may choose a lower CQ than a simple fixed-preset workflow would. That means larger outputs, but fewer visibly bad encodes.

For animation or easier SDR content, the learning model and quality guards can allow more aggressive compression when historical results support it.

## Seed priors are only a starting point

The aggregate seed data is meant to reduce cold-start pain. It is not a universal truth. Your own library, GPU, FFmpeg build, source mix, and quality preferences should take over as local learning data accumulates.

If output quality is too conservative or too aggressive, adjust the Tdarr plugin inputs and quality thresholds in your own flow rather than editing the public seed files directly.
