#!/usr/bin/env python3
"""Patch Tdarr VMAF plugins with:
1. CAMBI (Netflix banding metric) collection in calculateVMAF
2. Resolution/type-aware quality floors + output-size guards in selectBestParameters
3. Risk-aware sample count floors in extractVideoSamples
Backs up originals with .bak-TIMESTAMP suffix before each write.
"""
import re, shutil, time
from pathlib import Path

BASE = Path(r'C:\Users\seb_m\tdarr\custom-cont-init.d\vmaf-plugin-patches')
TS = time.strftime('%Y%m%d-%H%M%S')

def cp(src):
    dst = Path(str(src) + f'.bak-{TS}')
    shutil.copy2(src, dst)
    print(f'  backed up: {src.name} -> {dst.name}')

def read(path):
    return Path(path).read_text(encoding='utf-8', errors='replace').replace('\r\n', '\n')

def write(path, text):
    Path(path).write_text(text.replace('\n', '\r\n'), encoding='utf-8')

def sub(text, pattern, repl, label=''):
    """Regex or literal replace."""
    if isinstance(pattern, str):
        found = pattern in text
        if not found:
            raise SystemExit(f'NOT FOUND [{label}]: {repr(pattern[:80])}')
        return text.replace(pattern, repl, 1)
    m = re.search(pattern, text)
    if not m:
        raise SystemExit(f'NOT FOUND [{label}]: pattern {repr(str(pattern)[:80])}')
    return text[:m.start()] + repl + text[m.end():]

def rsub(text, pattern, repl, label=''):
    """Global regex replace."""
    n = 0
    def repl_fn(m):
        nonlocal n; n += 1
        return repl
    result, count = re.subn(pattern, repl_fn, text)
    if count == 0:
        raise SystemExit(f'NOT FOUND [{label}]: {repr(str(pattern)[:80])}')
    print(f'  regex [{label}]: {count} replacements')
    return result

# ──────────────────────────────────────────────────────────────
# 1. calculateVMAF — add CAMBI feature + parsing + aggregation
# ──────────────────────────────────────────────────────────────
print('\n[calculateVMAF]')
p = BASE / 'calculateVMAF/1.0.0/index.js'
cp(p)
s = read(p)

# Add CAMBI fields to per-sample result object
s = sub(s,
    '            vmafP1: null,\n            vmafScore: null\n        };',
    '            vmafP1: null,\n            vmafScore: null,\n            cambiMean: null,\n            cambiMax: null,\n            cambiP95: null\n        };',
    'result-fields')

# Parse per-frame CAMBI + pool 95th percentile
OLD_FRAME = r'''        // 1%-low from per-frame scores.*?
                result\.vmafP1 = frameScores\[p1Idx\];
            \}
        \}
'''
NEW_FRAME = r'''        // 1%-low from per-frame scores.*?
            if (frameScores.length > 0) {
                frameScores.sort(function(a, b) { return a - b; });
                var p1Idx = Math.min(frameScores.length - 1, Math.max(0, Math.floor(0.01 * frameScores.length)));
                result.vmafP1 = frameScores[p1Idx];
            }
            // CAMBI: Netflix's banding detector — lower is better, ~5 starts annoying.
            if (cambiScores.length > 0) {
                cambiScores.sort(function(a, b) { return a - b; });
                var c95Idx = Math.min(cambiScores.length - 1, Math.max(0, Math.floor(0.95 * (cambiScores.length - 1))));
                result.cambiP95 = cambiScores[c95Idx];
            }
        }
        if (cambiScores.length > 0) {
            cambiScores.sort(function(a, b) { return a - b; });
            var c95Idx = Math.min(cambiScores.length - 1, Math.max(0, Math.floor(0.95 * (cambiScores.length - 1))));
            result.cambiP95 = cambiScores[c95Idx];
        }
'''
s = sub(s, OLD_FRAME, NEW_FRAME, 'frame-parse')

# Insert cambiScores accumulation + parse pooled CAMBI
s = sub(s,
    '            var frameScores = [];\n            for (var fi = 0; fi < jsonData.frames.length; fi++) {',
    '            var frameScores = [];\n            var cambiScores = [];\n            for (var fi = 0; fi < jsonData.frames.length; fi++) {',
    'frame-var')

