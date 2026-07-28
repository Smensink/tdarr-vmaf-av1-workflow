'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const postEncodeCheckpoint = require('./postEncodeCheckpoint.js');
const postReplaceAttestation = require('./postReplaceAttestation.js');
const deliveryPolicy = require('./deliveryPolicy.js');
const deliveryFinalization = require('./deliveryFinalization.js');

const SCHEMA = 'vmaf-delivery-transaction/v1';
const VERSION = 1;
const FILE_NAME = 'delivery-transaction-v1.json';
const LOCK_NAME = 'delivery-transaction-v1.lock';
const TEMP_PREFIX = `${FILE_NAME}.tmp-`;
const LOCK_SCHEMA = 'vmaf-delivery-transaction-lock/v1';
const PENDING_PROOF_SCHEMA = 'vmaf-delivery-outcome-pending/v1';
const CANDIDATE_VALIDATION_SCHEMA =
    'vmaf-delivery-candidate-validation/v1';
const COMMIT_SCHEMA = 'vmaf-delivery-commit/v1';
const RETIREMENT_SCHEMA = 'vmaf-delivery-retirement-tombstone/v1';
const RETIREMENT_VERSION = 1;
const RETIREMENT_FILE_NAME = 'delivery-retirement-v1.json';
const RETIREMENT_TEMP_PREFIX = `${RETIREMENT_FILE_NAME}.tmp-`;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_RETIREMENT_BYTES = 2 * 1024 * 1024;
const MAX_LOCK_BYTES = 16 * 1024;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 10000;
const LOCK_POLL_MS = 10;
const LOCK_INITIALIZATION_GRACE_MS = 1000;
const FLOAT_TOLERANCE = 0.000000001;
const STATES = Object.freeze({
    reserved: 1,
    installed_pending_finalize: 2,
    delivery_committing: 3,
    delivered: 4,
});
const NEXT_STATE = Object.freeze({
    reserved: 'installed_pending_finalize',
    installed_pending_finalize: 'delivery_committing',
    delivery_committing: 'delivered',
});
const RETIREMENT_DATABASE_FIELDS = Object.freeze([
    'job_id',
    'file_path',
    'delivery_transaction_id',
    'delivery_checkpoint_key',
    'transcode_succeeded',
    'met_vmaf_target',
    'met_size_target',
    'size_target_status',
    'size_policy_version',
    'outcome_stage',
    'delivered_at',
    'replacement_attestation_version',
    'replacement_backup_retained',
    'skip_reason',
    'final_output_size_mb',
    'final_output_ratio_pct',
    'actual_size_reduction_pct',
    'target_size_reduction_pct',
    'minimum_size_reduction_pct',
    'max_final_output_ratio_pct',
]);

function exactObject(value, required, optional, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const allowed = new Set(required.concat(optional || []));
    const keys = Object.keys(value);
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw new Error(`${label} is missing ${key}`);
        }
    }
    for (const key of keys) {
        if (!allowed.has(key)) {
            throw new Error(`${label} has unexpected entry ${key}`);
        }
    }
    return value;
}

function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === 'object') {
        const out = {};
        Object.keys(value).sort().forEach((key) => {
            if (value[key] !== undefined) out[key] = canonicalValue(value[key]);
        });
        return out;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new Error('delivery transaction contains a non-finite number');
    }
    if (typeof value === 'bigint' || typeof value === 'function' ||
        typeof value === 'symbol' || value === undefined) {
        throw new Error(
            `delivery transaction contains unsupported ${typeof value} data`);
    }
    return value;
}

function canonicalJson(value) {
    return JSON.stringify(canonicalValue(value));
}

function canonicalCopy(value) {
    return JSON.parse(canonicalJson(value));
}

function sha256Text(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8')
        .digest('hex');
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    const handle = fs.openSync(filePath, 'r');
    try {
        let position = 0;
        while (true) {
            const count = fs.readSync(
                handle, buffer, 0, buffer.length, position);
            if (count === 0) break;
            hash.update(count === buffer.length
                ? buffer
                : buffer.subarray(0, count));
            position += count;
        }
    } finally {
        fs.closeSync(handle);
    }
    return hash.digest('hex');
}

function pathKey(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
    return pathKey(left) === pathKey(right);
}

function strictChild(root, child) {
    const relative = path.relative(path.resolve(root), path.resolve(child));
    return relative !== '' && relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeIsoTimestamp(value, label) {
    const text = String(value || '');
    if (!text || !Number.isFinite(Date.parse(text))) {
        throw new Error(`${label} must be an ISO timestamp`);
    }
    return text;
}

function safeJobId(value) {
    const jobId = String(value || '').trim();
    if (!jobId || jobId.length > 512 || /[\u0000-\u001f]/.test(jobId)) {
        throw new Error('delivery transaction job id is missing or unsafe');
    }
    return jobId;
}

function safeCheckpointKey(value) {
    const key = String(value || '');
    if (!/^[0-9a-f]{64}$/.test(key)) {
        throw new Error('delivery transaction checkpoint key is invalid');
    }
    return key;
}

function safePositiveInteger(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return number;
}

function finiteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        throw new Error(`${label} must be finite`);
    }
    return number;
}

function inspectRegularFile(filePath, label) {
    const requested = String(filePath || '').trim();
    if (!requested || !path.isAbsolute(requested)) {
        throw new Error(`${label} path must be absolute`);
    }
    const resolved = path.resolve(requested);
    if (resolved === path.parse(resolved).root) {
        throw new Error(`${label} path is unsafe`);
    }
    const stat = fs.lstatSync(resolved, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0n) {
        throw new Error(`${label} is not a non-empty regular file`);
    }
    const canonical = path.resolve(fs.realpathSync(resolved));
    if (!samePath(canonical, resolved)) {
        throw new Error(`${label} contains a symlinked path component`);
    }
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size <= 0) {
        throw new Error(`${label} byte count is invalid`);
    }
    return {
        path: canonical,
        dev: String(stat.dev),
        ino: String(stat.ino),
        size_bytes: size,
        mtime_ms: Math.trunc(Number(stat.mtimeMs)),
        ctime_ms: Math.trunc(Number(stat.ctimeMs)),
        mtime_ns: String(stat.mtimeNs),
        ctime_ns: String(stat.ctimeNs),
    };
}

function artifactProof(filePath, label) {
    const identity = inspectRegularFile(filePath, label);
    return Object.assign(identity, {
        sha256_full: sha256File(identity.path),
    });
}

function assertArtifactShape(proof, label) {
    exactObject(proof, [
        'path', 'dev', 'ino', 'size_bytes', 'mtime_ms', 'ctime_ms',
        'mtime_ns', 'ctime_ns', 'sha256_full',
    ], [], label);
    if (!path.isAbsolute(String(proof.path || '')) ||
        path.resolve(proof.path) === path.parse(path.resolve(proof.path)).root ||
        !String(proof.dev || '') || !String(proof.ino || '') ||
        !Number.isSafeInteger(Number(proof.mtime_ms)) ||
        !Number.isSafeInteger(Number(proof.ctime_ms)) ||
        !/^[0-9]+$/.test(String(proof.mtime_ns || '')) ||
        !/^[0-9]+$/.test(String(proof.ctime_ns || '')) ||
        !/^[0-9a-f]{64}$/.test(String(proof.sha256_full || ''))) {
        throw new Error(`${label} identity is incomplete`);
    }
    safePositiveInteger(proof.size_bytes, `${label} byte count`);
    return proof;
}

