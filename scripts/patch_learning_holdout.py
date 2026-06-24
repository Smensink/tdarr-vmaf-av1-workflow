#!/usr/bin/env python3
"""Patch learnCQRange, extractVideoSamples, selectBestParameters:
 1. Adaptive bracket width (confidence -> width mapping)
 2. Holdout sample tagging in extractVideoSamples
 3. CAMBI tiebreaker + holdout validation in selectBestParameters
Backs up originals with .bak-TIMESTAMP suffix.
"""
import re, shutil
from pathlib import Path

BASE = Path(r'C:\Users\seb_m\tdarr\custom-cont-init.d\vmaf-plugin-patches')
TS   = '20260619-023000'

def read(p):
    return Path(p).read_text(encoding='utf-8')

def write(p, text):
    Path(p).write_text(text, encoding='utf-8')

def backup(p):
    shutil.copy2(p, p.with_suffix(p.suffix + f'.bak-{TS}'))

# ──────────────────────────────────────────────────────────────
# 1. learnCQRange — adaptive bracket width
# ──────────────────────────────────────────────────────────────
print('[1] learnCQRange adaptive bracket width')
p = BASE / 'learnCQRange/1.0.0/index.js'
backup(p)
s = read(p)

# Match the block with flexible whitespace: blank lines may contain spaces
pattern = (
    r'(estCQ = Math\.max\(16, Math\.min\(51, estCQ\);)\n'
    r'\s*bracketMin = Math\.max\(16, Math\.round\(estCQ - Math\.ceil\(defaultWidth / 2\)\);\n'
    r'\s*bracketMax = Math\.min\(51, Math\.round\(estCQ \+ Math\.ceil\(defaultWidth / 2\)\);\n'
    r'\s*\n'
    r'\s*var probeSet = \[\];\n'
    r'\s*var mid = Math\.round\(\(bracketMin \+ bracketMax\) / 2\);'
)
replacement = (
    r'\1\n'
    r'        var conf = (estimatedCqConfidence !== null && isFinite(estimatedCqConfidence))\n'
    r'            ? Math.max(0, Math.min(1, estimatedCqConfidence)) : 0.4;\n'
    r'        var adaptiveWidth = Math.max(4, Math.min(8, Math.round(10 - conf * 6)));\n'
    r'        bracketMin = Math.max(16, Math.round(estCQ - Math.ceil(adaptiveWidth / 2)));\n'
    r'        bracketMax = Math.min(51, Math.round(estCQ + Math.ceil(adaptiveWidth / 2)));\n\n'
    r'        var probeSet = [];\n'
    r'        var mid = Math.round((bracketMin + bracketMax) / 2);'
)
s2, n = re.subn(pattern, replacement, s)
if n == 0:
    print(f'  WARNING: pattern not found in learnCQRange (already patched?)')
else:
    print(f'  Applied {n} replacement(s)')
s = s2
write(p, s)

# ──────────────────────────────────────────────────────────────
# 2. extractVideoSamples — holdout tagging
# ──────────────────────────────────────────────────────────────
print('\n[2] extractVideoSamples holdout tagging')
p = BASE / 'extractVideoSamples/1.0.0/index.js'
backup(p)
s = read(p)

