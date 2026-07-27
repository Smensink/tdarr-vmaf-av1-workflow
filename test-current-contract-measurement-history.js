'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../../methods/lib') {
    return () => ({ loadDefaultValues(inputs) { return inputs || {}; } });
  }
  return originalLoad.call(this, request, parent, isMain);
};
const history = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/currentContractMeasurementHistory.js');
const canonical = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/canonicalDenoise.js');
const calculateTest = require(
  './custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js'
)._test;
const extractTest = require(
  './custom-cont-init.d/vmaf-plugin-patches/extractVideoSamples/1.0.0/index.js'
)._test;
const exportTest = require(
  './custom-cont-init.d/vmaf-plugin-patches/exportVMAFResults/1.0.0/index.js'
)._test;
const bracketPlugin = require(
  './plugins/vmaf/checkCQBracket/1.0.0/index.js'
).plugin;

const CONTRACT = canonical.REFERENCE_CONTRACT_ID;
const SOURCE = '/media/library/example-source.mkv';
const JOB = 'canonical-example-job';
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function point(cq, harmonic, p1, cambiP95, cambiMax, options = {}) {
  const preset = options.preset || 'p7';
  const id = options.id || `gpu_${preset}_cq${cq}`;
  return {
    parameterSetId: id,
    parameterSet: { id, encoder: 'av1_nvenc', preset, quality: cq },
    avgVMAF: harmonic,
    avgVMAFMean: harmonic,
    vmafP1Low: p1,
    avgCAMBI: Math.min(cambiP95, 2),
    p95CAMBI: cambiP95,
    maxCAMBI: cambiMax,
    avgFileSizeMB: 4,
    measurementSubsample: 1,
  };
}

function makeArgs() {
  return {
    inputFileObj: {
      _id: SOURCE,
      ffProbeData: {
        streams: [{ codec_type: 'video', width: 3840, height: 2160 }],
      },
    },
    variables: {
      vmafOriginalFile: SOURCE,
      vmafCanonicalJobId: JOB,
    },
  };
}

const initial1917 = [
  point(30, 97.86, 90.98, 3.51, 4.45),
  point(35, 96.63, 89.97, 4.43, 5.06),
  point(40, 94.52, 86.08, 4.73, 5.44),
];
const refinement1917 = point(32.5, 96.55, 91.40, 4.62, 6.44);

test('30/35/40 survive the 32.5 refinement and drive the next real bracket probe', () => {
  const args = makeArgs();
  let published = calculateTest.persistCurrentContractMeasurements(args, CONTRACT, initial1917);
  args.variables.vmafAggregatedResults = published;

  assert.deepStrictEqual(published.map((row) => row.parameterSet.quality), [30, 35, 40]);
  assert.strictEqual(args.variables.vmafCurrentContractMeasurementHistory.round, 1);

  published = calculateTest.persistCurrentContractMeasurements(args, CONTRACT, [refinement1917]);
  args.variables.vmafAggregatedResults = published;
  assert.deepStrictEqual(published.map((row) => row.parameterSet.quality), [30, 35, 40, 32.5]);
  assert.strictEqual(args.variables.vmafCurrentContractMeasurementHistory.round, 2);

  const logs = [];
  const bracketArgs = {
    inputFileObj: args.inputFileObj,
    inputs: { targetVMAF: '95' },
    variables: Object.assign(args.variables, {
      vmafAggregatedResults: published,
      vmafMinFrameVMAF: 88,
      vmafTestedCQs: [30, 35, 40, 32.5],
      vmafActiveRefineCount: 1,
      vmafProgressiveExpansion: { enabled: false },
      isHDR: true,
      vmafSourceCAMBI: 0.173716,
      vmafSourceCAMBIP95: 0.225824,
    }),
    jobLog(message) { logs.push(String(message)); },
  };
  const result = bracketPlugin(bracketArgs);
  assert.strictEqual(result.outputNumber, 2);
  assert.deepStrictEqual(bracketArgs.variables.vmafNextCQs, [31.3]);
  assert(logs.some((line) => line.includes('feasible CQ 30 / infeasible CQ 32.5')));
});

test('published aggregate mutations and selector reuse rows cannot contaminate fresh history', () => {
  const args = makeArgs();
  const published = calculateTest.persistCurrentContractMeasurements(args, CONTRACT, initial1917);
  args.variables.vmafAggregatedResults = published;

  published[0].avgVMAF = -100;
  published.push(Object.assign(point(28, 98, 92, 2, 2), {
    reusedFromJobId: 'historical-job',
  }));

  const republished = calculateTest.persistCurrentContractMeasurements(
    args, CONTRACT, [refinement1917]
  );
  assert.strictEqual(republished.length, 4);
  assert.strictEqual(republished.find((row) => row.parameterSet.quality === 30).avgVMAF, 97.86);
  assert(republished.every((row) => !Object.prototype.hasOwnProperty.call(row, 'reusedFromJobId')));

  republished[0].parameterSet.quality = 99;
  assert.strictEqual(
    args.variables.vmafCurrentContractMeasurementHistory.points[0].parameterSet.quality,
    30,
    'published points must be deep clones of the authoritative envelope'
  );
});

