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

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var targetVMAF = Number(args.inputs.targetVMAF) || 90;
    var expansionCQCount = Number(args.inputs.expansionCQCount) || 2;
    var highMarginVMAFHeadroom = Number(args.inputs.highMarginVMAFHeadroom);
    if (isNaN(highMarginVMAFHeadroom) || highMarginVMAFHeadroom < 0) highMarginVMAFHeadroom = 1.5;
    var highMarginVMAFHeadroom4K = Number(args.inputs.highMarginVMAFHeadroom4K);
    if (isNaN(highMarginVMAFHeadroom4K) || highMarginVMAFHeadroom4K < 0) highMarginVMAFHeadroom4K = 2;
    var highMarginExpansionCQCount4K = Number(args.inputs.highMarginExpansionCQCount4K) || 4;

    args.jobLog('=== CQ Bracket Check ===');

    // Check if progressive expansion is enabled
    var progressive = args.variables.vmafProgressiveExpansion;
    if (!progressive || !progressive.enabled) {
        args.jobLog('Progressive expansion not enabled - skipping bracket check');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,  // Proceed to selection
            variables: args.variables,
        };
    }

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

    if (bracketed) {
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
        var _floor = Number(args.variables.vmafMinFrameVMAF)
            || (args.variables.vmafQualityRiskPolicy && Number(args.variables.vmafQualityRiskPolicy.adaptiveFrameFloor))
            || null;
        var _cambiBase = args.variables.isHDR ? 5.0 : (args.variables.vmafMediaIsAnimation === true ? 6.0 : 5.5);
        var _scR = Math.max(Number(args.variables.vmafSourceCAMBI) || -Infinity, Number(args.variables.vmafSourceCAMBIP95) || -Infinity);
        var _effCambi = isFinite(_scR) ? Math.max(_cambiBase, _scR + 1.0) : _cambiBase;
        var _feasibleCqs = [], _allCqs = [];
        for (var _bi = 0; _bi < aggregated.length; _bi++) {
            var _r = aggregated[_bi]; if (!_r.parameterSet || _r.parameterSet.quality === undefined) continue;
            var _ccq = Number(_r.parameterSet.quality);
            var _cvm = (_r.avgVMAFMean != null ? Number(_r.avgVMAFMean) : Number(_r.avgVMAF));
            var _cp1 = (_r.vmafP1Low != null ? Number(_r.vmafP1Low) : null);
            var _ccb = (_r.p95CAMBI != null ? Number(_r.p95CAMBI) : (_r.maxCAMBI != null ? Number(_r.maxCAMBI) : null));
            if (!isFinite(_ccq)) continue;
            _allCqs.push(_ccq);
            var _ok = (isFinite(_cvm) && _cvm >= targetVMAF)
                && (_floor == null || _cp1 == null || _cp1 >= _floor)
                && (_ccb == null || _ccb <= _effCambi);
            if (_ok) _feasibleCqs.push(_ccq);
        }
        if (_feasibleCqs.length > 0) {
            var _maxFeas = Math.max.apply(null, _feasibleCqs);
            var _hasHigherInfeasible = _allCqs.some(function (c) { return c > _maxFeas; });
            if (_hasHigherInfeasible || maxCQ >= progressive.cqMax) {
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
