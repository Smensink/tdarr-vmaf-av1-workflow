'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const runtime = require('./build-scripts/apply-tdarr-runtime-settings');
const REVIEWED_LIBRARY_IDS = Object.freeze([
  'lib-a',
  'lib-b',
  'lib-c',
  'lib-d',
]);

function testStableStringifyPreservesPrototypeNamedKeys() {
  const left = JSON.parse('{"a":1,"__proto__":{"reviewed":1}}');
  const right = JSON.parse('{"a":1,"__proto__":{"reviewed":2}}');
  assert.notStrictEqual(
    runtime.stableStringify(left),
    runtime.stableStringify(right),
    'stable comparison must retain own __proto__ JSON keys'
  );
}

function testCliErrorsDoNotExposePrivateArguments() {
  const secretArgument = '--private-path=C:\\secret\\runtime-proof.json';
  const result = childProcess.spawnSync(process.execPath, [
    path.join(
      __dirname,
      'build-scripts',
      'apply-tdarr-runtime-settings.js'
    ),
    secretArgument,
  ], { encoding: 'utf8' });
  assert.notStrictEqual(result.status, 0);
  assert.strictEqual(
    result.stderr,
    'FAIL Tdarr runtime settings (TDARR_RUNTIME_SETTINGS_FAILED)\n'
  );
  assert(!result.stderr.includes(secretArgument));
}

function makeLibrary(id, overrides = {}) {
  return {
    _id: id,
    name: `synthetic-${id}`,
    folder: `/library/synthetic-${id}`,
    useFsEvents: true,
    folderWatchScanInterval: 30,
    scheduledScanFindNew: true,
    scanOnStart: true,
    holdFor: 3600,
    holdNewFiles: false,
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    libraries: [
      makeLibrary('lib-a'),
      makeLibrary('lib-b'),
      makeLibrary('lib-c'),
      makeLibrary('lib-d'),
    ],
    globalSettings: {
      _id: 'globalsettings',
      pauseAllNodes: 'manual',
      backupLimit: 30,
      jobHistorySizeLimitGB: 10,
      autoUpdateNodes: false,
      autoUpdateServer: false,
    },
    ...overrides,
  };
}

function makeApi(initialState, mutateAfterUpdate) {
  const state = JSON.parse(JSON.stringify(initialState));
  const calls = [];
  const requestJson = async (endpoint, options) => {
    assert.strictEqual(endpoint, 'cruddb');
    assert.strictEqual(options.method, 'POST');
    const body = options.body;
    assert.strictEqual(body.timeout, 20000);
    calls.push(JSON.parse(JSON.stringify(body)));
    const { collection, mode, docID, obj } = body.data;

    if (collection === 'LibrarySettingsJSONDB' && mode === 'getAll') {
      assert.strictEqual(options.responseMode, 'json');
      assert.strictEqual(docID, '');
      assert.deepStrictEqual(obj, {});
      return JSON.parse(JSON.stringify(state.libraries));
    }
    if (collection === 'LibrarySettingsJSONDB' && mode === 'getById') {
      assert.strictEqual(options.responseMode, 'json');
      const document = state.libraries.find((item) => item._id === docID);
      assert(document, 'synthetic library exact-ID readback identity missing');
      assert.deepStrictEqual(obj, {});
      return JSON.parse(JSON.stringify(document));
    }
    if (collection === 'SettingsGlobalJSONDB' && mode === 'getById') {
      assert.strictEqual(options.responseMode, 'json');
      assert.strictEqual(docID, 'globalsettings');
      assert.deepStrictEqual(obj, {});
      return JSON.parse(JSON.stringify(state.globalSettings));
    }
    if (collection === 'LibrarySettingsJSONDB' && mode === 'update') {
      assert.strictEqual(options.responseMode, 'mutation');
      const document = state.libraries.find((item) => item._id === docID);
      assert(document, 'synthetic library update identity missing');
      Object.assign(document, obj);
      if (mutateAfterUpdate) mutateAfterUpdate({ collection, document, state });
      return 'success';
    }
    if (collection === 'SettingsGlobalJSONDB' && mode === 'update') {
      assert.strictEqual(options.responseMode, 'mutation');
      assert.strictEqual(docID, 'globalsettings');
      Object.assign(state.globalSettings, obj);
      if (mutateAfterUpdate) {
        mutateAfterUpdate({
          collection,
          document: state.globalSettings,
          state,
        });
      }
      return 'success';
    }
    throw new Error(`unexpected synthetic CRUD request ${collection}/${mode}`);
  };
  return { calls, requestJson, state };
}

