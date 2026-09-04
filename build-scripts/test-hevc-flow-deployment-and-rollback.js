'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const rollback = require('./rollback-hevc-flow-canary.js');
const drain = require('./set-tdarr-global-pause.js');
const requeue = require('./requeue-hevc-fallback-cohort.js');
const cohortFixture = require('./fixtures/build-hevc-fallback-cohort.js');

const root = path.resolve(__dirname, '..');
const canaryPath = path.join(root, 'configs', 'flow_YR5PZ1QaD_HEVC_CANARY.json');
const canonicalPath = path.join(root, 'configs', 'flow_YR5PZ1QaD_CANONICAL.json');
const canaryRaw = fs.readFileSync(canaryPath, 'utf8').trim();
const canonicalRaw = fs.readFileSync(canonicalPath, 'utf8').trim();
const canary = JSON.parse(canaryRaw);
const canonical = JSON.parse(canonicalRaw);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-hevc-rollback-'));
const cohortPath = path.join(tmp, 'synthetic-cohort.json');
const builtCohort = cohortFixture.buildSyntheticCohort({ outputPath: cohortPath });
const cohortRaw = Buffer.from(builtCohort.raw, 'utf8');
const cohort = JSON.parse(cohortRaw.toString('utf8'));
Object.defineProperty(cohort, '_physical_sha256', {
  value: rollback.digest(cohortRaw), enumerable: false,
});
assert.deepStrictEqual(canonical, canary,
  'r34 canonical and compatibility Flow snapshots must be identical');
const hevcNodes = (canary.flowPlugins || []).filter((node) =>
  node.pluginName === 'activateHevcFallback');
assert.strictEqual(hevcNodes.length, 2,
  'both post-AV1 and manifest-prior HEVC adapters must remain available');
hevcNodes.forEach((node) => assert.strictEqual(node.inputsDB && node.inputsDB.enabled, false,
  `${node.id} must be toggle-disabled in r34`));
const reviewCanary = JSON.parse(canaryRaw);
for (const node of reviewCanary.flowPlugins.filter((item) =>
  item.pluginName === 'activateHevcFallback')) {
  node.inputsDB.manifestFileSha256 = builtCohort.manifestFileSha256;
  node.inputsDB.manifestCanonicalSha256 = builtCohort.manifestCanonicalSha256;
}
const reviewCanaryPath = path.join(tmp, 'review-flow.json');
const reviewCanaryRaw = `${JSON.stringify(reviewCanary, null, 2)}\n`;
fs.writeFileSync(reviewCanaryPath, reviewCanaryRaw, 'utf8');
const reviewCanarySha256 = rollback.digest(reviewCanaryRaw);

const validation = spawnSync(process.execPath, [
  path.join(__dirname, 'deploy-grain-flow-canary.js'), '--validate-only', '--review-fixture',
], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    GRAIN_FLOW_CANONICAL: reviewCanaryPath,
    GRAIN_HEVC_COHORT_MANIFEST: cohortPath,
    GRAIN_REVIEW_FIXTURE_CANONICAL_SHA256: reviewCanarySha256,
  },
});
assert.strictEqual(validation.status, 0,
  `r34 deployment validation failed: ${validation.stderr || validation.stdout}`);
assert(validation.stdout.includes('PASS validated r34 AV1 80/70 HEVC-off deployment payload'));

const alteredCanaryPath = path.join(os.tmpdir(), `tdarr-r34-altered-canary-${process.pid}.json`);
const alteredCanary = JSON.parse(reviewCanaryRaw);
alteredCanary.name = `${alteredCanary.name || 'r34'}-unreviewed`;
fs.writeFileSync(alteredCanaryPath, JSON.stringify(alteredCanary));
try {
  const alteredValidation = spawnSync(process.execPath, [
    path.join(__dirname, 'deploy-grain-flow-canary.js'), '--validate-only', '--review-fixture',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      GRAIN_FLOW_CANONICAL: alteredCanaryPath,
      GRAIN_HEVC_COHORT_MANIFEST: cohortPath,
      GRAIN_REVIEW_FIXTURE_CANONICAL_SHA256: reviewCanarySha256,
    },
  });
  assert.notStrictEqual(alteredValidation.status, 0,
    'deployment validation must reject altered Flow bytes');
  assert((alteredValidation.stderr || alteredValidation.stdout)
    .includes('canonical Flow bytes differ from the exact reviewed r34 structure'));
} finally {
  fs.unlinkSync(alteredCanaryPath);
}

