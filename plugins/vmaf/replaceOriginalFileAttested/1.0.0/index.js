"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

const fs = require('fs');
const path = require('path');
const deliveryPolicy = require('../../_lib/deliveryPolicy.js');
const deliveryTransaction = require('../../_lib/deliveryTransaction.js');
const postEncodeCheckpoint = require('../../_lib/postEncodeCheckpoint.js');
const postReplaceAttestation = require('../../_lib/postReplaceAttestation.js');

const PENDING_SCHEMA = 'vmaf-delivery-outcome-pending/v1';
const VALIDATION_SCHEMA = 'vmaf-delivery-candidate-validation/v1';
const STAGE_SUFFIX = '.tdarr-vmaf-delivery-stage';
const INSTALL_SUFFIX = '.partial.new';
const DB_RETRY_DELAYS_MS = Object.freeze([50, 150]);
const FLOAT_TOLERANCE = 0.000000001;
const PRETERMINAL_NULL_FIELDS = Object.freeze([
    'transcode_succeeded',
    'met_vmaf_target',
    'met_size_target',
    'final_output_size_mb',
    'final_output_ratio_pct',
    'actual_size_reduction_pct',
    'delivered_at',
    'replacement_attestation_version',
    'replacement_backup_retained',
    'skip_reason',
]);
const JOB_SELECT = [
    'SELECT job_id, file_path, transcode_succeeded, met_vmaf_target,',
    'met_size_target, final_output_size_mb, final_output_ratio_pct,',
    'actual_size_reduction_pct, size_target_status,',
    'target_size_reduction_pct, minimum_size_reduction_pct,',
    'max_final_output_ratio_pct, size_policy_version, outcome_stage,',
    'delivered_at, replacement_attestation_version,',
    'replacement_backup_retained, skip_reason, delivery_transaction_id,',
    'delivery_checkpoint_key FROM jobs WHERE job_id = ?',
].join(' ');
const RESERVE_SQL = [
    "UPDATE jobs SET outcome_stage = 'replacement_committing',",
    'delivery_transaction_id = ?, updated_at = ?',
    "WHERE job_id = ? AND file_path = ? AND outcome_stage = 'candidate_ready'",
    'AND delivery_transaction_id IS NULL AND delivery_checkpoint_key = ?',
    "AND size_target_status = 'pending_delivery'",
    'AND target_size_reduction_pct = ? AND minimum_size_reduction_pct = ?',
    'AND max_final_output_ratio_pct = ? AND size_policy_version = ?',
    'AND transcode_succeeded IS NULL AND met_vmaf_target IS NULL',
    'AND met_size_target IS NULL AND final_output_size_mb IS NULL',
    'AND final_output_ratio_pct IS NULL AND actual_size_reduction_pct IS NULL',
    'AND delivered_at IS NULL AND replacement_attestation_version IS NULL',
    'AND replacement_backup_retained IS NULL AND skip_reason IS NULL',
].join(' ');
const COMMIT_SQL = [
    "UPDATE jobs SET outcome_stage = 'delivery_committing', updated_at = ?",
    "WHERE job_id = ? AND file_path = ? AND outcome_stage = 'replacement_committing'",
    'AND delivery_transaction_id = ? AND delivery_checkpoint_key = ?',
    "AND size_target_status = 'pending_delivery'",
    'AND target_size_reduction_pct = ? AND minimum_size_reduction_pct = ?',
    'AND max_final_output_ratio_pct = ? AND size_policy_version = ?',
    'AND transcode_succeeded IS NULL AND met_vmaf_target IS NULL',
    'AND met_size_target IS NULL AND final_output_size_mb IS NULL',
    'AND final_output_ratio_pct IS NULL AND actual_size_reduction_pct IS NULL',
    'AND delivered_at IS NULL AND replacement_attestation_version IS NULL',
    'AND replacement_backup_retained IS NULL AND skip_reason IS NULL',
].join(' ');
const FAILURE_SQL = [
    "UPDATE jobs SET outcome_stage = 'technical_failure',",
    'transcode_succeeded = 0, met_vmaf_target = NULL, met_size_target = NULL,',
    'final_output_size_mb = NULL, final_output_ratio_pct = NULL,',
    "actual_size_reduction_pct = NULL, size_target_status = 'not_delivered',",
    'delivered_at = NULL, replacement_attestation_version = NULL,',
    'replacement_backup_retained = ?, skip_reason = ?, updated_at = ?',
    "WHERE job_id = ? AND file_path = ? AND outcome_stage = 'replacement_committing'",
    'AND delivery_transaction_id = ? AND delivery_checkpoint_key = ?',
    "AND size_target_status = 'pending_delivery'",
    'AND target_size_reduction_pct = ? AND minimum_size_reduction_pct = ?',
    'AND max_final_output_ratio_pct = ? AND size_policy_version = ?',
    'AND transcode_succeeded IS NULL AND met_vmaf_target IS NULL',
    'AND met_size_target IS NULL AND final_output_size_mb IS NULL',
    'AND final_output_ratio_pct IS NULL AND actual_size_reduction_pct IS NULL',
    'AND delivered_at IS NULL AND replacement_attestation_version IS NULL',
    'AND replacement_backup_retained IS NULL AND skip_reason IS NULL',
].join(' ');

function pathKey(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32'
        ? resolved.toLowerCase()
        : resolved;
}

function samePath(left, right) {
    return pathKey(left) === pathKey(right);
}

function safeIso(value, label) {
    const text = String(value || '');
    if (!text || !Number.isFinite(Date.parse(text))) {
        throw new Error(`${label} is not a valid timestamp`);
    }
    return text;
}

function currentPath(args) {
    return String(args.inputFileObj &&
        (args.inputFileObj._id || args.inputFileObj.file) || '');
}

function originalPath(args) {
    return String(args.originalLibraryFile &&
        (args.originalLibraryFile._id || args.originalLibraryFile.file) ||
        args.variables && args.variables.vmafOriginalFile || '');
}

function exactPathExists(filePath) {
    try {
        fs.lstatSync(filePath);
        return true;
    } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        throw error;
    }
}

