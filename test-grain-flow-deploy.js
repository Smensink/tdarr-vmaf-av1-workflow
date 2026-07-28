'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const flowId = 'YR5PZ1QaD';
const canonicalPath = path.resolve('configs/flow_YR5PZ1QaD_CANONICAL.json');
const deployPath = path.resolve('build-scripts/deploy-grain-flow-canary.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-grain-flow-deploy-'));
const safeTempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
assert(path.resolve(root).startsWith(safeTempRoot), `unsafe test root: ${root}`);

const canonical = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
const live = JSON.parse(JSON.stringify(canonical));
const expectedSecrets = new Map();
const secretKeys = ['plexToken', 'tmdbApiKey', 'tvdbApiKey', 'arr_api_key'];
for (const node of live.flowPlugins) {
  for (const key of secretKeys) {
    if (!node.inputsDB || !/^\$\{TDARR_[A-Z0-9_]+\}$/.test(String(node.inputsDB[key] || ''))) continue;
    const value = `test-secret-${node.id}-${key}`;
    node.inputsDB[key] = value;
    expectedSecrets.set(`${node.id}.${key}`, value);
  }
}
assert(expectedSecrets.size > 0, 'test fixture found no canonical credential placeholders');
const liveRaw = JSON.stringify(live);

function createFixture(name, sabotageReadback = false) {
  const fixtureRoot = path.join(root, name);
  const databasePath = path.join(fixtureRoot, 'database.db');
  const backupRoot = path.join(fixtureRoot, 'backups');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE flowsjsondb (id TEXT PRIMARY KEY, timestamp INTEGER, json_data TEXT NOT NULL)');
  db.prepare('INSERT INTO flowsjsondb (id, timestamp, json_data) VALUES (?, ?, ?)')
    .run(flowId, Date.now(), liveRaw);
  if (sabotageReadback) {
    db.exec(`CREATE TRIGGER corrupt_flow_readback AFTER UPDATE ON flowsjsondb
      BEGIN
        UPDATE flowsjsondb SET json_data = '{"tampered":true}' WHERE id = NEW.id;
      END`);
  }
  db.close();
  return { databasePath, backupRoot };
}

function readFlow(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId).json_data;
  } finally {
    db.close();
  }
}

