'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const contract = require('./vmafMetricContract.js');

let passed = 0;

function test(name, callback) {
    callback();
    passed += 1;
    console.log('PASS ' + name);
}

test('standard video selects the standard v0 CUDA8 contract', function () {
    const resolved = contract.resolveProductionForVideo(1920, 1080);
    assert.strictEqual(resolved.metricContractId,
        contract.PRODUCTION_STANDARD_METRIC_CONTRACT_ID);
    assert.strictEqual(resolved.modelName, 'vmaf_v0.6.1');
    assert.strictEqual(resolved.modelPath, '/usr/local/share/model/vmaf_v0.6.1.json');
    assert.strictEqual(resolved.modelSha256,
        '5950d61fa1f861bd45d8149d80539ed9f3376cfc2495b8f0fa8e9f57cb131ee3');
    assert.strictEqual(resolved.backend, 'cuda');
    assert.strictEqual(resolved.filterName, 'libvmaf_cuda');
    assert.strictEqual(resolved.requiresGpu, true);
    assert.strictEqual(resolved.allowCpuFallback, false);
    assert.strictEqual(resolved.scoringBitDepth, 8);
    assert.strictEqual(resolved.scoringPixelFormat, 'yuv420p');
});

test('4K video selects the 4K v0 CUDA8 contract', function () {
    const resolved = contract.resolveProductionForVideo(3840, 2160);
    assert.strictEqual(resolved.metricContractId,
        contract.PRODUCTION_4K_METRIC_CONTRACT_ID);
    assert.strictEqual(resolved.modelName, 'vmaf_4k_v0.6.1');
    assert.strictEqual(resolved.modelPath, '/usr/local/share/model/vmaf_4k_v0.6.1.json');
    assert.strictEqual(resolved.modelSha256,
        '73b187001309703c89d57cf58baab01660bd11e4ea6fac62bc064c5f5da6dac8');
});

test('resolution selection has an exact and stable boundary', function () {
    assert.strictEqual(contract.resolveProductionForVideo(3839, 2159).modelResolutionClass,
        'standard');
    assert.strictEqual(contract.resolveProductionForVideo(3840, 1600).modelResolutionClass,
        '4k');
    assert.strictEqual(contract.resolveProductionForVideo(1600, 2160).modelResolutionClass,
        '4k');
});

test('Tdarr ffProbeData dimensions are accepted', function () {
    const resolved = contract.resolveProduction({
        ffProbeData: {
            streams: [
                { codec_type: 'audio', channels: 6 },
                { codec_type: 'video', width: 1920, height: 1080 },
            ],
        },
    });
    assert.strictEqual(resolved.sourceWidth, 1920);
    assert.strictEqual(resolved.sourceHeight, 1080);
    assert.strictEqual(resolved.modelResolutionClass, 'standard');
});

test('missing or invalid dimensions fail closed', function () {
    assert.throws(function () {
        contract.resolveProduction({});
    }, /positive width and height/);
    assert.throws(function () {
        contract.resolveProductionForVideo(1920, 0);
    }, /positive width and height/);
});

test('pooling and unavailable CAMBI policy are explicit', function () {
    const resolved = contract.resolveProductionForVideo(1920, 1080);
    assert.strictEqual(resolved.poolingPrimary, 'harmonic_mean');
    assert.strictEqual(resolved.pooling.primary, 'harmonic_mean');
    assert.strictEqual(resolved.cambiPolicy, 'unavailable');
    assert.strictEqual(resolved.cambi.integratedInModel, false);
    assert.strictEqual(resolved.cambi.required, false);
    assert.strictEqual(resolved.cambi.featureName, null);
    assert.strictEqual(resolved.cambi.metricKey, null);
    assert.match(resolved.cambi.reasonCode, /cpu-cambi-disabled-for-speed/);
});

test('encoder identity is stamped only after explicit exact attestation', function () {
    const unattested = contract.resolveProductionForVideo(1920, 1080);
    assert.strictEqual(unattested.encoderProfileId, contract.LEGACY_ENCODER_PROFILE_ID);
    assert.strictEqual(unattested.encoderProfileAttested, false);

    const unknown = contract.resolveProductionForVideo(1920, 1080, {
        attestedEncoderProfileId: 'unknown-profile',
    });
    assert.strictEqual(unknown.encoderProfileId, contract.LEGACY_ENCODER_PROFILE_ID);
    assert.strictEqual(unknown.encoderProfileAttested, false);

    const attested = contract.resolveProductionForVideo(1920, 1080, {
        attestedEncoderProfileId: contract.COMPARISON_ENCODER_PROFILE_ID,
    });
    assert.strictEqual(attested.encoderProfileId, contract.COMPARISON_ENCODER_PROFILE_ID);
    assert.strictEqual(attested.encoderProfileAttested, true);
});

