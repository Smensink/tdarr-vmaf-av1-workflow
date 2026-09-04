"use strict";

Object.defineProperty(exports, "__esModule", { value: true });

exports.plugin = exports.details = void 0;

var nvencTemporalFilter = require('../../_lib/nvencTemporalFilter.js');
var canonicalDenoise = require('../../_lib/canonicalDenoise.js');
var grainVmafContract = require('../../_lib/grainVmafContract.js');
var vmafMetricContract = require('../../_lib/vmafMetricContract.js');
var vmafV1Cpu = require('../../_lib/vmafV1Cpu.js');
var preFgsCambi = require('../../_lib/preFgsCambi.js');
var deliveryPolicy = require('../../_lib/deliveryPolicy.js');
var adaptiveFrameFloorLib = require('../../_lib/adaptiveFrameFloor.js');
var pixelFormatContract = require('../../_lib/pixelFormatContract.js');

function buildOriginalSourceSampleSizeMap(variables, fsModule) {
    variables = variables || {};
    var paths = Array.isArray(variables.vmafOriginalSourceSamples)
        ? variables.vmafOriginalSourceSamples : [];
    var sizeMap = {};
    for (var index = 0; index < paths.length; index++) {
        var samplePath = String(paths[index] || '').trim();
        if (!samplePath) continue;
        try {
            var bytes = Number(fsModule.statSync(samplePath).size);
            if (isFinite(bytes) && bytes > 0) sizeMap[index] = bytes / (1024 * 1024);
        } catch (_) {}
    }
    return sizeMap;
}

function estimateCandidateSizeMetrics(candidate, policy) {
    var sampleMB = Number(candidate.avgFileSizeMB || 0);

    // Prefer the AV1/original-source byte ratio for the same clip indices. On the
    // canonical-denoise path, candidate.originalSamplePath points at a lossless FFV1
    // reference and can be more than ten times larger than the source clip. It is a
    // quality reference, never a compression denominator. The extractor's dedicated
    // vmafOriginalSourceSamples array is the only accepted source-size authority.
    var projectedMB = 0;
    try {
        var originalMap = policy.originalSampleMBByIndex || null;
        if (originalMap && sampleMB > 0 && policy.sourceSizeMB > 0) {
            var matchedIndices = (candidate.clipSampleIndices || []).filter(function (value) {
                return originalMap[value] != null;
            });
            var originalSum = 0;
            var originalCount = 0;
            if (matchedIndices.length > 0) {
                for (var index = 0; index < matchedIndices.length; index++) {
                    originalSum += originalMap[matchedIndices[index]];
                    originalCount++;
                }
            } else {
                // Unaligned fallback for revived rows: use all authenticated source clips.
                // Hardness-first sampling makes this conservative rather than permissive.
                for (var key in originalMap) {
                    originalSum += originalMap[key];
                    originalCount++;
                }
            }
            if (originalCount > 0 && originalSum > 0) {
                projectedMB = (sampleMB / (originalSum / originalCount)) * policy.sourceSizeMB;
            }
        }
    } catch (_) { projectedMB = 0; }

    // If the authenticated source clips are unavailable, extrapolate the encoded
    // bytes over their configured duration. This is conservative for hardness-first
    // sampling and cannot accidentally use a lossless reference as source evidence.
    if (!(projectedMB > 0)) {
        projectedMB = (policy.duration > 0 && policy.sampleDuration > 0)
            ? sampleMB * (policy.duration / policy.sampleDuration) : 0;
    }

    var outputMbps = projectedMB > 0 && policy.duration > 0
        ? projectedMB * 1024 * 1024 * 8 / policy.duration / 1000000 : 0;
    var outputBpp = outputMbps > 0 && policy.width > 0 && policy.height > 0 && policy.fps > 0
        ? outputMbps * 1000000 / (policy.width * policy.height * policy.fps) : 0;
    var projectedRatioPct = projectedMB > 0 && policy.sourceSizeMB > 0
        ? projectedMB / policy.sourceSizeMB * 100 : 0;
    return {
        projectedMB: projectedMB,
        outputMbps: outputMbps,
        outputBpp: outputBpp,
        projectedRatioPct: projectedRatioPct,
    };
}

function decoderForEncoder(encoder) {
    var value = String(encoder || '').toLowerCase();
    if (value.indexOf('hevc') !== -1 || value.indexOf('h265') !== -1) return 'hevc_cuvid';
    if (value.indexOf('av1') !== -1) return 'av1_cuvid';
    return null;
}

function buildHoldoutVmafArgs(options) {
    options = options || {};
    var modelParam = options.modelPath ? ':model=path=' + options.modelPath : '';
    var filterComplex = '[0:v]settb=1/1000,setpts=N' + (options.tonemap || '') +
        ',format=' + options.scoringPixelFormat +
        ',hwupload[dis];[1:v]settb=1/1000,setpts=N' + (options.tonemap || '') +
        ',format=' + options.scoringPixelFormat +
        ',hwupload[ref];[dis][ref]' + options.filterName +
        '=log_path=' + options.logPath + ':log_fmt=json' + modelParam +
        ':shortest=1:repeatlast=0:ts_sync_mode=nearest';
    var argv = [
        '-hide_banner', '-y',
        '-init_hw_device', 'cuda=cuda0:0',
        '-filter_hw_device', 'cuda0',
        '-hwaccel', 'cuda',
        '-hwaccel_device', '0',
    ];
    var distortedDecoder = options.distortedDecoder || decoderForEncoder(options.encoder);
    if (distortedDecoder) argv.push('-c:v', String(distortedDecoder));
    argv.push('-i', String(options.distortedPath));
    if (options.referenceCuvid) {
        argv.push('-hwaccel', 'cuda', '-hwaccel_device', '0',
            '-c:v', String(options.referenceCuvid));
    }
    argv.push(
        '-i', String(options.referencePath),
        '-filter_complex', filterComplex,
        '-f', 'null', '-'
    );
    return argv;
}

function buildXpsnrArgs(distortedPath, referencePath, encoder) {
    var argv = [
        '-hide_banner',
        '-hwaccel', 'nvdec',
        '-hwaccel_device', '0',
    ];
    var decoder = decoderForEncoder(encoder);
    if (decoder) argv.push('-c:v', decoder);
    return argv.concat([
        '-i', String(distortedPath),
        '-i', String(referencePath),
        '-filter_complex',
        '[0:v]settb=1/1000,setpts=N[d];[1:v]settb=1/1000,setpts=N[r];[d][r]xpsnr',
        '-f', 'null', '-',
    ]);
}

function resolveMeasuredSweepContract(args, policy) {
    var variables = args.variables || {};
    var options = {
        attestedEncoderProfileId: variables.vmafReferenceComparisonEncoderProfileId ||
            variables.vmafEncoderProfileId,
    };
    // CPU-v1 binds coded geometry, SAR/DAR and the normalization decision into
    // the measurement identity and never infers them. Forward the authenticated
    // ffprobe stream so the selector resolves the same identity calculateVMAF
    // measured under; an explicit caller-supplied ratio still wins. Missing
    // SAR/DAR must fail closed here rather than be silently normalized.
    var cpuInput = {
        width: policy.width,
        height: policy.height,
        frameRate: policy.fps,
        isHdr: policy.isHDR === true,
        scoringBitDepth: 10,
        ffProbeData: policy.ffProbeData ||
            (args.inputFileObj && args.inputFileObj.ffProbeData) || undefined,
        sampleAspectRatio: policy.sampleAspectRatio,
        displayAspectRatio: policy.displayAspectRatio,
        geometryNormalization: policy.geometryNormalization || 'none',
    };
    if (variables.vmafCpuV1ProductionActive === true) {
        return vmafMetricContract.resolveCpuV1Production(cpuInput, options);
    }
    if (variables.vmafCpuV1QualificationActive === true) {
        return vmafMetricContract.resolveCpuV1Candidate(cpuInput, options);
    }
    return vmafMetricContract.resolveProductionForVideo(policy.width, policy.height, options);
}

function cpuV1ScorerGeometryFromContract(contract) {
    if (!contract || contract.backend !== 'cpu') {
        throw new Error('CPU-v1 scorer geometry requires an exact CPU metric contract');
    }
    var width = Number(contract.sourceWidth);
    var height = Number(contract.sourceHeight);
    var sampleAspectRatio = String(contract.sourceSampleAspectRatio || '').trim();
    var displayAspectRatio = String(contract.sourceDisplayAspectRatio || '').trim();
    var geometryNormalization = String(contract.geometryNormalization || '').trim();
    var validated;
    try {
        validated = vmafV1Cpu.validateGeometry({
            width: width,
            height: height,
            sampleAspectRatio: sampleAspectRatio,
            displayAspectRatio: displayAspectRatio,
            geometryNormalization: geometryNormalization,
        });
        var selectedModel = vmafV1Cpu.selectModel({
            width: validated.width,
            height: validated.height,
            modelProfile: vmafV1Cpu.profileForModelVersion(contract.modelVersion),
        });
        if (selectedModel.version !== contract.modelVersion ||
                selectedModel.resolutionClass !== validated.resolutionClass) {
            throw new Error('CPU-v1 model does not match the authenticated geometry family');
        }
    } catch (error) {
        throw new Error('CPU-v1 scorer contract lacks supported, exact coded geometry/SAR/DAR identity: ' +
            error.message);
    }
    return {
        width: validated.width,
        height: validated.height,
        sampleAspectRatio: validated.sampleAspectRatio,
        displayAspectRatio: validated.displayAspectRatio,
        geometryNormalization: validated.geometryNormalization,
    };
}

