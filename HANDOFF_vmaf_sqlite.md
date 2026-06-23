# Tdarr VMAF/AV1 System — Change Handoff (as of 2026-06-23)

TL;DR current state

A multi-phase migration of the adaptive-CQ learning system from two corruption-prone CSVs → one SQLite store, plus a
full predictor rewrite, is partly deployed. The live transcode behavior is UNCHANGED — new predictor runs in log-only
"A/B-shadow" mode. Data capture (dual-write to SQLite) is live.

- Host project root: C:\Users\seb_m\tdarr (Docker container tdarr, LinuxServer.io image).
- GPU: RTX 5070 Ti (Blackwell). Custom FFmpeg 8.1.1 + libvmaf CUDA. Container Node = v24.15.0.
- Flow "VMAF Parameter Optimization + stream reorder" (id YR5PZ1QaD). Target VMAF = 95.

Origin / why

A job ("andre") was rejected for high output CAMBI (banding). That expanded into: record source CAMBI and use it in CQ
selection → which exposed that the learning data lived in two CSVs that had repeatedly corrupted/culled each other → 
full move to SQLite + a rewrite of the CQ-sweep predictor with the goal of reaching the right CQ in the fewest test
transcodes.

New files — C:\Users\seb_m\tdarr\custom-cont-init.d\vmaf-plugin-patches\_lib\

(custom-cont-init.d is bind-mounted into the container at /custom-cont-init.d, so plugins require() these by absolute
path — no copy step.)

- vmafdb.js — SQLite data layer via built-in node:sqlite. Two tables: jobs (1 row/job: source facts + decision + 
outcome + source_cambi, bit_depth) and sweep_points (1 row/(job,CQ): the target-independent CQ→VMAF/CAMBI/size curve).
Schema versioned by PRAGMA user_version (currently v2); migrations are ALTER TABLE ADD COLUMN only (never drops
data). API: openDb(), upsertJob() (partial upsert by job_id), insertSweepPoints(), getSimilarSweepCurves(),
getSimilarJobs(), tierFor(), makeJobId(), counts().
- vmafpredict.js — the predictor. Key fns: predictCQCenter (sweep center via weighted median of similar jobs' optimal
CQ), nextSweepCQ (sequential controller: log-ceiling fit + binding-constraint root-finding), selectCQ (final 
constrained pick), selectSampleCount (CI-based), fitLogCeiling (VMAF=100−e^(a+b·cq)), fitRising (CAMBI vs cq),
effectiveCambiFloor (source-relative), bindingTargetCQ.
- backfill_vmaf_training_db.js — one-time backfill from both CSVs into the DB (already run).
- test_vmafpredict.js — unit tests (9, all pass).
- ab_vmafpredict.js, ab_sweepdomain.js, ab_convergence.js — analysis/backtest scripts (re-runnable).

Edited plugins (source of truth in custom-cont-init.d/vmaf-plugin-patches/<name>/1.0.0/index.js)

- extractVideoSamples — seeds shared args.variables.vmafJobId; earlier added a source-CAMBI→CQ slope model + 
target-VMAF-proximity weighting in the learned-CQ preload.
- learnCQRange — added source_cambi,source_cambi_p95 CSV columns; fixed the migration to PAD old rows instead of 
dropping them (this drop-on-mismatch bug had wiped history before); dual-writes the job OUTCOME to SQLite.
- exportVMAFResults — dual-writes the per-CQ sweep curve to SQLite including CAMBI, 1%-low VMAF, SSIM (signals the 
CSVs never stored) + job source/decision.
- testEncodingParameters — source-CAMBI heuristic made confidence-gated; [SHADOW] log of predictCQCenter + 
selectSampleCount vs live crfValues.
- selectBestParameters — [SHADOW] log of constraint-aware selectCQ pick vs live pick.

Data / DB (C:\Users\seb_m\tdarr\configs\)

- vmaf_training.db — the new store. 12,007 jobs / 19,500 sweep-curve points. Container path 
/app/configs/vmaf_training.db.
- vmaf_cq_learning.csv — recovered from 25 → 6,022 rows (merged backups). Still written (dual-write).
- vmaf_results.csv (72,858 rows) — still written. Legacy CSVs not yet archived.
- DO NOT run backfill_vmaf_cq_learning.py (stale 32-col schema; will truncate).

Validated algorithm (backtests on the 19,500-point DB)

1. Pooling history to predict absolute CQ is limited to ~MAE 3–4 (content variability) → history centers the sweep,
the per-job sweep finds the exact CQ.
2. Best center = weighted median of similar jobs' own optimal CQ (MAE 3.2).
3. CQ→VMAF curve is saturating; best monotone+invertible fit is VMAF=100−e^(a+b·cq) (RMSE 0.26 vs 0.33 linear).
4. Sequential root-finding on the file's own measured curve → converges in ~2–3 transcodes (vs ~6 for a static grid).
5. Sweep is constraint-aware: root-finds on whichever binds first — VMAF mean ≥ target, 1%-low ≥ floor,
source-relative CAMBI ≤ floor — so it won't converge to a CQ that then gets rejected (the andre fix).
6. Sample-count is CI-based but data-starved historically (only 1,857/19,500 points have usable vmaf_stddev); improves
as multi-sample dual-write accrues.

Deployment & verification

3-copy hot-deploy: edit source in custom-cont-init.d/..., then docker exec tdarr cp it to BOTH
/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf/<p>/1.0.0/index.js and
/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/vmaf/<p>/1.0.0/index.js. (Nodes periodically re-sync
plugins from the server, so the server copy must also be updated.)

Verify DB: docker exec tdarr node -e 'const d=require("/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js");const
h=d.openDb();console.log(d.counts(h))'
Watch shadow output: grep '\[SHADOW\]' /c/Users/seb_m/tdarr/logs/Tdarr_Node_Log.txt
Run predictor tests: docker exec tdarr node /custom-cont-init.d/vmaf-plugin-patches/_lib/test_vmafpredict.js

Phase status

- Phase 1 (DB lib + backfill): DONE.
- Phase 2 (dual-write to SQLite): LIVE.
- Phase 3 (predictor + A/B validation): DONE.
- Phase 4 (integration): A/B-SHADOW deployed (log-only, no behavior change). Not yet acting.

Next steps (not yet done)

1. Observe [SHADOW] lines on a few real jobs; confirm predictions are sane.
2. Flip plugins to ACT, one at a time: selectBestParameters uses selectCQ for the pick → testEncodingParameters seeds
crfValues from predictCQCenter → checkCQRangeRetry/checkCQBracket drive nextSweepCQ binding-constraint refinement.
3. Archive legacy CSVs; switch analyze_vmaf_data.py from pd.read_csv to pd.read_sql.

Gotchas

- node:sqlite is built-in (Node 24); emits a harmless ExperimentalWarning to stderr.
- Backfill needs PRAGMA synchronous=OFF (per-commit fsync is the bottleneck on the Windows bind mount).
- Schema evolution is migration-only (ALTER TABLE ADD COLUMN + bump user_version); never reorder/drop columns.
- Historical jobs from vmaf_results.csv (curves) and from vmaf_cq_learning.csv (outcomes) are NOT cross-linked (old 
CSVs shared no key); new jobs unify via vmafJobId.
- Full plan/design doc: C:\Users\seb_m\.claude\plans\shimmying-beaming-hamster.md.
