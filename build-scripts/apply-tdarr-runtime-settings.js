'use strict';

// Safe maintenance-window settings convergence for the reviewed Tdarr
// deployment. The default mode is read-only. Applying changes requires both
// --apply and ALLOW_TDARR_RUNTIME_SETTINGS_APPLY=1.

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const quiescence = require('./assert-tdarr-quiescence');

const EXPECTED_LIBRARY_COUNT = 4;
const CRUD_TIMEOUT_MS = 20000;
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
const ARCHIVE_RECEIPT_MAX_BYTES = 32 * 1024;
const ARCHIVE_RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ARCHIVE_RECEIPT_KIND = 'tdarr-private-job-report-archive';
const ARCHIVE_RECEIPT_SCHEMA_VERSION = 2;
const LIBRARY_IDENTITY_MANIFEST_KIND = 'tdarr-reviewed-library-identities';
const LIBRARY_IDENTITY_MANIFEST_MAX_BYTES = 32 * 1024;
const SQLITE_INTEGRITY_TIMEOUT_MS = 120000;
const TARGET_LIBRARY_SETTINGS = Object.freeze({
  useFsEvents: true,
  folderWatchScanInterval: 300,
  scheduledScanFindNew: true,
  scanOnStart: false,
});
const TARGET_GLOBAL_SETTINGS = Object.freeze({
  backupLimit: 10,
  jobHistorySizeLimitGB: 10,
});
const LIBRARY_TARGET_KEYS = Object.freeze(Object.keys(TARGET_LIBRARY_SETTINGS));
const GLOBAL_TARGET_KEYS = Object.freeze(Object.keys(TARGET_GLOBAL_SETTINGS));

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort()) output[key] = stableValue(value[key]);
    return output;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function omitKeys(document, keys) {
  const copy = clone(document);
  for (const key of keys) delete copy[key];
  return copy;
}

function sameValue(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function assertInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
}

function assertLibraryShape(document, ordinal) {
  const label = `library document ${ordinal + 1}`;
  if (!isRecord(document)) throw new TypeError(`${label} must be an object`);
  if (typeof document._id !== 'string' ||
      document._id.length === 0 ||
      document._id.length > 512) {
    throw new TypeError(`${label} has an invalid identity`);
  }
  if (typeof document.useFsEvents !== 'boolean') {
    throw new TypeError(`${label} useFsEvents must be boolean`);
  }
  assertInteger(document.folderWatchScanInterval, 0, 86400, `${label} folderWatchScanInterval`);
  if (typeof document.scheduledScanFindNew !== 'boolean') {
    throw new TypeError(`${label} scheduledScanFindNew must be boolean`);
  }
  if (typeof document.scanOnStart !== 'boolean') {
    throw new TypeError(`${label} scanOnStart must be boolean`);
  }
  assertInteger(document.holdFor, 0, 315576000, `${label} holdFor`);
}

function validateLibraryDocuments(documents, expectedCount = EXPECTED_LIBRARY_COUNT) {
  if (!Array.isArray(documents)) {
    throw new TypeError('LibrarySettingsJSONDB getAll response must be an array');
  }
  assertInteger(expectedCount, 1, 1000, 'expected library count');
  if (documents.length !== expectedCount) {
    throw new Error(
      `library scope mismatch: expected ${expectedCount} document(s), got ${documents.length}`
    );
  }
  const identities = new Set();
  documents.forEach((document, ordinal) => {
    assertLibraryShape(document, ordinal);
    if (identities.has(document._id)) {
      throw new Error('LibrarySettingsJSONDB returned duplicate identities');
    }
    identities.add(document._id);
  });
  return documents;
}

function validateGlobalDocument(document) {
  if (!isRecord(document)) {
    throw new TypeError('SettingsGlobalJSONDB getById response must be an object');
  }
  if (document._id !== 'globalsettings') {
    throw new Error('global settings identity does not match globalsettings');
  }
  assertInteger(document.backupLimit, 0, 1000, 'global backupLimit');
  assertInteger(
    document.jobHistorySizeLimitGB,
    1,
    1000,
    'global jobHistorySizeLimitGB'
  );
  if (document.pauseAllNodes !== 'manual') {
    throw new Error('global manual pause is not asserted');
  }
  return document;
}

function crudRequest(collection, mode, docID, obj = {}) {
  return {
    data: {
      collection,
      mode,
      docID,
      obj,
    },
    timeout: CRUD_TIMEOUT_MS,
  };
}

function safeErrorCode(error) {
  const value = error && (error.code || error.name) || 'unknown-error';
  return String(value).replace(/[^A-Za-z0-9_.:@-]/g, '?').slice(0, 80);
}