function assertMeasuredSweepRuntime(contract, fsImpl) {
    fsImpl = fsImpl || require('fs');
    if (contract.backend !== 'cpu') {
        return vmafMetricContract.assertModelFile(contract, { fs: fsImpl });
    }
    if (contract.upstreamRevision !== vmafV1Cpu.REVISION ||
            contract.runtimePath !== vmafV1Cpu.WRAPPER_PATH ||
            contract.filterName !== 'standalone-vmaf' ||
            contract.scoringPixelFormat !== vmafV1Cpu.PIXEL_FORMAT ||
            contract.scoringBitDepth !== vmafV1Cpu.BIT_DEPTH ||
            contract.allowGpuFallback !== false) {
        throw new Error('CPU-v1 selector contract lacks the exact isolated runtime identity');
    }
    fsImpl.accessSync(vmafV1Cpu.WRAPPER_PATH, fsImpl.constants.X_OK);
    fsImpl.accessSync(vmafV1Cpu.SCORE_WRAPPER_PATH, fsImpl.constants.X_OK);
    return { ok: true, reason: 'isolated-cpu-v1-runtime-verified' };
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
        if (v.indexOf('bt2020-10') !== -1) return 14;
        if (v.indexOf('bt2020-12') !== -1) return 15;
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

function buildHoldoutEncodeArgs(options) {
    options = options || {};
    var encoder = String(options.encoder || 'av1_nvenc');
    var isAv1Nvenc = encoder.indexOf('av1_nvenc') !== -1;
    var isHevcNvenc = encoder.indexOf('hevc_nvenc') !== -1;
    var isNvenc = encoder.indexOf('_nvenc') !== -1;
    var canonicalInput = options.canonicalInput === true;
    var temporalPolicy = options.temporalPolicy || (canonicalInput
        ? nvencTemporalFilter.CANONICAL_POLICY : nvencTemporalFilter.LEGACY_POLICY);
    if (canonicalInput && temporalPolicy !== nvencTemporalFilter.CANONICAL_POLICY) {
        throw new Error('canonical VMAF holdout requires the canonical tf0 policy');
    }
    var argv = ['-hide_banner', '-y'];
    if (!canonicalInput && isNvenc) argv.push('-hwaccel', 'cuda');
    argv.push('-i', String(options.inputPath), '-c:v', encoder);
    if (isNvenc) {
        argv.push('-pix_fmt', String(options.pixFmt || 'p010le'), '-rc', 'vbr',
            '-cq', String(options.cq), '-b:v', '0', '-preset', String(options.preset || 'p7'));
        nvencTemporalFilter.appendValidatedQualityFlags(argv,
            options.nvencFlagArgs || nvencTemporalFilter.qualityFlags(temporalPolicy, false),
            temporalPolicy,
            'VMAF holdout encode');
        if (isHevcNvenc) argv.push('-profile:v', 'main10');
        argv.push('-g', '96', '-forced-idr', '1');
        argv.push('-color_primaries', String(options.colorPrimaries || 'bt709'),
            '-color_trc', String(options.colorTrc || 'bt709'),
            '-colorspace', String(options.colorspace || 'bt709'));
        if (isAv1Nvenc) {
            var av1Meta = av1ColorMetadataArgs(options.colorPrimaries, options.colorTrc, options.colorspace);
            argv.push('-bsf:v', av1Meta.bsf);
        }
        argv.push('-max_muxing_queue_size', '4096');
    }
    argv.push('-an', '-sn', '-dn', String(options.outputPath));
    nvencTemporalFilter.assertNvencCommand(argv, temporalPolicy, 'VMAF holdout encode');
    canonicalDenoise.assertAbsent(argv, 'VMAF holdout encode from canonical denoised FFV1 sample');
    return argv;
}

function finiteMeasuredNumber(value) {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
    var number = Number(value);
    return isFinite(number) ? number : null;
}

function cpuV1ThreadsPerScore(args) {
    var value = Number(args && args.inputs && args.inputs.cpuV1ThreadsPerScore);
    if (!isFinite(value) || value < 1) value = 2;
    return Math.max(1, Math.min(4, Math.floor(value)));
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

function measureHoldoutPreFgsCambi(args, distortedPath, referencePath,
        cacheDir, modelPath, metricContract, safeId, timingVariableName) {
    var fs = require('fs');
    var execFileSync = require('child_process').execFileSync;
    var logPath = cacheDir + '/holdout_prefgs_cambi_' + safeId + '_' +
        process.pid + '_' + Date.now() + '.json';
    var argv = preFgsCambi.buildArgs({
        distortedPath: distortedPath,
        referencePath: referencePath,
        logPath: logPath,
        modelPath: modelPath,
        pixelFormat: metricContract.cambi.scoringPixelFormat,
        nSubsample: 1,
        threads: Math.max(1, Math.min(16,
            Number(args.inputs && args.inputs.maxParallelVmaf) || 4)),
    });
    try {
        var startedAt = Date.now();
        try {
            execFileSync(args.ffmpegPath, argv, {
                stdio: 'pipe', timeout: 300000, windowsHide: true,
                maxBuffer: 32 * 1024 * 1024,
            });
        } finally {
            accumulateTimingSeconds(args.variables, timingVariableName,
                (Date.now() - startedAt) / 1000);
        }
        return preFgsCambi.parseLogFile(logPath, fs);
    } finally {
        try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch (_) {}
    }
}

function validateHoldoutMetrics(holdoutData, frameFloor, options) {
    options = options || {};
    if (!holdoutData) return { ok: false, reason: 'no holdout data', metrics: null };
    var metrics = {
        avgVMAF: finiteMeasuredNumber(holdoutData.avgVMAF),
        p1: finiteMeasuredNumber(holdoutData.vmafP1),
        minVMAF: finiteMeasuredNumber(holdoutData.minVMAF),
        cambiMean: finiteMeasuredNumber(holdoutData.cambiMean),
        cambiP95: finiteMeasuredNumber(holdoutData.cambiP95),
    };
    if (metrics.p1 === null) metrics.p1 = metrics.minVMAF;
    var missing = [];
    if (metrics.avgVMAF === null) missing.push('avgVMAF');
    if (Number(frameFloor) > 0 && metrics.p1 === null) missing.push('vmafP1/minVMAF');
    if (options.requireCambi === true && metrics.cambiMean === null) missing.push('cambiMean');
    if (options.requireCambi === true && metrics.cambiP95 === null) missing.push('cambiP95');
    return {
        ok: missing.length === 0,
        reason: missing.length ? 'missing/non-finite mandatory metrics: ' + missing.join(', ') : null,
        metrics: metrics,
    };
}

function setParameterSetCQ(parameterSet, cq) {
    var value = finiteMeasuredNumber(cq);
    if (!parameterSet || value === null) throw new Error('cannot set a non-finite parameter CQ');
    parameterSet.quality = value;
    if (parameterSet.cq !== null && parameterSet.cq !== undefined) parameterSet.cq = value;
    return parameterSet;
}

function measuredCandidateCQ(result) {
    return finiteMeasuredNumber(result && result.parameterSet && result.parameterSet.quality);
}

function measuredFrameFloor(result) {
    var p1 = finiteMeasuredNumber(result && result.vmafP1Low);
    return p1 !== null ? p1 : finiteMeasuredNumber(result && result.minVMAF);
}

function measuredCambiRisk(result) {
    var values = [result && result.avgCAMBI, result && result.p95CAMBI]
        .map(finiteMeasuredNumber).filter(function (value) { return value !== null; });
    return values.length ? Math.max.apply(null, values) : null;
}

function measuredCandidateId(result) {
    return String((result && result.parameterSetId) || '').trim();
}

function validateFinalSelection(bestParams) {
    if (!bestParams || !bestParams.parameterSet) {
        throw new Error('cannot validate an incomplete VMAF selection');
    }
    var cq = finiteMeasuredNumber(bestParams.parameterSet.quality);
    var parameterSetId = String(bestParams.parameterSet.id || bestParams.parameterSetId || '').trim();
    if (cq === null || !parameterSetId) {
        throw new Error('cannot validate VMAF selection without a finite CQ and parameter-set ID');
    }
    return { cq: cq, parameterSetId: parameterSetId };
}

function publishFinalSelection(variables, bestParams, validatedSelection) {
    if (!variables) throw new Error('cannot publish VMAF selection without a variables object');
    var selection = validatedSelection || validateFinalSelection(bestParams);
    variables.vmafBestParameters = bestParams.parameterSet;
    variables.vmafFinalSelectedCQ = selection.cq;
    variables.vmafSelectedParameterSetId = selection.parameterSetId;
    variables.vmafSelectionHandoff = {
        schema: 'vmaf-selection-handoff/v1',
        selectedCQ: selection.cq,
        parameterSetId: selection.parameterSetId,
        parameterSet: Object.assign({}, bestParams.parameterSet),
        publishedAt: new Date().toISOString()
    };
    variables.vmafSelectionStatus = 'selected';
    return selection;
}

function publishEncoderDomainBridge(variables, parameterSet, measuredPixFmt,
        recommendedPixFmt, selectedCQ) {
    if (!variables) throw new Error('cannot publish encoder-domain bridge without variables');
    if (String(parameterSet && parameterSet.encoder || '').toLowerCase().indexOf('av1') === -1) {
        delete variables.vmafEncoderDomainBridge;
        return null;
    }
    var measuredDepth = pixelFormatContract.outputDepthForPixelFormat(measuredPixFmt);
    var deliveryDepth = pixelFormatContract.outputDepthForPixelFormat(recommendedPixFmt);
    if (measuredDepth !== deliveryDepth) {
        throw new Error('cannot publish encoder-domain bridge across different bit depths');
    }
    var bridge = pixelFormatContract.av1EncoderDomainBridge();
    bridge.measurement_pixel_format = String(measuredPixFmt).toLowerCase();
    bridge.delivery_pixel_format = String(recommendedPixFmt).toLowerCase();
    bridge.measurement_cq = Number(selectedCQ);
    bridge.delivery_cq = Number(selectedCQ);
    variables.vmafEncoderDomainBridge = bridge;
    variables.vmafPixelFormatContractId = pixelFormatContract.CONTRACT_ID;
    return bridge;
}

function markConstraintAwareHoldoutTechnicalFailure(variables, preSelectParams, error) {
    if (!variables || !preSelectParams || !preSelectParams.parameterSet) return null;
    var measuredCQ = finiteMeasuredNumber(preSelectParams.parameterSet.quality);
    if (measuredCQ === null) return null;
    var message = error && error.message ? error.message : String(error || 'unknown holdout error');
    variables.vmafConstraintAwareCQApplied = false;
    variables.vmafConstraintAwareCQReverted = true;
    variables.vmafConstraintAwareCQValidated = false;
    variables.vmafMaxCompressionApplied = false;
    variables.vmafHoldoutTechnicalFailure = message;
    variables.vmafHoldoutFailReason = 'constraint_aware_holdout_technical_error';
    variables.vmafHoldoutSuggestedCQ = measuredCQ;
    return { bestParams: preSelectParams, cq: measuredCQ, message: message };
}

function revertPredictionOnlyFractionalSelection(variables, bestParams, measuredParams) {
    if (!bestParams || bestParams.vmafInterpolated !== true) {
        return { bestParams: bestParams, reverted: false, cq: measuredCandidateCQ(bestParams) };
    }
    var measuredCQ = measuredCandidateCQ(measuredParams);
    if (measuredCQ === null) {
        throw new Error('prediction-only fractional CQ has no measured fallback');
    }
    variables.vmafInterpolatedCQRejected = variables.vmafInterpolatedCQ;
    variables.vmafInterpolatedCQ = null;
    variables.vmafInterpolatedCQReverted = true;
    return { bestParams: measuredParams, reverted: true, cq: measuredCQ };
}

function classifyToleranceRejection(reason) {
    var text = String(reason || '').toLowerCase();
    if (/missing mandatory metrics|incomplete|non-finite|technical|encode fail|corrupt|integrity/.test(text)) {
        return 'technical';
    }
    if (/projected output too small|configured quality-risk size floor|below.*(?:ratio|bpp|mbps).*floor/.test(text)) {
        return 'lower_plausibility';
    }
    if (/emergency cutoff|legacy cap|insufficient size benefit|projectedoutputratiopct.*at or above/.test(text)) {
        return 'oversize';
    }
    // A CAMBI fallback is permitted only when CAMBI/banding is the sole quality miss.
    // Shared-feasibility reasons are compound strings, so classify every binding image
    // quality metric before looking for CAMBI. Otherwise a reason such as
    // "cambiRisk ...; ssimulacra2 ..." is mislabeled cambi_only and resurrected.
    if (/vmaf|frame|ssim|xpsnr|ssimulacra|butteraugli|cvvdp|quality/.test(text)) return 'quality';
    if (/cambi|banding/.test(text)) return 'cambi';
    return 'other_tolerance';
}

function isTechnicallyMeasuredCandidate(result, frameFloor) {
    if (!result || !result.parameterSet || measuredCandidateCQ(result) === null) return false;
    var resultId = measuredCandidateId(result);
    var parameterSetId = String(result.parameterSet.id || '').trim();
    if (!resultId || !parameterSetId || resultId !== parameterSetId) return false;
    if (finiteMeasuredNumber(result.avgVMAF) === null
        || finiteMeasuredNumber(result.avgVMAFMean) === null
        || finiteMeasuredNumber(result.avgFileSizeMB) === null
        || Number(result.avgFileSizeMB) <= 0) return false;
    if (finiteMeasuredNumber(result.sampleCount) === null || Number(result.sampleCount) <= 0) return false;
    if (Number(frameFloor) > 0 && finiteMeasuredNumber(result.vmafP1Low) === null) return false;
    return true;
}

function measuredQualityPasses(result, targetVmaf, frameFloor) {
    var harmonic = finiteMeasuredNumber(result && result.avgVMAF);
    var floor = measuredFrameFloor(result);
    return harmonic !== null && harmonic >= Number(targetVmaf)
        && (!(Number(frameFloor) > 0) || (floor !== null && floor >= Number(frameFloor)));
}

/*
 * Select a measured CQ when policy/model tolerances cannot be satisfied. The
 * caller only invokes the general quality fallback after the retry search is
 * exhausted. CAMBI-only misses may be resolved immediately because the source
 * itself can exceed the prescribed CAMBI tolerance. Upper-size misses are not
 * advisory: a candidate rejected by the emergency cutoff can never be promoted
 * here. Missing/incomplete measurements are deliberately excluded: this is
 * never a technical-failure bypass.
 */
function chooseMeasuredToleranceFallback(results, options) {
    options = options || {};
    var targetVmaf = Number(options.targetVmaf);
    var frameFloor = Number(options.frameFloor) || 0;
    var rejected = options.rejectedResults || [];
    var rejectionById = {};
    for (var ri = 0; ri < rejected.length; ri++) {
        var entry = rejected[ri] || {};
        var rejectionId = String(entry.id || '').trim();
        if (!rejectionId) continue;
        var rejectionCategory = entry.category || classifyToleranceRejection(entry.reason);
        if (!rejectionById[rejectionId]) {
            rejectionById[rejectionId] = { reasons: [], categories: [], hasTechnical: false };
        }
        var rejectionState = rejectionById[rejectionId];
        rejectionState.reasons.push(String(entry.reason || ''));
        if (rejectionState.categories.indexOf(rejectionCategory) === -1) {
            rejectionState.categories.push(rejectionCategory);
        }
        if (rejectionCategory === 'technical') rejectionState.hasTechnical = true;
    }
    Object.keys(rejectionById).forEach(function (id) {
        var state = rejectionById[id];
        state.reason = state.reasons.join('; ');
        state.category = state.categories.length === 1 ? state.categories[0] : 'mixed_tolerance';
    });

    var candidates = (results || []).filter(function (result) {
        if (!isTechnicallyMeasuredCandidate(result, frameFloor)) return false;
        var rejection = rejectionById[measuredCandidateId(result)];
        // This helper only runs after the normal selector found zero valid results.
        // Promotion therefore requires the exact rejection record that explains why
        // this measured result was excluded; absent/mismatched provenance fails closed.
        return !!rejection && rejection.hasTechnical !== true;
    });
    if (!candidates.length) return null;

    function rejectionFor(result) {
        return rejectionById[measuredCandidateId(result)];
    }
    function qualityPassingPool() {
        return candidates.filter(function (result) {
            return measuredQualityPasses(result, targetVmaf, frameFloor);
        });
    }
    function allRejectedAs(pool, category) {
        return pool.length > 0 && pool.every(function (result) {
            return rejectionFor(result).category === category;
        });
    }
    function cqDesc(a, b) { return measuredCandidateCQ(b) - measuredCandidateCQ(a); }
    function vmafDesc(a, b) { return Number(b.avgVMAF) - Number(a.avgVMAF); }

    var qualityPassing = qualityPassingPool();
    if (allRejectedAs(qualityPassing, 'cambi')) {
        qualityPassing.sort(function (a, b) {
            var ar = measuredCambiRisk(a), br = measuredCambiRisk(b);
            if (ar === null) ar = Infinity;
            if (br === null) br = Infinity;
            return (ar - br) || cqDesc(a, b) || vmafDesc(a, b);
        });
        return { result: qualityPassing[0], mode: 'cambi_only', reason: rejectionFor(qualityPassing[0]).reason };
    }
    if (options.terminal !== true) return null;

    // A real VMAF/frame-floor miss is NOT a reason to encode anyway.
    //
    // This path used to sort by highest VMAF and commit the winner. Highest
    // VMAF is always the lowest CQ, i.e. the largest file, so on a terminal
    // quality miss the pipeline committed the single most expensive encode it
    // had measured — one that had just been rejected for missing the quality
    // limit. In a five-title incident this produced outputs at 103%-165% of
    // their sources, all at CQ 16 and still below the prescribed quality limit,
    // with each output replacing its original. One representative log showed:
    //   "Rejecting gpu_p7_cq16: vmafP1Low 78.12 below 86.00; cambiRisk 5.49
    //    above 5.00"  immediately followed by  "selecting measured CQ 16".
    //
    // Keeping the original is always available and beats that outcome on every
    // axis: smaller, no quality loss, nothing destroyed. Returning null leaves
    // validResults empty so the existing "No parameter sets met quality
    // thresholds" give-up path runs and the source is preserved.
    //
    // The exact post-encode and grain-vs-original gates remain downstream
    // backstops, while the final encoder also has a monotonic current-byte
    // guard. None of them justify launching an encode whose measured samples
    // have already crossed the selector's emergency cutoff.
    return null;
}

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

            tooltip: 'Fixed current delivered minimum: 10% compared with the original (90% output/source cap). Values other than 10 fail closed.',

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

        {

            label: 'Holdout Skip Shadow',

            name: 'holdoutSkipShadow',

            type: 'boolean',

            defaultValue: 'true',

            inputUI: { type: 'switch' },

            tooltip: 'Log whether a conservative margin rule would have skipped reserved holdout validation. Shadow only: the holdout always runs and remains authoritative.',

        },

        {

            label: 'CPU VMAF-v1 Threads Per Holdout Score',

            name: 'cpuV1ThreadsPerScore',

            type: 'number',

            defaultValue: '2',

            inputUI: { type: 'text' },

            tooltip: 'Worker threads for the authoritative CPU-v1 holdout score, independently clamped to 1-4.',

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

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = Number(value);
    return isFinite(number) ? number : null;
}

function shouldApplyFractionalOverride(predictedCq, measuredCq, holdoutAvailable) {
    var predicted = finiteNumber(predictedCq);
    var measured = finiteNumber(measuredCq);
    return predicted !== null && measured !== null && predicted > measured + 0.05
        && holdoutAvailable === true;
}

// The sweep clips are selected for compression difficulty, not sampled randomly from
// the title. This bound is therefore an uncertainty heuristic, not a population CI.
// It may require an independent holdout or more measurement, but must not silently
// override a candidate that passed every authoritative measured constraint.
function measuredCandidateUncertainty(candidate, targetVmaf) {
    var n = Math.max(1, Number(candidate && candidate.sampleCount) || 1);
    var sd = finiteNumber(candidate && candidate.vmafStdDev);
    if (sd === null || sd <= 0) sd = 0.8;
    var se = Math.max(0.3, sd / Math.sqrt(n));
    var harmonic = finiteNumber(candidate && candidate.avgVMAF);
    var lcb = harmonic === null ? null : harmonic - 1.28 * se;
    return {
        sampleCount: n,
        standardDeviation: sd,
        standardError: se,
        lcb: lcb,
        clearsTarget: lcb !== null && lcb >= Number(targetVmaf),
        role: 'diagnostic_require_independent_validation_when_uncertain',
    };
}

function rankMeasuredCandidatesByCompression(candidates) {
    return (candidates || []).filter(function(candidate) {
        return candidate.parameterSet &&
            isFinite(Number(candidate.parameterSet.quality));
    }).slice().sort(function(a, b) {
        return Number(b.parameterSet.quality) - Number(a.parameterSet.quality);
    });
}

function measuredConstraintBracket(aggregated, policy, evaluator) {
    var evaluate = evaluator || require('../../_lib/feasibility.js').evaluate;
    var strictPolicy = Object.assign({}, policy || {}, { requireAuxMetrics: true });
    var feasible = [];
    var infeasible = [];
    for (var i = 0; i < (aggregated || []).length; i++) {
        var row = aggregated[i];
        var cq = measuredCandidateCQ(row);
        if (cq === null) continue;
        var assessment = evaluate(row, strictPolicy);
        if (assessment && assessment.feasible === true &&
                !row.vmafLowerPlausibilityRejection &&
                !(row.sizeGateDecision && row.sizeGateDecision.action === 'reject')) {
            feasible.push(cq);
        } else {
            infeasible.push(cq);
        }
    }
    feasible.sort(function(a, b) { return a - b; });
    infeasible.sort(function(a, b) { return a - b; });
    var highestFeasible = feasible.length ? feasible[feasible.length - 1] : null;
    var firstRejectedAbove = null;
    if (highestFeasible !== null) {
        for (var j = 0; j < infeasible.length; j++) {
            if (infeasible[j] > highestFeasible) {
                firstRejectedAbove = infeasible[j];
                break;
            }
        }
    }
    return {
        highestFeasible: highestFeasible,
        firstRejectedAbove: firstRejectedAbove,
    };
}

// A VMAF/CAMBI-only holdout cannot authenticate SSIMULACRA2, Butteraugli, CVVDP,
// SSIM, or XPSNR. Therefore a harder CQ may only become authoritative when that exact
// CQ already has a complete measured row passing every enabled binding constraint.
// The damped secant loop normally creates that row; prediction remains telemetry.
function assessMeasuredBindingAuthority(aggregated, proposedCq, policy, evaluator) {
    var proposed = finiteNumber(proposedCq);
    if (proposed === null) return { allowed: false, reason: 'proposed CQ is non-finite' };
    var exact = null;
    for (var i = 0; i < (aggregated || []).length; i++) {
        var cq = measuredCandidateCQ(aggregated[i]);
        if (cq !== null && Math.abs(cq - proposed) < 0.0001) {
            exact = aggregated[i];
            break;
        }
    }
    if (!exact) {
        return { allowed: false, reason: 'exact CQ lacks a full measured binding-metric row' };
    }
    var strictPolicy = Object.assign({}, policy || {}, { requireAuxMetrics: true });
    var evaluate = evaluator || require('../../_lib/feasibility.js').evaluate;
    var assessment = evaluate(exact, strictPolicy);
    return {
        allowed: assessment && assessment.feasible === true,
        reason: assessment && assessment.reason ? assessment.reason : 'binding evaluation unavailable',
        evaluation: assessment || null,
    };
}

function assessHoldoutSkipShadow(candidate, policy) {
    candidate = candidate || {};
    policy = policy || {};
    // Shadow arithmetic must mirror the authoritative selector metric even
    // though it cannot currently skip a holdout: avgVMAF is the per-clip
    // harmonic aggregate; avgVMAFMean is diagnostic only.
    var mean = finiteNumber(candidate.avgVMAF);
    if (mean === null) mean = finiteNumber(candidate.avgVMAFMean);
    var p1 = finiteNumber(candidate.vmafP1Low);
    if (p1 === null) p1 = finiteNumber(candidate.minVMAF);
    var cambiMean = finiteNumber(candidate.avgCAMBI);
    var cambiP95 = finiteNumber(candidate.p95CAMBI);
    var cambiRisk = null;
    if (cambiMean !== null || cambiP95 !== null) {
        cambiRisk = Math.max(cambiMean !== null ? cambiMean : -Infinity,
            cambiP95 !== null ? cambiP95 : -Infinity);
    }
    var sampleCount = Math.max(0, Number(candidate.sampleCount) || 0);
    var meanFloor = finiteNumber(policy.meanFloor);
    var frameFloor = finiteNumber(policy.frameFloor);
    var cambiLimit = finiteNumber(policy.cambiLimit);
    var meanMargin = mean !== null && meanFloor !== null ? mean - meanFloor : null;
    var floorMargin = p1 !== null && frameFloor !== null && frameFloor > 0 ? p1 - frameFloor : null;
    var cambiMargin = cambiRisk !== null && cambiLimit !== null ? cambiLimit - cambiRisk : null;
    var reasons = [];
    if (policy.directlyMeasured !== true) reasons.push('not_directly_measured');
    if (sampleCount < 8) reasons.push('sample_count_below_8');
    if (meanMargin === null || meanMargin < 2.0) reasons.push('mean_margin_below_2');
    if (frameFloor !== null && frameFloor > 0 && (floorMargin === null || floorMargin < 3.0)) {
        reasons.push('floor_margin_below_3');
    }
    if (cambiMargin === null || cambiMargin < 1.0) reasons.push('cambi_margin_below_1');
    var highConfidenceReasons = [];
    if (policy.directlyMeasured !== true) highConfidenceReasons.push('not_directly_measured');
    if (sampleCount < 12) highConfidenceReasons.push('sample_count_below_12');
    if (meanMargin === null || meanMargin < 3.0) highConfidenceReasons.push('mean_margin_below_3');
    if (floorMargin === null || floorMargin < 0.25) highConfidenceReasons.push('floor_margin_below_0_25');
    if (cambiMargin === null || cambiMargin < 0.25) highConfidenceReasons.push('cambi_margin_below_0_25');
    var legacySafe = reasons.length === 0;
    var highConfidenceSafe = highConfidenceReasons.length === 0;
    var candidateV2Safe = legacySafe || highConfidenceSafe;
    var candidateV2Reasons = candidateV2Safe ? [] :
        ['legacy:' + reasons.join('|'), 'high_confidence:' + highConfidenceReasons.join('|')];
    return {
        predictedSafeToSkip: legacySafe,
        reasons: reasons,
        candidateVersion: 'loo_buffer_composite_v2',
        candidateV2Safe: candidateV2Safe,
        candidateV2Reasons: candidateV2Reasons,
        candidateV2LegacyBranch: legacySafe,
        candidateV2HighConfidenceBranch: highConfidenceSafe,
        directlyMeasured: policy.directlyMeasured === true,
        sampleCount: sampleCount,
        mean: mean,
        p1: p1,
        cambiRisk: cambiRisk,
        meanMargin: meanMargin,
        floorMargin: floorMargin,
        cambiMargin: cambiMargin,
    };
}

function appendHoldoutShadowRecord(args, record) {
    try {
        var fs = require('fs');
        fs.appendFileSync('/app/configs/vmaf_holdout_shadow.jsonl', JSON.stringify(record) + '\n', 'utf8');
    } catch (error) {
        if (args && args.jobLog) {
            args.jobLog('Holdout skip shadow write failed (non-fatal): ' +
                (error && error.message ? error.message : String(error)));
        }
    }
}

// ── Size-gate policy (projection and delivery limits separated) ──
// The legacy >=90% projected-ratio hard reject was never prospectively validated: every
// candidate it rejected was censored (no final-size label ever produced). The projection
// also has observed two-sided error, so a projection at the real-byte delivery boundary is
// not proof that the completed file will fail that boundary. Policy:
//   - projected >= emergencyRatioPct (default 110): hard reject. Even the worst observed
//     overprediction cannot bring a >=110% projection under the 90% benefit cap, so these
//     are all-risk-no-benefit encodes (e.g. Nino 2026-07-18: best quality-passing CQ
//     projected 120.8%).
//   - legacyRatioPct (default 90) <= projected < emergencyRatioPct: always allowed through
//     to the full transcode. The monotonic actual-byte guard remains authoritative. The
//     bounded reservation ledger controls label telemetry only; exhaustion or telemetry
//     failure must never turn this uncertain projection back into a hard rejection.
//   - below legacyRatioPct: unaffected.
function evaluateSizeGate(projectedRatioPct, options) {
    options = options || {};
    var legacy = Number(options.legacyRatioPct);
    if (!isFinite(legacy) || legacy <= 0) legacy = 90;
    var emergency = Number(options.emergencyRatioPct);
    if (!isFinite(emergency) || emergency <= legacy) emergency = Math.max(110, legacy);
    var remaining = Number(options.forcedFullRemaining);
    if (!isFinite(remaining) || remaining < 0) remaining = 0;
    var ratio = Number(projectedRatioPct);
    if (!isFinite(ratio) || ratio <= 0) {
        // No projection is available. This is common — estimateCandidateSizeMetrics
        // only runs for candidates that were not already rejected, and it yields 0
        // when the per-clip original-size map or the durations are missing, so a
        // large minority of jobs reach here. Hard-rejecting them would halt most of
        // the library, and there is genuinely no evidence to reject on.
        //
        // What must NOT happen is treating "no evidence" as "clear", which is how
        // this previously behaved: an identical shape to the 'clear' band, with
        // nothing recording that the size claim was never actually checked. The
        // band stays distinct and requiresActualSizeVerification marks the decision
        // as unproven, so the authoritative post-encode gate in
        // vmafOptimizedTranscode is the thing that has to clear it on real bytes.
        return {
            action: 'allow',
            band: 'unknown',
            forcedFull: false,
            legacyWouldReject: false,
            requiresActualSizeVerification: true,
        };
    }
    if (ratio >= emergency) {
        return { action: 'reject', band: 'emergency', forcedFull: false, legacyWouldReject: true };
    }
    if (ratio >= legacy) {
        return {
            action: 'allow',
            band: 'shadow',
            forcedFull: true,
            legacyWouldReject: true,
            labelBudgetAvailable: remaining > 0,
        };
    }
    return { action: 'allow', band: 'clear', forcedFull: false, legacyWouldReject: false };
}

var SIZE_GATE_FORCED_FULL_ROOT = '/app/configs/vmaf_size_gate_forced_full_reservations_v1';
var SIZE_GATE_FORCED_FULL_LOG = '/app/configs/vmaf_size_gate_forced_full.jsonl';
var SIZE_GATE_FORCED_FULL_SCHEMA = 1;
var SIZE_GATE_FORCED_FULL_ID_DOMAIN = 'tdarr-vmaf-size-gate-forced-full-v1\0';

function forcedFullFailure(code, error) {
    return {
        ok: false,
        code: code,
        error: error && error.message ? error.message : String(error || code),
    };
}

function normalizeForcedFullCap(value) {
    var cap = Number(value);
    if (!isFinite(cap) || cap < 0 || Math.floor(cap) !== cap || cap > 999999) {
        throw new Error('forced-full reservation cap must be an integer from 0 through 999999');
    }
    return cap;
}

function resolveForcedFullCap(value) {
    if (value === undefined || value === null) {
        return { ok: true, cap: 12, defaulted: true };
    }
    if ((typeof value === 'string' && !value.trim()) ||
        (typeof value !== 'string' && typeof value !== 'number')) {
        return forcedFullFailure('reservation_cap_invalid',
            'forced-full reservation cap must be an explicit integer');
    }
    try {
        return { ok: true, cap: normalizeForcedFullCap(value), defaulted: false };
    } catch (error) {
        return forcedFullFailure('reservation_cap_invalid', error);
    }
}

function resetForcedFullAttemptState(variables) {
    if (!variables || typeof variables !== 'object') {
        throw new Error('forced-full attempt reset requires a variables object');
    }
    variables.vmafSizeGateForcedFull = false;
    delete variables.vmafSizeGateForcedFullJobHash;
    delete variables.vmafSizeGateForcedFullReservationSlot;
    delete variables.vmafSizeGateForcedFullReservationStatus;
    delete variables.vmafSizeGateForcedFullReservationFailure;
    delete variables.vmafSizeGateForcedFullReservationError;
}

function forcedFullSlotName(slot) {
    return 'slot-' + String(slot).padStart(6, '0') + '.json';
}

function hashForcedFullJobIdentity(jobIdentity) {
    var normalized = String(jobIdentity === undefined || jobIdentity === null ? '' : jobIdentity).trim();
    if (!normalized) throw new Error('forced-full reservation requires a stable job identity');
    return require('crypto').createHash('sha256')
        .update(SIZE_GATE_FORCED_FULL_ID_DOMAIN, 'utf8')
        .update(normalized, 'utf8')
        .digest('hex');
}

function resolveForcedFullJobIdentityHash(args) {
    var variables = args && args.variables ? args.variables : {};
    // vmafCanonicalJobId/vmafJobId is seeded once by extractVideoSamples and is
    // deliberately retained by monitorTranscodeRetry. vmafRunId and a file path
    // are not acceptable fallbacks: the former can change on retry, while the
    // latter would let a later, unrelated job reuse an old cohort reservation.
    var identity = variables.vmafCanonicalJobId || variables.vmafJobId;
    return hashForcedFullJobIdentity(identity);
}

function isPrivateMode(stat) {
    // Windows does not expose POSIX ownership bits usefully. The production
    // runtime is Linux, where group/other permissions on this private ledger
    // are rejected rather than silently accepted.
    return process.platform === 'win32' || ((Number(stat.mode) & 0o077) === 0);
}

function inspectForcedFullReservations(options) {
    options = options || {};
    var fs = options.fs || require('fs');
    var path = options.path || require('path');
    var rootPath = String(options.rootPath || SIZE_GATE_FORCED_FULL_ROOT);
    var identityHash = options.jobIdentityHash
        ? String(options.jobIdentityHash).toLowerCase() : null;
    var cap;
    try {
        cap = normalizeForcedFullCap(options.cap);
        if (identityHash && !/^[a-f0-9]{64}$/.test(identityHash)) {
            throw new Error('forced-full reservation job hash is invalid');
        }
        var rootStat;
        try {
            rootStat = fs.lstatSync(rootPath);
        } catch (rootError) {
            if (rootError && rootError.code === 'ENOENT') {
                return {
                    ok: true,
                    rootExists: false,
                    used: 0,
                    ownedSlot: null,
                    firstFreeSlot: cap > 0 ? 1 : null,
                };
            }
            throw rootError;
        }
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
            throw new Error('forced-full reservation root is not a real directory');
        }
        if (!isPrivateMode(rootStat)) {
            throw new Error('forced-full reservation root is not private (mode must deny group/other access)');
        }

        var entries = fs.readdirSync(rootPath);
        var slots = {};
        var identities = {};
        var ownedSlot = null;
        for (var entryIndex = 0; entryIndex < entries.length; entryIndex++) {
            var entry = String(entries[entryIndex]);
            if (entry === '.pending') {
                var pendingStat = fs.lstatSync(path.join(rootPath, entry));
                if (!pendingStat.isDirectory() || pendingStat.isSymbolicLink() || !isPrivateMode(pendingStat)) {
                    throw new Error('forced-full reservation pending directory is invalid');
                }
                continue;
            }
            var match = /^slot-(\d{6})\.json$/.exec(entry);
            if (!match) {
                throw new Error('unexpected entry in forced-full reservation root: ' + entry);
            }
            var slot = Number(match[1]);
            if (slot < 1 || slot > cap || slots[slot]) {
                throw new Error('forced-full reservation slot is outside the configured hard cap or duplicated');
            }
            var slotPath = path.join(rootPath, entry);
            var slotStat = fs.lstatSync(slotPath);
            if (!slotStat.isFile() || slotStat.isSymbolicLink() || !isPrivateMode(slotStat) ||
                Number(slotStat.size) < 1 || Number(slotStat.size) > 4096) {
                throw new Error('forced-full reservation slot is not a private regular file: ' + entry);
            }
            var record = JSON.parse(fs.readFileSync(slotPath, 'utf8'));
            if (!record || Array.isArray(record) ||
                record.schema !== SIZE_GATE_FORCED_FULL_SCHEMA ||
                record.event !== 'forced_full_reserved' ||
                record.slot !== slot ||
                !/^[a-f0-9]{64}$/.test(String(record.job_identity_sha256 || '')) ||
                typeof record.reserved_at !== 'string' ||
                !isFinite(Date.parse(record.reserved_at))) {
                throw new Error('forced-full reservation slot record is corrupt: ' + entry);
            }
            var owner = String(record.job_identity_sha256).toLowerCase();
            if (identities[owner]) {
                throw new Error('forced-full job identity owns multiple reservation slots');
            }
            identities[owner] = slot;
            slots[slot] = record;
            if (identityHash === owner) ownedSlot = slot;
        }

        var firstFreeSlot = null;
        for (var candidateSlot = 1; candidateSlot <= cap; candidateSlot++) {
            if (!slots[candidateSlot]) {
                firstFreeSlot = candidateSlot;
                break;
            }
        }
        return {
            ok: true,
            rootExists: true,
            used: Object.keys(slots).length,
            ownedSlot: ownedSlot,
            firstFreeSlot: firstFreeSlot,
        };
    } catch (error) {
        return forcedFullFailure('reservation_root_invalid', error);
    }
}

function ensureForcedFullDirectory(fs, directoryPath, mode) {
    try {
        fs.mkdirSync(directoryPath, { mode: mode });
    } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error;
    }
    var stat = fs.lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !isPrivateMode(stat)) {
        throw new Error('forced-full reservation directory is invalid or not private: ' + directoryPath);
    }
}