function assertIdentity(expected, actual, label) {
    if (!expected || typeof expected !== 'object') {
        throw new Error(`${label} evidence is missing`);
    }
    for (const key of [
        'dev', 'ino', 'size_bytes', 'mtime_ms', 'ctime_ms',
        'mtime_ns', 'ctime_ns', 'sha256_full',
    ]) {
        if (String(expected[key] === undefined ? '' : expected[key]) !==
            String(actual[key] === undefined ? '' : actual[key])) {
            throw new Error(`${label} ${key} changed after validation`);
        }
    }
    if (!samePath(expected.path, actual.path)) {
        throw new Error(`${label} path changed after validation`);
    }
}

function assertContent(expected, actual, label) {
    if (!expected || !actual ||
        Number(expected.size_bytes) !== Number(actual.size_bytes) ||
        String(expected.sha256_full || '') !==
            String(actual.sha256_full || '')) {
        throw new Error(`${label} full SHA-256 or byte count differs`);
    }
}

function inspect(filePath) {
    return postReplaceAttestation.inspectInstalledFile(filePath);
}

function inspectedIdentity(value) {
    return Object.assign({ path: value.path }, value.identity);
}

function requireExactPolicy(variables, pending, validation) {
    const policy = deliveryPolicy.resolve(variables);
    if (policy.version !== deliveryPolicy.POLICY_VERSION ||
        policy.targetReductionPct !== 30 ||
        policy.minimumReductionPct !== 20 ||
        policy.maxFinalOutputRatioPct !== 80) {
        throw new Error(
            'replacement requires the exact current 30/20/80 delivery policy');
    }
    for (const [label, evidence, versionKey] of [
        ['pending proof', pending, 'size_policy_version'],
        ['candidate validation', validation, 'policy_version'],
    ]) {
        if (!evidence ||
            evidence[versionKey] !== policy.version ||
            Number(evidence.target_size_reduction_pct) !==
                policy.targetReductionPct ||
            Number(evidence.minimum_size_reduction_pct) !==
                policy.minimumReductionPct ||
            Number(evidence.max_final_output_ratio_pct) !==
                policy.maxFinalOutputRatioPct) {
            throw new Error(
                `${label} differs from the exact current 30/20/80 policy`);
        }
    }
    return policy;
}

function requireCanonicalProof(args) {
    args.variables = args.variables || {};
    const variables = args.variables;
    const sourceRequested = originalPath(args);
    const candidateRequested = currentPath(args);
    if (!sourceRequested || !candidateRequested ||
        !path.isAbsolute(sourceRequested) ||
        !path.isAbsolute(candidateRequested)) {
        throw new Error(
            'replacement requires absolute candidate and original paths');
    }
    const jobId = String(variables.vmafCanonicalJobId || '').trim();
    if (!jobId) {
        throw new Error('replacement requires the canonical VMAF job id');
    }
    const checkpointRecord = variables.vmafPostEncodeCheckpoint;
    if (!checkpointRecord) {
        throw new Error(
            'replacement requires a real post-encode checkpoint record');
    }
    const authenticated =
        postEncodeCheckpoint.authenticateRecord(checkpointRecord);
    const checkpointKey = authenticated.key;
    const pending = variables.vmafDeliveryOutcomePending;
    if (!pending || pending.schema !== PENDING_SCHEMA ||
        pending.version !== 1 || pending.status !== 'candidate_ready' ||
        pending.database_recorded !== true ||
        pending.job_id !== jobId ||
        pending.checkpoint_key !== checkpointKey ||
        !path.isAbsolute(String(pending.source_path || '')) ||
        !samePath(pending.source_path, sourceRequested)) {
        throw new Error(
            'replacement requires the exact canonical candidate-ready proof');
    }
    const pendingAt = safeIso(
        pending.recorded_at, 'candidate-ready recorded_at');
    const validation = variables.vmafDeliveryCandidateValidation;
    if (!validation || validation.schema !== VALIDATION_SCHEMA ||
        validation.status !== 'accepted' ||
        validation.job_id !== jobId ||
        validation.checkpoint_key !== checkpointKey ||
        validation.candidate_ready_schema !== PENDING_SCHEMA ||
        !validation.source || !validation.candidate ||
        !path.isAbsolute(String(validation.source.path || '')) ||
        !path.isAbsolute(String(validation.candidate.path || '')) ||
        !samePath(validation.source.path, sourceRequested) ||
        !samePath(validation.candidate.path, candidateRequested)) {
        throw new Error(
            'replacement requires the exact accepted candidate validation');
    }
    const validatedAt = safeIso(
        validation.validated_at,
        'candidate validation validated_at');
    if (Date.parse(validatedAt) < Date.parse(pendingAt)) {
        throw new Error(
            'candidate validation predates the recorded candidate-ready proof');
    }
    const policy = requireExactPolicy(variables, pending, validation);
    const assessment = deliveryPolicy.evaluateBytes(
        Number(validation.candidate.size_bytes),
        Number(validation.source.size_bytes),
        policy,
    );
    if (!assessment.accepted ||
        Math.abs(Number(validation.output_ratio_pct) -
            assessment.ratioPct) > FLOAT_TOLERANCE ||
        Math.abs(Number(validation.actual_size_reduction_pct) -
            assessment.actualReductionPct) > FLOAT_TOLERANCE) {
        throw new Error(
            'candidate validation does not prove the accepted byte outcome');
    }
    return {
        variables,
        jobId,
        checkpointRecord,
        authenticated,
        checkpointKey,
        pending,
        validation,
        policy,
        assessment,
        sourceRequested: path.resolve(sourceRequested),
        candidateRequested: path.resolve(candidateRequested),
    };
}

function inspectAndBindCurrentFiles(proof) {
    const source = inspect(proof.sourceRequested);
    const candidate = inspect(proof.candidateRequested);
    assertIdentity(proof.validation.source, inspectedIdentity(source),
        'original source');
    assertIdentity(proof.validation.candidate, inspectedIdentity(candidate),
        'delivery candidate');
    if (samePath(source.path, candidate.path) ||
        (source.identity.dev === candidate.identity.dev &&
            source.identity.ino === candidate.identity.ino)) {
        throw new Error(
            'delivery candidate aliases the original source');
    }
    return { source, candidate };
}

