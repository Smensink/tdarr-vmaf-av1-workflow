'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runner = require('./build-scripts/run-grain-gpu-selftests.js');
const lock = require('./plugins/vmaf/_lib/gpuPipelineLock.js');

function config(lockPath) {
  return {
    lockPath,
    lockHelperPath: path.resolve('plugins/vmaf/_lib/gpuPipelineLock.js'),
    runtimeUser: 'runtime-user',
    grav1synth: '/tools/grav1synth',
    grav1synthRegression: '/tools/test-grav1synth.sh',
    ffmpeg: '/tools/ffmpeg',
    nvenccContractEnabled: true,
    nvencc: '/tools/nvencc',
    nvenccSmoke: '/tools/test-nvencc.sh',
    smokeBase: '/private/scratch',
  };
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  child.unref = () => {};
  return child;
}

async function testTimeoutDrainsDetachedDescendants() {
  const originalSpawn = childProcess.spawn;
  const child = fakeChild(41001);
  const signals = [];
  let groupAlive = true;
  const state = {
    child: null,
    childControl: null,
    childTreeUnconfirmed: false,
    signal: null,
    platform: 'linux',
    commandTimeoutMs: 5,
    terminationGraceMs: 5,
    terminationConfirmMs: 25,
    terminationPollMs: 1,
    unrefTimers: false,
    isProcessGroupAlive: () => groupAlive,
    killProcessGroup: (pid, signal) => {
      assert.strictEqual(pid, child.pid);
      signals.push(signal);
      if (signal === 'SIGTERM') {
        child.exitCode = 0;
        child.signalCode = 'SIGTERM';
        setImmediate(() => child.emit('exit', null, 'SIGTERM'));
      } else if (signal === 'SIGKILL') {
        groupAlive = false;
      }
    },
  };
  childProcess.spawn = () => child;
  try {
    await assert.rejects(
      runner.spawnCommand('/tools/mock-selftest', [], state),
      /self-test timed out/);
  } finally {
    childProcess.spawn = originalSpawn;
  }
  assert.deepStrictEqual(signals, ['SIGTERM', 'SIGKILL'],
    'leader exit cancelled detached-descendant SIGKILL escalation');
  assert.strictEqual(state.childTreeUnconfirmed, false);
}

async function testNormalExitRejectsDetachedDescendant() {
  const originalSpawn = childProcess.spawn;
  const child = fakeChild(41002);
  const signals = [];
  let groupAlive = true;
  const state = {
    child: null,
    childControl: null,
    childTreeUnconfirmed: false,
    signal: null,
    platform: 'linux',
    terminationGraceMs: 10,
    terminationConfirmMs: 25,
    terminationPollMs: 1,
    unrefTimers: false,
    isProcessGroupAlive: () => groupAlive,
    killProcessGroup: (pid, signal) => {
      assert.strictEqual(pid, child.pid);
      signals.push(signal);
      groupAlive = false;
    },
  };
  childProcess.spawn = () => {
    setImmediate(() => {
      child.exitCode = 0;
      child.emit('exit', 0, null);
    });
    return child;
  };
  try {
    await assert.rejects(
      runner.spawnCommand('/tools/mock-selftest', [], state),
      /left a detached descendant/);
  } finally {
    childProcess.spawn = originalSpawn;
  }
  assert.deepStrictEqual(signals, ['SIGTERM']);
  assert.strictEqual(state.childTreeUnconfirmed, false);
}

