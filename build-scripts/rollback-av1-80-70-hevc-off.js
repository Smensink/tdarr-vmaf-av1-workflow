'use strict';

// Receipt-bound rollback for r34 AV1 80/70 + HEVC-off deployment.
// Restoring the exact pre-r34 Flow may re-enable both preserved HEVC adapters,
// so that outcome requires a per-invocation acknowledgement naming them.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const quiescence = require('./assert-tdarr-quiescence.js');

const FLOW_ID = 'YR5PZ1QaD';
const RELEASE_ID = 'r34-20260904T060333Z-startup-canonical-protection';
const RECEIPT_SCHEMA = 'tdarr-av1-80-70-hevc-off-deployment-receipt/v1';
const EXPECTED_CANONICAL_STRUCTURE_SHA256 =
  'f9e485ccf5d5e89222c3621ad295362a32e283f00e09909ac72cf991cca987ca';
const DEFAULT_DATABASE = '/app/server/Tdarr/DB2/SQL/database.db';
const DEFAULT_BACKUP_ROOT = '/app/configs/backups';
const HEVC_ADAPTER_IDS = ['activateHevcFallback1', 'activateHevcPrior1'];
const HEVC_REENABLE_ACK_FLAG = '--acknowledge-hevc-reenable';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function directRegularFile(filePath, root) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(String(filePath || ''));
  assert(resolved.startsWith(`${resolvedRoot}${path.sep}`),
    'rollback artifact escaped the configured backup root');
  const lstat = fs.lstatSync(resolved);
  assert(lstat.isFile() && !lstat.isSymbolicLink(),
    'rollback artifact is not a direct regular file');
  assert.strictEqual(path.resolve(fs.realpathSync(resolved)), resolved,
    'rollback artifact contains a symlinked path component');
  assert(lstat.size > 0 && lstat.size <= 2 * 1024 * 1024,
    'rollback artifact is empty or unexpectedly large');
  return resolved;
}

function adapterState(flow) {
  assert(Array.isArray(flow.flowPlugins) && Array.isArray(flow.flowEdges),
    'rollback Flow is not a valid Flow payload');
  const byId = new Map(flow.flowPlugins.map((node) => [node.id, node]));
  const enabledHevcAdapters = [];
  for (const id of HEVC_ADAPTER_IDS) {
    const node = byId.get(id);
    assert(node && node.inputsDB, `rollback Flow is missing preserved adapter ${id}`);
    const value = node.inputsDB.enabled;
    if (value === true || String(value).trim().toLowerCase() === 'true') {
      enabledHevcAdapters.push(id);
    }
  }
  return enabledHevcAdapters;
}

function parseHevcReenableAcknowledgement(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const flagIndexes = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === HEVC_REENABLE_ACK_FLAG) flagIndexes.push(index);
  }
  assert(flagIndexes.length <= 1, `${HEVC_REENABLE_ACK_FLAG} may be supplied only once`);
  if (flagIndexes.length === 0) return [];

  const value = args[flagIndexes[0] + 1];
  assert(typeof value === 'string' && value.length > 0 && !value.startsWith('--'),
    `${HEVC_REENABLE_ACK_FLAG} requires a comma-separated adapter list`);
  const adapterIds = value.split(',').map((id) => id.trim());
  assert(adapterIds.every(Boolean),
    `${HEVC_REENABLE_ACK_FLAG} contains an empty adapter ID`);
  assert.strictEqual(new Set(adapterIds).size, adapterIds.length,
    `${HEVC_REENABLE_ACK_FLAG} contains a duplicate adapter ID`);
  for (const id of adapterIds) {
    assert(HEVC_ADAPTER_IDS.includes(id),
      `${HEVC_REENABLE_ACK_FLAG} contains unknown HEVC adapter ${id}`);
  }
  return adapterIds;
}