function pathPlan(sourcePath, candidatePath) {
    const original = path.resolve(sourcePath);
    const current = path.resolve(candidatePath);
    return {
        current,
        target: original,
        temp: `${current}${STAGE_SUFFIX}`,
        installTemp: `${original}${INSTALL_SUFFIX}`,
        original,
        backup: postReplaceAttestation.exactBackupPath(original),
    };
}

function assertPairwisePathSeparation(paths) {
    const entries = Object.entries(paths);
    for (let left = 0; left < entries.length; left += 1) {
        for (let right = left + 1; right < entries.length; right += 1) {
            const [leftName, leftPath] = entries[left];
            const [rightName, rightPath] = entries[right];
            if (!samePath(leftPath, rightPath)) continue;
            const allowed = new Set([leftName, rightName]);
            if (allowed.has('target') && allowed.has('original')) continue;
            throw new Error(
                `replacement path collision: ${leftName} equals ${rightName}`);
        }
    }
}

function assertFreshMutationPaths(paths) {
    assertPairwisePathSeparation(paths);
    if (exactPathExists(paths.backup)) {
        throw new Error(
            'exact .partial.old backup already exists; refusing to delete or overwrite it');
    }
    if (exactPathExists(paths.temp)) {
        throw new Error(
            'delivery staging path already exists; refusing to overwrite it');
    }
    if (exactPathExists(paths.installTemp)) {
        throw new Error(
            'replacement .partial.new path already exists; refusing to overwrite it');
    }
    if (!samePath(paths.target, paths.original) &&
        exactPathExists(paths.target)) {
        throw new Error(
            'replacement target already exists; refusing to overwrite it');
    }
}

function isBusyError(error) {
    const code = String(error && error.code || '').toUpperCase();
    const message = String(error && error.message || '').toUpperCase();
    return code.includes('SQLITE_BUSY') ||
        code.includes('SQLITE_LOCKED') ||
        message.includes('SQLITE_BUSY') ||
        message.includes('SQLITE_LOCKED') ||
        message.includes('DATABASE IS LOCKED') ||
        message.includes('DATABASE TABLE IS LOCKED');
}

async function withDbRetries(action, dependencies) {
    const delay = dependencies && dependencies.dbDelay ||
        ((milliseconds) => new Promise(
            (resolve) => setTimeout(resolve, milliseconds)));
    for (let attempt = 0;
        attempt <= DB_RETRY_DELAYS_MS.length;
        attempt += 1) {
        try {
            return action();
        } catch (error) {
            if (!isBusyError(error) ||
                attempt === DB_RETRY_DELAYS_MS.length) {
                throw error;
            }
            await delay(DB_RETRY_DELAYS_MS[attempt]);
        }
    }
    throw new Error('unreachable DB retry state');
}

function readJob(db, jobId) {
    return db.prepare(JOB_SELECT).get(jobId);
}

function requireCanonicalRow(row, proof) {
    if (!row || row.job_id !== proof.jobId ||
        !samePath(row.file_path, proof.validation.source.path)) {
        throw new Error('canonical VMAF delivery row is missing or inexact');
    }
    if (row.delivery_checkpoint_key !== proof.checkpointKey) {
        throw new Error(
            'canonical VMAF delivery row has the wrong checkpoint key');
    }
    if (Number(row.target_size_reduction_pct) !==
            proof.policy.targetReductionPct ||
        Number(row.minimum_size_reduction_pct) !==
            proof.policy.minimumReductionPct ||
        Number(row.max_final_output_ratio_pct) !==
            proof.policy.maxFinalOutputRatioPct ||
        row.size_policy_version !== proof.policy.version) {
        throw new Error(
            'canonical VMAF delivery row has the wrong 30/20/80 policy');
    }
}

function requirePreterminalRow(row, proof, stage, transactionId) {
    requireCanonicalRow(row, proof);
    if (row.outcome_stage !== stage ||
        row.size_target_status !== 'pending_delivery') {
        throw new Error(
            `canonical VMAF delivery row is not exact ${stage}`);
    }
    for (const field of PRETERMINAL_NULL_FIELDS) {
        if (row[field] !== null) {
            throw new Error(
                `${stage} row requires ${field} to remain NULL`);
        }
    }
    if (stage === 'candidate_ready') {
        if (row.delivery_transaction_id !== null) {
            throw new Error(
                'candidate_ready row already has a transaction id');
        }
    } else if (row.delivery_transaction_id !== transactionId) {
        throw new Error(
            `${stage} row has a different delivery transaction id`);
    }
    return row;
}

function casReserve(db, proof, transactionId, updatedAt) {
    const result = db.prepare(RESERVE_SQL).run(
        transactionId,
        updatedAt,
        proof.jobId,
        proof.validation.source.path,
        proof.checkpointKey,
        proof.policy.targetReductionPct,
        proof.policy.minimumReductionPct,
        proof.policy.maxFinalOutputRatioPct,
        proof.policy.version,
    );
    return Number(result && result.changes || 0);
}

function casDeliveryCommitting(db, proof, transactionId, updatedAt) {
    const result = db.prepare(COMMIT_SQL).run(
        updatedAt,
        proof.jobId,
        proof.validation.source.path,
        transactionId,
        proof.checkpointKey,
        proof.policy.targetReductionPct,
        proof.policy.minimumReductionPct,
        proof.policy.maxFinalOutputRatioPct,
        proof.policy.version,
    );
    return Number(result && result.changes || 0);
}

async function reserveDatabase(db, proof, journal, dependencies) {
    let row = await withDbRetries(
        () => readJob(db, proof.jobId), dependencies);
    if (row && row.outcome_stage === 'replacement_committing') {
        return requirePreterminalRow(
            row, proof, 'replacement_committing',
            journal.transaction_id);
    }
    requirePreterminalRow(row, proof, 'candidate_ready', null);
    const changes = await withDbRetries(
        () => casReserve(
            db, proof, journal.transaction_id,
            new Date().toISOString()),
        dependencies,
    );
    row = await withDbRetries(
        () => readJob(db, proof.jobId), dependencies);
    requirePreterminalRow(
        row, proof, 'replacement_committing',
        journal.transaction_id);
    if (changes !== 1) {
        throw new Error(
            'candidate_ready reservation CAS did not update exactly one row');
    }
    return row;
}

