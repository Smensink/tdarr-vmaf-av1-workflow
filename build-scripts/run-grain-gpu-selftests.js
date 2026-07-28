'use strict';

// Own the same generation-scoped lease as production Flow GPU work while the
// grain/NVEncC runtime self-tests execute. This helper never waits for, breaks,
// or steals an existing lock: a busy pipeline is a successful self-test skip.

const childProcess = require('child_process');
const path = require('path');

const DEFAULT_LOCK_PATH = '/temp/tdarr-vmaf-gpu-pipeline.lock';
const DEFAULT_LOCK_HELPER =
  '/custom-cont-init.d/vmaf-plugin-patches/_lib/gpuPipelineLock.js';
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const TERMINATION_GRACE_MS = 5000;
const TERMINATION_CONFIRM_MS = 5000;
const TERMINATION_POLL_MS = 50;

function required(value, label) {
  const text = String(value || '');
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function configFromEnv(environment = process.env) {
  const lockPath = path.resolve(
    environment.TDARR_GPU_PIPELINE_LOCK_DIR || DEFAULT_LOCK_PATH
  );
  const lockHelperPath = path.resolve(
    environment.TDARR_GPU_LOCK_HELPER || DEFAULT_LOCK_HELPER
  );
  return Object.freeze({
    lockPath,
    lockHelperPath,
    runtimeUser: required(environment.TDARR_RUNTIME_USER, 'TDARR_RUNTIME_USER'),
    grav1synth: required(environment.TDARR_GRAV1SYNTH, 'TDARR_GRAV1SYNTH'),
    grav1synthRegression: required(
      environment.GRAV1SYNTH_NVENC_REGRESSION,
      'GRAV1SYNTH_NVENC_REGRESSION'
    ),
    ffmpeg: required(environment.TDARR_FFMPEG, 'TDARR_FFMPEG'),
    nvenccContractEnabled:
      String(environment.TDARR_NVENCC_CONTRACT_ENABLED || '') === '1',
    nvencc: String(environment.TDARR_NVENCC || ''),
    nvenccSmoke: String(environment.NVENCC_KNN_SMOKE || ''),
    smokeBase: String(environment.NVENCC_SMOKE_BASE || '/tmp'),
  });
}

function boundedStateInteger(state, key, fallback) {
  const value = Number(state && state[key]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function timer(state, callback, milliseconds) {
  const handle = setTimeout(callback, milliseconds);
  if (!state || state.unrefTimers !== false) handle.unref();
  return handle;
}

function delay(state, milliseconds) {
  if (state && typeof state.sleep === 'function') {
    return Promise.resolve(state.sleep(milliseconds));
  }
  // Drain timers must keep the supervisor alive after the detached group leader
  // exits; otherwise Node can exit before SIGKILL escalation or absence proof.
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function childTreeAlive(child, state = {}) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return false;
  }
  if (typeof state.isProcessGroupAlive === 'function') {
    return state.isProcessGroupAlive(child.pid) === true;
  }
  const platform = state.platform || process.platform;
  if (platform === 'win32') {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function terminateChildTree(child, signal, state = {}) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return { sent: false, absent: true };
  }
  const platform = state.platform || process.platform;
  try {
    if (platform !== 'win32') {
      if (typeof state.killProcessGroup === 'function') {
        state.killProcessGroup(child.pid, signal);
      } else {
        process.kill(-child.pid, signal);
      }
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    } else {
      return { sent: false, absent: true };
    }
    return { sent: true, absent: false };
  } catch (error) {
    if (error && error.code === 'ESRCH') {
      return { sent: false, absent: true };
    }
    return { sent: false, absent: false, error };
  }
}

async function waitForChildTreeExit(child, state, timeoutMs) {
  const pollMs = boundedStateInteger(
    state, 'terminationPollMs', TERMINATION_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!childTreeAlive(child, state)) return true;
    if (Date.now() >= deadline) return false;
    await delay(state, Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

function beginChildTreeTermination(control, state) {
  if (control.terminationPromise) return control.terminationPromise;
  control.terminationPromise = (async () => {
    const term = terminateChildTree(control.child, 'SIGTERM', state);
    if (term.error) control.terminationErrors.push(term.error);
    const graceMs = boundedStateInteger(
      state, 'terminationGraceMs', TERMINATION_GRACE_MS);
    let exited = false;
    try {
      exited = await waitForChildTreeExit(control.child, state, graceMs);
    } catch (error) {
      control.terminationErrors.push(error);
    }
    if (exited) return;

    const killed = terminateChildTree(control.child, 'SIGKILL', state);
    if (killed.error) control.terminationErrors.push(killed.error);
    const confirmMs = boundedStateInteger(
      state, 'terminationConfirmMs', TERMINATION_CONFIRM_MS);
    try {
      exited = await waitForChildTreeExit(control.child, state, confirmMs);
    } catch (error) {
      control.terminationErrors.push(error);
    }
    if (!exited) {
      const details = control.terminationErrors
        .map((error) => String(error && error.message || error))
        .filter(Boolean)
        .join('; ');
      throw new Error(
        'could not prove detached self-test process group termination' +
        (details ? `: ${details}` : ''));
    }
  })();
  control.terminationPromise.catch((error) => {
    state.childTreeUnconfirmed = true;
    control.terminationError = error;
    if (typeof control.onTerminationFailure === 'function') {
      control.onTerminationFailure(error);
    }
  });
  return control.terminationPromise;
}

function spawnCommand(executable, argv, state) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(executable, argv, {
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
    });
    state.child = child;
    const control = {
      child,
      terminationErrors: [],
      terminationError: null,
      terminationPromise: null,
    };
    state.childControl = control;
    let settled = false;
    let timedOut = false;
    const commandTimeoutMs = boundedStateInteger(
      state, 'commandTimeoutMs', COMMAND_TIMEOUT_MS);
    const timeout = timer(state, () => {
      timedOut = true;
      void beginChildTreeTermination(control, state);
    }, commandTimeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      state.child = null;
      state.childControl = null;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    control.onTerminationFailure = (error) => {
      if (typeof child.unref === 'function') child.unref();
      finish(error);
    };
    child.once('error', (error) => {
      try {
        if (childTreeAlive(child, state)) {
          state.childTreeUnconfirmed = true;
        }
      } catch (_) {
        state.childTreeUnconfirmed = true;
      }
      if (state.childTreeUnconfirmed && typeof child.unref === 'function') {
        child.unref();
      }
      finish(error);
    });
    child.once('exit', (code, signal) => {
      void (async () => {
        let orphaned = false;
        try {
          if (state.signal || timedOut) {
            await beginChildTreeTermination(control, state);
          } else if (childTreeAlive(child, state)) {
            orphaned = true;
            await beginChildTreeTermination(control, state);
          }
        } catch (error) {
          state.childTreeUnconfirmed = true;
          if (typeof child.unref === 'function') child.unref();
          finish(error);
          return;
        }
        if (orphaned) {
          finish(new Error(
            `${path.basename(executable)} self-test left a detached descendant`));
        } else if (state.signal) {
          finish(new Error(`self-test interrupted by ${state.signal}`));
        } else if (timedOut) {
          finish(new Error(`${path.basename(executable)} self-test timed out`));
        } else if (code !== 0) {
          finish(new Error(
            `${path.basename(executable)} self-test failed with code ${code}` +
            (signal ? ` (${signal})` : '')
          ));
        } else {
          finish(null, { code, signal });
        }
      })();
    });
  });
}

function installSignalHandlers(state) {
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (!state.signal) state.signal = signal;
      const control = state.childControl;
      if (control) void beginChildTreeTermination(control, state);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  };
}

function loadLockHelper(helperPath) {
  // The path is deployment-controlled and checksum-pinned by the surrounding
  // preflight. Dynamic loading keeps the helper usable in the review checkout.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const helper = require(helperPath);
  if (!helper || typeof helper.tryAcquireOnce !== 'function' ||
      typeof helper.release !== 'function') {
    throw new Error('GPU lock helper lacks the one-shot owned-lease contract');
  }
  return helper;
}

async function execute(config, supplied = {}) {
  const lock = supplied.lock || loadLockHelper(config.lockHelperPath);
  const state = supplied.state || {
    child: null,
    childControl: null,
    childTreeUnconfirmed: false,
    signal: null,
  };
  state.childTreeUnconfirmed = false;
  const run = supplied.run || ((executable, argv) =>
    spawnCommand(executable, argv, state));
  const removeSignalHandlers = supplied.installSignals === false
    ? () => {}
    : installSignalHandlers(state);
  let lease = null;
  let primaryError = null;
  let releaseError = null;
  let outcome = null;
  try {
    lease = lock.tryAcquireOnce({
      lockDir: config.lockPath,
      owner: {
        ownerId: 'grain-toolchain-runtime-selftests',
        workerName: 'maintenance-preflight',
        automaticStaleBreakDisabled: true,
      },
      heartbeatIntervalSeconds: 5,
    });
    if (!lease || lease.acquired !== true) {
      outcome = Object.freeze({
        ran: false,
        skipped: true,
        reason: 'gpu-pipeline-busy',
      });
    } else {
      if (state.signal) throw new Error(`self-test interrupted by ${state.signal}`);

      await run('runuser', [
        '-u', config.runtimeUser,
        '--',
        'env', 'GRAV1SYNTH_REGRESSION_QUIET=1',
        'bash', config.grav1synthRegression, config.grav1synth, config.ffmpeg,
      ]);
      if (state.signal) throw new Error(`self-test interrupted by ${state.signal}`);

      if (config.nvenccContractEnabled) {
        required(config.nvencc, 'TDARR_NVENCC');
        required(config.nvenccSmoke, 'NVENCC_KNN_SMOKE');
        await run('env', [
          `TDARR_NVENCC=${config.nvencc}`,
          `TDARR_FFMPEG=${config.ffmpeg}`,
          `TDARR_RUNTIME_USER=${config.runtimeUser}`,
          `NVENCC_SMOKE_BASE=${config.smokeBase}`,
          'bash', config.nvenccSmoke,
        ]);
      }
      if (state.signal) throw new Error(`self-test interrupted by ${state.signal}`);
      outcome = Object.freeze({ ran: true, skipped: false, reason: null });
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      if (lease && lease.acquired === true) {
        if (state.childTreeUnconfirmed) {
          releaseError = new Error(
            'GPU self-test lease retained because detached child termination ' +
            'was not confirmed; manual recovery is required');
        } else {
          const released = lock.release(config.lockPath, lease.owner.token, {
            expectedGeneration: lease.owner.leaseGeneration,
          });
          if (!released || released.released !== true) {
            releaseError = new Error('GPU self-test lease release was not confirmed');
          }
        }
      }
    } finally {
      removeSignalHandlers();
    }
  }
  if (releaseError && primaryError) primaryError.releaseError = releaseError;
  if (primaryError) throw primaryError;
  if (releaseError) throw releaseError;
  if (state.signal) throw new Error(`self-test interrupted by ${state.signal}`);
  return outcome;
}

async function main() {
  const result = await execute(configFromEnv());
  process.stdout.write(result.ran ? 'RAN\n' : 'SKIPPED_BUSY\n');
}

module.exports = {
  DEFAULT_LOCK_HELPER,
  DEFAULT_LOCK_PATH,
  COMMAND_TIMEOUT_MS,
  configFromEnv,
  execute,
  installSignalHandlers,
  loadLockHelper,
  required,
  spawnCommand,
  terminateChildTree,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  });
}
