'use strict';

// Regression contract for the 2026-07-20 size-gate demotion:
// - the retired >=90% projection cap must not hard-reject on its own while forced-full
//   budget remains (shadow band),
// - the emergency cutoff (default 110%) must always hard-reject,
// - budget exhaustion must restore the legacy hard gate,
// - private atomic reservations, never JSONL row counts, own the cohort budget.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const selector = require('./custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js');
const {
  evaluateSizeGate,
  resolveForcedFullCap,
  resetForcedFullAttemptState,
  hashForcedFullJobIdentity,
  inspectForcedFullReservations,
  reserveForcedFullSlot,
  requiresForcedFullReservation,
  forcedFullDeniedResult,
  commitForcedFullSelection,
} = selector._test;

assert.strictEqual(typeof evaluateSizeGate, 'function');
assert.strictEqual(typeof resolveForcedFullCap, 'function');
assert.strictEqual(typeof resetForcedFullAttemptState, 'function');
assert.strictEqual(typeof hashForcedFullJobIdentity, 'function');
assert.strictEqual(typeof inspectForcedFullReservations, 'function');
assert.strictEqual(typeof reserveForcedFullSlot, 'function');
assert.strictEqual(typeof requiresForcedFullReservation, 'function');
assert.strictEqual(typeof forcedFullDeniedResult, 'function');
assert.strictEqual(typeof commitForcedFullSelection, 'function');

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

// Reservation identity is deterministic and does not expose the source job ID.
const hashA = hashForcedFullJobIdentity('canonical-job-a');
assert.match(hashA, /^[a-f0-9]{64}$/);
assert.strictEqual(hashA, hashForcedFullJobIdentity('canonical-job-a'));
assert.notStrictEqual(hashA, hashForcedFullJobIdentity('canonical-job-b'));

// Single-process contract: a retry reuses its slot and a third distinct job
// cannot cross the hard cap.
const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), `size-gate-test-${process.pid}-`));
const reservationRoot = path.join(tempParent, 'reservations');
try {
  const first = reserveForcedFullSlot({
    rootPath: reservationRoot,
    cap: 2,
    jobIdentityHash: hashA,
  });
  assert.deepStrictEqual([first.ok, first.status, first.slot], [true, 'acquired', 1]);

  const retry = reserveForcedFullSlot({
    rootPath: reservationRoot,
    cap: 2,
    jobIdentityHash: hashA,
  });
  assert.deepStrictEqual([retry.ok, retry.status, retry.slot], [true, 'reused', 1]);

  const second = reserveForcedFullSlot({
    rootPath: reservationRoot,
    cap: 2,
    jobIdentityHash: hashForcedFullJobIdentity('canonical-job-b'),
  });
  assert.deepStrictEqual([second.ok, second.status, second.slot], [true, 'acquired', 2]);

  const exhausted = reserveForcedFullSlot({
    rootPath: reservationRoot,
    cap: 2,
    jobIdentityHash: hashForcedFullJobIdentity('canonical-job-c'),
  });
  assert.deepStrictEqual([exhausted.ok, exhausted.code], [false, 'reservation_cap_exhausted']);

  const snapshot = inspectForcedFullReservations({
    rootPath: reservationRoot,
    cap: 2,
    jobIdentityHash: hashA,
  });
  assert.deepStrictEqual([snapshot.ok, snapshot.used, snapshot.ownedSlot, snapshot.firstFreeSlot],
    [true, 2, 1, null]);
} finally {
  fs.rmSync(tempParent, { recursive: true, force: true });
}

assert.strictEqual(requiresForcedFullReservation({ projectedOutputRatioPct: 95 }, 90, 110), true);
assert.strictEqual(requiresForcedFullReservation({ projectedOutputRatioPct: 89.9 }, 90, 110), false);
assert.strictEqual(requiresForcedFullReservation({ projectedOutputRatioPct: 110 }, 90, 110), false);

// Only a genuinely absent cap gets the default. Explicit malformed safety
// configuration fails closed instead of silently admitting a 12-job cohort.
assert.deepStrictEqual(resolveForcedFullCap(undefined),
  { ok: true, cap: 12, defaulted: true });
assert.deepStrictEqual(resolveForcedFullCap(null),
  { ok: true, cap: 12, defaulted: true });
for (const invalidCap of ['', -1, 1.5, 1000000, 'not-a-number']) {
  const invalid = resolveForcedFullCap(invalidCap);
  assert.deepStrictEqual([invalid.ok, invalid.code], [false, 'reservation_cap_invalid']);
}
assert.deepStrictEqual(resolveForcedFullCap('7'),
  { ok: true, cap: 7, defaulted: false });

