'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const patchRoot = path.join(root, 'custom-cont-init.d', '.vmaf-plugin-patches');
const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../FlowHelpers/1.0.0/cliUtils') {
    return { CLI: class MockCLI {} };
  }
  if (request === '../../../../../methods/lib') {
    return function () {
      return { loadDefaultValues(inputs) { return inputs || {}; } };
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const activationModule = require(path.join(patchRoot, 'activateHevcFallback', '1.0.0', 'index.js'));
const activation = activationModule._test;
const enabledInput = activationModule.details().inputs.find((input) => input.name === 'enabled');
assert(enabledInput, 'HEVC activation plugin must expose its enable switch');
assert.strictEqual(enabledInput.defaultValue, 'false',
  'HEVC activation must remain default-off when a Flow omits the input');
const disabledInput = h264File('/media/Test/disabled-hevc.mkv');
const disabledVariables = { sentinel: 'preserved' };
const disabledLogs = [];
const disabledResult = activationModule.plugin({
  inputs: {
    enabled: false,
    manifestPath: path.join(os.tmpdir(), `absent-hevc-manifest-${process.pid}.json`),
  },
  inputFileObj: disabledInput,
  variables: disabledVariables,
  jobLog(message) { disabledLogs.push(String(message)); },
});
assert.strictEqual(disabledResult.outputNumber, 2);
assert.strictEqual(disabledResult.outputFileObj, disabledInput);
assert.strictEqual(disabledResult.variables, disabledVariables);
assert.deepStrictEqual(disabledVariables, { sentinel: 'preserved' },
  'disabled adapter must not publish HEVC state');
assert.deepStrictEqual(disabledLogs,
  ['Temporary HEVC fallback disabled; preserving the existing AV1 path.'],
  'disabled adapter must return before any manifest read/authentication failure');
const samples = require(path.join(patchRoot, 'testEncodingParameters', '1.0.0', 'index.js'))._test;
const select = require(path.join(patchRoot, 'selectBestParameters', '1.0.0', 'index.js'))._test;
const transcode = require(path.join(patchRoot, 'vmafOptimizedTranscode', '1.0.0', 'index.js'))._test;
const grain = require(path.join(patchRoot, 'synthesizeFilmGrain', '1.0.0', 'index.js'))._test;
const retryModule = require(path.join(patchRoot, 'checkCQRangeRetry', '1.0.0', 'index.js'));
const retry = retryModule._test;
const bracket = require(path.join(patchRoot, 'checkCQBracket', '1.0.0', 'index.js'));
const nvenc = require(path.join(patchRoot, '_lib', 'nvencTemporalFilter.js'));
const requeue = require(path.join(__dirname, 'requeue-hevc-fallback-cohort.js'));
const cohortFixture = require(path.join(__dirname, 'fixtures', 'build-hevc-fallback-cohort.js'));

assert.strictEqual(requeue.isRequeueableCohortState('Not required'), true);
assert.strictEqual(requeue.isRequeueableCohortState('Queued'), true);
assert.strictEqual(requeue.isRequeueableCohortState('Transcode error'), true,
  'a manifest-bound source may be recovered after the failed live canary');
assert.strictEqual(requeue.isRequeueableCohortState('Success'), false,
  'completed/replaced files must not be silently requeued');

const nonJsonMutationReadback = requeue.mutateQueueAndReadBack(
  { apiBase: 'http://unused.invalid' },
  async (relativePath, options) => {
    assert.strictEqual(relativePath, 'cruddb');
    assert.strictEqual(options.body.data.mode, 'getById');
    return { _id: '/media/Test/non-json.mkv', file: '/media/Test/non-json.mkv',
      TranscodeDecisionMaker: 'Queued', holdUntil: 0 };
  },
  { file_id: '/media/Test/non-json.mkv' },
  async (config, relativePath, body) => {
    assert.strictEqual(relativePath, 'cruddb');
    assert.strictEqual(body.data.mode, 'update');
    return undefined;
  }
);

function h264File(id, size = 1000) {
  return {
    _id: id,
    file: id,
    file_size: size,
    video_codec_name: 'h264',
    ffProbeData: {
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }],
      format: { size: String(size), duration: '3600' },
    },
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-hevc-fallback-'));
const sourceId = path.join(tmp, 'retained.mkv');
fs.writeFileSync(sourceId, Buffer.alloc(1000, 0x5a));
const source = h264File(sourceId);
const sourceIdentity = activation.cohortIdentity(source);
assert(/^[0-9a-f]{64}$/.test(sourceIdentity.path_sha256));
assert.strictEqual(activation.cohortIdentity(h264File(sourceId, 999)).source_size_bytes, 999);
const conflictingSizeDomains = h264File(sourceId, 7.5);
conflictingSizeDomains.ffProbeData.format.size = '1000';
assert.strictEqual(activation.cohortIdentity(conflictingSizeDomains).source_size_bytes, 1000,
  'cohort identity must use ffprobe bytes, never Tdarr file_size units');
assert.notStrictEqual(
  activation.cohortIdentity(h264File('/media/a\\b.mkv')).path_sha256,
  activation.cohortIdentity(h264File('/media/a/b.mkv')).path_sha256,
  'opaque POSIX FileJSONDB IDs must not collide through slash normalization'
);

const manifestPath = path.join(tmp, 'cohort.json');
const builtCohort = cohortFixture.buildSyntheticCohort({
  outputPath: manifestPath,
  source: { fileId: sourceId, filePath: sourceId, sourceSizeBytes: 1000 },
});
const entries = builtCohort.manifest.entries;
function completeManifest(manifestEntries) {
  return cohortFixture.finalizeManifest({
    ...builtCohort.manifest,
    entries: manifestEntries,
  });
}
assert.strictEqual(activation.readManifest(manifestPath).entries.length, 30);
const manifestFileSha256 = builtCohort.manifestFileSha256;
const manifestCanonicalSha256 = builtCohort.manifestCanonicalSha256;
const duplicateManifestPath = path.join(tmp, 'duplicate-cohort.json');
const duplicates = Array.from({ length: 30 }, () => ({ ...entries[0] }));
fs.writeFileSync(duplicateManifestPath, JSON.stringify(completeManifest(duplicates)));
assert.throws(() => activation.readManifest(duplicateManifestPath), /invalid or duplicate entry/);
const missingDigestPath = path.join(tmp, 'missing-manifest-digest.json');
const missingDigest = completeManifest(entries);
delete missingDigest.manifest_sha256;
fs.writeFileSync(missingDigestPath, JSON.stringify(missingDigest));
assert.throws(() => activation.readManifest(missingDigestPath), /integrity contract/);
const corruptBindingPath = path.join(tmp, 'corrupt-source-binding.json');
const corruptBinding = completeManifest(entries.map((entry) => ({ ...entry })));
corruptBinding.entries[0].source_binding_sha256 = 'f'.repeat(64);
corruptBinding.snapshotProvenance.selectedSourceBindingsSha256 =
  activation.sourceBindingsSnapshotSha256(corruptBinding.entries);
delete corruptBinding.manifest_sha256;
corruptBinding.manifest_sha256 = require('crypto').createHash('sha256')
  .update(activation.canonicalJson(corruptBinding)).digest('hex');
fs.writeFileSync(corruptBindingPath, JSON.stringify(corruptBinding));
assert.throws(() => activation.readManifest(corruptBindingPath), /invalid or duplicate entry/);
const missingPriorEvidencePath = path.join(tmp, 'missing-prior-evidence.json');
const missingPriorEvidence = completeManifest(entries.map((entry) => ({ ...entry })));
delete missingPriorEvidence.entries[0].priorSweepPointCount;
missingPriorEvidence.snapshotProvenance.selectedSourceBindingsSha256 =
  activation.sourceBindingsSnapshotSha256(missingPriorEvidence.entries);
delete missingPriorEvidence.manifest_sha256;
missingPriorEvidence.manifest_sha256 = require('crypto').createHash('sha256')
  .update(activation.canonicalJson(missingPriorEvidence)).digest('hex');
fs.writeFileSync(missingPriorEvidencePath, JSON.stringify(missingPriorEvidence));
assert.throws(() => activation.readManifest(missingPriorEvidencePath), /invalid or duplicate entry/,
  'manifest must fail closed when prior AV1 terminal evidence is incomplete');

const baseVariables = {
  vmafCodecStage: 'av1',
  vmafGPUEncoder: 'av1_nvenc',
  vmafReferenceContractId: 'nvencc-knn-r3-d0-s008-l020-th080-tf0-gpu8vmaf-v1',
  vmafCanonicalDenoiseActive: true,
  vmafNvencTemporalPolicy: nvenc.CANONICAL_POLICY,
  vmafBestParameters: null,
  vmafSelectOutput: 2,
  vmafSelectionStatus: 'no_feasible_parameters',
  vmafAv1TerminalAuthenticated: true,
  vmafSweepRetriesExhausted: true,
  vmafTranscodeGaveUp: true,
  vmafTestedCQs: [16, 18, 21, 24],
  vmafTestResults: [{ parameterSetId: 'av1-old' }],
  vmafAggregatedResults: [{
    parameterSetId: 'av1-old',
    parameterSet: { quality: 16, encoder: 'av1_nvenc', pixFmt: 'p010le' },
    avgVMAF: 93.2,
    vmafP1Low: 86.2,
  }],
  vmafRejectedResults: [{ cq: 16, reason: 'SSIMULACRA2 p5' }],
  vmafRetryCount: 4,
  vmafMaxRetries: 4,
  vmafSweepRetriesExhausted: true,
  vmafTranscodeGaveUp: true,
};

const decision = activation.activationDecision({
  enabled: true,
  manifestPath,
  inputFileObj: source,
  variables: baseVariables,
});
assert.strictEqual(decision.activate, true);
assert.strictEqual(decision.evidenceSource, 'live_authenticated_terminal');
assert.strictEqual(decision.entry.av1_terminal_reason, 'no_feasible_parameters');
const priorDecision = activation.activationDecision({
  enabled: true,
  allowManifestPriorTerminal: true,
  manifestPath,
  inputFileObj: source,
  variables: {
    vmafCodecStage: 'av1',
    vmafGPUEncoder: 'av1_nvenc',
    vmafReferenceContractId: baseVariables.vmafReferenceContractId,
    vmafCanonicalDenoiseActive: true,
    vmafNvencTemporalPolicy: nvenc.CANONICAL_POLICY,
  },
});
assert.strictEqual(priorDecision.activate, true,
  'exact current source plus frozen prior terminal evidence should skip AV1 replay');
assert.strictEqual(priorDecision.evidenceSource, 'manifest_bound_prior_terminal');
assert.strictEqual(activation.activationDecision({
  enabled: true,
  manifestPath,
  inputFileObj: source,
  variables: { vmafCodecStage: 'av1', vmafGPUEncoder: 'av1_nvenc' },
}).activate, false, 'prior terminal evidence must require an explicit Flow-node opt-in');
assert.strictEqual(activation.activationDecision({
  enabled: true, manifestPath, inputFileObj: source,
  variables: { ...baseVariables, vmafAv1TerminalAuthenticated: false },
}).activate, false, 'selector output alone must not authenticate terminal AV1');
assert.strictEqual(activation.activationDecision({
  enabled: true, manifestPath, inputFileObj: source,
  variables: { ...baseVariables, vmafSweepRetriesExhausted: false },
}).activate, false, 'AV1 terminal handoff requires exhausted retry state');
const transportedTerminal = {
  vmafGPUEncoder: 'av1_nvenc',
  vmafBestParameters: null,
  vmafSelectOutput: 2,
  vmafTestedCQs: [16, 18],
  vmafAggregatedResults: [{ parameterSet: { quality: 16 }, avgVMAF: 92 }],
};
assert.strictEqual(retry.markAv1TerminalHandoff(transportedTerminal, null, 2), true,
  'terminal retry node must authenticate measured AV1 exhaustion');
assert.strictEqual(transportedTerminal.vmafSelectionStatus, 'no_feasible_parameters');
assert.strictEqual(transportedTerminal.vmafAv1TerminalAuthenticated, true);
assert.strictEqual(transportedTerminal.vmafSweepRetriesExhausted, true);
assert.strictEqual(transportedTerminal.vmafTranscodeGaveUp, true);
assert.strictEqual(retry.markAv1TerminalHandoff({
  vmafGPUEncoder: 'av1_nvenc', vmafTestedCQs: [], vmafAggregatedResults: [],
}, null, 2), false, 'terminal handoff must reject unmeasured selector output');
const malformedEvidence = {
  ...baseVariables,
  vmafTestedCQs: [18],
  vmafAggregatedResults: [{}],
  vmafAv1TerminalAuthenticated: false,
};
assert.strictEqual(retry.markAv1TerminalHandoff(malformedEvidence, null, 2), false,
  'terminal producer must reject aggregate rows without a finite measured VMAF tied to a tested CQ');
assert.strictEqual(activation.av1TerminalWithoutSelection({
  ...malformedEvidence, vmafAv1TerminalAuthenticated: true,
}), false, 'terminal consumer must independently reject malformed aggregate evidence');
const staleTerminal = {
  vmafGPUEncoder: 'av1_nvenc',
  vmafAv1TerminalAuthenticated: true,
  vmafTestedCQs: [18],
  vmafAggregatedResults: [{ parameterSet: { quality: 18 }, avgVMAF: 92 }],
};
assert.strictEqual(retry.markAv1TerminalHandoff(staleTerminal, { quality: 18 }, 1), false);
assert.strictEqual(Object.hasOwn(staleTerminal, 'vmafAv1TerminalAuthenticated'), false,
  'a non-terminal traversal must clear a stale AV1 authentication marker');
const staleEarlyReturn = retryModule.plugin({
  inputs: { maxRetries: 4, vmafHeadroomThreshold: 5, vmafBelowThresholdMargin: 5 },
  variables: {
    ...baseVariables,
    vmafTriggerSweepRetry: true,
    vmafAv1TerminalAuthenticated: true,
  },
  inputFileObj: source,
  jobLog() {},
  updateWorker() {},
});
assert.strictEqual(staleEarlyReturn.outputNumber, 2);
assert.strictEqual(Object.hasOwn(staleEarlyReturn.variables, 'vmafAv1TerminalAuthenticated'), false,
  'every AV1 traversal must clear stale authentication before an early return');
const wrapperResult = activationModule.plugin({
  inputs: {
    enabled: true, manifestPath, manifestFileSha256, manifestCanonicalSha256, expectedCohortSize: 30,
    initialCqs: '18,23,28', maxUniqueCqs: 8, maxRetries: 2,
  },
  inputFileObj: source,
  variables: { ...baseVariables },
  jobLog() {},
});
assert.strictEqual(wrapperResult.outputNumber, 1,
  'the real wrapper must consume the exact generated-schema 30-entry manifest snapshot');
assert.strictEqual(wrapperResult.variables.vmafGPUEncoder, 'hevc_nvenc');
const priorWrapperResult = activationModule.plugin({
  inputs: {
    enabled: true, allowManifestPriorTerminal: true,
    manifestPath, manifestFileSha256, manifestCanonicalSha256, expectedCohortSize: 30,
    initialCqs: '18,23,28', maxUniqueCqs: 8, maxRetries: 2,
  },
  inputFileObj: source,
  variables: {
    vmafCodecStage: 'av1', vmafGPUEncoder: 'av1_nvenc',
    vmafReferenceContractId: baseVariables.vmafReferenceContractId,
    vmafCanonicalDenoiseActive: true,
    vmafNvencTemporalPolicy: nvenc.CANONICAL_POLICY,
  },
  jobLog() {},
});
assert.strictEqual(priorWrapperResult.outputNumber, 1,
  'the explicitly opted-in early adapter must consume frozen prior AV1 terminal evidence');
assert.strictEqual(priorWrapperResult.variables.vmafHevcFallbackAv1Evidence.evidence_source,
  'manifest_bound_prior_terminal');
assert.strictEqual(priorWrapperResult.variables.vmafHevcFallbackAv1Evidence.prior_sweep_point_count,
  entries[0].priorSweepPointCount);
assert.deepStrictEqual(priorWrapperResult.variables.vmafNextCQs, [18, 23, 28]);
const wrongManifestDigestResult = activationModule.plugin({
  inputs: {
    enabled: true, manifestPath, manifestFileSha256: '0'.repeat(64), manifestCanonicalSha256,
    expectedCohortSize: 30,
    initialCqs: '18,23,28', maxUniqueCqs: 8, maxRetries: 2,
  },
  inputFileObj: source,
  variables: { ...baseVariables },
  jobLog() {},
});
assert.strictEqual(wrongManifestDigestResult.outputNumber, 2,
  'the wrapper must fail closed when the physical manifest digest is not pinned exactly');
const wrongCanonicalDigestResult = activationModule.plugin({
  inputs: {
    enabled: true, manifestPath, manifestFileSha256, manifestCanonicalSha256: '0'.repeat(64),
    expectedCohortSize: 30, initialCqs: '18,23,28', maxUniqueCqs: 8, maxRetries: 2,
  },
  inputFileObj: source,
  variables: { ...baseVariables },
  jobLog() {},
});
assert.strictEqual(wrongCanonicalDigestResult.outputNumber, 2,
  'the wrapper must fail closed when the canonical manifest digest is not pinned exactly');
assert.strictEqual(activation.activationDecision({
  enabled: true,
  manifestPath,
  inputFileObj: h264File('/media/TV_D/not-selected.mkv'),
  variables: baseVariables,
}).activate, false, 'non-cohort files must remain on the original-retention path');
assert.strictEqual(activation.activationDecision({
  enabled: true,
  manifestPath,
  inputFileObj: { ...source, video_codec_name: 'hevc', ffProbeData: { streams: [{ codec_type: 'video', codec_name: 'hevc' }] } },
  variables: baseVariables,
}).activate, false, 'only H.264 originals may enter this canary');
assert.strictEqual(activation.activationDecision({
  enabled: true,
  manifestPath,
  inputFileObj: source,
  variables: { ...baseVariables, vmafBestParameters: { encoder: 'av1_nvenc' } },
}).activate, false, 'a successful AV1 selection must never enter HEVC fallback');
assert.strictEqual(activation.activationDecision({
  enabled: true,
  manifestPath,
  inputFileObj: source,
  variables: { ...baseVariables, vmafSelectionStatus: 'holdout_failed_no_validated_fallback' },
}).activate, false, 'technical holdout failure must not activate HEVC fallback');
assert.strictEqual(activation.activationDecision({
  enabled: true,
  manifestPath,
  inputFileObj: source,
  variables: { ...baseVariables, vmafAggregatedResults: [] },
}).activate, false, 'terminal activation requires measured AV1 sweep evidence');

const activated = activation.activateState({ ...baseVariables }, decision.entry, {
  initialCqs: [18, 23, 28], maxUniqueCqs: 8, maxRetries: 2,
});
assert.strictEqual(activated.vmafCodecStage, 'hevc');
assert.strictEqual(activated.vmafGPUEncoder, 'hevc_nvenc');
assert.strictEqual(activated.vmafNvencTemporalPolicy, nvenc.CANONICAL_POLICY,
  'HEVC fallback must preserve the authenticated reference-domain temporal policy');
assert.strictEqual(activated.vmafReferenceContractId, baseVariables.vmafReferenceContractId);
assert.strictEqual(activated.vmafCanonicalDenoiseActive, true);
assert.deepStrictEqual(activated.vmafNextCQs, [18, 23, 28]);
assert.deepStrictEqual(activated.vmafTestedCQs, []);
assert.deepStrictEqual(activated.vmafTestResults, []);
assert.strictEqual(activated.vmafRetryCount, 0);
assert.strictEqual(activated.vmafMaxRetries, 2);
assert.strictEqual(activated.vmafSweepRetriesExhausted, false);
assert.strictEqual(activated.vmafTranscodeGaveUp, false);
assert.strictEqual(Object.hasOwn(activated, 'vmafAv1TerminalAuthenticated'), false);
assert.strictEqual(Object.hasOwn(activated, 'vmafSelectionStatus'), false,
  'AV1 selection status must not leak into the fresh HEVC search');
assert.strictEqual(activated.vmafHevcFallbackAv1Evidence.tested_cqs.length, 4);
assert.strictEqual(activated.vmafHevcFallbackAv1Evidence.terminal_reason, 'no_feasible_parameters');
assert.notStrictEqual(activated.vmafEncoderProfileId, baseVariables.vmafEncoderProfileId);

assert.deepStrictEqual(samples.capCodecCqs([18.5], [18, 19], 'av1', 8), [18.5]);
const hevcGrid = bracket.resolveActiveCQGrid(
  [{ parameterSet: { encoder: 'hevc_nvenc' } }],
  { vmafGPUEncoder: 'hevc_nvenc' }, false);
assert.strictEqual(hevcGrid.cqStep, 0.1);
assert.strictEqual(hevcGrid.integerGrid, false);
const representativeHevcMidpoint = Number(((18 + 23) / 2).toFixed(1));
assert.strictEqual(representativeHevcMidpoint, 20.5);
assert.deepStrictEqual(samples.capCodecCqs(
  [representativeHevcMidpoint], [18, 23], 'hevc', 8), [20.5],
'HEVC active refinement must preserve a valid 0.1-grid midpoint');
assert.deepStrictEqual(samples.capCodecCqs([20.55], [18, 23], 'hevc', 8), [],
  'off-grid HEVC CQs must fail validation');
assert.strictEqual(samples.shouldUseConfiguredFallback([], true), false,
  'an empty guided refinement must never fall back to the configured full sweep');
assert.strictEqual(samples.shouldUseConfiguredFallback([], false), true);
assert.strictEqual(samples.shouldRetryTransientNvencSampleFailure({
  ok: false,
  error: 'ffmpeg exited with code 218',
  stderrTail: '[hevc_nvenc] OpenEncodeSessionEx failed: unsupported device (2): no details',
}, 1), true, 'the first exact unsupported-device failure should receive one bounded retry');
assert.strictEqual(samples.shouldRetryTransientNvencSampleFailure({
  ok: false,
  error: 'ffmpeg exited with code 218',
  stderrTail: '[hevc_nvenc] No capable devices found',
}, 1), true, 'the first exact no-capable-device failure should receive one bounded retry');
assert.strictEqual(samples.shouldRetryTransientNvencSampleFailure({
  ok: false,
  error: 'ffmpeg exited with code 244',
  stderrTail: '[hevc_nvenc] Failed locking bitstream buffer: out of memory (10)',
}, 1), true, 'the first exact NVENC bitstream-buffer exhaustion should receive one bounded retry');
assert.strictEqual(samples.shouldRetryTransientNvencSampleFailure({
  ok: false,
  error: 'ffmpeg exited with code 244',
  stderrTail: '[hevc_nvenc] Failed locking bitstream buffer: out of memory (10)',
}, 2), false, 'a second bitstream-buffer exhaustion must remain terminal for that sample');
assert.strictEqual(samples.shouldRetryTransientNvencSampleFailure({
  ok: false,
  timedOut: true,
  error: 'sample encode timed out after 600s',
  stderrTail: '[hevc_nvenc] Failed locking bitstream buffer: out of memory (10)',
}, 1), false, 'a hard timeout must settle as failure rather than enter the transient retry path');
{
  const settlements = [];
  samples.settleTimedOutSampleAttempt({
    kill() { throw new Error('simulated child that cannot be killed'); },
  }, (result) => settlements.push(result), {
    error: 'sample encode timed out after 600s',
  });
  assert.strictEqual(settlements.length, 1,
    'a timeout must settle immediately even when SIGKILL throws and no close event arrives');
  assert.strictEqual(settlements[0].ok, false);
  assert.strictEqual(settlements[0].timedOut, true);
}
assert.strictEqual(samples.shouldRetryTransientNvencSampleFailure({
  ok: false,
  error: 'ffmpeg exited with code 218',
  stderrTail: '[hevc_nvenc] OpenEncodeSessionEx failed: unsupported device (2): no details',
}, 2), false, 'a second NVENC device-init failure must remain terminal for that sample');
assert.strictEqual(samples.shouldRetryTransientNvencSampleFailure({
  ok: false,
  error: 'ffmpeg exited with code 218',
  stderrTail: 'unrelated decode failure',
}, 1), false, 'exit code 218 alone must not trigger the device-init retry');
const renderedNvencTail = samples.formatDiagnosticTail(
  `ffmpeg banner ${'.'.repeat(1100)} No capable devices found`, 1000);
assert.strictEqual(renderedNvencTail.length, 1000);
assert.ok(renderedNvencTail.endsWith('No capable devices found'));
assert.ok(!renderedNvencTail.startsWith('ffmpeg banner'),
  'failure reporting must preserve the actionable stderr tail rather than the banner');
assert.deepStrictEqual(samples.capCodecCqs([18, 23, 28], [], 'hevc', 8), [18, 23, 28]);
assert.deepStrictEqual(samples.capCodecCqs([16, 17, 18], [18, 20, 22, 24, 26, 28], 'hevc', 8), [16, 17]);
assert.deepStrictEqual(samples.capCodecCqs([16], [18, 20, 22, 24, 26, 28, 30, 32], 'hevc', 8), []);
assert.strictEqual(retry.hevcBudgetExhausted({
  vmafCodecStage: 'hevc', vmafTestedCQs: [18, 20, 22, 24, 26, 28, 30, 32], vmafHevcMaxUniqueCQs: 8,
}), true);
assert.strictEqual(retry.hevcBudgetExhausted({
  vmafCodecStage: 'hevc',
  vmafTestedCQs: [18, 20.5, 21.8, 22.4, 22.7, 22.9, 23, 28],
  vmafHevcMaxUniqueCQs: 8,
}), true, 'HEVC terminal budget accounting must count valid fractional 0.1-grid CQs');
assert.strictEqual(retry.hevcBudgetExhausted({
  vmafCodecStage: 'hevc',
  vmafTestedCQs: [18, '20.50', 20.5, 20.55, NaN, 23, 28],
  vmafHevcMaxUniqueCQs: 5,
}), false, 'HEVC terminal budget accounting must normalize duplicates and reject off-grid/non-finite CQs');
const davidHevcCqsAtCap = [18, 23, 28, 25.5, 24.3, 23.7, 23.4, 23.6];
assert.strictEqual(bracket.hevcUniqueCqBudgetState({
  vmafCodecStage: 'hevc', vmafTestedCQs: davidHevcCqsAtCap,
  vmafHevcMaxUniqueCQs: 8,
}, davidHevcCqsAtCap).exhausted, true,
'upstream bracket refinement must stop at the exact eight-CQ HEVC cap');
assert.strictEqual(bracket.hevcUniqueCqBudgetState({
  vmafCodecStage: 'hevc', vmafTestedCQs: davidHevcCqsAtCap.slice(0, 7),
  vmafHevcMaxUniqueCQs: 8,
}, davidHevcCqsAtCap.slice(0, 7)).exhausted, false,
'upstream bracket refinement must still permit the eighth unique HEVC CQ');
assert.strictEqual(bracket.hevcUniqueCqBudgetState({
  vmafCodecStage: 'av1', vmafTestedCQs: davidHevcCqsAtCap,
  vmafHevcMaxUniqueCQs: 8,
}, davidHevcCqsAtCap).applies, false,
'HEVC cap logic must not alter normal AV1 refinement');
const davidBudgetLogs = [];
const davidBudgetRows = davidHevcCqsAtCap.map((cq) => {
  const feasible = cq <= 23.4;
  return {
    parameterSet: { quality: cq, encoder: 'hevc_nvenc', preset: 'p7' },
    avgVMAF: feasible ? 97 : 94,
    avgVMAFMean: feasible ? 97 : 94,
    vmafP1Low: 90,
    p95CAMBI: 0.5,
    avgSSIM: 99,
    minXPSNR: 42,
    ssimulacra2: 90,
    ssimulacra2P5: 88,
    butteraugliNormInf: 1,
    cvvdp: 9.9,
    measurementSubsample: 1,
  };
});
const davidBudgetRoute = bracket.plugin({
  inputs: { targetVMAF: '95' },
  variables: {
    vmafCodecStage: 'hevc',
    vmafGPUEncoder: 'hevc_nvenc',
    vmafHevcMaxUniqueCQs: 8,
    vmafTestedCQs: davidHevcCqsAtCap,
    vmafAggregatedResults: davidBudgetRows,
    vmafProgressiveExpansion: { enabled: true, cqMin: 16, cqMax: 50, step: 2 },
    vmafActiveBoundary: true,
    vmafActiveCQStep: 0.1,
    vmafActiveStopGap: 0.1,
    vmafMinFrameVMAF: 84.8,
    vmafSourceCAMBI: 5,
    vmafSourceCAMBIP95: 12,
  },
  inputFileObj: h264File('/media/Movies_D/David (2025)/David.mkv'),
  jobLog(line) { davidBudgetLogs.push(String(line)); },
});
assert.strictEqual(davidBudgetRoute.outputNumber, 1,
'at eight unique HEVC CQs, bracket refinement must proceed to selection');
assert.strictEqual(Object.hasOwn(davidBudgetRoute.variables, 'vmafNextCQs'), false,
'at the HEVC CQ cap, the bracket plugin must not propose a ninth CQ');
assert(davidBudgetLogs.some((line) => /HEVC CQ evaluation budget reached \(8\/8\)/.test(line)),
  'HEVC cap terminalization must be explicit in the job report');
const davidSevenCqs = davidHevcCqsAtCap.slice(0, 7);
const davidSevenRoute = bracket.plugin({
  inputs: { targetVMAF: '95' },
  variables: {
    vmafCodecStage: 'hevc',
    vmafGPUEncoder: 'hevc_nvenc',
    vmafHevcMaxUniqueCQs: 8,
    vmafTestedCQs: davidSevenCqs,
    vmafAggregatedResults: davidBudgetRows.slice(0, 7),
    vmafProgressiveExpansion: { enabled: true, cqMin: 16, cqMax: 50, step: 2 },
    vmafActiveBoundary: true,
    vmafActiveCQStep: 0.1,
    vmafActiveStopGap: 0.1,
    vmafSourceGrain: 0,
    vmafSourceCAMBI: 5,
    vmafSourceCAMBIP95: 12,
  },
  inputFileObj: h264File('/media/Movies_D/David (2025)/David.mkv'),
  jobLog() {},
});
assert.strictEqual(davidSevenRoute.outputNumber, 2,
  'at seven unique HEVC CQs, the real bracket route must permit the eighth measurement');
assert.deepStrictEqual(davidSevenRoute.variables.vmafNextCQs, [23.6],
  'the real HEVC 7/8 route must schedule only the finite 0.1-grid boundary midpoint');
const davidAv1Route = bracket.plugin({
  inputs: { targetVMAF: '95' },
  variables: {
    vmafCodecStage: 'av1',
    vmafGPUEncoder: 'av1_nvenc',
    vmafHevcMaxUniqueCQs: 8,
    vmafTestedCQs: davidHevcCqsAtCap,
    vmafAggregatedResults: davidBudgetRows,
    vmafProgressiveExpansion: { enabled: true, cqMin: 16, cqMax: 50, step: 2 },
    vmafActiveBoundary: true,
    vmafActiveCQStep: 0.1,
    vmafActiveStopGap: 0.1,
    vmafSourceGrain: 0,
    vmafSourceCAMBI: 5,
    vmafSourceCAMBIP95: 12,
  },
  inputFileObj: h264File('/media/Movies_D/David (2025)/David.mkv'),
  jobLog() {},
});
assert.strictEqual(davidAv1Route.outputNumber, 2,
  'HEVC CQ budget logic must not terminalize the real AV1 bracket route');
assert.deepStrictEqual(davidAv1Route.variables.vmafNextCQs, [23.5],
  'the real AV1 route must retain its existing 0.1-grid midpoint behavior');
assert.strictEqual(retry.resolveRetryLimit({ vmafCodecStage: 'hevc', vmafHevcMaxRetries: 2 }, 4), 2);
assert.strictEqual(retry.resolveRetryLimit({ vmafCodecStage: 'av1', vmafHevcMaxRetries: 2 }, 4), 4);

const hevcSampleArgs = samples.buildSampleEncodeArgs({
  encoder: 'hevc_nvenc', isGPU: true, pixFmt: 'p010le', quality: 23, preset: 'p7',
}, '/work/sample.mkv', '/work/sample-hevc.mkv',
nvenc.ENHANCED_QUALITY_FLAGS_CANONICAL,
{ canonicalInput: true, temporalPolicy: nvenc.CANONICAL_POLICY });
assert(hevcSampleArgs.includes('hevc_nvenc'));
assert(hevcSampleArgs.includes('-cq') && hevcSampleArgs.includes('23'));
assert(hevcSampleArgs.includes('-profile:v') && hevcSampleArgs.includes('main10'));
assert.strictEqual(hevcSampleArgs.includes('av1_metadata'), false);
assert.doesNotThrow(() => nvenc.assertNvencCommand(
  hevcSampleArgs, nvenc.CANONICAL_POLICY, 'HEVC sample contract'));
const hevcRefinementArgs = samples.buildSampleEncodeArgs({
  encoder: 'hevc_nvenc', isGPU: true, pixFmt: 'p010le', quality: representativeHevcMidpoint, preset: 'p7',
}, '/work/sample.mkv', '/work/sample-hevc-refinement.mkv',
nvenc.ENHANCED_QUALITY_FLAGS_CANONICAL,
{ canonicalInput: true, temporalPolicy: nvenc.CANONICAL_POLICY });
const hevcRefinementCqIndex = hevcRefinementArgs.indexOf('-cq');
assert(hevcRefinementCqIndex >= 0);
assert.strictEqual(hevcRefinementArgs[hevcRefinementCqIndex + 1], '20.5',
  'HEVC fractional midpoint must reach FFmpeg unchanged');

const hevcHoldoutArgs = select.buildHoldoutEncodeArgs({
  inputPath: '/work/holdout.mkv', outputPath: '/work/holdout-hevc.mkv',
  encoder: 'hevc_nvenc', pixFmt: 'p010le', cq: 23, preset: 'p7',
  canonicalInput: true, temporalPolicy: nvenc.CANONICAL_POLICY,
  nvencFlagArgs: nvenc.ENHANCED_QUALITY_FLAGS_CANONICAL,
  colorPrimaries: 'bt709', colorTrc: 'bt709', colorspace: 'bt709',
});
assert(hevcHoldoutArgs.includes('hevc_nvenc'));
assert(hevcHoldoutArgs.includes('-profile:v') && hevcHoldoutArgs.includes('main10'));
assert.strictEqual(hevcHoldoutArgs.some((value) => String(value).includes('av1_metadata')), false);

const hevcFinalArgs = transcode.buildFinalTranscodeArgs({
  bestParams: { encoder: 'hevc_nvenc', isGPU: true, preset: 'p7' },
  canonicalDenoise: false,
  temporalPolicy: nvenc.LEGACY_POLICY,
  nvencFlagArgs: nvenc.ENHANCED_QUALITY_FLAGS_LEGACY,
  originalFile: '/media/source.mkv', outputPath: '/work/final-hevc.mkv',
  pixFmt: 'p010le', useCQ: 23,
  colorPrimaries: 'bt709', colorTrc: 'bt709', colorspace: 'bt709',
  ffProbeData: { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } }] },
  requireStreamInventory: true, matroskaVideoOnly: true,
});
assert(hevcFinalArgs.includes('hevc_nvenc'));
assert(hevcFinalArgs.includes('-profile:v') && hevcFinalArgs.includes('main10'));
assert.strictEqual(hevcFinalArgs.some((value) => String(value).includes('av1_metadata')), false);

