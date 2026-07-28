'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const checkpoint =
    require('./plugins/vmaf/_lib/postEncodeCheckpoint.js');
const deliveryFinalization =
    require('./plugins/vmaf/_lib/deliveryFinalization.js');
const deliveryPolicy =
    require('./plugins/vmaf/_lib/deliveryPolicy.js');
const deliveryTransaction =
    require('./plugins/vmaf/_lib/deliveryTransaction.js');
const postReplaceAttestation =
    require('./plugins/vmaf/_lib/postReplaceAttestation.js');
const cleanupTest =
    require('./plugins/vmaf/cleanupTempFiles/1.0.0/index.js')._test;

function sha256File(filePath) {
    return crypto.createHash('sha256')
        .update(fs.readFileSync(filePath)).digest('hex');
}

function identity(filePath) {
    const resolved = path.resolve(filePath);
    const stat = fs.lstatSync(resolved, { bigint: true });
    return {
        path: resolved,
        size_bytes: Number(stat.size),
        dev: String(stat.dev),
        ino: String(stat.ino),
        mtime_ms: Math.trunc(Number(stat.mtimeMs)),
        ctime_ms: Math.trunc(Number(stat.ctimeMs)),
        mtime_ns: String(stat.mtimeNs),
        ctime_ns: String(stat.ctimeNs),
    };
}

