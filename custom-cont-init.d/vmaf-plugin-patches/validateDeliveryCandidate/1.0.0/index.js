"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var fs = require('fs');
var path = require('path');
var deliveryPolicy = require('../../_lib/deliveryPolicy.js');
var postReplaceAttestation = require('../../_lib/postReplaceAttestation.js');

var VALIDATION_SCHEMA = 'vmaf-delivery-candidate-validation/v1';
var LOWER_QUALITY_RISK_POLICY = 'lower-size-quality-risk-v2-binding';
var LOW_RATIO_EVIDENCE_THRESHOLD_PCT = 30;

function positiveNumber(value) {
    var number = Number(value);
    return isFinite(number) && number > 0 ? number : null;
}

function frameRate(value) {
    var text = String(value || '').trim();
    var match = text.match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
    if (!match) return null;
    var numerator = Number(match[1]);
    var denominator = match[2] ? Number(match[2]) : 1;
    return numerator > 0 && denominator > 0 ? numerator / denominator : null;
}

function primaryVideo(fileObj) {
    var streams = fileObj && fileObj.ffProbeData && fileObj.ffProbeData.streams;
    if (!Array.isArray(streams)) return null;
    for (var i = 0; i < streams.length; i += 1) {
        if (streams[i] && streams[i].codec_type === 'video') return streams[i];
    }
    return null;
}

function lowerQualityRiskFloor(args) {
    var variables = args.variables || {};
    var sourceObj = args.originalLibraryFile || {};
    var video = primaryVideo(sourceObj) || primaryVideo(args.inputFileObj) || {};
    var width = positiveNumber(video.width || video.coded_width);
    var height = positiveNumber(video.height || video.coded_height);
    var pixels = width && height ? width * height : null;
    var fps = frameRate(video.avg_frame_rate || video.r_frame_rate);
    var durationSec = positiveNumber(args.inputFileObj && args.inputFileObj.duration) ||
        positiveNumber(args.inputFileObj && args.inputFileObj.ffProbeData &&
            args.inputFileObj.ffProbeData.format && args.inputFileObj.ffProbeData.format.duration) ||
        positiveNumber(sourceObj.duration) ||
        positiveNumber(sourceObj.ffProbeData && sourceObj.ffProbeData.format &&
            sourceObj.ffProbeData.format.duration);
    var hdr = variables.isHDR === true || variables.vmafIsHDR === true ||
        String(variables.isHDR || variables.vmafIsHDR || '').toLowerCase() === 'true';
    var genre = String(variables.vmafMediaGenre || '').toLowerCase();
    var animationValue = variables.vmafMediaIsAnimation;
    var isAnimation = animationValue === true || String(animationValue).toLowerCase() === 'true' ||
        genre.indexOf('animation') !== -1 || genre.indexOf('anime') !== -1;
    var tier = 'sd';
    if (width >= 3800 || height >= 1800 || pixels >= 7000000) tier = '4k';
    else if (width >= 2500 || height >= 1300 || pixels >= 3000000) tier = '1440p';
    else if (width >= 1700 || height >= 900 || pixels >= 1600000) tier = '1080p';
    else if (width >= 1100 || height >= 650 || pixels >= 800000) tier = '720p';
    var minBpp = {
        '4k': isAnimation ? 0.010 : (hdr ? 0.018 : 0.015),
        '1440p': isAnimation ? 0.011 : (hdr ? 0.020 : 0.017),
        '1080p': isAnimation ? 0.016 : (hdr ? 0.028 : 0.024),
        '720p': isAnimation ? 0.022 : (hdr ? 0.040 : 0.034),
        'sd': isAnimation ? 0.030 : 0.050,
    }[tier];
    var minRatioPct = {
        '4k': isAnimation ? 5.0 : (hdr ? 10.0 : 8.0),
        '1440p': isAnimation ? 4.5 : (hdr ? 9.0 : 7.5),
        '1080p': isAnimation ? 4.0 : 7.0,
        '720p': isAnimation ? 3.5 : 6.0,
        'sd': isAnimation ? 3.0 : 5.0,
    }[tier];
    var minMbps = {
        '4k': isAnimation ? 1.4 : (hdr ? 2.5 : 2.2),
        '1440p': isAnimation ? 1.1 : (hdr ? 2.0 : 1.7),
        '1080p': isAnimation ? 0.8 : (hdr ? 1.6 : 1.4),
        '720p': isAnimation ? 0.45 : 0.85,
        'sd': isAnimation ? 0.22 : 0.35,
    }[tier];
    return {
        policy: LOWER_QUALITY_RISK_POLICY,
        tier: tier,
        isHDR: hdr,
        isAnimation: isAnimation,
        width: width,
        height: height,
        fps: fps,
        durationSec: durationSec,
        minOutputRatioPct: minRatioPct,
        minOutputBpp: minBpp,
        minOutputMbps: minMbps,
    };
}

