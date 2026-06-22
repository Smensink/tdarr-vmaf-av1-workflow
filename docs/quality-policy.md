# Quality policy

This workflow chooses AV1 CQ values by measuring candidate encodes, not by trusting a fixed preset.

The policy is inspired by Netflix's video-quality work:

- [VMAF](https://github.com/Netflix/vmaf) estimates perceptual quality by combining several objective features into a model trained against subjective human opinion scores.
- Netflix's [Toward a Practical Perceptual Video Quality Metric](https://netflixtechblog.com/toward-a-practical-perceptual-video-quality-metric-653f208b9652) explains why perceptual metrics are more useful than raw PSNR/SSIM-style scores for streaming decisions.
- [CAMBI](https://netflixtechblog.com/cambi-a-new-video-quality-metric-for-hdr-1ba3aefc0f44) focuses on banding, especially visible stair-step artifacts in smooth gradients.

The workflow uses those ideas in a Tdarr setting: encode a small set of samples, measure them, reject risky candidates, then transcode the full file only after a candidate has earned it.

## Why mean VMAF is not enough

A single average score can hide failure modes:

- a few dark or complex frames collapse while the average stays high
- samples miss the hardest scene
- output bitrate becomes implausibly low for the resolution
- gradients band even though VMAF remains acceptable
- HDR/live-action content behaves differently from animation or easy SDR content

So the workflow treats mean VMAF as one signal, not the whole decision.

## Candidate scoring

For each tested CQ candidate, the workflow records a quality/size profile:

- VMAF mean and harmonic mean
- low-frame/tail quality signals, including 1%-low frame VMAF where available
- sample output size
- projected full-file output size
- projected bitrate and bits-per-pixel
- CAMBI/banding score where the FFmpeg/libvmaf build supports it
- source metadata such as resolution tier, HDR/SDR, codec, and content class

## Acceptance guards

A candidate must clear several layers before it can be selected.

### 1. Perceptual quality target

The candidate must meet the configured VMAF target. VMAF is used because it better approximates perceived quality than simple pixel-error metrics.

### 2. Tail-frame quality

The candidate must not have an unacceptable 1%-low frame score. This catches cases where average quality is fine but hard frames are visibly worse.

### 3. Output-size plausibility

The projected output must not be suspiciously tiny for its resolution/source class. The workflow checks:

- output/source-size ratio
- bits per pixel
- output Mbps

This prevents a candidate from passing on VMAF while collapsing the bitrate too aggressively.

### 4. CAMBI/banding risk

Where available, CAMBI is used as a banding guard. Lower CAMBI is better. The workflow can reject or de-prioritize candidates with elevated banding risk, especially for HDR/live-action material.

### 5. Holdout validation

A sample is reserved outside the main sweep. After the best candidate is chosen, the workflow validates it against that holdout sample. If the holdout fails quality or banding checks, the workflow moves to a safer CQ or retries.

## Bracket and retry behavior

The workflow tries to test a useful range of CQ values:

- if all candidates are too high quality, it can test higher CQ values for more compression
- if all candidates are too low quality, it can test lower CQ values for more bits
- if selection guards reject every candidate, retry logic can expand or shift the range

This matters because CQ is content-dependent. The same CQ can be transparent for one source and unacceptable for another.

## Learning priors

After completed runs, `learnCQRange` updates learning data. Future jobs use that history to choose better starting brackets for similar files.

The shipped seed priors are only a warm start. Local results should become more important over time because they reflect your own sources, GPU, FFmpeg build, and quality preferences.

## Conservative by design

For difficult live-action, high-resolution, HDR, or grainy content, the workflow may choose a lower CQ than a simple fixed-preset workflow would. That means larger outputs, but fewer visibly bad encodes.

For animation or easier SDR content, the learning model and quality guards can allow more aggressive compression when measured history supports it.

## Why the provided FFmpeg/libvmaf runtime is recommended

The policy depends on measurements. If FFmpeg lacks the expected VMAF/libvmaf/CAMBI/NVENC features, the workflow cannot make the same decisions. Use the provided FFmpeg/libvmaf image/build path unless you are deliberately porting the workflow to another validated runtime.
