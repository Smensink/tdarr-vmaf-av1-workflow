"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

var details = function () { return ({
    name: 'Check CQ Bracket',
    description: 'Checks if target VMAF is bracketed by current CQ tests. If not, expands range intelligently.',
    style: {
        borderColor: 'orange',
    },
    tags: 'video,vmaf,cq,bracket',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faExpand',
    inputs: [
        {
            label: 'Target VMAF',
            name: 'targetVMAF',
            type: 'number',
            defaultValue: '95',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Target minimum VMAF to check bracketing. Default 95 (visually-transparent floor). Must match selectBestParameters minVMAF and testEncodingParameters targetMinVMAF.',
        },
        {
            label: 'Expansion CQ Count',
            name: 'expansionCQCount',
            type: 'number',
            defaultValue: '2',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Number of additional CQ values to test when expanding',
        },
        {
            label: 'High Margin VMAF Headroom',
            name: 'highMarginVMAFHeadroom',
            type: 'number',
            defaultValue: '1.5',
            inputUI: {
                type: 'text',
            },
            tooltip: 'If all tested CQ values are above target by at least this much, expand upward/more compressed.',
        },
        {
            label: '4K High Margin VMAF Headroom',
            name: 'highMarginVMAFHeadroom4K',
            type: 'number',
            defaultValue: '2',
            inputUI: {
                type: 'text',
            },
            tooltip: '4K-specific high-margin threshold for larger upward CQ expansion.',
        },
        {
            label: '4K High Margin Expansion CQ Count',
            name: 'highMarginExpansionCQCount4K',
            type: 'number',
            defaultValue: '4',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Number of additional higher-CQ values to test for 4K files when VMAF headroom remains high.',
        },
        {
            label: 'Three-Stage VMAF Schedule',
            name: 'threeStageVmaf',
            type: 'boolean',
            defaultValue: 'false',
            inputUI: { type: 'switch' },
            tooltip: 'Use n=2 for intermediate refinement only when a reserved n=1 holdout will validate the selected winner. Jobs without a holdout remain n=1.',
        },
        {
            label: 'Intermediate VMAF Subsample',
            name: 'intermediateVmafSubsample',
            type: 'number',
            defaultValue: '2',
            inputUI: { type: 'text' },
            tooltip: 'Frame subsampling for intermediate refinement under the three-stage schedule. Clamp: 2-4.',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'Target bracketed - proceed to selection',
        },
        {
            number: 2,
            tooltip: 'Target NOT bracketed - expand and retest',
        },
    ],
}); };
exports.details = details;

var CRITICAL_DEFAULTS = Object.freeze({
    targetVMAF: 95,
    expansionCQCount: 2,
    highMarginVMAFHeadroom: 1.5,
    highMarginVMAFHeadroom4K: 2,
    highMarginExpansionCQCount4K: 4,
    threeStageVmaf: false,
    intermediateVmafSubsample: 2,
});

function resolveCriticalDefaults(inputs) {
    inputs = inputs || {};
    function boundedNumber(name, min, max, integer) {
        var value = Number(inputs[name]);
        if (!isFinite(value) || value < min || value > max) value = CRITICAL_DEFAULTS[name];
        return integer ? Math.round(value) : value;
    }
    return {
        targetVMAF: boundedNumber('targetVMAF', 0, 100, false),
        expansionCQCount: boundedNumber('expansionCQCount', 1, 16, true),
        highMarginVMAFHeadroom: boundedNumber('highMarginVMAFHeadroom', 0, 20, false),
        highMarginVMAFHeadroom4K: boundedNumber('highMarginVMAFHeadroom4K', 0, 20, false),
        highMarginExpansionCQCount4K: boundedNumber('highMarginExpansionCQCount4K', 1, 16, true),
        threeStageVmaf: inputs.threeStageVmaf === true || inputs.threeStageVmaf === 'true',
        intermediateVmafSubsample: boundedNumber('intermediateVmafSubsample', 2, 4, true),
    };
}

