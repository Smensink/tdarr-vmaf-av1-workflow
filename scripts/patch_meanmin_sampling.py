#!/usr/bin/env python3
"""
Implement mean-min adaptive sample-count targeting in extractVideoSamples,
and add aggregated_vmaf_mean_min_gap column to exportVMAFResults.

Surgical string edits only (buildFeaturesFor / predict left untouched).
Single-copy file assumed (verified before running).
"""
import shutil, time, subprocess, sys
from pathlib import Path

BASE = Path(r'C:\Users\seb_m\tdarr\custom-cont-init.d\vmaf-plugin-patches')
TS = time.strftime('%Y%m%d-%H%M%S')

def backup(p):
    dst = p.with_suffix(p.suffix + f'.bak-{TS}')
    shutil.copy2(p, dst)
    print(f'  backed up -> {dst.name}')

def read(p):
    return Path(p).read_text(encoding='utf-8')

def write(p, txt):
    Path(p).write_text(txt, encoding='utf-8')

def replace_once(s, old, new, label):
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'ABORT [{label}]: expected exactly 1 match, found {n}')
    return s.replace(old, new, 1)

# ============================================================
# 1. extractVideoSamples
# ============================================================
print('[extractVideoSamples]')
p = BASE / 'extractVideoSamples/1.0.0/index.js'
s = read(p)

# Guard: must be single copy
if s.count('exports.plugin = plugin') != 1:
    raise SystemExit('ABORT: extractVideoSamples is not single-copy; fix duplication first')

backup(p)

# --- Edit 1: function signature add targetMode ---
s = replace_once(
    s,
    'function loadSampleStdModel(csvPath, filters, maxLines) {',
    'function loadSampleStdModel(csvPath, filters, maxLines, targetMode) {',
    'sig'
)

# --- Edit 2: add mean/min column lookups after stdIdx ---
s = replace_once(
    s,
    "var stdIdx = idx('aggregated_vmaf_stddev');\n\n        var countIdx = idx('aggregated_sample_count');",
    "var stdIdx = idx('aggregated_vmaf_stddev');\n\n        var meanIdx = idx('aggregated_vmaf_mean');\n\n        var minIdx = idx('aggregated_vmaf_min');\n\n        var countIdx = idx('aggregated_sample_count');",
    'colidx'
)

# --- Edit 3: mode-aware guard ---
s = replace_once(
    s,
    'if (stdIdx === -1 || countIdx === -1) return null;',
    "if (targetMode === 'meanmin') {\n\n            if (meanIdx === -1 || minIdx === -1 || countIdx === -1) return null;\n\n        } else {\n\n            if (stdIdx === -1 || countIdx === -1) return null;\n\n        }",
    'guard'
)

# --- Edit 4: compute target value per mode (gap vs stddev) ---
s = replace_once(
    s,
    "var stdVal = parseFloat(cols[stdIdx]);\n\n            var nVal = parseInt(cols[countIdx]) || 0;\n\n            if (isNaN(stdVal) || nVal <= 0) continue;",
    ("var nVal = parseInt(cols[countIdx]) || 0;\n\n"
     "            var stdVal;\n\n"
     "            if (targetMode === 'meanmin') {\n\n"
     "                var mv = meanIdx !== -1 ? parseFloat(cols[meanIdx]) : NaN;\n\n"
     "                var mnv = minIdx !== -1 ? parseFloat(cols[minIdx]) : NaN;\n\n"
     "                stdVal = (isFinite(mv) && isFinite(mnv)) ? Math.max(0, mv - mnv) : NaN;\n\n"
     "            } else {\n\n"
     "                stdVal = parseFloat(cols[stdIdx]);\n\n"
     "            }\n\n"
     "            if (isNaN(stdVal) || nVal <= 0) continue;"),
    'targetval'
)

