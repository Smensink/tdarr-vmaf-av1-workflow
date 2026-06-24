# Tdarr VMAF/AV1 System — Change Handoff (as of 2026-06-25)

## TL;DR current state

Phase 4 A/B-shadow has been **promoted to ACTING** — the learned predictor (η² feature weights, sequential
sampling, self-comparing holdout CAMBI) is now making real CQ decisions. A data-integrity sweep also recovered
17,849 corrupted aggregate rows from the CSV→DB backfill. GPU VMAF fallback is **not occurring** — the high-CPU
is from NVENC quality-maximising settings, not VMAF slow paths.

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

## File inventory — live vs repo

| Path | Status | Notes |
|------|--------|-------|
| `_lib/vmafdb.js` | ❌ DIFF +2,175B | Schema v4; `getSimilarSweepCurves` filters impossible rows by default |
| `_lib/vmafpredict.js` | ❌ DIFF +12,123B | `learnFeatureWeights` (η²), `correlationRatio`, plausibility-bounded sigma, sequential sampling support |
| `_lib/backfill_metadata.js` | 🆕 NEW | Not previously in repo |
| `_lib/recover_sweep_aggregates.js` | 🆕 NEW | Not previously in repo |
| `calculateVMAF/1.0.0/index.js` | ❌ DIFF +5,643B | Sequential sampling, per-file sigma, kill-switch |
| `extractVideoSamples/1.0.0/index.js` | ❌ DIFF +7,979B | Holdout CAMBI fix, no_variance_data sigma bounding |
| `testEncodingParameters/1.0.0/index.js` | ❌ DIFF +2,802B | CAMBI delta gating |
| `selectBestParameters/1.0.0/index.js` | ❌ DIFF +6,299B | ACTING mode (was SHADOW); learned weights in CQ pick |
| `exportVMAFResults/1.0.0/index.js` | ❌ DIFF +1,106B | DB dual-write refinements |
| `fetchMediaMetadata/1.0.0/index.js` | ❌ DIFF +664B | |
| `learnCQRange/1.0.0/index.js` | ❌ DIFF +272B | EMA state tracking |
| `learnCQRange/1.0.0/ema_cq_state.json` | 🆕 NEW | EMA state snapshot |
| `checkHdrContent/1.0.0/index.js` | ✅ SAME | |
| `vmafOptimization.js` | 🆕 NEW | Flow template (basic) |
| `vmafOptimizationAdvanced.js` | 🆕 NEW | Flow template (advanced) |
| `scripts/patch_*.py`, `remove_hard_sample_floor.py` | 🆕 NEW | Patch scripts |

---

## Phase status

| Phase | Status |
|-------|--------|
| 1 — DB lib + backfill | ✅ DONE |
| 2 — Dual-write to SQLite | ✅ LIVE |
| 3 — Predictor + A/B validation | ✅ DONE |
| 4 — Integration (SHADOW) | ✅ **PROMOTED TO ACTING** |
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
2. **Per-clip VMAF logging** — would let `selectSampleCount` use true per-file sigma at seed time
   (currently uses historical sigma initially, then updates post-measurement).
3. **NVENC CPU overhead reduction** — if CPU load needs trimming: reduce `-rc-lookahead` from 48→24,
   or switch HDR tonemapping to a lighter filter.
4. **Archive legacy CSVs** — `vmaf_results.csv` (72,858 rows) and `vmaf_cq_learning.csv`; switch
   `analyze_vmaf_data.py` from `pd.read_csv` to `pd.read_sql`.

---

## Gotchas

- `node:sqlite` is built-in (Node 24); emits a harmless `ExperimentalWarning` to stderr.
- Schema evolution is migration-only (`ALTER TABLE ADD COLUMN` + bump `user_version`); never reorder/drop columns.
- `getSimilarSweepCurves` now excludes rows where `vmaf_min > vmaf_max` or `vmaf_mean` is outside
  `[vmaf_min, vmaf_max]` by default — these were ~92% of historical rows due to CSV column drift.
- Full design doc: `C:\Users\seb_m\.claude\plans\shimmying-beaming-hamster.md`.
