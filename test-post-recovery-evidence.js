'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const evidence = require('./build-scripts/create-post-recovery-evidence');
const runtimeSettings = require(
  './build-scripts/apply-tdarr-runtime-settings'
);

const FLOW_ID = 'synthetic-reviewed-flow';
const FIXED_NOW = Date.parse('2026-07-28T03:00:00.000Z');
const LIBRARY_IDS = Object.freeze([
  'synthetic-library-a',
  'synthetic-library-b',
  'synthetic-library-c',
  'synthetic-library-d',
]);

function syntheticPrivateValue(label) {
  return ['synthetic', 'private', label].join('-');
}

function ownerOnlyDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directoryPath, 0o700);
  } catch (_) {}
}

function ownerOnlyFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_) {}
}

function makeLibrary(identity) {
  return {
    _id: identity,
    name: 'synthetic private library',
    folder: '/private/synthetic/library',
    useFsEvents: true,
    folderWatchScanInterval: 30,
    scheduledScanFindNew: true,
    scanOnStart: true,
    holdFor: 3600,
  };
}

function createFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'tdarr-post-recovery-evidence-test-')
  );
  const databaseRoot = path.join(root, 'database-source');
  const configsRoot = path.join(root, 'configs-source');
  const reportsRoot = path.join(root, 'reports-source');
  const reviewRoot = path.join(root, 'review-source');
  const terminalProofRoot = path.join(root, 'terminal-proof-source');
  const destinationParent = path.join(root, 'private-destination');
  for (const directory of [
    databaseRoot,
    configsRoot,
    reportsRoot,
    reviewRoot,
    terminalProofRoot,
    destinationParent,
  ]) {
    ownerOnlyDirectory(directory);
  }

  const flow = {
    _id: FLOW_ID,
    name: 'Synthetic private active Flow',
    flowPlugins: [{
      id: 'synthetic-secret-node',
      inputsDB: {
        apiKey: syntheticPrivateValue('flow-value'),
      },
    }],
    flowEdges: [],
  };

  const databasePath = path.join(databaseRoot, 'database.db');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA journal_mode=WAL');
  database.exec(
    'CREATE TABLE flowsjsondb (id TEXT PRIMARY KEY, json_data TEXT NOT NULL)'
  );
  database.prepare(
    'INSERT INTO flowsjsondb (id, json_data) VALUES (?, ?)'
  ).run(FLOW_ID, JSON.stringify(flow));
  database.exec(
    'CREATE TABLE terminal_recovery (state TEXT NOT NULL);' +
    "INSERT INTO terminal_recovery VALUES ('success')"
  );

  const learningDatabasePath = path.join(configsRoot, 'vmaf_training.db');
  const learningDatabase = new DatabaseSync(learningDatabasePath);
  learningDatabase.exec('PRAGMA journal_mode=WAL');
  learningDatabase.exec(
    'CREATE TABLE jobs (job_id TEXT PRIMARY KEY, selected_cq REAL);' +
    "INSERT INTO jobs VALUES ('private-job-id', 18.5)"
  );

  ownerOnlyFile(
    path.join(configsRoot, 'settings.json'),
    '{"privateConfig":"synthetic-private-config"}\n'
  );
  const nestedConfigRoot = path.join(configsRoot, 'nested');
  ownerOnlyDirectory(nestedConfigRoot);
  ownerOnlyFile(
    path.join(nestedConfigRoot, '-leading-config.txt'),
    'synthetic config\n'
  );

  const firstReportRoot = path.join(reportsRoot, 'report-a');
  const secondReportRoot = path.join(reportsRoot, 'nested', 'report-b');
  ownerOnlyDirectory(firstReportRoot);
  ownerOnlyDirectory(secondReportRoot);
  ownerOnlyFile(
    path.join(firstReportRoot, 'data.json'),
    '{"status":"success"}\n'
  );
  ownerOnlyFile(
    path.join(firstReportRoot, 'second report.txt'),
    'synthetic report\n'
  );
  ownerOnlyFile(
    path.join(secondReportRoot, '-leading-report.json'),
    '{"status":"failed-synthetic"}\n'
  );
  ownerOnlyFile(
    path.join(reportsRoot, 'root-metadata.txt'),
    'not a descendant report\n'
  );

  const reviewedManifestPath = path.join(
    reviewRoot,
    'reviewed-libraries.json'
  );
  const reviewedManifest = {
    schemaVersion: 1,
    kind: runtimeSettings.LIBRARY_IDENTITY_MANIFEST_KIND,
    reviewedAt: '2026-07-28T02:00:00.000Z',
    libraryIds: LIBRARY_IDS,
    reviewContract: 'synthetic-operator-reviewed-fixture',
  };
  ownerOnlyFile(
    reviewedManifestPath,
    `${JSON.stringify(reviewedManifest, null, 2)}\n`
  );

  const terminalRecoveryWatcherPath = path.join(
    terminalProofRoot,
    'watch-controlled-retained-recovery.js'
  );
  ownerOnlyFile(
    terminalRecoveryWatcherPath,
    "'use strict';\n// Synthetic frozen watcher fixture.\n"
  );
  const expectedTerminalWatcher = {
    sha256: sha256File(terminalRecoveryWatcherPath),
    size: fs.statSync(terminalRecoveryWatcherPath).size,
  };
  const milestones = Object.fromEntries(
    evidence.TERMINAL_RECOVERY_MILESTONE_KEYS.map(
      (key) => [key, true]
    )
  );
  const terminalRecoveryJournalPath = path.join(
    terminalProofRoot,
    'terminal-recovery-journal.jsonl'
  );
  const terminalRecoveryJournalEvents = [
    {
      schema: evidence.TERMINAL_RECOVERY_JOURNAL_SCHEMA_VERSION,
      contract_id: evidence.TERMINAL_RECOVERY_JOURNAL_CONTRACT_ID,
      sequence: 1,
      observed_at: '2026-07-28T02:00:00.000Z',
      kind: 'journal_opened',
      evidence: {
        schema: evidence.TERMINAL_RECOVERY_JOURNAL_SCHEMA_VERSION,
        contract_id: evidence.TERMINAL_RECOVERY_JOURNAL_CONTRACT_ID,
      },
    },
    {
      schema: evidence.TERMINAL_RECOVERY_JOURNAL_SCHEMA_VERSION,
      contract_id: evidence.TERMINAL_RECOVERY_JOURNAL_CONTRACT_ID,
      sequence: 2,
      observed_at: '2026-07-28T02:29:59.000Z',
      kind: 'watcher_terminal',
      evidence: {
        outcome: 'success',
        milestones,
        quiescence_ok: true,
        violation_count: 0,
      },
    },
  ];
  ownerOnlyFile(
    terminalRecoveryJournalPath,
    `${terminalRecoveryJournalEvents
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`
  );
  const terminalRecoveryJournalBytes = fs.readFileSync(
    terminalRecoveryJournalPath
  );
  const terminalRecoveryReceipt = {
    schema: evidence.TERMINAL_RECOVERY_RECEIPT_SCHEMA_VERSION,
    contract_id: evidence.TERMINAL_RECOVERY_RECEIPT_CONTRACT_ID,
    outcome: 'success',
    ok: true,
    started_at: '2026-07-28T02:00:00.000Z',
    completed_at: '2026-07-28T02:30:00.000Z',
    identity: { fixture: 'private identity' },
    milestones,
    terminal: {
      api: { decision: 'Transcode success' },
      report: { decision: 'Transcode success' },
    },
    staging: { fixture: true },
    retirement: { fixture: true },
    terminal_evidence: { fixture: true },
    quiescence: {
      ok: true,
      samples: [{ ok: true }, { ok: true }],
    },
    violations: [],
    journal: {
      path: terminalRecoveryJournalPath,
      sha256_full: sha256File(terminalRecoveryJournalPath),
      size_bytes: terminalRecoveryJournalBytes.length,
      event_count: terminalRecoveryJournalEvents.length,
    },
  };
  const terminalRecoveryReceiptPath = path.join(
    terminalProofRoot,
    'terminal-recovery-receipt.json'
  );
  ownerOnlyFile(
    terminalRecoveryReceiptPath,
    `${JSON.stringify(terminalRecoveryReceipt, null, 2)}\n`
  );

  return {
    root,
    database,
    learningDatabase,
    databasePath,
    learningDatabasePath,
    configsRoot,
    reportsRoot,
    destinationParent,
    reviewedManifest,
    reviewedManifestPath,
    terminalRecoveryReceipt,
    terminalRecoveryReceiptPath,
    terminalRecoveryReceiptSha256:
      sha256File(terminalRecoveryReceiptPath),
    terminalRecoveryJournalEvents,
    terminalRecoveryJournalPath,
    terminalRecoveryWatcherPath,
    expectedTerminalWatcher,
    flow,
  };
}