function makeDeliveredFixture(label, options) {
    options = options || {};
    const root = fs.mkdtempSync(path.join(
        os.tmpdir(), `tdarr-delivery-retirement-${label}-`));
    const workDir = path.join(root, 'work');
    const checkpointRoot = path.join(root, 'protected');
    const mediaDir = path.join(root, 'media');
    fs.mkdirSync(workDir);
    fs.mkdirSync(mediaDir);
    const sourcePath = path.join(mediaDir, 'title.mkv');
    fs.writeFileSync(sourcePath, Buffer.alloc(1000, 0x31));
    const sourceSha256 = sha256File(sourcePath);
    const validateArtifact = (filePath) => {
        const size = fs.statSync(filePath).size;
        if (size !== 700) throw new Error('fixture candidate size changed');
        return { validator: 'retirement-fixture-v1', size_bytes: size };
    };
    const planOptions = {
        workDir,
        checkpointRoot,
        sourceFingerprint: {
            scheme: 'sha256-sampled-v1',
            sha256: '1'.repeat(64),
            size_bytes: 1000,
            mtime_ns: 1782744454000000000,
            sample_bytes: 128,
            sample_offsets: [0, 436, 872],
            resolved_path: sourcePath,
        },
        encodeContract: {
            schema: 1,
            executable: '/usr/local/bin/tdarr-ffmpeg',
            argv: [
                '-i', '<SOURCE>', '-c:v', 'av1_nvenc', '-cq', '28',
                '-y', '<OUTPUT>',
            ],
        },
        extension: '.mkv',
        validateArtifact,
    };
    const plan = checkpoint.buildPlan(planOptions);
    fs.writeFileSync(plan.encodePath, Buffer.alloc(700, 0x42));
    checkpoint.commit(plan, validateArtifact);
    const candidatePath = path.join(workDir, 'candidate.mkv');
    checkpoint.materialize(plan, candidatePath, workDir);
    let reuseMarkerPath = null;
    if (options.reuseMarker) {
        const reused = checkpoint.buildPlan(planOptions);
        assert.strictEqual(reused.reused, true);
        reuseMarkerPath = checkpoint.createReuseRequired(reused, {
            sha256_full: sourceSha256,
        }).markerPath;
        assert.strictEqual(fs.existsSync(reuseMarkerPath), true);
    }
    const sidePath = path.join(
        plan.entryDir,
        'retired.postencode.mkv.invalid-123-456-abcdef123456');
    const operatorPath = path.join(plan.entryDir, 'operator-note.txt');
    if (options.sideFile) {
        fs.writeFileSync(sidePath, Buffer.alloc(113, 0x4a));
    }
    fs.writeFileSync(operatorPath, 'must survive retirement');
    const record = {
        schema: checkpoint.SCHEMA,
        contract_id: checkpoint.CONTRACT_ID,
        checkpoint_key: plan.checkpointKey,
        artifact_path: plan.artifactPath,
        manifest_path: plan.manifestPath,
    };
    const jobId = `job-${label}`;
    const pendingProof = {
        schema: deliveryTransaction.PENDING_PROOF_SCHEMA,
        version: 1,
        status: 'candidate_ready',
        recorded_at: new Date().toISOString(),
        database_recorded: true,
        source_path: sourcePath,
        size_policy_version: deliveryPolicy.POLICY_VERSION,
        target_size_reduction_pct: 30,
        minimum_size_reduction_pct: 20,
        max_final_output_ratio_pct: 80,
        candidate_output_ratio_pct: 70,
        candidate_output_size_mb: 700 / (1024 * 1024),
        job_id: jobId,
        checkpoint_key: plan.checkpointKey,
    };
    const candidateValidation = {
        schema: deliveryTransaction.CANDIDATE_VALIDATION_SCHEMA,
        status: 'accepted',
        validated_at: new Date().toISOString(),
        policy_version: deliveryPolicy.POLICY_VERSION,
        target_size_reduction_pct: 30,
        minimum_size_reduction_pct: 20,
        max_final_output_ratio_pct: 80,
        output_ratio_pct: 70,
        actual_size_reduction_pct: 30,
        source: identity(sourcePath),
        candidate: identity(candidatePath),
        job_id: jobId,
        checkpoint_key: plan.checkpointKey,
        candidate_ready_schema:
            deliveryTransaction.PENDING_PROOF_SCHEMA,
    };
    const reserved = deliveryTransaction.create(record, {
        jobId,
        pendingProof,
        candidateValidation,
    });
    const backupPath =
        postReplaceAttestation.exactBackupPath(sourcePath);
    fs.renameSync(sourcePath, backupPath);
    fs.renameSync(candidatePath, sourcePath);
    const replacement = postReplaceAttestation.create({
        targetPath: sourcePath,
        originalPath: sourcePath,
        checkpointKey: record.checkpoint_key,
        backupRetained: true,
    });
    deliveryTransaction.transition(
        record, 'reserved', 'installed_pending_finalize',
        { replacementAttestation: replacement });
    deliveryTransaction.transition(
        record, 'installed_pending_finalize', 'delivery_committing');
    const evidence = deliveryFinalization.create({
        policy: deliveryPolicy.resolve({}),
        installedPath: sourcePath,
        sourceSizeBytes: 1000,
        deliveredAt: new Date().toISOString(),
        jobId,
        transactionId: reserved.transaction_id,
        candidateValidationSchema:
            deliveryTransaction.CANDIDATE_VALIDATION_SCHEMA,
        replacementAttestation: replacement,
        backupDisposition: 'backup_retained',
        checkpointRecord: record,
        originalPath: sourcePath,
        databaseRecorded: true,
    });
    const delivered = deliveryTransaction.transition(
        record, 'delivery_committing', 'delivered',
        { deliveryFinalization: evidence });
    const row = {
        job_id: jobId,
        file_path: sourcePath,
        delivery_transaction_id: delivered.transaction_id,
        delivery_checkpoint_key: delivered.checkpoint_key,
        transcode_succeeded: 1,
        met_vmaf_target: 1,
        met_size_target: 1,
        size_target_status: 'met',
        size_policy_version: deliveryPolicy.POLICY_VERSION,
        outcome_stage: 'delivered',
        delivered_at: evidence.delivered_at,
        replacement_attestation_version:
            `${postReplaceAttestation.SCHEMA}/v${postReplaceAttestation.VERSION}`,
        replacement_backup_retained: 1,
        skip_reason: null,
        final_output_size_mb: evidence.final_output_size_mb,
        final_output_ratio_pct: evidence.final_output_ratio_pct,
        actual_size_reduction_pct: evidence.actual_size_reduction_pct,
        target_size_reduction_pct: evidence.target_size_reduction_pct,
        minimum_size_reduction_pct: evidence.minimum_size_reduction_pct,
        max_final_output_ratio_pct: evidence.max_final_output_ratio_pct,
    };
    return {
        root,
        record,
        plan,
        sourcePath,
        backupPath,
        sidePath,
        operatorPath,
        reuseMarkerPath,
        jobId,
        delivered,
        evidence,
        row,
    };
}

function loader(fixture, onLoad) {
    return {
        loadDatabaseRow(jobId) {
            assert.strictEqual(jobId, fixture.jobId);
            if (onLoad) onLoad();
            return fixture.row;
        },
    };
}

function phaseKey(name, details) {
    return name === 'checkpoint_file_removed'
        ? `${name}:${details.kind}`
        : name;
}