async function commitDatabase(db, proof, journal, dependencies) {
    let row = await withDbRetries(
        () => readJob(db, proof.jobId), dependencies);
    if (row && row.outcome_stage === 'delivery_committing') {
        return requirePreterminalRow(
            row, proof, 'delivery_committing',
            journal.transaction_id);
    }
    requirePreterminalRow(
        row, proof, 'replacement_committing',
        journal.transaction_id);
    const changes = await withDbRetries(
        () => casDeliveryCommitting(
            db, proof, journal.transaction_id,
            new Date().toISOString()),
        dependencies,
    );
    row = await withDbRetries(
        () => readJob(db, proof.jobId), dependencies);
    requirePreterminalRow(
        row, proof, 'delivery_committing',
        journal.transaction_id);
    if (changes !== 1) {
        throw new Error(
            'replacement_committing CAS did not update exactly one row');
    }
    return row;
}

function requireTechnicalFailureRow(row, proof, transactionId) {
    requireCanonicalRow(row, proof);
    if (row.outcome_stage !== 'technical_failure' ||
        row.delivery_transaction_id !== transactionId ||
        row.transcode_succeeded !== 0 ||
        row.size_target_status !== 'not_delivered' ||
        row.final_output_size_mb !== null ||
        row.final_output_ratio_pct !== null ||
        row.actual_size_reduction_pct !== null ||
        row.delivered_at !== null ||
        row.replacement_attestation_version !== null) {
        throw new Error(
            'replacement failure DB read-back is not the exact terminal state');
    }
    return row;
}

async function recordTechnicalFailure(
    db, proof, journal, backupRetained, dependencies) {
    let row = await withDbRetries(
        () => readJob(db, proof.jobId), dependencies);
    if (row && row.outcome_stage === 'delivery_committing') {
        requirePreterminalRow(
            row, proof, 'delivery_committing',
            journal.transaction_id);
        return { terminalized: false, commitBoundaryCrossed: true, row };
    }
    if (row && row.outcome_stage === 'technical_failure') {
        return {
            terminalized: true,
            commitBoundaryCrossed: false,
            row: requireTechnicalFailureRow(
                row, proof, journal.transaction_id),
        };
    }
    requirePreterminalRow(
        row, proof, 'replacement_committing',
        journal.transaction_id);
    const result = await withDbRetries(
        () => db.prepare(FAILURE_SQL).run(
            backupRetained ? 1 : 0,
            'replacement_phase1_failed',
            new Date().toISOString(),
            proof.jobId,
            proof.validation.source.path,
            journal.transaction_id,
            proof.checkpointKey,
            proof.policy.targetReductionPct,
            proof.policy.minimumReductionPct,
            proof.policy.maxFinalOutputRatioPct,
            proof.policy.version,
        ),
        dependencies,
    );
    if (Number(result && result.changes || 0) !== 1) {
        throw new Error(
            'replacement technical-failure CAS did not update exactly one row');
    }
    row = await withDbRetries(
        () => readJob(db, proof.jobId), dependencies);
    return {
        terminalized: true,
        commitBoundaryCrossed: false,
        row: requireTechnicalFailureRow(
            row, proof, journal.transaction_id),
    };
}

function fsyncFile(filePath) {
    const handle = fs.openSync(
        filePath, process.platform === 'win32' ? 'r+' : 'r');
    try {
        fs.fsyncSync(handle);
    } finally {
        fs.closeSync(handle);
    }
}

function fsyncDirectory(directory) {
    let handle;
    try {
        handle = fs.openSync(directory, 'r');
        fs.fsyncSync(handle);
    } catch (error) {
        const windowsUnsupported = new Set([
            'EACCES', 'EBADF', 'EINVAL', 'EISDIR',
            'ENOTSUP', 'EPERM',
        ]);
        if (process.platform !== 'win32' || !error ||
            !windowsUnsupported.has(error.code)) {
            throw error;
        }
    } finally {
        if (handle !== undefined) fs.closeSync(handle);
    }
}

function exclusiveLinkOrCopy(
    source, destination, onCreated, label) {
    let method = 'hard_link';
    try {
        fs.linkSync(source, destination);
        onCreated();
    } catch (error) {
        if (error && error.code === 'EEXIST') {
            throw new Error(`${label} already exists; refusing to overwrite it`);
        }
        const fallbackCodes = new Set([
            'EACCES', 'EMLINK', 'ENOSYS', 'ENOTSUP',
            'EOPNOTSUPP', 'EPERM', 'EXDEV',
        ]);
        if (!error || !fallbackCodes.has(error.code)) throw error;
        method = 'exclusive_copy';
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        onCreated();
    }
    fsyncFile(destination);
    fsyncDirectory(path.dirname(destination));
    return method;
}

function stageCandidate(source, destination, onCreated) {
    fs.copyFileSync(
        source, destination, fs.constants.COPYFILE_EXCL);
    onCreated();
    fsyncFile(destination);
    fsyncDirectory(path.dirname(destination));
    return inspect(destination);
}

function exclusiveCopy(source, destination, onCreated, label) {
    try {
        fs.copyFileSync(
            source, destination, fs.constants.COPYFILE_EXCL);
    } catch (error) {
        if (error && error.code === 'EEXIST') {
            throw new Error(
                `${label} already exists; refusing to overwrite it`);
        }
        throw error;
    }
    onCreated();
    fsyncFile(destination);
    fsyncDirectory(path.dirname(destination));
    return 'exclusive_copy';
}

function removeInstallTemporary(paths) {
    if (!exactPathExists(paths.installTemp)) return false;
    fs.unlinkSync(paths.installTemp);
    fsyncDirectory(path.dirname(paths.installTemp));
    if (exactPathExists(paths.installTemp)) {
        throw new Error(
            'reserved .partial.new remained after cleanup');
    }
    return true;
}

