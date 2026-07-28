'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-gpu-lock-lease-'));
const lockPath = path.join(root, 'pipeline.lock');
process.env.TDARR_GPU_PIPELINE_LOCK_DIR = lockPath;
const lock = require('./plugins/vmaf/_lib/gpuPipelineLock.js');

(async () => {
  let acquired;
  try {
    acquired = await lock.acquire({
      lockDir: lockPath,
      owner: {
        ownerId: 'same-file',
        workerName: 'lease-test',
        filePath: '/media/same-file.mkv',
      },
      heartbeatIntervalSeconds: 5,
      waitPollSeconds: 1,
      maxWaitSeconds: 2,
    });
    assert.strictEqual(acquired.acquired, true);
    assert(acquired.owner.token);
    assert(acquired.owner.leaseGeneration);
    assert.strictEqual(acquired.owner.lockDir, path.resolve(lockPath));

    assert.throws(() => lock.resolveLockDir(path.join(root, 'other.lock')),
      /must match the configured fixed path/,
      'flow input must not select an arbitrary deletion root');

    let eventLoopAdvanced = false;
    setTimeout(() => { eventLoopAdvanced = true; }, 25);
    await assert.rejects(lock.acquire({
      lockDir: lockPath,
      owner: {
        ownerId: 'same-file',
        workerName: 'second-worker',
        filePath: '/media/same-file.mkv',
      },
      waitPollSeconds: 1,
      maxWaitSeconds: 1,
      staleHeartbeatSeconds: 300,
      maxLockAgeSeconds: 300,
    }), /Timed out waiting/,
    'a live same-file owner must never be replaced by identity alone');
    assert.strictEqual(eventLoopAdvanced, true,
      'async acquisition wait must yield the Node event loop');
    assert.strictEqual(lock.readOwner(lockPath).token, acquired.owner.token);

    const wrongToken = lock.release(lockPath, 'not-the-owner', {
      expectedGeneration: acquired.owner.leaseGeneration,
    });
    assert.strictEqual(wrongToken.released, false);
    assert.strictEqual(lock.readOwner(lockPath).token, acquired.owner.token);

    const wrongGeneration = lock.release(lockPath, acquired.owner.token, {
      expectedGeneration: 'not-the-generation',
    });
    assert.strictEqual(wrongGeneration.released, false);
    assert.strictEqual(lock.readOwner(lockPath).token, acquired.owner.token);

    const unexpected = path.join(lockPath, 'unmanaged.txt');
    fs.writeFileSync(unexpected, 'must not be recursively deleted');
    const refusedCleanup = lock.release(lockPath, acquired.owner.token, {
      expectedGeneration: acquired.owner.leaseGeneration,
    });
    assert.strictEqual(refusedCleanup.released, false);
    assert(fs.existsSync(unexpected),
      'release must not delete unexpected lock-directory contents');
    assert.strictEqual(lock.readOwner(lockPath).token, acquired.owner.token,
      'failed atomic cleanup must restore the active lease');
    fs.unlinkSync(unexpected);

    const released = lock.release(lockPath, acquired.owner.token, {
      expectedGeneration: acquired.owner.leaseGeneration,
    });
    assert.strictEqual(released.released, true);
    assert.strictEqual(fs.existsSync(lockPath), false);
    acquired = null;

    console.log('PASS GPU pipeline lock uses fixed async generation-owned leases');
  } finally {
    if (acquired && fs.existsSync(lockPath)) {
      lock.release(lockPath, acquired.owner.token, {
        expectedGeneration: acquired.owner.leaseGeneration,
      });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
