"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var fs = require('fs');
var path = require('path');
var deliveryPolicy = require('../../_lib/deliveryPolicy.js');
var CONSERVATIVE_CQ_SUBSTITUTION_CONTRACT_ID = 'vmaf-conservative-postencode-cq-substitution-v1';

function pathIdentity(filePath) {
    var resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function strictChildOf(root, candidate) {
    var relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' &&
        !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function canonicalRetryWorkRoot(workDir) {
    var requested = String(workDir || '').trim();
    if (!requested || !path.isAbsolute(requested)) {
        throw new Error('retry cleanup requires an absolute args.workDir');
    }
    var resolved = path.resolve(requested);
    if (resolved === path.parse(resolved).root) {
        throw new Error('retry cleanup refuses a filesystem root');
    }
    var stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('retry cleanup work root is not a real directory: ' + resolved);
    }
    var canonical = path.resolve(fs.realpathSync(resolved));
    if (pathIdentity(canonical) !== pathIdentity(resolved)) {
        throw new Error('retry cleanup work root contains a symlinked path component');
    }
    return canonical;
}

function removePartialOutputForRetry(args, outputFile) {
    if (!outputFile) return { removed: false, absent: true };
    var root = canonicalRetryWorkRoot(args && args.workDir);
    var resolved = path.resolve(String(outputFile));
    if (!strictChildOf(root, resolved)) {
        throw new Error('partial transcode output is outside the canonical job work root: ' + resolved);
    }
    var protectedPaths = [
        args && args.inputFileObj && (args.inputFileObj._id || args.inputFileObj.file),
        args && args.originalLibraryFile &&
            (args.originalLibraryFile._id || args.originalLibraryFile.file),
        args && args.variables && args.variables.vmafOriginalFile,
    ].filter(Boolean);
    var protectedIdentities = new Set();
    protectedPaths.forEach(function (protectedPath) {
        var lexical = path.resolve(String(protectedPath));
        protectedIdentities.add(pathIdentity(lexical));
        try { protectedIdentities.add(pathIdentity(fs.realpathSync(lexical))); } catch (_) {}
    });
    if (protectedIdentities.has(pathIdentity(resolved))) {
        throw new Error('partial transcode output aliases a protected source: ' + resolved);
    }
    if (!fs.existsSync(resolved)) return { removed: false, absent: true, path: resolved };
    var stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('partial transcode output is not a non-symlink regular file: ' + resolved);
    }
    var canonical = path.resolve(fs.realpathSync(resolved));
    if (pathIdentity(canonical) !== pathIdentity(resolved) ||
        !strictChildOf(root, canonical)) {
        throw new Error('partial transcode output contains a symlinked component or escaped the job root');
    }
    if (protectedIdentities.has(pathIdentity(canonical))) {
        throw new Error('partial transcode output resolves to a protected source: ' + resolved);
    }
    fs.unlinkSync(resolved);
    if (fs.existsSync(resolved)) {
        throw new Error('partial transcode output still exists after unlink: ' + resolved);
    }
    return { removed: true, absent: false, path: resolved };
}

function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === 'object') {
        var out = {};
        Object.keys(value).sort().forEach(function (key) {
            if (value[key] !== undefined) out[key] = canonicalValue(value[key]);
        });
        return out;
    }
    return value;
}

function measurementParameterContractSha256(parameterSet) {
    if (!parameterSet || typeof parameterSet !== 'object' || Array.isArray(parameterSet)) return '';
    var contract = {};
    Object.keys(parameterSet).sort().forEach(function (key) {
        if (key === 'id' || key === 'quality' || key === 'cq') return;
        if (parameterSet[key] !== undefined) contract[key] = parameterSet[key];
    });
    return require('crypto').createHash('sha256')
        .update(JSON.stringify(canonicalValue(contract)), 'utf8').digest('hex');
}

function finiteNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    var number = Number(value);
    return isFinite(number) ? number : null;
}

function aggregateParameterSetId(result) {
    var parameterSet = result && result.parameterSet || {};
    return String((result && result.parameterSetId) || parameterSet.id || '').trim();
}

function aggregateCQ(result) {
    var parameterSet = result && result.parameterSet || {};
    return finiteNumberOrNull(parameterSet.quality !== undefined
        ? parameterSet.quality : parameterSet.cq);
}

function nullableNumbersMatch(left, right) {
    left = finiteNumberOrNull(left);
    right = finiteNumberOrNull(right);
    if (left === null || right === null) return left === right;
    return Math.abs(left - right) <= 0.000000001 * Math.max(1, Math.abs(left), Math.abs(right));
}

/**
 * Resolve the physical sweep point represented by an authenticated conservative
 * post-encode checkpoint substitution. The transcode plugin already authenticates
 * the checkpoint itself; this second check prevents its requested CQ from being
 * paired with the lower-CQ artifact's size/quality measurements in the training DB.
 */
function resolveConservativeCqSubstitution(variables) {
    variables = variables || {};
    var audit = variables.vmafPostEncodeCqSubstitution;
    if (audit === undefined || audit === null) return null;
    if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
        throw new Error('post-encode CQ substitution audit is not an object');
    }
    if (audit.schema !== 'vmaf_postencode_cq_substitution_v1' ||
        audit.contract_id !== CONSERVATIVE_CQ_SUBSTITUTION_CONTRACT_ID ||
        audit.policy !== 'cq_only_conservative' ||
        audit.relation !== 'identical_except_lower_cq' ||
        audit.conservative !== true || audit.no_encode !== true) {
        throw new Error('post-encode CQ substitution audit contract is invalid');
    }

    var requestedCQ = finiteNumberOrNull(audit.requested_cq);
    var actualCQ = finiteNumberOrNull(audit.actual_cq);
    if (requestedCQ === null || actualCQ === null ||
        requestedCQ < 0 || requestedCQ > 63 ||
        actualCQ < 0 || actualCQ > 63 || !Number.isInteger(actualCQ) ||
        !(actualCQ < requestedCQ)) {
        throw new Error('post-encode CQ substitution is not strictly conservative');
    }

    var measured = audit.current_measurement;
    if (!measured || typeof measured !== 'object' || Array.isArray(measured)) {
        throw new Error('post-encode CQ substitution has no current-job sweep measurement');
    }
    var measuredId = String(measured.parameter_set_id || '').trim();
    if (!measuredId) {
        throw new Error('post-encode CQ substitution measurement has no parameter-set id');
    }
    var measuredContractSha256 = String(
        measured.parameter_set_contract_sha256 || '').trim();
    if (!/^[0-9a-f]{64}$/.test(measuredContractSha256)) {
        throw new Error('post-encode CQ substitution measurement has no parameter-set contract');
    }

    var results = Array.isArray(variables.vmafAggregatedResults)
        ? variables.vmafAggregatedResults : [];
    var matches = results.filter(function (result) {
        var cq = aggregateCQ(result);
        return result && !result.reusedFromJobId &&
            aggregateParameterSetId(result) === measuredId &&
            cq !== null && Math.abs(cq - actualCQ) < 0.000001 &&
            measurementParameterContractSha256(result.parameterSet) ===
                measuredContractSha256;
    }).sort(function (left, right) {
        return (Number(right.sampleCount) || 0) - (Number(left.sampleCount) || 0);
    });
    if (matches.length === 0) {
        throw new Error('post-encode CQ substitution measurement is absent from the current sweep');
    }

    var result = matches[0];
    var comparisons = [
        ['avg_vmaf', measured.avg_vmaf, result.avgVMAF],
        ['min_vmaf', measured.min_vmaf, result.minVMAF],
        ['p1_vmaf', measured.p1_vmaf, result.vmafP1Low],
        ['avg_cambi', measured.avg_cambi, result.avgCAMBI],
        ['avg_sample_size_mb', measured.avg_sample_size_mb, result.avgFileSizeMB],
    ];
    for (var i = 0; i < comparisons.length; i++) {
        if (!nullableNumbersMatch(comparisons[i][1], comparisons[i][2])) {
            throw new Error('post-encode CQ substitution measurement mismatch for ' + comparisons[i][0]);
        }
    }

    var avgVmaf = finiteNumberOrNull(result.avgVMAF);
    var minVmaf = finiteNumberOrNull(result.vmafP1Low);
    if (minVmaf === null) minVmaf = finiteNumberOrNull(result.minVMAF);
    var avgSizeMb = finiteNumberOrNull(result.avgFileSizeMB);
    if (avgVmaf === null || minVmaf === null || avgSizeMb === null) {
        throw new Error('post-encode CQ substitution sweep measurement is incomplete');
    }

    return {
        audit: audit,
        requestedCQ: requestedCQ,
        actualCQ: actualCQ,
        fields: {
            selected_cq: actualCQ,
            selected_parameter_set_id: measuredId,
            selected_vmaf: avgVmaf,
            selected_vmaf_min: minVmaf,
            selected_cambi: finiteNumberOrNull(result.avgCAMBI),
            selected_size_mb: avgSizeMb,
        },
    };
}

