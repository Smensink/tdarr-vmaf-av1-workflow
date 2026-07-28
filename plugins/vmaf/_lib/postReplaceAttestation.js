'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'tdarr-vmaf-post-replace-attestation';
const VERSION = 2;
const BACKUP_SUFFIX = '.partial.old';
const BACKUP_DELETE_ATTEMPTS = 3;
const BACKUP_DELETE_DELAYS_MS = Object.freeze([100, 250]);
const COMPLETED_OUTCOMES = Object.freeze({
    installed_verified: true,
    backup_retained: true,
});

async function fsyncDirectory(directory) {
    if (process.platform === 'win32') return;
    const handle = await fs.promises.open(directory, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

function pathKey(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function statIdentity(stat) {
    return {
        dev: String(stat.dev),
        ino: String(stat.ino),
        size_bytes: Number(stat.size),
        mtime_ms: Math.trunc(Number(stat.mtimeMs)),
        ctime_ms: Math.trunc(Number(stat.ctimeMs)),
        mtime_ns: String(stat.mtimeNs),
        ctime_ns: String(stat.ctimeNs),
    };
}

function sha256FileSync(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    try {
        for (;;) {
            const count = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!count) break;
            hash.update(buffer.subarray(0, count));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function assertIdentityMatches(expected, actual, label) {
    if (!expected || typeof expected !== 'object') {
        throw new Error(`${label} identity is missing`);
    }
    for (const key of ['dev', 'ino']) {
        if (!String(expected[key] || '') ||
            String(expected[key]) !== String(actual[key])) {
            throw new Error(`${label} ${key} changed`);
        }
    }
    for (const key of ['size_bytes', 'mtime_ms', 'ctime_ms']) {
        if (!Number.isFinite(Number(expected[key])) ||
            Number(expected[key]) !== Number(actual[key])) {
            throw new Error(`${label} ${key} changed`);
        }
    }
    for (const key of ['mtime_ns', 'ctime_ns', 'sha256_full']) {
        if (!String(expected[key] || '') ||
            String(expected[key]) !== String(actual[key] || '')) {
            throw new Error(`${label} ${key} changed`);
        }
    }
}

function inspectInstalledFile(filePath) {
    const requested = String(filePath || '').trim();
    if (!requested || !path.isAbsolute(requested)) {
        throw new Error('replacement target path is missing or not absolute');
    }
    const resolved = path.resolve(requested);
    if (resolved === path.parse(resolved).root) {
        throw new Error('replacement target path is missing or unsafe');
    }
    const stat = fs.lstatSync(resolved, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0n) {
        throw new Error('replacement target is not a non-empty regular file');
    }
    const canonical = path.resolve(fs.realpathSync(resolved));
    if (pathKey(canonical) !== pathKey(resolved)) {
        throw new Error('replacement target contains a symlinked path component');
    }
    const identity = statIdentity(stat);
    identity.sha256_full = sha256FileSync(canonical);
    return { path: canonical, stat, identity };
}

function exactBackupPath(originalPath) {
    return `${path.resolve(String(originalPath || ''))}${BACKUP_SUFFIX}`;
}

function create(input) {
    const installed = inspectInstalledFile(input.targetPath);
    const requestedOriginalPath = String(input.originalPath || '').trim();
    if (!requestedOriginalPath || !path.isAbsolute(requestedOriginalPath)) {
        throw new Error('replacement original path is missing or not absolute');
    }
    const originalPath = path.resolve(requestedOriginalPath);
    if (originalPath === path.parse(originalPath).root) {
        throw new Error('replacement original path is missing or unsafe');
    }
    const outcome = input.backupRetained ? 'backup_retained' : 'installed_verified';
    const checkpointKey = input.checkpointKey == null ? null : String(input.checkpointKey);
    let backupPath = null;
    let backupIdentity = null;
    if (input.backupRetained) {
        backupPath = exactBackupPath(originalPath);
        const backup = inspectInstalledFile(backupPath);
        if (pathKey(backup.path) !== pathKey(backupPath)) {
            throw new Error('replacement backup path is not exact');
        }
        backupIdentity = backup.identity;
    }
    return {
        schema: SCHEMA,
        version: VERSION,
        replacement_completed: true,
        outcome,
        target_path: installed.path,
        original_path: originalPath,
        checkpoint_key: checkpointKey,
        installed: installed.identity,
        backup_path: backupPath,
        backup: backupIdentity,
        attested_at_ms: Date.now(),
    };
}

function validate(attestation, context) {
    try {
        if (!attestation || typeof attestation !== 'object' ||
            attestation.schema !== SCHEMA ||
            attestation.version !== VERSION ||
            attestation.replacement_completed !== true ||
            COMPLETED_OUTCOMES[String(attestation.outcome || '')] !== true) {
            return { valid: false, reason: 'missing or unsupported completed replacement attestation' };
        }
        const checkpointRecord = context && context.checkpointRecord;
        const checkpointKey = checkpointRecord && String(checkpointRecord.checkpoint_key || '');
        if (!checkpointKey || attestation.checkpoint_key !== checkpointKey) {
            return { valid: false, reason: 'replacement attestation is not bound to this checkpoint' };
        }
        const inputPath = context && context.inputPath;
        if (!inputPath || pathKey(attestation.target_path) !== pathKey(inputPath)) {
            return { valid: false, reason: 'replacement attestation target differs from flow input' };
        }
        const originalPath = context && context.originalPath;
        if (!originalPath || pathKey(attestation.original_path) !== pathKey(originalPath)) {
            return { valid: false, reason: 'replacement attestation original differs from flow source' };
        }
        const installed = inspectInstalledFile(attestation.target_path);
        const expected = attestation.installed || {};
        assertIdentityMatches(expected, installed.identity, 'replacement target');
        if (attestation.outcome === 'backup_retained') {
            const requiredBackupPath = exactBackupPath(originalPath);
            if (!attestation.backup_path ||
                pathKey(attestation.backup_path) !== pathKey(requiredBackupPath) ||
                !attestation.backup) {
                return { valid: false, reason: 'replacement backup provenance is missing or inexact' };
            }
            if (context && context.requireRetainedBackup === true) {
                const backup = inspectInstalledFile(requiredBackupPath);
                assertIdentityMatches(attestation.backup, backup.identity,
                    'replacement backup');
            }
        }
        return {
            valid: true,
            reason: null,
            outcome: attestation.outcome,
            targetPath: installed.path,
        };
    } catch (error) {
        return { valid: false, reason: `replacement attestation verification failed: ${error.message}` };
    }
}

async function retireRetainedBackup(attestation, options) {
    if (!attestation || attestation.schema !== SCHEMA ||
        attestation.version !== VERSION || attestation.outcome !== 'backup_retained') {
        throw new Error('exact backup retirement requires a current backup-retained attestation');
    }
    const originalPath = path.resolve(String(attestation.original_path || ''));
    const backupPath = exactBackupPath(originalPath);
    if (!attestation.backup_path ||
        pathKey(attestation.backup_path) !== pathKey(backupPath) ||
        !attestation.backup) {
        throw new Error('exact backup retirement has no authenticated backup identity');
    }
    const operations = Object.assign({
        lstat: fs.promises.lstat.bind(fs.promises),
        unlink: fs.promises.unlink.bind(fs.promises),
        fsyncDirectory,
    }, options && options.operations);
    const delay = options && options.delay
        ? options.delay
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let lastError = null;
    for (let attempt = 1; attempt <= BACKUP_DELETE_ATTEMPTS; attempt += 1) {
        let exists = true;
        try {
            await operations.lstat(backupPath);
        } catch (error) {
            if (error && error.code === 'ENOENT') exists = false;
            else throw error;
        }
        if (!exists) {
            await operations.fsyncDirectory(path.dirname(backupPath));
            return { retained: false, attempts: attempt, backupPath, lastError: null };
        }
        const backup = inspectInstalledFile(backupPath);
        assertIdentityMatches(attestation.backup, backup.identity,
            'replacement backup');
        try {
            await operations.unlink(backupPath);
            lastError = null;
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                await operations.fsyncDirectory(path.dirname(backupPath));
                return { retained: false, attempts: attempt, backupPath, lastError: null };
            }
            lastError = error;
        }
        try {
            await operations.lstat(backupPath);
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                await operations.fsyncDirectory(path.dirname(backupPath));
                return { retained: false, attempts: attempt, backupPath, lastError: null };
            }
            lastError = error;
        }
        if (attempt < BACKUP_DELETE_ATTEMPTS) {
            await delay(BACKUP_DELETE_DELAYS_MS[attempt - 1]);
        }
    }
    return {
        retained: true,
        attempts: BACKUP_DELETE_ATTEMPTS,
        backupPath,
        lastError,
    };
}

module.exports = {
    SCHEMA,
    VERSION,
    COMPLETED_OUTCOMES,
    create,
    validate,
    inspectInstalledFile,
    statIdentity,
    sha256FileSync,
    assertIdentityMatches,
    exactBackupPath,
    retireRetainedBackup,
};
