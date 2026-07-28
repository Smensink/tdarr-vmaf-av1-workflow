'use strict';

// One-shot, fail-closed creation of the private post-recovery rollback
// generation consumed by apply-tdarr-runtime-settings.js.
//
// Run this in a helper container with:
//   * the live Tdarr volumes inherited read-only;
//   * Tdarr's network and PID namespaces shared for the API and /proc checks;
//   * one private destination parent mounted read-write.
//
// Nothing in the generated directory is suitable for publication.

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const quiescence = require('./assert-tdarr-quiescence');
const runtimeSettings = require('./apply-tdarr-runtime-settings');

const EVIDENCE_KIND = 'tdarr-post-recovery-private-evidence';
const EVIDENCE_SCHEMA_VERSION = 1;
const TERMINAL_RECOVERY_RECEIPT_SCHEMA_VERSION = 1;
const TERMINAL_RECOVERY_RECEIPT_CONTRACT_ID =
  'vmaf-private-controlled-retained-terminal-receipt-v1';
const TERMINAL_RECOVERY_JOURNAL_SCHEMA_VERSION = 1;
const TERMINAL_RECOVERY_JOURNAL_CONTRACT_ID =
  'vmaf-private-controlled-retained-terminal-journal-v1';
const TERMINAL_RECOVERY_WATCHER_CONTRACT_ID =
  'vmaf-private-controlled-retained-terminal-watcher-v1';
const TERMINAL_RECOVERY_WATCHER_SHA256 =
  '1bad22b5c92f087be3922ed67f95e57f8f2a95bd3897725bf1bf0a1d4177c53e';
const TERMINAL_RECOVERY_WATCHER_SIZE = 66898;
const TERMINAL_RECOVERY_RECEIPT_MAX_BYTES = 4 * 1024 * 1024;
const TERMINAL_RECOVERY_JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const TERMINAL_RECOVERY_RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PRODUCTION_SOURCE_CONTRACT_ID =
  'tdarr-r3-live-source-layout-v1';
const OVERRIDE_SOURCE_CONTRACT_ID =
  'tdarr-explicit-source-override-v1';
const JOB_REPORT_COUNT_CONTRACT_ID =
  'tdarr-job-report-descendant-txt-v1';
const LIBRARY_MANIFEST_KIND = runtimeSettings.LIBRARY_IDENTITY_MANIFEST_KIND;
const RECEIPT_KIND = runtimeSettings.ARCHIVE_RECEIPT_KIND;
const RECEIPT_SCHEMA_VERSION =
  runtimeSettings.ARCHIVE_RECEIPT_SCHEMA_VERSION;
const EXPECTED_LIBRARY_COUNT = runtimeSettings.EXPECTED_LIBRARY_COUNT;
const MAX_TREE_ENTRIES = 1_000_000;
const MAX_FLOW_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_LIST_BYTES = 256 * 1024 * 1024;
const DEFAULT_SQLITE_BACKUP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_ARCHIVE_TIMEOUT_MS = 30 * 60 * 1000;
const PRODUCTION_SOURCES = Object.freeze({
  databasePath: '/app/server/Tdarr/DB2/SQL/database.db',
  learningDatabasePath: '/app/configs/vmaf_training.db',
  jobReportsRoot: '/app/server/Tdarr/DB2/JobReports',
  configsRoot: '/app/configs',
  flowId: 'YR5PZ1QaD',
});
const TERMINAL_RECOVERY_MILESTONE_KEYS = Object.freeze([
  'assignment_observed',
  'report_identity_authenticated',
  'prepared_replay_authenticated',
  'checkpoint_reuse_authenticated',
  'latch_log_observed',
  'encode_skip_log_observed',
  'no_encoder_command_after_latch',
  'staging_descriptor_hashed',
  'retirement_snapshot_observed',
  'retirement_log_observed',
  'report_terminal_success',
  'api_terminal_success',
]);

const ARTIFACT_PATHS = Object.freeze({
  database: 'backups/database.db',
  learningDatabase: 'backups/vmaf_training.db',
  jobReports: 'archives/job-reports.tar.gz',
  configs: 'archives/configs.tar.gz',
  activeFlow: 'snapshots/active-flow.json',
  libraries: 'reviewed-libraries.json',
  terminalRecoveryReceipt: 'terminal-recovery-receipt.json',
  terminalRecoveryJournal: 'terminal-recovery-journal.jsonl',
  terminalRecoveryWatcher: 'watch-controlled-retained-recovery.js',
  receipt: 'archive-receipt.json',
  checksums: 'SHA256SUMS.txt',
  evidenceManifest: 'evidence-manifest.json',
});

const PYTHON_ARCHIVE_PROGRAM = String.raw`
import json
import os
import stat
import sys
import tarfile

root_path, inventory_path, archive_path = sys.argv[1:4]

with open(inventory_path, "r", encoding="utf-8") as handle:
    inventory = json.load(handle)

if not isinstance(inventory, list) or not inventory:
    raise SystemExit("invalid inventory")

def expected_identity(entry):
    return tuple(int(entry[key]) for key in (
        "dev", "ino", "size", "mode", "nlink", "mtimeNs", "ctimeNs"
    ))

def actual_identity(value):
    return (
        value.st_dev,
        value.st_ino,
        value.st_size,
        value.st_mode,
        value.st_nlink,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )

def identities_match(left, right):
    if sys.platform.startswith("win"):
        # Windows can update st_ctime merely by opening a file, and Node and
        # Python expose incompatible st_dev values there. Production Linux
        # continues to compare the complete identity tuple.
        return left[1:6] == right[1:6]
    return left == right

def matches_expected(value, entry):
    actual = actual_identity(value)
    expected = expected_identity(entry)
    return identities_match(actual, expected)

def unsafe_relative_path(value):
    return (
        not isinstance(value, str)
        or not value
        or value.startswith("/")
        or "\\" in value
        or any(ord(character) < 32 or ord(character) == 127
               for character in value)
        or any(part in ("", ".", "..") for part in value.split("/"))
    )

def open_linux_relative(root_fd, relative_path):
    parts = relative_path.split("/")
    if unsafe_relative_path(relative_path):
        raise SystemExit("unsafe relative path")
    directory_fd = os.dup(root_fd)
    try:
        for component in parts[:-1]:
            next_fd = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
            os.close(directory_fd)
            directory_fd = next_fd
        return os.open(
            parts[-1],
            os.O_RDONLY | os.O_NOFOLLOW,
            dir_fd=directory_fd,
        )
    finally:
        os.close(directory_fd)

def open_portable_relative(relative_path):
    parts = relative_path.split("/")
    if unsafe_relative_path(relative_path):
        raise SystemExit("unsafe relative path")
    candidate = os.path.abspath(os.path.join(root_path, *parts))
    root = os.path.abspath(root_path)
    if os.path.commonpath((root, candidate)) != root:
        raise SystemExit("path escape")
    before = os.lstat(candidate)
    if stat.S_ISLNK(before.st_mode):
        raise SystemExit("symlink")
    descriptor = os.open(
        candidate,
        os.O_RDONLY | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    if not identities_match(
        actual_identity(before),
        actual_identity(os.fstat(descriptor)),
    ):
        os.close(descriptor)
        raise SystemExit("identity changed")
    return descriptor

root_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) \
    | getattr(os, "O_NOFOLLOW", 0)
root_fd = os.open(root_path, root_flags) \
    if sys.platform.startswith("linux") else None
output_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL \
    | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
output_fd = os.open(archive_path, output_flags, 0o600)

try:
    with os.fdopen(output_fd, "wb", closefd=False) as output:
        with tarfile.open(
            fileobj=output,
            mode="w:gz",
            format=tarfile.PAX_FORMAT,
            dereference=False,
        ) as archive:
            for entry in inventory:
                if not isinstance(entry, dict):
                    raise SystemExit("invalid entry")
                relative_path = entry.get("path")
                archive_name = entry.get("archiveName")
                if (
                    archive_name != relative_path
                    or unsafe_relative_path(relative_path)
                    or unsafe_relative_path(archive_name)
                ):
                    raise SystemExit("invalid path")
                descriptor = (
                    open_linux_relative(root_fd, relative_path)
                    if sys.platform.startswith("linux")
                    else open_portable_relative(relative_path)
                )
                try:
                    before = os.fstat(descriptor)
                    if (
                        not stat.S_ISREG(before.st_mode)
                        or before.st_nlink != 1
                        or not matches_expected(before, entry)
                    ):
                        raise SystemExit("unsafe source identity")
                    info = tarfile.TarInfo(archive_name)
                    info.size = before.st_size
                    info.mode = stat.S_IMODE(before.st_mode)
                    info.mtime = before.st_mtime_ns // 1_000_000_000
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    with os.fdopen(os.dup(descriptor), "rb") as source:
                        archive.addfile(info, source)
                    after = os.fstat(descriptor)
                    if not identities_match(
                        actual_identity(before),
                        actual_identity(after),
                    ):
                        raise SystemExit("source changed")
                finally:
                    os.close(descriptor)
        output.flush()
        os.fsync(output.fileno())
    os.fchmod(output_fd, 0o600)
    final = os.fstat(output_fd)
    if (
        not stat.S_ISREG(final.st_mode)
        or final.st_nlink != 1
        or final.st_size <= 0
    ):
        raise SystemExit("unsafe archive")
finally:
    os.close(output_fd)
    if root_fd is not None:
        os.close(root_fd)

expected = {
    entry["archiveName"]: (int(entry["size"]), int(entry["mode"]) & 0o777)
    for entry in inventory
}
observed = {}
with tarfile.open(archive_path, mode="r:gz") as archive:
    for member in archive:
        name = member.name
        if (
            unsafe_relative_path(name)
            or name in observed
            or not member.isreg()
            or name not in expected
        ):
            raise SystemExit("unsafe archive member")
        expected_size, expected_mode = expected[name]
        if member.size != expected_size or member.mode != expected_mode:
            raise SystemExit("archive member metadata mismatch")
        extracted = archive.extractfile(member)
        if extracted is None:
            raise SystemExit("archive member cannot be read")
        remaining = member.size
        while remaining:
            chunk = extracted.read(min(1024 * 1024, remaining))
            if not chunk:
                raise SystemExit("archive member is truncated")
            remaining -= len(chunk)
        if extracted.read(1):
            raise SystemExit("archive member exceeds declared size")
        observed[name] = True

if set(observed) != set(expected) or len(observed) != len(inventory):
    raise SystemExit("archive member set mismatch")

print(f"ok:{len(inventory)}")
`;