# --- Edit 5: targetStd config + mode vars ---
s = replace_once(
    s,
    'var targetStd = 1.5;',
    ("var legacyTargetStd = 1.5;\n\n"
     "            var adaptiveMode = (String(args.inputs.adaptiveTargetMode || 'meanmin').toLowerCase() === 'stddev') ? 'stddev' : 'meanmin';\n\n"
     "            var deltaThreshold = Number(args.inputs.meanMinDeltaThreshold);\n\n"
     "            if (isNaN(deltaThreshold) || deltaThreshold <= 0) deltaThreshold = 0.2;\n\n"
     "            var coverageFraction = Number(args.inputs.meanMinCoverageFraction);\n\n"
     "            if (isNaN(coverageFraction) || coverageFraction <= 0 || coverageFraction > 1) coverageFraction = 0.6;"),
    'cfgvars'
)

# --- Edit 6: model call gains targetMode + parallel std model for logging ---
old_model_call = ('var model = loadSampleStdModel(resultsCsvPath, {\n\n'
                  '                resTier: sourceTier,\n\n'
                  '                codecCat: codecCategory(sourceCodec),\n\n'
                  '                isHDR: parseBool(args.variables.isHDR),\n\n'
                  '                isAnimation: currentIsAnimation,\n\n'
                  '                width: sourceWidth,\n\n'
                  '                height: sourceHeight,\n\n'
                  '                genresLower: currentGenresLower,\n\n'
                  '                sourceType: currentSourceType\n\n'
                  '            }, 4000);')
new_model_call = ('var adaptiveFilterObj = {\n\n'
                  '                resTier: sourceTier,\n\n'
                  '                codecCat: codecCategory(sourceCodec),\n\n'
                  '                isHDR: parseBool(args.variables.isHDR),\n\n'
                  '                isAnimation: currentIsAnimation,\n\n'
                  '                width: sourceWidth,\n\n'
                  '                height: sourceHeight,\n\n'
                  '                genresLower: currentGenresLower,\n\n'
                  '                sourceType: currentSourceType\n\n'
                  '            };\n\n'
                  '            var model = loadSampleStdModel(resultsCsvPath, adaptiveFilterObj, 4000, adaptiveMode);\n\n'
                  "            var stdModelForLog = (adaptiveMode === 'meanmin') ? loadSampleStdModel(resultsCsvPath, adaptiveFilterObj, 4000, 'stddev') : null;")
s = replace_once(s, old_model_call, new_model_call, 'modelcall')

# --- Edit 7: replace the selection for-loop with combined Option A + B logic ---
old_select = ("for (var n = minSegments; n <= maxSegments; n++) {\n\n"
              "                    var pred = predict(n);\n\n"
              "                    if (pred <= targetStd) {\n\n"
              "                        chosen = { n: n, pred: pred };\n\n"
              "                        break;\n\n"
              "                    }\n\n"
              "                }\n\n"
              "                if (!chosen) {\n\n"
              "                    var predMax = predict(maxSegments);\n\n"
              "                    chosen = { n: maxSegments, pred: predMax };\n\n"
              "                }\n\n"
              "                numSegments = chosen.n;\n\n"
              "                args.variables.vmafAdaptiveSampleReason = 'Learned target std<= ' + targetStd + ' (pred=' + chosen.pred.toFixed(3) + ', model from ' + model.count + ' rows, rmse=' + fitRmseStr + ')';\n\n"
              "                args.jobLog('Adaptive samples (learned): ' + numSegments + ' samples (was ' + originalNum + '), model count ' + model.count + ', predicted std ' + chosen.pred.toFixed(3) + ', fit rmse ' + fitRmseStr);\n\n"
              "            ")

