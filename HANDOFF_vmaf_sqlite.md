# Tdarr VMAF/AV1 System — Change Handoff (as of 2026-06-29)

## TL;DR current state

Phase 4 ACTING remains live. Newest live+repo state adds schema v6 `media_title` learning, source-CAMBI p95
similarity, constraint-aware predictor labels, bounded parallel sample encodes, a final-transcode watchdog, and a
live Tdarr flow fix for the GPU pipeline lock. The lock bypass was caused by three stale direct flow edges
(`retry1→test1`, `checkCQBracket→test1`, `monitorRetry1→transcode1`) that coexisted with the lock nodes; those
edges are now removed in live Tdarr and replaced with edges through `gpuLockAcquire1` / `gpuLockAcquireTranscode1`.

GPU VMAF fallback is **not occurring** — the high-CPU is from NVENC quality-maximising settings, not VMAF slow paths.

---

## Host environment

- Host project root: `C:\Users\seb_m\tdarr` (Docker container `tdarr`, LinuxServer.io image).
- GPU: RTX 5070 Ti (Blackwell). Custom FFmpeg 8.1.1 + libvmaf CUDA. Container Node = v24.15.0.
- Flow: **VMAF Parameter Optimization + stream reorder** (id `YR5PZ1QaD`). Target VMAF = 95.
- Live plugin source: `/custom-cont-init.d/vmaf-plugin-patches/` (bind-mounted; edits require only container restart).
- Repo: `C:\Users\seb_m\tdarr-vmaf-av1-workflow` (GitHub: smensink/tdarr-vmaf-av1-workflow).

---

## What changed this session (all live)

### 1. Data integrity — recovered 17,849 corrupted sweep rows

~92% of `sweep_points` had column-misaligned aggregates (impossible `vmaf_min>vmaf_max`, wrong `vmaf_mean`)
from a legacy CSV-writer bug. Per-sample columns were intact, so `_lib/recover_sweep_aggregates.js`
recomputed every aggregate from them. `vmaf_min>vmaf_max` dropped 17,956 → 107 (107 unrecoverable, auto-excluded).

`getSimilarSweepCurves` now filters physically-impossible rows by default (`opts.includeInvalid` to disable).
DB backed up: `configs/vmaf_training.db.bak_precover_*`.

### 2. Fixed `selectSampleCount` no-variance data — plausibility bounds on per-clip sigma

Previously inert; now acting. Per-file sigma is bounded to [0.05, 6] and `sample_count≥3` before being used
to adapt clip count to content variance, bounded by `[minSegments, maxSegments]`. Previously used a
conservative historical sigma regardless of file characteristics.

### 3. Holdout CAMBI fix — self-comparing source CAMBI

`runVmafOnHoldout` now self-compares the holdout segment's own source CAMBI and gates on the
**encode-introduced delta**, not a job-global floor. Fixes VMAF-100/CAMBI-high false-fails
where source banding was already elevated.

### 4. Learned similarity weights (η² correlation ratios) — replaced hand-tuned penalties

`vmafpredict.learnFeatureWeights` computes each metadata covariate's η² (correlation ratio) on the
optimal-CQ distribution → mismatch penalty, recomputed every prediction (self-updating).

Covariates tested: `genre`, `type`, `network`, `original_language`, `codec`, `release_group`, `media_year`.

Live finding from the recovered DB:
- `release_group` η²≈0.23 — top predictor
- `genre` η²≈0.23 — top predictor  
- `network` η²≈0.19
- `type`/`year`/`language`/`codec` ≈0 (uninformative)

Logged as `[PREDICT] learned metadata importance` in job output.

### 5. Per-file sequential sampling (`calculateVMAF`)

Per-paramset early-stop: clips measured in randomised order (shared permutation → curves stay comparable),
stops a CQ once its mean CI ≤ 0.5 VMAF **and** worst clip clears `floor+2` margin. Uses real per-file sigma
instead of conservative historical one. Kill switch: `args.variables.vmafSequentialSampling=false`.