const PYTHON_SQLITE_BACKUP_PROGRAM = String.raw`
import os
import pathlib
import sqlite3
import stat
import sys
import time

source_path, destination_path, timeout_ms = sys.argv[1:4]
deadline = time.monotonic() + (int(timeout_ms) / 1000)
flags = os.O_RDWR | os.O_CREAT | os.O_EXCL \
    | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
descriptor = os.open(destination_path, flags, 0o600)
os.close(descriptor)

source_uri = pathlib.Path(source_path).resolve().as_uri() + "?mode=ro"
source = sqlite3.connect(source_uri, uri=True, timeout=30)
destination = sqlite3.connect(destination_path, timeout=30)
try:
    source.execute("PRAGMA query_only=ON")
    source.execute("PRAGMA busy_timeout=30000")
    destination.execute("PRAGMA busy_timeout=30000")

    def progress(status, remaining, total):
        if time.monotonic() > deadline:
            raise TimeoutError("online backup deadline exceeded")

    source.backup(
        destination,
        pages=256,
        progress=progress,
        sleep=0.05,
    )
    destination.commit()
    rows = destination.execute("PRAGMA integrity_check").fetchall()
    if rows != [("ok",)]:
        raise SystemExit("integrity_check did not return exactly ok")
finally:
    destination.close()
    source.close()

os.chmod(destination_path, 0o600)
final = os.lstat(destination_path)
if (
    not stat.S_ISREG(final.st_mode)
    or stat.S_ISLNK(final.st_mode)
    or final.st_nlink != 1
    or final.st_size <= 0
):
    raise SystemExit("unsafe backup output")
print("ok")
`;

const PYTHON_SQLITE_INTEGRITY_PROGRAM = String.raw`
import pathlib
import sqlite3
import sys

database_path = sys.argv[1]
uri = pathlib.Path(database_path).resolve().as_uri() \
    + "?mode=ro&immutable=1"
database = sqlite3.connect(uri, uri=True, timeout=30)
try:
    database.execute("PRAGMA query_only=ON")
    rows = database.execute("PRAGMA integrity_check").fetchall()
    if rows != [("ok",)]:
        raise SystemExit("integrity_check did not return exactly ok")
finally:
    database.close()
print("ok")
`;

const PYTHON_ACTIVE_FLOW_PROGRAM = String.raw`
import pathlib
import sqlite3
import sys

database_path, flow_id, maximum_bytes = sys.argv[1:4]
uri = pathlib.Path(database_path).resolve().as_uri() \
    + "?mode=ro&immutable=1"
database = sqlite3.connect(uri, uri=True, timeout=30)
try:
    database.execute("PRAGMA query_only=ON")
    rows = database.execute(
        "SELECT json_data FROM flowsjsondb WHERE id = ?",
        (flow_id,),
    ).fetchall()
finally:
    database.close()
if len(rows) != 1 or not isinstance(rows[0][0], str):
    raise SystemExit("active Flow row is unavailable")
encoded = rows[0][0].encode("utf-8")
if not encoded or len(encoded) > int(maximum_bytes):
    raise SystemExit("active Flow row size is invalid")
sys.stdout.buffer.write(encoded)
`;

const PYTHON_PUBLISH_PROGRAM = String.raw`
import ctypes
import errno
import os
import sys

source, destination = sys.argv[1:3]
if os.path.lexists(destination):
    raise SystemExit("destination exists")

if sys.platform.startswith("linux"):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise SystemExit("renameat2 unavailable")
    renameat2.argtypes = [
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_uint,
    ]
    renameat2.restype = ctypes.c_int
    result = renameat2(
        -100,
        os.fsencode(source),
        -100,
        os.fsencode(destination),
        1,
    )
    if result != 0:
        value = ctypes.get_errno()
        if value in (errno.EEXIST, errno.ENOTEMPTY):
            raise SystemExit("destination exists")
        raise OSError(value, os.strerror(value))
else:
    os.rename(source, destination)

print("ok")
`;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256Equal(left, right) {
  if (!isSha256(left) || !isSha256(right)) return false;
  return crypto.timingSafeEqual(
    Buffer.from(left, 'hex'),
    Buffer.from(right, 'hex')
  );
}