new_select = (
"                if (adaptiveMode === 'meanmin') {\n\n"
"                    // Mean-min gap targeting: choose N where (A) the gap curve has stabilised\n\n"
"                    // (marginal growth < deltaThreshold) AND (B) we have covered enough of the\n\n"
"                    // quality-floor headroom. Take the max of the two so both are satisfied.\n\n"
"                    var hdrNow = parseBool(args.variables.isHDR);\n\n"
"                    var animNow = currentIsAnimation === true;\n\n"
"                    var pxNow = sourceWidth * sourceHeight;\n\n"
"                    var tierFloor;\n\n"
"                    if (pxNow >= 3800 * 1800) tierFloor = animNow ? 88.5 : (hdrNow ? 90.5 : 90.0);\n\n"
"                    else if (pxNow >= 2500 * 1300) tierFloor = animNow ? 88.5 : (hdrNow ? 90.0 : 89.5);\n\n"
"                    else if (pxNow >= 1700 * 900) tierFloor = animNow ? 88.0 : (hdrNow ? 89.5 : 89.0);\n\n"
"                    else if (pxNow >= 1100 * 650) tierFloor = animNow ? 87.5 : 88.5;\n\n"
"                    else tierFloor = animNow ? 86.0 : 87.0;\n\n"
"                    var targetMeanVmaf = Number(args.variables.vmafMinVMAF) || Number(args.inputs.targetMinVMAF) || 95;\n\n"
"                    var headroom = Math.max(1.0, targetMeanVmaf - tierFloor);\n\n"
"                    var coverageTargetGap = headroom * coverageFraction;\n\n"
"                    var preds = {};\n\n"
"                    for (var nn = minSegments; nn <= maxSegments; nn++) preds[nn] = Math.max(0, predict(nn));\n\n"
"                    var knee = null;\n\n"
"                    for (var na = minSegments; na < maxSegments; na++) {\n\n"
"                        if ((preds[na + 1] - preds[na]) < deltaThreshold) { knee = na; break; }\n\n"
"                    }\n\n"
"                    if (knee === null) knee = maxSegments;\n\n"
"                    var cover = null;\n\n"
"                    for (var nb = minSegments; nb <= maxSegments; nb++) {\n\n"
"                        if (preds[nb] >= coverageTargetGap) { cover = nb; break; }\n\n"
"                    }\n\n"
"                    if (cover === null) cover = maxSegments;\n\n"
"                    var combinedN = Math.max(knee, cover);\n\n"
"                    combinedN = Math.max(minSegments, Math.min(maxSegments, combinedN));\n\n"
"                    chosen = { n: combinedN, pred: preds[combinedN] };\n\n"
"                    numSegments = combinedN;\n\n"
"                    var stdNote = '';\n\n"
"                    if (stdModelForLog && stdModelForLog.beta) {\n\n"
"                        var sf = buildFeaturesFor(combinedN);\n\n"
"                        var sp = 0;\n\n"
"                        for (var si2 = 0; si2 < stdModelForLog.beta.length && si2 < sf.length; si2++) sp += stdModelForLog.beta[si2] * sf[si2];\n\n"
"                        stdNote = ', legacy std pred=' + sp.toFixed(3);\n\n"
"                    }\n\n"
"                    args.variables.vmafAdaptiveSampleReason = 'Mean-min adaptive: knee N=' + knee + ', coverage N=' + cover + ' (targetGap=' + coverageTargetGap.toFixed(2) + ' VMAF, floor=' + tierFloor.toFixed(1) + ', headroom=' + headroom.toFixed(1) + '), predicted gap@N=' + preds[combinedN].toFixed(2) + ', rows=' + model.count + ', rmse=' + fitRmseStr;\n\n"
"                    args.jobLog('Adaptive samples (mean-min): ' + numSegments + ' samples (was ' + originalNum + '); knee N=' + knee + ', coverage N=' + cover + ', targetGap=' + coverageTargetGap.toFixed(2) + ' VMAF, predicted gap@N=' + preds[combinedN].toFixed(2) + ', rows=' + model.count + ', rmse=' + fitRmseStr + stdNote);\n\n"
"                } else {\n\n"
"                    for (var n = minSegments; n <= maxSegments; n++) {\n\n"
"                        var pred = predict(n);\n\n"
"                        if (pred <= legacyTargetStd) { chosen = { n: n, pred: pred }; break; }\n\n"
"                    }\n\n"
"                    if (!chosen) { var predMax = predict(maxSegments); chosen = { n: maxSegments, pred: predMax }; }\n\n"
"                    numSegments = chosen.n;\n\n"
"                    args.variables.vmafAdaptiveSampleReason = 'Learned target std<= ' + legacyTargetStd + ' (pred=' + chosen.pred.toFixed(3) + ', model from ' + model.count + ' rows, rmse=' + fitRmseStr + ')';\n\n"
"                    args.jobLog('Adaptive samples (learned std): ' + numSegments + ' samples (was ' + originalNum + '), model count ' + model.count + ', predicted std ' + chosen.pred.toFixed(3) + ', fit rmse ' + fitRmseStr);\n\n"
"                }\n\n"
"            ")
s = replace_once(s, old_select, new_select, 'select')