function assertRetired(fixture, retirement) {
    const located =
        deliveryTransaction.retirementLocation(fixture.record);
    assert.strictEqual(retirement.retired, true);
    assert.strictEqual(retirement.tombstoneRetained, true);
    assert.strictEqual(fs.existsSync(located.tombstonePath), true);
    assert.strictEqual(fs.existsSync(located.journalPath), false);
    assert.strictEqual(fs.existsSync(fixture.plan.artifactPath), false);
    assert.strictEqual(fs.existsSync(fixture.plan.manifestPath), false);
    assert.strictEqual(fs.existsSync(fixture.sidePath), false);
    if (fixture.reuseMarkerPath) {
        assert.strictEqual(fs.existsSync(fixture.reuseMarkerPath), false);
    }
    assert.strictEqual(fs.existsSync(fixture.operatorPath), true);
    const remaining = fs.readdirSync(located.entryDir).sort();
    assert.deepStrictEqual(remaining, [
        deliveryTransaction.RETIREMENT_FILE_NAME,
        'operator-note.txt',
    ].sort());
    assert.strictEqual(
        deliveryTransaction.retirementIdentity(fixture.record).authority,
        'retirement_tombstone');
}

function retirementDatabase(fixture) {
    return {
        prepare(sql) {
            for (const field of
                deliveryTransaction.RETIREMENT_DATABASE_FIELDS) {
                assert(sql.includes(field));
            }
            return {
                get(jobId) {
                    assert.strictEqual(jobId, fixture.jobId);
                    return fixture.row;
                },
            };
        },
    };
}

