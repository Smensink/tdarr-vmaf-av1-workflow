# Quality policy

This is the policy represented by the tracked post-audit 36-node/58-edge
graph. The final immutable r3 release deployed that graph on 2026-07-28 and
passed the checks recorded in the
[rollout evidence](r3-rollout-evidence-2026-07-28.md). Deployment is not proof
that every threshold or adaptive policy has been prospectively validated, and
the controlled live terminal canary remains withheld.

## Tracked inputs

| Stage | Setting | Tracked value |
|---|---|---:|
| Eligibility | Minimum file age | 7 days |
| Sampling | Initial segments | 4 |
| Sampling | Maximum segments | 16 |
| Search | Target minimum VMAF | 95 |
| Search | Target size reduction | 30% |
| Search | CQ range width / step | 6 / 2 |
| Search | Preset | NVENC `p7` |
| Search | Exploration rate | 0.02 |
| Scoring | Parallel GPU VMAF | 4 |
| Scoring | Pre-FGS CAMBI threads | 8 |
| Scoring | CPU-v1 tasks per job | 1 |
| Scoring | Threads per CPU-v1 score | 2 |
| Selection | Minimum VMAF | 95 |
| Selection | Minimum frame VMAF | 88 |
| Delivered policy | Minimum actual reduction | 20% |
| Delivered policy | Maximum final output/source ratio | 80% |
| Projected-size research | Legacy shadow boundary / emergency cutoff | 90% / 110% |
| In-progress guard | Community live size threshold | 75% |
| Grain-stage guard | Local pre-delivery maximum ratio | 101% |

## Delivered-size contract

The current policy version accepts one exact, complete 30/20/80 contract.
Thirty percent is the search target. Actual delivery requires at least 20%
reduction, expressed equivalently as a final output/source ratio no greater
than 80%; equality at 80% is accepted. The base-transcode byte check and the
final delivery validator both use that contract. A rejected generation cannot
reach replacement, and failure to retire its authenticated checkpoint still
preserves the original.

The other percentages above are not alternate delivered-success definitions:

- 90% is the historical projected-ratio research boundary. The sample estimate
  can place a job into a bounded, reservation-backed forced-full label cohort;
  it does not prove final size or override the 80% delivered cap. Missing,
  corrupt, or exhausted reservation authority fails closed. The 110%
  emergency projection cutoff is a separate risk guard.
- 75% is the Community in-progress size monitor after a 120-second delay.
  Its defensive/error branch preserves the original. It is not the terminal
  size label.
- 101% is a grain-stage intermediate guard. The candidate must still pass the
  authoritative 80% exact-byte validator immediately before replacement.

## Measurements and constraints

The selector considers more than mean VMAF:

- average/harmonic quality;
- low-frame/tail quality;
- CAMBI and source-relative banding behavior;
- bitrate/BPP and projected output ratio;
- holdout measurements;
- prior failed CQs and same-file history;
- source/reference contract compatibility;
- temporal filter and denoise identities.

This layered feasibility design is sensible: one aggregate score should not
override a severe tail, banding, or size failure. The implementation still
needs controlled outcome labels before any learned or projected-size policy is
described as validated.

## Search and learning

The predictor pools compatible historical curves and uses metadata similarity
to propose a starting range. Same-file history can make a re-encode converge
faster. Exploration, projected-size, and shadow models collect evidence
without becoming delivered-success authority.

The checked-in policy keeps paired-CQ in full-measurement shadow mode:
`pairedCqShadow=true`, `pairedCqShadowForceFull=true`, and
`vmafPairedCqActingEnabled=false`. Paired-CQ cannot control selection without a
separate reviewed promotion that also removes the force-full interlock.

The runtime database is the learning authority. The incompatible plural
`learnCQRanges` plugin is a retired tombstone and writes no state. The tracked
singular `learnCQRange` plugin records pre-transcode selection/retry facts and
leaves terminal outcome unknown. The monitor may record keep-original or
technical failure, and it durably records a usable encode as
`candidate_ready`; only `finalizeDeliveredOutcome` can commit delivered
success. Technical failure stores `met_vmaf_target=NULL`, because an
incomplete delivery is not evidence that measured quality missed its target.