test('current-only merge rejects reused, legacy, mis-stamped, and conflicting points', () => {
  const context = { jobId: JOB, sourcePath: SOURCE, referenceContractId: CONTRACT };
  const envelope = history.mergeCurrentMeasurements(null, context, [initial1917[0]]);

  assert.throws(() => history.mergeCurrentMeasurements(envelope, context, [
    Object.assign(point(31, 97, 90, 2, 2), { reusedFromJobId: 'other-job' }),
  ]), /cross-job reused/);
  assert.throws(() => history.mergeCurrentMeasurements(envelope, context, [
    Object.assign(point(31, 97, 90, 2, 2), {
      referenceContractId: canonical.LEGACY_REFERENCE_CONTRACT_ID,
    }),
  ]), /wrong reference contract/);
  assert.throws(() => history.mergeCurrentMeasurements(envelope, context, [
    Object.assign(point(31, 97, 90, 2, 2), { measurementOrigin: 'historical-reuse' }),
  ]), /wrong measurement origin/);
  assert.throws(() => history.mergeCurrentMeasurements(envelope, context, [
    point(31, 97, 90, 2, 2, { id: initial1917[0].parameterSetId }),
  ]), /changed CQ/);
  assert.throws(() => history.mergeCurrentMeasurements(envelope, context, [
    Object.assign({}, point(31, 97, 90, 2, 2), { parameterSetId: '' }),
  ]), /requires point parameterSetId/);
  const missingCq = point(31, 97, 90, 2, 2);
  missingCq.parameterSet.quality = null;
  assert.throws(() => history.mergeCurrentMeasurements(envelope, context, [missingCq]),
    /requires a finite parameterSet\.quality CQ/);

  const tooMany = [];
  for (let index = 0; index <= history.MAX_POINTS; index += 1) {
    tooMany.push(point(index / 10, 97, 90, 2, 2, { id: `bounded-${index}` }));
  }
  assert.throws(() => history.mergeCurrentMeasurements(null, context, tooMany), /point limit/);
});

test('latest retest wins while distinct presets at the same CQ remain distinct', () => {
  const context = { jobId: JOB, sourcePath: SOURCE, referenceContractId: CONTRACT };
  let envelope = history.mergeCurrentMeasurements(null, context, [
    point(30, 97, 90, 2, 2),
    point(30, 96.5, 89, 2.5, 3, { preset: 'p6' }),
  ]);
  assert.strictEqual(envelope.points.length, 2);

  envelope = history.mergeCurrentMeasurements(envelope, context, [
    point(30, 98.25, 91, 1.5, 2),
  ]);
  assert.strictEqual(envelope.points.length, 2);
  assert.strictEqual(
    envelope.points.find((row) => row.parameterSetId === 'gpu_p7_cq30').avgVMAF,
    98.25
  );
});

test('compact encode timing survives refinement and the latest same-CQ retest wins', () => {
  const totals = calculateTest.buildEncodeTimeTotals([
    { parameterSetId: 'gpu_p7_cq30', encodingTimeSeconds: 4.25 },
    { parameterSetId: 'gpu_p7_cq30', encodingTimeSeconds: '5.75' },
    { parameterSetId: 'gpu_p7_cq35', encodingTimeSeconds: 7 },
    { parameterSetId: 'gpu_p7_cq35', encodingTimeSeconds: null },
    { parameterSetId: 'gpu_p7_cq40', encodingTimeSeconds: -1 },
  ]);
  assert.deepStrictEqual(totals, { gpu_p7_cq30: 10, gpu_p7_cq35: 7 });

  const args = makeArgs();
  const initial = initial1917.map((row) => Object.assign({}, row));
  initial[0].encodeTimeSecTotal = totals.gpu_p7_cq30;
  initial[1].encodeTimeSecTotal = totals.gpu_p7_cq35;
  initial[2].encodeTimeSecTotal = 9;
  calculateTest.persistCurrentContractMeasurements(args, CONTRACT, initial);

  const refinement = Object.assign({}, refinement1917, { encodeTimeSecTotal: 2.5 });
  let published = calculateTest.persistCurrentContractMeasurements(args, CONTRACT, [refinement]);
  assert.strictEqual(published.find((row) => row.parameterSet.quality === 30).encodeTimeSecTotal, 10);
  assert.strictEqual(published.find((row) => row.parameterSet.quality === 35).encodeTimeSecTotal, 7);
  assert.strictEqual(published.find((row) => row.parameterSet.quality === 32.5).encodeTimeSecTotal, 2.5);

  const cq30Retest = Object.assign({}, initial1917[0], {
    avgVMAF: 98.1,
    encodeTimeSecTotal: 3.25,
  });
  published = calculateTest.persistCurrentContractMeasurements(args, CONTRACT, [cq30Retest]);
  assert.strictEqual(published.length, 4);
  assert.strictEqual(published.find((row) => row.parameterSet.quality === 30).encodeTimeSecTotal, 3.25);
});

