# Plugin and helper reference

Inventory date: 2026-07-27. “Active” means the plugin identity occurs in flow
`YR5PZ1QaD`; it does not mean every branch runs for every file. The review was
static plus live-flow observation. It is not proof that every media edge case
has been exercised.

## Local plugins

| Status | Plugin | Runtime role | Review note |
|---|---|---|---|
| Active | `filter/checkFileAge` | Rejects sources newer than the configured seven days and records first-seen state. | Future timestamps are converted to an absolute age and can pass. The first-seen JSON update is not locked. Creation-time semantics vary by mount. |
| Active | `tools/unmonitorRadarrOrSonarr` | Resolves the replaced item and clears its monitored flag in Radarr or Sonarr. | This is an external side effect. It does not verify path/file identity or read back the mutation. Limit configured hosts, use TLS where possible, and validate identity before update. |
| Active | `vmaf/acquireGpuPipelineLock` | Acquires the cross-job GPU pipeline directory lock. | User-configurable lock paths and aggressive stale/same-file breaking are unsafe. The wait loop is synchronous and can block for hours. |
| Active | `vmaf/analyzeFilmGrain` | Runs the direct grain-analysis pipeline and publishes a versioned artifact for later synthesis. | Active graph runs it before the global GPU lock. Path scope checks follow symlinks and do not compare canonical real paths. |
| Active | `vmaf/calculateVMAF` | Scores encoded samples, aggregates VMAF/CAMBI, handles CPU-v1 authority, and manages scoring concurrency. | Critical shell-path injection; CPU-v1 geometry and runtime qualification gaps; misleading concurrency input; internal lock release/reacquire is incorrect and holds the GPU through CPU-only work. |
| Active | `vmaf/checkCQBracket` | Decides whether the target CQ has been bracketed or whether another search round is required. | Full-rate winner confirmation exists, but `threeStageVmaf` is not bound explicitly in the active flow. |
| Active | `vmaf/checkCQRangeRetry` | Bounds search/transcode retry state and resets the next search window. | No separate material static defect found. Important retry defaults should be explicit in the graph. |
| Unused | `vmaf/checkFileLimits` | Intended duration and file-size gate. | Broken if re-enabled: Tdarr size units are treated as bytes, and documented zero/disable values are replaced by defaults. |
| Active | `vmaf/checkHdrContent` | Classifies SDR/HDR/Dolby Vision and sets downstream colour policy. | Ambiguous 10/12-bit BT.2020 with unknown transfer can be treated as HDR and forcibly retagged BT.2020/PQ/BT2020NC. Preserve source signalling unless HDR evidence is conclusive. |
| Unused | `vmaf/checkVideoCodec` | Intended source-codec allow/deny gate. | Selects the first video stream and substring-matches aliases; attached pictures and ambiguous names can misclassify. |
| Active | `vmaf/cleanupTempFiles` | Deletes job-owned sample/transcode artifacts and retires checkpoints. | Trusts mutable flow arrays, clears manifests even after deletion errors, and always reports success. Require containment and explicit successful-replacement attestation. |
| Active | `vmaf/detectGPUEncoder` | Checks FFmpeg for NVIDIA AV1 capability. | Output 2 means no GPU, but both active-flow outputs continue to HDR analysis. Route output 2 to cleanup/failure. Its probe also uses a shell command. |
| Unused | `vmaf/detectSceneComplexity` | Claims to classify scene complexity. | It performs no scene-detection command and ignores several advertised thresholds. Keep retired or replace it. |
| Active | `vmaf/exportVMAFResults` | Persists primary SQLite results and best-effort CSV sidecars. | CSV creation/append is unlocked and can race. Treat SQLite as authority and CSV as non-transactional telemetry. |
| Active | `vmaf/extractVideoSamples` | Chooses representative segments, extracts sources, and validates/retries sample files. | Critical: interpolates media and output paths into shell commands. Convert all subprocesses to argv with `shell:false`. |
| Active | `vmaf/fetchMediaMetadata` | Enriches filename-derived metadata from Plex, TMDB, or TVDB. | Removes parenthesized years before parsing, accepts search result zero without robust matching, and handles some release-group formats poorly. HTTP responses are not bounded. |
| Active | `vmaf/learnCQRange` | Records the chosen CQ and updates learning priors. | Writes a pre-transcode selection as `transcode_succeeded=1` in CSV. CSV and EMA read-modify-write operations are not locked or atomic. |
| Unused | `vmaf/learnCQRanges` | Older plural learning implementation. | Incompatible with the current selector object shape; selected CQ becomes null. Remove or merge with the singular implementation. |
| Active | `vmaf/monitorTranscodeRetry` | Validates final-transcode outcome, records terminal state, and chooses retry/fallback branches. | Retry cleanup can delete a mutable output path without work-root containment. Terminal state handling otherwise fails closed. |
| Active | `vmaf/releaseGpuPipelineLock` | Releases the token-owned GPU pipeline lock. | Tokened release correctly throws on failure. This is safer than the unchecked internal release in `calculateVMAF`. |
| Active | `vmaf/selectBestParameters` | Applies quality/size feasibility, selects CQ, and runs holdout validation. | Critical shell-path injection in holdout/XPSNR commands. The holdout contract itself is strongly fail-closed. |
| Active | `vmaf/synthesizeFilmGrain` | Applies the stored grain artifact to the accepted transcode and publishes the replacement candidate. | Direct production path lacks bounded full-title decode validation after bitstream rewriting and does not enforce the legacy `requireExistingGpuLock` path. It shares the symlink scope issue. |
| Active | `vmaf/testEncodingParameters` | Builds a CQ candidate plan and runs AV1 NVENC sample encodes. | Uses argv and `shell:false`; reference and temporal-filter contracts fail closed. No material static defect found. |
| Active | `vmaf/vmafOptimizedTranscode` | Executes the selected full-title encode and commits protected post-encode checkpoints. | Hard timeout is 2× source duration, clamped to 30 minutes–4 hours, which may kill valid slow/long jobs. Comments call size policy advisory, but the post-mux size gate can reject output. |