function evaluateLowerQualityRisk(args, candidateBytes, sourceBytes) {
    var floor = lowerQualityRiskFloor(args);
    var ratioPct = (Number(candidateBytes) / Number(sourceBytes)) * 100;
    var measurable = floor.width && floor.height && floor.fps && floor.durationSec;
    if (!measurable) {
        return { policy: floor.policy, evaluated: false, rejected: false, floor: floor };
    }
    // Container rate includes audio, subtitles and mux overhead, so it is an upper bound on
    // video rate. If even this upper bound misses a video floor, rejection is conclusive.
    var containerMbps = Number(candidateBytes) * 8 / floor.durationSec / 1000000;
    var containerBpp = Number(candidateBytes) * 8 /
        (floor.durationSec * floor.fps * floor.width * floor.height);
    var ratioLow = ratioPct < floor.minOutputRatioPct;
    var bppLow = containerBpp < floor.minOutputBpp;
    var mbpsLow = containerMbps < floor.minOutputMbps;
    // Absolute Mbps is an aspect-ratio-blind restatement of BPP. Keep it in the
    // authenticated evidence for calibration, but do not let it independently reject a
    // cropped title whose ratio and normalized BPP both pass.
    var rejected = ratioLow || bppLow;
    return {
        policy: floor.policy,
        evaluated: true,
        rejected: rejected,
        reason: rejected ? 'delivery_candidate_below_quality_risk_floor' : null,
        mbpsAdvisory: !rejected && mbpsLow,
        ratioPct: ratioPct,
        containerMbpsUpperBound: containerMbps,
        containerBppUpperBound: containerBpp,
        ratioLow: ratioLow,
        bppLow: bppLow,
        mbpsLow: mbpsLow,
        floor: floor,
    };
}

function evaluateLowRatioQualityEvidence(args, ratioPct, deliveredCandidatePath) {
    var variables = args.variables || {};
    var ratio = Number(ratioPct);
    if (!isFinite(ratio) || ratio >= LOW_RATIO_EVIDENCE_THRESHOLD_PCT) {
        return { evaluated: false, accepted: true, thresholdPct: LOW_RATIO_EVIDENCE_THRESHOLD_PCT };
    }
    var outcome = variables.vmafAuthoritativeHoldoutOutcome;
    var finalCQ = Number(variables.vmafFinalSelectedCQ);
    var holdoutCQ = Number(outcome && (outcome.selectedCQ !== undefined
        ? outcome.selectedCQ : outcome.testedCQ));
    var exactHoldout = !!outcome && outcome.passed === true && isFinite(finalCQ) &&
        isFinite(holdoutCQ) && Math.abs(finalCQ - holdoutCQ) < 0.0001;
    var grain = { required: variables.grainSynthesisStatus === 'active_validated', accepted: true };
    if (grain.required) {
        var report = variables.grainSynthesisValidation;
        var warnings = report && Array.isArray(report.quality_warnings)
            ? report.quality_warnings : [];
        var bindingWarnings = warnings.filter(function (warning) {
            var stage = String(warning && warning.stage || '');
            return stage === 'postencode-calibration' || stage === 'heldout-energy-validation';
        });
        var reportOutput = report && String(report.output || '');
        grain = {
            required: true,
            accepted: !!report && report.semantic_grain_inspected === true &&
                pathKey(reportOutput) === pathKey(deliveredCandidatePath) && bindingWarnings.length === 0,
            schema: report && report.schema,
            outputMatches: !!reportOutput && pathKey(reportOutput) === pathKey(deliveredCandidatePath),
            semanticGrainInspected: !!report && report.semantic_grain_inspected === true,
            bindingWarnings: bindingWarnings
        };
    }
    var accepted = exactHoldout && grain.accepted;
    return {
        evaluated: true,
        accepted: accepted,
        rejected: !accepted,
        reason: accepted ? null : (!exactHoldout
            ? 'low_ratio_candidate_lacks_exact_cq_holdout' : 'low_ratio_grain_validation_failed'),
        thresholdPct: LOW_RATIO_EVIDENCE_THRESHOLD_PCT,
        ratioPct: ratio,
        finalCQ: isFinite(finalCQ) ? finalCQ : null,
        holdoutCQ: isFinite(holdoutCQ) ? holdoutCQ : null,
        exactHoldout: exactHoldout,
        grain: grain
    };
}

