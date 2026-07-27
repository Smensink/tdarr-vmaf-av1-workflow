'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const plugin = require('./plugins/vmaf/extractVideoSamples/1.0.0/index.js');

const maxInput = plugin.details().inputs.find((input) => input.name === 'maxSegments');
assert.ok(maxInput, 'maxSegments input missing');
assert.strictEqual(String(maxInput.defaultValue), '16');

const flowName = 'flow_YR5PZ1QaD_CANONICAL.json';
const flow = JSON.parse(fs.readFileSync(path.join(__dirname, 'configs', flowName), 'utf8'));
const extract = flow.flowPlugins.find((item) => item.pluginName === 'extractVideoSamples');
assert.ok(extract, `${flowName}: extractVideoSamples missing`);
assert.strictEqual(String(extract.inputsDB.maxSegments), '16', `${flowName}: stale maxSegments`);

console.log('PASS production sample budget policy (plugin default + canonical flow)');
