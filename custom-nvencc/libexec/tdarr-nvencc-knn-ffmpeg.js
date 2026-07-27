#!/usr/bin/env node
'use strict';

/*
 * Supervise the production NVEncC KNN -> raw NUT -> FFmpeg pipeline without a
 * shell, temporary full-title intermediate, or unbounded child-process output.
 *
 * Usage:
 *   tdarr-nvencc-knn-ffmpeg.js \
 *     --nvencc /usr/local/bin/nvencc \
 *     --source /media/input.mkv \
 *     --output-depth 10 \
 *     --producer-log /temp/job/nvencc.log \
 *     --ffmpeg /usr/local/bin/tdarr-ffmpeg \
 *     -- <ordinary ffmpeg argv containing exactly one pipe:0 input>
 */

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const CONTRACT_ID = 'nvencc-knn-raw-nut-pipe-v1';
const KNN_SETTINGS = 'radius=3,d=0,strength=0.08,lerp=0.2,th_lerp=0.8';
const INPUT_PROBESIZE = String(100 * 1024 * 1024);
const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;

function fail(message) {
    process.stderr.write(`ERROR: ${message}\n`);
    process.exitCode = 2;
}

function parseArgs(argv) {
    const delimiter = argv.indexOf('--');
    if (delimiter < 0) throw new Error('missing -- separator before FFmpeg arguments');
    const supervisor = argv.slice(0, delimiter);
    const ffmpegArgs = argv.slice(delimiter + 1);
    const parsed = {
        nvencc: '',
        source: '',
        outputDepth: 0,
        seek: null,
        frames: null,
        producerLog: '',
        ffmpeg: '',
        ffmpegArgs,
    };
    for (let index = 0; index < supervisor.length; index += 1) {
        const option = supervisor[index];
        if (![
            '--nvencc', '--source', '--output-depth', '--seek', '--frames',
            '--producer-log', '--ffmpeg',
        ].includes(option)) {
            throw new Error(`unknown supervisor option ${option}`);
        }
        if (index + 1 >= supervisor.length) throw new Error(`missing value for ${option}`);
        const value = supervisor[index + 1];
        index += 1;
        if (option === '--nvencc') parsed.nvencc = value;
        else if (option === '--source') parsed.source = value;
        else if (option === '--output-depth') parsed.outputDepth = Number(value);
        else if (option === '--seek') parsed.seek = Number(value);
        else if (option === '--frames') parsed.frames = Number(value);
        else if (option === '--producer-log') parsed.producerLog = value;
        else if (option === '--ffmpeg') parsed.ffmpeg = value;
    }
    return parsed;
}

