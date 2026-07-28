'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const replacement = require(
    './plugins/vmaf/replaceOriginalFileAttested/1.0.0/index.js');
const validation = require(
    './plugins/vmaf/validateDeliveryCandidate/1.0.0/index.js');
const checkpoint = require(
    './plugins/vmaf/_lib/postEncodeCheckpoint.js');
const deliveryTransaction = require(
    './plugins/vmaf/_lib/deliveryTransaction.js');
const attestation = require(
    './plugins/vmaf/_lib/postReplaceAttestation.js');

const POLICY_VERSION = 'delivered-minimum-reduction-v1';

function checkpointContract() {
    return {
        schema: 1,
        executable: '/usr/local/bin/tdarr-ffmpeg',
        executable_identity: {
            resolved_path: '/usr/local/ffmpeg-custom/bin/ffmpeg',
            size_bytes: 42,
            mtime_ns: 7,
        },
        argv: [
            '-i', '<SOURCE>', '-c:v', 'av1_nvenc',
            '-cq', '28', '-y', '<OUTPUT>',
        ],
    };
}

function validateArtifact(filePath) {
    const size = fs.statSync(filePath).size;
    if (size !== 1024) {
        throw checkpoint.confirmedInvalidError(
            'fixture output has the wrong byte count');
    }
    return {
        validator: 'replacement-phase1-fixture-v1',
        codec: 'av1',
        duration_seconds: 10,
        packets: 240,
        size_bytes: size,
    };
}

function canonicalRow(fixture) {
    return {
        job_id: fixture.jobId,
        file_path: fixture.originalPath,
        transcode_succeeded: null,
        met_vmaf_target: null,
        met_size_target: null,
        final_output_size_mb: null,
        final_output_ratio_pct: null,
        actual_size_reduction_pct: null,
        size_target_status: 'pending_delivery',
        target_size_reduction_pct: 30,
        minimum_size_reduction_pct: 20,
        max_final_output_ratio_pct: 80,
        size_policy_version: POLICY_VERSION,
        outcome_stage: 'candidate_ready',
        delivered_at: null,
        replacement_attestation_version: null,
        replacement_backup_retained: null,
        skip_reason: null,
        delivery_transaction_id: null,
        delivery_checkpoint_key:
            fixture.checkpointRecord.checkpoint_key,
    };
}

class FixtureDb {
    constructor(row, options) {
        this.row = Object.assign({}, row);
        this.options = options || {};
        this.reserveAttempts = 0;
        this.commitAttempts = 0;
        this.failureAttempts = 0;
        this.reads = 0;
    }