function assertSameArtifact(expected, actual, label) {
    assertArtifactShape(expected, `${label} expected proof`);
    assertArtifactShape(actual, `${label} actual proof`);
    for (const key of [
        'path', 'dev', 'ino', 'size_bytes', 'mtime_ms', 'ctime_ms',
        'mtime_ns', 'ctime_ns', 'sha256_full',
    ]) {
        const matches = key === 'path'
            ? samePath(expected[key], actual[key])
            : String(expected[key]) === String(actual[key]);
        if (!matches) throw new Error(`${label} ${key} changed`);
    }
}

function assertEvidenceIdentity(evidence, actual, label) {
    exactObject(evidence, [
        'path', 'size_bytes', 'dev', 'ino', 'mtime_ms', 'ctime_ms',
        'mtime_ns', 'ctime_ns',
    ], ['sha256_full'], label);
    if (!samePath(evidence.path, actual.path) ||
        Number(evidence.size_bytes) !== actual.size_bytes ||
        String(evidence.dev) !== actual.dev ||
        String(evidence.ino) !== actual.ino ||
        String(evidence.mtime_ns) !== actual.mtime_ns ||
        String(evidence.ctime_ns) !== actual.ctime_ns) {
        throw new Error(`${label} differs from the current file identity`);
    }
    if (evidence.sha256_full !== undefined &&
        evidence.sha256_full !== actual.sha256_full) {
        throw new Error(`${label} full SHA-256 differs from the current file`);
    }
}

function assertPendingEvidence(evidence, jobId, checkpointKey) {
    exactObject(evidence, [
        'schema', 'version', 'status', 'recorded_at', 'database_recorded',
        'source_path',
        'size_policy_version', 'target_size_reduction_pct',
        'minimum_size_reduction_pct', 'max_final_output_ratio_pct',
        'candidate_output_ratio_pct', 'candidate_output_size_mb',
        'job_id', 'checkpoint_key',
    ], [], 'delivery pending proof');
    if (evidence.schema !== PENDING_PROOF_SCHEMA ||
        evidence.version !== 1 ||
        evidence.status !== 'candidate_ready' ||
        evidence.database_recorded !== true ||
        evidence.job_id !== jobId ||
        evidence.checkpoint_key !== checkpointKey) {
        throw new Error(
            'delivery pending proof schema/job/checkpoint/status is invalid');
    }
    safeIsoTimestamp(evidence.recorded_at, 'delivery pending proof timestamp');
    deliveryPolicy.requireCurrentPolicy({
        version: evidence.size_policy_version,
        targetReductionPct: evidence.target_size_reduction_pct,
        minimumReductionPct: evidence.minimum_size_reduction_pct,
        maxFinalOutputRatioPct: evidence.max_final_output_ratio_pct,
    });
    if (finiteNumber(
        evidence.candidate_output_ratio_pct,
        'delivery pending output ratio') <= 0 ||
        finiteNumber(
            evidence.candidate_output_size_mb,
            'delivery pending output size') <= 0) {
        throw new Error(
            'delivery pending output size evidence must be positive');
    }
    return evidence;
}

function assertCandidateEvidence(evidence, jobId, checkpointKey) {
    exactObject(evidence, [
        'schema', 'status', 'validated_at', 'policy_version',
        'target_size_reduction_pct', 'minimum_size_reduction_pct',
        'max_final_output_ratio_pct', 'output_ratio_pct',
        'actual_size_reduction_pct', 'source', 'candidate', 'job_id',
        'checkpoint_key', 'candidate_ready_schema',
    ], [], 'candidate validation proof');
    if (evidence.schema !== CANDIDATE_VALIDATION_SCHEMA ||
        evidence.status !== 'accepted' ||
        evidence.job_id !== jobId ||
        evidence.checkpoint_key !== checkpointKey ||
        evidence.candidate_ready_schema !== PENDING_PROOF_SCHEMA) {
        throw new Error(
            'candidate validation schema/job/checkpoint/status is invalid');
    }
    safeIsoTimestamp(
        evidence.validated_at, 'candidate validation proof timestamp');
    deliveryPolicy.requireCurrentPolicy({
        version: evidence.policy_version,
        targetReductionPct: evidence.target_size_reduction_pct,
        minimumReductionPct: evidence.minimum_size_reduction_pct,
        maxFinalOutputRatioPct: evidence.max_final_output_ratio_pct,
    });
    finiteNumber(
        evidence.output_ratio_pct,
        'candidate validation output ratio');
    finiteNumber(
        evidence.actual_size_reduction_pct,
        'candidate validation actual reduction');
    return evidence;
}

function assertPolicyBindings(pending, candidate) {
    const pairs = [
        ['size_policy_version', 'policy_version'],
        ['target_size_reduction_pct', 'target_size_reduction_pct'],
        ['minimum_size_reduction_pct', 'minimum_size_reduction_pct'],
        ['max_final_output_ratio_pct', 'max_final_output_ratio_pct'],
    ];
    for (const [pendingKey, candidateKey] of pairs) {
        if (String(pending[pendingKey]) !== String(candidate[candidateKey])) {
            throw new Error(
                'pending and candidate proofs use different delivery policies');
        }
    }
}

function evidenceEnvelope(evidence, jobId, checkpointKey) {
    const copy = canonicalCopy(evidence);
    return {
        schema: copy.schema,
        job_id: jobId,
        checkpoint_key: checkpointKey,
        evidence_sha256: sha256Text(canonicalJson(copy)),
        evidence: copy,
    };
}

function assertEvidenceEnvelope(envelope, expectedSchema, jobId,
    checkpointKey, label) {
    exactObject(envelope, [
        'schema', 'job_id', 'checkpoint_key', 'evidence_sha256',
        'evidence',
    ], [], label);
    if (envelope.schema !== expectedSchema ||
        envelope.job_id !== jobId ||
        envelope.checkpoint_key !== checkpointKey ||
        !/^[0-9a-f]{64}$/.test(String(envelope.evidence_sha256 || '')) ||
        envelope.evidence_sha256 !==
            sha256Text(canonicalJson(envelope.evidence))) {
        throw new Error(`${label} binding or digest is invalid`);
    }
    return envelope;
}

function validateLocation(authenticated) {
    const entryDir = path.resolve(authenticated.entryDir);
    const stat = fs.lstatSync(entryDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(
            'delivery transaction checkpoint entry is not a real directory');
    }
    if (!samePath(fs.realpathSync(entryDir), entryDir)) {
        throw new Error(
            'delivery transaction checkpoint entry has a symlinked component');
    }
    const journalPath = path.join(entryDir, FILE_NAME);
    const lockPath = path.join(entryDir, LOCK_NAME);
    if (!strictChild(entryDir, journalPath) ||
        path.dirname(journalPath) !== entryDir ||
        path.basename(journalPath) !== FILE_NAME ||
        !strictChild(authenticated.root, journalPath)) {
        throw new Error(
            'derived delivery transaction path escaped its checkpoint entry');
    }
    return {
        authenticated,
        entryDir,
        journalPath,
        lockPath,
    };
}

function location(checkpointRecord) {
    return validateLocation(
        postEncodeCheckpoint.authenticateRecord(checkpointRecord));
}

