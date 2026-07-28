'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lockDir = path.join(os.tmpdir(), `tdarr-lock-finalization-${process.pid}-${Date.now()}`);
process.env.TDARR_GPU_PIPELINE_LOCK_DIR = lockDir;
const lock = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/gpuPipelineLock.js');
fs.mkdirSync(lockDir, { recursive: true });
fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
  token: 'job-a',
  leaseGeneration: 'generation-a',
  ownerId: 'job-a',
}));

assert.strictEqual(lock.release(lockDir, null).reason, 'missing owner token');
assert.ok(fs.existsSync(lockDir), 'tokenless release must preserve another job lock');
assert.strictEqual(lock.release(lockDir, 'job-b').reason, 'lock owned by another job');
assert.ok(fs.existsSync(lockDir), 'wrong-token release must preserve another job lock');
assert.strictEqual(lock.release(lockDir, 'job-a').released, true);
assert.ok(!fs.existsSync(lockDir), 'owner release must remove the lock');

const flow = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'configs', 'flow_YR5PZ1QaD_CANONICAL.json'), 'utf8'));
assert.ok(flow.flowPlugins.some((item) =>
  item.id === 'gpuLockErrorHandler1' && item.pluginName === 'onFlowError'));
assert.ok(flow.flowPlugins.some((item) =>
  item.id === 'gpuLockReleaseError1' && item.pluginName === 'releaseGpuPipelineLock'));
assert.ok(flow.flowEdges.some((edge) =>
  edge.source === 'gpuLockErrorHandler1' && edge.target === 'gpuLockReleaseError1'));
assert.ok(flow.flowEdges.some((edge) =>
  edge.source === 'gpuLockReleaseError1' && edge.target === 'F1jkDv0qn'),
'error release must route only to cleanup');

console.log('PASS GPU lock ownership and error finalization (3 ownership cases + canonical flow)');