    prepare(sql) {
        if (sql === replacement._test.JOB_SELECT) {
            return {
                get: (jobId) => {
                    this.reads += 1;
                    if (this.options.readError) {
                        throw this.options.readError;
                    }
                    if (this.options.failFirstDeliveryReadback &&
                        this.row.outcome_stage === 'delivery_committing' &&
                        !this.failedDeliveryReadback) {
                        this.failedDeliveryReadback = true;
                        throw new Error(
                            'injected post-CAS readback failure');
                    }
                    return this.row && this.row.job_id === jobId
                        ? Object.assign({}, this.row)
                        : undefined;
                },
            };
        }
        if (sql === replacement._test.RESERVE_SQL) {
            return {
                run: (
                    transactionId,
                    _updatedAt,
                    jobId,
                    filePath,
                    checkpointKey,
                    target,
                    minimum,
                    cap,
                    policyVersion,
                ) => {
                    this.reserveAttempts += 1;
                    if (this.options.reserveError) {
                        throw this.options.reserveError;
                    }
                    const matches = this.row.job_id === jobId &&
                        replacement._test.samePath(
                            this.row.file_path, filePath) &&
                        this.row.outcome_stage === 'candidate_ready' &&
                        this.row.delivery_transaction_id === null &&
                        this.row.delivery_checkpoint_key === checkpointKey &&
                        this.row.target_size_reduction_pct === target &&
                        this.row.minimum_size_reduction_pct === minimum &&
                        this.row.max_final_output_ratio_pct === cap &&
                        this.row.size_policy_version === policyVersion;
                    if (!matches) return { changes: 0 };
                    this.row.outcome_stage = 'replacement_committing';
                    this.row.delivery_transaction_id = transactionId;
                    return { changes: 1 };
                },
            };
        }
        if (sql === replacement._test.COMMIT_SQL) {
            return {
                run: (
                    _updatedAt,
                    jobId,
                    filePath,
                    transactionId,
                    checkpointKey,
                    target,
                    minimum,
                    cap,
                    policyVersion,
                ) => {
                    this.commitAttempts += 1;
                    if (this.options.commitError) {
                        throw this.options.commitError;
                    }
                    const matches = this.row.job_id === jobId &&
                        replacement._test.samePath(
                            this.row.file_path, filePath) &&
                        this.row.outcome_stage ===
                            'replacement_committing' &&
                        this.row.delivery_transaction_id ===
                            transactionId &&
                        this.row.delivery_checkpoint_key === checkpointKey &&
                        this.row.target_size_reduction_pct === target &&
                        this.row.minimum_size_reduction_pct === minimum &&
                        this.row.max_final_output_ratio_pct === cap &&
                        this.row.size_policy_version === policyVersion;
                    if (!matches) return { changes: 0 };
                    this.row.outcome_stage = 'delivery_committing';
                    return { changes: 1 };
                },
            };
        }
        if (sql === replacement._test.FAILURE_SQL) {
            return {
                run: (
                    backupRetained,
                    skipReason,
                    _updatedAt,
                    jobId,
                    filePath,
                    transactionId,
                    checkpointKey,
                ) => {
                    this.failureAttempts += 1;
                    if (this.options.failureError) {
                        throw this.options.failureError;
                    }
                    const matches = this.row.job_id === jobId &&
                        replacement._test.samePath(
                            this.row.file_path, filePath) &&
                        this.row.outcome_stage ===
                            'replacement_committing' &&
                        this.row.delivery_transaction_id ===
                            transactionId &&
                        this.row.delivery_checkpoint_key === checkpointKey;
                    if (!matches) return { changes: 0 };
                    Object.assign(this.row, {
                        outcome_stage: 'technical_failure',
                        transcode_succeeded: 0,
                        met_vmaf_target: null,
                        met_size_target: null,
                        final_output_size_mb: null,
                        final_output_ratio_pct: null,
                        actual_size_reduction_pct: null,
                        size_target_status: 'not_delivered',
                        delivered_at: null,
                        replacement_attestation_version: null,
                        replacement_backup_retained: backupRetained,
                        skip_reason: skipReason,
                    });
                    return { changes: 1 };
                },
            };
        }
        throw new Error(`fixture DB received unexpected SQL: ${sql}`);
    }
}

