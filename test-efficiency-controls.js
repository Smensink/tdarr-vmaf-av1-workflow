'use strict';

const assert = require('assert');

const calculate = require('./custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js');
const encoding = require('./custom-cont-init.d/vmaf-plugin-patches/testEncodingParameters/1.0.0/index.js');
const metricContracts = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafMetricContract.js');

const calculateInputs = Object.fromEntries(calculate.details().inputs.map((input) => [input.name, input]));
const encodingInputs = Object.fromEntries(encoding.details().inputs.map((input) => [input.name, input]));

assert.strictEqual(calculateInputs.ssimMode.defaultValue, 'off');
assert.strictEqual(calculateInputs.pairedCqShadow.defaultValue, 'true');
assert.strictEqual(calculateInputs.pairedCqShadowForceFull.defaultValue, 'true');
assert.strictEqual(calculateInputs.pairedCqShadowAnchors.defaultValue, '6');
assert.strictEqual(encodingInputs.explorationRate.defaultValue, '0.02');
assert.strictEqual(encodingInputs.sameTitleEmptyBandShadow.defaultValue, 'true');
assert.strictEqual(encodingInputs.encodeHardAbort.defaultValue, 'false');

assert.strictEqual(calculate._test.shouldRunSsim({ variables: {}, inputs: {} }), false);
assert.strictEqual(calculate._test.shouldRunSsim({
  variables: { vmafSsimMode: 'first-round' }, inputs: {},
}), true);
assert.strictEqual(calculate._test.shouldRunSsim({ variables: { vmafRetryCount: 1 }, inputs: {} }), false);
assert.strictEqual(calculate._test.shouldRunSsim({
  variables: { vmafRetryCount: 1, vmafSsimMode: 'all' }, inputs: {},
}), true);
assert.strictEqual(calculate._test.shouldRunSsim({
  variables: { vmafSsimMode: 'off' }, inputs: {},
}), false);

let checks = 0;
const args = { ffmpegPath: '/usr/bin/ffmpeg-a', variables: {} };
const standardMetric = metricContracts.resolveProductionForVideo(1920, 1080);
const fourKMetric = metricContracts.resolveProductionForVideo(3840, 2160);
let result = calculate._test.resolveGpuVmafSupport(
  args, standardMetric, () => { checks += 1; return true; });
assert.deepStrictEqual(result, { available: true, cacheHit: false });
result = calculate._test.resolveGpuVmafSupport(
  args, standardMetric, () => { checks += 1; return true; });
assert.deepStrictEqual(result, { available: true, cacheHit: true });
assert.strictEqual(checks, 1, 'positive capability result should be checked once per exact contract');
assert.strictEqual(args.variables.vmafGpuCapabilityCacheHits, 1);
result = calculate._test.resolveGpuVmafSupport(
  args, fourKMetric, () => { checks += 1; return true; });
assert.deepStrictEqual(result, { available: true, cacheHit: false },
  'a different selected model must run its own CUDA capability probe');
result = calculate._test.resolveGpuVmafSupport(
  args, fourKMetric, () => { checks += 1; return true; });
assert.deepStrictEqual(result, { available: true, cacheHit: true });

const fs = require('fs');
const selectorSource = fs.readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js', 'utf8');
const calculateSource = fs.readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js', 'utf8');
const monitorSource = fs.readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/monitorTranscodeRetry/1.0.0/index.js', 'utf8');
const extractSource = fs.readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/extractVideoSamples/1.0.0/index.js', 'utf8');
const databaseSource = fs.readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js', 'utf8');
assert(selectorSource.includes('vmafConfiguredMinFrameVMAF = minFrameVMAF'));
assert(selectorSource.includes('vmafMinFrameVMAF = adjustedMinFrameVMAF'));
assert(monitorSource.includes('vmafP1Floor: Number(policy.adaptiveFrameFloor) || Number(args.variables.vmafMinFrameVMAF)'));
assert(monitorSource.includes('predictedNoFeasibleWithProof: false'),
  'same-title history must never claim a terminal no-feasible prediction');
assert(selectorSource.includes('bits_per_pixel: Number(bitsPerPixel) > 0 ? Number(bitsPerPixel) : null'));
assert(selectorSource.includes('source_bitrate_mbps: Number(sourceBitrateMbps) > 0 ? Number(sourceBitrateMbps) : null'));
assert(selectorSource.includes("pipeline_version: 'size-shadow-prospective-label-v2'"));
assert(extractSource.includes('execFileSyncProbe(args.ffmpegPath'),
  'dark-scene probe must execute FFmpeg directly so timeout kills the decoder');
assert(extractSource.includes("killSignal: 'SIGKILL'"));
assert(extractSource.includes('if (pstSel.timedOut) break;'));
assert(extractSource.includes('args.inputFileObj._id || args.inputFileObj.file || args.inputFileObj.filePath'));
assert(extractSource.includes('args.variables.vmafSourceBitrateMbps = sourceBitrateMbps'));
assert(extractSource.includes('args.variables.vmafSourceBpp = liveSourceBpp'));
assert(extractSource.includes('Pre-FGS CAMBI source baseline deferred to authenticated reference scoring.'));
assert(calculateSource.includes('measureSourceCambiBaselines'));
assert(calculateSource.includes('metricContract.cambi.required === true'));
assert.doesNotMatch(extractSource, /\]libvmaf=.*feature=name=cambi/,
  'sample extraction must never launch the old CPU source-CAMBI pass');
assert.doesNotMatch(selectorSource, /\]libvmaf=.*feature=name=cambi/,
  'selection must never launch a CPU source-CAMBI pass');
assert.doesNotMatch(calculateSource, /buildCpuVmafCommand|\]libvmaf=/,
  'calculation must not retain a CPU VMAF fallback command');
assert(calculateSource.includes('Cross-contract fallback is forbidden.'));
assert(calculateSource.includes('cross-contract fallback is disabled.'));
assert(databaseSource.includes('var SCHEMA_VERSION = 15;'));
assert(databaseSource.includes('reference_contract_id'));
assert(databaseSource.includes('metric_contract_id'));
assert(databaseSource.includes('encoder_profile_id'));
assert(databaseSource.includes("'clip_vmafs', 'clip_vmaf_means', 'clip_vmaf_p1s', 'clip_cambis'"));

args.ffmpegPath = '/usr/bin/ffmpeg-b';
result = calculate._test.resolveGpuVmafSupport(
  args, fourKMetric, () => { checks += 1; return false; });
assert.deepStrictEqual(result, { available: false, cacheHit: false });
result = calculate._test.resolveGpuVmafSupport(
  args, fourKMetric, () => { checks += 1; return true; });
assert.deepStrictEqual(result, { available: true, cacheHit: false });
assert.strictEqual(checks, 4, 'negative capability result must be retried rather than cached');

console.log('PASS efficiency controls (SSIM off, capability cache, exploration, safe shadows)');