function mutateJson(filePath, mutation) {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    mutation(value);
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
    const roots = [];
    try {
        const crashPhases = [
            'tombstone_created',
            'journal_removed',
            'checkpoint_file_removed:artifact',
            'checkpoint_file_removed:manifest',
            'checkpoint_file_removed:side_file',
            'checkpoint_file_removed:reuse_marker',
            'retirement_complete',
        ];
        for (const targetPhase of crashPhases) {
            const fixture = makeDeliveredFixture(
                `crash-${targetPhase.replace(/[^a-z]+/g, '-')}`,
                { sideFile: true, reuseMarker: true });
            roots.push(fixture.root);
            let loads = 0;
            assert.throws(() => deliveryTransaction.retire(
                fixture.record, loader(fixture, () => { loads += 1; }), {
                    afterPhase(name, details) {
                        if (phaseKey(name, details) === targetPhase) {
                            throw new Error(
                                `injected crash after ${targetPhase}`);
                        }
                    },
                }), new RegExp(`injected crash after ${targetPhase}`));
            const located =
                deliveryTransaction.retirementLocation(fixture.record);
            assert.strictEqual(fs.existsSync(located.tombstonePath), true,
                `tombstone must precede the injected ${targetPhase} crash`);
            const retried = deliveryTransaction.retire(
                fixture.record, loader(fixture, () => { loads += 1; }));
            assert(loads >= 2,
                'every retry must independently reload the immutable DB row');
            assertRetired(fixture, retried);
            assertRetired(fixture, deliveryTransaction.retire(
                fixture.record, loader(fixture)));
        }

        const cleanupFixture = makeDeliveredFixture(
            'cleanup-api', { sideFile: true });
        roots.push(cleanupFixture.root);
        assertRetired(cleanupFixture,
            cleanupTest.retireDeliveredCheckpoint(
                cleanupFixture.record,
                retirementDatabase(cleanupFixture)));

        const wrongDatabase = makeDeliveredFixture('wrong-db');
        roots.push(wrongDatabase.root);
        const wrongRow = {
            ...wrongDatabase.row,
            delivery_transaction_id: 'f'.repeat(64),
        };
        assert.throws(() => deliveryTransaction.retire(
            wrongDatabase.record, {
                loadDatabaseRow() { return wrongRow; },
            }), /DB mismatch|database/);
        assert.strictEqual(
            fs.existsSync(wrongDatabase.plan.artifactPath), true);
        assert.strictEqual(
            fs.existsSync(deliveryTransaction.retirementLocation(
                wrongDatabase.record).tombstonePath), false);

        const driftedDatabase = makeDeliveredFixture('db-drift');
        roots.push(driftedDatabase.root);
        assert.throws(() => deliveryTransaction.retire(
            driftedDatabase.record, loader(driftedDatabase), {
                afterPhase(name) {
                    if (name === 'tombstone_created') {
                        throw new Error('stop after authority');
                    }
                },
            }), /stop after authority/);
        driftedDatabase.row = {
            ...driftedDatabase.row,
            final_output_ratio_pct:
                driftedDatabase.row.final_output_ratio_pct + 0.25,
        };
        assert.throws(() => deliveryTransaction.retire(
            driftedDatabase.record, loader(driftedDatabase)),
        /DB mismatch|database/);
        assert.strictEqual(
            fs.existsSync(driftedDatabase.plan.artifactPath), true);

        const tamperedTombstone = makeDeliveredFixture('tombstone-tamper');
        roots.push(tamperedTombstone.root);
        assert.throws(() => deliveryTransaction.retire(
            tamperedTombstone.record, loader(tamperedTombstone), {
                afterPhase(name) {
                    if (name === 'tombstone_created') {
                        throw new Error('stop after tombstone');
                    }
                },
            }), /stop after tombstone/);
        const tamperedLocation = deliveryTransaction.retirementLocation(
            tamperedTombstone.record);
        mutateJson(tamperedLocation.tombstonePath, (value) => {
            value.transaction_id = 'e'.repeat(64);
        });
        assert.throws(() => deliveryTransaction.retire(
            tamperedTombstone.record, loader(tamperedTombstone)),
        /identity|digest|differs/);
        assert.strictEqual(
            fs.existsSync(tamperedTombstone.plan.artifactPath), true);

        const namespace = makeDeliveredFixture('namespace');
        roots.push(namespace.root);
        const namespaceLocation =
            deliveryTransaction.retirementLocation(namespace.record);
        fs.writeFileSync(path.join(
            namespaceLocation.entryDir,
            `${deliveryTransaction.RETIREMENT_FILE_NAME}.shadow`), 'poison');
        assert.throws(() => deliveryTransaction.retire(
            namespace.record, loader(namespace)),
        /unexpected entry/);
        assert.strictEqual(fs.existsSync(namespace.plan.artifactPath), true);

        const artifactTamper = makeDeliveredFixture('artifact-tamper');
        roots.push(artifactTamper.root);
        assert.throws(() => deliveryTransaction.retire(
            artifactTamper.record, loader(artifactTamper), {
                afterPhase(name) {
                    if (name === 'tombstone_created') {
                        throw new Error('stop before checkpoint deletion');
                    }
                },
            }), /stop before checkpoint deletion/);
        fs.writeFileSync(
            artifactTamper.plan.artifactPath, Buffer.alloc(700, 0x7f));
        assert.throws(() => deliveryTransaction.retire(
            artifactTamper.record, loader(artifactTamper)),
        /inventory|differs|checkpoint bytes/);
        assert.strictEqual(
            fs.existsSync(artifactTamper.plan.manifestPath), true);

        const installedTamper = makeDeliveredFixture('installed-tamper');
        roots.push(installedTamper.root);
        assert.throws(() => deliveryTransaction.retire(
            installedTamper.record, loader(installedTamper), {
                afterPhase(name) {
                    if (name === 'tombstone_created') {
                        throw new Error('stop before installed tamper');
                    }
                },
            }), /stop before installed tamper/);
        fs.writeFileSync(
            installedTamper.sourcePath, Buffer.alloc(700, 0x6e));
        assert.throws(() => deliveryTransaction.retire(
            installedTamper.record, loader(installedTamper)),
        /installed|identity|SHA/);
        assert.strictEqual(
            fs.existsSync(installedTamper.plan.artifactPath), true);

        const wrongCheckpoint = makeDeliveredFixture('wrong-checkpoint');
        roots.push(wrongCheckpoint.root);
        assert.throws(() => deliveryTransaction.retire({
            ...wrongCheckpoint.record,
            checkpoint_key: 'd'.repeat(64),
        }, loader(wrongCheckpoint)), /keyed protected entry|checkpoint/);
        assert.throws(() => deliveryTransaction.retire({
            ...wrongCheckpoint.record,
            artifact_path: path.join(
                path.dirname(wrongCheckpoint.record.artifact_path),
                'wrong.postencode.mkv'),
        }, loader(wrongCheckpoint)), /mismatched|missing|artifact/);
        assert.strictEqual(
            fs.existsSync(wrongCheckpoint.plan.artifactPath), true);

        for (const relative of [
            'plugins/vmaf/_lib/deliveryTransaction.js',
            'plugins/vmaf/_lib/postEncodeCheckpoint.js',
            'plugins/vmaf/cleanupTempFiles/1.0.0/index.js',
        ]) {
            const mirror = relative.replace(
                'plugins/vmaf/',
                'custom-cont-init.d/vmaf-plugin-patches/');
            assert.strictEqual(
                fs.readFileSync(relative, 'utf8'),
                fs.readFileSync(mirror, 'utf8'),
                `${relative} mirror must be byte-identical`);
        }
        console.log(
            'PASS crash-resumable delivery retirement tombstone (all phases, exact DB/finalization revalidation, tamper/path/hash rejection, permanent recovery authority)');
    } finally {
        for (const root of roots) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
}

main();