function createRuntimeRequester(config, transports = { http, https }) {
  return function requestRuntime(relativePath, options = {}) {
    const suffix = String(relativePath || '').replace(/^\/+/, '');
    if (!/^[A-Za-z0-9_-]+$/.test(suffix)) {
      return Promise.reject(new TypeError('Tdarr API endpoint is not a safe relative name'));
    }
    const responseMode = options.responseMode || 'json';
    if (!['json', 'mutation'].includes(responseMode)) {
      return Promise.reject(new TypeError('Tdarr API responseMode must be json or mutation'));
    }
    const url = new URL(`${config.apiBase}/${suffix}`);
    const transport = url.protocol === 'https:' ? transports.https : transports.http;
    const body = options.body === undefined ? null : JSON.stringify(options.body);

    return new Promise((resolve, reject) => {
      const request = transport.request(url, {
        method: options.method || 'GET',
        headers: quiescence.buildRequestHeaders(config.apiKey, body),
        timeout: config.timeoutMs,
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_API_RESPONSE_BYTES) {
            request.destroy(new Error('TDARR_API_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('aborted', () => reject(new Error(
          `Tdarr API ${quiescence.safeLabel(suffix)} response was aborted`
        )));
        response.on('error', (error) => reject(new Error(
          `Tdarr API ${quiescence.safeLabel(suffix)} response failed ` +
          `(${safeErrorCode(error)})`
        )));
        response.on('end', () => {
          if (!response.statusCode ||
              response.statusCode < 200 ||
              response.statusCode >= 300) {
            reject(new Error(
              `Tdarr API ${quiescence.safeLabel(suffix)} returned HTTP ` +
              `${response.statusCode || 'unknown'}`
            ));
            return;
          }

          const text = Buffer.concat(chunks).toString('utf8');
          const trimmed = text.trim();
          if (responseMode === 'mutation' &&
              (response.statusCode === 204 ||
               trimmed === '' ||
               trimmed === 'success')) {
            resolve(Object.freeze({ success: true }));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (_) {
            reject(new Error(
              `Tdarr API ${quiescence.safeLabel(suffix)} returned invalid ` +
              `${responseMode === 'mutation' ? 'mutation response' : 'JSON'}`
            ));
          }
        });
      });
      request.on('timeout', () => request.destroy(new Error('TDARR_API_TIMEOUT')));
      request.on('error', (error) => reject(new Error(
        `Tdarr API ${quiescence.safeLabel(suffix)} request failed ` +
        `(${safeErrorCode(error)})`
      )));
      if (body !== null) request.write(body);
      request.end();
    });
  };
}

async function getRuntimeState(requestJson, exactLibraryIds = []) {
  const libraries = await requestJson('cruddb', {
    method: 'POST',
    body: crudRequest('LibrarySettingsJSONDB', 'getAll', '', {}),
    responseMode: 'json',
  });
  const globalSettings = await requestJson('cruddb', {
    method: 'POST',
    body: crudRequest(
      'SettingsGlobalJSONDB',
      'getById',
      'globalsettings',
      {}
    ),
    responseMode: 'json',
  });
  const exactLibraries = [];
  for (const identity of exactLibraryIds) {
    exactLibraries.push(await requestJson('cruddb', {
      method: 'POST',
      body: crudRequest(
        'LibrarySettingsJSONDB',
        'getById',
        identity,
        {}
      ),
      responseMode: 'json',
    }));
  }
  return { libraries, globalSettings, exactLibraries };
}

function buildPlan(state, options = {}) {
  const expectedLibraryCount = options.expectedLibraryCount === undefined
    ? EXPECTED_LIBRARY_COUNT
    : options.expectedLibraryCount;
  const libraries = validateLibraryDocuments(
    state.libraries,
    expectedLibraryCount
  );
  const globalSettings = validateGlobalDocument(state.globalSettings);
  const libraryUpdates = [];

  for (const document of libraries) {
    const patch = {};
    for (const [key, target] of Object.entries(TARGET_LIBRARY_SETTINGS)) {
      if (!sameValue(document[key], target)) patch[key] = target;
    }
    if (Object.keys(patch).length !== 0) {
      libraryUpdates.push(Object.freeze({
        id: document._id,
        patch: Object.freeze(patch),
      }));
    }
  }

  const globalPatch = {};
  for (const [key, target] of Object.entries(TARGET_GLOBAL_SETTINGS)) {
    if (!sameValue(globalSettings[key], target)) globalPatch[key] = target;
  }

  return Object.freeze({
    expectedLibraryCount,
    libraryUpdates: Object.freeze(libraryUpdates),
    globalPatch: Object.freeze(globalPatch),
    retentionChangeRequired: Object.prototype.hasOwnProperty.call(
      globalPatch,
      'jobHistorySizeLimitGB'
    ),
  });
}

