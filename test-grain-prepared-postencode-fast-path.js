'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const grainArtifactActual = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/grainAnalysisArtifact.js');
const canonicalDenoise = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/canonicalDenoise.js');
const nvencTemporalFilter = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/nvencTemporalFilter.js');
const postEncodeCheckpoint = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/postEncodeCheckpoint.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-grain-prepared-fast-path-'));
const sourcePath = path.join(scratch, 'source.mkv');
const workDir = path.join(scratch, 'tdarr-workDir-job');
const checkpointRoot = path.join(scratch, 'protected-checkpoints');
const reuseRequiredRoot = path.join(scratch, 'protected-reuse-required');
const ffmpegPath = path.join(scratch, 'tdarr-ffmpeg');
const effectiveFfmpegPath = path.join(scratch, 'ffmpeg-effective');
const nvenccPath = path.join(scratch, 'nvencc');
const coordinatorPath = path.join(scratch, 'tdarr-nvencc-knn-ffmpeg.js');
fs.mkdirSync(workDir);
fs.writeFileSync(sourcePath, Buffer.alloc(32768, 0x41));
fs.writeFileSync(effectiveFfmpegPath, 'FFmpeg fixture\n');
fs.writeFileSync(ffmpegPath, `#!/bin/sh\nexec "${effectiveFfmpegPath}" "$@"\n`);
fs.writeFileSync(nvenccPath, 'NVEncC fixture\n');
fs.writeFileSync(coordinatorPath, '#!/usr/bin/env node\n');
postEncodeCheckpoint.initializeReuseRequiredRoot(reuseRequiredRoot);

let encodeCalls = 0;
let fullDecodeCalls = 0;
let ancillaryMergeCalls = 0;

class MockCLI {
    constructor(options) { this.options = options; }
    async runCli() {
        encodeCalls += 1;
        fs.writeFileSync(this.options.outputFilePath, Buffer.alloc(16384, 0x42));
        return { cliExitCode: 0 };
    }
}

const sourceIdentify = {
    attachments: [], chapters: [], errors: [], global_tags: [], warnings: [],
    container: { supported: true, properties: { title: 'prepared fixture' } },
    tracks: [
        { type: 'video', codec: 'HEVC', properties: { codec_id: 'V_MPEGH/ISO/HEVC', uid: '101' } },
        { type: 'audio', codec: 'AAC', properties: { codec_id: 'A_AAC', uid: '102' } },
    ],
};

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
    if (request === '../../../../FlowHelpers/1.0.0/cliUtils') return { CLI: MockCLI };
    if (request === '../../../../../methods/lib') {
        return function () { return { loadDefaultValues(inputs) { return inputs || {}; } }; };
    }
    if (request === '../../_lib/grainAnalysisArtifact.js') {
        return Object.assign({}, grainArtifactActual, {
            canonicalDenoiseDisposition() { return 'prepared'; },
        });
    }
    return originalLoad.call(this, request, parent, isMain);
};

const plugin = require('./custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js').plugin;

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function mockSpawnSync(command, argv) {
    if (command === 'ffprobe') {
        const target = String(argv[argv.length - 1]);
        return {
            status: 0, stderr: '', stdout: JSON.stringify({
                format: { format_name: 'matroska,webm', duration: '10', size: String(fs.statSync(target).size) },
                streams: [{
                    index: 0, codec_type: 'video', codec_name: 'av1', width: 1920, height: 1080,
                    pix_fmt: 'yuv420p10le', avg_frame_rate: '24/1', r_frame_rate: '24/1',
                    nb_read_packets: '240', disposition: { attached_pic: 0 },
                }],
            }),
        };
    }
    if (path.resolve(String(command)) === path.resolve(ffmpegPath)) {
        fullDecodeCalls += 1;
        return { status: 0, stdout: '', stderr: '' };
    }
    assert.strictEqual(command, 'mkvmerge');
    if (argv[0] === '-J' && path.resolve(String(argv[1])) === path.resolve(sourcePath)) {
        return { status: 0, stdout: JSON.stringify(sourceIdentify), stderr: '' };
    }
    ancillaryMergeCalls += 1;
    return { status: 99, stdout: '', stderr: 'prepared fast path must not pre-remux ancillary streams' };
};

