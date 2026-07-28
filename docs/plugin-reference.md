# Plugin and helper reference

Inventory date: 2026-07-28. “Active” means the plugin identity occurs in the
tracked 36-node/58-edge flow `YR5PZ1QaD`; it does not mean every branch runs
for every file. Review notes describe the repaired checked-in source informed
by the dated live-flow observation. The final generation is deployed with
source/server/node parity, but the withheld live canary means these notes are
not proof that every media edge case or terminal delivery branch has executed.

## Local plugins

| Status | Plugin | Runtime role | Review note |
|---|---|---|---|
| Active | `filter/checkFileAge` | Rejects sources newer than the configured seven days and records first-seen state. | Future timestamps are age zero and cannot pass. First-seen evidence is an immutable, atomically published per-source record under `/app/configs/too_young_files.d`; concurrent workers cannot overwrite one shared array. Creation-time semantics still vary by mount. |
| Active | `tools/unmonitorRadarrOrSonarr` | Resolves the replaced item and clears its monitored flag in Radarr or Sonarr. | Before mutation it requires consistent Tdarr original/library paths and exactly one matching Arr file record (exact path or a mapped-root suffix containing at least parent plus filename). Sonarr also requires one unambiguous record per filename episode and one shared episode-file ID. After mutation it reloads the item and file identity and requires explicit `monitored=false`; mismatch, ambiguity, schema drift, or failed readback routes to output 2. Requests remain confined to fixed API paths on the configured HTTP(S) host; allowlist the host and use TLS where possible. |
| Active | `vmaf/acquireGpuPipelineLock` | Acquires the cross-job GPU pipeline directory lock. | Uses the fixed configured root, asynchronous waiting, and a generation-owned lease. A live same-file owner or an old-but-live owner is never stolen; unexpected lock content fails closed. |
| Active | `vmaf/analyzeFilmGrain` | Runs the direct grain-analysis pipeline and publishes a versioned artifact for later synthesis. | Although the tracked graph reaches it before an explicit Acquire node, the plugin serializes its heavy Python/NVEncC KNN stage with the fixed production lease. It re-enters an exact caller-owned lease without releasing it, otherwise performs an identity-checked release and treats failure as fatal. The source must be an absolute, non-symlink regular file whose lexical and canonical paths remain in scope. |
| Active | `vmaf/calculateVMAF` | Scores encoded samples, aggregates VMAF/CAMBI, handles CPU-v1 authority, and manages scoring concurrency. | Media paths use argv/`shell:false`. Geometry/model identity fails closed to GPU-v0, one two-thread CPU score runs per job under the host semaphore, and unconfirmed lock release retains ownership. CPU-v1 accepts exactly the model-qualified VMAF alias equal to the pinned model version in pooled and every frame metric; bare, wrong-qualified, duplicate, or suffixed aliases fail closed. The tracked policy preserves SDR CPU-v1 but disables provisional HDR CPU-v1, which falls back to GPU-v0 rather than aborting. |
| Active | `vmaf/checkCQBracket` | Decides whether the target CQ has been bracketed or whether another search round is required. | Critical policy inputs are range-checked against named defaults. The tracked flow binds those defaults explicitly, including `threeStageVmaf=false`. |
| Active | `vmaf/checkCQRangeRetry` | Bounds search/transcode retry state and resets the next search window. | No separate material static defect found. The tracked graph and guarded updater explicitly bind `maxRetries=4`, `vmafHeadroomThreshold=5`, and `vmafBelowThresholdMargin=5`. |
| Unused | `vmaf/checkFileLimits` | Optional duration and file-size gate. | Tdarr `file_size` is converted from MiB (with ffprobe-byte fallback), and numeric zero reliably disables either limit. |
| Active | `vmaf/checkHdrContent` | Classifies SDR/HDR/Dolby Vision and sets downstream colour policy. | Ambiguous high-bit-depth BT.2020 with unknown transfer now routes to keep-original output 3 and cannot be retagged PQ. Explicit wide-gamut SDR, PQ, HLG, Dolby Vision, and HDR10+ retain separate evidence rules. |
| Unused | `vmaf/checkVideoCodec` | Optional source-codec allow/deny gate. | Ignores attached pictures, classifies every ordinary video stream, and skips only when all streams exactly match a normalized target alias. |
| Active | `vmaf/cleanupTempFiles` | Deletes job-owned sample/transcode artifacts and retires completed delivery state. | Validates the complete mutable manifest against a canonical, non-symlink `args.workDir` before deleting anything. Unsafe paths and deletion failures fail closed; failed paths remain registered. A replacement path cannot retire its checkpoint until finalization, the terminal schema-v17 row, and the delivered transaction agree. It first retains an authenticated permanent retirement tombstone, then removes the exact journal/checkpoint inventory; retries are idempotent from that tombstone. |
| Active | `vmaf/detectGPUEncoder` | Checks FFmpeg for NVIDIA AV1 capability. | Its probe uses argv/`shell:false`; output 2 now terminates at `failFlow` instead of continuing into HDR analysis. |
| Retired | `vmaf/detectSceneComplexity` | Compatibility tombstone for the former complexity heuristic. | Performs no analysis and clears legacy sampling adjustments. Remove old nodes instead of treating bitrate-per-pixel as measured scene rate. |
| Active | `vmaf/exportVMAFResults` | Persists primary SQLite results and optional CSV telemetry. | SQLite writes occur before telemetry. CSV is disabled by default and, when enabled, uses exclusive per-job files under `<csvPath>.d`; there is no shared append authority. |
| Active | `vmaf/extractVideoSamples` | Chooses representative segments, extracts sources, and validates/retries sample files. | Validation, extraction, holdout, and feature commands now preserve media paths as literal argv values with `shell:false`. |
| Active | `vmaf/fetchMediaMetadata` | Enriches filename-derived metadata from Plex, TMDB, or TVDB. | Preserves bracketed/parenthesized years, scores title/year matches instead of trusting result zero, conservatively extracts release groups, and rejects non-2xx or responses over 1 MiB. |
| Active | `vmaf/finalizeDeliveredOutcome` | Authenticates the post-replacement state and commits delivered success. | Starts only from the exact `delivery_committing` transaction. It validates the journal, schema-v17 row, installed file, retained backup, candidate proof, replacement attestation, and exact 30/20/80 policy. It retires only the authenticated backup; after bounded failure an exactly revalidated backup is recorded as retained, while successful deletion includes parent-directory fsync. It then compare-and-swap commits the immutable `delivered` row and publishes finalization evidence. It is the sole delivered-success authority. |
| Active | `vmaf/learnCQRange` | Attaches the pre-transcode selection/retry facts to SQLite and reads legacy historical CSV priors. | Never labels the pre-transcode row successful. Legacy CSV and EMA outputs are disabled by default; opt-in diagnostics use exclusive per-job files and are not shared learning authority. |
| Retired | `vmaf/learnCQRanges` | Compatibility tombstone for the obsolete plural writer. | Always routes to retired output 2 and writes no state; replace old nodes with the singular implementation. |
| Active | `vmaf/monitorTranscodeRetry` | Validates the base transcode and chooses retry, keep-original, technical-failure, or candidate-ready branches. | A usable encode is durably recorded as `candidate_ready`, not delivered success, and is bound to the canonical job and authenticated checkpoint. Keep-original and technical outcomes are terminal, but technical failure records `met_vmaf_target=NULL` because it is not evidence of a quality miss. Retry deletion is restricted to a canonical non-symlink regular file strictly beneath `args.workDir`, with all source identities protected. |
| Active | `vmaf/releaseGpuPipelineLock` | Releases the token/generation-owned GPU pipeline lock. | Release atomically renames the exact owned lease and throws on failure. The internal scoring release uses the same checked result and retains ownership when release is unconfirmed. |
| Active | `vmaf/replaceOriginalFileAttested` | Performs the crash-recoverable source replacement. | Authenticates the candidate-ready/validator/checkpoint chain; creates a durable transaction; compare-and-swap reserves `replacement_committing` before mutation; rejects path aliases and any pre-existing backup; uses no-overwrite staging; retains the exact original backup; installs and fully attests the candidate; then advances the row and journal to `delivery_committing`. Unknown commit state fails closed for explicit recovery. |
| Active | `vmaf/selectBestParameters` | Applies quality/size feasibility, selects CQ, and runs holdout validation. | Holdout and XPSNR commands use literal argv with `shell:false`; the holdout contract remains strongly fail-closed. The 20% minimum delivered reduction is the current exact policy. The old 90% projected ratio is a separate research boundary: bounded shadow-band admission uses atomically linked private reservation slots, while missing/corrupt/exhausted authority fails closed and the emergency projection cutoff remains separate. A terminal no-feasible result preserves the original. |
| Active | `vmaf/synthesizeFilmGrain` | Applies the stored grain artifact to the accepted transcode and publishes the replacement candidate. | Direct rewrites require exhaustive NVDEC or software decode before promotion; failure routes through the untouched-original fallback. Final CUVID validation acquires or borrows the exact global lease only around GPU decode, publishes its identity, and treats release failure as fatal. Source lexical/canonical scope and symlink identity fail closed. |
| Active | `vmaf/testEncodingParameters` | Builds a CQ candidate plan and runs AV1 NVENC sample encodes. | Uses argv and `shell:false`; reference and temporal-filter contracts fail closed. It requires and publishes the current 30% search target instead of accepting a stale/dead policy input. |
| Active | `vmaf/validateDeliveryCandidate` | Authenticates the final candidate immediately before replacement. | Requires the real post-encode checkpoint, durable `candidate_ready` proof, canonical job/checkpoint identities, full-file source/candidate identities, work-directory containment, non-aliasing, and the exact 30/20/80 delivered policy. Ratio equality at 80% is accepted; a larger file keeps the original. |
| Active | `vmaf/vmafOptimizedTranscode` | Executes the selected full-title encode and commits protected post-encode checkpoints. | The absolute liveness watchdog uses measured sample throughput when available, otherwise a 1/12-realtime fallback, with wide slack and a 12–72 hour bound. It remains finite without acting as a normal encode deadline. Its exact-byte post-mux gate uses the current 80% cap before candidate-ready status and retires only the exact rejected checkpoint; retirement errors retain the artifact for cleanup without permitting replacement. |

