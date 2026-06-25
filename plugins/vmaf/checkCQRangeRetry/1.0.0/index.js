"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Check CQ Range Retry',
    description: 'VMAF-aware CQ range retry logic. Validates that higher CQ values have acceptable VMAF before retrying. Handles sweep retries triggered by transcode failures.',
    style: {
        borderColor: 'orange',
    },
    tags: 'video,vmaf,retry,optimize',
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
            defaultValue: '4',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Maximum number of CQ-range retry attempts. Each retry picks a new bracket when the first misses. Default: 4 (prev: 2 — increased since the learning model converges in 1-2 more steps on hard content).',
        },
        {
            label: 'VMAF Headroom Threshold',
            name: 'vmafHeadroomThreshold',
            type: 'number',
            defaultValue: '5',
            inputUI: {
                type: 'text',
            },
            tooltip: 'If lowest VMAF is this many points above minimum threshold, worth testing higher CQ for better compression. Default: 5',
        },
        {
            label: 'VMAF Below Threshold Margin',
            name: 'vmafBelowThresholdMargin',
            type: 'number',
            defaultValue: '5',
            inputUI: {
                type: 'text',
            },
            tooltip: 'If VMAF is this many points below threshold, do not retry with higher CQ. Default: 5',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'Retry with adjusted CQ range',
        },
        {
            number: 2,
            tooltip: 'Continue (success or max retries reached)',
        },
    ],
}); };
exports.details = details;

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    
    var maxRetries = Number(args.inputs.maxRetries) || 2;
    
    // ENHANCEMENT FIX #14: Input validation
    if (isNaN(maxRetries) || maxRetries < 0) {
        args.jobLog('WARNING: Invalid maxRetries (' + args.inputs.maxRetries + '), using default 2');
        maxRetries = 2;
    }
    
    // ENHANCEMENT FIX #17: Store maxRetries in variables so selectBestParameters can use it
    args.variables.vmafMaxRetries = maxRetries;

    // Initialize retry count early (used by progress reporting)
    var retryCount = args.variables.vmafRetryCount;
    if (retryCount === undefined || retryCount === null) {
        retryCount = 0;
        args.variables.vmafRetryCount = 0;
    }
    
    // ENHANCEMENT FIX #16: Progress reporting for retry loops
    if (args.updateWorker) {
        args.updateWorker({
            percentage: 0,
            ETA: 0,
            CLIType: 'VMAF Retry',
            preset: 'CQ Range Retry Check (Attempt ' + (retryCount + 1) + ' / ' + maxRetries + ')'
        });
    }
    
    var vmafHeadroomThreshold = Number(args.inputs.vmafHeadroomThreshold) || 5;
    var vmafBelowThresholdMargin = Number(args.inputs.vmafBelowThresholdMargin) || 5;
    
    // Get VMAF thresholds (may already be adjusted by selectBestParameters)
    var baseMinVMAF = args.variables.vmafMinVMAF || 90;
    var baseMinFrameVMAF = args.variables.vmafMinFrameVMAF || 0;
    
    // Apply 10-bit buffer if needed (in case checkCQRangeRetry runs before selectBestParameters)
    var vmafBuffer10Bit = args.variables.vmafBuffer10Bit;
    var bufferApplied = args.variables.vmafBufferApplied === true;
    
    // If buffer not yet applied, check if we need to apply it
    if (vmafBuffer10Bit === undefined || vmafBuffer10Bit === null) {
        vmafBuffer10Bit = 5; // Default buffer
    }
    
    if (!bufferApplied && vmafBuffer10Bit > 0) {
        // Detect 10-bit source
        var is10BitSource = args.variables.is10BitSource;
        if (is10BitSource === undefined || is10BitSource === null) {
            is10BitSource = false;
            if (args.inputFileObj && args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams) {
                for (var s = 0; s < args.inputFileObj.ffProbeData.streams.length; s++) {
                    var stream = args.inputFileObj.ffProbeData.streams[s];
                    if (stream.codec_type === 'video') {
                        var pixFmt = String(stream.pix_fmt || '').toLowerCase();
                        if (pixFmt.indexOf('10') !== -1 || pixFmt === 'p010le' || pixFmt === 'p210le' || pixFmt === 'p410le') {
                            is10BitSource = true;
                            break;
                        }
                        var bitsPerSample = Number(stream.bits_per_raw_sample);
                        if (!isNaN(bitsPerSample) && bitsPerSample === 10) {
                            is10BitSource = true;
                            break;
                        }
                        var profile = String(stream.profile || '').toLowerCase();
                        if (profile.indexOf('main 10') !== -1 || profile.indexOf('high 10') !== -1) {
                            is10BitSource = true;
                            break;
                        }
                    }
                }
            }
        }
        
        // Check if GPU VMAF was actually used
        var gpuVmafActuallyUsed = args.variables.vmafUsedGpuVmaf === true;
        
        // Apply buffer if conditions are met
        if (is10BitSource && gpuVmafActuallyUsed) {
            bufferApplied = true;
            args.variables.vmafBufferApplied = true;
        }
    }
    
    // Use adjusted thresholds (either from selectBestParameters or apply buffer here)
    var minVMAF = baseMinVMAF;
    var minFrameVMAF = baseMinFrameVMAF;
    
    if (bufferApplied && vmafBuffer10Bit > 0) {
        minVMAF = Math.max(0, baseMinVMAF - vmafBuffer10Bit);
        minFrameVMAF = Math.max(0, baseMinFrameVMAF - vmafBuffer10Bit);
        args.variables.vmafMinVMAF = minVMAF;
        args.variables.vmafMinFrameVMAF = minFrameVMAF;
    }
    
    // Check if this is a sweep retry triggered by monitorTranscodeRetry
    var sweepRetryTriggered = args.variables.vmafTriggerSweepRetry === true;
    var sweepRetryReason = args.variables.vmafSweepRetryReason || '';
    
    args.jobLog('=== VMAF-Aware CQ Range Retry Check ===');
    args.jobLog('Current retry count: ' + retryCount + ' / ' + maxRetries);
    args.jobLog('VMAF thresholds: minVMAF=' + minVMAF + ', minFrameVMAF=' + minFrameVMAF);
    
    // Helper function to check if a result meets VMAF thresholds
    function meetsVMAFThreshold(result) {
        if (!result) return false;
        if (result.avgVMAF < minVMAF) return false;
        if (minFrameVMAF > 0 && result.minVMAF !== null && result.minVMAF !== undefined) {
            if (result.minVMAF < minFrameVMAF) return false;
        }
        return true;
    }
    
    // Helper function to check if VMAF is significantly below threshold
    function isSignificantlyBelowThreshold(vmaf) {
        var threshold = minVMAF - vmafBelowThresholdMargin;
        return vmaf < threshold;
    }
    
    // Helper function to check if any tested higher CQ has acceptable VMAF
    function hasValidHigherCQ(currentMaxCQ, aggregatedResults) {
        for (var i = 0; i < aggregatedResults.length; i++) {
            var result = aggregatedResults[i];
            if (result.parameterSet && 
                result.parameterSet.quality !== undefined && 
                result.parameterSet.quality > currentMaxCQ) {
                if (meetsVMAFThreshold(result)) {
                    return {
                        hasValid: true,
                        cq: result.parameterSet.quality,
                        vmaf: result.avgVMAF,
                        result: result
                    };
                }
            }
        }
        return { hasValid: false };
    }
    
    // Helper function to find highest CQ with acceptable VMAF (evidence for retry)
    function findHighestValidCQ(aggregatedResults) {
        var highest = null;
        for (var i = 0; i < aggregatedResults.length; i++) {
            var result = aggregatedResults[i];
            if (result.parameterSet && result.parameterSet.quality !== undefined) {
                if (meetsVMAFThreshold(result)) {
                    if (!highest || result.parameterSet.quality > highest.cq) {
                        highest = {
                            cq: result.parameterSet.quality,
                            vmaf: result.avgVMAF,
                            minVMAF: result.minVMAF,
                            result: result
                        };
                    }
                }
            }
        }
        return highest;
    }
    
    // Helper function to check if CQ range is exhausted
    function isCQRangeExhausted(testedCQs) {
        if (!testedCQs || testedCQs.length === 0) return false;
        var sorted = testedCQs.slice().sort(function(a, b) { return a - b; });
        var minTested = sorted[0];
        var maxTested = sorted[sorted.length - 1];
        var rangeSpan = maxTested - minTested;
        return rangeSpan >= 30 && minTested <= 18 && maxTested >= 48;
    }
    
    // Helper: VMAF trend-based increment using weighted drop per CQ step
    function calculateVMAFTrendBasedIncrement(results, currentCQ, minVMAF, fudgeFactor, cqStepSize) {
        if (!results || results.length < 2) return null;
        
        var byCQ = results.filter(function(r) {
            return r && r.parameterSet && r.parameterSet.quality !== undefined && r.avgVMAF !== undefined;
        }).sort(function(a, b) { return a.parameterSet.quality - b.parameterSet.quality; });
        
        if (byCQ.length < 2) return null;
        
        var weightedDrop = 0;
        var weightTotal = 0;
        for (var i = 0; i < byCQ.length - 1; i++) {
            var curr = byCQ[i];
            var next = byCQ[i + 1];
            var cqDelta = next.parameterSet.quality - curr.parameterSet.quality;
            if (cqDelta <= 0) continue;
            var vmafDrop = (curr.avgVMAF - next.avgVMAF);
            if (vmafDrop < 0) vmafDrop = 0;
            var dropRate = vmafDrop / cqDelta;
            var weight = 1 + (i / (byCQ.length - 1)); // weight later (higher CQ) comparisons higher
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
        var cappedIncrement = Math.min(calculatedIncrement, 30);
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


    function getCQ(result) {
        if (!result || !result.parameterSet || result.parameterSet.quality === undefined) return null;
        var cq = Number(result.parameterSet.quality);
        return isFinite(cq) ? cq : null;
    }

    function getCambiRisk(result) {
        if (!result) return null;
        var vals = [];
        if (result.avgCAMBI !== null && result.avgCAMBI !== undefined && isFinite(Number(result.avgCAMBI))) vals.push(Number(result.avgCAMBI));
        if (result.p95CAMBI !== null && result.p95CAMBI !== undefined && isFinite(Number(result.p95CAMBI))) vals.push(Number(result.p95CAMBI));
        if (vals.length === 0) return null;
        return Math.max.apply(null, vals);
    }

    function roundDownToStep(value, step) {
        if (!isFinite(value)) return value;
        return Math.floor(value / step) * step;
    }

    function estimateLowerCrossing(points, metricFn, limit, passWhenAtOrAbove) {
        if (!points || points.length === 0 || !isFinite(limit)) return null;
        var byCQ = points.filter(function(r) {
            var cq = getCQ(r);
            var y = metricFn(r);
            return cq !== null && y !== null && y !== undefined && isFinite(Number(y));
        }).sort(function(a, b) { return getCQ(a) - getCQ(b); });
        if (byCQ.length === 0) return null;
        function passes(y) { return passWhenAtOrAbove ? y >= limit : y <= limit; }
        for (var i = 0; i < byCQ.length - 1; i++) {
            var q1 = getCQ(byCQ[i]);
            var q2 = getCQ(byCQ[i + 1]);
            var y1 = Number(metricFn(byCQ[i]));
            var y2 = Number(metricFn(byCQ[i + 1]));
            if (passes(y1) !== passes(y2) && q2 !== q1 && y2 !== y1) {
                return q1 + ((limit - y1) * (q2 - q1) / (y2 - y1));
            }
        }
        var low = byCQ[0];
        var lowCQ = getCQ(low);
        var lowY = Number(metricFn(low));
        if (passes(lowY)) return lowCQ;
        if (byCQ.length >= 2) {
            var next = byCQ[1];
            var nextCQ = getCQ(next);
            var nextY = Number(metricFn(next));
            var slope = (nextY - lowY) / (nextCQ - lowCQ);
            if (isFinite(slope) && Math.abs(slope) > 0.000001) {
                return lowCQ + ((limit - lowY) / slope);
            }
        }
        return lowCQ - cqStepSize;
    }

    function buildConstraintAwareLowerRetryPlan(results, testedCQMin, testedCQSet, cqStepSize, minVMAF, minFrameVMAF) {
        var byCQ = (results || []).filter(function(r) { return getCQ(r) !== null; })
            .sort(function(a, b) { return getCQ(a) - getCQ(b); });
        if (byCQ.length === 0) return null;

        var naturalMax = Math.max(16, testedCQMin - cqStepSize);
        var maxUsefulCQ = naturalMax;
        var notes = [];
        var limiting = [];
        var isHDR = args.variables.isHDR === true || args.variables.isDolbyVision === true || String(args.variables.color_trc || '').toLowerCase() === 'smpte2084';
        var isAnimation = args.variables.vmafMediaIsAnimation === true;
        var cambiLimit = isAnimation ? 6.0 : (isHDR ? 5.0 : 5.5);
        var lowest = byCQ[0];
        var lowestCQ = getCQ(lowest);
        var lowestCambi = getCambiRisk(lowest);

        if (lowest.avgVMAF !== null && lowest.avgVMAF !== undefined && Number(lowest.avgVMAF) < minVMAF) {
            var vmafCross = estimateLowerCrossing(byCQ, function(r) { return Number(r.avgVMAF); }, minVMAF, true);
            if (vmafCross !== null && isFinite(vmafCross)) {
                maxUsefulCQ = Math.min(maxUsefulCQ, roundDownToStep(vmafCross, cqStepSize));
                limiting.push('VMAF≈CQ' + vmafCross.toFixed(1));
            }
        }
        if (minFrameVMAF > 0) {
            var floorMetric = function(r) {
                if (r.vmafP1Low !== null && r.vmafP1Low !== undefined && isFinite(Number(r.vmafP1Low))) return Number(r.vmafP1Low);
                if (r.minVMAF !== null && r.minVMAF !== undefined && isFinite(Number(r.minVMAF))) return Number(r.minVMAF);
                return null;
            };
            var lowFloor = floorMetric(lowest);
            if (lowFloor !== null && lowFloor < minFrameVMAF) {
                var floorCross = estimateLowerCrossing(byCQ, floorMetric, minFrameVMAF, true);
                if (floorCross !== null && isFinite(floorCross)) {
                    maxUsefulCQ = Math.min(maxUsefulCQ, roundDownToStep(floorCross, cqStepSize));
                    limiting.push('1%low≈CQ' + floorCross.toFixed(1));
                }
            }
        }
        if (lowestCambi !== null && lowestCambi > cambiLimit) {
            var cambiCross = estimateLowerCrossing(byCQ, getCambiRisk, cambiLimit, false);
            if (cambiCross !== null && isFinite(cambiCross)) {
                maxUsefulCQ = Math.min(maxUsefulCQ, roundDownToStep(cambiCross, cqStepSize));
                limiting.push('CAMBI≈CQ' + cambiCross.toFixed(1));
                notes.push('lowest tested CQ ' + lowestCQ + ' still failed CAMBI risk ' + lowestCambi.toFixed(2) + ' > ' + cambiLimit.toFixed(1));
            }
        }

        var candidates = [];
        var seen = {};
        function addCandidate(cq) {
            cq = Math.round(Number(cq));
            if (cq < 16 || cq > 51 || testedCQSet[cq] || seen[cq]) return;
            candidates.push(cq);
            seen[cq] = true;
        }

        if (maxUsefulCQ < 16) {
            notes.push('extrapolated useful CQ boundary below encoder floor; probing lowest legal CQ values only');
            for (var lowProbe = 16; lowProbe < testedCQMin && candidates.length < 6; lowProbe += cqStepSize) {
                addCandidate(lowProbe);
            }
        } else {
            var usefulMax = Math.min(naturalMax, Math.max(16, roundDownToStep(maxUsefulCQ, cqStepSize)));
            for (var cq = usefulMax; cq >= 16 && candidates.length < 6; cq -= cqStepSize) {
                addCandidate(cq);
            }
            candidates.sort(function(a, b) { return a - b; });
        }

        // If the extrapolated boundary was very low and the first loop produced too few probes,
        // add low-end points only. Never add points at/above the lowest known failed CQ.
        for (var fill = 16; fill < testedCQMin && candidates.length < 3; fill += cqStepSize) {
            addCandidate(fill);
        }
        candidates.sort(function(a, b) { return a - b; });
        return {
            candidates: candidates,
            limiting: limiting,
            notes: notes,
            maxUsefulCQ: maxUsefulCQ,
            naturalMax: naturalMax
        };
    }
    
    // Handle sweep retry triggered by monitorTranscodeRetry
    if (sweepRetryTriggered) {
        args.jobLog('');
        args.jobLog('🔄 SWEEP RETRY TRIGGERED by transcode failure');
        args.jobLog('Reason: ' + sweepRetryReason);
        
        // Clear the trigger flag
        args.variables.vmafTriggerSweepRetry = false;
        args.variables.vmafSweepRetryReason = '';
        
        // Check if we have the override CQ range set by monitorTranscodeRetry
        var overrideCQMin = args.variables.vmafOverrideCQMin;
        var overrideCQMax = args.variables.vmafOverrideCQMax;
        
        if (overrideCQMin !== undefined && overrideCQMax !== undefined) {
            // Check retry count
            if (retryCount >= maxRetries) {
                args.jobLog('⚠ Maximum retries (' + maxRetries + ') reached - cannot retry sweep');
                
                // Store tracking info for learning
                if (!args.variables.vmafCQRangeRetryHistory) {
                    args.variables.vmafCQRangeRetryHistory = [];
                }
                args.variables.vmafCQRangeRetryHistory.push({
                    reason: sweepRetryReason,
                    proposedRange: overrideCQMin + '-' + overrideCQMax,
                    executed: false,
                    blockedBy: 'max_retries_exceeded',
                    retryCount: retryCount
                });

                // Give up gracefully: keeping the original is a valid outcome, not a job error.
                // The exhausted flag makes monitorTranscodeRetry stop the loop on its side too.
                var testedCQs = args.variables.vmafTestedCQs || [];
                args.jobLog('⚠ GIVING UP: sweep retries exhausted (' + sweepRetryReason + '). Proposed CQ range ' +
                    overrideCQMin + '-' + overrideCQMax + ', tested CQs: ' + (testedCQs.length ? testedCQs.join(', ') : 'none') + '.');
                args.jobLog('  Keeping original file - it is already efficiently encoded.');
                args.variables.vmafSweepRetriesExhausted = true;
                args.variables.vmafTranscodeGaveUp = true;
                return {
                    outputFileObj: args.inputFileObj,
                    outputNumber: 2,
                    variables: args.variables,
                };
            }
            
            // Increment retry count
            args.variables.vmafRetryCount = retryCount + 1;
            // Flag the final permitted retry so monitorTranscodeRetry gives up gracefully
            // instead of requesting another sweep that would exceed the budget.
            if (args.variables.vmafRetryCount >= maxRetries) {
                args.variables.vmafSweepRetriesExhausted = true;
            }
            
            // Clear previous test results to force re-testing
            // But preserve vmafTestedCQs to avoid retesting
            args.variables.vmafTestResults = [];
            args.variables.vmafResults = [];
            args.variables.vmafAggregatedResults = [];
            args.variables.vmafBestParameters = null;
            
            // Store tracking info for learning
            if (!args.variables.vmafCQRangeRetryHistory) {
                args.variables.vmafCQRangeRetryHistory = [];
            }
            args.variables.vmafCQRangeRetryHistory.push({
                reason: sweepRetryReason,
                newRange: overrideCQMin + '-' + overrideCQMax,
                executed: true,
                retryCount: args.variables.vmafRetryCount
            });
            
            args.jobLog('');
            args.jobLog('✓ EXECUTING SWEEP RETRY with CQ range: ' + overrideCQMin + ' - ' + overrideCQMax);
            args.jobLog('Retry attempt: ' + args.variables.vmafRetryCount + ' / ' + maxRetries);
            
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 1,
                variables: args.variables,
            };
        } else {
            args.jobLog('⚠ Sweep retry triggered but no CQ range specified');
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 2,
                variables: args.variables,
            };
        }
    }
    
    // Regular CQ range retry logic (from selectBestParameters)
    var bestParams = args.variables.vmafBestParameters;
    var selectOutput = args.variables.vmafSelectOutput || 1;
    var suggestedCQMin = args.variables.vmafSuggestedCQMin;
    var suggestedCQMax = args.variables.vmafSuggestedCQMax;
    var aggregatedResults = args.variables.vmafAggregatedResults || [];
    args.variables.vmafTrendAvgDropPerCQ = null;
    args.variables.vmafTrendIncrementUsed = null;
    args.variables.vmafTrendCurrentVMAF = null;
    args.variables.vmafTrendMargin = null;
    
    // Check for transcode failures from previous runs
    var transcodeFailures = args.variables.vmafTranscodeFailures || [];
    var hasTranscodeFailures = transcodeFailures.length > 0;
    if (hasTranscodeFailures) {
        args.jobLog('⚠ Previous transcode failures detected: ' + transcodeFailures.length);
        for (var tf = 0; tf < transcodeFailures.length; tf++) {
            var failure = transcodeFailures[tf];
            if (!failure.succeeded) {
                args.jobLog('  Failure: CQ ' + failure.originalCQ + ' - ' + (failure.reason || 'file too large'));
            }
        }
    }
    
    var shouldRetry = false;
    var retryReason = '';
    var newCQMin = null;
    var newCQMax = null;
    
    // Get all tested CQ values to avoid retesting
    var allTestedCQs = args.variables.vmafTestedCQs || [];
    var testedCQSet = {};
    for (var t = 0; t < allTestedCQs.length; t++) {
        testedCQSet[allTestedCQs[t]] = true;
    }
    var cqStepSize = args.variables.vmafCQStep || 2;
    var trendFudge = Number(args.variables.vmafTrendFudgeFactor || 2.5);
    var sizeMonitor = args.variables.liveSizeCompare || {};
    var sizeFlagged = sizeMonitor && (sizeMonitor.error === true || sizeMonitor.predictedTooLarge === true);
    
    // Check if retry is needed
    if (selectOutput === 2) {
        // No suitable parameters found - need to retry with different CQ range
        args.jobLog('');
        args.jobLog('No suitable parameters found - evaluating retry options');
        
        // Get current tested CQ range
        var testedCQMin = Infinity;
        var testedCQMax = -Infinity;
        
        for (var i = 0; i < aggregatedResults.length; i++) {
            var result = aggregatedResults[i];
            if (result.parameterSet && result.parameterSet.quality !== undefined) {
                var cq = result.parameterSet.quality;
                if (cq < testedCQMin) testedCQMin = cq;
                if (cq > testedCQMax) testedCQMax = cq;
            }
        }
        
        // Handle edge case where no CQ values were tested (shouldn't happen, but be safe)
        if (testedCQMin === Infinity || testedCQMax === -Infinity) {
            // Fallback to default CQ range if no tested values found
            var defaultCQMin = args.variables.vmafCQRange?.min || 24;
            var defaultCQMax = args.variables.vmafCQRange?.max || 32;
            testedCQMin = defaultCQMin;
            testedCQMax = defaultCQMax;
            args.jobLog('⚠ No tested CQ values found - using default range: ' + testedCQMin + ' - ' + testedCQMax);
        } else {
            args.jobLog('Previously tested CQ range: ' + testedCQMin + ' - ' + testedCQMax);
        }
        
        // Find the best (lowest CQ) that had acceptable VMAF to understand the quality floor
        var lowestValidCQ = null;
        var highestTestedVMAF = 0;
        var highestTestedCQ = null;
        
        for (var j = 0; j < aggregatedResults.length; j++) {
            var res = aggregatedResults[j];
            if (res.parameterSet && res.parameterSet.quality !== undefined) {
                if (meetsVMAFThreshold(res)) {
                    if (!lowestValidCQ || res.parameterSet.quality < lowestValidCQ.cq) {
                        lowestValidCQ = {
                            cq: res.parameterSet.quality,
                            vmaf: res.avgVMAF
                        };
                    }
                }
                if (res.avgVMAF > highestTestedVMAF) {
                    highestTestedVMAF = res.avgVMAF;
                    highestTestedCQ = res.parameterSet.quality;
                }
            }
        }
        
        args.jobLog('Highest VMAF achieved: ' + highestTestedVMAF.toFixed(2) + ' at CQ ' + highestTestedCQ);
        if (lowestValidCQ) {
            args.jobLog('Lowest valid CQ (meets threshold): ' + lowestValidCQ.cq + ' with VMAF ' + lowestValidCQ.vmaf.toFixed(2));
        } else {
            args.jobLog('⚠ No tested CQ value met the VMAF threshold');
        }
        
        // Determine retry direction based on VMAF results
        // Retry if: avgVMAF below threshold OR avgVMAF meets threshold but no params passed.
        // The latter can happen for more than minFrameVMAF: selectBestParameters may reject
        // every candidate on policy guards such as projected output being suspiciously tiny,
        // BPP/Mbps floor, CAMBI banding risk, or holdout failure. In that case the old logic
        // saw a base-VMAF-valid CQ and skipped retrying, so the flow marked the HEVC source
        // "Not required" without ever testing lower CQ values that would give hard areas more bits.
        if (highestTestedVMAF < minVMAF || lowestValidCQ === null || !bestParams) {
            // Determine the failure reason
            var isAvgVmafFailure = highestTestedVMAF < minVMAF;
            var isMinFrameFailure = !isAvgVmafFailure && lowestValidCQ === null;
            
            if (isAvgVmafFailure) {
                // Even the best (lowest CQ) didn't meet threshold - need lower CQ (higher quality)
                if (isSignificantlyBelowThreshold(highestTestedVMAF)) {
                    // VMAF is significantly below threshold - this content may be impossible to compress
                    args.jobLog('');
                    args.jobLog('⚠ Best VMAF (' + highestTestedVMAF.toFixed(2) + ') is significantly below threshold (' + minVMAF + ')');
                    args.jobLog('  Deficit: ' + (minVMAF - highestTestedVMAF).toFixed(1) + ' points');
                    
                    // Check if we've exhausted lower CQ options
                    if (testedCQMin <= 18) {
                        args.jobLog('⚠ Already tested very low CQ (' + testedCQMin + ') - limited improvement possible');
                    }
                }
                
                // Try lower CQ (higher quality)
                retryReason = 'No parameters met VMAF threshold - trying lower CQ for higher quality';
            } else if (isMinFrameFailure) {
                // Average VMAF meets threshold but per-frame quality too low (minFrameVMAF failures)
                args.jobLog('');
                args.jobLog('⚠ Average VMAF (' + highestTestedVMAF.toFixed(2) + ') meets threshold but per-frame quality too low');
                args.jobLog('  Some frames fail minFrameVMAF threshold - trying lower CQ to improve worst-case frames');
                
                retryReason = 'Average VMAF meets threshold but per-frame quality too low - trying lower CQ to improve worst-case frames';
            } else {
                // Base VMAF passed, but all candidates were rejected by secondary quality guards
                // (size/BPP/Mbps too low, CAMBI risk, holdout, etc.). Try lower CQ before giving up.
                args.jobLog('');
                args.jobLog('⚠ Average VMAF (' + highestTestedVMAF.toFixed(2) + ') meets threshold but selection guards rejected all candidates');
                args.jobLog('  Trying lower CQ to allocate more bits to difficult scenes before skipping this file');

                retryReason = 'Selection guards rejected all candidates - trying lower CQ for more bits and safer quality';
            }
            
            shouldRetry = true;
            
            var lowerPlan = buildConstraintAwareLowerRetryPlan(aggregatedResults, testedCQMin, testedCQSet, cqStepSize, minVMAF, minFrameVMAF);
            var untestedCQs = lowerPlan && lowerPlan.candidates ? lowerPlan.candidates : [];
            if (lowerPlan) {
                if (lowerPlan.limiting.length > 0) {
                    args.jobLog('Constraint-aware retry boundary: ' + lowerPlan.limiting.join(', ') +
                        ' (natural max below tested CQ=' + lowerPlan.naturalMax + ', selected max=' + lowerPlan.maxUsefulCQ + ')');
                }
                for (var lp = 0; lp < lowerPlan.notes.length; lp++) {
                    args.jobLog('  ' + lowerPlan.notes[lp]);
                }
            }
            if (hasTranscodeFailures) {
                args.jobLog('Transcode failures detected - retry candidates remain constrained below known failed/unsafe CQ values');
            }
            
            if (untestedCQs.length > 0) {
                newCQMin = Math.min.apply(null, untestedCQs);
                newCQMax = Math.max.apply(null, untestedCQs);
                args.variables.vmafNextCQs = untestedCQs.slice(0, 6);
                args.jobLog('New CQ range (constraint-aware, untested only): ' + newCQMin + ' - ' + newCQMax);
                args.jobLog('Untested CQs: ' + untestedCQs.join(', '));
            } else {
                shouldRetry = false;
                retryReason = 'No untested CQ values available below constraint boundary';
                args.jobLog('⚠ ' + retryReason);
            }
        }
        
    } else if (bestParams && sizeFlagged) {
        // Live size monitor indicated the output would be too large - try higher CQ using VMAF trend
        var currentCQForTrend = args.variables.vmafTranscodeRetryCQ || (bestParams.parameterSet && bestParams.parameterSet.quality) || suggestedCQMax || 30;
        var trendResult = calculateVMAFTrendBasedIncrement(aggregatedResults, currentCQForTrend, minVMAF, trendFudge, cqStepSize);
        
        if (trendResult && trendResult.increment > 0) {
            var proposedMinSize = Math.min(51, currentCQForTrend + cqStepSize);
            var proposedMaxSize = Math.min(51, trendResult.targetCQ);
            var untestedSizeCQs = [];
            for (var cs = proposedMinSize; cs <= proposedMaxSize; cs += cqStepSize) {
                if (!testedCQSet[cs]) {
                    untestedSizeCQs.push(cs);
                }
            }
            while (untestedSizeCQs.length < 3 && proposedMaxSize < 51) {
                proposedMaxSize += cqStepSize;
                if (proposedMaxSize <= 51 && !testedCQSet[proposedMaxSize]) {
                    untestedSizeCQs.push(proposedMaxSize);
                }
            }
            
            if (untestedSizeCQs.length > 0) {
                shouldRetry = true;
                retryReason = 'Size monitor flagged output too large - increasing CQ using VMAF trend';
                newCQMin = Math.min.apply(null, untestedSizeCQs);
                newCQMax = Math.max.apply(null, untestedSizeCQs);
                args.variables.vmafTrendAvgDropPerCQ = trendResult.avgDropPerStep;
                args.variables.vmafTrendIncrementUsed = trendResult.increment;
                args.variables.vmafTrendCurrentVMAF = trendResult.currentVMAF;
                args.variables.vmafTrendMargin = trendResult.margin;
            } else {
                args.jobLog('? Size monitor triggered but no untested CQs found in trend window');
            }
        } else {
            args.jobLog('? Size monitor triggered but insufficient trend data to propose higher CQ');
        }
        
    } else if (bestParams && suggestedCQMin && suggestedCQMax) {
        // Parameters found but there's headroom - check if worth retrying with higher CQ
        var lowestVMAF = args.variables.vmafBestMinVMAF;
        var bestVMAF = args.variables.vmafBestVMAF || bestParams.avgVMAF;
        
        args.jobLog('');
        args.jobLog('Parameters found - checking for compression headroom');
        args.jobLog('Best VMAF: ' + bestVMAF.toFixed(2) + ', Min VMAF: ' + (lowestVMAF !== null ? lowestVMAF.toFixed(2) : 'N/A'));
        
        if (lowestVMAF !== null && lowestVMAF !== undefined) {
            var headroom = lowestVMAF - minVMAF;
            args.jobLog('VMAF headroom: ' + headroom.toFixed(1) + ' points above threshold');
            
            if (headroom >= vmafHeadroomThreshold) {
                // Before retrying with higher CQ, verify we have evidence it could work
                // Check if any tested higher CQ values had acceptable VMAF
                var currentBestCQ = bestParams.parameterSet ? bestParams.parameterSet.quality : null;
                
                if (currentBestCQ !== null) {
                    // Check what's the highest CQ that had acceptable VMAF
                    var highestValidCQ = findHighestValidCQ(aggregatedResults);
                    
                    if (highestValidCQ && highestValidCQ.cq > currentBestCQ) {
                        // We have evidence that higher CQ can work
                        args.jobLog('✓ Evidence found: CQ ' + highestValidCQ.cq + ' had VMAF ' + highestValidCQ.vmaf.toFixed(2));
                        
                        // Filter suggested range to exclude already-tested CQ values
                        var untestedCQs2 = [];
                        for (var cq2 = suggestedCQMin; cq2 <= suggestedCQMax; cq2 += 2) {
                            if (!testedCQSet[cq2]) {
                                untestedCQs2.push(cq2);
                            }
                        }
                        
                        // Expand upward if needed
                        var expandedMax = suggestedCQMax;
                        while (expandedMax <= 51 && untestedCQs2.length < 3) {
                            expandedMax += 2;
                            if (expandedMax <= 51 && !testedCQSet[expandedMax]) {
                                untestedCQs2.push(expandedMax);
                            }
                        }
                        
                        if (untestedCQs2.length >= 3) {
                            shouldRetry = true;
                            retryReason = 'VMAF headroom of ' + headroom.toFixed(1) + ' points - testing higher CQ for better compression';
                            newCQMin = Math.min.apply(null, untestedCQs2);
                            newCQMax = Math.max.apply(null, untestedCQs2);
                            args.jobLog('New CQ range (untested only): ' + newCQMin + ' - ' + newCQMax);
                            args.jobLog('Untested CQs: ' + untestedCQs2.join(', '));
                        } else if (untestedCQs2.length > 0) {
                            shouldRetry = true;
                            retryReason = 'VMAF headroom of ' + headroom.toFixed(1) + ' points - testing higher CQ for better compression';
                            newCQMin = Math.min.apply(null, untestedCQs2);
                            newCQMax = Math.max.apply(null, untestedCQs2);
                            args.jobLog('Limited untested CQs available: ' + untestedCQs2.join(', '));
                        } else {
                            args.jobLog('⚠ Not enough untested CQ values - skipping retry');
                        }
                    } else {
                        // No evidence that higher CQ works - don't retry blindly
                        args.jobLog('⚠ No tested higher CQ with acceptable VMAF - not retrying blindly');
                        args.jobLog('  Highest CQ tested: ' + (highestValidCQ ? highestValidCQ.cq : 'none with acceptable VMAF'));
                    }
                }
            } else {
                args.jobLog('VMAF headroom (' + headroom.toFixed(1) + ') below threshold (' + vmafHeadroomThreshold + ') - no retry needed');
            }
        }
    }
    
    // Check retry count limit
    if (shouldRetry && retryCount >= maxRetries) {
        shouldRetry = false;
        retryReason = 'Maximum retries (' + maxRetries + ') reached';
        args.jobLog('⚠ ' + retryReason);
    }
    
    if (shouldRetry && newCQMin !== null && newCQMax !== null) {
        // Increment retry count
        args.variables.vmafRetryCount = retryCount + 1;
        
        // Set override CQ range for next test
        args.variables.vmafOverrideCQMin = newCQMin;
        args.variables.vmafOverrideCQMax = newCQMax;
        
        // Clear previous test results to force re-testing
        // But preserve vmafTestedCQs to avoid retesting
        args.variables.vmafTestResults = [];
        args.variables.vmafResults = [];
        args.variables.vmafAggregatedResults = [];
        args.variables.vmafBestParameters = null;
        
        // Store tracking info for learning
        if (!args.variables.vmafCQRangeRetryHistory) {
            args.variables.vmafCQRangeRetryHistory = [];
        }
        args.variables.vmafCQRangeRetryHistory.push({
            reason: retryReason,
            newRange: newCQMin + '-' + newCQMax,
            executed: true,
            retryCount: args.variables.vmafRetryCount,
            previousBestVMAF: args.variables.vmafBestVMAF || null,
            previousBestCQ: bestParams && bestParams.parameterSet ? bestParams.parameterSet.quality : null
        });
        
        args.jobLog('');
        args.jobLog('✓ RETRYING with CQ range: ' + newCQMin + ' - ' + newCQMax);
        args.jobLog('Reason: ' + retryReason);
        args.jobLog('Retry attempt: ' + args.variables.vmafRetryCount + ' / ' + maxRetries);
        
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    } else {
        // Check if we've exhausted all options
        if (!bestParams && selectOutput === 2 && retryCount >= maxRetries) {
            var cqRangeExhausted = isCQRangeExhausted(allTestedCQs);
            
            // Find best VMAF achieved
            var bestVMAFAchieved = 0;
            var bestCQAchieved = null;
            for (var k = 0; k < aggregatedResults.length; k++) {
                if (aggregatedResults[k].avgVMAF > bestVMAFAchieved) {
                    bestVMAFAchieved = aggregatedResults[k].avgVMAF;
                    if (aggregatedResults[k].parameterSet && aggregatedResults[k].parameterSet.quality !== undefined) {
                        bestCQAchieved = aggregatedResults[k].parameterSet.quality;
                    }
                }
            }
            
            if (cqRangeExhausted) {
                args.jobLog('CQ RANGE EXHAUSTED: Cannot achieve target VMAF (' + minVMAF + ') with any CQ value in the valid range (16-51), even after ' + retryCount + ' retry attempts.');
                args.jobLog('Tested CQ range: ' + (allTestedCQs.length > 0 ? Math.min.apply(null, allTestedCQs) + '-' + Math.max.apply(null, allTestedCQs) : 'unknown') + '.');
                args.jobLog('Best VMAF achieved: ' + bestVMAFAchieved.toFixed(2) + ' (at CQ ' + (bestCQAchieved || 'unknown') + ').');
                args.jobLog('MARKING retry-eligible: this file was the best we could do; sweep data is preserved for future retries when more training data exists.');
                args.jobLog('NON-FATAL: proceeding with best-available parameters. The file will be saved as-is and is re-queueable.');
                // Mark file for potential re-queue
                args.variables.vmafRetryEligible = true;
                args.variables.vmafRetryEligibleReason = 'cq_range_exhausted';
                // Don't throw — fall through to preserve sweep data
            } else {
                args.jobLog('');
                args.jobLog('⚠ No suitable parameters found after ' + retryCount + ' retries');
                args.jobLog('Best VMAF achieved: ' + bestVMAFAchieved.toFixed(2) + ' (target: ' + minVMAF + ')');
                args.jobLog('Tested CQ range: ' + (allTestedCQs.length > 0 ? Math.min.apply(null, allTestedCQs) + '-' + Math.max.apply(null, allTestedCQs) : 'unknown'));
            }
        } else {
            if (retryCount > 0) {
                args.jobLog('');
                args.jobLog('✓ Retry cycle complete. Total retries: ' + retryCount);
            }
            if (bestParams) {
                args.jobLog('✓ Suitable parameters found - continuing to transcode');
            } else if (selectOutput !== 2) {
                args.jobLog('✓ Proceeding with selected parameters');
            } else {
                args.jobLog('⚠ No suitable parameters found after ' + retryCount + ' retries');
            }
        }
        
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 2,
            variables: args.variables,
        };
    }
};
exports.plugin = plugin;
