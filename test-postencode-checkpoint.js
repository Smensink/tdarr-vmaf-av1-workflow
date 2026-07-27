'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const checkpoint = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/postEncodeCheckpoint.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-postencode-checkpoint-'));
const workDir = path.join(scratch, 'tdarr-workDir-job-1');
const protectedRoot = path.join(scratch, '.protected-checkpoints');
fs.mkdirSync(workDir);

function fingerprint(overrides) {
    return Object.assign({
        scheme: 'sha256-sampled-v1',
        sha256: '1'.repeat(64),
        size_bytes: 16000,
        mtime_ns: 1782744454000000000,
        sample_bytes: 1024,
        sample_offsets: [0, 7488, 14976],
        resolved_path: path.join(scratch, 'source.mkv'),
    }, overrides || {});
}

function contract(cq) {
    return {
        schema: 1,
        executable: '/usr/local/bin/tdarr-ffmpeg',
        executable_identity: { resolved_path: '/usr/local/ffmpeg-custom/bin/ffmpeg', size_bytes: 42, mtime_ns: 7 },
        argv: ['-i', '<SOURCE>', '-c:v', 'av1_nvenc', '-cq', String(cq), '-y', '<OUTPUT>'],
    };
}

function validator(filePath) {
    const stat = fs.statSync(filePath);
    if (stat.size !== 8192) {
        throw checkpoint.confirmedInvalidError('technical media validation rejected incomplete output');
    }
    return {
        validator: 'fixture-demux-v1',
        codec: 'av1',
        duration_seconds: 10,
        packets: 240,
        size_bytes: stat.size,
    };
}

function plan(options) {
    return checkpoint.buildPlan(Object.assign({
        workDir,
        checkpointRoot: protectedRoot,
        sourceFingerprint: fingerprint(),
        encodeContract: contract(28),
        extension: '.mkv',
        validateArtifact: validator,
    }, options || {}));
}