function installCandidateAtomically(
    source,
    temporary,
    destination,
    onPublished,
    label,
    expectedSource,
    expectedCandidate,
    operations,
) {
    operations = operations || {};
    const copyFileSync = operations.copyFileSync ||
        fs.copyFileSync.bind(fs);
    const renameSync = operations.renameSync || fs.renameSync.bind(fs);
    const destinationDirectory = path.dirname(destination);
    if (!samePath(path.dirname(temporary), destinationDirectory) ||
        !samePath(temporary, `${destination}${INSTALL_SUFFIX}`)) {
        throw new Error(
            `${label} temporary path must be the reserved destination sibling`);
    }
    if (!exactPathExists(temporary)) {
        try {
            copyFileSync(
                source, temporary, fs.constants.COPYFILE_EXCL);
        } catch (error) {
            if (error && error.code === 'EEXIST') {
                throw new Error(
                    `${label} .partial.new already exists; refusing to overwrite it`);
            }
            throw error;
        }
    }
    fsyncFile(temporary);
    const prepared = inspect(temporary);
    assertContent(
        expectedCandidate, prepared.identity,
        `${label} prepared candidate`);
    if (exactPathExists(destination)) {
        const occupant = inspect(destination);
        assertSourceForAtomicPublish(
            expectedSource,
            occupant,
            `${label} original immediately before atomic publish`,
        );
    }
    fsyncDirectory(destinationDirectory);
    renameSync(temporary, destination);
    onPublished();
    fsyncDirectory(destinationDirectory);
    const installed = inspect(destination);
    assertContent(
        expectedCandidate, installed.identity,
        `${label} installed candidate`);
    return installed;
}

function assertOriginalAfterBackup(sourceProof, currentSource, backup) {
    assertContent(sourceProof, currentSource.identity,
        'original after backup creation');
    assertContent(sourceProof, backup.identity,
        'durable original backup');
    for (const field of ['dev', 'ino', 'size_bytes', 'mtime_ns']) {
        if (String(sourceProof[field]) !==
            String(currentSource.identity[field])) {
            throw new Error(
                `original ${field} changed while the backup was created`);
        }
    }
}

function assertSourceForAtomicPublish(sourceProof, currentSource, label) {
    assertContent(sourceProof, currentSource.identity, label);
    if (!samePath(sourceProof.path, currentSource.path)) {
        throw new Error(`${label} path changed after validation`);
    }
    for (const field of ['dev', 'ino', 'size_bytes', 'mtime_ns']) {
        if (String(sourceProof[field]) !==
            String(currentSource.identity[field])) {
            throw new Error(`${label} ${field} changed after backup`);
        }
    }
}

function restoreOriginalSafely(paths, journal, state) {
    if (!exactPathExists(paths.backup)) {
        throw new Error(
            'exact retained backup is missing; automatic restoration refused');
    }
    const backup = inspect(paths.backup);
    assertContent(journal.source, backup.identity,
        'retained backup used for restoration');
    if (exactPathExists(paths.original)) {
        const occupant = inspect(paths.original);
        if (String(occupant.identity.sha256_full) ===
                String(journal.source.sha256_full) &&
            Number(occupant.identity.size_bytes) ===
                Number(journal.source.size_bytes) &&
            String(occupant.identity.mtime_ns) ===
                String(journal.source.mtime_ns)) {
            return { restored: true, alreadyOriginal: true, backup };
        }
        if (!state.installedByUs ||
            !state.installedIdentity ||
            String(occupant.identity.sha256_full) !==
                String(state.installedIdentity.sha256_full) ||
            Number(occupant.identity.size_bytes) !==
                Number(state.installedIdentity.size_bytes)) {
            throw new Error(
                'original path has ambiguous bytes; automatic deletion refused');
        }
        if (!exactPathExists(paths.temp)) {
            throw new Error(
                'installed candidate has no preserved stage; automatic deletion refused');
        }
        const staged = inspect(paths.temp);
        assertContent(journal.candidate, staged.identity,
            'preserved candidate stage');
        fs.unlinkSync(paths.original);
        fsyncDirectory(path.dirname(paths.original));
    }
    let restoredCreated = false;
    exclusiveLinkOrCopy(
        paths.backup,
        paths.original,
        () => { restoredCreated = true; },
        'restored original',
    );
    if (!restoredCreated) {
        throw new Error('original restoration did not create its target');
    }
    const restored = inspect(paths.original);
    assertContent(journal.source, restored.identity,
        'restored original');
    return { restored: true, alreadyOriginal: false, backup, restoredFile: restored };
}

function requireJournalBinding(journal, proof) {
    if (!journal ||
        journal.job_id !== proof.jobId ||
        journal.checkpoint_key !== proof.checkpointKey ||
        deliveryTransaction.canonicalJson(
            journal.pending_proof && journal.pending_proof.evidence) !==
            deliveryTransaction.canonicalJson(proof.pending) ||
        deliveryTransaction.canonicalJson(
            journal.candidate_validation &&
                journal.candidate_validation.evidence) !==
            deliveryTransaction.canonicalJson(proof.validation)) {
        throw new Error(
            'delivery transaction differs from the current exact proofs');
    }
    return journal;
}

function getExistingJournal(proof) {
    const location = deliveryTransaction.location(
        proof.checkpointRecord);
    if (!exactPathExists(location.journalPath)) return null;
    const structural = deliveryTransaction.validate(
        proof.checkpointRecord,
        undefined,
        { verifyCurrentFiles: false },
    );
    if (!structural.valid) {
        throw new Error(structural.reason);
    }
    let journal = requireJournalBinding(
        structural.journal, proof);
    if (journal.state !== 'reserved') {
        journal = requireJournalBinding(
            deliveryTransaction.load(proof.checkpointRecord),
            proof,
        );
    }
    return journal;
}

function inspectOptional(filePath) {
    if (!exactPathExists(filePath)) return null;
    return inspect(filePath);
}

function inspectInstallTemporary(filePath) {
    if (!exactPathExists(filePath)) return null;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
            'reserved .partial.new is not a regular file');
    }
    if (stat.size === 0) {
        return {
            path: path.resolve(filePath),
            identity: { size_bytes: 0, sha256_full: '' },
        };
    }
    return inspect(filePath);
}

