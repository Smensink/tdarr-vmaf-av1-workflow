'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const checkpoint = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/postEncodeCheckpoint.js');
const replacementAttestation = require(
    './custom-cont-init.d/vmaf-plugin-patches/_lib/postReplaceAttestation.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-postencode-cleanup-'));
const workDir = path.join(scratch, 'tdarr-workDir-job');
const root = path.join(scratch, 'protected');
const source = path.join(scratch, 'source.mkv');
fs.mkdirSync(workDir);
fs.writeFileSync(source, Buffer.alloc(100, 0x51));

const plan = checkpoint.buildPlan({
    workDir,
    checkpointRoot: root,
    sourceFingerprint: {
        scheme: 'sha256-sampled-v1', sha256: 'a'.repeat(64), size_bytes: 100,
        mtime_ns: 1782744454000000000, sample_bytes: 100, sample_offsets: [0], resolved_path: source,
    },
    encodeContract: {
        schema: 1, executable: 'ffmpeg', argv: ['-i', '<SOURCE>', '-c:v', 'av1', '<OUTPUT>'],
    },
    extension: '.mkv',
    validateArtifact(filePath) { return { size: fs.statSync(filePath).size, valid: true }; },
});
fs.writeFileSync(plan.encodePath, Buffer.alloc(4096, 0x52));
checkpoint.commit(plan, (filePath) => ({ size: fs.statSync(filePath).size, valid: true }));

const record = {
    schema: checkpoint.SCHEMA,
    contract_id: checkpoint.CONTRACT_ID,
    checkpoint_key: plan.checkpointKey,
    artifact_path: plan.artifactPath,
    manifest_path: plan.manifestPath,
};

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
    if (request === '../../../../../methods/lib') {
        return function () { return { loadDefaultValues(inputs) { return inputs || {}; } }; };
    }
    return originalLoad.call(this, request, parent, isMain);
};
const cleanup = require('./custom-cont-init.d/vmaf-plugin-patches/cleanupTempFiles/1.0.0/index.js').plugin;

function runCleanup(variables) {
    const logs = [];
    const result = cleanup({
        inputFileObj: { _id: source }, inputs: {}, variables, workDir,
        jobLog(message) { logs.push(String(message)); },
    });
    return { result, logs };
}

try {
    const failedVariables = {
        vmafOriginalFile: source,
        vmafPostEncodeCheckpoint: record,
        vmafTranscodeSucceeded: false,
        vmafTranscodeStatus: 'technical_failure',
        grainSynthesisStatus: 'failed',
    };
    const retained = runCleanup(failedVariables);
    assert.strictEqual(fs.existsSync(plan.artifactPath), true,
        'technical/grain failure cleanup must retain the reusable completed encode');
    assert.strictEqual(failedVariables.vmafPostEncodeCheckpointRetired, false);
    assert(retained.logs.some((line) =>
        line.includes('Retaining protected post-encode checkpoint')));

    const preReplacementVariables = {
        vmafOriginalFile: source,
        vmafPostEncodeCheckpoint: record,
        vmafTranscodeSucceeded: true,
        vmafTranscodeStatus: 'success',
        grainSynthesisStatus: 'size_rejected',
    };
    const preReplacementRetained = runCleanup(preReplacementVariables);
    assert.strictEqual(fs.existsSync(plan.artifactPath), true,
        'pre-replacement success variables alone must not retire the reusable checkpoint');
    assert.strictEqual(preReplacementVariables.vmafPostEncodeCheckpointRetired, false);
    assert.strictEqual(preReplacementVariables.vmafReplacementAttestationVerified, false);
    assert(preReplacementRetained.logs.some((line) =>
        line.includes('no delivery boundary exists')));

    const attestedOnlyVariables = {
        vmafOriginalFile: source,
        vmafPostEncodeCheckpoint: record,
        vmafReplacementAttestation: replacementAttestation.create({
            targetPath: source,
            originalPath: source,
            checkpointKey: record.checkpoint_key,
            backupRetained: false,
        }),
    };
    const attestedOnlyRetained = runCleanup(attestedOnlyVariables);
    assert.strictEqual(fs.existsSync(plan.artifactPath), true,
        'replacement attestation without DB-finalized delivery must retain the checkpoint');
    assert.strictEqual(attestedOnlyVariables.vmafReplacementAttestationVerified, false);
    assert.strictEqual(attestedOnlyVariables.vmafDeliveryFinalizationVerified, false);
    assert.strictEqual(attestedOnlyVariables.vmafPostEncodeCheckpointRetired, false);
    assert(attestedOnlyRetained.logs.some((line) =>
        line.includes('no delivery boundary exists')));

    const flowEvidenceOnly = {
        vmafOriginalFile: source,
        vmafPostEncodeCheckpoint: record,
        vmafTranscodeSucceeded: true,
        vmafTranscodeStatus: 'success',
        grainSynthesisStatus: 'active_validated',
        vmafReplacementAttestation: attestedOnlyVariables.vmafReplacementAttestation,
        vmafDeliveryFinalization: {
            schema: 'vmaf-delivery-finalization/v2',
            version: 2,
            status: 'delivered',
            database_recorded: true,
        },
    };
    const flowOnlyResult = runCleanup(flowEvidenceOnly);
    assert.strictEqual(fs.existsSync(plan.artifactPath), true,
        'flow evidence alone must never authorize checkpoint retirement');
    assert.strictEqual(flowEvidenceOnly.vmafPostEncodeCheckpointRetired, false);
    assert(flowOnlyResult.logs.some((line) =>
        line.includes('no delivery boundary exists')));

    console.log(
        'PASS checkpoint cleanup retains payload without durable journal/tombstone/DB authority');
} finally {
    Module._load = originalLoad;
    fs.rmSync(scratch, { recursive: true, force: true });
}