function absolutePath(value, label) {
  if (typeof value !== 'string' ||
      value.length === 0 ||
      value.includes('\0') ||
      !path.isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function safeRelativePath(value, label) {
  if (typeof value !== 'string' ||
      value.length === 0 ||
      /[\x00-\x1f\x7f\\]/.test(value) ||
      path.posix.isAbsolute(value) ||
      value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError(`${label} must be a safe relative path`);
  }
  return value;
}

function toLocalPath(rootPath, relativePath) {
  const safe = safeRelativePath(relativePath, 'artifact path');
  const target = path.resolve(rootPath, ...safe.split('/'));
  const relative = path.relative(rootPath, target);
  if (relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)) {
    throw new Error('artifact path escapes the evidence root');
  }
  return target;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right) &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function bigintStat(fsImpl, filePath) {
  return fsImpl.lstatSync(filePath, { bigint: true });
}

function inspectDirectory(fsImpl, directoryPath, label) {
  const requestedPath = absolutePath(directoryPath, label);
  let requested;
  let realPath;
  let canonical;
  try {
    requested = bigintStat(fsImpl, requestedPath);
    realPath = fsImpl.realpathSync(requestedPath);
    canonical = bigintStat(fsImpl, realPath);
  } catch (_) {
    throw new Error(`${label} cannot be inspected`);
  }
  if (!requested.isDirectory() ||
      requested.isSymbolicLink() ||
      !canonical.isDirectory() ||
      canonical.isSymbolicLink() ||
      !sameIdentity(requested, canonical)) {
    throw new Error(`${label} must be a non-symlink directory`);
  }
  return Object.freeze({ requestedPath, realPath, stat: canonical, label });
}

function inspectRegularFile(fsImpl, filePath, label) {
  const requestedPath = absolutePath(filePath, label);
  let requested;
  let realPath;
  let canonical;
  try {
    requested = bigintStat(fsImpl, requestedPath);
    realPath = fsImpl.realpathSync(requestedPath);
    canonical = bigintStat(fsImpl, realPath);
  } catch (_) {
    throw new Error(`${label} cannot be inspected`);
  }
  if (!requested.isFile() ||
      requested.isSymbolicLink() ||
      requested.nlink !== 1n ||
      !canonical.isFile() ||
      canonical.isSymbolicLink() ||
      canonical.nlink !== 1n ||
      !sameSnapshot(requested, canonical)) {
    throw new Error(`${label} must be a single-link regular non-symlink file`);
  }
  return Object.freeze({ requestedPath, realPath, stat: canonical, label });
}

function assertFileIdentityStillPresent(fsImpl, file, label) {
  let current;
  let realPath;
  try {
    current = bigintStat(fsImpl, file.realPath);
    realPath = fsImpl.realpathSync(file.realPath);
  } catch (_) {
    throw new Error(`${label} identity changed`);
  }
  if (!current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      realPath !== file.realPath ||
      !sameIdentity(file.stat, current)) {
    throw new Error(`${label} identity changed`);
  }
}

function assertFileSnapshotStillPresent(fsImpl, file, label) {
  let current;
  let realPath;
  try {
    current = bigintStat(fsImpl, file.realPath);
    realPath = fsImpl.realpathSync(file.realPath);
  } catch (_) {
    throw new Error(`${label} changed`);
  }
  if (!current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      realPath !== file.realPath ||
      !sameSnapshot(file.stat, current)) {
    throw new Error(`${label} changed`);
  }
}

function pathsOverlap(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b ||
    a.startsWith(`${b}${path.sep}`) ||
    b.startsWith(`${a}${path.sep}`);
}

function inspectDestination(fsImpl, destinationPath, sourcePaths) {
  const requestedPath = absolutePath(
    destinationPath,
    'TDARR_PRIVATE_EVIDENCE_DESTINATION'
  );
  const basename = path.basename(requestedPath);
  if (!basename || basename === '.' || basename === '..') {
    throw new Error('private evidence destination name is invalid');
  }
  const parent = inspectDirectory(
    fsImpl,
    path.dirname(requestedPath),
    'private evidence destination parent'
  );
  const canonicalPath = path.join(parent.realPath, basename);
  if (path.resolve(requestedPath) !==
      path.resolve(parent.requestedPath, basename)) {
    throw new Error('private evidence destination is not a direct child');
  }
  for (const sourcePath of sourcePaths) {
    if (pathsOverlap(canonicalPath, sourcePath) ||
        pathsOverlap(parent.realPath, sourcePath)) {
      throw new Error('private evidence destination overlaps a source');
    }
  }
  try {
    fsImpl.lstatSync(canonicalPath);
    throw new Error('private evidence destination already exists');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  return Object.freeze({
    requestedPath,
    canonicalPath,
    parent,
    basename,
  });
}

function makeDirectoryExclusive(fsImpl, directoryPath) {
  fsImpl.mkdirSync(directoryPath, { recursive: false, mode: 0o700 });
  try {
    fsImpl.chmodSync(directoryPath, 0o700);
  } catch (_) {}
  const stat = bigintStat(fsImpl, directoryPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('generated directory is unsafe');
  }
  return stat;
}

function allocateStagingDirectory(
  fsImpl,
  destination,
  randomBytes = crypto.randomBytes
) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const suffix = randomBytes(12).toString('hex');
    const stagingPath = path.join(
      destination.parent.realPath,
      `.${destination.basename}.partial-${suffix}`
    );
    try {
      const stat = makeDirectoryExclusive(fsImpl, stagingPath);
      return Object.freeze({ path: stagingPath, stat });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('could not allocate a unique evidence staging directory');
}

function ensureArtifactDirectories(fsImpl, rootPath) {
  for (const relativePath of ['backups', 'archives', 'snapshots']) {
    makeDirectoryExclusive(fsImpl, toLocalPath(rootPath, relativePath));
  }
}

function openExclusiveForWrite(fsImpl, filePath, mode = 0o600) {
  const constants = fsImpl.constants || fs.constants;
  const noFollow = constants.O_NOFOLLOW || 0;
  return fsImpl.openSync(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    mode
  );
}

function writeExclusiveFile(fsImpl, filePath, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  let descriptor;
  try {
    descriptor = openExclusiveForWrite(fsImpl, filePath);
    fsImpl.writeFileSync(descriptor, data);
    fsImpl.fsyncSync(descriptor);
    try {
      fsImpl.fchmodSync(descriptor, 0o600);
    } catch (_) {}
  } finally {
    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch (_) {}
    }
  }
  const file = inspectRegularFile(fsImpl, filePath, 'generated private file');
  if (file.stat.size !== BigInt(data.length)) {
    throw new Error('generated private file size changed');
  }
  return file;
}

function fsyncExistingFile(fsImpl, filePath) {
  const constants = fsImpl.constants || fs.constants;
  const noFollow = constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(filePath, constants.O_RDWR | noFollow);
    fsImpl.fsyncSync(descriptor);
    try {
      fsImpl.fchmodSync(descriptor, 0o600);
    } catch (_) {}
  } finally {
    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch (_) {}
    }
  }
}

function fsyncDirectory(fsImpl, directoryPath) {
  let descriptor;
  try {
    descriptor = fsImpl.openSync(directoryPath, fsImpl.constants.O_RDONLY);
    fsImpl.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'win32' ||
        !error ||
        !['EINVAL', 'EPERM', 'EACCES'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch (_) {}
    }
  }
}