async function main() {
    process.env.NODE_ENV = 'test';
    process.env.VMAF_POSTENCODE_TEST_UNPINNED_STORAGE = '1';
    process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT = checkpointRoot;
    process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT = reuseRequiredRoot;
    process.env.TDARR_NVENCC = nvenccPath;
    process.env.TDARR_NVENCC_COORDINATOR = coordinatorPath;
    const logs = [];
    const args = {
        inputFileObj: {
            _id: sourcePath,
            file_size: fs.statSync(sourcePath).size / (1024 * 1024),
            ffProbeData: {
                format: { duration: '10', format_name: 'matroska,webm' },
                streams: [
                    {
                        index: 0, codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080,
                        pix_fmt: 'yuv420p10le', avg_frame_rate: '24/1',
                        r_frame_rate: '24/1', disposition: { attached_pic: 0 },
                    },
                    { index: 1, codec_type: 'audio' },
                ],
            },
        },
        inputs: {}, workDir, ffmpegPath, ffprobePath: 'ffprobe',
        variables: {
            grainAnalysisStatus: 'prepared',
            vmafBestParameters: {
                id: 'gpu_p7_cq28', encoder: 'av1_nvenc', preset: 'p7', quality: 28,
                isGPU: true, pixFmt: 'yuv420p10le',
            },
            vmafFinalSelectedCQ: 28,
            vmafSelectedParameterSetId: 'gpu_p7_cq28',
            vmafReferenceContractId: canonicalDenoise.REFERENCE_CONTRACT_ID,
            vmafCanonicalDenoiseActive: true,
            vmafNvencTemporalPolicy: nvencTemporalFilter.CANONICAL_POLICY,
            color_primaries: 'bt709', color_trc: 'bt709', colorspace: 'bt709',
        },
        jobLog(message) { logs.push(String(message)); },
    };

    const result = await plugin(args);
    assert.strictEqual(result.outputNumber, 1, logs.join('\n'));
    assert.strictEqual(encodeCalls, 1);
    assert.strictEqual(fullDecodeCalls, 3,
        'routine checkpoint validation must sample three distributed decode windows');
    assert.strictEqual(ancillaryMergeCalls, 0,
        'prepared grain path must defer the only ancillary remux until after grain application');
    assert.strictEqual(args.variables.vmafAncillaryRemuxDeferred, true);
    assert.strictEqual(args.variables.vmafAncillaryPreservationMethod, 'deferred-to-grain-synthesis-v1');
    assert.strictEqual(args.variables.vmafDeferredGrainBase.exactly_one_video_only_stream, true);
    assert.match(args.variables.vmafDeferredGrainBase.sha256_full, /^[0-9a-f]{64}$/);
    assert.strictEqual(path.resolve(args.variables.vmafDeferredGrainBase.path),
        path.resolve(result.outputFileObj._id));
    assert.strictEqual(fs.existsSync(args.variables.vmafPostEncodeCheckpointPath), true);
    assert.strictEqual(fs.existsSync(result.outputFileObj._id), true);
    assert(logs.some((line) => line.includes('ancillary remux is deferred until after grain application')));
    assert(!logs.some((line) => line.includes('preserving original Matroska ancillary payloads')));

    // Any policy bypass after deferral must retain the source instead of sending a
    // video-only file to Replace Original File.
    const synthesis = require('./custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js')._test;
    const originalObject = { _id: sourcePath };
    const bypassArgs = {
        inputFileObj: { _id: result.outputFileObj._id },
        originalLibraryFile: originalObject,
        variables: { vmafAncillaryRemuxDeferred: true },
        jobLog() {},
    };
    const guarded = synthesis.makeResult(bypassArgs, 3, bypassArgs.inputFileObj, 'ineligible', {
        grainSynthesisReason: 'injected_policy_bypass',
    });
    assert.strictEqual(guarded.outputNumber, 4);
    assert.strictEqual(guarded.outputFileObj, originalObject);
    assert.strictEqual(guarded.variables.grainSynthesisStatus, 'failed');
    assert.match(guarded.variables.grainSynthesisReason, /deferred_video_only_base_cannot_bypass/);

    const workingProbe = {
        format: { format_name: 'matroska,webm', duration: '10' },
        streams: [{
            index: 0, codec_type: 'video', codec_name: 'av1', width: 1920, height: 1080,
            disposition: { attached_pic: 0 },
        }],
    };
    assert.doesNotThrow(() => synthesis.validateDeferredGrainBaseContract(
        args, sourcePath, result.outputFileObj._id, workingProbe));
    const materializedSize = fs.statSync(result.outputFileObj._id).size;
    fs.writeFileSync(result.outputFileObj._id, Buffer.alloc(materializedSize, 0x7e));
    assert.throws(() => synthesis.validateDeferredGrainBaseContract(
        args, sourcePath, result.outputFileObj._id, workingProbe),
    /SHA-256 changed after checkpoint materialization/,
    'same-size substitution of a different healthy-looking AV1 must fail the authenticated handoff');

    console.log('PASS prepared-grain checkpoint fast path defers sole ancillary remux and guards bypass');
}

main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
}).finally(() => {
    childProcess.spawnSync = originalSpawnSync;
    Module._load = originalLoad;
    delete process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT;
    delete process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT;
    delete process.env.TDARR_NVENCC;
    delete process.env.TDARR_NVENCC_COORDINATOR;
    delete process.env.VMAF_POSTENCODE_TEST_UNPINNED_STORAGE;
    delete process.env.NODE_ENV;
    fs.rmSync(scratch, { recursive: true, force: true });
});