assert.strictEqual(select.decoderForEncoder('hevc_nvenc'), 'hevc_cuvid');
assert.strictEqual(select.decoderForEncoder('av1_nvenc'), 'av1_cuvid');
assert.strictEqual(transcode.expectedCodecForEncoder('hevc_nvenc'), 'hevc');
assert.strictEqual(transcode.expectedCodecForEncoder('av1_nvenc'), 'av1');
assert.strictEqual(transcode.shouldUseDirectNvenccFinal('hevc_nvenc', '1'), false,
  'HEVC canonical-denoise final jobs must use the codec-aware coordinator/FFmpeg path');
assert.strictEqual(transcode.shouldUseDirectNvenccFinal('av1_nvenc', '1'), true);
assert.strictEqual(transcode.shouldUseDirectNvenccFinal('av1_nvenc', '0'), false);
assert.strictEqual(/\boptions\./.test(transcode.buildRetainedRecoveryPlan.toString()), false,
  'retained AV1 recovery must not reference an undeclared options object');
assert.strictEqual(grain.shouldBypassFilmGrainForCodec({ vmafCodecStage: 'hevc', vmafGPUEncoder: 'hevc_nvenc' }), true);
assert.strictEqual(grain.shouldBypassFilmGrainForCodec({ vmafCodecStage: 'av1', vmafGPUEncoder: 'av1_nvenc' }), false);