Success-rate denominator fixed to exclude skipped clips.

### 6. Autoresearch re-run on recovered data + metadata + fractional CQ

Seed was 37% violation on real data; new `feat_float_bisect_v5` → **0.34% violation**.
Conclusion: transcode count is floored by the noisy worst-case `vmaf_min` — the lever is content features
(grain/dark), which are still too sparse (only 5 jobs with grain/luma/dark signals, 0 with full curves).

### 7. GPU VMAF investigation — NOT the CPU culprit

Job reports show `vmafGpuVmafFallbackUsed=false` in all recent jobs; server logs show zero GPU→CPU fallback
events. The 100%+ CPU processes are FFmpeg AV1 NVENC encodes — caused by quality-maximising settings
(`-tune uhq -multipass fullres -spatial-aq 1 -temporal-aq 1 -rc-lookahead 48`) and HDR→SDR tonemapping,
not by VMAF falling back to CPU.

---

## What changed in the second session (all live, pushed 2026-06-25)

### 8. Schema v5 — per-clip VMAF logging (`clip_vmafs`)

`sweep_points` now has a `clip_vmafs TEXT` column storing the raw per-clip VMAF scores as a JSON array.
Enables offline backtesting of the sequential sampler's stopping rule against measured clip distributions.
Migration is additive (`ALTER TABLE ADD COLUMN`), null on pre-v5 rows. Schema version bumped 4→5.

### 9. Same-file re-encode prior (`getSameFileSweepCurves`)

When a file is re-queued (manual retry or automatic re-encode trigger), the predictor now consults its
own previous sweep history before falling back to similar-content priors.

**Architecture:**
- `vmafdb.js` exports `getSameFileSweepCurves(db, filePath, opts)` — queries `sweep_points JOIN jobs`
  WHERE `j.file_path` matches exactly.
- `vmafpredict.js` — both `selectCQFromDb()` and `sampleStatsFromDb()` call `getSameFileSweepCurves()`
  after `getSimilarSweepCurves()` and **prepend the same-file rows with `timestamp` set to +1 day future**.
  This gives them maximal recency weight, making same-file history the dominant contributor.
- Two callers pipe `file_path` into the predictor's `src` object:
  - `testEncodingParameters`: `file_path: (args.inputFileObj && args.inputFileObj._id) || ''`
  - `extractVideoSamples`: `file_path: (args.inputFileObj && args.inputFileObj._id) || ''`

**Stats:** 1,074 distinct files processed more than once; 2,454 total prior runs (~2.3 runs/file average).

### 10. Known-failed CQ avoidance

When building the guided/retry candidate CQ list in `testEncodingParameters`, the code now:
1. Opens SQLite and calls `getSameFileSweepCurves()` to fetch all previously-tested CQ→VMAF points
   for this exact file
2. Compares each point's `vmaf_mean` against the target VMAF
3. Builds a `knownFailedCQs` array of CQs that failed, finds the `lowestFailedCQ`
4. **Caps the retry bracket** so the maximum CQ tested is `lowestFailedCQ - 1`
5. Also filters out any remaining known-failed CQs from the shifted range
6. Logs how many CQs are being excluded and the adjusted bracket
7. Pad-value fallback (when <2 candidates remain) also checks against `knownFailedCQs`

**Cross-plugin scope lesson:** `isHdrContent()` is defined only in `calculateVMAF/1.0.0/index.js`.
Two plugins called it outside its scope (`selectBestParameters`, `extractVideoSamples`) — fixed by
inlining HDR detection. Fix pattern: never reference functions from other plugin files; inline the check.

### 11. Constraint-aware optimum bracketing (`checkCQBracket`)