function cloneWarnings(warnings) {
    return (Array.isArray(warnings) ? warnings : []).map(function (warning) {
        if (!warning || typeof warning !== 'object' || Array.isArray(warning)) {
            return { advisory: true, code: String(warning || 'grain-quality-warning') };
        }
        return JSON.parse(JSON.stringify(warning));
    });
}

function grainSynthesisDeliveryEvidence(args, deliveredCandidatePath) {
    var variables = args.variables || {};
    var status = String(variables.grainSynthesisStatus || 'not_applicable');
    if (status !== 'active_validated') {
        return {
            status: status,
            output_matches_candidate: false,
            output_size_ratio_pct_of_base: null,
            size_efficiency_warning_pct: null,
            size_efficiency_warning_breached: false,
            quality_warnings: [],
            warnings_source: 'not_applicable',
        };
    }
    var report = variables.grainSynthesisValidation || {};
    var variableWarnings = Array.isArray(variables.grainSynthesisQualityWarnings)
        ? variables.grainSynthesisQualityWarnings : null;
    var warnings = cloneWarnings(variableWarnings || report.quality_warnings);
    var ratioPct = Number(report.output_size_ratio_pct_of_base);
    var warningPct = Number(report.output_size_efficiency_warning_pct);
    var sizeWarnings = warnings.filter(function (warning) {
        return String(warning && warning.stage || '') === 'output-size-efficiency';
    });
    var breached = report.output_size_efficiency_warning_breached === true ||
        sizeWarnings.length > 0;
    return {
        status: status,
        output_matches_candidate: !!report.output &&
            pathKey(report.output) === pathKey(deliveredCandidatePath),
        output_size_ratio_pct_of_base: isFinite(ratioPct) ? ratioPct : null,
        size_efficiency_warning_pct: isFinite(warningPct) ? warningPct : null,
        size_efficiency_warning_breached: breached,
        quality_warnings: warnings,
        warnings_source: variableWarnings
            ? 'grainSynthesisQualityWarnings' : 'grainSynthesisValidation.quality_warnings',
    };
}