s = sub(s,
    '                if (typeof fv === \'number\' && isFinite(fv)) frameScores.push(fv);\n            }',
    '                if (typeof fv === \'number\' && isFinite(fv)) frameScores.push(fv);\n                var cv = fr && fr.metrics && fr.metrics.cambi;\n                if (typeof cv === \'number\' && isFinite(cv)) cambiScores.push(cv);\n            }',
    'cambi-accum')

# Pooled CAMBI
s = sub(s,
    '        if (jsonData.pooled_metrics && jsonData.pooled_metrics.vmaf) {\n            var vmafMetrics = jsonData.pooled_metrics.vmaf;\n            if (vmafMetrics.mean !== undefined) result.vmafMean = parseFloat(vmafMetrics.mean);\n            if (vmafMetrics.harmonic_mean !== undefined) result.vmafHarmonicMean = parseFloat(vmafMetrics.harmonic_mean);\n            if (vmafMetrics.min !== undefined) result.vmafMin = parseFloat(vmafMetrics.min);\n            if (vmafMetrics.max !== undefined) result.vmafMax = parseFloat(vmafMetrics.max);\n        }',
    '        if (jsonData.pooled_metrics && jsonData.pooled_metrics.vmaf) {\n            var vmafMetrics = jsonData.pooled_metrics.vmaf;\n            if (vmafMetrics.mean !== undefined) result.vmafMean = parseFloat(vmafMetrics.mean);\n            if (vmafMetrics.harmonic_mean !== undefined) result.vmafHarmonicMean = parseFloat(vmafMetrics.harmonic_mean);\n            if (vmafMetrics.min !== undefined) result.vmafMin = parseFloat(vmafMetrics.min);\n            if (vmafMetrics.max !== undefined) result.vmafMax = parseFloat(vmafMetrics.max);\n            if (jsonData.pooled_metrics.cambi) {\n                var cambiMetrics = jsonData.pooled_metrics.cambi;\n                if (cambiMetrics.mean !== undefined) result.cambiMean = parseFloat(cambiMetrics.mean);\n                if (cambiMetrics.max !== undefined) result.cambiMax = parseFloat(cambiMetrics.max);\n            }\n        }',
    'pooled-cambi')

# Add CAMBI feature param to CPU VMAF command builder
s = sub(s,
    "function buildCpuVmafCommand(ffmpegPath, distortedPath, referencePath, logPath, modelPath, inputFileObj, useGpuDecode, isHdr) {\n    var modelParam = modelPath ? ':model=path=' + modelPath : '';\n",
    "function buildCpuVmafCommand(ffmpegPath, distortedPath, referencePath, logPath, modelPath, inputFileObj, useGpuDecode, isHdr) {\n    var modelParam = modelPath ? ':model=path=' + modelPath : '';\n    var cambiFeatureParam = ':feature=name=cambi';\n",
    'cambi-var')

s = sub(s,
    ":log_fmt=json' + modelParam + ':shortest=1:repeatlast=0:ts_sync_mode=nearest",
    ":log_fmt=json' + modelParam + cambiFeatureParam + ':shortest=1:repeatlast=0:ts_sync_mode=nearest",
    'cambi-cmd')

# Wire CAMBI into all three result object sites
for old,new_ in [
    ("vmafP1: parsed.vmafP1,\n                            ssimScore: ssimScore,\n",
     "vmafP1: parsed.vmafP1,\n                            cambiMean: parsed.cambiMean,\n                            cambiMax: parsed.cambiMax,\n                            cambiP95: parsed.cambiP95,\n                            ssimScore: ssimScore,\n"),
    ("vmafP1: vmafData.vmafP1,\n            vmafMethod: usedMethod || '',\n",
     "vmafP1: vmafData.vmafP1,\n            cambiMean: vmafData.cambiMean,\n            cambiMax: vmafData.cambiMax,\n            cambiP95: vmafData.cambiP95,\n            vmafMethod: usedMethod || '',\n"),
    ("vmafP1: vmafData.vmafP1,\n                                    vmafMethod: method.name || '',\n",
     "vmafP1: vmafData.vmafP1,\n                                    cambiMean: vmafData.cambiMean,\n                                    cambiMax: vmafData.cambiMax,\n                                    cambiP95: vmafData.cambiP95,\n                                    vmafMethod: method.name || '',\n"),
]:
    s = sub(s, old, new_, 'cambi-wire')

