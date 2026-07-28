'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const checkpoint =
    require('./plugins/vmaf/_lib/postEncodeCheckpoint.js');
const deliveryPolicy =
    require('./plugins/vmaf/_lib/deliveryPolicy.js');
const deliveryFinalization =
    require('./plugins/vmaf/_lib/deliveryFinalization.js');
const deliveryTransaction =
    require('./plugins/vmaf/_lib/deliveryTransaction.js');
const postReplaceAttestation =
    require('./plugins/vmaf/_lib/postReplaceAttestation.js');

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fingerprint(sourcePath) {
    return {
        scheme: 'sha256-sampled-v1',
        sha256: '1'.repeat(64),
        size_bytes: 1000,
        mtime_ns: 1782744454000000000,
        sample_bytes: 128,
        sample_offsets: [0, 436, 872],
        resolved_path: sourcePath,
    };
}

function contract() {
    return {
        schema: 1,
        executable: '/usr/local/bin/tdarr-ffmpeg',
        argv: [
            '-i', '<SOURCE>', '-c:v', 'av1_nvenc', '-cq', '28',
            '-y', '<OUTPUT>',
        ],
    };
}

function validationIdentity(filePath) {
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

function makeFixture(label) {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), `tdarr-delivery-transaction-${label}-`));
    const workDir = path.join(root, 'work');
    const checkpointRoot = path.join(root, 'protected');
    const mediaDir = path.join(root, 'media');
    fs.mkdirSync(workDir);
    fs.mkdirSync(mediaDir);
    const sourcePath = path.join(mediaDir, 'title.mkv');
    fs.writeFileSync(sourcePath, Buffer.alloc(1000, 0x31));
    const validateArtifact = (filePath) => {
        const stat = fs.statSync(filePath);
        if (stat.size !== 700) {
            throw new Error('fixture candidate has the wrong size');
        }
        return { validator: 'fixture-v1', size_bytes: stat.size };
    };
    const plan = checkpoint.buildPlan({
        workDir,
        checkpointRoot,
        sourceFingerprint: fingerprint(sourcePath),
        encodeContract: contract(),
        extension: '.mkv',
        validateArtifact,
    });
    fs.writeFileSync(plan.encodePath, Buffer.alloc(700, 0x42));
    checkpoint.commit(plan, validateArtifact);
    const candidatePath = path.join(workDir, 'title-candidate.mkv');
    checkpoint.materialize(plan, candidatePath, workDir);
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
        size_policy_version: deliveryPolicy.POLICY_VERSION,
        target_size_reduction_pct: 30,
        minimum_size_reduction_pct: 20,
        max_final_output_ratio_pct: 80,
        candidate_output_ratio_pct: 70,
        candidate_output_size_mb: 700 / (1024 * 1024),
        job_id: jobId,
        checkpoint_key: plan.checkpointKey,
        source_path: sourcePath,
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
        source: validationIdentity(sourcePath),
        candidate: validationIdentity(candidatePath),
        job_id: jobId,
        checkpoint_key: plan.checkpointKey,
        candidate_ready_schema:
            deliveryTransaction.PENDING_PROOF_SCHEMA,
    };
    return {
        root,
        workDir,
        sourcePath,
        candidatePath,
        record,
        jobId,
        pendingProof,
        candidateValidation,
    };
}

function reserve(fixture) {
    return deliveryTransaction.create(fixture.record, {
        jobId: fixture.jobId,
        pendingProof: fixture.pendingProof,
        candidateValidation: fixture.candidateValidation,
    });
}

function install(fixture) {
    const backupPath =
        postReplaceAttestation.exactBackupPath(fixture.sourcePath);
    fs.renameSync(fixture.sourcePath, backupPath);
    fs.renameSync(fixture.candidatePath, fixture.sourcePath);
    const replacementAttestation = postReplaceAttestation.create({
        targetPath: fixture.sourcePath,
        originalPath: fixture.sourcePath,
        checkpointKey: fixture.record.checkpoint_key,
        backupRetained: true,
    });
    return replacementAttestation;
}

