'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const checkpoint = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/postEncodeCheckpoint.js');
const grainArtifact = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/grainAnalysisArtifact.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-file-age-recovery-'));
const checkpointRoot = path.join(scratch, 'checkpoints');
const reuseRequiredRoot = path.join(scratch, 'reuse-required');
const sourcePath = path.join(scratch, 'source.ts');
const artifactBytes = Buffer.alloc(32768, 0x42);
fs.mkdirSync(checkpointRoot);
fs.writeFileSync(sourcePath, Buffer.alloc(65536, 0x41));
checkpoint.initializeReuseRequiredRoot(reuseRequiredRoot);

function sha256Text(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function sha256Bytes(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const sourceFingerprint = grainArtifact.sampledSourceFingerprint(sourcePath);
const encodeContract = {
    schema: 1,
    executable: 'tdarr-ffmpeg',
    argv: ['-i', '<SOURCE>', '-c:v', 'av1_nvenc', '-y', '<OUTPUT>'],
};
const encodeContractSha256 = sha256Text(checkpoint.canonicalJson(encodeContract));
const checkpointKey = sha256Text(checkpoint.canonicalJson({
    contract_id: checkpoint.CONTRACT_ID,
    source_fingerprint: sourceFingerprint,
    encode_contract_sha256: encodeContractSha256,
}));
const sourceScopeKey = sha256Text(checkpoint.canonicalJson({
    contract_id: checkpoint.REUSE_REQUIRED_CONTRACT_ID,
    source_fingerprint: sourceFingerprint,
}));
const checkpointEntry = path.join(checkpointRoot, checkpointKey.slice(0, 2), checkpointKey);
const markerBucket = path.join(reuseRequiredRoot, sourceScopeKey.slice(0, 2));
const artifactName = 'source.postencode.mkv';
const artifactPath = path.join(checkpointEntry, artifactName);
const markerPath = path.join(markerBucket, `${sourceScopeKey}.json`);
fs.mkdirSync(checkpointEntry, { recursive: true });
fs.mkdirSync(markerBucket, { recursive: true });
fs.writeFileSync(artifactPath, artifactBytes);

const manifest = {
    schema: checkpoint.SCHEMA,
    contract_id: checkpoint.CONTRACT_ID,
    checkpoint_key: checkpointKey,
    source_fingerprint: sourceFingerprint,
    encode_contract_sha256: encodeContractSha256,
    encode_contract: encodeContract,
    artifact: {
        relative_path: artifactName,
        size_bytes: artifactBytes.length,
        sha256_full: sha256Bytes(artifactBytes),
    },
    media_validation: {
        validator: 'ffprobe-demux-plus-full-decode-v1',
        full_primary_video_decode: true,
        ordinary_video_streams: 1,
        stream_count: 1,
        size_bytes: artifactBytes.length,
        primary: {
            codec_name: 'av1', width: 1920, height: 1080,
            packet_count: 240, pix_fmt: 'yuv420p10le', avg_frame_rate: '24/1',
        },
    },
    committed_at: new Date().toISOString(),
};
const marker = {
    schema: checkpoint.REUSE_REQUIRED_SCHEMA,
    contract_id: checkpoint.REUSE_REQUIRED_CONTRACT_ID,
    state: 'reuse_required',
    source_scope_key: sourceScopeKey,
    source_fingerprint: sourceFingerprint,
    checkpoint_key: checkpointKey,
    encode_contract_sha256: encodeContractSha256,
    source: { sha256_full: checkpoint.sha256FileSync(sourcePath) },
    artifact: {
        size_bytes: artifactBytes.length,
        sha256_full: sha256Bytes(artifactBytes),
    },
    created_by: 'retained-output-import-v1',
    created_at: new Date().toISOString(),
};
writeJson(path.join(checkpointEntry, 'manifest.json'), manifest);
writeJson(markerPath, marker);

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
    if (request === '../../../../../methods/lib') {
        return function tdarrLib() {
            return { loadDefaultValues(inputs) { return inputs || {}; } };
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};

const agePlugin = require('./custom-cont-init.d/filter-plugin-patches/checkFileAge/1.0.0/index.js').plugin;

function argsFor(filePath, ageDays) {
    const logs = [];
    const timestamp = Date.now() - (ageDays * 24 * 60 * 60 * 1000);
    return {
        inputs: { minAgeDays: 7, dateType: 'creation' },
        variables: {},
        inputFileObj: { _id: filePath },
        originalLibraryFile: {
            statSync: { birthtimeMs: timestamp, ctimeMs: timestamp, mtimeMs: timestamp },
        },
        jobLog(message) { logs.push(String(message)); },
        _logs: logs,
    };
}

function expectTooYoung(args, description) {
    assert.throws(() => agePlugin(args), /File is too young/, description);
    assert.strictEqual(args.variables.vmafRetainedRecoveryAgeBypass, undefined, description);
}

try {
    process.env.NODE_ENV = 'test';
    process.env.VMAF_POSTENCODE_TEST_UNPINNED_STORAGE = '1';
    process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT = checkpointRoot;
    process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT = reuseRequiredRoot;

    const oldEnough = argsFor(path.join(scratch, 'ordinary-old.ts'), 8);
    const oldResult = agePlugin(oldEnough);
    assert.strictEqual(oldResult.outputNumber, 1, 'an old-enough ordinary file did not pass');
    assert.strictEqual(oldEnough.variables.vmafRetainedRecoveryAgeBypass, undefined,
        'ordinary age success was mislabeled as recovery');

    const ordinaryYoungPath = path.join(scratch, 'ordinary-young.ts');
    fs.writeFileSync(ordinaryYoungPath, Buffer.alloc(4096, 0x11));
    const ordinaryYoung = argsFor(ordinaryYoungPath, 0.1);
    expectTooYoung(ordinaryYoung, 'an unlatched young file bypassed the age gate');

    const validRecovery = argsFor(sourcePath, 0.1);
    const validResult = agePlugin(validRecovery);
    assert.strictEqual(validResult.outputNumber, 1, 'the exact retained recovery did not pass');
    assert.strictEqual(validRecovery.variables.vmafRetainedRecoveryAgeBypass.checkpoint_key,
        checkpointKey, 'recovery audit did not bind the exact checkpoint key');
    assert(validRecovery._logs.some((line) => line.includes('title encoder remains prohibited')),
        'recovery log did not retain the no-encoder invariant');

    const originalMarker = fs.readFileSync(markerPath, 'utf8');
    const wrongState = JSON.parse(originalMarker);
    wrongState.state = 'complete';
    writeJson(markerPath, wrongState);
    expectTooYoung(argsFor(sourcePath, 0.1), 'a non-active recovery marker bypassed the age gate');
    fs.writeFileSync(markerPath, originalMarker, 'utf8');

    fs.writeFileSync(artifactPath, Buffer.alloc(artifactBytes.length, 0x43));
    expectTooYoung(argsFor(sourcePath, 0.1),
        'same-size checkpoint corruption bypassed full retained-artifact authentication');
    fs.writeFileSync(artifactPath, artifactBytes);

    const originalManifest = fs.readFileSync(path.join(checkpointEntry, 'manifest.json'), 'utf8');
    fs.unlinkSync(path.join(checkpointEntry, 'manifest.json'));
    expectTooYoung(argsFor(sourcePath, 0.1), 'a missing checkpoint manifest bypassed the age gate');
    fs.writeFileSync(path.join(checkpointEntry, 'manifest.json'), originalManifest, 'utf8');

    console.log('PASS file-age retained-recovery contract (normal age gate + exact protected bypass + tamper rejection)');
} finally {
    Module._load = originalLoad;
    delete process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT;
    delete process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT;
    delete process.env.VMAF_POSTENCODE_TEST_UNPINNED_STORAGE;
    delete process.env.NODE_ENV;
    fs.rmSync(scratch, { recursive: true, force: true });
}