# Aggregation arrays
s = sub(s,
    'vmafP1s: [],\n                ssimScores: [],\n                fileSizes: [],',
    'vmafP1s: [],\n                ssimScores: [],\n                cambiMeans: [],\n                cambiMaxs: [],\n                cambiP95s: [],\n                fileSizes: [],',
    'agg-arrays')

# Aggregation push
s = sub(s,
    '''        if (r.ssimScore !== null && r.ssimScore !== undefined) {
            aggregated[r.parameterSetId].ssimScores.push(r.ssimScore);
        }
        aggregated[r.parameterSetId].fileSizes.push(r.fileSizeMB);
''',
    '''        if (r.ssimScore !== null && r.ssimScore !== undefined) {
            aggregated[r.parameterSetId].ssimScores.push(r.ssimScore);
        }
        if (r.cambiMean !== null && r.cambiMean !== undefined) aggregated[r.parameterSetId].cambiMeans.push(r.cambiMean);
        if (r.cambiMax !== null && r.cambiMax !== undefined) aggregated[r.parameterSetId].cambiMaxs.push(r.cambiMax);
        if (r.cambiP95 !== null && r.cambiP95 !== undefined) aggregated[r.parameterSetId].cambiP95s.push(r.cambiP95);
        aggregated[r.parameterSetId].fileSizes.push(r.fileSizeMB);
''',
    'agg-push')

# Aggregation compute
s = sub(s,
    '''        var avgSSIM = item.ssimScores.length > 0
            ? item.ssimScores.reduce(function(a, b) { return a + b; }, 0) / item.ssimScores.length
            : null;
        var variance = 0;
''',
    '''        var avgSSIM = item.ssimScores.length > 0
            ? item.ssimScores.reduce(function(a, b) { return a + b; }, 0) / item.ssimScores.length
            : null;
        var avgCAMBI = item.cambiMeans.length > 0
            ? item.cambiMeans.reduce(function(a, b) { return a + b; }, 0) / item.cambiMeans.length : null;
        var maxCAMBI = item.cambiMaxs.length > 0 ? Math.max.apply(null, item.cambiMaxs) : null;
        var p95CAMBI = item.cambiP95s.length > 0 ? Math.max.apply(null, item.cambiP95s) : null;
        var variance = 0;
''',
    'agg-compute')

# Aggregation result object
s = sub(s,
    'avgSSIM: avgSSIM,\n            sampleCount: item.vmafScores.length,',
    'avgSSIM: avgSSIM,\n            avgCAMBI: avgCAMBI,\n            maxCAMBI: maxCAMBI,\n            p95CAMBI: p95CAMBI,\n            sampleCount: item.vmafScores.length,',
    'agg-result')

# Aggregation log line
s = sub(s,
    '''            (overallMin !== null ? overallMin.toFixed(2) : 'N/A') + ', SSIM=' +
            (avgSSIM !== null ? avgSSIM.toFixed(2) : 'N/A') + ', Size=' + avgSize.toFixed(2) + 'MB');
''',
    '''            (overallMin !== null ? overallMin.toFixed(2) : 'N/A') + ', SSIM=' +
            (avgSSIM !== null ? avgSSIM.toFixed(2) : 'N/A') + ', CAMBI=' +
            (avgCAMBI !== null ? avgCAMBI.toFixed(2) : 'N/A') + ', Size=' + avgSize.toFixed(2) + 'MB');
''',
    'agg-log')

write(p, s)
print('  wrote calculateVMAF')

# ──────────────────────────────────────────────────────────────
# 2. selectBestParameters — quality risk policy + size guard
# ──────────────────────────────────────────────────────────────
print('\n[selectBestParameters]')
p = BASE / 'selectBestParameters/1.0.0/index.js'
cp(p)
s = read(p)