function makeFixture(label, options) {
    options = options || {};
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), `tdarr-replace-phase1-${label}-`));
    const mediaDir = path.join(root, 'media');
    const workDir = path.join(root, 'work');
    const protectedRoot = path.join(root, 'protected-checkpoints');
    fs.mkdirSync(mediaDir);
    fs.mkdirSync(workDir);
    const originalPath = path.resolve(
        path.join(mediaDir, 'title.mkv'));
    const candidatePath = path.resolve(
        path.join(workDir, 'title-candidate.mkv'));
    const originalBytes = Buffer.alloc(1280, 0x31);
    const checkpointCandidateBytes = Buffer.alloc(1024, 0x42);
    const candidateBytes = options.transformedCandidate
        ? Buffer.alloc(1024, 0x43)
        : checkpointCandidateBytes;
    fs.writeFileSync(originalPath, originalBytes);

    const postEncodePlan = checkpoint.buildPlan({
        workDir,
        checkpointRoot: protectedRoot,
        sourceFingerprint: {
            scheme: 'sha256-sampled-v1',
            sha256: checkpoint.sha256FileSync(originalPath),
            size_bytes: originalBytes.length,
            mtime_ns: 1782744454000000000,
            sample_bytes: 1280,
            sample_offsets: [0],
            resolved_path: originalPath,
        },
        encodeContract: checkpointContract(),
        extension: '.mkv',
        validateArtifact,
    });
    fs.writeFileSync(
        postEncodePlan.encodePath, checkpointCandidateBytes);
    checkpoint.commit(postEncodePlan, validateArtifact);
    checkpoint.initializeReuseRequiredRoot(
        postEncodePlan.reuseRequiredRoot);
    checkpoint.materialize(
        postEncodePlan, candidatePath, workDir);
    if (options.transformedCandidate) {
        fs.writeFileSync(candidatePath, candidateBytes);
    }
    const checkpointRecord = {
        schema: checkpoint.SCHEMA,
        contract_id: checkpoint.CONTRACT_ID,
        checkpoint_key: postEncodePlan.checkpointKey,
        artifact_path: postEncodePlan.artifactPath,
        manifest_path: postEncodePlan.manifestPath,
        reuse_required_root: postEncodePlan.reuseRequiredRoot,
        encode_contract_sha256:
            postEncodePlan.encodeContractSha256,
        reused: false,
    };
    checkpoint.authenticateRecord(checkpointRecord);

    const jobId = `canonical-job-${label}`;
    const variables = {
        vmafCanonicalJobId: jobId,
        vmafOriginalFile: originalPath,
        vmafPostEncodeCheckpoint: checkpointRecord,
        vmafSizePolicyVersion: POLICY_VERSION,
        vmafTargetSizeReductionPct: 30,
        vmafMinimumSizeReductionPct: 20,
        vmafMaxFinalOutputRatioPct: 80,
        vmafDeliveryOutcomePending: {
            schema: 'vmaf-delivery-outcome-pending/v1',
            version: 1,
            status: 'candidate_ready',
            recorded_at: new Date().toISOString(),
            database_recorded: true,
            job_id: jobId,
            checkpoint_key: checkpointRecord.checkpoint_key,
            source_path: originalPath,
            size_policy_version: POLICY_VERSION,
            target_size_reduction_pct: 30,
            minimum_size_reduction_pct: 20,
            max_final_output_ratio_pct: 80,
            candidate_output_ratio_pct: 80,
            candidate_output_size_mb:
                candidateBytes.length / (1024 * 1024),
        },
    };
    const logs = [];
    const args = {
        inputFileObj: { _id: candidatePath },
        originalLibraryFile: { _id: originalPath },
        variables,
        workDir,
        jobLog(message) { logs.push(String(message)); },
    };
    validation._test.validate(args);
    const fixture = {
        root,
        mediaDir,
        workDir,
        protectedRoot,
        originalPath,
        candidatePath,
        originalBytes,
        candidateBytes,
        postEncodePlan,
        checkpointRecord,
        jobId,
        variables,
        args,
        logs,
    };
    fixture.db = new FixtureDb(canonicalRow(fixture));
    return fixture;
}

function replacementDependencies(fixture, overrides) {
    return Object.assign({
        db: fixture.db,
        dbDelay: async () => {},
    }, overrides || {});
}

async function expectRejectedWithoutMutation(fixture, pattern, dependencies) {
    await assert.rejects(
        replacement._test.replaceOriginal(
            fixture.args,
            dependencies || replacementDependencies(fixture)),
        pattern,
    );
    assert.deepStrictEqual(
        fs.readFileSync(fixture.originalPath),
        fixture.originalBytes,
        'failed phase 1 must preserve the original bytes',
    );
}

async function prepareReservedCrash(fixture, phase) {
    const proof = replacement._test.requireCanonicalProof(
        fixture.args);
    const bound = replacement._test.inspectAndBindCurrentFiles(
        proof);
    const paths = replacement._test.pathPlan(
        bound.source.path, bound.candidate.path);
    replacement._test.assertFreshMutationPaths(paths);
    const journal = deliveryTransaction.create(
        fixture.checkpointRecord,
        {
            jobId: fixture.jobId,
            pendingProof:
                fixture.variables.vmafDeliveryOutcomePending,
            candidateValidation:
                fixture.variables.vmafDeliveryCandidateValidation,
        },
    );
    await replacement._test.reserveDatabase(
        fixture.db,
        proof,
        journal,
        { dbDelay: async () => {} },
    );
    replacement._test.stageCandidate(
        paths.current, paths.temp, () => {});
    if (phase === 'staged') return { proof, journal, paths };
    replacement._test.exclusiveLinkOrCopy(
        paths.original,
        paths.backup,
        () => {},
        'crash fixture backup',
    );
    if (phase === 'backed_up') return { proof, journal, paths };
    fs.unlinkSync(paths.original);
    replacement._test.fsyncDirectory(
        path.dirname(paths.original));
    if (phase === 'original_unlinked') {
        return { proof, journal, paths };
    }
    replacement._test.exclusiveCopy(
        paths.temp,
        paths.target,
        () => {},
        'crash fixture install',
    );
    return { proof, journal, paths };
}

