'use strict';

const fs = require('fs');
const path = require('path');
const deliveryPolicy = require('./deliveryPolicy.js');
const postReplaceAttestation = require('./postReplaceAttestation.js');

const SCHEMA = 'vmaf-delivery-finalization/v2';
const VERSION = 2;
const STATUS = 'delivered';
const CANDIDATE_VALIDATION_SCHEMA = 'vmaf-delivery-candidate-validation/v1';
const BACKUP_DISPOSITIONS = Object.freeze({
    backup_removed: true,
    backup_retained: true,
});
const REQUIRED_TARGET_REDUCTION_PCT = 30;
const REQUIRED_MINIMUM_REDUCTION_PCT = 20;
const REQUIRED_MAX_OUTPUT_RATIO_PCT = 80;
const FLOAT_TOLERANCE = 0.000000001;

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

function requireContentIdentity(identity, label) {
    if (!identity || typeof identity !== 'object' ||
        Array.isArray(identity)) {
        throw new Error(`${label} is missing`);
    }
    const keys = Object.keys(identity).sort();
    if (keys.length !== 2 ||
        keys[0] !== 'sha256_full' || keys[1] !== 'size_bytes') {
        throw new Error(`${label} has unsupported fields`);
    }
    const sizeBytes = positiveSafeInteger(
        identity.size_bytes, `${label} byte count`);
    const sha256Full = String(identity.sha256_full || '');
    if (!/^[0-9a-f]{64}$/.test(sha256Full)) {
        throw new Error(`${label} full SHA-256 is invalid`);
    }
    return {
        size_bytes: sizeBytes,
        sha256_full: sha256Full,
    };
}

function requireExactPolicy(policy) {
    if (!policy || policy.version !== deliveryPolicy.POLICY_VERSION ||
        typeof policy.targetReductionPct !== 'number' ||
        policy.targetReductionPct !== REQUIRED_TARGET_REDUCTION_PCT ||
        typeof policy.minimumReductionPct !== 'number' ||
        policy.minimumReductionPct !== REQUIRED_MINIMUM_REDUCTION_PCT ||
        typeof policy.maxFinalOutputRatioPct !== 'number' ||
        policy.maxFinalOutputRatioPct !== REQUIRED_MAX_OUTPUT_RATIO_PCT) {
        throw new Error('delivery finalization requires the exact current 30/20/80 size policy');
    }
    return policy;
}

function requireInstalledIdentity(expected, actual) {
    if (!expected || typeof expected !== 'object') {
        throw new Error('delivery finalization installed identity is missing');
    }
    postReplaceAttestation.assertIdentityMatches(
        expected, actual, 'delivery finalization installed file');
}

