"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

const path = require('path');
const deliveryPolicy = require('../../_lib/deliveryPolicy.js');
const postReplaceAttestation = require('../../_lib/postReplaceAttestation.js');
const deliveryFinalization = require('../../_lib/deliveryFinalization.js');
const deliveryTransaction = require('../../_lib/deliveryTransaction.js');

const PENDING_SCHEMA = 'vmaf-delivery-outcome-pending/v1';
const VALIDATION_SCHEMA = 'vmaf-delivery-candidate-validation/v1';
const REQUIRED_TARGET_REDUCTION_PCT = 30;
const REQUIRED_MINIMUM_REDUCTION_PCT = 20;
const REQUIRED_MAX_OUTPUT_RATIO_PCT = 80;
const FLOAT_TOLERANCE = 0.000000001;
const DB_RETRY_DELAYS_MS = Object.freeze([50, 150]);
const JOB_SELECT = [
    'SELECT job_id, file_path, transcode_succeeded, met_vmaf_target,',
    'final_output_size_mb, final_output_ratio_pct, actual_size_reduction_pct,',
    'met_size_target, size_target_status, target_size_reduction_pct,',
    'minimum_size_reduction_pct, max_final_output_ratio_pct, size_policy_version,',
    'outcome_stage, delivered_at, replacement_attestation_version,',
    'replacement_backup_retained, delivery_transaction_id,',
    'delivery_checkpoint_key, skip_reason',
    'FROM jobs WHERE job_id = ?',
].join(' ');

function pathKey(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
    return pathKey(left) === pathKey(right);
}

function finiteNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} must be finite`);
    }
    return value;
}

function positiveSafeInteger(value, label) {
    if (typeof value !== 'number' ||
        !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}

function installedPath(args) {
    return String(args.inputFileObj &&
        (args.inputFileObj._id || args.inputFileObj.file) || '');
}

function originalPath(args) {
    return String(args.originalLibraryFile &&
        (args.originalLibraryFile._id || args.originalLibraryFile.file) ||
        args.variables && args.variables.vmafOriginalFile || '');
}

function canonicalJobId(args) {
    const jobId = String(args.variables && args.variables.vmafCanonicalJobId || '').trim();
    if (!jobId) {
        throw new Error('delivery finalization requires the canonical VMAF job id');
    }
    return jobId;
}

function requireExactPolicy(variables, pending, validation) {
    const policy = deliveryPolicy.resolve(variables);
    if (policy.version !== deliveryPolicy.POLICY_VERSION ||
        policy.targetReductionPct !== REQUIRED_TARGET_REDUCTION_PCT ||
        policy.minimumReductionPct !== REQUIRED_MINIMUM_REDUCTION_PCT ||
        policy.maxFinalOutputRatioPct !== REQUIRED_MAX_OUTPUT_RATIO_PCT) {
        throw new Error('delivery finalization requires the exact current 30/20/80 size policy');
    }
    for (const [label, evidence] of [
        ['pending delivery proof', pending],
        ['candidate validation', validation],
    ]) {
        if (evidence.size_policy_version !== undefined &&
            evidence.size_policy_version !== policy.version) {
            throw new Error(`${label} size-policy version differs from the current policy`);
        }
        if (evidence.policy_version !== undefined &&
            evidence.policy_version !== policy.version) {
            throw new Error(`${label} policy version differs from the current policy`);
        }
        if (finiteNumber(evidence.target_size_reduction_pct,
            `${label} target reduction`) !== policy.targetReductionPct ||
            finiteNumber(evidence.minimum_size_reduction_pct,
                `${label} minimum reduction`) !== policy.minimumReductionPct ||
            finiteNumber(evidence.max_final_output_ratio_pct,
                `${label} maximum output ratio`) !== policy.maxFinalOutputRatioPct) {
            throw new Error(`${label} differs from the exact current 30/20/80 policy`);
        }
    }
    return policy;
}

function requireSourceBackupBinding(validation, replacement) {
    const source = validation.source;
    const backup = replacement.backup;
    if (!source || !backup) {
        throw new Error('source-to-backup identity evidence is missing');
    }
    if (positiveSafeInteger(source.size_bytes, 'validated source byte count') !==
        positiveSafeInteger(backup.size_bytes, 'attested backup byte count')) {
        throw new Error('attested backup size differs from the validated source');
    }
    if (!String(source.sha256_full || '') ||
        String(source.sha256_full) !== String(backup.sha256_full || '')) {
        throw new Error('attested backup hash differs from the validated source');
    }
}

function requireCandidateInstalledBinding(validation, replacement) {
    const candidate = validation.candidate;
    const installed = replacement.installed;
    if (!candidate || !installed) {
        throw new Error('candidate-to-installed identity evidence is missing');
    }
    if (positiveSafeInteger(candidate.size_bytes, 'validated candidate byte count') !==
        positiveSafeInteger(installed.size_bytes, 'attested installed byte count')) {
        throw new Error('attested installed size differs from the validated candidate');
    }
    if (!String(candidate.sha256_full || '') ||
        String(candidate.sha256_full) !== String(installed.sha256_full || '')) {
        throw new Error('attested installed hash differs from the validated candidate');
    }
}

function validateEvidence(args) {
    args.variables = args.variables || {};
    const variables = args.variables;
    const jobId = canonicalJobId(args);
    const checkpoint = variables.vmafPostEncodeCheckpoint;
    const checkpointKey = checkpoint && String(checkpoint.checkpoint_key || '');
    if (!checkpointKey) {
        throw new Error('delivery finalization requires an authenticated post-encode checkpoint');
    }
    const pending = variables.vmafDeliveryOutcomePending;
    if (!pending || typeof pending !== 'object' ||
        pending.schema !== PENDING_SCHEMA ||
        pending.version !== 1 ||
        pending.status !== 'candidate_ready' ||
        pending.database_recorded !== true ||
        String(pending.job_id || '') !== jobId ||
        String(pending.checkpoint_key || '') !== checkpointKey) {
        throw new Error('delivery finalization requires the exact recorded pending-delivery proof');
    }
    const validation = variables.vmafDeliveryCandidateValidation;
    if (!validation || typeof validation !== 'object' ||
        validation.schema !== VALIDATION_SCHEMA ||
        validation.status !== 'accepted' ||
        String(validation.job_id || '') !== jobId ||
        String(validation.checkpoint_key || '') !== checkpointKey ||
        validation.candidate_ready_schema !== PENDING_SCHEMA) {
        throw new Error('delivery finalization requires the exact accepted candidate validation');
    }
    if (!Number.isFinite(Date.parse(String(pending.recorded_at || '')))) {
        throw new Error('pending-delivery proof has an invalid recorded timestamp');
    }
    const sourcePath = String(validation.source && validation.source.path || '');
    const original = originalPath(args);
    const target = installedPath(args);
    if (!sourcePath || !path.isAbsolute(sourcePath) ||
        !original || !path.isAbsolute(original) ||
        !samePath(sourcePath, original) ||
        !samePath(pending.source_path, sourcePath)) {
        throw new Error('pending/validated source paths do not bind to the original library file');
    }
    if (!target || !path.isAbsolute(target)) {
        throw new Error('delivery finalization requires an absolute installed file path');
    }
    const validatedAt = Date.parse(String(validation.validated_at || ''));
    const consumedAt = Date.parse(String(
        variables.vmafDeliveryCandidateValidationConsumedAt || ''));
    if (!Number.isFinite(validatedAt) || !Number.isFinite(consumedAt) ||
        consumedAt < validatedAt) {
        throw new Error('delivery finalization requires ordered candidate-validation consumption proof');
    }

    const policy = requireExactPolicy(variables, pending, validation);
    const replacement = variables.vmafReplacementAttestation;
    const replacementProof = postReplaceAttestation.validate(replacement, {
        checkpointRecord: checkpoint,
        inputPath: target,
        originalPath: original,
    });
    if (!replacementProof.valid ||
        replacement.version !== postReplaceAttestation.VERSION ||
        replacement.outcome !== 'backup_retained' ||
        !replacement.backup_path || !replacement.backup) {
        throw new Error('delivery finalization requires the current installed-and-backup attestation');
    }
    if (!Number.isFinite(Number(replacement.attested_at_ms)) ||
        Number(replacement.attested_at_ms) < consumedAt) {
        throw new Error('replacement attestation predates candidate-validation consumption');
    }
    const exactBackupPath = postReplaceAttestation.exactBackupPath(original);
    if (!samePath(replacement.backup_path, exactBackupPath) ||
        !samePath(replacement.original_path, sourcePath)) {
        throw new Error('replacement backup path does not bind to the validated source');
    }
    requireSourceBackupBinding(validation, replacement);
    requireCandidateInstalledBinding(validation, replacement);

    const installed = postReplaceAttestation.inspectInstalledFile(target);
    const candidateBytes = positiveSafeInteger(
        validation.candidate && validation.candidate.size_bytes,
        'validated candidate byte count');
    if (installed.identity.size_bytes !== candidateBytes) {
        throw new Error('installed file size differs from the validated delivery candidate');
    }
    const sourceBytes = positiveSafeInteger(
        validation.source && validation.source.size_bytes,
        'validated source byte count');
    const assessment = deliveryPolicy.evaluateBytes(
        installed.identity.size_bytes, sourceBytes, policy);
    if (!assessment.accepted) {
        throw new Error('installed file exceeds the exact delivered-size cap');
    }
    if (Math.abs(finiteNumber(validation.output_ratio_pct,
        'validated output ratio') - assessment.ratioPct) > FLOAT_TOLERANCE ||
        Math.abs(finiteNumber(validation.actual_size_reduction_pct,
            'validated actual reduction') - assessment.actualReductionPct) >
            FLOAT_TOLERANCE) {
        throw new Error('validated size outcome differs from the installed delivery');
    }
    return {
        variables,
        jobId,
        checkpoint,
        checkpointKey,
        pending,
        validation,
        replacement,
        installed,
        originalPath: original,
        backupPath: exactBackupPath,
        policy,
        assessment,
    };
}

function requireDeliveryJournal(proof, dependencies) {
    const transaction = dependencies && dependencies.deliveryTransaction ||
        deliveryTransaction;
    const validated = transaction.validate(
        proof.checkpoint, undefined, { verifyCurrentFiles: false });
    if (!validated.valid || !validated.journal) {
        throw new Error('delivery transaction journal is invalid: ' +
            String(validated.reason || 'missing journal'));
    }
    const journal = validated.journal;
    const compact = proof.variables.vmafDeliveryTransaction;
    const flowTransactionId = String(
        proof.variables.vmafDeliveryTransactionId || '');
    const flowState = String(
        proof.variables.vmafDeliveryTransactionState || '');
    if (!/^[0-9a-f]{64}$/.test(String(journal.transaction_id || '')) ||
        journal.job_id !== proof.jobId ||
        journal.checkpoint_key !== proof.checkpointKey ||
        (journal.state !== 'delivery_committing' &&
            journal.state !== 'delivered')) {
        throw new Error('delivery transaction journal identity/state is not finalizable');
    }
    if (flowTransactionId !== journal.transaction_id ||
        !compact || compact.schema !== transaction.SCHEMA ||
        compact.version !== transaction.VERSION ||
        compact.transaction_id !== journal.transaction_id ||
        compact.job_id !== journal.job_id ||
        compact.checkpoint_key !== journal.checkpoint_key ||
        compact.state !== flowState ||
        Number(compact.revision) !== Number(transaction.STATES[flowState]) ||
        (flowState !== 'delivery_committing' && flowState !== 'delivered') ||
        (journal.state === 'delivery_committing' &&
            flowState !== 'delivery_committing')) {
        throw new Error('flow delivery-transaction proof differs from its journal');
    }
    const bindings = [
        ['pending proof', journal.pending_proof && journal.pending_proof.evidence,
            proof.pending],
        ['candidate validation',
            journal.candidate_validation &&
                journal.candidate_validation.evidence,
            proof.validation],
        ['replacement attestation',
            journal.replacement && journal.replacement.evidence,
            proof.replacement],
    ];
    for (const [label, journalEvidence, flowEvidence] of bindings) {
        if (!journalEvidence ||
            transaction.canonicalJson(journalEvidence) !==
                transaction.canonicalJson(flowEvidence)) {
            throw new Error(`delivery transaction ${label} differs from flow evidence`);
        }
    }
    proof.transaction = transaction;
    proof.journal = journal;
    proof.transactionId = journal.transaction_id;
    return proof;
}

function isBusyError(error) {
    const code = String(error && error.code || '').toUpperCase();
    const message = String(error && error.message || '').toUpperCase();
    return code.includes('SQLITE_BUSY') || code.includes('SQLITE_LOCKED') ||
        message.includes('SQLITE_BUSY') || message.includes('DATABASE IS LOCKED');
}

async function withDbRetries(action, dependencies, label) {
    const delay = dependencies && dependencies.dbDelay ||
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let lastError;
    for (let attempt = 0; attempt <= DB_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            return await action();
        } catch (error) {
            lastError = error;
            if (!isBusyError(error) || attempt === DB_RETRY_DELAYS_MS.length) {
                throw error;
            }
            await delay(DB_RETRY_DELAYS_MS[attempt]);
        }
    }
    throw new Error(`${label} failed after retries: ${lastError && lastError.message}`);
}

function readJobRow(db, jobId) {
    return db.prepare(JOB_SELECT).get(jobId);
}

function requireNullFields(row, fields, label) {
    for (const field of fields) {
        if (row[field] !== null) {
            throw new Error(`${label} requires ${field} to remain NULL`);
        }
    }
}

function requireFiniteEqual(actual, expected, label) {
    if (typeof actual !== 'number' || typeof expected !== 'number' ||
        !Number.isFinite(actual) || !Number.isFinite(expected) ||
        Math.abs(actual - expected) > FLOAT_TOLERANCE) {
        throw new Error(`${label} differs from the exact delivered outcome`);
    }
}

function requireCanonicalRow(row, proof) {
    if (!row || String(row.job_id || '') !== proof.jobId) {
        throw new Error(`canonical VMAF job row is missing: ${proof.jobId}`);
    }
    if (!row.file_path || !samePath(row.file_path, proof.validation.source.path)) {
        throw new Error('canonical VMAF job row is not bound to the validated source');
    }
    if (row.delivery_transaction_id !== proof.transactionId ||
        row.delivery_checkpoint_key !== proof.checkpointKey) {
        throw new Error('canonical VMAF job row differs from the delivery transaction journal');
    }
    requireFiniteEqual(row.target_size_reduction_pct,
        proof.policy.targetReductionPct, 'DB target reduction');
    requireFiniteEqual(row.minimum_size_reduction_pct,
        proof.policy.minimumReductionPct, 'DB minimum reduction');
    requireFiniteEqual(row.max_final_output_ratio_pct,
        proof.policy.maxFinalOutputRatioPct, 'DB maximum output ratio');
    if (row.size_policy_version !== proof.policy.version) {
        throw new Error('DB size-policy version differs from the pending delivery');
    }
}

const PRETERMINAL_NULL_FIELDS = Object.freeze([
    'transcode_succeeded',
    'met_vmaf_target',
    'final_output_size_mb',
    'final_output_ratio_pct',
    'actual_size_reduction_pct',
    'met_size_target',
    'delivered_at',
    'replacement_attestation_version',
    'replacement_backup_retained',
    'skip_reason',
]);

function requirePreterminalRow(row, proof, stage) {
    requireCanonicalRow(row, proof);
    if (row.outcome_stage !== stage) {
        throw new Error(`canonical VMAF job is not in ${stage}`);
    }
    if (row.size_target_status !== 'pending_delivery') {
        throw new Error('preterminal delivery row has an invalid size-target status');
    }
    requireNullFields(row, PRETERMINAL_NULL_FIELDS, stage);
}

function deliveredFields(proof, deliveredAt, backupRetained) {
    return {
        job_id: proof.jobId,
        transcode_succeeded: 1,
        met_vmaf_target: 1,
        final_output_size_mb: proof.assessment.outputBytes / (1024 * 1024),
        final_output_ratio_pct: proof.assessment.ratioPct,
        actual_size_reduction_pct: proof.assessment.actualReductionPct,
        met_size_target: 1,
        size_target_status: 'met',
        target_size_reduction_pct: proof.policy.targetReductionPct,
        minimum_size_reduction_pct: proof.policy.minimumReductionPct,
        max_final_output_ratio_pct: proof.policy.maxFinalOutputRatioPct,
        size_policy_version: proof.policy.version,
        outcome_stage: 'delivered',
        delivered_at: deliveredAt,
        replacement_attestation_version:
            deliveryFinalization.replacementContract(proof.replacement),
        replacement_backup_retained: backupRetained ? 1 : 0,
        delivery_transaction_id: proof.transactionId,
        delivery_checkpoint_key: proof.checkpointKey,
        skip_reason: null,
    };
}

function assertDeliveredRow(row, proof, expected) {
    requireCanonicalRow(row, proof);
    const exactFields = [
        'transcode_succeeded', 'met_vmaf_target', 'met_size_target',
        'size_target_status', 'size_policy_version', 'outcome_stage', 'delivered_at',
        'replacement_attestation_version', 'replacement_backup_retained',
        'delivery_transaction_id', 'delivery_checkpoint_key',
    ];
    for (const field of exactFields) {
        if (row[field] !== expected[field]) {
            throw new Error(`delivered outcome DB read-back mismatch for ${field}`);
        }
    }
    if (row.skip_reason !== null) {
        throw new Error('delivered outcome DB read-back did not clear skip_reason');
    }
    for (const field of [
        'final_output_size_mb', 'final_output_ratio_pct', 'actual_size_reduction_pct',
        'target_size_reduction_pct', 'minimum_size_reduction_pct',
        'max_final_output_ratio_pct',
    ]) {
        requireFiniteEqual(row[field], expected[field],
            `delivered outcome DB ${field}`);
    }
    return row;
}

function casCommittingToDelivered(db, expected) {
    const result = db.prepare(
        'UPDATE jobs SET transcode_succeeded = ?, met_vmaf_target = ?, ' +
        'final_output_size_mb = ?, final_output_ratio_pct = ?, ' +
        'actual_size_reduction_pct = ?, met_size_target = ?, size_target_status = ?, ' +
        'target_size_reduction_pct = ?, minimum_size_reduction_pct = ?, ' +
        'max_final_output_ratio_pct = ?, size_policy_version = ?, outcome_stage = ?, ' +
        'delivered_at = ?, replacement_attestation_version = ?, ' +
        'replacement_backup_retained = ?, skip_reason = NULL, updated_at = ? ' +
        "WHERE job_id = ? AND outcome_stage = 'delivery_committing' " +
        'AND delivery_transaction_id = ? AND delivery_checkpoint_key = ? ' +
        "AND size_target_status = 'pending_delivery' " +
        'AND transcode_succeeded IS NULL AND met_vmaf_target IS NULL ' +
        'AND final_output_size_mb IS NULL AND final_output_ratio_pct IS NULL ' +
        'AND actual_size_reduction_pct IS NULL AND met_size_target IS NULL ' +
        'AND delivered_at IS NULL AND replacement_attestation_version IS NULL ' +
        'AND replacement_backup_retained IS NULL AND skip_reason IS NULL'
    ).run(
        expected.transcode_succeeded,
        expected.met_vmaf_target,
        expected.final_output_size_mb,
        expected.final_output_ratio_pct,
        expected.actual_size_reduction_pct,
        expected.met_size_target,
        expected.size_target_status,
        expected.target_size_reduction_pct,
        expected.minimum_size_reduction_pct,
        expected.max_final_output_ratio_pct,
        expected.size_policy_version,
        expected.outcome_stage,
        expected.delivered_at,
        expected.replacement_attestation_version,
        expected.replacement_backup_retained,
        expected.delivered_at,
        expected.job_id,
        expected.delivery_transaction_id,
        expected.delivery_checkpoint_key,
    );
    return Number(result && result.changes || 0);
}

function finalizationContext(proof) {
    return {
        checkpointRecord: proof.checkpoint,
        inputPath: proof.installed.path,
        originalPath: proof.originalPath,
        replacementAttestation: proof.replacement,
    };
}

function createFinalization(proof, deliveredAt, backupDisposition) {
    return deliveryFinalization.create({
        deliveredAt,
        jobId: proof.jobId,
        transactionId: proof.transactionId,
        policy: proof.policy,
        sourceSizeBytes: proof.assessment.sourceBytes,
        installedPath: proof.installed.path,
        originalPath: proof.originalPath,
        candidateValidationSchema: proof.validation.schema,
        replacementAttestation: proof.replacement,
        checkpointRecord: proof.checkpoint,
        backupDisposition,
        databaseRecorded: true,
    });
}

function publishFinalization(args, proof, evidence) {
    args.variables.vmafDeliveryFinalization = evidence;
    args.variables.vmafDeliveryFinalizationStatus = 'delivered';
    args.variables.vmafDeliveryTransactionId = proof.journal.transaction_id;
    args.variables.vmafDeliveryTransactionState = proof.journal.state;
    args.variables.vmafDeliveryTransaction = {
        schema: proof.journal.schema,
        version: proof.journal.version,
        transaction_id: proof.journal.transaction_id,
        job_id: proof.journal.job_id,
        checkpoint_key: proof.journal.checkpoint_key,
        state: proof.journal.state,
        revision: proof.journal.revision,
    };
    delete args.variables.vmafDeliveryFinalizationFailureReason;
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
}

function commitJournalFinalization(proof, evidence) {
    const journal = proof.transaction.transition(
        proof.checkpoint,
        'delivery_committing',
        'delivered',
        { deliveryFinalization: evidence },
    );
    const validation = proof.transaction.validate(
        proof.checkpoint, journal, { verifyCurrentFiles: true });
    if (!validation.valid || !validation.journal ||
        validation.journal.state !== 'delivered' ||
        !validation.journal.delivered ||
        proof.transaction.canonicalJson(
            validation.journal.delivered.evidence) !==
            proof.transaction.canonicalJson(evidence)) {
        throw new Error('delivered transaction-journal read-back is invalid: ' +
            String(validation.reason || 'evidence mismatch'));
    }
    proof.journal = validation.journal;
    return validation.journal.delivered.evidence;
}

function reconstructDelivered(args, row, proof) {
    if (row.replacement_backup_retained !== 0 &&
        row.replacement_backup_retained !== 1) {
        throw new Error('delivered row has an invalid backup-retained flag');
    }
    const backupDisposition = row.replacement_backup_retained === 1
        ? 'backup_retained' : 'backup_removed';
    const expected = deliveredFields(
        proof, String(row.delivered_at || ''), row.replacement_backup_retained === 1);
    if (!Number.isFinite(Date.parse(expected.delivered_at))) {
        throw new Error('delivered row has an invalid immutable delivered_at');
    }
    assertDeliveredRow(row, proof, expected);
    let evidence;
    if (proof.journal.state === 'delivered') {
        evidence = proof.journal.delivered &&
            proof.journal.delivered.evidence;
        if (!evidence) {
            throw new Error('delivered journal has no immutable finalization evidence');
        }
    } else {
        evidence = createFinalization(
            proof, expected.delivered_at, backupDisposition);
    }
    if (evidence.job_id !== proof.jobId ||
        evidence.delivery_transaction_id !== proof.transactionId ||
        evidence.delivered_at !== expected.delivered_at ||
        evidence.backup_disposition !== backupDisposition) {
        throw new Error('journal finalization evidence differs from the immutable delivered row');
    }
    deliveryFinalization.assertDatabaseRow(evidence, row);
    evidence = commitJournalFinalization(proof, evidence);
    const existing = args.variables.vmafDeliveryFinalization;
    if (existing && proof.transaction.canonicalJson(existing) !==
        proof.transaction.canonicalJson(evidence)) {
        throw new Error('flow finalization evidence differs from the immutable journal');
    }
    args.jobLog('Immutable delivered DB row and transaction journal verified.');
    return publishFinalization(args, proof, evidence);
}

async function finalizeDeliveredOutcome(args, dependencies) {
    args.variables = args.variables || {};
    const priorFinalization = args.variables.vmafDeliveryFinalization;
    args.variables.vmafDeliveryFinalizationStatus = 'pending';
    delete args.variables.vmafDeliveryFinalizationFailureReason;
    try {
        const proof = requireDeliveryJournal(validateEvidence(args), dependencies);
        const vmafdb = dependencies && dependencies.vmafdb ||
            require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
        const db = dependencies && dependencies.db || vmafdb.openDb();
        let row = await withDbRetries(
            () => readJobRow(db, proof.jobId), dependencies, 'delivery DB read');
        requireCanonicalRow(row, proof);

        if (row.outcome_stage === 'delivered') {
            return reconstructDelivered(args, row, proof);
        }
        requirePreterminalRow(row, proof, 'delivery_committing');
        if (proof.journal.state !== 'delivery_committing') {
            throw new Error('delivery-committing DB row differs from the immutable journal state');
        }

        const backupOperations = Object.assign(
            {},
            dependencies && dependencies.backupOperations || {},
        );
        if (dependencies && dependencies.fsyncParentDirectory) {
            backupOperations.fsyncDirectory =
                dependencies.fsyncParentDirectory;
        }
        const retirement = await postReplaceAttestation.retireRetainedBackup(
            proof.replacement,
            {
                operations: backupOperations,
                delay: dependencies && dependencies.backupDelay,
            },
        );
        const backupRetained = retirement.retained === true;
        const backupDisposition = backupRetained ? 'backup_retained' : 'backup_removed';
        if (backupRetained) {
            const retainedProof = postReplaceAttestation.validate(proof.replacement, {
                checkpointRecord: proof.checkpoint,
                inputPath: proof.installed.path,
                originalPath: proof.originalPath,
                requireRetainedBackup: true,
            });
            if (!retainedProof.valid) {
                throw new Error(`retained exact backup failed revalidation: ${retainedProof.reason}`);
            }
        } else {
            if (deliveryFinalization.exactPathExists(proof.backupPath)) {
                throw new Error('exact replacement backup reappeared after retirement and parent fsync');
            }
        }

        const deliveredAt = new Date().toISOString();
        const expected = deliveredFields(proof, deliveredAt, backupRetained);
        const evidence = createFinalization(proof, deliveredAt, backupDisposition);
        const changed = await withDbRetries(
            () => casCommittingToDelivered(db, expected),
            dependencies,
            'delivery-committing terminal CAS',
        );
        row = await withDbRetries(
            () => readJobRow(db, proof.jobId), dependencies, 'delivered DB read-back');
        if (changed !== 1) {
            if (row && row.outcome_stage === 'delivered') {
                return reconstructDelivered(args, row, proof);
            }
            throw new Error('delivery-committing terminal CAS did not update exactly one row');
        }
        assertDeliveredRow(row, proof, expected);
        deliveryFinalization.assertDatabaseRow(evidence, row);
        deliveryFinalization.validateOrThrow(evidence, finalizationContext(proof));
        const journalEvidence = commitJournalFinalization(proof, evidence);
        args.jobLog('Delivered outcome committed at ' +
            proof.assessment.ratioPct.toFixed(3) + '% of source; backup ' +
            (backupRetained ? 'retained after exact retirement retries.' :
                'removed with parent-directory fsync.'));
        return publishFinalization(args, proof, journalEvidence);
    } catch (error) {
        if (priorFinalization === undefined) {
            delete args.variables.vmafDeliveryFinalization;
        } else {
            args.variables.vmafDeliveryFinalization = priorFinalization;
        }
        args.variables.vmafDeliveryFinalizationStatus = 'failed';
        args.variables.vmafDeliveryFinalizationFailureReason =
            String(error.message || error);
        args.jobLog('FATAL: Delivered outcome was not finalized: ' +
            args.variables.vmafDeliveryFinalizationFailureReason +
            '. Protected checkpoint retained.');
        const fatal = new Error('delivered outcome finalization failed: ' +
            args.variables.vmafDeliveryFinalizationFailureReason);
        fatal.code = 'TDARR_VMAF_DELIVERY_FINALIZATION_FATAL';
        throw fatal;
    }
}

const details = () => ({
    name: 'Finalize Delivered Outcome',
    description: [
        'Requires the replacement phase to have durably reached delivery_committing.',
        'Retires only the exact attested original backup, fsyncs its parent, then CASes delivered.',
        'Fails closed and retains the protected checkpoint on any inconsistency.',
    ].join(' '),
    style: { borderColor: 'green' },
    tags: 'video,vmaf,delivery,attestation,database,safety',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faCheck',
    inputs: [],
    outputs: [
        { number: 1, tooltip: 'Immutable delivered outcome and finalization proof verified' },
    ],
});
exports.details = details;

const plugin = async (args) => {
    const lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    args.jobLog('=== Finalize Delivered Outcome ===');
    return finalizeDeliveredOutcome(args);
};
exports.plugin = plugin;
exports._test = {
    PENDING_SCHEMA,
    VALIDATION_SCHEMA,
    JOB_SELECT,
    DB_RETRY_DELAYS_MS,
    validateEvidence,
    requireDeliveryJournal,
    canonicalJobId,
    isBusyError,
    withDbRetries,
    readJobRow,
    requireFiniteEqual,
    requireCanonicalRow,
    requirePreterminalRow,
    deliveredFields,
    assertDeliveredRow,
    casCommittingToDelivered,
    createFinalization,
    commitJournalFinalization,
    reconstructDelivered,
    finalizeDeliveredOutcome,
};
