'use strict';

const assert = require('assert');
const analyze = require(
    './plugins/vmaf/analyzeFilmGrain/1.0.0/index.js')._test;

function fakeLock(options) {
    const calls = [];
    return {
        calls,
        resolveLockDir(value) {
            calls.push(['resolve', value]);
            return '/temp/tdarr-vmaf-gpu-pipeline.lock';
        },
        async acquire(input) {
            calls.push(['acquire', input]);
            if (options && options.acquireError) {
                throw options.acquireError;
            }
            return {
                reentrant: Boolean(options && options.reentrant),
                owner: {
                    token: 'owned-token',
                    leaseGeneration: 'owned-generation',
                },
            };
        },
        release(lockDir, token, input) {
            calls.push(['release', lockDir, token, input]);
            return options && options.releaseResult ||
                { released: true };
        },
    };
}

async function main() {
    const args = {
        variables: {},
        jobLog() {},
    };
    const normal = fakeLock();
    assert.strictEqual(await analyze.withAnalysisGpuLease(
        args, '/media/source.mkv', async () => 'completed', normal),
    'completed');
    assert.strictEqual(
        normal.calls.filter((entry) => entry[0] === 'acquire').length, 1);
    assert.strictEqual(
        normal.calls.filter((entry) => entry[0] === 'release').length, 1);
    const owner = normal.calls.find(
        (entry) => entry[0] === 'acquire')[1].owner;
    assert(!JSON.stringify(owner).includes('/media/source.mkv'),
        'lease owner metadata must not publish the media path');

    const reentrant = fakeLock({ reentrant: true });
    assert.strictEqual(await analyze.withAnalysisGpuLease({
        variables: {
            vmafGpuPipelineLockAcquired: true,
            vmafGpuPipelineLock: { token: 'flow-token' },
        },
        jobLog() {},
    }, '/media/source.mkv', async () => 'reused', reentrant), 'reused');
    assert.strictEqual(
        reentrant.calls.filter((entry) => entry[0] === 'release').length, 0,
        'a reentrant flow-owned lease must not be released by analysis');
    assert.strictEqual(
        reentrant.calls.find(
            (entry) => entry[0] === 'acquire')[1].existingToken,
        'flow-token');

    const operationFailure = new Error('operation failed');
    const failureLock = fakeLock();
    await assert.rejects(
        analyze.withAnalysisGpuLease(
            args,
            '/media/source.mkv',
            async () => { throw operationFailure; },
            failureLock),
        (error) => error === operationFailure);
    assert.strictEqual(
        failureLock.calls.filter((entry) => entry[0] === 'release').length, 1);

    const releaseLock = fakeLock({
        releaseResult: { released: false, reason: 'identity changed' },
    });
    await assert.rejects(
        analyze.withAnalysisGpuLease(
            args, '/media/source.mkv', async () => 'done', releaseLock),
        /lease release failed: identity changed/);

    let operationStarted = false;
    const acquireFailure = new Error('busy');
    await assert.rejects(
        analyze.withAnalysisGpuLease(
            args,
            '/media/source.mkv',
            async () => {
                operationStarted = true;
            },
            fakeLock({ acquireError: acquireFailure })),
        (error) => error === acquireFailure);
    assert.strictEqual(operationStarted, false);

    const plugin = require(
        './plugins/vmaf/analyzeFilmGrain/1.0.0/index.js');
    const mirror = require(
        './custom-cont-init.d/vmaf-plugin-patches/' +
        'analyzeFilmGrain/1.0.0/index.js');
    assert.strictEqual(
        require('fs').readFileSync(require.resolve(
            './plugins/vmaf/analyzeFilmGrain/1.0.0/index.js'), 'utf8'),
        require('fs').readFileSync(require.resolve(
            './custom-cont-init.d/vmaf-plugin-patches/' +
            'analyzeFilmGrain/1.0.0/index.js'), 'utf8'));
    assert(plugin._test.withAnalysisGpuLease);
    assert(mirror._test.withAnalysisGpuLease);
    console.log('PASS grain analysis heavy GPU work uses an owned or reentrant pipeline lease');
}

main().catch((error) => {
    console.error(error && error.stack || error);
    process.exitCode = 1;
});