function safeRemoveCreatedDirectory(
  fsImpl,
  parent,
  createdPath,
  createdStat
) {
  try {
    const current = bigintStat(fsImpl, createdPath);
    const realPath = fsImpl.realpathSync(createdPath);
    if (!current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameIdentity(current, createdStat) ||
        realPath !== createdPath ||
        path.dirname(realPath) !== parent.realPath) {
      return false;
    }
    fsImpl.rmSync(createdPath, {
      recursive: true,
      force: false,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function assertApplyReadyTree(
  fsImpl,
  rootPath,
  platform = process.platform,
  expectedFilePaths
) {
  let directoryCount = 0;
  let fileCount = 0;
  const observedFiles = new Set();
  const observedDirectories = new Set();
  function visit(targetPath) {
    const stat = bigintStat(fsImpl, targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error('generated evidence contains a symlink');
    }
    const mode = Number(stat.mode & 0o777n);
    const relative = path.relative(rootPath, targetPath)
      .split(path.sep).join('/');
    if (stat.isDirectory()) {
      observedDirectories.add(relative);
      directoryCount += 1;
      if (platform === 'linux' && mode !== 0o700) {
        throw new Error('generated evidence directory mode is not 0700');
      }
      for (const name of fsImpl.readdirSync(targetPath).sort()) {
        visit(path.join(targetPath, name));
      }
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1n) {
      throw new Error(
        'generated evidence contains a non-regular or hard-linked file'
      );
    }
    if (platform === 'linux' && mode !== 0o600) {
      throw new Error('generated evidence file mode is not 0600');
    }
    observedFiles.add(relative);
    fileCount += 1;
  }
  visit(rootPath);
  if (expectedFilePaths) {
    const expectedFiles = new Set(
      [...expectedFilePaths].map((value) =>
        safeRelativePath(value, 'expected generated artifact')
      )
    );
    const expectedDirectories = new Set([
      '',
      'archives',
      'backups',
      'snapshots',
    ]);
    if (observedFiles.size !== expectedFiles.size ||
        observedDirectories.size !== expectedDirectories.size ||
        [...observedFiles].some((value) => !expectedFiles.has(value)) ||
        [...observedDirectories].some(
          (value) => !expectedDirectories.has(value)
        )) {
      throw new Error('generated evidence artifact set is not exact');
    }
  }
  return Object.freeze({ directoryCount, fileCount });
}

function defaultPublishStaging(options) {
  const result = childProcess.spawnSync(
    options.pythonExecutable,
    [
      '-I',
      '-c',
      PYTHON_PUBLISH_PROGRAM,
      options.stagingPath,
      options.destinationPath,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024,
      timeout: 30_000,
    }
  );
  if (!result ||
      result.status !== 0 ||
      result.signal ||
      String(result.stdout || '').trim() !== 'ok') {
    throw new Error('private evidence publication failed');
  }
}

function relativeFromRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  if (relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)) {
    throw new Error('source entry escapes its root');
  }
  return safeRelativePath(
    relative.split(path.sep).join('/'),
    'source entry path'
  );
}

function snapshotForArchive(stat) {
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

function scanRegularTree(fsImpl, root, options = {}) {
  const excluded = options.excluded || new Set();
  const label = options.label || 'private source tree';
  const files = new Map();
  const directories = new Map();
  let entries = 0;

  function visit(directoryPath) {
    let names;
    try {
      names = fsImpl.readdirSync(directoryPath).sort();
    } catch (_) {
      throw new Error(`${label} cannot be enumerated`);
    }
    for (const name of names) {
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) {
        throw new Error(`${label} contains too many entries`);
      }
      const fullPath = path.join(directoryPath, name);
      const relativePath = relativeFromRoot(root.realPath, fullPath);
      let stat;
      let realPath;
      let canonical;
      try {
        stat = bigintStat(fsImpl, fullPath);
        realPath = fsImpl.realpathSync(fullPath);
        canonical = bigintStat(fsImpl, realPath);
      } catch (_) {
        throw new Error(`${label} contains an unreadable entry`);
      }
      if (stat.isSymbolicLink() ||
          canonical.isSymbolicLink() ||
          !sameSnapshot(stat, canonical) ||
          relativeFromRoot(root.realPath, realPath) !== relativePath) {
        throw new Error(`${label} contains an unsafe entry`);
      }
      if (stat.isDirectory()) {
        directories.set(relativePath, stat);
        visit(fullPath);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1n) {
          throw new Error(`${label} contains a hard-linked file`);
        }
        if (!excluded.has(relativePath)) {
          files.set(relativePath, Object.freeze({
            path: relativePath,
            archiveName: relativePath,
            fullPath,
            stat,
          }));
        }
      } else {
        throw new Error(`${label} contains a non-regular entry`);
      }
    }
  }

  visit(root.realPath);
  return Object.freeze({ files, directories, rootStat: root.stat });
}

function assertTreeStable(before, after, label) {
  if (!sameIdentity(before.rootStat, after.rootStat) ||
      before.files.size !== after.files.size ||
      before.directories.size !== after.directories.size) {
    throw new Error(`${label} changed while it was archived`);
  }
  for (const [relativePath, entry] of before.files.entries()) {
    const current = after.files.get(relativePath);
    if (!current || !sameSnapshot(entry.stat, current.stat)) {
      throw new Error(`${label} changed while it was archived`);
    }
  }
  for (const [relativePath, stat] of before.directories.entries()) {
    const current = after.directories.get(relativePath);
    if (!current || !sameSnapshot(stat, current)) {
      throw new Error(`${label} changed while it was archived`);
    }
  }
}

function archiveInventory(entries) {
  return [...entries.values()].map((entry) => ({
    path: entry.path,
    archiveName: entry.archiveName,
    ...snapshotForArchive(entry.stat),
  }));
}

function defaultArchiveRunner(options) {
  const {
    fsImpl,
    pythonExecutable,
    root,
    entries,
    archivePath,
    inventoryPath,
  } = options;
  const inventory = archiveInventory(entries);
  if (inventory.length === 0) {
    throw new Error('private source archive cannot be empty');
  }
  const encoded = `${JSON.stringify(inventory)}\n`;
  if (Buffer.byteLength(encoded) > MAX_ARCHIVE_LIST_BYTES) {
    throw new Error('private source archive inventory is too large');
  }
  writeExclusiveFile(fsImpl, inventoryPath, encoded);
  let result;
  let inventoryRemoved = false;
  try {
    result = childProcess.spawnSync(
      pythonExecutable,
      [
        '-I',
        '-c',
        PYTHON_ARCHIVE_PROGRAM,
        root.realPath,
        inventoryPath,
        archivePath,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024,
        timeout: options.timeoutMs,
      }
    );
  } finally {
    try {
      fsImpl.unlinkSync(inventoryPath);
      inventoryRemoved = true;
    } catch (_) {}
  }
  if (!inventoryRemoved ||
      !result ||
      result.status !== 0 ||
      String(result.stdout || '').trim() !== `ok:${inventory.length}`) {
    throw new Error('private source archive creation failed');
  }
  fsyncExistingFile(fsImpl, archivePath);
  return inspectRegularFile(fsImpl, archivePath, 'generated private archive');
}

async function createStableArchive(options, dependencies) {
  const before = scanRegularTree(dependencies.fs, options.root, {
    excluded: options.excluded,
    label: options.label,
  });
  if (before.files.size === 0) {
    throw new Error(`${options.label} contains no regular files`);
  }
  const archive = await dependencies.archiveRunner({
    fsImpl: dependencies.fs,
    pythonExecutable: options.pythonExecutable,
    timeoutMs: options.archiveTimeoutMs,
    root: options.root,
    entries: before.files,
    archivePath: options.archivePath,
    inventoryPath: options.inventoryPath,
  });
  const afterRoot = inspectDirectory(
    dependencies.fs,
    options.root.realPath,
    options.label
  );
  const after = scanRegularTree(dependencies.fs, afterRoot, {
    excluded: options.excluded,
    label: options.label,
  });
  assertTreeStable(before, after, options.label);
  const countedFileCount = typeof options.countPredicate === 'function'
    ? [...before.files.keys()].filter(options.countPredicate).length
    : before.files.size;
  return Object.freeze({
    file: archive,
    regularFileCount: before.files.size,
    countedFileCount,
  });
}

function validateSqliteIntegrity(databasePath, options) {
  const result = childProcess.spawnSync(
    options.pythonExecutable,
    [
      '-I',
      '-c',
      PYTHON_SQLITE_INTEGRITY_PROGRAM,
      databasePath,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024,
      timeout: options.sqliteBackupTimeoutMs,
    }
  );
  if (!result ||
      result.status !== 0 ||
      result.signal ||
      String(result.stdout || '').trim() !== 'ok') {
    throw new Error('SQLite integrity_check failed');
  }
  return Object.freeze({ integrityCheck: 'ok' });
}

function defaultSqliteBackup(options) {
  const result = childProcess.spawnSync(
    options.pythonExecutable,
    [
      '-I',
      '-c',
      PYTHON_SQLITE_BACKUP_PROGRAM,
      options.sourcePath,
      options.destinationPath,
      String(options.timeoutMs),
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024,
      timeout: options.timeoutMs + 5000,
    }
  );
  if (!result ||
      result.status !== 0 ||
      result.signal ||
      String(result.stdout || '').trim() !== 'ok') {
    throw new Error('SQLite online backup failed');
  }
}

async function createOnlineSqliteBackup(
  source,
  destinationPath,
  options,
  dependencies
) {
  try {
    dependencies.fs.lstatSync(destinationPath);
    throw new Error('SQLite backup destination already exists');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  await dependencies.sqliteBackup({
    sourcePath: source.realPath,
    destinationPath,
    pythonExecutable: options.pythonExecutable,
    timeoutMs: options.sqliteBackupTimeoutMs,
  });
  assertFileIdentityStillPresent(
    dependencies.fs,
    source,
    source.label
  );
  fsyncExistingFile(dependencies.fs, destinationPath);
  const generated = inspectRegularFile(
    dependencies.fs,
    destinationPath,
    'generated SQLite backup'
  );
  validateSqliteIntegrity(generated.realPath, options);
  return generated;
}

function readActiveFlow(databasePath, flowId, options) {
  const result = childProcess.spawnSync(
    options.pythonExecutable,
    [
      '-I',
      '-c',
      PYTHON_ACTIVE_FLOW_PROGRAM,
      databasePath,
      flowId,
      String(MAX_FLOW_BYTES),
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_FLOW_BYTES + 1024,
      timeout: options.sqliteBackupTimeoutMs,
    }
  );
  if (!result ||
      result.status !== 0 ||
      result.signal ||
      !Buffer.isBuffer(result.stdout) ||
      result.stdout.length === 0 ||
      result.stdout.length > MAX_FLOW_BYTES) {
    throw new Error('active Flow snapshot is unavailable');
  }
  let flow;
  try {
    flow = JSON.parse(result.stdout.toString('utf8'));
  } catch (_) {
    throw new Error('active Flow snapshot is not valid JSON');
  }
  if (!isRecord(flow) || flow._id !== flowId) {
    throw new Error('active Flow snapshot identity differs');
  }
  return flow;
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!isRecord(value)) return value;
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) output[key] = stableJson(value[key]);
  return output;
}

function sameJson(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right));
}

function sha256FileStable(fsImpl, filePath) {
  const inspected = inspectRegularFile(fsImpl, filePath, 'private artifact');
  const constants = fsImpl.constants || fs.constants;
  const noFollow = constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(
      inspected.realPath,
      constants.O_RDONLY | noFollow
    );
    const opened = fsImpl.fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(inspected.stat, opened) ||
        !opened.isFile() ||
        opened.nlink !== 1n) {
      throw new Error('private artifact changed before hashing');
    }
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const count = fsImpl.readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        offset
      );
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fsImpl.fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(opened, after)) {
      throw new Error('private artifact changed while hashing');
    }
    return Object.freeze({
      sha256: digest.digest('hex'),
      size: Number(opened.size),
    });
  } finally {
    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch (_) {}
    }
  }
}

function readStableFile(fsImpl, file, maximumBytes) {
  if (file.stat.size <= 0n || file.stat.size > BigInt(maximumBytes)) {
    throw new Error('private reviewed file size is invalid');
  }
  const constants = fsImpl.constants || fs.constants;
  const noFollow = constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fsImpl.openSync(file.realPath, constants.O_RDONLY | noFollow);
    const opened = fsImpl.fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(file.stat, opened) ||
        !opened.isFile() ||
        opened.nlink !== 1n) {
      throw new Error('private reviewed file changed before reading');
    }
    const bytes = fsImpl.readFileSync(descriptor);
    const after = fsImpl.fstatSync(descriptor, { bigint: true });
    if (!sameSnapshot(opened, after) ||
        bytes.length !== Number(opened.size)) {
      throw new Error('private reviewed file changed while reading');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch (_) {}
    }
  }
}