try {
  const rollbackBaseline = JSON.parse(canonicalRaw);
  rollbackBaseline.name = `${rollbackBaseline.name}-pre-r34-rollback-baseline`;
  const hevcIds = new Set(['activateHevcFallback1', 'activateHevcPrior1']);
  rollbackBaseline.flowPlugins = rollbackBaseline.flowPlugins.filter((node) => !hevcIds.has(node.id));
  rollbackBaseline.flowEdges = rollbackBaseline.flowEdges.filter((edge) =>
    !hevcIds.has(edge.source) && !hevcIds.has(edge.target));
  rollbackBaseline.flowEdges.push(
    {
      id: 'rollback-baseline-extract-to-lock',
      source: 'extract1',
      sourceHandle: '1',
      target: 'gpuLockAcquire1',
      targetHandle: null,
    },
    {
      id: 'rollback-baseline-terminal-to-learn',
      source: 'retry1',
      sourceHandle: '2',
      target: 'learn1',
      targetHandle: null,
    },
  );
  assert.strictEqual(rollbackBaseline.flowPlugins.length, 37);
  assert.strictEqual(rollbackBaseline.flowEdges.length, 59);
  const rollbackBaselineRaw = JSON.stringify(rollbackBaseline);
  const databasePath = path.join(tmp, 'database.db');
  const backupRoot = path.join(tmp, 'backups');
  fs.mkdirSync(backupRoot);
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE flowsjsondb (id TEXT PRIMARY KEY, json_data TEXT NOT NULL, timestamp INTEGER)');
  db.prepare('INSERT INTO flowsjsondb (id, json_data, timestamp) VALUES (?, ?, ?)')
    .run(rollback.FLOW_ID, canaryRaw, 1);
  db.close();

  const backupPath = path.join(backupRoot, 'pre-canary.json');
  fs.writeFileSync(backupPath, `${rollbackBaselineRaw}\n`);
  const receiptPath = path.join(backupRoot, 'deployment-receipt.json');
  fs.writeFileSync(receiptPath, JSON.stringify({
    schema: rollback.RECEIPT_SCHEMA,
    release_id: rollback.RELEASE_ID,
    flow_id: rollback.FLOW_ID,
    deployed_payload_sha256: rollback.digest(canaryRaw),
    canonical_structure_sha256: rollback.EXPECTED_CANONICAL_STRUCTURE_SHA256,
    cohort_file_sha256: cohort._physical_sha256,
    backup_path: backupPath,
    backup_sha256: rollback.digest(rollbackBaselineRaw),
  }));
  const authenticated = rollback.validateReceipt(receiptPath, backupRoot);
  assert.strictEqual(authenticated.backup.raw, rollbackBaselineRaw);
  const wrongCanonicalReceiptPath = path.join(backupRoot, 'wrong-canonical-receipt.json');
  fs.writeFileSync(wrongCanonicalReceiptPath, JSON.stringify({
    ...authenticated.receipt,
    canonical_structure_sha256: '0'.repeat(64),
  }));
  assert.throws(() => rollback.validateReceipt(wrongCanonicalReceiptPath, backupRoot),
    /canonical r32 Flow digest mismatch/,
    'receipt validation must reject a payload not bound to the reviewed r32 Flow structure');
  const missingCanonicalReceiptPath = path.join(backupRoot, 'missing-canonical-receipt.json');
  const missingCanonicalReceipt = { ...authenticated.receipt };
  delete missingCanonicalReceipt.canonical_structure_sha256;
  fs.writeFileSync(missingCanonicalReceiptPath, JSON.stringify(missingCanonicalReceipt));
  assert.throws(() => rollback.validateReceipt(missingCanonicalReceiptPath, backupRoot),
    /canonical r32 Flow digest mismatch/,
    'receipt validation must require the reviewed r32 Flow structure digest');
  assert.throws(() => requeue.validateLiveDeployment(databasePath, authenticated, cohort),
    /HEVC activation adapter is not enabled/,
    'a toggle-disabled Flow must never authorize the frozen HEVC cohort requeue');
  assert.throws(() => requeue.parseArguments(['--apply']), /requires --receipt/,
    'apply must refuse to run without the exact deployment receipt');
  assert.deepStrictEqual(requeue.parseArguments(['--apply', '--receipt', receiptPath]),
    { apply: true, receiptPath });

  const result = rollback.restoreDatabase({
    databasePath,
    backupRoot,
    backupRaw: rollbackBaselineRaw,
    expectedLiveSha256: rollback.digest(canaryRaw),
    now: new Date('2026-09-03T00:00:00.000Z'),
  });
  assert.strictEqual(result.restoredSha256, rollback.digest(rollbackBaselineRaw));
  assert.strictEqual(fs.readFileSync(result.preRollbackPath, 'utf8').trim(), canaryRaw,
    'rollback rehearsal did not preserve the pre-rollback canary payload');
  const verify = new DatabaseSync(databasePath, { readOnly: true });
  const row = verify.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(rollback.FLOW_ID);
  verify.close();
  assert.strictEqual(row.json_data, rollbackBaselineRaw,
    'rollback rehearsal did not restore the exact pre-canary canonical payload');
  assert.throws(() => requeue.validateLiveDeployment(databasePath, authenticated, cohort),
    /live Flow differs from the exact r32 deployed payload receipt/,
    'requeue must reject the AV1-only baseline even when its manifest and helper are available');
  assert.throws(() => rollback.restoreDatabase({
    databasePath,
    backupRoot,
    backupRaw: rollbackBaselineRaw,
    expectedLiveSha256: rollback.digest(canaryRaw),
    now: new Date('2026-09-03T00:00:01.000Z'),
  }), /live Flow is not the exact r32 HEVC canary/,
  'rollback must refuse to overwrite a non-canary concurrent Flow state');

  const mutatedCanary = JSON.parse(canaryRaw);
  mutatedCanary.name = `${mutatedCanary.name || 'canary'}-concurrent-edit`;
  const mutatedCanaryRaw = JSON.stringify(mutatedCanary);
  const mutate = new DatabaseSync(databasePath);
  mutate.prepare('UPDATE flowsjsondb SET json_data = ?, timestamp = ? WHERE id = ?')
    .run(mutatedCanaryRaw, 2, rollback.FLOW_ID);
  mutate.close();
  assert.throws(() => rollback.restoreDatabase({
    databasePath,
    backupRoot,
    backupRaw: rollbackBaselineRaw,
    expectedLiveSha256: rollback.digest(canaryRaw),
    now: new Date('2026-09-03T00:00:02.000Z'),
  }), /differs from the exact deployed payload receipt/,
  'rollback must reject a concurrent Flow edit even when the adapter remains present');

  const pauseReceiptPath = path.join(backupRoot, 'pause-receipt.json');
  const pauseReceipt = {
    schema: drain.RECEIPT_SCHEMA,
    created_utc: '2026-09-03T00:00:03.000Z',
    prior_global_pause: false,
    nodes: { node1: { nodePaused: false, workerLimits: { transcodegpu: 4 } } },
  };
  fs.writeFileSync(pauseReceiptPath, `${JSON.stringify(pauseReceipt)}\n`);
  const archivedPauseReceipt = drain.archiveReceipt(pauseReceiptPath, pauseReceipt);
  assert.strictEqual(fs.existsSync(pauseReceiptPath), false,
    'successful resume must retire the active pause receipt so a future drain can run');
  assert.strictEqual(JSON.parse(fs.readFileSync(archivedPauseReceipt, 'utf8')).schema,
    drain.RECEIPT_SCHEMA, 'retired pause receipt archive was not preserved exactly');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('PASS r34 HEVC-off Flow deployment validation, disabled-requeue guard, and isolated rollback rehearsal');
