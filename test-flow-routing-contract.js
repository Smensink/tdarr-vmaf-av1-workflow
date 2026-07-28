'use strict';

const assert = require('assert');
const fs = require('fs');

const exported = JSON.parse(fs.readFileSync('flow/tdarr-flow-vmaf-av1.json', 'utf8'));
const canonical = JSON.parse(fs.readFileSync('configs/flow_YR5PZ1QaD_CANONICAL.json', 'utf8'));
assert.deepStrictEqual(exported, canonical, 'tracked flow snapshots must remain identical');

const nodesById = Object.fromEntries(exported.flowPlugins.map((node) => [node.id, node]));
const gpuFailureRoutes = exported.flowEdges.filter(
  (edge) => edge.source === 'gpu1' && String(edge.sourceHandle) === '2'
);
assert.strictEqual(gpuFailureRoutes.length, 1, 'no-GPU output must have exactly one route');
assert.strictEqual(nodesById[gpuFailureRoutes[0].target].pluginName, 'failFlow',
  'no-GPU output must terminate through failFlow');
assert.ok(!gpuFailureRoutes.some((edge) => edge.target === 'hdr1'),
  'no-GPU output must not continue to HDR analysis');

const sizeRoutes = exported.flowEdges.filter((edge) => edge.source === 'sizeCheck1');
assert.deepStrictEqual(
  sizeRoutes.map((edge) => String(edge.sourceHandle)).sort(),
  ['1', '2'],
  'size check must define both its proceed and defensive reject routes'
);
assert.strictEqual(
  sizeRoutes.find((edge) => String(edge.sourceHandle) === '1').target,
  'gpuLockAcquireTranscode1',
  'only size-check output 1 may start the final transcode'
);
assert.strictEqual(
  sizeRoutes.find((edge) => String(edge.sourceHandle) === '2').target,
  'F1jkDv0qn',
  'size-check output 2 must preserve the original and clean job-owned temporary files'
);
assert.ok(!sizeRoutes.some((edge) =>
  String(edge.sourceHandle) === '2' && edge.target === 'gpuLockAcquireTranscode1'),
'size rejection must never reach the final transcode');

const replaceNode = nodesById.replace1;
assert.strictEqual(replaceNode.sourceRepo, 'Local');
assert.strictEqual(replaceNode.pluginName, 'replaceOriginalFileAttested');
const validationNode = nodesById.deliveryValidate1;
assert.strictEqual(validationNode.sourceRepo, 'Local');
assert.strictEqual(validationNode.pluginName, 'validateDeliveryCandidate');
const validationRoutes = exported.flowEdges.filter(
  (edge) => edge.source === 'deliveryValidate1'
);
assert.deepStrictEqual(
  validationRoutes.map((edge) => String(edge.sourceHandle)).sort(),
  ['1', '2'],
  'delivery validation must distinguish accepted and keep-original outcomes'
);
assert.strictEqual(
  validationRoutes.find((edge) => String(edge.sourceHandle) === '1').target,
  'replace1',
  'only an exact-byte accepted candidate may reach replacement'
);
assert.strictEqual(
  validationRoutes.find((edge) => String(edge.sourceHandle) === '2').target,
  'F1jkDv0qn',
  'a delivery-size rejection must preserve the original through cleanup'
);
for (const source of ['grainSynthesis1', 'BthcE0uii']) {
  assert.strictEqual(
    exported.flowEdges.find((edge) =>
      edge.source === source && String(edge.sourceHandle) === '1').target,
    'deliveryValidate1',
    `${source} must pass through exact-byte delivery validation`
  );
}
const replaceRoutes = exported.flowEdges.filter((edge) => edge.source === 'replace1');
assert.deepStrictEqual(
  replaceRoutes.map((edge) => String(edge.sourceHandle)).sort(),
  ['1', '2', '3'],
  'attested replacement must distinguish verified, backup-retained, and keep-original outcomes'
);
for (const handle of ['1', '2']) {
  assert.strictEqual(
    replaceRoutes.find((edge) => String(edge.sourceHandle) === handle).target,
    'deliveryFinalize1',
    `successful replacement output ${handle} must enter delivered-outcome finalization`
  );
}
assert.strictEqual(
  replaceRoutes.find((edge) => String(edge.sourceHandle) === '3').target,
  'F1jkDv0qn',
  'keep-original replacement output must bypass notifications and retain checkpoint proof'
);
const finalizerNode = nodesById.deliveryFinalize1;
assert.strictEqual(finalizerNode.sourceRepo, 'Local');
assert.strictEqual(finalizerNode.pluginName, 'finalizeDeliveredOutcome');
const finalizerRoutes = exported.flowEdges.filter(
  (edge) => edge.source === 'deliveryFinalize1'
);
assert.strictEqual(finalizerRoutes.length, 1);
assert.strictEqual(String(finalizerRoutes[0].sourceHandle), '1');
assert.strictEqual(finalizerRoutes[0].target, 'fk_oDdIer',
  'notifications may run only after the delivered DB outcome is read-back verified');

assert.strictEqual(exported.flowPlugins.length, 36);
assert.strictEqual(exported.flowEdges.length, 58);

console.log('PASS fail-closed GPU, delivery validation, replacement, and finalization routing');
