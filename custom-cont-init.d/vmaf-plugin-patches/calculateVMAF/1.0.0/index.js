"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var canonicalDenoise = require('../../_lib/canonicalDenoise.js');
var grainVmafContract = require('../../_lib/grainVmafContract.js');
var currentContractMeasurementHistory = require('../../_lib/currentContractMeasurementHistory.js');
var vmafMetricContract = require('../../_lib/vmafMetricContract.js');
var preFgsCambi = require('../../_lib/preFgsCambi.js');
var pairedCqShadow = require('../../_lib/pairedCqShadow.js');
var vmafV1Cpu = require('../../_lib/vmafV1Cpu.js');
var details = function () { return ({
    name: 'Calculate VMAF',
    description: 'Calculates GPU VMAF plus required CPU pre-FGS CAMBI on grain-free encoded samples against the authenticated reference domain.',
    style: {
        borderColor: 'purple',
    },
    tags: 'video,vmaf,quality,gpu',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faChartBar',
    inputs: [
        {
            label: 'CPU VMAF-v1 Qualification Runtime',
            name: 'vmafCpuV1QualificationEnabled',
            type: 'boolean',
            defaultValue: 'false',
            inputUI: { type: 'dropdown', options: ['true', 'false'] },
            tooltip: 'Default-off candidate switch. Execution additionally requires args.variables.vmafCpuV1QualificationAuthorized=true. Uses one native-10-bit CPU VMAF-v1/full-reference-CAMBI FIFO pass and never falls back across contracts.',
        },
        {
            label: 'CPU VMAF-v1 Production Authority',
            name: 'vmafCpuV1ProductionEnabled',
            type: 'boolean',
            defaultValue: 'false',
            inputUI: { type: 'dropdown', options: ['true', 'false'] },
            tooltip: 'Explicit production promotion switch. Unsupported geometry is rejected before activation and retains the existing GPU-v0 contract; once an eligible CPU identity is active, result-level cross-contract fallback is forbidden.',
        },
        {
            label: 'Authorize Provisional HDR/PQ CPU-v1',
            name: 'vmafCpuV1ProductionAllowProvisionalHdr',
            type: 'boolean',
            defaultValue: 'false',
            inputUI: { type: 'dropdown', options: ['true', 'false'] },
            tooltip: 'Independent fail-closed authorization required before the promoted CPU-v1 contract may score HDR/PQ content while HDR calibration remains provisional.',
        },
        {
            label: 'Max Parallel CPU VMAF-v1',
            name: 'maxParallelCpuV1',
            type: 'number',
            defaultValue: '1',
            inputUI: { type: 'text' },
            tooltip: 'Per-job CPU-v1 task count. Fixed at one; the wrapper semaphore enforces the host-wide concurrency limit.',
        },
        {
            label: 'CPU VMAF-v1 Threads Per Score',
            name: 'cpuV1ThreadsPerScore',
            type: 'number',
            defaultValue: '2',
            inputUI: { type: 'text' },
            tooltip: 'Worker threads for each CPU-v1 score, independently clamped to 1-4. This is separate from task concurrency and standalone pre-FGS CAMBI threads.',
        },
        {
            label: 'Pre-FGS CAMBI CPU Threads Per Task',
            name: 'maxParallelVmaf',
            type: 'number',
            defaultValue: '4',
            inputUI: {
                type: 'text',
            },
            tooltip: 'CPU threads for each required standalone pre-FGS CAMBI measurement. This is not a CPU VMAF fallback; GPU VMAF remains mandatory.',
        },
        {
            label: 'Max Parallel GPU VMAF',
            name: 'maxParallelGpuVmaf',
            type: 'number',
            defaultValue: '4',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Maximum number of GPU VMAF jobs to run concurrently (libvmaf_cuda). Keep at or below testEncodingParameters pool size. RTX 5070 Ti handles 4 comfortably. Default: 4, clamp 1-6.',
        },
        {
            label: 'SSIM Mode',
            name: 'ssimMode',
            type: 'string',
            defaultValue: 'off',
            inputUI: {
                type: 'text',
            },
            tooltip: 'When to compute advisory CPU SSIM after VMAF: off (default), first-round, or all. The measured 305-job baseline had zero SSIM vetoes while recent 4K jobs spent about 598s/job on SSIM inside the GPU lock.',
        },
        {
            label: 'VMAF Subsample',
            name: 'vmafSubsample',
            type: 'string',
            defaultValue: '4',
            inputUI: {
                type: 'text',
            },
            tooltip: 'VMAF frame subsampling: 1=every frame (default), 2=every 2nd frame, 4=every 4th frame. Coarser values (2-4) are suitable only for coarse/initial rounds; final binding checks should always use 1. Can be overridden by args.variables.vmafSubsample.',
        },
        {
            label: 'Paired-CQ Shadow',
            name: 'pairedCqShadow',
            type: 'boolean',
            defaultValue: 'true',
            inputUI: { type: 'dropdown', options: ['true', 'false'] },
            tooltip: 'Observe six-anchor adjacent-CQ score reconstruction. Shadow only: every real score still controls the decision.',
        },
        {
            label: 'Paired-CQ Shadow Full Pair',
            name: 'pairedCqShadowForceFull',
            type: 'boolean',
            defaultValue: 'true',
            inputUI: { type: 'dropdown', options: ['true', 'false'] },
            tooltip: 'Once per job, fully score one adjacent CQ pair so the shadow has an unbiased counterfactual. This temporarily adds bounded validation work.',
        },
        {
            label: 'Paired-CQ Shadow Anchors',
            name: 'pairedCqShadowAnchors',
            type: 'number',
            defaultValue: '6',
            inputUI: { type: 'text' },
            tooltip: 'Number of stratified current-CQ anchors used by the observational paired-delta reconstruction.',
        },
        {
            label: 'Paired-CQ Acting Enabled',
            name: 'vmafPairedCqActingEnabled',
            type: 'boolean',
            defaultValue: 'false',
            inputUI: { type: 'dropdown', options: ['true', 'false'] },
            tooltip: 'Default-off kill switch. When explicitly enabled, one exact-contract adjacent harder CQ may infer non-anchor metrics from six deterministic anchors. Any failed prerequisite measures all clips normally.',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'VMAF calculation completed',
        },
    ],
}); };
exports.details = details;

// Compute SSIM (CPU, fast on short samples) as a secondary perceptual metric.
// Resolves a 0-100 scaled score, or null on any failure - SSIM is advisory, never fatal.
function runSsimAsync(ffmpegPath, distortedPath, referencePath) {
    return new Promise(function(resolve) {
        try {
            var spawn = require('child_process').spawn;
            // The distorted clip is AV1 and this FFmpeg build has no software AV1 decoder,
            // so decode it with NVDEC (av1_cuvid). The reference (hevc/h264/etc) decodes in
            // software. The ssim filter graph auto-negotiates the common pixel format.
            var fargs = ['-hide_banner',
                '-hwaccel', 'nvdec', '-hwaccel_device', '0', '-c:v', 'av1_cuvid', '-i', distortedPath,
                '-i', referencePath,
                '-filter_complex', '[0:v]settb=1/1000,setpts=N[d];[1:v]settb=1/1000,setpts=N[r];[d][r]ssim',
                '-f', 'null', '-'];
            var child = spawn(ffmpegPath, fargs, {
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            var out = '';
            var timer = setTimeout(function() { try { child.kill('SIGKILL'); } catch (e) {} }, 180000);
            if (child.stderr) child.stderr.on('data', function(d) { out += d.toString(); });
            child.on('error', function() { clearTimeout(timer); resolve(null); });
            child.on('close', function(code) {
                clearTimeout(timer);
                if (code !== 0) { resolve(null); return; }
                var all = out.match(/All:\s*([0-9.]+)/g);
                if (!all || all.length === 0) { resolve(null); return; }
                var last = all[all.length - 1].match(/All:\s*([0-9.]+)/);
                var v = last ? parseFloat(last[1]) : NaN;
                resolve(isFinite(v) ? Math.round(v * 10000) / 100 : null);
            });
        } catch (e) {
            resolve(null);
        }
    });
}

function getSsimMode(args) {
    var raw = (args.variables && args.variables.vmafSsimMode !== undefined && args.variables.vmafSsimMode !== null)
        ? args.variables.vmafSsimMode
        : (args.inputs ? args.inputs.ssimMode : 'off');
    var mode = String(raw === undefined || raw === null ? 'off' : raw).trim().toLowerCase();
    if (mode === '0' || mode === 'false' || mode === 'no' || mode === 'none' || mode === 'disabled' || mode === 'off') return 'off';
    if (mode === '1' || mode === 'true' || mode === 'yes' || mode === 'enabled' || mode === 'on' || mode === 'all') return 'all';
    if (mode === 'first' || mode === 'first_round' || mode === 'first-round' || mode === 'initial' || mode === 'initial-only') return 'first-round';
    return 'off';
}

function isFirstVmafRound(args) {
    var vars = args.variables || {};
    var retryCount = Number(vars.vmafRetryCount || 0);
    var transcodeRetryCount = Number(vars.vmafTranscodeRetryCount || 0);
    var sweepRetryHistory = Array.isArray(vars.vmafSweepRetryHistory) ? vars.vmafSweepRetryHistory : [];
    var cqRangeRetryHistory = Array.isArray(vars.vmafCQRangeRetryHistory) ? vars.vmafCQRangeRetryHistory : [];
    return (!isFinite(retryCount) || retryCount <= 0)
        && (!isFinite(transcodeRetryCount) || transcodeRetryCount <= 0)
        && sweepRetryHistory.length === 0
        && cqRangeRetryHistory.length === 0
        && vars.vmafTriggerSweepRetry !== true;
}

function shouldRunSsim(args) {
    var mode = getSsimMode(args);
    if (mode === 'off') return false;
    if (mode === 'first-round') return isFirstVmafRound(args);
    return true;
}

function resolveCpuV1QualificationEnabled(args) {
    var inputEnabled = args && args.inputs &&
        (args.inputs.vmafCpuV1QualificationEnabled === true ||
         String(args.inputs.vmafCpuV1QualificationEnabled).toLowerCase() === 'true');
    return inputEnabled && args && args.variables &&
        args.variables.vmafCpuV1QualificationAuthorized === true;
}

function resolveCpuV1ProductionEnabled(args) {
    return Boolean(args && args.inputs &&
        (args.inputs.vmafCpuV1ProductionEnabled === true ||
         String(args.inputs.vmafCpuV1ProductionEnabled).toLowerCase() === 'true'));
}

function resolveCpuV1ProvisionalHdrAuthorized(args) {
    return Boolean(args && args.inputs &&
        (args.inputs.vmafCpuV1ProductionAllowProvisionalHdr === true ||
         String(args.inputs.vmafCpuV1ProductionAllowProvisionalHdr).toLowerCase() === 'true'));
}

function resolveCpuV1ExecutionPolicy(args) {
    var productionRequested = resolveCpuV1ProductionEnabled(args);
    var qualificationRequested = productionRequested || resolveCpuV1QualificationEnabled(args);
    var isHdr = Boolean(args && args.variables && args.variables.isHDR === true);
    if (qualificationRequested && isHdr) {
        if (productionRequested && !resolveCpuV1ProvisionalHdrAuthorized(args)) {
            return Object.freeze({
                productionRequested: true,
                qualificationRequested: true,
                productionEnabled: false,
                qualificationEnabled: false,
                fallbackToGpuV0: true,
                fallbackCode: 'CPU_V1_PROVISIONAL_HDR_NOT_AUTHORIZED',
                fallbackReason: 'CPU VMAF-v1 HDR/PQ production authority is not authorized',
            });
        }
        if (!productionRequested &&
                (!args.variables || args.variables.vmafCpuV1AllowProvisionalHdr !== true)) {
            throw new Error('CPU VMAF-v1 HDR/PQ qualification requires explicit vmafCpuV1AllowProvisionalHdr=true');
        }
    }
    return Object.freeze({
        productionRequested: productionRequested,
        qualificationRequested: qualificationRequested,
        productionEnabled: productionRequested,
        qualificationEnabled: qualificationRequested,
        fallbackToGpuV0: false,
        fallbackCode: null,
        fallbackReason: null,
    });
}

function parseFrameRate(stream) {
    var raw = stream && (stream.avg_frame_rate || stream.r_frame_rate || stream.frame_rate);
    if (typeof raw === 'string' && raw.indexOf('/') !== -1) {
        var parts = raw.split('/');
        var numerator = Number(parts[0]);
        var denominator = Number(parts[1]);
        return isFinite(numerator) && isFinite(denominator) && denominator > 0
            ? numerator / denominator : null;
    }
    var value = Number(raw);
    return isFinite(value) && value > 0 ? value : null;
}

var GPU_LOCK_MODULE = '/custom-cont-init.d/vmaf-plugin-patches/_lib/gpuPipelineLock.js';

/**
 * Release the exclusive GPU pipeline lock around CPU-only VMAF-v1 scoring.
 * Returns the released lock descriptor, or null when nothing was released.
 * A non-confirming release retains every ownership variable unchanged.
 */
function releaseGpuLockForCpuScoring(args, hasCpuV1, lockImpl) {
    if (hasCpuV1 !== true) return null;
    var info = args.variables && args.variables.vmafGpuPipelineLock;
    if (!args.variables || args.variables.vmafGpuPipelineLockAcquired !== true || !info || !info.token) {
        return null;
    }
    try {
        var lock = lockImpl || require(GPU_LOCK_MODULE);
        var releaseResult = lock.release(info.lockDir, info.token, {
            force: false,
            expectedGeneration: info.leaseGeneration || null,
        });
        if (!releaseResult || releaseResult.released !== true) {
            args.jobLog('GPU pipeline lock release skipped (retaining ownership): ' +
                String(releaseResult && releaseResult.reason || 'release was not confirmed'));
            return null;
        }
        args.variables.vmafGpuPipelineLockAcquired = false;
        args.variables.vmafGpuPipelineLockReleased = true;
        args.variables.vmafGpuPipelineLockReleasedForCpuScoring = true;
        args.jobLog('GPU pipeline lock released for CPU-only VMAF-v1 scoring (no GPU work in this phase).');
        return info;
    } catch (releaseError) {
        // Failing to release is not fatal: we simply keep the lock and lose the
        // sharing benefit, which is strictly the previous behaviour.
        args.jobLog('GPU pipeline lock release skipped (non-fatal, keeping lock): ' + releaseError.message);
        return null;
    }
}

function maxParallelCpuV1(args) {
    var value = Number(args && args.inputs && args.inputs.maxParallelCpuV1);
    if (!isFinite(value) || value < 1) value = 1;
    return 1;
}

function cpuV1ThreadsPerScore(args) {
    var value = Number(args && args.inputs && args.inputs.cpuV1ThreadsPerScore);
    if (!isFinite(value) || value < 1) value = 2;
    return Math.max(1, Math.min(4, Math.floor(value)));
}

function isCpuV1GeometryError(error) {
    return Boolean(error && typeof error.code === 'string' &&
        error.code.indexOf('VMAF_V1_GEOMETRY_') === 0);
}

function cpuV1Capability(args, contract, fsImpl) {
    fsImpl = fsImpl || require('fs');
    if (!contract || contract.backend !== 'cpu' ||
        typeof contract.productionEligible !== 'boolean' ||
        contract.upstreamRevision !== vmafV1Cpu.REVISION ||
        contract.runtimePath !== vmafV1Cpu.WRAPPER_PATH) return false;
    try {
        var geometry = vmafV1Cpu.validateGeometry({
            width: Number(contract.sourceWidth),
            height: Number(contract.sourceHeight),
            sampleAspectRatio: contract.sourceSampleAspectRatio,
            displayAspectRatio: contract.sourceDisplayAspectRatio,
            geometryNormalization: contract.geometryNormalization,
        });
        var selectedModel = vmafV1Cpu.selectModel({
            width: geometry.width,
            height: geometry.height,
            modelProfile: vmafV1Cpu.profileForModelVersion(contract.modelVersion),
        });
        if (selectedModel.version !== contract.modelVersion ||
                selectedModel.resolutionClass !== geometry.resolutionClass) return false;
        fsImpl.accessSync(vmafV1Cpu.WRAPPER_PATH, fsImpl.constants.X_OK);
        fsImpl.accessSync(vmafV1Cpu.SCORE_WRAPPER_PATH, fsImpl.constants.X_OK);
        return true;
    } catch (_) {
        return false;
    }
}

// Resolve n_subsample integer from plugin input or variable override.
// Default 1 (every frame). Values >1 enable frame subsampling for faster VMAF.
// Variable override args.variables.vmafSubsample takes precedence over inputs.vmafSubsample.
function getVmafSubsampleInt(args) {
    var raw;
    if (args.variables && args.variables.vmafSubsample !== undefined && args.variables.vmafSubsample !== null) {
        raw = args.variables.vmafSubsample;
    } else if (args.inputs && args.inputs.vmafSubsample !== undefined && args.inputs.vmafSubsample !== null) {
        raw = args.inputs.vmafSubsample;
    } else {
        raw = '1';
    }
    var n = parseInt(raw, 10);
    if (!isFinite(n) || n < 1) n = 1;
    if (n > 16) n = 16;  // sanity cap
    return n;
}

function splitPrecomputedVmafResults(validResults, precomputedResults, requireCambi) {
    var precomputedByKey = {};
    (Array.isArray(precomputedResults) ? precomputedResults : []).forEach(function (result) {
        if (!result || result.parameterSetId == null || result.sampleIndex == null ||
                result.vmafScore == null || result.vmafScore === '' ||
                !isFinite(Number(result.vmafScore))) return;
        if (requireCambi === true &&
                (!isFinite(Number(result.cambiMean)) || !isFinite(Number(result.cambiP95)))) return;
        var key = String(result.parameterSetId) + ':' + String(result.sampleIndex);
        if (!precomputedByKey[key]) precomputedByKey[key] = result;
    });
    var reused = [];
    var pending = [];
    (Array.isArray(validResults) ? validResults : []).forEach(function (result) {
        var key = String(result.parameterSetId) + ':' + String(result.sampleIndex);
        if (precomputedByKey[key]) reused.push(precomputedByKey[key]);
        else pending.push(result);
    });
    return { reused: reused, pending: pending };
}

function preFgsCambiThreads(args) {
    var threads = parseInt(args.inputs && args.inputs.maxParallelVmaf, 10);
    if (!isFinite(threads) || threads < 1) threads = 4;
    return Math.max(1, Math.min(threads, 16));
}

function safeCambiLabel(value) {
    return String(value || 'measurement').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120);
}

function accumulateTimingSeconds(variables, key, seconds) {
    variables = variables || {};
    var elapsed = Number(seconds);
    var previous = Number(variables[key]);
    if (!isFinite(previous) || previous < 0) previous = 0;
    if (!isFinite(elapsed) || elapsed < 0) return previous;
    variables[key] = previous + elapsed;
    return variables[key];
}

function measurePreFgsCambiAsync(args, distortedPath, referencePath, cacheDir,
        modelPath, metricContract, label) {
    return new Promise(function (resolve) {
        var fs = require('fs');
        var spawn = require('child_process').spawn;
        var logPath = cacheDir + '/prefgs_cambi_' + safeCambiLabel(label) + '_' +
            process.pid + '_' + Date.now() + '.json';
        var argv;
        try {
            argv = preFgsCambi.buildArgs({
                distortedPath: distortedPath,
                referencePath: referencePath,
                logPath: logPath,
                modelPath: modelPath,
                pixelFormat: metricContract.cambi.scoringPixelFormat,
                nSubsample: getVmafSubsampleInt(args),
                threads: preFgsCambiThreads(args),
            });
        } catch (error) {
            resolve({ success: false, error: error.message });
            return;
        }
        var started = Date.now();
        var child;
        try {
            child = spawn(args.ffmpegPath, argv, {
                shell: false,
                stdio: ['ignore', 'ignore', 'pipe'],
                env: process.env,
                detached: true,
            });
        } catch (error) {
            resolve({ success: false, error: 'pre-FGS CAMBI spawn failed: ' + error.message });
            return;
        }
        var stderr = '';
        var timedOut = false;
        var timeoutMs = 300000;
        var settled = false;
        var timer = setTimeout(function () {
            timedOut = true;
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
        }, timeoutMs);
        if (child.stderr) child.stderr.on('data', function (data) {
            if (stderr.length < 2 * 1024 * 1024) stderr += data.toString();
        });
        child.on('error', function (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch (_) {}
            resolve({ success: false, error: 'pre-FGS CAMBI process error: ' + error.message });
        });
        child.on('close', function (code) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            var duration = (Date.now() - started) / 1000;
            if (timedOut || code !== 0) {
                try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch (_) {}
                resolve({ success: false, error: (timedOut ? 'pre-FGS CAMBI timed out' :
                    'pre-FGS CAMBI exited ' + code) + ': ' + stderr.trim().slice(-2000) });
                return;
            }
            try {
                var parsed = preFgsCambi.parseLogFile(logPath, fs);
                try { fs.unlinkSync(logPath); } catch (_) {}
                resolve({ success: true, duration: duration, result: parsed });
            } catch (error) {
                try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch (_) {}
                resolve({ success: false, error: 'pre-FGS CAMBI parse failed: ' + error.message });
            }
        });
    });
}