### Highest-priority code locations

- Command-path safety: the three active media-command plugins expose argv
  builders to `test-command-path-safety.js`, which covers spaces, quotes,
  command substitution, and shell metacharacters in POSIX and Windows paths.
- CPU-v1 geometry, exact model-qualified alias parsing, and promotion:
  `_lib/vmafV1Cpu.js:129-286,359-519,614-700` and
  `_lib/vmafMetricContract.js:175-313`.
- HDR retagging and keep-original routing:
  `checkHdrContent/1.0.0/index.js:318-380,420-464`.
- Grain output validation:
  `synthesizeFilmGrain/1.0.0/index.js:2025-2176,3504-3511,4087-4102`.
- Lock, replacement, and deletion boundaries:
  `_lib/gpuPipelineLock.js`, `cleanupTempFiles/1.0.0/index.js`, and
  `monitorTranscodeRetry/1.0.0/index.js`,
  `replaceOriginalFileAttested/1.0.0/index.js`, and
  `finalizeDeliveredOutcome/1.0.0/index.js`.

Paths above are relative to `plugins/vmaf/` unless another root is named.
The init-pinned subset of the deployment mirror under
`custom-cont-init.d/vmaf-plugin-patches/` must match byte-for-byte. Inactive
reference plugins are not all startup-pinned.

