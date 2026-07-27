'use strict';

const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../../methods/lib') {
    return () => ({ loadDefaultValues(inputs) { return inputs || {}; } });
  }
  return originalLoad.call(this, request, parent, isMain);
};
const bracketPlugin = require('./plugins/vmaf/checkCQBracket/1.0.0/index.js').plugin;

function point(cq, mean, p1, cambi) {
  return {
    parameterSet: { quality: cq },
    avgVMAF: mean,
    avgVMAFMean: mean,
    vmafP1Low: p1,
    p95CAMBI: cambi,
  };
}

function run(points, variables, dimensions) {
  const logs = [];
  const args = {
    inputFileObj: {
      _id: 'C:/media/test.mkv',
      ffProbeData: {
        streams: [{ codec_type: 'video', width: dimensions?.width || 1920, height: dimensions?.height || 1080 }],
      },
    },
    inputs: { targetVMAF: '95' },
    variables: Object.assign({
      vmafAggregatedResults: points,
      vmafMinFrameVMAF: 87,
      vmafTestedCQs: points.map((item) => item.parameterSet.quality),
    }, variables || {}),
    jobLog(message) { logs.push(String(message)); },
  };
  return { args, logs, result: bracketPlugin(args) };
}

function main() {
  const defaultGrid = run([
    point(30, 96, 90, 2),
    point(30.2, 94, 85, 3),
  ]);
  assert.strictEqual(defaultGrid.result.outputNumber, 2);
  assert.deepStrictEqual(defaultGrid.args.variables.vmafNextCQs, [30.1]);
  assert.strictEqual(defaultGrid.args.variables.vmafSubsample, '1');

  const wideGap = run([
    point(30, 96, 90, 2),
    point(32, 94, 85, 3),
  ]);
  assert.deepStrictEqual(wideGap.args.variables.vmafNextCQs, [31]);
  assert.ok(wideGap.logs.some((line) => line.includes('grid 0.1')));

  const tightGap = run([
    point(30, 96, 90, 2),
    point(30.1, 94, 85, 3),
  ]);
  assert.strictEqual(tightGap.result.outputNumber, 1, '0.1 gap should be terminal on the production grid');

  const capped = run([
    point(30, 96, 90, 2),
    point(32, 94, 85, 3),
  ], { vmafActiveRefineCount: 8 });
  assert.strictEqual(capped.result.outputNumber, 1, 'default eight-round cap should be honored');

  const overrideGrid = run([
    point(30, 96, 90, 2),
    point(31, 94, 85, 3),
  ], { vmafActiveCQStep: 0.5, vmafActiveStopGap: 0.5 });
  assert.deepStrictEqual(overrideGrid.args.variables.vmafNextCQs, [30.5]);

  const fourK = run([
    point(30, 96, 90, 2),
    point(30.2, 94, 85, 3),
  ], {}, { width: 3840, height: 2160 });
  assert.deepStrictEqual(fourK.args.variables.vmafNextCQs, [30.1], '4K should use the same 0.1 default stop gap');

  const incomplete = run([
    point(30, 96, 90, null),
    point(32, 94, 85, null),
  ]);
  assert.strictEqual(incomplete.result.outputNumber, 2);
  assert.deepStrictEqual(incomplete.args.variables.vmafForceRetestCQs, [30, 32]);
  assert.ok(incomplete.logs.some((line) => line.includes('incomplete mandatory metrics')));

  console.log('PASS checkCQBracket live/harness grid parity (7 cases)');
}

try {
  main();
} finally {
  Module._load = originalLoad;
}