try {
    const first = plan();
    assert.strictEqual(first.reused, false);
    assert.strictEqual(fs.existsSync(first.manifestPath), false);
    assert.ok(!checkpoint.resolveCheckpointRoot(workDir, protectedRoot).startsWith(`${workDir}${path.sep}`),
        'protected checkpoint root must sit outside disposable job workDir');

    // A killed/incomplete encoder never creates a manifest and therefore can never be reused.
    fs.writeFileSync(first.encodePath, Buffer.alloc(1024, 0x10));
    assert.throws(() => checkpoint.commit(first, validator), /incomplete output/);
    checkpoint.abandon(first);
    assert.strictEqual(fs.existsSync(first.manifestPath), false);

    // FFmpeg has exited 0, but the validation tool times out. The authenticated
    // candidate must survive and a fresh plan must finalize it without encoding.
    const transient = plan({ encodeContract: contract(27) });
    fs.writeFileSync(transient.encodePath, Buffer.alloc(8192, 0x21));
    assert.throws(() => checkpoint.commit(transient, () => {
        throw new Error('injected transient validator timeout');
    }), (error) => checkpoint.isRetryableValidationError(error));
    assert.strictEqual(fs.existsSync(transient.candidatePath), true);
    assert.strictEqual(fs.existsSync(transient.candidateManifestPath), true);
    assert.strictEqual(fs.existsSync(transient.encodePath), false);
    const transientRecovered = plan({ encodeContract: contract(27) });
    assert.strictEqual(transientRecovered.reused, true,
        'fresh job must finalize a retained exit-0 candidate without another encode');
    assert.strictEqual(fs.existsSync(transientRecovered.artifactPath), true);

    // Simulate the process dying immediately after the exit-0 identity marker is
    // fsynced but before the first full artifact hash starts.
    const crashBoundary = plan({ encodeContract: contract(26) });
    fs.writeFileSync(crashBoundary.encodePath, Buffer.alloc(8192, 0x20));
    checkpoint.recordExitZeroCandidate(crashBoundary);
    const crashMarker = JSON.parse(fs.readFileSync(
        crashBoundary.candidatePendingManifestPath, 'utf8'));
    assert.strictEqual(crashMarker.state, 'ffmpeg_exit_0_hash_pending');
    assert.strictEqual(crashMarker.artifact.sha256_full, undefined);
    const crashRecovered = plan({ encodeContract: contract(26) });
    assert.strictEqual(crashRecovered.reused, true,
        'fresh job must finish hashing/validation after a crash at the exit-0 boundary');
    assert.strictEqual(fs.existsSync(crashBoundary.encodePath), false);
    assert.strictEqual(fs.existsSync(crashRecovered.artifactPath), true);

    const completed = plan();
    fs.writeFileSync(completed.encodePath, Buffer.alloc(8192, 0x22));
    checkpoint.commit(completed, validator);
    assert.strictEqual(fs.existsSync(completed.artifactPath), true);
    assert.strictEqual(fs.existsSync(completed.manifestPath), true);
    assert.strictEqual(fs.existsSync(completed.encodePath), false);
    assert.strictEqual(completed.manifest.artifact.sha256_full,
        checkpoint.sha256FileSync(completed.artifactPath));

    const reused = plan();
    assert.strictEqual(reused.reused, true, 'same source and exact command must reuse completed AV1');
    assert.strictEqual(reused.artifactPath, completed.artifactPath);

    const materialized = path.join(workDir, 'source_vmaf_optimized.mkv');
    checkpoint.materialize(reused, materialized, workDir);
    assert.strictEqual(checkpoint.sha256FileSync(materialized),
        checkpoint.sha256FileSync(reused.artifactPath));

    const changedSource = plan({
        sourceFingerprint: fingerprint({ sha256: '2'.repeat(64) }),
    });
    assert.strictEqual(changedSource.reused, false);
    assert.notStrictEqual(changedSource.checkpointKey, reused.checkpointKey,
        'source content fingerprint must participate in checkpoint identity');

    const changedCommand = plan({ encodeContract: contract(29) });
    assert.strictEqual(changedCommand.reused, false);
    assert.notStrictEqual(changedCommand.checkpointKey, reused.checkpointKey,
        'exact encode command must participate in checkpoint identity');

    // Recovery is atomic: artifact + fsynced pending manifest can be promoted after a crash.
    fs.renameSync(reused.manifestPath, reused.pendingManifestPath);
    const recovered = plan();
    assert.strictEqual(recovered.reused, true);
    assert.strictEqual(fs.existsSync(recovered.manifestPath), true);
    assert.strictEqual(fs.existsSync(recovered.pendingManifestPath), false);

    // Mutation/corruption invalidates the cache. It is never silently accepted or reused.
    fs.appendFileSync(recovered.artifactPath, Buffer.from('tamper'));
    const corrupted = plan();
    assert.strictEqual(corrupted.reused, false);
    assert.match(corrupted.invalidReason, /size does not match|SHA-256/);
    assert.strictEqual(fs.existsSync(recovered.artifactPath), false,
        'confirmed corruption must be quarantined before a replacement encode');

    assert.throws(() => checkpoint.materialize(recovered,
        path.join(scratch, 'outside-job.mkv'), workDir), /job-owned path/);

    assert.throws(() => checkpoint.retire({
        schema: 1, contract_id: checkpoint.CONTRACT_ID, checkpoint_key: '0'.repeat(64),
        artifact_path: corrupted.artifactPath, manifest_path: corrupted.manifestPath,
    }), /keyed protected entry|mismatched/);
    fs.writeFileSync(corrupted.encodePath, Buffer.alloc(8192, 0x33));
    checkpoint.commit(corrupted, validator);
    const retired = checkpoint.retire({
        schema: 1,
        contract_id: checkpoint.CONTRACT_ID,
        checkpoint_key: corrupted.checkpointKey,
        artifact_path: corrupted.artifactPath,
        manifest_path: corrupted.manifestPath,
    });
    assert.strictEqual(retired.retired, true);
    assert.strictEqual(fs.existsSync(corrupted.artifactPath), false);
    assert.strictEqual(fs.existsSync(corrupted.manifestPath), false);

    console.log('PASS protected post-encode checkpoint (atomic commit/recovery, exact reuse, corruption rejection, safe retirement)');
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
