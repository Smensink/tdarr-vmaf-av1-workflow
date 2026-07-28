'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const selectorPath =
  './custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js';
const reservation = require(selectorPath)._test;

function waitForBarrier(barrierPath) {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(barrierPath)) {
    Atomics.wait(waitArray, 0, 0, 5);
  }
}

if (process.argv[2] === '--worker') {
  const rootPath = process.argv[3];
  const cap = Number(process.argv[4]);
  const jobIdentity = process.argv[5];
  const barrierPath = process.argv[6];
  const readyPath = process.argv[7];
  fs.writeFileSync(readyPath, 'ready\n', { flag: 'wx', mode: 0o600 });
  waitForBarrier(barrierPath);
  const result = reservation.reserveForcedFullSlot({
    rootPath,
    cap,
    jobIdentityHash: reservation.hashForcedFullJobIdentity(jobIdentity),
  });
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`reservation worker exited ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`invalid worker result ${JSON.stringify(stdout)}: ${error.message}`));
      }
    });
  });
}

async function runContenders(tempParent, cohortName, identities, cap) {
  const rootPath = path.join(tempParent, `${cohortName}-reservations`);
  const coordinationPath = path.join(tempParent, `${cohortName}-coordination`);
  fs.mkdirSync(coordinationPath, { mode: 0o700 });
  const barrierPath = path.join(coordinationPath, 'start');
  const children = identities.map((identity, index) => {
    const readyPath = path.join(coordinationPath, `ready-${String(index).padStart(3, '0')}`);
    const child = childProcess.spawn(process.execPath, [
      __filename,
      '--worker',
      rootPath,
      String(cap),
      identity,
      barrierPath,
      readyPath,
    ], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return { child, readyPath, completion: waitForExit(child) };
  });

  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 15000;
  try {
    while (!children.every(({ readyPath }) => fs.existsSync(readyPath))) {
      if (Date.now() > deadline) throw new Error('workers did not reach contention barrier');
      Atomics.wait(waitArray, 0, 0, 10);
    }
    fs.writeFileSync(barrierPath, 'go\n', { flag: 'wx', mode: 0o600 });
    return {
      rootPath,
      results: await Promise.all(children.map(({ completion }) => completion)),
    };
  } catch (error) {
    children.forEach(({ child }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    await Promise.allSettled(children.map(({ completion }) => completion));
    throw error;
  }
}

async function main() {
  const tempParent = fs.mkdtempSync(
    path.join(os.tmpdir(), `forced-full-contention-${process.pid}-`));
  try {
    // Distinct jobs contend for five slots. Exactly five may acquire authority;
    // every other contender must fail closed with cap exhaustion.
    const distinct = await runContenders(
      tempParent,
      'distinct',
      Array.from({ length: 24 }, (_, index) => `canonical-job-${index}`),
      5);
    const admitted = distinct.results.filter((result) => result.ok);
    const denied = distinct.results.filter((result) => !result.ok);
    assert.strictEqual(admitted.length, 5);
    assert.strictEqual(denied.length, 19);
    assert.ok(denied.every((result) => result.code === 'reservation_cap_exhausted'));
    assert.strictEqual(new Set(admitted.map((result) => result.slot)).size, 5);
    const distinctSnapshot = reservation.inspectForcedFullReservations({
      rootPath: distinct.rootPath,
      cap: 5,
    });
    assert.deepStrictEqual(
      [distinctSnapshot.ok, distinctSnapshot.used, distinctSnapshot.firstFreeSlot],
      [true, 5, null]);

    // Concurrent retry-shaped calls for one canonical job all converge on a
    // single stable hashed owner and consume one slot total.
    const retry = await runContenders(
      tempParent,
      'retry',
      Array.from({ length: 12 }, () => 'same-canonical-job'),
      3);
    assert.ok(retry.results.every((result) => result.ok));
    assert.strictEqual(new Set(retry.results.map((result) => result.slot)).size, 1);
    assert.strictEqual(retry.results.filter((result) => result.status === 'acquired').length, 1);
    assert.strictEqual(retry.results.filter((result) => result.status === 'reused').length, 11);
    const retrySnapshot = reservation.inspectForcedFullReservations({
      rootPath: retry.rootPath,
      cap: 3,
      jobIdentityHash: reservation.hashForcedFullJobIdentity('same-canonical-job'),
    });
    assert.deepStrictEqual([retrySnapshot.ok, retrySnapshot.used, retrySnapshot.ownedSlot],
      [true, 1, retry.results[0].slot]);

    // A corrupt root and a malformed authority record both fail closed.
    const rootIsFile = path.join(tempParent, 'root-is-file');
    fs.writeFileSync(rootIsFile, 'not a directory\n', 'utf8');
    const invalidRoot = reservation.reserveForcedFullSlot({
      rootPath: rootIsFile,
      cap: 2,
      jobIdentityHash: reservation.hashForcedFullJobIdentity('invalid-root-job'),
    });
    assert.strictEqual(invalidRoot.ok, false);

    const corruptRoot = path.join(tempParent, 'corrupt-root');
    fs.mkdirSync(corruptRoot, { mode: 0o700 });
    fs.mkdirSync(path.join(corruptRoot, '.pending'), { mode: 0o700 });
    fs.writeFileSync(path.join(corruptRoot, 'slot-000001.json'), '{broken\n',
      { mode: 0o600 });
    const corrupt = reservation.reserveForcedFullSlot({
      rootPath: corruptRoot,
      cap: 2,
      jobIdentityHash: reservation.hashForcedFullJobIdentity('corrupt-root-job'),
    });
    assert.deepStrictEqual([corrupt.ok, corrupt.code], [false, 'reservation_root_invalid']);

    // Deterministically inject the EACCES that a read-only /app/configs mount
    // would produce. No reservation means the caller must not return output 1.
    const deniedRoot = path.join(tempParent, 'denied-root');
    const deniedFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'openSync') {
          return (filePath, ...args) => {
            if (String(filePath).includes(`${path.sep}.pending${path.sep}`)) {
              const error = new Error('simulated read-only reservation root');
              error.code = 'EACCES';
              throw error;
            }
            return target.openSync(filePath, ...args);
          };
        }
        return target[property];
      },
    });
    const unwritable = reservation.reserveForcedFullSlot({
      rootPath: deniedRoot,
      cap: 2,
      jobIdentityHash: reservation.hashForcedFullJobIdentity('unwritable-root-job'),
      fs: deniedFs,
    });
    assert.deepStrictEqual([unwritable.ok, unwritable.code],
      [false, 'reservation_write_failed']);

    // The new ledger's own contents are not enough: its directory entry must
    // be flushed in the fixed parent (/app/configs in production). A parent
    // barrier failure is denied before any slot can be published, and retry
    // repeats the same barrier instead of trusting the surviving directory.
    const parentBarrierParent = path.join(tempParent, 'parent-barrier');
    fs.mkdirSync(parentBarrierParent, { mode: 0o700 });
    const parentBarrierRoot = path.join(parentBarrierParent, 'reservations');
    const failParentBarrierFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'openSync') {
          return (filePath, ...args) => {
            if (path.resolve(String(filePath)) === path.resolve(parentBarrierParent)) {
              const error = new Error('simulated parent-directory fsync failure');
              error.code = 'EIO';
              throw error;
            }
            return target.openSync(filePath, ...args);
          };
        }
        return target[property];
      },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parentBarrierDenied = reservation.reserveForcedFullSlot({
        rootPath: parentBarrierRoot,
        cap: 2,
        jobIdentityHash: reservation.hashForcedFullJobIdentity('parent-barrier-job'),
        fs: failParentBarrierFs,
        forceDirectoryFsync: true,
      });
      assert.deepStrictEqual([parentBarrierDenied.ok, parentBarrierDenied.code],
        [false, 'reservation_write_failed']);
      assert.strictEqual(fs.existsSync(path.join(parentBarrierRoot, 'slot-000001.json')), false);
    }

    // A post-link verification error leaves a conservative slot claim, but
    // retry cannot reuse it without performing a fresh durability/readback
    // barrier. Persistent verification failure remains denied; a later clean
    // readback can safely repair/reuse the same slot.
    const postLinkRoot = path.join(tempParent, 'post-link-root');
    let firstReadCount = 0;
    const failFirstCommitReadFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'readdirSync') {
          return (...args) => {
            firstReadCount += 1;
            if (firstReadCount === 2) {
              const error = new Error('simulated post-link readback failure');
              error.code = 'EIO';
              throw error;
            }
            return target.readdirSync(...args);
          };
        }
        return target[property];
      },
    });
    const postLinkHash = reservation.hashForcedFullJobIdentity('post-link-job');
    const firstCommit = reservation.reserveForcedFullSlot({
      rootPath: postLinkRoot,
      cap: 2,
      jobIdentityHash: postLinkHash,
      fs: failFirstCommitReadFs,
    });
    assert.deepStrictEqual([firstCommit.ok, firstCommit.code],
      [false, 'reservation_commit_unverified']);
    assert.strictEqual(fs.existsSync(path.join(postLinkRoot, 'slot-000001.json')), true);

    let retryReadCount = 0;
    const failRetryVerificationFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'readdirSync') {
          return (...args) => {
            retryReadCount += 1;
            if (retryReadCount === 2) {
              const error = new Error('simulated retry durability readback failure');
              error.code = 'EIO';
              throw error;
            }
            return target.readdirSync(...args);
          };
        }
        return target[property];
      },
    });
    const deniedReuse = reservation.reserveForcedFullSlot({
      rootPath: postLinkRoot,
      cap: 2,
      jobIdentityHash: postLinkHash,
      fs: failRetryVerificationFs,
    });
    assert.deepStrictEqual([deniedReuse.ok, deniedReuse.code],
      [false, 'reservation_commit_unverified']);
    assert.strictEqual(retryReadCount, 2,
      'reuse must perform an initial scan plus a fresh durability/readback verification');

    const repairedReuse = reservation.reserveForcedFullSlot({
      rootPath: postLinkRoot,
      cap: 2,
      jobIdentityHash: postLinkHash,
    });
    assert.deepStrictEqual([repairedReuse.ok, repairedReuse.status, repairedReuse.slot],
      [true, 'reused', 1]);

    console.log('PASS forced-full atomic reservation contention and fail-closed contracts');
  } finally {
    fs.rmSync(tempParent, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