When all candidates meet VMAF mean target AND the 1%-low floor AND the CAMBI threshold, but a higher-CQ
candidate fails one, the optimum is already bracketed by the binding constraint — no need to expand the
sweep upward chasing a VMAF crossing that doesn't bind. Previously the bracket expansion would blow the
sweep up to the whole range.

New logic in `checkCQBracket/1.0.0/index.js`: iterates aggregated results, collects feasible CQs
(those meeting all constraints), and if the highest feasible CQ has a higher-infeasible neighbour,
returns "bracketed by binding constraint" and proceeds to selection without expansion.

### 12. HDR tonemap removal from GPU VMAF (`calculateVMAF`)

The `isHdrContent()` function and its HDR tonemap pipeline have been **removed** from GPU VMAF commands.

**Why:** libvmaf_cuda needs 8-bit input — `format=yuv420p` already provides that. The old code also applied
`tonemap=hable` to the PQ signal, which:
- Banded smooth gradients (the tonemap was applied without linear zscale)
- CAMBI then reported those bands as false banding
- Measured a tonemapped-SDR rendition that never exists in the pipeline (the final transcode stays 10-bit HDR)

**Correct approach:** Measuring PQ signal requantized to 8-bit is a faithful (slightly conservative) proxy
for the 10-bit output's banding. Native 10-bit VMAF is CPU-only here.

`buildGpuVmafCommand` and `buildCpuVmafCommand` both lost their `isHdr` parameter. HDR is no longer
detected or passed — the GPU format conversion is the only 8-bit path.

### 13. Retry limit 2→4 + graceful fallback (`checkCQRangeRetry`)

**Problem:** `maxRetries=2`. When initial bracket and first retry both missed target VMAF, the file
threw a hard error — losing all sweep data. With the model converging in 1-2 more steps, 2 was too tight.

**Changes:**

| Component | Before | After | File |
|-----------|--------|-------|------|
| Plugin input default | `defaultValue: '2'` | `defaultValue: '4'` | `checkCQRangeRetry/1.0.0/index.js` |
| Fallback default | `\|\| 2` | `\|\| 4` | `selectBestParameters/1.0.0/index.js` |
| Retry-exhausted | `throw new Error(...)` | graceful log + `vmafRetryEligible` flag | `checkCQRangeRetry/1.0.0/index.js` |

**Graceful fallback:** When `retryCount >= maxRetries` AND `cqRangeExhausted`:
- Sets `args.variables.vmafRetryEligible = true` and reason
- Falls through — sweep data written to DB, file saved with best-available params
- Future re-queue finds its own history via `getSameFileSweepCurves`

### 14. DB self-healing handle (`vmafdb.js`)

`openDb()` previously returned a cached `DatabaseSync` handle. If any caller closed it (the `getSameFileSweepCurves`
caller in `testEncodingParameters` initially closed the handle), the cache returned a DEAD handle — every
later `openDb()` returned a closed db, and the predictor silently failed with "database is not open".

**Fix:** Before returning a cached handle, probe it with `SELECT 1`. If it fails, drop it and reopen
transparently. The handle is now meant to live for the Node process's lifetime.

### 15. `is_hdr` added to `getSimilarSweepCurves` SELECT

The `is_hdr` column was being compared in `vmafpredict.weightForPoint()` but was **missing from the SELECT**
in `getSimilarSweepCurves`. Added `j.is_hdr` to the query. This was a feature-parity gap between the
predictor and its data query — every WHERE that used `is_hdr` got undefined instead of the stored value,
silently degrading HDR similarity matching.

### 16. `selectBestParameters` — clean source replacement

The repo had a 289K-line transpiled/bundled `selectBestParameters/index.js`. The live version is a
hand-written 3,007-line clean source. Replaced the bundled version with the clean source.

### 17. Init script updates

- `96-apply-vmaf-plugin-patches.sh`: Added `fetchMediaMetadata` to the applied patches list; removed
  `learnCQRanges` (superseded); minor echo text update.
- `99-replace-ffmpeg.sh`: Minor echo text updates.

