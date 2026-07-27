'use strict';

// Regression contract for the 2026-07-20 CQ16 boundary-seed promotion:
// - round-1 CQ16 seeding fires only on first-attempt unguided sweeps with a same-title
//   boundary-first hint, respecting the kill switch and duplicate protection,
// - the CQ16 quality-ceiling give-up rule fires only when every measured CQ<=16.5 point
//   hard-fails quality by >0.5 pt (monotonicity terminal), never on near-misses,
// - checkCQRangeRetry still recognises every generation of the selector's size-cap
//   rejection wording (cross-plugin string contract).

const assert = require('assert');
const fs = require('fs');

const encoding = require('./custom-cont-init.d/vmaf-plugin-patches/testEncodingParameters/1.0.0/index.js');
const retry = require('./custom-cont-init.d/vmaf-plugin-patches/checkCQRangeRetry/1.0.0/index.js');

const { shouldSeedBoundaryCq16 } = encoding._test;
const { cq16QualityCeilingTerminal } = retry._test;

// ── Seeding decision ──
const hintYes = { recommendBoundaryFirst: true, priorNoFeasible: 2 };
const base = { isRetry: false, guidedCount: 0, crfValues: [26, 30, 34], testedCQs: [26, 30, 34], hint: hintYes };

assert.strictEqual(shouldSeedBoundaryCq16(base), true, 'hint + first attempt must seed');
assert.strictEqual(shouldSeedBoundaryCq16({ ...base, killSwitch: false }), false, 'kill switch must win');
assert.strictEqual(shouldSeedBoundaryCq16({ ...base, isRetry: true }), false, 'retry rounds must not seed');
assert.strictEqual(shouldSeedBoundaryCq16({ ...base, guidedCount: 2 }), false, 'guided rounds must not seed');
assert.strictEqual(shouldSeedBoundaryCq16({ ...base, hint: { recommendBoundaryFirst: false } }), false);
assert.strictEqual(shouldSeedBoundaryCq16({ ...base, hint: null }), false, 'no hint object → no seed');
assert.strictEqual(shouldSeedBoundaryCq16({ ...base, crfValues: [16, 26, 30] }), false, 'CQ16 already scheduled');
assert.strictEqual(shouldSeedBoundaryCq16({ ...base, testedCQs: [16, 26] }), false, 'CQ16 already tested');
assert.strictEqual(shouldSeedBoundaryCq16({ ...base, crfValues: [] }), false, 'empty sweep must not seed');

// ── CQ16 give-up terminal ──
function pt(cq, vmaf, p1) { return { parameterSet: { quality: cq }, avgVMAF: vmaf, vmafP1Low: p1 }; }

// Clear hard fail at CQ16: terminal.
let t = cq16QualityCeilingTerminal([pt(16, 93.1, 82.0), pt(24, 90.2, 78.1)], 95, 85.5);
assert.ok(t, 'hard fail at CQ16 must be terminal');
assert.strictEqual(t.cq, 16);

// Near-miss inside the 0.5 margin: NOT terminal (cross-attempt noise protection).
assert.strictEqual(cq16QualityCeilingTerminal([pt(16, 94.6, 86.0)], 95, 85.5), null,
  'VMAF within 0.5 of target must not trigger give-up');
assert.strictEqual(cq16QualityCeilingTerminal([pt(16, 96.0, 85.1)], 95, 85.5), null,
  '1%-low within 0.5 of floor must not trigger give-up');

// 1%-low hard fail alone is terminal even when harmonic passes.
t = cq16QualityCeilingTerminal([pt(16, 96.2, 84.9)], 95, 85.5);
assert.ok(t, '1%-low failing by >0.5 at CQ16 is terminal');

// Frame floor disabled (0): only harmonic counts.
assert.strictEqual(cq16QualityCeilingTerminal([pt(16, 96.2, 10)], 95, 0), null);

// No CQ<=16.5 measured: never terminal.
assert.strictEqual(cq16QualityCeilingTerminal([pt(18, 80, 60)], 95, 85.5), null,
  'rule must only fire once the CQ16 ceiling is actually measured');

// Missing VMAF at 16 (unmeasured point object): ignored, not terminal.
assert.strictEqual(cq16QualityCeilingTerminal([pt(16, null, null)], 95, 85.5), null);

// Two <=16.5 points, one passing: not terminal (every() semantics).
assert.strictEqual(cq16QualityCeilingTerminal([pt(16, 93, 80), pt(16.5, 96, 88)], 95, 85.5), null);

// Fractional CQ 16.5 alone hard-failing: terminal.
assert.ok(cq16QualityCeilingTerminal([pt(16.5, 90, 70)], 95, 85.5));

// ── Cross-plugin reason-string contract ──
// 2026-07-21: the OR-of-.indexOf() match used to live inline in checkCQRangeRetry; it is now
// centralised in _lib/rejectionReasons.js (see test-rejection-reasons-migration.js for the
// dedicated old-vs-new behavioural regression). Assert the shared module still recognises
// every generation of the wording, AND that checkCQRangeRetry actually delegates to it
// instead of re-duplicating its own inline copy.
const retrySource = fs.readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/checkCQRangeRetry/1.0.0/index.js', 'utf8');
const selectorSource = fs.readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js', 'utf8');
const rejectionReasons = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/rejectionReasons.js');
for (const token of ['insufficient size benefit', 'emergency cutoff', 'legacy cap']) {
  assert.ok(rejectionReasons.isSizeTerminalReason(`some prefix ${token} some suffix`),
    `shared rejectionReasons helper must recognise '${token}'`);
}
assert.ok(retrySource.includes('rejectionReasons'), 'retry plugin must require the shared rejectionReasons module');
assert.ok(retrySource.includes('isSizeTerminalReason'), 'retry plugin must delegate to isSizeTerminalReason');
assert.ok(selectorSource.includes('emergency cutoff'), 'selector must emit the emergency-cutoff wording');
assert.ok(selectorSource.includes('legacy cap'), 'selector must emit the legacy-cap wording');

// Seed wiring + kill switches present.
const encodingSource = fs.readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/testEncodingParameters/1.0.0/index.js', 'utf8');
assert.ok(encodingSource.includes('vmafBoundarySeed'), 'seed kill switch missing');
assert.ok(encodingSource.includes('vmafBoundarySeedCQ16 = true'), 'seed marker missing');
assert.ok(encodingSource.includes("'target_vmaf_unreachable'"), 'hint v2 must count unreachable priors');
assert.ok(encodingSource.includes('hintVersion: 2'), 'hint version bump missing');
assert.ok(retrySource.includes('vmafCq16GiveUp'), 'give-up kill switch missing');
assert.ok(retrySource.includes('vmafCq16GiveUpFired'), 'give-up telemetry marker missing');

const monitorSource = fs.readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/monitorTranscodeRetry/1.0.0/index.js', 'utf8');
assert.ok(monitorSource.includes('boundarySeedApplied'), 'empty-band record must carry seed flag');
assert.ok(monitorSource.includes('cq16GiveUpFired'), 'empty-band record must carry give-up flag');

console.log('PASS CQ16 boundary-seed + quality-ceiling give-up contract');
