'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const helper = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/preFgsCambi.js');
const metric = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafMetricContract.js');

(function testCommandDomain() {
    const argv = helper.buildArgs({
        distortedPath: '/temp/candidate.mkv',
        referencePath: '/temp/canonical-denoised.mkv',
        logPath: '/temp/prefgs-cambi.json',
        modelPath: '/usr/local/share/model/vmaf_4k_v0.6.1.json',
        pixelFormat: 'yuv420p',
        nSubsample: 2,
        threads: 8,
    });
    assert(Array.isArray(argv));
    assert.deepStrictEqual(argv.slice(0, 3), ['-hide_banner', '-nostats', '-y']);
    assert(argv.includes('/temp/candidate.mkv'));
    assert(argv.includes('/temp/canonical-denoised.mkv'));
    const graph = argv[argv.indexOf('-filter_complex') + 1];
    assert(graph.includes('format=yuv420p'));
    assert(graph.includes('libvmaf='));
    assert(graph.includes('feature=name=cambi'));
    assert(graph.includes('n_subsample=2'));
    assert(!graph.includes('hwupload'));
    assert(!graph.toLowerCase().includes('tonemap'));
})();

(function testStrictParsingAndAggregation() {
    const parsed = helper.parseLogData({
        frames: [1, 2, 3, 4].map((value) => ({ metrics: { cambi: value } })),
        pooled_metrics: { cambi: { mean: 2.5, max: 4 } },
    });
    assert.deepStrictEqual(parsed, {
        cambiMean: 2.5,
        cambiMax: 4,
        cambiP95: 3,
        frameCount: 4,
    });
    assert.throws(() => helper.parseLogData({ frames: [], pooled_metrics: {} }), /CAMBI/);
    assert.deepStrictEqual(helper.aggregateBaselines([
        { cambiMean: 2, cambiP95: 4, cambiMax: 5 },
        { cambiMean: 4, cambiP95: 6, cambiMax: 7 },
    ]), { cambiMean: 3, cambiP95: 6, cambiMax: 7, sampleCount: 2 });
})();

(function testProductionContractAndWiring() {
    const contract = metric.resolveProductionForVideo(3840, 2160, {
        attestedEncoderProfileId: metric.COMPARISON_ENCODER_PROFILE_ID,
    });
    assert.strictEqual(contract.cambi.required, true);
    assert.strictEqual(contract.cambiPolicy, 'pre-fgs-standalone-cpu');
    assert.strictEqual(contract.cambi.backend, 'cpu');
    assert.strictEqual(contract.cambi.filterName, 'libvmaf');
    assert.strictEqual(contract.cambi.scoringPixelFormat, 'yuv420p');
    assert.match(contract.metricContractId, /prefgs-cambi-cpu-yuv420p8/);

    const calculate = fs.readFileSync(path.join(root,
        'custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js'), 'utf8');
    const select = fs.readFileSync(path.join(root,
        'custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js'), 'utf8');
    const extract = fs.readFileSync(path.join(root,
        'custom-cont-init.d/vmaf-plugin-patches/extractVideoSamples/1.0.0/index.js'), 'utf8');

    assert(calculate.includes("require('../../_lib/preFgsCambi.js')"));
    assert(calculate.includes('measureSourceCambiBaselines'));
    assert(calculate.includes('measurePreFgsCambiAsync'));
    assert(calculate.includes('Pre-FGS CAMBI'));
    assert(select.includes("require('../../_lib/preFgsCambi.js')"));
    assert(select.includes('measureHoldoutPreFgsCambi'));
    assert(select.includes('var sourceCAMBI = finiteMeasuredNumber(args.variables.vmafSourceCAMBI)'));
    assert(!select.includes('CAMBI unavailable under the GPU-only metric contract; CAMBI gates are disabled.'));
    assert(extract.includes('Pre-FGS CAMBI source baseline deferred'));
    assert(!extract.includes('Source CAMBI unavailable under the GPU-only metric contract; baseline fields remain null.'));
})();

console.log('PASS pre-FGS CAMBI contract, parser, command domain, and plugin wiring');
