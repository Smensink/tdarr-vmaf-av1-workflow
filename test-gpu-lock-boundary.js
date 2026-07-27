'use strict';

/**
 * This test records the observed live lock topology. It does not establish
 * that every stage outside the lock is safe to overlap; the grain KNN boundary
 * remains an unresolved design decision requiring measurement.
 *
 * By that rule, measured on a 2026-07-26 4K episodic canary:
 *   - IN: the sustained NVENC work — sample encodes (Test Encoding Parameters)
 *     and the full-title AV1 encode (77 min of the 91 min lock).
 *   - OUT: CPU-only VMAF-v1 scoring. 9.4 min across 7 rounds, 65% of the 14.4 min
 *     lock-held analysis phase, with the GPU completely idle. `vmaf-v1-score`
 *     decodes in software and scores on CPU libvmaf.
 *   - OUT in the current graph: grain analysis and sample extraction. The
 *     observed 8.9 min span included ~6 min of Python/grav1synth CPU work and
 *     ~3 min of NVEncC KNN. Whether the KNN portion needs a narrower GPU lease
 *     is deliberately not decided by this structural contract.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const flow = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'configs/flow_YR5PZ1QaD_CANONICAL.json'), 'utf8'));
const nodes = new Map(flow.flowPlugins.map((n) => [n.id, n.name || n.pluginId]));
const edges = flow.flowEdges;

function idsNamed(name) {
  return [...nodes.entries()].filter(([, n]) => n === name).map(([i]) => i);
}
function successorsOf(id) {
  return edges.filter((e) => e.source === id).map((e) => e.target);
}
function predecessorsOf(id) {
  return edges.filter((e) => e.target === id).map((e) => e.source);
}

const acquireIds = idsNamed('Acquire GPU Pipeline Lock');
assert.ok(acquireIds.length >= 1, 'expected at least one acquire point');

// --- stages currently outside the live lock -----------------------------------
// Grain analysis is entered directly from the HDR classifier, never via an
// acquire node. Change this assertion only with the live/canonical migration.
const grain = idsNamed('Analyze Film Grain');
assert.strictEqual(grain.length, 1);
const grainPreds = predecessorsOf(grain[0]).map((p) => nodes.get(p));
assert.ok(!grainPreds.includes('Acquire GPU Pipeline Lock'),
  `live grain-analysis lock topology drifted; predecessors: ${grainPreds}`);

// Sample extraction likewise precedes the lock rather than sitting inside it.
const extract = idsNamed('Extract Video Samples');
assert.strictEqual(extract.length, 1);
const extractNext = successorsOf(extract[0]).map((t) => nodes.get(t));
assert.ok(extractNext.includes('Acquire GPU Pipeline Lock'),
  'the lock must be taken after sample extraction, immediately before the sample encodes');

// --- the sustained NVENC work must be inside the lock ------------------------
const encodeAcq = successorsOf(extract[0]).find((t) => nodes.get(t) === 'Acquire GPU Pipeline Lock');
const afterAcquire = successorsOf(encodeAcq).map((t) => nodes.get(t));
assert.ok(afterAcquire.includes('Test Encoding Parameters'),
  'sample encodes (sustained NVENC) must run under the lock');

const releaseIds = new Set(idsNamed('Release GPU Pipeline Lock'));
const transcode = idsNamed('VMAF Optimized Transcode')[0];
const transcodeNext = successorsOf(transcode).map((t) => t);
assert.ok(transcodeNext.every((t) => releaseIds.has(t)),
  'the full-title encode must release the lock on every exit');

// --- CPU-only scoring must release the lock ----------------------------------
const calcSrc = fs.readFileSync(path.join(__dirname,
  'custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js'), 'utf8');

assert.ok(/function releaseGpuLockForCpuScoring/.test(calcSrc));
assert.ok(/function reacquireGpuLockAfterCpuScoring/.test(calcSrc));

// Anchor on the call sites, not the function definitions (which contain the
// same identifier and would otherwise match first).
const releaseAt = calcSrc.indexOf('= releaseGpuLockForCpuScoring(args, hasCpuV1)');
const startAt = calcSrc.indexOf('=== Starting VMAF Calculations ===');
const reacquireAt = calcSrc.indexOf('reacquireGpuLockAfterCpuScoring(args, _gpuLockReleasedForCpuScoring)');
const aggregateAt = calcSrc.indexOf('=== Aggregating Results ===');
assert.ok(releaseAt > 0 && startAt > 0 && reacquireAt > 0 && aggregateAt > 0);
assert.ok(releaseAt < startAt, 'the lock must be released before scoring begins');
assert.ok(startAt < reacquireAt, 'the lock must stay released across scoring');
assert.ok(reacquireAt < aggregateAt, 'the lock must be back before anything downstream');

// Only the CPU-v1 path may release; the GPU-v0 rollback path must not.
assert.ok(/if \(hasCpuV1 !== true\) return null;/.test(calcSrc),
  'the GPU-v0 rollback path must never release the lock');

// A failed release must keep the lock rather than continue unlocked.
assert.ok(/keeping lock/.test(calcSrc),
  'a failed release must fall back to holding the lock');

// --- the scorer must genuinely be GPU-free -----------------------------------
const scorer = fs.readFileSync(path.join(__dirname,
  'runtime/vmaf-v1/vmaf-v1-score.sh'), 'utf8');
for (const gpuToken of ['hwaccel', 'cuda', 'nvdec', 'cuvid', 'nvenc']) {
  assert.ok(!new RegExp(gpuToken, 'i').test(scorer),
    `releasing the lock during scoring is only safe while the scorer is GPU-free; found ${gpuToken}`);
}

console.log('PASS observed GPU-lock topology '
  + '(grain analysis outside; sample/final encode inside; CPU scoring released)');
