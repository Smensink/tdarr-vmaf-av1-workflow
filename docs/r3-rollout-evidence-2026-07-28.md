# r3 rollout evidence

Date: 2026-07-28

This record describes two drained r3 phases: the initial runtime with its
historical 34-node/53-edge graph, followed by the final immutable
36-node/58-edge validator/replacer/finalizer deployment. It supplements the
dated [audit](audit-2026-07-27.md), the reusable
[release checklist](release-checklist.md), and the
[installation and upgrade guide](installation.md). It contains no media
identity, API material, private evidence hash, or private host path.

## Operator decision and evidence boundary

The project owner explicitly waived the failed-job retained-candidate recovery
and directed the rollout to proceed to r3. No recovery retry was dispatched.
The protected retained candidate, latch/checkpoint material, rollback copy, and
earlier review evidence were preserved rather than used or deleted.

The evidence volume mounted for runtime-settings convergence therefore contains
verified **pre-r3** evidence. It is not post-recovery evidence, does not prove
that retained-candidate recovery completed, and must not be described as a
post-recovery rollback baseline. The recovery procedure remains documented in
[retained candidate recovery](retained-candidate-recovery.md) for any future
operator decision to revisit it.

This dated rollout phase did not itself claim a denoise retention result. The
later [post-rollout screen addendum](#post-rollout-sample-only-denoise-screens)
records two safely completed but inconclusive sample-only screens. Such work
remains limited to selected original-preserved cases, requires valid metrics
and manual visual review, and cannot automatically promote a setting or
authorize a full-title encode. Already replaced AV1 outputs are not valid
second-generation trial sources.

## Drain, backup, and rollback

Admission and the internal node remained manually paused, all four worker
limits remained zero, and no running job was cancelled. The read-only
quiescence verifier passed repeated two-snapshot checks immediately before live
mutations. Those checks covered Tdarr API state, the observed Linux process
namespace, and the exact production GPU lock; as always, a pass was evidence
for the observed instant rather than a lease on future idleness.

Before r3, a private rollback generation was completed and verified:

- online SQLite backups passed `PRAGMA integrity_check`;
- configuration and job-report archives passed traversal and content-parity
  checks;
- the active Flow, Compose inputs, environment material, mounted release
  sources, and artifact provenance were preserved privately; and
- the previous container image was retained under a private rollback tag.

The pre-r3 backup remains private because it contains operational state and may
contain media-identifying or credential-bearing data.

## Immutable release generations

The first recreate used a frozen initial r3 release and coordinator release
`9.25-r3`. The final deployment uses immutable release
`r3-20260727T233311Z-7b625a1f-final`. Exact image and rollback identities
remain in the private operator evidence.

The image qualified its wrapper identities, layer ancestry, native-Linux
FIFO transport, CPU VMAF-v1/CAMBI path, and coordinator supervision. The
runtime Dockerfile also fails closed if the expected upstream model directory
or Git LFS pointer check is unavailable. The build remains subject to ordinary
distribution-package timestamp/version drift; it is pinned at the image and
release boundary, not claimed to be bit-reproducible from future package
mirrors.

## Recreated security and mount boundary

Post-recreate inspection and API checks established:

- the final container runs the exact privately recorded image ID, is healthy,
  and has restart count zero;
- Tdarr authentication is enabled;
- the unauthenticated API boundary rejects access, while authenticated
  loopback calls succeed;
- both published Tdarr ports bind only to the literal loopback interface;
- the internal node uses the authenticated loopback server endpoint;
- the unique external private-runtime Docker volume is mounted read-only at
  `/private/tdarr-runtime`;
- the frozen r3 init, build, and NVEncC release sources are read-only mounts;
  and
- `TDARR_FLOW_PARITY_BOOTSTRAP` is back to effective zero.

The resolved Compose model was validated without publishing or saving its API
key. No credential value or private volume name belongs in this repository.

## Historical Flow and catalog deployment

The Flow deployed during this dated phase was the reviewed 34-node, 53-edge
graph. It contains the
post-audit fail-closed no-GPU and size-rejection routes. CPU VMAF-v1 production
authority is SDR-only; provisional CPU-v1 HDR authority remains disabled, and
paired-CQ remains shadow-only rather than acting policy. A later experimental
35-node, 54-edge host canonical was preserved privately but was not deployed
as r3.

The startup catalog issue was corrected with a complete 359-file
persistent-server/internal-node catalog reconciliation. That hotfix included
the correction for Tdarr_Node's enabled-FFmpeg-encoder probe, which could not
find `FlowHelpers/1.0.0/hardwareUtils.test.js` in the incomplete catalog. The
internal-node preservation sentinel was created only after the full seed and
given ownership matching its parent catalog. Source, persistent-server, and
internal-node parity then passed twice at least 15 seconds apart with
admission closed, proving that a late cached catalog download did not undo the
pinned generation.

## Final 36/58 deployment

The later drained final release deployed the repository's 36-node, 58-edge
graph with `validateDeliveryCandidate`, `replaceOriginalFileAttested`, and
`finalizeDeliveredOutcome`. The active database Flow, mounted canonical, and
redacted export agree at 36/58. The learning database migrated to schema 17,
passed integrity verification, and contains the guarded
`candidate_ready -> replacement_committing -> delivery_committing ->
delivered` success path.

The complete final catalog contains 366 files and 23 runtime helpers.
Source/persistent-server/internal-node parity passed twice after reconnect.
Compose/security, authenticated loopback API, runtime-settings convergence,
and deep toolchain qualification passed for the final immutable release. The
node remains paused with zero worker limits and repeated quiescence checks
passing.

This establishes deployment of the exact 30% search target, 20% minimum
reduction, and 80% maximum final-ratio contract. It does not prospectively
validate those thresholds or prove that a live job completed the new delivery
state machine.

## Runtime settings convergence

The reviewed settings operation followed its full idempotent sequence:

1. a dry plan passed against the read-only private evidence mount;
2. the apply completed while the queue and node remained paused;
3. exact-ID readback proved the target fields and preserved non-target fields;
   and
4. a second dry plan reported no pending changes.

The converged policy keeps filesystem events and hourly scheduled discovery
enabled, raises the folder-watch interval to 300 seconds, disables only
scan-on-start, preserves `holdFor` and the reviewed job-history limit, and
reduces the SQL backup limit to 10.

Because recovery was waived, the receipt used here authenticates the pre-r3
backup and report archive only. It is sufficient for this reviewed settings
operation under the recorded operator waiver; it is not promoted to
post-recovery evidence.

## Runtime and toolchain validation

With the node drained and the production GPU lease held by the qualification
runner, the r3 runtime passed the deep grain toolchain checks, including
grav1synth, the supervised NVEncC path, CUDA KNN coverage for the reviewed
8-bit and 10-bit cases, and the FFV1 handoff. CPU VMAF-v1 native 10-bit
FIFO scoring and CAMBI transport had already passed in the exact candidate
image. Deployment/Flow parity and quiescence were rechecked after recreate.

These checks qualify the installed runtime and its fail-closed process
contracts. They are not evidence that a feature-length live encode reached a
terminal success state. The final deployed source serializes the heavy
grain-analysis Python/NVEncC stage and final CUVID validation with
identity-owned production leases; their source/runtime qualification is still
not a feature-length live result.

## Canary and admission status

A live canary was deliberately withheld. With an existing paused queue, the
available Tdarr controls could not prove a one-file aperture that would admit
only the reviewed canary without also exposing queued work. Admission, the
node, and worker limits therefore stayed closed instead of trading isolation
for a nominal canary.

This remains the rollout boundary: the final 36/58 release is installed and
runtime-qualified, but no live-flow terminal encode is claimed. Before
reopening general admission, establish a queue-isolated canary mechanism and
verify the terminal database outcome, final decode, streams, colour signalling,
duration, exact-byte policy, attested replacement/finalization, delivery
retirement tombstone, and exact journal/checkpoint retirement.

## Grain review and scratch behavior

Production review preservation is now an explicit opt-in. The
`preserveProductionReview` input defaults to `false`; when enabled it may copy
one full source/output pair into the bounded private review area. Existing
review artifacts were preserved and were not treated as disposable scratch or
as proof of an r3 canary.

The direct-grain size-rejection path now removes the complete owned job
directory through the contained job-directory cleanup contract, instead of
unlinking only one partial output and leaving related scratch behind. Cleanup
remains confined to the authenticated job-owned root and cannot authorize
replacement. Durable review artifacts are outside that scratch lifecycle.

## Post-rollout sample-only denoise screens

Two isolated screens ran only after repeated process/API/lock quiescence
checks. Both exited successfully, retained their private evidence, made no
production mutation or restart, wrote no Tdarr database state, made no Tdarr
API call, and were followed by a passing quiescence check.

The priority-one screen used a predecessor fit-selection artifact. Its bounded
attempts mixed an operational fit failure with non-global multi-segment table
rejections, but the older artifact collapsed that distinction. It produced no
valid review clips, objective metrics, or contact sheets. The corrected
cautious screen classified its unavailable 0.08 control as
`grain_synthesis_fit_runtime_failure`, then skipped 0.10 and 0.12 without GPU
work as `control_setting_unavailable`. It also produced no size delta, VMAF,
CAMBI, band-MAE, contact sheet, or manual-review artifact.

Both comparisons therefore returned
`setting_unavailable_no_denoise_conclusion`, and production promotion remained
forbidden. These runs establish safe failure handling, not whether increased
denoising helps or harms, looks acceptable, or reduces full-title size.

## Explicitly not claimed

This rollout does not claim:

- successful failed-job or retained-candidate recovery;
- a post-recovery evidence generation;
- a completed live r3 canary or feature-length encode;
- successful live execution of the final delivery state machine;
- any denoise benefit/harm, visual-quality, size-reduction, full-title, or
  production-setting conclusion;
- provisional CPU-v1 HDR authority;
- live validation of the tracked 30% search target, 20% minimum reduction, and
  80% maximum final ratio;
- validation of the separate 90% projected-size research boundary, bounded
  forced-full cohort, or emergency projection cutoff;
- validation of projected-size or CQ policy from stage entry alone;
- feature-length live validation of the grain-analysis and final-decode lease
  changes; or
- deletion of historical review, quarantine, or recovery artifacts.