pattern2 = (
    r"args\.jobLog\('Sampling strategy: ' \+ \(stratified \? 'stratified' : 'uniform'\)\);\n"
    r"args\.jobLog\('Total samples to extract: ' \+ numSegments\);\n\n"
    r"if \(segments\.length === 0\) \{"
)
replacement2 = (
    "args.jobLog('Sampling strategy: ' + (stratified ? 'stratified' : 'uniform'));\n"
    "args.jobLog('Total samples to extract: ' + numSegments);\n\n"
    "var holdoutSample = null;\n"
    "try {\n"
    "    var riskStream = getVideoStream(args.inputFileObj);\n"
    "    var rw = riskStream ? Number(riskStream.width || 0) : 0;\n"
    "    var rh = riskStream ? Number(riskStream.height || 0) : 0;\n"
    "    var rhdr = args.variables.isHDR === true || args.variables.vmafIsHDR === true;\n"
    "    var rgenre = String(args.variables.vmafMediaGenre || '').toLowerCase();\n"
    "    var ranim = args.variables.vmafMediaIsAnimation === true\n"
    "        || String(args.variables.vmafMediaIsAnimation).toLowerCase() === 'true'\n"
    "        || rgenre.indexOf('animation') !== -1 || rgenre.indexOf('anime') !== -1;\n"
    "    var isHoldoutWorthy = !ranim && (rw >= 3800 || rh >= 1800 || (rw >= 1700 && rhdr));\n"
    "    if (isHoldoutWorthy && segments.length >= 3) {\n"
    "        holdoutSample = segments.pop();\n"
    "        args.jobLog('Holdout reserved: seg ' + holdoutSample.segmentIndex\n"
    "            + ' at ' + holdoutSample.startTime.toFixed(1) + 's (post-sel validation)');\n"
    "    }\n"
    "} catch (hoErr) {\n"
    "    args.jobLog('Holdout skip: ' + (hoErr && hoErr.message ? hoErr.message : String(hoErr)));\n"
    "}\n"
    "args.variables.vmafHoldoutSample = holdoutSample;\n\n"
    "if (segments.length === 0) {"
)
s2, n2 = re.subn(pattern2, replacement2, s)
if n2 == 0:
    print(f'  WARNING: pattern not found in extractVideoSamples (already patched?)')
else:
    print(f'  Applied {n2} replacement(s)')
s = s2
write(p, s)

# ──────────────────────────────────────────────────────────────
# 3. selectBestParameters — CAMBI tiebreaker + holdout validation
# ──────────────────────────────────────────────────────────────
print('\n[3] selectBestParameters — CAMBI tiebreaker + holdout validation')
p = BASE / 'selectBestParameters/1.0.0/index.js'
backup(p)
s = read(p)

# 3a: CAMBI tiebreaker in eligible check
pat3a = (
    r'(var eligible = lcb >= targetVMAF && floorOk;)\n'
    r'(\s+)(args\.jobLog\(cand\.parameterSetId)'
)
rep3a = (
    r'\1\n'
    r'\2if (eligible && bestParams && lcb >= bestParams.lcb - 0.3) {\n'
    r'\2    var cw = Math.max(Number(cand.avgCAMBI||0), Number(cand.p95CAMBI||0));\n'
    r'\2    var bw = Math.max(Number(bestParams.avgCAMBI||0), Number(bestParams.p95CAMBI||0));\n'
    r'\2    if (cw < bw - 0.1) {\n'
    r'\2        args.jobLog(\'  CAMBI tiebreak: \' + cand.parameterSetId\n'
    r'\2            + \' (CAMBI \' + cw.toFixed(2) + \' < \' + bw.toFixed(2) + \')\');\n'
    r'\2        bestParams = cand;\n'
    r'\2        eligible = false;\n'
    r'\2    }\n'
    r'\2}\n'
    r'\2\3'
)
s2, n3a = re.subn(pat3a, rep3a, s)
if n3a == 0:
    print(f'  WARNING: 3a pattern not found')
else:
    print(f'  3a CAMBI tiebreaker: {n3a} replacement(s)')
s = s2

# 3b: Store lcb on cand before the if (!bestParams) check
s = re.sub(
    r'\n(if \(eligible && !bestParams\) \{)',
    r'\ncand.lcb = lcb;\n            \1',
    s
)

# 3c: CAMBI_worst in the candidate log
s = s.replace(
    "+ (eligible ? ' [eligible]' : ''));",
    "+ (eligible ? ' [eligible]' : '')\n                + (cand.avgCAMBI !== null && cand.avgCAMBI !== undefined\n                    ? ' CAMBI_w=' + Math.max(Number(cand.avgCAMBI||0),Number(cand.p95CAMBI||0)).toFixed(3) : ''));"
)