function startApi({
  pauses = ['manual'],
  nodes = {},
  onPauseRead = null,
  expectedApiKey = '',
} = {}) {
  let pauseRead = 0;
  const server = http.createServer((request, response) => {
    assert.strictEqual(
      String(request.headers['x-api-key'] || ''),
      expectedApiKey,
      'deployment request did not preserve the private API-key header'
    );
    const finish = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && request.url === '/api/v2/get-nodes') {
      finish(200, nodes);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v2/cruddb') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const parsed = JSON.parse(body);
        assert.strictEqual(parsed.data.collection, 'SettingsGlobalJSONDB');
        assert.strictEqual(parsed.data.mode, 'getById');
        const pause = pauses[Math.min(pauseRead, pauses.length - 1)];
        pauseRead += 1;
        if (typeof onPauseRead === 'function') onPauseRead(pauseRead, pause);
        finish(200, { _id: 'globalsettings', pauseAllNodes: pause });
      });
      return;
    }
    finish(404, { error: 'not found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, apiBase: `http://127.0.0.1:${address.port}/api/v2` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function runDeploy(fixture, apiBase, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [deployPath], {
      env: {
        ...process.env,
        ALLOW_GRAIN_FLOW_DEPLOY: '1',
        GRAIN_FLOW_CANONICAL: canonicalPath,
        GRAIN_FLOW_DATABASE: fixture.databasePath,
        GRAIN_FLOW_BACKUP_ROOT: fixture.backupRoot,
        GRAIN_FLOW_API_BASE: apiBase,
        GRAIN_FLOW_API_TIMEOUT_MS: '2000',
        GRAIN_FLOW_GPU_LOCK: path.join(root, 'absent-gpu-pipeline.lock'),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function withApi(options, callback) {
  const api = await startApi(options);
  try {
    return await callback(api.apiBase);
  } finally {
    await closeServer(api.server);
  }
}

async function main() {
  const guardFixture = createFixture('operator-guard');
  const refused = childProcess.spawnSync(process.execPath, [deployPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GRAIN_FLOW_CANONICAL: canonicalPath,
      GRAIN_FLOW_DATABASE: guardFixture.databasePath,
      GRAIN_FLOW_BACKUP_ROOT: guardFixture.backupRoot,
    },
  });
  assert.notStrictEqual(refused.status, 0, 'deploy helper ran without its operator guard');
  assert.strictEqual(readFlow(guardFixture.databasePath), liveRaw);

  const unpausedFixture = createFixture('unpaused');
  await withApi({ pauses: [false] }, async (apiBase) => {
    const result = await runDeploy(unpausedFixture, apiBase);
    assert.notStrictEqual(result.status, 0, 'deploy helper ran while queues were unpaused');
    assert.match(result.stderr, /refusing Flow mutation while pauseAllNodes=false/);
  });
  assert.strictEqual(readFlow(unpausedFixture.databasePath), liveRaw);
  assert.ok(!fs.existsSync(unpausedFixture.backupRoot), 'unpaused refusal created a backup directory');

  const activeFixture = createFixture('active-worker');
  await withApi({
    nodes: {
      node1: {
        workers: {
          busy1: { workerType: 'transcodegpu', idle: false, status: 'Encoding' },
        },
      },
    },
  }, async (apiBase) => {
    const result = await runDeploy(activeFixture, apiBase);
    assert.notStrictEqual(result.status, 0, 'deploy helper ran with a non-idle worker');
    assert.match(result.stderr, /non-idle workers: node1\/busy1\(transcodegpu:Encoding\)/);
  });
  assert.strictEqual(readFlow(activeFixture.databasePath), liveRaw);
  assert.ok(!fs.existsSync(activeFixture.backupRoot), 'active-worker refusal created a backup directory');

  const heldLockFixture = createFixture('held-gpu-lock');
  const heldLockPath = path.join(root, 'held-gpu-pipeline.lock');
  fs.mkdirSync(heldLockPath);
  await withApi({}, async (apiBase) => {
    const result = await runDeploy(heldLockFixture, apiBase, { GRAIN_FLOW_GPU_LOCK: heldLockPath });
    assert.notStrictEqual(result.status, 0, 'deploy helper ran while the GPU pipeline lock existed');
    assert.match(result.stderr, /GPU pipeline lock exists during initial check/);
  });
  assert.strictEqual(readFlow(heldLockFixture.databasePath), liveRaw);
  assert.ok(!fs.existsSync(heldLockFixture.backupRoot), 'held-lock refusal created a backup directory');

  const racedLockFixture = createFixture('gpu-lock-race');
  const racedLockPath = path.join(root, 'raced-gpu-pipeline.lock');
  await withApi({
    onPauseRead: (readCount) => {
      if (readCount === 2) fs.mkdirSync(racedLockPath);
    },
  }, async (apiBase) => {
    const result = await runDeploy(racedLockFixture, apiBase, { GRAIN_FLOW_GPU_LOCK: racedLockPath });
    assert.notStrictEqual(result.status, 0, 'deploy helper ignored a GPU-lock race');
    assert.match(result.stderr, /GPU pipeline lock exists during final check/);
  });
  assert.strictEqual(readFlow(racedLockFixture.databasePath), liveRaw);
  assert.ok(!fs.existsSync(racedLockFixture.backupRoot), 'GPU-lock race created a backup directory');

  const racedFixture = createFixture('pause-race');
  await withApi({ pauses: ['manual', false] }, async (apiBase) => {
    const result = await runDeploy(racedFixture, apiBase);
    assert.notStrictEqual(result.status, 0, 'deploy helper ignored a pause-state race');
    assert.match(result.stderr, /pauseAllNodes changed during deployment preflight/);
  });
  assert.strictEqual(readFlow(racedFixture.databasePath), liveRaw);

  const rollbackFixture = createFixture('transaction-rollback', true);
  await withApi({}, async (apiBase) => {
    const result = await runDeploy(rollbackFixture, apiBase);
    assert.notStrictEqual(result.status, 0, 'deploy helper committed a mismatched transactional readback');
    assert.match(result.stderr, /transactional Flow read-back differs from the exact deployment payload/);
  });
  assert.strictEqual(readFlow(rollbackFixture.databasePath), liveRaw,
    'transactional mismatch did not roll the Flow row back');

  const successFixture = createFixture('success');
  const testApiKey = ['tapi', 'test', 'deploy', 'key', '123'].join('_');
  await withApi({
    nodes: { node1: { workers: { idle1: { workerType: 'transcodegpu', idle: true } } } },
    expectedApiKey: testApiKey,
  }, async (apiBase) => {
    const deployed = await runDeploy(successFixture, apiBase, { TDARR_API_KEY: testApiKey });
    assert.strictEqual(deployed.status, 0, deployed.stderr || deployed.stdout);
    assert.match(
      deployed.stdout,
      /PASS deployment preflight: queues paused, workers idle, production CLI processes absent, and GPU pipeline lock absent/
    );
    assert.match(deployed.stdout, /PASS deployed active grain Flow/);
  });

  const saved = JSON.parse(readFlow(successFixture.databasePath));
  assert.deepStrictEqual(saved.flowEdges, canonical.flowEdges, 'canonical edge graph was not deployed');
  assert.deepStrictEqual(
    saved.flowPlugins.map((node) => node.id),
    canonical.flowPlugins.map((node) => node.id),
    'canonical plugin graph was not deployed'
  );
  for (const node of saved.flowPlugins) {
    for (const key of secretKeys) {
      const expected = expectedSecrets.get(`${node.id}.${key}`);
      if (expected) assert.strictEqual(node.inputsDB[key], expected, `credential not retained: ${node.id}.${key}`);
    }
  }

  const backups = fs.readdirSync(successFixture.backupRoot);
  assert.strictEqual(backups.length, 1, 'deploy helper did not create exactly one backup');
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(successFixture.backupRoot, backups[0]), 'utf8')),
    live,
    'pre-deployment backup does not match the old live Flow'
  );
  console.log('PASS grain Flow guarded transactional deploy helper');
}

main().finally(() => {
  const resolved = path.resolve(root);
  assert(resolved.startsWith(safeTempRoot), `refusing unsafe test cleanup: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
