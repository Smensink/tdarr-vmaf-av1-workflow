'use strict';

const assert = require('assert');
const fs = require('fs');
const learn = require('./plugins/vmaf/learnCQRange/1.0.0/index.js');

const ema = learn.details().inputs.find((input) => input.name === 'emaEnabled');
assert.strictEqual(String(ema.defaultValue), 'false');

for (const file of [
  'custom-cont-init.d/vmaf-plugin-patches/learnCQRange/1.0.0/index.js',
  'plugins/vmaf/learnCQRange/1.0.0/index.js',
]) {
  const source = fs.readFileSync(file, 'utf8');
  const sqliteBlock = source.slice(source.indexOf('Unified SQLite training store: selection/retry facts'), source.indexOf('Legacy EMA is diagnostic-only'));
  assert.ok(!sqliteBlock.includes('transcode_succeeded:'), `${file}: selection still writes terminal success`);
  assert.ok(!sqliteBlock.includes('met_vmaf_target:'), `${file}: selection still writes terminal VMAF outcome`);
  assert.ok(source.includes('if (emaEnabled) try'), `${file}: EMA toggle is not honored`);
}

const patchedLearningSource = fs.readFileSync(
  'custom-cont-init.d/vmaf-plugin-patches/learnCQRange/1.0.0/index.js', 'utf8'
);
const patchedLearningSqliteBlock = patchedLearningSource.slice(
  patchedLearningSource.indexOf('Unified SQLite training store: selection/retry facts'),
  patchedLearningSource.indexOf('Legacy EMA is diagnostic-only')
);
assert.ok(patchedLearningSqliteBlock.includes(
  'reference_contract_id: args.variables.vmafReferenceContractId || undefined'
), 'learn-only job creation can lose the VMAF reference contract');

for (const file of [
  'custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js',
  'plugins/vmaf/vmafOptimizedTranscode/1.0.0/index.js',
]) {
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(!source.includes("transcode_succeeded: 1,"), `${file}: transcode still writes terminal DB success`);
}

const monitor = fs.readFileSync('custom-cont-init.d/vmaf-plugin-patches/monitorTranscodeRetry/1.0.0/index.js', 'utf8');
assert.ok(monitor.includes('Single authoritative terminal-outcome write'));
assert.ok(monitor.includes('final_output_ratio_pct:'));
assert.ok(monitor.includes('transcode_succeeded: 1'));
assert.ok(monitor.includes('transcode_succeeded: 0'));

console.log('PASS SQLite learning/terminal outcome authority');