// Attempt-scoped routing state is cleared even when a retry's new selection is
// below the shadow band. The attempt re-derives the same stable owner from the
// canonical job ID rather than trusting a stale carried hash.
const retryVariables = {
  vmafSizeGateForcedFull: true,
  vmafSizeGateForcedFullJobHash: hashA,
  vmafSizeGateForcedFullReservationSlot: 1,
  vmafSizeGateForcedFullReservationStatus: 'acquired',
  vmafSizeGateForcedFullReservationFailure: 'old-failure',
  vmafSizeGateForcedFullReservationError: 'old-error',
};
resetForcedFullAttemptState(retryVariables);
assert.strictEqual(retryVariables.vmafSizeGateForcedFull, false);
assert.ok(!Object.prototype.hasOwnProperty.call(
  retryVariables, 'vmafSizeGateForcedFullJobHash'));
assert.strictEqual(selector._test.resolveForcedFullJobIdentityHash({
  variables: { vmafCanonicalJobId: 'canonical-job-a' },
}), hashA);
for (const staleKey of [
  'vmafSizeGateForcedFullReservationSlot',
  'vmafSizeGateForcedFullReservationStatus',
  'vmafSizeGateForcedFullReservationFailure',
  'vmafSizeGateForcedFullReservationError',
]) {
  assert.ok(!Object.prototype.hasOwnProperty.call(retryVariables, staleKey));
}

// Exhaustion/unwritable admission has a directly tested output-2 route and
// clears any previously published exact transcode handoff.
const deniedArgs = {
  inputFileObj: { _id: 'private-test-id' },
  variables: {
    vmafBestParameters: { id: 'stale' },
    vmafFinalSelectedCQ: 24,
    vmafSelectedParameterSetId: 'stale',
  },
  jobLog() {},
};
const deniedResult = forcedFullDeniedResult(deniedArgs, {
  ok: false,
  code: 'reservation_cap_exhausted',
  error: 'cap exhausted',
}, {
  parameterSet: { quality: 30 },
  projectedOutputRatioPct: 95,
});
assert.strictEqual(deniedResult.outputNumber, 2);
assert.strictEqual(deniedResult.variables.vmafSelectOutput, 2);
assert.strictEqual(deniedResult.variables.vmafSizeGateForcedFull, false);
assert.ok(!Object.prototype.hasOwnProperty.call(deniedResult.variables, 'vmafBestParameters'));
assert.ok(!Object.prototype.hasOwnProperty.call(deniedResult.variables, 'vmafFinalSelectedCQ'));
assert.ok(!Object.prototype.hasOwnProperty.call(deniedResult.variables, 'vmafSelectedParameterSetId'));

