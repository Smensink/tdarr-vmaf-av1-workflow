'use strict';

const assert = require('assert');
const fs = require('fs');
const plugin = require('./plugins/vmaf/testEncodingParameters/1.0.0/index.js');

const details = plugin.details();
const timeout = details.inputs.find((input) => input.name === 'sampleEncodeTimeoutSeconds');
const coverage = details.inputs.find((input) => input.name === 'minParameterCoverage');
assert.strictEqual(String(timeout.defaultValue), '600');
assert.strictEqual(String(coverage.defaultValue), '0.8');

for (const file of [
  'custom-cont-init.d/vmaf-plugin-patches/testEncodingParameters/1.0.0/index.js',
  'plugins/vmaf/testEncodingParameters/1.0.0/index.js',
]) {
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.includes("spawn(args.ffmpegPath, invocationArgs, { shell: false"), `${file}: direct argv spawn missing`);
  assert.ok(!source.includes('spawn(cmd, { shell: true })'), `${file}: legacy shell spawn remains`);
  assert.ok(source.includes("child.kill('SIGKILL')"), `${file}: timeout kill missing`);
  assert.ok(source.includes('vmafIncompleteParameterSets'), `${file}: completeness gate missing`);
  assert.ok(source.includes('testResults = testResults.filter'), `${file}: incomplete results are not excluded`);
}

console.log('PASS sample encode argv/timeout/completeness policy');