Schema v17 enforces the delivery sequence
`candidate_ready -> replacement_committing -> delivery_committing ->
delivered`, exact policy provenance, and immutable delivered rows.

Shared CSV and EMA writers are retired. Optional compatibility telemetry is
disabled by default and uses exclusive per-job files, so it cannot race a
shared append or become learning authority.

## CPU VMAF-v1 authority

The checked-in graph sets:

- qualification enabled: false;
- production enabled: true;
- provisional HDR production allowed: false;
- one CPU-v1 task per job and two threads per score.

The wrapper additionally defaults to a one-slot host-wide semaphore.

The production boolean still promotes the CPU scorer for eligible SDR without
requiring an immutable calibration artifact or scorer digest at runtime. The
resolver and scorer authenticate the exact coded raster, SAR, DAR, no-scale
decision, model family, transport, and metric aliases before authority. The
only accepted VMAF metric name is the model-qualified alias exactly equal to
the pinned model version in pooled and every frame metric; bare,
wrong-qualified, duplicate, and suffixed aliases fail closed. Native-Linux
FIFO publication/parsing must pass deployment qualification. Unsupported or
inconsistent geometry retains the established GPU-v0 contract. HDR also
retains GPU-v0 while the independent provisional-HDR authorization is false;
an explicit true value is reserved for a separately reviewed canary.
Before treating HDR decisions as calibrated authority:

1. bind wrapper, libvmaf, model, and parser hashes to a calibration result;
2. compare CPU/GPU decisions on a controlled labeled cohort;
3. keep HDR canary-only until its transform/colour contract is validated.

## Grain policy

The tracked graph enables grain analysis and synthesis for SDR and PQ sources
under `/media`. It preserves the base encode if analysis is skipped or
synthesis is not applicable. The 101% synthesis input is a local intermediate
guard, not delivery authority; the final candidate still must satisfy the 80%
source-relative cap.

Production grain acceptance must include:

- authenticated source-scoped analysis artifact;
- exact denoise/temporal-filter/metric contract;
- source and output duration/stream validation;
- size policy;
- mandatory full-title decode validation after bitstream rewriting and before
  promotion, with strict decode errors and timeouts preserving the original.

## HDR policy

Dolby Vision handling is profile-aware. Ambiguous 10/12-bit BT.2020 sources
with missing, unknown, unspecified, or reserved transfer route to output 3 with
`keep_original_ambiguous_color_transfer`; they are not retagged PQ. Explicit
BT.2020-10/12 wide-gamut SDR remains SDR, while PQ/HLG requires affirmative
transfer or compatible dynamic-HDR evidence.

## Stronger-denoise trials

The stronger KNN settings are sample-only experiments for selected
original-preserved cases. They require exact source/provenance binding,
isolated scratch, and manual visual review. A result does not promote a
denoiser, alter the production 0.08 setting, authorize a full-title encode, or
change the delivered-size policy. Already replaced AV1 outputs are not
second-generation trial sources.

The two isolated 2026-07-28 screens produced no valid comparison output,
metrics, or contact sheets. They support no denoise benefit, harm, visual,
size-reduction, or production-setting conclusion; see
[live job forensics](live-forensics-2026-07-27.md).

## Validation status

Verified in this repository:

- static JavaScript syntax and undeclared-identifier checks;
- graph shape, plugin inventory, and deployment-source parity;
- database integrity and aggregate-export structure;
- explicit contracts encoded in the included tests.

Not established by those checks:

- perceptual superiority on an independent labeled cohort;
- prospective validity of the 90% projected-size research boundary, its
  emergency cutoff, or the bounded forced-full cohort;
- sufficiency of the 75% in-progress guard across all content;
- CPU-v1 HDR parity;
- global throughput under multiple concurrent jobs;
- production runtime and latency of the newly mandatory post-grain full-title
  decode across a representative feature-length cohort.