function readReviewedLibraryManifest(fsImpl, manifestPath, now) {
  const file = inspectRegularFile(
    fsImpl,
    manifestPath,
    'reviewed library identity manifest'
  );
  const bytes = readStableFile(fsImpl, file, 32 * 1024);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (_) {
    throw new Error('reviewed library identity manifest is not valid JSON');
  }
  if (!isRecord(manifest) ||
      manifest.schemaVersion !== 1 ||
      manifest.kind !== LIBRARY_MANIFEST_KIND ||
      !Array.isArray(manifest.libraryIds) ||
      manifest.libraryIds.length !== EXPECTED_LIBRARY_COUNT) {
    throw new Error('reviewed library identity manifest schema is invalid');
  }
  const reviewedAt = Date.parse(manifest.reviewedAt);
  if (!Number.isFinite(reviewedAt) || reviewedAt > now + 5 * 60 * 1000) {
    throw new Error('reviewed library identity manifest timestamp is invalid');
  }
  const identities = new Set();
  for (const identity of manifest.libraryIds) {
    if (typeof identity !== 'string' ||
        identity.length === 0 ||
        identity.length > 512 ||
        identities.has(identity)) {
      throw new Error(
        'reviewed library identity manifest identities are invalid'
      );
    }
    identities.add(identity);
  }
  return Object.freeze({
    file,
    bytes,
    libraryIds: Object.freeze([...identities].sort()),
    reviewedAt,
  });
}

function readTerminalRecoveryEvidence(
  fsImpl,
  options,
  expectedWatcher,
  now
) {
  if (!isSha256(options.terminalRecoveryReceiptSha256)) {
    throw new Error(
      'reviewed terminal-recovery receipt SHA-256 is invalid'
    );
  }
  if (!isRecord(expectedWatcher) ||
      !isSha256(expectedWatcher.sha256) ||
      !Number.isSafeInteger(expectedWatcher.size) ||
      expectedWatcher.size <= 0) {
    throw new Error('frozen terminal watcher identity is invalid');
  }
  const receiptFile = inspectRegularFile(
    fsImpl,
    options.terminalRecoveryReceiptPath,
    'controlled-recovery terminal receipt'
  );
  const journalFile = inspectRegularFile(
    fsImpl,
    options.terminalRecoveryJournalPath,
    'controlled-recovery terminal journal'
  );
  const watcherFile = inspectRegularFile(
    fsImpl,
    options.terminalRecoveryWatcherPath,
    'frozen controlled-recovery watcher'
  );
  const distinctPaths = new Set([
    receiptFile.realPath,
    journalFile.realPath,
    watcherFile.realPath,
  ]);
  if (distinctPaths.size !== 3) {
    throw new Error(
      'terminal receipt, journal, and watcher must be distinct files'
    );
  }

  const watcherBytes = readStableFile(
    fsImpl,
    watcherFile,
    Math.max(expectedWatcher.size, TERMINAL_RECOVERY_RECEIPT_MAX_BYTES)
  );
  const watcherSha256 = sha256Bytes(watcherBytes);
  if (path.basename(watcherFile.realPath) !==
      'watch-controlled-retained-recovery.js' ||
      watcherBytes.length !== expectedWatcher.size ||
      !sha256Equal(watcherSha256, expectedWatcher.sha256)) {
    throw new Error(
      'controlled-recovery watcher differs from the frozen implementation'
    );
  }

  const receiptBytes = readStableFile(
    fsImpl,
    receiptFile,
    TERMINAL_RECOVERY_RECEIPT_MAX_BYTES
  );
  const receiptSha256 = sha256Bytes(receiptBytes);
  if (!sha256Equal(
    receiptSha256,
    options.terminalRecoveryReceiptSha256
  )) {
    throw new Error(
      'controlled-recovery terminal receipt differs from the reviewed hash'
    );
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'));
  } catch (_) {
    throw new Error(
      'controlled-recovery terminal receipt is not valid JSON'
    );
  }
  if (!hasExactKeys(receipt, [
    'schema',
    'contract_id',
    'outcome',
    'ok',
    'started_at',
    'completed_at',
    'identity',
    'milestones',
    'terminal',
    'staging',
    'retirement',
    'terminal_evidence',
    'quiescence',
    'violations',
    'journal',
  ]) ||
      receipt.schema !== TERMINAL_RECOVERY_RECEIPT_SCHEMA_VERSION ||
      receipt.contract_id !== TERMINAL_RECOVERY_RECEIPT_CONTRACT_ID ||
      receipt.outcome !== 'success' ||
      receipt.ok !== true ||
      !isRecord(receipt.identity) ||
      !isRecord(receipt.staging) ||
      Object.keys(receipt.staging).length === 0 ||
      !isRecord(receipt.retirement) ||
      Object.keys(receipt.retirement).length === 0 ||
      !isRecord(receipt.terminal_evidence) ||
      Object.keys(receipt.terminal_evidence).length === 0 ||
      !Array.isArray(receipt.violations) ||
      receipt.violations.length !== 0 ||
      !hasExactKeys(
        receipt.milestones,
        TERMINAL_RECOVERY_MILESTONE_KEYS
      ) ||
      TERMINAL_RECOVERY_MILESTONE_KEYS.some(
        (key) => receipt.milestones[key] !== true
      ) ||
      !hasExactKeys(receipt.terminal, ['api', 'report']) ||
      !isRecord(receipt.terminal.api) ||
      !isRecord(receipt.terminal.report) ||
      receipt.terminal.api.decision !== 'Transcode success' ||
      receipt.terminal.report.decision !== 'Transcode success' ||
      !hasExactKeys(receipt.quiescence, ['ok', 'samples']) ||
      receipt.quiescence.ok !== true ||
      !Array.isArray(receipt.quiescence.samples) ||
      receipt.quiescence.samples.length !== 2 ||
      receipt.quiescence.samples.some(
        (sample) => !isRecord(sample) || sample.ok !== true
      ) ||
      !hasExactKeys(receipt.journal, [
        'path',
        'sha256_full',
        'size_bytes',
        'event_count',
      ]) ||
      typeof receipt.journal.path !== 'string' ||
      receipt.journal.path.includes('\0') ||
      !path.isAbsolute(receipt.journal.path) ||
      path.basename(receipt.journal.path) !==
        path.basename(journalFile.realPath) ||
      !isSha256(receipt.journal.sha256_full) ||
      !Number.isSafeInteger(receipt.journal.size_bytes) ||
      receipt.journal.size_bytes <= 0 ||
      receipt.journal.size_bytes > TERMINAL_RECOVERY_JOURNAL_MAX_BYTES ||
      !Number.isSafeInteger(receipt.journal.event_count) ||
      receipt.journal.event_count < 2 ||
      receipt.journal.event_count > 1_000_000) {
    throw new Error(
      'controlled-recovery terminal receipt schema or success proof is invalid'
    );
  }
  const startedAt = Date.parse(receipt.started_at);
  const completedAt = Date.parse(receipt.completed_at);
  if (!Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) ||
      startedAt > completedAt ||
      completedAt > now + 5 * 60 * 1000 ||
      completedAt < now - TERMINAL_RECOVERY_RECEIPT_MAX_AGE_MS) {
    throw new Error(
      'controlled-recovery terminal receipt timestamp is invalid'
    );
  }

  const journalBytes = readStableFile(
    fsImpl,
    journalFile,
    TERMINAL_RECOVERY_JOURNAL_MAX_BYTES
  );
  const journalSha256 = sha256Bytes(journalBytes);
  if (journalBytes.length !== receipt.journal.size_bytes ||
      !sha256Equal(journalSha256, receipt.journal.sha256_full) ||
      journalBytes[journalBytes.length - 1] !== 0x0a) {
    throw new Error(
      'controlled-recovery terminal journal differs from its receipt'
    );
  }
  let journalEvents;
  try {
    journalEvents = journalBytes
      .subarray(0, journalBytes.length - 1)
      .toString('utf8')
      .split('\n')
      .map((line) => JSON.parse(line));
  } catch (_) {
    throw new Error(
      'controlled-recovery terminal journal is not valid JSONL'
    );
  }
  if (journalEvents.length !== receipt.journal.event_count) {
    throw new Error(
      'controlled-recovery terminal journal event count differs'
    );
  }
  let previousObservedAt = -Infinity;
  for (let index = 0; index < journalEvents.length; index += 1) {
    const event = journalEvents[index];
    const observedAt = isRecord(event) ? Date.parse(event.observed_at) : NaN;
    if (!hasExactKeys(event, [
      'schema',
      'contract_id',
      'sequence',
      'observed_at',
      'kind',
      'evidence',
    ]) ||
        event.schema !== TERMINAL_RECOVERY_JOURNAL_SCHEMA_VERSION ||
        event.contract_id !== TERMINAL_RECOVERY_JOURNAL_CONTRACT_ID ||
        event.sequence !== index + 1 ||
        !Number.isFinite(observedAt) ||
        observedAt < previousObservedAt ||
        typeof event.kind !== 'string' ||
        event.kind.length === 0 ||
        event.kind.length > 256 ||
        !isRecord(event.evidence)) {
      throw new Error(
        'controlled-recovery terminal journal event is invalid'
      );
    }
    previousObservedAt = observedAt;
  }
  const firstEvent = journalEvents[0];
  const lastEvent = journalEvents[journalEvents.length - 1];
  const terminalEventCount = journalEvents.filter(
    (event) => event.kind === 'watcher_terminal'
  ).length;
  if (firstEvent.kind !== 'journal_opened' ||
      firstEvent.evidence.schema !==
        TERMINAL_RECOVERY_JOURNAL_SCHEMA_VERSION ||
      firstEvent.evidence.contract_id !==
        TERMINAL_RECOVERY_JOURNAL_CONTRACT_ID ||
      terminalEventCount !== 1 ||
      lastEvent.kind !== 'watcher_terminal' ||
      lastEvent.evidence.outcome !== 'success' ||
      lastEvent.evidence.quiescence_ok !== true ||
      lastEvent.evidence.violation_count !== 0 ||
      !sameJson(lastEvent.evidence.milestones, receipt.milestones) ||
      previousObservedAt > completedAt) {
    throw new Error(
      'controlled-recovery terminal journal does not end in exact success'
    );
  }

  return Object.freeze({
    receiptFile,
    receiptBytes,
    receipt,
    receiptSha256,
    completedAt,
    journalFile,
    journalBytes,
    journalSha256,
    watcherFile,
    watcherBytes,
    watcherSha256,
  });
}