var details = function () { return ({
    name: 'Monitor Transcode Retry',
    description: 'VMAF-aware transcode retry logic. Only retries with CQ values that had acceptable VMAF during sweep. Triggers sweep retry if no higher CQ was tested.',
    style: {
        borderColor: 'orange',
    },
    tags: 'video,vmaf,retry,transcode',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faRedo',
    inputs: [
        {
            label: 'Maximum Retries',
            name: 'maxRetries',
            type: 'number',
            defaultValue: '3',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Maximum number of transcode retry attempts. Default: 3',
        },
        {
            label: 'VMAF Below Threshold Margin',
            name: 'vmafBelowThresholdMargin',
            type: 'number',
            defaultValue: '5',
            inputUI: {
                type: 'text',
            },
            tooltip: 'If VMAF is this many points below threshold, consider it impossible to achieve target. Default: 5',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'Retry transcode with higher CQ (from tested values with acceptable VMAF)',
        },
        {
            number: 2,
            tooltip: 'Continue (success or max retries reached)',
        },
        {
            number: 3,
            tooltip: 'Retry VMAF sweep at higher CQ range (no tested higher CQ available)',
        },
        {
            number: 4,
            tooltip: 'Keep original and stop before reorder/replace/notification side effects',
        },
    ],
}); };
exports.details = details;

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    var feasibility = require('../../_lib/feasibility.js');
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var maxRetries = Number(args.inputs.maxRetries) || 3;

    // ENHANCEMENT FIX #14: Input validation
    if (isNaN(maxRetries) || maxRetries < 0) {
        args.jobLog('WARNING: Invalid maxRetries (' + args.inputs.maxRetries + '), using default 3');
        maxRetries = 3;
    }

    // Initialize before progress reporting. The previous declaration came after this block,
    // so the displayed attempt was NaN because `var` was hoisted with an undefined value.
    var retryCount = args.variables.vmafTranscodeRetryCount || 0;

    // ENHANCEMENT FIX #16: Progress reporting for retry loops
    if (args.updateWorker) {
        args.updateWorker({
            percentage: 0,
            ETA: 0,
            CLIType: 'VMAF Transcode Retry',
            preset: 'Transcode Retry Check (Attempt ' + (retryCount + 1) + ' / ' + maxRetries + ')'
        });
    }

    var vmafBelowThresholdMargin = Number(args.inputs.vmafBelowThresholdMargin) || 5;

    // Get VMAF thresholds
    var minVMAF = args.variables.vmafMinVMAF || 90;
    var minFrameVMAF = args.variables.vmafMinFrameVMAF || 0; // 0 means disabled

    // Get aggregated results from sweep
    var aggregatedResults = args.variables.vmafAggregatedResults || [];
    args.variables.vmafTrendAvgDropPerCQ = null;
    args.variables.vmafTrendIncrementUsed = null;
    args.variables.vmafTrendCurrentVMAF = null;
    args.variables.vmafTrendMargin = null;

    // Consume the explicit terminal state written by vmafOptimizedTranscode. Fail closed when
    // it is absent/unknown: "not cancelled" is not evidence that FFmpeg succeeded.
    var liveSizeCompare = args.variables.liveSizeCompare;
    var transcodeStatus = String(args.variables.vmafTranscodeStatus || 'unknown');
    var transcodeFailureReason = String(args.variables.vmafTranscodeFailureReason || 'unspecified');
    var explicitSuccess = args.variables.vmafTranscodeSucceeded === true && transcodeStatus === 'success';
    var wasCancelled = (liveSizeCompare && liveSizeCompare.error === true) || transcodeStatus === 'size_failed';
    var keepOriginalRequested = transcodeStatus.indexOf('keep_original') === 0;
    var technicalFailure = transcodeStatus === 'technical_failure'
        || transcodeStatus === 'unknown'
        || transcodeStatus === 'not_started'
        || transcodeStatus === 'running';
    var conservativeCqSubstitution = null;

    function recordJobOutcome(fields, requireDurableReadback) {
        try {
            var vmafdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
            var _odb = vmafdb.openDb();
            var _canonicalId = String(args.variables.vmafCanonicalJobId || '');
            // Compatibility for a job already in flight when the canonical-id variable was
            // deployed: locate the source-backed row by the shared start-time prefix.
            if (!_canonicalId && requireDurableReadback === true) {
                throw new Error('candidate-ready delivery requires the exact canonical VMAF job id');
            }
            if (!_canonicalId && args.variables.vmafJobStartTime) {
                var _prefix = String(args.variables.vmafJobStartTime) + '-%';
                var _existing = _odb.prepare(
                    'SELECT job_id FROM jobs WHERE job_id LIKE ? AND file_path IS NOT NULL ' +
                    'ORDER BY CASE WHEN selected_cq IS NOT NULL THEN 0 ELSE 1 END, updated_at DESC LIMIT 1'
                ).get(_prefix);
                if (_existing && _existing.job_id) _canonicalId = String(_existing.job_id);
            }
            if (!_canonicalId) {
                var _ofp = String((args.inputFileObj && (args.inputFileObj._id || args.inputFileObj.file)) || '');
                if (!_ofp) {
                    if (requireDurableReadback === true) {
                        throw new Error('candidate-ready outcome has no canonical source identity');
                    }
                    return false;
                }
                _canonicalId = vmafdb.makeJobId(_ofp, args.variables.vmafJobStartTime || '');
            }
            fields.job_id = _canonicalId;
            args.variables.vmafCanonicalJobId = _canonicalId;
            var _attempts = requireDurableReadback === true ? 3 : 1;
            var _retryDelays = [100, 250];
            for (var _attempt = 1; _attempt <= _attempts; _attempt++) {
                try {
                    vmafdb.upsertJob(_odb, fields);
                    if (requireDurableReadback === true) {
                        var _columns = Object.keys(fields).filter(function (column) {
                            return column !== 'job_id' && fields[column] !== undefined;
                        });
                        var _persisted = _odb.prepare(
                            'SELECT ' + _columns.join(', ') + ' FROM jobs WHERE job_id = ?'
                        ).get(_canonicalId);
                        if (!_persisted) {
                            throw new Error('candidate-ready DB read-back found no canonical job row');
                        }
                        for (var _columnIndex = 0; _columnIndex < _columns.length; _columnIndex++) {
                            var _column = _columns[_columnIndex];
                            var _expected = fields[_column];
                            var _actual = _persisted[_column];
                            var _matches = _expected === null
                                ? _actual === null
                                : (typeof _expected === 'number'
                                    ? Number.isFinite(Number(_actual)) &&
                                        Number(_actual) === _expected
                                    : String(_actual) === String(_expected));
                            if (!_matches) {
                                throw new Error('candidate-ready DB read-back mismatch for ' + _column);
                            }
                        }
                    }
                    return true;
                } catch (_writeError) {
                    var _writeText = String((_writeError && _writeError.code) || '') + ' ' +
                        String((_writeError && _writeError.message) || _writeError);
                    var _transient = /SQLITE_BUSY|SQLITE_LOCKED|database is (?:busy|locked)/i
                        .test(_writeText);
                    if (!_transient || _attempt >= _attempts) throw _writeError;
                    args.jobLog('Candidate-ready DB write was transiently busy; retrying attempt ' +
                        (_attempt + 1) + '/' + _attempts + '.');
                    if (typeof SharedArrayBuffer === 'function' &&
                        typeof Atomics === 'object' && typeof Atomics.wait === 'function') {
                        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0,
                            _retryDelays[_attempt - 1]);
                    }
                }
            }
            throw new Error('candidate-ready DB write exhausted its bounded retries');
        } catch (eRec) {
            if (requireDurableReadback === true) {
                try {
                    args.jobLog('FATAL: Candidate-ready outcome was not durably recorded: ' +
                        eRec.message + '. Replacement is blocked.');
                } catch (eRecRequiredLog) {}
                var durabilityError = new Error(
                    'candidate-ready DB durability failed: ' + eRec.message);
                durabilityError.code = 'TDARR_VMAF_CANDIDATE_READY_DURABILITY_FATAL';
                throw durabilityError;
            }
            try { args.jobLog('Job outcome record skipped (non-fatal): ' + eRec.message); } catch (eRec2) {}
            return false;
        }
    }

    function recordEmptyBandShadow(outcome, skipReason) {
        if (args.variables.vmafEmptyBandShadowOutcomeRecorded === true) return;
        var prior = args.variables.vmafSameTitleEmptyBandShadow;
        if (!prior || typeof prior !== 'object') return;
        try {
            var fs = require('fs');
            var emptyBand = require('../../_lib/emptyBandShadow.js');
            var policy = args.variables.vmafQualityRiskPolicy || {};
            var cambiLimit = feasibility.effectiveCambiLimit({
                isAnimation: args.variables.vmafMediaIsAnimation === true,
                isHDR: args.variables.isHDR === true || args.variables.vmafIsHDR === true,
                sourceCambi: args.variables.vmafSourceCAMBI,
                sourceCambiP95: args.variables.vmafSourceCAMBIP95,
                cambiTolerance: 1.0,
            });
            var proof = emptyBand.assess(args.variables.vmafAggregatedResults || [], {
                targetVmaf: Number(args.variables.vmafMinVMAF) || 95,
                vmafP1Floor: Number(policy.adaptiveFrameFloor) || Number(args.variables.vmafMinFrameVMAF),
                cambiLimit: cambiLimit,
                maxOutputRatioPct: Number(args.variables.vmafMaxOutputRatioPct) ||
                    Number(liveSizeCompare && liveSizeCompare.thresholdPerc) || 100,
                gridStep: 0.1,
            });
            var actualNoFeasible = skipReason === 'no_feasible_parameters';
            var actualEligible = outcome === 'success' || actualNoFeasible;
            var retiredProofWouldHavePredicted = prior.recommendBoundaryFirst === true && proof.provenEmpty === true;
            var record = {
                schema: 3,
                proofMode: 'retired_no_feasible_inference_v3',
                timestamp: new Date().toISOString(),
                jobId: args.variables.vmafCanonicalJobId || args.variables.vmafJobId || args.variables.vmafRunId || null,
                title: prior.title || null,
                tier: prior.tier || null,
                isHDR: prior.isHDR === true,
                priorTerminalOutcomes: Number(prior.priorTerminalOutcomes) || 0,
                priorNoFeasible: Number(prior.priorNoFeasible) || 0,
                recommendBoundaryFirst: prior.recommendBoundaryFirst === true,
                historyMeasurementOrderHint: prior.recommendBoundaryFirst === true,
                hintVersion: Number(prior.hintVersion) || 1,
                boundarySeedApplied: prior.boundarySeedApplied === true,
                cq16GiveUpFired: args.variables.vmafCq16GiveUpFired === true,
                effectivePolicy: {
                    targetVmaf: Number(args.variables.vmafMinVMAF) || 95,
                    adaptiveFrameFloor: Number(policy.adaptiveFrameFloor) || Number(args.variables.vmafMinFrameVMAF) || null,
                    cambiLimit: cambiLimit,
                    maxOutputRatioPct: Number(args.variables.vmafMaxOutputRatioPct) ||
                        Number(liveSizeCompare && liveSizeCompare.thresholdPerc) || 100,
                },
                retrospectiveEmptyBandProof: proof,
                retiredProofWouldHavePredicted: retiredProofWouldHavePredicted,
                predictedNoFeasibleWithProof: false,
                actual: { eligible: actualEligible, outcome: outcome, skipReason: skipReason || null,
                    noFeasible: actualNoFeasible },
                falseNoFeasiblePrediction: false,
                action: 'shadow_only_history_hint_no_skip_no_reorder',
            };
            fs.appendFileSync('/app/configs/vmaf_empty_band_shadow.jsonl', JSON.stringify(record) + '\n', 'utf8');
            args.variables.vmafEmptyBandShadowOutcome = record;
            args.variables.vmafEmptyBandShadowOutcomeRecorded = true;
            args.jobLog('Empty-band history shadow: measurementOrderHint=' + record.historyMeasurementOrderHint +
                ', retiredProofDiagnostic=' + proof.provenEmpty + ', actualNoFeasible=' + actualNoFeasible +
                '; no CQ/file skip or measurement reorder applied');
        } catch (shadowError) {
            args.jobLog('Empty-band shadow write failed (non-fatal): ' + shadowError.message);
        }
    }

    function recordSizeFailureShadowOutcome(outcome, skipReason) {
        if (args.variables.vmafSizeFailureShadowOutcomeRecorded === true) return;
        var substitutionAudit = args.variables.vmafPostEncodeCqSubstitution;
        if (substitutionAudit && typeof substitutionAudit === 'object') {
            // The prediction describes the selector's requested CQ, while the completed
            // checkpoint has a different (lower) physical CQ. Never join that output size
            // to the requested-CQ prediction: it would be a mislabeled training outcome.
            var excluded = {
                schema: 3,
                event: 'outcome_excluded',
                ts: new Date().toISOString(),
                prediction_id: args.variables.vmafSizeFailureShadowPrediction &&
                    args.variables.vmafSizeFailureShadowPrediction.prediction_id || null,
                job_id: args.variables.vmafCanonicalJobId ||
                    args.variables.vmafJobId || args.variables.vmafRunId || null,
                requested_cq: finiteNumberOrNull(substitutionAudit.requested_cq),
                actual_cq: finiteNumberOrNull(substitutionAudit.actual_cq),
                eligible: false,
                exclusion_reason: 'conservative_postencode_cq_substitution',
                action: 'excluded_no_requested_cq_to_physical_output_label_join',
            };
            args.variables.vmafSizeFailureShadowOutcome = excluded;
            args.variables.vmafSizeFailureShadowOutcomeExclusion = excluded;
            args.variables.vmafSizeFailureShadowOutcomeExcluded = true;
            args.variables.vmafSizeFailureShadowOutcomeRecorded = true;
            args.jobLog('Size-failure shadow outcome excluded: conservative checkpoint substitution used physical CQ ' +
                excluded.actual_cq + ' for requested CQ ' + excluded.requested_cq +
                '; no mismatched-CQ label was recorded.');
            return;
        }
        var prediction = args.variables.vmafSizeFailureShadowPrediction;
        if (!prediction || typeof prediction !== 'object') return;
        try {
            var sizeShadow = require('../../_lib/sizeFailureShadow.js');
            var finalRatio = Number(args.variables.vmafFinalOutputRatioPct);
            var threshold = Number((liveSizeCompare && liveSizeCompare.thresholdPerc) ||
                args.variables.vmafMaxOutputRatioPct);
            var sizeStatus = 'unknown';
            if (outcome === 'success' && isFinite(finalRatio) && isFinite(threshold)) {
                sizeStatus = finalRatio <= threshold ? 'met' : 'failed';
            }
            var actual = {
                outcome: outcome,
                skip_reason: skipReason || null,
                size_target_status: sizeStatus,
                final_output_ratio_pct: isFinite(finalRatio) ? finalRatio : null,
                threshold_pct: isFinite(threshold) ? threshold : null,
            };
            var label = sizeShadow.labelOutcome(actual);
            var record = {
                schema: 2,
                event: 'outcome',
                ts: new Date().toISOString(),
                prediction_id: prediction.prediction_id || null,
                job_id: prediction.job_id || args.variables.vmafJobId || args.variables.vmafRunId || null,
                file_path: prediction.file_path || null,
                selected_cq: prediction.selected_cq,
                probability: prediction.probability,
                would_skip_095: prediction.would_skip_095 === true,
                would_skip_098: prediction.would_skip_098 === true,
                model_schema: prediction.model_schema || null,
                model_hash_sha256: prediction.model_hash_sha256 || null,
                model_trained_at: prediction.model_trained_at || null,
                model_rows: prediction.model_rows || null,
                pipeline_version: prediction.pipeline_version || null,
                actual: actual,
                label: label,
                false_skip_095: label === 0 && prediction.would_skip_095 === true,
                false_skip_098: label === 0 && prediction.would_skip_098 === true,
                action: 'shadow_only_terminal_label_joined_by_prediction_id',
            };
            sizeShadow.appendShadowLog(record);
            args.variables.vmafSizeFailureShadowOutcome = record;
            args.variables.vmafSizeFailureShadowOutcomeRecorded = true;
            args.jobLog('Size-failure shadow outcome: label=' + label +
                ', p=' + (Number(prediction.probability) * 100).toFixed(1) +
                '%, falseSkip@0.95=' + record.false_skip_095 +
                ', falseSkip@0.98=' + record.false_skip_098);
        } catch (sizeShadowError) {
            args.jobLog('Size-failure shadow outcome write failed (non-fatal): ' + sizeShadowError.message);
        }
    }

    function finalizeFlowOutcome(reason, outcome, skipReason) {
        if (args.variables.liveSizeCompare) {
            args.variables.liveSizeCompare.enabled = false;
            args.variables.liveSizeCompare.error = false;
            args.variables.liveSizeCompare.errorType = '';
            args.variables.liveSizeCompare.clearedBeforePostRemux = true;
            args.variables.liveSizeCompare.clearReason = reason;
        }
        args.jobLog('Finalized transcode outcome before leaving monitor: ' + reason);
        // A technically complete base encode is still pre-delivery: grain,
        // reorder/remux, exact delivered-size validation, and replacement remain.
        // Only keep-original/technical paths are terminal here. Successful
        // candidates are finalized by the post-replacement delivery authority.
        var sizePolicy = deliveryPolicy.resolve(args.variables);
        if (outcome === 'success') {
            var pendingJobId = String(args.variables.vmafCanonicalJobId || '').trim();
            var pendingCheckpoint = args.variables.vmafPostEncodeCheckpoint;
            var pendingCheckpointKey = pendingCheckpoint &&
                String(pendingCheckpoint.checkpoint_key || '');
            if (!pendingJobId || !/^[0-9a-f]{64}$/.test(pendingCheckpointKey)) {
                var pendingIdentityError = new Error(
                    'candidate-ready delivery requires exact canonical job and checkpoint identities');
                pendingIdentityError.code = 'TDARR_VMAF_CANDIDATE_READY_DURABILITY_FATAL';
                throw pendingIdentityError;
            }
            var finalRatio = Number(args.variables.vmafFinalOutputRatioPct);
            var candidateSizeMb = Number(args.variables.vmafFinalOutputSizeMB);
            var pendingFields = {
                transcode_succeeded: null,
                met_vmaf_target: null,
                final_output_size_mb: null,
                final_output_ratio_pct: null,
                actual_size_reduction_pct: null,
                met_size_target: null,
                size_target_status: 'pending_delivery',
                target_size_reduction_pct: sizePolicy.targetReductionPct,
                minimum_size_reduction_pct: sizePolicy.minimumReductionPct,
                max_final_output_ratio_pct: sizePolicy.maxFinalOutputRatioPct,
                size_policy_version: sizePolicy.version,
                outcome_stage: 'candidate_ready',
                delivered_at: null,
                replacement_attestation_version: null,
                replacement_backup_retained: null,
                delivery_transaction_id: null,
                delivery_checkpoint_key: pendingCheckpointKey,
                skip_reason: null,
            };
            if (conservativeCqSubstitution) {
                pendingFields = Object.assign(pendingFields, conservativeCqSubstitution.fields);
            }
            var dbRecorded = recordJobOutcome(pendingFields, true);
            args.variables.vmafCandidateOutputRatioPct =
                isFinite(finalRatio) ? finalRatio : null;
            args.variables.vmafCandidateOutputSizeMB =
                isFinite(candidateSizeMb) ? candidateSizeMb : null;
            args.variables.vmafDeliveryOutcomePending = {
                schema: 'vmaf-delivery-outcome-pending/v1',
                version: 1,
                status: 'candidate_ready',
                recorded_at: new Date().toISOString(),
                database_recorded: true,
                job_id: pendingJobId,
                checkpoint_key: pendingCheckpointKey,
                source_path: String(args.variables.vmafOriginalFile ||
                    args.originalLibraryFile && args.originalLibraryFile._id ||
                    args.inputFileObj && (args.inputFileObj._id || args.inputFileObj.file) || ''),
                size_policy_version: sizePolicy.version,
                target_size_reduction_pct: sizePolicy.targetReductionPct,
                minimum_size_reduction_pct: sizePolicy.minimumReductionPct,
                max_final_output_ratio_pct: sizePolicy.maxFinalOutputRatioPct,
                candidate_output_ratio_pct: args.variables.vmafCandidateOutputRatioPct,
                candidate_output_size_mb: args.variables.vmafCandidateOutputSizeMB,
            };
            if (conservativeCqSubstitution) {
                args.variables.vmafPostEncodeCqSubstitutionDbOutcome = {
                    schema: 'vmaf_postencode_cq_substitution_db_outcome_v1',
                    timestamp: new Date().toISOString(),
                    job_id: args.variables.vmafCanonicalJobId || null,
                    requested_cq: conservativeCqSubstitution.requestedCQ,
                    actual_cq: conservativeCqSubstitution.actualCQ,
                    physical_selection: Object.assign({}, conservativeCqSubstitution.fields),
                    recorded: dbRecorded === true,
                    action: dbRecorded === true
                        ? 'canonical_job_selection_rewritten_to_physical_output'
                        : 'canonical_job_selection_rewrite_failed',
                };
                if (dbRecorded === true) {
                    args.jobLog('Canonical VMAF job selection rewritten to physical retained output: requested CQ ' +
                        conservativeCqSubstitution.requestedCQ + ', actual CQ ' +
                        conservativeCqSubstitution.actualCQ + ', parameter set ' +
                        conservativeCqSubstitution.fields.selected_parameter_set_id + '.');
                } else {
                    args.jobLog('WARNING: Physical retained-CQ selection could not be written to the canonical VMAF job row.');
                }
            }
        } else {
            recordJobOutcome({
                transcode_succeeded: 0,
                met_vmaf_target: null,
                met_size_target: null,
                final_output_size_mb: null,
                final_output_ratio_pct: null,
                actual_size_reduction_pct: null,
                size_target_status: 'not_delivered',
                target_size_reduction_pct: sizePolicy.targetReductionPct,
                minimum_size_reduction_pct: sizePolicy.minimumReductionPct,
                max_final_output_ratio_pct: sizePolicy.maxFinalOutputRatioPct,
                size_policy_version: sizePolicy.version,
                outcome_stage: technicalFailure ? 'technical_failure' : 'keep_original',
                delivered_at: null,
                replacement_attestation_version: null,
                replacement_backup_retained: null,
                skip_reason: skipReason || (wasCancelled ? 'live_size_guard_exceeded' : 'transcode_gave_up')
            });
        }
        if (outcome !== 'success') {
            recordSizeFailureShadowOutcome(outcome, skipReason);
            recordEmptyBandShadow(outcome, skipReason);
        }
    }

    if (explicitSuccess && args.variables.vmafPostEncodeCqSubstitution != null) {
        try {
            conservativeCqSubstitution = resolveConservativeCqSubstitution(args.variables);
        } catch (substitutionError) {
            args.variables.vmafTranscodeSucceeded = false;
            args.variables.vmafTranscodeStatus = 'technical_failure';
            args.variables.vmafTranscodeFailureReason =
                'invalid_postencode_cq_substitution_audit: ' + substitutionError.message;
            finalizeFlowOutcome('technical failure: invalid post-encode CQ substitution audit',
                'technical_failure', 'technical_transcode_failure');
            throw new Error('Invalid conservative post-encode CQ substitution: ' +
                substitutionError.message);
        }
    }

    if (keepOriginalRequested) {
        args.jobLog('KEEP ORIGINAL: No feasible transcode parameters were selected; stopping before reorder, replace, notify, and unmonitor stages.');
        args.variables.vmafTranscodeGaveUp = true;
        finalizeFlowOutcome('keep original: ' + transcodeFailureReason, 'keep_original', 'no_feasible_parameters');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 4,
            variables: args.variables,
        };
    }

    if (technicalFailure || (!wasCancelled && !explicitSuccess)) {
        args.variables.vmafTranscodeStatus = 'technical_failure';
        finalizeFlowOutcome('technical failure: ' + transcodeFailureReason, 'technical_failure', 'technical_transcode_failure');
        throw new Error('VMAF final transcode did not complete successfully (' + transcodeStatus + '): ' + transcodeFailureReason);
    }

    args.jobLog('=== VMAF-Aware Transcode Retry Check ===');
    args.jobLog('Current retry count: ' + retryCount + ' / ' + maxRetries);
    args.jobLog('VMAF thresholds: minVMAF=' + minVMAF + ', minFrameVMAF=' + minFrameVMAF);
    args.jobLog('Available sweep results: ' + aggregatedResults.length + ' parameter sets');

    // Helper function to check if a result meets VMAF thresholds
    function meetsVMAFThreshold(result) {
        if (!result) return false;
        var riskPolicy = args.variables.vmafQualityRiskPolicy || {};
        return feasibility.evaluate(result, {
            targetVmaf: minVMAF,
            vmafMetric: 'harmonic',
            requireVmafMean: true,
            vmafP1Floor: minFrameVMAF > 0 ? minFrameVMAF : null,
            cambiLimit: feasibility.effectiveCambiLimit({
                isHDR: riskPolicy.isHDR === true || args.variables.isHDR === true,
                isAnimation: riskPolicy.isAnimation === true || args.variables.vmafMediaIsAnimation === true,
                sourceCambi: args.variables.vmafSourceCAMBI,
                sourceCambiP95: args.variables.vmafSourceCAMBIP95
            })
        }).feasible;
    }

    // Helper function to check if VMAF is significantly below threshold (impossible scenario)
    function isSignificantlyBelowThreshold(result) {
        if (!result) return false;
        var threshold = minVMAF - vmafBelowThresholdMargin;
        return result.avgVMAF < threshold;
    }

    // Helper function to find valid higher CQ from tested results
    function findNextValidCQ(currentCQ) {
        // Sort results by CQ value
        var sortedResults = aggregatedResults
            .filter(function(r) {
                return r.parameterSet &&
                       r.parameterSet.quality !== undefined &&
                       r.parameterSet.quality > currentCQ;
            })
            .sort(function(a, b) {
                return a.parameterSet.quality - b.parameterSet.quality;
            });

        // Find the lowest higher CQ that meets VMAF threshold
        for (var i = 0; i < sortedResults.length; i++) {
            if (meetsVMAFThreshold(sortedResults[i])) {
                return {
                    cq: sortedResults[i].parameterSet.quality,
                    vmaf: sortedResults[i].avgVMAF,
                    minVMAF: sortedResults[i].minVMAF,
                    result: sortedResults[i]
                };
            }
        }
        return null;
    }

    // Helper function to check if any higher CQ was tested (regardless of VMAF)
    function findAnyHigherCQTested(currentCQ) {
        var higherResults = aggregatedResults.filter(function(r) {
            return r.parameterSet &&
                   r.parameterSet.quality !== undefined &&
                   r.parameterSet.quality > currentCQ;
        });
        return higherResults.length > 0 ? higherResults : null;
    }

    // Calculate VMAF trend-based increment using weighted drop per CQ step
    function calculateVMAFTrendBasedIncrement(results, currentCQ, minVMAF, fudgeFactor, cqStepSize) {
        if (!results || results.length < 2) return null;

        var byCQ = results.filter(function(r) {
            return r && r.parameterSet && r.parameterSet.quality !== undefined && r.avgVMAF !== undefined;
        }).sort(function(a, b) {
            return a.parameterSet.quality - b.parameterSet.quality;
        });

        if (byCQ.length < 2) return null;

        var weightedDrop = 0;
        var weightTotal = 0;
        for (var i = 0; i < byCQ.length - 1; i++) {
            var curr = byCQ[i];
            var next = byCQ[i + 1];
            var cqDelta = next.parameterSet.quality - curr.parameterSet.quality;
            if (cqDelta <= 0) continue;
            var vmafDrop = (curr.avgVMAF - next.avgVMAF);
            if (vmafDrop < 0) vmafDrop = 0; // guard non-monotonic noise
            var dropRate = vmafDrop / cqDelta;
            var weight = 1 + (i / (byCQ.length - 1)); // later (higher CQ) pairs weigh more
            weightedDrop += dropRate * weight;
            weightTotal += weight;
        }

        if (weightTotal === 0) return null;
        var avgDropPerStep = weightedDrop / weightTotal;
        if (avgDropPerStep <= 0) return null;

        var currentEntry = null;
        for (var c = 0; c < byCQ.length; c++) {
            if (byCQ[c].parameterSet.quality === currentCQ) {
                currentEntry = byCQ[c];
                break;
            }
        }
        if (!currentEntry) {
            // pick closest lower CQ, otherwise lowest available
            for (var c2 = byCQ.length - 1; c2 >= 0; c2--) {
                if (byCQ[c2].parameterSet.quality < currentCQ) {
                    currentEntry = byCQ[c2];
                    break;
                }
            }
            if (!currentEntry) currentEntry = byCQ[0];
        }

        var currentVMAF = currentEntry.avgVMAF || 0;
        var targetFloor = minVMAF + (fudgeFactor || 0);
        var vmafMargin = currentVMAF - targetFloor;
        var calculatedIncrement = vmafMargin > 0 ? Math.ceil((vmafMargin / avgDropPerStep) * cqStepSize) : cqStepSize;
        if (calculatedIncrement < cqStepSize) calculatedIncrement = cqStepSize;

        var cappedIncrement = Math.min(calculatedIncrement, 30); // cap aggressive jumps
        var targetCQ = Math.min(51, currentCQ + cappedIncrement);

        return {
            increment: cappedIncrement,
            targetCQ: targetCQ,
            avgDropPerStep: avgDropPerStep,
            currentVMAF: currentVMAF,
            margin: vmafMargin,
            pairsUsed: byCQ.length - 1
        };
    }

    // Helper function to calculate new CQ range for sweep retry
    function calculateSweepRetryRange(currentCQ) {
        var testedCQs = args.variables.vmafTestedCQs || [];
        var testedCQSet = {};
        for (var i = 0; i < testedCQs.length; i++) {
            testedCQSet[testedCQs[i]] = true;
        }

        var cqStepSize = args.variables.vmafCQStep || 2;
        var trendFudge = Number(args.variables.vmafTrendFudgeFactor || 2.5);

        var trend = calculateVMAFTrendBasedIncrement(
            aggregatedResults,
            currentCQ,
            minVMAF,
            trendFudge,
            cqStepSize
        );

        if (trend && trend.avgDropPerStep) {
            args.variables.vmafTrendAvgDropPerCQ = trend.avgDropPerStep;
            args.variables.vmafTrendIncrementUsed = trend.increment;
            args.variables.vmafTrendCurrentVMAF = trend.currentVMAF;
            args.variables.vmafTrendMargin = trend.margin;
        }

        // Start from trend target if available, otherwise default window
        var proposedMin = currentCQ + cqStepSize;
        var proposedMax = Math.min(51, trend ? trend.targetCQ : currentCQ + 12);

        // Filter out already-tested CQ values
        var untestedCQs = [];
        for (var cq = proposedMin; cq <= proposedMax; cq += cqStepSize) {
            if (!testedCQSet[cq]) {
                untestedCQs.push(cq);
            }
        }

        // If fewer than 3 untested values, expand upward
        while (untestedCQs.length < 3 && proposedMax < 51) {
            proposedMax += cqStepSize;
            if (proposedMax <= 51 && !testedCQSet[proposedMax]) {
                untestedCQs.push(proposedMax);
            }
        }

        if (untestedCQs.length === 0) {
            return null; // No untested CQ values available
        }

        return {
            min: Math.min.apply(null, untestedCQs),
            max: Math.max.apply(null, untestedCQs),
            untestedCQs: untestedCQs,
            testedCQsAvoided: testedCQs.filter(function(cq) { return cq >= proposedMin && cq <= proposedMax; })
        };
    }

    if (wasCancelled) {
        args.jobLog('⚠ Transcode was cancelled due to file size exceeding threshold');

        // Get current CQ that failed
        var currentCQ = args.variables.vmafTranscodeRetryCQ ||
                        (args.variables.vmafBestParameters && args.variables.vmafBestParameters.quality) ||
                        30;
        var originalCQ = args.variables.vmafTranscodeOriginalCQ || currentCQ;
        var originalFileSizeMB = args.inputFileObj.file_size || 0;

        args.jobLog('Current failed CQ: ' + currentCQ);

        // Store original CQ on first retry
        if (retryCount === 0) {
            args.variables.vmafTranscodeOriginalCQ = currentCQ;
            originalCQ = currentCQ;
        }

        // Check if we've exceeded max retries
        if (retryCount >= maxRetries) {
            args.jobLog('⚠ Maximum retries (' + maxRetries + ') reached');

            // Store failure info for learning
            if (!args.variables.vmafTranscodeFailures) {
                args.variables.vmafTranscodeFailures = [];
            }
            args.variables.vmafTranscodeFailures.push({
                originalCQ: originalCQ,
                finalCQ: currentCQ,
                retries: retryCount,
                reason: 'max_retries_exceeded',
                succeeded: false,
                vmafAtFinalCQ: args.variables.vmafBestVMAF || null
            });

            args.jobLog('Keeping original: maximum size retries reached and the output is still too large.');
            args.variables.vmafTranscodeGaveUp = true;
            args.variables.vmafTranscodeStatus = 'keep_original_size_retries_exhausted';
            args.variables.vmafTranscodeFailureReason = 'max_size_retries_exceeded';
            finalizeFlowOutcome('keep original: maximum size retries reached', 'keep_original', 'live_size_guard_exceeded');
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 4,
                variables: args.variables,
            };
        }

        // VMAF-aware retry: Find next valid CQ from tested results
        var nextValidCQ = findNextValidCQ(currentCQ);

        if (nextValidCQ) {
            // Found a tested higher CQ with acceptable VMAF - use it
            args.jobLog('');
            args.jobLog('✓ Found tested CQ with acceptable VMAF');
            args.jobLog('  Next valid CQ: ' + nextValidCQ.cq);
            args.jobLog('  VMAF at CQ ' + nextValidCQ.cq + ': ' + nextValidCQ.vmaf.toFixed(2) +
                       (nextValidCQ.minVMAF !== null ? ' (min: ' + nextValidCQ.minVMAF.toFixed(2) + ')' : ''));

            // Increment retry count
            retryCount++;
            args.variables.vmafTranscodeRetryCount = retryCount;

            // Store new retry CQ
            args.variables.vmafTranscodeRetryCQ = nextValidCQ.cq;

            // Store retry info for learning
            if (!args.variables.vmafTranscodeRetryHistory) {
                args.variables.vmafTranscodeRetryHistory = [];
            }
            args.variables.vmafTranscodeRetryHistory.push({
                fromCQ: currentCQ,
                toCQ: nextValidCQ.cq,
                vmafAtToCQ: nextValidCQ.vmaf,
                minVMAFAtToCQ: nextValidCQ.minVMAF,
                retryNumber: retryCount
            });

            // Clear liveSizeCompare error flag for next attempt
            if (args.variables.liveSizeCompare) {
                args.variables.liveSizeCompare.error = false;
            }

            // Clear transcode output file if it exists (partial transcode)
            var outputFile = args.variables.vmafTranscodeOutputPath;
            if (outputFile) {
                var retryCleanup = removePartialOutputForRetry(args, outputFile);
                if (retryCleanup.removed) {
                    args.jobLog('Cleared contained partial transcode output: ' + retryCleanup.path);
                }
            }

            args.jobLog('');
            args.jobLog('✓ RETRYING transcode with validated higher CQ');
            args.jobLog('  Previous CQ: ' + currentCQ);
            args.jobLog('  New CQ: ' + nextValidCQ.cq + ' (validated VMAF: ' + nextValidCQ.vmaf.toFixed(2) + ')');
            args.jobLog('  Retry attempt: ' + retryCount + ' / ' + maxRetries);

            // Guide next run to execute this CQ first
            args.variables.vmafNextCQs = [nextValidCQ.cq];

            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 1,
                variables: args.variables,
            };
        }

        // No valid higher CQ found - check if any higher CQ was tested at all
        var higherCQsTested = findAnyHigherCQTested(currentCQ);

        if (higherCQsTested && higherCQsTested.length > 0) {
            // Higher CQ values were tested but none had acceptable VMAF
            // Check if they're significantly below threshold (impossible scenario)
            args.jobLog('');
            args.jobLog('⚠ Higher CQ values were tested but none meet VMAF threshold:');

            var impossibleDetected = false;
            var worstResult = null;

            for (var i = 0; i < higherCQsTested.length; i++) {
                var result = higherCQsTested[i];
                var cq = result.parameterSet.quality;
                var vmaf = result.avgVMAF;
                var minVmaf = result.minVMAF;

                args.jobLog('  CQ ' + cq + ': VMAF=' + vmaf.toFixed(2) +
                           (minVmaf !== null ? ', Min=' + minVmaf.toFixed(2) : '') +
                           (vmaf < minVMAF ? ' (below threshold ' + minVMAF + ')' : ''));

                if (isSignificantlyBelowThreshold(result)) {
                    impossibleDetected = true;
                    if (!worstResult || result.avgVMAF < worstResult.avgVMAF) {
                        worstResult = result;
                    }
                }
            }

            if (impossibleDetected && worstResult) {
                // VMAF is significantly below threshold - impossible scenario
                var deficit = minVMAF - worstResult.avgVMAF;

                // Store failure info for learning
                if (!args.variables.vmafTranscodeFailures) {
                    args.variables.vmafTranscodeFailures = [];
                }
                args.variables.vmafTranscodeFailures.push({
                    originalCQ: originalCQ,
                    finalCQ: currentCQ,
                    retries: retryCount,
                    reason: 'vmaf_too_low_at_higher_cq',
                    succeeded: false,
                    testedHigherCQs: higherCQsTested.map(function(r) {
                        return { cq: r.parameterSet.quality, vmaf: r.avgVMAF };
                    }),
                    vmafDeficit: deficit
                });

                // Not an error: the file simply cannot be shrunk at acceptable quality.
                // Give up gracefully and keep the original instead of failing the job.
                args.jobLog('');
                args.jobLog('⚠ GIVING UP: Cannot achieve target VMAF at higher compression.');
                args.jobLog('  Tested CQ ' + worstResult.parameterSet.quality + ' had VMAF ' + worstResult.avgVMAF.toFixed(2) +
                    ' (' + deficit.toFixed(1) + ' points below threshold ' + minVMAF + ').');
                args.jobLog('  Keeping original file - it is already efficiently encoded.');
                args.variables.vmafTranscodeGaveUp = true;
                args.variables.vmafTranscodeStatus = 'keep_original_quality_limit';
                args.variables.vmafTranscodeFailureReason = 'vmaf_too_low_at_higher_cq';
                finalizeFlowOutcome('keep original: VMAF too low at higher CQ', 'keep_original', 'quality_limit_reached');
                return {
                    outputFileObj: args.inputFileObj,
                    outputNumber: 4,
                    variables: args.variables,
                };
            }

            // VMAF is close to threshold but not acceptable - might need different approach
            args.jobLog('');
            args.jobLog('⚠ Higher CQ values tested but VMAF close to but below threshold');
            args.jobLog('  No automatic retry possible - file may be difficult to compress');

            // Store failure info for learning
            if (!args.variables.vmafTranscodeFailures) {
                args.variables.vmafTranscodeFailures = [];
            }
            args.variables.vmafTranscodeFailures.push({
                originalCQ: originalCQ,
                finalCQ: currentCQ,
                retries: retryCount,
                reason: 'no_valid_higher_cq',
                succeeded: false,
                testedHigherCQs: higherCQsTested.map(function(r) {
                    return { cq: r.parameterSet.quality, vmaf: r.avgVMAF };
                })
            });

            args.variables.vmafTranscodeGaveUp = true;
            args.variables.vmafTranscodeStatus = 'keep_original_no_valid_higher_cq';
            args.variables.vmafTranscodeFailureReason = 'no_valid_higher_cq';
            finalizeFlowOutcome('keep original: no valid higher CQ', 'keep_original', 'quality_limit_reached');
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 4,
                variables: args.variables,
            };
        }

        // No higher CQ was tested at all - trigger sweep retry
        args.jobLog('');
        args.jobLog('⚠ No higher CQ values were tested during sweep');
        args.jobLog('  Triggering VMAF sweep retry at higher CQ range');

        var sweepRetryRange = calculateSweepRetryRange(currentCQ);

        if (!sweepRetryRange) {
            // No untested CQ values available (all CQ values up to 51 tested).
            // Not an error: the file cannot be shrunk at target quality. Keep original.
            if (!args.variables.vmafTranscodeFailures) {
                args.variables.vmafTranscodeFailures = [];
            }
            args.variables.vmafTranscodeFailures.push({
                originalCQ: originalCQ,
                finalCQ: currentCQ,
                retries: retryCount,
                reason: 'all_cq_values_exhausted',
                succeeded: false
            });
            args.jobLog('');
            args.jobLog('⚠ GIVING UP: All CQ values up to 51 have been tested; none produce a smaller file at target VMAF ' + minVMAF + '.');
            args.jobLog('  Keeping original file - it is already efficiently encoded.');
            args.variables.vmafTranscodeGaveUp = true;
            args.variables.vmafTranscodeStatus = 'keep_original_cq_exhausted';
            args.variables.vmafTranscodeFailureReason = 'all_cq_values_exhausted';
            finalizeFlowOutcome('keep original: all CQ values exhausted', 'keep_original', 'cq_range_exhausted');
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 4,
                variables: args.variables,
            };
        }

        // If the sweep-retry budget is already exhausted, do not trigger another loop -
        // checkCQRangeRetry would hard-fail the job. Give up gracefully instead.
        if (args.variables.vmafSweepRetriesExhausted) {
            if (!args.variables.vmafTranscodeFailures) {
                args.variables.vmafTranscodeFailures = [];
            }
            args.variables.vmafTranscodeFailures.push({
                originalCQ: originalCQ,
                finalCQ: currentCQ,
                retries: retryCount,
                reason: 'sweep_retries_exhausted',
                succeeded: false,
                proposedRange: sweepRetryRange.min + '-' + sweepRetryRange.max
            });
            args.jobLog('');
            args.jobLog('⚠ GIVING UP: Sweep retries exhausted; would need CQ ' + sweepRetryRange.min + '-' + sweepRetryRange.max + ' but no retry budget remains.');
            args.jobLog('  Keeping original file - it is already efficiently encoded.');
            args.variables.vmafTranscodeGaveUp = true;
            args.variables.vmafTranscodeStatus = 'keep_original_sweep_retries_exhausted';
            args.variables.vmafTranscodeFailureReason = 'sweep_retries_exhausted';
            finalizeFlowOutcome('keep original: sweep retries exhausted', 'keep_original', 'sweep_retries_exhausted');
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 4,
                variables: args.variables,
            };
        }

        // Set up sweep retry
        args.variables.vmafTriggerSweepRetry = true;
        args.variables.vmafSweepRetryReason = 'no_higher_cq_tested';
        args.variables.vmafOverrideCQMin = sweepRetryRange.min;
        args.variables.vmafOverrideCQMax = sweepRetryRange.max;
        args.variables.vmafNextCQs = sweepRetryRange.untestedCQs ? sweepRetryRange.untestedCQs.slice(0, 4) : [sweepRetryRange.min, sweepRetryRange.max];

        // Store retry info for learning
        if (!args.variables.vmafSweepRetryHistory) {
            args.variables.vmafSweepRetryHistory = [];
        }
        args.variables.vmafSweepRetryHistory.push({
            triggerCQ: currentCQ,
            newCQRange: sweepRetryRange.min + '-' + sweepRetryRange.max,
            reason: 'no_higher_cq_tested',
            untestedCQs: sweepRetryRange.untestedCQs,
            avoidedCQs: sweepRetryRange.testedCQsAvoided
        });

        // Clear liveSizeCompare error flag
        if (args.variables.liveSizeCompare) {
            args.variables.liveSizeCompare.error = false;
        }

        // Clear transcode output file if it exists
        var outputFile = args.variables.vmafTranscodeOutputPath;
        if (outputFile) {
            var sweepCleanup = removePartialOutputForRetry(args, outputFile);
            if (sweepCleanup.removed) {
                args.jobLog('Cleared contained partial transcode output: ' + sweepCleanup.path);
            }
        }

        args.jobLog('');
        args.jobLog('✓ TRIGGERING VMAF SWEEP RETRY at higher CQ range');
        args.jobLog('  Current failed CQ: ' + currentCQ);
        args.jobLog('  New CQ range: ' + sweepRetryRange.min + ' - ' + sweepRetryRange.max);
        args.jobLog('  Untested CQ values: ' + sweepRetryRange.untestedCQs.join(', '));
        if (sweepRetryRange.testedCQsAvoided.length > 0) {
            args.jobLog('  Avoiding retest of: ' + sweepRetryRange.testedCQsAvoided.join(', '));
        }

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 3,
            variables: args.variables,
        };

    } else {
        // Only the explicit success state can reach output 2 and the deployed
        // reorder/replace/notify/unmonitor branch.
        if (conservativeCqSubstitution) {
            args.jobLog('✓ Transcode completed successfully using conservative retained checkpoint substitution' +
                ' (requested CQ ' + conservativeCqSubstitution.requestedCQ +
                ', physical CQ ' + conservativeCqSubstitution.actualCQ +
                ', no title re-encode)');
        }
        if (retryCount > 0) {
            if (!conservativeCqSubstitution) {
                args.jobLog('✓ Transcode completed successfully after ' + retryCount + ' retry attempt(s)');
            } else {
                args.jobLog('  Completed after ' + retryCount +
                    ' retry attempt(s); retry provenance remains separate from the physical checkpoint CQ.');
            }

            // Store success info for learning
            if (!args.variables.vmafTranscodeFailures) {
                args.variables.vmafTranscodeFailures = [];
            }
            var finalCQ = conservativeCqSubstitution
                ? conservativeCqSubstitution.actualCQ
                : (args.variables.vmafTranscodeRetryCQ ||
                    (args.variables.vmafBestParameters && args.variables.vmafBestParameters.quality));
            args.variables.vmafTranscodeFailures.push({
                originalCQ: args.variables.vmafTranscodeOriginalCQ || finalCQ,
                finalCQ: finalCQ,
                retries: retryCount,
                reason: 'size_too_large',
                succeeded: true,
                retryHistory: args.variables.vmafTranscodeRetryHistory || []
            });
        } else if (!conservativeCqSubstitution) {
            args.jobLog('✓ Transcode completed successfully (no retries needed)');
        }

        finalizeFlowOutcome('explicit transcode success', 'success');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 2,
            variables: args.variables,
        };
    }
};
exports.plugin = plugin;
exports._test = {
    measurementParameterContractSha256: measurementParameterContractSha256,
    resolveConservativeCqSubstitution: resolveConservativeCqSubstitution,
    canonicalRetryWorkRoot: canonicalRetryWorkRoot,
    removePartialOutputForRetry: removePartialOutputForRetry,
};