function removeFixture(fixture) {
  try {
    fixture.database.close();
  } catch (_) {}
  try {
    fixture.learningDatabase.close();
  } catch (_) {}
  const resolved = path.resolve(fixture.root);
  const tempRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(`${tempRoot}${path.sep}`) ||
      !path.basename(resolved).startsWith(
        'tdarr-post-recovery-evidence-test-'
      )) {
    throw new Error('refusing unsafe synthetic fixture cleanup');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function optionsFor(fixture, suffix = 'generation') {
  return {
    allowGeneration: '1',
    destinationPath: path.join(fixture.destinationParent, suffix),
    reviewedLibraryManifestPath: fixture.reviewedManifestPath,
    terminalRecoveryReceiptPath: fixture.terminalRecoveryReceiptPath,
    terminalRecoveryReceiptSha256:
      fixture.terminalRecoveryReceiptSha256,
    terminalRecoveryJournalPath: fixture.terminalRecoveryJournalPath,
    terminalRecoveryWatcherPath: fixture.terminalRecoveryWatcherPath,
    allowSourceOverride: '1',
    databasePath: fixture.databasePath,
    learningDatabasePath: fixture.learningDatabasePath,
    jobReportsRoot: fixture.reportsRoot,
    configsRoot: fixture.configsRoot,
    flowId: FLOW_ID,
    pythonExecutable: process.platform === 'win32' ? 'python' : 'python3',
    sqliteBackupTimeoutMs: 60_000,
    archiveTimeoutMs: 60_000,
    config: {
      apiBase: 'http://127.0.0.1:8266/api/v2',
      apiKey: syntheticPrivateValue('api-material'),
      gpuLockPath: '/temp/synthetic.lock',
      intervalMs: 250,
      timeoutMs: 1000,
    },
  };
}

function dependenciesFor(fixture, overrides = {}) {
  let quiescenceCalls = 0;
  let libraryCalls = 0;
  return {
    now: () => FIXED_NOW,
    expectedTerminalWatcher: fixture.expectedTerminalWatcher,
    assertQuiescence: async () => {
      quiescenceCalls += 1;
      return {
        checks: 2,
        intervalMs: 250,
        nodeCount: 1,
      };
    },
    requestJson: async (endpoint, request) => {
      libraryCalls += 1;
      assert.strictEqual(endpoint, 'cruddb');
      assert.strictEqual(request.method, 'POST');
      assert.strictEqual(
        request.body.data.collection,
        'LibrarySettingsJSONDB'
      );
      assert.strictEqual(request.body.data.mode, 'getAll');
      assert.strictEqual(request.responseMode, 'json');
      return LIBRARY_IDS.map(makeLibrary);
    },
    counters: {
      get quiescenceCalls() {
        return quiescenceCalls;
      },
      get libraryCalls() {
        return libraryCalls;
      },
    },
    ...overrides,
  };
}

function sha256File(filePath) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function archiveMembers(archivePath) {
  const program = [
    'import json, sys, tarfile',
    'with tarfile.open(sys.argv[1], "r:gz") as archive:',
    '    print(json.dumps([{"name": item.name, "regular": item.isreg()} for item in archive]))',
  ].join('\n');
  const result = childProcess.spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    ['-I', '-c', program, archivePath],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }
  );
  assert.strictEqual(result.status, 0, 'synthetic archive must be readable');
  return JSON.parse(result.stdout);
}