function config() {
  return {
    apiBase: 'http://127.0.0.1:8266/api/v2',
    apiKey: ['synthetic', 'api', 'value'].join('-'),
    gpuLockPath: '/temp/tdarr-vmaf-gpu-pipeline.lock',
    intervalMs: 250,
    timeoutMs: 1000,
  };
}

function applyOptions(overrides = {}) {
  return {
    apply: true,
    applyLatch: '1',
    allowRetentionChange: '',
    privateRoot: path.resolve('synthetic-private-root'),
    archiveReceiptPath: path.resolve('synthetic-private-root', 'receipt.json'),
    libraryIdentityManifestPath: path.resolve(
      'synthetic-private-root',
      'reviewed-libraries.json'
    ),
    config: config(),
    expectedLibraryCount: 4,
    ...overrides,
  };
}

function gateDependencies(overrides = {}) {
  return {
    validateArchiveReceipt: async () => Object.freeze({
      reportCount: 1,
    }),
    validateLibraryIdentityManifest: async () => Object.freeze({
      libraryIds: REVIEWED_LIBRARY_IDS,
      reviewedAt: Date.now(),
    }),
    ...overrides,
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function writeOwnerOnly(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_) {}
}

function makePrivateFixture() {
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-runtime-settings-'));
  try {
    fs.chmodSync(privateRoot, 0o700);
  } catch (_) {}
  const archiveDirectory = path.join(privateRoot, 'archives');
  const backupDirectory = path.join(privateRoot, 'backups');
  fs.mkdirSync(archiveDirectory, { mode: 0o700 });
  fs.mkdirSync(backupDirectory, { mode: 0o700 });
  const archive = Buffer.from('synthetic private archived job reports\n');
  const database = Buffer.concat([
    Buffer.from('SQLite format 3\0', 'binary'),
    Buffer.alloc(256, 0x5a),
  ]);
  const archivePath = path.join(archiveDirectory, 'job-reports.tar');
  const databasePath = path.join(backupDirectory, 'database.db');
  writeOwnerOnly(archivePath, archive);
  writeOwnerOnly(databasePath, database);
  const manifestPath = path.join(privateRoot, 'reviewed-libraries.json');
  writeOwnerOnly(manifestPath, JSON.stringify({
    schemaVersion: 1,
    kind: runtime.LIBRARY_IDENTITY_MANIFEST_KIND,
    reviewedAt: '2026-07-27T09:00:00.000Z',
    libraryIds: REVIEWED_LIBRARY_IDS,
  }));
  const receiptPath = path.join(privateRoot, 'archive-receipt.json');
  const receipt = {
    schemaVersion: runtime.ARCHIVE_RECEIPT_SCHEMA_VERSION,
    kind: runtime.ARCHIVE_RECEIPT_KIND,
    verified: true,
    reportCount: 42,
    createdAt: '2026-07-27T09:30:00.000Z',
    archive: {
      path: path.join('archives', 'job-reports.tar'),
      sha256: sha256(archive),
    },
    databaseBackup: {
      path: path.join('backups', 'database.db'),
      sha256: sha256(database),
    },
  };
  writeOwnerOnly(receiptPath, JSON.stringify(receipt));
  return {
    privateRoot,
    archivePath,
    databasePath,
    manifestPath,
    receipt,
    receiptPath,
  };
}

function removePrivateFixture(fixture) {
  const resolved = path.resolve(fixture.privateRoot);
  const tempRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(`${tempRoot}${path.sep}`) ||
      !path.basename(resolved).startsWith('tdarr-runtime-settings-')) {
    throw new Error('refusing unsafe synthetic fixture cleanup');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function testDryRunIsReadOnly() {
  const api = makeApi(makeState());
  let quiescenceChecks = 0;
  const result = await runtime.execute({
    apply: false,
    config: config(),
    expectedLibraryCount: 4,
  }, {
    requestJson: api.requestJson,
    assertQuiescence: async () => { quiescenceChecks += 1; },
  });

  assert.deepStrictEqual(result, {
    applied: false,
    libraryCount: 4,
    libraryDocumentsNeedingUpdate: 4,
    globalFieldsNeedingUpdate: 1,
    retentionChangeRequired: false,
  });
  assert.strictEqual(quiescenceChecks, 1);
  assert.strictEqual(
    api.calls.filter((call) => call.data.mode === 'update').length,
    0
  );
}

async function testApplyUsesExactPatchAndReadback() {
  const api = makeApi(makeState());
  let quiescenceChecks = 0;
  let receiptChecks = 0;
  let manifestChecks = 0;
  const options = applyOptions();
  const result = await runtime.execute(options, {
    requestJson: api.requestJson,
    assertQuiescence: async () => { quiescenceChecks += 1; },
    ...gateDependencies({
      validateArchiveReceipt: async (receiptPath, privateRoot) => {
        receiptChecks += 1;
        assert.strictEqual(receiptPath, options.archiveReceiptPath);
        assert.strictEqual(privateRoot, options.privateRoot);
      },
      validateLibraryIdentityManifest: async (manifestPath, privateRoot) => {
        manifestChecks += 1;
        assert.strictEqual(manifestPath, options.libraryIdentityManifestPath);
        assert.strictEqual(privateRoot, options.privateRoot);
        return Object.freeze({
          libraryIds: REVIEWED_LIBRARY_IDS,
          reviewedAt: Date.now(),
        });
      },
    }),
  });

  assert.deepStrictEqual(result, {
    applied: true,
    libraryCount: 4,
    libraryDocumentsUpdated: 4,
    globalFieldsUpdated: 1,
  });
  assert.strictEqual(quiescenceChecks, 3);
  assert.strictEqual(receiptChecks, 1);
  assert.strictEqual(manifestChecks, 1);

  const updates = api.calls.filter((call) => call.data.mode === 'update');
  assert.strictEqual(updates.length, 5);
  for (const update of updates.slice(0, 4)) {
    assert.strictEqual(update.data.collection, 'LibrarySettingsJSONDB');
    assert.deepStrictEqual(update.data.obj, {
      folderWatchScanInterval: 300,
      scanOnStart: false,
    });
  }
  assert.deepStrictEqual(updates[4].data, {
    collection: 'SettingsGlobalJSONDB',
    mode: 'update',
    docID: 'globalsettings',
    obj: { backupLimit: 10 },
  });
  assert.strictEqual(
    api.calls.filter((call) =>
      call.data.collection === 'LibrarySettingsJSONDB' &&
      call.data.mode === 'getById').length,
    8
  );
  assert(api.state.libraries.every((library) =>
    library.scheduledScanFindNew === true &&
    library.holdFor === 3600
  ));
}

async function testLibraryCountMismatchFailsBeforeWrites() {
  const state = makeState();
  state.libraries.pop();
  const api = makeApi(state);
  await assert.rejects(
    runtime.execute(applyOptions(), {
      requestJson: api.requestJson,
      assertQuiescence: async () => {},
      ...gateDependencies(),
    }),
    /library scope mismatch/
  );
  assert.strictEqual(
    api.calls.filter((call) => call.data.mode === 'update').length,
    0
  );
}

async function testRetentionDifferenceNeedsExplicitApproval() {
  const state = makeState();
  state.globalSettings.jobHistorySizeLimitGB = 8;
  const api = makeApi(state);
  await assert.rejects(
    runtime.execute(applyOptions({
      allowRetentionChange: '',
    }), {
      requestJson: api.requestJson,
      assertQuiescence: async () => {},
      ...gateDependencies(),
    }),
    /explicit archival-backed retention approval/
  );
  assert.strictEqual(
    api.calls.filter((call) => call.data.mode === 'update').length,
    0
  );
}

async function testIdentityMutationFailsReadback() {
  let mutated = false;
  const api = makeApi(makeState(), ({ collection, document }) => {
    if (!mutated && collection === 'LibrarySettingsJSONDB') {
      document.folder = '/library/unexpected-mutation';
      mutated = true;
    }
  });
  await assert.rejects(
    runtime.execute(applyOptions(), {
      requestJson: api.requestJson,
      assertQuiescence: async () => {},
      ...gateDependencies(),
    }),
    /changed outside the target fields/
  );
}

async function testPreMutationStateDriftFailsBeforeWrites() {
  const api = makeApi(makeState());
  let quiescenceChecks = 0;
  await assert.rejects(
    runtime.execute(applyOptions(), {
      requestJson: api.requestJson,
      assertQuiescence: async () => {
        quiescenceChecks += 1;
        if (quiescenceChecks === 2) {
          api.state.libraries[0].folder = '/library/replaced-after-review';
        }
      },
      ...gateDependencies(),
    }),
    /changed before settings mutation/
  );
  assert.strictEqual(quiescenceChecks, 2);
  assert.strictEqual(
    api.calls.filter((call) => call.data.mode === 'update').length,
    0,
    'reviewed-state TOCTOU caused a partial settings write'
  );
}

function testCrudSchemaAndOptionParsing() {
  assert.deepStrictEqual(
    runtime.crudRequest('LibrarySettingsJSONDB', 'getAll', '', {}),
    {
      data: {
        collection: 'LibrarySettingsJSONDB',
        mode: 'getAll',
        docID: '',
        obj: {},
      },
      timeout: 20000,
    }
  );
  const options = runtime.optionsFromProcess([], {
    TDARR_API_BASE: 'http://127.0.0.1:8266/api/v2',
    TDARR_API_KEY: ['synthetic', 'api', 'value'].join('-'),
    TDARR_PRIVATE_RUNTIME_ROOT: path.resolve('private-root'),
    TDARR_PRIVATE_ARCHIVE_RECEIPT: path.resolve('private-root', 'receipt.json'),
    TDARR_PRIVATE_LIBRARY_IDENTITY_MANIFEST: path.resolve(
      'private-root',
      'libraries.json'
    ),
  });
  assert.strictEqual(options.apply, false);
  assert.strictEqual(options.expectedLibraryCount, 4);
  assert.strictEqual(options.config.apiKey, ['synthetic', 'api', 'value'].join('-'));
  assert.strictEqual(options.privateRoot, path.resolve('private-root'));
  assert.strictEqual(
    options.libraryIdentityManifestPath,
    path.resolve('private-root', 'libraries.json')
  );
  assert.throws(
    () => runtime.optionsFromProcess(['--unexpected'], {}),
    /unsupported argument/
  );
}

async function testPrivateReceiptAndManifestContracts() {
  const now = Date.parse('2026-07-27T10:00:00.000Z');
  const fixture = makePrivateFixture();
  try {
    const manifest = runtime.validateLibraryIdentityManifest(
      fixture.manifestPath,
      { privateRoot: fixture.privateRoot, now }
    );
    assert.deepStrictEqual(manifest.libraryIds, REVIEWED_LIBRARY_IDS);

    let sqliteChecks = 0;
    const result = await runtime.validateArchiveReceipt(fixture.receiptPath, {
      privateRoot: fixture.privateRoot,
      now,
      sqliteIntegrity: async (databasePath, expectedSha256) => {
        sqliteChecks += 1;
        assert.strictEqual(databasePath, fs.realpathSync(fixture.databasePath));
        assert.strictEqual(
          expectedSha256,
          fixture.receipt.databaseBackup.sha256
        );
      },
    });
    assert.strictEqual(result.reportCount, 42);
    assert.strictEqual(result.archiveSha256, fixture.receipt.archive.sha256);
    assert.strictEqual(
      result.databaseSha256,
      fixture.receipt.databaseBackup.sha256
    );
    assert.strictEqual(sqliteChecks, 1);

    const archiveHardLink = path.join(
      fixture.privateRoot,
      'archive-hardlink-alias'
    );
    fs.linkSync(fixture.archivePath, archiveHardLink);
    try {
      await assert.rejects(
        runtime.validateArchiveReceipt(fixture.receiptPath, {
          privateRoot: fixture.privateRoot,
          now,
          sqliteIntegrity: async () => {},
        }),
        /must not be hard-linked/
      );
    } finally {
      fs.unlinkSync(archiveHardLink);
    }

    const inspectedRoot = runtime.inspectPrivateRoot(fixture.privateRoot);
    const inspectedArchive = runtime.inspectPrivateFile(
      inspectedRoot,
      fixture.archivePath,
      'private report archive'
    );
    const originalArchivePath = `${fixture.archivePath}.inspected`;
    const originalArchiveBytes = fs.readFileSync(fixture.archivePath);
    fs.renameSync(fixture.archivePath, originalArchivePath);
    writeOwnerOnly(fixture.archivePath, originalArchiveBytes);
    try {
      await assert.rejects(
        runtime.hashPrivateFile({
          ...inspectedArchive,
          label: 'private report archive',
        }),
        /hash could not be computed/
      );
    } finally {
      fs.unlinkSync(fixture.archivePath);
      fs.renameSync(originalArchivePath, fixture.archivePath);
    }

    const badReceipt = {
      ...fixture.receipt,
      archive: {
        ...fixture.receipt.archive,
        sha256: '0'.repeat(64),
      },
    };
    writeOwnerOnly(fixture.receiptPath, JSON.stringify(badReceipt));
    await assert.rejects(
      runtime.validateArchiveReceipt(fixture.receiptPath, {
        privateRoot: fixture.privateRoot,
        now,
        sqliteIntegrity: async () => {
          throw new Error('SQLite must not run after a hash mismatch');
        },
      }),
      /report archive SHA-256 does not match receipt/
    );
    await assert.rejects(
      runtime.validateArchiveReceipt('', {
        privateRoot: fixture.privateRoot,
        now,
      }),
      /must be an absolute path/
    );
  } finally {
    removePrivateFixture(fixture);
  }

  assert.throws(
    () => runtime.assertOwnerOnly({ mode: 0o100640 }, 'synthetic file', 'linux'),
    /permissions must be owner-only/
  );
  assert.doesNotThrow(
    () => runtime.assertOwnerOnly({ mode: 0o100600 }, 'synthetic file', 'linux')
  );
}

async function testSqliteIntegrityContract() {
  const fixture = makePrivateFixture();
  try {
    let invocation;
    const result = await runtime.validateSqliteIntegrity(fixture.databasePath, {
      expectedSha256: fixture.receipt.databaseBackup.sha256,
      execFileImpl: (executable, argv, options, callback) => {
        invocation = { executable, argv, options };
        callback(null, 'ok\n', '');
      },
    });
    assert.deepStrictEqual(result, { integrityCheck: 'ok' });
    assert.strictEqual(
      invocation.executable,
      process.platform === 'win32' ? 'python' : 'python3'
    );
    assert.strictEqual(invocation.argv[0], '-I');
    assert.strictEqual(invocation.argv[1], '-c');
    assert.match(invocation.argv[2], /PRAGMA integrity_check/);
    assert.match(invocation.argv[2], /mode=ro/);
    assert.match(invocation.argv[2], /immutable=1/);
    assert.match(invocation.argv[2], /\/proc\/self\/fd/);
    assert.match(invocation.argv[2], /hashlib\.sha256/);
    assert.strictEqual(invocation.argv[3], fixture.databasePath);
    assert.strictEqual(
      invocation.argv[4],
      fixture.receipt.databaseBackup.sha256
    );
    assert.strictEqual(invocation.options.timeout, 120000);

    await assert.rejects(
      runtime.validateSqliteIntegrity(fixture.databasePath, {
        expectedSha256: fixture.receipt.databaseBackup.sha256,
        execFileImpl: (_executable, _argv, _options, callback) => {
          callback(null, 'row 7 missing from index\n', '');
        },
      }),
      /failed SQLite integrity_check/
    );

    await assert.rejects(
      runtime.validateSqliteIntegrity(fixture.databasePath, {
        expectedSha256: fixture.receipt.databaseBackup.sha256,
        execFileImpl: (_executable, _argv, _options, callback) => {
          const error = new Error('python3 is unavailable');
          error.code = 'ENOENT';
          callback(error, '', '');
        },
      }),
      /failed SQLite integrity_check/
    );
  } finally {
    removePrivateFixture(fixture);
  }
}

async function testReviewedIdentityMismatchFailsBeforeWrites() {
  const api = makeApi(makeState());
  let receiptChecks = 0;
  let caught;
  try {
    await runtime.execute(applyOptions(), {
      requestJson: api.requestJson,
      assertQuiescence: async () => {},
      ...gateDependencies({
        validateArchiveReceipt: async () => {
          receiptChecks += 1;
        },
        validateLibraryIdentityManifest: async () => ({
          libraryIds: ['lib-a', 'lib-b', 'lib-c', 'private-mismatch-id'],
          reviewedAt: Date.now(),
        }),
      }),
    });
  } catch (error) {
    caught = error;
  }
  assert(caught, 'reviewed identity mismatch must reject apply');
  assert.match(caught.message, /reviewed library identity set does not match/);
  assert(!caught.message.includes('private-mismatch-id'));
  assert.strictEqual(receiptChecks, 0);
  assert.strictEqual(
    api.calls.filter((call) => call.data.mode === 'update').length,
    0
  );
}

async function testApplyAlwaysChecksPrivateProofs() {
  const state = makeState({
    libraries: REVIEWED_LIBRARY_IDS.map((id) => makeLibrary(id, {
      folderWatchScanInterval: 300,
      scanOnStart: false,
    })),
    globalSettings: {
      ...makeState().globalSettings,
      backupLimit: 10,
    },
  });
  const api = makeApi(state);
  let receiptChecks = 0;
  let manifestChecks = 0;
  const result = await runtime.execute(applyOptions(), {
    requestJson: api.requestJson,
    assertQuiescence: async () => {},
    ...gateDependencies({
      validateArchiveReceipt: async () => {
        receiptChecks += 1;
      },
      validateLibraryIdentityManifest: async () => {
        manifestChecks += 1;
        return {
          libraryIds: REVIEWED_LIBRARY_IDS,
          reviewedAt: Date.now(),
        };
      },
    }),
  });
  assert.strictEqual(result.libraryDocumentsUpdated, 0);
  assert.strictEqual(result.globalFieldsUpdated, 0);
  assert.strictEqual(receiptChecks, 1);
  assert.strictEqual(manifestChecks, 1);
  assert.strictEqual(
    api.calls.filter((call) => call.data.mode === 'update').length,
    0
  );
}

async function testRealTransportResponseModes() {
  const observedBodies = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (chunks.length > 0) {
        observedBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      }
      if (request.url === '/api/v2/read-json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'strict-json' }));
      } else if (request.url === '/api/v2/empty') {
        response.writeHead(204);
        response.end();
      } else if (request.url === '/api/v2/empty-200') {
        response.writeHead(200);
        response.end();
      } else if (request.url === '/api/v2/plain-success') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('success');
      } else if (request.url === '/api/v2/json-success') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ updated: true }));
      } else if (request.url === '/api/v2/invalid') {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('not-success');
      } else if (request.url === '/api/v2/aborted') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"partial":');
        response.destroy();
      } else {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'synthetic' }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    const requestRuntime = runtime.createRuntimeRequester({
      ...config(),
      apiBase: `http://127.0.0.1:${address.port}/api/v2`,
    });
    assert.deepStrictEqual(
      await requestRuntime('read-json'),
      { status: 'strict-json' }
    );
    await assert.rejects(
      requestRuntime('empty'),
      /returned invalid JSON/
    );
    assert.deepStrictEqual(
      await requestRuntime('empty', {
        method: 'POST',
        body: { mutation: 1 },
        responseMode: 'mutation',
      }),
      { success: true }
    );
    assert.deepStrictEqual(
      await requestRuntime('empty-200', {
        method: 'POST',
        body: { mutation: 2 },
        responseMode: 'mutation',
      }),
      { success: true }
    );
    assert.deepStrictEqual(
      await requestRuntime('plain-success', {
        method: 'POST',
        body: { mutation: 3 },
        responseMode: 'mutation',
      }),
      { success: true }
    );
    assert.deepStrictEqual(
      await requestRuntime('json-success', {
        method: 'POST',
        body: { mutation: 4 },
        responseMode: 'mutation',
      }),
      { updated: true }
    );
    await assert.rejects(
      requestRuntime('plain-success'),
      /returned invalid JSON/
    );
    await assert.rejects(
      requestRuntime('invalid', { responseMode: 'mutation' }),
      /returned invalid mutation response/
    );
    await assert.rejects(
      requestRuntime('failure', { responseMode: 'mutation' }),
      /returned HTTP 500/
    );
    await assert.rejects(
      requestRuntime('aborted'),
      /response was aborted|request failed/
    );
    assert.deepStrictEqual(observedBodies, [
      { mutation: 1 },
      { mutation: 2 },
      { mutation: 3 },
      { mutation: 4 },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  testStableStringifyPreservesPrototypeNamedKeys();
  testCliErrorsDoNotExposePrivateArguments();
  await testDryRunIsReadOnly();
  await testApplyUsesExactPatchAndReadback();
  await testLibraryCountMismatchFailsBeforeWrites();
  await testRetentionDifferenceNeedsExplicitApproval();
  await testIdentityMutationFailsReadback();
  await testPreMutationStateDriftFailsBeforeWrites();
  await testReviewedIdentityMismatchFailsBeforeWrites();
  await testApplyAlwaysChecksPrivateProofs();
  testCrudSchemaAndOptionParsing();
  await testPrivateReceiptAndManifestContracts();
  await testSqliteIntegrityContract();
  await testRealTransportResponseModes();
  console.log(
    'PASS Tdarr runtime settings convergence: dry-run, exact CRUD patches, ' +
    'artifact-bound private gates, strict identities, transport response modes, ' +
    'and identity-preserving readback'
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