function requireHevcReenableLatch(enabledHevcAdapters, acknowledgedHevcAdapters) {
  const enabled = [...enabledHevcAdapters].sort();
  const acknowledged = Array.isArray(acknowledgedHevcAdapters)
    ? [...acknowledgedHevcAdapters].sort()
    : [];
  assert.deepStrictEqual(acknowledged, enabled,
    `${HEVC_REENABLE_ACK_FLAG} must exactly name enabled HEVC adapters; `
    + `expected ${enabled.length > 0 ? enabled.join(',') : '(none)'}`);
}

function validateBackup(backupPath, backupRoot, options = {}) {
  const resolved = directRegularFile(backupPath, backupRoot);
  const raw = fs.readFileSync(resolved, 'utf8').trim();
  const flow = JSON.parse(raw);
  assert.strictEqual(flow._id, FLOW_ID, 'rollback backup Flow ID mismatch');
  const enabledHevcAdapters = adapterState(flow);
  requireHevcReenableLatch(enabledHevcAdapters, options.acknowledgedHevcAdapters);
  return { path: resolved, raw, flow, enabledHevcAdapters };
}

function validateReceipt(receiptPath, backupRoot, options = {}) {
  const resolved = directRegularFile(receiptPath, backupRoot);
  const receipt = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  assert.strictEqual(receipt.schema, RECEIPT_SCHEMA, 'deployment receipt schema mismatch');
  assert.strictEqual(receipt.release_id, RELEASE_ID, 'deployment receipt release mismatch');
  assert.strictEqual(receipt.flow_id, FLOW_ID, 'deployment receipt Flow ID mismatch');
  assert.strictEqual(receipt.canonical_structure_sha256, EXPECTED_CANONICAL_STRUCTURE_SHA256,
    'deployment receipt canonical r34 Flow digest mismatch');
  assert(/^[0-9a-f]{64}$/.test(String(receipt.deployed_payload_sha256 || '')),
    'deployment receipt deployed hash is invalid');
  assert(/^[0-9a-f]{64}$/.test(String(receipt.backup_sha256 || '')),
    'deployment receipt backup hash is invalid');
  assert(/^[0-9a-f]{64}$/.test(String(receipt.cohort_file_sha256 || '')),
    'deployment receipt cohort hash is invalid');
  const backup = validateBackup(receipt.backup_path, backupRoot, options);
  assert.strictEqual(digest(backup.raw), receipt.backup_sha256,
    'deployment receipt backup digest mismatch');
  return { path: resolved, receipt, backup };
}

function assertExactR33LiveFlow(flow) {
  assert.strictEqual(flow._id, FLOW_ID, 'live Flow ID mismatch');
  const byId = new Map((flow.flowPlugins || []).map((node) => [node.id, node]));
  for (const id of HEVC_ADAPTER_IDS) {
    const node = byId.get(id);
    assert(node && node.inputsDB, `live r34 Flow is missing ${id}`);
    assert.strictEqual(node.inputsDB.enabled, false,
      `live r34 Flow does not have strict boolean false at ${id}`);
  }
}