// ── Winner full-rate confirmation (2026-07-21, adaptive subsampling) ──
// With coarse rounds at n=4 (flow input vmafSubsample=4), the selected winner could be a CQ
// whose only measurement was frame-subsampled — carrying the known optimistic subsampling
// bias (~+0.5 VMAF at n=2 in the 07-10 replay) into the shipped decision. Refinement
// midpoints already force n=1 (or n=2 only with a reserved n=1 holdout), and the holdout
// itself always scores at n=1; this closes the remaining gap: if the bracket has converged
// and the winner-elect's coarsest measurement was n>1 with NO holdout reserved to validate
// it, schedule one full-rate re-measure of exactly that CQ before selection.
// Pure decision helper: returns the CQ to confirm, or null. Bounded per-CQ (once each) and
// by a total cap so cascading feasibility flips cannot loop. Kill switch:
// variables.vmafWinnerFullRate === false.
function chooseWinnerFullRateConfirmation(aggregated, feasibleCqs, variables) {
    if (!variables || variables.vmafWinnerFullRate === false) return null;
    if (variables.vmafHoldoutSample) return null; // n=1 holdout will validate the winner
    if (!feasibleCqs || feasibleCqs.length === 0) return null;
    var confirmed = (variables.vmafWinnerFullRateConfirmed && typeof variables.vmafWinnerFullRateConfirmed === 'object')
        ? variables.vmafWinnerFullRateConfirmed : {};
    var totalDone = 0;
    for (var ck in confirmed) { if (confirmed[ck]) totalDone++; }
    if (totalDone >= 3) return null; // total cap per attempt
    var winnerCq = Math.max.apply(null, feasibleCqs);
    var winnerKey = Number(winnerCq).toFixed(1);
    if (confirmed[winnerKey]) return null; // this CQ already confirmed once
    var entry = null;
    for (var ai = 0; ai < (aggregated || []).length; ai++) {
        var ps = aggregated[ai] && aggregated[ai].parameterSet;
        if (ps && ps.quality !== undefined && Math.abs(Number(ps.quality) - winnerCq) < 0.0001) {
            entry = aggregated[ai];
            break;
        }
    }
    if (!entry) return null;
    // Rows without a stamp predate the adaptive-subsample deploy, when everything was n=1.
    var nSub = Number(entry.measurementSubsample);
    if (!isFinite(nSub) || nSub <= 1) return null;
    return winnerCq;
}

