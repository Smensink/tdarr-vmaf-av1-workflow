"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

exports.plugin = exports.details = void 0;

var details = function () { return ({

    name: 'Select Best Parameters',

    description: 'Selects optimal encoding parameters based on VMAF score and file size ratio.',

    style: {

        borderColor: 'green',

    },

    tags: 'video,vmaf,optimize',

    isStartPlugin: false,

    pType: '',

    requiresVersion: '2.11.01',

    sidebarPosition: -1,

    icon: 'faCheck',

    inputs: [

        {

            label: 'Minimum VMAF (Harmonic Mean)',

            name: 'minVMAF',

            type: 'number',

            defaultValue: '95',

            inputUI: {

                type: 'text',

            },

            tooltip: 'Minimum acceptable VMAF harmonic mean (0-100). Harmonic mean penalizes low-quality frames more heavily than arithmetic mean. Default: 95 (visually-transparent floor; the 4K model reads optimistically and GPU VMAF measures in 8-bit, so 95 here protects real 4K quality)',

        },

        {

            label: 'Minimum Per-Frame VMAF',

            name: 'minFrameVMAF',

            type: 'number',

            defaultValue: '86',

            inputUI: {

                type: 'text',

            },

            tooltip: 'Reject parameter sets where the 1%-low frame VMAF drops below this threshold. This is the primary guard against transient artifacts on hard scenes (grain/motion/dark gradients). Set to 0 to disable. Default: 88 (a mean of 95 with worst-1% above 88 is what eliminates the "looks fine then artifacts" failure mode; 70 was far too low)',

        },

        {

            label: 'Optimization Strategy',

            name: 'strategy',

            type: 'string',

            defaultValue: 'target-balanced',

            inputUI: {

                type: 'dropdown',

                options: ['target-balanced', 'pareto-efficiency', 'pareto-quality', 'pareto-size', 'efficiency-curve', 'pareto-efficiency-curve', 'diminishing-returns', 'balanced', 'quality', 'size', 'efficiency'],

            },

            tooltip: 'pareto-efficiency = Pareto frontier + best VMAF/size ratio, pareto-quality = Pareto + highest VMAF, pareto-size = Pareto + smallest file, efficiency-curve = find knee point on VMAF/bitrate curve, pareto-efficiency-curve = Pareto + efficiency curve knee, diminishing-returns = stop before quality gains diminish, balanced = VMAF^2/size, quality = highest VMAF, size = smallest file, efficiency = VMAF/size',

        },

        {

            label: 'Diminishing Returns Threshold',

            name: 'dimReturnsThreshold',

            type: 'number',

            defaultValue: '0.5',

            inputUI: {

                type: 'text',

            },

            tooltip: 'Minimum VMAF points per MB gain (for diminishing-returns strategy). Lower = more aggressive compression. Default: 0.5',

        },

        {

            label: 'Minimum Size Reduction (%)',

            name: 'minSizeReduction',

            type: 'number',

            defaultValue: '10',

            inputUI: {

                type: 'text',

            },

            tooltip: 'Minimum required size reduction compared to original file. Parameter sets that would result in larger or insufficiently smaller files are rejected. Set to 0 to disable. Default: 10 (10% smaller)',

        },

        {

            label: '10-bit Source VMAF Buffer',

            name: 'vmafBuffer10Bit',

            type: 'number',

            defaultValue: '0',

            inputUI: {

                type: 'text',

            },

            tooltip: 'LOWERS the effective minVMAF/minFrameVMAF by this many points for 10-bit sources measured with GPU (8-bit) VMAF. Default 0 (disabled): the 8-bit conversion is applied to BOTH reference and distorted, so the relative VMAF is preserved - if anything 8-bit measurement is slightly optimistic, so lowering the target here would compound that and admit visible artifacts. Leave at 0 unless you have evidence the 8-bit path under-scores your content.',

        },

    ],

    outputs: [

        {

            number: 1,

            tooltip: 'Best parameters selected',

        },

        {

            number: 2,

            tooltip: 'No suitable parameters found',

        },

    ],

}); };

exports.details = details;