function retirementLocation(checkpointRecord) {
    const located =
        postEncodeCheckpoint.retirementLocation(checkpointRecord);
    const entryDir = path.resolve(located.entryDir);
    const journalPath = path.join(entryDir, FILE_NAME);
    const lockPath = path.join(entryDir, LOCK_NAME);
    const tombstonePath = path.join(entryDir, RETIREMENT_FILE_NAME);
    for (const [label, filePath, expectedName] of [
        ['journal', journalPath, FILE_NAME],
        ['lock', lockPath, LOCK_NAME],
        ['retirement tombstone', tombstonePath, RETIREMENT_FILE_NAME],
    ]) {
        if (!strictChild(entryDir, filePath) ||
            path.dirname(filePath) !== entryDir ||
            path.basename(filePath) !== expectedName ||
            !strictChild(located.root, filePath)) {
            throw new Error(
                `derived delivery ${label} path escaped its checkpoint entry`);
        }
    }
    return {
        authenticated: located,
        entryDir,
        journalPath,
        lockPath,
        tombstonePath,
    };
}

function fsyncDirectory(directory) {
    let handle;
    try {
        handle = fs.openSync(directory, 'r');
        fs.fsyncSync(handle);
    } catch (error) {
        const unsupportedOnWindows = new Set([
            'EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM',
        ]);
        if (process.platform !== 'win32' || !error ||
            !unsupportedOnWindows.has(error.code)) {
            throw error;
        }
    } finally {
        if (handle !== undefined) fs.closeSync(handle);
    }
}

function randomToken() {
    return `${process.pid}-${Date.now()}-${
        crypto.randomBytes(12).toString('hex')}`;
}

function writeTemp(directory, value) {
    const tempPath = path.join(directory, `${TEMP_PREFIX}${randomToken()}`);
    if (!strictChild(directory, tempPath) ||
        path.dirname(tempPath) !== directory) {
        throw new Error('derived delivery transaction temp path escaped');
    }
    const handle = fs.openSync(tempPath, 'wx', 0o600);
    let writeError = null;
    try {
        fs.writeFileSync(
            handle, `${JSON.stringify(canonicalValue(value), null, 2)}\n`,
            'utf8');
        fs.fsyncSync(handle);
    } catch (error) {
        writeError = error;
        throw error;
    } finally {
        try {
            fs.closeSync(handle);
        } catch (closeError) {
            if (!writeError) throw closeError;
        }
        if (writeError) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
        }
    }
    return tempPath;
}

function readBoundedJson(filePath, label, maxBytes) {
    let stat;
    try {
        stat = fs.lstatSync(filePath);
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            throw new Error(`${label} is missing`);
        }
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() ||
        stat.size <= 0 || stat.size > maxBytes) {
        throw new Error(`${label} is not a bounded regular file`);
    }
    if (!samePath(fs.realpathSync(filePath), filePath)) {
        throw new Error(`${label} has a symlinked path component`);
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`${label} contains corrupt JSON: ${error.message}`);
    }
}

function journalExists(journalPath) {
    try {
        fs.lstatSync(journalPath);
        return true;
    } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        throw error;
    }
}

function assertNamespace(locationValue, allowLock) {
    const entries = fs.readdirSync(locationValue.entryDir);
    for (const name of entries) {
        if (!name.startsWith('delivery-transaction-v1')) continue;
        if (name === FILE_NAME) continue;
        if (allowLock && name === LOCK_NAME) continue;
        throw new Error(
            `delivery transaction checkpoint entry has unexpected entry ${name}`);
    }
}

function assertRetirementNamespace(locationValue) {
    const entries = fs.readdirSync(locationValue.entryDir);
    for (const name of entries) {
        if (!name.startsWith('delivery-retirement-v1')) continue;
        if (name === RETIREMENT_FILE_NAME) continue;
        throw new Error(
            `delivery retirement checkpoint entry has unexpected entry ${name}`);
    }
}

function sleepSync(milliseconds) {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function acquireLock(locationValue) {
    const started = Date.now();
    let handle;
    while (true) {
        try {
            handle = fs.openSync(locationValue.lockPath, 'wx', 0o600);
            break;
        } catch (error) {
            if (!error || error.code !== 'EEXIST') throw error;
            const lock = fs.lstatSync(locationValue.lockPath);
            if (!lock.isFile() || lock.isSymbolicLink() ||
                lock.size > MAX_LOCK_BYTES) {
                throw new Error(
                    'delivery transaction lock is not a bounded regular file');
            }
            const ageMs = Math.max(0, Date.now() -
                Math.max(Number(lock.mtimeMs), Number(lock.ctimeMs)));
            if (lock.size === 0) {
                if (ageMs <= LOCK_INITIALIZATION_GRACE_MS) {
                    sleepSync(LOCK_POLL_MS);
                    continue;
                }
                throw new Error(
                    'delivery transaction lock initialization is incomplete');
            }
            try {
                const owner = readBoundedJson(
                    locationValue.lockPath,
                    'delivery transaction lock', MAX_LOCK_BYTES);
                exactObject(owner, [
                    'schema', 'pid', 'token', 'created_at',
                ], [], 'delivery transaction lock');
                if (owner.schema !== LOCK_SCHEMA ||
                    !Number.isSafeInteger(Number(owner.pid)) ||
                    Number(owner.pid) <= 0 ||
                    !/^[0-9a-f]{32}$/.test(String(owner.token || ''))) {
                    throw new Error(
                        'delivery transaction lock owner is invalid');
                }
                safeIsoTimestamp(
                    owner.created_at, 'delivery transaction lock timestamp');
            } catch (lockError) {
                if (ageMs <= LOCK_INITIALIZATION_GRACE_MS) {
                    sleepSync(LOCK_POLL_MS);
                    continue;
                }
                throw lockError;
            }
            if (Date.now() - started >= LOCK_TIMEOUT_MS) {
                throw new Error(
                    'delivery transaction lock is held; recovery is fail-closed');
            }
            sleepSync(LOCK_POLL_MS);
        }
    }
    try {
        const owner = {
            schema: LOCK_SCHEMA,
            pid: process.pid,
            token: crypto.randomBytes(16).toString('hex'),
            created_at: new Date().toISOString(),
        };
        fs.writeFileSync(
            handle, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
        fs.fsyncSync(handle);
        fs.closeSync(handle);
        handle = undefined;
        fsyncDirectory(locationValue.entryDir);
        const stat = fs.lstatSync(locationValue.lockPath, { bigint: true });
        return {
            path: locationValue.lockPath,
            dev: String(stat.dev),
            ino: String(stat.ino),
        };
    } catch (error) {
        if (handle !== undefined) {
            try { fs.closeSync(handle); } catch (_) {}
        }
        throw error;
    }
}

function releaseLock(locationValue, owner) {
    const stat = fs.lstatSync(owner.path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() ||
        String(stat.dev) !== owner.dev || String(stat.ino) !== owner.ino) {
        throw new Error('delivery transaction lock identity changed');
    }
    fs.unlinkSync(owner.path);
    fsyncDirectory(locationValue.entryDir);
}

function withLock(locationValue, operation) {
    const owner = acquireLock(locationValue);
    let operationError = null;
    try {
        assertNamespace(locationValue, true);
        assertRetirementNamespace(locationValue);
        return operation();
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        try {
            releaseLock(locationValue, owner);
        } catch (releaseError) {
            if (!operationError) throw releaseError;
            operationError.lockReleaseError = releaseError;
        }
    }
}

function atomicExclusiveCreate(locationValue, value) {
    let tempPath;
    let linked = false;
    try {
        tempPath = writeTemp(locationValue.entryDir, value);
        fs.linkSync(tempPath, locationValue.journalPath);
        linked = true;
        fsyncDirectory(locationValue.entryDir);
        fs.unlinkSync(tempPath);
        tempPath = null;
        fsyncDirectory(locationValue.entryDir);
    } catch (error) {
        if (tempPath) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
        }
        if (!linked && error && error.code === 'EEXIST') {
            throw new Error(
                'delivery transaction journal already exists');
        }
        throw error;
    }
}

function atomicUpdate(locationValue, value) {
    let tempPath;
    try {
        tempPath = writeTemp(locationValue.entryDir, value);
        fs.renameSync(tempPath, locationValue.journalPath);
        tempPath = null;
        fsyncDirectory(locationValue.entryDir);
    } catch (error) {
        if (tempPath) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
        }
        throw error;
    }
}

