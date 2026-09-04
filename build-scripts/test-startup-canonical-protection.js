'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const releaseRoot = path.resolve(__dirname, '..');
const exporter = path.join(releaseRoot, 'custom-cont-init.d', 'export-vmaf-flow-definition.js');
const migration = path.join(
  releaseRoot,
  'custom-cont-init.d',
  'update-vmaf-flow-nvenc-lock-scope.js',
);
const startupHook = path.join(releaseRoot, 'custom-cont-init.d', '96-apply-vmaf-nvenc-lock-scope.sh');
const canonical = path.join(releaseRoot, 'configs', 'flow_YR5PZ1QaD_CANONICAL.json');
const FLOW_ID = 'YR5PZ1QaD';
const RELEASE_ID = 'gpuLockReleaseSamples1';
const APPLY_ENV = 'ALLOW_TDARR_NVENC_LOCK_SCOPE_MIGRATION';
const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function createFlowDatabase(databasePath, flow) {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('CREATE TABLE flowsjsondb (id TEXT PRIMARY KEY, json_data TEXT NOT NULL, timestamp INTEGER)');
    db.prepare('INSERT INTO flowsjsondb (id, json_data, timestamp) VALUES (?, ?, ?)')
      .run(FLOW_ID, JSON.stringify(flow), 1);
  } finally {
    db.close();
  }
}

