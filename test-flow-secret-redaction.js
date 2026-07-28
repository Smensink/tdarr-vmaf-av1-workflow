'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ARR_PLACEHOLDERS,
  arrPlaceholder,
  scrub,
  snapshotFiles,
} = require('./redact-flow-secrets');

const secretKeys = new Set(['plexToken', 'tmdbApiKey', 'tvdbApiKey', 'arr_api_key']);
const violations = [];

function scan(value, location) {
  if (Array.isArray(value)) return value.forEach((item, index) => scan(item, `${location}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (secretKeys.has(key)) {
      const text = String(child || '');
      if (text && !/^\$\{TDARR_[A-Z_]+\}$/.test(text) && !/^<[A-Z_]+>$/.test(text)) {
        violations.push(`${location}.${key}`);
      }
      if (key === 'arr_api_key' && text !== arrPlaceholder(value)) {
        violations.push(`${location}.${key}.wrong-service-placeholder`);
      }
    }
    scan(child, `${location}.${key}`);
  }
}

const files = snapshotFiles();
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('${TDARR_ARR_API_KEY}'),
    `${path.relative(__dirname, file)} contains the forbidden shared Arr placeholder`);
  scan(JSON.parse(raw), path.relative(__dirname, file));
}
assert.deepStrictEqual(violations, [], `plaintext credential fields: ${violations.join(', ')}`);

const fixture = {
  flowPlugins: [
    {
      pluginName: 'notifyRadarrOrSonarr',
      inputsDB: {
        arr_host: 'http://example.invalid:7878',
        arr_api_key: 'x',
      },
    },
    {
      pluginName: 'notifyRadarrOrSonarr',
      inputsDB: {
        arr: 'sonarr',
        arr_host: 'http://example.invalid:8989',
        arr_api_key: 'y',
      },
    },
    {
      pluginName: 'unmonitorRadarrOrSonarr',
      inputsDB: {
        arr: 'radarr',
        arr_api_key: 'z',
      },
    },
    {
      pluginName: 'unmonitorRadarrOrSonarr',
      inputsDB: {
        arr: 'sonarr',
        arr_api_key: 'w',
      },
    },
  ],
};
const scrubbed = scrub(fixture);
assert.deepStrictEqual(
  scrubbed.flowPlugins.map((node) => node.inputsDB.arr_api_key),
  [
    ARR_PLACEHOLDERS.radarr,
    ARR_PLACEHOLDERS.sonarr,
    ARR_PLACEHOLDERS.radarr,
    ARR_PLACEHOLDERS.sonarr,
  ],
);
assert.throws(
  () => scrub({ arr_api_key: 'x' }),
  /without an unambiguous Radarr\/Sonarr identity/,
);
assert.throws(
  () => scrub({
    arr: 'sonarr',
    arr_host: 'http://example.invalid:7878',
    arr_api_key: 'x',
  }),
  /conflicting Arr service evidence/,
);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-arr-redaction-test-'));
const resolvedTempRoot = path.resolve(tempRoot);
assert.strictEqual(path.dirname(resolvedTempRoot), path.resolve(os.tmpdir()));
assert.ok(path.basename(resolvedTempRoot).startsWith('tdarr-arr-redaction-test-'));
try {
  const output = path.join(resolvedTempRoot, 'flow.json');
  const exportFixture = {
    _id: 'arr-placeholder-test',
    flowPlugins: fixture.flowPlugins,
    flowEdges: [],
  };
  const result = childProcess.spawnSync(
    process.env.PYTHON || 'python',
    [
      path.join(__dirname, 'tools', 'export-live-state.py'),
      '--flow-json-stdin',
      '--flow-id',
      exportFixture._id,
      '--flow-out',
      output,
    ],
    {
      cwd: __dirname,
      encoding: 'utf8',
      input: JSON.stringify(exportFixture),
    },
  );
  assert.strictEqual(
    result.status,
    0,
    `flow exporter failed: ${String(result.stderr || '').trim()}`,
  );
  const exportedRaw = fs.readFileSync(output, 'utf8');
  const exported = JSON.parse(exportedRaw);
  assert.deepStrictEqual(
    exported.flowPlugins.map((node) => node.inputsDB.arr_api_key),
    [
      ARR_PLACEHOLDERS.radarr,
      ARR_PLACEHOLDERS.sonarr,
      ARR_PLACEHOLDERS.radarr,
      ARR_PLACEHOLDERS.sonarr,
    ],
  );
  assert.ok(!exportedRaw.includes('${TDARR_ARR_API_KEY}'));

  const ambiguous = childProcess.spawnSync(
    process.env.PYTHON || 'python',
    [
      path.join(__dirname, 'tools', 'export-live-state.py'),
      '--flow-json-stdin',
      '--flow-id',
      'ambiguous-arr-test',
      '--flow-out',
      path.join(resolvedTempRoot, 'ambiguous.json'),
    ],
    {
      cwd: __dirname,
      encoding: 'utf8',
      input: JSON.stringify({
        _id: 'ambiguous-arr-test',
        flowPlugins: [{ inputsDB: { arr_api_key: 'x' } }],
        flowEdges: [],
      }),
    },
  );
  assert.notStrictEqual(ambiguous.status, 0);
  assert.match(
    String(ambiguous.stderr || ''),
    /without an unambiguous Radarr\/Sonarr identity/,
  );
} finally {
  fs.rmSync(resolvedTempRoot, { recursive: true, force: true });
}

console.log(`PASS service-specific flow secret redaction (${files.length} snapshots)`);