# 3d: Holdout runner helper function — insert before estimateCandidateSizeMetrics
holdout_fn = '''    function runVmafOnHoldout(args, holdoutSeg, selectedCQ) {
        var fs = require('fs');
        var spawnSync = require('child_process').spawnSync;
        var ffmpegBin = 'tdarr-ffmpeg';
        var cacheDir = '/tmp';
        var ts = Date.now();
        var logFile = cacheDir + '/holdout_vmaf_' + ts + '.json';
        var srcPath = args.inputFileObj ? (args.inputFileObj.file || '') : '';
        if (!srcPath) return null;
        var refPath = cacheDir + '/holdout_ref_' + ts + '.yuv';
        var disPath = cacheDir + '/holdout_dis_' + ts + '.yuv';
        var startT = holdoutSeg.startTime || 0;
        var dur = holdoutSeg.duration || 5;
        var w = holdoutSeg.width || 1920;
        var h = holdoutSeg.height || 1080;
        var isHdr = !!(args.variables.isHDR || args.variables.vmafIsHDR);
        var pixFmt = isHdr ? 'yuv420p10le' : 'yuv420p';
        var modelPath = (w >= 3840 || h >= 2160)
            ? '/usr/local/share/model/vmaf_4k_v0.6.1.json'
            : '/usr/local/share/model/vmaf_v0.6.1.json';
        var scaleVaapi = ',scale_vaapi=w=' + w + ':h=' + h + ':format=' + pixFmt;
        var refCmd = ffmpegBin + ' -ss ' + startT + ' -i "' + srcPath + '"'
            + ' -t ' + dur + ' -vf "setpts=PTS-STARTPTS,format=' + pixFmt + scaleVaapi + '"'
            + ' -pix_fmt ' + pixFmt + ' -f yuv4mpegpipe -quiet -y "' + refPath + '"';
        var disCmd = ffmpegBin + ' -ss ' + startT + ' -i "' + srcPath + '"'
            + ' -t ' + dur + ' -vf "setpts=PTS-STARTPTS,libsvtav1=crf=' + selectedCQ
            + ':preset=6:tiled_threading=0:film-grain=0,format=' + pixFmt + '"'
            + ' -pix_fmt ' + pixFmt + ' -f yuv4mpegpipe -quiet -y "' + disPath + '"';
        var vmafCmd = ffmpegBin + ' -s ' + w + 'x' + h + ' -pix_fmt ' + pixFmt
            + ' -i "' + refPath + '" -s ' + w + 'x' + h + ' -pix_fmt ' + pixFmt
            + ' -i "' + disPath + '"'
            + ' -filter_complex "[0:v][1:v]libvmaf=log_path=' + logFile
            + ':log_fmt=json:feature=name=cambi:model=path=' + modelPath
            + ':shortest=1:repeatlast=0" -f null - 2>&1';
        try { spawnSync(refCmd, [], {timeout:120, stdio:['ignore','pipe','pipe']}); } catch(e) {}
        try { spawnSync(disCmd, [], {timeout:120, stdio:['ignore','pipe','pipe']}); } catch(e) {}
        try { spawnSync(vmafCmd, [], {timeout:120, stdio:['ignore','pipe','pipe']}); } catch(e) {}
        if (!fs.existsSync(logFile)) {
            try { fs.unlinkSync(refPath); } catch(e) {}
            try { fs.unlinkSync(disPath); } catch(e) {}
            return null;
        }
        var raw = '';
        try { raw = fs.readFileSync(logFile, 'utf8'); } catch(e) { return null; }
        var json = null;
        try { json = JSON.parse(raw); } catch(e) { return null; }
        var frames = (json && json.frames) ? json.frames : [];
        var cambiScores = [];
        var vmafScores = [];
        for (var fi = 0; fi < frames.length; fi++) {
            var fr = frames[fi];
            if (fr && fr.metrics) {
                if (typeof fr.metrics.vmaf === 'number') vmafScores.push(fr.metrics.vmaf);
                if (typeof fr.metrics.cambi === 'number') cambiScores.push(fr.metrics.cambi);
            }
        }
        if (vmafScores.length === 0) return null;
        vmafScores.sort(function(a, b) { return a - b; });
        cambiScores.sort(function(a, b) { return a - b; });
        var p1 = Math.min(vmafScores.length - 1, Math.max(0, Math.floor(0.01 * vmafScores.length)));
        var c95 = cambiScores.length > 0
            ? Math.min(cambiScores.length - 1, Math.max(0, Math.floor(0.95 * (cambiScores.length - 1)))) : 0;
        var avgV = vmafScores.reduce(function(a, b) { return a + b; }, 0) / vmafScores.length;
        var result = {
            avgVMAF: avgV,
            vmafP1: vmafScores[p1],
            cambiMean: cambiScores.length > 0
                ? cambiScores.reduce(function(a, b) { return a + b; }, 0) / cambiScores.length : 0,
            cambiP95: cambiScores.length > 0 ? cambiScores[c95] : 0
        };
        try { fs.unlinkSync(refPath); } catch(e) {}
        try { fs.unlinkSync(disPath); } catch(e) {}
        try { fs.unlinkSync(logFile); } catch(e) {}
        return result;
    }

'''
# Insert before estimateCandidateSizeMetrics
s = s.replace(
    '    function estimateCandidateSizeMetrics(candidate, policy) {\n        var sampleMB = Number(candidate.avgFileSizeMB || 0);',
    holdout_fn + '    function estimateCandidateSizeMetrics(candidate, policy) {\n        var sampleMB = Number(candidate.avgFileSizeMB || 0);'
)

