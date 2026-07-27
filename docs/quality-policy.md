# Quality policy

This is the policy represented by the 2026-07-27 active-flow snapshot. It
describes implemented decisions; it does not claim that every threshold or
adaptive policy has been prospectively validated.

## Active inputs

| Stage | Setting | Active value |
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
| Scoring | CPU-v1 scorers per job | 2 |
| Scoring | Threads per CPU-v1 scorer | 8, via misnamed `maxParallelVmaf` |
| Selection | Minimum VMAF | 95 |
| Selection | Minimum frame VMAF | 88 |
| Selection | Minimum requested reduction | 20% |
| Live size check | Maximum output/source ratio | 75% |
| Grain synthesis | Maximum output/source ratio | 101% |

The 75% live size gate occurs after search/export and waits 120 seconds before
checking. Its second graph edge is currently dead because the Community plugin
exposes only one output.

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
faster. Exploration and shadow models collect evidence without necessarily
controlling the result.

The runtime database is the appropriate source for learning. The plural
`learnCQRanges` plugin is retired and incompatible with the current selector.
The active singular `learnCQRange` plugin currently writes a CSV field named
`transcode_succeeded` before the title transcode has occurred. Treat that field
as a selection-eligible observation until the schema is corrected; use
terminal status written by the monitor for outcome learning.

CSV and EMA sidecars are not concurrency-safe. SQLite transactions should own
the learning state, with CSV generated later as reporting output.

## CPU VMAF-v1 authority

The active graph sets:

- qualification enabled: false;
- production enabled: true;
- provisional HDR production allowed: true.

Those booleans currently promote the CPU scorer without requiring an immutable
calibration artifact or scorer digest at runtime. The helper itself labels SDR
runtime qualification incomplete and HDR provisional. Before retaining acting
authority:

1. preflight exact coded/display geometry and SAR/DAR;
2. route unsupported content to the established GPU metric path;
3. bind wrapper, libvmaf, model, and parser hashes to a calibration result;
4. compare CPU/GPU decisions on a controlled labeled cohort;
5. keep HDR canary-only until its transform/colour contract is validated.

## Grain policy

Grain analysis and synthesis are active for SDR and PQ sources under `/media`.
The flow preserves the base encode if analysis is skipped or synthesis is not
applicable. A synthesized title may be up to 101% of the pre-grain source ratio
according to the active plugin input.

Production grain acceptance must include:

- authenticated source-scoped analysis artifact;
- exact denoise/temporal-filter/metric contract;
- source and output duration/stream validation;
- size policy;
- bounded full-title decode validation after bitstream rewriting.

The last item is missing from the active direct synthesis path.

## HDR policy

Dolby Vision handling is profile-aware. HDR classification must not infer PQ
solely from 10/12-bit BT.2020 primaries with an unknown transfer function.
Ambiguous sources should preserve their original signalling or fail closed for
manual review. Retagging to BT.2020/PQ/BT2020NC is irreversible metadata
mutation and needs affirmative evidence.

## Validation status

Verified in this repository:

- static JavaScript syntax and undeclared-identifier checks;
- graph shape, plugin inventory, and deployment-source parity;
- database integrity and aggregate-export structure;
- explicit contracts encoded in the included tests.

Not established by those checks:

- perceptual superiority on an independent labeled cohort;
- safety of the 75% projected/output-size decision for all content;
- CPU-v1 HDR parity;
- global throughput under multiple concurrent jobs;
- post-grain full-title decode health.
