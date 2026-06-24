#!/usr/bin/env python3
import shutil, time, subprocess, sys
from pathlib import Path

p = Path(r'C:\Users\seb_m\tdarr\custom-cont-init.d\vmaf-plugin-patches\extractVideoSamples\1.0.0\index.js')
ts = time.strftime('%Y%m%d-%H%M%S')
s = p.read_text(encoding='utf-8')

if s.count('exports.plugin = plugin') != 1:
    raise SystemExit(f'ABORT: expected single plugin copy, found {s.count("exports.plugin = plugin")} exports')

old = """    // Risk-aware sampling floor: 4K HDR live-action needs more samples so the VMAF\n\n    // measurement is not dominated by a few easy scenes while hard scenes collapse unnoticed.\n\n    try {\n\n        var riskStream = getVideoStream(args.inputFileObj);\n\n        var rw = riskStream ? Number(riskStream.width || 0) : 0;\n\n        var rh = riskStream ? Number(riskStream.height || 0) : 0;\n\n        var rpixels = rw * rh;\n\n        var rfmt = String((riskStream && riskStream.pix_fmt) || '').toLowerCase();\n\n        var rbits = Number((riskStream && (riskStream.bits_per_raw_sample || riskStream.bits_per_sample)) || 0);\n\n        var rhdr = args.variables.isHDR === true || args.variables.vmafIsHDR === true;\n\n        var rgenre = String(args.variables.vmafMediaGenre || '').toLowerCase();\n\n        var ranim = args.variables.vmafMediaIsAnimation === true\n\n            || String(args.variables.vmafMediaIsAnimation).toLowerCase() === 'true'\n\n            || rgenre.indexOf('animation') !== -1 || rgenre.indexOf('anime') !== -1;\n\n        var riskFloor = minSegments;\n\n        if (!ranim && (rw >= 3800 || rh >= 1800 || rpixels >= 7000000)) riskFloor = rhdr ? 8 : 7;\n\n        else if (!ranim && (rw >= 1700 || rh >= 900 || rpixels >= 1600000)\n\n            && (rhdr || rfmt.indexOf('10') !== -1 || rbits >= 10)) riskFloor = 7;\n\n        else if (!ranim && (rw >= 1700 || rh >= 900 || rpixels >= 1600000)) riskFloor = 6;\n\n        if (riskFloor > numSegments) {\n\n            var beforeRiskSamples = numSegments;\n\n            numSegments = Math.min(maxSegments, riskFloor);\n\n            args.jobLog('Risk-aware sampling floor: ' + beforeRiskSamples + ' -> ' + numSegments\n\n                + ' samples for ' + rw + 'x' + rh + (rhdr ? ' HDR' : ' SDR') + (ranim ? ' animation' : ' live-action'));\n\n        }\n\n    } catch (riskSampleErr) {\n\n        args.jobLog('Risk-aware sampling floor skipped: ' + (riskSampleErr && riskSampleErr.message ? riskSampleErr.message : String(riskSampleErr)));\n\n    }\n\n\n\n"""

new = """    // Risk-aware sampling advisory only. Mean-min adaptive sampling decides N; this\n\n    // block records/logs the old tier recommendation without forcing extra samples.\n\n    try {\n\n        var riskStream = getVideoStream(args.inputFileObj);\n\n        var rw = riskStream ? Number(riskStream.width || 0) : 0;\n\n        var rh = riskStream ? Number(riskStream.height || 0) : 0;\n\n        var rpixels = rw * rh;\n\n        var rfmt = String((riskStream && riskStream.pix_fmt) || '').toLowerCase();\n\n        var rbits = Number((riskStream && (riskStream.bits_per_raw_sample || riskStream.bits_per_sample)) || 0);\n\n        var rhdr = args.variables.isHDR === true || args.variables.vmafIsHDR === true;\n\n        var rgenre = String(args.variables.vmafMediaGenre || '').toLowerCase();\n\n        var ranim = args.variables.vmafMediaIsAnimation === true\n\n            || String(args.variables.vmafMediaIsAnimation).toLowerCase() === 'true'\n\n            || rgenre.indexOf('animation') !== -1 || rgenre.indexOf('anime') !== -1;\n\n        var riskRecommendedSamples = minSegments;\n\n        if (!ranim && (rw >= 3800 || rh >= 1800 || rpixels >= 7000000)) riskRecommendedSamples = rhdr ? 8 : 7;\n\n        else if (!ranim && (rw >= 1700 || rh >= 900 || rpixels >= 1600000)\n\n            && (rhdr || rfmt.indexOf('10') !== -1 || rbits >= 10)) riskRecommendedSamples = 7;\n\n        else if (!ranim && (rw >= 1700 || rh >= 900 || rpixels >= 1600000)) riskRecommendedSamples = 6;\n\n        args.variables.vmafRiskRecommendedSampleCount = riskRecommendedSamples;\n\n        if (riskRecommendedSamples > numSegments) {\n\n            args.jobLog('Risk advisory: adaptive sampling chose ' + numSegments\n\n                + ' samples; old tier recommendation would have been ' + riskRecommendedSamples\n\n                + ' for ' + rw + 'x' + rh + (rhdr ? ' HDR' : ' SDR') + (ranim ? ' animation' : ' live-action')\n\n                + '. Not forcing the floor.');\n\n        }\n\n    } catch (riskSampleErr) {\n\n        args.jobLog('Risk advisory skipped: ' + (riskSampleErr && riskSampleErr.message ? riskSampleErr.message : String(riskSampleErr)));\n\n    }\n\n\n\n"""

count = s.count(old)
if count != 1:
    raise SystemExit(f'ABORT: expected hard-floor block once, found {count}')

backup = p.with_suffix(p.suffix + f'.bak-{ts}')
shutil.copy2(p, backup)
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print(f'Backed up {backup.name}')

r = subprocess.run(['node', '--check', str(p)], capture_output=True, text=True)
print(r.stdout, end='')
print(r.stderr, end='')
if r.returncode:
    sys.exit(r.returncode)
print('node --check OK')
print('hard floor markers:', p.read_text(encoding='utf-8').count('Risk-aware sampling floor'))
print('advisory markers:', p.read_text(encoding='utf-8').count('Risk advisory'))
