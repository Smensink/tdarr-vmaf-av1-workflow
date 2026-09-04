'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const FLOW_ID = 'YR5PZ1QaD';
const releaseRoot = path.resolve(__dirname, '..');
const exporter = path.join(releaseRoot, 'custom-cont-init.d', 'export-vmaf-flow-definition.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-canonical-secret-guard-'));

function writeFixtureDatabase(filename, flow) {
  const databasePath = path.join(root, filename);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('CREATE TABLE flowsjsondb (id TEXT PRIMARY KEY, json_data TEXT NOT NULL)');
    database.prepare('INSERT INTO flowsjsondb (id, json_data) VALUES (?, ?)')
      .run(FLOW_ID, JSON.stringify(flow));
  } finally {
    database.close();
  }
  return databasePath;
}

function runExport(databasePath, target) {
  return spawnSync(process.execPath, [exporter, '--apply'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ALLOW_TDARR_CANONICAL_FLOW_EXPORT: '1',
      TDARR_SQL_DB: databasePath,
      TDARR_CANONICAL_FLOW_TARGET: target,
    },
  });
}

try {
  const unsafeDatabase = writeFixtureDatabase('unsafe.db', {
    _id: FLOW_ID,
    flowPlugins: [{
      id: 'notification',
      inputsDB: {
        notificationWebhook: 'https://example.invalid/hooks/live-credential',
      },
    }],
  });
  const unsafeTarget = path.join(root, 'unsafe-canonical.json');
  const unsafeResult = runExport(unsafeDatabase, unsafeTarget);

  assert.notStrictEqual(unsafeResult.status, 0,
    'export with an unknown secret-shaped key unexpectedly succeeded');
  assert.match(unsafeResult.stderr, /unscrubbed secret-shaped key/i);
  assert(!fs.existsSync(unsafeTarget), 'unsafe canonical target was written');
  assert.deepStrictEqual(
    fs.readdirSync(root).filter((entry) => entry.startsWith(`${path.basename(unsafeTarget)}.tmp-`)),
    [],
    'failed export left a temporary canonical file',
  );

  const safeFlow = {
    _id: FLOW_ID,
    flowPlugins: [
      {
        id: 'metadata',
        inputsDB: {
          plexToken: 'live-plex-token',
          tmdbApiKey: 'live-tmdb-key',
          tvdbApiKey: 'live-tvdb-key',
        },
      },
      {
        id: 'radarr',
        inputsDB: {
          arr: 'radarr',
          arr_host: 'http://radarr:7878',
          arr_api_key: 'live-radarr-key',
        },
      },
      {
        id: 'sonarr',
        inputsDB: {
          arr_host: 'http://sonarr:8989',
          arr_api_key: 'live-sonarr-key',
        },
      },
    ],
  };
  const expectedSafeFlow = JSON.parse(JSON.stringify(safeFlow));
  expectedSafeFlow.flowPlugins[0].inputsDB.plexToken = '${TDARR_PLEX_TOKEN}';
  expectedSafeFlow.flowPlugins[0].inputsDB.tmdbApiKey = '${TDARR_TMDB_API_KEY}';
  expectedSafeFlow.flowPlugins[0].inputsDB.tvdbApiKey = '${TDARR_TVDB_API_KEY}';
  expectedSafeFlow.flowPlugins[1].inputsDB.arr_api_key = '${TDARR_RADARR_API_KEY}';
  expectedSafeFlow.flowPlugins[2].inputsDB.arr_api_key = '${TDARR_SONARR_API_KEY}';

  const safeDatabase = writeFixtureDatabase('safe.db', safeFlow);
  const safeTarget = path.join(root, 'safe-canonical.json');
  const safeResult = runExport(safeDatabase, safeTarget);

  assert.strictEqual(safeResult.status, 0, safeResult.stderr || safeResult.stdout);
  assert.strictEqual(
    fs.readFileSync(safeTarget, 'utf8'),
    `${JSON.stringify(expectedSafeFlow, null, 2)}\n`,
    'known credential keys did not produce stable canonical output',
  );

  console.log('PASS canonical flow export rejects unknown secrets and preserves known placeholders');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
