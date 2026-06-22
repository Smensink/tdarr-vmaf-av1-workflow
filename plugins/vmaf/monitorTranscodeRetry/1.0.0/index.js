"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
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
    ],
}); };
exports.details = details;

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var fs = require('fs');
    var maxRetries = Number(args.inputs.maxRetries) || 3;

    // ENHANCEMENT FIX #14: Input validation
    if (isNaN(maxRetries) || maxRetries < 0) {
        args.jobLog('WARNING: Invalid maxRetries (' + args.inputs.maxRetries + '), using default 3');
        maxRetries = 3;
    }

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

    // Initialize retry count if not set
    var retryCount = args.variables.vmafTranscodeRetryCount || 0;

    // Get VMAF thresholds
    var minVMAF = args.variables.vmafMinVMAF || 90;
    var minFrameVMAF = args.variables.vmafMinFrameVMAF || 0; // 0 means disabled

    // Get aggregated results from sweep
    var aggregatedResults = args.variables.vmafAggregatedResults || [];
    args.variables.vmafTrendAvgDropPerCQ = null;
    args.variables.vmafTrendIncrementUsed = null;
    args.variables.vmafTrendCurrentVMAF = null;
    args.variables.vmafTrendMargin = null;

    // Check if transcode was cancelled due to size
    var liveSizeCompare = args.variables.liveSizeCompare;
    var wasCancelled = liveSizeCompare && liveSizeCompare.error === true;

    args.jobLog('=== VMAF-Aware Transcode Retry Check ===');
    args.jobLog('Current retry count: ' + retryCount + ' / ' + maxRetries);
    args.jobLog('VMAF thresholds: minVMAF=' + minVMAF + ', minFrameVMAF=' + minFrameVMAF);
    args.jobLog('Available sweep results: ' + aggregatedResults.length + ' parameter sets');

    // Helper function to check if a result meets VMAF thresholds
    function meetsVMAFThreshold(result) {
        if (!result) return false;
        if (result.avgVMAF < minVMAF) return false;
        if (minFrameVMAF > 0 && result.minVMAF !== null && result.minVMAF !== undefined) {
            if (result.minVMAF < minFrameVMAF) return false;
        }
        return true;
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

            var errorMsg = 'TRANSCODE FAILED: Maximum retries (' + maxRetries + ') exceeded. ';
            errorMsg += 'Original CQ: ' + originalCQ + ', Final CQ: ' + currentCQ + '. ';
            errorMsg += 'File size still exceeds original. ';
            errorMsg += 'Consider: lowering VMAF threshold, increasing max retries, or skipping this file.';
            throw new Error(errorMsg);
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
            if (outputFile && fs.existsSync(outputFile)) {
                try {
                    fs.unlinkSync(outputFile);
                    args.jobLog('Cleared partial transcode output: ' + outputFile);
                } catch (err) {
                    args.jobLog('⚠ Could not delete partial output: ' + err.message);
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
                return {
                    outputFileObj: args.inputFileObj,
                    outputNumber: 2,
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

            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 2,
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
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 2,
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
            return {
                outputFileObj: args.inputFileObj,
                outputNumber: 2,
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
        if (outputFile && fs.existsSync(outputFile)) {
            try {
                fs.unlinkSync(outputFile);
                args.jobLog('Cleared partial transcode output: ' + outputFile);
            } catch (err) {
                args.jobLog('⚠ Could not delete partial output: ' + err.message);
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
        // Transcode succeeded or completed
        if (retryCount > 0) {
            args.jobLog('✓ Transcode completed successfully after ' + retryCount + ' retry attempt(s)');

            // Store success info for learning
            if (!args.variables.vmafTranscodeFailures) {
                args.variables.vmafTranscodeFailures = [];
            }
            var finalCQ = args.variables.vmafTranscodeRetryCQ ||
                         (args.variables.vmafBestParameters && args.variables.vmafBestParameters.quality);
            args.variables.vmafTranscodeFailures.push({
                originalCQ: args.variables.vmafTranscodeOriginalCQ || finalCQ,
                finalCQ: finalCQ,
                retries: retryCount,
                reason: 'size_too_large',
                succeeded: true,
                retryHistory: args.variables.vmafTranscodeRetryHistory || []
            });
        } else {
            args.jobLog('✓ Transcode completed successfully (no retries needed)');
        }

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 2,
            variables: args.variables,
        };
    }
};
exports.plugin = plugin;