HELPER = r'''

    function getPrimaryVideoStream(inputFileObj) {
        var streams = inputFileObj && inputFileObj.ffProbeData && inputFileObj.ffProbeData.streams;
        if (!Array.isArray(streams)) return null;
        for (var i = 0; i < streams.length; i++) {
            var st = streams[i];
            if (!st || st.codec_type !== 'video') continue;
            if (st.disposition && st.disposition.attached_pic === 1) continue;
            if ((st.width || 0) < 100 || (st.height || 0) < 100) continue;
            return st;
        }
        return null;
    }

    function getQualityRiskPolicy(inputFileObj, vars, configuredFrameFloor, configuredMeanFloor) {
        var v = getPrimaryVideoStream(inputFileObj) || {};
        var width = Number(v.width || 0);
        var height = Number(v.height || 0);
        var pixels = width * height;
        var format = (inputFileObj && inputFileObj.ffProbeData && inputFileObj.ffProbeData.format) || {};
        var duration = Number(format.duration || vars.vmafSourceDuration || 0);
        var sourceSizeMB = Number(inputFileObj && (inputFileObj.file_size || inputFileObj.fileSize || inputFileObj.size) || 0);
        if (sourceSizeMB > 1024 * 1024) sourceSizeMB = sourceSizeMB / 1024 / 1024;
        var fps = 24000 / 1001;
        try {
            var rate = String(v.r_frame_rate || v.avg_frame_rate || '');
            var m = rate.match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
            if (m) { var num = Number(m[1]); var den = m[2] ? Number(m[2]) : 1; if (num > 0 && den > 0) fps = num / den; }
        } catch(e) {}
        var pixFmt = String(v.pix_fmt || '').toLowerCase();
        var bits = Number(v.bits_per_raw_sample || v.bits_per_sample || 0);
        var is10Bit = pixFmt.indexOf('10') !== -1 || pixFmt.indexOf('p010') !== -1 || bits >= 10;
        var hdr = !!(vars.isHDR || vars.vmafIsHDR);
        var mediaType = String(vars.vmafMediaType || '').toLowerCase();
        var sourceType = String(vars.vmafMediaSourceType || '').toLowerCase();
        var genre = String(vars.vmafMediaGenre || '').toLowerCase();
        var animRaw = vars.vmafMediaIsAnimation;
        var isAnimation = animRaw === true || String(animRaw).toLowerCase() === 'true'
            || genre.indexOf('animation') !== -1 || genre.indexOf('anime') !== -1;
        var isMovie = mediaType.indexOf('movie') !== -1;
        var isBluray = sourceType.indexOf('bluray') !== -1 || sourceType.indexOf('blu-ray') !== -1;
        var tier = 'sd';
        if (width >= 3800 || height >= 1800 || pixels >= 7000000) tier = '4k';
        else if (width >= 2500 || height >= 1300 || pixels >= 3000000) tier = '1440p';
        else if (width >= 1700 || height >= 900 || pixels >= 1600000) tier = '1080p';
        else if (width >= 1100 || height >= 650 || pixels >= 800000) tier = '720p';

        var minBpp = {
            '4k':    isAnimation ? 0.010 : (hdr ? 0.018 : 0.015),
            '1440p': isAnimation ? 0.011 : (hdr ? 0.020 : 0.017),
            '1080p': isAnimation ? 0.016 : (hdr ? 0.028 : 0.024),
            '720p':  isAnimation ? 0.022 : (hdr ? 0.040 : 0.034),
            'sd':    isAnimation ? 0.030 : 0.050
        };
        var minRatio = {
            '4k':    isAnimation ? 5.0 : (hdr ? 10.0 : 8.0),
            '1440p': isAnimation ? 4.5 : (hdr ? 9.0 : 7.5),
            '1080p': isAnimation ? 4.0 : 7.0,
            '720p':  isAnimation ? 3.5 : 6.0,
            'sd':    isAnimation ? 3.0 : 5.0
        };
        var minMbps = {
            '4k':    isAnimation ? 1.4 : (hdr ? 2.5 : 2.2),
            '1440p': isAnimation ? 1.1 : (hdr ? 2.0 : 1.7),
            '1080p': isAnimation ? 0.8 : (hdr ? 1.6 : 1.4),
            '720p':  isAnimation ? 0.45 : 0.85,
            'sd':    isAnimation ? 0.22 : 0.35
        };
        var frameFloor = {
            '4k':    isAnimation ? 88.5 : (hdr ? 90.5 : 90.0),
            '1440p': isAnimation ? 88.5 : (hdr ? 90.0 : 89.5),
            '1080p': isAnimation ? 88.0 : (hdr ? 89.5 : 89.0),
            '720p':  isAnimation ? 87.5 : 88.5,
            'sd':    isAnimation ? 86.0 : 87.0
        };
        var adaptiveFloor = Math.max(configuredFrameFloor, frameFloor[tier]);
        if (isBluray && !isAnimation) adaptiveFloor += 0.3;
        if (isMovie && tier === '4k' && !isAnimation) adaptiveFloor += 0.2;
        adaptiveFloor = Math.min(94, adaptiveFloor);
        return {
            width: width, height: height, pixels: pixels, duration: duration, fps: fps,
            sourceSizeMB: sourceSizeMB, tier: tier, isHDR: hdr, is10Bit: is10Bit,
            isAnimation: isAnimation, mediaType: mediaType, sourceType: sourceType,
            minOutputBpp: minBpp[tier], minOutputRatioPct: minRatio[tier],
            minOutputMbps: minMbps[tier], adaptiveFrameFloor: adaptiveFloor,
            meanFloor: configuredMeanFloor, sampleDuration: Math.max(1, Number(vars.vmafSegmentDuration || 5))
        };
    }

    function estimateCandidateSizeMetrics(candidate, policy) {
        var sampleMB = Number(candidate.avgFileSizeMB || 0);
        var projectedMB = (policy.duration > 0 && policy.sampleDuration > 0)
            ? sampleMB * (policy.duration / policy.sampleDuration) : 0;
        var outputMbps = projectedMB > 0 && policy.duration > 0
            ? projectedMB * 1024 * 1024 * 8 / policy.duration / 1000000 : 0;
        var outputBpp = outputMbps > 0 && policy.width > 0 && policy.height > 0 && policy.fps > 0
            ? outputMbps * 1000000 / (policy.width * policy.height * policy.fps) : 0;
        var projectedRatioPct = projectedMB > 0 && policy.sourceSizeMB > 0
            ? projectedMB / policy.sourceSizeMB * 100 : 0;
        return { projectedMB: projectedMB, outputMbps: outputMbps, outputBpp: outputBpp, projectedRatioPct: projectedRatioPct };
    }
'''

