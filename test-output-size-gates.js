'use strict';

/**
 * Guards for the four size gates that were all failing open on 2026-07-27,
 * letting outputs LARGER than their sources replace and destroy the originals
 * (8 files, about 7.1 GB total avoidable growth, worst case 165%).
 *
 *   1. evaluateSizeGate treated a missing projection as indistinguishable from
 *      a clear one.
 *   2/4. vmafOptimizedTranscode computed the real output-vs-source ratio, logged
 *      "QUALITY ADVISORY: Final output is larger than source; keeping the
 *      technically complete output", kept it, and then set
 *      liveSizeCompare.error = false — neutering the live monitor as well.
 *   3. synthesizeFilmGrain measured its output against its own input, so grain
 *      inflation on top of an acceptable transcode was invisible.
 */

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const selectorPath = path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js');
const { evaluateSizeGate } = require(selectorPath)._test;
const transcodePath = path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js');
const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../FlowHelpers/1.0.0/cliUtils') {
    return { CLI: class MockCLI {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const {
  evaluateFinalOutputSizeGate,
  retireRejectedPostEncodeCheckpoint,
} = require(transcodePath)._test;
Module._load = originalLoad;

// ---------------------------------------------------------------- gap 1 -----
// A missing projection must stay distinguishable from a proven-clear one.
const unknown = evaluateSizeGate(null, { legacyRatioPct: 90, emergencyRatioPct: 110 });
assert.strictEqual(unknown.action, 'allow',
  'a missing projection cannot hard-reject: it would halt a large minority of the library');
assert.strictEqual(unknown.band, 'unknown');
assert.strictEqual(unknown.requiresActualSizeVerification, true,
  'an unproven size claim must be marked so the post-encode gate is the authority');

for (const missing of [null, undefined, NaN, 0, -5, 'abc']) {
  const g = evaluateSizeGate(missing, { legacyRatioPct: 90, emergencyRatioPct: 110 });
  assert.strictEqual(g.band, 'unknown', `projection ${String(missing)} must be 'unknown'`);
  assert.strictEqual(g.requiresActualSizeVerification, true);
}

// A genuinely clear projection must NOT carry the unproven marker.
const clear = evaluateSizeGate(55, { legacyRatioPct: 90, emergencyRatioPct: 110 });
assert.strictEqual(clear.band, 'clear');
assert.notStrictEqual(clear.requiresActualSizeVerification, true,
  'a measured clear projection must not be confused with an unverified one');

// The emergency cutoff still rejects.
assert.strictEqual(
  evaluateSizeGate(165.3, { legacyRatioPct: 90, emergencyRatioPct: 110 }).action, 'reject');

// ------------------------------------------------------------- gaps 2/4 -----
// The authoritative post-encode gate must fail closed, not advise.
const transcodeSrc = fs.readFileSync(path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js'), 'utf8');

for (const ratio of [103.03, 113.17, 114.02, 124.52, 165.34]) {
  const gate = evaluateFinalOutputSizeGate(ratio * 10000, 1000000, 80);
  assert.ok(Math.abs(gate.ratioPct - ratio) < 1e-9);
  assert.strictEqual(gate.rejected, true,
    `observed ${ratio}% oversized output must be rejected`);
}
assert.strictEqual(evaluateFinalOutputSizeGate(799999, 1000000, 80).rejected, false);
assert.strictEqual(evaluateFinalOutputSizeGate(800000, 1000000, 80).rejected, false,
  'an exact 20% reduction meets the minimum and must be accepted');
assert.strictEqual(evaluateFinalOutputSizeGate(800001, 1000000, 80).rejected, true,
  'an output above the 80% delivered cap must preserve the original');
assert.throws(() => evaluateFinalOutputSizeGate(800000, 1000000, 90),
  /must equal the current policy value 80/,
  'the post-encode gate must reject a non-current cap even when the output would fit it');
assert.throws(() => evaluateFinalOutputSizeGate(100, 0, 80), /source byte count/,
  'unknown source size must fail closed');

const checkpointRecord = {
  schema: 1,
  contract_id: 'vmaf-postencode-checkpoint-v1',
  checkpoint_key: 'a'.repeat(64),
  encode_contract_sha256: 'b'.repeat(64),
  artifact_path: '/temp/checkpoint/oversized.mkv',
  manifest_path: '/temp/checkpoint/manifest.json',
  reused: false,
};
let retiredRecord = null;
const retirementVariables = {
  vmafPostEncodeCheckpoint: checkpointRecord,
  vmafPostEncodeCheckpointPath: checkpointRecord.artifact_path,
  vmafPostEncodeCheckpointManifestPath: checkpointRecord.manifest_path,
};
const retired = retireRejectedPostEncodeCheckpoint(
  retirementVariables,
  { retire(record) { retiredRecord = record; } },
  () => {},
  () => '2026-07-27T00:00:00.000Z'
);
assert.strictEqual(retired.retired, true);
assert.strictEqual(retiredRecord, checkpointRecord,
  'retirement must receive the exact authenticated checkpoint record');
assert.strictEqual(retirementVariables.vmafPostEncodeCheckpoint, undefined,
  'a retired oversized generation must not remain available for retry reuse');
assert.strictEqual(retirementVariables.vmafPostEncodeCheckpointPath, undefined);
assert.strictEqual(retirementVariables.vmafPostEncodeCheckpointManifestPath, undefined);
assert.strictEqual(retirementVariables.vmafPostEncodeCheckpointStatus, 'retired_size_rejected');
assert.strictEqual(retirementVariables.vmafRejectedPostEncodeCheckpointAudit.checkpoint_key,
  checkpointRecord.checkpoint_key);
assert.ok(!('artifact_path' in retirementVariables.vmafRejectedPostEncodeCheckpointAudit),
  'the retirement tombstone must not expose or retain a reusable artifact path');

const retainedRecord = { ...checkpointRecord, checkpoint_key: 'c'.repeat(64) };
const retirementFailureVariables = {
  vmafPostEncodeCheckpoint: retainedRecord,
  vmafTranscodeSucceeded: false,
  vmafTranscodeStatus: 'size_failed',
};
const notRetired = retireRejectedPostEncodeCheckpoint(
  retirementFailureVariables,
  { retire() { throw new Error('simulated storage error'); } },
  () => {}
);
assert.strictEqual(notRetired.retired, false);
assert.strictEqual(notRetired.retained, true);
assert.strictEqual(retirementFailureVariables.vmafPostEncodeCheckpoint, retainedRecord,
  'failed retirement must retain the authenticated record for later cleanup');
assert.strictEqual(retirementFailureVariables.vmafTranscodeSucceeded, false,
  'retirement failure must never convert size rejection into replacement permission');
assert.strictEqual(retirementFailureVariables.vmafTranscodeStatus, 'size_failed');
assert.strictEqual(
  retirementFailureVariables.vmafPostEncodeCheckpointStatus,
  'retirement_failed_size_rejected'
);

assert.ok(!/QUALITY ADVISORY: Final output is larger than source/.test(transcodeSrc),
  'the advisory-and-keep branch must be gone');
assert.ok(/refusing the encode and preserving the original/.test(transcodeSrc),
  'an oversized output must be refused with the original preserved');
assert.ok(/vmafTranscodeStatus = 'size_failed'/.test(transcodeSrc),
  "must use the exact status monitorTranscodeRetry consumes ('size_failed')");
assert.ok(/vmafTranscodeSucceeded = false/.test(transcodeSrc));
assert.ok(/deliveryPolicy\.resolve\(args\.variables\)/.test(transcodeSrc),
  'the transcode must consume the single versioned delivery-size policy');

// The rejection must not re-disable the live monitor the way the old code did.
const rejectionBlock = transcodeSrc.slice(
  transcodeSrc.indexOf('AUTHORITATIVE POST-ENCODE SIZE GATE'),
  transcodeSrc.indexOf('// Apply HDR color metadata'));
assert.ok(rejectionBlock.length > 0, 'expected to locate the post-encode gate block');
assert.ok(/liveSizeCompare\.error = true/.test(rejectionBlock),
  'an oversized output must surface as a live-size-compare error, not be cleared');
assert.ok(/retireRejectedPostEncodeCheckpoint\(/.test(rejectionBlock),
  'an exact authenticated oversized checkpoint must be retired before returning');

// monitorTranscodeRetry must actually treat that state as a size cancellation.
const monitorSrc = fs.readFileSync(path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/monitorTranscodeRetry/1.0.0/index.js'), 'utf8');
assert.ok(/transcodeStatus === 'size_failed'/.test(monitorSrc),
  'monitor must recognise the size_failed status the transcode now emits');

// ---------------------------------------------------------------- gap 3 -----
// Grain output must be judged against the ORIGINAL library file, not its input.
const grainSrc = fs.readFileSync(path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js'), 'utf8');
const grainTest = require(
  './custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js')._test;

assert.ok(/function assessGrainOutputAgainstOriginal/.test(grainSrc));
const grainCalls = grainSrc.match(/assessGrainOutputAgainstOriginal\(\s*\n?\s*sourcePath,/g) || [];
assert.strictEqual(grainCalls.length, 2,
  'both the staged and direct grain validation paths must gate against the original');
assert.ok(/grain_output_not_smaller_than_original/.test(grainSrc));
const grainSizeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-grain-size-boundary-'));
try {
  const original = path.join(grainSizeRoot, 'original.mkv');
  const exact = path.join(grainSizeRoot, 'exact.mkv');
  const over = path.join(grainSizeRoot, 'over.mkv');
  fs.writeFileSync(original, Buffer.alloc(1000));
  fs.writeFileSync(exact, Buffer.alloc(800));
  fs.writeFileSync(over, Buffer.alloc(801));
  assert.strictEqual(
    grainTest.assessGrainOutputAgainstOriginal(original, exact, 80),
    null,
    'grain output at exactly 80% must meet the 20% minimum reduction',
  );
  assert.strictEqual(
    grainTest.assessGrainOutputAgainstOriginal(original, over, 80).outputBytes,
    801,
  );
  assert.strictEqual(grainTest.grainOriginalRatioCap({ variables: {} }), 80);
} finally {
  fs.rmSync(grainSizeRoot, { recursive: true, force: true });
}

// Every rename-to-validated must be preceded by the original-size gate, so a
// grained file can never be published without being checked.
const renameCount = (grainSrc.match(/fs\.renameSync\(finalPartialPath, validatedOutputPath\)/g) || []).length;
assert.strictEqual(renameCount, 2, 'expected exactly two publish points');
for (const m of grainSrc.matchAll(/fs\.renameSync\(finalPartialPath, validatedOutputPath\)/g)) {
  const preceding = grainSrc.slice(Math.max(0, m.index - 1400), m.index);
  assert.ok(/assessGrainOutputAgainstOriginal\(/.test(preceding),
    'each grain publish must be gated against the original library file');
}

// The per-stage efficiency advisory is a different signal and must survive.
assert.ok(/output-size-efficiency/.test(grainSrc),
  'the grain-cost advisory against its own input is still wanted');

console.log('PASS output size gates fail closed (projection, post-encode, grain-vs-original)');