function finalization(fixture, replacementAttestation) {
    const journal = deliveryTransaction.load(fixture.record);
    return deliveryFinalization.create({
        policy: deliveryPolicy.resolve({}),
        installedPath: fixture.sourcePath,
        sourceSizeBytes: 1000,
        deliveredAt: new Date().toISOString(),
        jobId: fixture.jobId,
        transactionId: journal.transaction_id,
        candidateValidationSchema:
            deliveryTransaction.CANDIDATE_VALIDATION_SCHEMA,
        replacementAttestation,
        backupDisposition: 'backup_retained',
        checkpointRecord: fixture.record,
        originalPath: fixture.sourcePath,
        databaseRecorded: true,
    });
}

function deliveredDatabaseRow(fixture, journal, evidence) {
    return {
        job_id: fixture.jobId,
        file_path: fixture.sourcePath,
        delivery_transaction_id: journal.transaction_id,
        delivery_checkpoint_key: fixture.record.checkpoint_key,
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
}

async function childResult(child) {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
    });
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function runConcurrentTransition(fixture, first, second) {
    const controlDir = path.join(fixture.root, 'concurrency');
    fs.mkdirSync(controlDir);
    const recordPath = path.join(controlDir, 'record.json');
    const firstPath = path.join(controlDir, 'first.json');
    const secondPath = path.join(controlDir, 'second.json');
    const startPath = path.join(controlDir, 'start');
    const readyOne = path.join(controlDir, 'ready-one');
    const readyTwo = path.join(controlDir, 'ready-two');
    fs.writeFileSync(recordPath, JSON.stringify(fixture.record));
    fs.writeFileSync(firstPath, JSON.stringify(first));
    fs.writeFileSync(secondPath, JSON.stringify(second));
    const spawn = (proofPath, readyPath) => childProcess.spawn(
        process.execPath,
        [__filename, '--worker', recordPath, proofPath, startPath, readyPath],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    const one = spawn(firstPath, readyOne);
    const two = spawn(secondPath, readyTwo);
    const deadline = Date.now() + 10000;
    while ((!fs.existsSync(readyOne) || !fs.existsSync(readyTwo)) &&
        Date.now() < deadline) {
        await sleep(10);
    }
    assert(fs.existsSync(readyOne) && fs.existsSync(readyTwo),
        'concurrent transition workers did not reach their barrier');
    fs.writeFileSync(startPath, 'go');
    return Promise.all([childResult(one), childResult(two)]);
}

async function worker() {
    const [, , , recordPath, proofPath, startPath, readyPath] = process.argv;
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    fs.writeFileSync(readyPath, String(process.pid));
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(startPath) && Date.now() < deadline) {
        await sleep(5);
    }
    try {
        const journal = deliveryTransaction.transition(
            record, 'reserved', 'installed_pending_finalize',
            { replacementAttestation: proof });
        process.stdout.write(JSON.stringify({
            ok: true,
            attested_at_ms:
                journal.replacement.evidence.attested_at_ms,
        }));
    } catch (error) {
        process.stderr.write(error.stack || String(error));
        process.exitCode = 2;
    }
}

