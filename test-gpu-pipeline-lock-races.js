'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-gpu-lock-races-'));
const lockPath = path.join(root, 'pipeline.lock');
const lockModule = path.join(__dirname, 'plugins/vmaf/_lib/gpuPipelineLock.js');
process.env.TDARR_GPU_PIPELINE_LOCK_DIR = lockPath;
const lock = require(lockModule);

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFiles(paths, timeoutMs) {
  const started = Date.now();
  while (!paths.every((filePath) => fs.existsSync(filePath))) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Timed out waiting for files: ${paths.join(', ')}`);
    }
    await waitMs(20);
  }
}

function waitForChild(child, label) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${label} exited ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function assertAcquireTimesOut(ownerId) {
  await assert.rejects(lock.acquire({
    lockDir: lockPath,
    owner: { ownerId, workerName: 'race-test' },
    initializationGraceSeconds: 30,
    waitPollSeconds: 1,
    maxWaitSeconds: 1,
  }), /Timed out waiting/);
}

async function run() {
  let acquired = null;
  try {
    // mkdir is the exclusion publication point. A waiter must not retire a
    // creator's fresh empty directory before owner metadata is published.
    fs.mkdirSync(lockPath);
    await assertAcquireTimesOut('fresh-empty-waiter');
    assert(fs.existsSync(lockPath), 'fresh empty lock must remain during initialization grace');
    fs.rmdirSync(lockPath);

    // Partial JSON is another initialization/corruption window. It must never
    // be interpreted as proof that no owner or GPU descendant exists.
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), '{"token":');
    fs.writeFileSync(path.join(lockPath, 'heartbeat.json'), '{"timestamp":');
    await assertAcquireTimesOut('partial-json-waiter');
    assert.strictEqual(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'), '{"token":');
    fs.unlinkSync(path.join(lockPath, 'owner.json'));
    fs.unlinkSync(path.join(lockPath, 'heartbeat.json'));
    fs.rmdirSync(lockPath);

    // An old, completely metadata-free directory can only be a failed mkdir
    // publication. It is the sole automatically recoverable stale state.
    fs.mkdirSync(lockPath);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    acquired = await lock.acquire({
      lockDir: lockPath,
      owner: { ownerId: 'aged-empty-successor', workerName: 'race-test' },
      initializationGraceSeconds: 5,
      waitPollSeconds: 1,
      maxWaitSeconds: 3,
    });
    assert.strictEqual(acquired.acquired, true);
    assert.strictEqual(lock.readOwner(lockPath).token, acquired.owner.token);
    assert.strictEqual(lock.release(lockPath, acquired.owner.token, {
      expectedGeneration: acquired.owner.leaseGeneration,
    }).released, true);
    acquired = null;

    // A failed creator may clean up only the inode it created. If a successor
    // has already published the fixed path, the predecessor must not rename or
    // delete that successor.
    const displacedCreator = path.join(root, 'displaced-creator.lock');
    assert.throws(() => lock.tryAcquireOnce({
      lockDir: lockPath,
      owner: { ownerId: 'injected-failure', workerName: 'race-test' },
      _testAfterDirectoryCreated: () => {
        fs.renameSync(lockPath, displacedCreator);
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'successor.marker'), 'must survive');
        throw new Error('injected creator failure');
      },
    }), /injected creator failure/);
    assert.strictEqual(
      fs.readFileSync(path.join(lockPath, 'successor.marker'), 'utf8'),
      'must survive',
      'creator cleanup must not delete a successor directory',
    );
    fs.unlinkSync(path.join(lockPath, 'successor.marker'));
    fs.rmdirSync(lockPath);
    fs.rmdirSync(displacedCreator);

    // Owner death is not GPU-idle proof: FFmpeg/NVEncC descendants may outlive
    // the Tdarr worker. Established metadata therefore requires explicit
    // quiescence recovery even when the recorded PID is certainly absent.
    fs.mkdirSync(lockPath);
    const deadOwner = {
      token: 'dead-owner',
      leaseGeneration: 'dead-owner-generation',
      ownerId: 'dead-owner',
      pid: 2147483647,
      workerStartTime: 1,
      acquiredAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    };
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(deadOwner));
    fs.writeFileSync(path.join(lockPath, 'heartbeat.json'), JSON.stringify({
      token: deadOwner.token,
      leaseGeneration: deadOwner.leaseGeneration,
      pid: deadOwner.pid,
      timestamp: deadOwner.acquiredAt,
    }));
    await assertAcquireTimesOut('dead-owner-waiter');
    assert.strictEqual(lock.readOwner(lockPath).token, deadOwner.token);
    fs.unlinkSync(path.join(lockPath, 'owner.json'));
    fs.unlinkSync(path.join(lockPath, 'heartbeat.json'));
    fs.rmdirSync(lockPath);

    // Two processes start from the same barrier and hold a timed critical
    // section. Their measured intervals must never overlap.
    const barrier = path.join(root, 'barrier');
    const workerSource = [
      "'use strict';",
      "const fs=require('fs');",
      "const lock=require(process.env.LOCK_MODULE);",
      "const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));",
      "fs.writeFileSync(process.env.READY_PATH,'ready');",
      "(async()=>{",
      "  while(!fs.existsSync(process.env.BARRIER_PATH)){await sleep(10);}",
      "  const lease=await lock.acquire({",
      "    lockDir:process.env.LOCK_PATH,",
      "    owner:{ownerId:process.env.WORKER_ID,workerName:'barrier-worker'},",
      "    heartbeatIntervalSeconds:5,waitPollSeconds:1,maxWaitSeconds:10",
      "  });",
      "  const entered=Date.now();",
      "  await sleep(350);",
      "  const exited=Date.now();",
      "  const released=lock.release(process.env.LOCK_PATH,lease.owner.token,{expectedGeneration:lease.owner.leaseGeneration});",
      "  if(!released.released)throw new Error('release failed: '+released.reason);",
      "  fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify({id:process.env.WORKER_ID,entered,exited}));",
      "})().catch((error)=>{console.error(error.stack||error.message);process.exitCode=1;});",
    ].join('\n');

    const workers = ['a', 'b'].map((id) => {
      const readyPath = path.join(root, `ready-${id}`);
      const resultPath = path.join(root, `result-${id}.json`);
      const child = childProcess.spawn(process.execPath, ['-e', workerSource], {
        env: {
          ...process.env,
          TDARR_GPU_PIPELINE_LOCK_DIR: lockPath,
          LOCK_PATH: lockPath,
          LOCK_MODULE: lockModule,
          BARRIER_PATH: barrier,
          READY_PATH: readyPath,
          RESULT_PATH: resultPath,
          WORKER_ID: id,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { id, child, readyPath, resultPath, done: waitForChild(child, `worker-${id}`) };
    });
    await waitForFiles(workers.map((worker) => worker.readyPath), 5000);
    fs.writeFileSync(barrier, 'go');
    await Promise.all(workers.map((worker) => worker.done));
    const intervals = workers.map((worker) =>
      JSON.parse(fs.readFileSync(worker.resultPath, 'utf8')));
    assert(
      intervals[0].exited <= intervals[1].entered ||
      intervals[1].exited <= intervals[0].entered,
      `GPU critical sections overlapped: ${JSON.stringify(intervals)}`,
    );
    assert.strictEqual(fs.existsSync(lockPath), false);

    console.log('PASS GPU pipeline lock resists initialization, successor, orphan, and process races');
  } finally {
    if (acquired && fs.existsSync(lockPath)) {
      lock.release(lockPath, acquired.owner.token, {
        expectedGeneration: acquired.owner.leaseGeneration,
      });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