function fullIdentityMatches(expected, inspected) {
    if (!inspected) return false;
    try {
        assertIdentity(expected, inspectedIdentity(inspected),
            'reserved filesystem object');
        return true;
    } catch (_) {
        return false;
    }
}

function contentMatches(expected, inspected) {
    if (!inspected) return false;
    try {
        assertContent(expected, inspected.identity,
            'reserved filesystem object');
        return true;
    } catch (_) {
        return false;
    }
}

function classifyReservedFilesystem(paths, journal) {
    const current = inspectOptional(paths.current);
    const original = inspectOptional(paths.original);
    const temp = inspectOptional(paths.temp);
    const installTemp = inspectInstallTemporary(paths.installTemp);
    const backup = inspectOptional(paths.backup);
    if (!fullIdentityMatches(journal.candidate, current)) {
        throw new Error(
            'reserved transaction candidate is missing or changed');
    }
    const tempIsCandidate = contentMatches(journal.candidate, temp);
    const installTempIsCandidate =
        contentMatches(journal.candidate, installTemp);
    const backupIsSource = contentMatches(journal.source, backup);
    const originalIsExactSource =
        fullIdentityMatches(journal.source, original);
    const originalIsSource =
        contentMatches(journal.source, original);
    const originalIsCandidate =
        contentMatches(journal.candidate, original);

    let phase;
    if (originalIsExactSource && !temp && !installTemp && !backup) {
        phase = 'clean';
    } else if (originalIsExactSource && tempIsCandidate &&
        !installTemp && !backup) {
        phase = 'staged';
    } else if (originalIsSource && tempIsCandidate &&
        !installTemp && backupIsSource) {
        phase = 'backed_up';
    } else if ((originalIsSource || !original) && tempIsCandidate &&
        installTemp && backupIsSource) {
        phase = installTempIsCandidate
            ? 'install_ready'
            : 'install_copying';
    } else if (!original && tempIsCandidate &&
        !installTemp && backupIsSource) {
        phase = 'original_unlinked';
    } else if (originalIsCandidate &&
        tempIsCandidate && !installTemp && backupIsSource) {
        phase = 'installed';
    } else {
        throw new Error(
            'reserved delivery transaction has an ambiguous filesystem state');
    }
    return {
        phase,
        current,
        original,
        temp,
        installTemp,
        backup,
    };
}

function publishJournal(variables, journal) {
    variables.vmafDeliveryTransactionId = journal.transaction_id;
    variables.vmafDeliveryTransactionState = journal.state;
    variables.vmafDeliveryTransaction = {
        schema: journal.schema,
        version: journal.version,
        transaction_id: journal.transaction_id,
        job_id: journal.job_id,
        checkpoint_key: journal.checkpoint_key,
        state: journal.state,
        revision: journal.revision,
    };
}

function publishReplacement(variables, journal) {
    const evidence = journal.replacement &&
        journal.replacement.evidence;
    if (!evidence) {
        throw new Error(
            'delivery transaction has no replacement attestation');
    }
    variables.vmafReplacementAttestation = evidence;
    variables.vmafReplacementCompleted = true;
    variables.vmafReplacementBackupRetained = true;
    variables.vmafReplacementStatus = 'backup_retained';
    publishJournal(variables, journal);
}

function markPending(variables) {
    delete variables.vmafReplacementAttestation;
    variables.vmafReplacementCompleted = false;
    variables.vmafReplacementBackupRetained = false;
    variables.vmafReplacementStatus = 'pending';
    delete variables.vmafReplacementFailureReason;
}

function registerTemporaryFile(variables, filePath) {
    if (!Array.isArray(variables.vmafTemporaryFiles)) {
        variables.vmafTemporaryFiles = [];
    }
    if (!variables.vmafTemporaryFiles.some(
        (entry) => samePath(entry, filePath))) {
        variables.vmafTemporaryFiles.push(filePath);
    }
}

function unregisterTemporaryFile(variables, filePath) {
    if (!Array.isArray(variables.vmafTemporaryFiles)) return;
    variables.vmafTemporaryFiles =
        variables.vmafTemporaryFiles.filter(
            (entry) => !samePath(entry, filePath));
}

function fatal(error, variables, state) {
    const reason = String(error && error.message || error);
    delete variables.vmafReplacementAttestation;
    variables.vmafReplacementCompleted = false;
    variables.vmafReplacementBackupRetained =
        state.backupCreated === true;
    variables.vmafReplacementStatus = state.restored
        ? 'failed_keep_original'
        : (state.dbDeliveryCommitted
            ? 'installed_pending_finalize'
            : 'failed_recovery_required');
    variables.vmafReplacementFailureReason = reason;
    const failure = new Error(
        `attested replacement phase 1 failed: ${reason}`);
    failure.code = 'TDARR_VMAF_REPLACEMENT_PHASE1_FATAL';
    failure.cause = error;
    return failure;
}

