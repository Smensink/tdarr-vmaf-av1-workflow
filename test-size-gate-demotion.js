'use strict';

// Regression contract for the 2026-07-20 size-gate demotion:
// - the retired >=90% projection cap must not hard-reject on its own while forced-full
//   budget remains (shadow band),
// - the emergency cutoff (default 110%) must always hard-reject,
// - budget exhaustion must restore the legacy hard gate,
// - the forced-full counter must only count forced_full_selected events.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const selector = require('./custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js');
const { evaluateSizeGate, countForcedFullSelections } = selector._test;

assert.strictEqual(typeof evaluateSizeGate, 'function');
assert.strictEqual(typeof countForcedFullSelections, 'function');

// Below the legacy cap: always allowed, no shadow flag.
let d = evaluateSizeGate(60, { forcedFullRemaining: 5 });
assert.deepStrictEqual([d.action, d.band, d.forcedFull, d.legacyWouldReject], ['allow', 'clear', false, false]);
d = evaluateSizeGate(89.9, { forcedFullRemaining: 0 });
assert.strictEqual(d.action, 'allow');

// Shadow band with budget: allowed, marked forced-full, legacy would have rejected.
d = evaluateSizeGate(90.0, { forcedFullRemaining: 3 });
assert.deepStrictEqual([d.action, d.band, d.forcedFull, d.legacyWouldReject], ['allow', 'shadow', true, true]);
d = evaluateSizeGate(109.9, { forcedFullRemaining: 1 });
assert.strictEqual(d.action, 'allow');
assert.strictEqual(d.band, 'shadow');

// Shadow band with exhausted budget: legacy hard gate resumes.
d = evaluateSizeGate(95, { forcedFullRemaining: 0 });
assert.deepStrictEqual([d.action, d.band], ['reject', 'shadow_budget_exhausted']);

// Emergency cutoff: always a hard reject, budget irrelevant.
d = evaluateSizeGate(110.0, { forcedFullRemaining: 10 });
assert.deepStrictEqual([d.action, d.band], ['reject', 'emergency']);
d = evaluateSizeGate(289.5, { forcedFullRemaining: 10 });
assert.strictEqual(d.action, 'reject');
// Nino 2026-07-18: best quality-passing CQ projected 120.8% — must stay rejected.
d = evaluateSizeGate(120.8, { forcedFullRemaining: 10 });
assert.deepStrictEqual([d.action, d.band], ['reject', 'emergency']);

// Custom thresholds and degenerate configs.
d = evaluateSizeGate(120, { legacyRatioPct: 90, emergencyRatioPct: 130, forcedFullRemaining: 1 });
assert.strictEqual(d.action, 'allow');
d = evaluateSizeGate(120, { legacyRatioPct: 90, emergencyRatioPct: 80, forcedFullRemaining: 1 });
assert.strictEqual(d.band, 'emergency', 'emergency <= legacy must fall back to max(110, legacy)');
d = evaluateSizeGate(NaN, { forcedFullRemaining: 1 });
assert.deepStrictEqual([d.action, d.band], ['allow', 'unknown']);
d = evaluateSizeGate(0, { forcedFullRemaining: 1 });
assert.strictEqual(d.band, 'unknown');

// Forced-full counter: counts only forced_full_selected, tolerates junk and missing files.
const tmp = path.join(os.tmpdir(), `size-gate-test-${process.pid}.jsonl`);
fs.writeFileSync(tmp, [
  JSON.stringify({ event: 'forced_full_selected', job_id: 'a' }),
  JSON.stringify({ event: 'decision', job_id: 'b' }),
  'not-json',
  JSON.stringify({ event: 'forced_full_selected', job_id: 'c' }),
  '',
].join('\n'), 'utf8');
assert.strictEqual(countForcedFullSelections(tmp), 2);
fs.unlinkSync(tmp);
assert.strictEqual(countForcedFullSelections(tmp), 0, 'missing file must count as zero used budget');

// Source contracts: the selector must not contain an unconditional legacy hard reject,
// and must wire the shadow/forced-full plumbing.
const selectorSource = fs.readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js', 'utf8');
assert.ok(!selectorSource.includes('insufficient size benefit to justify a lossy re-encode'),
  'legacy unconditional max-ratio reject must be gone');
assert.ok(selectorSource.includes('vmafSizeGateEmergencyRatioPct'));
assert.ok(selectorSource.includes('vmafSizeGateForcedFullCap'));
assert.ok(selectorSource.includes("event: 'forced_full_selected'"));
assert.ok(selectorSource.includes('vmafSizeGateForcedFull = true'));
assert.ok(selectorSource.includes('SIZE-GATE SHADOW'));
// The shared quality-risk size evaluation must no longer carry the max-ratio hard cap.
const sharedSizeBlock = selectorSource.split('var sharedSizeEvaluation')[1].split(';')[0];
assert.ok(!sharedSizeBlock.includes('maxOutputRatioPct'),
  'sharedSizeEvaluation must not hard-gate on maxOutputRatioPct');

console.log('PASS size-gate demotion contract (evaluateSizeGate, forced-full budget, source wiring)');