const flow = JSON.parse(fs.readFileSync(path.join(root, 'configs', 'flow_YR5PZ1QaD_HEVC_CANARY.json'), 'utf8'));
assert.notStrictEqual(path.resolve(cohortFixture.FIXTURE_PATH),
  path.join(root, 'configs', 'hevc-fallback-canary', 'cohort.json'),
  'the review fixture must never replace the production cohort manifest');
const generatedManifest = activation.readManifest(manifestPath);
assert.strictEqual(generatedManifest.entries.length, 30,
  'the synthetic fixture builder output must satisfy the runtime manifest contract');
const installer = fs.readFileSync(path.join(root, 'custom-cont-init.d', '96-apply-vmaf-plugin-patches.sh'), 'utf8');
assert(installer.includes("apply_patch_file 'activateHevcFallback/1.0.0'"),
  'release init must install the adapter in both server and node plugin catalogs');
const nodes = new Map(flow.flowPlugins.map((n) => [n.id, n]));
assert(nodes.has('activateHevcFallback1'));
assert.strictEqual(nodes.get('activateHevcFallback1').sourceRepo, 'Local');
assert.strictEqual(nodes.get('activateHevcFallback1').pluginName, 'activateHevcFallback');
const edges = flow.flowEdges;
assert(edges.some((e) => e.source === 'retry1' && e.sourceHandle === '2' && e.target === 'activateHevcFallback1'));
assert(edges.some((e) => e.source === 'activateHevcFallback1' && e.sourceHandle === '1' && e.target === 'gpuLockAcquire1'));
assert(edges.some((e) => e.source === 'activateHevcFallback1' && e.sourceHandle === '2' && e.target === 'learn1'));
assert.strictEqual(edges.some((e) => e.source === 'retry1' && e.sourceHandle === '2' && e.target === 'learn1'), false,
  'terminal AV1 must be consumed by the adapter before normal retention');