async function replaceOriginal(args, dependencies) {
    dependencies = dependencies || {};
    args.variables = args.variables || {};
    const variables = args.variables;
    markPending(variables);
    const state = {
        backupCreated: false,
        stageCreated: false,
        installedByUs: false,
        installedIdentity: null,
        dbReserved: false,
        commitAttempted: false,
        dbDeliveryCommitted: false,
        commitBoundaryUnknown: false,
        restored: false,
    };
    let proof;
    let journal;
    let db;
    let paths;
    try {
        proof = requireCanonicalProof(args);
        journal = getExistingJournal(proof);
        if (!journal) {
            const bound = inspectAndBindCurrentFiles(proof);
            paths = pathPlan(bound.source.path, bound.candidate.path);
            assertFreshMutationPaths(paths);
            journal = deliveryTransaction.create(
                proof.checkpointRecord,
                {
                    jobId: proof.jobId,
                    pendingProof: proof.pending,
                    candidateValidation: proof.validation,
                },
            );
            requireJournalBinding(journal, proof);
        } else {
            paths = pathPlan(
                journal.source.path, journal.candidate.path);
            assertPairwisePathSeparation(paths);
        }
        publishJournal(variables, journal);

        const vmafdb = dependencies.vmafdb ||
            (!dependencies.db
                ? require(
                    '/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js')
                : null);
        db = dependencies.db || vmafdb.openDb();

        if (journal.state === 'delivered') {
            throw new Error(
                'delivery transaction is already delivered; replacement will not run again');
        }
        if (journal.state === 'delivery_committing') {
            requirePreterminalRow(
                await withDbRetries(
                    () => readJob(db, proof.jobId), dependencies),
                proof,
                'delivery_committing',
                journal.transaction_id,
            );
            publishReplacement(variables, journal);
            return {
                outputFileObj: { _id: journal.source.path },
                outputNumber: 2,
                variables,
            };
        }
        if (journal.state === 'installed_pending_finalize') {
            state.backupCreated = true;
            state.installedByUs = true;
            state.installedIdentity =
                inspect(journal.source.path).identity;
            state.dbReserved = true;
            if (!variables.vmafDeliveryCandidateValidationConsumedAt) {
                variables.vmafDeliveryCandidateValidationConsumedAt =
                    proof.validation.validated_at;
            }
            publishReplacement(variables, journal);
            state.commitAttempted = true;
            await commitDatabase(db, proof, journal, dependencies);
            state.dbDeliveryCommitted = true;
            journal = deliveryTransaction.transition(
                proof.checkpointRecord,
                'installed_pending_finalize',
                'delivery_committing',
            );
            publishReplacement(variables, journal);
            return {
                outputFileObj: { _id: journal.source.path },
                outputNumber: 2,
                variables,
            };
        }
        if (journal.state !== 'reserved') {
            throw new Error(
                `unsupported delivery transaction state ${journal.state}`);
        }

        await reserveDatabase(db, proof, journal, dependencies);
        state.dbReserved = true;
        let filesystem = classifyReservedFilesystem(
            paths, journal);
        state.stageCreated = Boolean(filesystem.temp);
        state.backupCreated = Boolean(filesystem.backup);
        if (filesystem.temp) {
            registerTemporaryFile(variables, paths.temp);
        }
        if (filesystem.installTemp) {
            registerTemporaryFile(variables, paths.installTemp);
        }
        if (filesystem.phase === 'installed') {
            state.installedByUs = true;
            state.installedIdentity =
                filesystem.original.identity;
        }
        if (!variables.vmafDeliveryCandidateValidationConsumedAt) {
            variables.vmafDeliveryCandidateValidationConsumedAt =
                filesystem.phase === 'clean'
                    ? new Date().toISOString()
                    : proof.validation.validated_at;
        }

        if (filesystem.phase === 'clean') {
            inspectAndBindCurrentFiles(proof);
            const journalCheck = deliveryTransaction.validate(
                proof.checkpointRecord,
                journal,
                { verifyCurrentFiles: true },
            );
            if (!journalCheck.valid) {
                throw new Error(journalCheck.reason);
            }
            const stageOperation = dependencies.stageCandidate ||
                stageCandidate;
            registerTemporaryFile(variables, paths.temp);
            const staged = stageOperation(
                paths.current,
                paths.temp,
                () => { state.stageCreated = true; },
            );
            assertContent(
                journal.candidate, staged.identity,
                'staged delivery candidate');
            filesystem = classifyReservedFilesystem(
                paths, journal);
        }

        if (filesystem.phase === 'staged') {
            const sourceImmediatelyBeforeBackup =
                inspect(paths.original);
            assertIdentity(
                proof.validation.source,
                inspectedIdentity(sourceImmediatelyBeforeBackup),
                'original immediately before backup');
            const backupOperation = dependencies.createBackup ||
                ((source, destination, onCreated) =>
                    exclusiveLinkOrCopy(
                        source, destination, onCreated,
                        'exact original backup'));
            backupOperation(
                paths.original,
                paths.backup,
                () => { state.backupCreated = true; },
            );
            const backup = inspect(paths.backup);
            const sourceAfterBackup = inspect(paths.original);
            assertOriginalAfterBackup(
                journal.source, sourceAfterBackup, backup);
            filesystem = classifyReservedFilesystem(
                paths, journal);
        }

        if (filesystem.phase === 'install_copying') {
            removeInstallTemporary(paths);
            unregisterTemporaryFile(variables, paths.installTemp);
            filesystem = classifyReservedFilesystem(
                paths, journal);
        }

        if (['backed_up', 'original_unlinked', 'install_ready'].includes(
            filesystem.phase)) {
            const installOperation = dependencies.installCandidate ||
                ((source, temporary, destination, onPublished) =>
                    installCandidateAtomically(
                        source,
                        temporary,
                        destination,
                        onPublished,
                        'replacement target',
                        journal.source,
                        journal.candidate,
                    ));
            registerTemporaryFile(variables, paths.installTemp);
            const installed = installOperation(
                paths.temp,
                paths.installTemp,
                paths.target,
                () => {
                    state.installedByUs = true;
                    state.installedIdentity = journal.candidate;
                },
            );
            unregisterTemporaryFile(variables, paths.installTemp);
            state.installedIdentity = installed.identity;
            assertContent(
                journal.candidate, installed.identity,
                'installed delivery candidate');
            filesystem = classifyReservedFilesystem(
                paths, journal);
        }
        if (filesystem.phase !== 'installed') {
            throw new Error(
                `replacement did not reach installed state: ${filesystem.phase}`);
        }
        state.installedByUs = true;
        state.installedIdentity =
            filesystem.original.identity;

        const replacementAttestation =
            postReplaceAttestation.create({
                targetPath: paths.target,
                originalPath: paths.original,
                checkpointKey: proof.checkpointKey,
                backupRetained: true,
            });
        journal = deliveryTransaction.transition(
            proof.checkpointRecord,
            'reserved',
            'installed_pending_finalize',
            { replacementAttestation },
        );
        publishReplacement(variables, journal);

        state.commitAttempted = true;
        await commitDatabase(db, proof, journal, dependencies);
        state.dbDeliveryCommitted = true;
        journal = deliveryTransaction.transition(
            proof.checkpointRecord,
            'installed_pending_finalize',
            'delivery_committing',
        );
        publishReplacement(variables, journal);

        try {
            const stageNow = inspect(paths.temp);
            assertContent(
                journal.candidate, stageNow.identity,
                'completed replacement stage');
            const removeStage = dependencies.removeStage ||
                fs.unlinkSync.bind(fs);
            removeStage(paths.temp);
            fsyncDirectory(path.dirname(paths.temp));
            if (exactPathExists(paths.temp)) {
                throw new Error(
                    'authenticated replacement stage remained after unlink');
            }
            unregisterTemporaryFile(variables, paths.temp);
            variables.vmafReplacementStagingRetained = false;
        } catch (cleanupError) {
            variables.vmafReplacementStagingRetained = true;
            variables.vmafReplacementStagingCleanupWarning =
                String(cleanupError.message || cleanupError);
            args.jobLog(
                'WARNING: Exact delivery stage remains for bounded cleanup: ' +
                variables.vmafReplacementStagingCleanupWarning);
        }
        args.jobLog(
            'Replacement phase 1 committed: installed candidate and exact ' +
            '.partial.old backup are attested; finalizer must retire the backup.');
        return {
            outputFileObj: { _id: paths.target },
            outputNumber: 2,
            variables,
        };
    } catch (error) {
        let recoveryError = null;
        if (paths && exactPathExists(paths.installTemp)) {
            try {
                removeInstallTemporary(paths);
                unregisterTemporaryFile(variables, paths.installTemp);
            } catch (cleanupError) {
                recoveryError = cleanupError;
            }
        }
        if (paths && exactPathExists(paths.backup)) {
            state.backupCreated = true;
        }
        if (state.dbReserved && state.commitAttempted &&
            !state.dbDeliveryCommitted) {
            try {
                const boundaryRow = await withDbRetries(
                    () => readJob(db, proof.jobId), dependencies);
                if (boundaryRow &&
                    boundaryRow.outcome_stage ===
                        'delivery_committing') {
                    requirePreterminalRow(
                        boundaryRow,
                        proof,
                        'delivery_committing',
                        journal.transaction_id,
                    );
                    state.dbDeliveryCommitted = true;
                } else {
                    requirePreterminalRow(
                        boundaryRow,
                        proof,
                        'replacement_committing',
                        journal.transaction_id,
                    );
                }
            } catch (boundaryError) {
                state.commitBoundaryUnknown = true;
                recoveryError = new Error(
                    `delivery DB commit boundary is uncertain: ${boundaryError.message}`);
            }
        }
        if (state.dbReserved && !state.dbDeliveryCommitted) {
            if (!state.commitBoundaryUnknown &&
                state.backupCreated) {
                try {
                    restoreOriginalSafely(
                        paths, journal, state);
                    state.restored = true;
                } catch (restoreError) {
                    recoveryError = restoreError;
                    args.jobLog(
                        'FATAL: exact original restoration requires manual recovery: ' +
                        restoreError.message);
                }
            } else if (!state.commitBoundaryUnknown &&
                paths && exactPathExists(paths.original)) {
                try {
                    const original = inspect(paths.original);
                    assertContent(
                        journal.source, original.identity,
                        'preserved original');
                    state.restored = true;
                } catch (preserveError) {
                    recoveryError = preserveError;
                }
            }
            if (state.restored && !state.commitBoundaryUnknown) {
                try {
                    await recordTechnicalFailure(
                        db, proof, journal,
                        state.backupCreated, dependencies);
                } catch (dbFailure) {
                    recoveryError = recoveryError
                        ? new Error(
                            `${recoveryError.message}; terminal DB recording failed: ${dbFailure.message}`)
                        : dbFailure;
                }
            }
        }
        const combined = recoveryError
            ? new Error(
                `${error.message}; recovery warning: ${recoveryError.message}`)
            : error;
        args.jobLog(
            'FATAL: attested replacement phase 1 stopped fail-closed: ' +
            combined.message +
            '. Exact backup/checkpoint/journal evidence was not deleted.');
        throw fatal(combined, variables, state);
    }
}