async function main() {
    const created = [];
    try {
        const normal = makeFixture('normal');
        created.push(normal.root);
        const reserved = reserve(normal);
        assert.strictEqual(reserved.schema, deliveryTransaction.SCHEMA);
        assert.match(reserved.transaction_id, /^[0-9a-f]{64}$/);
        assert.strictEqual(reserved.job_id, normal.jobId);
        assert.strictEqual(
            reserved.checkpoint_key, normal.record.checkpoint_key);
        assert.strictEqual(reserved.state, 'reserved');
        assert.strictEqual(reserved.revision, 1);
        assert.strictEqual(
            deliveryTransaction.load(normal.record).transaction_id,
            reserved.transaction_id,
            'journal must be independently loadable after process-local state is gone');
        assert.strictEqual(
            deliveryTransaction.validate(normal.record).valid, true);
        assert.strictEqual(
            reserve(normal).transaction_id, reserved.transaction_id,
            'reserve retry must read back the existing transaction');
        assert.throws(() => deliveryTransaction.transition(
            normal.record, 'reserved', 'delivery_committing'), /invalid.*transition/);

        const replacement = install(normal);
        const installed = deliveryTransaction.transition(
            normal.record, 'reserved', 'installed_pending_finalize',
            { replacementAttestation: replacement });
        assert.strictEqual(installed.state, 'installed_pending_finalize');
        assert.strictEqual(installed.revision, 2);
        assert.strictEqual(
            installed.replacement.installed.sha256_full,
            reserved.candidate.sha256_full);
        assert.strictEqual(
            installed.replacement.backup.sha256_full,
            reserved.source.sha256_full);
        const committing = deliveryTransaction.transition(
            normal.record, 'installed_pending_finalize',
            'delivery_committing');
        assert.strictEqual(committing.state, 'delivery_committing');
        assert.strictEqual(committing.revision, 3);
        const deliveredEvidence = finalization(normal, replacement);
        const wrongSourceHash =
            JSON.parse(JSON.stringify(deliveredEvidence));
        wrongSourceHash.source_identity.sha256_full = 'f'.repeat(64);
        assert.throws(() => deliveryTransaction.transition(
            normal.record, 'delivery_committing', 'delivered',
            { deliveryFinalization: wrongSourceHash }),
        /source identity|reserved source|size evidence/);
        const wrongSourceSize =
            JSON.parse(JSON.stringify(deliveredEvidence));
        wrongSourceSize.source_identity.size_bytes -= 1;
        assert.throws(() => deliveryTransaction.transition(
            normal.record, 'delivery_committing', 'delivered',
            { deliveryFinalization: wrongSourceSize }),
        /source identity|source byte count|reserved source|size evidence/);
        const wrongInstalledHash =
            JSON.parse(JSON.stringify(deliveredEvidence));
        wrongInstalledHash.installed_identity.sha256_full = 'e'.repeat(64);
        assert.throws(() => deliveryTransaction.transition(
            normal.record, 'delivery_committing', 'delivered',
            { deliveryFinalization: wrongInstalledHash }),
        /installed file|installed delivery candidate/);
        const delivered = deliveryTransaction.transition(
            normal.record, 'delivery_committing', 'delivered',
            { deliveryFinalization: deliveredEvidence });
        assert.strictEqual(delivered.state, 'delivered');
        assert.strictEqual(delivered.revision, 4);
        assert.strictEqual(delivered.transaction_id, reserved.transaction_id);
        assert.strictEqual(delivered.job_id, reserved.job_id);
        assert.strictEqual(delivered.checkpoint_key, reserved.checkpoint_key);
        const deliveredRetry = deliveryTransaction.transition(
            normal.record, 'delivery_committing', 'delivered',
            { deliveryFinalization: deliveredEvidence });
        assert.deepStrictEqual(deliveredRetry, delivered);
        const changedDelivered = JSON.parse(JSON.stringify(deliveredEvidence));
        changedDelivered.delivered_at =
            new Date(Date.now() + 1000).toISOString();
        assert.throws(() => deliveryTransaction.transition(
            normal.record, 'delivery_committing', 'delivered',
            { deliveryFinalization: changedDelivered }),
        /invalid|immutable delivered fields differ/);
        const deliveredRow =
            deliveredDatabaseRow(normal, delivered, deliveredEvidence);
        const wrongDeliveredRow = {
            ...deliveredRow,
            final_output_ratio_pct:
                deliveredRow.final_output_ratio_pct + 1,
        };
        assert.throws(() => deliveryTransaction.retire(
            normal.record,
            { loadDatabaseRow() { return wrongDeliveredRow; } }),
        /database|DB mismatch/);
        const retiredJournal = deliveryTransaction.retire(
            normal.record,
            { loadDatabaseRow() { return deliveredRow; } });
        assert.strictEqual(retiredJournal.retired, true);
        assert.strictEqual(retiredJournal.tombstoneRetained, true);
        assert.strictEqual(
            retiredJournal.transactionId, reserved.transaction_id);
        assert.strictEqual(
            fs.existsSync(deliveryTransaction.retirementLocation(
                normal.record).journalPath),
            false);
        assert.strictEqual(
            fs.existsSync(normal.record.artifact_path), false,
            'retirement must remove the authenticated checkpoint artifact');
        assert.strictEqual(
            fs.existsSync(normal.record.manifest_path), false,
            'retirement must remove the authenticated checkpoint manifest');
        assert.strictEqual(
            fs.existsSync(retiredJournal.tombstonePath), true,
            'retirement must retain its permanent recovery tombstone');
        assert.strictEqual(deliveryTransaction.retire(
            normal.record,
            { loadDatabaseRow() { return deliveredRow; } }).retired,
        true, 'retirement retry must be idempotent from the tombstone');

        const wrongBindings = makeFixture('wrong-bindings');
        created.push(wrongBindings.root);
        const wrongJob = {
            ...wrongBindings.pendingProof,
            job_id: 'different-job',
        };
        assert.throws(() => deliveryTransaction.create(
            wrongBindings.record, {
                jobId: wrongBindings.jobId,
                pendingProof: wrongJob,
                candidateValidation: wrongBindings.candidateValidation,
            }), /schema\/job\/checkpoint/);
        const wrongCheckpoint = {
            ...wrongBindings.candidateValidation,
            checkpoint_key: 'f'.repeat(64),
        };
        assert.throws(() => deliveryTransaction.create(
            wrongBindings.record, {
                jobId: wrongBindings.jobId,
                pendingProof: wrongBindings.pendingProof,
                candidateValidation: wrongCheckpoint,
            }), /schema\/job\/checkpoint/);
        assert.throws(() => deliveryTransaction.load({
            ...wrongBindings.record,
            checkpoint_key: 'e'.repeat(64),
        }), /keyed protected entry|mismatched/);

        const corrupt = makeFixture('corrupt');
        created.push(corrupt.root);
        reserve(corrupt);
        const corruptPath =
            deliveryTransaction.location(corrupt.record).journalPath;
        fs.writeFileSync(corruptPath, '{"schema":');
        assert.throws(
            () => deliveryTransaction.load(corrupt.record), /corrupt JSON/);

        const unexpected = makeFixture('unexpected');
        created.push(unexpected.root);
        reserve(unexpected);
        const unexpectedPath =
            deliveryTransaction.location(unexpected.record).journalPath;
        const unexpectedValue =
            JSON.parse(fs.readFileSync(unexpectedPath, 'utf8'));
        unexpectedValue.surprise = true;
        fs.writeFileSync(
            unexpectedPath, `${JSON.stringify(unexpectedValue)}\n`);
        assert.throws(
            () => deliveryTransaction.load(unexpected.record),
            /unexpected entry surprise/);

        const torn = makeFixture('torn');
        created.push(torn.root);
        reserve(torn);
        const tornLocation = deliveryTransaction.location(torn.record);
        const tornPath = path.join(
            tornLocation.entryDir,
            `${deliveryTransaction.TEMP_PREFIX}torn`);
        fs.writeFileSync(tornPath, '{"partial":');
        assert.throws(
            () => deliveryTransaction.load(torn.record),
            /unexpected entry.*tmp-torn/);
        fs.unlinkSync(tornPath);

        const symlinked = makeFixture('symlinked');
        created.push(symlinked.root);
        reserve(symlinked);
        const symlinkLocation =
            deliveryTransaction.location(symlinked.record);
        const symlinkTarget = path.join(symlinked.root, 'journal-target.json');
        fs.copyFileSync(symlinkLocation.journalPath, symlinkTarget);
        fs.unlinkSync(symlinkLocation.journalPath);
        let symlinkCreated = false;
        try {
            fs.symlinkSync(
                symlinkTarget, symlinkLocation.journalPath, 'file');
            symlinkCreated = true;
        } catch (error) {
            if (!error || !['EPERM', 'EACCES'].includes(error.code)) {
                throw error;
            }
        }
        if (symlinkCreated) {
            assert.throws(
                () => deliveryTransaction.load(symlinked.record),
                /bounded regular file|symlinked path component/);
        }

        const fsyncFault = makeFixture('fsync-fault');
        created.push(fsyncFault.root);
        reserve(fsyncFault);
        const fsyncAttestation = install(fsyncFault);
        const originalFsync = fs.fsyncSync;
        let fsyncCalls = 0;
        fs.fsyncSync = function injectedFsync(handle) {
            fsyncCalls += 1;
            if (fsyncCalls === 3) {
                const error = new Error('injected journal temp fsync failure');
                error.code = 'EIO';
                throw error;
            }
            return originalFsync(handle);
        };
        try {
            assert.throws(() => deliveryTransaction.transition(
                fsyncFault.record, 'reserved',
                'installed_pending_finalize',
                { replacementAttestation: fsyncAttestation }),
            /injected journal temp fsync failure/);
        } finally {
            fs.fsyncSync = originalFsync;
        }
        assert.throws(
            () => deliveryTransaction.load(fsyncFault.record),
            /current reserved source .* changed/,
            'a renamed filesystem with an unadvanced journal must fail closed');
        const fsyncJournalPath =
            deliveryTransaction.location(fsyncFault.record).journalPath;
        assert.strictEqual(
            JSON.parse(fs.readFileSync(fsyncJournalPath, 'utf8')).state,
            'reserved',
            'a pre-rename fsync failure must leave the old journal authoritative');
        assert.deepStrictEqual(
            fs.readdirSync(
                deliveryTransaction.location(fsyncFault.record).entryDir)
                .filter((name) =>
                    name.startsWith(deliveryTransaction.TEMP_PREFIX)),
            [], 'failed transaction temps must not be mistaken for commits');
        assert.strictEqual(deliveryTransaction.transition(
            fsyncFault.record, 'reserved', 'installed_pending_finalize',
            { replacementAttestation: fsyncAttestation }).state,
        'installed_pending_finalize',
        'same-proof retry must recover after a pre-rename fsync failure');

        const concurrent = makeFixture('concurrent');
        created.push(concurrent.root);
        reserve(concurrent);
        const firstAttestation = install(concurrent);
        const secondAttestation =
            JSON.parse(JSON.stringify(firstAttestation));
        secondAttestation.attested_at_ms =
            Number(firstAttestation.attested_at_ms) + 1;
        const results = await runConcurrentTransition(
            concurrent, firstAttestation, secondAttestation);
        assert.strictEqual(
            results.filter((result) => result.code === 0).length, 1,
            `one concurrent writer must win: ${JSON.stringify(results)}`);
        assert.strictEqual(
            results.filter((result) => result.code !== 0).length, 1,
            'the conflicting writer must not overwrite the winner');
        const concurrentJournal =
            deliveryTransaction.load(concurrent.record);
        assert.strictEqual(
            concurrentJournal.state, 'installed_pending_finalize');
        assert.strictEqual(concurrentJournal.revision, 2);
        const winner = results.find((result) => result.code === 0);
        const winnerValue = JSON.parse(winner.stdout);
        assert.strictEqual(
            concurrentJournal.replacement.evidence.attested_at_ms,
            winnerValue.attested_at_ms,
            'concurrent CAS must preserve the winning proof without a lost write');
        const winnerAttestation =
            winnerValue.attested_at_ms === firstAttestation.attested_at_ms
                ? firstAttestation
                : secondAttestation;
        assert.deepStrictEqual(deliveryTransaction.transition(
            concurrent.record, 'reserved', 'installed_pending_finalize',
            { replacementAttestation: winnerAttestation }),
        concurrentJournal, 'same-proof retry must be an idempotent read-back');

        assert.strictEqual(
            fs.readFileSync(
                './plugins/vmaf/_lib/deliveryTransaction.js', 'utf8'),
            fs.readFileSync(
                './custom-cont-init.d/vmaf-plugin-patches/_lib/deliveryTransaction.js',
                'utf8'),
            'delivery transaction helper mirrors must be byte-identical');

        console.log(
            'PASS delivery transaction journal (authenticated placement, full-hash proofs, strict CAS/idempotency, torn/corrupt rejection, concurrent no-lost-write, fsync fail-closed)');
    } finally {
        for (const root of created) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
}

if (process.argv[2] === '--worker') {
    worker().catch((error) => {
        process.stderr.write(error.stack || String(error));
        process.exitCode = 2;
    });
} else {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
