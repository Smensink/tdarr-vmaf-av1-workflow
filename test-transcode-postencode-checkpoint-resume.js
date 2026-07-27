'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const postEncodeCheckpoint = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/postEncodeCheckpoint.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-transcode-checkpoint-resume-'));
const sourcePath = path.join(scratch, 'source.ts');
const checkpointRoot = path.join(scratch, 'protected-checkpoints');
const reuseRequiredRoot = path.join(scratch, 'protected-reuse-required');
fs.writeFileSync(sourcePath, Buffer.alloc(16384, 0x30));
postEncodeCheckpoint.initializeReuseRequiredRoot(reuseRequiredRoot);

let encodeCalls = 0;
let fullDecodeCalls = 0;
// One bounded sample first tries NVDEC and then software. Fail both backends
// once to model a genuinely transient validator outage.
let transientDecodeFailures = 2;
let failNextFullDecode = false;
let mergeCalls = 0;
let failMerge = true;

class MockCLI {
    constructor(options) { this.options = options; }
    async runCli() {
        encodeCalls += 1;
        fs.writeFileSync(this.options.outputFilePath, Buffer.alloc(24576, 0x31));
        return { cliExitCode: 0 };
    }
}

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
    if (request === '../../../../FlowHelpers/1.0.0/cliUtils') return { CLI: MockCLI };
    if (request === '../../../../../methods/lib') {
        return function () {
            return { loadDefaultValues(inputs) { return inputs || {}; } };
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const pluginPath = path.join(__dirname,
    'custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js');
const plugin = require(pluginPath).plugin;

function identify(title, tracks) {
    return {
        attachments: [], chapters: [], errors: [], global_tags: [], warnings: [],
        container: { supported: true, properties: { title } }, tracks,
    };
}

const oldVideo = { type: 'video', codec: 'HEVC', properties: { codec_id: 'V_MPEGH/ISO/HEVC', uid: '101' } };
const newVideo = { type: 'video', codec: 'AV1', properties: { codec_id: 'V_AV1', uid: '201' } };
const audio = {
    type: 'audio', codec: 'AAC',
    properties: { codec_id: 'A_AAC', uid: '102', language: 'eng', default_track: true },
};
const sourceIdentify = identify('checkpoint fixture', [oldVideo, audio]);
const videoIdentify = identify('', [newVideo]);
const outputIdentify = identify('checkpoint fixture', [newVideo, audio]);

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function mockSpawnSync(command, argv) {
    if (command === 'tdarr-ffmpeg') {
        assert(argv.includes('-f') && argv.includes('null'), 'checkpoint validation must full-decode primary video');
        fullDecodeCalls += 1;
        if (transientDecodeFailures > 0) {
            transientDecodeFailures -= 1;
            const timeoutError = new Error('injected transient decoder spawn timeout');
            timeoutError.code = 'ETIMEDOUT';
            return { error: timeoutError, status: null, stdout: '', stderr: '' };
        }
        if (failNextFullDecode) {
            failNextFullDecode = false;
            return { status: 69, stdout: '', stderr: 'injected AV1 decode corruption' };
        }
        return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'ffprobe') {
        const target = String(argv[argv.length - 1]);
        return {
            status: 0, stderr: '', stdout: JSON.stringify({
                format: {
                    format_name: 'matroska,webm', duration: '10',
                    size: String(fs.statSync(target).size),
                },
                streams: [{
                    index: 0, codec_type: 'video', codec_name: 'av1',
                    width: 1920, height: 1080, pix_fmt: 'yuv420p10le',
                    avg_frame_rate: '24/1', r_frame_rate: '24/1',
                    nb_read_packets: '240', disposition: { attached_pic: 0 },
                }],
            }),
        };
    }
    assert.strictEqual(command, 'mkvmerge', `unexpected child command: ${command}`);
    if (argv[0] === '-J') {
        const target = path.resolve(String(argv[1]));
        const payload = target === path.resolve(sourcePath)
            ? sourceIdentify
            : target.endsWith('.mkvmerge-partial.mkv') ? outputIdentify : videoIdentify;
        return { status: 0, stdout: JSON.stringify(payload), stderr: '' };
    }
    mergeCalls += 1;
    if (failMerge) return { status: 2, stdout: '', stderr: 'injected post-encode naming/remux failure' };
    const outputIndex = argv.indexOf('--output');
    fs.writeFileSync(argv[outputIndex + 1], Buffer.alloc(32768, 0x32));
    return { status: 0, stdout: '', stderr: '' };
};

function variables() {
    return {
        vmafBestParameters: {
            id: 'gpu_p7_cq28', encoder: 'av1_nvenc', preset: 'p7', quality: 28,
            isGPU: true, pixFmt: 'yuv420p10le',
        },
        vmafFinalSelectedCQ: 28,
        vmafSelectedParameterSetId: 'gpu_p7_cq28',
        vmafReferenceContractId: 'legacy-original-tf4-v1',
        vmafCanonicalDenoiseActive: false,
        vmafNvencTemporalPolicy: 'legacy-original',
        color_primaries: 'bt709', color_trc: 'bt709', colorspace: 'bt709',
    };
}

function argsFor(jobName) {
    const workDir = path.join(scratch, jobName);
    fs.mkdirSync(workDir);
    const logs = [];
    return {
        inputFileObj: {
            _id: sourcePath,
            file_size: fs.statSync(sourcePath).size / (1024 * 1024),
            ffProbeData: {
                format: { duration: '10', format_name: 'matroska,webm' },
                streams: [
                    {
                        index: 0, codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080,
                        avg_frame_rate: '24/1', disposition: { attached_pic: 0 },
                    },
                    { index: 1, codec_type: 'audio' },
                ],
            },
        },
        inputs: {}, variables: variables(), workDir,
        ffmpegPath: 'tdarr-ffmpeg', ffprobePath: 'ffprobe',
        jobLog(message) { logs.push(String(message)); }, _logs: logs,
    };
}

async function main() {
    process.env.NODE_ENV = 'test';
    process.env.VMAF_POSTENCODE_TEST_UNPINNED_STORAGE = '1';
    process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT = checkpointRoot;
    process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT = reuseRequiredRoot;

    const firstArgs = argsFor('tdarr-workDir-job-1');
    const first = await plugin(firstArgs);
    assert.strictEqual(first.outputNumber, 2, 'transient validation failure must remain technical');
    assert.match(firstArgs.variables.vmafTranscodeFailureReason, /postencode_checkpoint_validation_retry/);
    assert.strictEqual(encodeCalls, 1);
    assert.strictEqual(firstArgs.variables.vmafPostEncodeCheckpointStatus, 'pending_candidate_validation');
    const firstEntry = path.dirname(firstArgs.variables.vmafPostEncodeCheckpointPath);
    assert(fs.readdirSync(firstEntry).some((name) => name === 'candidate.json'));
    assert(fs.readdirSync(firstEntry).some((name) => name.includes('.postencode-candidate.mkv')),
        'FFmpeg-exit-0 artifact must survive a transient validator failure');

    const secondArgs = argsFor('tdarr-workDir-job-2');
    const second = await plugin(secondArgs);
    assert.strictEqual(second.outputNumber, 2, 'injected ancillary failure must remain technical');
    assert.match(secondArgs.variables.vmafTranscodeFailureReason, /mkvmerge_ancillary_preservation_failed/);
    assert.strictEqual(encodeCalls, 1,
        'retrying/finalizing the exit-0 candidate must not run another title encode');
    assert.strictEqual(secondArgs.variables.vmafPostEncodeCheckpointStatus, 'reused');
    assert.strictEqual(fs.existsSync(secondArgs.variables.vmafPostEncodeCheckpointPath), true,
        'postprocess failure must not delete the finalized AV1 checkpoint');

    failMerge = false;
    const thirdArgs = argsFor('tdarr-workDir-job-3');
    const third = await plugin(thirdArgs);
    // Output 2: the checkpoint is still reused and no re-encode happens, but the
    // finished output is refused by the post-encode size gate (see below).
    assert.strictEqual(third.outputNumber, 2);
    assert.strictEqual(encodeCalls, 1,
        'a new Tdarr job with the same source/command must not run another title encode');
    assert.strictEqual(mergeCalls, 2, 'only the cheap failed postprocess stage should be retried');
    assert.strictEqual(thirdArgs.variables.vmafPostEncodeCheckpointStatus, 'reused');
    assert.strictEqual(secondArgs.variables.vmafPostEncodeCheckpointStatus, 'reused');
    assert.strictEqual(fullDecodeCalls, 8,
        'transient dual-backend attempt plus two three-window validations must run');
    assert(thirdArgs._logs.some((line) => line.includes('skipping the completed title encode')));

    // The synthetic output here is deliberately larger than the synthetic source,
    // which now trips the authoritative post-encode size gate. This used to be
    // an advisory that kept the oversized output ('success', advisoryOnly, no
    // error) — the behaviour that let five real outputs larger than their sources
    // replace and destroy their originals on 2026-07-25/26. It must now fail
    // closed so the original is preserved.
    assert.strictEqual(thirdArgs.variables.vmafTranscodeStatus, 'size_failed');
    assert.strictEqual(thirdArgs.variables.vmafTranscodeSucceeded, false);
    assert.strictEqual(thirdArgs.variables.vmafFinalOutputSizeRejected, true);
    assert.strictEqual(thirdArgs.variables.liveSizeCompare.enabled, false);
    assert.strictEqual(thirdArgs.variables.liveSizeCompare.error, true);
    assert.strictEqual(thirdArgs.variables.liveSizeCompare.errorType, 'upperThreshold');
    assert.strictEqual(thirdArgs.variables.liveSizeCompare.advisoryOnly, false);
    assert(thirdArgs.variables.vmafFinalOutputRatioPct > 100);
    assert(thirdArgs.variables.vmafTranscodeQualityWarnings.some((warning) =>
        warning.code === 'final-output-larger-than-source' && warning.advisory === false));
    assert(thirdArgs._logs.some((line) => line.includes('refusing the encode and preserving the original')));

    // A fingerprint-matching file that no longer full-decodes is not reusable. Only
    // this integrity failure is allowed to trigger another real encode.
    failNextFullDecode = true;
    const fourthArgs = argsFor('tdarr-workDir-job-4');
    const fourth = await plugin(fourthArgs);
    // Re-encoded, committed, then refused by the size gate: the synthetic output
    // is still larger than the synthetic source.
    assert.strictEqual(fourth.outputNumber, 2);
    assert.strictEqual(encodeCalls, 2,
        'failed full-decode validation must invalidate the checkpoint and run a real encode');
    assert.strictEqual(fullDecodeCalls, 12,
        'rejected reuse plus replacement commit must run bounded corruption checks');
    assert.strictEqual(fourthArgs.variables.vmafPostEncodeCheckpointStatus, 'committed');
    assert(fourthArgs._logs.some((line) =>
        line.includes('GPU decode confirmed corruption') ||
        line.includes('bounded decode confirmed corruption')));

    console.log('PASS post-encode retry resumes checkpoint; oversized output fails closed; decode corruption re-encodes');
}

main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
}).finally(() => {
    childProcess.spawnSync = originalSpawnSync;
    Module._load = originalLoad;
    delete process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT;
    delete process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT;
    delete process.env.VMAF_POSTENCODE_TEST_UNPINNED_STORAGE;
    delete process.env.NODE_ENV;
    fs.rmSync(scratch, { recursive: true, force: true });
});