function immutableSqliteRows(databasePath, query) {
  const program = [
    'import json, pathlib, sqlite3, sys',
    'uri = pathlib.Path(sys.argv[1]).resolve().as_uri() + "?mode=ro&immutable=1"',
    'database = sqlite3.connect(uri, uri=True)',
    'try:',
    '    rows = database.execute(sys.argv[2]).fetchall()',
    'finally:',
    '    database.close()',
    'print(json.dumps(rows))',
  ].join('\n');
  const result = childProcess.spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    ['-I', '-c', program, databasePath, query],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    }
  );
  assert.strictEqual(
    result.status,
    0,
    'immutable synthetic SQLite query must succeed'
  );
  return JSON.parse(result.stdout);
}

function walkOutput(rootPath) {
  const output = [];
  function visit(directoryPath) {
    for (const name of fs.readdirSync(directoryPath).sort()) {
      const fullPath = path.join(directoryPath, name);
      const stat = fs.lstatSync(fullPath);
      assert(!stat.isSymbolicLink(), 'generated output must not contain symlinks');
      if (stat.isDirectory()) visit(fullPath);
      else {
        assert(stat.isFile(), 'generated output must contain regular files only');
        assert.strictEqual(
          stat.nlink,
          1,
          'generated output must not contain hard links'
        );
        output.push(path.relative(rootPath, fullPath).split(path.sep).join('/'));
      }
    }
  }
  visit(rootPath);
  return output;
}