### Highest-priority code locations

- Shell-path construction:
  `extractVideoSamples/1.0.0/index.js:6562,6650-6666`,
  `calculateVMAF/1.0.0/index.js:645-667,1035-1114`, and
  `selectBestParameters/1.0.0/index.js:1309-1325,2998-3006`.
- CPU-v1 geometry/promotion:
  `_lib/vmafV1Cpu.js:113-143,269-284` and
  `_lib/vmafMetricContract.js:192-249,315-324`.
- HDR retagging: `checkHdrContent/1.0.0/index.js:322-386`.
- Grain output validation:
  `synthesizeFilmGrain/1.0.0/index.js:3765-4174`.
- Lock breaking and deletion:
  `_lib/gpuPipelineLock.js:26-55,284-315,381-439`.

Paths above are relative to `plugins/vmaf/` unless another root is named.
The init-pinned subset of the deployment mirror under
`custom-cont-init.d/vmaf-plugin-patches/` must match byte-for-byte. Inactive
reference plugins are not all startup-pinned.

## Shared runtime helpers

Nineteen JavaScript helpers are deployed by the init hook.

| Helper | Purpose | Review note |
|---|---|---|
| `feasibility.js` | Shared quality/size constraint evaluation. | Active; no separate material defect found. |
| `gpuPipelineLock.js` | Directory-lock ownership, heartbeat, wait, break, and release. | High-risk stale-owner and arbitrary-root behavior described above. |
| `sizeFailureShadow.js` | Shadow model for size-failure risk. | Advisory only. The row-derived model is a private, ignored artifact because its category vocabulary exposes media titles and release groups. Missing-model errors are caught by the caller and do not alter routing. |
| `vmafdb.js` | SQLite schema, migrations, prepared writes, and queries. | Primary persistence authority; no obvious SQL injection found. |
| `vmafpredict.js` | Similarity-weighted CQ prediction and search planning. | Advisory/shadow components should not be described as validated policy without cohort evidence. |
| `referenceContractBridge.js` | Compatibility bridge for versioned reference measurements. | Active. |
| `pairedCqShadow.js` | Paired-CQ comparison and acting candidate. | Active configuration sets both “acting” and “force full”; force-full currently disables acting. |
| `emptyBandShadow.js` | Empty-feasible-band research shadow. | Retired/shadow-only. |
| `rejectionReasons.js` | Stable rejection taxonomy. | Active. |
| `grainAnalysisArtifact.js` | Grain artifact schema, scope, and integrity checks. | Canonicalize source real paths to prevent symlink scope bypass. |
| `postEncodeCheckpoint.js` | Authenticated checkpoint/reuse registry. | Strong fail-closed contract; retirement removes manifest before artifact, so a crash can orphan a large artifact. |
| `canonicalDenoise.js` | Canonical denoise policy identity. | Active. |
| `nvencTemporalFilter.js` | Exact NVENC temporal-filter policy identity. | Active. |
| `nvenccKnn.js` | NVEncC KNN coordinator contract. | Active and GPU-using. |
| `grainVmafContract.js` | Maps grain/VMAF outcome dispositions. | Active. |
| `preFgsCambi.js` | Records pre-film-grain banding measurements. | Active production helper; prior parity verifier omitted it. |
| `vmafMetricContract.js` | Resolves metric family, colour geometry, and authority. | Accepts geometries the CPU helper rejects and promotes by booleans without calibration attestation. |
| `currentContractMeasurementHistory.js` | Filters historical measurements for current contract reuse. | Active. |
| `vmafV1Cpu.js` | Builds/parses official CPU VMAF-v1 scoring. | Narrow geometry bands; provisional HDR; parser can accept an unexpected sole `cambi_*` alias. |

The `_lib` directory also contains tests and backfill/analysis utilities.
Those are support assets, not all deployed runtime helpers; `manifest.json`
classifies them separately. The private size-shadow model is excluded from the
manifest even when it exists locally.

## Community nodes used by the flow

The active graph also uses these Tdarr Community identities:

- `inputFile`
- `compareFileSizeRatioLive`
- `ffmpegCommandStart`
- `ffmpegCommandRorderStreams`
- `ffmpegCommandExecute`
- `replaceOriginalFile`
- `notifyRadarrOrSonarr`
- `failFlow`
- `onFlowError`

The graph has two notify nodes, two unmonitor nodes, two cleanup nodes, and
multiple acquire/release nodes. Those are repeated node instances, not
additional plugin identities. Community plugin source is supplied by Tdarr and
is therefore not vendored here.