function assertOwnerOnly(stat, label, platform = process.platform) {
  if (platform === 'linux' && (stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must be owner-only`);
  }
}

function absolutePath(value, environmentName) {
  if (typeof value !== 'string' ||
      value.length === 0 ||
      value.includes('\0') ||
      !path.isAbsolute(value)) {
    throw new TypeError(`${environmentName} must be an absolute path`);
  }
  return path.resolve(value);
}

function isStrictDescendant(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function inspectPrivateRoot(privateRootPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  const requestedPath = absolutePath(
    privateRootPath,
    'TDARR_PRIVATE_RUNTIME_ROOT'
  );
  let stat;
  let realPath;
  let canonicalStat;
  try {
    stat = fsImpl.lstatSync(requestedPath);
    realPath = fsImpl.realpathSync(requestedPath);
    canonicalStat = fsImpl.lstatSync(realPath);
  } catch (_) {
    throw new Error('private runtime root cannot be inspected');
  }
  if (!stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !canonicalStat.isDirectory() ||
      canonicalStat.isSymbolicLink() ||
      !sameFileIdentity(stat, canonicalStat)) {
    throw new Error('private runtime root must be a non-symlink directory');
  }
  assertOwnerOnly(stat, 'private runtime root', platform);
  assertOwnerOnly(canonicalStat, 'private runtime root', platform);
  return Object.freeze({ requestedPath, realPath, stat: canonicalStat });
}

function assertPrivateRootSnapshot(root, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  let current;
  try {
    current = fsImpl.lstatSync(root.realPath);
  } catch (_) {
    throw new Error('private runtime root changed after inspection');
  }
  if (!current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameFileIdentity(root.stat, current)) {
    throw new Error('private runtime root changed after inspection');
  }
  assertOwnerOnly(current, 'private runtime root', platform);
}

function inspectPrivateFile(root, filePath, label, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const platform = options.platform || process.platform;
  const maximumBytes = options.maximumBytes;
  const requestedPath = absolutePath(filePath, label);
  assertPrivateRootSnapshot(root, options);
  let stat;
  let realPath;
  let canonicalStat;
  try {
    stat = fsImpl.lstatSync(requestedPath);
    realPath = fsImpl.realpathSync(requestedPath);
    canonicalStat = fsImpl.lstatSync(realPath);
  } catch (_) {
    throw new Error(`${label} cannot be inspected`);
  }
  if (!stat.isFile() ||
      stat.isSymbolicLink() ||
      !canonicalStat.isFile() ||
      canonicalStat.isSymbolicLink() ||
      !sameFileSnapshot(stat, canonicalStat)) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  if (!isStrictDescendant(root.realPath, realPath)) {
    throw new Error(`${label} must resolve beneath the private runtime root`);
  }
  if (canonicalStat.nlink !== 1) {
    throw new Error(`${label} must not be hard-linked`);
  }
  if (canonicalStat.size <= 0 ||
      (maximumBytes !== undefined && canonicalStat.size > maximumBytes)) {
    throw new Error(`${label} size is outside the accepted range`);
  }
  assertOwnerOnly(canonicalStat, label, platform);
  assertPrivateRootSnapshot(root, options);
  return Object.freeze({ requestedPath, realPath, stat: canonicalStat });
}

function inspectPrivateRelativeFile(root, relativePath, label, options = {}) {
  if (typeof relativePath !== 'string' ||
      relativePath.length === 0 ||
      relativePath.includes('\0') ||
      path.isAbsolute(relativePath)) {
    throw new TypeError(`${label} path must be relative to the private runtime root`);
  }
  const resolvedPath = path.resolve(root.realPath, relativePath);
  if (!isStrictDescendant(root.realPath, resolvedPath)) {
    throw new Error(`${label} path escapes the private runtime root`);
  }
  return inspectPrivateFile(root, resolvedPath, label, options);
}

function sameFileIdentity(before, after) {
  return before.dev === after.dev && before.ino === after.ino;
}

function sameFileSnapshot(before, after) {
  return sameFileIdentity(before, after) &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.nlink === after.nlink &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs;
}

function openPrivateFileDescriptor(file, label, fsImpl = fs) {
  let descriptor;
  try {
    const constants = fsImpl.constants || fs.constants;
    const noFollow = process.platform === 'linux' && constants.O_NOFOLLOW
      ? constants.O_NOFOLLOW
      : 0;
    descriptor = fsImpl.openSync(
      file.realPath,
      constants.O_RDONLY | noFollow
    );
    const opened = fsImpl.fstatSync(descriptor);
    if (!opened.isFile() ||
        opened.isSymbolicLink() ||
        opened.nlink !== 1 ||
        !sameFileSnapshot(file.stat, opened)) {
      throw new Error('identity changed');
    }
    return { descriptor, opened };
  } catch (_) {
    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch (_) {}
    }
    throw new Error(`${label} changed before it could be opened`);
  }
}

function assertOpenPrivateFileUnchanged(file, opened, descriptor, label, fsImpl = fs) {
  let afterDescriptor;
  let afterPath;
  try {
    afterDescriptor = fsImpl.fstatSync(descriptor);
    afterPath = fsImpl.lstatSync(file.realPath);
  } catch (_) {
    throw new Error(`${label} changed while it was read`);
  }
  if (!afterDescriptor.isFile() ||
      afterDescriptor.isSymbolicLink() ||
      afterDescriptor.nlink !== 1 ||
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterPath.nlink !== 1 ||
      !sameFileSnapshot(opened, afterDescriptor) ||
      !sameFileSnapshot(opened, afterPath)) {
    throw new Error(`${label} changed while it was read`);
  }
}

function parsePrivateJson(file, label, fsImpl = fs) {
  const opened = openPrivateFileDescriptor(file, label, fsImpl);
  let text;
  try {
    text = fsImpl.readFileSync(opened.descriptor, 'utf8');
    assertOpenPrivateFileUnchanged(
      file,
      opened.opened,
      opened.descriptor,
      label,
      fsImpl
    );
  } finally {
    try {
      fsImpl.closeSync(opened.descriptor);
    } catch (_) {}
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error(`${label} is not valid JSON`);
  }
}

function hashPrivateFile(file, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const cryptoImpl = options.cryptoImpl || crypto;
  return new Promise((resolve, reject) => {
    let stream;
    let opened;
    let settled = false;
    try {
      opened = openPrivateFileDescriptor(
        file,
        file.label || 'private artifact',
        fsImpl
      );
      stream = fsImpl.createReadStream(file.realPath, {
        fd: opened.descriptor,
        autoClose: false,
      });
    } catch (_) {
      reject(new Error(`${file.label || 'private artifact'} hash could not be computed`));
      return;
    }
    const hash = cryptoImpl.createHash('sha256');
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => {
      if (settled) return;
      settled = true;
      try {
        fsImpl.closeSync(opened.descriptor);
      } catch (_) {}
      reject(new Error(`${file.label || 'private artifact'} hash could not be computed`));
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        assertOpenPrivateFileUnchanged(
          file,
          opened.opened,
          opened.descriptor,
          file.label || 'private artifact',
          fsImpl
        );
      } catch (_) {
        try {
          fsImpl.closeSync(opened.descriptor);
        } catch (_) {}
        reject(new Error(`${file.label || 'private artifact'} changed while hashing`));
        return;
      }
      try {
        fsImpl.closeSync(opened.descriptor);
      } catch (_) {}
      resolve(hash.digest('hex'));
    });
  });
}

function validateSqliteHeader(databasePath, fsImpl = fs) {
  const header = Buffer.alloc(16);
  let descriptor;
  try {
    const constants = fsImpl.constants || fs.constants;
    const noFollow = process.platform === 'linux' && constants.O_NOFOLLOW
      ? constants.O_NOFOLLOW
      : 0;
    descriptor = fsImpl.openSync(
      databasePath,
      constants.O_RDONLY | noFollow
    );
    const bytesRead = fsImpl.readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead !== header.length ||
        !header.equals(Buffer.from('SQLite format 3\0', 'binary'))) {
      throw new Error('invalid header');
    }
  } catch (_) {
    throw new Error('private database backup is not a SQLite database');
  } finally {
    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch (_) {}
    }
  }
}

function validateSqliteIntegrity(databasePath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const execFileImpl = options.execFileImpl || childProcess.execFile;
  const pythonExecutable = options.pythonExecutable ||
    (process.platform === 'win32' ? 'python' : 'python3');
  assertSha256(
    options.expectedSha256,
    'expected private database backup'
  );
  validateSqliteHeader(databasePath, fsImpl);
  const integrityProgram = [
    'import hashlib, os, pathlib, sqlite3, stat, sys',
    'target, expected = sys.argv[1], sys.argv[2]',
    'flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)',
    'descriptor = os.open(target, flags)',
    'try:',
    '    before = os.fstat(descriptor)',
    '    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:',
    '        raise SystemExit("database identity is unsafe")',
    '    digest = hashlib.sha256()',
    '    os.lseek(descriptor, 0, os.SEEK_SET)',
    '    while True:',
    '        chunk = os.read(descriptor, 1024 * 1024)',
    '        if not chunk:',
    '            break',
    '        digest.update(chunk)',
    '    if digest.hexdigest() != expected:',
    '        raise SystemExit("database digest changed")',
    '    if sys.platform.startswith("linux"):',
    '        fd_path = f"/proc/self/fd/{descriptor}"',
    '        if not os.path.exists(fd_path):',
    '            raise SystemExit("proc fd identity is unavailable")',
    '        uri = pathlib.Path(fd_path).as_uri() + "?mode=ro&immutable=1"',
    '    else:',
    '        uri = pathlib.Path(target).resolve().as_uri() + "?mode=ro&immutable=1"',
    '    connection = sqlite3.connect(uri, uri=True)',
    '    try:',
    '        connection.execute("PRAGMA query_only=ON")',
    '        rows = connection.execute("PRAGMA integrity_check").fetchall()',
    '    finally:',
    '        connection.close()',
    '    after = os.fstat(descriptor)',
    '    identity = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mode, value.st_nlink, value.st_mtime_ns, value.st_ctime_ns)',
    '    if identity(before) != identity(after):',
    '        raise SystemExit("database changed during integrity_check")',
    'finally:',
    '    os.close(descriptor)',
    'if rows != [("ok",)]:',
    '    raise SystemExit("integrity_check did not return exactly ok")',
    'print("ok")',
  ].join('\n');
  return new Promise((resolve, reject) => {
    execFileImpl(
      pythonExecutable,
      ['-I', '-c', integrityProgram, databasePath, options.expectedSha256],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: SQLITE_INTEGRITY_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error || String(stdout || '').trim() !== 'ok') {
          reject(new Error('private database backup failed SQLite integrity_check'));
          return;
        }
        resolve(Object.freeze({ integrityCheck: 'ok' }));
      }
    );
  });
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} SHA-256 is invalid`);
  }
}

