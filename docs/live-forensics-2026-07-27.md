# Live job forensics and remediation

Date: 2026-07-27; remediation continued 2026-07-28

This report records the private live-history investigation in aggregate. Media
titles, library paths, job-report paths, credentials, and full file identities
are deliberately omitted from the repository.

## Two failed jobs

The two failures shown in Tdarr did not have the same cause.

1. One job failed during command setup because the coordinator was given the
   relative spelling `tdarr-ffmpeg` where an absolute executable path was
   required. A later attempt for the same source completed successfully and
   reduced the file from approximately 8.26 GiB to 1.18 GiB. The current
   command builder resolves and authenticates the absolute wrapper and its
   effective target before starting work.
2. The other producer and consumer both exited zero, but the post-encode
   validator estimated an expected packet count as frame rate multiplied by
   duration. The source is sparse/damaged and reported container errors, so
   that estimate was not a valid completeness test. The retained candidate had
   122,252 measured video packets versus 122,264 in the source: a difference of
   12 packets, inside the existing 48-frame tolerance. The candidate remains
   quarantined and byte-authenticated.

The validator now measures source packets directly with `ffprobe
-count_packets`, compares measured source and output counts, and treats a
missing source count as retryable rather than confirmed-invalid. A separate,
  explicit [recovery utility](retained-candidate-recovery.md) authenticates the
  legacy manifest, source, candidate, tools, and contract; changes only the old
  job-specific `--producer-log` value to the portable token; requires equality
  with a fresh current plan; performs exhaustive decode validation; imports the
  exact bytes; and arms the source-scoped reuse latch. It never encodes, deletes
  legacy evidence, replaces a source, or requeues a job.

The first controlled exact-reuse attempt then failed safely before retained
checkpoint reuse, a full-title transcode, or replacement. The deployed
native-Linux FIFO scorer emitted the model-qualified VMAF alias, while the CPU
helper incorrectly required bare `vmaf`. Admission stayed closed and the
source, retained candidate, latch, normalized checkpoint, rollback copy, and
legacy evidence remained intact. The helper-only correction now binds the
alias to the exact pinned model version, passes `name=<model version>` on the
direct path, and requires that exact sole alias in pooled and every frame
metric; bare, wrong-qualified, duplicate, and suffixed aliases fail closed.
The old private dispatch spec was invalidated and the complete execution path
must be reauthenticated before the one-job retry.

Operator disposition (2026-07-28): the owner waived this retained-candidate
recovery. No retry was dispatched; the protected artifacts were preserved, and
no terminal-recovery or post-recovery-evidence claim is made. The procedure
remains available only for a future explicit decision.

## “Original kept” correction

Two different populations had been conflated.

Five historical rows marked `size_target_status=failed` did **not** preserve
their originals. Their larger AV1 outputs reached replacement at:

| Output/source ratio |
| ---: |
| 103.03% |
| 113.17% |
| 114.02% |
| 124.52% |
| 165.34% |

The original files were no longer present. These are destructive oversized
replacements, not denoise-retention candidates. Re-encoding those AV1 files
would be a second-generation test and is not recommended. If the sources are
reacquired, the 103.03% case is the strongest first test, followed by the two
113–114% cases.

The repaired final transcode path now compares exact post-mux output bytes with
exact source bytes before reporting success. An output at or above the
configured cap routes to original-preserving cleanup and retires only its exact
authenticated checkpoint. A retirement error retains the checkpoint for
diagnosis but cannot authorize replacement. Regression tests include all five
observed ratios.

Four recent `no_feasible_parameters` jobs did preserve their sources
byte-for-byte and never reached replacement:

| Priority | Source size | CQ16 quality evidence | Assessment |
| --- | ---: | --- | --- |
| 1 | about 6.98 GB | harmonic VMAF 96.524; frame floor missed by 0.072; mean CAMBI 2.392 | Highest-priority bounded candidate; the 2026-07-28 screen was inconclusive |
| 2 | about 7.01 GB | harmonic VMAF 97.848; frame floor missed by 5.948; mean CAMBI 0.481 | Cautious second candidate with detail-loss risk; the screen was inconclusive |
| 3 | about 20.4 GB | harmonic VMAF 95.245; frame floor missed by 11.626 | Low priority |
| 4 | about 14.46 GB | harmonic VMAF 94.754; frame floor missed by 29.908 | Not a useful stronger-denoise candidate |

