# Adaptive Tdarr workflow vs FileFlows

This project and FileFlows solve related problems, but they sit at different levels.

- **FileFlows** is a general file-processing flow engine. Its video plugin includes an [FFmpeg Builder](https://fileflows.com/docs/plugins/video-nodes/ffmpeg-builder/) that builds an FFmpeg command from flow nodes, parses streams, and copies unmodified streams by default. It also supports JavaScript [flow scripts](https://fileflows.com/docs/scripting/javascript/flow-scripts/) and a `Flow` runtime object with helpers such as `Execute`, `GetParameter`, `SetParameter`, `GetProperty`, and `SetProperty`.
- **This repository** is a specialized Tdarr workflow that implements an adaptive AV1 quality-control loop: sample the file, encode candidate CQs, measure those candidates with VMAF/CAMBI, reject unsafe candidates, retry lower-CQ ranges when needed, transcode the full file only after passing quality gates, and learn from the result.

So the difference is not "Tdarr can transcode and FileFlows cannot". FileFlows can absolutely build complex FFmpeg flows. The difference is that this project ships a concrete, opinionated **quality-decision system** rather than a generic graph of media-processing building blocks.

## What FileFlows gives you out of the box

Based on the public FileFlows docs:

| FileFlows capability | Why it matters |
|---|---|
| Flow graph execution | Good visual model for branching media-processing jobs. |
| FFmpeg Builder | Builds complex FFmpeg commands from smaller nodes and preserves streams unless told to delete/convert them. |
| Hardware decoding controls | Can test/use hardware decode depending on mode and bit-depth compatibility. |
| `FfmpegBuilderModel` | Exposes video/audio/subtitle stream objects, filters, encoding parameters, metadata parameters, extension, inputs, and custom executor parameters. |
| JavaScript flow scripts | Lets advanced users create custom decision nodes. |
| `Flow.Execute` | Lets a script run external commands and capture exit code/stdout/stderr. |
| `Flow.GetParameter` / `Flow.SetParameter` | Lets plugins/scripts share complex objects during one flow execution. |
| `Flow.GetProperty` / `Flow.SetProperty` | Lets scripts store properties on a specific file's database record. |
| Standard variables | Exposes working/original file paths, file sizes, dates, flow execution metadata, and library-file metadata. |

Those primitives are enough to build a VMAF-based workflow in FileFlows, especially with custom scripts. But the adaptive behavior would need to be authored and maintained as custom logic.

## What this project adds beyond a normal media flow

A usual Tdarr or FileFlows transcode flow often looks like this:

```text
inspect file -> choose codec/preset/bitrate/CQ -> run FFmpeg -> replace or keep original
```

This workflow instead does this:

```text
inspect file
  -> decide content class and risk tier
  -> extract representative samples plus holdout
  -> choose initial CQ search range from priors/history
  -> encode multiple candidate CQs on samples
  -> score every candidate with VMAF and CAMBI
  -> reject candidates that pass mean VMAF but fail tail quality, banding, or bitrate floors
  -> retry lower-CQ ranges if every candidate is unsafe
  -> validate the selected CQ against a holdout sample
  -> run the final AV1 NVENC transcode
  -> export measurements
  -> update learned CQ priors for future files
```

The important part is the feedback loop. It does not assume that `CQ 32` or `VMAF mean >= 95` is always safe. It measures, checks several failure modes, and adapts.

## Adaptive features compared

| Area | This project | FileFlows equivalent |
|---|---|---|
| Candidate CQ sweep | Built in via `testEncodingParameters` and `calculateVMAF`. | Would need custom scripts/nodes that run FFmpeg sample encodes repeatedly. |
| VMAF scoring | Built in via `calculateVMAF`, using the provided FFmpeg/libvmaf runtime. | Possible with `Flow.Execute` and a suitable FFmpeg/libvmaf binary, but not a turnkey stock FFmpeg Builder decision loop. |
| CAMBI banding metric | Built into scoring and selection as a hard/soft guard. | Possible if the FileFlows runtime FFmpeg exposes libvmaf `feature=name=cambi`; custom parsing required. |
| Mean VMAF | Used, but not trusted alone. | Easy to compute if custom VMAF scripting exists. |
| Tail quality / 1%-low frame VMAF | Explicit guard against a few bad scenes hidden by a good average. | Would need custom parsing of per-frame VMAF JSON and policy code. |
| Output-size/BPP/Mbps guard | Built in; prevents misleading high-VMAF candidates that collapse bitrate too far. | Possible with custom script and FileFlows file-size/stream variables. |
| CQ range retry | Built in; if all tested candidates fail policy, the flow expands/retries safer lower-CQ ranges. | Would need explicit graph loops or script-managed retry state. |
| Holdout validation | Built in; reserves an unseen sample to verify the chosen CQ before full transcode. | Possible, but would require custom sample extraction and validation script. |
| Learning/warm start | Built in via `learnCQRange`, CSV/EMA state, and optional seed priors. | File-specific properties exist, but global cross-file learning would need external JSON/CSV/database logic. |
| Runtime expectations | Repo documents/provides the FFmpeg/libvmaf runtime expected by the plugins. | FileFlows can run FFmpeg, but a user must ensure the deployed binary has matching VMAF/CAMBI/NVENC capabilities. |
| Operational fit | Fits Tdarr's library/queue/transcode model and local flow plugins. | FileFlows is broader and more flexible for arbitrary file workflows. |

## Quality-decision philosophy

This project is closer to a small per-file encoder experiment than a static transcode preset.

The quality model follows ideas from Netflix's VMAF/CAMBI work:

- [VMAF](https://github.com/Netflix/vmaf) estimates perceptual quality by comparing a distorted encode to a reference source.
- [CAMBI](https://github.com/Netflix/vmaf/blob/master/resource/doc/cambi.md) targets banding, which can be visible even when VMAF is high.
- Mean scores are useful, but averages hide tails. A file can have an excellent mean and still have bad dark scenes, gradients, or high-motion sections.

That is why the selection plugin checks several dimensions before accepting a candidate:

1. **Mean/harmonic VMAF** — overall perceptual quality.
2. **1%-low frame VMAF** — avoids letting a few ugly scenes hide inside a good average.
3. **CAMBI mean/P95/max** — catches banding risk.
4. **Projected bitrate, BPP, and source-size ratio** — catches over-compressed outputs that metrics alone may under-penalize.
5. **Holdout sample** — checks the selected CQ on a sample not used in the original candidate sweep.
6. **Learned priors** — narrows future searches when prior data is confident, while widening them when uncertainty is high.

## Could this be ported to FileFlows?

Yes, but it would be a rewrite rather than a simple import.

A credible FileFlows port would likely need these custom pieces:

1. A sample-extraction script using `Flow.Execute` and FileFlows path/stream variables.
2. A candidate-encode script that generates multiple AV1 NVENC sample outputs.
3. A VMAF/CAMBI scoring script that invokes an FFmpeg/libvmaf binary and parses JSON output.
4. A selection script that implements the same mean VMAF, 1%-low, CAMBI, BPP, Mbps, ratio, and holdout rules.
5. A retry/loop mechanism for lower-CQ sweeps when all candidates are unsafe.
6. A persistence layer for global learning data. `Flow.SetProperty` is useful for per-file state, but cross-library CQ priors probably belong in an external JSON/CSV/database file.
7. A final FFmpeg Builder or direct FFmpeg execution step that uses the selected parameters.

The biggest porting question is state. FileFlows exposes file-record properties and flow parameters, which are good for per-file decisions. This workflow's adaptive behavior depends on cross-file history, so a FileFlows port needs an explicit global learner store.

## When FileFlows might be the better fit

FileFlows may be a better base if you want:

- one tool for many file types, not only media-library transcodes;
- a visual FFmpeg command builder with broad stream-copy/transcode handling;
- scriptable custom logic without Tdarr's local plugin packaging model;
- workflows that move, rename, notify, or process non-video files alongside video files.

## When this Tdarr workflow is the better fit

This workflow is the better fit if the goal is specifically:

- AV1 NVENC transcoding for media libraries;
- VMAF/CAMBI-guided CQ selection;
- adaptive retries rather than static CQ/bitrate choices;
- learned priors that reduce future sample sweeps;
- documented FFmpeg/libvmaf runtime compatibility;
- drop-in Tdarr local-flow behavior.

## Bottom line

FileFlows provides excellent general-purpose media-flow primitives. This project provides a specialized adaptive quality optimizer.

A FileFlows implementation could be built, and the FileFlows scripting model is flexible enough to host it. But the novel part of this repository is not the existence of a flow graph or FFmpeg command builder; it is the **adaptive measurement-and-selection policy** layered around FFmpeg: candidate sweeps, VMAF/CAMBI scoring, tail-risk guards, output-size guards, holdout validation, retry, and learning.