assert(edges.some((e) => e.source === 'meta1' && e.sourceHandle === '1' && e.target === 'extract1'),
  'fresh sample extraction must run before the manifest-prior HEVC adapter');
assert(edges.some((e) => e.source === 'extract1' && e.sourceHandle === '1' && e.target === 'activateHevcPrior1'),
  'the prior adapter must establish HEVC seeds after the new-file reset');
assert(edges.some((e) => e.source === 'activateHevcPrior1' && e.sourceHandle === '1' && e.target === 'gpuLockAcquire1'));
assert(edges.some((e) => e.source === 'activateHevcPrior1' && e.sourceHandle === '2' && e.target === 'gpuLockAcquire1'));
assert.strictEqual(edges.some((e) => e.source === 'meta1' && e.target === 'activateHevcPrior1'), false,
  'the prior adapter must never run before extractVideoSamples clears vmafNextCQs');
assert.strictEqual(edges.some((e) => e.source === 'activateHevcPrior1' && e.target === 'extract1'), false,
  'an activated HEVC seed handoff must never cross the new-file reset');

nonJsonMutationReadback.then((saved) => {
  assert.strictEqual(saved.TranscodeDecisionMaker, 'Queued',
    'empty/non-JSON successful mutation bodies require exact authoritative readback');
  fs.rmSync(tmp, { recursive: true, force: true });
  Module._load = originalLoad;
  console.log('PASS temporary H.264 retained-original HEVC fallback contract');
}).catch((error) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