function validateQuiescenceReceipt(value, label) {
  if (!isRecord(value) ||
      !Number.isSafeInteger(value.checks) ||
      value.checks < 2 ||
      !Number.isSafeInteger(value.intervalMs) ||
      value.intervalMs < 0 ||
      !Number.isSafeInteger(value.nodeCount) ||
      value.nodeCount < 1) {
    throw new Error(`${label} quiescence receipt is invalid`);
  }
  return Object.freeze({
    checks: value.checks,
    intervalMs: value.intervalMs,
    nodeCount: value.nodeCount,
  });
}

async function getReviewedLibraryIds(requestJson) {
  const libraries = await requestJson('cruddb', {
    method: 'POST',
    body: runtimeSettings.crudRequest(
      'LibrarySettingsJSONDB',
      'getAll',
      '',
      {}
    ),
    responseMode: 'json',
  });
  return Object.freeze(
    runtimeSettings.validateLibraryDocuments(
      libraries,
      EXPECTED_LIBRARY_COUNT
    ).map((document) => document._id).sort()
  );
}

function derivedLearningDatabaseExclusions(configRoot, learningDatabase) {
  const excluded = new Set([
    'vmaf_training.db',
    'vmaf_training.db-wal',
    'vmaf_training.db-shm',
    'vmaf_training.db-journal',
  ]);
  const relative = path.relative(configRoot.realPath, learningDatabase.realPath);
  if (relative !== '' &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)) {
    const posix = relative.split(path.sep).join('/');
    excluded.add(posix);
    excluded.add(`${posix}-wal`);
    excluded.add(`${posix}-shm`);
    excluded.add(`${posix}-journal`);
  }
  return excluded;
}

function isTdarrJobReport(relativePath) {
  const safe = safeRelativePath(relativePath, 'job-report member');
  const parts = safe.split('/');
  return parts.length >= 2 && parts[parts.length - 1].endsWith('.txt');
}

function artifactRecord(rootPath, relativePath, fsImpl) {
  const localPath = toLocalPath(rootPath, relativePath);
  const identity = sha256FileStable(fsImpl, localPath);
  return Object.freeze({
    path: relativePath,
    sha256: identity.sha256,
    size: identity.size,
  });
}

function writeJsonArtifact(fsImpl, rootPath, relativePath, value) {
  const target = toLocalPath(rootPath, relativePath);
  writeExclusiveFile(
    fsImpl,
    target,
    `${JSON.stringify(value, null, 2)}\n`
  );
  return target;
}

function writeChecksumManifest(fsImpl, rootPath, records) {
  const lines = [...records]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((record) => `${record.sha256}  ${record.path}`)
    .join('\n');
  return writeExclusiveFile(
    fsImpl,
    toLocalPath(rootPath, ARTIFACT_PATHS.checksums),
    `${lines}\n`
  );
}

function sourceContractForOptions(options) {
  const production = Object.entries(PRODUCTION_SOURCES)
    .every(([key, value]) => options[key] === value);
  if (production) return PRODUCTION_SOURCE_CONTRACT_ID;
  if (options.allowSourceOverride !== '1') {
    throw new Error(
      'non-production evidence sources require ' +
      'ALLOW_TDARR_EVIDENCE_SOURCE_OVERRIDE=1'
    );
  }
  return OVERRIDE_SOURCE_CONTRACT_ID;
}

function validateOptions(options) {
  if (!isRecord(options)) throw new TypeError('options must be an object');
  if (options.allowGeneration !== '1') {
    throw new Error(
      'generation requires ALLOW_TDARR_POST_RECOVERY_EVIDENCE=1'
    );
  }
  if (typeof options.flowId !== 'string' ||
      options.flowId.length === 0 ||
      options.flowId.length > 512 ||
      options.flowId.includes('\0')) {
    throw new Error('active Flow identity is invalid');
  }
  if (typeof options.pythonExecutable !== 'string' ||
      options.pythonExecutable.length === 0 ||
      options.pythonExecutable.includes('\0')) {
    throw new Error('Python executable is invalid');
  }
  if (!Number.isSafeInteger(options.sqliteBackupTimeoutMs) ||
      options.sqliteBackupTimeoutMs < 10_000 ||
      options.sqliteBackupTimeoutMs > 30 * 60 * 1000) {
    throw new Error('SQLite backup timeout is invalid');
  }
  if (!Number.isSafeInteger(options.archiveTimeoutMs) ||
      options.archiveTimeoutMs < 60_000 ||
      options.archiveTimeoutMs > 6 * 60 * 60 * 1000) {
    throw new Error('archive timeout is invalid');
  }
  if (!isSha256(options.terminalRecoveryReceiptSha256)) {
    throw new Error(
      'reviewed terminal-recovery receipt SHA-256 is invalid'
    );
  }
  return sourceContractForOptions(options);
}

