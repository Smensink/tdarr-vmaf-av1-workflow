"use strict";

const assert = require('assert');
const plugin = require('./custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js');
const test = plugin._test;

function probe(duration) {
    return {
        streams: [{
            index: 3,
            codec_name: 'av1',
            codec_type: 'video',
            disposition: { attached_pic: 0 },
        }],
        format: { duration: String(duration) },
    };
}

function result(code, stderr) {
    return {
        code,
        signal: null,
        stdout: '',
        stderr: stderr || '',
        timedOut: false,
    };
}

function runnerFrom(responses, calls) {
    return async function (executable, argv, options) {
        calls.push({ executable, argv: argv.slice(), options: Object.assign({}, options) });
        assert(responses.length, 'unexpected decode command');
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
    };
}

(async () => {
    assert.strictEqual(test.gpuDecodeUnavailableBeforePass(result(
        1, 'No device available for decoder: device type cuda needed for codec av1_cuvid')), true);
    assert.strictEqual(test.gpuDecodeUnavailableBeforePass(result(
        1, 'Error while decoding stream #0:3: Invalid data found when processing input')), false);
    assert.strictEqual(test.gpuDecodeUnavailableBeforePass(Object.assign(
        result(1, 'CUDA_ERROR_NO_DEVICE'), { timedOut: true })), false);

    const distributed = test.distributedDecodeSamples(probe(7200));
    assert.strictEqual(distributed.length, 8);
    assert.strictEqual(distributed[0].start_seconds, 0);
    assert.strictEqual(distributed[distributed.length - 1].start_seconds, 7198);
    assert(distributed.every((sample) => sample.duration_seconds <= 2));
    assert(distributed.reduce((total, sample) => total + sample.duration_seconds, 0) <= 16);

    {
        const calls = [];
        const logs = [];
        const validation = await test.validateFinalAv1Decode(
            '/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'active',
                timeoutMs: 600000,
                runner: runnerFrom([], calls),
                log: (message) => logs.push(message),
            });
        assert.strictEqual(validation.mode, 'active_structural_semantic_sampled_v1');
        assert.strictEqual(validation.exhaustive, false);
        assert.strictEqual(validation.sampled, true);
        assert.strictEqual(validation.additional_decode_commands, 0);
        assert.strictEqual(validation.gpu_preflight.attempted, false);
        assert.strictEqual(calls.length, 0);
        assert(logs.some((line) => /no additional full-title decode/.test(line)));
    }

    {
        const calls = [];
        const logs = [];
        const validation = await test.validateFinalAv1Decode(
            '/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'canary',
                timeoutMs: 600000,
                runner: runnerFrom([result(0), result(0)], calls),
                log: (message) => logs.push(message),
            });
        assert.strictEqual(validation.mode, 'canary_nvdec_full_v1');
        assert.strictEqual(validation.exhaustive, true);
        assert.strictEqual(validation.hardware_accelerated, true);
        assert.strictEqual(calls.length, 2);
        assert(calls[0].argv.includes('av1_cuvid'));
        assert(calls[0].argv.includes('-frames:v'));
        assert(calls[1].argv.includes('av1_cuvid'));
        assert(!calls[1].argv.includes('-frames:v'));
        assert(logs.some((line) => /exhaustive GPU NVDEC\/CUVID/.test(line)));
    }

    {
        const calls = [];
        const logs = [];
        const unavailable = result(
            1, 'No device available for decoder: device type cuda needed for codec av1_cuvid');
        const responses = [unavailable].concat(Array(8).fill(null).map(() => result(0)));
        const validation = await test.validateFinalAv1Decode(
            '/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'canary',
                timeoutMs: 600000,
                runner: runnerFrom(responses, calls),
                log: (message) => logs.push(message),
            });
        assert.strictEqual(validation.mode,
            'canary_distributed_software_samples_gpu_unavailable_v1');
        assert.strictEqual(validation.exhaustive, false);
        assert.strictEqual(validation.sampled, true);
        assert.strictEqual(validation.hardware_accelerated, false);
        assert.strictEqual(validation.sample_count, 8);
        assert(validation.sampled_media_seconds <= 16);
        assert.strictEqual(calls.length, 9);
        calls.slice(1).forEach((call) => {
            assert(call.argv.includes('-ss'));
            assert(call.argv.includes('-t'));
            assert(!call.argv.includes('-hwaccel'));
            assert(!call.argv.includes('av1_cuvid'));
        });
        assert(logs.some((line) => /canary\/audit decode validation mode/.test(line)));
    }

    {
        const calls = [];
        await assert.rejects(
            test.validateFinalAv1Decode('/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'canary',
                timeoutMs: 600000,
                runner: runnerFrom([
                    result(0),
                    result(1, 'Error while decoding stream #0:3: Invalid data found'),
                    // This response must remain unused: a started exhaustive GPU
                    // pass is never converted into sampled success.
                    result(0),
                ], calls),
            }),
            /after successful preflight; sampled fallback is forbidden/
        );
        assert.strictEqual(calls.length, 2);
    }

    {
        const calls = [];
        await assert.rejects(
            test.validateFinalAv1Decode('/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'canary',
                timeoutMs: 600000,
                runner: runnerFrom([
                    result(1, 'Error while decoding stream #0:3: Invalid data found'),
                    result(0),
                ], calls),
            }),
            /GPU AV1 decode preflight failed/
        );
        assert.strictEqual(calls.length, 1);
    }

    await assert.rejects(
        test.validateFinalAv1Decode('/ffmpeg', '/output.mkv', {
            streams: [{
                index: 0,
                codec_name: 'hevc',
                codec_type: 'video',
                disposition: { attached_pic: 0 },
            }],
            format: { duration: '100' },
        }, { mode: 'active', runner: async () => result(0) }),
        /requires AV1/
    );

    console.log('PASS grain final validation active fast-path and canary GPU/fallback/fail-closed contract');
})().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