## Bounded denoise experiment

The [sample-only denoise harness](denoise-retention-trials.md) compares the
production KNN strength 0.08 with trial-only 0.10 and 0.12 contracts at exact
private timestamps. It keeps AV1 NVENC preset p7, the title's approved quality
profile, and temporal filtering off. For each executed setting, the harness
fits one production-shaped global grav1synth table and applies it to every
review interval. If the 0.08 control is unavailable, stronger settings are
skipped without GPU/media work and no comparison conclusion is claimed. It
measures AV1 packet bytes, VMAF/CAMBI when available, and fixed dark, shadow,
midtone, and highlight luma bands. Contact sheets remain private and every
result requires manual visual review; the tool can never promote a setting.

The harness fails before creating output if the production GPU lock exists or
if `/proc` shows a pre-existing Tdarr worker, coordinator, NVEncC, FFmpeg,
VMAF/libvmaf, grain, NVENC, CUDA, or CUVID process. It repeats those checks
before and after every executed case and setting. This independent check is
required because the live API was observed reporting workers idle while a real
title encode and GPU lock were still active.

Trial results are recorded only after a fully drained run. Private inputs,
artifacts, contact sheets, and results are excluded from Git.

### Observed screen outcomes on 2026-07-28

Both isolated screens exited safely, retained their private evidence, made no
production mutation, restart, database write, or Tdarr API call, and left the
paused production node quiescent. Neither produced a valid comparison output.

- The priority-one screen used the predecessor fit-selection artifact, before
  the control-unavailable short-circuit and corrected reason taxonomy. Its
  first bounded attempts included an operational fit failure, while the other
  bounded candidates emitted non-global multi-segment tables. No setting
  produced review clips, metrics, or contact sheets. The predecessor's
  collapsed reason therefore cannot prove pure static-model
  unrepresentability.
- The cautious screen used the corrected harness. Its 0.08 control was
  unavailable as `grain_synthesis_fit_runtime_failure`; 0.10 and 0.12 were
  recorded as `control_setting_unavailable` and skipped without GPU/media
  work. It produced no size delta, VMAF, CAMBI, band-MAE, contact sheet, or
  manual-review artifact.

Both comparisons returned `setting_unavailable_no_denoise_conclusion`.
Accordingly, there is no evidence that increased denoising looks good, reduces
size, or should replace production strength 0.08, and no full-title test is
authorized. Any future screen must first diagnose the control fit runtime
failure and still preserve the direct single-global-table contract; a
multi-segment table must not be normalized into a false global model.

## Additional checked-in source fixes

Deployment of these repairs requires a verified process-level drained rollout;
the source diff alone is not evidence that a running catalog or graph changed.

- Media paths are literal argv values with `shell:false`.
- No-GPU and defensive size-check graph routes fail closed.
- GPU locking uses a fixed root and generation-owned asynchronous leases; live
  same-file owners are never stolen.
- CPU VMAF-v1 authority checks exact supported geometry and transport before
  selection and falls back to GPU-v0 when unsupported.
- Ambiguous high-bit-depth BT.2020 with unknown transfer keeps the original.
- Direct grain rewrites require a complete AV1 decode before replacement.
- Cleanup and retry deletion are confined to authenticated job-owned paths.
- Future timestamps cannot bypass the age gate, and first-seen records publish
  atomically per source.
- SQLite is learning authority; shared CSV/EMA writers and pre-transcode
  success labels are retired.
- Metadata HTTP responses are bounded and title/year matches are scored.
- Inactive file-limit and codec gates have correct units/exact stream
  semantics; deceptive obsolete plugins are explicit tombstones.
- Critical CQ-bracketing inputs are explicit in both Flow snapshots.
- The r3 NVEncC coordinator terminates the producer if FFmpeg exits first, even
  with status zero, preventing a hidden producer/lease orphan. Its rollout must
  follow any legacy retained-candidate recovery and controlled exact reuse.
- Deployment and experiment gates check both Tdarr's API and real processes.

The full design and operational findings remain in
[the deployment audit](audit-2026-07-27.md).