async function testHappyPathAndConsumerCompatibility() {
  const fixture = createFixture();
  try {
    const dependencies = dependenciesFor(fixture);
    let onlineBackupCalls = 0;
    const generated = await evidence.generateEvidence(
      optionsFor(fixture),
      {
        ...dependencies,
        sqliteBackup: async (options) => {
          onlineBackupCalls += 1;
          return evidence.defaultSqliteBackup(options);
        },
      }
    );
    assert.strictEqual(generated.completed, true);
    assert.strictEqual(generated.reportCount, 1);
    assert.strictEqual(generated.archiveFileCount, 4);
    assert.strictEqual(generated.libraryCount, 4);
    assert.strictEqual(generated.artifactCount, 10);
    assert.strictEqual(onlineBackupCalls, 2);
    assert.strictEqual(dependencies.counters.quiescenceCalls, 2);
    assert.strictEqual(dependencies.counters.libraryCalls, 2);

    const destination = generated.destinationPath;
    const receiptPath = path.join(destination, 'archive-receipt.json');
    const libraryManifestPath = path.join(
      destination,
      'reviewed-libraries.json'
    );
    const receipt = readJson(receiptPath);
    assert.deepStrictEqual(receipt, {
      schemaVersion: 2,
      kind: runtimeSettings.ARCHIVE_RECEIPT_KIND,
      verified: true,
      reportCount: 1,
      createdAt: '2026-07-28T03:00:00.000Z',
      archive: {
        path: 'archives/job-reports.tar.gz',
        sha256: sha256File(
          path.join(destination, 'archives', 'job-reports.tar.gz')
        ),
      },
      databaseBackup: {
        path: 'backups/database.db',
        sha256: sha256File(
          path.join(destination, 'backups', 'database.db')
        ),
      },
    });

    const receiptValidation = await runtimeSettings.validateArchiveReceipt(
      receiptPath,
      {
        privateRoot: destination,
        now: FIXED_NOW,
        pythonExecutable: process.platform === 'win32' ? 'python' : 'python3',
      }
    );
    assert.strictEqual(receiptValidation.reportCount, 1);
    const manifestValidation =
      runtimeSettings.validateLibraryIdentityManifest(
        libraryManifestPath,
        {
          privateRoot: destination,
          now: FIXED_NOW,
        }
      );
    assert.deepStrictEqual(
      [...manifestValidation.libraryIds].sort(),
      [...LIBRARY_IDS].sort()
    );
    assert.deepStrictEqual(
      readJson(libraryManifestPath),
      fixture.reviewedManifest,
      'operator-reviewed identity attestation must be copied unchanged'
    );
    const terminalReceiptPath = path.join(
      destination,
      'terminal-recovery-receipt.json'
    );
    assert.deepStrictEqual(
      readJson(terminalReceiptPath),
      fixture.terminalRecoveryReceipt,
      'reviewed terminal-recovery receipt must be copied unchanged'
    );
    assert.strictEqual(
      sha256File(terminalReceiptPath),
      fixture.terminalRecoveryReceiptSha256
    );
    const terminalJournalPath = path.join(
      destination,
      'terminal-recovery-journal.jsonl'
    );
    assert.deepStrictEqual(
      fs.readFileSync(terminalJournalPath),
      fs.readFileSync(fixture.terminalRecoveryJournalPath),
      'controlled-recovery journal must be copied unchanged'
    );
    const terminalWatcherPath = path.join(
      destination,
      'watch-controlled-retained-recovery.js'
    );
    assert.deepStrictEqual(
      fs.readFileSync(terminalWatcherPath),
      fs.readFileSync(fixture.terminalRecoveryWatcherPath),
      'frozen watcher implementation must be copied unchanged'
    );

    assert.deepStrictEqual(
      immutableSqliteRows(
        path.join(destination, 'backups', 'database.db'),
        'SELECT state FROM terminal_recovery'
      ),
      [['success']]
    );
    assert.deepStrictEqual(
      immutableSqliteRows(
        path.join(destination, 'backups', 'vmaf_training.db'),
        'SELECT selected_cq FROM jobs'
      ),
      [[18.5]]
    );
    assert.deepStrictEqual(
      readJson(path.join(destination, 'snapshots', 'active-flow.json')),
      fixture.flow
    );

    const reportMembers = archiveMembers(
      path.join(destination, 'archives', 'job-reports.tar.gz')
    );
    assert.strictEqual(reportMembers.length, 4);
    assert(reportMembers.every((member) => member.regular));
    assert.deepStrictEqual(
      reportMembers.map((member) => member.name).sort(),
      [
        'nested/report-b/-leading-report.json',
        'report-a/data.json',
        'report-a/second report.txt',
        'root-metadata.txt',
      ]
    );

    const configMembers = archiveMembers(
      path.join(destination, 'archives', 'configs.tar.gz')
    );
    assert(configMembers.every((member) => member.regular));
    assert.deepStrictEqual(
      configMembers.map((member) => member.name).sort(),
      ['nested/-leading-config.txt', 'settings.json']
    );

    const outputFiles = walkOutput(destination);
    assert(!outputFiles.some((name) => name.includes('.inventory.')));
    assert(
      !outputFiles.some((name) =>
        /(?:-wal|-shm|-journal)$/.test(name)
      ),
      'immutable backup reads must not create SQLite sidecars'
    );
    assert(outputFiles.includes('evidence-manifest.json'));
    const evidenceManifest = readJson(
      path.join(destination, 'evidence-manifest.json')
    );
    assert.strictEqual(
      evidenceManifest.kind,
      evidence.EVIDENCE_KIND
    );
    assert.strictEqual(evidenceManifest.verified, true);
    assert.strictEqual(evidenceManifest.reportCount, 1);
    assert.strictEqual(
      evidenceManifest.sourceContractId,
      evidence.OVERRIDE_SOURCE_CONTRACT_ID
    );
    assert.deepStrictEqual(evidenceManifest.jobReportArchive, {
      countContractId: evidence.JOB_REPORT_COUNT_CONTRACT_ID,
      reportCount: 1,
      regularFileCount: 4,
    });
    assert.strictEqual(evidenceManifest.libraryCount, 4);
    assert.strictEqual(evidenceManifest.artifacts.length, 10);
    assert.deepStrictEqual(evidenceManifest.terminalRecovery, {
      schema: evidence.TERMINAL_RECOVERY_RECEIPT_SCHEMA_VERSION,
      contractId: evidence.TERMINAL_RECOVERY_RECEIPT_CONTRACT_ID,
      outcome: 'success',
      completedAt: '2026-07-28T02:30:00.000Z',
      receiptSha256: fixture.terminalRecoveryReceiptSha256,
      journalContractId: evidence.TERMINAL_RECOVERY_JOURNAL_CONTRACT_ID,
      journalSha256: sha256File(fixture.terminalRecoveryJournalPath),
      journalSize:
        fs.statSync(fixture.terminalRecoveryJournalPath).size,
      journalEventCount: fixture.terminalRecoveryJournalEvents.length,
      watcherContractId: evidence.TERMINAL_RECOVERY_WATCHER_CONTRACT_ID,
      watcherSha256: fixture.expectedTerminalWatcher.sha256,
      watcherSize: fixture.expectedTerminalWatcher.size,
    });
    assert.deepStrictEqual(evidenceManifest.quiescence, {
      preBackup: { checks: 2, intervalMs: 250, nodeCount: 1 },
      postBackup: { checks: 2, intervalMs: 250, nodeCount: 1 },
    });

    const checksumLines = fs.readFileSync(
      path.join(destination, 'SHA256SUMS.txt'),
      'utf8'
    ).trim().split('\n');
    assert.strictEqual(checksumLines.length, 10);
    for (const line of checksumLines) {
      const match = /^([a-f0-9]{64})  ([^\0\r\n]+)$/.exec(line);
      assert(match, 'checksum manifest line must be canonical');
      assert.strictEqual(
        sha256File(path.join(destination, ...match[2].split('/'))),
        match[1]
      );
    }
  } finally {
    removeFixture(fixture);
  }
}

