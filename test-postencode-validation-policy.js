'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-postencode-validation-'));
const artifactPath = path.join(scratch, 'validated.postencode.mkv');
fs.writeFileSync(artifactPath, Buffer.alloc(4096, 0x61));

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
    if (request === '../../../../FlowHelpers/1.0.0/cliUtils') {
        return { CLI: class MockCLI {} };
    }
    if (request === '../../../../../methods/lib') {
        return function () {
            return { loadDefaultValues(inputs) { return inputs || {}; } };
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const pluginModule = require(
    './custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js'
);
const validation = pluginModule._test;
const sourceProbe = {
    format: { duration: '100' },
    streams: [{
        index: 0,
        codec_type: 'video',
        codec_name: 'hevc',
        width: 3840,
        height: 2160,
        avg_frame_rate: '24/1',
        nb_read_packets: '2400',
        disposition: { attached_pic: 0 },
    }],
};

const originalSpawnSync = childProcess.spawnSync;
let calls = [];
let failNextCuda = false;
let corruptNextCuda = false;
let outputDuration = '100';
let outputRate = '24/1';
let outputPackets = '2400';
childProcess.spawnSync = function mockSpawnSync(command, argv) {
    calls.push({ command, argv: argv.slice() });
    if (command === 'ffprobe') {
        assert(argv.includes('-count_packets'),
            'structural validation must count demuxed packets across the output');
        return {
            status: 0,
            stdout: JSON.stringify({
                format: { format_name: 'matroska,webm', duration: outputDuration },
                streams: [{
                    index: 0,
                    codec_type: 'video',
                    codec_name: 'av1',
                    width: 3840,
                    height: 2160,
                    pix_fmt: 'yuv420p10le',
                    avg_frame_rate: outputRate,
                    r_frame_rate: outputRate,
                    nb_read_packets: outputPackets,
                    disposition: { attached_pic: 0 },
                }],
            }),
            stderr: '',
        };
    }
    assert.strictEqual(command, 'ffmpeg');
    const cuda = argv.includes('-hwaccel');
    if (cuda && corruptNextCuda) {
        corruptNextCuda = false;
        return { status: 1, stdout: '', stderr: 'Invalid AV1 OBU while decoding' };
    }
    if (cuda && failNextCuda) {
        failNextCuda = false;
        return { status: 1, stdout: '', stderr: 'Cannot load libcuda.so.1' };
    }
    return { status: 0, stdout: '', stderr: '' };
};

try {
    calls = [];
    const routine = validation.validatePostEncodeMedia(
        'ffprobe', 'ffmpeg', artifactPath, sourceProbe,
        { width: 3840, height: 2160 }, true
    );
    assert.strictEqual(routine.validator, validation.postEncodeRoutineValidator);
    assert.strictEqual(routine.full_primary_video_decode, false);
    assert.deepStrictEqual(routine.decode_policy, {
        mode: 'distributed_samples',
        sample_seconds: 1,
        offsets_seconds: [0, 49.5, 99],
        backends: ['nvdec', 'nvdec', 'nvdec'],
    });
    const routineDecodes = calls.filter((call) => call.command === 'ffmpeg');
    assert.strictEqual(routineDecodes.length, 3);
    routineDecodes.forEach((call) => {
        assert(call.argv.includes('-hwaccel') && call.argv.includes('cuda'));
        assert(call.argv.includes('-t'), 'every routine decode must be duration-bounded');
        assert(call.argv.includes('-ss'), 'every routine decode must use a bounded seek point');
    });

    calls = [];
    const exhaustive = validation.validatePostEncodeMedia(
        'ffprobe', 'ffmpeg', artifactPath, sourceProbe,
        { width: 3840, height: 2160 }, true, { mode: 'exhaustive' }
    );
    assert.strictEqual(exhaustive.validator, validation.postEncodeExhaustiveValidator);
    assert.strictEqual(exhaustive.full_primary_video_decode, true);
    assert.deepStrictEqual(exhaustive.decode_policy, {
        mode: 'exhaustive',
        backend: 'nvdec',
    });
    const exhaustiveDecodes = calls.filter((call) => call.command === 'ffmpeg');
    assert.strictEqual(exhaustiveDecodes.length, 1);
    assert(exhaustiveDecodes[0].argv.includes('-hwaccel'));
    assert.strictEqual(exhaustiveDecodes[0].argv.includes('-t'), false,
        'explicit exhaustive attestation must cover the complete primary video');

    calls = [];
    failNextCuda = true;
    const fallback = validation.validatePostEncodeMedia(
        'ffprobe', 'ffmpeg', artifactPath, sourceProbe,
        { width: 3840, height: 2160 }, true
    );
    assert.strictEqual(fallback.decode_policy.backends[0], 'software');
    const fallbackCalls = calls.filter((call) => call.command === 'ffmpeg');
    assert.strictEqual(fallbackCalls.length, 4,
        'one failed CUDA sample may add one bounded software fallback only');
    assert.strictEqual(fallbackCalls[1].argv.includes('-hwaccel'), false);
    assert(fallbackCalls[1].argv.includes('-t'));

    const sparseSourceProbe = {
        format: { duration: '5206.944' },
        streams: [{
            index: 0,
            codec_type: 'video',
            codec_name: 'hevc',
            width: 3840,
            height: 2160,
            avg_frame_rate: '24000/1001',
            nb_read_packets: '122264',
            disposition: { attached_pic: 0 },
        }],
    };
    outputDuration = '5206.952';
    outputRate = '24000/1001';
    outputPackets = '122252';
    const sparse = validation.validatePostEncodeMedia(
        'ffprobe', 'ffmpeg', artifactPath, sparseSourceProbe,
        { width: 3840, height: 2160 }, true, { mode: 'exhaustive' }
    );
    assert.strictEqual(sparse.primary.source_packet_count, 122264);
    assert.strictEqual(sparse.primary.packet_count_delta, -12,
        'measured sparse/VFR source packet counts must replace nominal fps*duration');

    outputPackets = '122100';
    assert.throws(() => validation.validatePostEncodeMedia(
        'ffprobe', 'ffmpeg', artifactPath, sparseSourceProbe,
        { width: 3840, height: 2160 }, true, { mode: 'exhaustive' }
    ), /packet coverage is incomplete/);
    outputDuration = '100';
    outputRate = '24/1';
    outputPackets = '2400';

    calls = [];
    corruptNextCuda = true;
    assert.throws(() => validation.validatePostEncodeMedia(
        'ffprobe', 'ffmpeg', artifactPath, sourceProbe,
        { width: 3840, height: 2160 }, true
    ), /confirmed corruption/);
    assert.strictEqual(calls.filter((call) => call.command === 'ffmpeg').length, 1,
        'confirmed corruption must fail closed without disguising it as a CUDA fallback');

    console.log('PASS routine post-encode validation uses three bounded GPU samples; ' +
        'exhaustive full decode is explicit and CUDA-first');
} finally {
    childProcess.spawnSync = originalSpawnSync;
    Module._load = originalLoad;
    fs.rmSync(scratch, { recursive: true, force: true });
}
