'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const rollback = require('./rollback-av1-80-70-hevc-off.js');

function flowWithHevcAdapters(enabled) {
  return {
    _id: rollback.FLOW_ID,
    flowPlugins: rollback.HEVC_ADAPTER_IDS.map((id) => ({
      id,
      inputsDB: { enabled },
    })),
    flowEdges: [],
  };
}

const r34Raw = JSON.stringify(flowWithHevcAdapters(false));
const r32Path = path.join(__dirname, 'fixtures', 'r32-hevc-enabled-flow.json');
const r32Raw = fs.readFileSync(r32Path, 'utf8').trim();
const r32 = JSON.parse(r32Raw);
assert.strictEqual(r32.fixture_notice,
  'Synthetic review fixture only; contains no production Flow metadata.');
for (const id of ['activateHevcFallback1', 'activateHevcPrior1']) {
  const node = r32.flowPlugins.find((item) => item.id === id);
  assert(node, `r32 rollback fixture missing ${id}`);
  assert.strictEqual(node.inputsDB.enabled, true, `r32 rollback fixture must enable ${id}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-r34-rollback-test-'));
try {
  const backupRoot = path.join(root, 'backups');
  fs.mkdirSync(backupRoot);
  const backupPath = path.join(backupRoot, 'flow-pre-r34.json');
  fs.writeFileSync(backupPath, `${r32Raw}\n`, { encoding: 'utf8' });
  const receiptPath = path.join(backupRoot, 'receipt.json');
  const receipt = {
    schema: rollback.RECEIPT_SCHEMA,
    release_id: rollback.RELEASE_ID,
    flow_id: rollback.FLOW_ID,
    deployed_payload_sha256: rollback.digest(r34Raw),
    canonical_structure_sha256: rollback.EXPECTED_CANONICAL_STRUCTURE_SHA256,
    cohort_file_sha256: 'a'.repeat(64),
    backup_path: backupPath,
    backup_sha256: rollback.digest(r32Raw),
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8' });

  const previousStaleLatch = process.env.ALLOW_R33_ROLLBACK_REENABLE_HEVC;
  try {
    process.env.ALLOW_R33_ROLLBACK_REENABLE_HEVC = '1';
    const staleEnvOnlyAcknowledgement = rollback.parseHevcReenableAcknowledgement([]);
    assert.deepStrictEqual(staleEnvOnlyAcknowledgement, [],
      'the retired environment latch must not create a per-invocation acknowledgement');
    assert.throws(
      () => rollback.validateReceipt(receiptPath, backupRoot, {
        acknowledgedHevcAdapters: staleEnvOnlyAcknowledgement,
      }),
      /--acknowledge-hevc-reenable/,
      'a stale exported environment variable alone must not authorise HEVC re-enable'
    );
  } finally {
    if (previousStaleLatch === undefined) {
      delete process.env.ALLOW_R33_ROLLBACK_REENABLE_HEVC;
    } else {
      process.env.ALLOW_R33_ROLLBACK_REENABLE_HEVC = previousStaleLatch;
    }
  }

  const acknowledgedHevcAdapters = rollback.parseHevcReenableAcknowledgement([
    '--acknowledge-hevc-reenable',
    'activateHevcPrior1,activateHevcFallback1',
  ]);
  const authenticated = rollback.validateReceipt(receiptPath, backupRoot, {
    acknowledgedHevcAdapters,
  });
  assert.strictEqual(authenticated.backup.raw, r32Raw);
  assert.deepStrictEqual(authenticated.backup.enabledHevcAdapters.sort(),
    ['activateHevcFallback1', 'activateHevcPrior1']);
  assert.throws(
    () => rollback.validateReceipt(receiptPath, backupRoot, {
      acknowledgedHevcAdapters: ['activateHevcFallback1'],
    }),
    /must exactly name enabled HEVC adapters/,
    'an acknowledgement must name every adapter the rollback will re-enable'
  );

  const disabledBackupPath = path.join(backupRoot, 'flow-hevc-disabled.json');
  fs.writeFileSync(disabledBackupPath, `${r34Raw}\n`, { encoding: 'utf8' });
  const disabledReceiptPath = path.join(backupRoot, 'disabled-receipt.json');
  fs.writeFileSync(disabledReceiptPath, `${JSON.stringify({
    ...receipt,
    backup_path: disabledBackupPath,
    backup_sha256: rollback.digest(r34Raw),
  }, null, 2)}\n`, { encoding: 'utf8' });
  const disabledAuthenticated = rollback.validateReceipt(disabledReceiptPath, backupRoot, {
    acknowledgedHevcAdapters: rollback.parseHevcReenableAcknowledgement([]),
  });
  assert.deepStrictEqual(disabledAuthenticated.backup.enabledHevcAdapters, [],
    'a backup with both HEVC adapters disabled must succeed without acknowledgement');

  const disabledDatabasePath = path.join(root, 'disabled-database.db');
  const disabledDb = new DatabaseSync(disabledDatabasePath);
  disabledDb.exec(
    'CREATE TABLE flowsjsondb (id TEXT PRIMARY KEY, json_data TEXT NOT NULL, timestamp INTEGER)'
  );
  disabledDb.prepare('INSERT INTO flowsjsondb (id, json_data, timestamp) VALUES (?, ?, ?)')
    .run(rollback.FLOW_ID, r34Raw, 1);
  disabledDb.close();
  const disabledRestored = rollback.restoreDatabase({
    databasePath: disabledDatabasePath,
    backupRoot,
    backupRaw: disabledAuthenticated.backup.raw,
    expectedLiveSha256: receipt.deployed_payload_sha256,
    acknowledgedHevcAdapters: [],
    now: new Date('2026-09-04T05:39:00Z'),
  });
  assert.strictEqual(disabledRestored.restoredRaw, r34Raw,
    'a rollback that keeps both HEVC adapters disabled must complete without acknowledgement');

  const badReceiptPath = path.join(backupRoot, 'bad-receipt.json');
  fs.writeFileSync(badReceiptPath, JSON.stringify({
    ...receipt,
    backup_sha256: 'b'.repeat(64),
  }));
  assert.throws(
    () => rollback.validateReceipt(badReceiptPath, backupRoot, { acknowledgedHevcAdapters }),
    /backup digest mismatch/,
    'receipt/backup digest mismatch must fail closed'
  );

  const databasePath = path.join(root, 'database.db');
  let db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE flowsjsondb (id TEXT PRIMARY KEY, json_data TEXT NOT NULL, timestamp INTEGER)');
  db.prepare('INSERT INTO flowsjsondb (id, json_data, timestamp) VALUES (?, ?, ?)')
    .run(rollback.FLOW_ID, r34Raw, 1);
  db.close();

  assert.throws(() => rollback.restoreDatabase({
    databasePath,
    backupRoot,
    backupRaw: authenticated.backup.raw,
    expectedLiveSha256: 'c'.repeat(64),
    acknowledgedHevcAdapters,
    now: new Date('2026-09-04T05:40:00Z'),
  }), /differs from the exact r34 deployed payload receipt/,
  'a changed live Flow must block rollback');

  const restored = rollback.restoreDatabase({
    databasePath,
    backupRoot,
    backupRaw: authenticated.backup.raw,
    expectedLiveSha256: receipt.deployed_payload_sha256,
    acknowledgedHevcAdapters,
    now: new Date('2026-09-04T05:41:00Z'),
  });
  assert.strictEqual(restored.restoredRaw, r32Raw);
  assert.strictEqual(restored.restoredSha256, receipt.backup_sha256);
  assert(fs.existsSync(restored.preRollbackPath), 'pre-rollback r34 snapshot was not retained');

  db = new DatabaseSync(databasePath, { readOnly: true });
  const saved = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(rollback.FLOW_ID);
  db.close();
  assert.strictEqual(saved.json_data, r32Raw,
    'post-rollback database does not contain the exact authenticated r32 payload');

  console.log('PASS r34 rollback requires per-invocation exact HEVC acknowledgement and restores exactly');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