async function testSignalDrainsDetachedDescendants() {
  const originalSpawn = childProcess.spawn;
  const child = fakeChild(41003);
  const signals = [];
  let groupAlive = true;
  const state = {
    child: null,
    childControl: null,
    childTreeUnconfirmed: false,
    signal: null,
    platform: 'linux',
    commandTimeoutMs: 1000,
    terminationGraceMs: 5,
    terminationConfirmMs: 25,
    terminationPollMs: 1,
    unrefTimers: false,
    isProcessGroupAlive: () => groupAlive,
    killProcessGroup: (pid, signal) => {
      assert.strictEqual(pid, child.pid);
      signals.push(signal);
      if (signal === 'SIGTERM') {
        child.exitCode = 0;
        child.signalCode = 'SIGTERM';
        setImmediate(() => child.emit('exit', null, 'SIGTERM'));
      } else if (signal === 'SIGKILL') {
        groupAlive = false;
      }
    },
  };
  const priorHandlers = new Set(process.listeners('SIGTERM'));
  const removeSignalHandlers = runner.installSignalHandlers(state);
  childProcess.spawn = () => child;
  try {
    const command = runner.spawnCommand('/tools/mock-selftest', [], state);
    const signalHandler = process.listeners('SIGTERM')
      .find((handler) => !priorHandlers.has(handler));
    assert(signalHandler, 'self-test SIGTERM handler was not installed');
    signalHandler();
    await assert.rejects(command, /self-test interrupted by SIGTERM/);
  } finally {
    childProcess.spawn = originalSpawn;
    removeSignalHandlers();
  }
  assert.deepStrictEqual(signals, ['SIGTERM', 'SIGKILL'],
    'signal path released after leader exit without killing descendants');
  assert.strictEqual(state.childTreeUnconfirmed, false);
}

async function testUnkillableGroupFailsClosed() {
  const originalSpawn = childProcess.spawn;
  const child = fakeChild(41004);
  const signals = [];
  const state = {
    child: null,
    childControl: null,
    childTreeUnconfirmed: false,
    signal: null,
    platform: 'linux',
    commandTimeoutMs: 5,
    terminationGraceMs: 5,
    terminationConfirmMs: 5,
    terminationPollMs: 1,
    unrefTimers: false,
    isProcessGroupAlive: () => true,
    killProcessGroup: (pid, signal) => {
      assert.strictEqual(pid, child.pid);
      signals.push(signal);
      if (signal === 'SIGTERM') {
        child.exitCode = 0;
        child.signalCode = 'SIGTERM';
        setImmediate(() => child.emit('exit', null, 'SIGTERM'));
      }
    },
  };
  childProcess.spawn = () => child;
  try {
    await assert.rejects(
      runner.spawnCommand('/tools/mock-selftest', [], state),
      /could not prove detached self-test process group termination/);
  } finally {
    childProcess.spawn = originalSpawn;
  }
  assert.deepStrictEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.strictEqual(state.childTreeUnconfirmed, true,
    'unconfirmed process group did not force lease retention');
}

async function testUnconfirmedTreeRetainsLease() {
  const state = {
    child: null,
    childControl: null,
    childTreeUnconfirmed: false,
    signal: null,
  };
  let releaseCalls = 0;
  const mockLock = {
    tryAcquireOnce() {
      return {
        acquired: true,
        owner: { token: 'owned-token', leaseGeneration: 'owned-generation' },
      };
    },
    release() {
      releaseCalls += 1;
      return { released: true };
    },
  };
  let error;
  try {
    await runner.execute(config('/private/mock-gpu.lock'), {
      lock: mockLock,
      installSignals: false,
      state,
      run: async () => {
        state.childTreeUnconfirmed = true;
        throw new Error('mock child-tree proof failure');
      },
    });
  } catch (caught) {
    error = caught;
  }
  assert(error, 'unconfirmed child tree did not abort the self-test');
  assert.match(error.message, /mock child-tree proof failure/);
  assert(error.releaseError, 'retained lease was not reported on the primary error');
  assert.match(error.releaseError.message, /manual recovery is required/);
  assert.strictEqual(releaseCalls, 0,
    'unconfirmed detached child allowed the production lease to be released');
}

async function testSignalDuringReleaseCompletesOwnedRelease() {
  const state = {
    child: null,
    childControl: null,
    childTreeUnconfirmed: false,
    signal: null,
  };
  const priorHandlers = new Set(process.listeners('SIGTERM'));
  let releaseCalls = 0;
  const mockLock = {
    tryAcquireOnce() {
      return {
        acquired: true,
        owner: { token: 'owned-token', leaseGeneration: 'owned-generation' },
      };
    },
    release() {
      releaseCalls += 1;
      const signalHandler = process.listeners('SIGTERM')
        .find((handler) => !priorHandlers.has(handler));
      assert(signalHandler, 'release ran without the self-test signal handler');
      signalHandler();
      return { released: true };
    },
  };
  await assert.rejects(
    runner.execute(config('/private/mock-gpu.lock'), {
      lock: mockLock,
      state,
      run: async () => {},
    }),
    /self-test interrupted by SIGTERM/);
  assert.strictEqual(releaseCalls, 1,
    'signal during release prevented the exact owned lease release');
  assert.strictEqual(
    process.listeners('SIGTERM').filter(
      (handler) => !priorHandlers.has(handler)).length,
    0,
    'self-test SIGTERM handler leaked after release');
}