const details = () => ({
    name: 'Replace Original File (Attested Phase 1)',
    description: [
        'Authenticates the candidate-ready DB row, protected checkpoint, and exact 30/20/80 proof.',
        'Installs at the canonical original path with exclusive filesystem operations.',
        'Always retains and attests the exact .partial.old backup for the finalizer.',
    ].join(' '),
    style: { borderColor: 'green' },
    tags: 'video,vmaf,replacement,transaction,safety',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faArrowRight',
    inputs: [],
    outputs: [
        { number: 1, tooltip: 'Unused legacy route' },
        {
            number: 2,
            tooltip: 'Installed, journaled, DB committing, exact backup retained',
        },
        { number: 3, tooltip: 'Unused legacy keep-original route' },
    ],
});
exports.details = details;

const plugin = async (args) => {
    const lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    args.jobLog('=== Replace Original File: Attested Phase 1 ===');
    return replaceOriginal(args);
};
exports.plugin = plugin;
exports._test = {
    PENDING_SCHEMA,
    VALIDATION_SCHEMA,
    STAGE_SUFFIX,
    INSTALL_SUFFIX,
    DB_RETRY_DELAYS_MS,
    JOB_SELECT,
    RESERVE_SQL,
    COMMIT_SQL,
    FAILURE_SQL,
    pathKey,
    samePath,
    pathPlan,
    assertPairwisePathSeparation,
    assertFreshMutationPaths,
    requireCanonicalProof,
    inspectAndBindCurrentFiles,
    isBusyError,
    withDbRetries,
    requireCanonicalRow,
    requirePreterminalRow,
    casReserve,
    casDeliveryCommitting,
    reserveDatabase,
    commitDatabase,
    recordTechnicalFailure,
    fsyncFile,
    fsyncDirectory,
    exclusiveLinkOrCopy,
    exclusiveCopy,
    removeInstallTemporary,
    installCandidateAtomically,
    stageCandidate,
    restoreOriginalSafely,
    requireJournalBinding,
    getExistingJournal,
    classifyReservedFilesystem,
    registerTemporaryFile,
    unregisterTemporaryFile,
    replaceOriginal,
};
