# Adaptive Tdarr workflow vs FileFlows

This project and FileFlows solve related problems, but they sit at different levels and the adaptive quality approaches differ in detail.

## The two FileFlows adaptive quality pieces

### ab-av1 (DockerMod)

FileFlows can install **ab-av1** via a DockerMod (`AutoCRF.sh`). This is the most directly comparable piece to this project.

ab-av1 is a Rust CLI tool (by alexheretic) that:

1. Takes an input file and a `--min-vmaf` target (e.g. `--min-vmaf 95`).
2. Runs an **interpolated binary search** over CRF values (`sample-encode` at each step) to find the lowest CRF that delivers the target VMAF.
3. Also enforces `--max-encoded-percent` — a hard ceiling on output size as a percentage of input size. If the binary search finds a CRF that hits VMAF 95 but the output would be larger than the max-encoded threshold, it rejects that CRF and searches lower (more compressed).
4. Uses **SVT-AV1** as the primary encoder (libsvtav1 in FFmpeg), not NVENC.
5. Runs on a **single sample** (not multiple samples) — it extracts one short clip and searches over that.
6. Supports XPSNR as an alternative to VMAF.
7. Outputs JSON with the best CRF, mean VMAF, predicted full-encode size and time.

```text
ab-av1 crf-search -i input.mkv --preset 7 --min-vmaf 95 --max-encoded-percent 80
# → finds best CRF, returns JSON: { crf, vmaf, predicted_size, predicted_time }
```

ab-av1 in FileFlows is called as a `Flow.Execute` step — FileFlows runs the ab-av1 CLI and parses its JSON output. The VMAF measurement loop is inside the Rust binary, not in FileFlows itself.

### FFmpeg Builder + VideoEncode

FileFlows' stock video encoding uses a **visual node graph** (FFmpeg Builder) or a single `VideoEncode` node. Codec and CRF (or bitrate) are set as node parameters. There is no automatic adjustment — the user configures CRF 23 or whatever preset they want and it runs that.

The `FfmpegBuilderVideoCodec` node lets users set codec + parameters like `hevc_nvenc -preset hq -crf 23`. The `CheckVideoCodec` method auto-selects the best available encoder for the hardware (NVENC > QSV > AMF > VAAPI > software), but the quality parameter itself is static.

## Concrete technical differences

| | **ab-av1 (FileFlows)** | **This project** |
|---|---|---|
| Quality target | `--min-vmaf` mean VMAF | Multiple: mean VMAF **+** 1%-low VMAF **+** CAMBI banding **+** BPP/Mbps/ratio |
| Multi-metric guards | No. Single `min-vmaf` mean only. | Yes — see below |
| Size constraint | `--max-encoded-percent` | BPP + Mbps + ratio % guard, applied per-resolution tier |
| Encoder | SVT-AV1 (libsvtav1) | AV1 NVENC (av1_nvenc) |
| Search strategy | Interpolated binary search on CRF | Candidate CQ sweep (4–8 points based on confidence), then fractional CQ refinement |
| Sample count | 1 sample | 3–12 samples, count chosen by learned mean-min model |
| Holdout validation | No | Yes — reserves 1 unseen sample, validates chosen CQ on it before committing |
| Banding metric (CAMBI) | No | Yes — mean, P95, max; tiered limits per HDR/SDR/animation |
| Tail-quality guard | No — mean only | Yes — 1%-low frame VMAF per resolution/HDR tier |
| Cross-file learning | No | Yes — CSV + EMA priors per resolution/codec/release-group |
| Adaptive bracket width | No | Yes — 4–8 CQ steps based on isotonic confidence |
| CQ retry/loop | No | Yes — if all candidates fail guards, retries lower CQ ranges |
| HDR metadata | Not handled specially | Tonemap in VMAF graph, HDR passthrough/reinjection on final transcode |
| Custom FFmpeg | Required: libsvtav1 + libvmaf | Required: libvmaf + CAMBI + NVENC |
| Integration model | CLI tool invoked via `Flow.Execute` | Tdarr Local Flow plugins, fully native |

## Why multiple quality dimensions matter

ab-av1 is elegant and works well for its use case. The limitation is that **mean VMAF alone can hide problems**:

- A file can score VMAF 95 mean but have banding on dark gradients (CAMBI would catch this).
- A file can score VMAF 93 mean but have individual frames at VMAF 70 — the tail of the distribution is the perceptually relevant part (1%-low frame VMAF guard catches this).
- A file can produce an output at 12% of source size with VMAF 94 — mean VMAF looks fine but the bitrate collapse predicts re-encode artefacts on difficult scenes (BPP/ratio guard catches this).

This is the core reason the Tdarr project uses a multi-dimensional selection policy rather than a single `min-vmaf` threshold. Netflix's own CAMBI paper explicitly frames banding as orthogonal to VMAF — a file can ace VMAF and fail CAMBI.

## Could ab-av1 be used inside FileFlows as-is?

Yes. If you have an FFmpeg with SVT-AV1 and libvmaf, you can call ab-av1 from a FileFlows flow script. The FileFlows DockerMod installs it automatically. It would give you a VMAF-guided CRF search with size constraint — more capable than a static CRF, less capable than this project's multi-guard policy.

The main limitation is that ab-av1 is designed around SVT-AV1. If you want NVENC (faster on NVIDIA hardware), you'd need to adapt or replace the ab-av1 logic.

## Could FileFlows replicate this project's full policy?

FileFlows scripting (`Flow.Execute`, `Flow.GetParameter`, `Flow.SetParameter`) is powerful enough to replicate the adaptive loop. A FileFlows implementation could:

1. Extract multiple samples via FFmpeg Builder.
2. Loop over CQ values, calling `Flow.Execute` to run NVENC encodes.
3. Call `Flow.Execute` to run `ffmpeg ... libvmaf` and parse the JSON.
4. Evaluate CAMBI, 1%-low, BPP, ratio against tiered policy.
5. Retry lower CQ on failure.
6. Validate on holdout.
7. Persist CSV/JSON learning state across runs.

The scripting surface is there. The novelty is in the policy logic and the learning state — not in any FileFlows primitive that doesn't exist.

## Practical summary

| | ab-av1 | This project |
|---|---|---|
| VMAF-guided | ✅ CRF search via binary search | ✅ CQ sweep + selection |
| CAMBI banding guard | ❌ | ✅ |
| 1%-low / tail quality | ❌ | ✅ |
| Size guard | `--max-encoded-percent` | BPP + Mbps + ratio per tier |
| Holdout sample | ❌ | ✅ |
| Learning | ❌ | ✅ |
| HDR handling | Not special | Tonemap + passthrough |
| Hardware encoder | SVT-AV1 | AV1 NVENC |
| Deployment | FileFlows DockerMod | Tdarr Local Flow + custom FFmpeg |
| Operates on | Single sample | Multiple samples + holdout |

ab-av1 is the closest thing in the FileFlows ecosystem to what this project does — and the comparison is useful because it clarifies exactly where this project's multi-guard policy goes further than a single VMAF mean + size cap.