function assertRegularFile(filePath, description) {
    if (!path.isAbsolute(filePath)) throw new Error(`${description} path must be absolute`);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${description} must be a regular non-symlink file`);
    }
}

function assertExecutableTarget(filePath, description) {
    if (!path.isAbsolute(filePath)) throw new Error(`${description} path must be absolute`);
    const resolved = fs.realpathSync(filePath);
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
        throw new Error(`${description} must resolve to a regular file`);
    }
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
}

function validate(parsed) {
    // Production publishes NVEncC through an installer-owned atomic stable
    // symlink. Permit that stable path only when it resolves to a real
    // executable. Checkpoint authentication separately binds both the requested
    // path and resolved bytes, so a target change cannot reuse an old encode.
    assertExecutableTarget(parsed.nvencc, 'NVEncC executable');
    assertExecutableTarget(parsed.ffmpeg, 'FFmpeg executable');
    assertRegularFile(parsed.source, 'source');
    if (![8, 10].includes(parsed.outputDepth)) {
        throw new Error('output depth must be 8 or 10');
    }
    if (parsed.seek !== null && (!Number.isFinite(parsed.seek) || parsed.seek < 0)) {
        throw new Error('seek must be a finite non-negative number');
    }
    if (parsed.frames !== null &&
        (!Number.isSafeInteger(parsed.frames) || parsed.frames <= 0)) {
        throw new Error('frames must be a positive safe integer');
    }
    if (!parsed.producerLog || !path.isAbsolute(parsed.producerLog)) {
        throw new Error('producer log path must be absolute');
    }
    const logParent = fs.realpathSync(path.dirname(parsed.producerLog));
    const sourceReal = fs.realpathSync(parsed.source);
    const logRealCandidate = path.resolve(logParent, path.basename(parsed.producerLog));
    if (logRealCandidate === sourceReal) throw new Error('producer log must not replace the source');
    if (!parsed.ffmpegArgs.length) throw new Error('FFmpeg argument list is empty');
    const pipeInputs = [];
    for (let index = 0; index < parsed.ffmpegArgs.length - 1; index += 1) {
        if (parsed.ffmpegArgs[index] === '-i' &&
            parsed.ffmpegArgs[index + 1] === 'pipe:0') pipeInputs.push(index);
    }
    if (pipeInputs.length !== 1) {
        throw new Error(`FFmpeg arguments require exactly one "-i pipe:0"; observed ${pipeInputs.length}`);
    }
    if (parsed.ffmpegArgs.includes('-filter:v:0') ||
        parsed.ffmpegArgs.some((value) => /hqdn3d|nlmeans|knnlm/i.test(String(value)))) {
        throw new Error('FFmpeg consumer must not apply a second denoiser');
    }
    return parsed;
}

function buildProducerArgs(parsed) {
    const args = [
        '--disable-nvml', '2',
        '--avsw',
        '--input-analyze', '5',
        '--input-probesize', INPUT_PROBESIZE,
        '--timestamp-passthrough',
    ];
    if (parsed.seek !== null) args.push('--seek', parsed.seek.toFixed(6));
    args.push(
        '-i', parsed.source,
        '--vpp-knn', KNN_SETTINGS,
        '-c', 'raw',
        '--output-format', 'nut',
        '--output-csp', 'yuv420',
        '--output-depth', String(parsed.outputDepth)
    );
    if (parsed.frames !== null) args.push('--frames', String(parsed.frames));
    args.push('-o', '-');
    return args;
}

function boundedForward(stream, destination, logHandle, state) {
    stream.on('data', (chunk) => {
        if (state.bytes < MAX_DIAGNOSTIC_BYTES) {
            const remaining = MAX_DIAGNOSTIC_BYTES - state.bytes;
            const bounded = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            destination.write(bounded);
            state.bytes += bounded.length;
            if (bounded.length < chunk.length && !state.truncated) {
                destination.write('\n[NVEncC diagnostics truncated]\n');
                state.truncated = true;
            }
        }
        logHandle.write(chunk);
    });
}

function terminate(child, signal) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill(signal); } catch (_) {}
}

async function run(parsed) {
    fs.mkdirSync(path.dirname(parsed.producerLog), { recursive: true });
    const producerLog = fs.createWriteStream(parsed.producerLog, {
        flags: 'w',
        mode: 0o600,
    });
    const producerArgs = buildProducerArgs(parsed);
    process.stderr.write(
        `[${CONTRACT_ID}] starting NVEncC KNN producer and FFmpeg consumer\n`
    );
    process.stderr.write(
        `[${CONTRACT_ID}] KNN=${KNN_SETTINGS}; depth=${parsed.outputDepth}\n`
    );

    const producer = childProcess.spawn(parsed.nvencc, producerArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const consumer = childProcess.spawn(parsed.ffmpeg, parsed.ffmpegArgs, {
        stdio: ['pipe', 'inherit', 'pipe'],
        windowsHide: true,
    });
    consumer.stdin.on('error', (error) => {
        if (!error || error.code !== 'EPIPE') {
            process.stderr.write(
                `[${CONTRACT_ID}] FFmpeg stdin error: ${error && error.message}\n`
            );
        }
    });
    producer.stdout.pipe(consumer.stdin);
    consumer.stderr.pipe(process.stderr);
    boundedForward(
        producer.stderr,
        process.stderr,
        producerLog,
        { bytes: 0, truncated: false }
    );

    let terminating = false;
    let killTimer = null;
    const stopBoth = (signal) => {
        if (terminating && signal !== 'SIGKILL') return;
        terminating = true;
        terminate(producer, signal);
        terminate(consumer, signal);
        if (signal !== 'SIGKILL') {
            killTimer = setTimeout(() => {
                terminate(producer, 'SIGKILL');
                terminate(consumer, 'SIGKILL');
            }, 5000);
            killTimer.unref();
        }
    };
    const signalHandler = (signal) => {
        process.stderr.write(`[${CONTRACT_ID}] received ${signal}; stopping both children\n`);
        stopBoth(signal);
    };
    process.once('SIGINT', () => signalHandler('SIGINT'));
    process.once('SIGTERM', () => signalHandler('SIGTERM'));
    process.once('SIGHUP', () => signalHandler('SIGHUP'));

    const childResult = (child, name) => new Promise((resolve) => {
        child.once('error', (error) => resolve({ name, code: null, signal: null, error }));
        child.once('exit', (code, signal) => resolve({ name, code, signal, error: null }));
    });
    const producerPromise = childResult(producer, 'NVEncC');
    const consumerPromise = childResult(consumer, 'FFmpeg');
    producerPromise.then((result) => {
        if (result.error || result.code !== 0) stopBoth('SIGTERM');
    });
    consumerPromise.then((result) => {
        if (result.error || result.code !== 0) stopBoth('SIGTERM');
    });
    const [producerResult, consumerResult] = await Promise.all([
        producerPromise,
        consumerPromise,
    ]);
    if (killTimer) clearTimeout(killTimer);
    producerLog.end();

    for (const result of [producerResult, consumerResult]) {
        if (result.error) {
            throw new Error(`${result.name} failed to start: ${result.error.message}`);
        }
        if (result.code !== 0) {
            throw new Error(
                `${result.name} exited ${result.code === null ? 'without a code' : `with code ${result.code}`}` +
                (result.signal ? ` after ${result.signal}` : '')
            );
        }
    }
    process.stderr.write(`[${CONTRACT_ID}] producer and consumer completed successfully\n`);
}

async function main() {
    try {
        const parsed = validate(parseArgs(process.argv.slice(2)));
        await run(parsed);
    } catch (error) {
        fail(error && error.message ? error.message : String(error));
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    CONTRACT_ID,
    KNN_SETTINGS,
    parseArgs,
    validate,
    assertExecutableTarget,
    buildProducerArgs,
    run,
};