test('SQLite timing export prefers aggregate history and falls back to last-round timing', () => {
  assert.strictEqual(exportTest.resolveAggregateEncodeTime({ encodeTimeSecTotal: 12.5 }, 99), 12.5);
  assert.strictEqual(exportTest.resolveAggregateEncodeTime({ encodeTimeSecTotal: null }, 8.25), 8.25);
  assert.strictEqual(exportTest.resolveAggregateEncodeTime({}, '6.5'), 6.5);
  assert.strictEqual(exportTest.resolveAggregateEncodeTime({ encodeTimeSecTotal: 0 }, 4), 0);
  assert.strictEqual(exportTest.resolveAggregateEncodeTime({ encodeTimeSecTotal: -1 }, -2), undefined);
});

test('new-file reset discards stale job identity before seeding one canonical id', () => {
  const variables = {
    vmafJobId: 'stale-job',
    vmafCanonicalJobId: 'stale-canonical',
    vmafRunId: 'stale-run',
    vmafJobStartTime: '2026-01-01T00:00:00.000Z',
    unrelated: 'preserved',
  };
  extractTest.resetVmafJobIdentity(variables);
  for (const key of ['vmafJobId', 'vmafCanonicalJobId', 'vmafRunId', 'vmafJobStartTime']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(variables, key), false, `${key} survived reset`);
  }
  assert.strictEqual(variables.unrelated, 'preserved');

  extractTest.seedVmafJobIdentity(
    variables, 'fresh-source-job', '2026-07-22T12:34:56.000Z'
  );
  assert.strictEqual(variables.vmafJobId, 'fresh-source-job');
  assert.strictEqual(variables.vmafCanonicalJobId, 'fresh-source-job');
  assert.strictEqual(variables.vmafJobStartTime, '2026-07-22T12:34:56.000Z');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(variables, 'vmafRunId'), false);
});

test('job, source, and contract changes fail until the new-file reset clears the envelope', () => {
  const args = makeArgs();
  calculateTest.persistCurrentContractMeasurements(args, CONTRACT, [initial1917[0]]);

  args.variables.vmafCanonicalJobId = 'next-job';
  args.variables.vmafOriginalFile = '/media/next-source.mkv';
  args.inputFileObj._id = '/media/next-source.mkv';
  assert.throws(() => calculateTest.persistCurrentContractMeasurements(
    args, CONTRACT, [point(30, 96, 90, 2, 2)]
  ), /job changed without a reset/);

  args.variables.vmafCurrentContractMeasurementHistory = null;
  const next = calculateTest.persistCurrentContractMeasurements(
    args, CONTRACT, [point(30, 96, 90, 2, 2)]
  );
  assert.strictEqual(next.length, 1);
  assert.strictEqual(args.variables.vmafCurrentContractMeasurementHistory.jobId, 'next-job');

  const wrongContractEnvelope = args.variables.vmafCurrentContractMeasurementHistory;
  assert.throws(() => history.mergeCurrentMeasurements(wrongContractEnvelope, {
    jobId: 'next-job',
    sourcePath: '/media/next-source.mkv',
    referenceContractId: canonical.LEGACY_REFERENCE_CONTRACT_ID,
  }, [point(31, 95, 89, 2, 2)]), /reference contract changed without a reset/);
});

test('extract owns the reset and deployment copies/verifies the helper', () => {
  const extractSource = fs.readFileSync(
    'custom-cont-init.d/vmaf-plugin-patches/extractVideoSamples/1.0.0/index.js', 'utf8'
  );
  assert.match(extractSource, /vmafCurrentContractMeasurementHistory\s*=\s*null/);
  assert.match(extractSource, /vmafSweepResultHistory\s*=\s*\[\]/);
  assert.match(extractSource, /resetVmafJobIdentity\(args\.variables\)/);

  for (const retryPath of [
    'custom-cont-init.d/vmaf-plugin-patches/checkCQRangeRetry/1.0.0/index.js',
    'custom-cont-init.d/vmaf-plugin-patches/monitorTranscodeRetry/1.0.0/index.js',
  ]) {
    const retrySource = fs.readFileSync(retryPath, 'utf8');
    assert.doesNotMatch(retrySource, /vmafCurrentContractMeasurementHistory\s*=/,
      `${retryPath} must preserve current-job measurements`);
  }

  const initSource = fs.readFileSync('custom-cont-init.d/96-apply-vmaf-plugin-patches.sh', 'utf8');
  assert.match(initSource, /apply_shared_lib_file 'currentContractMeasurementHistory\.js'/);
  const paritySource = fs.readFileSync('build-scripts/verify-vmaf-deployment-parity.js', 'utf8');
  assert.match(paritySource, /'currentContractMeasurementHistory\.js'/);
});

test('calculateVMAF persists results under the authenticated runtime reference contract', () => {
  const calculateSource = fs.readFileSync(
    'custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js', 'utf8'
  );
  assert.match(
    calculateSource,
    /persistCurrentContractMeasurements\(args,\s*referenceContract\.id,\s*aggregatedResults\)/
  );
  assert.doesNotMatch(calculateSource, /expectedReferenceContract/);
});

console.log(`PASS current-contract measurement history (${passed} cases)`);
Module._load = originalLoad;
