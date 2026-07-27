'use strict';

/**
 * Regression guard: a terminal VMAF/frame-floor miss must NOT commit an encode.
 *
 * History. `chooseMeasuredToleranceFallback` used to end with a
 * `terminal_best_quality` branch that sorted the measured candidates by highest
 * VMAF and returned the winner. Highest VMAF is always the lowest CQ, i.e. the
 * largest file, so when nothing met the prescribed limit the selector committed
 * the single most expensive encode it had measured — the very one it had just
 * rejected. A representative 2026-07-27 incident logged, seconds apart:
 *
 *   Rejecting gpu_p7_cq16: vmafP1Low 78.12 below 86.00; cambiRisk 5.49 above 5.00
 *   ADVISORY LIMIT FALLBACK ... selecting measured CQ 16 (VMAF 96.94, 1%-low 78.12)
 *
 * Across the incident that produced five outputs at 103%-165% of source size,
 * every one was CQ 16 and still below the prescribed limit. Each replaced its
 * original and consumed about 7.1 GB of avoidable extra disk.
 *
 * The downstream size gates do not catch it: the projected-ratio emergency gate
 * fails open on a null projection, the flow's size-compare node wires pass and
 * fail to the same target, and film-grain synthesis measures its own input.
 * So the selector itself must refuse.
 */

const assert = require('assert');
const path = require('path');

const selector = require(path.join(__dirname,
  'custom-cont-init.d', 'vmaf-plugin-patches', 'selectBestParameters', '1.0.0', 'index.js'));
const { chooseMeasuredToleranceFallback } = selector._test;

/** A technically complete measured candidate, per isTechnicallyMeasuredCandidate. */
function candidate(id, cq, vmaf, p1Low, sizeMB) {
  return {
    parameterSetId: id,
    parameterSet: { id: id, quality: cq },
    avgVMAF: vmaf,
    avgVMAFMean: vmaf,
    vmafP1Low: p1Low,
    avgFileSizeMB: sizeMB,
    sampleCount: 12,
  };
}

const TARGET_VMAF = 95;
const FRAME_FLOOR = 86;

// Representative incident shape: lower CQ buys VMAF and size, but no
// candidate clears the 1%-low frame floor.
const results = [
  candidate('gpu_p7_cq16', 16, 96.94, 78.12, 10729),
  candidate('gpu_p7_cq20', 20, 95.80, 74.90, 8100),
  candidate('gpu_p7_cq24', 24, 94.10, 71.40, 6200),
];
const rejectedResults = [
  { id: 'gpu_p7_cq16', reason: 'Shared feasibility: vmafP1Low 78.12 below 86.00', category: 'tolerance' },
  { id: 'gpu_p7_cq20', reason: 'Shared feasibility: vmafP1Low 74.90 below 86.00', category: 'tolerance' },
  { id: 'gpu_p7_cq24', reason: 'Shared feasibility: vmafP1Low 71.40 below 86.00', category: 'tolerance' },
];

const terminal = chooseMeasuredToleranceFallback(results, {
  targetVmaf: TARGET_VMAF,
  frameFloor: FRAME_FLOOR,
  rejectedResults: rejectedResults,
  terminal: true,
});

assert.strictEqual(terminal, null,
  'a terminal quality miss must return null so the original is preserved, not commit an encode');

// Specifically: it must never hand back the largest / lowest-CQ candidate.
if (terminal !== null) {
  assert.notStrictEqual(terminal && terminal.mode, 'terminal_best_quality',
    'the terminal_best_quality commit path must not be reachable');
}

// Non-terminal invocation was already a no-op and must stay one.
assert.strictEqual(chooseMeasuredToleranceFallback(results, {
  targetVmaf: TARGET_VMAF,
  frameFloor: FRAME_FLOOR,
  rejectedResults: rejectedResults,
  terminal: false,
}), null, 'non-terminal invocation must not select anything');

// The adjacent category fallbacks are deliberately preserved: when candidates
// DO pass the quality limit and were rejected only on CAMBI, selection is still
// allowed. This guards against over-correcting the fix into a total block.
const cambiResults = [
  candidate('gpu_p7_cq22', 22, 96.50, 90.10, 5200),
  candidate('gpu_p7_cq26', 26, 95.60, 88.40, 4300),
];
const cambiRejections = [
  { id: 'gpu_p7_cq22', reason: 'cambiRisk 5.49 above 5.00', category: 'cambi' },
  { id: 'gpu_p7_cq26', reason: 'cambiRisk 5.20 above 5.00', category: 'cambi' },
];
const cambiFallback = chooseMeasuredToleranceFallback(cambiResults, {
  targetVmaf: TARGET_VMAF,
  frameFloor: FRAME_FLOOR,
  rejectedResults: cambiRejections,
  terminal: true,
});
assert.ok(cambiFallback && cambiFallback.mode === 'cambi_only',
  'quality-passing candidates rejected only on CAMBI must still be selectable');

console.log('PASS terminal quality miss preserves the original instead of committing the largest encode');