function readFlowJson(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(FLOW_ID).json_data;
  } finally {
    db.close();
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-canonical-export-guard-'));
try {
  const target = path.join(root, 'canonical.json');
  const original = fs.readFileSync(canonical);
  fs.writeFileSync(target, original);
  const before = digest(fs.readFileSync(target));

  for (const environment of [
    {},
    { ALLOW_TDARR_CANONICAL_FLOW_EXPORT: '1' },
  ]) {
    const result = spawnSync(process.execPath, [exporter], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...environment,
        TDARR_SQL_DB: path.join(root, 'must-not-be-opened.db'),
        TDARR_CANONICAL_FLOW_TARGET: target,
      },
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /SKIP: explicit .* and --apply required/);
    assert.strictEqual(digest(fs.readFileSync(target)), before,
      'unlatched canonical exporter modified its target');
    assert(!fs.existsSync(path.join(root, 'must-not-be-opened.db')),
      'unlatched canonical exporter opened or created the database');
  }

  const hook = fs.readFileSync(startupHook, 'utf8');
  assert(hook.includes('export-vmaf-flow-definition.js'),
    'startup regression fixture no longer exercises the legacy exporter call');
  assert(!hook.includes('ALLOW_TDARR_CANONICAL_FLOW_EXPORT=1'),
    'startup hook must not authorize canonical export');
  assert(!/export-vmaf-flow-definition\.js[^\n]*--apply/.test(hook),
    'startup hook must not pass the canonical export apply flag');

  assert(!/^\s*node\s+[^\n]*update-vmaf-flow-nvenc-lock-scope\.js[^\n]*$/m.test(hook),
    'startup hook must not invoke the NVENC lock-scope migration');
  assert(!hook.includes(`${APPLY_ENV}=1`),
    'startup hook must not authorize the NVENC lock-scope migration');

  const rolledBackFlow = {
    _id: FLOW_ID,
    flowPlugins: [
      { id: 'test1', pluginName: 'testEncodingParameters' },
      { id: 'vmaf1', pluginName: 'calculateVMAF' },
    ],
    flowEdges: [
      { id: 'edge4-rolled-back-test-to-vmaf', source: 'test1', sourceHandle: '1', target: 'vmaf1' },
    ],
  };
  const alreadyMigratedFlow = {
    _id: FLOW_ID,
    flowPlugins: [
      { id: 'test1', pluginName: 'testEncodingParameters' },
      { id: RELEASE_ID, pluginName: 'releaseGpuPipelineLock' },
      { id: 'vmaf1', pluginName: 'calculateVMAF' },
    ],
    flowEdges: [
      { id: 'edgeLockA_release_in', source: 'test1', sourceHandle: '1', target: RELEASE_ID },
      { id: 'edgeLockA_release_to_vmaf', source: RELEASE_ID, sourceHandle: '1', target: 'vmaf1' },
    ],
  };
  assert(!rolledBackFlow.flowPlugins.some((plugin) => plugin.id === RELEASE_ID),
    'rolled-back regression fixture unexpectedly contains the release node');

  for (const [label, flow] of [
    ['rolled-back', rolledBackFlow],
    ['already-migrated', alreadyMigratedFlow],
  ]) {
    const databasePath = path.join(root, `${label}.db`);
    createFlowDatabase(databasePath, flow);
    const flowBefore = digest(Buffer.from(readFlowJson(databasePath), 'utf8'));
    const databaseBefore = digest(fs.readFileSync(databasePath));
    const boot = spawnSync('bash', [startupHook], {
      encoding: 'utf8',
      env: {
        ...process.env,
        [APPLY_ENV]: '0',
        ALLOW_TDARR_CANONICAL_FLOW_EXPORT: '0',
        TDARR_CUSTOM_CONT_INIT_DIR: path.dirname(startupHook),
        TDARR_SQL_DB: databasePath,
        TDARR_CANONICAL_FLOW_TARGET: target,
      },
    });
    assert.strictEqual(boot.status, 0, boot.stderr || boot.stdout);
    assert.strictEqual(
      digest(Buffer.from(readFlowJson(databasePath), 'utf8')),
      flowBefore,
      `startup changed the ${label} live Flow SHA-256`,
    );
    assert.strictEqual(digest(fs.readFileSync(databasePath)), databaseBefore,
      `startup wrote to the ${label} flowsjsondb database`);
  }

  for (const variant of [
    { label: 'no authorization', environment: {}, args: [] },
    { label: 'environment only', environment: { [APPLY_ENV]: '1' }, args: [] },
    { label: 'flag only', environment: {}, args: ['--apply'] },
  ]) {
    const databasePath = path.join(root, `unlatched-${variant.label.replaceAll(' ', '-')}.db`);
    createFlowDatabase(databasePath, rolledBackFlow);
    const beforeMigration = digest(fs.readFileSync(databasePath));
    const result = spawnSync(process.execPath, [migration, ...variant.args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        [APPLY_ENV]: '0',
        ...variant.environment,
        TDARR_SQL_DB: databasePath,
      },
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /SKIP: explicit .* and --apply required/);
    assert.strictEqual(digest(fs.readFileSync(databasePath)), beforeMigration,
      `${variant.label} migration authorization wrote flowsjsondb`);
  }

  const explicitDatabase = path.join(root, 'explicit-operator-migration.db');
  const explicitBackup = path.join(root, 'explicit-operator-migration.backup.db');
  createFlowDatabase(explicitDatabase, rolledBackFlow);
  const explicit = spawnSync(process.execPath, [migration, '--apply'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      [APPLY_ENV]: '1',
      TDARR_SQL_DB: explicitDatabase,
      TDARR_NVENC_LOCK_SCOPE_BACKUP: explicitBackup,
    },
  });
  assert.strictEqual(explicit.status, 0, explicit.stderr || explicit.stdout);
  const migrated = JSON.parse(readFlowJson(explicitDatabase));
  assert(migrated.flowPlugins.some(
    (plugin) => plugin.id === RELEASE_ID && plugin.pluginName === 'releaseGpuPipelineLock',
  ), 'dual-authorized operator migration did not add the NVENC release node');
  assert(fs.existsSync(explicitBackup), 'operator migration did not create a fresh backup');
  assert(!JSON.parse(readFlowJson(explicitBackup)).flowPlugins.some(
    (plugin) => plugin.id === RELEASE_ID,
  ), 'operator migration backup did not preserve the rolled-back Flow');

  console.log('PASS startup preserves rolled-back and migrated Flow bytes; both writers require dual operator authorization');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