write(p, s)
print('  wrote extractVideoSamples')

# ============================================================
# 2. exportVMAFResults — add aggregated_vmaf_mean_min_gap column
# ============================================================
print('[exportVMAFResults]')
p2 = BASE / 'exportVMAFResults/1.0.0/index.js'
s2 = read(p2)
if s2.count('exports.plugin') < 1:
    raise SystemExit('ABORT: exportVMAFResults missing exports')
backup(p2)

# 2a: header — add column right after aggregated_vmaf_stddev
s2 = replace_once(
    s2,
    "'aggregated_avg_size_mb', 'aggregated_sample_count', 'aggregated_vmaf_stddev',",
    "'aggregated_avg_size_mb', 'aggregated_sample_count', 'aggregated_vmaf_stddev', 'aggregated_vmaf_mean_min_gap',",
    'hdr'
)

# 2b: per-sample row — placeholder cell after the stddev placeholder
s2 = replace_once(
    s2,
    "            '', // aggregated_vmaf_stddev\n            strategy,",
    "            '', // aggregated_vmaf_stddev\n            '', // aggregated_vmaf_mean_min_gap\n            strategy,",
    'row1ph'
)

# 2c: fill the per-sample aggregated cell (after row[49] = vmafStdDev)
s2 = replace_once(
    s2,
    "                row[49] = aggregatedResults[a].vmafStdDev || '';\n                break;",
    ("                row[49] = aggregatedResults[a].vmafStdDev || '';\n"
     "                var _mean = aggregatedResults[a].avgVMAFMean;\n"
     "                var _min = aggregatedResults[a].minVMAF;\n"
     "                row[50] = (typeof _mean === 'number' && typeof _min === 'number') ? Math.max(0, _mean - _min) : '';\n"
     "                break;"),
    'row1fill'
)

# 2d: aggregated-only row (no individual samples) — add gap cell after vmafStdDev
s2 = replace_once(
    s2,
    "                aggResult.vmafStdDev || '',\n                strategy,",
    ("                aggResult.vmafStdDev || '',\n"
     "                (typeof aggResult.avgVMAFMean === 'number' && typeof aggResult.minVMAF === 'number') ? Math.max(0, aggResult.avgVMAFMean - aggResult.minVMAF) : '',\n"
     "                strategy,"),
    'row2fill'
)

write(p2, s2)
print('  wrote exportVMAFResults')

# ============================================================
# Syntax check both
# ============================================================
print('\n[syntax check]')
for rel in ['extractVideoSamples/1.0.0/index.js', 'exportVMAFResults/1.0.0/index.js']:
    fp = BASE / rel
    r = subprocess.run(['node', '--check', str(fp)], capture_output=True, text=True)
    status = 'OK' if r.returncode == 0 else 'BROKEN'
    print(f'  {rel}: {status}')
    if r.returncode != 0:
        print(r.stderr[:500])
        sys.exit(1)

print(f'\nDONE. Backups: *.bak-{TS}')