async function measureSourceCambiBaselines(args, validResults, samples, cacheDir,
        modelPath, metricContract) {
    var references = [];
    var seen = {};
    (Array.isArray(validResults) ? validResults : []).forEach(function (result) {
        var referencePath = result.originalSamplePath || samples[result.sampleIndex];
        if (!referencePath || seen[referencePath]) return;
        seen[referencePath] = true;
        references.push({ path: referencePath, sampleIndex: result.sampleIndex });
    });
    if (!references.length) throw new Error('pre-FGS CAMBI source baseline has no authenticated references');
    var next = 0;
    var measured = [];
    var bySample = {};
    var timeSec = 0;
    async function worker() {
        while (next < references.length) {
            var current = references[next++];
            var measurement = await measurePreFgsCambiAsync(args, current.path, current.path,
                cacheDir, modelPath, metricContract, 'source_s' + (Number(current.sampleIndex) + 1));
            if (!measurement.success) throw new Error(measurement.error);
            measured.push(measurement.result);
            bySample[current.sampleIndex] = measurement.result;
            timeSec += Number(measurement.duration) || 0;
        }
    }
    var workers = [];
    for (var index = 0; index < Math.min(2, references.length); index++) workers.push(worker());
    await Promise.all(workers);
    return {
        aggregate: preFgsCambi.aggregateBaselines(measured),
        bySample: bySample,
        timeSec: timeSec,
    };
}

function runOptionalSsimAsync(args, result, originalSample) {
    if (!shouldRunSsim(args)) {
        return Promise.resolve({ score: null, timeSec: 0, skipped: true });
    }
    var start = Date.now();
    return runSsimAsync(args.ffmpegPath, result.outputPath, originalSample).then(function(ssimScore) {
        return { score: ssimScore, timeSec: (Date.now() - start) / 1000, skipped: false };
    });
}

function calculateSingleVmafV1CpuAsync(args, result, samples, cacheDir, metricContract) {
    return new Promise(function (resolve) {
        var fs = require('fs');
        var spawn = require('child_process').spawn;
        var originalSample = result.originalSamplePath || samples[result.sampleIndex];
        var safe = safeCambiLabel(result.parameterSetId + '_s' + (Number(result.sampleIndex) + 1));
        var outputPath = cacheDir + '/vmaf_v1_' + safe + '_' + process.pid + '_' + Date.now() + '.json';
        var metadataPath = outputPath + '.transport.json';
        var command;
        try {
            command = vmafV1Cpu.buildScorerCommand({
                referencePath: originalSample,
                distortedPath: result.outputPath,
                outputPath: outputPath,
                metadataOutputPath: metadataPath,
                ffmpegPath: args.ffmpegPath,
                width: Number(metricContract.sourceWidth),
                height: Number(metricContract.sourceHeight),
                sampleAspectRatio: metricContract.sourceSampleAspectRatio,
                displayAspectRatio: metricContract.sourceDisplayAspectRatio,
                geometryNormalization: metricContract.geometryNormalization,
                modelVersion: metricContract.modelVersion,
                contentClass: metricContract.contentClass,
                allowProvisionalHdr: metricContract.contentClass === 'hdr-pq',
                subsample: getVmafSubsampleInt(args),
                threads: cpuV1ThreadsPerScore(args),
                pooling: metricContract.poolingPrimary,
            });
        } catch (error) {
            resolve({ success: false, error: 'CPU VMAF-v1 command rejected: ' + error.message });
            return;
        }
        var started = Date.now();
        var child;
        var settled = false;
        var stderr = '';
        var timedOut = false;
        function cleanup() {
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
            try { if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath); } catch (_) {}
        }
        try {
            child = spawn(command.executable, command.args, {
                shell: false,
                stdio: ['ignore', 'ignore', 'pipe'],
                env: process.env,
                detached: true,
            });
        } catch (error) {
            cleanup();
            resolve({ success: false, error: 'CPU VMAF-v1 scorer spawn failed: ' + error.message });
            return;
        }
        var timer = setTimeout(function () {
            timedOut = true;
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
        }, 300000);
        if (child.stderr) child.stderr.on('data', function (data) {
            if (stderr.length < 2 * 1024 * 1024) stderr += data.toString();
        });
        child.on('error', function (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve({ success: false, error: 'CPU VMAF-v1 scorer process error: ' + error.message });
        });
        child.on('close', function (code) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            var duration = (Date.now() - started) / 1000;
            if (timedOut || code !== 0) {
                cleanup();
                resolve({ success: false, error: (timedOut ? 'CPU VMAF-v1 scorer timed out' :
                    'CPU VMAF-v1 scorer exited ' + code) + ': ' + stderr.trim().slice(-2000) });
                return;
            }
            try {
                var parsed = vmafV1Cpu.parseScorerOutput(
                    fs.readFileSync(outputPath, 'utf8'), fs.readFileSync(metadataPath, 'utf8'), command);
                var vmafFrames = parsed.frames.map(function (frame) { return Number(frame.vmaf); });
                var cambiFrames = parsed.frames.map(function (frame) { return Number(frame.cambi); });
                var sourceFrames = parsed.frames.map(function (frame) { return Number(frame.cambiSource); });
                function mean(values) { return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length; }
                function percentile(values, fraction) {
                    var sorted = values.slice().sort(function (a, b) { return a - b; });
                    return sorted[Math.min(sorted.length - 1,
                        Math.max(0, Math.floor(fraction * (sorted.length - 1))))];
                }
                var vmafSorted = vmafFrames.slice().sort(function (a, b) { return a - b; });
                cleanup();
                resolve({
                    success: true,
                    duration: duration,
                    method: 'CPU VMAF-v1 + integrated full-reference CAMBI native10',
                    result: {
                        parameterSetId: result.parameterSetId,
                        parameterSet: result.parameterSet,
                        sampleIndex: result.sampleIndex,
                        fileSizeMB: result.fileSizeMB,
                        vmafTimeSec: duration,
                        cambiTimeSec: 0,
                        cambiTimingAttribution: 'integrated-in-vmaf-v1-wall-clock',
                        ssimTimeSec: 0,
                        vmafScore: parsed.vmaf,
                        vmafMean: mean(vmafFrames),
                        vmafHarmonicMean: parsed.vmaf,
                        vmafMin: vmafSorted[0],
                        vmafMax: vmafSorted[vmafSorted.length - 1],
                        vmafP1: percentile(vmafFrames, 0.01),
                        cambiMean: mean(cambiFrames),
                        cambiMax: Math.max.apply(null, cambiFrames),
                        cambiP95: percentile(cambiFrames, 0.95),
                        cambiFrameCount: cambiFrames.length,
                        sourceCambiMean: mean(sourceFrames),
                        sourceCambiMax: Math.max.apply(null, sourceFrames),
                        sourceCambiP95: percentile(sourceFrames, 0.95),
                        cambiStage: 'pre-fgs-grain-free-candidate-native10',
                        ssimScore: null,
                        vmafMethod: 'CPU VMAF-v1 + integrated full-reference CAMBI native10',
                        vmafModelPath: '',
                        vmafModelVersion: metricContract.modelVersion,
                        metricAliases: parsed.aliases,
                    },
                });
            } catch (error) {
                cleanup();
                resolve({ success: false, error: 'CPU VMAF-v1 output rejected: ' + error.message });
            }
        });
    });
}

// Run a single GPU VMAF job asynchronously (libvmaf_cuda primary method only)
function calculateSingleVmafGpuAsync(args, result, samples, cacheDir, modelPath, metricContract) {
    return new Promise(function(resolve) {
        var fs = require('fs');
        var execSpawn = require('child_process').spawn;

        var originalSample = result.originalSamplePath || samples[result.sampleIndex];
        var logPath = cacheDir + '/vmaf_' + result.parameterSetId + '_s' + (result.sampleIndex + 1) + '.json';
        var distortedEncoder = (result.parameterSet && result.parameterSet.encoder) || args.variables.vmafTargetCodec || '';
        var nSubsample = getVmafSubsampleInt(args);

        function runOnce() {
            // The Blackwell-compatible path performs pixel-format conversion in
            // system memory and uploads yuv420p frames for GPU scoring. There is
            // no second CPU-VMAF path and no duplicate retry of this command.
            var command = buildGpuVmafCommand(args.ffmpegPath, result.outputPath, originalSample,
                logPath, modelPath, args.inputFileObj, true, distortedEncoder, nSubsample);
            var start = Date.now();
            var child = execSpawn(command.executable, command.args, {
                shell: false,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: process.env,
                detached: true
            });
            var stderr = '';
            var timedOut = false;
            var timeoutMs = 300000;
            var timeoutHandle = setTimeout(function() {
                timedOut = true;
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch (killGroupErr) {
                    try { child.kill('SIGKILL'); } catch (killErr) {}
                }
            }, timeoutMs);
            if (child.stderr) child.stderr.on('data', function(d) { stderr += d.toString(); });
            child.on('close', function(code) {
                clearTimeout(timeoutHandle);
                var duration = (Date.now() - start) / 1000;
                if (timedOut) {
                    resolve({ success: false, error: 'GPU VMAF timed out after ' + Math.round(timeoutMs / 1000) + 's: ' + stderr.trim().slice(-2000) });
                    return;
                }
                if (code !== 0) {
                    resolve({ success: false, error: 'GPU VMAF failed (code ' + code + '): ' + stderr.trim() });
                    return;
                }
                var parsed = parseVmafLog(logPath, fs);
                if (!parsed || parsed.vmafScore === null || parsed.vmafScore === undefined) {
                    resolve({ success: false, error: 'GPU VMAF log parse failed for ' + logPath });
                    return;
                }
                measurePreFgsCambiAsync(args, result.outputPath, originalSample,
                    cacheDir, modelPath, metricContract,
                    result.parameterSetId + '_s' + (Number(result.sampleIndex) + 1))
                    .then(function (cambiMeasurement) {
                        if (!cambiMeasurement.success) {
                            resolve({ success: false, error: cambiMeasurement.error });
                            return;
                        }
                        runOptionalSsimAsync(args, result, originalSample).then(function(ssimResult) {
                            resolve({
                                success: true,
                                duration: duration + cambiMeasurement.duration,
                                method: 'GPU VMAF + CPU pre-FGS CAMBI',
                                result: {
                                    parameterSetId: result.parameterSetId,
                                    parameterSet: result.parameterSet,
                                    sampleIndex: result.sampleIndex,
                                    fileSizeMB: result.fileSizeMB,
                                    vmafTimeSec: duration,
                                    cambiTimeSec: cambiMeasurement.duration,
                                    ssimTimeSec: ssimResult.timeSec,
                                    vmafScore: parsed.vmafScore,
                                    vmafMean: parsed.vmafMean,
                                    vmafHarmonicMean: parsed.vmafHarmonicMean,
                                    vmafMin: parsed.vmafMin,
                                    vmafMax: parsed.vmafMax,
                                    vmafP1: parsed.vmafP1,
                                    cambiMean: cambiMeasurement.result.cambiMean,
                                    cambiMax: cambiMeasurement.result.cambiMax,
                                    cambiP95: cambiMeasurement.result.cambiP95,
                                    cambiFrameCount: cambiMeasurement.result.frameCount,
                                    cambiStage: 'pre-fgs-grain-free-candidate',
                                    ssimScore: ssimResult.score,
                                    vmafMethod: 'GPU VMAF + CPU pre-FGS CAMBI',
                                    vmafModelPath: modelPath || ''
                                }
                            });
                        });
                    });
            });
        }

        runOnce();
    });
}

// Check the exact selected VMAF model, not merely whether the CUDA filter is
// listed. A different model can require different feature extractors, so a
// successful v0 smoke test must never attest v1 (or vice versa). CAMBI is
// unavailable in this CUDA-only contract and is deliberately not requested
// from libvmaf_cuda (which silently omits it).
function checkGpuVmafSupport(ffmpegPath, metricContract) {
    var execFileSync = require('child_process').execFileSync;
    var fs = require('fs');
    if (!metricContract || metricContract.backend !== 'cuda' ||
            metricContract.filterName !== 'libvmaf_cuda' ||
            !metricContract.modelPath || !metricContract.metricContractId) {
        return false;
    }
    var logPath = '/temp/vmaf_cuda_capability_check_' + process.pid + '.json';
    try {
        var env = Object.assign({}, process.env);
        var preferred = '/custom-libvmaf-lib:/usr/local/ffmpeg-custom/lib:/usr/local/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/lib';
        env.LD_LIBRARY_PATH = preferred + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');

        var filters = execFileSync(ffmpegPath, ['-hide_banner', '-filters'], {
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            timeout: 10000,
            env: env,
            maxBuffer: 10 * 1024 * 1024
        });
        if (filters.indexOf('libvmaf_cuda') === -1) return false;

        var modelParam = ':model=path=' + metricContract.modelPath;
        try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch (ignore) {}

        var capabilityFilter = '[0:v]format=' + metricContract.scoringPixelFormat +
            ',hwupload[dist];[1:v]format=' + metricContract.scoringPixelFormat +
            ',hwupload[ref];[dist][ref]' + metricContract.filterName +
            '=log_fmt=json:log_path=' + logPath + modelParam;
        execFileSync(ffmpegPath, [
            '-hide_banner', '-y',
            '-init_hw_device', 'cuda=cuda0:0',
            '-filter_hw_device', 'cuda0',
            '-f', 'lavfi', '-i', 'testsrc2=s=128x128:d=0.25:r=8',
            '-f', 'lavfi', '-i', 'testsrc2=s=128x128:d=0.25:r=8',
            '-filter_complex', capabilityFilter,
            '-f', 'null', '-',
        ], {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            timeout: 20000,
            env: env,
            maxBuffer: 10 * 1024 * 1024
        });

        if (!fs.existsSync(logPath)) return false;
        var parsed = parseVmafLog(logPath, fs);
        try { fs.unlinkSync(logPath); } catch (ignore2) {}
        return !!(parsed && parsed.vmafScore !== null && parsed.vmafScore !== undefined && !isNaN(parsed.vmafScore));
    } catch (e) {
        return false;
    } finally {
        try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch (cleanupError) {}
    }
}

function resolveGpuVmafSupport(args, metricContract, checker) {
    var capabilityCache = args.variables.vmafGpuCapabilityCache;
    var capabilityCacheHit = !!(capabilityCache
        && capabilityCache.available === true
        && capabilityCache.ffmpegPath === args.ffmpegPath
        && capabilityCache.metricContractId === metricContract.metricContractId
        && capabilityCache.modelPath === metricContract.modelPath
        && capabilityCache.modelSha256 === metricContract.modelSha256
        && capabilityCache.filterName === metricContract.filterName
        && capabilityCache.scoringPixelFormat === metricContract.scoringPixelFormat);
    var hasGpuVmaf = capabilityCacheHit ? true : checker(args.ffmpegPath, metricContract);
    if (hasGpuVmaf) {
        args.variables.vmafGpuCapabilityCache = {
            available: true,
            ffmpegPath: args.ffmpegPath,
            metricContractId: metricContract.metricContractId,
            modelPath: metricContract.modelPath,
            modelSha256: metricContract.modelSha256,
            filterName: metricContract.filterName,
            scoringPixelFormat: metricContract.scoringPixelFormat,
            checkedAt: capabilityCacheHit ? capabilityCache.checkedAt : new Date().toISOString(),
        };
        args.variables.vmafGpuCapabilityCacheHits = Number(args.variables.vmafGpuCapabilityCacheHits || 0)
            + (capabilityCacheHit ? 1 : 0);
    }
    return { available: hasGpuVmaf, cacheHit: capabilityCacheHit };
}