function writeRetirementTemp(locationValue, value) {
    const tempPath = path.join(
        locationValue.entryDir,
        `${RETIREMENT_TEMP_PREFIX}${randomToken()}`);
    if (!strictChild(locationValue.entryDir, tempPath) ||
        path.dirname(tempPath) !== locationValue.entryDir) {
        throw new Error('derived delivery retirement temp path escaped');
    }
    const handle = fs.openSync(tempPath, 'wx', 0o600);
    let writeError = null;
    try {
        fs.writeFileSync(
            handle, `${JSON.stringify(canonicalValue(value), null, 2)}\n`,
            'utf8');
        fs.fsyncSync(handle);
    } catch (error) {
        writeError = error;
        throw error;
    } finally {
        try {
            fs.closeSync(handle);
        } catch (closeError) {
            if (!writeError) throw closeError;
        }
        if (writeError) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
        }
    }
    return tempPath;
}

function atomicExclusiveRetirementCreate(locationValue, value) {
    let tempPath;
    let linked = false;
    try {
        tempPath = writeRetirementTemp(locationValue, value);
        fs.linkSync(tempPath, locationValue.tombstonePath);
        linked = true;
        fs.unlinkSync(tempPath);
        tempPath = null;
        fsyncDirectory(locationValue.entryDir);
    } catch (error) {
        if (tempPath) {
            try { fs.unlinkSync(tempPath); } catch (_) {}
        }
        if (!linked && error && error.code === 'EEXIST') {
            throw new Error(
                'delivery retirement tombstone already exists');
        }
        throw error;
    }
}

function assertReplacementEnvelope(replacement, journal, verifyCurrent) {
    exactObject(replacement, [
        'schema', 'job_id', 'checkpoint_key', 'evidence_sha256',
        'evidence', 'installed', 'backup',
    ], [], 'delivery replacement proof');
    if (replacement.job_id !== journal.job_id ||
        replacement.checkpoint_key !== journal.checkpoint_key ||
        replacement.schema !== replacement.evidence.schema ||
        replacement.evidence_sha256 !==
            sha256Text(canonicalJson(replacement.evidence))) {
        throw new Error('delivery replacement proof binding or digest is invalid');
    }
    assertArtifactShape(replacement.installed,
        'delivery replacement installed proof');
    assertArtifactShape(
        replacement.backup, 'delivery replacement backup proof');
    const evidence = replacement.evidence;
    exactObject(evidence, [
        'schema', 'version', 'replacement_completed', 'outcome',
        'target_path', 'original_path', 'checkpoint_key', 'installed',
        'backup_path', 'backup', 'attested_at_ms',
    ], [], 'replacement attestation');
    if (evidence.schema !== postReplaceAttestation.SCHEMA ||
        Number(evidence.version) !==
            Number(postReplaceAttestation.VERSION) ||
        evidence.replacement_completed !== true ||
        evidence.outcome !== 'backup_retained' ||
        evidence.checkpoint_key !== journal.checkpoint_key ||
        !samePath(evidence.target_path, journal.source.path) ||
        !samePath(evidence.original_path, journal.source.path) ||
        !samePath(evidence.backup_path,
            postReplaceAttestation.exactBackupPath(journal.source.path)) ||
        !evidence.installed || !evidence.backup) {
        throw new Error(
            'replacement attestation is not exact, retained, and checkpoint-bound');
    }
    postReplaceAttestation.assertIdentityMatches(
        evidence.installed, replacement.installed,
        'journal replacement installed file');
    postReplaceAttestation.assertIdentityMatches(
        evidence.backup, replacement.backup,
        'journal replacement backup file');
    if (replacement.installed.sha256_full !==
            journal.candidate.sha256_full ||
        replacement.installed.size_bytes !== journal.candidate.size_bytes) {
        throw new Error(
            'installed replacement bytes differ from the reserved candidate');
    }
    if (replacement.backup.sha256_full !== journal.source.sha256_full ||
        replacement.backup.size_bytes !== journal.source.size_bytes) {
        throw new Error(
            'exact replacement backup bytes differ from the reserved source');
    }
    if (verifyCurrent) {
        const installed = artifactProof(
            journal.source.path, 'current installed delivery file');
        const backup = artifactProof(
            postReplaceAttestation.exactBackupPath(journal.source.path),
            'current exact replacement backup');
        assertSameArtifact(
            replacement.installed, installed, 'installed delivery file');
        assertSameArtifact(
            replacement.backup, backup, 'exact replacement backup');
    }
}

function replacementEnvelope(journal, checkpointRecord, attestation) {
    const proof = postReplaceAttestation.validate(attestation, {
        checkpointRecord,
        inputPath: journal.source.path,
        originalPath: journal.source.path,
        requireRetainedBackup: true,
    });
    if (!proof.valid || attestation.outcome !== 'backup_retained') {
        throw new Error(
            `delivery replacement attestation is invalid: ${proof.reason}`);
    }
    const installed = artifactProof(
        journal.source.path, 'installed delivery candidate');
    const backupPath =
        postReplaceAttestation.exactBackupPath(journal.source.path);
    const backup = artifactProof(
        backupPath, 'exact retained replacement backup');
    const envelope = {
        schema: attestation.schema,
        job_id: journal.job_id,
        checkpoint_key: journal.checkpoint_key,
        evidence_sha256: sha256Text(canonicalJson(attestation)),
        evidence: canonicalCopy(attestation),
        installed,
        backup,
    };
    assertReplacementEnvelope(envelope, journal, true);
    return envelope;
}

function assertCommitProof(commit, journal) {
    exactObject(commit, [
        'schema', 'job_id', 'checkpoint_key', 'started_at',
    ], [], 'delivery commit proof');
    if (commit.schema !== COMMIT_SCHEMA ||
        commit.job_id !== journal.job_id ||
        commit.checkpoint_key !== journal.checkpoint_key) {
        throw new Error('delivery commit proof binding is invalid');
    }
    safeIsoTimestamp(commit.started_at, 'delivery commit timestamp');
}