function restoreDatabase(options) {
  const databasePath = path.resolve(options.databasePath);
  const backupRoot = path.resolve(options.backupRoot);
  const backupRaw = String(options.backupRaw || '').trim();
  const expectedLiveSha256 = String(options.expectedLiveSha256 || '');
  const acknowledgedHevcAdapters = options.acknowledgedHevcAdapters;
  assert(/^[0-9a-f]{64}$/.test(expectedLiveSha256),
    'expected live deployment hash is invalid');

  const backup = JSON.parse(backupRaw);
  assert.strictEqual(backup._id, FLOW_ID, 'rollback payload Flow ID mismatch');
  const enabledHevcAdapters = adapterState(backup);
  requireHevcReenableLatch(enabledHevcAdapters, acknowledgedHevcAdapters);

  const db = new DatabaseSync(databasePath);
  let transactionOpen = false;
  try {
    db.exec('PRAGMA busy_timeout = 30000');
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(FLOW_ID);
    assert(row && typeof row.json_data === 'string', 'live Flow row is missing');
    const live = JSON.parse(row.json_data);
    assertExactR33LiveFlow(live);
    assert.strictEqual(digest(row.json_data), expectedLiveSha256,
      'refusing rollback because the live Flow differs from the exact r34 deployed payload receipt');

    const now = options.now instanceof Date ? options.now : new Date();
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const preRollbackPath = path.join(
      backupRoot, `flow_${FLOW_ID}.pre-r34-rollback-${stamp}.json`
    );
    fs.writeFileSync(
      preRollbackPath,
      row.json_data.endsWith('\n') ? row.json_data : `${row.json_data}\n`,
      { encoding: 'utf8', flag: 'wx' }
    );

    const update = db.prepare(
      'UPDATE flowsjsondb SET json_data = ?, timestamp = ? WHERE id = ?'
    ).run(backupRaw, now.getTime(), FLOW_ID);
    assert.strictEqual(Number(update.changes), 1,
      'rollback did not update exactly one Flow row');
    const inside = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(FLOW_ID);
    assert(inside && inside.json_data === backupRaw,
      'transactional rollback read-back differs from the exact backup payload');
    db.exec('COMMIT');
    transactionOpen = false;

    const saved = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(FLOW_ID);
    assert(saved && saved.json_data === backupRaw,
      'post-commit rollback read-back differs from the exact backup payload');
    return {
      restoredSha256: digest(backupRaw),
      preRollbackPath,
      restoredRaw: saved.json_data,
      enabledHevcAdapters,
    };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch (_) { /* best effort */ }
    }
    throw error;
  } finally {
    db.close();
  }
}

async function main() {
  assert.strictEqual(process.env.ALLOW_R33_FLOW_ROLLBACK, '1',
    'refusing rollback without ALLOW_R33_FLOW_ROLLBACK=1');
  const receiptIndex = process.argv.indexOf('--receipt');
  const receiptArgument = receiptIndex >= 0 ? process.argv[receiptIndex + 1] : '';
  assert(receiptArgument, '--receipt is required');
  const databasePath = process.env.GRAIN_FLOW_DATABASE || DEFAULT_DATABASE;
  const backupRoot = process.env.GRAIN_FLOW_BACKUP_ROOT || DEFAULT_BACKUP_ROOT;
  const acknowledgedHevcAdapters = parseHevcReenableAcknowledgement(process.argv.slice(2));
  const authenticated = validateReceipt(receiptArgument, backupRoot, {
    acknowledgedHevcAdapters,
  });

  await quiescence.assertTdarrQuiescence(quiescence.configFromEnv());
  const result = restoreDatabase({
    databasePath,
    backupRoot,
    backupRaw: authenticated.backup.raw,
    expectedLiveSha256: authenticated.receipt.deployed_payload_sha256,
    acknowledgedHevcAdapters,
  });
  console.log(`PASS rolled back r34 Flow ${FLOW_ID}`);
  console.log(`Restored SHA-256: ${result.restoredSha256}`);
  console.log(`Pre-rollback snapshot: ${result.preRollbackPath}`);
  if (result.enabledHevcAdapters.length > 0) {
    console.log(`HEVC adapters explicitly re-enabled: ${result.enabledHevcAdapters.join(', ')}`);
  }
}

module.exports = {
  FLOW_ID,
  RELEASE_ID,
  RECEIPT_SCHEMA,
  EXPECTED_CANONICAL_STRUCTURE_SHA256,
  HEVC_ADAPTER_IDS,
  HEVC_REENABLE_ACK_FLAG,
  adapterState,
  assertExactR33LiveFlow,
  digest,
  directRegularFile,
  parseHevcReenableAcknowledgement,
  requireHevcReenableLatch,
  restoreDatabase,
  validateBackup,
  validateReceipt,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`FAIL r34 Flow rollback: ${error.message}`);
    process.exitCode = 1;
  });
}