async function main() {
  await testTimeoutDrainsDetachedDescendants();
  await testNormalExitRejectsDetachedDescendant();
  await testSignalDrainsDetachedDescendants();
  await testUnkillableGroupFailsClosed();
  await testUnconfirmedTreeRetainsLease();
  await testSignalDuringReleaseCompletesOwnedRelease();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-selftest-lease-'));
  const lockPath = path.join(root, 'gpu.lock');
  process.env.TDARR_GPU_PIPELINE_LOCK_DIR = lockPath;
  try {
    const calls = [];
    const result = await runner.execute(config(lockPath), {
      lock,
      installSignals: false,
      run: async (executable, argv) => {
        const owner = lock.readOwner(lockPath);
        assert(owner, 'self-test command ran without an owned production lock');
        assert.strictEqual(owner.automaticStaleBreakDisabled, true,
          'hard supervisor loss would permit automatic stale-lock theft');
        const competitor = lock.tryAcquireOnce({
          lockDir: lockPath,
          owner: { ownerId: 'competing-job' },
        });
        assert.strictEqual(competitor.acquired, false,
          'a competing job acquired during the self-test lease');
        calls.push({ executable, argv });
      },
    });
    assert.deepStrictEqual(result, { ran: true, skipped: false, reason: null });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].executable, 'runuser');
    assert.strictEqual(calls[1].executable, 'env');
    assert.strictEqual(fs.existsSync(lockPath), false,
      'owned self-test lease was not released');

    const jobLease = lock.tryAcquireOnce({
      lockDir: lockPath,
      owner: { ownerId: 'existing-job' },
    });
    assert.strictEqual(jobLease.acquired, true);
    let invoked = false;
    const skipped = await runner.execute(config(lockPath), {
      lock,
      installSignals: false,
      run: async () => { invoked = true; },
    });
    assert.deepStrictEqual(skipped, {
      ran: false,
      skipped: true,
      reason: 'gpu-pipeline-busy',
    });
    assert.strictEqual(invoked, false);
    assert.strictEqual(lock.readOwner(lockPath).token, jobLease.owner.token,
      'busy self-test changed another job lease');
    assert.strictEqual(lock.release(lockPath, jobLease.owner.token, {
      expectedGeneration: jobLease.owner.leaseGeneration,
    }).released, true);

    const nonStealable = lock.tryAcquireOnce({
      lockDir: lockPath,
      owner: {
        ownerId: 'hard-loss-simulation',
        automaticStaleBreakDisabled: true,
      },
    });
    const ownerPath = path.join(lockPath, 'owner.json');
    const deadOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    deadOwner.pid = 2147483000;
    deadOwner.workerStartTime = 1;
    fs.writeFileSync(ownerPath, `${JSON.stringify(deadOwner, null, 2)}\n`);
    await assert.rejects(
      lock.acquire({
        lockDir: lockPath,
        owner: { ownerId: 'must-not-steal-hard-loss-lease' },
        maxWaitSeconds: 1,
        waitPollSeconds: 1,
      }),
      /Timed out waiting/,
      'automatic acquisition stole a non-stealable hard-loss lease'
    );
    assert.strictEqual(lock.readOwner(lockPath).token, nonStealable.owner.token);
    assert.strictEqual(lock.release(lockPath, nonStealable.owner.token, {
      expectedGeneration: nonStealable.owner.leaseGeneration,
    }).released, true);

    console.log('PASS grain GPU self-tests hold the production lease');
  } finally {
    delete process.env.TDARR_GPU_PIPELINE_LOCK_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