if 'function getQualityRiskPolicy' not in s:
    s = sub(s, '    var isHDR = args.variables.isHDR || false;\n', '    var isHDR = args.variables.isHDR || false;\n' + HELPER, 'risk-helper')
print('  inserted risk policy helpers')

# Adaptive threshold override block
s = sub(s,
    '    // Store VMAF thresholds (adjusted if buffer was applied) so retry plugins can access them\n    args.variables.vmafMinVMAF = adjustedMinVMAF;',
    '''    var qualityRiskPolicy = getQualityRiskPolicy(args.inputFileObj, args.variables, adjustedMinFrameVMAF, adjustedMinVMAF);
    if (qualityRiskPolicy.adaptiveFrameFloor > adjustedMinFrameVMAF) {
        args.jobLog('');
        args.jobLog('=== Adaptive Quality Guard ===');
        args.jobLog('Policy: ' + qualityRiskPolicy.tier + (qualityRiskPolicy.isHDR ? ' HDR' : ' SDR')
            + (qualityRiskPolicy.isAnimation ? ' animation' : ' live-action')
            + ' (' + qualityRiskPolicy.width + 'x' + qualityRiskPolicy.height + ')');
        args.jobLog('Raising 1%-low frame VMAF floor ' + adjustedMinFrameVMAF.toFixed(1)
            + ' -> ' + qualityRiskPolicy.adaptiveFrameFloor.toFixed(1));
        adjustedMinFrameVMAF = qualityRiskPolicy.adaptiveFrameFloor;
    }
    args.variables.vmafQualityRiskPolicy = qualityRiskPolicy;

    // Store VMAF thresholds (adjusted if buffer was applied) so retry plugins can access them
    args.variables.vmafMinVMAF = adjustedMinVMAF;''',
    'adaptive-threshold')