## Shared runtime helpers

Twenty-three JavaScript helpers are deployed by the init hook.

| Helper | Purpose | Review note |
|---|---|---|
| `feasibility.js` | Shared quality/size constraint evaluation. | Active; no separate material defect found. |
| `gpuPipelineLock.js` | Directory-lock ownership, heartbeat, wait, recovery, and release. | Fixed-root, generation-owned leases; atomic owner/heartbeat publication; initialization grace; Linux PID/start-time liveness; async wait; exact-identity release; unexpected or established ownerless state fails closed for manual quiescent recovery. |
| `sizeFailureShadow.js` | Shadow model for size-failure risk. | Advisory only. The row-derived model is a private, ignored artifact because its category vocabulary exposes media titles and release groups. Missing-model errors are caught by the caller and do not alter routing. |
| `vmafdb.js` | SQLite schema, migrations, prepared writes, and queries. | Schema v17 enforces `candidate_ready -> replacement_committing -> delivery_committing -> delivered`, exact policy fields, and immutable delivered outcomes. |
| `vmafpredict.js` | Similarity-weighted CQ prediction and search planning. | Advisory/shadow components should not be described as validated policy without cohort evidence. |
| `referenceContractBridge.js` | Compatibility bridge for versioned reference measurements. | Active. |
| `pairedCqShadow.js` | Paired-CQ comparison and acting candidate. | Active configuration explicitly keeps shadow and force-full enabled while acting is disabled. Acting requires a separate reviewed promotion that removes the interlock. |
| `emptyBandShadow.js` | Empty-feasible-band research shadow. | Retired/shadow-only. |
| `rejectionReasons.js` | Stable rejection taxonomy. | Active. |
| `grainAnalysisArtifact.js` | Grain artifact schema, scope, and integrity checks. | Provides the shared absolute/non-symlink lexical and canonical source-scope check used by both grain stages. |
| `postEncodeCheckpoint.js` | Authenticated checkpoint/reuse registry. | Strong fail-closed contract. Completeness uses measured source/output packets, producer-log paths are portable identity tokens, and retirement authenticates then removes the payload before its manifest so an interruption remains visible. |
| `postReplaceAttestation.js` | Full-file installed/backup identity and replacement attestation. | Records full SHA-256 plus nanosecond filesystem identity where available, binds the exact retained backup, and permits only identity-checked backup retirement. |
| `deliveryPolicy.js` | One canonical delivered-size policy. | Requires the exact current version and complete 30% target, 20% minimum, and 80% final-ratio cap. Byte evaluation accepts equality at the cap and rejects partial/stale policy objects. |
| `deliveryFinalization.js` | Constructs and validates immutable delivered evidence. | Rechecks candidate, replacement, installed-file, exact-byte policy, and terminal database provenance; it cannot turn candidate-ready state into success by itself. |
| `deliveryTransaction.js` | Durable delivery transaction, crash-recovery journal, and retirement proof. | Uses an authenticated checkpoint-entry journal, exclusive sibling lock, atomic write/fsync/rename, monotonic state transitions, and immutable delivered evidence. Retirement first publishes permanent `delivery-retirement-v1.json` with schema `vmaf-delivery-retirement-tombstone/v1`. It embeds finalization-v2, replacement proof, terminal DB critical fields, checkpoint inventory, and journal/finalization/replacement/DB/self digests; only then can the journal and authenticated payload be removed. |
| `canonicalDenoise.js` | Canonical denoise policy identity. | Active. |
| `nvencTemporalFilter.js` | Exact NVENC temporal-filter policy identity. | Active. |
| `nvenccKnn.js` | NVEncC KNN coordinator contract. | Active and GPU-using. |
| `grainVmafContract.js` | Maps grain/VMAF outcome dispositions. | Active. |
| `preFgsCambi.js` | Records pre-film-grain banding measurements. | Active production helper; prior parity verifier omitted it. |
| `vmafMetricContract.js` | Resolves metric family, colour geometry, and authority. | Uses the CPU helper's exact model-family and rational SAR/DAR validator. Promotion still depends on booleans without a signed calibration artifact. |
| `currentContractMeasurementHistory.js` | Filters historical measurements for current contract reuse. | Active. |
| `vmafV1Cpu.js` | Builds/parses official CPU VMAF-v1 scoring. | Exact supported geometry and reference/candidate transport identity fail closed. It accepts exactly the model-qualified VMAF alias equal to the pinned model version; bare, wrong-qualified, duplicate, and suffixed aliases are rejected in pooled and every frame metric. HDR remains provisional. |

The `_lib` directory also contains tests and backfill/analysis utilities.
Those are support assets, not all deployed runtime helpers; `manifest.json`
classifies them separately. The private size-shadow model is excluded from the
manifest even when it exists locally.

## Community nodes used by the flow

The tracked graph also uses these Tdarr Community identities:

- `inputFile`
- `compareFileSizeRatioLive`
- `ffmpegCommandStart`
- `ffmpegCommandRorderStreams`
- `ffmpegCommandExecute`
- `notifyRadarrOrSonarr`
- `failFlow`
- `onFlowError`

The graph has two notify nodes, two unmonitor nodes, two cleanup nodes, and
multiple acquire/release nodes. Those are repeated node instances, not
additional plugin identities. Community plugin source is supplied by Tdarr and
is therefore not vendored here.