function sha256Matches(actual, expected) {
  const actualBytes = Buffer.from(actual, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return actualBytes.length === expectedBytes.length &&
    crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function validateLibraryIdentityManifest(manifestPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const now = options.now === undefined ? Date.now() : options.now;
  const root = inspectPrivateRoot(options.privateRoot, options);
  const file = inspectPrivateFile(
    root,
    manifestPath,
    'TDARR_PRIVATE_LIBRARY_IDENTITY_MANIFEST',
    {
      ...options,
      maximumBytes: LIBRARY_IDENTITY_MANIFEST_MAX_BYTES,
    }
  );
  const manifest = parsePrivateJson(file, 'private library identity manifest', fsImpl);
  if (!isRecord(manifest) ||
      manifest.schemaVersion !== 1 ||
      manifest.kind !== LIBRARY_IDENTITY_MANIFEST_KIND ||
      !Array.isArray(manifest.libraryIds)) {
    throw new Error('private library identity manifest has an invalid schema');
  }
  const reviewedAt = Date.parse(manifest.reviewedAt);
  if (!Number.isFinite(reviewedAt) || reviewedAt > now + 5 * 60 * 1000) {
    throw new Error('private library identity manifest reviewedAt is invalid');
  }
  if (manifest.libraryIds.length !== EXPECTED_LIBRARY_COUNT) {
    throw new Error(
      `private library identity manifest must contain exactly ` +
      `${EXPECTED_LIBRARY_COUNT} identities`
    );
  }
  const identities = new Set();
  for (const identity of manifest.libraryIds) {
    if (typeof identity !== 'string' ||
        identity.length === 0 ||
        identity.length > 512 ||
        identities.has(identity)) {
      throw new Error('private library identity manifest contains invalid identities');
    }
    identities.add(identity);
  }
  return Object.freeze({
    libraryIds: Object.freeze([...identities]),
    reviewedAt,
  });
}

function assertReviewedLibraryIdentities(libraries, manifest) {
  const current = validateLibraryDocuments(libraries, EXPECTED_LIBRARY_COUNT)
    .map((document) => document._id)
    .sort();
  const reviewed = [...manifest.libraryIds].sort();
  if (!sameValue(current, reviewed)) {
    throw new Error('reviewed library identity set does not match live library scope');
  }
}

async function validateArchiveReceipt(receiptPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const now = options.now === undefined ? Date.now() : options.now;
  const root = inspectPrivateRoot(options.privateRoot, options);
  const receiptFile = inspectPrivateFile(
    root,
    receiptPath,
    'TDARR_PRIVATE_ARCHIVE_RECEIPT',
    { ...options, maximumBytes: ARCHIVE_RECEIPT_MAX_BYTES }
  );
  const receipt = parsePrivateJson(receiptFile, 'private archive receipt', fsImpl);
  if (!isRecord(receipt) ||
      receipt.schemaVersion !== ARCHIVE_RECEIPT_SCHEMA_VERSION ||
      receipt.kind !== ARCHIVE_RECEIPT_KIND ||
      receipt.verified !== true ||
      !isRecord(receipt.archive) ||
      !isRecord(receipt.databaseBackup)) {
    throw new Error('private archive receipt has an invalid schema');
  }
  assertInteger(receipt.reportCount, 1, Number.MAX_SAFE_INTEGER, 'archive reportCount');
  assertSha256(receipt.archive.sha256, 'private report archive');
  assertSha256(receipt.databaseBackup.sha256, 'private database backup');
  const createdAt = Date.parse(receipt.createdAt);
  if (!Number.isFinite(createdAt) ||
      createdAt > now + 5 * 60 * 1000 ||
      createdAt < now - ARCHIVE_RECEIPT_MAX_AGE_MS) {
    throw new Error('private archive receipt createdAt is invalid');
  }

  const archiveFile = inspectPrivateRelativeFile(
    root,
    receipt.archive.path,
    'private report archive',
    options
  );
  const databaseFile = inspectPrivateRelativeFile(
    root,
    receipt.databaseBackup.path,
    'private database backup',
    options
  );
  if (archiveFile.realPath === databaseFile.realPath) {
    throw new Error('private archive and database backup must be different files');
  }
  const labelledArchive = { ...archiveFile, label: 'private report archive' };
  const labelledDatabase = { ...databaseFile, label: 'private database backup' };
  const [archiveSha256, databaseSha256] = await Promise.all([
    hashPrivateFile(labelledArchive, options),
    hashPrivateFile(labelledDatabase, options),
  ]);
  if (!sha256Matches(archiveSha256, receipt.archive.sha256)) {
    throw new Error('private report archive SHA-256 does not match receipt');
  }
  if (!sha256Matches(databaseSha256, receipt.databaseBackup.sha256)) {
    throw new Error('private database backup SHA-256 does not match receipt');
  }

  const sqliteIntegrity = options.sqliteIntegrity ||
    ((databasePath, expectedSha256) => validateSqliteIntegrity(databasePath, {
      ...options,
      expectedSha256,
    }));
  await sqliteIntegrity(
    databaseFile.realPath,
    receipt.databaseBackup.sha256
  );
  return Object.freeze({
    reportCount: receipt.reportCount,
    createdAt,
    archiveSha256,
    databaseSha256,
  });
}

async function assertApplyGates(plan, state, options, dependencies) {
  if (options.applyLatch !== '1') {
    throw new Error('apply requires ALLOW_TDARR_RUNTIME_SETTINGS_APPLY=1');
  }
  if (plan.expectedLibraryCount !== EXPECTED_LIBRARY_COUNT) {
    throw new Error(`apply is fixed to exactly ${EXPECTED_LIBRARY_COUNT} reviewed libraries`);
  }
  if (plan.retentionChangeRequired && options.allowRetentionChange !== '1') {
    throw new Error(
      'job report retention differs; explicit archival-backed retention approval is required'
    );
  }
  const manifest = await dependencies.validateLibraryIdentityManifest(
    options.libraryIdentityManifestPath,
    options.privateRoot
  );
  assertReviewedLibraryIdentities(state.libraries, manifest);
  await dependencies.validateArchiveReceipt(
    options.archiveReceiptPath,
    options.privateRoot
  );
}

async function applyPlan(plan, requestJson) {
  for (const update of plan.libraryUpdates) {
    await requestJson('cruddb', {
      method: 'POST',
      body: crudRequest(
        'LibrarySettingsJSONDB',
        'update',
        update.id,
        update.patch
      ),
      responseMode: 'mutation',
    });
  }
  if (Object.keys(plan.globalPatch).length !== 0) {
    await requestJson('cruddb', {
      method: 'POST',
      body: crudRequest(
        'SettingsGlobalJSONDB',
        'update',
        'globalsettings',
        plan.globalPatch
      ),
      responseMode: 'mutation',
    });
  }
}

function assertPreMutationState(
  before,
  current,
  expectedLibraryCount = EXPECTED_LIBRARY_COUNT
) {
  const beforeLibraries = validateLibraryDocuments(
    before.libraries,
    expectedLibraryCount
  );
  const currentLibraries = validateLibraryDocuments(
    current.libraries,
    expectedLibraryCount
  );
  const currentExact = validateLibraryDocuments(
    current.exactLibraries,
    expectedLibraryCount
  );
  const beforeById = new Map(
    beforeLibraries.map((document) => [document._id, document])
  );
  const currentById = new Map(
    currentLibraries.map((document) => [document._id, document])
  );
  if (beforeById.size !== currentById.size ||
      [...beforeById.keys()].some((identity) => !currentById.has(identity))) {
    throw new Error('library identity set changed before settings mutation');
  }
  for (let index = 0; index < beforeLibraries.length; index += 1) {
    const requestedIdentity = beforeLibraries[index]._id;
    const aggregate = currentById.get(requestedIdentity);
    const exact = currentExact[index];
    if (exact._id !== requestedIdentity ||
        !sameValue(exact, aggregate) ||
        !sameValue(exact, beforeById.get(requestedIdentity))) {
      throw new Error(
        `library document ${index + 1} changed before settings mutation`
      );
    }
  }
  const beforeGlobal = validateGlobalDocument(before.globalSettings);
  const currentGlobal = validateGlobalDocument(current.globalSettings);
  if (!sameValue(beforeGlobal, currentGlobal)) {
    throw new Error('global settings changed before settings mutation');
  }
}

function assertReadback(before, after, expectedLibraryCount = EXPECTED_LIBRARY_COUNT) {
  const beforeLibraries = validateLibraryDocuments(
    before.libraries,
    expectedLibraryCount
  );
  const afterLibraries = validateLibraryDocuments(
    after.libraries,
    expectedLibraryCount
  );
  const beforeById = new Map(beforeLibraries.map((document) => [document._id, document]));
  const afterById = new Map(afterLibraries.map((document) => [document._id, document]));
  if (beforeById.size !== afterById.size ||
      [...beforeById.keys()].some((id) => !afterById.has(id))) {
    throw new Error('library identity set changed during settings update');
  }
  const exactLibraries = validateLibraryDocuments(
    after.exactLibraries,
    expectedLibraryCount
  );
  for (let index = 0; index < exactLibraries.length; index += 1) {
    const requestedIdentity = beforeLibraries[index]._id;
    const exactDocument = exactLibraries[index];
    if (exactDocument._id !== requestedIdentity) {
      throw new Error(`library document ${index + 1} exact-ID readback mismatched`);
    }
    if (!sameValue(exactDocument, afterById.get(requestedIdentity))) {
      throw new Error(`library document ${index + 1} exact-ID readback diverged`);
    }
  }

  let ordinal = 0;
  for (const [id, prior] of beforeById.entries()) {
    const current = afterById.get(id);
    for (const [key, target] of Object.entries(TARGET_LIBRARY_SETTINGS)) {
      if (!sameValue(current[key], target)) {
        throw new Error(`library document ${ordinal + 1} failed target readback`);
      }
    }
    if (!sameValue(
      omitKeys(prior, LIBRARY_TARGET_KEYS),
      omitKeys(current, LIBRARY_TARGET_KEYS)
    )) {
      throw new Error(`library document ${ordinal + 1} changed outside the target fields`);
    }
    ordinal += 1;
  }

  const beforeGlobal = validateGlobalDocument(before.globalSettings);
  const afterGlobal = validateGlobalDocument(after.globalSettings);
  for (const [key, target] of Object.entries(TARGET_GLOBAL_SETTINGS)) {
    if (!sameValue(afterGlobal[key], target)) {
      throw new Error(`global ${key} failed target readback`);
    }
  }
  if (!sameValue(
    omitKeys(beforeGlobal, GLOBAL_TARGET_KEYS),
    omitKeys(afterGlobal, GLOBAL_TARGET_KEYS)
  )) {
    throw new Error('global settings changed outside the target fields');
  }
}

async function execute(options, suppliedDependencies = {}) {
  const config = options.config || quiescence.configFromEnv();
  const dependencies = {
    requestJson: suppliedDependencies.requestJson ||
      createRuntimeRequester(config),
    assertQuiescence: suppliedDependencies.assertQuiescence ||
      (() => quiescence.assertTdarrQuiescence(config)),
    validateArchiveReceipt: suppliedDependencies.validateArchiveReceipt ||
      ((receiptPath, privateRoot) => validateArchiveReceipt(receiptPath, {
        privateRoot,
      })),
    validateLibraryIdentityManifest:
      suppliedDependencies.validateLibraryIdentityManifest ||
      ((manifestPath, privateRoot) => validateLibraryIdentityManifest(
        manifestPath,
        { privateRoot }
      )),
  };

  await dependencies.assertQuiescence();
  const before = await getRuntimeState(dependencies.requestJson);
  const plan = buildPlan(before, {
    expectedLibraryCount: options.expectedLibraryCount,
  });

  if (!options.apply) {
    return Object.freeze({
      applied: false,
      libraryCount: plan.expectedLibraryCount,
      libraryDocumentsNeedingUpdate: plan.libraryUpdates.length,
      globalFieldsNeedingUpdate: Object.keys(plan.globalPatch).length,
      retentionChangeRequired: plan.retentionChangeRequired,
    });
  }

  await assertApplyGates(plan, before, options, dependencies);
  await dependencies.assertQuiescence();
  const preMutation = await getRuntimeState(
    dependencies.requestJson,
    before.libraries.map((document) => document._id)
  );
  assertPreMutationState(before, preMutation, plan.expectedLibraryCount);
  await applyPlan(plan, dependencies.requestJson);
  const after = await getRuntimeState(
    dependencies.requestJson,
    before.libraries.map((document) => document._id)
  );
  assertReadback(before, after, plan.expectedLibraryCount);
  await dependencies.assertQuiescence();

  return Object.freeze({
    applied: true,
    libraryCount: plan.expectedLibraryCount,
    libraryDocumentsUpdated: plan.libraryUpdates.length,
    globalFieldsUpdated: Object.keys(plan.globalPatch).length,
  });
}

function optionsFromProcess(argv = process.argv.slice(2), environment = process.env) {
  const allowed = new Set(['--apply']);
  for (const argument of argv) {
    if (!allowed.has(argument)) throw new Error(`unsupported argument: ${argument}`);
  }
  return {
    apply: argv.includes('--apply'),
    applyLatch: String(environment.ALLOW_TDARR_RUNTIME_SETTINGS_APPLY || ''),
    allowRetentionChange: String(environment.ALLOW_TDARR_JOB_RETENTION_CHANGE || ''),
    privateRoot: String(environment.TDARR_PRIVATE_RUNTIME_ROOT || ''),
    archiveReceiptPath: String(environment.TDARR_PRIVATE_ARCHIVE_RECEIPT || ''),
    libraryIdentityManifestPath: String(
      environment.TDARR_PRIVATE_LIBRARY_IDENTITY_MANIFEST || ''
    ),
    expectedLibraryCount: EXPECTED_LIBRARY_COUNT,
    config: quiescence.configFromEnv(environment),
  };
}

async function main() {
  const result = await execute(optionsFromProcess());
  if (result.applied) {
    console.log(
      `PASS applied reviewed Tdarr runtime settings to ` +
      `${result.libraryDocumentsUpdated}/${result.libraryCount} library document(s) ` +
      `and ${result.globalFieldsUpdated} global field(s); exact aggregate readback passed`
    );
  } else {
    console.log(
      `DRY RUN reviewed ${result.libraryCount} library document(s): ` +
      `${result.libraryDocumentsNeedingUpdate} need convergence; ` +
      `${result.globalFieldsNeedingUpdate} global field(s) differ; ` +
      `job-retention-change-required=${result.retentionChangeRequired}`
    );
  }
}

module.exports = {
  ARCHIVE_RECEIPT_KIND,
  ARCHIVE_RECEIPT_MAX_AGE_MS,
  ARCHIVE_RECEIPT_SCHEMA_VERSION,
  EXPECTED_LIBRARY_COUNT,
  GLOBAL_TARGET_KEYS,
  LIBRARY_IDENTITY_MANIFEST_KIND,
  LIBRARY_TARGET_KEYS,
  TARGET_GLOBAL_SETTINGS,
  TARGET_LIBRARY_SETTINGS,
  applyPlan,
  assertApplyGates,
  assertOwnerOnly,
  assertPreMutationState,
  assertReadback,
  assertReviewedLibraryIdentities,
  buildPlan,
  createRuntimeRequester,
  crudRequest,
  execute,
  getRuntimeState,
  hashPrivateFile,
  inspectPrivateFile,
  inspectPrivateRoot,
  omitKeys,
  optionsFromProcess,
  stableStringify,
  validateArchiveReceipt,
  validateGlobalDocument,
  validateLibraryIdentityManifest,
  validateLibraryDocuments,
  validateSqliteIntegrity,
};

if (require.main === module) {
  main().catch(() => {
    console.error(
      'FAIL Tdarr runtime settings (TDARR_RUNTIME_SETTINGS_FAILED)'
    );
    process.exitCode = 1;
  });
}