function assertDeliveredEnvelope(delivered, journal, checkpointRecord,
    verifyCurrent) {
    assertEvidenceEnvelope(
        delivered, delivered && delivered.schema, journal.job_id,
        journal.checkpoint_key, 'delivered finalization proof');
    const evidence = delivered.evidence;
    if (!evidence || evidence.schema !== delivered.schema ||
        evidence.status !== 'delivered' ||
        evidence.database_recorded !== true ||
        evidence.job_id !== journal.job_id ||
        evidence.checkpoint_key !== journal.checkpoint_key ||
        evidence.delivery_transaction_id !== journal.transaction_id) {
        throw new Error(
            'delivered finalization schema/job/checkpoint/transaction/status is invalid');
    }
    const sourceBytes = safePositiveInteger(
        evidence.source_size_bytes,
        'delivered finalization source byte count');
    const deliveredBytes = safePositiveInteger(
        evidence.delivered_size_bytes,
        'delivered finalization output byte count');
    const sourceIdentity = evidence.source_identity || {};
    const ratio = journal.replacement.installed.size_bytes /
        journal.source.size_bytes * 100;
    if (sourceBytes !== journal.source.size_bytes ||
        Number(sourceIdentity.size_bytes) !== journal.source.size_bytes ||
        String(sourceIdentity.sha256_full || '') !==
            journal.source.sha256_full ||
        deliveredBytes !== journal.replacement.installed.size_bytes ||
        !samePath(evidence.installed_path,
            journal.replacement.installed.path) ||
        Math.abs(finiteNumber(
            evidence.final_output_ratio_pct,
            'delivered finalization output ratio') - ratio) >
            FLOAT_TOLERANCE ||
        Math.abs(finiteNumber(
            evidence.actual_size_reduction_pct,
            'delivered finalization actual reduction') -
            (100 - ratio)) > FLOAT_TOLERANCE ||
        Math.abs(finiteNumber(
            evidence.final_output_size_mb,
            'delivered finalization output size') -
            deliveredBytes / (1024 * 1024)) > FLOAT_TOLERANCE) {
        throw new Error(
            'delivered finalization size evidence differs from the reserved transaction');
    }
    postReplaceAttestation.assertIdentityMatches(
        evidence.installed_identity,
        journal.replacement.installed,
        'delivered finalization installed file');
    const deliveryFinalization = require('./deliveryFinalization.js');
    if (evidence.schema !== deliveryFinalization.SCHEMA) {
        throw new Error('delivered finalization schema is not current');
    }
    const validation = deliveryFinalization.validate(evidence, {
        checkpointRecord,
        inputPath: journal.source.path,
        originalPath: journal.source.path,
        replacementAttestation: journal.replacement.evidence,
    });
    if (!validation.valid) {
        throw new Error(
            `delivered finalization is invalid: ${validation.reason}`);
    }
    if (verifyCurrent) {
        const installed = artifactProof(
            journal.source.path, 'current delivered file');
        assertSameArtifact(
            journal.replacement.installed, installed,
            'current delivered file');
    }
}

function deliveredEnvelope(journal, checkpointRecord, finalization) {
    const envelope = evidenceEnvelope(
        finalization, journal.job_id, journal.checkpoint_key);
    assertDeliveredEnvelope(envelope, journal, checkpointRecord, true);
    return envelope;
}

function assertJournal(journal, checkpointRecord, authenticated,
    verifyCurrent) {
    exactObject(journal, [
        'schema', 'version', 'transaction_id', 'job_id', 'checkpoint_key',
        'state', 'revision', 'created_at', 'updated_at', 'pending_proof',
        'candidate_validation', 'source', 'candidate', 'replacement',
        'delivery_commit', 'delivered',
    ], [], 'delivery transaction journal');
    const jobId = safeJobId(journal.job_id);
    const checkpointKey = safeCheckpointKey(journal.checkpoint_key);
    if (journal.schema !== SCHEMA || journal.version !== VERSION ||
        !/^[0-9a-f]{64}$/.test(String(journal.transaction_id || '')) ||
        !STATES[journal.state] ||
        Number(journal.revision) !== STATES[journal.state] ||
        checkpointKey !== authenticated.key) {
        throw new Error('delivery transaction journal identity/state is invalid');
    }
    safeIsoTimestamp(journal.created_at, 'delivery transaction created time');
    safeIsoTimestamp(journal.updated_at, 'delivery transaction updated time');
    if (Date.parse(journal.updated_at) < Date.parse(journal.created_at)) {
        throw new Error(
            'delivery transaction update predates its creation');
    }
    assertEvidenceEnvelope(
        journal.pending_proof, PENDING_PROOF_SCHEMA, jobId, checkpointKey,
        'delivery pending proof envelope');
    assertEvidenceEnvelope(
        journal.candidate_validation, CANDIDATE_VALIDATION_SCHEMA,
        jobId, checkpointKey, 'candidate validation envelope');
    assertPendingEvidence(
        journal.pending_proof.evidence, jobId, checkpointKey);
    assertCandidateEvidence(
        journal.candidate_validation.evidence, jobId, checkpointKey);
    assertPolicyBindings(
        journal.pending_proof.evidence,
        journal.candidate_validation.evidence);
    if (!samePath(
        journal.pending_proof.evidence.source_path,
        journal.candidate_validation.evidence.source.path)) {
        throw new Error(
            'pending proof source path differs from candidate validation');
    }
    assertArtifactShape(journal.source, 'reserved source proof');
    assertArtifactShape(journal.candidate, 'reserved candidate proof');
    assertEvidenceIdentity(
        journal.candidate_validation.evidence.source,
        journal.source, 'candidate-validation source identity');
    assertEvidenceIdentity(
        journal.candidate_validation.evidence.candidate,
        journal.candidate, 'candidate-validation candidate identity');
    if (samePath(journal.source.path, journal.candidate.path) ||
        (journal.source.dev === journal.candidate.dev &&
            journal.source.ino === journal.candidate.ino)) {
        throw new Error('reserved source and candidate alias one another');
    }
    const ratio = journal.candidate.size_bytes /
        journal.source.size_bytes * 100;
    const reduction = 100 - ratio;
    const candidateRatio = finiteNumber(
        journal.candidate_validation.evidence.output_ratio_pct,
        'candidate validation output ratio');
    const candidateReduction = finiteNumber(
        journal.candidate_validation.evidence.actual_size_reduction_pct,
        'candidate validation actual reduction');
    if (Math.abs(candidateRatio - ratio) >
            FLOAT_TOLERANCE ||
        Math.abs(candidateReduction - reduction) > FLOAT_TOLERANCE) {
        throw new Error(
            'candidate validation size metrics differ from reserved bytes');
    }

    if (journal.state === 'reserved') {
        if (journal.replacement !== null ||
            journal.delivery_commit !== null || journal.delivered !== null) {
            throw new Error('reserved transaction has later-state evidence');
        }
        if (verifyCurrent) {
            assertSameArtifact(
                journal.source,
                artifactProof(journal.source.path, 'current reserved source'),
                'current reserved source');
            assertSameArtifact(
                journal.candidate,
                artifactProof(
                    journal.candidate.path, 'current reserved candidate'),
                'current reserved candidate');
        }
    } else {
        if (!journal.replacement) {
            throw new Error(
                'post-install transaction has no replacement proof');
        }
        assertReplacementEnvelope(
            journal.replacement, journal,
            verifyCurrent && journal.state !== 'delivered');
        if (journal.state === 'installed_pending_finalize') {
            if (journal.delivery_commit !== null ||
                journal.delivered !== null) {
                throw new Error(
                    'installed transaction has later-state evidence');
            }
        } else {
            assertCommitProof(journal.delivery_commit, journal);
            if (journal.state === 'delivery_committing') {
                if (journal.delivered !== null) {
                    throw new Error(
                        'committing transaction has delivered evidence');
                }
            } else {
                if (!journal.delivered) {
                    throw new Error(
                        'delivered transaction has no finalization proof');
                }
                assertDeliveredEnvelope(
                    journal.delivered, journal, checkpointRecord,
                    verifyCurrent);
            }
        }
    }
    return journal;
}