# 3e: Holdout validation call — insert between the fallbackBest block and the final !bestParams check
holdout_validate = '''
    var holdoutFailReason = null;
    var holdoutSuggestedCQ = null;
    if (bestParams && args.variables.vmafHoldoutSample) {
        var ho = args.variables.vmafHoldoutSample;
        var chosenCQ = Number(bestParams.parameterSet ? bestParams.parameterSet.quality : (bestParams.cq || 28));
        args.jobLog('');
        args.jobLog('=== Holdout Validation ===');
        args.jobLog('Holdout seg ' + ho.segmentIndex + ' at ' + (ho.startTime||0).toFixed(1)
            + 's — validating CQ ' + chosenCQ);
        try {
            var hoData = runVmafOnHoldout(args, ho, chosenCQ);
            if (hoData) {
                var hoV  = Number(hoData.avgVMAF)    || 0;
                var hoP1 = Number(hoData.vmafP1)    || 0;
                var hoCM = Number(hoData.cambiMean)  || 0;
                var hoCP = Number(hoData.cambiP95)   || 0;
                var hoCW = Math.max(hoCM, hoCP);
                var policy     = args.variables.vmafQualityRiskPolicy;
                var meanFloor  = policy ? policy.meanFloor          : adjustedMinVMAF;
                var frameFloor = policy ? policy.adaptiveFrameFloor  : adjustedMinFrameVMAF;
                var cambiLimit = policy
                    ? (policy.isHDR ? 4.0 : (policy.isAnimation ? 5.0 : 4.5))
                    : 4.5;
                args.jobLog('Holdout: VMAF=' + hoV.toFixed(2)
                    + ', 1%-low=' + hoP1.toFixed(2)
                    + ', CAMBI=' + hoCM.toFixed(3) + ' (p95=' + hoCP.toFixed(3) + ')');
                var vmafOk  = hoV  >= meanFloor;
                var floorOk = hoP1 >= frameFloor;
                var cambiOk = hoCW <= cambiLimit;
                args.jobLog('  Floors: VMAF>=' + meanFloor.toFixed(1)
                    + ', 1%-low>=' + frameFloor.toFixed(1)
                    + ', CAMBI<=' + cambiLimit.toFixed(1)
                    + ' => ' + (vmafOk?'OK':'FAIL') + '/' + (floorOk?'OK':'FAIL') + '/' + (cambiOk?'OK':'FAIL'));
                if (!vmafOk || !floorOk || !cambiOk) {
                    var safeCQ = Math.min(51, chosenCQ + 2);
                    holdoutFailReason  = 'vmaf=' + vmafOk + ',floor=' + floorOk + ',cambi=' + cambiOk;
                    holdoutSuggestedCQ = safeCQ;
                    args.jobLog('Holdout FAILED — pushing CQ ' + chosenCQ + ' -> ' + safeCQ);
                    if (bestParams.parameterSet) bestParams.parameterSet.quality = safeCQ;
                    args.jobLog('Holdout-validated CQ: ' + safeCQ);
                } else {
                    args.jobLog('Holdout PASSED');
                }
            } else {
                args.jobLog('Holdout returned no data — proceeding with chosen CQ');
            }
        } catch (hoErr) {
            args.jobLog('Holdout error (proceeding): ' + (hoErr && hoErr.message ? hoErr.message : String(hoErr)));
        }
    }
    args.variables.vmafHoldoutFailReason = holdoutFailReason;
    args.variables.vmafHoldoutSuggestedCQ = holdoutSuggestedCQ;
'''
s = s.replace(
    '''    if (!bestParams && fallbackBest) {
        args.jobLog('No candidate clears the lower confidence bound; using highest passing CQ '
            + fallbackBest.parameterSet.quality + ' (mean cleared the target but confidence is thin)');
        bestParams = fallbackBest;
    }

    if (!bestParams) {''',
    '''    if (!bestParams && fallbackBest) {
        args.jobLog('No candidate clears the lower confidence bound; using highest passing CQ '
            + fallbackBest.parameterSet.quality + ' (mean cleared the target but confidence is thin)');
        bestParams = fallbackBest;
    }
''' + holdout_validate + '''
    if (!bestParams) {'''
)