function writeForcedFullPendingRecord(fs, filePath, record) {
    var fd = fs.openSync(filePath, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify(record) + '\n', { encoding: 'utf8' });
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function fsyncForcedFullDirectory(fs, directoryPath, forceDirectoryFsync) {
    if (process.platform === 'win32' && forceDirectoryFsync !== true) return;
    var directoryFd = fs.openSync(directoryPath, 'r');
    try {
        fs.fsyncSync(directoryFd);
    } finally {
        fs.closeSync(directoryFd);
    }
}

function verifyForcedFullReservation(fs, path, rootPath, cap, identityHash, expectedSlot, status,
    forceDirectoryFsync) {
    try {
        // The slot file was fsynced before link publication. Re-fsync the
        // containing directory on every acquisition and every reuse so a prior
        // post-link error can never be converted into admission without a fresh
        // durability barrier and complete ledger readback.
        fsyncForcedFullDirectory(fs, rootPath, forceDirectoryFsync);
        var committed = inspectForcedFullReservations({
            rootPath: rootPath,
            cap: cap,
            jobIdentityHash: identityHash,
            fs: fs,
            path: path,
        });
        if (!committed.ok || committed.ownedSlot !== expectedSlot) {
            return forcedFullFailure('reservation_commit_unverified',
                committed.error || 'forced-full reservation could not be read back');
        }
        return {
            ok: true,
            status: status,
            slot: expectedSlot,
            used: committed.used,
            jobIdentityHash: identityHash,
        };
    } catch (error) {
        return forcedFullFailure('reservation_commit_unverified', error);
    }
}

function reserveForcedFullSlot(options) {
    options = options || {};
    var fs = options.fs || require('fs');
    var path = options.path || require('path');
    var rootPath = String(options.rootPath || SIZE_GATE_FORCED_FULL_ROOT);
    var identityHash = String(options.jobIdentityHash || '').toLowerCase();
    var cap;
    try {
        cap = normalizeForcedFullCap(options.cap);
        if (!/^[a-f0-9]{64}$/.test(identityHash)) {
            throw new Error('forced-full reservation job hash is invalid');
        }
        ensureForcedFullDirectory(fs, rootPath, 0o700);
        // Persist the ledger root's directory entry as well as its later
        // contents. This runs on every attempt, so a transient parent-fsync
        // failure cannot become a successful retry without a fresh barrier.
        fsyncForcedFullDirectory(fs, path.dirname(rootPath), options.forceDirectoryFsync);
        var pendingPath = path.join(rootPath, '.pending');
        ensureForcedFullDirectory(fs, pendingPath, 0o700);

        // Every contender chooses the lowest free slot. The complete, fsynced
        // pending record is hard-linked into that slot with one atomic link(2);
        // EEXIST means another process won and triggers a full rescan. This both
        // enforces the cap and makes concurrent retries for one job converge on
        // the same hashed owner rather than consuming multiple slots.
        for (var attempt = 0; attempt <= cap + 1; attempt++) {
            var snapshot = inspectForcedFullReservations({
                rootPath: rootPath,
                cap: cap,
                jobIdentityHash: identityHash,
                fs: fs,
                path: path,
            });
            if (!snapshot.ok) return snapshot;
            if (snapshot.ownedSlot !== null) {
                return verifyForcedFullReservation(fs, path, rootPath, cap,
                    identityHash, snapshot.ownedSlot, 'reused', options.forceDirectoryFsync);
            }
            if (snapshot.firstFreeSlot === null || snapshot.used >= cap) {
                return {
                    ok: false,
                    code: 'reservation_cap_exhausted',
                    error: 'forced-full reservation hard cap is exhausted',
                    used: snapshot.used,
                };
            }

            var slot = snapshot.firstFreeSlot;
            var record = {
                schema: SIZE_GATE_FORCED_FULL_SCHEMA,
                event: 'forced_full_reserved',
                slot: slot,
                job_identity_sha256: identityHash,
                reserved_at: new Date().toISOString(),
            };
            var nonce = require('crypto').randomBytes(12).toString('hex');
            var pendingFile = path.join(pendingPath,
                identityHash + '.' + String(process.pid) + '.' + nonce + '.json');
            var slotPath = path.join(rootPath, forcedFullSlotName(slot));
            try {
                writeForcedFullPendingRecord(fs, pendingFile, record);
                try {
                    fs.linkSync(pendingFile, slotPath);
                } catch (linkError) {
                    try { fs.unlinkSync(pendingFile); } catch (_) {}
                    if (linkError && linkError.code === 'EEXIST') continue;
                    return forcedFullFailure('reservation_write_failed', linkError);
                }
                try { fs.unlinkSync(pendingFile); } catch (_) {
                    // A leftover name in .pending is not authority; the immutable
                    // slot link is complete and remains the reservation.
                }
                return verifyForcedFullReservation(fs, path, rootPath, cap,
                    identityHash, slot, 'acquired', options.forceDirectoryFsync);
            } catch (writeError) {
                try { fs.unlinkSync(pendingFile); } catch (_) {}
                return forcedFullFailure('reservation_write_failed', writeError);
            }
        }
        return forcedFullFailure('reservation_contention_exhausted',
            'forced-full reservation contention did not converge');
    } catch (error) {
        return forcedFullFailure('reservation_write_failed', error);
    }
}

function requiresForcedFullReservation(bestParams, legacyRatioPct, emergencyRatioPct) {
    var projected = Number(bestParams && bestParams.projectedOutputRatioPct);
    return isFinite(projected) && projected >= legacyRatioPct && projected < emergencyRatioPct;
}

function noteForcedFullReservationFailure(args, reservation, bestParams) {
    args.variables.vmafSizeGateForcedFull = true;
    args.variables.vmafSizeGateForcedFullReservationFailure = reservation.code;
    args.variables.vmafSizeGateForcedFullReservationError = reservation.error;
    var projected = Number(bestParams && bestParams.projectedOutputRatioPct);
    try {
        args.jobLog('SIZE-GATE LABEL RESERVATION UNAVAILABLE (non-fatal): selected CQ '
            + (bestParams && bestParams.parameterSet && bestParams.parameterSet.quality)
            + ' projected ' + (isFinite(projected) ? projected.toFixed(1) : 'unknown') + '%; '
            + reservation.code + ': ' + reservation.error
            + '. Full transcode remains allowed; the monotonic actual-byte guard is authoritative.');
    } catch (_) {}
}

function commitForcedFullSelection(args, bestParams, options) {
    options = options || {};
    // Validation is deliberately before reservation. Callers may supply the
    // exact prevalidated contract, but the default path remains independently
    // testable and cannot consume a slot for an invalid selection.
    var validatedSelection = validateFinalSelection(bestParams);
    if (options.validatedSelection &&
        (Number(options.validatedSelection.cq) !== validatedSelection.cq ||
            String(options.validatedSelection.parameterSetId) !== validatedSelection.parameterSetId)) {
        throw new Error('VMAF selection changed after prevalidation');
    }
    var reservation = null;
    if (requiresForcedFullReservation(bestParams,
        Number(options.legacyRatioPct), Number(options.emergencyRatioPct))) {
        args.variables.vmafSizeGateForcedFull = true;
        var capResolution = options.capResolution;
        reservation = capResolution && !capResolution.ok
            ? capResolution
            : (options.jobIdentityHash
                ? reserveForcedFullSlot({
                    rootPath: options.rootPath || SIZE_GATE_FORCED_FULL_ROOT,
                    cap: options.cap,
                    jobIdentityHash: options.jobIdentityHash,
                    fs: options.fs,
                    path: options.path,
                })
                : forcedFullFailure('reservation_identity_unavailable',
                    options.reservationReadError || 'stable job identity is unavailable'));
        if (!reservation.ok) {
            noteForcedFullReservationFailure(args, reservation, bestParams);
            reservation = null;
        } else {
            args.variables.vmafSizeGateForcedFullJobHash = options.jobIdentityHash;
            args.variables.vmafSizeGateForcedFullReservationSlot = reservation.slot;
            args.variables.vmafSizeGateForcedFullReservationStatus = reservation.status;
        }
    }
    var selection = publishFinalSelection(args.variables, bestParams, validatedSelection);
    return {
        ok: true,
        reservation: reservation,
        selection: selection,
    };
}

var plugin = function (args) {

    var lib = require('../../../../../methods/lib')();
    var feasibility = require('../../_lib/feasibility.js');
    var referenceContract = grainVmafContract.assertVariables(args.variables, {
        context: 'VMAF holdout',
        requireTemporalPolicy: true,
    });
    var canonicalInput = referenceContract.canonical;
    var metricContract = null;

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

        // Floor table lives in _lib/adaptiveFrameFloor.js so checkCQBracket - which runs before
        // this plugin publishes the policy - derives the identical value instead of falling back
        // to null and silently dropping the 1%-low constraint.
        var adaptiveFloor = adaptiveFrameFloorLib.frameFloorForTier(tier, {
            isHDR: hdr, isAnimation: isAnimation, isBluray: isBluray, isMovie: isMovie
        });

        return {

            width: width, height: height, pixels: pixels, duration: duration, fps: fps,

            sourceSizeMB: sourceSizeMB, tier: tier, isHDR: hdr, is10Bit: is10Bit,

            isAnimation: isAnimation, mediaType: mediaType, sourceType: sourceType,

            minOutputBpp: minBpp[tier], minOutputRatioPct: minRatio[tier],

            minOutputMbps: minMbps[tier], adaptiveFrameFloor: adaptiveFloor,

            meanFloor: configuredMeanFloor, sampleDuration: Math.max(1, Number(vars.vmafSegmentDuration || 5))

        };

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

    function measureCpuV1Holdout(args, holdout, distortedPath, cacheDir, safeId,
            holdoutMetricContract, policy) {
        var fs = require('fs');
        var execFileSync = require('child_process').execFileSync;
        var outputPath = cacheDir + '/holdout_vmaf_v1_' + safeId + '_' +
            process.pid + '_' + Date.now() + '.json';
        var metadataPath = outputPath + '.transport.json';
        var scorerGeometry = cpuV1ScorerGeometryFromContract(holdoutMetricContract);
        var command = vmafV1Cpu.buildScorerCommand({
            referencePath: holdout.path,
            distortedPath: distortedPath,
            outputPath: outputPath,
            metadataOutputPath: metadataPath,
            ffmpegPath: args.ffmpegPath,
            width: scorerGeometry.width,
            height: scorerGeometry.height,
            sampleAspectRatio: scorerGeometry.sampleAspectRatio,
            displayAspectRatio: scorerGeometry.displayAspectRatio,
            geometryNormalization: scorerGeometry.geometryNormalization,
            modelVersion: holdoutMetricContract.modelVersion,
            contentClass: holdoutMetricContract.contentClass,
            allowProvisionalHdr: holdoutMetricContract.contentClass === 'hdr-pq',
            subsample: 1,
            threads: cpuV1ThreadsPerScore(args),
            pooling: holdoutMetricContract.poolingPrimary,
        });
        var startedAt = Date.now();
        try {
            execFileSync(command.executable, command.args, {
                stdio: 'pipe', timeout: 300000, windowsHide: true,
                maxBuffer: 32 * 1024 * 1024,
            });
            var parsed = vmafV1Cpu.parseScorerOutput(
                fs.readFileSync(outputPath, 'utf8'),
                fs.readFileSync(metadataPath, 'utf8'), command);
            var frames = parsed.frames || [];
            if (!frames.length) throw new Error('CPU-v1 holdout returned no frames');
            function valuesFor(key) {
                var values = frames.map(function (frame) { return Number(frame[key]); });
                if (!values.length || values.some(function (value) { return !isFinite(value); })) {
                    throw new Error('CPU-v1 holdout returned non-finite ' + key);
                }
                return values;
            }
            function mean(values) {
                return values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
            }
            function percentile(values, fraction) {
                var sorted = values.slice().sort(function (a, b) { return a - b; });
                return sorted[Math.min(sorted.length - 1,
                    Math.max(0, Math.floor(fraction * (sorted.length - 1))))];
            }
            var vmafFrames = valuesFor('vmaf');
            var cambiFrames = valuesFor('cambi');
            var sourceCambiFrames = valuesFor('cambiSource');
            var out = {
                avgVMAF: Number(parsed.vmaf),
                vmafP1: percentile(vmafFrames, 0.01),
                minVMAF: Math.min.apply(null, vmafFrames),
                cambiMean: mean(cambiFrames),
                cambiP95: percentile(cambiFrames, 0.95),
                cambiMax: Math.max.apply(null, cambiFrames),
                srcCambiMean: mean(sourceCambiFrames),
                srcCambiP95: percentile(sourceCambiFrames, 0.95),
                srcCambiMax: Math.max.apply(null, sourceCambiFrames),
                cambiStage: 'pre-fgs-grain-free-candidate-native10',
                metricAliases: parsed.aliases,
            };
            if (!isFinite(out.avgVMAF)) throw new Error('CPU-v1 holdout pooled VMAF is non-finite');
            args.jobLog('CPU VMAF-v1 authoritative holdout: VMAF=' +
                out.avgVMAF.toFixed(3) + ', p1=' + out.vmafP1.toFixed(3) +
                ', CAMBI=' + out.cambiMean.toFixed(3) + '/p95 ' +
                out.cambiP95.toFixed(3));
            return out;
        } finally {
            accumulateTimingSeconds(args.variables, 'vmafHoldoutVmafTimeSec',
                (Date.now() - startedAt) / 1000);
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
            try { if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath); } catch (_) {}
        }
    }

    function runVmafOnHoldout(args, holdout, parameterSet, policy) {

        var fs = require('fs');

        var path = require('path');

        var childProcess = require('child_process');

        var execFileSync = childProcess.execFileSync;

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

        var temporalPolicy = referenceContract.temporalPolicy;
        if (args.variables.vmafNvencTemporalPolicy !== temporalPolicy) {
            throw new Error('holdout NVENC temporal policy does not match the measured sweep');
        }
        var nvencFlagArgs = args.variables.vmafNvencFlagArgs ||
            nvencTemporalFilter.qualityFlags(temporalPolicy, false);

        try { if (fs.existsSync(distortedPath)) fs.unlinkSync(distortedPath); } catch (e1) {}

        try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch (e2) {}

        var encArgs = buildHoldoutEncodeArgs({
            inputPath: holdout.path,
            outputPath: distortedPath,
            encoder: encoder,
            pixFmt: pixFmt,
            cq: cq,
            preset: preset,
            nvencFlagArgs: nvencFlagArgs,
            colorPrimaries: colorPrimaries,
            colorTrc: colorTrc,
            colorspace: colorspace,
            canonicalInput: canonicalInput,
            temporalPolicy: temporalPolicy,
        });

        var holdoutEncodeStartedAt = Date.now();
        try {
            execFileSync(args.ffmpegPath, encArgs, {
                stdio: 'pipe', timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024
            });
        } finally {
            accumulateTimingSeconds(args.variables, 'vmafHoldoutEncodeTimeSec',
                (Date.now() - holdoutEncodeStartedAt) / 1000);
        }

        var holdoutMetricContract = metricContract ||
            resolveMeasuredSweepContract(args, policy);
        assertMeasuredSweepRuntime(holdoutMetricContract, fs);
        if (args.variables.vmafMetricContractId &&
                args.variables.vmafMetricContractId !== holdoutMetricContract.metricContractId) {
            throw new Error('holdout metric contract does not match the measured sweep');
        }
        if (holdoutMetricContract.backend === 'cpu') {
            try {
                return measureCpuV1Holdout(args, holdout, distortedPath, cacheDir,
                    safeId, holdoutMetricContract, policy);
            } finally {
                try { if (fs.existsSync(distortedPath)) fs.unlinkSync(distortedPath); } catch (_) {}
            }
        }
        var capabilityCache = args.variables.vmafGpuCapabilityCache;
        if (!capabilityCache || capabilityCache.available !== true ||
                capabilityCache.ffmpegPath !== args.ffmpegPath ||
                capabilityCache.metricContractId !== holdoutMetricContract.metricContractId ||
                capabilityCache.modelPath !== holdoutMetricContract.modelPath ||
                capabilityCache.modelSha256 !== holdoutMetricContract.modelSha256 ||
                capabilityCache.filterName !== holdoutMetricContract.filterName ||
                capabilityCache.scoringPixelFormat !== holdoutMetricContract.scoringPixelFormat) {
            throw new Error('holdout requires a positive exact-model CUDA capability attestation');
        }
        var modelPath = holdoutMetricContract.modelPath;

        // CAMBI is measured in a separate required CPU pass. libvmaf_cuda does
        // not publish it reliably and must remain VMAF-only.

        // Do NOT tonemap for VMAF/CAMBI. libvmaf_cuda requires 8-bit (yuv420p) input, which the
        // `format=yuv420p` step below already provides — the 8-bit requirement does NOT require a
        // tonemap. tonemap=hable applied directly to the PQ signal bands smooth gradients, which
        // CAMBI then reports as ~13 banding on an otherwise-pristine HDR encode (VMAF ~100). The GPU
        // sweep (calculateVMAF) does not tonemap in practice either, so tonemapping only the holdout
        // put its CAMBI on a different scale (~13 vs the sweep's ~2) and false-failed every HDR
        // holdout. Measuring 8-bit-without-tonemap keeps the holdout on the same scale as the sweep.
        // (Native 10-bit HDR VMAF is only available on CPU libvmaf, not libvmaf_cuda, in this build.)
        var tonemap = '';

        if (canonicalInput && (holdout.denoiseId !== canonicalDenoise.DENOISE_ID ||
            holdout.denoiseSettings !== canonicalDenoise.KNN_SETTINGS ||
            Number(holdout.denoisePrerollSeconds) !== canonicalDenoise.PREROLL_SECONDS ||
            holdout.referenceContractId !== canonicalDenoise.REFERENCE_CONTRACT_ID)) {
            throw new Error('holdout lacks authenticated canonical denoised FFV1 evidence');
        }
        if (!canonicalInput && (holdout.denoiseFilter !== undefined ||
            holdout.denoiseId !== undefined || holdout.denoiseSettings !== undefined ||
            holdout.denoisePrerollSeconds !== undefined ||
            holdout.referenceContractId !== referenceContract.id)) {
            throw new Error('original-source holdout has an incompatible reference contract');
        }
        // The holdout reference is the materialized FFV1 v3 denoised clip, so it
        // must be software-decoded. Only the distorted AV1 uses CUVID.
        var refCuvid = null;

        var holdoutVmafArgs = buildHoldoutVmafArgs({
            distortedPath: distortedPath,
            referencePath: holdout.path,
            encoder: encoder,
            referenceCuvid: refCuvid,
            scoringPixelFormat: holdoutMetricContract.scoringPixelFormat,
            filterName: holdoutMetricContract.filterName,
            logPath: logPath,
            modelPath: modelPath,
            tonemap: tonemap,
        });






        var holdoutVmafStartedAt = Date.now();
        try {
            execFileSync(args.ffmpegPath, holdoutVmafArgs, {
                stdio: 'pipe', timeout: 240000, windowsHide: true,
                shell: false, maxBuffer: 32 * 1024 * 1024
            });
        } finally {
            accumulateTimingSeconds(args.variables, 'vmafHoldoutVmafTimeSec',
                (Date.now() - holdoutVmafStartedAt) / 1000);
        }

        var parsed = parseHoldoutVmafLog(logPath, fs);

        try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch (e3) {}

        if (!parsed) throw new Error('holdout VMAF log parse failed');
        if (holdoutMetricContract.cambi.required === true) {
            var holdoutCambi = measureHoldoutPreFgsCambi(args, distortedPath,
                holdout.path, cacheDir, modelPath, holdoutMetricContract,
                safeId + '_candidate', 'vmafHoldoutCandidateCambiTimeSec');
            var sourceHoldoutCambi = measureHoldoutPreFgsCambi(args, holdout.path,
                holdout.path, cacheDir, modelPath, holdoutMetricContract,
                safeId + '_source', 'vmafHoldoutSourceCambiTimeSec');
            parsed.cambiMean = holdoutCambi.cambiMean;
            parsed.cambiP95 = holdoutCambi.cambiP95;
            parsed.cambiMax = holdoutCambi.cambiMax;
            parsed.cambiStage = 'pre-fgs-grain-free-candidate';
            parsed.srcCambiMean = sourceHoldoutCambi.cambiMean;
            parsed.srcCambiP95 = sourceHoldoutCambi.cambiP95;
            parsed.srcCambiMax = sourceHoldoutCambi.cambiMax;
            args.jobLog('Holdout pre-FGS CAMBI: candidate=' +
                holdoutCambi.cambiMean.toFixed(3) + '/p95 ' +
                holdoutCambi.cambiP95.toFixed(3) + ', source=' +
                sourceHoldoutCambi.cambiMean.toFixed(3) + '/p95 ' +
                sourceHoldoutCambi.cambiP95.toFixed(3));
        }

        try { if (fs.existsSync(distortedPath)) fs.unlinkSync(distortedPath); } catch (e4) {}

        return parsed;

    }

    args.inputs = lib.loadDefaultValues(args.inputs, details);

    // Infeasible-file cooldown (2026-07-20): no sweep was run for this job because the exact
    // file already failed terminally under the current feasibility-policy era. Give up
    // immediately (keep original) — checkCQRangeRetry has a matching guard so no retry fires.
    if (args.variables.vmafCooldownSkip) {
        args.jobLog('=== Infeasible-File Cooldown ===');
        args.jobLog('GIVING UP without a sweep: prior terminal failure '
            + (args.variables.vmafCooldownSkip.priorSkipReason || 'unknown') + ' on '
            + String(args.variables.vmafCooldownSkip.priorTimestamp || '').slice(0, 10)
            + ' (job ' + (args.variables.vmafCooldownSkip.priorJobId || 'unknown') + '). Keeping original file.');
        args.variables.vmafTranscodeGaveUp = true;
        args.variables.vmafSweepRetriesExhausted = true;
        if (!args.variables.vmafTranscodeFailures) args.variables.vmafTranscodeFailures = [];
        args.variables.vmafTranscodeFailures.push({
            reason: 'infeasible_cooldown',
            succeeded: false,
            retries: 0,
            originalCQ: null,
            finalCQ: null,
            bestVMAF: null,
        });
        args.variables.vmafSelectOutput = 2;
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 2,
            variables: args.variables,
        };
    }

    var aggregatedResults = args.variables.vmafAggregatedResults || [];

    // ── Cross-attempt result memory (SweepLog 2026-07-07 addendum 2) ──
    // checkCQRangeRetry wipes vmafAggregatedResults on every sweep retry, so measurements from
    // earlier attempts were forgotten: GOAT had cq25/cq30 ACCEPTED in attempt 1, then retries
    // explored only cq37-47 (all size-floor/harmonic fails) and the job kept the original despite
    // known-feasible candidates. Persist every measured result across attempts and re-evaluate
    // ALL of them under the CURRENT policy each pass (so a stale acceptance like GOAT cq38 is
    // still re-rejected by the size guard, and a stale CAMBI rejection is revived if the source
    // baseline later relaxes the floor). Kill switch: vmafCrossAttemptMemory === false.
    if (args.variables.vmafCrossAttemptMemory !== false) {
        try {
            var _histById = {};
            var _hist = args.variables.vmafSweepResultHistory || [];
            for (var _hI = 0; _hI < _hist.length; _hI++) {
                if (_hist[_hI] && _hist[_hI].parameterSetId) _histById[_hist[_hI].parameterSetId] = _hist[_hI];
            }
            var _curIds = {};
            for (var _aI = 0; _aI < aggregatedResults.length; _aI++) {
                if (aggregatedResults[_aI] && aggregatedResults[_aI].parameterSetId) {
                    _histById[aggregatedResults[_aI].parameterSetId] = aggregatedResults[_aI]; // latest wins
                    _curIds[aggregatedResults[_aI].parameterSetId] = true;
                }
            }
            args.variables.vmafSweepResultHistory = Object.keys(_histById).map(function (k) { return _histById[k]; });
            var _revived = 0;
            for (var _hK in _histById) {
                if (!_curIds[_hK]) { aggregatedResults.push(_histById[_hK]); _revived++; }
            }
            if (_revived > 0) {
                args.variables.vmafAggregatedResults = aggregatedResults;
                args.jobLog('Cross-attempt memory: re-considering ' + _revived
                    + ' previously measured parameter set(s) from earlier sweep attempts under current policy');
            }
        } catch (_chErr) {
            args.jobLog('Cross-attempt result memory skipped (non-fatal): ' + _chErr.message);
        }
    }

    // ── Cross-job measurement reuse revive (2026-07-20) ──
    // testEncodingParameters skipped re-encoding CQs whose current-era measurements for this
    // exact file already exist (vmafReusedSweepRows). Reconstruct result objects from those DB
    // rows and merge them for re-judgement under CURRENT policy. parameterSet metadata (encoder,
    // pixel format, colour) is cloned from a measured result of this job — testEncodingParameters
    // guarantees at least one fresh probe per sweep. Revived rows carry reusedFromJobId and are
    // NOT re-written to the training DB (exportVMAFResults filters them), so created_at
    // age-gating stays honest. Kill switch: args.variables.vmafCrossJobReuse === false.
    if (args.variables.vmafCrossJobReuse !== false) {
        try {
            var _cjrRows = args.variables.vmafReusedSweepRows || [];
            if (_cjrRows.length > 0) {
                var _cjrTemplate = null;
                for (var _cjrI = 0; _cjrI < aggregatedResults.length; _cjrI++) {
                    if (aggregatedResults[_cjrI] && aggregatedResults[_cjrI].parameterSet) {
                        _cjrTemplate = aggregatedResults[_cjrI].parameterSet;
                        break;
                    }
                }
                var _cjrHave = {};
                for (var _cjrJ = 0; _cjrJ < aggregatedResults.length; _cjrJ++) {
                    var _cjrQ = aggregatedResults[_cjrJ] && aggregatedResults[_cjrJ].parameterSet
                        ? Number(aggregatedResults[_cjrJ].parameterSet.quality) : NaN;
                    if (isFinite(_cjrQ)) _cjrHave[Math.round(_cjrQ * 10) / 10] = true;
                }
                var _cjrAdded = 0;
                if (_cjrTemplate) {
                    for (var _cjrK = 0; _cjrK < _cjrRows.length; _cjrK++) {
                        var _cjrRow = _cjrRows[_cjrK] || {};
                        var _cjrCq = Math.round(Number(_cjrRow.cq) * 10) / 10;
                        if (!isFinite(_cjrCq) || _cjrHave[_cjrCq]) continue;
                        var _cjrPs = JSON.parse(JSON.stringify(_cjrTemplate));
                        _cjrPs.quality = _cjrCq;
                        var _cjrIndices = null;
                        try {
                            _cjrIndices = _cjrRow.clip_sample_indices ? JSON.parse(_cjrRow.clip_sample_indices) : null;
                        } catch (_cjrIdxErr) { _cjrIndices = null; }
                        aggregatedResults.push({
                            parameterSetId: 'gpu_' + (_cjrPs.preset || 'p7') + '_cq' + _cjrCq,
                            parameterSet: _cjrPs,
                            avgVMAF: Number(_cjrRow.vmaf_harmonic_mean),
                            avgVMAFMean: _cjrRow.vmaf_mean != null ? Number(_cjrRow.vmaf_mean) : null,
                            minVMAF: _cjrRow.vmaf_min != null ? Number(_cjrRow.vmaf_min) : null,
                            maxVMAF: _cjrRow.vmaf_max != null ? Number(_cjrRow.vmaf_max) : null,
                            vmafP1Low: _cjrRow.vmaf_p1_low != null ? Number(_cjrRow.vmaf_p1_low) : null,
                            vmafStdDev: _cjrRow.vmaf_stddev != null ? Number(_cjrRow.vmaf_stddev) : null,
                            avgCAMBI: _cjrRow.cambi_mean != null ? Number(_cjrRow.cambi_mean) : null,
                            maxCAMBI: _cjrRow.cambi_max != null ? Number(_cjrRow.cambi_max) : null,
                            p95CAMBI: _cjrRow.cambi_p95 != null ? Number(_cjrRow.cambi_p95) : null,
                            avgSSIM: _cjrRow.ssim != null ? Number(_cjrRow.ssim) : null,
                            minXPSNR: _cjrRow.xpsnr_min != null ? Number(_cjrRow.xpsnr_min) : null,
                            avgXPSNRWeighted: _cjrRow.xpsnr_weighted != null ? Number(_cjrRow.xpsnr_weighted) : null,
                            avgPSNR: _cjrRow.psnr_avg != null ? Number(_cjrRow.psnr_avg) : null,
                            ssimulacra2: _cjrRow.ssimulacra2 != null ? Number(_cjrRow.ssimulacra2) : null,
                            ssimulacra2P5: _cjrRow.ssimulacra2_p5 != null ? Number(_cjrRow.ssimulacra2_p5) : null,
                            butteraugliNormInf: _cjrRow.butteraugli_norm_inf != null
                                ? Number(_cjrRow.butteraugli_norm_inf) : null,
                            butteraugli: _cjrRow.butteraugli_norm3 != null
                                ? Number(_cjrRow.butteraugli_norm3) : null,
                            cvvdp: _cjrRow.cvvdp != null ? Number(_cjrRow.cvvdp) : null,
                            gpuPerceptualContractId: _cjrRow.gpu_perceptual_contract_id || null,
                            avgFileSizeMB: Number(_cjrRow.avg_size_mb),
                            sampleCount: _cjrRow.sample_count != null ? Number(_cjrRow.sample_count) : null,
                            clipSampleIndices: _cjrIndices,
                            reusedFromJobId: _cjrRow.job_id || null,
                            reusedCreatedAt: _cjrRow.created_at || null,
                        });
                        _cjrHave[_cjrCq] = true;
                        _cjrAdded++;
                    }
                }
                if (_cjrAdded > 0) {
                    args.variables.vmafAggregatedResults = aggregatedResults;
                    args.jobLog('Cross-job reuse: revived ' + _cjrAdded + ' previously measured parameter set(s)'
                        + ' for this exact file from the training DB; re-judged under current policy');
                } else if (!_cjrTemplate) {
                    args.jobLog('Cross-job reuse: no fresh-result template available this pass; revive deferred');
                }
            }
        } catch (_cjrErr) {
            args.jobLog('Cross-job reuse revive skipped (non-fatal): '
                + (_cjrErr && _cjrErr.message ? _cjrErr.message : String(_cjrErr)));
        }
    }

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

    if (!isFinite(minSizeReduction) ||
            minSizeReduction !== deliveryPolicy.DEFAULT_MINIMUM_REDUCTION_PCT) {

        throw new Error('minSizeReduction must equal the current policy value ' +
            deliveryPolicy.DEFAULT_MINIMUM_REDUCTION_PCT);

    }
    args.variables.vmafMinimumSizeReductionPct = minSizeReduction;
    var selectedDeliveryPolicy = deliveryPolicy.resolve(args.variables);

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

        args.jobLog('Source is 10-bit, but exact-contract GPU VMAF was not attested; no CPU VMAF fallback is permitted');

        args.jobLog('No buffer applied - thresholds used as configured');

    } else if (is10BitSource) {

        args.jobLog('');

        args.jobLog('=== 10-bit Source Detected ===');

        args.jobLog('Source is 10-bit. Buffer disabled (vmafBuffer10Bit=0). Thresholds used as configured.');

    }

    // ── Adaptive quality guard: resolution/type-aware frame-floor and size/BPP checks ─

    var qualityRiskPolicy = getQualityRiskPolicy(args.inputFileObj, args.variables, adjustedMinFrameVMAF, adjustedMinVMAF);

    metricContract = resolveMeasuredSweepContract(args, qualityRiskPolicy);
    assertMeasuredSweepRuntime(metricContract, require('fs'));
    if (args.variables.vmafMetricContractId &&
            args.variables.vmafMetricContractId !== metricContract.metricContractId) {
        throw new Error('selection metric contract does not match the measured sweep');
    }
    args.variables.vmafMetricContractFamilyId = metricContract.metricContractFamilyId;
    args.variables.vmafMetricContractId = metricContract.metricContractId;
    args.variables.vmafEncoderProfileId = metricContract.encoderProfileId;
    args.variables.vmafEncoderProfileAttested = metricContract.encoderProfileAttested;
    args.variables.vmafModelPath = metricContract.modelPath;
    args.variables.vmafModelName = metricContract.modelName;
    args.variables.vmafModelSha256 = metricContract.modelSha256;
    args.variables.vmafMetricBackend = metricContract.backend;
    args.variables.vmafMetricFilterName = metricContract.filterName;
    args.variables.vmafScoringBitDepth = metricContract.scoringBitDepth;
    args.variables.vmafScoringPixelFormat = metricContract.scoringPixelFormat;
    args.variables.vmafPoolingPrimary = metricContract.poolingPrimary;
    args.variables.vmafCambiPolicy = metricContract.cambiPolicy;
    args.variables.vmafCambiAvailable = metricContract.cambi.required === true;
    args.variables.vmafCambiUnavailableReason = metricContract.cambi.reasonCode || null;

    // Original source sample sizes by sampleIndex, feeding the ratio-based size projection.
    // Do not derive this map from vmafTestResults.originalSamplePath: on the canonical-denoise
    // path that field is the lossless FFV1 quality reference, not the compressed source clip.
    try {
        var _osFs = require('fs');
        var _osMap = buildOriginalSourceSampleSizeMap(args.variables, _osFs);
        var _osN = Object.keys(_osMap).length;
        if (_osN > 0) {
            qualityRiskPolicy.originalSampleMBByIndex = _osMap;
            args.jobLog('Size projection: per-clip compression ratio vs ' + _osN
                + ' authenticated original-source sample size(s) (lossless references excluded)');
        } else {
            args.jobLog('Size projection: authenticated original-source samples unavailable; using encoded-duration extrapolation');
        }
    } catch (_osErr) {
        args.jobLog('Original-sample size map unavailable (non-fatal, using duration extrapolation): ' + _osErr.message);
    }

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

    // Note: per-clip compression-ratio size projection is used only for the hard emergency
    // cutoff and the shadow band (see evaluateSizeGate); the authoritative size verdict comes
    // from live monitoring during the actual transcode.

    args.jobLog('=== File Size Note ===');

    args.jobLog('Size projection is advisory: hard reject only at the emergency cutoff; the retired 90% gate is shadow/forced-full.');

    args.jobLog('File size will be verified during actual transcode using live monitoring.');

    args.jobLog('Delivery size policy: search target ' +
        selectedDeliveryPolicy.targetReductionPct + '%, minimum delivered reduction ' +
        selectedDeliveryPolicy.minimumReductionPct + '%, final byte cap ' +
        selectedDeliveryPolicy.maxFinalOutputRatioPct + '% (' +
        selectedDeliveryPolicy.version + '). Projected-size gates remain separate.');

    args.jobLog('');

    // Product contract: every AV1 delivery is 10-bit, including 8-bit SDR.
    // The sweep publishes its measured format explicitly so backend differences
    // cannot silently reintroduce an 8-bit delivery domain.
    var recommendedPixFmt = pixelFormatContract.AV1_DELIVERY_PIX_FMT;
    var measuredPixFmt = String(args.variables.vmafMeasurementPixFmt || '').trim();
    if (!measuredPixFmt) {
        var measuredFormats = parameterSets.map(function (set) {
            return String(set && set.pixFmt || '').trim().toLowerCase();
        }).filter(Boolean).filter(function (value, index, values) {
            return values.indexOf(value) === index;
        });
        if (measuredFormats.length === 1) measuredPixFmt = measuredFormats[0];
    }
    var measuredDepth = pixelFormatContract.outputDepthForPixelFormat(measuredPixFmt);
    var recommendedDepth = pixelFormatContract.outputDepthForPixelFormat(recommendedPixFmt);
    if (measuredDepth !== recommendedDepth) {
        throw new Error('AV1 measurement/delivery bit-depth contract mismatch: measured ' +
            measuredPixFmt + ' (' + measuredDepth + '-bit), selected ' +
            recommendedPixFmt + ' (' + recommendedDepth + '-bit)');
    }
    var encoderDomainBridge = null;

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

    // Required CAMBI values were measured on the authenticated reference domain
    // immediately before candidate scoring. Missing values are a contract failure,
    // never a reason to silently disable the gate.
    var sourceCAMBI = finiteMeasuredNumber(args.variables.vmafSourceCAMBI);
    var sourceCAMBIP95 = finiteMeasuredNumber(args.variables.vmafSourceCAMBIP95);
    if (metricContract.cambi.required === true &&
            (sourceCAMBI === null || sourceCAMBIP95 === null)) {
        throw new Error('required pre-FGS CAMBI source baseline is missing or non-finite');
    }
    args.jobLog('Pre-FGS CAMBI source baseline: mean=' + sourceCAMBI.toFixed(3) +
        ', p95=' + sourceCAMBIP95.toFixed(3));

    var cambiTolerance = 1.0; // Allow up to 1.0 CAMBI point degradation from source

    var sourceCambiRisk = (sourceCAMBI !== null && sourceCAMBIP95 !== null)

        ? Math.max(sourceCAMBI, sourceCAMBIP95) : (sourceCAMBI !== null ? sourceCAMBI : null);

    var sharedCambiLimit = metricContract.cambi.required === true
        ? feasibility.effectiveCambiLimit({
            isHDR: qualityRiskPolicy.isHDR,
            isAnimation: qualityRiskPolicy.isAnimation,
            sourceCambi: sourceCAMBI,
            sourceCambiP95: sourceCAMBIP95,
            cambiTolerance: cambiTolerance
        })
        : null;
    args.variables.vmafEffectiveCambiLimit = sharedCambiLimit;
    args.variables.vmafSelectorPolicyVersion = 'selector-authoritative-v5-ssim2p5-exact-holdout';

    // SSIMULACRA2 mean and lower-tail evidence are mandatory for authoritative selection.
    // The current-contract replay found visually weak Upright encodes clustered just above
    // the former mean-80 boundary, and one selected CQ had no SSIMULACRA2 measurement at all.
    // Other auxiliary metrics remain advisory when a backend cannot produce them.
    var sharedSsimFloor = feasibility.resolveAuxFloor(args, 'vmafSsimFloor', 'ssimFloor',
        feasibility.DEFAULT_SSIM_FLOOR);
    var sharedXpsnrFloor = feasibility.resolveAuxFloor(args, 'vmafXpsnrFloor', 'xpsnrFloor',
        feasibility.DEFAULT_XPSNR_FLOOR);
    args.variables.vmafEffectiveSsimFloor = sharedSsimFloor;
    args.variables.vmafEffectiveXpsnrFloor = sharedXpsnrFloor;
    var sharedSsimulacra2Floor = feasibility.resolveAuxFloor(args, 'vmafSsimulacra2Floor',
        'ssimulacra2Floor', feasibility.DEFAULT_SSIMULACRA2_FLOOR);
    var sharedSsimulacra2P5Floor = feasibility.resolveAuxFloor(args, 'vmafSsimulacra2P5Floor',
        'ssimulacra2P5Floor', feasibility.DEFAULT_SSIMULACRA2_P5_FLOOR);
    var sharedButteraugliCeiling = feasibility.resolveAuxFloor(args, 'vmafButteraugliCeiling',
        'butteraugliCeiling', feasibility.DEFAULT_BUTTERAUGLI_CEILING);
    var sharedCvvdpFloor = feasibility.resolveAuxFloor(args, 'vmafCvvdpFloor',
        'cvvdpFloor', feasibility.DEFAULT_CVVDP_FLOOR);
    args.variables.vmafEffectiveSsimulacra2Floor = sharedSsimulacra2Floor;
    args.variables.vmafEffectiveSsimulacra2P5Floor = sharedSsimulacra2P5Floor;
    args.variables.vmafEffectiveButteraugliCeiling = sharedButteraugliCeiling;
    args.variables.vmafEffectiveCvvdpFloor = sharedCvvdpFloor;

    var sharedQualityPolicy = {
        targetVmaf: adjustedMinVMAF,
        vmafMetric: 'harmonic',
        requireVmafMean: true,
        vmafP1Floor: adjustedMinFrameVMAF > 0 ? adjustedMinFrameVMAF : null,
        cambiLimit: sharedCambiLimit,
        ssimFloor: sharedSsimFloor,
        xpsnrFloor: sharedXpsnrFloor,
        ssimulacra2Floor: sharedSsimulacra2Floor,
        ssimulacra2P5Floor: sharedSsimulacra2P5Floor,
        butteraugliCeiling: sharedButteraugliCeiling,
        cvvdpFloor: sharedCvvdpFloor,
        requiredAuxMetrics: ['ssimulacra2', 'ssimulacra2P5']
    };

    // Size-gate demotion policy (see evaluateSizeGate for rationale). The private
    // per-slot reservation ledger is the only budget authority. A retry derives
    // the same job hash and reuses its slot; the JSONL stream is telemetry only.
    var sizeGateLegacyPct = Number(args.variables.vmafMaxOutputRatioPct);
    if (!isFinite(sizeGateLegacyPct) || sizeGateLegacyPct <= 0) sizeGateLegacyPct = 90;
    var sizeGateEmergencyPct = Number(args.variables.vmafSizeGateEmergencyRatioPct);
    if (!isFinite(sizeGateEmergencyPct) || sizeGateEmergencyPct <= sizeGateLegacyPct) {
        sizeGateEmergencyPct = Math.max(110, sizeGateLegacyPct);
    }
    var sizeGateDeliveryPct = Number(args.variables.vmafMaxFinalOutputRatioPct);
    if (!isFinite(sizeGateDeliveryPct) || sizeGateDeliveryPct <= 0) sizeGateDeliveryPct = 90;
    resetForcedFullAttemptState(args.variables);
    var sizeGateCapResolution = resolveForcedFullCap(args.variables.vmafSizeGateForcedFullCap);
    var sizeGateForcedFullCap = sizeGateCapResolution.ok ? sizeGateCapResolution.cap : 0;
    var sizeGateForcedFullJobHash = null;
    var sizeGateReservationSnapshot = null;
    var sizeGateReservationReadError = sizeGateCapResolution.ok
        ? null : sizeGateCapResolution.error;
    if (sizeGateCapResolution.ok) {
        try {
            sizeGateForcedFullJobHash = resolveForcedFullJobIdentityHash(args);
            args.variables.vmafSizeGateForcedFullJobHash = sizeGateForcedFullJobHash;
            sizeGateReservationSnapshot = inspectForcedFullReservations({
                rootPath: SIZE_GATE_FORCED_FULL_ROOT,
                cap: sizeGateForcedFullCap,
                jobIdentityHash: sizeGateForcedFullJobHash,
            });
            if (!sizeGateReservationSnapshot.ok) {
                sizeGateReservationReadError = sizeGateReservationSnapshot.error;
            }
        } catch (reservationIdentityError) {
            sizeGateReservationReadError = reservationIdentityError && reservationIdentityError.message
                ? reservationIdentityError.message : String(reservationIdentityError);
        }
    }
    var sizeGateForcedFullUsed = sizeGateReservationSnapshot && sizeGateReservationSnapshot.ok
        ? sizeGateReservationSnapshot.used : sizeGateForcedFullCap;
    var sizeGateForcedFullRemaining = sizeGateReservationSnapshot && sizeGateReservationSnapshot.ok
        ? (sizeGateReservationSnapshot.ownedSlot !== null
            ? 1
            : Math.max(0, sizeGateForcedFullCap - sizeGateForcedFullUsed))
        : 0;
    args.jobLog('Size gate: projections from ' + sizeGateLegacyPct + '% through '
        + (sizeGateEmergencyPct - 0.1).toFixed(1) + '% run under the actual-byte delivery guard; hard emergency cutoff '
        + sizeGateEmergencyPct + '%; forced-full label budget used ' + sizeGateForcedFullUsed
        + '/' + sizeGateForcedFullCap
        + (sizeGateReservationSnapshot && sizeGateReservationSnapshot.ownedSlot !== null
            ? ' (this job already owns slot ' + sizeGateReservationSnapshot.ownedSlot + ')' : '')
        + (sizeGateReservationReadError
            ? ' (reservation ledger unavailable; label telemetry disabled: ' + sizeGateReservationReadError + ')' : '')
        + '; actual-byte delivery cap ' + sizeGateDeliveryPct + '%; label-budget state never changes the allow decision');

    var validResults = [];

    delete args.variables.vmafToleranceFallbackActive;
    delete args.variables.vmafToleranceFallbackDegraded;
    delete args.variables.vmafToleranceFallbackMode;
    delete args.variables.vmafToleranceFallbackReason;
    delete args.variables.vmafToleranceFallbackCQ;
    delete args.variables.vmafToleranceFallbackHoldoutMiss;
    args.variables.vmafLowerPlausibilityAdvisories = [];
    args.variables.vmafLowerPlausibilityRejections = [];

    // Keep rejected sets (with the reason) so the decision summary can explain why a more
    // aggressive (higher) CQ was not chosen.
    var rejectedResults = [];

    for (var i = 0; i < aggregatedResults.length; i++) {

        var result = aggregatedResults[i];

        var rejected = false;

        var rejectReason = '';

        var sharedQualityEvaluation = feasibility.evaluate(result, sharedQualityPolicy);
        if (!sharedQualityEvaluation.feasible) {
            rejected = true;
            rejectReason = 'Shared feasibility: ' + sharedQualityEvaluation.reason;
        }

        // Check harmonic mean threshold (use adjusted values)

        if (!rejected && result.avgVMAF < adjustedMinVMAF) {

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

            // Max-ratio handling moved to the size-gate block below (evaluateSizeGate);
            // this shared evaluation now owns only the too-small quality-risk floors.
            var sharedSizeEvaluation = feasibility.evaluate(result, {
                minOutputRatioPct: qualityRiskPolicy.minOutputRatioPct,
                minOutputBpp: qualityRiskPolicy.minOutputBpp
            });
            var lowerPlausibilityMessage = !sharedSizeEvaluation.feasible
                ? 'Shared feasibility: ' + sharedSizeEvaluation.reason : null;

            var ratioLow = sizeMetrics.projectedRatioPct > 0 && sizeMetrics.projectedRatioPct < qualityRiskPolicy.minOutputRatioPct;

            var bppLow = sizeMetrics.outputBpp > 0 && sizeMetrics.outputBpp < qualityRiskPolicy.minOutputBpp;

            var mbpsLow = sizeMetrics.outputMbps > 0 && sizeMetrics.outputMbps < qualityRiskPolicy.minOutputMbps;

            if (ratioLow || bppLow) {

                lowerPlausibilityMessage = 'Projected output too small for ' + qualityRiskPolicy.tier

                    + (qualityRiskPolicy.isHDR ? ' HDR' : ' SDR')

                    + (qualityRiskPolicy.isAnimation ? ' animation' : ' live-action')

                    + ': ratio ' + (sizeMetrics.projectedRatioPct || 0).toFixed(1) + '% (floor ' + qualityRiskPolicy.minOutputRatioPct.toFixed(1) + '%)'

                    + ', BPP ' + (sizeMetrics.outputBpp || 0).toFixed(4) + ' (floor ' + qualityRiskPolicy.minOutputBpp.toFixed(4) + ')'

                    + ', Mbps ' + (sizeMetrics.outputMbps || 0).toFixed(2) + ' (floor ' + qualityRiskPolicy.minOutputMbps.toFixed(2) + ')';

            }

            // Absolute Mbps is retained as telemetry, not an independent veto. BPP already
            // normalizes the same byte rate for coded width, coded height and frame rate.
            // Making both bind double-counts bitrate and rejects cropped 1080p titles such as
            // 1920x800 sources even when ratio, BPP and every measured quality metric pass.
            if (!ratioLow && !bppLow && mbpsLow) {
                result.vmafLowerPlausibilityAdvisory = 'Projected output is below the legacy ' +
                    'absolute bitrate floor (' + (sizeMetrics.outputMbps || 0).toFixed(2) +
                    ' < ' + qualityRiskPolicy.minOutputMbps.toFixed(2) +
                    ' Mbps), but normalized ratio/BPP safeguards pass';
                args.jobLog('SIZE ADVISORY for ' + result.parameterSetId + ': ' +
                    result.vmafLowerPlausibilityAdvisory + '. Candidate remains eligible.');
            }

            // A quality metric can be over-optimistic on a small or unrepresentative clip set.
            // Ratio and normalized BPP remain independently binding. Absolute Mbps is advisory
            // because it is an aspect-ratio-blind restatement of the BPP signal.
            if (lowerPlausibilityMessage) {
                delete result.vmafLowerPlausibilityAdvisory;
                result.vmafLowerPlausibilityRejection = lowerPlausibilityMessage;
                args.variables.vmafLowerPlausibilityRejections.push({
                    parameterSetId: result.parameterSetId,
                    cq: result.parameterSet && result.parameterSet.quality,
                    reason: lowerPlausibilityMessage
                });
                rejected = true;
                rejectReason = lowerPlausibilityMessage;
                args.jobLog('✗ LOWER-SIZE QUALITY-RISK REJECTION for ' + result.parameterSetId + ': '
                    + lowerPlausibilityMessage + '. Retrying a lower CQ; source is preserved if no CQ passes.');
            }

            // The legacy >=90% projection cap is shadow-only. Hard rejection occurs only at
            // the emergency cutoff. Every shadow-band candidate may run under the monotonic
            // actual-byte guard; the bounded reservation ledger is telemetry, not admission.
            if (!rejected && sizeMetrics.projectedRatioPct > 0) {

                var sizeGateDecision = evaluateSizeGate(sizeMetrics.projectedRatioPct, {
                    legacyRatioPct: sizeGateLegacyPct,
                    emergencyRatioPct: sizeGateEmergencyPct,
                    deliveryRatioPct: sizeGateDeliveryPct,
                    forcedFullRemaining: sizeGateForcedFullRemaining
                });
                result.sizeGateDecision = sizeGateDecision;

                if (sizeGateDecision.action === 'reject') {

                    rejected = true;

                    rejectReason = sizeGateDecision.band === 'emergency'
                        ? 'Projected output ' + sizeMetrics.projectedRatioPct.toFixed(1)
                            + '% of source (>= ' + sizeGateEmergencyPct + '% emergency cutoff) - even worst-case'
                            + ' projection error cannot make this a beneficial re-encode'
                        : 'Projected output ' + sizeMetrics.projectedRatioPct.toFixed(1)
                            + '% of source (>= ' + sizeGateLegacyPct + '% legacy cap) - forced-full label budget'
                            + ' exhausted (' + sizeGateForcedFullUsed + '/' + sizeGateForcedFullCap + '), legacy gate in effect';

                } else if (sizeGateDecision.band === 'shadow') {

                    args.jobLog('SIZE-GATE SHADOW: ' + result.parameterSetId + ' projected '
                        + sizeMetrics.projectedRatioPct.toFixed(1) + '% would have been rejected by the retired '
                        + sizeGateLegacyPct + '% gate; full transcode allowed under the actual-byte guard'
                        + (sizeGateDecision.labelBudgetAvailable
                            ? ' (label budget remaining ' + sizeGateForcedFullRemaining + ')'
                            : ' (label budget exhausted or unavailable; admission unchanged)'));

                }

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
                reason: rejectReason,
                category: classifyToleranceRejection(rejectReason)
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

    // Expose rejection reasons to checkCQRangeRetry so retry direction can account for WHY
    // candidates were rejected (e.g. max-ratio "insufficient size benefit" makes lower-CQ
    // retries counterproductive - lower CQ only increases output size).
    args.variables.vmafRejectedResults = rejectedResults;

    if (validResults.length === 0) {

        args.variables.vmafPolicyGateOnlyBlock = aggregatedResults.length > 0 &&
            aggregatedResults.every(function (result) {
                return Boolean(result && result.vmafLowerPlausibilityRejection);
            });

        var retryCount = args.variables.vmafRetryCount || 0;

        var maxRetries = args.variables.vmafMaxRetries || 4;

        var testedCQs = args.variables.vmafTestedCQs || [];

        var encoderFloorMeasured = testedCQs.some(function (cq) {
            return isFinite(Number(cq)) && Number(cq) <= 16.5;
        }) || aggregatedResults.some(function (result) {
            var cq = measuredCandidateCQ(result);
            return cq !== null && cq <= 16.5;
        });

        // A CAMBI-only miss can have a useful measured answer now because the source
        // may itself exceed the prescribed tolerance. Oversize rejection is deliberately
        // non-overridable: keeping the source is always smaller than that candidate.
        // Actual VMAF/frame-floor misses still use the retry search, then ship the most
        // source-like technically complete measurement at the encoder floor/budget limit.
        var toleranceFallback = chooseMeasuredToleranceFallback(aggregatedResults, {
            targetVmaf: adjustedMinVMAF,
            frameFloor: adjustedMinFrameVMAF,
            rejectedResults: rejectedResults,
            terminal: false
        });
        if (!toleranceFallback && (retryCount >= maxRetries || encoderFloorMeasured)) {
            toleranceFallback = chooseMeasuredToleranceFallback(aggregatedResults, {
                targetVmaf: adjustedMinVMAF,
                frameFloor: adjustedMinFrameVMAF,
                rejectedResults: rejectedResults,
                terminal: true
            });
        }
        if (toleranceFallback) {
            var fallbackCQ = measuredCandidateCQ(toleranceFallback.result);
            validResults.push(toleranceFallback.result);
            args.variables.vmafToleranceFallbackActive = true;
            args.variables.vmafToleranceFallbackDegraded = true;
            args.variables.vmafToleranceFallbackMode = toleranceFallback.mode;
            args.variables.vmafToleranceFallbackReason = toleranceFallback.reason;
            args.variables.vmafToleranceFallbackCQ = fallbackCQ;
            args.variables.vmafTranscodeGaveUp = false;
            args.jobLog('');
            args.jobLog('⚠ ADVISORY LIMIT FALLBACK: no prescribed-limit candidate passed, but a technically complete measured encode is available.');
            args.jobLog('  Mode: ' + toleranceFallback.mode + '; selecting measured CQ ' + fallbackCQ
                + ' (VMAF ' + Number(toleranceFallback.result.avgVMAF).toFixed(2)
                + ', 1%-low ' + (measuredFrameFloor(toleranceFallback.result) !== null
                    ? measuredFrameFloor(toleranceFallback.result).toFixed(2) : 'n/a')
                + ', CAMBI ' + (measuredCambiRisk(toleranceFallback.result) !== null
                    ? measuredCambiRisk(toleranceFallback.result).toFixed(2) : 'n/a') + ').');
            args.jobLog('  Prescribed limit missed: ' + toleranceFallback.reason);
            args.jobLog('  Proceeding to transcode; technical, corruption, metadata, and final-output integrity checks remain authoritative.');
        }

        if (validResults.length === 0) {

        args.jobLog('');

        args.jobLog('ERROR: No parameter sets met quality thresholds');

        // ENHANCEMENT FIX #17: Get maxRetries from checkCQRangeRetry plugin config (if available)

        // Default to 2 if not set, but this should match checkCQRangeRetry's maxRetries input

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

        // Every entry in candidates has already passed the shared measured quality, auxiliary,
        // lower-size and emergency-size feasibility contract. Select the highest measured CQ.
        // The old LCB is retained as an uncertainty diagnostic only: these clips are deliberately
        // hardness-selected rather than a probability sample, and the independent holdout below
        // is the authoritative validation when the four-clip estimate is uncertain.

        selectionMethod = 'Shared-feasibility (highest fully measured CQ; LCB diagnostic, holdout authoritative)';

        var ranked = rankMeasuredCandidatesByCompression(candidates);

        for (var ci = 0; ci < ranked.length; ci++) {

            var cand = ranked[ci];

            var uncertainty = measuredCandidateUncertainty(cand, targetVMAF);

            var nSamp = uncertainty.sampleCount;

            var seC = uncertainty.standardError;

            var lcb = uncertainty.lcb;

            var floorStatC = (cand.vmafP1Low !== null && cand.vmafP1Low !== undefined && isFinite(cand.vmafP1Low))

                ? cand.vmafP1Low

                : ((cand.minVMAF !== null && cand.minVMAF !== undefined) ? cand.minVMAF : null);

            var lcbClear = uncertainty.clearsTarget;

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

                + (ci === 0 ? ' [selected-highest-feasible]' : '')
                + (lcbClear ? ' [LCB-clear]' : ' [LCB-uncertain: holdout required]')
                + (cand.avgCAMBI !== null && cand.avgCAMBI !== undefined

                    ? ' CAMBI_w=' + Math.max(Number(cand.avgCAMBI||0),Number(cand.p95CAMBI||0)).toFixed(3) : ''));

            if (!bestParams) {

                bestParams = cand;

                args.variables.vmafSelectionUncertainty = uncertainty;

                args.variables.vmafSelectionLcbClear = lcbClear;

            }

        }

        if (bestParams && args.variables.vmafSelectionLcbClear !== true) {
            args.jobLog('UNCERTAINTY ADVISORY: selected CQ ' + bestParams.parameterSet.quality
                + ' passed every measured constraint but its hardness-sample LCB crosses the target;'
                + ' this is not a title-wide confidence interval, so the independent holdout remains authoritative.');
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

    if (args.variables.vmafToleranceFallbackActive) {
        selectionMethod += ' + advisory measured fallback (' + args.variables.vmafToleranceFallbackMode + ')';
    }

    // Record the core sweep pick (CQ chosen by the strategy, incl. CAMBI tiebreak / SSIM veto)
    // before the post-selection guards (XPSNR / fractional / holdout / max-compression) run, so
    // the summary can show how the CQ moved from the sweep result to the final value.
    var rawStrategyCQ = (bestParams && bestParams.parameterSet && isFinite(Number(bestParams.parameterSet.quality)))
        ? Number(bestParams.parameterSet.quality) : null;

    if (bestParams) {

        // XPSNR second opinion on the winner. This duplicate synchronous decode is disabled
        // by default together with the uncalibrated default floor; it remains available
        // only when an operator explicitly configures an XPSNR floor for this contract.

        if (sharedXpsnrFloor !== null) {

        // XPSNR second opinion on the winner: a perceptually-weighted PSNR variant that

        // catches banding/chroma damage in flat and dark regions where VMAF over-scores.

        // Advisory below 34 dB min-channel; hard veto (step back one CQ) below 30 dB.

        try {

            var xpSpawnSync = require('child_process').spawnSync;

            var xpSamples = args.variables.vmafSamples || [];
            var xpTests = (args.variables.vmafTestResults || []).map(function(t) {
                if (!t || t.originalSamplePath) return t;
                return Object.assign({}, t, { originalSamplePath: xpSamples[t.sampleIndex] || null });
            }).filter(function(t) {

                return t && t.parameterSetId === bestParams.parameterSetId && t.outputPath && t.originalSamplePath;

            }).slice(0, 3);

            var xpMinDb = null;

            for (var xi = 0; xi < xpTests.length; xi++) {

                try {

                    // XPSNR prints its summary on stderr. Capture both streams
                    // directly instead of asking a shell to merge descriptors.
                    var xpRun = xpSpawnSync(args.ffmpegPath, buildXpsnrArgs(
                        xpTests[xi].outputPath, xpTests[xi].originalSamplePath,
                        bestParams.parameterSet && bestParams.parameterSet.encoder
                    ), {
                        encoding: 'utf8',
                        stdio: 'pipe',
                        timeout: 180000,
                        shell: false,
                        windowsHide: true,
                        maxBuffer: 16 * 1024 * 1024
                    });
                    if (xpRun.error) throw xpRun.error;
                    if (xpRun.status !== 0) {
                        throw new Error('XPSNR exited ' + xpRun.status + ': ' +
                            String(xpRun.stderr || xpRun.stdout || '').trim().slice(-1000));
                    }
                    var xpOut = String(xpRun.stdout || '') + '\n' + String(xpRun.stderr || '');

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

        }

        // Fractional CQ refinement is local to the measured boundary. Historical attested NVENC
        // pairs show that neighbouring tenths often produce different bytes and metrics, so do
        // not collapse this final refinement to an integer grid.

        // interpolate between the selected CQ and the next higher tested CQ to land just

        // above the VMAF target. Only ever moves toward MORE compression, with a noise-based

        // safety margin and a min-frame-VMAF guard.

        var preFractionalRefinementParams = bestParams;

        var nvencIntegerCqGrid = false;

        var primaryHoldoutEnabled = args.inputs.enableHoldoutValidation !== false
            && args.inputs.enableHoldoutValidation !== 'false';

        var primaryHoldoutAvailable = !!args.variables.vmafHoldoutSample && primaryHoldoutEnabled;

        // These variables survive CQ-range retries, but an override is authoritative only for
        // the current selection attempt. Reset before deriving any new prediction-only CQ.
        args.variables.vmafConstraintAwareCQApplied = false;
        args.variables.vmafConstraintAwareCQReverted = false;
        args.variables.vmafConstraintAwareCQValidated = false;
        args.variables.vmafConstraintAwareCQ = null;
        args.variables.vmafMaxCompressionApplied = false;
        args.variables.vmafInterpolatedCQ = null;
        args.variables.vmafInterpolatedFrom = null;
        args.variables.vmafInterpolatedCQRejected = null;
        args.variables.vmafInterpolatedCQReverted = false;

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

            if (!nvencIntegerCqGrid && !args.variables.vmafToleranceFallbackActive && primaryHoldoutAvailable
                && selPt && nextPt && selPt.vmaf > interpTarget && nextPt.vmaf < interpTarget && selPt.vmaf > nextPt.vmaf) {

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

                    setParameterSetCQ(interpParamSet, fracCq);

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

        // ── Adaptive-subsample telemetry guard (2026-07-21) ──
        // checkCQBracket's winner full-rate confirmation should ensure any frame-subsampled
        // (n>1) winner is re-measured at n=1 before selection whenever no reserved holdout will
        // validate it. Retry paths can bypass checkCQBracket, so count any leakage here: this is
        // observational only (job-report visible + jobLog), never changes the selection.
        try {
            if (bestParams && bestParams.parameterSet) {
                var _assWinnerCq = Number(bestParams.parameterSet.quality);
                var _assAgg = args.variables.vmafAggregatedResults || [];
                for (var _assI = 0; _assI < _assAgg.length; _assI++) {
                    var _assPs = _assAgg[_assI] && _assAgg[_assI].parameterSet;
                    if (_assPs && _assPs.quality !== undefined && Math.abs(Number(_assPs.quality) - _assWinnerCq) < 0.0001) {
                        var _assSub = Number(_assAgg[_assI].measurementSubsample);
                        if (isFinite(_assSub) && _assSub > 1 && !args.variables.vmafHoldoutSample) {
                            args.variables.vmafWinnerSubsampledUnconfirmed = true;
                            args.jobLog('⚠ Adaptive-subsample telemetry: winner CQ ' + _assWinnerCq
                                + ' was measured at n=' + _assSub + ' with no reserved holdout and no full-rate'
                                + ' re-measure (likely a retry-path bypass of checkCQBracket). Selection unchanged; counting for review.');
                        }
                        break;
                    }
                }
            }
        } catch (_assErr) { /* observational only */ }

        var holdoutFailReason = null;

        var holdoutSuggestedCQ = null;

        var holdoutShadowAssessment = null;

        var holdoutShadowActual = null;

        var holdoutShadowSelectedCQ = null;

        var holdoutTechnicalFailure = null;
        var holdoutPolicyFailure = null;

        args.variables.vmafHoldoutTechnicalFailure = null;
        args.variables.vmafAuthoritativeHoldoutOutcome = null;

        try {

            if (primaryHoldoutAvailable) {

                var ho = args.variables.vmafHoldoutSample;

                var chosenCQ = Number(bestParams.parameterSet ? bestParams.parameterSet.quality : bestParams.cq);

                holdoutShadowSelectedCQ = chosenCQ;

                if (args.inputs.holdoutSkipShadow !== false && args.inputs.holdoutSkipShadow !== 'false') {

                    var shadowCambiLimit = qualityRiskPolicy ? (qualityRiskPolicy.isHDR ? 5.0 : (qualityRiskPolicy.isAnimation ? 6.0 : 5.5)) : 5.5;

                    if (sourceCambiRisk !== null) shadowCambiLimit = Math.max(shadowCambiLimit, sourceCambiRisk + 1.0);

                    holdoutShadowAssessment = assessHoldoutSkipShadow(bestParams, {

                        meanFloor: adjustedMinVMAF,

                        frameFloor: adjustedMinFrameVMAF,

                        cambiLimit: shadowCambiLimit,

                        directlyMeasured: rawStrategyCQ !== null && Math.abs(chosenCQ - rawStrategyCQ) < 0.05,

                    });

                    args.variables.vmafHoldoutSkipShadow = holdoutShadowAssessment;

                    args.jobLog('Holdout skip shadow: would ' +

                        (holdoutShadowAssessment.predictedSafeToSkip ? 'SKIP' : 'RUN') +

                        ' (observation only; real holdout still runs)' +

                        (holdoutShadowAssessment.reasons.length ? ' reasons=' + holdoutShadowAssessment.reasons.join(',') : '') +

                        '; candidate-v2=' + (holdoutShadowAssessment.candidateV2Safe ? 'SKIP' : 'RUN') +

                        (holdoutShadowAssessment.candidateV2Reasons.length ?

                            ' reasons=' + holdoutShadowAssessment.candidateV2Reasons.join(',') : ''));

                }

                args.jobLog('');

                args.jobLog('=== Holdout Validation ===');

                args.jobLog('Holdout segment at ' + (Number(ho.startTime || 0)).toFixed(1) + 's - validating CQ ' + chosenCQ);

                var holdoutData = runVmafOnHoldout(args, ho, bestParams.parameterSet, qualityRiskPolicy);

                if (holdoutData) {

                    var primaryHoldoutMetrics = validateHoldoutMetrics(
                        holdoutData,
                        adjustedMinFrameVMAF,
                        { requireCambi: metricContract.cambi.required === true }
                    );

                    if (!primaryHoldoutMetrics.ok) {
                        throw new Error('primary holdout ' + primaryHoldoutMetrics.reason);
                    }

                    var hoV = primaryHoldoutMetrics.metrics.avgVMAF;

                    var hoP1 = primaryHoldoutMetrics.metrics.p1;

                    var hoCM = primaryHoldoutMetrics.metrics.cambiMean;

                    var hoCP = primaryHoldoutMetrics.metrics.cambiP95;

                    var hoCW = (hoCM !== null || hoCP !== null)
                        ? Math.max(hoCM !== null ? hoCM : -Infinity,
                            hoCP !== null ? hoCP : -Infinity)
                        : null;

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

                        + ', CAMBI=' + (hoCM !== null ? hoCM.toFixed(3) : 'n/a')
                        + ' (p95=' + (hoCP !== null ? hoCP.toFixed(3) : 'n/a') + ')'
                        + (isFinite(hoSrcCW) && hoCW !== null
                            ? ', srcCAMBI=' + hoSrcCW.toFixed(3) + ' (encode-delta=' + (hoCW - hoSrcCW).toFixed(3) + ')'
                            : ''));

                    var vmafOk = hoV >= meanFloor;

                    var floorOk = !(frameFloor > 0) || hoP1 >= frameFloor;

                    var cambiOk = hoCW === null || hoCW <= cambiLimit;

                    holdoutShadowActual = {

                        passed: vmafOk && floorOk && cambiOk,

                        vmaf: hoV,

                        p1: hoP1,

                        cambiRisk: hoCW,

                        meanMargin: hoV - meanFloor,

                        floorMargin: frameFloor > 0 ? hoP1 - frameFloor : null,

                        cambiMargin: hoCW === null ? null : cambiLimit - hoCW,

                    };
                    args.variables.vmafAuthoritativeHoldoutOutcome = {
                        passed: holdoutShadowActual.passed,
                        directlyMeasured: true,
                        selectedCQ: chosenCQ,
                        testedCQ: chosenCQ,
                        metricContractId: args.variables.vmafMetricContractId || null,
                        referenceContractId: args.variables.vmafReferenceContractId || null,
                        vmaf: hoV,
                        p1: hoP1,
                        cambiMean: hoCM,
                        cambiP95: hoCP,
                        sourceCambiMean: isFinite(hoSrcCM) ? hoSrcCM : null,
                        sourceCambiP95: isFinite(hoSrcCP) ? hoSrcCP : null,
                        margins: {
                            harmonic: holdoutShadowActual.meanMargin,
                            p1: holdoutShadowActual.floorMargin,
                            cambi: holdoutShadowActual.cambiMargin,
                        },
                    };

                    args.jobLog('  Floors: VMAF>=' + meanFloor.toFixed(1)

                        + ', 1%-low>=' + frameFloor.toFixed(1)

                        + ', CAMBI<=' + cambiLimit.toFixed(1)

                        + ' => ' + (vmafOk ? 'OK' : 'FAIL') + '/' + (floorOk ? 'OK' : 'FAIL') + '/'
                        + (hoCW === null ? 'N/A' : (cambiOk ? 'OK' : 'FAIL')));

                    args.variables.vmafHoldoutVMAF = hoV;

                    args.variables.vmafHoldoutP1VMAF = hoP1;

                    args.variables.vmafHoldoutCAMBI = hoCM;

                    args.variables.vmafHoldoutCAMBIP95 = hoCP;

                    if (!vmafOk || !floorOk || !cambiOk) {

                        holdoutFailReason = 'vmaf=' + vmafOk + ',floor=' + floorOk + ',cambi=' + cambiOk;
                        var saferCandidates = validResults.filter(function (candidate) {
                            return candidate && candidate.parameterSet &&
                                isFinite(Number(candidate.parameterSet.quality)) &&
                                Number(candidate.parameterSet.quality) < chosenCQ;
                        }).sort(function (left, right) {
                            return Number(right.parameterSet.quality) - Number(left.parameterSet.quality);
                        });
                        var fallbackAttempts = [];
                        var validatedSafer = null;
                        for (var sk = 0; sk < saferCandidates.length; sk++) {
                            var safer = saferCandidates[sk];
                            var saferCQ = Number(safer.parameterSet.quality);
                            args.jobLog('Holdout FAILED at CQ ' + chosenCQ +
                                ' - validating measured safer CQ ' + saferCQ + ' before selection.');
                            var saferData = runVmafOnHoldout(args, ho, safer.parameterSet, qualityRiskPolicy);
                            if (!saferData) {
                                fallbackAttempts.push({ cq: saferCQ, passed: false, reason: 'no_holdout_data' });
                                continue;
                            }
                            var saferMetrics = validateHoldoutMetrics(saferData, frameFloor,
                                { requireCambi: metricContract.cambi.required === true });
                            if (!saferMetrics.ok) {
                                fallbackAttempts.push({ cq: saferCQ, passed: false, reason: saferMetrics.reason });
                                continue;
                            }
                            var saferVmaf = saferMetrics.metrics.avgVMAF;
                            var saferP1 = saferMetrics.metrics.p1;
                            var saferCambiMean = saferMetrics.metrics.cambiMean;
                            var saferCambiP95 = saferMetrics.metrics.cambiP95;
                            var saferCambiRisk = (saferCambiMean !== null || saferCambiP95 !== null)
                                ? Math.max(saferCambiMean !== null ? saferCambiMean : -Infinity,
                                    saferCambiP95 !== null ? saferCambiP95 : -Infinity) : null;
                            var saferSourceMean = Number(saferData.srcCambiMean);
                            var saferSourceP95 = Number(saferData.srcCambiP95);
                            var saferSourceRisk = Math.max(isFinite(saferSourceMean) ? saferSourceMean : -Infinity,
                                isFinite(saferSourceP95) ? saferSourceP95 : -Infinity);
                            var saferCambiLimit = cambiLimit;
                            if (isFinite(saferSourceRisk)) saferCambiLimit = Math.max(saferCambiLimit, saferSourceRisk + 1.0);
                            var saferPassed = saferVmaf >= meanFloor &&
                                (!(frameFloor > 0) || saferP1 >= frameFloor) &&
                                (saferCambiRisk === null || saferCambiRisk <= saferCambiLimit);
                            fallbackAttempts.push({
                                cq: saferCQ,
                                passed: saferPassed,
                                vmaf: saferVmaf,
                                p1: saferP1,
                                cambiRisk: saferCambiRisk
                            });
                            args.jobLog('Safer-CQ holdout: CQ ' + saferCQ + ', VMAF=' + saferVmaf.toFixed(2) +
                                ', 1%-low=' + saferP1.toFixed(2) + ', CAMBI=' +
                                (saferCambiRisk === null ? 'n/a' : saferCambiRisk.toFixed(3)) +
                                ' => ' + (saferPassed ? 'PASS' : 'FAIL'));
                            if (!saferPassed) continue;
                            validatedSafer = safer;
                            holdoutSuggestedCQ = saferCQ;
                            bestParams = safer;
                            args.variables.vmafHoldoutVMAF = saferVmaf;
                            args.variables.vmafHoldoutP1VMAF = saferP1;
                            args.variables.vmafHoldoutCAMBI = saferCambiMean;
                            args.variables.vmafHoldoutCAMBIP95 = saferCambiP95;
                            args.variables.vmafAuthoritativeHoldoutOutcome = {
                                passed: true,
                                directlyMeasured: true,
                                selectedCQ: saferCQ,
                                testedCQ: saferCQ,
                                primaryFailedCQ: chosenCQ,
                                fallbackAttempts: fallbackAttempts,
                                metricContractId: args.variables.vmafMetricContractId || null,
                                referenceContractId: args.variables.vmafReferenceContractId || null,
                                vmaf: saferVmaf,
                                p1: saferP1,
                                cambiMean: saferCambiMean,
                                cambiP95: saferCambiP95
                            };
                            args.jobLog('Holdout fallback PASSED at measured CQ ' + saferCQ + '.');
                            break;
                        }
                        if (!validatedSafer) {
                            holdoutPolicyFailure = 'selected CQ failed the authoritative holdout and no measured lower CQ passed';
                            args.variables.vmafAuthoritativeHoldoutOutcome = {
                                passed: false,
                                directlyMeasured: true,
                                selectedCQ: chosenCQ,
                                testedCQ: chosenCQ,
                                fallbackAttempts: fallbackAttempts,
                                metricContractId: args.variables.vmafMetricContractId || null,
                                referenceContractId: args.variables.vmafReferenceContractId || null,
                                vmaf: hoV,
                                p1: hoP1,
                                cambiMean: hoCM,
                                cambiP95: hoCP,
                                reason: holdoutPolicyFailure
                            };
                            args.jobLog('Holdout FAILED CLOSED: ' + holdoutPolicyFailure + '.');
                        }

                    } else {

                        args.jobLog('Holdout PASSED');

                    }

                } else {

                    holdoutTechnicalFailure = 'holdout returned no VMAF data';

                    holdoutFailReason = 'holdout_unavailable';

                    args.variables.vmafHoldoutTechnicalFailure = holdoutTechnicalFailure;

                    var noDataFallback = revertPredictionOnlyFractionalSelection(
                        args.variables, bestParams, preFractionalRefinementParams);

                    bestParams = noDataFallback.bestParams;

                    if (noDataFallback.reverted) holdoutSuggestedCQ = noDataFallback.cq;

                    args.jobLog('Holdout returned no VMAF data - '
                        + (noDataFallback.reverted ? 'reverting prediction-only fractional CQ to fresh measured CQ '
                            + noDataFallback.cq : 'retaining the fresh measured CQ')
                        + '; fractional override disabled');

                }

            } else {

                var skippedHoldoutFallback = revertPredictionOnlyFractionalSelection(
                    args.variables, bestParams, preFractionalRefinementParams);

                bestParams = skippedHoldoutFallback.bestParams;

                if (skippedHoldoutFallback.reverted) {
                    holdoutFailReason = 'holdout_unavailable';
                    holdoutSuggestedCQ = skippedHoldoutFallback.cq;
                    args.jobLog('Holdout validation unavailable - reverting prediction-only fractional CQ to fresh measured CQ '
                        + skippedHoldoutFallback.cq);
                }

                args.jobLog('Holdout validation skipped: no reserved holdout sample available');

            }

        } catch (hoErr) {

            holdoutTechnicalFailure = hoErr && hoErr.message ? hoErr.message : String(hoErr);

            holdoutFailReason = 'holdout_technical_error';

            args.variables.vmafHoldoutTechnicalFailure = holdoutTechnicalFailure;

            var errorFallback = revertPredictionOnlyFractionalSelection(
                args.variables, bestParams, preFractionalRefinementParams);

            bestParams = errorFallback.bestParams;

            if (errorFallback.reverted) holdoutSuggestedCQ = errorFallback.cq;

            args.jobLog('Holdout validation technical error - '
                + (errorFallback.reverted ? 'reverting prediction-only fractional CQ to fresh measured CQ '
                    + errorFallback.cq : 'retaining the fresh measured CQ')
                + '; fractional override disabled: ' + holdoutTechnicalFailure);

        }

        if (holdoutPolicyFailure) {
            args.variables.vmafBestParameters = null;
            delete args.variables.vmafSelectionHandoff;
            args.variables.vmafSelectionStatus = 'holdout_failed_no_validated_fallback';
            args.variables.vmafSelectOutput = 2;
            args.variables.vmafHoldoutFailReason = holdoutPolicyFailure;
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 2,
                variables: args.variables
            };
        }

        if (holdoutShadowAssessment) {

            var holdoutShadowRecord = {

                schema: 2,

                timestamp: new Date().toISOString(),

                jobId: args.variables.vmafCanonicalJobId || args.variables.vmafJobId || args.variables.vmafRunId || null,

                tier: args.variables.vmafTier || null,

                selectedCQ: holdoutShadowSelectedCQ,

                rawStrategyCQ: rawStrategyCQ,

                predictedSafeToSkip: holdoutShadowAssessment.predictedSafeToSkip,

                prediction: holdoutShadowAssessment,

                actual: holdoutShadowActual,

                falseSafe: holdoutShadowAssessment.predictedSafeToSkip === true &&

                    holdoutShadowActual !== null && holdoutShadowActual.passed === false,

                candidateV2Safe: holdoutShadowAssessment.candidateV2Safe === true,

                candidateV2FalseSafe: holdoutShadowAssessment.candidateV2Safe === true &&

                    holdoutShadowActual !== null && holdoutShadowActual.passed === false,

                action: 'shadow_only_holdout_always_ran',

            };

            args.variables.vmafHoldoutSkipShadowOutcome = holdoutShadowRecord;

            appendHoldoutShadowRecord(args, holdoutShadowRecord);

        }

        args.variables.vmafHoldoutFailReason = holdoutFailReason;

        args.variables.vmafHoldoutSuggestedCQ = holdoutSuggestedCQ;

        // ── ACTING: constraint-aware CQ selector. Uses the SAME measured per-job curve
        // (harmonic VMAF + 1%-low + CAMBI p95) but interpolates on a 0.1 CQ grid, so we can land
        // just below the binding constraint instead of falling all the way back to the previous
        // measured CQ. This replaces the old shadow-only selectCQ path.
        try {
            var _vp = require('/custom-cont-init.d/.vmaf-plugin-patches/_lib/vmafpredict.js');
            var _agg = args.variables.vmafAggregatedResults || [];
            var _curve = [];
            for (var _ai = 0; _ai < _agg.length; _ai++) {
                var _a = _agg[_ai], _ps = _a.parameterSet || {};
                var _cq = Number(_ps.cq != null ? _ps.cq : _ps.quality);
                if (!isFinite(_cq)) continue;
                _curve.push({
                    cq: _cq,
                    vmaf_harmonic_mean: _a.avgVMAF != null ? Number(_a.avgVMAF) : null,
                    vmaf_mean: _a.avgVMAFMean != null ? Number(_a.avgVMAFMean) : (Number(_a.avgVMAF) || null),
                    vmaf_p1_low: _a.vmafP1Low != null ? Number(_a.vmafP1Low) : null,
                    cambi_p95: _a.p95CAMBI != null ? Number(_a.p95CAMBI) : null,
                    avg_size_mb: Number(_a.avgFileSizeMB) || null,
                    ssim: _a.avgSSIM != null ? Number(_a.avgSSIM) : null,
                    xpsnr: _a.minXPSNR != null ? Number(_a.minXPSNR) : null,
                    ssimulacra2: _a.ssimulacra2 != null ? Number(_a.ssimulacra2) : null,
                    ssimulacra2_p5: _a.ssimulacra2P5 != null ? Number(_a.ssimulacra2P5) : null,
                    butteraugli: _a.butteraugliNormInf != null ? Number(_a.butteraugliNormInf) : null,
                    cvvdp: _a.cvvdp != null ? Number(_a.cvvdp) : null,
                    projected_output_ratio_pct: _a.projectedOutputRatioPct != null
                        ? Number(_a.projectedOutputRatioPct) : null,
                    projected_output_bpp: _a.projectedOutputBpp != null
                        ? Number(_a.projectedOutputBpp) : null,
                    projected_output_mbps: _a.projectedOutputMbps != null
                        ? Number(_a.projectedOutputMbps) : null,
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
            var _cambiBase = metricContract.cambi.required === true
                ? (args.variables.isHDR ? 5.0 : (args.variables.vmafMediaIsAnimation === true ? 6.0 : 5.5))
                : null;
            var _effCambi = _vp.effectiveCambiFloor({ cambiFloor: _cambiBase, sourceCambi: args.variables.vmafSourceCAMBI, sourceCambiP95: args.variables.vmafSourceCAMBIP95 });
            var _predictConstraints = {
                targetVmaf: _tgt, vmafFloor: _floor, cambiFloor: _cambiBase,
                sourceCambi: args.variables.vmafSourceCAMBI, sourceCambiP95: args.variables.vmafSourceCAMBIP95,
                ssimFloor: sharedSsimFloor, xpsnrFloor: sharedXpsnrFloor,
                ssimulacra2Floor: sharedSsimulacra2Floor,
                ssimulacra2P5Floor: sharedSsimulacra2P5Floor,
                butteraugliCeiling: sharedButteraugliCeiling, cvvdpFloor: sharedCvvdpFloor,
                minOutputRatioPct: qualityRiskPolicy.minOutputRatioPct,
                minOutputBpp: qualityRiskPolicy.minOutputBpp,
                maxOutputRatioPct: sizeGateEmergencyPct
            };
            var _predictOptions = {
                minSupport: 0.05,
                cqBandwidth: 1.5,
                cqStep: nvencIntegerCqGrid ? 1 : 0.1,
            };
            var _rawSel = _vp.selectCQ(_curve, {}, _predictConstraints, _predictOptions);
            var _measuredBracket = measuredConstraintBracket(
                _agg, sharedQualityPolicy, feasibility.evaluate);
            var _sel = _rawSel;
            var _predictionMaxCq = null;
            if (finiteNumber(_measuredBracket.firstRejectedAbove) !== null) {
                _predictionMaxCq = Math.round((Number(_measuredBracket.firstRejectedAbove)
                    - _predictOptions.cqStep) * 10) / 10;
                if (finiteNumber(_rawSel.cq) !== null && Number(_rawSel.cq) > _predictionMaxCq) {
                    _sel = _vp.selectCQ(_curve, {}, _predictConstraints,
                        Object.assign({}, _predictOptions, { maxCq: _predictionMaxCq }));
                    args.jobLog('[ACTING] Constraint-aware raw pick ' + Number(_rawSel.cq).toFixed(1)
                        + ' was clipped to the measured bracket below rejected CQ '
                        + Number(_measuredBracket.firstRejectedAbove).toFixed(1)
                        + '; bounded prediction=' + (_sel.cq != null ? Number(_sel.cq).toFixed(1) : 'none') + '.');
                }
            }
            var _liveCq = (bestParams.parameterSet && (bestParams.parameterSet.cq != null ? bestParams.parameterSet.cq : bestParams.parameterSet.quality));
            args.jobLog('[ACTING] constraint-aware selectCQ pick=' + (_sel.cq != null ? _sel.cq : 'none')
                + ' (binding=' + _sel.bindingConstraint + ', predVMAF=' + (_sel.predictedVmaf != null ? _sel.predictedVmaf.toFixed(2) : 'n/a')
                + ', pred1%low=' + (_sel.predictedP1Low != null ? _sel.predictedP1Low.toFixed(2) : 'n/a')
                + ', predCAMBI_p95=' + (_sel.predictedCambi != null ? _sel.predictedCambi.toFixed(2) : 'n/a')
                + ', predSSIMULACRA2=' + (_sel.predictedSsimulacra2 != null ? _sel.predictedSsimulacra2.toFixed(2) : 'n/a')
                + ', predSSIMULACRA2_p5=' + (_sel.predictedSsimulacra2P5 != null ? _sel.predictedSsimulacra2P5.toFixed(2) : 'n/a')
                + ', predCVVDP=' + (_sel.predictedCvvdp != null ? _sel.predictedCvvdp.toFixed(3) : 'n/a')
                + ', predRatio=' + (_sel.predictedOutputRatioPct != null ? _sel.predictedOutputRatioPct.toFixed(1) + '%' : 'n/a')
                + ', predBPP=' + (_sel.predictedOutputBpp != null ? _sel.predictedOutputBpp.toFixed(4) : 'n/a')
                + ', effCambiFloor=' + (_effCambi != null ? _effCambi.toFixed(2) : 'n/a')
                + ') vs measured-core pick CQ=' + _liveCq);

            var _fractionalHoldoutAvailable = primaryHoldoutAvailable && !holdoutTechnicalFailure;
            var _fractionalWouldHarden = finiteNumber(_sel.cq) !== null && finiteNumber(_liveCq) !== null
                && Number(_sel.cq) > Number(_liveCq) + 0.05;
            if (_fractionalWouldHarden && !_fractionalHoldoutAvailable) {
                args.jobLog('[ACTING] Constraint-aware fractional CQ ' + Number(_sel.cq).toFixed(1)
                    + ' is prediction-only and no enabled holdout is available; retaining fresh measured CQ ' + _liveCq + '.');
            }
            var _bindingAuthority = assessMeasuredBindingAuthority(_agg, _sel.cq, sharedQualityPolicy,
                feasibility.evaluate);
            if (_fractionalWouldHarden && !_bindingAuthority.allowed) {
                args.jobLog('[ACTING] Constraint-aware CQ ' + Number(_sel.cq).toFixed(1)
                    + ' remains prediction-only and cannot override measured CQ ' + _liveCq
                    + ': ' + _bindingAuthority.reason + '.');
            }
            if (!nvencIntegerCqGrid
                && !args.variables.vmafToleranceFallbackActive
                && _bindingAuthority.allowed
                && shouldApplyFractionalOverride(_sel.cq, _liveCq, _fractionalHoldoutAvailable)) {
                var _preSelectParams = bestParams;
                var _newCq = Math.round(Number(_sel.cq) * 10) / 10;
                var _paramSet = {};
                for (var _pk in bestParams.parameterSet) {
                    if (Object.prototype.hasOwnProperty.call(bestParams.parameterSet, _pk)) _paramSet[_pk] = bestParams.parameterSet[_pk];
                }
                setParameterSetCQ(_paramSet, _newCq);
                _paramSet.id = String(bestParams.parameterSet.id || bestParams.parameterSetId || 'sel') + '_cqa' + _newCq;
                var _predV = _sel.predictedVmaf != null ? Number(_sel.predictedVmaf) : _metricAt(_newCq, function(x) { return x.avgVMAF; });
                var _predMean = _metricAt(_newCq, function(x) { return x.avgVMAFMean; });
                var _predP1 = _sel.predictedP1Low != null ? Number(_sel.predictedP1Low) : _metricAt(_newCq, function(x) { return x.vmafP1Low; });
                var _predP95Cambi = _sel.predictedCambi != null ? Number(_sel.predictedCambi) : _metricAt(_newCq, function(x) { return x.p95CAMBI; });
                var _predAvgCambi = _metricAt(_newCq, function(x) { return x.avgCAMBI; });
                var _predSize = _sel.predictedSizeMb != null ? Number(_sel.predictedSizeMb) : _metricAt(_newCq, function(x) { return x.avgFileSizeMB; });
                var _predSSIM = _metricAt(_newCq, function(x) { return x.avgSSIM; });
                var _predXpsnr = _sel.predictedXpsnr != null ? Number(_sel.predictedXpsnr) : _metricAt(_newCq, function(x) { return x.minXPSNR; });
                var _predSsimulacra2 = _sel.predictedSsimulacra2 != null ? Number(_sel.predictedSsimulacra2) : _metricAt(_newCq, function(x) { return x.ssimulacra2; });
                var _predSsimulacra2P5 = _sel.predictedSsimulacra2P5 != null ? Number(_sel.predictedSsimulacra2P5) : _metricAt(_newCq, function(x) { return x.ssimulacra2P5; });
                var _predButteraugli = _sel.predictedButteraugli != null ? Number(_sel.predictedButteraugli) : _metricAt(_newCq, function(x) { return x.butteraugliNormInf; });
                var _predCvvdp = _sel.predictedCvvdp != null ? Number(_sel.predictedCvvdp) : _metricAt(_newCq, function(x) { return x.cvvdp; });
                bestParams = Object.assign({}, bestParams, {
                    parameterSet: _paramSet,
                    parameterSetId: _paramSet.id,
                    avgVMAF: _predV != null ? _predV : bestParams.avgVMAF,
                    avgVMAFMean: _predMean != null ? _predMean : bestParams.avgVMAFMean,
                    minVMAF: _predP1 != null ? _predP1 : bestParams.minVMAF,
                    vmafP1Low: _predP1 != null ? _predP1 : bestParams.vmafP1Low,
                    avgCAMBI: _predAvgCambi != null ? _predAvgCambi : bestParams.avgCAMBI,
                    p95CAMBI: _predP95Cambi != null ? _predP95Cambi : bestParams.p95CAMBI,
                    avgFileSizeMB: _predSize != null ? _predSize : bestParams.avgFileSizeMB,
                    avgSSIM: _predSSIM != null ? _predSSIM : bestParams.avgSSIM,
                    minXPSNR: _predXpsnr != null ? _predXpsnr : bestParams.minXPSNR,
                    ssimulacra2: _predSsimulacra2 != null ? _predSsimulacra2 : bestParams.ssimulacra2,
                    ssimulacra2P5: _predSsimulacra2P5 != null ? _predSsimulacra2P5 : bestParams.ssimulacra2P5,
                    butteraugliNormInf: _predButteraugli != null ? _predButteraugli : bestParams.butteraugliNormInf,
                    cvvdp: _predCvvdp != null ? _predCvvdp : bestParams.cvvdp,
                    vmafConstraintAware: true
                });
                args.variables.vmafConstraintAwareCQApplied = true;
                args.variables.vmafConstraintAwareCQ = _newCq;
                args.variables.vmafConstraintAwareCQValidated = false;
                args.jobLog('[ACTING] Provisional constraint-aware CQ override: CQ ' + _liveCq + ' -> ' + _newCq
                    + ' (pred VMAF=' + (bestParams.avgVMAF != null ? bestParams.avgVMAF.toFixed(2) : 'n/a')
                    + ', pred 1%-low=' + (bestParams.vmafP1Low != null ? bestParams.vmafP1Low.toFixed(2) : 'n/a')
                    + ', pred CAMBI_p95=' + (bestParams.p95CAMBI != null ? bestParams.p95CAMBI.toFixed(2) : 'n/a') + ')');

                // Re-run holdout against the harder fractional CQ. The earlier holdout validated
                // the measured-core CQ; this validates the CQ that will actually be transcoded.
                if (_fractionalHoldoutAvailable) {
                    var _ho2 = args.variables.vmafHoldoutSample;
                    args.jobLog('');
                    args.jobLog('=== Constraint-aware Holdout Validation ===');
                    args.jobLog('Holdout segment at ' + (Number(_ho2.startTime || 0)).toFixed(1) + 's - validating CQ ' + _newCq);
                    var _hd2 = runVmafOnHoldout(args, _ho2, bestParams.parameterSet, qualityRiskPolicy);
                    if (_hd2) {
                        var _validated2 = validateHoldoutMetrics(
                            _hd2,
                            _floor,
                            { requireCambi: metricContract.cambi.required === true }
                        );
                        if (!_validated2.ok) {
                            throw new Error('constraint-aware holdout ' + _validated2.reason);
                        }
                        var _hv2 = _validated2.metrics.avgVMAF;
                        var _hp12 = _validated2.metrics.p1;
                        var _hcm2 = _validated2.metrics.cambiMean;
                        var _hcp2 = _validated2.metrics.cambiP95;
                        var _hcw2 = (_hcm2 !== null || _hcp2 !== null)
                            ? Math.max(_hcm2 !== null ? _hcm2 : -Infinity,
                                _hcp2 !== null ? _hcp2 : -Infinity)
                            : null;
                        var _hsCM2 = Number(_hd2.srcCambiMean), _hsCP2 = Number(_hd2.srcCambiP95);
                        var _hsCW2 = Math.max(isFinite(_hsCM2) ? _hsCM2 : -Infinity, isFinite(_hsCP2) ? _hsCP2 : -Infinity);
                        var _lim2 = _effCambi;
                        if (isFinite(_hsCW2)) _lim2 = Math.max(_lim2, _hsCW2 + 1.0);
                        args.jobLog('Constraint-aware holdout: VMAF=' + _hv2.toFixed(2)
                            + ', 1%-low=' + _hp12.toFixed(2)
                            + ', CAMBI=' + (_hcm2 !== null ? _hcm2.toFixed(3) : 'n/a')
                            + ' (p95=' + (_hcp2 !== null ? _hcp2.toFixed(3) : 'n/a') + ')'
                            + (isFinite(_hsCW2) && _hcw2 !== null
                                ? ', srcCAMBI=' + _hsCW2.toFixed(3) + ' (encode-delta=' + (_hcw2 - _hsCW2).toFixed(3) + ')'
                                : ''));
                        var _ok2 = (_hv2 >= _tgt) && (_floor == null || _hp12 >= _floor)
                            && (_hcw2 === null || _lim2 == null || _hcw2 <= _lim2);
                        args.jobLog(' Floors: VMAF>=' + _tgt.toFixed(1)
                            + ', 1%-low>=' + (_floor != null ? _floor.toFixed(1) : 'n/a')
                            + ', CAMBI<=' + (_lim2 != null ? _lim2.toFixed(1) : 'n/a')
                            + ' => ' + (_hv2 >= _tgt ? 'OK' : 'FAIL') + '/'
                            + ((_floor == null || _hp12 >= _floor) ? 'OK' : 'FAIL') + '/'
                            + (_hcw2 === null ? 'N/A' : ((_lim2 == null || _hcw2 <= _lim2) ? 'OK' : 'FAIL')));
                        if (!_ok2) {
                            holdoutFailReason = 'constraint_aware_holdout_failed';
                            holdoutSuggestedCQ = Number(_preSelectParams.parameterSet.quality);
                            bestParams = _preSelectParams;
                            args.variables.vmafConstraintAwareCQApplied = false;
                            args.variables.vmafConstraintAwareCQReverted = true;
                            args.variables.vmafConstraintAwareCQValidated = false;
                            args.variables.vmafMaxCompressionApplied = false;
                            args.variables.vmafHoldoutFailReason = holdoutFailReason;
                            args.variables.vmafHoldoutSuggestedCQ = holdoutSuggestedCQ;
                            args.jobLog('Constraint-aware holdout FAILED - reverting to measured CQ ' + holdoutSuggestedCQ);
                        } else {
                            args.variables.vmafConstraintAwareCQValidated = true;
                            args.variables.vmafMaxCompressionApplied = true;
                            args.variables.vmafAuthoritativeHoldoutOutcome = {
                                passed: true,
                                directlyMeasured: true,
                                selectedCQ: _newCq,
                                testedCQ: _newCq,
                                metricContractId: args.variables.vmafMetricContractId || null,
                                referenceContractId: args.variables.vmafReferenceContractId || null,
                                vmaf: _hv2,
                                p1: _hp12,
                                cambiMean: _hcm2,
                                cambiP95: _hcp2,
                                sourceCambiMean: isFinite(_hsCM2) ? _hsCM2 : null,
                                sourceCambiP95: isFinite(_hsCP2) ? _hsCP2 : null
                            };
                            selectionMethod += ' + constraint-aware fractional selectCQ';
                            args.jobLog('Constraint-aware holdout PASSED');
                        }
                    } else {
                        holdoutFailReason = 'constraint_aware_holdout_unavailable';
                        holdoutSuggestedCQ = Number(_preSelectParams.parameterSet.quality);
                        bestParams = _preSelectParams;
                        args.variables.vmafConstraintAwareCQApplied = false;
                        args.variables.vmafConstraintAwareCQReverted = true;
                        args.variables.vmafConstraintAwareCQValidated = false;
                        args.variables.vmafMaxCompressionApplied = false;
                        args.variables.vmafHoldoutFailReason = holdoutFailReason;
                        args.variables.vmafHoldoutSuggestedCQ = holdoutSuggestedCQ;
                        args.jobLog('Constraint-aware holdout returned no VMAF data - reverting to fresh measured CQ ' + holdoutSuggestedCQ);
                    }
                }
            }
        } catch (_acErr) {
            var _acFallback = markConstraintAwareHoldoutTechnicalFailure(args.variables, _preSelectParams, _acErr);
            if (_acFallback && args.variables.vmafConstraintAwareCQApplied === false) {
                bestParams = _acFallback.bestParams;
                holdoutFailReason = 'constraint_aware_holdout_technical_error';
                holdoutSuggestedCQ = _acFallback.cq;
                args.jobLog('[ACTING] Constraint-aware holdout technical error - reverting to fresh measured CQ '
                    + _acFallback.cq + ': ' + _acFallback.message);
            } else {
                args.jobLog('[ACTING] constraint-aware selectCQ skipped (non-fatal): ' + (_acErr && _acErr.message ? _acErr.message : String(_acErr)));
            }
        }

        // Validate the exact downstream handoff now, but do not publish it yet.
        // All remaining report/invariant work runs before a finite forced-full
        // slot is consumed.
        var finalSelectionContract = validateFinalSelection(bestParams);

        args.variables.vmafBestVMAF = bestParams.avgVMAF;

        args.variables.vmafBestMinVMAF = bestParams.minVMAF;

        args.variables.vmafBestSSIM = (bestParams.avgSSIM !== null && bestParams.avgSSIM !== undefined) ? bestParams.avgSSIM : null;

        args.variables.vmafBestSize = bestParams.avgFileSizeMB;

        args.variables.vmafStrategy = strategy;

        args.variables.vmafMinVMAF = minVMAF;

        args.variables.vmafConfiguredMinFrameVMAF = minFrameVMAF;

        // Downstream holdout/retry/shadow paths must consume the same effective adaptive floor
        // that selected the CQ. Preserve the configured value separately for audit/UI display.
        args.variables.vmafMinFrameVMAF = adjustedMinFrameVMAF;

        args.variables.vmafSelectionMethod = selectionMethod;

        args.variables.vmafRecommendedPixFmt = recommendedPixFmt;

        // FFmpeg av1_nvenc remains the bounded sample frontend while direct
        // NVEncC owns full delivery. Record that bridge as an explicit selector
        // correction instead of leaving the backend boundary implicit.
        encoderDomainBridge = publishEncoderDomainBridge(
            args.variables, bestParams.parameterSet, measuredPixFmt,
            recommendedPixFmt, finalSelectionContract.cq);
        if (encoderDomainBridge) {
            args.jobLog('Encoder-domain correction: FFmpeg av1_nvenc measurement -> direct NVEncC ' +
                'delivery; CQ offset 0, both normalized to ' + recommendedDepth + '-bit ' +
                recommendedPixFmt + ', with fail-closed delivered-depth validation (' +
                encoderDomainBridge.contract_id + ').');
        }

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

        // Preserve the already-verified metric identity for downstream retry
        // loops. Never silently substitute the standard model for missing 4K
        // data: those scores are not threshold-equivalent.

        if (!metricContract) {
            throw new Error('selection completed without an established VMAF metric contract');
        }
        var vmafModelPath = metricContract.modelPath;

        args.variables.vmafModelPath = vmafModelPath;

        args.jobLog('  VMAF model: ' + metricContract.modelName + ' for ' + sourceWidth + 'x' + sourceHeight +
            ' (' + metricContract.metricContractId + ')');

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

            metric_contract_id: metricContract.metricContractId,

            encoder_profile_id: metricContract.encoderProfileId,

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


        // ── SHADOW ONLY: final-size failure pre-skip model ──
        // Scores whether the final encode is likely to be cancelled / marked "transcode not required"
        // by the live size guard. This is instrumentation only: it logs and appends JSONL, but never
        // changes outputNumber or skips the transcode.
        try {
            function _tierForShadow(w, h) {
                w = Number(w) || 0; h = Number(h) || 0;
                var maxDim = Math.max(w, h);
                if (maxDim >= 3840) return '2160p';
                if (maxDim >= 1920) return '1080p';
                if (maxDim >= 1280) return '720p';
                return 'SD';
            }
            var _sizeShadow = require('/custom-cont-init.d/.vmaf-plugin-patches/_lib/sizeFailureShadow.js');
            var _shadowFeatures = {
                // Runtime sometimes cannot derive source bitrate/BPP before the selected-CQ stage.
                // Zero is outside the training distribution and must mean missing so the exported
                // preprocessing pipeline applies the same median imputation used in training.
                bits_per_pixel: Number(bitsPerPixel) > 0 ? Number(bitsPerPixel) : null,
                source_bitrate_mbps: Number(sourceBitrateMbps) > 0 ? Number(sourceBitrateMbps) : null,
                bit_depth: is10BitSource ? 10 : 8,
                is_hdr: isHDR ? 1 : 0,
                media_is_animation: args.variables.vmafMediaIsAnimation === true ? 1 : 0,
                media_year: Number(args.variables.vmafMediaYear) || null,
                source_cambi: args.variables.vmafSourceCAMBI != null ? Number(args.variables.vmafSourceCAMBI) : null,
                grain: args.variables.vmafSourceGrain != null ? Number(args.variables.vmafSourceGrain) : null,
                spatial_info: args.variables.vmafSourceSI != null ? Number(args.variables.vmafSourceSI) : null,
                temporal_info: args.variables.vmafSourceTI != null ? Number(args.variables.vmafSourceTI) : null,
                dark_fraction: args.variables.vmafSourceDarkFrac != null ? Number(args.variables.vmafSourceDarkFrac) : null,
                luma_avg: args.variables.vmafSourceLumaAvg != null ? Number(args.variables.vmafSourceLumaAvg) : null,
                selected_cq: bestParams.parameterSet.quality,
                selected_vmaf: bestParams.avgVMAF,
                selected_vmaf_min: bestParams.vmafP1Low != null ? bestParams.vmafP1Low : bestParams.minVMAF,
                selected_cambi: bestParams.avgCAMBI !== undefined ? bestParams.avgCAMBI : null,
                selected_size_mb: bestParams.avgFileSizeMB,
                source_file_size_mb: sourceFileSizeMB,
                projected_output_ratio_pct: bestParams.projectedOutputRatioPct !== undefined ? bestParams.projectedOutputRatioPct : null,
                projected_size_reduction_pct: bestParams.projectedOutputRatioPct !== undefined ? (100 - Number(bestParams.projectedOutputRatioPct)) : null,
                source_width: sourceWidth,
                source_height: sourceHeight,
                source_duration_sec: sourceDuration,
                cq_range_retry_count: Number(args.variables.vmafRetryCount) || 0,
                total_retries: (Number(args.variables.vmafRetryCount) || 0) + (Number(args.variables.vmafTranscodeRetryCount) || 0),
                tier: _tierForShadow(sourceWidth, sourceHeight),
                source_codec: sourceCodec,
                media_genre: Array.isArray(args.variables.vmafMediaGenre) ? args.variables.vmafMediaGenre.join(', ') : (args.variables.vmafMediaGenre || ''),
                media_type: args.variables.vmafMediaType || 'unknown',
                media_title: args.variables.vmafSeriesTitle || null,
                release_group: releaseGroup || null,
                network: args.variables.vmafNetwork || null,
                original_language: args.variables.vmafOriginalLanguage || null,
                media_source_type: mediaSourceType || 'unknown'
            };
            var _shadow = _sizeShadow.predictProbability(_shadowFeatures);
            var _sizeShadowJobId = args.variables.vmafCanonicalJobId || args.variables.vmafJobId || args.variables.vmafRunId || null;
            var _sizeShadowPredictionId = String(_sizeShadowJobId || 'unknown') +
                ':cq' + String(_shadowFeatures.selected_cq) + ':' + String(Date.now());
            var _sizeShadowPrediction = {
                schema: 2,
                event: 'prediction',
                prediction_id: _sizeShadowPredictionId,
                ts: new Date().toISOString(),
                job_id: _sizeShadowJobId,
                file_path: args.inputFileObj && (args.inputFileObj._id || args.inputFileObj.file || null),
                selected_cq: _shadowFeatures.selected_cq,
                probability: _shadow.probability,
                would_skip_095: _shadow.would_skip_candidate,
                would_skip_098: _shadow.would_skip_conservative,
                model_schema: _shadow.model_schema,
                model_hash_sha256: _shadow.model_hash_sha256,
                model_trained_at: _shadow.model_trained_at,
                model_rows: _shadow.model_rows,
                pipeline_version: 'size-shadow-prospective-label-v2',
                features: _shadowFeatures
            };
            args.variables.vmafSizeFailureShadowPrediction = _sizeShadowPrediction;
            args.variables.vmafSizeFailureShadowProbability = _shadow.probability;
            args.variables.vmafSizeFailureWouldSkip95 = _shadow.would_skip_candidate;
            args.variables.vmafSizeFailureWouldSkip98 = _shadow.would_skip_conservative;
            args.jobLog('');
            args.jobLog('=== Size-Failure Pre-Skip Shadow ===');
            args.jobLog('SHADOW ONLY: predicted size-failure probability=' + (_shadow.probability * 100).toFixed(1) + '%'
                + '; would-skip@0.95=' + (_shadow.would_skip_candidate ? 'YES' : 'no')
                + '; would-skip@0.98=' + (_shadow.would_skip_conservative ? 'YES' : 'no')
                + '; no action taken.');
            _sizeShadow.appendShadowLog(_sizeShadowPrediction);
        } catch (_shadowErr) {
            args.jobLog('Size-failure pre-skip shadow skipped (non-fatal): ' + (_shadowErr && _shadowErr.message ? _shadowErr.message : String(_shadowErr)));
        }

        // Candidate filtering used a reservation snapshot for telemetry only. Try to commit
        // a label slot after every selection guard and invariant, but never let telemetry
        // capacity or availability veto a validated handoff. Actual bytes remain authoritative.
        var _ffProjected = Number(bestParams.projectedOutputRatioPct);
        var _ffCommit = commitForcedFullSelection(args, bestParams, {
            validatedSelection: finalSelectionContract,
            legacyRatioPct: sizeGateLegacyPct,
            emergencyRatioPct: sizeGateEmergencyPct,
            capResolution: sizeGateCapResolution,
            cap: sizeGateForcedFullCap,
            jobIdentityHash: sizeGateForcedFullJobHash,
            reservationReadError: sizeGateReservationReadError,
            rootPath: SIZE_GATE_FORCED_FULL_ROOT,
        });
        var _ffReservation = _ffCommit.reservation;

        if (_ffReservation) {
            // Derived telemetry only. It carries no raw job/file identity, and
            // failure cannot create capacity or invalidate the private slot.
            var _ffRecord = {
                schema: 2,
                event: 'forced_full_selected',
                ts: new Date().toISOString(),
                job_identity_sha256: sizeGateForcedFullJobHash,
                reservation_slot: _ffReservation.slot,
                reservation_status: _ffReservation.status,
                selected_cq: bestParams.parameterSet && bestParams.parameterSet.quality,
                projected_output_ratio_pct: _ffProjected,
                legacy_gate_pct: sizeGateLegacyPct,
                emergency_cutoff_pct: sizeGateEmergencyPct,
                budget_used_after: _ffReservation.used,
                budget_cap: sizeGateForcedFullCap,
                action: 'forced_full_label_collection_monitor_remains_kill_switch',
                authority: 'atomic_private_slot_reservation_v1',
            };
            try {
                require('fs').appendFileSync(SIZE_GATE_FORCED_FULL_LOG,
                    JSON.stringify(_ffRecord) + '\n', { encoding: 'utf8', mode: 0o600 });
            } catch (_ffTelemetryError) {
                try {
                    args.jobLog('Size-gate forced-full telemetry write failed (non-fatal; actual-byte guard remains authoritative): '
                        + (_ffTelemetryError && _ffTelemetryError.message
                            ? _ffTelemetryError.message : String(_ffTelemetryError)));
                } catch (_) {}
            }
            try {
                args.jobLog('SIZE-GATE FORCED-FULL: selected CQ ' + _ffRecord.selected_cq + ' projected '
                    + _ffProjected.toFixed(1) + '% (retired gate ' + sizeGateLegacyPct + '%); '
                    + (_ffReservation.status === 'reused' ? 'reusing' : 'acquired')
                    + ' private reservation slot ' + _ffReservation.slot + ', budget '
                    + _ffReservation.used + '/' + sizeGateForcedFullCap);
            } catch (_) {}
        }

        // Store output number for retry check

        args.variables.vmafSelectOutput = 1;

        return {

            outputFileObj: args.inputFileObj,

            outputNumber: 1,

            variables: args.variables,

        };

    } else {

        args.jobLog('ERROR: Could not select best parameters');
        args.variables.vmafSelectionStatus = 'no_feasible_parameters';
        args.variables.vmafNoFeasibleParametersReason = rejectedResults.length
            ? rejectedResults.map(function (result) {
                return 'CQ ' + result.cq + ': ' + result.reason;
            }).join('; ')
            : 'No measured parameter set passed the authoritative quality contract';
        delete args.variables.vmafSelectionHandoff;

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
exports._test = {
    buildOriginalSourceSampleSizeMap: buildOriginalSourceSampleSizeMap,
    estimateCandidateSizeMetrics: estimateCandidateSizeMetrics,
    buildHoldoutVmafArgs: buildHoldoutVmafArgs,
    buildXpsnrArgs: buildXpsnrArgs,
    decoderForEncoder: decoderForEncoder,
    assessHoldoutSkipShadow: assessHoldoutSkipShadow,
    shouldApplyFractionalOverride: shouldApplyFractionalOverride,
    measuredCandidateUncertainty: measuredCandidateUncertainty,
    rankMeasuredCandidatesByCompression: rankMeasuredCandidatesByCompression,
    measuredConstraintBracket: measuredConstraintBracket,
    assessMeasuredBindingAuthority: assessMeasuredBindingAuthority,
    evaluateSizeGate: evaluateSizeGate,
    resolveForcedFullCap: resolveForcedFullCap,
    resetForcedFullAttemptState: resetForcedFullAttemptState,
    hashForcedFullJobIdentity: hashForcedFullJobIdentity,
    resolveForcedFullJobIdentityHash: resolveForcedFullJobIdentityHash,
    inspectForcedFullReservations: inspectForcedFullReservations,
    reserveForcedFullSlot: reserveForcedFullSlot,
    requiresForcedFullReservation: requiresForcedFullReservation,
    noteForcedFullReservationFailure: noteForcedFullReservationFailure,
    commitForcedFullSelection: commitForcedFullSelection,
    buildHoldoutEncodeArgs: buildHoldoutEncodeArgs,
    classifyToleranceRejection: classifyToleranceRejection,
    measuredQualityPasses: measuredQualityPasses,
    chooseMeasuredToleranceFallback: chooseMeasuredToleranceFallback,
    validateFinalSelection: validateFinalSelection,
    publishFinalSelection: publishFinalSelection,
    publishEncoderDomainBridge: publishEncoderDomainBridge,
    markConstraintAwareHoldoutTechnicalFailure: markConstraintAwareHoldoutTechnicalFailure,
    revertPredictionOnlyFractionalSelection: revertPredictionOnlyFractionalSelection,
    validateHoldoutMetrics: validateHoldoutMetrics,
    finiteMeasuredNumber: finiteMeasuredNumber,
    setParameterSetCQ: setParameterSetCQ,
    accumulateTimingSeconds: accumulateTimingSeconds,
    cpuV1ThreadsPerScore: cpuV1ThreadsPerScore,
    resolveMeasuredSweepContract: resolveMeasuredSweepContract,
    cpuV1ScorerGeometryFromContract: cpuV1ScorerGeometryFromContract,
    assertMeasuredSweepRuntime: assertMeasuredSweepRuntime,
};