async function generateEvidence(options, suppliedDependencies = {}) {
  const sourceContractId = validateOptions(options);
  const dependencies = {
    fs: suppliedDependencies.fs || fs,
    sqliteBackup: suppliedDependencies.sqliteBackup || defaultSqliteBackup,
    archiveRunner: suppliedDependencies.archiveRunner || defaultArchiveRunner,
    publishStaging:
      suppliedDependencies.publishStaging || defaultPublishStaging,
    assertQuiescence: suppliedDependencies.assertQuiescence ||
      (() => quiescence.assertTdarrQuiescence(options.config)),
    requestJson: suppliedDependencies.requestJson ||
      runtimeSettings.createRuntimeRequester(options.config),
    now: suppliedDependencies.now || (() => Date.now()),
    randomBytes: suppliedDependencies.randomBytes || crypto.randomBytes,
    platform: suppliedDependencies.platform || process.platform,
    expectedTerminalWatcher:
      suppliedDependencies.expectedTerminalWatcher ||
      Object.freeze({
        sha256: TERMINAL_RECOVERY_WATCHER_SHA256,
        size: TERMINAL_RECOVERY_WATCHER_SIZE,
      }),
    validateArchiveReceipt:
      suppliedDependencies.validateArchiveReceipt ||
      ((receiptPath, privateRoot, now) =>
        runtimeSettings.validateArchiveReceipt(receiptPath, {
          privateRoot,
          now,
          pythonExecutable: options.pythonExecutable,
        })),
    validateLibraryIdentityManifest:
      suppliedDependencies.validateLibraryIdentityManifest ||
      ((manifestPath, privateRoot, now) =>
        runtimeSettings.validateLibraryIdentityManifest(manifestPath, {
          privateRoot,
          now,
        })),
  };

  const databaseSource = inspectRegularFile(
    dependencies.fs,
    options.databasePath,
    'Tdarr database source'
  );
  const learningDatabaseSource = inspectRegularFile(
    dependencies.fs,
    options.learningDatabasePath,
    'learning database source'
  );
  const jobReportsRoot = inspectDirectory(
    dependencies.fs,
    options.jobReportsRoot,
    'job-report source root'
  );
  const configsRoot = inspectDirectory(
    dependencies.fs,
    options.configsRoot,
    'config source root'
  );
  const reviewedLibraryManifest = readReviewedLibraryManifest(
    dependencies.fs,
    options.reviewedLibraryManifestPath,
    dependencies.now()
  );
  const terminalRecovery = readTerminalRecoveryEvidence(
    dependencies.fs,
    options,
    dependencies.expectedTerminalWatcher,
    dependencies.now()
  );
  if ([
    terminalRecovery.receiptFile.realPath,
    terminalRecovery.journalFile.realPath,
    terminalRecovery.watcherFile.realPath,
  ].includes(reviewedLibraryManifest.file.realPath)) {
    throw new Error(
      'reviewed library and controlled-recovery files must be distinct'
    );
  }
  const destination = inspectDestination(
    dependencies.fs,
    options.destinationPath,
    [
      databaseSource.realPath,
      learningDatabaseSource.realPath,
      jobReportsRoot.realPath,
      configsRoot.realPath,
      reviewedLibraryManifest.file.realPath,
      terminalRecovery.receiptFile.realPath,
      terminalRecovery.journalFile.realPath,
      terminalRecovery.watcherFile.realPath,
    ]
  );

  let createdStat;
  const createdPaths = [];
  let complete = false;
  try {
    const staging = allocateStagingDirectory(
      dependencies.fs,
      destination,
      dependencies.randomBytes
    );
    createdStat = staging.stat;
    createdPaths.push(staging.path, destination.canonicalPath);
    const evidenceRoot = staging.path;
    ensureArtifactDirectories(dependencies.fs, evidenceRoot);

    const preQuiescence = validateQuiescenceReceipt(
      await dependencies.assertQuiescence(),
      'pre-backup'
    );
    const preLibraryIds = await getReviewedLibraryIds(
      dependencies.requestJson
    );
    if (!sameJson(preLibraryIds, reviewedLibraryManifest.libraryIds)) {
      throw new Error(
        'reviewed library identity set does not match pre-backup live scope'
      );
    }

    const databasePath = toLocalPath(
      evidenceRoot,
      ARTIFACT_PATHS.database
    );
    const learningDatabasePath = toLocalPath(
      evidenceRoot,
      ARTIFACT_PATHS.learningDatabase
    );
    await createOnlineSqliteBackup(
      databaseSource,
      databasePath,
      options,
      dependencies
    );
    await createOnlineSqliteBackup(
      learningDatabaseSource,
      learningDatabasePath,
      options,
      dependencies
    );

    const activeFlow = readActiveFlow(
      databasePath,
      options.flowId,
      options
    );
    writeJsonArtifact(
      dependencies.fs,
      evidenceRoot,
      ARTIFACT_PATHS.activeFlow,
      activeFlow
    );

    const jobArchive = await createStableArchive({
      root: jobReportsRoot,
      excluded: new Set(),
      label: 'job-report source tree',
      archivePath: toLocalPath(
        evidenceRoot,
        ARTIFACT_PATHS.jobReports
      ),
      inventoryPath: toLocalPath(
        evidenceRoot,
        'archives/.job-reports.inventory.json'
      ),
      pythonExecutable: options.pythonExecutable,
      archiveTimeoutMs: options.archiveTimeoutMs,
      countPredicate: isTdarrJobReport,
    }, dependencies);
    if (jobArchive.countedFileCount < 1) {
      throw new Error(
        'job-report source tree contains no descendant .txt reports'
      );
    }

    await createStableArchive({
      root: configsRoot,
      excluded: derivedLearningDatabaseExclusions(
        configsRoot,
        learningDatabaseSource
      ),
      label: 'config source tree',
      archivePath: toLocalPath(
        evidenceRoot,
        ARTIFACT_PATHS.configs
      ),
      inventoryPath: toLocalPath(
        evidenceRoot,
        'archives/.configs.inventory.json'
      ),
      pythonExecutable: options.pythonExecutable,
      archiveTimeoutMs: options.archiveTimeoutMs,
    }, dependencies);

    const postQuiescence = validateQuiescenceReceipt(
      await dependencies.assertQuiescence(),
      'post-backup'
    );
    const postLibraryIds = await getReviewedLibraryIds(
      dependencies.requestJson
    );
    if (!sameJson(preLibraryIds, postLibraryIds)) {
      throw new Error('reviewed library scope changed during backup');
    }
    if (!sameJson(postLibraryIds, reviewedLibraryManifest.libraryIds)) {
      throw new Error(
        'reviewed library identity set does not match post-backup live scope'
      );
    }

    const createdAtValue = dependencies.now();
    if (!Number.isFinite(createdAtValue)) {
      throw new Error('evidence timestamp is invalid');
    }
    const createdAt = new Date(createdAtValue).toISOString();
    assertFileSnapshotStillPresent(
      dependencies.fs,
      reviewedLibraryManifest.file,
      'reviewed library identity manifest'
    );
    assertFileSnapshotStillPresent(
      dependencies.fs,
      terminalRecovery.receiptFile,
      'controlled-recovery terminal receipt'
    );
    assertFileSnapshotStillPresent(
      dependencies.fs,
      terminalRecovery.journalFile,
      'controlled-recovery terminal journal'
    );
    assertFileSnapshotStillPresent(
      dependencies.fs,
      terminalRecovery.watcherFile,
      'frozen controlled-recovery watcher'
    );
    writeExclusiveFile(
      dependencies.fs,
      toLocalPath(
        evidenceRoot,
        ARTIFACT_PATHS.libraries
      ),
      reviewedLibraryManifest.bytes
    );
    writeExclusiveFile(
      dependencies.fs,
      toLocalPath(
        evidenceRoot,
        ARTIFACT_PATHS.terminalRecoveryReceipt
      ),
      terminalRecovery.receiptBytes
    );
    writeExclusiveFile(
      dependencies.fs,
      toLocalPath(
        evidenceRoot,
        ARTIFACT_PATHS.terminalRecoveryJournal
      ),
      terminalRecovery.journalBytes
    );
    writeExclusiveFile(
      dependencies.fs,
      toLocalPath(
        evidenceRoot,
        ARTIFACT_PATHS.terminalRecoveryWatcher
      ),
      terminalRecovery.watcherBytes
    );

    const databaseRecord = artifactRecord(
      evidenceRoot,
      ARTIFACT_PATHS.database,
      dependencies.fs
    );
    const jobArchiveRecord = artifactRecord(
      evidenceRoot,
      ARTIFACT_PATHS.jobReports,
      dependencies.fs
    );
    writeJsonArtifact(
      dependencies.fs,
      evidenceRoot,
      ARTIFACT_PATHS.receipt,
      {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        kind: RECEIPT_KIND,
        verified: true,
        reportCount: jobArchive.countedFileCount,
        createdAt,
        archive: {
          path: ARTIFACT_PATHS.jobReports,
          sha256: jobArchiveRecord.sha256,
        },
        databaseBackup: {
          path: ARTIFACT_PATHS.database,
          sha256: databaseRecord.sha256,
        },
      }
    );

    const artifactPaths = [
      ARTIFACT_PATHS.database,
      ARTIFACT_PATHS.learningDatabase,
      ARTIFACT_PATHS.jobReports,
      ARTIFACT_PATHS.configs,
      ARTIFACT_PATHS.activeFlow,
      ARTIFACT_PATHS.libraries,
      ARTIFACT_PATHS.terminalRecoveryReceipt,
      ARTIFACT_PATHS.terminalRecoveryJournal,
      ARTIFACT_PATHS.terminalRecoveryWatcher,
      ARTIFACT_PATHS.receipt,
    ];
    const records = artifactPaths.map((relativePath) =>
      artifactRecord(
        evidenceRoot,
        relativePath,
        dependencies.fs
      ));
    writeChecksumManifest(
      dependencies.fs,
      evidenceRoot,
      records
    );
    const checksumRecord = artifactRecord(
      evidenceRoot,
      ARTIFACT_PATHS.checksums,
      dependencies.fs
    );
    writeJsonArtifact(
      dependencies.fs,
      evidenceRoot,
      ARTIFACT_PATHS.evidenceManifest,
      {
        schemaVersion: EVIDENCE_SCHEMA_VERSION,
        kind: EVIDENCE_KIND,
        verified: true,
        createdAt,
        sourceContractId,
        reportCount: jobArchive.countedFileCount,
        jobReportArchive: {
          countContractId: JOB_REPORT_COUNT_CONTRACT_ID,
          reportCount: jobArchive.countedFileCount,
          regularFileCount: jobArchive.regularFileCount,
        },
        libraryCount: postLibraryIds.length,
        terminalRecovery: {
          schema: TERMINAL_RECOVERY_RECEIPT_SCHEMA_VERSION,
          contractId: TERMINAL_RECOVERY_RECEIPT_CONTRACT_ID,
          outcome: 'success',
          completedAt:
            terminalRecovery.receipt.completed_at,
          receiptSha256: terminalRecovery.receiptSha256,
          journalContractId: TERMINAL_RECOVERY_JOURNAL_CONTRACT_ID,
          journalSha256: terminalRecovery.journalSha256,
          journalSize: terminalRecovery.journalBytes.length,
          journalEventCount:
            terminalRecovery.receipt.journal.event_count,
          watcherContractId: TERMINAL_RECOVERY_WATCHER_CONTRACT_ID,
          watcherSha256: terminalRecovery.watcherSha256,
          watcherSize: terminalRecovery.watcherBytes.length,
        },
        quiescence: {
          preBackup: preQuiescence,
          postBackup: postQuiescence,
        },
        sqliteIntegrity: {
          database: 'ok',
          learningDatabase: 'ok',
        },
        artifacts: records,
        sha256Manifest: checksumRecord,
      }
    );

    for (const directory of [
      toLocalPath(evidenceRoot, 'backups'),
      toLocalPath(evidenceRoot, 'archives'),
      toLocalPath(evidenceRoot, 'snapshots'),
      evidenceRoot,
    ]) {
      fsyncDirectory(dependencies.fs, directory);
    }
    assertApplyReadyTree(
      dependencies.fs,
      evidenceRoot,
      dependencies.platform,
      new Set([
        ...artifactPaths,
        ARTIFACT_PATHS.checksums,
        ARTIFACT_PATHS.evidenceManifest,
      ])
    );
    const createdAtMs = Date.parse(createdAt);
    await dependencies.validateArchiveReceipt(
      toLocalPath(evidenceRoot, ARTIFACT_PATHS.receipt),
      evidenceRoot,
      createdAtMs
    );
    await dependencies.validateLibraryIdentityManifest(
      toLocalPath(evidenceRoot, ARTIFACT_PATHS.libraries),
      evidenceRoot,
      createdAtMs
    );
    await dependencies.publishStaging({
      pythonExecutable: options.pythonExecutable,
      stagingPath: evidenceRoot,
      destinationPath: destination.canonicalPath,
    });
    const published = bigintStat(
      dependencies.fs,
      destination.canonicalPath
    );
    if (!published.isDirectory() ||
        published.isSymbolicLink() ||
        !sameIdentity(createdStat, published)) {
      throw new Error('published private evidence identity differs');
    }
    fsyncDirectory(dependencies.fs, destination.parent.realPath);
    complete = true;
    return Object.freeze({
      completed: true,
      reportCount: jobArchive.countedFileCount,
      archiveFileCount: jobArchive.regularFileCount,
      libraryCount: postLibraryIds.length,
      artifactCount: records.length,
      destinationPath: destination.canonicalPath,
    });
  } finally {
    if (!complete && createdStat) {
      for (const candidatePath of [...createdPaths].reverse()) {
        safeRemoveCreatedDirectory(
          dependencies.fs,
          destination.parent,
          candidatePath,
          createdStat
        );
      }
    }
  }
}

