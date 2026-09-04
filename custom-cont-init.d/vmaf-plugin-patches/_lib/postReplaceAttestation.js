'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA = 'tdarr-vmaf-post-replace-attestation';
const VERSION = 2;
const BACKUP_SUFFIX = '.partial.old';
const BACKUP_DELETE_ATTEMPTS = 3;
const BACKUP_DELETE_DELAYS_MS = Object.freeze([100, 250]);
const HASH_CACHE_MAX_ENTRIES = 64;
const COMPLETED_OUTCOMES = Object.freeze({
    installed_verified: true,
    backup_retained: true,
});
const fullHashCache = new Map();
const fullHashStats = { hits: 0, misses: 0, hashed_bytes: 0 };

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

function fullIdentityKey(identity) {
    return [
        identity.dev,
        identity.ino,
        identity.size_bytes,
        identity.mtime_ns,
        identity.ctime_ns,
    ].map(String).join('\u0000');
}

function sameStatIdentity(left, right) {
    return fullIdentityKey(left) === fullIdentityKey(right);
}

function rememberFullHash(key, sha256) {
    if (fullHashCache.has(key)) fullHashCache.delete(key);
    fullHashCache.set(key, sha256);
    while (fullHashCache.size > HASH_CACHE_MAX_ENTRIES) {
        fullHashCache.delete(fullHashCache.keys().next().value);
    }
}

function fullHashForStableIdentity(filePath, identity) {
    const key = fullIdentityKey(identity);
    if (fullHashCache.has(key)) {
        const value = fullHashCache.get(key);
        // Refresh LRU order. The cache key includes ctime_ns, which callers cannot
        // restore after a content mutation; same-size rewrites therefore miss.
        rememberFullHash(key, value);
        fullHashStats.hits += 1;
        return value;
    }
    const sha256 = sha256FileSync(filePath);
    const after = statIdentity(fs.lstatSync(filePath, { bigint: true }));
    if (!sameStatIdentity(identity, after)) {
        throw new Error('replacement file changed while full SHA-256 was being calculated');
    }
    fullHashStats.misses += 1;
    fullHashStats.hashed_bytes += Number(identity.size_bytes);
    rememberFullHash(key, sha256);
    return sha256;
}

function hashCacheStats() {
    return {
        hits: fullHashStats.hits,
        misses: fullHashStats.misses,
        hashed_bytes: fullHashStats.hashed_bytes,
        entries: fullHashCache.size,
    };
}

// A successful hard-link operation changes ctime/link-count but cannot change
// the inode's bytes. Carry an already authenticated full hash to the new stat
// identity only when dev, inode, size and mtime_ns remain exact. Copies and
// renames to a different inode deliberately cannot use this shortcut.
function carryForwardHardLinkHash(filePath, previousIdentity) {
    if (!previousIdentity || !/^[0-9a-f]{64}$/.test(
        String(previousIdentity.sha256_full || ''))) {
        throw new Error('hard-link hash carry-forward requires an authenticated full hash');
    }
    const requested = String(filePath || '').trim();
    if (!requested || !path.isAbsolute(requested)) {
        throw new Error('hard-link hash carry-forward path must be absolute');
    }
    const resolved = path.resolve(requested);
    const stat = fs.lstatSync(resolved, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0n) {
        throw new Error('hard-link hash carry-forward target is not a regular file');
    }
    const identity = statIdentity(stat);
    for (const key of ['dev', 'ino', 'size_bytes', 'mtime_ns']) {
        if (String(identity[key]) !== String(previousIdentity[key])) {
            throw new Error(`hard-link hash carry-forward ${key} changed`);
        }
    }
    rememberFullHash(fullIdentityKey(identity), previousIdentity.sha256_full);
    return Object.assign({}, identity, {
        sha256_full: previousIdentity.sha256_full,
    });
}

function resetHashCacheForTests() {
    fullHashCache.clear();
    fullHashStats.hits = 0;
    fullHashStats.misses = 0;
    fullHashStats.hashed_bytes = 0;
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
    identity.sha256_full = fullHashForStableIdentity(canonical, identity);
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
    hashCacheStats,
    carryForwardHardLinkHash,
    resetHashCacheForTests,
};
