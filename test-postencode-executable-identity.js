'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-ffmpeg-identity-'));
const executable = path.join(scratch, 'tdarr-ffmpeg');
const targetDir = path.join(scratch, 'ffmpeg-custom', 'bin');
const target = path.join(targetDir, 'ffmpeg');

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
    if (request === '../../../../FlowHelpers/1.0.0/cliUtils') {
        return { CLI: class MockCLI {} };
    }
    return originalLoad.call(this, request, parent, isMain);
};

try {
    const transcode = require(
        './custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js')._test;
    const checkpoint = require(
        './custom-cont-init.d/vmaf-plugin-patches/_lib/postEncodeCheckpoint.js');
    const nvenccKnn = require(
        './custom-cont-init.d/vmaf-plugin-patches/_lib/nvenccKnn.js');
    const fixedTime = new Date('2026-07-23T00:00:00.000Z');
    const recreatedTime = new Date('2026-07-23T00:05:00.000Z');
    fs.mkdirSync(targetDir, { recursive: true });
    assert.strictEqual(transcode.absoluteShellExecTarget(
        '#!/bin/sh\nexport LD_LIBRARY_PATH=/custom-libvmaf-lib\n' +
        'exec /usr/local/ffmpeg-custom/bin/ffmpeg "$@"\n'),
    '/usr/local/ffmpeg-custom/bin/ffmpeg',
    'the exact production wrapper exec line must resolve narrowly');

    function writeLauncher() {
        fs.writeFileSync(executable, '#!/bin/sh\nexec "' + target + '" "$@"\n');
    }

    function contract(identity) {
        return {
            schema: 1,
            executable,
            executable_identity: identity,
            argv: ['-i', '<SOURCE>', '-c:v', 'av1_nvenc', '<OUTPUT>'],
        };
    }

    function buildKey(encodeContract) {
        const workDir = path.join(scratch, 'job-' + Math.random().toString(16).slice(2));
        fs.mkdirSync(workDir);
        return checkpoint.buildPlan({
            workDir,
            checkpointRoot: path.join(scratch, 'protected'),
            sourceFingerprint: {
                scheme: 'sha256-sampled-v1', sha256: '7'.repeat(64), size_bytes: 100,
                mtime_ns: 1, sample_bytes: 100, sample_offsets: [0],
                resolved_path: path.join(scratch, 'source.mkv'),
            },
            encodeContract,
            extension: '.mkv',
            validateArtifact() { return { valid: true }; },
        }).checkpointKey;
    }

    fs.writeFileSync(target, Buffer.alloc(8192, 0x61));
    writeLauncher();
    fs.utimesSync(executable, fixedTime, fixedTime);
    fs.utimesSync(target, fixedTime, fixedTime);
    const first = transcode.resolveExecutableIdentity(executable);
    const firstKey = buildKey(contract(first));
    assert.match(first.sha256_full, /^[0-9a-f]{64}$/);
    assert.match(first.effective_target.sha256_full, /^[0-9a-f]{64}$/);
    ['mtime_ns', 'ctime_ns', 'device', 'inode'].forEach((field) => {
        assert.strictEqual(first[field], undefined, `${field} must not persist in launcher identity`);
        assert.strictEqual(first.effective_target[field], undefined,
            `${field} must not persist in target identity`);
    });

    // Recreate both files with identical bytes but different filesystem instance
    // metadata, matching a container restart/init-wrapper reinstall.
    fs.unlinkSync(executable);
    fs.unlinkSync(target);
    fs.writeFileSync(target, Buffer.alloc(8192, 0x61));
    writeLauncher();
    fs.utimesSync(executable, recreatedTime, recreatedTime);
    fs.utimesSync(target, recreatedTime, recreatedTime);
    const recreated = transcode.resolveExecutableIdentity(executable);
    assert.deepStrictEqual(recreated, first,
        'identical launcher and target bytes must survive inode/timestamp recreation');
    assert.strictEqual(buildKey(contract(recreated)), firstKey,
        'filesystem recreation alone must not invalidate the checkpoint key');

    const sourcePath = path.join(scratch, 'source.mkv');
    const outputPath = path.join(scratch, 'output.mkv');
    function pipelineContract(jobName) {
        const producerLog = path.join(scratch, jobName, 'nvencc.log');
        const coordinatorOptions = {
            nvenccPath: target,
            coordinatorPath: executable,
            sourcePath,
            outputDepth: 10,
            producerLog,
            ffmpegPath: target,
            ffmpegArgs: ['-f', 'nut', '-i', 'pipe:0', '-c:v', 'av1_nvenc', outputPath],
        };
        return transcode.buildPostEncodeContract(
            executable,
            nvenccKnn.buildCoordinatorArgs(coordinatorOptions),
            sourcePath,
            outputPath,
            {
                producer: target,
                consumer: target,
                producerLog,
                pipeline: nvenccKnn.contractDescriptor(coordinatorOptions),
            }
        );
    }
    const firstJobContract = pipelineContract('job-a');
    const secondJobContract = pipelineContract('job-b');
    assert.deepStrictEqual(secondJobContract, firstJobContract,
        'job-owned producer diagnostics must not make checkpoints unrecoverable across workers');
    assert(firstJobContract.argv.includes('<PRODUCER_LOG>'));
    assert.strictEqual(firstJobContract.argv.some((item) => /job-[ab]/.test(item)), false);
    assert.match(buildKey(firstJobContract), /^[0-9a-f]{64}$/,
        'the strict checkpoint validator must accept the portable producer-log token');
    const legacyAbsoluteLogContract = JSON.parse(JSON.stringify(firstJobContract));
    legacyAbsoluteLogContract.argv[
        legacyAbsoluteLogContract.argv.indexOf('<PRODUCER_LOG>')
    ] = path.join(scratch, 'legacy-job', 'nvencc.log');
    assert.throws(() => buildKey(legacyAbsoluteLogContract), /not bound to its pipeline/,
        'normal checkpoint planning must reject a legacy job-owned diagnostic path');
    const duplicatedLogTokenContract = JSON.parse(JSON.stringify(firstJobContract));
    duplicatedLogTokenContract.argv.push('<PRODUCER_LOG>');
    assert.throws(() => buildKey(duplicatedLogTokenContract), /not bound to its pipeline/,
        'the producer-log token must occur exactly once at its option value');

    // The wrapper text is unchanged, but its effective FFmpeg target changes at
    // the same path and byte length. The target digest must invalidate reuse.
    fs.writeFileSync(target, Buffer.alloc(8192, 0x62));
    fs.utimesSync(target, recreatedTime, recreatedTime);
    const changedTarget = transcode.resolveExecutableIdentity(executable);
    assert.strictEqual(changedTarget.sha256_full, first.sha256_full,
        'unchanged launcher bytes must retain their digest');
    assert.notStrictEqual(changedTarget.effective_target.sha256_full,
        first.effective_target.sha256_full,
        'changed effective FFmpeg bytes must change the target digest');
    assert.notStrictEqual(buildKey(contract(changedTarget)), firstKey,
        'changed effective FFmpeg bytes must change the checkpoint key');

    fs.writeFileSync(executable, '#!/bin/sh\nexec ffmpeg "$@"\n');
    assert.throws(() => transcode.resolveExecutableIdentity(executable),
        /cannot authenticate a non-absolute FFmpeg wrapper target/,
        'production wrapper with an unauthenticated relative target must fail closed');

    console.log('PASS stable launcher/target byte identities govern checkpoint reuse');
} finally {
    Module._load = originalLoad;
    fs.rmSync(scratch, { recursive: true, force: true });
}
