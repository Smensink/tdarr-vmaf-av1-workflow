'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../../methods/lib') {
    return () => ({ loadDefaultValues(inputs) { return inputs || {}; } });
  }
  return originalLoad.call(this, request, parent, isMain);
};
const cleanup = require('./plugins/vmaf/cleanupTempFiles/1.0.0/index.js').plugin;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-cleanup-test-'));
const jobRoot = path.join(base, 'job');
fs.mkdirSync(jobRoot);
const owned = path.join(jobRoot, 'owned.tmp');
const original = path.join(jobRoot, 'original.mkv');
const foreign = path.join(base, 'foreign.tmp');
fs.writeFileSync(owned, 'owned');
fs.writeFileSync(original, 'original');
fs.writeFileSync(foreign, 'foreign');
try {
  const variables = { vmafOriginalFile: original, vmafTemporaryFiles: [owned, original] };
  cleanup({ inputFileObj: { _id: original }, inputs: {}, variables, workDir: jobRoot, jobLog() {} });
  assert.ok(!fs.existsSync(owned), 'owned manifest file should be deleted');
  assert.ok(fs.existsSync(original), 'original must be protected');
  assert.deepStrictEqual(variables.vmafTemporaryFiles, []);

  const poisonedOwned = path.join(jobRoot, 'poisoned-owned.tmp');
  fs.writeFileSync(poisonedOwned, 'owned');
  const poisoned = {
    vmafOriginalFile: original,
    vmafTemporaryFiles: [poisonedOwned, foreign],
  };
  assert.throws(
    () => cleanup({
      inputFileObj: { _id: original }, inputs: {}, variables: poisoned,
      workDir: jobRoot, jobLog() {},
    }),
    /containment validation failed/,
    'an out-of-job mutable manifest path must fail closed',
  );
  assert.ok(fs.existsSync(poisonedOwned),
    'manifest validation must happen before any deletion');
  assert.ok(fs.existsSync(foreign), 'path outside the job root must be protected');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

const flow = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'configs', 'flow_YR5PZ1QaD_CANONICAL.json'), 'utf8'));
for (const expected of [['monitorRetry1', '4'], ['gpuLockReleaseError1', '1'], ['hdr1', '3']]) {
  assert.ok(flow.flowEdges.some((edge) => edge.source === expected[0] &&
    edge.sourceHandle === expected[1] && edge.target === 'F1jkDv0qn'));
}
Module._load = originalLoad;
console.log('PASS job-owned cleanup and terminal routing (3 path cases + canonical flow)');
