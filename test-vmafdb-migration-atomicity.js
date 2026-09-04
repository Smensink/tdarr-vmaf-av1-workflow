'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const sqlite = require('node:sqlite');

const helperPath = path.resolve(
  __dirname, 'custom-cont-init.d', 'vmaf-plugin-patches', '_lib', 'vmafdb.js'
);
const dbModule = require(helperPath);
const dbPath = path.join(os.tmpdir(), `vmafdb-migration-atomicity-${process.pid}-${Date.now()}.db`);
const deliveryTriggers = [
  'trg_jobs_candidate_ready_insert_guard',
  'trg_jobs_candidate_ready_update_guard',
  'trg_jobs_delivery_committing_insert_guard',
  'trg_jobs_delivery_committing_update_guard',
  'trg_jobs_delivered_insert_guard',
  'trg_jobs_delivered_update_guard',
  'trg_jobs_delivery_stage_transition_guard',
  'trg_jobs_delivered_immutable',
];

function userVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function existingDeliveryTriggers(db) {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (" +
    deliveryTriggers.map(() => '?').join(', ') + ') ORDER BY name'
  ).all(...deliveryTriggers).map((row) => row.name);
}

let db;
let faultHandle;
const originalLoad = Module._load;
try {
  db = dbModule.openDb(dbPath);
  assert.strictEqual(userVersion(db), dbModule.SCHEMA_VERSION);
  assert.strictEqual(existingDeliveryTriggers(db).length, deliveryTriggers.length);

  for (const trigger of deliveryTriggers) db.exec(`DROP TRIGGER ${trigger};`);
  db.exec('PRAGMA user_version = 16;');
  assert.deepStrictEqual(existingDeliveryTriggers(db), []);
  db.close();
  db = null;

  let createCount = 0;
  let injected = false;
  class FaultInjectingDatabaseSync extends sqlite.DatabaseSync {
    constructor(...args) {
      super(...args);
      faultHandle = this;
    }

    exec(sql) {
      const statement = String(sql).trim();
      if (/^CREATE TRIGGER IF NOT EXISTS trg_jobs_/.test(statement)) {
        createCount += 1;
        if (!injected && createCount === 3) {
          injected = true;
          throw new Error('injected v17 trigger creation failure');
        }
      }
      return super.exec(sql);
    }
  }

  Module._load = function loadWithFault(request, parent, isMain) {
    if (request === 'node:sqlite') return { DatabaseSync: FaultInjectingDatabaseSync };
    return originalLoad.call(this, request, parent, isMain);
  };

  assert.throws(
    () => dbModule.openDb(dbPath),
    /injected v17 trigger creation failure/
  );
  Module._load = originalLoad;

  assert(injected, 'the v17 trigger creation fault must be injected');
  assert.strictEqual(userVersion(faultHandle), 16,
    'a failed migration must retain its original user_version');
  assert.deepStrictEqual(existingDeliveryTriggers(faultHandle), [],
    'a failed migration must roll back triggers created earlier in the same version step');
  faultHandle.close();
  faultHandle = null;

  db = dbModule.openDb(dbPath);
  assert.strictEqual(userVersion(db), 17,
    'a normal reopen must complete the v16 to v17 migration');
  assert.strictEqual(existingDeliveryTriggers(db).length, deliveryTriggers.length);

  const reopened = dbModule.openDb(dbPath);
  assert.strictEqual(reopened, db, 'openDb must remain idempotent at the current schema version');
  assert.strictEqual(userVersion(reopened), 17);

  console.log('PASS schema migration steps are atomic and current-version reopen is idempotent');
} finally {
  Module._load = originalLoad;
  if (faultHandle) {
    try { faultHandle.close(); } catch (_) {}
  }
  if (db) {
    try { db.close(); } catch (_) {}
  }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch (_) {}
  }
}