// Integration-level handoff contract: invalid selection cannot create a
// reservation; concurrent cap exhaustion returns output 2 without publishing;
// clear and admitted shadow selections publish only through the commit helper.
const commitParent = fs.mkdtempSync(path.join(os.tmpdir(), `size-gate-commit-${process.pid}-`));
try {
  const invalidRoot = path.join(commitParent, 'invalid');
  assert.throws(() => commitForcedFullSelection({
    inputFileObj: {},
    variables: {},
    jobLog() {},
  }, {
    projectedOutputRatioPct: 95,
  }, {
    legacyRatioPct: 90,
    emergencyRatioPct: 110,
    capResolution: resolveForcedFullCap(1),
    cap: 1,
    jobIdentityHash: hashForcedFullJobIdentity('invalid-selection'),
    rootPath: invalidRoot,
  }), /incomplete VMAF selection/);
  assert.strictEqual(fs.existsSync(invalidRoot), false,
    'selection validation must happen before reservation-root creation');

  const exhaustedRoot = path.join(commitParent, 'exhausted');
  reserveForcedFullSlot({
    rootPath: exhaustedRoot,
    cap: 1,
    jobIdentityHash: hashForcedFullJobIdentity('existing-owner'),
  });
  const exhaustedArgs = {
    inputFileObj: { _id: 'private-test-id' },
    variables: {},
    jobLog() {},
  };
  const exhaustedCommit = commitForcedFullSelection(exhaustedArgs, {
    parameterSet: { id: 'shadow', quality: 30 },
    parameterSetId: 'shadow',
    projectedOutputRatioPct: 95,
  }, {
    legacyRatioPct: 90,
    emergencyRatioPct: 110,
    capResolution: resolveForcedFullCap(1),
    cap: 1,
    jobIdentityHash: hashForcedFullJobIdentity('denied-new-owner'),
    rootPath: exhaustedRoot,
  });
  assert.strictEqual(exhaustedCommit.ok, false);
  assert.strictEqual(exhaustedCommit.result.outputNumber, 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(
    exhaustedArgs.variables, 'vmafBestParameters'));

  const admittedRoot = path.join(commitParent, 'admitted');
  const admittedArgs = { inputFileObj: {}, variables: {}, jobLog() {} };
  const admittedCommit = commitForcedFullSelection(admittedArgs, {
    parameterSet: { id: 'shadow', quality: 30 },
    parameterSetId: 'shadow',
    projectedOutputRatioPct: 95,
  }, {
    legacyRatioPct: 90,
    emergencyRatioPct: 110,
    capResolution: resolveForcedFullCap(1),
    cap: 1,
    jobIdentityHash: hashForcedFullJobIdentity('admitted-owner'),
    rootPath: admittedRoot,
  });
  assert.strictEqual(admittedCommit.ok, true);
  assert.strictEqual(admittedCommit.reservation.status, 'acquired');
  assert.strictEqual(admittedArgs.variables.vmafFinalSelectedCQ, 30);
  assert.strictEqual(admittedArgs.variables.vmafSelectedParameterSetId, 'shadow');

  const clearRoot = path.join(commitParent, 'clear');
  const clearArgs = { inputFileObj: {}, variables: {}, jobLog() {} };
  const clearCommit = commitForcedFullSelection(clearArgs, {
    parameterSet: { id: 'clear', quality: 32 },
    parameterSetId: 'clear',
    projectedOutputRatioPct: 80,
  }, {
    legacyRatioPct: 90,
    emergencyRatioPct: 110,
    capResolution: resolveForcedFullCap(1),
    cap: 1,
    jobIdentityHash: hashForcedFullJobIdentity('clear-owner'),
    rootPath: clearRoot,
  });
  assert.deepStrictEqual([clearCommit.ok, clearCommit.reservation], [true, null]);
  assert.strictEqual(clearArgs.variables.vmafFinalSelectedCQ, 32);
  assert.strictEqual(fs.existsSync(clearRoot), false,
    'clear-band selection must not touch the reservation ledger');
} finally {
  fs.rmSync(commitParent, { recursive: true, force: true });
}

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
assert.ok(selectorSource.includes('/app/configs/vmaf_size_gate_forced_full_reservations_v1'));
assert.ok(!selectorSource.includes('countForcedFullSelections'),
  'JSONL event counts must not be budget authority');
const pluginAt = selectorSource.indexOf('var plugin =');
const invariantAt = selectorSource.indexOf(
  "throw new Error('selection completed without an established VMAF metric contract')", pluginAt);
const commitAt = selectorSource.indexOf(
  'var _ffCommit = commitForcedFullSelection(args, bestParams, {', invariantAt);
const outputOneAt = selectorSource.indexOf('outputNumber: 1', commitAt);
const commitHelperAt = selectorSource.indexOf('function commitForcedFullSelection(');
const reserveAt = selectorSource.indexOf('reserveForcedFullSlot({', commitHelperAt);
const publishAt = selectorSource.indexOf('publishFinalSelection(', reserveAt);
assert.ok(invariantAt > 0 && invariantAt < commitAt && commitAt < outputOneAt,
  'all known invariants must precede the final reservation/publication commit and output 1');
assert.ok(commitHelperAt > 0 && commitHelperAt < reserveAt && reserveAt < publishAt &&
  publishAt < pluginAt,
  'commit helper must reserve before publishing the exact downstream handoff');
const forcedTelemetryAt = selectorSource.indexOf("event: 'forced_full_selected'", reserveAt);
const forcedTelemetryBlock = selectorSource.slice(
  forcedTelemetryAt,
  selectorSource.indexOf('// Store output number for retry check', forcedTelemetryAt));
assert.ok(!forcedTelemetryBlock.includes('job_id:') && !forcedTelemetryBlock.includes('file_path:'),
  'forced-full telemetry must not expose raw job or file identity');
// The shared quality-risk size evaluation must no longer carry the max-ratio hard cap.
const sharedSizeBlock = selectorSource.split('var sharedSizeEvaluation')[1].split(';')[0];
assert.ok(!sharedSizeBlock.includes('maxOutputRatioPct'),
  'sharedSizeEvaluation must not hard-gate on maxOutputRatioPct');

console.log('PASS size-gate demotion contract (policy, atomic reservation budget, source wiring)');