function chooseRefinementSubsample(args) {
    var vars = args.variables || {};
    var inputEnabled = args.inputs && (args.inputs.threeStageVmaf === true || args.inputs.threeStageVmaf === 'true');
    var enabled = vars.vmafThreeStageSubsample !== undefined
        ? vars.vmafThreeStageSubsample === true
        : inputEnabled;
    if (!enabled || !vars.vmafHoldoutSample) return 1;
    var requested = Number(vars.vmafIntermediateSubsample
        || (args.inputs && args.inputs.intermediateVmafSubsample) || 2);
    if (!isFinite(requested)) requested = 2;
    return Math.max(2, Math.min(4, Math.round(requested)));
}

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    var feasibility = require('../../_lib/feasibility.js');
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var policyInputs = resolveCriticalDefaults(args.inputs);
    var targetVMAF = policyInputs.targetVMAF;
    var expansionCQCount = policyInputs.expansionCQCount;
    var highMarginVMAFHeadroom = policyInputs.highMarginVMAFHeadroom;
    var highMarginVMAFHeadroom4K = policyInputs.highMarginVMAFHeadroom4K;
    var highMarginExpansionCQCount4K = policyInputs.highMarginExpansionCQCount4K;

    args.jobLog('=== CQ Bracket Check ===');

    // Check if progressive expansion is enabled. Active-boundary refinement below must run
    // either way (in production 538/539 July runs had progressive disabled, which left the
    // refinement dead code until 2026-07-07), so this only sets a flag; the not-enabled
    // early exit happens after the refinement attempt.
    var progressive = args.variables.vmafProgressiveExpansion;
    var progressiveEnabled = !!(progressive && progressive.enabled);

    // Get aggregated results
    var aggregated = args.variables.vmafAggregatedResults || [];
    if (aggregated.length === 0) {
        args.jobLog('No aggregated results available - cannot check bracket');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    // Find min and max VMAF from current tests
    var minVMAF = Infinity;
    var maxVMAF = -Infinity;
    var minCQ = Infinity;
    var maxCQ = -Infinity;

    for (var i = 0; i < aggregated.length; i++) {
        var result = aggregated[i];
        if (result.avgVMAF !== undefined && result.parameterSet && result.parameterSet.quality !== undefined) {
            var vmaf = result.avgVMAF;
            var cq = result.parameterSet.quality;

            if (vmaf < minVMAF) minVMAF = vmaf;
            if (vmaf > maxVMAF) maxVMAF = vmaf;
            if (cq < minCQ) minCQ = cq;
            if (cq > maxCQ) maxCQ = cq;
        }
    }

    args.jobLog('Current VMAF range: ' + minVMAF.toFixed(2) + ' - ' + maxVMAF.toFixed(2));
    args.jobLog('Current CQ range tested: ' + minCQ + ' - ' + maxCQ);
    args.jobLog('Target VMAF: ' + targetVMAF);

    // Check if target is bracketed
    var bracketed = (minVMAF <= targetVMAF && maxVMAF >= targetVMAF);

    // ── Per-CQ feasibility (VMAF mean + 1%-low floor + CAMBI), shared by the constraint-aware
    //    bracket check and active-boundary refinement below ──
    var _feasibleCqs = [], _allCqs = [], _unknownCqs = [];
    try {
        var _floor = Number(args.variables.vmafMinFrameVMAF)
            || (args.variables.vmafQualityRiskPolicy && Number(args.variables.vmafQualityRiskPolicy.adaptiveFrameFloor))
            || null;
        var _effCambi = feasibility.effectiveCambiLimit({
            isHDR: args.variables.isHDR === true,
            isAnimation: args.variables.vmafMediaIsAnimation === true,
            sourceCambi: args.variables.vmafSourceCAMBI,
            sourceCambiP95: args.variables.vmafSourceCAMBIP95
        });
        var _policy = {
            targetVmaf: targetVMAF,
            vmafMetric: 'mean',
            requireVmafHarmonic: true,
            vmafP1Floor: _floor,
            cambiLimit: _effCambi
        };
        var _curveEval = feasibility.evaluateCurve(aggregated, _policy);
        var _cqStates = {};
        for (var _bi = 0; _bi < _curveEval.length; _bi++) {
            var _ev = _curveEval[_bi].evaluation;
            var _ccq = _ev.metrics.cq;
            if (_ccq === null) continue;
            var _key = Number(_ccq).toFixed(1);
            if (!_cqStates[_key]) _cqStates[_key] = { cq: _ccq, complete: false, feasible: false, reason: _ev.reason };
            if (_ev.status !== 'unknown') _cqStates[_key].complete = true;
            if (_ev.feasible) _cqStates[_key].feasible = true;
            if (_ev.status === 'unknown') _cqStates[_key].reason = _ev.reason;
        }
        for (var _stateKey in _cqStates) {
            var _state = _cqStates[_stateKey];
            _allCqs.push(_state.cq);
            if (_state.feasible) _feasibleCqs.push(_state.cq);
            if (!_state.complete) {
                _unknownCqs.push(_state.cq);
                args.jobLog('CQ ' + _state.cq + ' feasibility unknown - ' + _state.reason + '; re-measurement required');
            }
        }
    } catch (_feasErr) {
        args.jobLog('Per-CQ feasibility computation failed closed: ' + _feasErr.message);
        _feasibleCqs = []; _allCqs = []; _unknownCqs = [];
    }

    // ── Active-boundary refinement ──
    // Keep the live grid aligned with autoresearch/candidate.py: 0.1-CQ midpoint probes and a
    // 0.1-CQ stop gap. The previous live implementation rounded every midpoint to 0.5 and stopped
    // at 1.0 (0.5 for 4K), while the committed harness policy had already moved to 0.1. That made
    // the live flow unable to realize the thin feasible bands the harness was optimizing for.
    // Refinement probes measure VMAF at full frame rate (subsample 1) because they decide the
    // binding CQ. Kill switch: args.variables.vmafActiveBoundary === false.
    function roundToCqGrid(value, step) {
        var safeStep = Number(step);
        if (!isFinite(safeStep) || safeStep < 0.1) safeStep = 0.1;
        // CQ is a one-decimal production grid. toFixed removes binary float tails that would
        // otherwise defeat tested-CQ deduplication (for example 30.200000000000003).
        return Number((Math.floor((Number(value) / safeStep) + 0.5 + 1e-9) * safeStep).toFixed(1));
    }

    function tryActiveRefinement() {
        if (args.variables.vmafActiveBoundary === false) return null;
        if (_feasibleCqs.length === 0) return null;
        var _lo = Math.max.apply(null, _feasibleCqs);
        var _above = _allCqs.filter(function (c) { return c > _lo; });
        if (_above.length === 0) return null;
        var _hi = Math.min.apply(null, _above);
        var _is4K = getSourceResolution().is4K;
        var _cqStep = Number(args.variables.vmafActiveCQStep);
        if (!isFinite(_cqStep) || _cqStep < 0.1) _cqStep = 0.1;
        var _stopGapRaw = _is4K ? Number(args.variables.vmafActiveStopGap4K)
                                : Number(args.variables.vmafActiveStopGap);
        var _stopGap = (isFinite(_stopGapRaw) && _stopGapRaw >= 0.1) ? _stopGapRaw : 0.1;
        var _refineMax = Number(args.variables.vmafActiveRefineMax);
        if (!isFinite(_refineMax) || _refineMax <= 0) _refineMax = 8;
        var _refineCount = Number(args.variables.vmafActiveRefineCount) || 0;
        if ((_hi - _lo) <= _stopGap + 1e-6) return null;
        if (_refineCount >= _refineMax) {
            args.jobLog('Active-boundary refinement cap reached (' + _refineCount + '/' + _refineMax + ') - proceeding with gap ' + (_hi - _lo).toFixed(1));
            return null;
        }
        var _mid = roundToCqGrid((_lo + _hi) / 2, _cqStep);
        var _tested = (args.variables.vmafTestedCQs || []).concat(_allCqs);
        var _alreadyTested = _tested.some(function (c) { return Math.abs(Number(c) - _mid) < 0.0001; });
        if (!(_mid > _lo && _mid < _hi) || _alreadyTested) return null;
        return { mid: _mid, lo: _lo, hi: _hi, stopGap: _stopGap, cqStep: _cqStep };
    }

    function scheduleActiveRefinement(_ref) {
        args.variables.vmafActiveRefineCount = (Number(args.variables.vmafActiveRefineCount) || 0) + 1;
        args.variables.vmafNextCQs = [_ref.mid];
        var _refinementSubsample = chooseRefinementSubsample(args);
        if (args.variables.vmafSubsampleAuto !== false) {
            // Coarse rounds keep n=4. The optional three-stage schedule uses n=2 here only when
            // selection has a reserved holdout, which is always encoded and measured at n=1.
            // Without a holdout, keep refinement full-rate so no job loses final validation.
            args.variables.vmafSubsample = String(_refinementSubsample);
        }
        args.variables.vmafRefinementSubsampleEffective = _refinementSubsample;
        args.variables.vmafFinalValidationMode = _refinementSubsample > 1 ? 'n1-holdout' : 'n1-refinement';
        args.jobLog('Active-boundary refinement ' + args.variables.vmafActiveRefineCount + ': feasible CQ ' + _ref.lo + ' / infeasible CQ ' + _ref.hi
            + ' (gap ' + (_ref.hi - _ref.lo).toFixed(1) + ' > stop-gap ' + _ref.stopGap
            + ', grid ' + _ref.cqStep + ') - probing midpoint CQ ' + _ref.mid + ' at n=' + _refinementSubsample
            + (_refinementSubsample > 1 ? ' (reserved holdout remains n=1)' : ' (full-rate)'));
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 2, // Expand and retest
            variables: args.variables,
        };
    }

    // Winner full-rate confirmation scheduler: reuses the same force-retest loop (output 2)
    // as the incomplete-metric re-measurement path, so cross-attempt reuse cannot short-circuit
    // the fresh n=1 measurement. Fires only after refinement declines (bracket converged).
    function tryWinnerFullRateConfirmation() {
        var _wCq = chooseWinnerFullRateConfirmation(aggregated, _feasibleCqs, args.variables);
        if (_wCq === null || _wCq === undefined) return null;
        var _wKey = Number(_wCq).toFixed(1);
        var _wMap = (args.variables.vmafWinnerFullRateConfirmed && typeof args.variables.vmafWinnerFullRateConfirmed === 'object')
            ? args.variables.vmafWinnerFullRateConfirmed : {};
        _wMap[_wKey] = true;
        args.variables.vmafWinnerFullRateConfirmed = _wMap;
        args.variables.vmafForceRetestCQs = [_wCq];
        args.variables.vmafNextCQs = [_wCq];
        args.variables.vmafSubsample = '1';
        args.jobLog('Winner-elect CQ ' + _wCq + ' was measured frame-subsampled (n>1) with no reserved holdout - re-measuring at full rate (n=1) before selection.');
        return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
    }

    if (_unknownCqs.length > 0) {
        var _retestCounts = args.variables.vmafMetricRetestCounts || {};
        var _retestCqs = _unknownCqs.filter(function (cq) {
            return Number(_retestCounts[Number(cq).toFixed(1)] || 0) < 2;
        });
        if (_retestCqs.length > 0) {
            for (var _ui = 0; _ui < _retestCqs.length; _ui++) {
                var _uk = Number(_retestCqs[_ui]).toFixed(1);
                _retestCounts[_uk] = Number(_retestCounts[_uk] || 0) + 1;
            }
            args.variables.vmafMetricRetestCounts = _retestCounts;
            args.variables.vmafForceRetestCQs = _retestCqs.slice(0, 6);
            args.variables.vmafNextCQs = _retestCqs.slice(0, 6);
            args.variables.vmafSubsample = '1';
            args.jobLog('Re-measuring CQ values with incomplete mandatory metrics at full rate: ' + args.variables.vmafNextCQs.join(', '));
            return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
        }
        args.jobLog('Mandatory metrics remain incomplete after two re-measurements; failing closed into selection/retry handling.');
    }

    // Progressive expansion disabled: still attempt boundary refinement (the flow's output 2
    // edge re-enters testEncodingParameters, which honours vmafNextCQs on the guided path),
    // then exit to selection as before.
    if (!progressiveEnabled) {
        var _refN = tryActiveRefinement();
        if (_refN) return scheduleActiveRefinement(_refN);
        var _wcN = tryWinnerFullRateConfirmation();
        if (_wcN) return _wcN;
        args.jobLog('Progressive expansion not enabled - skipping bracket check');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,  // Proceed to selection
            variables: args.variables,
        };
    }

    if (bracketed) {
        var _refB = tryActiveRefinement();
        if (_refB) return scheduleActiveRefinement(_refB);
        var _wcB = tryWinnerFullRateConfirmation();
        if (_wcB) return _wcB;
        args.jobLog('✓ Target VMAF is bracketed - proceeding to selection');

        // Disable further expansion
        delete args.variables.vmafProgressiveExpansion;

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,  // Proceed to selection
            variables: args.variables,
        };
    }

    // ── Constraint-aware bracket: when VMAF mean is met everywhere (all above target), the
    //    optimum is bounded by the 1%-low / CAMBI floor, NOT by the VMAF crossing. If a candidate
    //    meets ALL constraints and a higher-CQ candidate fails one, the feasible optimum is already
    //    bracketed within the tested CQs -> proceed to selection instead of expanding upward (the
    //    old behaviour blew the sweep up to the whole range chasing a VMAF crossing that doesn't
    //    bind). ──
    try {
        if (_feasibleCqs.length > 0) {
            var _maxFeas = Math.max.apply(null, _feasibleCqs);
            var _hasHigherInfeasible = _allCqs.some(function (c) { return c > _maxFeas; });
            if (_hasHigherInfeasible || maxCQ >= progressive.cqMax) {
                var _refC = tryActiveRefinement();
                if (_refC) return scheduleActiveRefinement(_refC);
                var _wcC = tryWinnerFullRateConfirmation();
                if (_wcC) return _wcC;
                args.jobLog('✓ Optimum bracketed by binding constraint (1%-low ' + (_floor != null ? '>=' + _floor : 'n/a')
                    + ', CAMBI <= ' + _effCambi.toFixed(1) + ') - feasible up to CQ ' + _maxFeas
                    + '; proceeding to selection without VMAF-mean expansion');
                delete args.variables.vmafProgressiveExpansion;
                return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
            }
        }
    } catch (_cbErr) {
        args.jobLog('Constraint-aware bracket check skipped (non-fatal): ' + _cbErr.message);
    }

    // Not bracketed - determine expansion direction
    args.jobLog('⚠ Target VMAF NOT bracketed - expanding range');

    var allAboveTarget = (minVMAF > targetVMAF); // even the lowest-quality/highest-CQ point is above target
    var allBelowTarget = (maxVMAF < targetVMAF); // even the highest-quality/lowest-CQ point is below target

    var newCQs = [];
    var step = progressive.step;
    var availableMin = progressive.cqMin;
    var availableMax = progressive.cqMax;

    function getSourceResolution() {
        var width = 0;
        var height = 0;
        var streams = (((args.inputFileObj || {}).ffProbeData || {}).streams || []);
        for (var si = 0; si < streams.length; si++) {
            if (streams[si].codec_type === 'video') {
                width = Number(streams[si].width) || 0;
                height = Number(streams[si].height) || 0;
                break;
            }
        }
        return { width: width, height: height, is4K: width >= 3840 || height >= 2160 };
    }

    function pushUntestedCQ(cqVal) {
        var tested = args.variables.vmafTestedCQs || [];
        if (tested.indexOf(cqVal) === -1 && newCQs.indexOf(cqVal) === -1) {
            newCQs.push(cqVal);
        }
    }

    if (allAboveTarget) {
        // Need higher CQ (more compression). This is the common size-efficiency miss: all tested
        // encodes are still above target, so lower CQ would only increase quality/file size.
        var headroom = minVMAF - targetVMAF;
        var res = getSourceResolution();
        var count = expansionCQCount;
        if (headroom >= highMarginVMAFHeadroom) {
            count = Math.max(count, expansionCQCount + 1);
        }
        if (res.is4K && headroom >= highMarginVMAFHeadroom4K) {
            count = Math.max(count, highMarginExpansionCQCount4K);
            args.jobLog('4K high-margin overshoot detected: lowest VMAF is ' + headroom.toFixed(2) + ' above target; expanding farther upward.');
        }
        args.jobLog('All VMAF results are above target - testing HIGHER CQ (more compression), headroom=' + headroom.toFixed(2));
        for (var i = 1; i <= count; i++) {
            var newCQ = maxCQ + (step * i);
            if (newCQ <= availableMax) {
                pushUntestedCQ(newCQ);
            }
        }
    } else if (allBelowTarget) {
        // Need lower CQ (higher quality).
        args.jobLog('All VMAF results are below target - testing LOWER CQ (higher quality)');
        for (var j = 1; j <= expansionCQCount; j++) {
            var lowerCQ = minCQ - (step * j);
            if (lowerCQ >= availableMin) {
                pushUntestedCQ(lowerCQ);
            }
        }
    }

    if (newCQs.length === 0) {
        args.jobLog('⚠ Cannot expand further - at boundary of allowed range');
        args.jobLog('Proceeding with best available result');
        delete args.variables.vmafProgressiveExpansion;
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    // Set new CQ values for next test iteration
    args.variables.vmafNextCQs = newCQs;
    args.variables.vmafOverrideCQMin = availableMin;
    args.variables.vmafOverrideCQMax = availableMax;

    args.jobLog('Expansion CQ values: ' + newCQs.join(', '));
    args.jobLog('Returning to test additional CQ values...');

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 2,  // Expand and retest
        variables: args.variables,
    };
};
exports.plugin = plugin;
exports._test = {
    CRITICAL_DEFAULTS: CRITICAL_DEFAULTS,
    resolveCriticalDefaults: resolveCriticalDefaults,
    chooseRefinementSubsample: chooseRefinementSubsample,
    chooseWinnerFullRateConfirmation: chooseWinnerFullRateConfirmation,
};
