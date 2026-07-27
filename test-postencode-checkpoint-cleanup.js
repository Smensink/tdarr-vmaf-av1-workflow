'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const checkpoint = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/postEncodeCheckpoint.js');

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
    assert(retained.logs.some((line) => line.includes('Retaining protected post-encode checkpoint')));

    const generatedQuarantine = path.join(plan.entryDir,
        'old.postencode.mkv.invalid-123-456-abcdef123456');
    const lookalike = path.join(plan.entryDir,
        'keep.invalid-123-456-deadbeef');
    const unrelated = path.join(plan.entryDir, 'operator-note.txt');
    fs.writeFileSync(generatedQuarantine, Buffer.alloc(2048, 0x53));
    fs.writeFileSync(lookalike, 'keep');
    fs.writeFileSync(unrelated, 'keep');

    const successVariables = {
        vmafOriginalFile: source,
        vmafPostEncodeCheckpoint: record,
        vmafTranscodeSucceeded: true,
        vmafTranscodeStatus: 'success',
        grainSynthesisStatus: 'active_validated',
    };
    const retired = runCleanup(successVariables);
    assert.strictEqual(fs.existsSync(plan.artifactPath), false,
        'checkpoint must be retired only after successful replacement reaches terminal cleanup');
    assert.strictEqual(successVariables.vmafPostEncodeCheckpointRetired, true);
    assert(retired.logs.some((line) => line.includes('Retired protected post-encode checkpoint')));
    assert.strictEqual(fs.existsSync(generatedQuarantine), false,
        'helper-generated quarantined checkpoint generations must be reclaimed at retirement');
    assert.strictEqual(fs.existsSync(lookalike), true,
        'lookalike files outside the exact quarantine suffix must survive');
    assert.strictEqual(fs.existsSync(unrelated), true,
        'unrelated operator files in the keyed entry must survive');

    const unavailableRoot = path.join(scratch, 'protected-analysis-unavailable');
    const unavailablePlan = checkpoint.buildPlan({
        workDir,
        checkpointRoot: unavailableRoot,
        sourceFingerprint: {
            scheme: 'sha256-sampled-v1', sha256: 'b'.repeat(64), size_bytes: 100,
            mtime_ns: 1782744454000000000, sample_bytes: 100, sample_offsets: [0], resolved_path: source,
        },
        encodeContract: {
            schema: 1, executable: 'ffmpeg', argv: ['-i', '<SOURCE>', '-c:v', 'av1', '<OUTPUT>'],
        },
        extension: '.mkv',
        validateArtifact(filePath) { return { size: fs.statSync(filePath).size, valid: true }; },
    });
    fs.writeFileSync(unavailablePlan.encodePath, Buffer.alloc(4096, 0x54));
    checkpoint.commit(unavailablePlan,
        (filePath) => ({ size: fs.statSync(filePath).size, valid: true }));
    const unavailableVariables = {
        vmafOriginalFile: source,
        vmafPostEncodeCheckpoint: {
            schema: checkpoint.SCHEMA,
            contract_id: checkpoint.CONTRACT_ID,
            checkpoint_key: unavailablePlan.checkpointKey,
            artifact_path: unavailablePlan.artifactPath,
            manifest_path: unavailablePlan.manifestPath,
        },
        vmafTranscodeSucceeded: true,
        vmafTranscodeStatus: 'success',
        grainSynthesisStatus: 'analysis_unavailable',
    };
    const unavailableRetired = runCleanup(unavailableVariables);
    assert.strictEqual(fs.existsSync(unavailablePlan.artifactPath), false,
        'authenticated analysis-unavailable replacement must retire its completed encode checkpoint');
    assert.strictEqual(unavailableVariables.vmafPostEncodeCheckpointRetired, true);
    assert(unavailableRetired.logs.some((line) =>
        line.includes('Retired protected post-encode checkpoint')));

    console.log('PASS post-encode checkpoint cleanup retains failures and retires successful replacement and analysis-unavailable bypass');
} finally {
    Module._load = originalLoad;
    fs.rmSync(scratch, { recursive: true, force: true });
}
