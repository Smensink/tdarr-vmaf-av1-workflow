'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../FlowHelpers/1.0.0/cliUtils') {
    return { CLI: class MockCLI {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const selectorPayloadPath = path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js');
const selectorServerPath = path.join(__dirname,
  'plugins/vmaf/selectBestParameters/1.0.0/index.js');
const transcodePayloadPath = path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js');
const transcodeServerPath = path.join(__dirname,
  'plugins/vmaf/vmafOptimizedTranscode/1.0.0/index.js');

const selector = require(selectorPayloadPath)._test;
const transcode = require(transcodePayloadPath)._test;

const finalResult = {
  parameterSetId: 'gpu_p7_cq30.7_cqa35.6',
  parameterSet: {
    id: 'gpu_p7_cq30.7_cqa35.6',
    quality: 35.6,
    cq: 35.6,
    encoder: 'av1_nvenc',
    preset: 'p7',
    isGPU: true,
  },
};
const variables = {
  // Reproduce the stale pre-override value observed in the cancelled canary.
  vmafBestParameters: {
    id: 'gpu_p7_cq30.7', quality: 30.7, cq: 30.7, encoder: 'av1_nvenc', preset: 'p7', isGPU: true,
  },
};
const published = selector.publishFinalSelection(variables, finalResult);
assert.deepStrictEqual(published, {
  cq: 35.6,
  parameterSetId: 'gpu_p7_cq30.7_cqa35.6',
});
assert.strictEqual(variables.vmafBestParameters, finalResult.parameterSet,
  'the downstream parameter object must be replaced after the final override');
assert.strictEqual(variables.vmafBestParameters.quality, 35.6);
assert.strictEqual(variables.vmafFinalSelectedCQ, 35.6);
assert.strictEqual(variables.vmafSelectedParameterSetId, 'gpu_p7_cq30.7_cqa35.6');

const downstreamCQ = transcode.resolveFinalTranscodeCQ(variables.vmafBestParameters, variables);
assert.strictEqual(downstreamCQ, 35.6,
  'the exact fractional selector CQ must reach the final transcode');
const finalArgs = transcode.buildFinalTranscodeArgs({
  bestParams: variables.vmafBestParameters,
  originalFile: 'source.mkv',
  outputPath: 'output.mkv',
  pixFmt: 'p010le',
  useCQ: downstreamCQ,
  colorPrimaries: 'bt709',
  colorTrc: 'bt709',
  colorspace: 'bt709',
  canonicalDenoise: false,
});
assert.strictEqual(finalArgs[finalArgs.indexOf('-cq') + 1], '35.6');

assert.throws(() => transcode.resolveFinalTranscodeCQ({
  id: 'gpu_p7_cq30.7', quality: 30.7,
}, variables), /final selected CQ contract mismatch/,
'a stale pre-override parameter object must fail before FFmpeg starts');
assert.throws(() => transcode.resolveFinalTranscodeCQ({
  id: 'wrong-id', quality: 35.6,
}, variables), /parameter-set contract mismatch/,
'a stale or mismatched parameter ID must fail before FFmpeg starts');
for (const invalidCQ of [null, undefined, '', '   ', NaN, Infinity, -Infinity]) {
  assert.throws(() => transcode.resolveFinalTranscodeCQ({
    id: 'bad-cq', quality: invalidCQ,
  }, {}), /no finite CQ/,
  `transcode handoff must reject invalid CQ ${String(invalidCQ)}`);
  assert.strictEqual(selector.finiteMeasuredNumber(invalidCQ), null,
    `selector must reject invalid CQ ${String(invalidCQ)}`);
}

const measured = {
  parameterSetId: 'gpu_p7_cq30.7',
  parameterSet: { id: 'gpu_p7_cq30.7', quality: 30.7 },
};
const technicalVariables = {
  vmafConstraintAwareCQApplied: true,
  vmafConstraintAwareCQValidated: false,
  vmafMaxCompressionApplied: true,
};
const fallback = selector.markConstraintAwareHoldoutTechnicalFailure(
  technicalVariables, measured, new ReferenceError('tool runner unavailable'));
assert.strictEqual(fallback.bestParams, measured);
assert.strictEqual(fallback.cq, 30.7);
assert.strictEqual(technicalVariables.vmafConstraintAwareCQApplied, false);
assert.strictEqual(technicalVariables.vmafConstraintAwareCQReverted, true);
assert.strictEqual(technicalVariables.vmafConstraintAwareCQValidated, false);
assert.strictEqual(technicalVariables.vmafHoldoutFailReason,
  'constraint_aware_holdout_technical_error');
assert.strictEqual(technicalVariables.vmafHoldoutSuggestedCQ, 30.7);

const interpolatedVariables = {
  vmafInterpolatedCQ: 35.6,
  vmafInterpolatedFrom: 30.7,
};
const predictedFractional = {
  parameterSetId: 'gpu_p7_cq30.7_cqi35.6',
  parameterSet: { id: 'gpu_p7_cq30.7_cqi35.6', quality: 35.6 },
  vmafInterpolated: true,
};
const interpolationFallback = selector.revertPredictionOnlyFractionalSelection(
  interpolatedVariables, predictedFractional, measured);
assert.strictEqual(interpolationFallback.bestParams, measured,
  'an unvalidated interpolation must restore the captured measured result');
assert.strictEqual(interpolationFallback.cq, 30.7);
assert.strictEqual(interpolationFallback.reverted, true);
assert.strictEqual(interpolatedVariables.vmafInterpolatedCQ, null);
assert.strictEqual(interpolatedVariables.vmafInterpolatedCQRejected, 35.6);
assert.strictEqual(interpolatedVariables.vmafInterpolatedCQReverted, true);
const measuredPassThrough = selector.revertPredictionOnlyFractionalSelection(
  {}, measured, measured);
assert.strictEqual(measuredPassThrough.bestParams, measured,
  'a primary holdout tooling failure may retain an already-measured CQ');
assert.strictEqual(measuredPassThrough.reverted, false);

const completeHoldout = {
  avgVMAF: 96.2,
  vmafP1: 89.4,
  minVMAF: 85,
  cambiMean: 2.1,
  cambiP95: 3.2,
};
assert.strictEqual(selector.validateHoldoutMetrics(completeHoldout, 86).ok, true);
for (const badCambi of [null, undefined, '', '   ', NaN, Infinity]) {
  const missingMean = Object.assign({}, completeHoldout, { cambiMean: badCambi });
  assert.strictEqual(selector.validateHoldoutMetrics(missingMean, 86).ok, true,
    `unavailable CAMBI mean ${String(badCambi)} is optional in the GPU-only contract`);
  assert.strictEqual(selector.validateHoldoutMetrics(
    missingMean, 86, { requireCambi: true }).ok, false,
  `a future contract that requires CAMBI must reject invalid mean ${String(badCambi)}`);
  const missingP95 = Object.assign({}, completeHoldout, { cambiP95: badCambi });
  assert.strictEqual(selector.validateHoldoutMetrics(missingP95, 86).ok, true,
    `unavailable CAMBI p95 ${String(badCambi)} is optional in the GPU-only contract`);
  assert.strictEqual(selector.validateHoldoutMetrics(
    missingP95, 86, { requireCambi: true }).ok, false,
  `a future contract that requires CAMBI must reject invalid p95 ${String(badCambi)}`);
}
const missingFrameMetric = Object.assign({}, completeHoldout, {
  vmafP1: null,
  minVMAF: null,
});
assert.strictEqual(selector.validateHoldoutMetrics(missingFrameMetric, 86).ok, false,
  'missing P1/min metrics must fail when the frame floor is active');
assert.strictEqual(selector.validateHoldoutMetrics(missingFrameMetric, 0).ok, true,
  'P1/min metrics are optional only when the frame floor is disabled');
assert.strictEqual(selector.validateHoldoutMetrics(
  Object.assign({}, completeHoldout, { avgVMAF: NaN }), 86).ok, false,
'non-finite VMAF must never authorize a harder CQ');
const dualCQFields = { quality: 30.7, cq: 30.7 };
selector.setParameterSetCQ(dualCQFields, 35.6);
assert.deepStrictEqual(dualCQFields, { quality: 35.6, cq: 35.6 },
  'every synthetic CQ mutation must keep quality and cq synchronized');
const qualityOnly = { quality: 30.7 };
selector.setParameterSetCQ(qualityOnly, 35.6);
assert.deepStrictEqual(qualityOnly, { quality: 35.6 });
assert.throws(() => selector.setParameterSetCQ({ quality: 30 }, '   '), /non-finite/);

const selectorSource = fs.readFileSync(selectorPayloadPath, 'utf8');
assert.strictEqual((selectorSource.match(/\bexecSync\s*\(/g) || []).length, 0,
  'holdout work must not use a shell-command execSync alias');
assert.strictEqual((selectorSource.match(/execFileSync\('\/bin\/sh', \['-c'/g) || []).length, 0,
  'the GPU holdout must not cross a /bin/sh -c boundary');
assert(selectorSource.includes('execFileSync(args.ffmpegPath, holdoutVmafArgs'),
  'the GPU holdout VMAF command must execute its argv directly');
assert(selectorSource.includes("safeId + '_candidate'") &&
  selectorSource.includes("safeId + '_source'") &&
  selectorSource.includes('measureHoldoutPreFgsCambi(args, distortedPath') &&
  selectorSource.includes('measureHoldoutPreFgsCambi(args, holdout.path'),
'candidate and source holdout CAMBI use separate required CPU pre-FGS measurements');
assert(selectorSource.includes('&& !holdoutTechnicalFailure'),
  'a primary holdout technical failure must disable a harder prediction-only override');
assert(selectorSource.includes('!args.variables.vmafToleranceFallbackActive && primaryHoldoutAvailable'),
  'prediction-only interpolation requires an enabled reserved holdout');
assert(selectorSource.includes('var skippedHoldoutFallback = revertPredictionOnlyFractionalSelection('),
  'the disabled/missing-holdout branch must explicitly restore a provisional interpolation');
assert(selectorSource.includes('var primaryHoldoutMetrics = validateHoldoutMetrics(') &&
  selectorSource.includes('var _validated2 = validateHoldoutMetrics('),
'primary and constraint-aware holdouts must both enforce mandatory finite metrics');
assert(selectorSource.includes('args.variables.vmafConstraintAwareCQApplied = false;') &&
  selectorSource.includes('args.variables.vmafConstraintAwareCQValidated = false;'),
'retry-persistent override flags must reset for each selection attempt');
const measuredCapture = selectorSource.indexOf('var preFractionalRefinementParams = bestParams;');
const interpolationStart = selectorSource.indexOf('var interpPts = aggregatedResults.filter');
assert(measuredCapture > 0 && measuredCapture < interpolationStart,
  'the measured fallback must be captured immediately before interpolation');
assert.strictEqual((selectorSource.match(/setParameterSetCQ\(/g) || []).length, 4,
  'all three synthetic CQ mutations must use the shared synchronized setter');
assert(selectorSource.indexOf(
  'var _ffCommit = commitForcedFullSelection(args, bestParams, {') >
  selectorSource.indexOf('catch (_acErr)'),
'the final downstream handoff must be published after override validation and reversion');

assert.strictEqual(fs.readFileSync(selectorPayloadPath, 'utf8'),
  fs.readFileSync(selectorServerPath, 'utf8'), 'selector payload/server mirrors differ');
assert.strictEqual(fs.readFileSync(transcodePayloadPath, 'utf8'),
  fs.readFileSync(transcodeServerPath, 'utf8'), 'transcode payload/server mirrors differ');

console.log('PASS selector holdout safety and final-CQ handoff contract');