// Get the primary video stream, skipping attached pictures, cover images, and other non-primary video.
// Filters out: attached_pic, clean_effects, still_image, very small resolutions (<100px), dependent layers.
function getVideoStream(inputFile) {
    var streams = inputFile && inputFile.ffProbeData && inputFile.ffProbeData.streams;
    if (!Array.isArray(streams)) return null;
    var candidates = [];
    for (var i = 0; i < streams.length; i++) {
        var s = streams[i];
        if (!s || s.codec_type !== 'video') continue;
        // Skip attached pictures (cover images embedded in container)
        if (s.disposition && (s.disposition.attached_pic === 1 || s.disposition.clean_effects === 1)) continue;
        // Skip still images / multilayer (poster frames, cover jpegs)
        if (s.tags && s.tags.filename && /\.(jpg|jpeg|png|gif|bmp)$/i.test(s.tags.filename)) continue;
        if (s.still_image === 1 || s.multilayer === 1) continue;
        // Skip very small resolutions — these are logos/icons, not primary video
        if ((s.width || 0) < 100 || (s.height || 0) < 100) continue;
        // Prefer streams that are not dependent layers
        if (s.disposition && s.disposition.dependent === 1) continue;
        // Prefer default streams, deprioritize non-default
        var priority = 0;
        if (s.disposition) {
            if (s.disposition.default === 1) priority = 2;
            else if (s.disposition.forced === 1) priority = 1;
        }
        candidates.push({ stream: s, priority: priority, index: i });
    }
    if (candidates.length === 0) return null;
    // Sort: highest priority first, then by stream index
    candidates.sort(function(a, b) { return b.priority - a.priority || a.index - b.index; });
    return candidates[0].stream;
}

// ── XPSNR shadow (2026-07-21) ──
// Calibration-only telemetry for the XPSNR CPU-prescreen candidate: score a small sample of
// clips with ffmpeg's CPU-only xpsnr filter (software AV1 decode via libdav1d — zero GPU, no
// GPU-lock involvement) concurrently with the authoritative GPU VMAF pool, and log paired
// (xpsnr, clip-VMAF) rows to /app/configs/vmaf_xpsnr_shadow.jsonl. Shadow only: results never
// influence any decision, and every failure path is fail-open. Kill switch:
// args.variables.vmafXpsnrShadow === false. Requires an ffmpeg build with libdav1d + xpsnr
// (capability-probed once per job, cached +/- in flow variables) — inert until the
// dav1d-capable build is promoted.
function parseXpsnrStderr(text) {
    var m = /XPSNR\s+y:\s*(inf|[0-9.]+)\s+u:\s*(inf|[0-9.]+)\s+v:\s*(inf|[0-9.]+)/.exec(String(text || ''));
    if (!m) return null;
    var toNum = function (s) { return s === 'inf' ? Infinity : Number(s); };
    var y = toNum(m[1]);
    var u = toNum(m[2]);
    var v = toNum(m[3]);
    if (!(isFinite(y) || y === Infinity)) return null;
    return { y: y, u: u, v: v, min: Math.min(y, u, v) };
}

function checkXpsnrShadowCapability(args) {
    if (args.variables.vmafXpsnrCapable === true) return true;
    if (args.variables.vmafXpsnrCapable === false) return false;
    try {
        var execFileSyncXp = require('child_process').execFileSync;
        var filtersOut = execFileSyncXp(args.ffmpegPath, ['-hide_banner', '-filters'], {
            encoding: 'utf8', shell: false, windowsHide: true,
            timeout: 10000, maxBuffer: 10 * 1024 * 1024
        });
        var decodersOut = execFileSyncXp(args.ffmpegPath, ['-hide_banner', '-decoders'], {
            encoding: 'utf8', shell: false, windowsHide: true,
            timeout: 10000, maxBuffer: 10 * 1024 * 1024
        });
        var capable = filtersOut.indexOf(' xpsnr ') !== -1 && decodersOut.indexOf('libdav1d') !== -1;
        // Cache either way: the binary cannot gain/lose filters mid-job.
        args.variables.vmafXpsnrCapable = capable;
        return capable;
    } catch (eCap) {
        args.variables.vmafXpsnrCapable = false;
        return false;
    }
}