write(p, s)

# ──────────────────────────────────────────────────────────────
# Verification
# ──────────────────────────────────────────────────────────────
print('\n[Verification]')
checks = [
    ('learnCQRange',          'adaptiveWidth',             BASE / 'learnCQRange/1.0.0/index.js'),
    ('extractVideoSamples',   'vmafHoldoutSample',        BASE / 'extractVideoSamples/1.0.0/index.js'),
    ('extractVideoSamples',   'segments.pop()',           BASE / 'extractVideoSamples/1.0.0/index.js'),
    ('selectBestParameters',  'CAMBI tiebreak',            BASE / 'selectBestParameters/1.0.0/index.js'),
    ('selectBestParameters',  'cand.lcb',                 BASE / 'selectBestParameters/1.0.0/index.js'),
    ('selectBestParameters',  'CAMBI_w=',                  BASE / 'selectBestParameters/1.0.0/index.js'),
    ('selectBestParameters',  'function runVmafOnHoldout', BASE / 'selectBestParameters/1.0.0/index.js'),
    ('selectBestParameters',  'Holdout Validation',       BASE / 'selectBestParameters/1.0.0/index.js'),
    ('selectBestParameters',  'vmafHoldoutFailReason',    BASE / 'selectBestParameters/1.0.0/index.js'),
]
all_ok = True
for label, needle, path in checks:
    s = read(path)
    ok = needle in s
    if not ok: all_ok = False
    print(f'  [{("OK" if ok else "FAIL"):4}] {label}: {needle}')

print(f'\nAll OK: {all_ok}')
print(f'Backups: *.bak-{TS}')