function pathKey(filePath) {
    var resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function strictChild(root, candidate) {
    var relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' &&
        !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function sha256FileSync(filePath) {
    return postReplaceAttestation.inspectInstalledFile(filePath)
        .identity.sha256_full;
}

function regularFileIdentity(filePath, label) {
    try {
        var inspected = postReplaceAttestation.inspectInstalledFile(filePath);
        return Object.assign({ path: inspected.path }, inspected.identity);
    } catch (error) {
        throw new Error(label + ' inspection failed: ' + error.message);
    }
}

function requirePendingProof(args, policy) {
    var variables = args.variables || {};
    var pending = variables.vmafDeliveryOutcomePending;
    var checkpoint = variables.vmafPostEncodeCheckpoint;
    var jobId = String(variables.vmafCanonicalJobId || '').trim();
    var checkpointKey = checkpoint && String(checkpoint.checkpoint_key || '');
    var source = path.resolve(sourcePath(args));
    if (!pending || pending.schema !== 'vmaf-delivery-outcome-pending/v1' ||
        pending.version !== 1 || pending.status !== 'candidate_ready' ||
        pending.database_recorded !== true) {
        throw new Error('delivery validation requires a durable candidate-ready proof');
    }
    if (!jobId || pending.job_id !== jobId) {
        throw new Error('candidate-ready proof differs from the canonical VMAF job id');
    }
    if (!/^[0-9a-f]{64}$/.test(checkpointKey) ||
        pending.checkpoint_key !== checkpointKey) {
        throw new Error('candidate-ready proof differs from the authenticated checkpoint key');
    }
    if (!pending.source_path || pathKey(pending.source_path) !== pathKey(source)) {
        throw new Error('candidate-ready proof differs from the original source path');
    }
    if (pending.size_policy_version !== policy.version ||
        Number(pending.target_size_reduction_pct) !== policy.targetReductionPct ||
        Number(pending.minimum_size_reduction_pct) !== policy.minimumReductionPct ||
        Number(pending.max_final_output_ratio_pct) !== policy.maxFinalOutputRatioPct) {
        throw new Error('candidate-ready proof differs from the exact delivery policy');
    }
    return pending;
}

function workRoot(workDir) {
    var requested = String(workDir || '').trim();
    if (!requested || !path.isAbsolute(requested)) {
        throw new Error('delivery validation requires an absolute args.workDir');
    }
    var resolved = path.resolve(requested);
    if (resolved === path.parse(resolved).root) {
        throw new Error('delivery validation refuses a filesystem root as args.workDir');
    }
    var stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('delivery validation workDir is not a real directory');
    }
    var canonical = path.resolve(fs.realpathSync(resolved));
    if (pathKey(canonical) !== pathKey(resolved)) {
        throw new Error('delivery validation workDir contains a symlinked component');
    }
    return canonical;
}

function sourcePath(args) {
    return String(args.variables && args.variables.vmafOriginalFile ||
        args.originalLibraryFile &&
            (args.originalLibraryFile._id || args.originalLibraryFile.file) || '');
}

function candidatePath(args) {
    return String(args.inputFileObj &&
        (args.inputFileObj._id || args.inputFileObj.file) || '');
}

function canonicalJobId(args, vmafdb) {
    var jobId = String(args.variables.vmafCanonicalJobId || '');
    if (jobId) return jobId;
    var source = sourcePath(args);
    if (!source) throw new Error('delivery outcome has no canonical job or source identity');
    jobId = vmafdb.makeJobId(source, args.variables.vmafJobStartTime || '');
    args.variables.vmafCanonicalJobId = jobId;
    return jobId;
}

function recordRejectedCandidate(args, assessment, policy, rejectionReason, dbOverride) {
    var vmafdb = dbOverride ||
        require('/custom-cont-init.d/.vmaf-plugin-patches/_lib/vmafdb.js');
    var db = vmafdb.openDb();
    var pending = args.variables && args.variables.vmafDeliveryOutcomePending;
    var checkpointKey = pending && String(pending.checkpoint_key || '');
    var jobId = canonicalJobId(args, vmafdb);
    var source = sourcePath(args);
    if (!pending || pending.schema !== 'vmaf-delivery-outcome-pending/v1' ||
            pending.database_recorded !== true ||
            pending.job_id !== jobId ||
            !/^[0-9a-f]{64}$/.test(checkpointKey) || !source) {
        throw new Error(
            'terminal delivery rejection requires the exact durable candidate-ready checkpoint proof');
    }
    var terminalSkipReason = rejectionReason ||
        'delivery_candidate_exceeds_size_cap';
    vmafdb.upsertJob(db, {
        job_id: jobId,
        transcode_succeeded: 0,
        met_vmaf_target: 1,
        met_size_target: 0,
        final_output_size_mb: null,
        final_output_ratio_pct: null,
        actual_size_reduction_pct: null,
        size_target_status: 'candidate_rejected',
        target_size_reduction_pct: policy.targetReductionPct,
        minimum_size_reduction_pct: policy.minimumReductionPct,
        max_final_output_ratio_pct: policy.maxFinalOutputRatioPct,
        size_policy_version: policy.version,
        outcome_stage: 'keep_original',
        delivered_at: null,
        replacement_attestation_version: null,
        replacement_backup_retained: null,
        delivery_transaction_id: null,
        delivery_checkpoint_key: checkpointKey,
        skip_reason: terminalSkipReason,
    });
    args.variables.vmafTerminalCheckpointDisposition = {
        schema: 'vmaf-terminal-checkpoint-disposition/v1',
        version: 1,
        disposition: 'retire_keep_original',
        recorded_at: new Date().toISOString(),
        database_recorded: true,
        job_id: jobId,
        source_path: source,
        checkpoint_key: checkpointKey,
        outcome_stage: 'keep_original',
        skip_reason: terminalSkipReason,
    };
    return assessment;
}

function validate(args) {
    args.variables = args.variables || {};
    var policy = deliveryPolicy.resolve(args.variables);
    var pending = requirePendingProof(args, policy);
    var root = workRoot(args.workDir);
    var source = regularFileIdentity(sourcePath(args), 'original library file');
    var candidate = regularFileIdentity(candidatePath(args), 'delivery candidate');
    if (!strictChild(root, candidate.path)) {
        throw new Error('delivery candidate is outside the canonical job workDir');
    }
    if (pathKey(source.path) === pathKey(candidate.path) ||
            (source.dev === candidate.dev && source.ino === candidate.ino)) {
        throw new Error('delivery candidate aliases the original library file');
    }
    var assessment = deliveryPolicy.evaluateBytes(
        candidate.size_bytes, source.size_bytes, policy);
    var lowerQualityRisk = evaluateLowerQualityRisk(
        args, candidate.size_bytes, source.size_bytes);
    var lowRatioEvidence = evaluateLowRatioQualityEvidence(
        args, assessment.ratioPct, candidate.path);
    assessment.maximumSizeRejected = assessment.rejected;
    assessment.lowerQualityRiskRejected = lowerQualityRisk.rejected;
    assessment.lowRatioEvidenceRejected = lowRatioEvidence.rejected === true;
    assessment.accepted = assessment.accepted && !lowerQualityRisk.rejected &&
        !assessment.lowRatioEvidenceRejected;
    assessment.rejected = !assessment.accepted;
    assessment.rejectionReason = assessment.maximumSizeRejected
        ? 'delivery_candidate_exceeds_size_cap'
        : (lowerQualityRisk.rejected ? lowerQualityRisk.reason :
            (assessment.lowRatioEvidenceRejected ? lowRatioEvidence.reason : null));
    var evidence = {
        schema: VALIDATION_SCHEMA,
        status: assessment.accepted ? 'accepted' : 'rejected',
        validated_at: new Date().toISOString(),
        policy_version: policy.version,
        target_size_reduction_pct: policy.targetReductionPct,
        minimum_size_reduction_pct: policy.minimumReductionPct,
        max_final_output_ratio_pct: policy.maxFinalOutputRatioPct,
        output_ratio_pct: assessment.ratioPct,
        actual_size_reduction_pct: assessment.actualReductionPct,
        lower_quality_risk: lowerQualityRisk,
        low_ratio_quality_evidence: lowRatioEvidence,
        job_id: pending.job_id,
        checkpoint_key: pending.checkpoint_key,
        candidate_ready_schema: pending.schema,
        source: source,
        candidate: candidate,
        grain_synthesis: grainSynthesisDeliveryEvidence(args, candidate.path),
    };
    args.variables.vmafDeliveryCandidateValidation = evidence;
    return {
        policy: policy,
        assessment: assessment,
        evidence: evidence,
    };
}

var details = function () { return ({
    name: 'Validate Delivery Candidate',
    description: 'Applies the exact delivered-byte size policy immediately before replacement. Equality at the 90% cap is accepted; larger candidates keep the original.',
    style: { borderColor: 'orange' },
    tags: 'video,vmaf,size,delivery,safety',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faScaleBalanced',
    inputs: [],
    outputs: [
        { number: 1, tooltip: 'Candidate satisfies the delivered-size policy' },
        { number: 2, tooltip: 'Candidate rejected; keep the original' },
    ],
}); };
exports.details = details;

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    args.jobLog('=== Validate Delivery Candidate ===');
    var hashStatsBefore = postReplaceAttestation.hashCacheStats();
    var result = validate(args);
    var hashStatsAfter = postReplaceAttestation.hashCacheStats();
    args.jobLog('Delivery validation integrity hashing: ' +
        (hashStatsAfter.misses - hashStatsBefore.misses) + ' fresh pass(es), ' +
        (hashStatsAfter.hits - hashStatsBefore.hits) + ' unchanged-identity reuse(s), ' +
        ((hashStatsAfter.hashed_bytes - hashStatsBefore.hashed_bytes) /
            (1024 * 1024 * 1024)).toFixed(2) + ' GiB freshly hashed.');
    if (result.assessment.rejected) {
        args.variables.vmafDeliveryCandidateRejected = true;
        args.variables.vmafTranscodeSucceeded = false;
        args.variables.vmafTranscodeStatus = (result.assessment.lowerQualityRiskRejected ||
            result.assessment.lowRatioEvidenceRejected)
            ? 'keep_original_delivery_quality_risk_policy'
            : 'keep_original_delivery_size_policy';
        args.variables.vmafTranscodeFailureReason =
            result.assessment.rejectionReason;
        recordRejectedCandidate(args, result.assessment, result.policy,
            result.assessment.rejectionReason);
        var risk = result.evidence.lower_quality_risk;
        if (result.assessment.lowRatioEvidenceRejected) {
            var lowEvidence = result.evidence.low_ratio_quality_evidence;
            args.jobLog('DELIVERY QUALITY-EVIDENCE REJECTED: candidate is ' +
                lowEvidence.ratioPct.toFixed(2) + '% of source but exact-CQ holdout/grain evidence failed (' +
                lowEvidence.reason + '). Original preserved.');
        } else if (result.assessment.lowerQualityRiskRejected) {
            args.jobLog('DELIVERY QUALITY-RISK REJECTED: candidate container upper bounds are ' +
                risk.containerMbpsUpperBound.toFixed(2) + ' Mbps and ' +
                risk.containerBppUpperBound.toFixed(4) + ' bpp; ' + risk.floor.tier +
                (risk.floor.isHDR ? ' HDR' : ' SDR') + ' floors are ' +
                risk.floor.minOutputMbps.toFixed(2) + ' Mbps and ' +
                risk.floor.minOutputBpp.toFixed(4) + ' bpp. Original preserved.');
        } else {
            args.jobLog('DELIVERY REJECTED: candidate is ' +
                result.assessment.ratioPct.toFixed(3) + '% of source; cap is ' +
                result.assessment.capPct.toFixed(3) + '%. Original preserved.');
        }
        return {
            outputFileObj: args.originalLibraryFile || args.inputFileObj,
            outputNumber: 2,
            variables: args.variables,
        };
    }
    args.variables.vmafDeliveryCandidateRejected = false;
    var acceptedRisk = result.evidence.lower_quality_risk;
    if (acceptedRisk.evaluated) {
        args.jobLog('Delivery quality-risk floor passed: container upper bounds ' +
            acceptedRisk.containerMbpsUpperBound.toFixed(2) + ' Mbps, ' +
            acceptedRisk.containerBppUpperBound.toFixed(4) + ' bpp.' +
            (acceptedRisk.mbpsAdvisory ? ' Legacy absolute Mbps floor is advisory-only.' : ''));
    }
    args.jobLog('Delivery candidate accepted at ' +
        result.assessment.ratioPct.toFixed(3) + '% of source (cap ' +
        result.assessment.capPct.toFixed(3) + '%).');
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
exports._test = {
    pathKey: pathKey,
    strictChild: strictChild,
    regularFileIdentity: regularFileIdentity,
    workRoot: workRoot,
    sha256FileSync: sha256FileSync,
    requirePendingProof: requirePendingProof,
    validate: validate,
    recordRejectedCandidate: recordRejectedCandidate,
    lowerQualityRiskFloor: lowerQualityRiskFloor,
    evaluateLowerQualityRisk: evaluateLowerQualityRisk,
    evaluateLowRatioQualityEvidence: evaluateLowRatioQualityEvidence,
    grainSynthesisDeliveryEvidence: grainSynthesisDeliveryEvidence,
    recordRejectedCandidate: recordRejectedCandidate,
    LOW_RATIO_EVIDENCE_THRESHOLD_PCT: LOW_RATIO_EVIDENCE_THRESHOLD_PCT,
    LOWER_QUALITY_RISK_POLICY: LOWER_QUALITY_RISK_POLICY,
    VALIDATION_SCHEMA: VALIDATION_SCHEMA,
};
