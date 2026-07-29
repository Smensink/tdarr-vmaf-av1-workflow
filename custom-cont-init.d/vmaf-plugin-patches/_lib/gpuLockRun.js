#!/usr/bin/env node
'use strict';

// Holds the shared GPU pipeline lock for exactly the lifetime of one child command.
//
// The grain fit pipeline is a long Python process whose GPU segment (the NVEncC KNN
// denoise) is a few seconds, while the surrounding work - candidate ranking, lossless
// source-clip extraction, the FFV1 consumer, grav1synth diff, hashing - is CPU-bound
// and can take minutes. Leasing the GPU lock around the whole pipeline pinned an
// exclusive GPU lease to work that never touches the GPU, so unrelated VMAF and
// transcode jobs queued behind an idle device.
//
// Acquiring per GPU segment cannot be done with a bare "acquire" / "release" CLI pair:
// the lock's heartbeat proves liveness via the OWNER pid, so an acquiring process that
// exits immediately leaves a lease whose owner is already gone, and a peer would treat
// it as dead and take over mid-denoise. Wrapping the child keeps this process alive for
// the whole critical section, which makes owner-pid liveness truthful and guarantees
// release on every exit path including a crash or a signal.

const childProcess = require('child_process');
const gpuPipelineLock = require('./gpuPipelineLock.js');

const RELEASE_FAILURE_EXIT_CODE = 70;

// Owner identity is taken from the environment rather than flags because the caller
// passes this wrapper through argparse's nargs="+", which stops consuming at the first
// token beginning with "-". Keeping the prefix flag-free lets the pipeline forward it
// verbatim without the option list being truncated.
function parseArgs(argv, env) {
    env = env || process.env;
    const opts = {
        ownerId: env.TDARR_GPU_LOCK_OWNER_ID || '',
        stage: env.TDARR_GPU_LOCK_STAGE || '',
        plugin: env.TDARR_GPU_LOCK_PLUGIN || '',
        command: '',
        commandArgs: [],
    };
    let i = 0;
    for (; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--') { i++; break; }
        const next = () => {
            const value = argv[++i];
            if (value === undefined) throw new Error(`missing value for ${arg}`);
            return value;
        };
        if (arg === '--owner-id') opts.ownerId = next();
        else if (arg === '--stage') opts.stage = next();
        else if (arg === '--plugin') opts.plugin = next();
        else throw new Error(`unknown option: ${arg}`);
    }
    const rest = argv.slice(i);
    if (!rest.length) throw new Error('a child command is required after --');
    opts.command = rest[0];
    opts.commandArgs = rest.slice(1);
    if (!opts.ownerId) {
        throw new Error('an owner id is required (--owner-id or TDARR_GPU_LOCK_OWNER_ID)');
    }
    return opts;
}

function runChild(command, commandArgs) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = childProcess.spawn(command, commandArgs, {
                stdio: 'inherit', shell: false, windowsHide: true,
            });
        } catch (error) { reject(error); return; }

        // Forward terminating signals so a supervisor killing this wrapper also stops
        // the GPU work, rather than orphaning it while the lease is released.
        const forwarded = ['SIGINT', 'SIGTERM', 'SIGHUP'];
        const handlers = {};
        for (const signal of forwarded) {
            handlers[signal] = () => { try { child.kill(signal); } catch (_) {} };
            process.on(signal, handlers[signal]);
        }
        const detach = () => {
            for (const signal of forwarded) process.removeListener(signal, handlers[signal]);
        };

        child.on('error', (error) => { detach(); reject(error); });
        child.on('close', (code, signal) => {
            detach();
            // Mirror shell convention so a signalled child is not reported as success.
            resolve(signal ? 128 + (require('os').constants.signals[signal] || 0) : (code === null ? 1 : code));
        });
    });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    // The lock module pins one fixed lock directory (env override or its default) and
    // rejects any other path, so the location is deliberately not a CLI knob here.
    const lockDir = gpuPipelineLock.resolveLockDir();

    const acquired = await gpuPipelineLock.acquire({
        lockDir,
        owner: {
            ownerId: opts.ownerId,
            workerName: process.env.Tdarr_Node_Name || process.env.TDARR_NODE_NAME ||
                process.env.nodeID || process.env.NODE_ID || process.env.HOSTNAME || 'unknown-worker',
            stage: opts.stage || 'gpu-lock-run',
            plugin: opts.plugin || 'gpuLockRun',
        },
        waitPollSeconds: 5,
        waitLogSeconds: 60,
        maxWaitSeconds: 43200,
        staleHeartbeatSeconds: 7200,
        maxLockAgeSeconds: 28800,
        initializationGraceSeconds: 30,
        heartbeatIntervalSeconds: 30,
        log: (message) => process.stderr.write(`[gpu-lock-run] ${message}\n`),
    });

    let exitCode = 1;
    try {
        exitCode = await runChild(opts.command, opts.commandArgs);
    } finally {
        const released = gpuPipelineLock.release(
            lockDir,
            acquired.owner && acquired.owner.token,
            { expectedGeneration: acquired.owner && acquired.owner.leaseGeneration },
        );
        if (!released || released.released !== true) {
            process.stderr.write('[gpu-lock-run] FAILED to release the GPU pipeline lock: ' +
                String((released && released.reason) || 'unknown reason') + '\n');
            // Surface the leak even when the GPU work itself succeeded.
            if (exitCode === 0) exitCode = RELEASE_FAILURE_EXIT_CODE;
        }
    }
    process.exit(exitCode);
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`[gpu-lock-run] ${(error && error.message) || error}\n`);
        process.exit(1);
    });
}

module.exports = { parseArgs, RELEASE_FAILURE_EXIT_CODE };