var plugin = function (args) {

    var lib = require('../../../../../methods/lib')();

    // ── Quality-risk policy: resolution/type-aware floors and size guards ──────

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

            '4k':    isAnimation ? 84.0 : (hdr ? 86.0 : 85.5),

            '1440p': isAnimation ? 83.5 : (hdr ? 85.5 : 85.0),

            '1080p': isAnimation ? 83.0 : (hdr ? 85.0 : 84.5),

            '720p':  isAnimation ? 82.5 : 83.5,

            'sd':    isAnimation ? 81.5 : 82.5

        };

        var adaptiveFloor = frameFloor[tier];

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

    function av1ColorMetadataArgs(colorPrimaries, colorTrc, colorspace) {

        function clean(v) { return String(v == null ? '' : v).toLowerCase().trim(); }

        function mapPrimaries(v) {

            v = clean(v);

            if (v.indexOf('bt2020') !== -1) return 9;

            if (v.indexOf('bt709') !== -1) return 1;

            return 2;

        }

        function mapTransfer(v) {

            v = clean(v);

            if (v.indexOf('smpte2084') !== -1 || v.indexOf('pq') !== -1) return 16;

            if (v.indexOf('arib-std-b67') !== -1 || v.indexOf('hlg') !== -1) return 18;

            if (v.indexOf('bt709') !== -1) return 1;

            return 2;

        }

        function mapMatrix(v) {

            v = clean(v);

            if (v === '' || v === 'undefined') return 9;

            if (v.indexOf('bt2020') !== -1) return 9;

            if (v.indexOf('bt709') !== -1) return 1;

            return 2;

        }

        return { bsf: 'av1_metadata=color_primaries=' + mapPrimaries(colorPrimaries) + ':transfer_characteristics=' + mapTransfer(colorTrc) + ':matrix_coefficients=' + mapMatrix(colorspace) };

    }

    function parseHoldoutVmafLog(logPath, fs) {

        try {

            var data = JSON.parse(fs.readFileSync(logPath, 'utf8'));

            var out = { avgVMAF: null, vmafP1: null, minVMAF: null, cambiMean: null, cambiP95: null };

            if (Array.isArray(data.frames) && data.frames.length > 0) {

                var scores = [];

                var cambiScores = [];

                for (var fi = 0; fi < data.frames.length; fi++) {

                    var m = data.frames[fi] && data.frames[fi].metrics;

                    if (m && typeof m.vmaf === 'number' && isFinite(m.vmaf)) scores.push(m.vmaf);

                    if (m && typeof m.cambi === 'number' && isFinite(m.cambi)) cambiScores.push(m.cambi);

                }

                if (scores.length > 0) {

                    scores.sort(function(a, b) { return a - b; });

                    out.minVMAF = scores[0];

                    out.vmafP1 = scores[Math.min(scores.length - 1, Math.max(0, Math.floor(0.01 * scores.length)))];

                }

                if (cambiScores.length > 0) {

                    cambiScores.sort(function(a, b) { return a - b; });

                    out.cambiP95 = cambiScores[Math.min(cambiScores.length - 1, Math.max(0, Math.floor(0.95 * (cambiScores.length - 1))))];

                }

            }

            if (data.pooled_metrics && data.pooled_metrics.vmaf) {

                var vm = data.pooled_metrics.vmaf;

                out.avgVMAF = vm.harmonic_mean !== undefined ? parseFloat(vm.harmonic_mean) : (vm.mean !== undefined ? parseFloat(vm.mean) : null);

                if (out.minVMAF === null && vm.min !== undefined) out.minVMAF = parseFloat(vm.min);

                if (data.pooled_metrics.cambi) {

                    var cm = data.pooled_metrics.cambi;

                    if (cm.mean !== undefined) out.cambiMean = parseFloat(cm.mean);

                    if (out.cambiP95 === null && cm.max !== undefined) out.cambiP95 = parseFloat(cm.max);

                }

            }

            return out.avgVMAF !== null && isFinite(out.avgVMAF) ? out : null;

        } catch (e) {

            return null;

        }

    }

    function runVmafOnHoldout(args, holdout, parameterSet, policy) {

        var fs = require('fs');

        var path = require('path');

        var execSync = require('child_process').execSync;

        var cacheDir = args.workDir || '/temp';

        var cq = Number(parameterSet && parameterSet.quality);

        if (!isFinite(cq)) throw new Error('Holdout CQ is not finite');

        var encoder = (parameterSet && parameterSet.encoder) || args.variables.vmafGPUEncoder || 'av1_nvenc';

        var preset = (parameterSet && parameterSet.preset) || 'p7';

        var pixFmt = (parameterSet && parameterSet.pixFmt) || 'p010le';

        var colorPrimaries = (parameterSet && parameterSet.colorPrimaries) || args.variables.color_primaries || 'bt709';

        var colorTrc = (parameterSet && parameterSet.colorTrc) || args.variables.color_trc || 'bt709';

        var colorspace = (parameterSet && parameterSet.colorspace) || args.variables.colorspace || 'bt709';

        var safeId = String((parameterSet && parameterSet.id) || ('cq' + cq)).replace(/[^A-Za-z0-9_.-]/g, '_');

        var ext = path.extname(holdout.path || '') || '.mkv';

        var distortedPath = cacheDir + '/holdout_' + safeId + ext;

        var logPath = cacheDir + '/holdout_vmaf_' + safeId + '.json';

        var nvencFlagArgs = args.variables.vmafNvencFlagArgs || '-tune hq -multipass fullres -spatial-aq 1 -temporal-aq 1 -aq-strength 10 -rc-lookahead 32';

        try { if (fs.existsSync(distortedPath)) fs.unlinkSync(distortedPath); } catch (e1) {}

        try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch (e2) {}

        var encCmd = '"' + args.ffmpegPath + '" -hide_banner -y';

        if (String(encoder).indexOf('av1_nvenc') !== -1) encCmd += ' -hwaccel cuda';

        encCmd += ' -i "' + holdout.path + '" -c:v ' + encoder;

        if (String(encoder).indexOf('_nvenc') !== -1) {

            encCmd += ' -pix_fmt ' + pixFmt + ' -rc vbr -cq ' + cq + ' -b:v 0 -preset ' + preset + ' ' + nvencFlagArgs + ' -g 96 -forced-idr 1';

            encCmd += ' -color_primaries ' + colorPrimaries + ' -color_trc ' + colorTrc + ' -colorspace ' + colorspace;

            if (String(encoder).indexOf('av1_nvenc') !== -1) {

                var av1Meta = av1ColorMetadataArgs(colorPrimaries, colorTrc, colorspace);

                encCmd += ' -bsf:v ' + av1Meta.bsf + (av1Meta.tags || '');

            }

            encCmd += ' -max_muxing_queue_size 4096';

        }

        encCmd += ' -an -sn -dn "' + distortedPath + '"';

        execSync(encCmd, { stdio: 'pipe', timeout: 180000, shell: '/bin/sh', maxBuffer: 16 * 1024 * 1024 });

        var modelPath = args.variables.vmafModelPath || ((policy && (policy.width >= 3840 || policy.height >= 2160)) ? '/usr/local/share/model/vmaf_4k_v0.6.1.json' : '/usr/local/share/model/vmaf_v0.6.1.json');

        var modelParam = modelPath ? ':model=path=' + modelPath : '';

        var cambiFeatureParam = ':feature=name=cambi';

        // Do NOT tonemap for VMAF/CAMBI. libvmaf_cuda requires 8-bit (yuv420p) input, which the
        // `format=yuv420p` step below already provides — the 8-bit requirement does NOT require a
        // tonemap. tonemap=hable applied directly to the PQ signal bands smooth gradients, which
        // CAMBI then reports as ~13 banding on an otherwise-pristine HDR encode (VMAF ~100). The GPU
        // sweep (calculateVMAF) does not tonemap in practice either, so tonemapping only the holdout
        // put its CAMBI on a different scale (~13 vs the sweep's ~2) and false-failed every HDR
        // holdout. Measuring 8-bit-without-tonemap keeps the holdout on the same scale as the sweep.
        // (Native 10-bit HDR VMAF is only available on CPU libvmaf, not libvmaf_cuda, in this build.)
        var tonemap = '';

        var stream = getPrimaryVideoStream(args.inputFileObj) || {};

        var refCodec = String(stream.codec_name || '').toLowerCase();

        var refCuvid = null;

        if (refCodec === 'h264') refCuvid = 'h264_cuvid';

        else if (refCodec === 'hevc' || refCodec === 'h265') refCuvid = 'hevc_cuvid';

        else if (refCodec === 'av1') refCuvid = 'av1_cuvid';

        else if (refCodec === 'vp9') refCuvid = 'vp9_cuvid';

        else if (refCodec === 'vp8') refCuvid = 'vp8_cuvid';

        else if (refCodec === 'mpeg2video' || refCodec === 'mpeg2') refCuvid = 'mpeg2_cuvid';

        else if (refCodec === 'mpeg4') refCuvid = 'mpeg4_cuvid';

        var vcmd = '"' + args.ffmpegPath + '" -hide_banner -y -init_hw_device cuda=cuda0:0 -filter_hw_device cuda0'

            + ' -hwaccel cuda -hwaccel_device 0 -c:v av1_cuvid -i "' + distortedPath + '"';

        if (refCuvid) vcmd += ' -hwaccel cuda -hwaccel_device 0 -c:v ' + refCuvid;

        vcmd += ' -i "' + holdout.path + '"'

            + ' -filter_complex "[0:v]settb=1/1000,setpts=N' + tonemap + ',format=yuv420p,hwupload[dis];[1:v]settb=1/1000,setpts=N' + tonemap + ',format=yuv420p,hwupload[ref];[dis][ref]libvmaf_cuda=log_path=' + logPath + ':log_fmt=json' + modelParam + cambiFeatureParam + ':shortest=1:repeatlast=0:ts_sync_mode=nearest"'

            + ' -f null -';

        execSync(vcmd, { stdio: 'pipe', timeout: 240000, shell: '/bin/sh', maxBuffer: 32 * 1024 * 1024 });

        var parsed = parseHoldoutVmafLog(logPath, fs);

        try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch (e3) {}

        try { if (fs.existsSync(distortedPath)) fs.unlinkSync(distortedPath); } catch (e4) {}

        // ── Per-segment SOURCE CAMBI: self-compare the un-encoded holdout segment ──
        // CAMBI measured on the distorted encode includes banding ALREADY present in the source.
        // Measuring this segment's OWN source banding lets the caller gate on the encode-INTRODUCED
        // delta, so a holdout that lands on an already-banded scene is not false-rejected. (This was
        // the cause of VMAF=100 / CAMBI-high holdout failures: the job-global source floor came from
        // the sweep clips, not this segment.) Self-compare => VMAF~100, cambi = source banding.
        if (parsed) {
            try {
                var srcCambiLog = cacheDir + '/holdout_srccambi_' + safeId + '.json';
                try { if (fs.existsSync(srcCambiLog)) fs.unlinkSync(srcCambiLog); } catch (e5) {}
                // Measure THIS segment's own banding through the SAME pipeline as the distorted
                // holdout and the GPU sweep: 8-bit yuv420p, libvmaf_cuda, NO tonemap (the shared
                // `tonemap` var is now ''). Previously this used 10-bit yuv420p10le + CPU libvmaf,
                // a third inconsistent pipeline. Keeping all three measurements identical (8-bit GPU,
                // no tonemap) puts the holdout CAMBI on the same scale as the sweep (~2), so the
                // encode-introduced delta is apples-to-apples and the absolute CAMBI floor applies.
                var srcDec = refCuvid ? (' -hwaccel cuda -hwaccel_device 0 -c:v ' + refCuvid) : '';
                var srcCmd = '"' + args.ffmpegPath + '" -hide_banner -y -init_hw_device cuda=cuda0:0 -filter_hw_device cuda0'
                    + srcDec + ' -i "' + holdout.path + '"'
                    + srcDec + ' -i "' + holdout.path + '"'
                    + ' -filter_complex "[0:v]settb=1/1000,setpts=N' + tonemap + ',format=yuv420p,hwupload[d];[1:v]settb=1/1000,setpts=N' + tonemap + ',format=yuv420p,hwupload[r];[d][r]libvmaf_cuda=log_fmt=json:log_path=' + srcCambiLog + modelParam + cambiFeatureParam + ':shortest=1:repeatlast=0:ts_sync_mode=nearest"'
                    + ' -f null -';
                try { execSync(srcCmd, { stdio: 'pipe', timeout: 120000, shell: '/bin/sh', maxBuffer: 32 * 1024 * 1024 }); } catch (e6) {}
                var srcParsed = fs.existsSync(srcCambiLog) ? parseHoldoutVmafLog(srcCambiLog, fs) : null;
                if (srcParsed) {
                    parsed.srcCambiMean = srcParsed.cambiMean;
                    parsed.srcCambiP95 = srcParsed.cambiP95;
                }
                try { if (fs.existsSync(srcCambiLog)) fs.unlinkSync(srcCambiLog); } catch (e7) {}
            } catch (e8) { /* non-fatal: caller falls back to the job-global source CAMBI floor */ }
        }

        return parsed;

    }

    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var aggregatedResults = args.variables.vmafAggregatedResults || [];

    var releaseGroup = args.variables.vmafReleaseGroup || '';

    var mediaSourceType = args.variables.vmafMediaSourceType || 'unknown';

    // ENHANCEMENT FIX #14: Input validation

    var minVMAF = Number(args.inputs.minVMAF);

    if (isNaN(minVMAF) || minVMAF < 0 || minVMAF > 100) {

        args.jobLog('WARNING: Invalid minVMAF (' + args.inputs.minVMAF + '), using default 90');

        minVMAF = 90;

    }

    var minFrameVMAF = Number(args.inputs.minFrameVMAF);

    if (isNaN(minFrameVMAF) || minFrameVMAF < 0 || minFrameVMAF > 100) {

        args.jobLog('WARNING: Invalid minFrameVMAF (' + args.inputs.minFrameVMAF + '), using default 70');

        minFrameVMAF = 70;

    }

    var strategy = String(args.inputs.strategy) || 'target-balanced';

    var validStrategies = ['target-balanced', 'pareto-efficiency', 'pareto-quality', 'pareto-size', 'efficiency-curve', 'pareto-efficiency-curve', 'diminishing-returns', 'balanced', 'quality', 'size', 'efficiency'];

    if (validStrategies.indexOf(strategy) === -1) {

        args.jobLog('WARNING: Invalid strategy (' + strategy + '), using default target-balanced');

        strategy = 'target-balanced';

    }

    var dimReturnsThreshold = Number(args.inputs.dimReturnsThreshold);

    if (isNaN(dimReturnsThreshold) || dimReturnsThreshold <= 0) {

        args.jobLog('WARNING: Invalid dimReturnsThreshold (' + args.inputs.dimReturnsThreshold + '), using default 0.5');

        dimReturnsThreshold = 0.5;

    }

    var minSizeReduction = Number(args.inputs.minSizeReduction);

    if (isNaN(minSizeReduction) || minSizeReduction < 0 || minSizeReduction > 100) {

        args.jobLog('WARNING: Invalid minSizeReduction (' + args.inputs.minSizeReduction + '), using default 10');

        minSizeReduction = 10;

    }

    var vmafBuffer10Bit = Number(args.inputs.vmafBuffer10Bit);

    if (isNaN(vmafBuffer10Bit) || vmafBuffer10Bit < 0 || vmafBuffer10Bit > 50) {

        args.jobLog('WARNING: Invalid vmafBuffer10Bit (' + args.inputs.vmafBuffer10Bit + '), using default 5');

        vmafBuffer10Bit = 5;

    }

    var isHDR = args.variables.isHDR || false;

    // Detect 10-bit source content

    var is10BitSource = false;

    if (args.inputFileObj && args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams) {

        for (var s = 0; s < args.inputFileObj.ffProbeData.streams.length; s++) {

            var stream = args.inputFileObj.ffProbeData.streams[s];

            if (stream.codec_type === 'video') {

                // Check pixel format for 10-bit indicators

                var pixFmt = String(stream.pix_fmt || '').toLowerCase();

                if (pixFmt.indexOf('10') !== -1 || pixFmt === 'p010le' || pixFmt === 'p210le' || pixFmt === 'p410le') {

                    is10BitSource = true;

                    break;

                }

                // Check bits_per_raw_sample

                var bitsPerSample = Number(stream.bits_per_raw_sample);

                if (!isNaN(bitsPerSample) && bitsPerSample === 10) {

                    is10BitSource = true;

                    break;

                }

                // Check profile for 10-bit indicators

                var profile = String(stream.profile || '').toLowerCase();

                if (profile.indexOf('main 10') !== -1 || profile.indexOf('high 10') !== -1) {

                    is10BitSource = true;

                    break;

                }

            }

        }

    }

    // Store 10-bit source status

    args.variables.is10BitSource = is10BitSource;

    // Check if GPU VMAF was actually used

    var gpuVmafActuallyUsed = args.variables.vmafUsedGpuVmaf === true;

    // Apply buffer to thresholds if conditions are met

    var adjustedMinVMAF = minVMAF;

    var adjustedMinFrameVMAF = minFrameVMAF;

    var bufferApplied = false;

    if (vmafBuffer10Bit > 0 && is10BitSource && gpuVmafActuallyUsed) {

        adjustedMinVMAF = Math.max(0, minVMAF - vmafBuffer10Bit);

        adjustedMinFrameVMAF = Math.max(0, minFrameVMAF - vmafBuffer10Bit);

        bufferApplied = true;

        args.jobLog('');

        args.jobLog('=== 10-bit Source + GPU VMAF Buffer Applied ===');

        args.jobLog('Source is 10-bit, GPU VMAF was used (requires 8-bit conversion)');

        args.jobLog('Original thresholds: minVMAF=' + minVMAF + ', minFrameVMAF=' + minFrameVMAF);

        args.jobLog('Adjusted thresholds: minVMAF=' + adjustedMinVMAF + ', minFrameVMAF=' + adjustedMinFrameVMAF);

        args.jobLog('Buffer amount: ' + vmafBuffer10Bit + ' points');

        args.jobLog('(This accounts for conversion artifacts that only appear in VMAF test files, not final encode)');

    } else if (vmafBuffer10Bit > 0 && is10BitSource && !gpuVmafActuallyUsed) {

        args.jobLog('');

        args.jobLog('=== 10-bit Source Detected ===');

        args.jobLog('Source is 10-bit, but GPU VMAF was not used (CPU VMAF supports 10-bit natively)');

        args.jobLog('No buffer applied - thresholds used as configured');

    } else if (is10BitSource) {

        args.jobLog('');

        args.jobLog('=== 10-bit Source Detected ===');

        args.jobLog('Source is 10-bit. Buffer disabled (vmafBuffer10Bit=0). Thresholds used as configured.');

    }

    // ── Adaptive quality guard: resolution/type-aware frame-floor and size/BPP checks ─

    var qualityRiskPolicy = getQualityRiskPolicy(args.inputFileObj, args.variables, adjustedMinFrameVMAF, adjustedMinVMAF);

    if (Math.abs(qualityRiskPolicy.adaptiveFrameFloor - adjustedMinFrameVMAF) >= 0.01) {

        args.jobLog('');

        args.jobLog('=== Adaptive Quality Guard ===');

        args.jobLog('Policy: ' + qualityRiskPolicy.tier + (qualityRiskPolicy.isHDR ? ' HDR' : ' SDR')

            + (qualityRiskPolicy.isAnimation ? ' animation' : ' live-action')

            + ' (' + qualityRiskPolicy.width + 'x' + qualityRiskPolicy.height + ')');

        args.jobLog('Using policy 1%-low frame VMAF floor ' + adjustedMinFrameVMAF.toFixed(1)

            + ' -> ' + qualityRiskPolicy.adaptiveFrameFloor.toFixed(1));

        adjustedMinFrameVMAF = qualityRiskPolicy.adaptiveFrameFloor;

    }

    args.variables.vmafQualityRiskPolicy = qualityRiskPolicy;

    // Store VMAF thresholds (adjusted if buffer was applied) so retry plugins can access them

    args.variables.vmafMinVMAF = adjustedMinVMAF;

    args.variables.vmafMinFrameVMAF = adjustedMinFrameVMAF;

    args.variables.vmafBuffer10Bit = vmafBuffer10Bit;

    args.variables.vmafBufferApplied = bufferApplied;

    if (aggregatedResults.length === 0) {

        args.jobLog('Error: No VMAF results found. Run Calculate VMAF first.');

        return {

            outputFileObj: args.inputFileObj,

            outputNumber: 2,

            variables: args.variables,

        };

    }

    // MEDIUM FIX #9: Validate aggregated results completeness

    var parameterSets = args.variables.vmafParameterSets || [];

    var missingParameterSets = [];

    for (var ps = 0; ps < parameterSets.length; ps++) {

        var paramSet = parameterSets[ps];

        var found = false;

        for (var ar = 0; ar < aggregatedResults.length; ar++) {

            if (aggregatedResults[ar].parameterSetId === paramSet.id) {

                found = true;

                break;

            }

        }

        if (!found) {

            missingParameterSets.push(paramSet.id);

        }

    }

    if (missingParameterSets.length > 0) {

        var missingRate = missingParameterSets.length / parameterSets.length;

        args.jobLog('');

        args.jobLog('=== Missing Parameter Sets ===');

        args.jobLog('Missing ' + missingParameterSets.length + ' of ' + parameterSets.length + ' parameter sets (' + (missingRate * 100).toFixed(1) + '%)');

        args.jobLog('Missing sets: ' + missingParameterSets.join(', '));

        if (missingRate > 0.2) {

            args.jobLog('WARNING: >20% of parameter sets are missing VMAF results. Selection may be suboptimal.');

        }

    }

    // Note: Sample-based size extrapolation is unreliable and has been removed.

    // File size will be verified during actual transcode using live size monitoring.

    args.jobLog('=== File Size Note ===');

    args.jobLog('Sample-based size prediction has been removed (unreliable).');

    args.jobLog('File size will be verified during actual transcode using live monitoring.');

    if (minSizeReduction > 0) {

        args.jobLog('Minimum size reduction target: ' + minSizeReduction + '% (enforced during transcode)');

    }

    args.jobLog('');

    // All tests now use 10-bit format

    var recommendedPixFmt = 'p010le';

    args.jobLog('=== VMAF Quality Thresholds ===');

    args.jobLog('Minimum Harmonic Mean VMAF: ' + adjustedMinVMAF + (bufferApplied ? ' (adjusted from ' + minVMAF + ')' : ''));

    args.jobLog('Minimum Per-Frame VMAF: ' + adjustedMinFrameVMAF + (bufferApplied ? ' (adjusted from ' + minFrameVMAF + ')' : '') + (adjustedMinFrameVMAF === 0 ? ' (disabled)' : ''));

    args.jobLog('');

    // Filter by minimum VMAF threshold, minimum per-frame threshold, and size constraints

    // Sweep-attempt context: this plugin runs once per CQ retry sweep, so a single file can
    // produce several selectBestParameters sections in one report. State the attempt up front
    // (and the CQs tried so far across attempts) so the retry journey is readable end to end.
    var _attemptNo = (Number(args.variables.vmafRetryCount) || 0) + 1;

    var _attemptMax = (Number(args.variables.vmafMaxRetries) || 4) + 1;

    var _testedSoFar = (args.variables.vmafTestedCQs || []).slice().map(Number)
        .filter(function (n) { return isFinite(n); }).sort(function (a, b) { return a - b; });

    args.jobLog('=== Sweep Attempt ' + _attemptNo + ' of ' + _attemptMax + ' ===');

    if (_testedSoFar.length) args.jobLog('CQ values tested so far (all attempts): ' + _testedSoFar.join(', '));

    args.jobLog('');

    args.jobLog('=== Filtering Parameter Sets ===');

    // ── Source CAMBI baseline measurement ──

    // Measures the banding (CAMBI) already present in the source file by running

    // a self-comparison VMAF (reference vs reference) on one original sample.

    // If the source has high banding, the output's CAMBI limit is raised to

    // sourceCAMBI + tolerance, so we don't reject an output for having the same

    // banding that was already in the source.

    var sourceCAMBI = args.variables.vmafSourceCAMBI !== undefined ? args.variables.vmafSourceCAMBI : null;
    var sourceCAMBIP95 = args.variables.vmafSourceCAMBIP95 !== undefined ? args.variables.vmafSourceCAMBIP95 : null;
    if (sourceCAMBI !== null) {
        args.jobLog('Source CAMBI baseline (from extractVideoSamples): mean=' + (sourceCAMBI !== null ? sourceCAMBI.toFixed(3) : 'N/A')
            + ', p95=' + (sourceCAMBIP95 !== null ? sourceCAMBIP95.toFixed(3) : 'N/A'));
    }

    try {

        var testResults = args.variables.vmafTestResults || [];

        var samplePath = null;

        for (var ti = 0; ti < testResults.length; ti++) {

            if (testResults[ti] && testResults[ti].originalSamplePath) {

                samplePath = testResults[ti].originalSamplePath;

                break;

            }

        }

        if (samplePath) {

            var execSyncCAMBI = require('child_process').execSync;

            var cambiLogPath = '/tmp/source_cambi_' + Date.now() + '.json';

            // Inline HDR detection (isHdrContent is not available in this plugin scope)
            var cambiIsHdr = false;
            if (args.inputFileObj && args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams) {
                for (var cIsI = 0; cIsI < args.inputFileObj.ffProbeData.streams.length; cIsI++) {
                    var cIsS = args.inputFileObj.ffProbeData.streams[cIsI];
                    if (cIsS.codec_type === 'video') {
                        var cIsTrc = (cIsS.color_transfer || '').toLowerCase();
                        if (cIsTrc.indexOf('smpte2084') !== -1 || cIsTrc.indexOf('hlg') !== -1) { cambiIsHdr = true; }
                        break;
                    }
                }
            }
            var srcPixFmt = cambiIsHdr ? 'yuv420p10le' : 'yuv420p';

            var cambiCmd = '"' + args.ffmpegPath + '" -y -hide_banner '

                + '-i "' + samplePath + '" -i "' + samplePath + '" '

                + '-filter_complex "[0:v]format=' + srcPixFmt + '[dist];[1:v]format=' + srcPixFmt + '[ref];[dist][ref]libvmaf=log_fmt=json:log_path=' + cambiLogPath + ':feature=name=cambi" '

                + '-f null -';

            args.jobLog('Measuring source CAMBI baseline (self-comparison on original sample)...');

            try {

                execSyncCAMBI(cambiCmd, { stdio: 'pipe', timeout: 60000, shell: '/bin/sh', maxBuffer: 32 * 1024 * 1024 });

            } catch (e) {

                // FFmpeg may exit non-zero even on success with libvmaf; check the log file

            }

            // Read the JSON log

            var fsCAMBI = require('fs');

            if (fsCAMBI.existsSync(cambiLogPath)) {

                var cambiData = JSON.parse(fsCAMBI.readFileSync(cambiLogPath, 'utf-8'));

                var pooled = cambiData.pooled_metrics || {};

                if (pooled.cambi) {

                    sourceCAMBI = pooled.cambi.mean !== undefined ? parseFloat(pooled.cambi.mean) : null;

                    // Also compute P95 from per-frame data

                    var frames = cambiData.frames || [];

                    var frameCambis = [];

                    for (var fi = 0; fi < frames.length; fi++) {

                        var cv = frames[fi].metrics && frames[fi].metrics.cambi;

                        if (typeof cv === 'number' && isFinite(cv)) frameCambis.push(cv);

                    }

                    if (frameCambis.length > 0) {

                        frameCambis.sort(function(a, b) { return a - b; });

                        var p95Idx = Math.min(frameCambis.length - 1, Math.max(0, Math.floor(0.95 * (frameCambis.length - 1))));

                        sourceCAMBIP95 = frameCambis[p95Idx];

                    }

                    args.jobLog('Source CAMBI baseline: mean=' + (sourceCAMBI !== null ? sourceCAMBI.toFixed(3) : 'N/A')

                        + ', p95=' + (sourceCAMBIP95 !== null ? sourceCAMBIP95.toFixed(3) : 'N/A'));

                }

            }

            // Clean up

            try { fsCAMBI.unlinkSync(cambiLogPath); } catch (e) {}

        }

    } catch (e) {

        args.jobLog('Source CAMBI measurement failed (non-fatal): ' + e.message);

    }

    args.variables.vmafSourceCAMBI = sourceCAMBI;

    args.variables.vmafSourceCAMBIP95 = sourceCAMBIP95;

    var cambiTolerance = 1.0; // Allow up to 1.0 CAMBI point degradation from source

    var sourceCambiRisk = (sourceCAMBI !== null && sourceCAMBIP95 !== null)

        ? Math.max(sourceCAMBI, sourceCAMBIP95) : (sourceCAMBI !== null ? sourceCAMBI : null);

    var validResults = [];

    // Keep rejected sets (with the reason) so the decision summary can explain why a more
    // aggressive (higher) CQ was not chosen.
    var rejectedResults = [];

    for (var i = 0; i < aggregatedResults.length; i++) {

        var result = aggregatedResults[i];

        var rejected = false;

        var rejectReason = '';

        // Check harmonic mean threshold (use adjusted values)

        if (result.avgVMAF < adjustedMinVMAF) {

            rejected = true;

            rejectReason = 'Harmonic mean ' + result.avgVMAF.toFixed(2) + ' below threshold ' + adjustedMinVMAF;

        }

        // Check the per-frame floor. Prefer the 1%-low frame VMAF (stable worst-case

        // statistic) over the absolute minimum, where one odd frame out of hundreds

        // could veto an otherwise good candidate.

        if (!rejected && adjustedMinFrameVMAF > 0) {

            var floorStat = (result.vmafP1Low !== null && result.vmafP1Low !== undefined && isFinite(result.vmafP1Low))

                ? result.vmafP1Low

                : ((result.minVMAF !== null && result.minVMAF !== undefined) ? result.minVMAF : null);

            var floorLabel = (result.vmafP1Low !== null && result.vmafP1Low !== undefined && isFinite(result.vmafP1Low))

                ? '1%-low frame VMAF' : 'Min frame VMAF';

            if (floorStat !== null && floorStat < adjustedMinFrameVMAF) {

                rejected = true;

                rejectReason = floorLabel + ' ' + floorStat.toFixed(2) + ' below threshold ' + adjustedMinFrameVMAF + ' (worst-case frames have visible artifacts)';

            }

        }                if (!rejected) {

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

            var cambiLimit = qualityRiskPolicy.isHDR ? 5.0 : 5.5;

            if (qualityRiskPolicy.isAnimation) cambiLimit = 6.0;

            var cambiTol = 1.0;

            if (sourceCambiRisk !== null) {

                var effectiveCambiLimit = Math.max(cambiLimit, sourceCambiRisk + cambiTol);

                if (effectiveCambiLimit > cambiLimit) {

                    args.jobLog('Source CAMBI ' + sourceCambiRisk.toFixed(2) + ' > floor ' + cambiLimit.toFixed(1) + '; raising effective CAMBI limit to ' + effectiveCambiLimit.toFixed(2) + ' (source+' + cambiTol + ' tolerance)');

                    cambiLimit = effectiveCambiLimit;

                }

            }

            var cambiRisk = Math.max(Number(result.avgCAMBI || 0), Number(result.p95CAMBI || 0));

            if (cambiRisk > cambiLimit) {

                rejected = true;

                rejectReason = 'CAMBI banding risk ' + cambiRisk.toFixed(2) + ' above floor ' + cambiLimit.toFixed(1) + ' (lower is better; ~6 starts annoying)';

            }

        }

        if (rejected) {

            rejectedResults.push({
                id: result.parameterSetId,
                cq: (result.parameterSet && isFinite(Number(result.parameterSet.quality))) ? Number(result.parameterSet.quality) : NaN,
                vmaf: result.avgVMAF,
                reason: rejectReason
            });

            args.jobLog('❌ Rejecting ' + result.parameterSetId + ': ' + rejectReason);

        } else {

            validResults.push(result);

            // Log quality metrics for accepted results

            var minInfo = result.minVMAF !== null && result.minVMAF !== undefined ? 

                ', Min=' + result.minVMAF.toFixed(2) : '';

            args.jobLog('✓ Accepted ' + result.parameterSetId + ': VMAF=' + result.avgVMAF.toFixed(2) + minInfo);

        }

    }

    if (validResults.length === 0) {

        args.jobLog('');

        args.jobLog('ERROR: No parameter sets met quality thresholds');

        // ENHANCEMENT FIX #17: Get maxRetries from checkCQRangeRetry plugin config (if available)

        // Default to 2 if not set, but this should match checkCQRangeRetry's maxRetries input

        var retryCount = args.variables.vmafRetryCount || 0;

        var maxRetries = args.variables.vmafMaxRetries || 4; // Set by checkCQRangeRetry; increased from 2→4

        var testedCQs = args.variables.vmafTestedCQs || [];

        // Find the best VMAF score achieved (even if below threshold)

        var bestVMAFAchieved = 0;

        var bestCQAchieved = null;

        for (var i = 0; i < aggregatedResults.length; i++) {

            if (aggregatedResults[i].avgVMAF > bestVMAFAchieved) {

                bestVMAFAchieved = aggregatedResults[i].avgVMAF;

                if (aggregatedResults[i].parameterSet && aggregatedResults[i].parameterSet.quality !== undefined) {

                    bestCQAchieved = aggregatedResults[i].parameterSet.quality;

                }

            }

        }

        args.jobLog('Best VMAF achieved: ' + bestVMAFAchieved.toFixed(2) + ' (target: ' + adjustedMinVMAF + ')');

        if (bestCQAchieved !== null) {

            args.jobLog('Best VMAF achieved at CQ: ' + bestCQAchieved);

        }

        args.jobLog('Tested CQ values: ' + (testedCQs.length > 0 ? testedCQs.sort(function(a, b) { return a - b; }).join(', ') : 'unknown'));

        // If we've retried and still no valid results, the target is unreachable for this

        // file. Exit gracefully (keep original) instead of erroring the job - checkCQRangeRetry

        // sees the exhausted retry count and continues to the give-up path.

        if (retryCount >= maxRetries) {

            args.jobLog('');

            args.jobLog('GIVING UP: Cannot achieve target VMAF (' + minVMAF + ') with any tested CQ values after ' + retryCount + ' retry attempts.');

            args.jobLog('Best VMAF achieved: ' + bestVMAFAchieved.toFixed(2) + ' (at CQ ' + (bestCQAchieved || 'unknown') + ').');

            args.jobLog('This file is likely too compressed or too low quality to re-encode within the quality floor. Keeping original file.');

            args.variables.vmafTranscodeGaveUp = true;

            args.variables.vmafSweepRetriesExhausted = true;

            if (!args.variables.vmafTranscodeFailures) {

                args.variables.vmafTranscodeFailures = [];

            }

            args.variables.vmafTranscodeFailures.push({

                reason: 'target_vmaf_unreachable',

                succeeded: false,

                retries: retryCount,

                originalCQ: bestCQAchieved,

                finalCQ: bestCQAchieved,

                bestVMAF: bestVMAFAchieved

            });

            args.variables.vmafSelectOutput = 2;

            return {

                outputFileObj: args.inputFileObj,

                outputNumber: 2,

                variables: args.variables,

            };

        }

        // Not retried yet - allow retry

        args.jobLog('Consider:');

        args.jobLog('  - Lowering minimum VMAF threshold (currently ' + minVMAF + ')');

        args.jobLog('  - Lowering minimum per-frame VMAF (currently ' + minFrameVMAF + ')');

        args.jobLog('  - Using lower CQ values (higher quality) in test parameters');

        // Store output number for retry check - CRITICAL: must be set before return

        args.variables.vmafSelectOutput = 2;

        return {

            outputFileObj: args.inputFileObj,

            outputNumber: 2,

            variables: args.variables,

        };

    }

    args.jobLog('');

    args.jobLog(validResults.length + ' of ' + aggregatedResults.length + ' parameter sets passed quality thresholds');

    // Helper function to find Pareto-optimal points

    function findParetoOptimal(results) {

        var paretoOptimal = [];

        for (var i = 0; i < results.length; i++) {

            var dominated = false;

            for (var j = 0; j < results.length; j++) {

                if (i === j) continue;

                // Check if result[j] dominates result[i]

                // Dominated means: j has higher or equal VMAF AND smaller or equal size,

                // and at least one is strictly better

                if (results[j].avgVMAF >= results[i].avgVMAF && 

                    results[j].avgFileSizeMB <= results[i].avgFileSizeMB &&

                    (results[j].avgVMAF > results[i].avgVMAF || 

                     results[j].avgFileSizeMB < results[i].avgFileSizeMB)) {

                    dominated = true;

                    break;

                }

            }

            if (!dominated) {

                paretoOptimal.push(results[i]);

            }

        }

        return paretoOptimal;

    }

    // Helper function to detect diminishing returns

    function findDiminishingReturns(results) {

        // Sort by file size (ascending) to analyze from smallest to largest

        var sorted = results.slice().sort(function(a, b) {

            return a.avgFileSizeMB - b.avgFileSizeMB;

        });

        if (sorted.length < 2) {

            return sorted[0] || null;

        }

        args.jobLog('Analyzing diminishing returns (threshold: ' + dimReturnsThreshold + ' VMAF points per MB)...');

        var bestPoint = sorted[0]; // Start with smallest file

        var bestEfficiency = -1;

        for (var i = 1; i < sorted.length; i++) {

            var prev = sorted[i - 1];

            var curr = sorted[i];

            var vmafGain = curr.avgVMAF - prev.avgVMAF;

            var sizeIncrease = curr.avgFileSizeMB - prev.avgFileSizeMB;

            if (sizeIncrease <= 0) {

                // Size didn't increase, definitely take this one

                bestPoint = curr;

                continue;

            }

            var marginalEfficiency = vmafGain / sizeIncrease;

            args.jobLog('  ' + prev.parameterSetId + ' → ' + curr.parameterSetId + 

                ': +' + vmafGain.toFixed(2) + ' VMAF for +' + sizeIncrease.toFixed(2) + 

                ' MB = ' + marginalEfficiency.toFixed(3) + ' VMAF/MB');

            // If marginal efficiency is still above threshold, this point is worth it

            if (marginalEfficiency >= dimReturnsThreshold) {

                bestPoint = curr;

                bestEfficiency = marginalEfficiency;

            } else {

                // Diminishing returns detected - stop here

                args.jobLog('  → Diminishing returns detected! Stopping at ' + prev.parameterSetId);

                break;

            }

        }

        return bestPoint;

    }

    // Helper function to find optimal point on VMAF-bitrate efficiency curve

    function findEfficiencyCurveKnee(results) {

        // Sort by file size (ascending) to analyze the curve

        var sorted = results.slice().sort(function(a, b) {

            return a.avgFileSizeMB - b.avgFileSizeMB;

        });

        if (sorted.length < 2) {

            return sorted[0] || null;

        }

        if (sorted.length === 2) {

            // For 2 points, choose the one with better efficiency

            var eff1 = sorted[0].avgVMAF / sorted[0].avgFileSizeMB;

            var eff2 = sorted[1].avgVMAF / sorted[1].avgFileSizeMB;

            return eff1 > eff2 ? sorted[0] : sorted[1];

        }

        args.jobLog('Analyzing VMAF-bitrate efficiency curve...');

        // Method 1: Find point with maximum efficiency (VMAF/bitrate)

        var maxEfficiency = -1;

        var maxEfficiencyPoint = null;

        // Method 2: Find knee point using elbow method (maximum distance from line)

        var firstPoint = sorted[0];

        var lastPoint = sorted[sorted.length - 1];

        // Calculate line from first to last point: y = mx + b

        var dx = lastPoint.avgFileSizeMB - firstPoint.avgFileSizeMB;

        var dy = lastPoint.avgVMAF - firstPoint.avgVMAF;

        var maxDistance = -1;

        var kneePoint = null;

        for (var i = 0; i < sorted.length; i++) {

            var point = sorted[i];

            // Calculate efficiency ratio

            var efficiency = point.avgVMAF / point.avgFileSizeMB;

            if (efficiency > maxEfficiency) {

                maxEfficiency = efficiency;

                maxEfficiencyPoint = point;

            }

            // Calculate perpendicular distance from point to line connecting first and last

            if (dx !== 0 || dy !== 0) {

                // Line equation: (y - y1) = m(x - x1) where m = dy/dx

                // Or: dy*x - dx*y + (dx*y1 - dy*x1) = 0

                // Distance from point (x0, y0) to line Ax + By + C = 0:

                // |Ax0 + By0 + C| / sqrt(A² + B²)

                var A = dy;

                var B = -dx;

                var C = dx * firstPoint.avgVMAF - dy * firstPoint.avgFileSizeMB;

                var distance = Math.abs(A * point.avgFileSizeMB + B * point.avgVMAF + C) / Math.sqrt(A * A + B * B);

                if (distance > maxDistance) {

                    maxDistance = distance;

                    kneePoint = point;

                }

            }

            args.jobLog('  ' + point.parameterSetId + ': VMAF=' + point.avgVMAF.toFixed(2) + 

                ', Size=' + point.avgFileSizeMB.toFixed(2) + 'MB, Efficiency=' + efficiency.toFixed(4) + ' VMAF/MB');

        }

        // Use knee point if available, otherwise use max efficiency point

        var selectedPoint = kneePoint || maxEfficiencyPoint;

        if (kneePoint && maxEfficiencyPoint && kneePoint !== maxEfficiencyPoint) {

            args.jobLog('  Knee point (elbow method): ' + kneePoint.parameterSetId + 

                ' (distance from line: ' + maxDistance.toFixed(3) + ')');

            args.jobLog('  Max efficiency point: ' + maxEfficiencyPoint.parameterSetId + 

                ' (efficiency: ' + maxEfficiency.toFixed(4) + ' VMAF/MB)');

        }

        return selectedPoint;

    }

    var candidates = validResults;

    var selectionMethod = '';

    // Apply Pareto filtering for Pareto strategies

    if (strategy.indexOf('pareto') === 0) {

        candidates = findParetoOptimal(validResults);

        args.jobLog('');

        args.jobLog('=== Pareto-Optimal Sets ===');

        args.jobLog(candidates.length + ' of ' + validResults.length + ' parameter sets on Pareto frontier');

        for (var i = 0; i < candidates.length; i++) {

            var minInfo = candidates[i].minVMAF !== null && candidates[i].minVMAF !== undefined ? 

                ', Min=' + candidates[i].minVMAF.toFixed(2) : '';

            args.jobLog('  • ' + candidates[i].parameterSetId + 

                ': VMAF=' + candidates[i].avgVMAF.toFixed(2) + minInfo +

                ', Size=' + candidates[i].avgFileSizeMB.toFixed(2) + 'MB');

        }

        if (candidates.length === 0) {

            args.jobLog('ERROR: No Pareto-optimal points found (this should not happen)');

            candidates = validResults; // Fallback

        }

    }

    var bestParams = null;

    var bestScore = -Infinity;

    var targetVMAF = adjustedMinVMAF;

    // Apply selection strategy

    if (strategy === 'target-balanced') {

        // Explicit constrained optimisation: choose the HIGHEST CQ (smallest file) whose

        // lower confidence bound on mean VMAF still clears the target, and whose worst-case

        // frame statistic clears the floor. Scale-invariant (no megabyte-weighted scoring),

        // so it behaves identically for 720p and 4K content.

        selectionMethod = 'Target-floor (highest CQ with LCB >= target, worst-case floor, SSIM veto)';

        var Z_LCB = 1.28; // 90% one-sided confidence on the mean

        var ranked = candidates.filter(function(r) {

            return r.parameterSet && isFinite(Number(r.parameterSet.quality));

        }).slice().sort(function(a, b) { return Number(b.parameterSet.quality) - Number(a.parameterSet.quality); });

        var fallbackBest = null;

        for (var ci = 0; ci < ranked.length; ci++) {

            var cand = ranked[ci];

            var nSamp = Math.max(1, cand.sampleCount || 1);

            var sdC = (cand.vmafStdDev !== undefined && cand.vmafStdDev !== null && isFinite(cand.vmafStdDev) && cand.vmafStdDev > 0)

                ? cand.vmafStdDev : 0.8;

            var seC = Math.max(0.3, sdC / Math.sqrt(nSamp));

            var lcb = cand.avgVMAF - Z_LCB * seC;

            var floorStatC = (cand.vmafP1Low !== null && cand.vmafP1Low !== undefined && isFinite(cand.vmafP1Low))

                ? cand.vmafP1Low

                : ((cand.minVMAF !== null && cand.minVMAF !== undefined) ? cand.minVMAF : null);

            var floorOk = !(adjustedMinFrameVMAF > 0 && floorStatC !== null && floorStatC < adjustedMinFrameVMAF);

            var eligible = lcb >= targetVMAF && floorOk;

            if (eligible && bestParams && lcb >= bestParams.lcb - 0.3) {

                var cw = Math.max(Number(cand.avgCAMBI||0), Number(cand.p95CAMBI||0));

                var bw = Math.max(Number(bestParams.avgCAMBI||0), Number(bestParams.p95CAMBI||0));

                if (cw < bw - 0.1) {

                    args.jobLog('  CAMBI tiebreak: ' + cand.parameterSetId

                        + ' (CAMBI ' + cw.toFixed(2) + ' < ' + bw.toFixed(2) + ')');

                    bestParams = cand;

                    eligible = false;

                }

            }

            args.jobLog(cand.parameterSetId + ': CQ=' + cand.parameterSet.quality

                + ', VMAF=' + cand.avgVMAF.toFixed(2)

                + ', LCB=' + lcb.toFixed(2) + ' (SE=' + seC.toFixed(2) + ', n=' + nSamp + ')'

                + ', 1%low=' + (floorStatC !== null ? floorStatC.toFixed(2) : 'n/a')

                + ', SSIM=' + ((cand.avgSSIM !== null && cand.avgSSIM !== undefined) ? cand.avgSSIM.toFixed(2) : 'n/a')

                + ', CAMBI(avg/p95/worst)=' + ((cand.avgCAMBI !== null && cand.avgCAMBI !== undefined) ? cand.avgCAMBI.toFixed(2) : 'n/a')
                + '/' + ((cand.p95CAMBI !== null && cand.p95CAMBI !== undefined) ? cand.p95CAMBI.toFixed(2) : 'n/a')
                + '/' + ((cand.avgCAMBI !== null && cand.avgCAMBI !== undefined) ? Math.max(Number(cand.avgCAMBI||0),Number(cand.p95CAMBI||0)).toFixed(2) : 'n/a')

                + ', Size=' + cand.avgFileSizeMB.toFixed(2) + 'MB'

                + ', proj=' + ((cand.projectedOutputRatioPct || 0).toFixed(1)) + '%/' + ((cand.projectedOutputMbps || 0).toFixed(2)) + 'Mbps/BPP' + ((cand.projectedOutputBpp || 0).toFixed(4))

                + (eligible ? ' [eligible]' : '')

                + (cand.avgCAMBI !== null && cand.avgCAMBI !== undefined

                    ? ' CAMBI_w=' + Math.max(Number(cand.avgCAMBI||0),Number(cand.p95CAMBI||0)).toFixed(3) : ''));

            if (eligible && !bestParams) {

                bestParams = cand;

            }

            if (!fallbackBest) fallbackBest = cand;

        }

        if (!bestParams && fallbackBest) {

            args.jobLog('No candidate clears the lower confidence bound; using highest passing CQ '

                + fallbackBest.parameterSet.quality + ' (mean cleared the target but confidence is thin)');

            bestParams = fallbackBest;

        }

        // SSIM disagreement veto: if SSIM collapses disproportionately at the chosen CQ

        // versus the next lower tested CQ while VMAF stays happy, that is the signature of

        // detail loss VMAF under-penalises (flat/dark areas). Step back one tested CQ.

        // Threshold 0.5/CQ on the 0-100 scale = raw SSIM 0.005 per CQ unit, ~3-5x the

        // typical inter-step drop.

        if (bestParams) {

            var lowerNb = null;

            for (var ni = 0; ni < ranked.length; ni++) {

                var rr = ranked[ni];

                if (Number(rr.parameterSet.quality) < Number(bestParams.parameterSet.quality)

                    && (!lowerNb || Number(rr.parameterSet.quality) > Number(lowerNb.parameterSet.quality))) {

                    lowerNb = rr;

                }

            }

            if (lowerNb && bestParams.avgSSIM !== null && bestParams.avgSSIM !== undefined

                && lowerNb.avgSSIM !== null && lowerNb.avgSSIM !== undefined) {

                var dCqNb = Number(bestParams.parameterSet.quality) - Number(lowerNb.parameterSet.quality);

                var ssimDropPerCq = dCqNb > 0 ? (lowerNb.avgSSIM - bestParams.avgSSIM) / dCqNb : 0;

                if (ssimDropPerCq > 0.5) {

                    args.jobLog('SSIM veto: SSIM drops ' + ssimDropPerCq.toFixed(3) + '/CQ ('

                        + lowerNb.avgSSIM.toFixed(2) + ' @ CQ' + lowerNb.parameterSet.quality + ' -> '

                        + bestParams.avgSSIM.toFixed(2) + ' @ CQ' + bestParams.parameterSet.quality

                        + ') - likely detail loss VMAF is missing. Stepping back to CQ ' + lowerNb.parameterSet.quality);

                    args.variables.vmafSsimVetoApplied = true;

                    bestParams = lowerNb;

                }

            }

        }

    } else if (strategy === 'pareto-efficiency' || strategy === 'efficiency') {

        selectionMethod = 'Best VMAF/size efficiency ratio';

        for (var i = 0; i < candidates.length; i++) {

            var result = candidates[i];

            var score = result.avgVMAF / result.avgFileSizeMB;

            args.jobLog(result.parameterSetId + ': VMAF=' + result.avgVMAF.toFixed(2) + 

                ', Size=' + result.avgFileSizeMB.toFixed(2) + 'MB, Efficiency=' + score.toFixed(4) + ' VMAF/MB');

            if (score > bestScore) {

                bestScore = score;

                bestParams = result;

            }

        }

    } else if (strategy === 'pareto-quality' || strategy === 'quality') {

        selectionMethod = 'Highest VMAF';

        for (var i = 0; i < candidates.length; i++) {

            var result = candidates[i];

            args.jobLog(result.parameterSetId + ': VMAF=' + result.avgVMAF.toFixed(2) + 

                ', Size=' + result.avgFileSizeMB.toFixed(2) + 'MB');

            if (result.avgVMAF > bestScore) {

                bestScore = result.avgVMAF;

                bestParams = result;

            }

        }

    } else if (strategy === 'pareto-size' || strategy === 'size') {

        selectionMethod = 'Smallest file size';

        bestScore = Infinity;

        for (var i = 0; i < candidates.length; i++) {

            var result = candidates[i];

            args.jobLog(result.parameterSetId + ': VMAF=' + result.avgVMAF.toFixed(2) + 

                ', Size=' + result.avgFileSizeMB.toFixed(2) + 'MB');

            if (result.avgFileSizeMB < bestScore) {

                bestScore = result.avgFileSizeMB;

                bestParams = result;

            }

        }

    } else if (strategy === 'efficiency-curve' || strategy === 'pareto-efficiency-curve') {

        selectionMethod = strategy.indexOf('pareto') === 0 ? 

            'Pareto frontier + efficiency curve knee point' : 

            'Efficiency curve knee point';

        bestParams = findEfficiencyCurveKnee(candidates);

    } else if (strategy === 'diminishing-returns') {

        selectionMethod = 'Diminishing returns detection';

        bestParams = findDiminishingReturns(candidates);

    } else if (strategy === 'balanced') {

        selectionMethod = 'VMAF²×SSIM/size (balanced)';

        for (var i = 0; i < candidates.length; i++) {

            var result = candidates[i];

            var ssimNorm = (result.avgSSIM !== null && result.avgSSIM !== undefined) ? (result.avgSSIM / 100) : 0.9;

            var score = ((result.avgVMAF * result.avgVMAF) * ssimNorm) / result.avgFileSizeMB;

            var ssimStr = (result.avgSSIM !== null && result.avgSSIM !== undefined) ? (', SSIM=' + result.avgSSIM.toFixed(2)) : '';

            args.jobLog(result.parameterSetId + ': VMAF=' + result.avgVMAF.toFixed(2) +

                ', Size=' + result.avgFileSizeMB.toFixed(2) + 'MB' + ssimStr + ', Score=' + score.toFixed(2));

            if (score > bestScore) {

                bestScore = score;

                bestParams = result;

            }

        }

    } else {

        // Fallback to efficiency

        selectionMethod = 'Best VMAF/size efficiency ratio (fallback)';

        for (var i = 0; i < candidates.length; i++) {

            var result = candidates[i];

            var score = result.avgVMAF / result.avgFileSizeMB;

            if (score > bestScore) {

                bestScore = score;

                bestParams = result;

            }

        }

    }

    // Record the core sweep pick (CQ chosen by the strategy, incl. CAMBI tiebreak / SSIM veto)
    // before the post-selection guards (XPSNR / fractional / holdout / max-compression) run, so
    // the summary can show how the CQ moved from the sweep result to the final value.
    var rawStrategyCQ = (bestParams && bestParams.parameterSet && isFinite(Number(bestParams.parameterSet.quality)))
        ? Number(bestParams.parameterSet.quality) : null;

    if (bestParams) {

        // XPSNR second opinion on the winner: a perceptually-weighted PSNR variant that

        // catches banding/chroma damage in flat and dark regions where VMAF over-scores.

        // Advisory below 34 dB min-channel; hard veto (step back one CQ) below 30 dB.

        try {

            var xpExecSync = require('child_process').execSync;

            var xpTests = (args.variables.vmafTestResults || []).filter(function(t) {

                return t && t.parameterSetId === bestParams.parameterSetId && t.outputPath && t.originalSamplePath;

            }).slice(0, 3);

            var xpMinDb = null;

            for (var xi = 0; xi < xpTests.length; xi++) {

                try {

                    // xpsnr prints its summary on stderr; merge it into stdout to capture.

                    var xpOut = xpExecSync('"' + args.ffmpegPath + '" -hide_banner'

                        + ' -hwaccel nvdec -hwaccel_device 0 -c:v av1_cuvid -i "' + xpTests[xi].outputPath + '"'

                        + ' -i "' + xpTests[xi].originalSamplePath + '"'

                        + ' -filter_complex "[0:v]settb=1/1000,setpts=N[d];[1:v]settb=1/1000,setpts=N[r];[d][r]xpsnr"'

                        + ' -f null - 2>&1', { stdio: 'pipe', timeout: 180000, shell: '/bin/sh', maxBuffer: 16 * 1024 * 1024 }).toString();

                    var xpm = xpOut.match(/minimum:\s*([0-9.]+|inf)/);

                    if (xpm) {

                        var xv = xpm[1] === 'inf' ? 99 : parseFloat(xpm[1]);

                        if (isFinite(xv) && (xpMinDb === null || xv < xpMinDb)) xpMinDb = xv;

                    }

                } catch (xpErr) { /* advisory metric - never fatal */ }

            }

            if (xpMinDb !== null) {

                args.variables.vmafXpsnrMinDb = xpMinDb;

                args.jobLog('XPSNR second opinion (min channel over ' + xpTests.length + ' samples): ' + xpMinDb.toFixed(2) + ' dB');

                if (xpMinDb < 30) {

                    var xpLower = null;

                    for (var xk = 0; xk < validResults.length; xk++) {

                        var xr = validResults[xk];

                        if (xr.parameterSet && Number(xr.parameterSet.quality) < Number(bestParams.parameterSet.quality)

                            && (!xpLower || Number(xr.parameterSet.quality) > Number(xpLower.parameterSet.quality))) {

                            xpLower = xr;

                        }

                    }

                    if (xpLower) {

                        args.jobLog('XPSNR veto: ' + xpMinDb.toFixed(2) + ' dB < 30 dB indicates visible banding/chroma damage. Stepping back to CQ ' + xpLower.parameterSet.quality);

                        args.variables.vmafXpsnrVetoApplied = true;

                        bestParams = xpLower;

                    } else {

                        args.jobLog('XPSNR warning: ' + xpMinDb.toFixed(2) + ' dB < 30 dB but no lower-CQ candidate available');

                    }

                } else if (xpMinDb < 34) {

                    args.jobLog('XPSNR advisory: ' + xpMinDb.toFixed(2) + ' dB is below the ~34 dB comfort threshold - borderline for flat/dark scenes');

                }

            }

        } catch (xpsnrErr) {

            args.jobLog('XPSNR check skipped: ' + (xpsnrErr && xpsnrErr.message ? xpsnrErr.message : String(xpsnrErr)));

        }

        // Fractional CQ refinement: av1_nvenc accepts fractional -cq values, so instead of

        // settling for the tested integer CQ (often a whole step of headroom above target),

        // interpolate between the selected CQ and the next higher tested CQ to land just

        // above the VMAF target. Only ever moves toward MORE compression, with a noise-based

        // safety margin and a min-frame-VMAF guard.

        try {

            var interpPts = aggregatedResults.filter(function(r) {

                return r.parameterSet && isFinite(Number(r.parameterSet.quality)) && isFinite(r.avgVMAF);

            }).map(function(r) {

                return {

                    cq: Number(r.parameterSet.quality),

                    vmaf: r.avgVMAF,

                    w: Math.max(1, r.sampleCount || 1),

                    minV: (r.vmafP1Low !== null && r.vmafP1Low !== undefined && isFinite(r.vmafP1Low)) ? r.vmafP1Low

                        : ((r.minVMAF !== null && r.minVMAF !== undefined && isFinite(r.minVMAF)) ? r.minVMAF : null)

                };

            }).sort(function(a, b) { return a.cq - b.cq; });

            // Isotonic smoothing (PAVA): enforce the physically-required non-increasing

            // VMAF-vs-CQ shape across ALL tested points before interpolating, so a noisy

            // measurement at either bracketing CQ cannot skew the landing spot.

            if (interpPts.length >= 3) {

                var pavaBlocks = [];

                for (var pb = 0; pb < interpPts.length; pb++) {

                    pavaBlocks.push({ s: pb, e: pb + 1, w: interpPts[pb].w, v: -interpPts[pb].vmaf });

                    while (pavaBlocks.length >= 2) {

                        var pb0 = pavaBlocks[pavaBlocks.length - 2];

                        var pb1 = pavaBlocks[pavaBlocks.length - 1];

                        if (pb0.v <= pb1.v) break;

                        var pbw = pb0.w + pb1.w;

                        pavaBlocks.splice(pavaBlocks.length - 2, 2, { s: pb0.s, e: pb1.e, w: pbw, v: (pb0.v * pb0.w + pb1.v * pb1.w) / pbw });

                    }

                }

                pavaBlocks.forEach(function(b) {

                    for (var pj = b.s; pj < b.e; pj++) {

                        if (Math.abs(-b.v - interpPts[pj].vmaf) > 0.001) {

                            interpPts[pj].vmafRaw = interpPts[pj].vmaf;

                        }

                        interpPts[pj].vmaf = -b.v;

                    }

                });

            }

            var selCqVal = Number(bestParams.parameterSet.quality);

            var selPtIdx = -1;

            for (var ip = 0; ip < interpPts.length; ip++) {

                if (Math.abs(interpPts[ip].cq - selCqVal) < 0.001) { selPtIdx = ip; break; }

            }

            var selPt = selPtIdx !== -1 ? interpPts[selPtIdx] : null;

            var nextPt = (selPtIdx !== -1 && selPtIdx + 1 < interpPts.length) ? interpPts[selPtIdx + 1] : null;

            var noiseSel = (bestParams.vmafStdDev !== undefined && bestParams.vmafStdDev !== null && bestParams.vmafStdDev > 0)

                ? bestParams.vmafStdDev : 0.8;

            var interpMargin = Math.max(0.4, 0.35 * noiseSel);

            var interpTarget = adjustedMinVMAF + interpMargin;

            if (selPt && nextPt && selPt.vmaf > interpTarget && nextPt.vmaf < interpTarget && selPt.vmaf > nextPt.vmaf) {

                var fracCq = selPt.cq + (interpTarget - selPt.vmaf) * (nextPt.cq - selPt.cq) / (nextPt.vmaf - selPt.vmaf);

                // Min-frame guard: don't cross the per-frame quality floor either.

                if (adjustedMinFrameVMAF > 0 && selPt.minV !== null && nextPt.minV !== null && nextPt.minV < adjustedMinFrameVMAF) {

                    var frameTarget = adjustedMinFrameVMAF + 0.5;

                    if (selPt.minV > frameTarget && selPt.minV > nextPt.minV) {

                        var fracCqFrame = selPt.cq + (frameTarget - selPt.minV) * (nextPt.cq - selPt.cq) / (nextPt.minV - selPt.minV);

                        fracCq = Math.min(fracCq, fracCqFrame);

                    } else {

                        fracCq = selPt.cq; // frame floor already at risk - stay put

                    }

                }

                fracCq = Math.max(selPt.cq, Math.min(nextPt.cq - 0.1, fracCq));

                fracCq = Math.round(fracCq * 10) / 10;

                if (fracCq > selPt.cq + 0.05) {

                    var slope = (nextPt.vmaf - selPt.vmaf) / (nextPt.cq - selPt.cq);

                    var predictedVmaf = selPt.vmaf + slope * (fracCq - selPt.cq);

                    var predictedMinV = (selPt.minV !== null && nextPt.minV !== null)

                        ? selPt.minV + ((nextPt.minV - selPt.minV) / (nextPt.cq - selPt.cq)) * (fracCq - selPt.cq)

                        : bestParams.minVMAF;

                    var interpParamSet = {};

                    for (var pk in bestParams.parameterSet) {

                        if (Object.prototype.hasOwnProperty.call(bestParams.parameterSet, pk)) {

                            interpParamSet[pk] = bestParams.parameterSet[pk];

                        }

                    }

                    interpParamSet.quality = fracCq;

                    interpParamSet.id = String(bestParams.parameterSet.id || bestParams.parameterSetId || 'sel') + '_cqi' + fracCq;

                    args.jobLog('');

                    args.jobLog('=== Fractional CQ Refinement ===');

                    args.jobLog('Selected CQ ' + selPt.cq + ' (VMAF ' + selPt.vmaf.toFixed(2) + ') overshoots target ' + adjustedMinVMAF

                        + '; next tested CQ ' + nextPt.cq + ' (VMAF ' + nextPt.vmaf.toFixed(2) + ') undershoots.');

                    args.jobLog('Interpolated CQ ' + fracCq + ' -> predicted VMAF ' + predictedVmaf.toFixed(2)

                        + ' (margin ' + interpMargin.toFixed(2) + ' above threshold, noise ' + noiseSel.toFixed(2) + ')');

                    bestParams = Object.assign({}, bestParams, {

                        parameterSet: interpParamSet,

                        parameterSetId: interpParamSet.id,

                        avgVMAF: predictedVmaf,

                        minVMAF: predictedMinV,

                        vmafInterpolated: true

                    });

                    args.variables.vmafInterpolatedCQ = fracCq;

                    args.variables.vmafInterpolatedFrom = selPt.cq;

                }

            }

        } catch (interpErr) {

            args.jobLog('Fractional CQ refinement skipped: ' + (interpErr && interpErr.message ? interpErr.message : String(interpErr)));

        }

        // Reserved holdout validation: encode a fresh sample that was not part of the CQ

        // sweep and run VMAF/CAMBI on it before handing parameters to the final transcode.

        // If it fails, step to the nearest lower-CQ tested candidate (lower CQ = more bits),

        // or conservatively reduce CQ by two if no tested safer point exists.

        var holdoutFailReason = null;

        var holdoutSuggestedCQ = null;

        try {

            if (args.variables.vmafHoldoutSample && args.inputs.enableHoldoutValidation !== false && args.inputs.enableHoldoutValidation !== 'false') {

                var ho = args.variables.vmafHoldoutSample;

                var chosenCQ = Number(bestParams.parameterSet ? bestParams.parameterSet.quality : bestParams.cq);

                args.jobLog('');

                args.jobLog('=== Holdout Validation ===');

                args.jobLog('Holdout segment at ' + (Number(ho.startTime || 0)).toFixed(1) + 's - validating CQ ' + chosenCQ);

                var holdoutData = runVmafOnHoldout(args, ho, bestParams.parameterSet, qualityRiskPolicy);

                if (holdoutData) {

                    var hoV = Number(holdoutData.avgVMAF) || 0;

                    var hoP1 = Number(holdoutData.vmafP1 !== null && holdoutData.vmafP1 !== undefined ? holdoutData.vmafP1 : holdoutData.minVMAF) || 0;

                    var hoCM = Number(holdoutData.cambiMean) || 0;

                    var hoCP = Number(holdoutData.cambiP95) || 0;

                    var hoCW = Math.max(hoCM, hoCP);

                    var meanFloor = adjustedMinVMAF;

                    var frameFloor = adjustedMinFrameVMAF;

                    var cambiLimit = qualityRiskPolicy ? (qualityRiskPolicy.isHDR ? 5.0 : (qualityRiskPolicy.isAnimation ? 6.0 : 5.5)) : 5.5;

                    // Source-relative CAMBI for holdout

                    if (sourceCambiRisk !== null) {

                        cambiLimit = Math.max(cambiLimit, sourceCambiRisk + 1.0);

                    }

                    // Per-segment source CAMBI (this holdout's OWN banding, self-compared in
                    // runVmafOnHoldout). Preferred over the job-global sweep-clip source CAMBI: judge
                    // the holdout on the banding the ENCODE added, not banding inherent to the source.
                    var hoSrcCM = Number(holdoutData.srcCambiMean);

                    var hoSrcCP = Number(holdoutData.srcCambiP95);

                    var hoSrcCW = Math.max(isFinite(hoSrcCM) ? hoSrcCM : -Infinity, isFinite(hoSrcCP) ? hoSrcCP : -Infinity);

                    if (isFinite(hoSrcCW)) {

                        cambiLimit = Math.max(cambiLimit, hoSrcCW + 1.0);

                    }

                    args.jobLog('Holdout: VMAF=' + hoV.toFixed(2)

                        + ', 1%-low=' + hoP1.toFixed(2)

                        + ', CAMBI=' + hoCM.toFixed(3) + ' (p95=' + hoCP.toFixed(3) + ')'
                        + (isFinite(hoSrcCW) ? ', srcCAMBI=' + hoSrcCW.toFixed(3) + ' (encode-delta=' + (hoCW - hoSrcCW).toFixed(3) + ')' : ''));

                    var vmafOk = hoV >= meanFloor;

                    var floorOk = !(frameFloor > 0) || hoP1 >= frameFloor;

                    var cambiOk = hoCW <= cambiLimit;

                    args.jobLog('  Floors: VMAF>=' + meanFloor.toFixed(1)

                        + ', 1%-low>=' + frameFloor.toFixed(1)

                        + ', CAMBI<=' + cambiLimit.toFixed(1)

                        + ' => ' + (vmafOk ? 'OK' : 'FAIL') + '/' + (floorOk ? 'OK' : 'FAIL') + '/' + (cambiOk ? 'OK' : 'FAIL'));

                    args.variables.vmafHoldoutVMAF = hoV;

                    args.variables.vmafHoldoutP1VMAF = hoP1;

                    args.variables.vmafHoldoutCAMBI = hoCM;

                    args.variables.vmafHoldoutCAMBIP95 = hoCP;

                    if (!vmafOk || !floorOk || !cambiOk) {

                        holdoutFailReason = 'vmaf=' + vmafOk + ',floor=' + floorOk + ',cambi=' + cambiOk;

                        var safer = null;

                        for (var sk = 0; sk < validResults.length; sk++) {

                            var sr = validResults[sk];

                            if (sr && sr.parameterSet && isFinite(Number(sr.parameterSet.quality)) && Number(sr.parameterSet.quality) < chosenCQ) {

                                if (!safer || Number(sr.parameterSet.quality) > Number(safer.parameterSet.quality)) safer = sr;

                            }

                        }

                        if (safer) {

                            holdoutSuggestedCQ = Number(safer.parameterSet.quality);

                            args.jobLog('Holdout FAILED - stepping back to tested safer CQ ' + holdoutSuggestedCQ);

                            bestParams = safer;

                        } else {

                            holdoutSuggestedCQ = Math.max(1, Math.round((chosenCQ - 2) * 10) / 10);

                            args.jobLog('Holdout FAILED - no lower-CQ tested candidate available; reducing CQ ' + chosenCQ + ' -> ' + holdoutSuggestedCQ);

                            var hoParamSet = {};

                            for (var hk in bestParams.parameterSet) {

                                if (Object.prototype.hasOwnProperty.call(bestParams.parameterSet, hk)) hoParamSet[hk] = bestParams.parameterSet[hk];

                            }

                            hoParamSet.quality = holdoutSuggestedCQ;

                            hoParamSet.id = String(hoParamSet.id || bestParams.parameterSetId || 'sel') + '_holdoutcq' + holdoutSuggestedCQ;

                            bestParams = Object.assign({}, bestParams, { parameterSet: hoParamSet, parameterSetId: hoParamSet.id });

                        }

                    } else {

                        args.jobLog('Holdout PASSED');

                    }

                } else {

                    args.jobLog('Holdout returned no VMAF data - proceeding with chosen CQ');

                }

            } else {

                args.jobLog('Holdout validation skipped: no reserved holdout sample available');

            }

        } catch (hoErr) {

            args.jobLog('Holdout validation error (proceeding with chosen CQ): ' + (hoErr && hoErr.message ? hoErr.message : String(hoErr)));

        }

        args.variables.vmafHoldoutFailReason = holdoutFailReason;

        args.variables.vmafHoldoutSuggestedCQ = holdoutSuggestedCQ;

        args.variables.vmafBestParameters = bestParams.parameterSet;

        // ── ACTING: constraint-aware CQ selector. Uses the SAME measured per-job curve
        // (VMAF mean + 1%-low + CAMBI p95) but interpolates on a 0.1 CQ grid, so we can land
        // just below the binding constraint instead of falling all the way back to the previous
        // measured CQ. This replaces the old shadow-only selectCQ path.
        try {
            var _vp = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafpredict.js');
            var _agg = args.variables.vmafAggregatedResults || [];
            var _curve = [];
            for (var _ai = 0; _ai < _agg.length; _ai++) {
                var _a = _agg[_ai], _ps = _a.parameterSet || {};
                var _cq = Number(_ps.cq != null ? _ps.cq : _ps.quality);
                if (!isFinite(_cq)) continue;
                _curve.push({
                    cq: _cq,
                    vmaf_mean: _a.avgVMAFMean != null ? Number(_a.avgVMAFMean) : (Number(_a.avgVMAF) || null),
                    vmaf_p1_low: _a.vmafP1Low != null ? Number(_a.vmafP1Low) : null,
                    cambi_p95: _a.p95CAMBI != null ? Number(_a.p95CAMBI) : null,
                    avg_size_mb: Number(_a.avgFileSizeMB) || null,
                    bits_per_pixel: null, source_codec: ''
                });
            }
            function _metricAt(cq, getter) {
                var pts = [];
                for (var mi = 0; mi < _agg.length; mi++) {
                    var ma = _agg[mi], mps = ma.parameterSet || {};
                    var mcq = Number(mps.cq != null ? mps.cq : mps.quality);
                    var mv = getter(ma);
                    if (isFinite(mcq) && mv != null && isFinite(Number(mv))) pts.push({ cq: mcq, v: Number(mv) });
                }
                if (!pts.length) return null;
                pts.sort(function(a, b) { return a.cq - b.cq; });
                if (cq <= pts[0].cq) return pts[0].v;
                if (cq >= pts[pts.length - 1].cq) return pts[pts.length - 1].v;
                for (var pi = 0; pi < pts.length - 1; pi++) {
                    var p0 = pts[pi], p1 = pts[pi + 1];
                    if (cq >= p0.cq && cq <= p1.cq && p1.cq !== p0.cq) {
                        return p0.v + ((p1.v - p0.v) * (cq - p0.cq) / (p1.cq - p0.cq));
                    }
                }
                return null;
            }
            var _tgt = Number(args.variables.vmafMinVMAF) || 95;
            var _floor = Number(args.variables.vmafMinFrameVMAF)
                || (args.variables.vmafQualityRiskPolicy && Number(args.variables.vmafQualityRiskPolicy.adaptiveFrameFloor)) || null;
            var _cambiBase = args.variables.isHDR ? 5.0 : (args.variables.vmafMediaIsAnimation === true ? 6.0 : 5.5);
            var _effCambi = _vp.effectiveCambiFloor({ cambiFloor: _cambiBase, sourceCambi: args.variables.vmafSourceCAMBI, sourceCambiP95: args.variables.vmafSourceCAMBIP95 });
            var _sel = _vp.selectCQ(_curve, {}, {
                targetVmaf: _tgt, vmafFloor: _floor, cambiFloor: _cambiBase,
                sourceCambi: args.variables.vmafSourceCAMBI, sourceCambiP95: args.variables.vmafSourceCAMBIP95
            }, { minSupport: 0.05, cqBandwidth: 1.5, cqStep: 0.1 });
            var _liveCq = (bestParams.parameterSet && (bestParams.parameterSet.cq != null ? bestParams.parameterSet.cq : bestParams.parameterSet.quality));
            args.jobLog('[ACTING] constraint-aware selectCQ pick=' + (_sel.cq != null ? _sel.cq : 'none')
                + ' (binding=' + _sel.bindingConstraint + ', predVMAF=' + (_sel.predictedVmaf != null ? _sel.predictedVmaf.toFixed(2) : 'n/a')
                + ', pred1%low=' + (_sel.predictedP1Low != null ? _sel.predictedP1Low.toFixed(2) : 'n/a')
                + ', predCAMBI_p95=' + (_sel.predictedCambi != null ? _sel.predictedCambi.toFixed(2) : 'n/a')
                + ', effCambiFloor=' + (_effCambi != null ? _effCambi.toFixed(2) : 'n/a')
                + ') vs measured-core pick CQ=' + _liveCq);

            if (_sel.cq != null && isFinite(Number(_sel.cq)) && isFinite(Number(_liveCq)) && Number(_sel.cq) > Number(_liveCq) + 0.05) {
                var _preSelectParams = bestParams;
                var _newCq = Math.round(Number(_sel.cq) * 10) / 10;
                var _paramSet = {};
                for (var _pk in bestParams.parameterSet) {
                    if (Object.prototype.hasOwnProperty.call(bestParams.parameterSet, _pk)) _paramSet[_pk] = bestParams.parameterSet[_pk];
                }
                _paramSet.quality = _newCq;
                if (_paramSet.cq != null) _paramSet.cq = _newCq;
                _paramSet.id = String(bestParams.parameterSet.id || bestParams.parameterSetId || 'sel') + '_cqa' + _newCq;
                var _predV = _sel.predictedVmaf != null ? Number(_sel.predictedVmaf) : _metricAt(_newCq, function(x) { return x.avgVMAFMean != null ? x.avgVMAFMean : x.avgVMAF; });
                var _predP1 = _sel.predictedP1Low != null ? Number(_sel.predictedP1Low) : _metricAt(_newCq, function(x) { return x.vmafP1Low; });
                var _predP95Cambi = _sel.predictedCambi != null ? Number(_sel.predictedCambi) : _metricAt(_newCq, function(x) { return x.p95CAMBI; });
                var _predAvgCambi = _metricAt(_newCq, function(x) { return x.avgCAMBI; });
                var _predSize = _sel.predictedSizeMb != null ? Number(_sel.predictedSizeMb) : _metricAt(_newCq, function(x) { return x.avgFileSizeMB; });
                var _predSSIM = _metricAt(_newCq, function(x) { return x.avgSSIM; });
                bestParams = Object.assign({}, bestParams, {
                    parameterSet: _paramSet,
                    parameterSetId: _paramSet.id,
                    avgVMAF: _predV != null ? _predV : bestParams.avgVMAF,
                    avgVMAFMean: _predV != null ? _predV : bestParams.avgVMAFMean,
                    minVMAF: _predP1 != null ? _predP1 : bestParams.minVMAF,
                    vmafP1Low: _predP1 != null ? _predP1 : bestParams.vmafP1Low,
                    avgCAMBI: _predAvgCambi != null ? _predAvgCambi : bestParams.avgCAMBI,
                    p95CAMBI: _predP95Cambi != null ? _predP95Cambi : bestParams.p95CAMBI,
                    avgFileSizeMB: _predSize != null ? _predSize : bestParams.avgFileSizeMB,
                    avgSSIM: _predSSIM != null ? _predSSIM : bestParams.avgSSIM,
                    vmafConstraintAware: true
                });
                args.variables.vmafConstraintAwareCQApplied = true;
                args.variables.vmafConstraintAwareCQ = _newCq;
                args.variables.vmafMaxCompressionApplied = true;
                selectionMethod += ' + constraint-aware fractional selectCQ';
                args.jobLog('[ACTING] Constraint-aware CQ override: CQ ' + _liveCq + ' -> ' + _newCq
                    + ' (pred VMAF=' + (bestParams.avgVMAF != null ? bestParams.avgVMAF.toFixed(2) : 'n/a')
                    + ', pred 1%-low=' + (bestParams.vmafP1Low != null ? bestParams.vmafP1Low.toFixed(2) : 'n/a')
                    + ', pred CAMBI_p95=' + (bestParams.p95CAMBI != null ? bestParams.p95CAMBI.toFixed(2) : 'n/a') + ')');

                // Re-run holdout against the harder fractional CQ. The earlier holdout validated
                // the measured-core CQ; this validates the CQ that will actually be transcoded.
                if (args.variables.vmafHoldoutSample && args.inputs.enableHoldoutValidation !== false && args.inputs.enableHoldoutValidation !== 'false') {
                    var _ho2 = args.variables.vmafHoldoutSample;
                    args.jobLog('');
                    args.jobLog('=== Constraint-aware Holdout Validation ===');
                    args.jobLog('Holdout segment at ' + (Number(_ho2.startTime || 0)).toFixed(1) + 's - validating CQ ' + _newCq);
                    var _hd2 = runVmafOnHoldout(args, _ho2, bestParams.parameterSet, qualityRiskPolicy);
                    if (_hd2) {
                        var _hv2 = Number(_hd2.avgVMAF) || 0;
                        var _hp12 = Number(_hd2.vmafP1 !== null && _hd2.vmafP1 !== undefined ? _hd2.vmafP1 : _hd2.minVMAF) || 0;
                        var _hcm2 = Number(_hd2.cambiMean) || 0;
                        var _hcp2 = Number(_hd2.cambiP95) || 0;
                        var _hcw2 = Math.max(_hcm2, _hcp2);
                        var _hsCM2 = Number(_hd2.srcCambiMean), _hsCP2 = Number(_hd2.srcCambiP95);
                        var _hsCW2 = Math.max(isFinite(_hsCM2) ? _hsCM2 : -Infinity, isFinite(_hsCP2) ? _hsCP2 : -Infinity);
                        var _lim2 = _effCambi;
                        if (isFinite(_hsCW2)) _lim2 = Math.max(_lim2, _hsCW2 + 1.0);
                        args.jobLog('Constraint-aware holdout: VMAF=' + _hv2.toFixed(2)
                            + ', 1%-low=' + _hp12.toFixed(2)
                            + ', CAMBI=' + _hcm2.toFixed(3) + ' (p95=' + _hcp2.toFixed(3) + ')'
                            + (isFinite(_hsCW2) ? ', srcCAMBI=' + _hsCW2.toFixed(3) + ' (encode-delta=' + (_hcw2 - _hsCW2).toFixed(3) + ')' : ''));
                        var _ok2 = (_hv2 >= _tgt) && (_floor == null || _hp12 >= _floor) && (_lim2 == null || _hcw2 <= _lim2);
                        args.jobLog(' Floors: VMAF>=' + _tgt.toFixed(1)
                            + ', 1%-low>=' + (_floor != null ? _floor.toFixed(1) : 'n/a')
                            + ', CAMBI<=' + (_lim2 != null ? _lim2.toFixed(1) : 'n/a')
                            + ' => ' + (_hv2 >= _tgt ? 'OK' : 'FAIL') + '/'
                            + ((_floor == null || _hp12 >= _floor) ? 'OK' : 'FAIL') + '/'
                            + ((_lim2 == null || _hcw2 <= _lim2) ? 'OK' : 'FAIL'));
                        if (!_ok2) {
                            holdoutFailReason = 'constraint_aware_holdout_failed';
                            holdoutSuggestedCQ = Number(_preSelectParams.parameterSet.quality);
                            bestParams = _preSelectParams;
                            args.variables.vmafConstraintAwareCQApplied = false;
                            args.variables.vmafConstraintAwareCQReverted = true;
                            args.variables.vmafHoldoutFailReason = holdoutFailReason;
                            args.variables.vmafHoldoutSuggestedCQ = holdoutSuggestedCQ;
                            args.jobLog('Constraint-aware holdout FAILED - reverting to measured CQ ' + holdoutSuggestedCQ);
                        } else {
                            args.jobLog('Constraint-aware holdout PASSED');
                        }
                    } else {
                        args.jobLog('Constraint-aware holdout returned no VMAF data - keeping selected CQ');
                    }
                }
            }
        } catch (_acErr) {
            args.jobLog('[ACTING] constraint-aware selectCQ skipped (non-fatal): ' + (_acErr && _acErr.message ? _acErr.message : String(_acErr)));
        }

        args.variables.vmafBestVMAF = bestParams.avgVMAF;

        args.variables.vmafBestMinVMAF = bestParams.minVMAF;

        args.variables.vmafBestSSIM = (bestParams.avgSSIM !== null && bestParams.avgSSIM !== undefined) ? bestParams.avgSSIM : null;

        args.variables.vmafBestSize = bestParams.avgFileSizeMB;

        args.variables.vmafStrategy = strategy;

        args.variables.vmafMinVMAF = minVMAF;

        args.variables.vmafMinFrameVMAF = minFrameVMAF;

        args.variables.vmafSelectionMethod = selectionMethod;

        args.variables.vmafRecommendedPixFmt = recommendedPixFmt;

        args.variables.vmafSelectedStdDev = bestParams.vmafStdDev;

        // ── CQ Decision Summary: one scannable block that answers "what CQ was picked, and why",
        // including the path across a multi-attempt CQ retry sweep. Sits above the detailed
        // === Selected Parameters === dump below. Non-fatal: never break selection over logging.
        try {

            var _finalCQ = (bestParams.parameterSet && isFinite(Number(bestParams.parameterSet.quality)))
                ? Number(bestParams.parameterSet.quality) : null;

            var _finalP1 = (bestParams.vmafP1Low !== null && bestParams.vmafP1Low !== undefined && isFinite(bestParams.vmafP1Low))
                ? bestParams.vmafP1Low
                : ((bestParams.minVMAF !== null && bestParams.minVMAF !== undefined) ? bestParams.minVMAF : null);

            var _finalCambi = Math.max(Number(bestParams.avgCAMBI || 0), Number(bestParams.p95CAMBI || 0));

            var _attN = (Number(args.variables.vmafRetryCount) || 0) + 1;

            var _attM = (Number(args.variables.vmafMaxRetries) || 4) + 1;

            // Post-selection guards that can move the CQ off the core sweep pick.
            var _guards = [];

            if (args.variables.vmafSsimVetoApplied) _guards.push('SSIM veto');

            if (args.variables.vmafXpsnrVetoApplied) _guards.push('XPSNR veto');

            if (args.variables.vmafInterpolatedCQ != null) _guards.push('fractional refine');

            if (args.variables.vmafHoldoutFailReason) _guards.push('holdout step-back');

            if (args.variables.vmafConstraintAwareCQApplied) _guards.push('constraint-aware fractional selectCQ');
            if (args.variables.vmafMaxCompressionApplied && !args.variables.vmafConstraintAwareCQApplied) _guards.push('max-compression override');

            // The next-more-aggressive CQ tested this attempt but rejected, and why — the direct
            // answer to "why not compress harder?".
            var _nextHigher = null;

            for (var _ri = 0; _ri < rejectedResults.length; _ri++) {
                var _rj = rejectedResults[_ri];
                if (_finalCQ !== null && isFinite(_rj.cq) && _rj.cq > _finalCQ
                    && (!_nextHigher || _rj.cq < _nextHigher.cq)) _nextHigher = _rj;
            }

            // CQs tested in THIS attempt (this sweep's aggregated results) vs all attempts.
            var _thisCQs = [];

            for (var _ai = 0; _ai < aggregatedResults.length; _ai++) {
                var _q = aggregatedResults[_ai].parameterSet && aggregatedResults[_ai].parameterSet.quality;
                if (isFinite(Number(_q)) && _thisCQs.indexOf(Number(_q)) === -1) _thisCQs.push(Number(_q));
            }

            _thisCQs.sort(function (a, b) { return a - b; });

            var _allCQs = (args.variables.vmafTestedCQs || []).slice().map(Number)
                .filter(function (n) { return isFinite(n); }).sort(function (a, b) { return a - b; });

            args.jobLog('');

            args.jobLog('=== CQ Decision Summary ===');

            args.jobLog('FINAL: CQ ' + (_finalCQ !== null ? _finalCQ : '?')
                + ' — VMAF ' + bestParams.avgVMAF.toFixed(2) + ' (target ' + adjustedMinVMAF + ')'
                + ', 1%-low ' + (_finalP1 !== null ? _finalP1.toFixed(2) : 'n/a')
                + (adjustedMinFrameVMAF > 0 ? ' (floor ' + adjustedMinFrameVMAF + ')' : '')
                + ', CAMBI ' + _finalCambi.toFixed(2)
                + ', ' + (bestParams.avgFileSizeMB != null ? bestParams.avgFileSizeMB.toFixed(2) + ' MB sample' : 'size n/a'));

            args.jobLog('Rule: ' + selectionMethod);

            if (rawStrategyCQ !== null && _finalCQ !== null && rawStrategyCQ !== _finalCQ) {
                args.jobLog('Path: core sweep pick CQ ' + rawStrategyCQ + ' → CQ ' + _finalCQ
                    + (_guards.length ? ' via ' + _guards.join(', ') : ''));
            } else {
                args.jobLog('Path: core sweep pick CQ '
                    + (rawStrategyCQ !== null ? rawStrategyCQ : (_finalCQ !== null ? _finalCQ : '?'))
                    + ', unchanged by post-selection guards'
                    + (_guards.length ? ' (noted: ' + _guards.join(', ') + ')' : ''));
            }

            args.jobLog('Sweep: attempt ' + _attN + ' of ' + _attM
                + '; this attempt tested CQ ' + (_thisCQs.length ? _thisCQs.join(', ') : '?')
                + (_allCQs.length && _attN > 1 ? '; all attempts tested CQ ' + _allCQs.join(', ') : ''));

            if (_nextHigher) {
                args.jobLog('Why not compress harder? CQ ' + _nextHigher.cq + ' rejected: ' + _nextHigher.reason);
            } else if (_finalCQ !== null) {
                args.jobLog('Why not compress harder? No higher tested CQ passed — CQ ' + _finalCQ
                    + ' is the most aggressive that held quality this attempt.');
            }

        } catch (_sumErr) {
            args.jobLog('CQ Decision Summary skipped (non-fatal): ' + (_sumErr && _sumErr.message ? _sumErr.message : String(_sumErr)));
        }

        args.jobLog('');

        args.jobLog('=== Selected Parameters ===');

        args.jobLog('Selection method: ' + selectionMethod);

        args.jobLog('Parameter set: ' + bestParams.parameterSetId);

        args.jobLog('VMAF (Harmonic Mean): ' + bestParams.avgVMAF.toFixed(2));

        if (bestParams.avgVMAFMean !== null && bestParams.avgVMAFMean !== undefined) {

            args.jobLog('VMAF (Arithmetic Mean): ' + bestParams.avgVMAFMean.toFixed(2));

        }

        if (bestParams.minVMAF !== null && bestParams.minVMAF !== undefined) {

            args.jobLog('VMAF (Min Frame): ' + bestParams.minVMAF.toFixed(2));

        }

        if (bestParams.vmafStdDev !== undefined && bestParams.vmafStdDev !== null) {

            args.jobLog('VMAF StdDev (samples @ CQ): ' + bestParams.vmafStdDev.toFixed(2));

        }

        args.jobLog('Sample Size: ' + bestParams.avgFileSizeMB.toFixed(2) + ' MB (sample only, not extrapolated)');

        if (bestParams.avgSSIM !== null && bestParams.avgSSIM !== undefined) {

            args.jobLog('SSIM: ' + bestParams.avgSSIM.toFixed(2));

        }

        if (bestParams.avgCAMBI !== null && bestParams.avgCAMBI !== undefined) {

            args.jobLog('CAMBI banding score: avg=' + bestParams.avgCAMBI.toFixed(2)
                + (bestParams.p95CAMBI !== null && bestParams.p95CAMBI !== undefined ? ', p95=' + bestParams.p95CAMBI.toFixed(2) : '')
                + ', worst=' + Math.max(Number(bestParams.avgCAMBI || 0), Number(bestParams.p95CAMBI || 0)).toFixed(2)
                + ' (gate uses worst; lower is better; ~5 starts to become annoying)');

        }

        if (bestParams.projectedOutputBpp !== undefined) {

            args.jobLog('Sample-size projection (diagnostic/quality-risk only; live size monitor decides final size): '

                + (bestParams.projectedOutputRatioPct || 0).toFixed(1) + '% source, '

                + (bestParams.projectedOutputMbps || 0).toFixed(2) + ' Mbps, BPP ' + (bestParams.projectedOutputBpp || 0).toFixed(4));

        }

        args.jobLog('Recommended Pixel Format: ' + recommendedPixFmt);

    args.jobLog('Note: Final file size will be verified during transcode using live monitoring');

        // Analyze CQ range effectiveness

        args.jobLog('');

        args.jobLog('=== CQ Range Analysis ===');

        // Find the range of CQ values tested and their VMAF scores

        var cqValues = [];

        var vmafByCQ = {};

        for (var i = 0; i < aggregatedResults.length; i++) {

            var r = aggregatedResults[i];

            if (r.parameterSet && r.parameterSet.quality !== undefined) {

                var cq = r.parameterSet.quality;

                if (vmafByCQ[cq] === undefined) {

                    cqValues.push(cq);

                    vmafByCQ[cq] = r.avgVMAF;

                }

            }

        }

        cqValues.sort(function(a, b) { return a - b; });

        if (cqValues.length >= 2) {

            var lowestCQ = cqValues[0];

            var highestCQ = cqValues[cqValues.length - 1];

            var vmafAtLowestCQ = vmafByCQ[lowestCQ];

            var vmafAtHighestCQ = vmafByCQ[highestCQ];

            args.jobLog('CQ range tested: ' + lowestCQ + ' - ' + highestCQ);

            args.jobLog('VMAF at CQ ' + lowestCQ + ' (lowest/highest quality): ' + vmafAtLowestCQ.toFixed(2));

            args.jobLog('VMAF at CQ ' + highestCQ + ' (highest/lowest quality): ' + vmafAtHighestCQ.toFixed(2));

            // Check if we should recommend a different CQ range

            var vmafHeadroom = vmafAtHighestCQ - minVMAF;

            var vmafMargin = vmafAtLowestCQ - 100; // How far from perfect

            if (vmafHeadroom > 5) {

                args.jobLog('');

                args.jobLog('💡 SUGGESTION: There is ' + vmafHeadroom.toFixed(1) + ' VMAF points headroom above minimum threshold.');

                args.jobLog('   Consider testing higher CQ values (e.g., CQ ' + (highestCQ + 2) + '-' + (highestCQ + 8) + ') for better compression.');

                args.variables.vmafSuggestedCQMin = highestCQ;

                args.variables.vmafSuggestedCQMax = Math.min(highestCQ + 10, 51);

            }

            if (vmafAtLowestCQ < 99 && validResults.length < aggregatedResults.length * 0.5) {

                args.jobLog('');

                args.jobLog('💡 SUGGESTION: Many parameter sets were rejected. Consider testing lower CQ values for higher quality.');

                args.variables.vmafSuggestedCQMin = Math.max(lowestCQ - 6, 1);

                args.variables.vmafSuggestedCQMax = lowestCQ;

            }

        }

        // Store learning data for Bayesian learning plugin

        var sourceBitrateMbps = args.variables.vmafSourceBitrateMbps || 0;

        var sourceWidth = 1920;

        var sourceHeight = 1080;

        var sourceCodec = 'unknown';

        var sourceDuration = 0;

        var sourceFileSizeRaw = Number(args.inputFileObj && args.inputFileObj.file_size || 0);
        var sourceFileSizeMB = sourceFileSizeRaw > 1024 * 1024 ? (sourceFileSizeRaw / 1024 / 1024) : sourceFileSizeRaw;

        var bitsPerPixel = args.variables.vmafSourceBpp || 0;

        if (args.inputFileObj.ffProbeData) {

            var format = args.inputFileObj.ffProbeData.format || {};

            var streams = args.inputFileObj.ffProbeData.streams || [];

            sourceDuration = parseFloat(format.duration) || 0;

            // Find video stream

            for (var i = 0; i < streams.length; i++) {

                if (streams[i].codec_type === 'video') {

                    sourceWidth = streams[i].width || 1920;

                    sourceHeight = streams[i].height || 1080;

                    sourceCodec = streams[i].codec_name || 'unknown';

                    break;

                }

            }

        }

        // Get tested CQ range

        var testedCQMin = lowestCQ || (args.variables.vmafCQRange?.min || 24);

        var testedCQMax = highestCQ || (args.variables.vmafCQRange?.max || 32);

        // Resolve VMAF model path based on resolution for downstream calculateVMAF plugin

        var fs2 = require('fs');

        var model4k = '/usr/local/share/model/vmaf_4k_v0.6.1.json';

        var modelStd = '/usr/local/share/model/vmaf_v0.6.1.json';

        var vmafModelPath = (sourceWidth >= 3840 || sourceHeight >= 2160)

            ? (fs2.existsSync(model4k) ? model4k : modelStd)

            : modelStd;

        args.variables.vmafModelPath = vmafModelPath;

        args.jobLog('  VMAF model: ' + require('path').basename(vmafModelPath) + ' for ' + sourceWidth + 'x' + sourceHeight);

        args.variables.vmafLearningData = {

            source_bitrate_mbps: sourceBitrateMbps,

            source_width: sourceWidth,

            source_height: sourceHeight,

            source_codec: sourceCodec,

            source_duration_sec: sourceDuration,

            source_file_size_mb: sourceFileSizeMB,

            bits_per_pixel: bitsPerPixel,

            tested_cq_min: testedCQMin,

            tested_cq_max: testedCQMax,

            selected_cq: bestParams.parameterSet.quality,

            selected_vmaf: bestParams.avgVMAF,

            selected_ssim: bestParams.avgSSIM !== undefined ? bestParams.avgSSIM : null,

            selected_cambi: bestParams.avgCAMBI !== undefined ? bestParams.avgCAMBI : null,

            selected_projected_output_bpp: bestParams.projectedOutputBpp !== undefined ? bestParams.projectedOutputBpp : null,

            selected_projected_output_ratio_pct: bestParams.projectedOutputRatioPct !== undefined ? bestParams.projectedOutputRatioPct : null,

            target_min_vmaf: minVMAF,

            release_group: releaseGroup,

            media_source_type: mediaSourceType,

            vmaf_model_path: vmafModelPath,

            actual_size_reduction_pct: null, // Unknown until a full-output size is measured

            met_vmaf_target: bestParams.avgVMAF >= minVMAF,

          met_frame_floor_target: bestParams.vmafP1Low !== null && bestParams.vmafP1Low !== undefined

              ? (bestParams.vmafP1Low >= adjustedMinFrameVMAF)

              : null,

          adaptive_frame_floor_used: adjustedMinFrameVMAF,

          met_size_target: null, // Unknown until a full-output size is measured

          size_target_status: 'unknown',

          projected_size_reduction_pct: bestParams.projectedOutputRatioPct !== undefined ? (100 - Number(bestParams.projectedOutputRatioPct)) : null

        };

        // Store output number for retry check

        args.variables.vmafSelectOutput = 1;

        return {

            outputFileObj: args.inputFileObj,

            outputNumber: 1,

            variables: args.variables,

        };

    } else {

        args.jobLog('ERROR: Could not select best parameters');

        // Store output number for retry check

        args.variables.vmafSelectOutput = 2;

        return {

            outputFileObj: args.inputFileObj,

            outputNumber: 2,

            variables: args.variables,

        };

    }

};

exports.plugin = plugin;