# Size/BPP guard + CAMBI reject block
OLD_REJECT = r'        // Note: Size-based filtering removed.*?\n        if \(rejected\) \{'
NEW_REJECT = '''        if (!rejected) {
            var sizeMetrics = estimateCandidateSizeMetrics(result, qualityRiskPolicy);
            result.projectedOutputMB = sizeMetrics.projectedMB;
            result.projectedOutputMbps = sizeMetrics.outputMbps;
            result.projectedOutputBpp = sizeMetrics.outputBpp;
            result.projectedOutputRatioPct = sizeMetrics.projectedRatioPct;
            var ratioLow = sizeMetrics.projectedRatioPct > 0 && sizeMetrics.projectedRatioPct < qualityRiskPolicy.minOutputRatioPct;
            var bppLow = sizeMetrics.outputBpp > 0 && sizeMetrics.outputBpp < qualityRiskPolicy.minOutputBpp;
            var mbpsLow = sizeMetrics.outputMbps > 0 && sizeMetrics.outputMbps < qualityRiskPolicy.minOutputMbps;
            var severeBppLow = sizeMetrics.outputBpp > 0 && sizeMetrics.outputBpp < qualityRiskPolicy.minOutputBpp * 0.75;
            if ((ratioLow && (bppLow || mbpsLow)) || severeBppLow) {
                rejected = true;
                rejectReason = 'Projected output too small for ' + qualityRiskPolicy.tier
                    + (qualityRiskPolicy.isHDR ? ' HDR' : ' SDR')
                    + (qualityRiskPolicy.isAnimation ? ' animation' : ' live-action')
                    + ': ratio ' + (sizeMetrics.projectedRatioPct || 0).toFixed(1) + '% (floor ' + qualityRiskPolicy.minOutputRatioPct.toFixed(1) + '%)'
                    + ', BPP ' + (sizeMetrics.outputBpp || 0).toFixed(4) + ' (floor ' + qualityRiskPolicy.minOutputBpp.toFixed(4) + ')'
                    + ', Mbps ' + (sizeMetrics.outputMbps || 0).toFixed(2) + ' (floor ' + qualityRiskPolicy.minOutputMbps.toFixed(2) + ')';
            }
        }
        if (!rejected && result.avgCAMBI !== null && result.avgCAMBI !== undefined) {
            var cambiLimit = qualityRiskPolicy.isHDR ? 4.0 : 4.5;
            if (qualityRiskPolicy.isAnimation) cambiLimit = 5.0;
            var cambiRisk = Math.max(Number(result.avgCAMBI || 0), Number(result.p95CAMBI || 0));
            if (cambiRisk > cambiLimit) {
                rejected = true;
                rejectReason = 'CAMBI banding risk ' + cambiRisk.toFixed(2) + ' above floor ' + cambiLimit.toFixed(1) + ' (lower is better; ~5 starts annoying)';
            }
        }

        if (rejected) {'''

s = sub(s, OLD_REJECT, NEW_REJECT, 'reject-block')

# target-balanced log: add CAMBI + projected size
s = sub(s,
    "', SSIM=' + ((cand.avgSSIM !== null && cand.avgSSIM !== undefined) ? cand.avgSSIM.toFixed(2) : 'n/a')\n                + ', Size=' + cand.avgFileSizeMB.toFixed(2) + 'MB'",
    "', SSIM=' + ((cand.avgSSIM !== null && cand.avgSSIM !== undefined) ? cand.avgSSIM.toFixed(2) : 'n/a')\n                + ', CAMBI=' + ((cand.avgCAMBI !== null && cand.avgCAMBI !== undefined) ? cand.avgCAMBI.toFixed(2) : 'n/a')\n                + ', Size=' + cand.avgFileSizeMB.toFixed(2) + 'MB'\n                + ', proj=' + ((cand.projectedOutputRatioPct || 0).toFixed(1)) + '%/' + ((cand.projectedOutputMbps || 0).toFixed(2)) + 'Mbps/BPP' + ((cand.projectedOutputBpp || 0).toFixed(4))",
    'balanced-log')

# Selected Parameters logs
s = sub(s,
    "        if (bestParams.avgSSIM !== null && bestParams.avgSSIM !== undefined) {\n            args.jobLog('SSIM: ' + bestParams.avgSSIM.toFixed(2));\n        }\n        args.jobLog('Recommended Pixel Format: ' + recommendedPixFmt);",
    """        if (bestParams.avgSSIM !== null && bestParams.avgSSIM !== undefined) {
            args.jobLog('SSIM: ' + bestParams.avgSSIM.toFixed(2));
        }
        if (bestParams.avgCAMBI !== null && bestParams.avgCAMBI !== undefined) {
            args.jobLog('CAMBI banding score: ' + bestParams.avgCAMBI.toFixed(2) + ' (lower is better; ~5 starts to become annoying)');
        }
        if (bestParams.projectedOutputBpp !== undefined) {
            args.jobLog('Projected output guard: ' + (bestParams.projectedOutputRatioPct || 0).toFixed(1) + '% source, '
                + (bestParams.projectedOutputMbps || 0).toFixed(2) + ' Mbps, BPP ' + (bestParams.projectedOutputBpp || 0).toFixed(4));
        }
        args.jobLog('Recommended Pixel Format: ' + recommendedPixFmt);""",
    'selected-logs')