function readJournal(locationValue, checkpointRecord, verifyCurrent) {
    const journal = readBoundedJson(
        locationValue.journalPath,
        'delivery transaction journal', MAX_JOURNAL_BYTES);
    return assertJournal(
        journal, checkpointRecord, locationValue.authenticated,
        verifyCurrent === true);
}

function validate(checkpointRecord, journal, options) {
    try {
        const locationValue = location(checkpointRecord);
        const value = journal === undefined
            ? readBoundedJson(locationValue.journalPath,
                'delivery transaction journal', MAX_JOURNAL_BYTES)
            : canonicalCopy(journal);
        assertJournal(
            value, checkpointRecord, locationValue.authenticated,
            !options || options.verifyCurrentFiles !== false);
        return { valid: true, reason: null, journal: value };
    } catch (error) {
        return {
            valid: false,
            reason: `delivery transaction verification failed: ${error.message}`,
            journal: null,
        };
    }
}

function load(checkpointRecord) {
    const locationValue = location(checkpointRecord);
    return withLock(locationValue, () =>
        readJournal(locationValue, checkpointRecord, true));
}

function create(checkpointRecord, input) {
    exactObject(input, [
        'jobId', 'pendingProof', 'candidateValidation',
    ], [], 'delivery transaction create input');
    const locationValue = location(checkpointRecord);
    const checkpointKey = locationValue.authenticated.key;
    const jobId = safeJobId(input.jobId);
    const pending = canonicalCopy(input.pendingProof);
    const candidateValidation = canonicalCopy(input.candidateValidation);
    assertPendingEvidence(pending, jobId, checkpointKey);
    assertCandidateEvidence(
        candidateValidation, jobId, checkpointKey);
    assertPolicyBindings(pending, candidateValidation);
    const source = artifactProof(
        candidateValidation.source.path, 'delivery source');
    const candidate = artifactProof(
        candidateValidation.candidate.path, 'delivery candidate');
    assertEvidenceIdentity(
        candidateValidation.source, source,
        'candidate-validation source identity');
    assertEvidenceIdentity(
        candidateValidation.candidate, candidate,
        'candidate-validation candidate identity');
    if (samePath(source.path, candidate.path) ||
        (source.dev === candidate.dev && source.ino === candidate.ino)) {
        throw new Error('delivery source and candidate alias one another');
    }
    const now = new Date().toISOString();
    const proposed = {
        schema: SCHEMA,
        version: VERSION,
        transaction_id: crypto.randomBytes(32).toString('hex'),
        job_id: jobId,
        checkpoint_key: checkpointKey,
        state: 'reserved',
        revision: STATES.reserved,
        created_at: now,
        updated_at: now,
        pending_proof:
            evidenceEnvelope(pending, jobId, checkpointKey),
        candidate_validation:
            evidenceEnvelope(candidateValidation, jobId, checkpointKey),
        source,
        candidate,
        replacement: null,
        delivery_commit: null,
        delivered: null,
    };
    assertJournal(
        proposed, checkpointRecord, locationValue.authenticated, true);
    return withLock(locationValue, () => {
        if (journalExists(locationValue.journalPath)) {
            const current = readJournal(
                locationValue, checkpointRecord, true);
            const immutableKeys = [
                'job_id', 'checkpoint_key', 'pending_proof',
                'candidate_validation', 'source', 'candidate',
            ];
            for (const key of immutableKeys) {
                if (canonicalJson(current[key]) !==
                    canonicalJson(proposed[key])) {
                    throw new Error(
                        `existing delivery transaction differs at ${key}`);
                }
            }
            return current;
        }
        atomicExclusiveCreate(locationValue, proposed);
        const readback = readJournal(
            locationValue, checkpointRecord, true);
        if (canonicalJson(readback) !== canonicalJson(proposed)) {
            throw new Error(
                'delivery transaction exclusive-create read-back mismatch');
        }
        return readback;
    });
}

function transition(checkpointRecord, expectedState, nextState, evidence) {
    if (!STATES[expectedState] || !STATES[nextState] ||
        NEXT_STATE[expectedState] !== nextState) {
        throw new Error(
            `invalid delivery transaction transition ${expectedState} -> ${nextState}`);
    }
    const payload = evidence === undefined ? {} : evidence;
    if (nextState === 'installed_pending_finalize') {
        exactObject(payload, ['replacementAttestation'], [],
            'installed transition evidence');
    } else if (nextState === 'delivery_committing') {
        exactObject(payload, [], [], 'delivery-commit transition evidence');
    } else {
        exactObject(payload, ['deliveryFinalization'], [],
            'delivered transition evidence');
    }
    const locationValue = location(checkpointRecord);
    return withLock(locationValue, () => {
        const current = readJournal(
            locationValue, checkpointRecord, false);
        // The reserved -> installed transition is intentionally recorded after
        // the filesystem rename. At that boundary the old reserved paths no
        // longer exist in their original identities; the exact installed and
        // backup proofs below authenticate both sides of the rename instead.
        const filesystemBoundary =
            (current.state === 'reserved' &&
                nextState === 'installed_pending_finalize') ||
            (current.state === 'delivery_committing' &&
                nextState === 'delivered');
        if (!filesystemBoundary) {
            assertJournal(
                current, checkpointRecord,
                locationValue.authenticated, true);
        }
        let proposedEvidence = null;
        if (nextState === 'installed_pending_finalize') {
            proposedEvidence = replacementEnvelope(
                current, checkpointRecord, payload.replacementAttestation);
        } else if (nextState === 'delivered') {
            proposedEvidence = deliveredEnvelope(
                current, checkpointRecord, payload.deliveryFinalization);
        }
        if (current.state === nextState) {
            if (nextState === 'installed_pending_finalize' &&
                canonicalJson(current.replacement) !==
                    canonicalJson(proposedEvidence)) {
                throw new Error(
                    'idempotent installed transition read-back differs');
            }
            if (nextState === 'delivered' &&
                canonicalJson(current.delivered) !==
                    canonicalJson(proposedEvidence)) {
                throw new Error(
                    'immutable delivered fields differ on idempotent read-back');
            }
            return current;
        }
        if (current.state !== expectedState) {
            throw new Error(
                `delivery transaction CAS expected ${expectedState} but found ${current.state}`);
        }
        const updated = canonicalCopy(current);
        updated.state = nextState;
        updated.revision = STATES[nextState];
        updated.updated_at = new Date().toISOString();
        if (nextState === 'installed_pending_finalize') {
            updated.replacement = proposedEvidence;
        } else if (nextState === 'delivery_committing') {
            updated.delivery_commit = {
                schema: COMMIT_SCHEMA,
                job_id: current.job_id,
                checkpoint_key: current.checkpoint_key,
                started_at: updated.updated_at,
            };
        } else {
            updated.delivered = proposedEvidence;
        }
        assertJournal(
            updated, checkpointRecord, locationValue.authenticated, true);
        atomicUpdate(locationValue, updated);
        const readback = readJournal(
            locationValue, checkpointRecord, true);
        if (canonicalJson(readback) !== canonicalJson(updated)) {
            throw new Error(
                'delivery transaction atomic-update read-back mismatch');
        }
        return readback;
    });
}

function projectRetirementDatabaseRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('delivery retirement database row is missing');
    }
    const projected = {};
    for (const field of RETIREMENT_DATABASE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(row, field)) {
            throw new Error(
                `delivery retirement database row is missing ${field}`);
        }
        projected[field] = row[field];
    }
    return canonicalCopy(projected);
}

function validateRetirementEvidence(tombstone, checkpointRecord, databaseRow) {
    const finalization = tombstone.delivery_finalization;
    if (!samePath(tombstone.source_path, finalization.installed_path) ||
        finalization.job_id !== tombstone.job_id ||
        finalization.delivery_transaction_id !== tombstone.transaction_id ||
        finalization.checkpoint_key !== tombstone.checkpoint_key) {
        throw new Error(
            'delivery retirement finalization identity differs from its tombstone');
    }
    deliveryFinalization.validateOrThrow(finalization, {
        checkpointRecord,
        inputPath: finalization.installed_path,
        originalPath: tombstone.source_path,
        replacementAttestation: tombstone.replacement_attestation,
    });
    deliveryFinalization.assertDatabaseRow(finalization, databaseRow);
    if (!samePath(databaseRow.file_path, tombstone.source_path)) {
        throw new Error(
            'delivery retirement database file path differs from the source');
    }
    const projected = projectRetirementDatabaseRow(databaseRow);
    if (sha256Text(canonicalJson(projected)) !==
            tombstone.database_row_sha256 ||
        canonicalJson(projected) !== canonicalJson(tombstone.database_row)) {
        throw new Error(
            'delivery retirement immutable database row changed');
    }
    return projected;
}

function tombstoneDigest(tombstone) {
    const copy = canonicalCopy(tombstone);
    delete copy.record_sha256;
    return sha256Text(canonicalJson(copy));
}

function assertRetirementTombstone(tombstone, checkpointRecord,
    locationValue, databaseRow, deliveredJournal) {
    exactObject(tombstone, [
        'schema', 'version', 'transaction_id', 'job_id', 'job_id_sha256',
        'checkpoint_key', 'source_path', 'created_at',
        'delivered_journal_sha256', 'delivery_finalization_sha256',
        'delivery_finalization', 'replacement_attestation_sha256',
        'replacement_attestation', 'database_row_sha256', 'database_row',
        'checkpoint_inventory', 'record_sha256',
    ], [], 'delivery retirement tombstone');
    const jobId = safeJobId(tombstone.job_id);
    const checkpointKey = safeCheckpointKey(tombstone.checkpoint_key);
    if (tombstone.schema !== RETIREMENT_SCHEMA ||
        tombstone.version !== RETIREMENT_VERSION ||
        !/^[0-9a-f]{64}$/.test(String(tombstone.transaction_id || '')) ||
        tombstone.job_id_sha256 !== sha256Text(jobId) ||
        checkpointKey !== locationValue.authenticated.key ||
        !path.isAbsolute(String(tombstone.source_path || '')) ||
        path.resolve(tombstone.source_path) ===
            path.parse(path.resolve(tombstone.source_path)).root) {
        throw new Error(
            'delivery retirement tombstone identity is invalid');
    }
    safeIsoTimestamp(
        tombstone.created_at, 'delivery retirement creation timestamp');
    for (const [label, digest] of [
        ['journal', tombstone.delivered_journal_sha256],
        ['finalization', tombstone.delivery_finalization_sha256],
        ['replacement', tombstone.replacement_attestation_sha256],
        ['database row', tombstone.database_row_sha256],
        ['record', tombstone.record_sha256],
    ]) {
        if (!/^[0-9a-f]{64}$/.test(String(digest || ''))) {
            throw new Error(
                `delivery retirement ${label} digest is invalid`);
        }
    }
    if (tombstone.delivery_finalization_sha256 !==
            sha256Text(canonicalJson(tombstone.delivery_finalization)) ||
        tombstone.replacement_attestation_sha256 !==
            sha256Text(canonicalJson(tombstone.replacement_attestation)) ||
        tombstone.database_row_sha256 !==
            sha256Text(canonicalJson(tombstone.database_row)) ||
        tombstone.record_sha256 !== tombstoneDigest(tombstone)) {
        throw new Error(
            'delivery retirement tombstone canonical digest is invalid');
    }
    exactObject(
        tombstone.database_row,
        RETIREMENT_DATABASE_FIELDS.slice(), [],
        'delivery retirement database-row projection');
    deliveryFinalization.assertDatabaseRow(
        tombstone.delivery_finalization,
        tombstone.database_row);
    if (!samePath(
        tombstone.database_row.file_path, tombstone.source_path)) {
        throw new Error(
            'stored delivery retirement database path differs from the source');
    }
    if (deliveredJournal) {
        if (deliveredJournal.state !== 'delivered' ||
            !deliveredJournal.delivered ||
            deliveredJournal.transaction_id !== tombstone.transaction_id ||
            deliveredJournal.job_id !== jobId ||
            deliveredJournal.checkpoint_key !== checkpointKey ||
            tombstone.delivered_journal_sha256 !==
                sha256Text(canonicalJson(deliveredJournal)) ||
            canonicalJson(deliveredJournal.delivered.evidence) !==
                canonicalJson(tombstone.delivery_finalization) ||
            canonicalJson(deliveredJournal.replacement.evidence) !==
                canonicalJson(tombstone.replacement_attestation)) {
            throw new Error(
                'delivered journal differs from the retirement tombstone');
        }
    }
    postEncodeCheckpoint.validateRetirementInventory(
        locationValue.authenticated, tombstone.checkpoint_inventory);
    if (databaseRow !== undefined) {
        validateRetirementEvidence(
            tombstone, checkpointRecord, databaseRow);
    }
    assertRetirementNamespace(locationValue);
    return tombstone;
}

function buildRetirementTombstone(journal, checkpointRecord,
    authenticated, databaseRow) {
    if (!journal || journal.state !== 'delivered' ||
        !journal.delivered || !journal.replacement) {
        throw new Error(
            'delivery transaction retirement requires a delivered journal');
    }
    const databaseProjection =
        projectRetirementDatabaseRow(databaseRow);
    const tombstone = {
        schema: RETIREMENT_SCHEMA,
        version: RETIREMENT_VERSION,
        transaction_id: journal.transaction_id,
        job_id: journal.job_id,
        job_id_sha256: sha256Text(journal.job_id),
        checkpoint_key: journal.checkpoint_key,
        source_path: journal.source.path,
        created_at: new Date().toISOString(),
        delivered_journal_sha256:
            sha256Text(canonicalJson(journal)),
        delivery_finalization_sha256:
            sha256Text(canonicalJson(journal.delivered.evidence)),
        delivery_finalization:
            canonicalCopy(journal.delivered.evidence),
        replacement_attestation_sha256:
            sha256Text(canonicalJson(journal.replacement.evidence)),
        replacement_attestation:
            canonicalCopy(journal.replacement.evidence),
        database_row_sha256:
            sha256Text(canonicalJson(databaseProjection)),
        database_row: databaseProjection,
        checkpoint_inventory:
            postEncodeCheckpoint.retirementInventory(authenticated),
    };
    tombstone.record_sha256 = tombstoneDigest(tombstone);
    return tombstone;
}

