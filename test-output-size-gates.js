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
const path = require('path');

const selectorPath = path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js');
const { evaluateSizeGate } = require(selectorPath)._test;

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

assert.ok(!/QUALITY ADVISORY: Final output is larger than source/.test(transcodeSrc),
  'the advisory-and-keep branch must be gone');
assert.ok(/refusing the encode and preserving the original/.test(transcodeSrc),
  'an oversized output must be refused with the original preserved');
assert.ok(/vmafTranscodeStatus = 'size_failed'/.test(transcodeSrc),
  "must use the exact status monitorTranscodeRetry consumes ('size_failed')");
assert.ok(/vmafTranscodeSucceeded = false/.test(transcodeSrc));
assert.ok(/vmafMaxFinalOutputRatioPct/.test(transcodeSrc),
  'the cap must be overridable rather than hard-coded');

// The rejection must not re-disable the live monitor the way the old code did.
const rejectionBlock = transcodeSrc.slice(
  transcodeSrc.indexOf('AUTHORITATIVE POST-ENCODE SIZE GATE'),
  transcodeSrc.indexOf('// Apply HDR color metadata'));
assert.ok(rejectionBlock.length > 0, 'expected to locate the post-encode gate block');
assert.ok(/liveSizeCompare\.error = true/.test(rejectionBlock),
  'an oversized output must surface as a live-size-compare error, not be cleared');

// monitorTranscodeRetry must actually treat that state as a size cancellation.
const monitorSrc = fs.readFileSync(path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/monitorTranscodeRetry/1.0.0/index.js'), 'utf8');
assert.ok(/transcodeStatus === 'size_failed'/.test(monitorSrc),
  'monitor must recognise the size_failed status the transcode now emits');

// ---------------------------------------------------------------- gap 3 -----
// Grain output must be judged against the ORIGINAL library file, not its input.
const grainSrc = fs.readFileSync(path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js'), 'utf8');

assert.ok(/function assessGrainOutputAgainstOriginal/.test(grainSrc));
const grainCalls = grainSrc.match(/assessGrainOutputAgainstOriginal\(\s*\n?\s*sourcePath,/g) || [];
assert.strictEqual(grainCalls.length, 2,
  'both the staged and direct grain validation paths must gate against the original');
assert.ok(/grain_output_not_smaller_than_original/.test(grainSrc));

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