function optionsFromProcess(
  argv = process.argv.slice(2),
  environment = process.env
) {
  if (argv.length !== 0) throw new Error('command-line arguments are not accepted');
  return {
    allowGeneration: String(
      environment.ALLOW_TDARR_POST_RECOVERY_EVIDENCE || ''
    ),
    destinationPath: String(
      environment.TDARR_PRIVATE_EVIDENCE_DESTINATION || ''
    ),
    reviewedLibraryManifestPath: String(
      environment.TDARR_REVIEWED_LIBRARY_IDENTITY_MANIFEST || ''
    ),
    terminalRecoveryReceiptPath: String(
      environment.TDARR_TERMINAL_RECOVERY_RECEIPT || ''
    ),
    terminalRecoveryReceiptSha256: String(
      environment.TDARR_TERMINAL_RECOVERY_RECEIPT_SHA256 || ''
    ),
    terminalRecoveryJournalPath: String(
      environment.TDARR_TERMINAL_RECOVERY_JOURNAL || ''
    ),
    terminalRecoveryWatcherPath: String(
      environment.TDARR_TERMINAL_RECOVERY_WATCHER || ''
    ),
    allowSourceOverride: String(
      environment.ALLOW_TDARR_EVIDENCE_SOURCE_OVERRIDE || ''
    ),
    databasePath: String(
      environment.TDARR_DATABASE_PATH ||
      PRODUCTION_SOURCES.databasePath
    ),
    learningDatabasePath: String(
      environment.TDARR_LEARNING_DATABASE_PATH ||
      PRODUCTION_SOURCES.learningDatabasePath
    ),
    jobReportsRoot: String(
      environment.TDARR_JOB_REPORTS_ROOT ||
      PRODUCTION_SOURCES.jobReportsRoot
    ),
    configsRoot: String(
      environment.TDARR_CONFIGS_ROOT ||
      PRODUCTION_SOURCES.configsRoot
    ),
    flowId: String(
      environment.TDARR_ACTIVE_FLOW_ID ||
      PRODUCTION_SOURCES.flowId
    ),
    pythonExecutable: String(
      environment.TDARR_EVIDENCE_PYTHON ||
      (process.platform === 'win32' ? 'python' : 'python3')
    ),
    sqliteBackupTimeoutMs: quiescence.boundedInteger(
      environment.TDARR_EVIDENCE_SQLITE_TIMEOUT_MS,
      DEFAULT_SQLITE_BACKUP_TIMEOUT_MS,
      10_000,
      30 * 60 * 1000,
      'TDARR_EVIDENCE_SQLITE_TIMEOUT_MS'
    ),
    archiveTimeoutMs: quiescence.boundedInteger(
      environment.TDARR_EVIDENCE_ARCHIVE_TIMEOUT_MS,
      DEFAULT_ARCHIVE_TIMEOUT_MS,
      60_000,
      6 * 60 * 60 * 1000,
      'TDARR_EVIDENCE_ARCHIVE_TIMEOUT_MS'
    ),
    config: quiescence.configFromEnv(environment),
  };
}

async function main() {
  await generateEvidence(optionsFromProcess());
  console.log('PASS post-recovery private evidence generation complete');
}

module.exports = {
  ARTIFACT_PATHS,
  EVIDENCE_KIND,
  EVIDENCE_SCHEMA_VERSION,
  EXPECTED_LIBRARY_COUNT,
  JOB_REPORT_COUNT_CONTRACT_ID,
  OVERRIDE_SOURCE_CONTRACT_ID,
  PRODUCTION_SOURCE_CONTRACT_ID,
  PRODUCTION_SOURCES,
  PYTHON_ACTIVE_FLOW_PROGRAM,
  PYTHON_ARCHIVE_PROGRAM,
  PYTHON_PUBLISH_PROGRAM,
  PYTHON_SQLITE_BACKUP_PROGRAM,
  PYTHON_SQLITE_INTEGRITY_PROGRAM,
  allocateStagingDirectory,
  assertApplyReadyTree,
  createOnlineSqliteBackup,
  createStableArchive,
  defaultArchiveRunner,
  defaultPublishStaging,
  defaultSqliteBackup,
  derivedLearningDatabaseExclusions,
  generateEvidence,
  getReviewedLibraryIds,
  inspectDestination,
  isTdarrJobReport,
  optionsFromProcess,
  readActiveFlow,
  readReviewedLibraryManifest,
  readTerminalRecoveryEvidence,
  scanRegularTree,
  sha256FileStable,
  sourceContractForOptions,
  TERMINAL_RECOVERY_JOURNAL_CONTRACT_ID,
  TERMINAL_RECOVERY_JOURNAL_SCHEMA_VERSION,
  TERMINAL_RECOVERY_MILESTONE_KEYS,
  TERMINAL_RECOVERY_RECEIPT_CONTRACT_ID,
  TERMINAL_RECOVERY_RECEIPT_SCHEMA_VERSION,
  TERMINAL_RECOVERY_WATCHER_CONTRACT_ID,
  TERMINAL_RECOVERY_WATCHER_SHA256,
  TERMINAL_RECOVERY_WATCHER_SIZE,
  validateQuiescenceReceipt,
};

if (require.main === module) {
  main().catch(() => {
    console.error(
      'FAIL post-recovery private evidence ' +
      '(TDARR_POST_RECOVERY_EVIDENCE_FAILED)'
    );
    process.exitCode = 1;
  });
}
