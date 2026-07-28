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

function runnerFrom(responses, calls, events) {
    return async function (executable, argv, options) {
        calls.push({ executable, argv: argv.slice(), options: Object.assign({}, options) });
        if (events) {
            events.push(argv.includes('av1_cuvid')
                ? (argv.includes('-frames:v') ? 'gpu-preflight' : 'gpu-full')
                : 'software');
        }
        assert(responses.length, 'unexpected decode command');
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
    };
}

function recordingLease(events, overrides) {
    const expected = {
        token: 'decode-token',
        leaseGeneration: 'decode-generation',
        lockDir: '/temp/tdarr-vmaf-gpu-pipeline.lock',
        borrowed: false,
    };
    const options = overrides || {};
    return {
        acquire: async () => {
            events.push('acquire');
            if (options.acquireError) throw options.acquireError;
            return Object.assign({}, expected);
        },
        release: async (lease) => {
            assert.deepStrictEqual(lease, expected,
                'GPU lease release did not receive the exact acquired identity');
            events.push('release');
            if (options.releaseError) throw options.releaseError;
        },
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
        const events = [];
        const validation = await test.validateFinalAv1Decode(
            '/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'canary',
                timeoutMs: 600000,
                runner: runnerFrom([result(0), result(0)], calls, events),
                gpuLease: recordingLease(events),
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
        assert.deepStrictEqual(events, ['acquire', 'gpu-preflight', 'gpu-full', 'release']);
        assert(logs.some((line) => /exhaustive GPU NVDEC\/CUVID/.test(line)));
    }

    {
        const calls = [];
        const logs = [];
        const events = [];
        const unavailable = result(
            1, 'No device available for decoder: device type cuda needed for codec av1_cuvid');
        const responses = [unavailable].concat(Array(8).fill(null).map(() => result(0)));
        const validation = await test.validateFinalAv1Decode(
            '/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'canary',
                timeoutMs: 600000,
                runner: runnerFrom(responses, calls, events),
                gpuLease: recordingLease(events),
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
        assert.deepStrictEqual(events.slice(0, 4),
            ['acquire', 'gpu-preflight', 'release', 'software'],
            'software fallback began before the internal GPU lease was released');
        assert(logs.some((line) => /canary\/audit decode validation mode/.test(line)));
    }

    {
        const calls = [];
        const events = [];
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
                ], calls, events),
                gpuLease: recordingLease(events),
            }),
            /after successful preflight; sampled fallback is forbidden/
        );
        assert.strictEqual(calls.length, 2);
        assert.deepStrictEqual(events, ['acquire', 'gpu-preflight', 'gpu-full', 'release']);
    }

    {
        const calls = [];
        const events = [];
        await assert.rejects(
            test.validateFinalAv1Decode('/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'canary',
                timeoutMs: 600000,
                runner: runnerFrom([
                    result(1, 'Error while decoding stream #0:3: Invalid data found'),
                    result(0),
                ], calls, events),
                gpuLease: recordingLease(events),
            }),
            /GPU AV1 decode preflight failed/
        );
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(events, ['acquire', 'gpu-preflight', 'release']);
    }

    {
        const calls = [];
        const events = [];
        const validation = await test.validateFinalAv1Decode(
            '/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'direct-active',
                requireFullTitle: true,
                timeoutMs: 600000,
                runner: runnerFrom([result(0), result(0)], calls, events),
                gpuLease: recordingLease(events),
            });
        assert.strictEqual(validation.mode, 'direct-active_nvdec_full_v1');
        assert.strictEqual(validation.exhaustive, true);
        assert.strictEqual(validation.sampled, false);
        assert.strictEqual(validation.additional_decode_commands, 2);
        assert.strictEqual(calls.length, 2);
        assert(calls[0].argv.includes('-frames:v'));
        assert(!calls[1].argv.includes('-frames:v'));
        assert.deepStrictEqual(events, ['acquire', 'gpu-preflight', 'gpu-full', 'release']);
    }

    {
        const calls = [];
        const logs = [];
        const events = [];
        const unavailable = result(
            1, 'No device available for decoder: device type cuda needed for codec av1_cuvid');
        const validation = await test.validateFinalAv1Decode(
            '/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'direct-active',
                requireFullTitle: true,
                timeoutMs: 600000,
                runner: runnerFrom([unavailable, result(0)], calls, events),
                gpuLease: recordingLease(events),
                log: (message) => logs.push(message),
            });
        assert.strictEqual(validation.mode,
            'direct-active_software_full_gpu_unavailable_v1');
        assert.strictEqual(validation.exhaustive, true);
        assert.strictEqual(validation.sampled, false);
        assert.strictEqual(calls.length, 2);
        assert(!calls[1].argv.includes('-ss'));
        assert(!calls[1].argv.includes('-t'));
        assert(!calls[1].argv.includes('-hwaccel'));
        assert.deepStrictEqual(calls[1].argv, test.softwareFullDecodeArgs('/output.mkv', 3));
        assert.deepStrictEqual(events,
            ['acquire', 'gpu-preflight', 'release', 'software'],
            'full-title software fallback ran while the internal GPU lease was held');
        assert(logs.some((line) => /mandatory full-title validation/.test(line)));
    }

    {
        const calls = [];
        const events = [];
        const unavailable = result(
            1, 'No device available for decoder: device type cuda needed for codec av1_cuvid');
        await assert.rejects(
            test.validateFinalAv1Decode('/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'direct-active',
                requireFullTitle: true,
                timeoutMs: 600000,
                runner: runnerFrom([
                    unavailable,
                    result(1, 'Error while decoding stream #0:3: Invalid data found'),
                ], calls, events),
                gpuLease: recordingLease(events),
            }),
            /mandatory full-title software AV1 decode after grain bitstream rewrite failed/
        );
        assert.strictEqual(calls.length, 2);
        assert.deepStrictEqual(events,
            ['acquire', 'gpu-preflight', 'release', 'software']);
    }

    {
        const calls = [];
        const events = [];
        const unavailable = result(
            1, 'No device available for decoder: device type cuda needed for codec av1_cuvid');
        await assert.rejects(
            test.validateFinalAv1Decode('/ffmpeg', '/output.mkv', probe(7200), {
                mode: 'direct-active',
                requireFullTitle: true,
                timeoutMs: 600000,
                runner: runnerFrom([unavailable, result(0)], calls, events),
                gpuLease: recordingLease(events, {
                    releaseError: new Error('injected exact release failure'),
                }),
            }),
            /GPU decode lease release failed closed: injected exact release failure/
        );
        assert.strictEqual(calls.length, 1,
            'software fallback ran after the GPU lease release failed');
        assert.deepStrictEqual(events, ['acquire', 'gpu-preflight', 'release']);
    }

    {
        const exactOwner = {
            token: 'fresh-token',
            leaseGeneration: 'fresh-generation',
            lockDir: '/temp/tdarr-vmaf-gpu-pipeline.lock',
        };
        const releaseCalls = [];
        const fakeLock = {
            resolveLockDir: (lockDir) => lockDir,
            readOwner: () => exactOwner,
            acquire: async (options) => {
                assert.strictEqual(options.lockDir, exactOwner.lockDir);
                assert.strictEqual(options.existingToken, null);
                return { acquired: true, reentrant: false, owner: exactOwner };
            },
            release: (lockDir, token, options) => {
                releaseCalls.push({ lockDir, token, options });
                return { released: true, owner: exactOwner };
            },
        };
        const controller = test.createGpuDecodeLeaseController({
            inputFileObj: { file: '/media/fixture.mkv' },
            variables: {},
            jobLog: () => {},
        }, fakeLock);
        const lease = await controller.acquire();
        await controller.release(lease);
        assert.deepStrictEqual(releaseCalls, [{
            lockDir: exactOwner.lockDir,
            token: exactOwner.token,
            options: { force: false, expectedGeneration: exactOwner.leaseGeneration },
        }], 'fresh internal lease was not released by exact token and generation');
    }

    {
        const exactOwner = {
            token: 'flow-token',
            leaseGeneration: 'flow-generation',
            lockDir: '/temp/tdarr-vmaf-gpu-pipeline.lock',
        };
        const physicalReleaseCalls = [];
        const variables = {
            vmafGpuPipelineLockAcquired: true,
            vmafGpuPipelineLock: {
                lockDir: exactOwner.lockDir,
                token: exactOwner.token,
                leaseGeneration: exactOwner.leaseGeneration,
            },
        };
        const fakeLock = {
            resolveLockDir: (lockDir) => lockDir,
            readOwner: () => exactOwner,
            acquire: async (options) => {
                assert.strictEqual(options.existingToken, exactOwner.token);
                return { acquired: true, reentrant: true, owner: exactOwner };
            },
            release: (lockDir, token, options) => {
                physicalReleaseCalls.push({ lockDir, token, options });
                return { released: true, owner: exactOwner };
            },
        };
        const controller = test.createGpuDecodeLeaseController({
            inputFileObj: { file: '/media/fixture.mkv' },
            variables,
            jobLog: () => {},
        }, fakeLock);
        const lease = await controller.acquire();
        assert.strictEqual(lease.borrowed, true);
        await controller.release(lease);
        assert.deepStrictEqual(physicalReleaseCalls, [{
            lockDir: exactOwner.lockDir,
            token: exactOwner.token,
            options: { force: false, expectedGeneration: exactOwner.leaseGeneration },
        }], 'reentrant lease was not released by exact token and generation');
        assert.strictEqual(variables.vmafGpuPipelineLockAcquired, false);
        assert.strictEqual(variables.vmafGpuPipelineLockReleased, true);
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

    console.log('PASS grain final validation fast-path, canary, and mandatory direct full-title fail-closed contract');
})().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