test('contract IDs and resolved records are immutable', function () {
    assert.strictEqual(contract.PRODUCTION_METRIC_CONTRACT_FAMILY_ID,
        'vmaf-v0.6.1-resolution-selected-libvmaf-cuda-yuv420p8-harmonic-cambi-unavailable-v1');
    assert.strictEqual(contract.LEGACY_METRIC_CONTRACT_ID,
        'vmaf-v0-resolution-selected-legacy-mixed-backend-v1');
    assert.strictEqual(contract.LEGACY_ENCODER_PROFILE_ID,
        'legacy-unattested-mixed-encoder-profile-v1');
    const resolved = contract.resolveProductionForVideo(1920, 1080);
    assert.strictEqual(Object.isFrozen(resolved), true);
    assert.strictEqual(Object.isFrozen(resolved.pooling), true);
    assert.throws(function () {
        resolved.modelName = 'changed';
    }, TypeError);
});

test('model verifier accepts the expected bytes and path override', function () {
    const bytes = Buffer.from('known model fixture', 'utf8');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    let observedPath = null;
    const descriptor = {
        name: 'fixture',
        path: '/default/model.json',
        sha256: digest,
    };
    const result = contract.assertModelFile(descriptor, {
        modelPath: '/override/model.json',
        fs: {
            readFileSync: function (modelPath) {
                observedPath = modelPath;
                return bytes;
            },
        },
    });
    assert.strictEqual(observedPath, '/override/model.json');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.reason, 'verified');
});

test('model verifier reports missing and mismatched models distinctly', function () {
    const descriptor = {
        name: 'fixture',
        path: '/model.json',
        sha256: '0'.repeat(64),
    };
    const mismatch = contract.verifyModelFile(descriptor, {
        fs: { readFileSync: function () { return Buffer.from('wrong'); } },
    });
    assert.strictEqual(mismatch.ok, false);
    assert.strictEqual(mismatch.reason, 'sha256-mismatch');
    assert.throws(function () {
        contract.assertModelFile(descriptor, {
            fs: { readFileSync: function () { return Buffer.from('wrong'); } },
        });
    }, function (error) {
        return error.code === 'VMAF_MODEL_SHA256_MISMATCH';
    });

    const missing = contract.verifyModelFile(descriptor, {
        fs: {
            readFileSync: function () {
                const error = new Error('missing');
                error.code = 'ENOENT';
                throw error;
            },
        },
    });
    assert.strictEqual(missing.reason, 'model-not-readable');
    assert.strictEqual(missing.errorCode, 'ENOENT');
    assert.throws(function () {
        contract.assertModelFile(descriptor, {
            fs: {
                readFileSync: function () {
                    const error = new Error('missing');
                    error.code = 'ENOENT';
                    throw error;
                },
            },
        });
    }, function (error) {
        return error.code === 'VMAF_MODEL_NOT_READABLE';
    });
});

test('checked-in production model artifacts match the pinned hashes when present', function () {
    const modelDirectory = path.resolve(__dirname, '../../../custom-vmaf-models');
    const descriptors = [
        contract.PRODUCTION_MODELS.standard,
        contract.PRODUCTION_MODELS.fourK,
    ];
    descriptors.forEach(function (descriptor) {
        const localPath = path.join(modelDirectory, path.basename(descriptor.path));
        if (!fs.existsSync(localPath)) return;
        const result = contract.assertModelFile(descriptor, { modelPath: localPath });
        assert.strictEqual(result.ok, true);
    });
});

test('VMAF v1 CUDA capability is explicit, complete, and not selectable', function () {
    const spec = contract.v1CudaCapabilitySpec();
    assert.strictEqual(Object.isFrozen(spec), true);
    assert.strictEqual(spec.backend, 'cuda');
    assert.strictEqual(spec.filterName, 'libvmaf_cuda');
    assert.strictEqual(spec.scoringBitDepth, 8);
    assert.strictEqual(spec.expectedSupported, false);
    assert.strictEqual(spec.productionEligible, false);
    assert.strictEqual(spec.requiredFeaturesWithoutCompleteCudaSupport.length, 4);
    assert.strictEqual(spec.models.standard.path,
        '/usr/local/share/model/vmaf_v1.0.16/vmaf_v1.0.16_3d0h.json');
    assert.strictEqual(spec.models.fourK.path,
        '/usr/local/share/model/vmaf_v1.0.16/vmaf_v1.0.16_1d5h_2160.json');
    assert.strictEqual(spec.models.hfrStandard.path,
        '/usr/local/share/model/vmaf_v1.0.16_hfr/vmaf_v1.0.16_hfr_3d0h.json');
    assert.strictEqual(spec.models.hfrFourK.path,
        '/usr/local/share/model/vmaf_v1.0.16_hfr/vmaf_v1.0.16_hfr_1d5h_2160.json');

    // Production remains deliberately pinned to v0 even for HFR-looking input.
    const production = contract.resolveProduction({
        width: 3840,
        height: 2160,
        avg_frame_rate: '60000/1001',
    });
    assert.strictEqual(production.modelVersion, 'vmaf_4k_v0.6.1');
    assert.strictEqual(production.modelVersion.indexOf('v1.0.16'), -1);
});

console.log('\nVMAF METRIC CONTRACT: ' + passed + ' passed, 0 failed');