### 18. maxParallelGpuVmaf default 2→4 — GPU VMAF parallelism

`calculateVMAF` previously defaulted to 2 concurrent GPU VMAF processes, below the live encode pool and below the
RTX 5070 Ti's measured safe headroom. It now defaults to **4**, giving one extra scoring slot for retry/holdout
bursts while staying inside the 1–6 clamp.
Also fixed the misleading tooltip that said "GPU VMAF always runs sequentially" (it never did; only the default
was small).

---


## What changed in the third session (live + repo, 2026-06-29)

### 19. Schema v6 — canonical `media_title` similarity

`vmafdb.js` bumps schema 5→6 and adds `jobs.media_title`. `fetchMediaMetadata` derives a canonical
filename title (`SxxExx` stripped for TV, movie title for films) and `exportVMAFResults` writes it to SQLite.
`vmafpredict.learnFeatureWeights()` and `weightForPoint()` now include `media_title`; exact same-show/movie
matches keep full weight while other titles are discounted. This reflects the observed signal that episodes of
one show share source master/grain/grade and have tighter CQ clustering than broad tier-wide priors.

### 20. Source banding risk uses p95 CAMBI

`getSimilarSweepCurves()` / `getSameFileSweepCurves()` now SELECT `source_cambi_p95` as well as mean
`source_cambi`. Predictor similarity uses `max(source_cambi, source_cambi_p95)` so dark/gradient-heavy files
match on the banding value that actually tends to bind the CAMBI gate. `calculateVMAF` job summaries now log
`CAMBI(avg/p95/max)` to remove the old “mean looks fine, p95 rejected” ambiguity.

### 21. Constraint-aware predictor labels + safer retry extrapolation

`vmafpredict.constraintAwareOptimum()` lets each neighbour job contribute the binding CQ implied by VMAF mean,
1%-low, and CAMBI where that neighbour has enough data; otherwise it falls back to the prior VMAF-mean crossing.
`checkCQRangeRetry` now caps CAMBI extrapolation below the tested range (default 6 CQ) so a shallow high-CQ CAMBI
slope cannot over-shoot to absurdly low retries such as CQ16–18 when the real boundary is near CQ30.

### 22. Bounded parallel sample encodes

`testEncodingParameters` is now async and uses a bounded `maxParallelEncodes` worker pool with `spawn()` instead
of synchronous serial `execSync()` sample encodes. It records per-task failures, rejects near-empty outputs, and
keeps Tdarr worker progress/ETA updated while preserving the existing `maxParallelEncodes` clamp.

### 23. Final transcode watchdog

`vmafOptimizedTranscode` sets a hard wall-clock timeout for the final FFmpeg process: `2 × source duration`,
clamped to 30 minutes–4 hours. If a pathological final encode stalls while holding the GPU pipeline lock, Node
SIGKILLs FFmpeg, the normal failure output routes through `releaseGpuPipelineLock`, and the queue is not wedged.

### 24. GPU pipeline lock live-flow bypass fixed

Investigation found the repo flow was correctly locked, but the live Tdarr DB still had stale direct edges in
addition to the lock nodes:

- removed `edge6b: retry1:1 → test1`; added `edge6b_to_gpuLockAcquire1: retry1:1 → gpuLockAcquire1`
- removed `rLWbQzi1W: checkCQBracket:2 → test1`; added `rLWbQzi1W_to_gpuLockAcquire1`
- removed `edge7d: monitorRetry1:1 → transcode1`; added `edge7d_to_gpuLockAcquireTranscode1`

Live fix was applied through Tdarr's `/api/v2/cruddb` endpoint on port 8266 (not direct SQLite; direct opens can
fail with `unable to open database file` while the server owns the DB). Verification after update: 42 edges,
no missing required lock edges, and zero remaining direct bypass edges. A DB copy backup and a flow JSON backup
were created before the live edit.

---
## File inventory — live vs repo