function replacementContract(attestation) {
    return `${attestation.schema}/v${attestation.version}`;
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

function requireBackupDisposition(evidence, replacement, context) {
    const disposition = String(evidence.backup_disposition || '');
    if (BACKUP_DISPOSITIONS[disposition] !== true) {
        throw new Error('delivery finalization backup disposition is invalid');
    }
    const retained = disposition === 'backup_retained';
    if (evidence.replacement_backup_retained !== retained) {
        throw new Error('delivery finalization backup-retained flag is inconsistent');
    }
    const backupPath = postReplaceAttestation.exactBackupPath(context.originalPath);
    if (!replacement.backup_path ||
        !samePath(replacement.backup_path, backupPath) ||
        !samePath(evidence.replacement_backup_path, backupPath)) {
        throw new Error('delivery finalization backup path is not the exact attested backup');
    }
    if (retained) {
        const retainedProof = postReplaceAttestation.validate(replacement, {
            checkpointRecord: context.checkpointRecord,
            inputPath: context.inputPath,
            originalPath: context.originalPath,
            requireRetainedBackup: true,
        });
        if (!retainedProof.valid) {
            throw new Error(`retained replacement backup is invalid: ${retainedProof.reason}`);
        }
    } else if (exactPathExists(backupPath)) {
        throw new Error('delivery finalization says backup removed but the exact backup still exists');
    }
    return disposition;
}

function validateOrThrow(evidence, context) {
    if (!evidence || typeof evidence !== 'object' ||
        evidence.schema !== SCHEMA || evidence.version !== VERSION ||
        evidence.status !== STATUS || evidence.database_recorded !== true) {
        throw new Error('missing or unsupported completed delivery finalization');
    }
    const checkpointRecord = context && context.checkpointRecord;
    const checkpointKey = checkpointRecord &&
        String(checkpointRecord.checkpoint_key || '');
    if (!checkpointKey || evidence.checkpoint_key !== checkpointKey) {
        throw new Error('delivery finalization is not bound to this checkpoint');
    }
    const inputPath = context && context.inputPath;
    const originalPath = context && context.originalPath;
    if (!inputPath || !samePath(evidence.installed_path, inputPath)) {
        throw new Error('delivery finalization installed path differs from flow input');
    }
    if (!originalPath || !path.isAbsolute(String(originalPath))) {
        throw new Error('delivery finalization original path is missing or not absolute');
    }
    if (!String(evidence.job_id || '').trim()) {
        throw new Error('delivery finalization canonical job id is missing');
    }
    if (!/^[0-9a-f]{64}$/.test(
        String(evidence.delivery_transaction_id || ''))) {
        throw new Error('delivery finalization transaction id is invalid');
    }
    if (evidence.candidate_validation_schema !== CANDIDATE_VALIDATION_SCHEMA) {
        throw new Error('delivery finalization candidate-validation provenance is invalid');
    }
    if (!Number.isFinite(Date.parse(String(evidence.delivered_at || '')))) {
        throw new Error('delivery finalization delivered timestamp is invalid');
    }

    const policy = requireExactPolicy({
        version: evidence.policy_version,
        targetReductionPct: finiteNumber(evidence.target_size_reduction_pct,
            'delivery finalization target reduction'),
        minimumReductionPct: finiteNumber(evidence.minimum_size_reduction_pct,
            'delivery finalization minimum reduction'),
        maxFinalOutputRatioPct: finiteNumber(evidence.max_final_output_ratio_pct,
            'delivery finalization maximum output ratio'),
    });
    const installed = postReplaceAttestation.inspectInstalledFile(inputPath);
    requireInstalledIdentity(evidence.installed_identity, installed.identity);
    const sourceSize = positiveSafeInteger(
        evidence.source_size_bytes, 'delivery finalization source byte count');
    const assessment = deliveryPolicy.evaluateBytes(
        installed.identity.size_bytes, sourceSize, policy);
    if (!assessment.accepted) {
        throw new Error('delivery finalization installed file exceeds the delivered-size cap');
    }
    const deliveredBytes = positiveSafeInteger(
        evidence.delivered_size_bytes, 'delivery finalization delivered byte count');
    const ratio = finiteNumber(
        evidence.final_output_ratio_pct, 'delivery finalization output ratio');
    const reduction = finiteNumber(
        evidence.actual_size_reduction_pct, 'delivery finalization actual reduction');
    const sizeMb = finiteNumber(
        evidence.final_output_size_mb, 'delivery finalization output size');
    if (deliveredBytes !== assessment.outputBytes ||
        Math.abs(ratio - assessment.ratioPct) > FLOAT_TOLERANCE ||
        Math.abs(reduction - assessment.actualReductionPct) > FLOAT_TOLERANCE ||
        Math.abs(sizeMb - assessment.outputBytes / (1024 * 1024)) >
            FLOAT_TOLERANCE) {
        throw new Error('delivery finalization size evidence differs from the installed file');
    }

    const replacement = context && context.replacementAttestation;
    const replacementProof = postReplaceAttestation.validate(replacement, {
        checkpointRecord,
        inputPath,
        originalPath,
    });
    if (!replacementProof.valid ||
        replacement.version !== postReplaceAttestation.VERSION ||
        replacement.outcome !== 'backup_retained' ||
        !replacement.backup) {
        throw new Error('delivery finalization requires a current installed-and-backup attestation');
    }
    const sourceIdentity = requireContentIdentity(
        evidence.source_identity, 'delivery finalization source identity');
    const replacementSourceIdentity = requireContentIdentity({
        size_bytes: replacement.backup.size_bytes,
        sha256_full: replacement.backup.sha256_full,
    }, 'replacement backup content identity');
    if (sourceSize !== sourceIdentity.size_bytes ||
        sourceIdentity.size_bytes !== replacementSourceIdentity.size_bytes ||
        sourceIdentity.sha256_full !== replacementSourceIdentity.sha256_full) {
        throw new Error(
            'delivery finalization source identity differs from the attested original backup');
    }
    const replacementInstalledBytes = positiveSafeInteger(
        replacement.installed && replacement.installed.size_bytes,
        'replacement installed byte count');
    if (deliveredBytes !== replacementInstalledBytes) {
        throw new Error(
            'delivery finalization delivered byte count differs from the replacement attestation');
    }
    postReplaceAttestation.assertIdentityMatches(
        evidence.installed_identity,
        replacement.installed,
        'delivery finalization replacement-installed file');
    const contract = replacementContract(replacement);
    if (evidence.replacement_attestation_schema !== replacement.schema ||
        evidence.replacement_attestation_version !== replacement.version ||
        evidence.replacement_attestation_contract !== contract) {
        throw new Error('delivery finalization replacement provenance differs from its attestation');
    }
    const disposition = requireBackupDisposition(evidence, replacement, {
        checkpointRecord,
        inputPath,
        originalPath,
    });
    return {
        evidence,
        installed,
        assessment,
        policy,
        replacementProof,
        backupDisposition: disposition,
    };
}

function validate(evidence, context) {
    try {
        const result = validateOrThrow(evidence, context);
        return {
            valid: true,
            reason: null,
            installedPath: result.installed.path,
            assessment: result.assessment,
            backupDisposition: result.backupDisposition,
        };
    } catch (error) {
        return {
            valid: false,
            reason: `delivery finalization verification failed: ${error.message}`,
        };
    }
}

function create(input) {
    const policy = requireExactPolicy(input.policy);
    const installed = postReplaceAttestation.inspectInstalledFile(input.installedPath);
    const sourceSize = positiveSafeInteger(input.sourceSizeBytes,
        'delivery finalization source byte count');
    const assessment = deliveryPolicy.evaluateBytes(
        installed.identity.size_bytes, sourceSize, policy);
    if (!assessment.accepted) {
        throw new Error('refusing to create finalization for a delivery above the size cap');
    }
    const replacement = input.replacementAttestation;
    const sourceIdentity = requireContentIdentity({
        size_bytes: replacement && replacement.backup &&
            replacement.backup.size_bytes,
        sha256_full: replacement && replacement.backup &&
            replacement.backup.sha256_full,
    }, 'replacement backup content identity');
    if (sourceSize !== sourceIdentity.size_bytes) {
        throw new Error(
            'delivery finalization source byte count differs from the attested original backup');
    }
    const evidence = {
        schema: SCHEMA,
        version: VERSION,
        status: STATUS,
        delivered_at: String(input.deliveredAt || ''),
        job_id: String(input.jobId || ''),
        delivery_transaction_id: String(input.transactionId || ''),
        policy_version: policy.version,
        target_size_reduction_pct: policy.targetReductionPct,
        minimum_size_reduction_pct: policy.minimumReductionPct,
        max_final_output_ratio_pct: policy.maxFinalOutputRatioPct,
        source_size_bytes: assessment.sourceBytes,
        source_identity: sourceIdentity,
        delivered_size_bytes: assessment.outputBytes,
        final_output_size_mb: assessment.outputBytes / (1024 * 1024),
        final_output_ratio_pct: assessment.ratioPct,
        actual_size_reduction_pct: assessment.actualReductionPct,
        installed_path: installed.path,
        installed_identity: Object.assign({}, installed.identity),
        candidate_validation_schema: String(input.candidateValidationSchema || ''),
        replacement_attestation_schema: replacement && replacement.schema,
        replacement_attestation_version: replacement && replacement.version,
        replacement_attestation_contract: replacement && replacementContract(replacement),
        replacement_backup_path: replacement && replacement.backup_path,
        backup_disposition: String(input.backupDisposition || ''),
        replacement_backup_retained:
            String(input.backupDisposition || '') === 'backup_retained',
        checkpoint_key: input.checkpointRecord &&
            String(input.checkpointRecord.checkpoint_key || ''),
        database_recorded: input.databaseRecorded === true,
    };
    validateOrThrow(evidence, {
        checkpointRecord: input.checkpointRecord,
        inputPath: input.installedPath,
        originalPath: input.originalPath,
        replacementAttestation: replacement,
    });
    return evidence;
}

function assertDatabaseRow(evidence, row) {
    if (!evidence || evidence.schema !== SCHEMA ||
        evidence.version !== VERSION || evidence.status !== STATUS ||
        evidence.database_recorded !== true) {
        throw new Error('database validation requires current delivered finalization evidence');
    }
    if (!row || typeof row !== 'object') {
        throw new Error('delivered finalization database row is missing');
    }
    const retained = evidence.backup_disposition === 'backup_retained';
    if (typeof evidence.job_id !== 'string' ||
        !evidence.job_id.trim() ||
        !/^[0-9a-f]{64}$/.test(String(evidence.delivery_transaction_id || '')) ||
        !/^[0-9a-f]{64}$/.test(String(evidence.checkpoint_key || '')) ||
        !Number.isFinite(Date.parse(String(evidence.delivered_at || ''))) ||
        BACKUP_DISPOSITIONS[String(evidence.backup_disposition || '')] !== true ||
        evidence.replacement_backup_retained !== retained ||
        evidence.candidate_validation_schema !== CANDIDATE_VALIDATION_SCHEMA ||
        evidence.policy_version !== deliveryPolicy.POLICY_VERSION ||
        typeof evidence.target_size_reduction_pct !== 'number' ||
        evidence.target_size_reduction_pct !==
            REQUIRED_TARGET_REDUCTION_PCT ||
        typeof evidence.minimum_size_reduction_pct !== 'number' ||
        evidence.minimum_size_reduction_pct !==
            REQUIRED_MINIMUM_REDUCTION_PCT ||
        typeof evidence.max_final_output_ratio_pct !== 'number' ||
        evidence.max_final_output_ratio_pct !==
            REQUIRED_MAX_OUTPUT_RATIO_PCT ||
        evidence.replacement_attestation_schema !==
            postReplaceAttestation.SCHEMA ||
        evidence.replacement_attestation_version !==
            postReplaceAttestation.VERSION ||
        evidence.replacement_attestation_contract !==
            `${postReplaceAttestation.SCHEMA}/v${postReplaceAttestation.VERSION}` ||
        !evidence.installed_path ||
        !path.isAbsolute(String(evidence.installed_path)) ||
        !samePath(
            evidence.replacement_backup_path,
            postReplaceAttestation.exactBackupPath(evidence.installed_path))) {
        throw new Error('delivered finalization database provenance is invalid');
    }
    if (!row.file_path || !samePath(row.file_path, evidence.installed_path)) {
        throw new Error('delivered finalization DB file path differs');
    }
    const sourceIdentity = requireContentIdentity(
        evidence.source_identity, 'delivered finalization source identity');
    const sourceBytes = positiveSafeInteger(
        evidence.source_size_bytes,
        'delivered finalization source byte count');
    if (sourceIdentity.size_bytes !== sourceBytes) {
        throw new Error(
            'delivered finalization source identity byte count is inconsistent');
    }
    const deliveredBytes = positiveSafeInteger(
        evidence.delivered_size_bytes,
        'delivered finalization delivered byte count');
    if (!evidence.installed_identity ||
        !/^[0-9a-f]{64}$/.test(String(
            evidence.installed_identity.sha256_full || '')) ||
        positiveSafeInteger(
            evidence.installed_identity.size_bytes,
            'delivered finalization installed byte count') !== deliveredBytes) {
        throw new Error(
            'delivered finalization installed identity is inconsistent');
    }
    const assessment = deliveryPolicy.evaluateBytes(
        deliveredBytes, sourceBytes, requireExactPolicy({
            version: evidence.policy_version,
            targetReductionPct: evidence.target_size_reduction_pct,
            minimumReductionPct: evidence.minimum_size_reduction_pct,
            maxFinalOutputRatioPct: evidence.max_final_output_ratio_pct,
        }));
    if (!assessment.accepted ||
        finiteNumber(
            evidence.final_output_ratio_pct,
            'delivered finalization output ratio') !== assessment.ratioPct ||
        finiteNumber(
            evidence.actual_size_reduction_pct,
            'delivered finalization actual reduction') !==
            assessment.actualReductionPct ||
        Math.abs(finiteNumber(
            evidence.final_output_size_mb,
            'delivered finalization output size') -
            assessment.outputBytes / (1024 * 1024)) > FLOAT_TOLERANCE) {
        throw new Error('delivered finalization size evidence is inconsistent');
    }
    const exact = {
        job_id: evidence.job_id,
        delivery_transaction_id: evidence.delivery_transaction_id,
        delivery_checkpoint_key: evidence.checkpoint_key,
        transcode_succeeded: 1,
        met_vmaf_target: 1,
        met_size_target: 1,
        size_target_status: 'met',
        size_policy_version: evidence.policy_version,
        outcome_stage: 'delivered',
        delivered_at: evidence.delivered_at,
        replacement_attestation_version:
            evidence.replacement_attestation_contract,
        replacement_backup_retained: retained ? 1 : 0,
    };
    for (const [field, expected] of Object.entries(exact)) {
        if (row[field] !== expected) {
            throw new Error(`delivered finalization DB mismatch for ${field}`);
        }
    }
    if (row.skip_reason !== null) {
        throw new Error('delivered finalization DB skip_reason is not NULL');
    }
    const numeric = {
        final_output_size_mb: evidence.final_output_size_mb,
        final_output_ratio_pct: evidence.final_output_ratio_pct,
        actual_size_reduction_pct: evidence.actual_size_reduction_pct,
        target_size_reduction_pct: evidence.target_size_reduction_pct,
        minimum_size_reduction_pct: evidence.minimum_size_reduction_pct,
        max_final_output_ratio_pct: evidence.max_final_output_ratio_pct,
    };
    for (const [field, expected] of Object.entries(numeric)) {
        const actualNumber = row[field];
        const expectedNumber = expected;
        if (typeof actualNumber !== 'number' ||
            typeof expectedNumber !== 'number' ||
            !Number.isFinite(actualNumber) ||
            !Number.isFinite(expectedNumber) ||
            Math.abs(actualNumber - expectedNumber) > FLOAT_TOLERANCE) {
            throw new Error(`delivered finalization DB mismatch for ${field}`);
        }
    }
    return row;
}

function validateDatabaseRow(evidence, row) {
    try {
        assertDatabaseRow(evidence, row);
        return { valid: true, reason: null };
    } catch (error) {
        return {
            valid: false,
            reason: `delivery finalization database verification failed: ${error.message}`,
        };
    }
}

module.exports = {
    SCHEMA,
    VERSION,
    STATUS,
    CANDIDATE_VALIDATION_SCHEMA,
    BACKUP_DISPOSITIONS,
    REQUIRED_TARGET_REDUCTION_PCT,
    REQUIRED_MINIMUM_REDUCTION_PCT,
    REQUIRED_MAX_OUTPUT_RATIO_PCT,
    create,
    validate,
    validateOrThrow,
    assertDatabaseRow,
    validateDatabaseRow,
    replacementContract,
    exactPathExists,
};