# Learning data
s = sub(s,
    "            selected_ssim: bestParams.avgSSIM !== undefined ? bestParams.avgSSIM : null,\n            target_min_vmaf: minVMAF,",
    """            selected_ssim: bestParams.avgSSIM !== undefined ? bestParams.avgSSIM : null,
            selected_cambi: bestParams.avgCAMBI !== undefined ? bestParams.avgCAMBI : null,
            selected_projected_output_bpp: bestParams.projectedOutputBpp !== undefined ? bestParams.projectedOutputBpp : null,
            selected_projected_output_ratio_pct: bestParams.projectedOutputRatioPct !== undefined ? bestParams.projectedOutputRatioPct : null,
            target_min_vmaf: minVMAF,""",
    'learning-data')

write(p, s)
print('  wrote selectBestParameters')

# ──────────────────────────────────────────────────────────────
# 3. extractVideoSamples — risk-aware sample floor
# ──────────────────────────────────────────────────────────────
print('\n[extractVideoSamples]')
p = BASE / 'extractVideoSamples/1.0.0/index.js'
cp(p)
s = read(p)

RISK_BLOCK = '''
    // Risk-aware sampling floor: 4K HDR live-action needs more samples so the VMAF
    // measurement is not dominated by a few easy scenes while hard scenes collapse unnoticed.
    try {
        var riskStream = getVideoStream(args.inputFileObj);
        var rw = riskStream ? Number(riskStream.width || 0) : 0;
        var rh = riskStream ? Number(riskStream.height || 0) : 0;
        var rpixels = rw * rh;
        var rfmt = String((riskStream && riskStream.pix_fmt) || '').toLowerCase();
        var rbits = Number((riskStream && (riskStream.bits_per_raw_sample || riskStream.bits_per_sample)) || 0);
        var rhdr = args.variables.isHDR === true || args.variables.vmafIsHDR === true;
        var rgenre = String(args.variables.vmafMediaGenre || '').toLowerCase();
        var ranim = args.variables.vmafMediaIsAnimation === true
            || String(args.variables.vmafMediaIsAnimation).toLowerCase() === 'true'
            || rgenre.indexOf('animation') !== -1 || rgenre.indexOf('anime') !== -1;
        var riskFloor = minSegments;
        if (!ranim && (rw >= 3800 || rh >= 1800 || rpixels >= 7000000)) riskFloor = rhdr ? 8 : 7;
        else if (!ranim && (rw >= 1700 || rh >= 900 || rpixels >= 1600000)
            && (rhdr || rfmt.indexOf('10') !== -1 || rbits >= 10)) riskFloor = 7;
        else if (!ranim && (rw >= 1700 || rh >= 900 || rpixels >= 1600000)) riskFloor = 6;
        if (riskFloor > numSegments) {
            var beforeRiskSamples = numSegments;
            numSegments = Math.min(maxSegments, riskFloor);
            args.jobLog('Risk-aware sampling floor: ' + beforeRiskSamples + ' -> ' + numSegments
                + ' samples for ' + rw + 'x' + rh + (rhdr ? ' HDR' : ' SDR') + (ranim ? ' animation' : ' live-action'));
        }
    } catch (riskSampleErr) {
        args.jobLog('Risk-aware sampling floor skipped: ' + (riskSampleErr && riskSampleErr.message ? riskSampleErr.message : String(riskSampleErr)));
    }

'''

s = sub(s,
    '    args.variables.vmafAdaptiveSampleCount = numSegments;\n\n    // Stratified sampling or uniform sampling\n',
    RISK_BLOCK + '    args.variables.vmafAdaptiveSampleCount = numSegments;\n\n    // Stratified sampling or uniform sampling\n',
    'risk-floor')

write(p, s)
print('  wrote extractVideoSamples')

print(f'\nAll patches applied. Backups: *.bak-{TS}')
