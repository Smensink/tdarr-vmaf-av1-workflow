'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const flowName = 'flow_YR5PZ1QaD_CANONICAL.json';
const flow = JSON.parse(fs.readFileSync(path.join(__dirname, 'configs', flowName), 'utf8'));
assert.ok(!flow.flowPlugins.some((item) => item.pluginName === 'detectSceneComplexity'),
  `${flowName}: heuristic node remains`);
assert.ok(flow.flowEdges.some((edge) => edge.source === 'meta1' && edge.target === 'extract1'),
  `${flowName}: direct metadata-to-extract edge missing`);
assert.ok(!flow.flowEdges.some((edge) =>
  edge.source === 'BCgj_9OBS' || edge.target === 'BCgj_9OBS'),
`${flowName}: stale heuristic edge remains`);

console.log('PASS scene-complexity heuristic retirement (canonical flow)');