| Path | Status | Notes |
|------|--------|-------|
| `_lib/vmafdb.js` | ✅ SYNCHRONISED | Schema v6 (`media_title`), clip_vmafs, self-healing handle, getSameFileSweepCurves, source_cambi_p95 in SELECT |
| `_lib/vmafpredict.js` | ✅ SYNCHRONISED | Same-file prior, media_title weighting, source CAMBI p95 risk, constraint-aware neighbour labels |
| `_lib/backfill_metadata.js` | ✅ IN REPO | |
| `_lib/recover_sweep_aggregates.js` | ✅ IN REPO | |
| `calculateVMAF/1.0.0/index.js` | ✅ SYNCHRONISED | HDR tonemap removed, CAMBI avg/p95/max logging, maxParallelGpuVmaf default 4 |
| `extractVideoSamples/1.0.0/index.js` | ✅ SYNCHRONISED | Same-file file_path piping, source_cambi_p95 predictor input |
| `testEncodingParameters/1.0.0/index.js` | ✅ SYNCHRONISED | Async bounded encode pool, known-failed CQ avoidance, media_title/source_cambi_p95 predictor inputs |
| `selectBestParameters/1.0.0/index.js` | ✅ SYNCHRONISED | Clean source (3K lines, was 289K bundled), retry default 4 |
| `exportVMAFResults/1.0.0/index.js` | ✅ SYNCHRONISED | clip_vmafs, media_title write |
| `checkCQBracket/1.0.0/index.js` | ✅ SYNCHRONISED | Constraint-aware bracket check |
| `checkCQRangeRetry/1.0.0/index.js` | ✅ SYNCHRONISED | maxRetries 4, graceful fallback, CAMBI extrapolation cap |
| `fetchMediaMetadata/1.0.0/index.js` | ✅ SYNCHRONISED | canonical `vmafSeriesTitle` / `media_title` extraction |
| `learnCQRange/1.0.0/index.js` | ✅ SAME | |
| `learnCQRange/1.0.0/ema_cq_state.json` | ✅ IN REPO | |
| `checkHdrContent/1.0.0/index.js` | ✅ SAME | |
| `vmafOptimizedTranscode/1.0.0/index.js` | ✅ SYNCHRONISED | final-transcode watchdog timeout |
| `docker/custom-cont-init.d/96-apply-vmaf-plugin-patches.sh` | ✅ SYNCHRONISED | Added fetchMediaMetadata, removed learnCQRanges |
| `docker/custom-cont-init.d/99-replace-ffmpeg.sh` | ✅ SAME | |
| `flow/vmafOptimization.js` | ✅ IN REPO | |
| `flow/vmafOptimizationAdvanced.js` | ✅ IN REPO | |
| `scripts/patch_*.py`, `remove_hard_sample_floor.py` | ✅ IN REPO | |

---

## Phase status

| Phase | Status |
|-------|--------|
| 1 — DB lib + backfill | ✅ DONE |
| 2 — Dual-write to SQLite | ✅ LIVE |
| 3 — Predictor + A/B validation | ✅ DONE |
| 4 — Integration (ACTING) | ✅ **PROMOTED TO ACTING** with 7 additional features |
| 5 — Feature accrual (grain/dark) | ⏳ Pending — needs batch runs |

---

## How to verify the next job's report

Look for these markers confirming the new logic is active:

```
Source CAMBI baseline: …  (encode-delta: …)     ← holdout self-comparison
[ACTING] Predictor-seeded                           ← selectBestParameters acting (not SHADOW)
[PREDICT] learned metadata importance              ← η² weights computed
Sequential sampling ON (randomised clip order)     ← calculateVMAF sequential
Sequential stop … at N clips                      ← early-stop triggered
vmaf_min>vmaf_max rows excluded: 107               ← data integrity filter
✓ Optimum bracketed by binding constraint           ← constraint-aware bracket (checkCQBracket)
Same-file history: N CQ(s) failed VMAF target       ← known-failed CQ avoidance (testEncodingParameters)
Same-file prior merged: N rows                      ← same-file re-encode prior (vmafpredict)
CQ RANGE EXHAUSTED (non-fatal)                      ← graceful fallback (checkCQRangeRetry)
GPU VMAF (libvmaf_cuda): available                  ← no HDR tonemap (calculateVMAF)
CAMBI(avg/p95/max)=…                                ← p95/worst-case CAMBI visible
Transcode watchdog: hard timeout …                  ← final-transcode watchdog active
=== Acquire GPU Pipeline Lock ===                   ← every retry/final-transcode entry passes through the lock
```

---

## Deployment reminder

Edit source in `/custom-cont-init.d/vmaf-plugin-patches/<name>/1.0.0/index.js`, then:
```bash
docker restart tdarr
```
The bind mount means both server and node plugin roots (`/app/server/Tdarr/Plugins/...` and
`/app/Tdarr_Node/assets/app/plugins/...`) pick up changes automatically after restart.

Verify DB:
```bash
docker exec tdarr node -e 'const d=require("/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js");const h=d.openDb();console.log(d.counts(h))'
```
Run predictor tests:
```bash
docker exec tdarr node /custom-cont-init.d/vmaf-plugin-patches/_lib/test_vmafpredict.js
```

---

## Next steps (priority order)

1. **Feature data accrual** — grain/luma/dark signals only on 5 jobs (0 with full curves). After a batch
   runs, re-run the autoresearch feature ablation.
2. **Backtest sequential sampler** — per-clip VMAF data (schema v5, `clip_vmafs`) now available.
   Run offline analysis to evaluate the stopping rule (mean CI, 1%-low coverage) against measured
   distributions and tune `SAMPLER_MAXN`, `SAMPLER_Z`, `SAMPLER_DELTA`.
3. **NVENC CPU overhead reduction** — if CPU load needs trimming: reduce `-rc-lookahead` from 48→24,
   or switch HDR tonemapping to a lighter filter.
4. **Archive legacy CSVs** — `vmaf_results.csv` (72,858 rows) and `vmaf_cq_learning.csv`; switch
   `analyze_vmaf_data.py` from `pd.read_csv` to `pd.read_sql`.

---

## Gotchas

- `node:sqlite` is built-in (Node 24); emits a harmless `ExperimentalWarning` to stderr.
- Schema evolution is migration-only (`ALTER TABLE ADD COLUMN` + bump `user_version`); never reorder/drop columns.
- **DB handle is process-cached and must NOT be closed.** `openDb()` returns a handle cached for the Node
  process's lifetime. Closing it corrupts the cache — every subsequent `openDb()` returns a dead handle
  and the predictor silently fails with "database is not open". The handle now self-heals (probes with
  `SELECT 1` before returning), but the correct pattern is to never close it at all.
- `getSimilarSweepCurves` now excludes rows where `vmaf_min > vmaf_max` or `vmaf_mean` is outside
  `[vmaf_min, vmaf_max]` by default — these were ~92% of historical rows due to CSV column drift.
- If two GPU workers appear to bypass the lock, inspect the live flow edges — stale direct edges can coexist with lock nodes. Required entries are `retry1:1→gpuLockAcquire1`, `checkCQBracket:2→gpuLockAcquire1`, and `monitorRetry1:1→gpuLockAcquireTranscode1`; there must be no direct `retry1→test1`, `checkCQBracket→test1`, or `monitorRetry1→transcode1`.
- For live flow edits, prefer Tdarr's `/api/v2/cruddb` on port 8266 and back up the flow JSON first. Direct SQLite opens from sidecar scripts can fail with `unable to open database file` while Tdarr owns the DB.
- Full design doc: `C:\\Users\\seb_m\\.claude\\plans\\shimmying-beaming-hamster.md`.