function runXpsnrShadowOnce(args, distortedPath, referencePath) {
    return new Promise(function (resolve) {
        var spawnXp = require('child_process').spawn;
        var started = Date.now();
        // Both decode paths are CPU by construction: libdav1d for the AV1 distorted clip, the
        // default software decoder for the reference. format=yuv420p on both sides matches the
        // sweep's 8-bit no-tonemap scoring convention (see the holdout CAMBI comment in
        // selectBestParameters), so pairs stay on the same scale as production VMAF.
        var argvXp = ['-hide_banner', '-nostats', '-y',
            '-c:v', 'libdav1d', '-i', distortedPath,
            '-i', referencePath,
            '-filter_complex', '[0:v]settb=1/1000,setpts=N,format=yuv420p[dis];[1:v]settb=1/1000,setpts=N,format=yuv420p[ref];[dis][ref]xpsnr',
            '-f', 'null', '-'];
        var childXp;
        try {
            childXp = spawnXp(args.ffmpegPath, argvXp, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
        } catch (eSpawn) { resolve(null); return; }
        var stderrXp = '';
        var settledXp = false;
        var killTimerXp = setTimeout(function () {
            if (settledXp) return;
            try { childXp.kill('SIGKILL'); } catch (eKill) {}
        }, 150000);
        childXp.stderr.on('data', function (d) { if (stderrXp.length < 1024 * 1024) stderrXp += d; });
        childXp.on('error', function () {
            if (settledXp) return;
            settledXp = true;
            clearTimeout(killTimerXp);
            resolve(null);
        });
        childXp.on('close', function () {
            if (settledXp) return;
            settledXp = true;
            clearTimeout(killTimerXp);
            var parsedXp = parseXpsnrStderr(stderrXp);
            resolve(parsedXp ? { xpsnr: parsedXp, durationSec: (Date.now() - started) / 1000 } : null);
        });
    });
}

// Compatibility wrapper for the encode-side sentinel. Model selection and
// digest verification are owned by the central immutable metric contract.
function findVmafModel(fs, inputFile) {
    try {
        var video = getVideoStream(inputFile);
        var contract = video
            ? vmafMetricContract.resolveProductionForVideo(video.width, video.height)
            : vmafMetricContract.resolveProduction(inputFile);
        vmafMetricContract.assertModelFile(contract, { fs: fs });
        return contract.modelPath;
    } catch (e) {
        return null;
    }
}

// Parse VMAF results from log file
function parseVmafLog(logPath, fs) {
    try {
        var logContent = fs.readFileSync(logPath, 'utf8');
        var jsonData = JSON.parse(logContent);

        var result = {
            vmafMean: null,
            vmafHarmonicMean: null,
            vmafMin: null,
            vmafMax: null,
            vmafP1: null,
            vmafScore: null,
            cambiMean: null,
            cambiMax: null,
            cambiP95: null
        };

        // 1%-low from per-frame scores: a far more stable worst-case statistic than the
        // absolute minimum (a single odd frame out of hundreds cannot veto a candidate).
        // CAMBI is Netflix's banding metric: lower is better, ~5 starts to become annoying.
        if (Array.isArray(jsonData.frames) && jsonData.frames.length > 0) {
            var frameScores = [];
            var cambiScores = [];
            for (var fi = 0; fi < jsonData.frames.length; fi++) {
                var fr = jsonData.frames[fi];
                var fv = fr && fr.metrics && fr.metrics.vmaf;
                var cv = fr && fr.metrics && fr.metrics.cambi;
                if (typeof fv === 'number' && isFinite(fv)) frameScores.push(fv);
                if (typeof cv === 'number' && isFinite(cv)) cambiScores.push(cv);
            }
            if (frameScores.length > 0) {
                frameScores.sort(function(a, b) { return a - b; });
                var p1Idx = Math.min(frameScores.length - 1, Math.max(0, Math.floor(0.01 * frameScores.length)));
                result.vmafP1 = frameScores[p1Idx];
            }
            if (cambiScores.length > 0) {
                cambiScores.sort(function(a, b) { return a - b; });
                var c95Idx = Math.min(cambiScores.length - 1, Math.max(0, Math.floor(0.95 * (cambiScores.length - 1))));
                result.cambiP95 = cambiScores[c95Idx];
            }
        }

        // Extract all VMAF metrics from pooled_metrics (preferred format)
        if (jsonData.pooled_metrics && jsonData.pooled_metrics.vmaf) {
            var vmafMetrics = jsonData.pooled_metrics.vmaf;
            if (vmafMetrics.mean !== undefined) result.vmafMean = parseFloat(vmafMetrics.mean);
            if (vmafMetrics.harmonic_mean !== undefined) result.vmafHarmonicMean = parseFloat(vmafMetrics.harmonic_mean);
            if (vmafMetrics.min !== undefined) result.vmafMin = parseFloat(vmafMetrics.min);
            if (vmafMetrics.max !== undefined) result.vmafMax = parseFloat(vmafMetrics.max);
            if (jsonData.pooled_metrics.cambi) {
                var cambiMetrics = jsonData.pooled_metrics.cambi;
                if (cambiMetrics.mean !== undefined) result.cambiMean = parseFloat(cambiMetrics.mean);
                if (cambiMetrics.max !== undefined) result.cambiMax = parseFloat(cambiMetrics.max);
            }
        }
        // Try aggregate_metrics.vmaf (alternative format)
        else if (jsonData.aggregate_metrics && jsonData.aggregate_metrics.vmaf !== undefined) {
            result.vmafMean = parseFloat(jsonData.aggregate_metrics.vmaf);
        }
        // Try VMAF score from FFmpeg console output (older format)
        else {
            var scoreMatch = logContent.match(/"VMAF score":\s*([\d.]+)/);
            if (scoreMatch && scoreMatch[1]) {
                result.vmafMean = parseFloat(scoreMatch[1]);
            }
        }

        // Use harmonic mean as primary score (Netflix best practice)
        result.vmafScore = result.vmafHarmonicMean !== null ? result.vmafHarmonicMean : result.vmafMean;

        return result;
    } catch (e) {
        return null;
    }
}

// Build the production GPU VMAF command. Pixel-format conversion runs in
// system memory because this build's scale_cuda PTX is not Blackwell-compatible;
// VMAF scoring itself remains exclusively libvmaf_cuda.
// HDR/PQ content is requantized to 8-bit (format=yuv420p) for libvmaf_cuda but NOT tonemapped:
// the 8-bit requirement is the GPU's, tonemapping is a separate step that bands gradients (false
// CAMBI) and measures an SDR rendition the pipeline never produces (the transcode stays 10-bit HDR).
function buildGpuVmafCommand(ffmpegPath, distortedPath, referencePath, logPath, modelPath, inputFileObj, useCpuFormatConversion, distortedEncoder, nSubsample) {
    function mapEncoderToCuvid(enc) {
        var lc = String(enc || '').toLowerCase();
        if (lc.indexOf('av1') !== -1) return 'av1_cuvid';
        if (lc.indexOf('265') !== -1 || lc.indexOf('hevc') !== -1 || lc.indexOf('h265') !== -1) return 'hevc_cuvid';
        if (lc.indexOf('264') !== -1 || lc.indexOf('avc') !== -1) return 'h264_cuvid';
        if (lc.indexOf('vp9') !== -1) return 'vp9_cuvid';
        if (lc.indexOf('vp8') !== -1) return 'vp8_cuvid';
        if (lc.indexOf('mpeg2') !== -1) return 'mpeg2_cuvid';
        if (lc.indexOf('mpeg4') !== -1) return 'mpeg4_cuvid';
        return null;
    }

    // libvmaf_cuda requires CUDA frames
    // According to FFmpeg docs, we need to:
    // 1. Initialize CUDA device explicitly for filters
    // 2. Decode both files with CUDA (use appropriate CUVID decoder) and keep in CUDA format
    // 3. Scale/convert both to yuv420p (8-bit) using scale_cuda (pure GPU) or CPU format conversion (fallback)
    // 4. Pass to libvmaf_cuda
    // IMPORTANT: libvmaf_cuda only supports yuv420p (8-bit) format, regardless of source HDR/SDR status
    // The actual encoding can use 10-bit (p010le) for HDR, but VMAF calculation must use 8-bit
    var modelParam = modelPath ? ':model=path=' + modelPath : '';
    // The active libvmaf_cuda build does not emit CAMBI. Keep the field null
    // under the explicit metric-contract policy instead of pretending the
    // ignored feature request was measured.
    var cambiFeatureParam = '';
    // Always use yuv420p for GPU VMAF calculations (libvmaf_cuda limitation)
    // Note: This is different from encoding format - encoding can use p010le for HDR content
    var targetFormat = 'yuv420p';

    // VMAF references are materialized canonical-denoised FFV1 v3 clips. They
    // are always software-decoded; deriving a CUVID decoder from the original
    // library stream would force (for example) hevc_cuvid onto an FFV1 file.
    var referenceCuvid = null;

    // Build command - both inputs use CUVID decode to keep everything in GPU memory
    // Initialize CUDA device with explicit name for filter use
    var distortedCuvid = mapEncoderToCuvid(distortedEncoder);
    var commandArgs = [
        '-init_hw_device', 'cuda=cuda0:0',
        '-filter_hw_device', 'cuda0',
        '-hwaccel', 'cuda',
        '-hwaccel_device', '0'
    ];

    // cuvid decodes to system memory (NO -hwaccel_output_format cuda). scale_cuda is
    // compute_90-only in this build and crashes on Blackwell (sm_120), so format
    // conversion is done on CPU (format=yuv420p) then re-uploaded with generic hwupload.
    if (distortedCuvid) {
        commandArgs.push('-c:v', distortedCuvid);
    }
    commandArgs.push('-i', String(distortedPath));

    // Add reference file input with CUVID decoder if supported.
        // This keeps both streams in GPU memory from decode to VMAF calculation.
        // Do NOT tonemap. libvmaf_cuda needs 8-bit (yuv420p) — `format=yuv420p` already provides that;
        // the 8-bit requirement does NOT need a tonemap. tonemap=hable on the PQ signal (no
        // zscale=linear) bands smooth gradients, which CAMBI then reports as false banding, and it
        // measures a tonemapped-SDR rendition that never exists in the pipeline (the final transcode
        // stays 10-bit HDR). Measuring the PQ signal requantized to 8-bit is a faithful (slightly
        // conservative) proxy for the 10-bit output's banding. Native 10-bit VMAF is CPU-only here.
        var tonemapRef = '';
        if (referenceCuvid) {
            commandArgs.push('-hwaccel', 'cuda');
            commandArgs.push('-hwaccel_device', '0');
            commandArgs.push('-c:v', referenceCuvid);
            commandArgs.push('-i', String(referencePath));
            // cuvid decodes to system memory; CPU tonemap (HDR) + format=yuv420p makes both
            // streams identical 8-bit, then generic hwupload puts them on the CUDA device for
            // libvmaf_cuda. (hwdownload cannot target yuv420p directly from an nv12/p010 surface.)
            commandArgs.push('-filter_complex', '[0:v]settb=1/1000,setpts=N' + tonemapRef + ',format=' + targetFormat + ',hwupload[dis];[1:v]settb=1/1000,setpts=N' + tonemapRef + ',format=' + targetFormat + ',hwupload[ref];[dis][ref]libvmaf_cuda=log_path=' + logPath + ':log_fmt=json' + modelParam + cambiFeatureParam + ':shortest=1:repeatlast=0:ts_sync_mode=nearest' + (nSubsample > 1 ? ':n_subsample=' + nSubsample : ''));
                    } else {
                                // Reference codec not supported by CUVID; decode in software then upload to GPU.
                                commandArgs.push('-i', String(referencePath));
                                commandArgs.push('-filter_complex', '[0:v]settb=1/1000,setpts=N' + tonemapRef + ',format=' + targetFormat + ',hwupload[dis];[1:v]settb=1/1000,setpts=N' + tonemapRef + ',format=' + targetFormat + ',hwupload[ref];[dis][ref]libvmaf_cuda=log_path=' + logPath + ':log_fmt=json' + modelParam + cambiFeatureParam + ':shortest=1:repeatlast=0:ts_sync_mode=nearest' + (nSubsample > 1 ? ':n_subsample=' + nSubsample : ''));
                            }

        commandArgs.push('-f', 'null', '-');
        return { executable: String(ffmpegPath), args: commandArgs };
}

function buildEncodeTimeTotals(testResults) {
    var totals = {};
    (Array.isArray(testResults) ? testResults : []).forEach(function (result) {
        if (!result || result.parameterSetId === undefined || result.parameterSetId === null) return;
        if (result.encodingTimeSeconds === undefined || result.encodingTimeSeconds === null ||
                String(result.encodingTimeSeconds).trim() === '') return;
        var seconds = Number(result.encodingTimeSeconds);
        if (!isFinite(seconds) || seconds < 0) return;
        var parameterSetId = String(result.parameterSetId);
        totals[parameterSetId] = Number(totals[parameterSetId] || 0) + seconds;
    });
    return totals;
}

function persistCurrentContractMeasurements(args, referenceContractId, currentResults) {
    var variables = args.variables || {};
    var inputFileObj = args.inputFileObj || {};
    var sourcePath = variables.vmafOriginalFile || inputFileObj._id || inputFileObj.file || inputFileObj.filePath;
    var jobId = variables.vmafCanonicalJobId || variables.vmafJobId || variables.vmafRunId;
    var envelope = currentContractMeasurementHistory.mergeCurrentMeasurements(
        variables.vmafCurrentContractMeasurementHistory,
        {
            jobId: jobId,
            sourcePath: sourcePath,
            referenceContractId: referenceContractId,
        },
        currentResults
    );
    variables.vmafCurrentContractMeasurementHistory = envelope;
    return currentContractMeasurementHistory.publishPoints(envelope);
}

function booleanSwitch(value) {
    if (value === true || value === 1) return true;
    var normalized = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function resolvePairedCqActingEnabled(args) {
    var variables = args.variables || {};
    var requested;
    if (variables.vmafPairedCqActingEnabled !== undefined &&
            variables.vmafPairedCqActingEnabled !== null) {
        requested = booleanSwitch(variables.vmafPairedCqActingEnabled);
    } else {
        requested = booleanSwitch(args.inputs && args.inputs.vmafPairedCqActingEnabled);
    }
    if (!requested) return false;
    // The force-full switch is a hard promotion interlock: an armed rollout first
    // measures unbiased counterfactuals. Acting starts only after review clears this switch.
    var forceFull = !args.inputs ||
        (args.inputs.pairedCqShadowForceFull !== false &&
         args.inputs.pairedCqShadowForceFull !== 'false');
    return !forceFull;
}

function resolvePairedCqActingPolicy(args, effectiveOverride) {
    var variables = args.variables || {};
    var override = effectiveOverride || {};
    var reasons = [];
    var target = Number(override.targetVmaf);
    if (!isFinite(target) || target <= 0) target = Number(variables.vmafMinVMAF);
    if (!isFinite(target) || target <= 0) target = 95;
    var floor = Number(override.vmafP1Floor);
    if (!isFinite(floor) || floor <= 0) floor = Number(override.adaptiveFrameFloor);
    if (!isFinite(floor) || floor <= 0) floor = Number(variables.vmafMinFrameVMAF);
    if (!isFinite(floor) || floor <= 0) {
        floor = Number(variables.vmafQualityRiskPolicy && variables.vmafQualityRiskPolicy.adaptiveFrameFloor);
    }
    if (!isFinite(floor) || floor <= 0) reasons.push('missing_frame_floor_policy');
    var cambiLimit = Number(override.cambiLimit);
    if (!isFinite(cambiLimit) || cambiLimit <= 0) {
        var sourceCambi = Number(variables.vmafSourceCAMBI);
        var sourceCambiP95 = Number(variables.vmafSourceCAMBIP95);
        if (!isFinite(sourceCambi) || !isFinite(sourceCambiP95)) {
            reasons.push('missing_source_cambi_policy');
            cambiLimit = null;
        } else {
            var feasibility = require('../../_lib/feasibility.js');
            cambiLimit = feasibility.effectiveCambiLimit({
                isAnimation: variables.vmafMediaIsAnimation === true,
                isHDR: variables.isHDR === true || variables.vmafIsHDR === true,
                sourceCambi: sourceCambi,
                sourceCambiP95: sourceCambiP95,
                cambiTolerance: 1.0,
            });
            if (!isFinite(Number(cambiLimit))) reasons.push('missing_cambi_limit_policy');
        }
    }
    var vmafScoreMax = require('../../_lib/vmafpredict.js').maximumVmafObservation({
        metricContractId: variables.vmafMetricContractId,
    });
    if (!isFinite(Number(vmafScoreMax))) reasons.push('missing_vmaf_score_max_policy');
    var selectorPolicyVersion = override.selectorPolicyVersion ||
        variables.vmafSelectorPolicyVersion || 'selector-authoritative-v2';
    var policy = {
        anchorCount: 6,
        maxCqGap: 2,
        targetVmaf: target,
        vmafP1Floor: floor,
        cambiLimit: cambiLimit,
        harmonicMargin: 0.25,
        p1Margin: 0.5,
        cambiMargin: 0.25,
        vmafScoreMax: vmafScoreMax,
    };
    policy.policyId = 'paired_cq_acting_policy_v1|' + JSON.stringify({
        selectorPolicyVersion: selectorPolicyVersion,
        targetVmaf: policy.targetVmaf,
        vmafP1Floor: policy.vmafP1Floor,
        cambiLimit: policy.cambiLimit,
        harmonicMargin: policy.harmonicMargin,
        p1Margin: policy.p1Margin,
        cambiMargin: policy.cambiMargin,
        vmafScoreMax: policy.vmafScoreMax,
    });
    return { eligible: reasons.length === 0, reasons: reasons, policy: policy };
}

function publishMeasuredAndInferredAggregates(args, referenceContractId, measuredAggregates,
        inferredAggregate) {
    var measured = Array.isArray(measuredAggregates) ? measuredAggregates.slice() : [];
    if (inferredAggregate) {
        measured = measured.filter(function (aggregate) {
            return aggregate && aggregate.parameterSetId !== inferredAggregate.parameterSetId;
        });
    }
    var published = persistCurrentContractMeasurements(args, referenceContractId, measured);
    if (inferredAggregate) published.push(inferredAggregate);
    return published;
}

function finishInferredAggregate(reconstruction, plan, allValidResults, measuredRows, encodeTimeTotals) {
    var aggregate = reconstruction.reconstructed;
    var currentTasks = (Array.isArray(allValidResults) ? allValidResults : []).filter(function (task) {
        return String(task.parameterSetId) === String(plan.currentId);
    });
    var currentMeasured = (Array.isArray(measuredRows) ? measuredRows : []).filter(function (row) {
        return String(row.parameterSetId) === String(plan.currentId);
    });
    function finiteSum(rows, key) {
        var values = rows.map(function (row) { return Number(row[key]); }).filter(isFinite);
        return values.length ? values.reduce(function (sum, value) { return sum + value; }, 0) : null;
    }
    var sizes = currentTasks.map(function (task) { return Number(task.fileSizeMB); }).filter(isFinite);
    var harmonicMean = aggregate.avgVMAF;
    var variance = aggregate.clipVmafs.reduce(function (sum, value) {
        var delta = value - harmonicMean;
        return sum + delta * delta;
    }, 0) / aggregate.clipVmafs.length;
    var measuredSeconds = ['vmafTimeSec', 'cambiTimeSec', 'ssimTimeSec'].reduce(function (sum, key) {
        var component = finiteSum(currentMeasured, key);
        return sum + (component === null ? 0 : component);
    }, 0);
    var perMeasuredClipSec = currentMeasured.length ? measuredSeconds / currentMeasured.length : null;
    aggregate.avgVMAFHarmonicMean = aggregate.avgVMAF;
    aggregate.minVMAF = null;
    aggregate.maxVMAF = null;
    aggregate.vmafStdDev = Math.sqrt(variance);
    aggregate.maxCAMBI = aggregate.p95CAMBI;
    aggregate.avgFileSizeMB = sizes.length
        ? sizes.reduce(function (sum, value) { return sum + value; }, 0) / sizes.length : null;
    aggregate.encodeTimeSecTotal = Object.prototype.hasOwnProperty.call(encodeTimeTotals, plan.currentId)
        ? encodeTimeTotals[plan.currentId] : null;
    aggregate.vmafTimeSecTotal = finiteSum(currentMeasured, 'vmafTimeSec');
    aggregate.cambiTimeSecTotal = finiteSum(currentMeasured, 'cambiTimeSec');
    aggregate.ssimTimeSecTotal = finiteSum(currentMeasured, 'ssimTimeSec');
    aggregate.measurementSubsample = aggregate.measurementIdentity.measurementSubsample;
    aggregate.componentSecondsSaved = {
        metricSubprocessSecondsEstimated: perMeasuredClipSec === null ? null
            : perMeasuredClipSec * aggregate.inferredClipCount,
        vmafAndCambiCallsSkipped: aggregate.inferredClipCount,
    };
    return aggregate;
}

var plugin = async function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    var fs = require('fs');
    var execFileSync = require('child_process').execFileSync;

    // Infeasible-file cooldown (2026-07-20): testEncodingParameters skipped the sweep, so
    // there is nothing to score — pass straight through without capability probes or setup.
    if (args.variables.vmafCooldownSkip) {
        args.jobLog('Infeasible-file cooldown active - no samples were encoded; skipping VMAF stage.');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    var maxParallelGpu = parseInt(args.inputs.maxParallelGpuVmaf) || 4;
    if (maxParallelGpu < 1) maxParallelGpu = 1;
    if (maxParallelGpu > 6) maxParallelGpu = 6;
    var ssimMode = getSsimMode(args);
    args.variables.vmafSsimModeEffective = ssimMode;
    var testResults = args.variables.vmafTestResults || [];
    var samples = args.variables.vmafSamples || [];
    var referenceContract = grainVmafContract.assertVariables(args.variables, {
        context: 'VMAF measurement',
        requireTemporalPolicy: true,
    });
    var canonicalReference = referenceContract.canonical;
    if (canonicalReference && (args.variables.vmafDenoiseId !== canonicalDenoise.DENOISE_ID ||
        args.variables.vmafDenoiseSettings !== canonicalDenoise.KNN_SETTINGS ||
        Number(args.variables.vmafDenoisePrerollSeconds) !== canonicalDenoise.PREROLL_SECONDS)) {
        throw new Error('VMAF refuses canonical references without the denoised-sample contract');
    }
    if (!canonicalReference && (args.variables.vmafDenoiseFilter !== undefined ||
        args.variables.vmafDenoiseId !== undefined ||
        args.variables.vmafDenoiseSettings !== undefined ||
        args.variables.vmafDenoisePrerollSeconds !== undefined)) {
        throw new Error('original-source VMAF references must not claim the canonical denoise contract');
    }

    if (testResults.length === 0) {
        var errorMsg = 'VMAF calculation failed: No test results found. Run Test Encoding Parameters first.';
        args.jobLog('Error: ' + errorMsg);
        throw new Error(errorMsg);
    }

    var cacheDir = args.workDir || '/temp';

    // Resolve and verify the exact production metric identity before probing
    // capability. A generic v0 smoke test cannot attest another model.
    args.jobLog('=== VMAF Capability Detection ===');
    args.jobLog('Using FFmpeg: ' + args.ffmpegPath);

    var videoStreamForModel = getVideoStream(args.inputFileObj);
    if (!videoStreamForModel || !(Number(videoStreamForModel.width) > 0) ||
            !(Number(videoStreamForModel.height) > 0)) {
        throw new Error('VMAF metric contract resolution requires a primary video stream with dimensions');
    }
    var cpuV1ExecutionPolicy = resolveCpuV1ExecutionPolicy(args);
    var cpuV1ProductionEnabled = cpuV1ExecutionPolicy.productionEnabled;
    var cpuV1QualificationEnabled = cpuV1ExecutionPolicy.qualificationEnabled;
    args.variables.vmafCpuV1HdrAuthorityFallbackUsed =
        cpuV1ExecutionPolicy.fallbackToGpuV0;
    if (cpuV1ExecutionPolicy.fallbackToGpuV0) {
        args.variables.vmafCpuV1HdrAuthorityRejectionCode =
            cpuV1ExecutionPolicy.fallbackCode;
        args.variables.vmafCpuV1HdrAuthorityRejectionReason =
            cpuV1ExecutionPolicy.fallbackReason;
        args.jobLog(cpuV1ExecutionPolicy.fallbackReason +
            '. Retaining the exact GPU-v0 production contract for this HDR file.');
    } else {
        delete args.variables.vmafCpuV1HdrAuthorityRejectionCode;
        delete args.variables.vmafCpuV1HdrAuthorityRejectionReason;
    }
    var cpuV1ContractInput = {
        width: videoStreamForModel.width,
        height: videoStreamForModel.height,
        sampleAspectRatio: videoStreamForModel.sample_aspect_ratio,
        displayAspectRatio: videoStreamForModel.display_aspect_ratio,
        geometryNormalization: 'none',
        isHdr: args.variables.isHDR === true,
        frameRate: parseFrameRate(videoStreamForModel),
        scoringBitDepth: 10,
    };
    var cpuV1ContractOptions = {
        attestedEncoderProfileId: args.variables.vmafReferenceComparisonEncoderProfileId ||
            args.variables.vmafEncoderProfileId,
    };
    var metricContract = null;
    if (cpuV1QualificationEnabled) {
        try {
            metricContract = cpuV1ProductionEnabled
                ? vmafMetricContract.resolveCpuV1Production(
                    cpuV1ContractInput, cpuV1ContractOptions)
                : vmafMetricContract.resolveCpuV1Candidate(
                    cpuV1ContractInput, cpuV1ContractOptions);
        } catch (cpuV1ContractError) {
            if (!isCpuV1GeometryError(cpuV1ContractError)) throw cpuV1ContractError;
            args.variables.vmafCpuV1GeometryRejected = true;
            args.variables.vmafCpuV1GeometryRejectionCode = cpuV1ContractError.code;
            args.variables.vmafCpuV1GeometryRejectionReason = cpuV1ContractError.message;
            args.jobLog('CPU VMAF-v1 authority disabled for this file: ' +
                cpuV1ContractError.message + '. Retaining the exact GPU-v0 production contract.');
            cpuV1ProductionEnabled = false;
            cpuV1QualificationEnabled = false;
        }
    }
    if (!metricContract) {
        metricContract = vmafMetricContract.resolveProductionForVideo(
            videoStreamForModel.width,
            videoStreamForModel.height,
            cpuV1ContractOptions
        );
    }
    if (!cpuV1QualificationEnabled) {
        try {
            vmafMetricContract.assertModelFile(metricContract, { fs: fs });
        } catch (modelVerificationError) {
            args.jobLog('ERROR: ' + modelVerificationError.message);
            throw modelVerificationError;
        }
    }
    args.variables.vmafMetricContractFamilyId = metricContract.metricContractFamilyId;
    args.variables.vmafMetricContractId = metricContract.metricContractId;
    args.variables.vmafEncoderProfileId = metricContract.encoderProfileId;
    args.variables.vmafEncoderProfileAttested = metricContract.encoderProfileAttested;
    args.variables.vmafModelPath = metricContract.modelPath || '';
    args.variables.vmafModelName = metricContract.modelName || metricContract.modelVersion || '';
    args.variables.vmafModelSha256 = metricContract.modelSha256 || '';
    args.variables.vmafMetricBackend = metricContract.backend;
    args.variables.vmafMetricFilterName = metricContract.filterName || 'vmaf-v1-standalone';
    args.variables.vmafScoringBitDepth = metricContract.scoringBitDepth;
    args.variables.vmafScoringPixelFormat = metricContract.scoringPixelFormat;
    args.variables.vmafPoolingPrimary = metricContract.poolingPrimary;
    args.variables.vmafCambiPolicy = metricContract.cambiPolicy;
    args.variables.vmafCambiAvailable = cpuV1QualificationEnabled ||
        Boolean(metricContract.cambi && metricContract.cambi.required === true);
    args.variables.vmafCambiUnavailableReason = metricContract.cambi
        ? (metricContract.cambi.reasonCode || null) : null;
    args.variables.vmafRequireGpuVmaf = !cpuV1QualificationEnabled;
    args.variables.vmafCpuV1QualificationActive = cpuV1QualificationEnabled && !cpuV1ProductionEnabled;
    args.variables.vmafCpuV1ProductionActive = cpuV1ProductionEnabled;
    args.variables.vmafMetricProductionEligible = metricContract.productionEligible === true;

    // Positive capability is cached only for the legacy exact GPU contract.
    // CPU-v1 is checked directly against both isolated wrappers.
    var capabilityResult = cpuV1QualificationEnabled
        ? { available: cpuV1Capability(args, metricContract, fs), cacheHit: false }
        : resolveGpuVmafSupport(args, metricContract, checkGpuVmafSupport);
    var capabilityCacheHit = capabilityResult.cacheHit;
    var hasGpuVmaf = !cpuV1QualificationEnabled && capabilityResult.available;
    var hasCpuV1 = cpuV1QualificationEnabled && capabilityResult.available;
    var hasMetricBackend = hasGpuVmaf || hasCpuV1;
    if (hasCpuV1) {
        args.jobLog(cpuV1ProductionEnabled
            ? 'CPU VMAF-v1 production authority: exact isolated wrappers available'
            : 'CPU VMAF-v1 qualification runtime: exact isolated wrappers available');
    } else if (hasGpuVmaf) {
        args.jobLog('GPU VMAF (libvmaf_cuda): exact contract available' +
            (capabilityCacheHit ? ' (cached for this job)' : ''));
    } else {
        args.jobLog((cpuV1QualificationEnabled
            ? (cpuV1ProductionEnabled ? 'CPU VMAF-v1 production authority' :
                'CPU VMAF-v1 qualification runtime')
            : 'GPU VMAF (libvmaf_cuda)') + ': exact selected contract unavailable');
    }

    args.variables.vmafGpuVmafAvailable = hasGpuVmaf;
    args.variables.vmafGpuVmafRequired = !cpuV1QualificationEnabled;
    args.variables.vmafGpuVmafFallbackUsed = false;
    args.variables.vmafCpuV1Available = hasCpuV1;
    if (!hasMetricBackend) {
        var requiredMsg = cpuV1QualificationEnabled
            ? 'CPU VMAF-v1 qualification was explicitly authorized, but the exact pinned FIFO/runtime wrappers are unavailable for contract ' +
                metricContract.metricContractId + '. Cross-contract fallback is forbidden.'
            : 'GPU VMAF is required, but libvmaf_cuda cannot execute exact metric contract ' +
                metricContract.metricContractId + ' with verified model ' + metricContract.modelPath +
                '. CPU scoring is intentionally disabled.';
        args.jobLog('ERROR: ' + requiredMsg);
        throw new Error(requiredMsg);
    }
    if (args.variables.isHDR) {
        args.variables.vmafHdrPolicy = cpuV1QualificationEnabled
            ? 'Qualification-only native-10-bit PQ-domain CPU VMAF-v1 plus integrated full-reference CAMBI; no tonemapping; provisional and production-ineligible.'
            : 'HDR/PQ content is requantized to 8-bit (format=yuv420p) WITHOUT tonemapping for both GPU VMAF and required CPU pre-FGS CAMBI. The authenticated reference and grain-free candidate use the same metric domain.';
        args.jobLog(cpuV1QualificationEnabled
            ? 'HDR metric policy: provisional native-10-bit PQ-domain CPU VMAF-v1/full-reference CAMBI qualification; no tonemapping.'
            : 'HDR metric policy: resolution-specific VMAF on libvmaf_cuda plus required CPU pre-FGS CAMBI; both use yuv420p8 without tonemapping.');
    }

    var modelPath = metricContract.modelPath || '';
    try {
        var versionOutput = execFileSync(args.ffmpegPath, ['-hide_banner', '-version'], {
            encoding: 'utf8', shell: false, windowsHide: true,
            timeout: 10000, maxBuffer: 1024 * 1024
        });
        args.variables.vmafFfmpegVersion = (versionOutput.split('\n')[0] || '').trim();
    } catch (versionErr) {
        args.variables.vmafFfmpegVersion = '';
    }
    args.variables.vmafLibvmafVersion = cpuV1QualificationEnabled
        ? 'isolated /opt/vmaf-v1 upstream revision ' + vmafV1Cpu.REVISION
        : 'libvmaf.so.3 (runtime path via /custom-libvmaf-lib; upgraded stack v3.1.0)';
    args.jobLog('Using VMAF model: ' + (metricContract.modelVersion || modelPath));
    args.jobLog('  Metric contract: ' + metricContract.metricContractId);
    if (metricContract.modelSha256) args.jobLog('  Model SHA-256: ' + metricContract.modelSha256);
    args.jobLog('  Resolution class: ' +
        (metricContract.modelResolutionClass || metricContract.resolutionClass) + ' for ' +
        videoStreamForModel.width + 'x' + videoStreamForModel.height);

    // Filter valid test results
    var validResults = [];
    var skippedResults = [];

    for (var i = 0; i < testResults.length; i++) {
        var result = testResults[i];
        var skipReason = null;

        if (!result || !result.outputPath) {
            skipReason = 'missing outputPath';
        } else if (result.sampleIndex === undefined || result.sampleIndex === null) {
            skipReason = 'missing sampleIndex';
        } else if (result.sampleIndex < 0 || result.sampleIndex >= samples.length) {
            skipReason = 'invalid sampleIndex ' + result.sampleIndex;
        } else {
            var originalSample = result.originalSamplePath || samples[result.sampleIndex];
            if (!originalSample) {
                skipReason = 'missing original sample';
            }
        }

        if (skipReason) {
            skippedResults.push({ result: result, reason: skipReason });
        } else {
            validResults.push(result);
        }
    }

    if (skippedResults.length > 0) {
        args.jobLog('Skipped ' + skippedResults.length + ' invalid results');
    }

    // The encode-side hard-abort may already have measured its sentinel clips. Reuse those exact
    // results instead of launching duplicate GPU work. Only entries that match this round's valid
    // encoded outputs by parameter-set/sample identity are accepted; the producer clears the list
    // at the start of every encoding round.
    var totalValidResults = validResults.length;
    var requiresSeparateSourceCambi = !cpuV1QualificationEnabled &&
        metricContract.cambi && metricContract.cambi.required === true;
    if (requiresSeparateSourceCambi) {
        var sourceCambiPaths = [];
        var sourceCambiSeen = {};
        validResults.forEach(function (result) {
            var referencePath = result.originalSamplePath || samples[result.sampleIndex];
            if (referencePath && !sourceCambiSeen[referencePath]) {
                sourceCambiSeen[referencePath] = true;
                sourceCambiPaths.push(referencePath);
            }
        });
        sourceCambiPaths.sort();
        var sourceCambiSignature = metricContract.metricContractId +
            '|n=' + getVmafSubsampleInt(args) + '|' + sourceCambiPaths.join('|');
        var sourceCambiCached = args.variables.vmafSourceCambiSignature === sourceCambiSignature &&
            args.variables.vmafSourceCAMBI !== null && args.variables.vmafSourceCAMBI !== undefined &&
            isFinite(Number(args.variables.vmafSourceCAMBI)) &&
            args.variables.vmafSourceCAMBIP95 !== null && args.variables.vmafSourceCAMBIP95 !== undefined &&
            isFinite(Number(args.variables.vmafSourceCAMBIP95));
        if (sourceCambiCached) {
            args.jobLog('Reusing run-bound pre-FGS CAMBI source baseline: mean=' +
                Number(args.variables.vmafSourceCAMBI).toFixed(3) + ', p95=' +
                Number(args.variables.vmafSourceCAMBIP95).toFixed(3));
        } else {
            args.jobLog('Measuring required source CAMBI on authenticated pre-FGS references...');
            var sourceCambiBaseline = await measureSourceCambiBaselines(args, validResults,
                samples, cacheDir, modelPath, metricContract);
            accumulateTimingSeconds(args.variables, 'vmafSourceCambiTimeSec',
                sourceCambiBaseline.timeSec);
            args.variables.vmafSourceCAMBI = sourceCambiBaseline.aggregate.cambiMean;
            args.variables.vmafSourceCAMBIP95 = sourceCambiBaseline.aggregate.cambiP95;
            args.variables.vmafSourceCAMBIMax = sourceCambiBaseline.aggregate.cambiMax;
            args.variables.vmafSourceCambiSampleCount = sourceCambiBaseline.aggregate.sampleCount;
            args.variables.vmafSourceCambiBySample = sourceCambiBaseline.bySample;
            args.variables.vmafSourceCambiSignature = sourceCambiSignature;
            args.jobLog('Pre-FGS CAMBI source baseline: mean=' +
                sourceCambiBaseline.aggregate.cambiMean.toFixed(3) + ', p95=' +
                sourceCambiBaseline.aggregate.cambiP95.toFixed(3) + ', max=' +
                sourceCambiBaseline.aggregate.cambiMax.toFixed(3) + ' across ' +
                sourceCambiBaseline.aggregate.sampleCount + ' authenticated clip(s)');
        }
        args.variables.vmafCambiAvailable = true;
        args.variables.vmafCambiUnavailableReason = null;
    }
    var allValidResults = validResults.slice();
    // Precomputed sentinels were measured under the active production GPU-v0 contract.
    // A CPU-v1 qualification run must never reuse or relabel them.
    var precomputedSplit = cpuV1QualificationEnabled
        ? { reused: [], pending: validResults.slice() }
        : splitPrecomputedVmafResults(
            validResults, args.variables.vmafPrecomputedVmafResults,
            requiresSeparateSourceCambi);
    var precomputedVmafResults = precomputedSplit.reused;
    validResults = precomputedSplit.pending;
    args.variables.vmafPrecomputedVmafResults = [];

    // ── Default-off bounded paired-CQ acting plan ───────────────────────────
    // Only one exact-encoder adjacent harder CQ may act per job. The scheduler below
    // completes the easier vector and six deterministic harder-CQ anchors before it
    // can skip any non-anchor metric subprocesses. Every failed prerequisite falls
    // back to the untouched pending queue.
    var pairedActingEnabled = resolvePairedCqActingEnabled(args);
    var pairedActingPlan = null;
    var pairedActingPolicy = null;
    var pairedActingIdentity = null;
    var pairedActingInference = null;
    var pairedActingSkipped = 0;
    if (pairedActingEnabled && args.variables.vmafPairedCqActingAttempted !== true) {
        var _actingPolicyResult = resolvePairedCqActingPolicy(args);
        var _actingPlanResult = pairedCqShadow.planActingQueue(
            allValidResults, validResults, precomputedVmafResults, { sampleCount: samples.length });
        var _actingIdentityReady = metricContract.metricContractId && referenceContract.id &&
            metricContract.encoderProfileId && metricContract.inferenceAuthorityContractId &&
            isFinite(Number(getVmafSubsampleInt(args)));
        if (_actingPolicyResult.eligible && _actingPlanResult.eligible && _actingIdentityReady) {
            pairedActingPlan = _actingPlanResult;
            pairedActingPolicy = _actingPolicyResult.policy;
            pairedActingIdentity = {
                metricContractId: metricContract.metricContractId,
                referenceContractId: referenceContract.id,
                encoderProfileId: metricContract.encoderProfileId + '|' + pairedActingPlan.encoderIdentity,
                measurementSubsample: getVmafSubsampleInt(args),
                policyId: pairedActingPolicy.policyId,
                inferenceAuthorityContractId: metricContract.inferenceAuthorityContractId,
            };
            args.variables.vmafPairedCqActingAttempted = true;
            args.jobLog('Paired-CQ acting staged: fully measure CQ' + pairedActingPlan.previousCQ +
                ', then six deterministic CQ' + pairedActingPlan.currentCQ + ' anchors before deciding');
        } else {
            var _actingReasons = _actingPolicyResult.reasons.concat(_actingPlanResult.reasons);
            if (!_actingIdentityReady) _actingReasons.push('missing_exact_measurement_identity');
            args.variables.vmafPairedCqActingOutcome = {
                action: 'fallback_full',
                reasons: _actingReasons,
                measurementDisposition: 'measured_full_current_contract',
            };
            args.jobLog('Paired-CQ acting prerequisites failed; measuring all clips: ' +
                _actingReasons.join(','));
        }
    }

    // ── Paired-CQ control-variate shadow ────────────────────────────────────
    // Fully measure at most one adjacent pair per job. The normal decision still consumes the
    // real full metrics; the six-anchor reconstruction is written only as counterfactual JSONL.
    // This bounded temporary cost gives an unbiased answer about the clips that would have been
    // skipped. Once validation is complete, force-full is removed before any acting rollout.
    var pairedShadowEnabled = args.inputs.pairedCqShadow !== false && args.inputs.pairedCqShadow !== 'false';
    var pairedShadowForceFull = args.inputs.pairedCqShadowForceFull !== false && args.inputs.pairedCqShadowForceFull !== 'false';
    var pairedShadowAnchorCount = Math.max(2, Math.min(12, Number(args.inputs.pairedCqShadowAnchors) || 6));
    var pairedShadowPlans = [];
    var pairedShadowForceIds = {};
    if (pairedShadowEnabled && pairedShadowForceFull && !pairedActingPlan &&
            args.variables.vmafPairedCqShadowForced !== true &&
            samples.length >= Math.max(8, pairedShadowAnchorCount + 1)) {
        try {
            var _shadowParamById = {};
            for (var _spr = 0; _spr < validResults.length; _spr++) {
                var _sr = validResults[_spr] || {};
                var _sp = _sr.parameterSet || {};
                var _scq = Number(_sp.cq != null ? _sp.cq : _sp.quality);
                if (_sr.parameterSetId && isFinite(_scq)) {
                    _shadowParamById[_sr.parameterSetId] = { id: _sr.parameterSetId, cq: _scq };
                }
            }
            var _shadowParams = Object.keys(_shadowParamById).map(function (id) { return _shadowParamById[id]; })
                .sort(function (a, b) { return a.cq - b.cq; });
            var _bestPair = null;
            for (var _spi = 0; _spi < _shadowParams.length - 1; _spi++) {
                var _gap = _shadowParams[_spi + 1].cq - _shadowParams[_spi].cq;
                if (_gap > 0 && _gap <= 2 && (!_bestPair || _gap < _bestPair.gap)) {
                    _bestPair = { previousId: _shadowParams[_spi].id, currentId: _shadowParams[_spi + 1].id, gap: _gap };
                }
            }
            if (_bestPair) {
                pairedShadowPlans.push(_bestPair);
                pairedShadowForceIds[_bestPair.previousId] = true;
                pairedShadowForceIds[_bestPair.currentId] = true;
                args.variables.vmafPairedCqShadowForced = true;
                args.jobLog('Paired-CQ shadow: fully measuring one CQ' + _shadowParamById[_bestPair.previousId].cq +
                    ' -> CQ' + _shadowParamById[_bestPair.currentId].cq + ' pair for a six-anchor counterfactual; decisions remain full-score');
            }
        } catch (_shadowPlanError) {
            args.jobLog('Paired-CQ shadow planning skipped (non-fatal): ' + _shadowPlanError.message);
        }
    }

    // GPU PIPELINE LOCK: release for the duration of CPU-v1 scoring.
    //
    // CPU VMAF-v1 does no GPU work at all — /usr/local/bin/vmaf-v1-score decodes
    // both inputs in software (`ffmpeg -i ... -pix_fmt yuv420p10le -f yuv4mpegpipe`,
    // no hwaccel/cuda/nvdec) and scores on CPU libvmaf. Holding the exclusive GPU
    // lock across it blocks every other worker from the GPU while the GPU is idle.
    // Measured on a 2026-07-26 4K episodic canary: 9.4 min of CPU VMAF across
    // 7 rounds inside a 14.4 min lock-held analysis phase — 65% of that phase was
    // GPU-idle-but-locked.
    //
    // Releasing here does not weaken the invariant the lock exists for (one job on
    // the GPU at a time) precisely because this section touches no GPU. The GPU
    // sample encodes that bracket it are protected by explicit downstream
    // Acquire nodes. Do not block this CPU-only plugin waiting to reacquire.
    // If this section throws, the flow's error-handler release is a no-op.
    releaseGpuLockForCpuScoring(args, hasCpuV1);

    args.jobLog('');
    args.jobLog('=== Starting VMAF Calculations ===');
    args.jobLog('Total samples to process: ' + totalValidResults);
    if (precomputedVmafResults.length > 0) {
        args.jobLog('Reusing ' + precomputedVmafResults.length + ' encode-sentinel VMAF result(s)');
    }
    args.jobLog('SSIM mode: ' + ssimMode + (ssimMode === 'first-round' ? (isFirstVmafRound(args) ? ' (enabled for this first round)' : ' (skipped on retry/refinement round)') : ''));

    if (args.updateWorker) {
        args.updateWorker({ percentage: 0 });
    }

    var vmafResults = precomputedVmafResults.slice();
    var successfulCalculations = precomputedVmafResults.length;
    var failedCalculations = 0;
    var gpuVmafActuallyUsed = precomputedVmafResults.length > 0; // Sentinels were measured with libvmaf_cuda.
    var cpuV1ActuallyUsed = false;
    var completedCount = precomputedVmafResults.length;
    var gpuFailureQueue = [];
    var stopGpuFastPath = false;

    // ── Per-file SEQUENTIAL sampling (per-CQ early stop) ──
    // Stop measuring a parameter set's clips once THIS FILE's own per-clip VMAF spread makes the
    // mean precise enough (CI half-width <= seqTol) AND its worst clip clears the 1%-low floor with
    // margin (so we never under-sample a binding floor). Uses the real per-file sigma instead of the
    // conservative between-content historical sigma, so low-variance content stops early and saves
    // the (CQ x clip) VMAF measurements that dominate sweep cost. Fully guarded: any issue -> measure
    // every clip. Kill switch: args.variables.vmafSequentialSampling === false.
    // A hard CAMBI gate requires every authenticated clip. VMAF-only sequential
    // stopping cannot prove that the unmeasured clips are free of banding.
    var seqEnabled = (args.variables.vmafSequentialSampling !== false) &&
        metricContract.cambi.required !== true && validResults.length > 0;
    if (metricContract.cambi.required === true) {
        args.jobLog('Sequential clip stopping disabled: required pre-FGS CAMBI measures every encoded clip');
    }
    var seqTol = Number(args.variables.vmafSampleStopTol); if (!isFinite(seqTol) || seqTol <= 0) seqTol = 0.5;
    var seqMinClips = Math.max(4, Math.min(Number(args.variables.vmafSampleStopMin) || 6, samples.length || 6));
    var seqMaxClips = samples.length || seqMinClips;
    var seqFrameFloor = Number(args.variables.vmafMinFrameVMAF); if (!isFinite(seqFrameFloor)) seqFrameFloor = 0;
    var seqFloorMargin = 2.0;
    var psSeqScores = {}, psSeqMins = {}, psSeqDone = {}, seqSkipped = 0;
    var psSeqByIdx = {}; // per-paramset {sampleIndex: vmafScore} — clip identity survives GPU concurrency
    var hardAbortIdx = null;
    var hardAbortMargin = 1.5;
    if (seqEnabled) {
        // RANDOMISE the clip measurement order (one shared permutation across all paramsets, so each
        // CQ is still compared on identical clips), then process breadth-first. This removes the
        // POSITIONAL bias an early stop would otherwise have: the first clips measured become a random
        // sample across the whole title, not the opening minutes (often easier than the climax), so
        // the per-file sigma / mean / 1%-low the stop relies on are unbiased estimates of the title.
        var _nSamp = samples.length || 0;
        var _perm = []; for (var _pi = 0; _pi < _nSamp; _pi++) _perm.push(_pi);
        for (var _pj = _nSamp - 1; _pj > 0; _pj--) { var _pk = Math.floor(Math.random() * (_pj + 1)); var _pt = _perm[_pj]; _perm[_pj] = _perm[_pk]; _perm[_pk] = _pt; }
        // ── Hardness-first ordering (worst-clip refinement, phase 1) ──
        // On expansion/refinement rounds, per-clip VMAFs from earlier rounds identify which clips
        // bind the floor (per-clip VMAF rank is stable across CQ: cross-CQ correlation ~0.95 in
        // training data). Measuring hardest-first closes the random-order hole where the early stop
        // could fire before the binding clip was ever measured (replay: ~14% of jobs picked an
        // infeasible CQ that way), and it makes clearly-fails decisions fire on the first clips.
        // CAMBI can bind a different clip than VMAF, so after the VMAF-hardness sort we force the
        // highest prior CAMBI-risk clip into the first measured block as well. The running mean over
        // a hardest-first prefix is biased LOW, so a "clearly passes" stop is conservative-valid and
        // a "clearly fails" stop fires earlier: both directions are safe without estimator correction.
        // First round has no prior info -> random order as before. Kill switch:
        // args.variables.vmafHardFirstSampling === false.
        var _hardMap = args.variables.vmafClipHardness;
        var _hardFirst = false;
        var _cambiFirst = false;
        if (args.variables.vmafHardFirstSampling !== false && _hardMap && typeof _hardMap === 'object') {
            var _knownIdx = _perm.filter(function (i) { return isFinite(Number(_hardMap[i])); });
            if (_knownIdx.length >= Math.min(3, _nSamp)) {
                var _unknownIdx = _perm.filter(function (i) { return !isFinite(Number(_hardMap[i])); });
                _knownIdx.sort(function (a, b) { return Number(_hardMap[a]) - Number(_hardMap[b]); });
                _perm = _knownIdx.concat(_unknownIdx); // hardest (lowest prior VMAF) first; unknown keep shuffled order
                _hardFirst = true;
            }
        }
        if (args.variables.vmafHardFirstSampling !== false) {
            var _cambiMap = args.variables.vmafClipCambiRisk;
            if (_cambiMap && typeof _cambiMap === 'object') {
                var _bestCambiIdx = null;
                var _bestCambiRisk = null;
                for (var _ciRisk = 0; _ciRisk < _perm.length; _ciRisk++) {
                    var _riskIdx = _perm[_ciRisk];
                    var _risk = Number(_cambiMap[_riskIdx]);
                    if (isFinite(_risk) && (_bestCambiRisk === null || _risk > _bestCambiRisk)) {
                        _bestCambiRisk = _risk;
                        _bestCambiIdx = _riskIdx;
                    }
                }
                var _frontBlock = Math.min(seqMinClips, _perm.length);
                var _curCambiPos = _bestCambiIdx !== null ? _perm.indexOf(_bestCambiIdx) : -1;
                if (_curCambiPos >= _frontBlock && _frontBlock > 0) {
                    _perm.splice(_curCambiPos, 1);
                    _perm.splice(_frontBlock - 1, 0, _bestCambiIdx);
                    _cambiFirst = true;
                }
            }
        }
        // ── Hard-abort sentinel setup (worst-clip proposal #3, harness-validated 2026-07-05) ──
        // When hardness ordering engaged, the K hardest known clips are the front of _perm.
        // If their collective mean's upper CI at a CQ is already below (target - margin), that CQ
        // cannot pass; the sentinel stops measuring its remaining clips. This matters because a
        // failing CQ usually also fails the 1%-low floor, which suppresses the generic
        // clearly-fails stop and would otherwise force measuring every clip. An abort can only
        // mark a CQ infeasible (selection moves DOWN), so it is conservative by construction.
        // Kill switch: args.variables.vmafHardAbort === false.
        if (_hardFirst && args.variables.vmafHardAbort !== false) {
            var _haK = Number(args.variables.vmafHardAbortK);
            if (!isFinite(_haK) || _haK < 2) _haK = 4;
            // The max-CAMBI splice occupies slot seqMinClips-1, so cap K below it to keep the
            // sentinel set purely VMAF-hardest.
            _haK = Math.min(_haK, Math.max(2, seqMinClips - 1));
            if (_perm.length >= _haK) hardAbortIdx = _perm.slice(0, _haK);
            var _haM = Number(args.variables.vmafHardAbortMargin);
            if (isFinite(_haM) && _haM > 0) hardAbortMargin = _haM;
            if (hardAbortIdx) args.jobLog('Hard-abort sentinel armed: hardest ' + hardAbortIdx.length + ' clips (indices ' + hardAbortIdx.join(',') + '), abort a CQ when their mean CI upper bound <= target - ' + hardAbortMargin);
        }
        var _rank = {}; for (var _ri = 0; _ri < _perm.length; _ri++) _rank[_perm[_ri]] = _ri;
        validResults.sort(function (a, b) {
            var ra = (_rank[a.sampleIndex] != null ? _rank[a.sampleIndex] : a.sampleIndex);
            var rb = (_rank[b.sampleIndex] != null ? _rank[b.sampleIndex] : b.sampleIndex);
            if (ra !== rb) return ra - rb;
            return String(a.parameterSetId).localeCompare(String(b.parameterSetId));
        });
        args.jobLog('Sequential sampling ON (' + (_hardFirst ? 'hardness-first clip order from prior rounds' : 'randomised clip order') + (_cambiFirst ? ' + max-CAMBI clip in first block' : '') + '): stop a CQ at >=' + seqMinClips + ' clips when decision is confident (90% CI clear of target ± ' + seqTol.toFixed(2) + ') AND 1%-low>=floor+' + seqFloorMargin + ' (cap ' + seqMaxClips + '/CQ)');
    }

    // ── XPSNR shadow launch: CPU-only children run concurrently with the GPU VMAF pool below,
    //    so their cost hides inside GPU time. One parameter set (middle CQ), up to 4 clips,
    //    strictly one child at a time. Collected + logged after aggregation. ──
    var xpsnrShadowPromise = null;
    try {
        if (args.variables.vmafXpsnrShadow !== false && hasGpuVmaf && checkXpsnrShadowCapability(args)) {
            var _xpPsIds = [];
            for (var _xi = 0; _xi < validResults.length; _xi++) {
                if (_xpPsIds.indexOf(validResults[_xi].parameterSetId) === -1) _xpPsIds.push(validResults[_xi].parameterSetId);
            }
            var _xpPsId = _xpPsIds.length > 0 ? _xpPsIds[Math.floor(_xpPsIds.length / 2)] : null;
            var _xpTasks = [];
            var _xpSeen = {};
            for (var _xj = 0; _xj < validResults.length && _xpTasks.length < 4; _xj++) {
                var _xe = validResults[_xj];
                if (_xe.parameterSetId !== _xpPsId) continue;
                if (_xpSeen[_xe.sampleIndex]) continue;
                _xpSeen[_xe.sampleIndex] = true;
                var _xref = _xe.originalSamplePath || samples[_xe.sampleIndex];
                if (_xe.outputPath && _xref) _xpTasks.push({ entry: _xe, ref: _xref });
            }
            if (_xpTasks.length > 0) {
                xpsnrShadowPromise = _xpTasks.reduce(function (chainXp, taskXp) {
                    return chainXp.then(function (accXp) {
                        return runXpsnrShadowOnce(args, taskXp.entry.outputPath, taskXp.ref).then(function (rXp) {
                            if (rXp) accXp.push({ task: taskXp, r: rXp });
                            return accXp;
                        });
                    });
                }, Promise.resolve([]));
            }
        }
    } catch (eXpLaunch) { xpsnrShadowPromise = null; }

    // Exact-contract metric backend selected above. Qualification CPU-v1 and production
    // GPU-v0 are mutually exclusive and never fall back across immutable contracts.
    if (hasMetricBackend) {
        var maxParallelMetric = hasCpuV1 ? maxParallelCpuV1(args) : maxParallelGpu;
        args.jobLog('Processing with ' + (hasCpuV1 ? 'CPU VMAF-v1/full-reference CAMBI' : 'GPU VMAF') +
            ' (parallel up to ' + maxParallelMetric + ')...');

        var queue = pairedActingPlan ? pairedActingPlan.stageOneTasks.slice() : validResults.slice();
        var active = 0;
        var completed = 0;

        function runNext() {
            if (active >= maxParallelMetric) return null;
            if (stopGpuFastPath) return null;
            // pull the next measurable item, skipping clips of paramsets already satisfied (seq stop)
            var calcResult = null;
            while (queue.length > 0) {
                var _c = queue.shift();
                if (seqEnabled && psSeqDone[_c.parameterSetId] && !pairedShadowForceIds[_c.parameterSetId]) { seqSkipped++; completedCount++; continue; }
                calcResult = _c; break;
            }
            if (!calcResult) return null;
            active++;
            var idxLabel = completed + active;
            args.jobLog('[' + idxLabel + '/' + totalValidResults + '] ' + calcResult.parameterSetId +
                ' sample ' + (calcResult.sampleIndex + 1) +
                (hasCpuV1 ? ' (CPU-v1 queued)' : ' (GPU queued)'));
            var calculation = hasCpuV1
                ? calculateSingleVmafV1CpuAsync(args, calcResult, samples, cacheDir, metricContract)
                : calculateSingleVmafGpuAsync(args, calcResult, samples, cacheDir,
                    modelPath, metricContract);
            return calculation.then(function(vmafCalcResult) {
                active--;
                if (vmafCalcResult.success) {
                    // Stamp the frame-subsample this row was measured at. Rows carried across
                    // rounds keep their original stamp, so the per-set measurementSubsample
                    // aggregate below reflects what was ACTUALLY measured, not the current
                    // invocation's setting (adaptive-subsample winner confirmation relies on this).
                    vmafCalcResult.result.nSubsample = getVmafSubsampleInt(args);
                    vmafResults.push(vmafCalcResult.result);
                    successfulCalculations++;
                    if (hasGpuVmaf) gpuVmafActuallyUsed = true;
                    if (hasCpuV1) cpuV1ActuallyUsed = true;
                    completedCount++;
                    args.jobLog('  VMAF Score: ' + vmafCalcResult.result.vmafScore.toFixed(2) +
                        ' (harmonic), pre-FGS CAMBI=' + vmafCalcResult.result.cambiMean.toFixed(3) +
                        '/p95 ' + vmafCalcResult.result.cambiP95.toFixed(3) +
                        ', Method: ' + vmafCalcResult.method + ', Time: ' + vmafCalcResult.duration.toFixed(1) + 's');
                    if (seqEnabled) {
                        try {
                            var _psid = vmafCalcResult.result.parameterSetId;
                            var _sv = Number(vmafCalcResult.result.vmafScore);
                            if (isFinite(_sv)) (psSeqScores[_psid] = psSeqScores[_psid] || []).push(_sv);
                            var _pmn = Number(vmafCalcResult.result.vmafMin);
                            if (isFinite(_pmn)) (psSeqMins[_psid] = psSeqMins[_psid] || []).push(_pmn);
                            var _sIdxHA = Number(calcResult.sampleIndex);
                            if (isFinite(_sv) && isFinite(_sIdxHA)) (psSeqByIdx[_psid] = psSeqByIdx[_psid] || {})[_sIdxHA] = _sv;
                            var _nC = (psSeqScores[_psid] || []).length;
                            if (!psSeqDone[_psid] && _nC >= seqMinClips && _nC < seqMaxClips) {
                                // ── Decision-aware sequential stop ──
                                // Instead of a fixed CI tolerance, we evaluate whether the running
                                // estimate is confident enough to DECIDE: clearly pass the target
                                // (lower CI bound >= target + δ) or clearly fail it (upper CI bound
                                // <= target - δ). δ provides a small noise band so we don't oscillate
                                // on marginal decisions. The per-file sigma automatically makes the
                                // effective tolerance scale with margin to the constraint — far from
                                // target → stop fast, near the binding floor → keep sampling.
                                var _decTarget = Number(args.variables.vmafMinVMAF);
                                if (!isFinite(_decTarget) || _decTarget <= 0) _decTarget = 95;
                                var _decFloor = seqFrameFloor; // already set from vmafMinFrameVMAF
                                var _z = 1.64; // 90% CI (one-sided ~95%)
                                var _delta = 0.5; // confidence band
                                var _svs = psSeqScores[_psid];
                                var _sMean = _svs.reduce(function(a,b){return a+b;}, 0) / _svs.length;
                                var _sVar = 0;
                                if (_svs.length > 1) {
                                    _sVar = _svs.reduce(function(ss,v){var d=v-_sMean;return ss+d*d;},0) / (_svs.length - 1);
                                }
                                var _sStd = Math.sqrt(_sVar);
                                var _h = _z * _sStd / Math.sqrt(_svs.length); // CI half-width
                                var _clearlyPasses = (_sMean - _h) >= (_decTarget + _delta);
                                var _clearlyFails = (_sMean + _h) <= (_decTarget - _delta);
                                var _floorOk = true;
                                if (_decFloor > 0 && psSeqMins[_psid] && psSeqMins[_psid].length) {
                                    _floorOk = Math.min.apply(null, psSeqMins[_psid]) >= (_decFloor + seqFloorMargin);
                                }
                                if ((_clearlyPasses || _clearlyFails) && _floorOk) {
                                    psSeqDone[_psid] = true;
                                    args.jobLog('  Sequential stop ' + _psid + ' at ' + _nC + ' clips (mean=' + _sMean.toFixed(2) + ' ± ' + _h.toFixed(2) + ' VMAF, decision=' + (_clearlyPasses ? 'PASS' : 'FAIL') + ', 1%-low clears floor)');
                                }
                                // ── Hard-abort sentinel (proposal #3): collective CI of the K
                                // hardest clips. The stricter threshold (target - margin, vs the
                                // generic target - δ) means it only decides when the generic stop
                                // is blocked by the floor guard — exactly the failing-CQ case where
                                // every remaining clip would otherwise be measured. ──
                                if (!psSeqDone[_psid] && hardAbortIdx) {
                                    var _byIdxHA = psSeqByIdx[_psid] || {};
                                    var _haScores = [];
                                    for (var _hj = 0; _hj < hardAbortIdx.length; _hj++) {
                                        var _hvHA = Number(_byIdxHA[hardAbortIdx[_hj]]);
                                        if (isFinite(_hvHA)) _haScores.push(_hvHA);
                                    }
                                    if (_haScores.length === hardAbortIdx.length) {
                                        var _haMean = _haScores.reduce(function(a,b){return a+b;}, 0) / _haScores.length;
                                        var _haVar = 0;
                                        if (_haScores.length > 1) {
                                            _haVar = _haScores.reduce(function(ss,v){var d=v-_haMean;return ss+d*d;}, 0) / (_haScores.length - 1);
                                        }
                                        var _haCiUpper = _haMean + _z * Math.sqrt(_haVar) / Math.sqrt(_haScores.length);
                                        if (_haCiUpper <= (_decTarget - hardAbortMargin)) {
                                            psSeqDone[_psid] = true;
                                            args.jobLog('  Hard-abort ' + _psid + ' at ' + _nC + ' clips: hardest-' + _haScores.length + ' mean=' + _haMean.toFixed(2) + ' (CI upper ' + _haCiUpper.toFixed(2) + ') <= ' + (_decTarget - hardAbortMargin).toFixed(1) + ' — CQ cannot pass, skipping remaining clips');
                                        }
                                    }
                                }
                            }
                        } catch (eSeqT) { /* non-fatal: keep measuring all clips */ }
                    }
                } else {
                    args.jobLog('  FAILED (' + (hasCpuV1
                        ? (cpuV1ProductionEnabled ? 'CPU-v1 production path' :
                            'CPU-v1 qualification path')
                        : 'GPU fast path') +
                        '): ' + vmafCalcResult.error + ' - disabling exact backend for remaining samples');
                    stopGpuFastPath = true;
                    gpuFailureQueue.push(calcResult);
                    while (queue.length > 0) {
                        gpuFailureQueue.push(queue.shift());
                    }
                }
                var progressPercent = Math.round((completedCount / Math.max(1, totalValidResults)) * 100);
                if (args.updateWorker) {
                    args.updateWorker({
                        percentage: progressPercent,
                        ETA: Math.max(0, Math.round((totalValidResults - completedCount) * 5))
                    });
                }
                return runNext();
            });
        }

        async function drainCurrentGpuQueue() {
            var runners = [];
            for (var r = 0; r < Math.min(maxParallelMetric, queue.length); r++) {
                var nxt = runNext();
                if (nxt) runners.push(nxt);
            }
            if (runners.length > 0) await Promise.all(runners);
        }

        await drainCurrentGpuQueue();

        if (pairedActingPlan && !stopGpuFastPath) {
            var _partial = pairedCqShadow.buildMeasuredPartial(
                pairedActingPlan, precomputedVmafResults.concat(vmafResults), pairedActingIdentity);
            var _reconstruction = _partial.eligible
                ? pairedCqShadow.reconstructPartial(
                    _partial.previous, _partial.currentAnchors, pairedActingPolicy)
                : { eligible: false, actingSafe: false, reasons: _partial.reasons };
            if (_reconstruction.eligible && _reconstruction.actingSafe) {
                pairedActingInference = _reconstruction;
                pairedActingSkipped = pairedActingPlan.currentNonanchorTasks.length;
                var _skipKeys = {};
                pairedActingPlan.currentNonanchorTasks.forEach(function (task) {
                    _skipKeys[String(task.parameterSetId) + ':' + String(task.sampleIndex)] = true;
                });
                queue = pairedActingPlan.remainingTasks.filter(function (task) {
                    return !_skipKeys[String(task.parameterSetId) + ':' + String(task.sampleIndex)];
                });
                var _pairedCi = _reconstruction.confidence95Halfwidth || {};
                var _pairedPredicted = _reconstruction.predicted || {};
                var _pairedEstimatedSecPerClip = _partial.previous && Number(_partial.previous.sampleCount) > 0
                    ? (Number(_partial.previous.vmafTimeSecTotal || 0) + Number(_partial.previous.cambiTimeSecTotal || 0)) /
                        Number(_partial.previous.sampleCount) : null;
                args.variables.vmafPairedCqActingOutcome = {
                    schema: pairedCqShadow.SCHEMA_VERSION,
                    action: 'paired_cq_inferred_v1',
                    reasons: [],
                    previousParameterSetId: pairedActingPlan.previousId,
                    currentParameterSetId: pairedActingPlan.currentId,
                    measurementIdentity: pairedActingIdentity,
                    measuredAnchorIndices: pairedActingPlan.anchorIndices.slice(),
                    measuredClipCount: _reconstruction.reconstructed.measuredClipCount,
                    inferredClipCount: _reconstruction.reconstructed.inferredClipCount,
                    skippedMetricCalls: pairedActingSkipped,
                    confidence95Halfwidth: _pairedCi,
                    maximumConfidence95Halfwidth: _reconstruction.maximumConfidence95Halfwidth,
                    conservativeCiMargins: {
                        harmonic: Number(_pairedPredicted.harmonic) - Number(_pairedCi.harmonic) -
                            (Number(pairedActingPolicy.targetVmaf) + Number(pairedActingPolicy.harmonicMargin)),
                        p1: Number(_pairedPredicted.p1) - Number(_pairedCi.p1) -
                            (Number(pairedActingPolicy.vmafP1Floor) + Number(pairedActingPolicy.p1Margin)),
                        cambi: (Number(pairedActingPolicy.cambiLimit) - Number(pairedActingPolicy.cambiMargin)) -
                            Math.max(Number(_pairedPredicted.cambiMean) + Number(_pairedCi.cambiMean),
                                Number(_pairedPredicted.cambiP95) + Number(_pairedCi.cambiP95)),
                    },
                    estimatedMetricSecondsSaved: isFinite(_pairedEstimatedSecPerClip)
                        ? pairedActingSkipped * _pairedEstimatedSecPerClip : null,
                    measurementDisposition: 'paired_cq_inferred_v1',
                };
                args.jobLog('Paired-CQ acting SAFE: skipping ' + pairedActingSkipped +
                    ' CQ' + pairedActingPlan.currentCQ + ' non-anchor metric subprocess(es); full holdout remains required');
            } else {
                queue = pairedActingPlan.remainingTasks.slice();
                args.variables.vmafPairedCqActingOutcome = {
                    schema: pairedCqShadow.SCHEMA_VERSION,
                    action: 'fallback_full',
                    reasons: (_reconstruction.reasons || []).slice(),
                    measurementIdentity: pairedActingIdentity,
                    measuredClipCount: 0,
                    inferredClipCount: 0,
                    skippedMetricCalls: 0,
                    estimatedMetricSecondsSaved: 0,
                    measurementDisposition: 'measured_full_current_contract',
                };
                args.jobLog('Paired-CQ acting reconstruction was not safely binding; measuring all remaining clips: ' +
                    ((_reconstruction.reasons || []).join(',') || 'insufficient_selector_margin'));
            }
            await drainCurrentGpuQueue();
        }

        if (gpuFailureQueue.length > 0) {
            var strictBackendMsg = (hasCpuV1
                ? (cpuV1ProductionEnabled ? 'CPU VMAF-v1 production runtime' :
                    'CPU VMAF-v1 qualification runtime')
                : 'GPU VMAF') +
                ' is required by the selected immutable contract, but failed for ' +
                gpuFailureQueue.length + ' sample(s). Cross-contract fallback is disabled.';
            args.jobLog('ERROR: ' + strictBackendMsg);
            throw new Error(strictBackendMsg);
        }
    } else {
        throw new Error('Exact-contract metric backend was not available; cross-contract fallback is disabled.');
    }

    if (cpuV1QualificationEnabled) {
        var integratedSourceBySample = {};
        vmafResults.forEach(function (row) {
            var key = Number(row.sampleIndex);
            if (integratedSourceBySample[key]) return;
            integratedSourceBySample[key] = {
                cambiMean: Number(row.sourceCambiMean),
                cambiP95: Number(row.sourceCambiP95),
                cambiMax: Number(row.sourceCambiMax),
            };
        });
        var integratedSourceRows = Object.keys(integratedSourceBySample).map(function (key) {
            return integratedSourceBySample[key];
        });
        var integratedSourceBaseline = preFgsCambi.aggregateBaselines(integratedSourceRows);
        args.variables.vmafSourceCAMBI = integratedSourceBaseline.cambiMean;
        args.variables.vmafSourceCAMBIP95 = integratedSourceBaseline.cambiP95;
        args.variables.vmafSourceCAMBIMax = integratedSourceBaseline.cambiMax;
        args.variables.vmafSourceCambiSampleCount = integratedSourceBaseline.sampleCount;
        args.variables.vmafSourceCambiBySample = integratedSourceBySample;
        args.variables.vmafSourceCambiTimeSec = 0;
        args.variables.vmafSourceCambiTimingAttribution = 'integrated-in-vmaf-v1-wall-clock';
        args.variables.vmafSourceCambiSignature = metricContract.metricContractId +
            '|n=' + getVmafSubsampleInt(args) + '|integrated-full-reference';
        args.variables.vmafCambiAvailable = true;
        args.variables.vmafCambiUnavailableReason = null;
        args.jobLog('Integrated native-10-bit source CAMBI baseline: mean=' +
            integratedSourceBaseline.cambiMean.toFixed(3) + ', p95=' +
            integratedSourceBaseline.cambiP95.toFixed(3) + ', max=' +
            integratedSourceBaseline.cambiMax.toFixed(3) + ' across ' +
            integratedSourceBaseline.sampleCount + ' authenticated clip(s)');
    }

    // Validation. Exclude clips intentionally skipped by sequential sampling from the denominator -
    // they were never attempted, so they must not count against the success rate.
    var totalAttempts = Math.max(1, totalValidResults - seqSkipped - pairedActingSkipped);
    if (pairedActingSkipped > 0) {
        args.jobLog('Paired-CQ acting skipped ' + pairedActingSkipped +
            ' metric subprocess(es) after exact-contract anchor reconstruction');
    }
    if (seqEnabled && seqSkipped > 0) {
        args.jobLog('Sequential sampling skipped ' + seqSkipped + ' clip-measurements (mean precise + 1%-low clear early)');
    }

    if (totalAttempts === 0) {
        throw new Error('VMAF calculation failed: No valid test results to process');
    }

    if (successfulCalculations === 0) {
        throw new Error('VMAF calculation failed: All ' + totalAttempts + ' calculation attempts failed');
    }

    var successRate = successfulCalculations / totalAttempts;
    if (successRate < 0.5) {
        throw new Error('VMAF calculation success rate too low (' + (successRate * 100).toFixed(1) + '%)');
    }

    if (successRate < 0.8) {
        args.jobLog('WARNING: VMAF success rate is ' + (successRate * 100).toFixed(1) + '%');
    }

    // Aggregate results by parameter set
    args.jobLog('');
    args.jobLog('=== Aggregating Results ===');

    // Deterministic clip order: parallel VMAF completion would otherwise permute the per-clip
    // arrays between parameter sets, breaking cross-CQ pairing of clip_vmafs/clip_cambis (the
    // paired-clip variance model in autoresearch assumes index i is the same source clip at
    // every CQ).
    vmafResults.sort(function (a, b) {
        if (a.parameterSetId !== b.parameterSetId) return a.parameterSetId < b.parameterSetId ? -1 : 1;
        return (a.sampleIndex || 0) - (b.sampleIndex || 0);
    });

    var aggregated = {};
    for (var n = 0; n < vmafResults.length; n++) {
        var r = vmafResults[n];
        if (!aggregated[r.parameterSetId]) {
            aggregated[r.parameterSetId] = {
                parameterSetId: r.parameterSetId,
                parameterSet: r.parameterSet,
                vmafScores: [],
                vmafMeans: [],
                vmafHarmonicMeans: [],
                vmafMins: [],
                vmafMaxs: [],
                vmafP1s: [],
                clipVmafMeans: [],
                clipVmafP1s: [],
                ssimScores: [],
                cambiMeans: [],
                cambiMaxs: [],
                cambiP95s: [],
                clipCambiMeans: [],
                clipCambiP95s: [],
                clipSampleIndices: [],
                fileSizes: [],
            };
        }
        // Which source clip each clip_vmafs entry came from. The sequential stop measures
        // different clip counts per CQ, so index position alone cannot pair clips across CQs.
        aggregated[r.parameterSetId].clipSampleIndices.push(r.sampleIndex != null ? r.sampleIndex : null);
        // Coarsest frame-subsample among this set's rows (rows without a stamp predate the
        // adaptive-subsample deploy, when everything ran full-rate -> treat as 1).
        var _rowNSub = Number(r.nSubsample);
        if (!isFinite(_rowNSub) || _rowNSub < 1) _rowNSub = 1;
        if (!aggregated[r.parameterSetId]._maxNSubsample || _rowNSub > aggregated[r.parameterSetId]._maxNSubsample) {
            aggregated[r.parameterSetId]._maxNSubsample = _rowNSub;
        }
        if (isFinite(Number(r.vmafTimeSec))) {
            aggregated[r.parameterSetId].vmafTimeSecTotal = (aggregated[r.parameterSetId].vmafTimeSecTotal || 0) + Number(r.vmafTimeSec);
        }
        if (isFinite(Number(r.cambiTimeSec))) {
            aggregated[r.parameterSetId].cambiTimeSecTotal = (aggregated[r.parameterSetId].cambiTimeSecTotal || 0) + Number(r.cambiTimeSec);
        }
        if (isFinite(Number(r.ssimTimeSec))) {
            aggregated[r.parameterSetId].ssimTimeSecTotal = (aggregated[r.parameterSetId].ssimTimeSecTotal || 0) + Number(r.ssimTimeSec);
        }
        // Per-clip CAMBI, position-aligned with vmafScores (nulls preserved so index i stays the
        // same source clip in every array). Feeds sweep_points.clip_cambis for real CAMBI CIs.
        aggregated[r.parameterSetId].clipCambiMeans.push(r.cambiMean !== null && r.cambiMean !== undefined ? r.cambiMean : null);
        aggregated[r.parameterSetId].clipCambiP95s.push(r.cambiP95 !== null && r.cambiP95 !== undefined ? r.cambiP95 : null);
        aggregated[r.parameterSetId].clipVmafMeans.push(
            r.vmafMean !== null && r.vmafMean !== undefined ? r.vmafMean : null);
        aggregated[r.parameterSetId].clipVmafP1s.push(
            r.vmafP1 !== null && r.vmafP1 !== undefined ? r.vmafP1 : null);
        aggregated[r.parameterSetId].vmafScores.push(r.vmafScore);
        if (r.vmafMean !== null && r.vmafMean !== undefined) {
            aggregated[r.parameterSetId].vmafMeans.push(r.vmafMean);
        }
        if (r.vmafHarmonicMean !== null && r.vmafHarmonicMean !== undefined) {
            aggregated[r.parameterSetId].vmafHarmonicMeans.push(r.vmafHarmonicMean);
        }
        if (r.vmafMin !== null && r.vmafMin !== undefined) {
            aggregated[r.parameterSetId].vmafMins.push(r.vmafMin);
        }
        if (r.vmafMax !== null && r.vmafMax !== undefined) {
            aggregated[r.parameterSetId].vmafMaxs.push(r.vmafMax);
        }
        if (r.vmafP1 !== null && r.vmafP1 !== undefined) {
            aggregated[r.parameterSetId].vmafP1s.push(r.vmafP1);
        }
        if (r.ssimScore !== null && r.ssimScore !== undefined) {
            aggregated[r.parameterSetId].ssimScores.push(r.ssimScore);
        }
        if (r.cambiMean !== null && r.cambiMean !== undefined) {
            aggregated[r.parameterSetId].cambiMeans.push(r.cambiMean);
        }
        if (r.cambiMax !== null && r.cambiMax !== undefined) {
            aggregated[r.parameterSetId].cambiMaxs.push(r.cambiMax);
        }
        if (r.cambiP95 !== null && r.cambiP95 !== undefined) {
            aggregated[r.parameterSetId].cambiP95s.push(r.cambiP95);
        }
        aggregated[r.parameterSetId].fileSizes.push(r.fileSizeMB);
    }

    var encodeTimeTotals = buildEncodeTimeTotals(testResults);
    var aggregatedResults = [];
    for (var key in aggregated) {
        var item = aggregated[key];
        var avgVMAF = item.vmafScores.reduce(function(a, b) { return a + b; }, 0) / item.vmafScores.length;
        var avgSize = item.fileSizes.reduce(function(a, b) { return a + b; }, 0) / item.fileSizes.length;
        var avgMean = item.vmafMeans.length > 0 ? item.vmafMeans.reduce(function(a, b) { return a + b; }, 0) / item.vmafMeans.length : null;
        var avgHarmonicMean = item.vmafHarmonicMeans.length > 0 ? item.vmafHarmonicMeans.reduce(function(a, b) { return a + b; }, 0) / item.vmafHarmonicMeans.length : null;
        var overallMin = item.vmafMins.length > 0 ? Math.min.apply(null, item.vmafMins) : null;
        var overallMax = item.vmafMaxs.length > 0 ? Math.max.apply(null, item.vmafMaxs) : null;
        var overallP1 = item.vmafP1s.length > 0 ? Math.min.apply(null, item.vmafP1s) : null;
        var avgSSIM = item.ssimScores.length > 0
            ? item.ssimScores.reduce(function(a, b) { return a + b; }, 0) / item.ssimScores.length
            : null;
        var avgCAMBI = item.cambiMeans.length > 0
            ? item.cambiMeans.reduce(function(a, b) { return a + b; }, 0) / item.cambiMeans.length
            : null;
        var maxCAMBI = item.cambiMaxs.length > 0 ? Math.max.apply(null, item.cambiMaxs) : null;
        var p95CAMBI = item.cambiP95s.length > 0 ? Math.max.apply(null, item.cambiP95s) : null;
        var variance = 0;
        if (item.vmafScores.length > 1) {
            var mean = avgVMAF;
            variance = item.vmafScores.reduce(function(acc, v) {
                var diff = v - mean;
                return acc + diff * diff;
            }, 0) / item.vmafScores.length;
        }
        var stdDev = Math.sqrt(variance);

        aggregatedResults.push({
            parameterSetId: item.parameterSetId,
            parameterSet: item.parameterSet,
            avgVMAF: avgVMAF,
            avgVMAFMean: avgMean,
            avgVMAFHarmonicMean: avgHarmonicMean,
            minVMAF: overallMin,
            maxVMAF: overallMax,
            vmafP1Low: overallP1,
            avgFileSizeMB: avgSize,
            avgSSIM: avgSSIM,
            avgCAMBI: avgCAMBI,
            maxCAMBI: maxCAMBI,
            p95CAMBI: p95CAMBI,
            sampleCount: item.vmafScores.length,
            vmafStdDev: stdDev,
            clipVmafs: item.vmafScores,
            clipVmafMeans: item.clipVmafMeans,
            clipVmafP1s: item.clipVmafP1s,
            clipCambis: { mean: item.clipCambiMeans, p95: item.clipCambiP95s },
            clipSampleIndices: item.clipSampleIndices,
            encodeTimeSecTotal: Object.prototype.hasOwnProperty.call(encodeTimeTotals, item.parameterSetId)
                ? encodeTimeTotals[item.parameterSetId] : null,
            vmafTimeSecTotal: item.vmafTimeSecTotal != null ? item.vmafTimeSecTotal : null,
            cambiTimeSecTotal: item.cambiTimeSecTotal != null ? item.cambiTimeSecTotal : null,
            ssimTimeSecTotal: item.ssimTimeSecTotal != null ? item.ssimTimeSecTotal : null,
            measurementDisposition: 'measured_full_current_contract',
            // Per-set coarsest subsample actually used (was: current invocation's setting, which
            // mislabelled rows carried over from earlier rounds measured at a different rate).
            // checkCQBracket's winner full-rate confirmation gates on this being > 1.
            measurementSubsample: item._maxNSubsample || 1,
        });

        // Show CAMBI as avg/p95/max, not just the mean: selection rejects on the WORST-CASE
        // (max(mean,p95)), so printing only the mean made "CAMBI=2.18" then "rejected CAMBI 5.59"
        // look contradictory. The p95/max is the banding the selector (and the viewer) actually cares about.
        args.jobLog(key + ': VMAF=' + avgVMAF.toFixed(2) + ', 1%low=' +
            (overallP1 !== null ? overallP1.toFixed(2) : 'N/A') + ', Min=' +
            (overallMin !== null ? overallMin.toFixed(2) : 'N/A') + ', SSIM=' +
            (avgSSIM !== null ? avgSSIM.toFixed(2) : 'N/A') + ', CAMBI(avg/p95/max)=' +
            (avgCAMBI !== null ? avgCAMBI.toFixed(2) : 'N/A') + '/' +
            (p95CAMBI !== null ? p95CAMBI.toFixed(2) : 'N/A') + '/' +
            (maxCAMBI !== null ? maxCAMBI.toFixed(2) : 'N/A') +
            ', Size=' + avgSize.toFixed(2) + 'MB');
    }

    // Per-clip hardness across all rounds so far: min VMAF seen for each sample index. Lower =
    // harder. Track max CAMBI p95 separately because banding can bind a different source clip than
    // VMAF floor/mean. Both maps feed the next expansion round's clip ordering.
    try {
        var _hardAcc = (args.variables.vmafClipHardness && typeof args.variables.vmafClipHardness === 'object')
            ? args.variables.vmafClipHardness : {};
        var _cambiAcc = (args.variables.vmafClipCambiRisk && typeof args.variables.vmafClipCambiRisk === 'object')
            ? args.variables.vmafClipCambiRisk : {};
        for (var _hn = 0; _hn < vmafResults.length; _hn++) {
            var _hr = vmafResults[_hn];
            var _hv = Number(_hr.vmafScore);
            if (_hr.sampleIndex == null) continue;
            if (isFinite(_hv)) {
                var _prev = Number(_hardAcc[_hr.sampleIndex]);
                _hardAcc[_hr.sampleIndex] = isFinite(_prev) ? Math.min(_prev, _hv) : _hv;
            }
            var _hc = Number(_hr.cambiP95);
            if (isFinite(_hc)) {
                var _cprev = Number(_cambiAcc[_hr.sampleIndex]);
                _cambiAcc[_hr.sampleIndex] = isFinite(_cprev) ? Math.max(_cprev, _hc) : _hc;
            }
        }
        args.variables.vmafClipHardness = _hardAcc;
        args.variables.vmafClipCambiRisk = _cambiAcc;
    } catch (eHard) { /* non-fatal: next round falls back to random order */ }

    // Preserve every measurement made by this job under this exact reference contract across
    // bracket/refinement/retry loops. The dedicated envelope is intentionally independent of
    // vmafAggregatedResults, which downstream selection may augment with cross-job reuse rows.
    // Publishing a deep clone keeps those rows from contaminating fresh acceptance authority.
    if (pairedActingInference && pairedActingPlan) {
        var _inferredAggregate = finishInferredAggregate(
            pairedActingInference, pairedActingPlan, allValidResults, vmafResults, encodeTimeTotals);
        aggregatedResults = publishMeasuredAndInferredAggregates(
            args, referenceContract.id, aggregatedResults, _inferredAggregate);
        args.variables.vmafPairedCqActingOutcome.reconstructedAggregate = {
            parameterSetId: _inferredAggregate.parameterSetId,
            measuredClipCount: _inferredAggregate.measuredClipCount,
            inferredClipCount: _inferredAggregate.inferredClipCount,
            avgVMAF: _inferredAggregate.avgVMAF,
            vmafP1Low: _inferredAggregate.vmafP1Low,
            avgCAMBI: _inferredAggregate.avgCAMBI,
            p95CAMBI: _inferredAggregate.p95CAMBI,
            measurementDisposition: _inferredAggregate.measurementDisposition,
        };
    } else {
        aggregatedResults = persistCurrentContractMeasurements(args, referenceContract.id, aggregatedResults);
    }
    args.variables.vmafAggregatedResults = aggregatedResults;
    args.variables.vmafResults = vmafResults;
    args.variables.vmafGpuAccelerated = gpuVmafActuallyUsed;
    args.variables.vmafUsedGpuVmaf = gpuVmafActuallyUsed; // Track if GPU VMAF was actually used (not just available)
    args.variables.vmafGpuVmafActuallyUsed = gpuVmafActuallyUsed;
    args.variables.vmafCpuV1ActuallyUsed = cpuV1ActuallyUsed;
    args.variables.vmafMetricExecutionBackend = cpuV1ActuallyUsed ? 'cpu-vmaf-v1-native10-integrated-cambi' :
        (gpuVmafActuallyUsed ? 'gpu-vmaf-v0-plus-cpu-cambi' : null);

    // ── XPSNR shadow collect: pair each finished xpsnr run with the authoritative per-clip
    //    VMAF from this round and append calibration rows. Entirely fail-open. ──
    if (xpsnrShadowPromise) {
        try {
            var _xpDone = await xpsnrShadowPromise;
            var _xpRows = 0;
            for (var _xk = 0; _xk < _xpDone.length; _xk++) {
                var _xt = _xpDone[_xk].task;
                var _xr = _xpDone[_xk].r;
                var _xVmaf = null;
                for (var _xm = 0; _xm < vmafResults.length; _xm++) {
                    var _vr = vmafResults[_xm];
                    if (_vr.parameterSetId === _xt.entry.parameterSetId && _vr.sampleIndex === _xt.entry.sampleIndex) { _xVmaf = _vr; break; }
                }
                if (!_xVmaf) continue;
                var _xRec = {
                    schema: 1,
                    ts: new Date().toISOString(),
                    jobId: args.variables.vmafCanonicalJobId || null,
                    parameterSetId: _xt.entry.parameterSetId,
                    cq: _xt.entry.parameterSet && _xt.entry.parameterSet.quality !== undefined ? _xt.entry.parameterSet.quality : null,
                    sampleIndex: _xt.entry.sampleIndex,
                    xpsnrY: _xr.xpsnr.y === Infinity ? 'inf' : _xr.xpsnr.y,
                    xpsnrU: _xr.xpsnr.u === Infinity ? 'inf' : _xr.xpsnr.u,
                    xpsnrV: _xr.xpsnr.v === Infinity ? 'inf' : _xr.xpsnr.v,
                    xpsnrMin: _xr.xpsnr.min === Infinity ? 'inf' : _xr.xpsnr.min,
                    xpsnrDurationSec: Number(_xr.durationSec.toFixed(2)),
                    clipVmafHarmonic: isFinite(Number(_xVmaf.vmafScore)) ? Number(_xVmaf.vmafScore) : null,
                    clipVmafMean: isFinite(Number(_xVmaf.vmafMean)) ? Number(_xVmaf.vmafMean) : null,
                    clipVmafP1: isFinite(Number(_xVmaf.vmafP1)) ? Number(_xVmaf.vmafP1) : null,
                    vmafNSubsample: Number(_xVmaf.nSubsample) || 1,
                    isHDR: args.variables.isHDR === true,
                };
                try {
                    fs.appendFileSync('/app/configs/vmaf_xpsnr_shadow.jsonl', JSON.stringify(_xRec) + '\n', 'utf8');
                    _xpRows++;
                } catch (eXpWrite) { /* fail-open: shadow telemetry must never affect the job */ }
            }
            if (_xpRows > 0) args.jobLog('XPSNR shadow: logged ' + _xpRows + ' paired (xpsnr, clip-VMAF) row(s) — calibration telemetry only');
        } catch (eXpCollect) {
            args.jobLog('XPSNR shadow collect failed (non-fatal): ' + eXpCollect.message);
        }
    }

    // Evaluate the paired-CQ plan only after both parameter sets have their full real clip vector.
    // This never replaces vmafAggregatedResults and cannot affect CQ selection.
    if (pairedShadowPlans.length > 0) {
        try {
            var pairedShadow = require('../../_lib/pairedCqShadow.js');
            var feasibility = require('../../_lib/feasibility.js');
            var _aggById = {};
            for (var _pai = 0; _pai < aggregatedResults.length; _pai++) {
                _aggById[aggregatedResults[_pai].parameterSetId] = aggregatedResults[_pai];
            }
            var _shadowFloor = Number(args.variables.vmafMinFrameVMAF);
            if (!isFinite(_shadowFloor) || _shadowFloor <= 0) {
                _shadowFloor = Number(args.variables.vmafQualityRiskPolicy && args.variables.vmafQualityRiskPolicy.adaptiveFrameFloor);
            }
            var _shadowStreams = args.inputFileObj && args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams;
            var _shadowVideo = Array.isArray(_shadowStreams) ? _shadowStreams.filter(function (stream) {
                return stream && stream.codec_type === 'video' && !(stream.disposition && stream.disposition.attached_pic === 1);
            })[0] : null;
            var _shadowWidth = Number(_shadowVideo && _shadowVideo.width) || 0;
            var _shadowHeight = Number(_shadowVideo && _shadowVideo.height) || 0;
            var _shadowPixels = _shadowWidth * _shadowHeight;
            var _shadowTier = 'sd';
            if (_shadowWidth >= 3800 || _shadowHeight >= 1800 || _shadowPixels >= 7000000) _shadowTier = '4k';
            else if (_shadowWidth >= 2500 || _shadowHeight >= 1300 || _shadowPixels >= 3000000) _shadowTier = '1440p';
            else if (_shadowWidth >= 1700 || _shadowHeight >= 900 || _shadowPixels >= 1600000) _shadowTier = '1080p';
            else if (_shadowWidth >= 1100 || _shadowHeight >= 650 || _shadowPixels >= 800000) _shadowTier = '720p';
            var _shadowHdr = args.variables.isHDR === true || args.variables.vmafIsHDR === true;
            var _shadowAnimation = args.variables.vmafMediaIsAnimation === true;
            if (!isFinite(_shadowFloor) || _shadowFloor <= 0) {
                var _shadowFloors = {
                    '4k': _shadowAnimation ? 84.0 : (_shadowHdr ? 86.0 : 85.5),
                    '1440p': _shadowAnimation ? 83.5 : (_shadowHdr ? 85.5 : 85.0),
                    '1080p': _shadowAnimation ? 83.0 : (_shadowHdr ? 85.0 : 84.5),
                    '720p': _shadowAnimation ? 82.5 : 83.5,
                    'sd': _shadowAnimation ? 81.5 : 82.5,
                };
                _shadowFloor = _shadowFloors[_shadowTier];
                var _shadowSourceType = String(args.variables.vmafMediaSourceType || '').toLowerCase();
                var _shadowMediaType = String(args.variables.vmafMediaType || '').toLowerCase();
                if (!_shadowAnimation && (_shadowSourceType.indexOf('bluray') !== -1 || _shadowSourceType.indexOf('blu-ray') !== -1)) _shadowFloor += 0.3;
                if (!_shadowAnimation && _shadowTier === '4k' && _shadowMediaType.indexOf('movie') !== -1) _shadowFloor += 0.2;
                _shadowFloor = Math.min(94, _shadowFloor);
            }
            var _shadowCambiLimit = feasibility.effectiveCambiLimit({
                isAnimation: _shadowAnimation,
                isHDR: _shadowHdr,
                sourceCambi: args.variables.vmafSourceCAMBI,
                sourceCambiP95: args.variables.vmafSourceCAMBIP95,
                cambiTolerance: 1.0,
            });
            for (var _ppi = 0; _ppi < pairedShadowPlans.length; _ppi++) {
                var _plan = pairedShadowPlans[_ppi];
                var _previous = _aggById[_plan.previousId];
                var _current = _aggById[_plan.currentId];
                // Bind identity to the exact effective policy used by this force-full
                // counterfactual. At calculateVMAF time the selector has not yet published
                // its policy variables, so resolving identity from args.variables alone
                // would serialize null floor/CAMBI authority under a non-empty policy ID.
                var _shadowPolicyResult = resolvePairedCqActingPolicy(args, {
                    selectorPolicyVersion: args.variables.vmafSelectorPolicyVersion || 'selector-authoritative-v2',
                    targetVmaf: Number(args.variables.vmafMinVMAF) || 95,
                    vmafP1Floor: _shadowFloor,
                    cambiLimit: _shadowCambiLimit,
                });
                var _shadowPolicy = _shadowPolicyResult.policy;
                var _assessment = pairedShadow.assess(_previous, _current, {
                    anchorCount: _shadowPolicy.anchorCount,
                    maxCqGap: _shadowPolicy.maxCqGap,
                    targetVmaf: _shadowPolicy.targetVmaf,
                    vmafP1Floor: _shadowPolicy.vmafP1Floor,
                    cambiLimit: _shadowPolicy.cambiLimit,
                    harmonicMargin: _shadowPolicy.harmonicMargin,
                    p1Margin: _shadowPolicy.p1Margin,
                    cambiMargin: _shadowPolicy.cambiMargin,
                });
                var _metricSeconds = _current
                    ? Number(_current.vmafTimeSecTotal || 0) + Number(_current.cambiTimeSecTotal || 0) : NaN;
                var _perScoreSec = _current && _current.sampleCount > 0 && isFinite(_metricSeconds)
                    ? _metricSeconds / Number(_current.sampleCount) : null;
                var _shadowEncoderIdentity = pairedShadow.encoderIdentity(
                    _current && _current.parameterSet ? _current.parameterSet : {});
                var _shadowPredictedSafe = Boolean(_assessment.eligible && _assessment.predicted &&
                    _assessment.predicted.safe === true && _shadowPolicyResult.eligible);
                var _shadowConservativeMargins = {
                    harmonic: _assessment.predicted
                        ? Number(_assessment.predicted.harmonic) -
                            (Number(_shadowPolicy.targetVmaf) + Number(_shadowPolicy.harmonicMargin)) : null,
                    p1: _assessment.predicted
                        ? Number(_assessment.predicted.p1) -
                            (Number(_shadowPolicy.vmafP1Floor) + Number(_shadowPolicy.p1Margin)) : null,
                    cambi: _assessment.predicted
                        ? (Number(_shadowPolicy.cambiLimit) - Number(_shadowPolicy.cambiMargin)) -
                            Number(_assessment.predicted.cambiRisk) : null,
                };
                var _shadowFallbackReasons = _shadowPolicyResult.reasons.slice();
                if (!_assessment.eligible && Array.isArray(_assessment.reasons)) {
                    _shadowFallbackReasons = _shadowFallbackReasons.concat(_assessment.reasons);
                }
                if (!_shadowPredictedSafe && _shadowFallbackReasons.length === 0) {
                    _shadowFallbackReasons.push('confidence_adjusted_policy_not_safe');
                }
                var _shadowJobId = args.variables.vmafCanonicalJobId ||
                    args.variables.vmafJobId || args.variables.vmafRunId || null;
                var _shadowDecisionId = [
                    _shadowJobId || 'unknown-job', metricContract.metricContractId,
                    referenceContract.id, _plan.previousId, _plan.currentId,
                    getVmafSubsampleInt(args), _shadowPolicy.policyId,
                ].join('|');
                var _shadowRecord = {
                    schema: pairedShadow.SCHEMA_VERSION,
                    metricMode: pairedShadow.METRIC_MODE,
                    timestamp: new Date().toISOString(),
                    jobId: _shadowJobId,
                    decisionId: _shadowDecisionId,
                    title: args.variables.vmafSeriesTitle || null,
                    tier: _shadowTier,
                    isHDR: _shadowHdr,
                    measurementIdentity: {
                        metricContractId: metricContract.metricContractId,
                        referenceContractId: referenceContract.id,
                        encoderProfileId: metricContract.encoderProfileId + '|' + _shadowEncoderIdentity,
                        measurementSubsample: Number(_current && _current.measurementSubsample) || getVmafSubsampleInt(args),
                        policyId: _shadowPolicy.policyId,
                        inferenceAuthorityContractId: metricContract.inferenceAuthorityContractId || null,
                    },
                    effectivePolicy: {
                        selectorPolicyVersion: args.variables.vmafSelectorPolicyVersion || 'selector-authoritative-v2',
                        targetVmaf: _shadowPolicy.targetVmaf,
                        adaptiveFrameFloor: _shadowPolicy.vmafP1Floor,
                        cambiLimit: _shadowPolicy.cambiLimit,
                        harmonicMargin: _shadowPolicy.harmonicMargin,
                        p1Margin: _shadowPolicy.p1Margin,
                        cambiMargin: _shadowPolicy.cambiMargin,
                        vmafScoreMax: _shadowPolicy.vmafScoreMax,
                        version: pairedShadow.METRIC_MODE
                    },
                    previousParameterSetId: _plan.previousId,
                    currentParameterSetId: _plan.currentId,
                    assessment: _assessment,
                    measuredClipCount: _current && Number(_current.sampleCount) || 0,
                    inferredClipCount: 0,
                    estimatedAvoidableMetricSec: _assessment.eligible && _perScoreSec !== null
                        ? _assessment.potentiallyAvoidableScores * _perScoreSec : null,
                    estimatedMetricSecondsSaved: _assessment.eligible && _perScoreSec !== null
                        ? _assessment.potentiallyAvoidableScores * _perScoreSec : null,
                    realizedMetricSecondsSaved: 0,
                    decision: {
                        action: _shadowPredictedSafe ? 'predicted_safe' : 'fallback_full',
                        reasons: _shadowPredictedSafe ? [] : _shadowFallbackReasons,
                    },
                    conservativeCiMargins: _shadowConservativeMargins,
                    holdoutOutcome: {
                        directlyMeasured: true,
                        passed: Boolean(_assessment.actual && _assessment.actual.passed === true),
                        parameterSetId: _plan.currentId,
                        sampleCount: _current && Number(_current.sampleCount) || 0,
                    },
                    measurementCounts: {
                        measuredClipCount: _current && Number(_current.sampleCount) || 0,
                        inferredClipCount: 0,
                    },
                    falseSafe: Boolean(_assessment.falseSafe),
                    eligibleForPromotion: Boolean(_shadowPredictedSafe && _shadowPolicyResult.eligible &&
                        _assessment.matchedClips >= 8 && metricContract.inferenceAuthorityContractId &&
                        _shadowJobId && isFinite(Number(_shadowConservativeMargins.harmonic)) &&
                        isFinite(Number(_shadowConservativeMargins.p1)) &&
                        isFinite(Number(_shadowConservativeMargins.cambi))),
                    action: 'shadow_only_full_metrics_authoritative',
                    forceFullCounterfactual: true,
                };
                fs.appendFileSync(pairedShadow.TELEMETRY_PATH, JSON.stringify(_shadowRecord) + '\n', 'utf8');
                args.variables.vmafPairedCqShadowOutcome = _shadowRecord;
                args.jobLog('Paired-CQ shadow result: ' + (_assessment.eligible
                    ? ('predictedSafe=' + _assessment.predicted.safe + ', actualPass=' + _assessment.actual.passed +
                        ', falseSafe=' + _assessment.falseSafe + ', matched=' + _assessment.matchedClips +
                        ', potentially avoidable scores=' + _assessment.potentiallyAvoidableScores)
                    : ('ineligible: ' + _assessment.reasons.join(','))));
            }
        } catch (_pairedShadowError) {
            args.jobLog('Paired-CQ shadow evaluation failed (non-fatal, full metrics retained): ' + _pairedShadowError.message);
        }
    }

    args.jobLog('');
    args.jobLog('=== VMAF Calculation Complete ===');
    args.jobLog('Processed: ' + successfulCalculations + '/' + totalAttempts + ' samples');
    args.jobLog('Parameter sets: ' + aggregatedResults.length);
    args.jobLog('GPU VMAF available: ' + (hasGpuVmaf ? 'Yes' : 'No'));
    args.jobLog('GPU VMAF actually used: ' + (gpuVmafActuallyUsed ? 'Yes' : 'No'));
    args.jobLog('CPU VMAF-v1 ' + (cpuV1ProductionEnabled ? 'production' :
        (cpuV1QualificationEnabled ? 'qualification' : 'disabled')) +
        ' runtime actually used: ' + (cpuV1ActuallyUsed ? 'Yes' : 'No'));

    if (args.updateWorker) {
        args.updateWorker({ percentage: 100 });
    }

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
exports._test = {
    getSsimMode: getSsimMode,
    isFirstVmafRound: isFirstVmafRound,
    shouldRunSsim: shouldRunSsim,
    checkGpuVmafSupport: checkGpuVmafSupport,
    resolveGpuVmafSupport: resolveGpuVmafSupport,
    splitPrecomputedVmafResults: splitPrecomputedVmafResults,
    calculateSingleVmafGpuAsync: calculateSingleVmafGpuAsync,
    calculateSingleVmafV1CpuAsync: calculateSingleVmafV1CpuAsync,
    resolveCpuV1QualificationEnabled: resolveCpuV1QualificationEnabled,
    resolveCpuV1ProductionEnabled: resolveCpuV1ProductionEnabled,
    resolveCpuV1ProvisionalHdrAuthorized: resolveCpuV1ProvisionalHdrAuthorized,
    resolveCpuV1ExecutionPolicy: resolveCpuV1ExecutionPolicy,
    releaseGpuLockForCpuScoring: releaseGpuLockForCpuScoring,
    isCpuV1GeometryError: isCpuV1GeometryError,
    cpuV1Capability: cpuV1Capability,
    maxParallelCpuV1: maxParallelCpuV1,
    cpuV1ThreadsPerScore: cpuV1ThreadsPerScore,
    parseFrameRate: parseFrameRate,
    findVmafModel: findVmafModel,
    parseXpsnrStderr: parseXpsnrStderr,
    buildGpuVmafCommand: buildGpuVmafCommand,
    buildEncodeTimeTotals: buildEncodeTimeTotals,
    persistCurrentContractMeasurements: persistCurrentContractMeasurements,
    resolvePairedCqActingEnabled: resolvePairedCqActingEnabled,
    resolvePairedCqActingPolicy: resolvePairedCqActingPolicy,
    publishMeasuredAndInferredAggregates: publishMeasuredAndInferredAggregates,
    finishInferredAggregate: finishInferredAggregate,
    accumulateTimingSeconds: accumulateTimingSeconds,
};