async function testExistingDestinationIsNeverOverwritten() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'existing');
    ownerOnlyDirectory(options.destinationPath);
    ownerOnlyFile(
      path.join(options.destinationPath, 'preserved.txt'),
      'preserve me\n'
    );
    await assert.rejects(
      evidence.generateEvidence(options, dependenciesFor(fixture)),
      /already exists/
    );
    assert.strictEqual(
      fs.readFileSync(
        path.join(options.destinationPath, 'preserved.txt'),
        'utf8'
      ),
      'preserve me\n'
    );
  } finally {
    removeFixture(fixture);
  }
}

async function testHardLinkedReportFailsClosed() {
  const fixture = createFixture();
  try {
    const original = path.join(fixture.reportsRoot, 'report-a', 'data.json');
    fs.linkSync(
      original,
      path.join(fixture.reportsRoot, 'report-a', 'hard-link.json')
    );
    const options = optionsFor(fixture, 'hard-link-rejected');
    await assert.rejects(
      evidence.generateEvidence(options, dependenciesFor(fixture)),
      /hard-linked/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testSymlinkedConfigFailsClosedWhenSupported() {
  const fixture = createFixture();
  try {
    const linkPath = path.join(fixture.configsRoot, 'unsafe-link.json');
    let supported = true;
    try {
      fs.symlinkSync(
        path.join(fixture.configsRoot, 'settings.json'),
        linkPath,
        'file'
      );
    } catch (error) {
      if (process.platform === 'win32' &&
          error &&
          ['EPERM', 'EACCES'].includes(error.code)) {
        supported = false;
      } else {
        throw error;
      }
    }
    if (!supported) return;
    const options = optionsFor(fixture, 'symlink-rejected');
    await assert.rejects(
      evidence.generateEvidence(options, dependenciesFor(fixture)),
      /unsafe entry/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testReviewedManifestMismatchFailsBeforeBackup() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'review-mismatch');
    let sqliteBackupCalls = 0;
    const dependencies = dependenciesFor(fixture, {
      requestJson: async () => [
        makeLibrary('unexpected-a'),
        makeLibrary('unexpected-b'),
        makeLibrary('unexpected-c'),
        makeLibrary('unexpected-d'),
      ],
      sqliteBackup: async () => {
        sqliteBackupCalls += 1;
      },
    });
    await assert.rejects(
      evidence.generateEvidence(options, dependencies),
      /does not match pre-backup/
    );
    assert.strictEqual(sqliteBackupCalls, 0);
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testLibraryScopeDriftFailsAndRemovesPartialGeneration() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'scope-drift');
    let call = 0;
    const dependencies = dependenciesFor(fixture, {
      requestJson: async () => {
        call += 1;
        const identities = call === 1
          ? LIBRARY_IDS
          : [
            LIBRARY_IDS[0],
            LIBRARY_IDS[1],
            LIBRARY_IDS[2],
            'synthetic-unreviewed-library',
          ];
        return identities.map(makeLibrary);
      },
    });
    await assert.rejects(
      evidence.generateEvidence(options, dependencies),
      /scope changed/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testPostQuiescenceFailureRemovesPartialGeneration() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'post-quiescence-failure');
    let call = 0;
    const dependencies = dependenciesFor(fixture, {
      assertQuiescence: async () => {
        call += 1;
        if (call === 2) throw new Error('synthetic post-backup drift');
        return { checks: 2, intervalMs: 250, nodeCount: 1 };
      },
    });
    await assert.rejects(
      evidence.generateEvidence(options, dependencies),
      /synthetic post-backup drift/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testSourceMutationDuringArchiveFailsClosed() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'source-mutation');
    let archiveCall = 0;
    const dependencies = dependenciesFor(fixture, {
      archiveRunner: async (archiveOptions) => {
        archiveCall += 1;
        const result = evidence.defaultArchiveRunner(archiveOptions);
        if (archiveCall === 1) {
          const first = [...archiveOptions.entries.values()][0];
          fs.appendFileSync(first.fullPath, 'synthetic drift\n');
        }
        return result;
      },
    });
    await assert.rejects(
      evidence.generateEvidence(options, dependencies),
      /changed while it was archived/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testDestinationCannotOverlapSource() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture);
    options.destinationPath = path.join(
      fixture.configsRoot,
      'unsafe-generation'
    );
    await assert.rejects(
      evidence.generateEvidence(options, dependenciesFor(fixture)),
      /overlaps a source/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testSourceOverridesRequireExplicitLatch() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'override-without-latch');
    options.allowSourceOverride = '';
    await assert.rejects(
      evidence.generateEvidence(options, dependenciesFor(fixture)),
      /ALLOW_TDARR_EVIDENCE_SOURCE_OVERRIDE=1/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testTerminalRecoveryReceiptHashMustMatch() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'terminal-hash-mismatch');
    options.terminalRecoveryReceiptSha256 = '0'.repeat(64);
    await assert.rejects(
      evidence.generateEvidence(options, dependenciesFor(fixture)),
      /differs from the reviewed hash/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testTerminalRecoveryReceiptMutationFailsClosed() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'terminal-receipt-mutation');
    let quiescenceCall = 0;
    const dependencies = dependenciesFor(fixture, {
      assertQuiescence: async () => {
        quiescenceCall += 1;
        if (quiescenceCall === 2) {
          fs.appendFileSync(
            fixture.terminalRecoveryReceiptPath,
            ' \n'
          );
        }
        return { checks: 2, intervalMs: 250, nodeCount: 1 };
      },
    });
    await assert.rejects(
      evidence.generateEvidence(options, dependencies),
      /controlled-recovery terminal receipt changed/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testTerminalRecoveryJournalHashMustMatchReceipt() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'terminal-journal-mismatch');
    fs.appendFileSync(
      fixture.terminalRecoveryJournalPath,
      '{"synthetic":"unreviewed"}\n'
    );
    await assert.rejects(
      evidence.generateEvidence(options, dependenciesFor(fixture)),
      /journal differs from its receipt/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testTerminalRecoveryEvidenceMustBeNonEmpty() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'terminal-evidence-empty');
    const invalidReceipt = {
      ...fixture.terminalRecoveryReceipt,
      terminal_evidence: {},
    };
    fs.writeFileSync(
      fixture.terminalRecoveryReceiptPath,
      `${JSON.stringify(invalidReceipt, null, 2)}\n`
    );
    options.terminalRecoveryReceiptSha256 = sha256File(
      fixture.terminalRecoveryReceiptPath
    );
    await assert.rejects(
      evidence.generateEvidence(options, dependenciesFor(fixture)),
      /schema or success proof is invalid/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testFrozenTerminalWatcherHashMustMatch() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'terminal-watcher-mismatch');
    fs.appendFileSync(
      fixture.terminalRecoveryWatcherPath,
      '// unreviewed mutation\n'
    );
    await assert.rejects(
      evidence.generateEvidence(options, dependenciesFor(fixture)),
      /differs from the frozen implementation/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

async function testPublishRenameThenThrowRemovesAmbiguousFinal() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'publish-then-throw');
    const dependencies = dependenciesFor(fixture, {
      publishStaging: async ({ stagingPath, destinationPath }) => {
        fs.renameSync(stagingPath, destinationPath);
        throw new Error('synthetic publisher lost acknowledgement');
      },
    });
    await assert.rejects(
      evidence.generateEvidence(options, dependencies),
      /lost acknowledgement/
    );
    assert(
      !fs.existsSync(options.destinationPath),
      'an ambiguously published exact generation must be removed'
    );
    assert.deepStrictEqual(
      fs.readdirSync(fixture.destinationParent),
      [],
      'no exact-inode staging generation may remain'
    );
  } finally {
    removeFixture(fixture);
  }
}

async function testUnexpectedGeneratedArtifactFailsClosed() {
  const fixture = createFixture();
  try {
    const options = optionsFor(fixture, 'unexpected-artifact');
    let backupCall = 0;
    const dependencies = dependenciesFor(fixture, {
      sqliteBackup: async (backupOptions) => {
        backupCall += 1;
        evidence.defaultSqliteBackup(backupOptions);
        if (backupCall === 1) {
          ownerOnlyFile(
            `${backupOptions.destinationPath}-wal`,
            'unexpected generated sidecar\n'
          );
        }
      },
    });
    await assert.rejects(
      evidence.generateEvidence(options, dependencies),
      /artifact set is not exact/
    );
    assert(!fs.existsSync(options.destinationPath));
  } finally {
    removeFixture(fixture);
  }
}

function testCliFailureDoesNotExposeArgumentsOrPaths() {
  const privateArgument =
    '--private-path=C:\\private\\never-print-this-value.json';
  const result = childProcess.spawnSync(
    process.execPath,
    [
      '--no-warnings',
      path.join(
        __dirname,
        'build-scripts',
        'create-post-recovery-evidence.js'
      ),
      privateArgument,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );
  assert.notStrictEqual(result.status, 0);
  assert.strictEqual(result.stdout, '');
  assert.strictEqual(
    result.stderr,
    'FAIL post-recovery private evidence ' +
    '(TDARR_POST_RECOVERY_EVIDENCE_FAILED)\n'
  );
  assert(!result.stderr.includes(privateArgument));
}

async function main() {
  await testHappyPathAndConsumerCompatibility();
  await testExistingDestinationIsNeverOverwritten();
  await testHardLinkedReportFailsClosed();
  await testSymlinkedConfigFailsClosedWhenSupported();
  await testReviewedManifestMismatchFailsBeforeBackup();
  await testLibraryScopeDriftFailsAndRemovesPartialGeneration();
  await testPostQuiescenceFailureRemovesPartialGeneration();
  await testSourceMutationDuringArchiveFailsClosed();
  await testDestinationCannotOverlapSource();
  await testSourceOverridesRequireExplicitLatch();
  await testTerminalRecoveryReceiptHashMustMatch();
  await testTerminalRecoveryReceiptMutationFailsClosed();
  await testTerminalRecoveryJournalHashMustMatchReceipt();
  await testTerminalRecoveryEvidenceMustBeNonEmpty();
  await testFrozenTerminalWatcherHashMustMatch();
  await testPublishRenameThenThrowRemovesAmbiguousFinal();
  await testUnexpectedGeneratedArtifactFailsClosed();
  testCliFailureDoesNotExposeArgumentsOrPaths();
  console.log('PASS post-recovery private evidence contract tests');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