function readRetirementTombstone(locationValue) {
    assertRetirementNamespace(locationValue);
    return readBoundedJson(
        locationValue.tombstonePath,
        'delivery retirement tombstone', MAX_RETIREMENT_BYTES);
}

function retirementIdentity(checkpointRecord) {
    const locationValue = retirementLocation(checkpointRecord);
    return withLock(locationValue, () => {
        if (journalExists(locationValue.tombstonePath)) {
            const tombstone = readRetirementTombstone(locationValue);
            assertRetirementTombstone(
                tombstone, checkpointRecord, locationValue);
            return {
                transactionId: tombstone.transaction_id,
                jobId: tombstone.job_id,
                jobIdSha256: tombstone.job_id_sha256,
                checkpointKey: tombstone.checkpoint_key,
                authority: 'retirement_tombstone',
            };
        }
        const authenticated =
            postEncodeCheckpoint.authenticateRecord(checkpointRecord);
        const journalLocation = validateLocation(authenticated);
        const journal = readJournal(
            journalLocation, checkpointRecord, true);
        if (journal.state !== 'delivered' || !journal.delivered) {
            throw new Error(
                'delivery retirement identity requires a delivered journal');
        }
        return {
            transactionId: journal.transaction_id,
            jobId: journal.job_id,
            jobIdSha256: sha256Text(journal.job_id),
            checkpointKey: journal.checkpoint_key,
            authority: 'delivered_journal',
        };
    });
}

function retire(checkpointRecord, input, options) {
    exactObject(input, ['loadDatabaseRow'], [],
        'delivery retirement input');
    if (typeof input.loadDatabaseRow !== 'function') {
        throw new Error(
            'delivery retirement requires a database-row loader');
    }
    const afterPhase = options && options.afterPhase;
    const phase = (name, details) => {
        if (typeof afterPhase === 'function') {
            afterPhase(name, details || {});
        }
    };
    const locationValue = retirementLocation(checkpointRecord);
    return withLock(locationValue, () => {
        let tombstone;
        let journal = null;
        let databaseRow;
        if (journalExists(locationValue.tombstonePath)) {
            tombstone = readRetirementTombstone(locationValue);
            databaseRow = input.loadDatabaseRow(tombstone.job_id);
            if (databaseRow && typeof databaseRow.then === 'function') {
                throw new Error(
                    'delivery retirement database loader must be synchronous');
            }
            if (journalExists(locationValue.journalPath)) {
                const authenticated =
                    postEncodeCheckpoint.authenticateRecord(checkpointRecord);
                const journalLocation = validateLocation(authenticated);
                journal = readJournal(
                    journalLocation, checkpointRecord, true);
            }
            assertRetirementTombstone(
                tombstone, checkpointRecord, locationValue,
                databaseRow, journal);
        } else {
            const authenticated =
                postEncodeCheckpoint.authenticateRecord(checkpointRecord);
            const journalLocation = validateLocation(authenticated);
            journal = readJournal(
                journalLocation, checkpointRecord, true);
            databaseRow = input.loadDatabaseRow(journal.job_id);
            if (databaseRow && typeof databaseRow.then === 'function') {
                throw new Error(
                    'delivery retirement database loader must be synchronous');
            }
            tombstone = buildRetirementTombstone(
                journal, checkpointRecord, authenticated, databaseRow);
            validateRetirementEvidence(
                tombstone, checkpointRecord, databaseRow);
            atomicExclusiveRetirementCreate(locationValue, tombstone);
            const readback = readRetirementTombstone(locationValue);
            assertRetirementTombstone(
                readback, checkpointRecord, locationValue,
                databaseRow, journal);
            if (canonicalJson(readback) !== canonicalJson(tombstone)) {
                throw new Error(
                    'delivery retirement tombstone read-back mismatch');
            }
            tombstone = readback;
            phase('tombstone_created', {
                transactionId: tombstone.transaction_id,
                checkpointKey: tombstone.checkpoint_key,
            });
        }
        if (journalExists(locationValue.journalPath)) {
            const currentJournal = journal || readBoundedJson(
                locationValue.journalPath,
                'delivery transaction journal', MAX_JOURNAL_BYTES);
            if (sha256Text(canonicalJson(currentJournal)) !==
                tombstone.delivered_journal_sha256) {
                throw new Error(
                    'delivery transaction journal digest changed before retirement');
            }
            const stat = fs.lstatSync(
                locationValue.journalPath, { bigint: true });
            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new Error(
                    'delivery transaction retirement target is not a regular file');
            }
            const current = fs.lstatSync(
                locationValue.journalPath, { bigint: true });
            if (String(current.dev) !== String(stat.dev) ||
                String(current.ino) !== String(stat.ino) ||
                !current.isFile() || current.isSymbolicLink()) {
                throw new Error(
                    'delivery transaction journal identity changed before retirement');
            }
            fs.unlinkSync(locationValue.journalPath);
            fsyncDirectory(locationValue.entryDir);
            if (journalExists(locationValue.journalPath)) {
                throw new Error(
                    'delivery transaction journal remained after retirement');
            }
            phase('journal_removed', {
                transactionId: tombstone.transaction_id,
                checkpointKey: tombstone.checkpoint_key,
            });
        }
        const checkpointRetirement =
            postEncodeCheckpoint.retireInventory(
                checkpointRecord, tombstone.checkpoint_inventory, {
                    afterFile(kind, relativeName) {
                        phase('checkpoint_file_removed', {
                            kind,
                            relativeName,
                            transactionId: tombstone.transaction_id,
                            checkpointKey: tombstone.checkpoint_key,
                        });
                    },
                });
        assertRetirementNamespace(locationValue);
        const permanentReadback =
            readRetirementTombstone(locationValue);
        assertRetirementTombstone(
            permanentReadback, checkpointRecord, locationValue,
            databaseRow);
        if (canonicalJson(permanentReadback) !==
            canonicalJson(tombstone)) {
            throw new Error(
                'permanent delivery retirement tombstone changed');
        }
        phase('retirement_complete', {
            transactionId: tombstone.transaction_id,
            checkpointKey: tombstone.checkpoint_key,
        });
        return {
            retired: true,
            transactionId: tombstone.transaction_id,
            jobId: tombstone.job_id,
            jobIdSha256: tombstone.job_id_sha256,
            checkpointKey: tombstone.checkpoint_key,
            tombstonePath: locationValue.tombstonePath,
            checkpointFilesRemoved: checkpointRetirement.removed,
            tombstoneRetained: true,
        };
    });
}

module.exports = {
    SCHEMA,
    VERSION,
    FILE_NAME,
    LOCK_NAME,
    TEMP_PREFIX,
    LOCK_SCHEMA,
    PENDING_PROOF_SCHEMA,
    CANDIDATE_VALIDATION_SCHEMA,
    COMMIT_SCHEMA,
    RETIREMENT_SCHEMA,
    RETIREMENT_VERSION,
    RETIREMENT_FILE_NAME,
    RETIREMENT_TEMP_PREFIX,
    RETIREMENT_DATABASE_FIELDS,
    STATES,
    NEXT_STATE,
    location,
    retirementLocation,
    retirementIdentity,
    create,
    load,
    transition,
    retire,
    validate,
    canonicalJson,
    sha256File,
};