async function main() {
    const created = [];
    try {
        const success = makeFixture(
            'success-transformed', { transformedCandidate: true });
        created.push(success.root);
        const unrelated = path.join(
            success.mediaDir, 'unrelated.partial.old');
        fs.writeFileSync(unrelated, 'unrelated');
        const result = await replacement._test.replaceOriginal(
            success.args,
            replacementDependencies(success),
        );
        const backupPath = `${success.originalPath}.partial.old`;
        assert.strictEqual(result.outputNumber, 2,
            'phase 1 must route only through backup-retained output 2');
        assert.strictEqual(result.outputFileObj._id, success.originalPath);
        assert.deepStrictEqual(
            fs.readFileSync(success.originalPath),
            success.candidateBytes);
        assert.deepStrictEqual(
            fs.readFileSync(backupPath),
            success.originalBytes);
        assert.strictEqual(fs.existsSync(unrelated), true,
            'replacement must never scan for similarly named backups');
        assert.strictEqual(
            success.variables.vmafReplacementBackupRetained, true);
        assert.strictEqual(
            success.variables.vmafReplacementStatus,
            'backup_retained');
        assert.strictEqual(
            success.variables.vmafReplacementAttestation.version,
            attestation.VERSION);
        const successAttestationValidation = attestation.validate(
            success.variables.vmafReplacementAttestation,
            {
                checkpointRecord: success.checkpointRecord,
                inputPath: success.originalPath,
                originalPath: success.originalPath,
                requireRetainedBackup: true,
            },
        );
        assert.strictEqual(
            successAttestationValidation.valid,
            true,
            successAttestationValidation.reason);
        const successJournal = deliveryTransaction.load(
            success.checkpointRecord);
        assert.strictEqual(
            successJournal.state, 'delivery_committing');
        assert.strictEqual(
            success.db.row.outcome_stage, 'delivery_committing');
        assert.strictEqual(
            success.db.row.delivery_transaction_id,
            successJournal.transaction_id);
        assert.strictEqual(
            success.variables.vmafDeliveryTransactionId,
            successJournal.transaction_id);
        assert.strictEqual(
            success.variables.vmafDeliveryTransactionState,
            'delivery_committing');
        assert.strictEqual(success.db.reserveAttempts, 1);
        assert.strictEqual(success.db.commitAttempts, 1);
        assert.notStrictEqual(
            checkpoint.sha256FileSync(
                success.postEncodePlan.artifactPath),
            checkpoint.sha256FileSync(success.originalPath),
            'a valid grain/reorder/remux transformed candidate must not be ' +
            'forced to equal the authenticated base checkpoint');
        assert.strictEqual(
            fs.existsSync(
                `${success.candidatePath}${replacement._test.STAGE_SUFFIX}`),
            false,
            'successful phase 1 should remove only its authenticated stage');
        assert.deepStrictEqual(
            success.variables.vmafTemporaryFiles,
            [],
            'verified stage unlink must unregister the cleanup path');

        const stageLeak = makeFixture('stage-cleanup-failure');
        created.push(stageLeak.root);
        const stageLeakResult =
            await replacement._test.replaceOriginal(
                stageLeak.args,
                replacementDependencies(stageLeak, {
                    removeStage() {
                        const error =
                            new Error('injected stage unlink failure');
                        error.code = 'EPERM';
                        throw error;
                    },
                }),
            );
        const retainedStage =
            `${stageLeak.candidatePath}${replacement._test.STAGE_SUFFIX}`;
        assert.strictEqual(stageLeakResult.outputNumber, 2);
        assert.strictEqual(fs.existsSync(retainedStage), true);
        assert.ok(stageLeak.variables.vmafTemporaryFiles.some(
            (entry) => replacement._test.samePath(
                entry, retainedStage)),
        'failed stage unlink must remain registered for cleanupTempFiles');
        assert.match(
            stageLeak.variables.vmafReplacementStagingCleanupWarning,
            /injected stage unlink failure/);

        const sameSizeMutation = makeFixture('same-size-mutation');
        created.push(sameSizeMutation.root);
        const mutated = Buffer.from(sameSizeMutation.candidateBytes);
        mutated[mutated.length - 1] ^= 0xff;
        fs.writeFileSync(sameSizeMutation.candidatePath, mutated);
        await expectRejectedWithoutMutation(
            sameSizeMutation,
            /changed after validation|SHA-256|current file identity/,
        );
        assert.strictEqual(sameSizeMutation.db.reserveAttempts, 0,
            'same-size mutation must fail before DB reservation');

        const collision = makeFixture('path-collision');
        created.push(collision.root);
        const collisionStage =
            `${collision.candidatePath}${replacement._test.STAGE_SUFFIX}`;
        fs.writeFileSync(collisionStage, 'pre-existing stage');
        await expectRejectedWithoutMutation(
            collision,
            /staging path already exists|path collision/,
        );
        assert.strictEqual(
            fs.readFileSync(collisionStage, 'utf8'),
            'pre-existing stage');
        assert.strictEqual(collision.db.reserveAttempts, 0);

        const preexistingBackup = makeFixture('preexisting-backup');
        created.push(preexistingBackup.root);
        const preexistingBackupPath =
            `${preexistingBackup.originalPath}.partial.old`;
        fs.writeFileSync(preexistingBackupPath, 'do-not-delete');
        await expectRejectedWithoutMutation(
            preexistingBackup,
            /backup already exists/,
        );
        assert.strictEqual(
            fs.readFileSync(preexistingBackupPath, 'utf8'),
            'do-not-delete',
            'pre-existing .partial.old must never be deleted or overwritten');
        assert.strictEqual(preexistingBackup.db.reserveAttempts, 0);

        const dbFailure = makeFixture('db-failure');
        created.push(dbFailure.root);
        const injectedDbError =
            new Error('injected non-retryable DB write failure');
        dbFailure.db = new FixtureDb(
            canonicalRow(dbFailure),
            { reserveError: injectedDbError },
        );
        await expectRejectedWithoutMutation(
            dbFailure,
            /injected non-retryable DB write failure/,
            replacementDependencies(dbFailure),
        );
        assert.strictEqual(dbFailure.db.reserveAttempts, 1,
            'non-busy DB errors must never be retried');
        assert.strictEqual(
            fs.existsSync(`${dbFailure.originalPath}.partial.old`),
            false);
        assert.strictEqual(deliveryTransaction.load(
            dbFailure.checkpointRecord).state, 'reserved');

        const missingCheckpoint = makeFixture('missing-checkpoint');
        created.push(missingCheckpoint.root);
        delete missingCheckpoint.variables.vmafPostEncodeCheckpoint;
        await expectRejectedWithoutMutation(
            missingCheckpoint,
            /real post-encode checkpoint record/,
        );
        assert.strictEqual(missingCheckpoint.db.reserveAttempts, 0);

        const fakeCheckpoint = makeFixture('fake-checkpoint');
        created.push(fakeCheckpoint.root);
        fakeCheckpoint.variables.vmafPostEncodeCheckpoint =
            Object.assign({}, fakeCheckpoint.checkpointRecord, {
                manifest_path: path.join(
                    fakeCheckpoint.root, 'fake-manifest.json'),
            });
        await expectRejectedWithoutMutation(
            fakeCheckpoint,
            /keyed protected entry|missing|mismatched committed identity/,
        );
        assert.strictEqual(fakeCheckpoint.db.reserveAttempts, 0);

        const rollback = makeFixture('post-backup-rollback');
        created.push(rollback.root);
        await expectRejectedWithoutMutation(
            rollback,
            /injected install failure/,
            replacementDependencies(rollback, {
                installCandidate() {
                    throw new Error('injected install failure');
                },
            }),
        );
        assert.deepStrictEqual(
            fs.readFileSync(`${rollback.originalPath}.partial.old`),
            rollback.originalBytes,
            'post-backup failure must retain the exact original backup');
        assert.strictEqual(
            rollback.db.row.outcome_stage, 'technical_failure');
        assert.strictEqual(
            rollback.db.row.transcode_succeeded, 0);
        assert.strictEqual(
            rollback.db.row.size_target_status, 'not_delivered');
        assert.strictEqual(
            rollback.db.row.replacement_backup_retained, 1);
        assert.strictEqual(rollback.db.failureAttempts, 1);
        assert.strictEqual(
            rollback.variables.vmafReplacementStatus,
            'failed_keep_original');
        assert.strictEqual(
            rollback.variables.vmafReplacementBackupRetained, true);
        const rollbackStage =
            `${rollback.candidatePath}${replacement._test.STAGE_SUFFIX}`;
        assert.strictEqual(fs.existsSync(rollbackStage), true);
        assert.ok(rollback.variables.vmafTemporaryFiles.some(
            (entry) => replacement._test.samePath(
                entry, rollbackStage)),
        'retained authenticated stage must remain registered for cleanup');

        for (const crashPhase of [
            'backed_up',
            'original_unlinked',
            'installed',
        ]) {
            const resumed = makeFixture(`resume-${crashPhase}`);
            created.push(resumed.root);
            await prepareReservedCrash(resumed, crashPhase);
            const resumedResult =
                await replacement._test.replaceOriginal(
                    resumed.args,
                    replacementDependencies(resumed),
                );
            assert.strictEqual(resumedResult.outputNumber, 2);
            assert.deepStrictEqual(
                fs.readFileSync(resumed.originalPath),
                resumed.candidateBytes,
                `${crashPhase} resume must install the exact candidate`);
            assert.deepStrictEqual(
                fs.readFileSync(
                    `${resumed.originalPath}.partial.old`),
                resumed.originalBytes,
                `${crashPhase} resume must retain the exact backup`);
            assert.strictEqual(
                deliveryTransaction.load(
                    resumed.checkpointRecord).state,
                'delivery_committing');
            assert.strictEqual(
                resumed.db.row.outcome_stage,
                'delivery_committing');
        }

        const uncertainReadback =
            makeFixture('post-cas-readback');
        created.push(uncertainReadback.root);
        uncertainReadback.db = new FixtureDb(
            canonicalRow(uncertainReadback),
            { failFirstDeliveryReadback: true },
        );
        await assert.rejects(
            replacement._test.replaceOriginal(
                uncertainReadback.args,
                replacementDependencies(uncertainReadback),
            ),
            /post-CAS readback failure/,
        );
        assert.strictEqual(
            uncertainReadback.db.row.outcome_stage,
            'delivery_committing');
        assert.deepStrictEqual(
            fs.readFileSync(uncertainReadback.originalPath),
            uncertainReadback.candidateBytes,
            'uncertain post-CAS readback must never roll back committed delivery');
        assert.deepStrictEqual(
            fs.readFileSync(
                `${uncertainReadback.originalPath}.partial.old`),
            uncertainReadback.originalBytes);
        assert.strictEqual(
            deliveryTransaction.validate(
                uncertainReadback.checkpointRecord,
                undefined,
                { verifyCurrentFiles: true },
            ).journal.state,
            'installed_pending_finalize');
        const resumedReadback =
            await replacement._test.replaceOriginal(
                uncertainReadback.args,
                replacementDependencies(uncertainReadback),
            );
        assert.strictEqual(resumedReadback.outputNumber, 2);
        assert.strictEqual(
            deliveryTransaction.load(
                uncertainReadback.checkpointRecord).state,
            'delivery_committing');

        assert.throws(() =>
            replacement._test.assertPairwisePathSeparation({
                current: 'C:\\candidate.mkv',
                target: 'C:\\original.mkv',
                temp: 'C:\\candidate.mkv',
                original: 'C:\\original.mkv',
                backup: 'C:\\original.mkv.partial.old',
            }), /path collision/);

        assert.strictEqual(
            fs.readFileSync(
                'plugins/vmaf/replaceOriginalFileAttested/1.0.0/index.js',
                'utf8'),
            fs.readFileSync(
                'custom-cont-init.d/vmaf-plugin-patches/replaceOriginalFileAttested/1.0.0/index.js',
                'utf8'),
            'replacement source and deployment mirror differ',
        );
        console.log(
            'PASS crash-safe replacement phase 1 (real checkpoint, exact proofs, ' +
            'same-size mutation/path/backup/DB failures, rollback, retained backup)');
    } finally {
        for (const directory of created) {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
