"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var fs = require('fs');
var path = require('path');
var deliveryTransaction = require('../../_lib/deliveryTransaction.js');
var vmafdb = require('../../_lib/vmafdb.js');
var DELIVERED_ROW_SELECT = 'SELECT ' +
    deliveryTransaction.RETIREMENT_DATABASE_FIELDS.join(', ') +
    ' FROM jobs WHERE job_id = ?';

function pathKey(filePath) {
    var resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isStrictChild(root, candidate) {
    var relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' &&
        !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function canonicalJobRoot(workDir) {
    var requested = String(workDir || '').trim();
    if (!requested || !path.isAbsolute(requested)) {
        throw new Error('cleanup requires an absolute args.workDir job directory');
    }
    var resolved = path.resolve(requested);
    if (resolved === path.parse(resolved).root) {
        throw new Error('cleanup refuses a filesystem root as args.workDir');
    }
    var stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('cleanup args.workDir is not a real directory: ' + resolved);
    }
    var canonical = path.resolve(fs.realpathSync(resolved));
    if (pathKey(canonical) !== pathKey(resolved)) {
        throw new Error('cleanup args.workDir contains a symlinked path component: ' + resolved);
    }
    return canonical;
}

function protectedPathKeys(paths) {
    var keys = new Set();
    (paths || []).filter(Boolean).forEach(function (filePath) {
        var resolved = path.resolve(String(filePath));
        keys.add(pathKey(resolved));
        try { keys.add(pathKey(fs.realpathSync(resolved))); } catch (_) {}
    });
    return keys;
}

function inspectCleanupCandidate(root, candidate, protectedKeys) {
    var resolved = path.resolve(String(candidate || ''));
    if (!isStrictChild(root, resolved)) {
        throw new Error('cleanup path is outside the canonical job directory: ' + resolved);
    }
    if (protectedKeys.has(pathKey(resolved))) {
        return { path: resolved, protected: true, exists: fs.existsSync(resolved) };
    }
    if (!fs.existsSync(resolved)) return { path: resolved, protected: false, exists: false };
    var stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('cleanup path is not a non-symlink regular file: ' + resolved);
    }
    var canonical = path.resolve(fs.realpathSync(resolved));
    if (pathKey(canonical) !== pathKey(resolved) || !isStrictChild(root, canonical)) {
        throw new Error('cleanup path contains a symlinked component or escaped the job directory: ' + resolved);
    }
    if (protectedKeys.has(pathKey(canonical))) {
        return { path: resolved, protected: true, exists: true };
    }
    return { path: resolved, protected: false, exists: true };
}

function removeJobOwnedCandidates(workDir, candidates, protectedPaths, jobLog) {
    var root = canonicalJobRoot(workDir);
    var protectedKeys = protectedPathKeys(protectedPaths);
    var unique = [];
    var seen = new Set();
    (candidates || []).filter(Boolean).forEach(function (candidate) {
        var key = pathKey(candidate);
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(candidate);
        }
    });

    // Validate the complete mutable manifest before deleting anything. A
    // poisoned path therefore cannot produce a partial cleanup that still
    // reports success.
    var inspected = unique.map(function (candidate) {
        return inspectCleanupCandidate(root, candidate, protectedKeys);
    });
    var deleted = [];
    var protectedSkipped = [];
    var missing = [];
    var failed = [];
    inspected.forEach(function (item) {
        if (item.protected) {
            protectedSkipped.push(item.path);
            return;
        }
        if (!item.exists) {
            missing.push(item.path);
            return;
        }
        try {
            fs.unlinkSync(item.path);
            if (fs.existsSync(item.path)) {
                throw new Error('path still exists after unlink');
            }
            deleted.push(item.path);
        } catch (error) {
            failed.push({ path: item.path, reason: error.message });
            if (typeof jobLog === 'function') {
                jobLog('Could not delete job temporary file: ' + item.path + ' - ' + error.message);
            }
        }
    });
    return {
        root: root,
        deleted: deleted,
        protectedSkipped: protectedSkipped,
        missing: missing,
        failed: failed,
    };
}

function retireDeliveredCheckpoint(checkpointRecord, database) {
    var statement = database.prepare(DELIVERED_ROW_SELECT);
    return deliveryTransaction.retire(checkpointRecord, {
        loadDatabaseRow: function (jobId) {
            return statement.get(jobId);
        },
    });
}

function deliveryRetirementBoundaryExists(checkpointRecord) {
    try {
        var located =
            deliveryTransaction.retirementLocation(checkpointRecord);
        return fs.existsSync(located.journalPath) ||
            fs.existsSync(located.tombstonePath);
    } catch (_) {
        return false;
    }
}

var details = function () { return ({
    name: 'Cleanup Temporary Files',
    description: 'Deletes only job-owned VMAF temporary files recorded in the flow manifest.',
    style: { borderColor: 'gray' },
    tags: 'video,cleanup,maintenance',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faTrash',
    inputs: [{ label: 'Cleanup Enabled', name: 'cleanupEnabled', type: 'boolean', defaultValue: 'true',
        inputUI: { type: 'switch' }, tooltip: 'Enable deletion of job-owned temporary files.' }],
    outputs: [{ number: 1, tooltip: 'Cleanup completed' }],
}); };
exports.details = details;
var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    if (args.inputs.cleanupEnabled === false || args.inputs.cleanupEnabled === 'false') {
        args.jobLog('Cleanup disabled - temporary files will be preserved');
        return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
    }
    var cacheDir = args.workDir;
    var candidates = (args.variables.vmafTemporaryFiles || []).slice();
    (args.variables.vmafSamples || []).forEach(function (file) { candidates.push(file); });
    (args.variables.vmafOriginalSourceSamples || []).forEach(function (file) { candidates.push(file); });
    (args.variables.vmafTestResults || []).forEach(function (item) { candidates.push(item && item.outputPath); });
    (args.variables.vmafEncodeFailures || []).forEach(function (item) { candidates.push(item && item.outputPath); });
    if (args.variables.vmafHoldoutSample) {
        candidates.push(args.variables.vmafHoldoutSample.path);
        candidates.push(args.variables.vmafHoldoutSample.originalPath);
    }
    candidates.push(args.variables.vmafTranscodeOutputPath);
    var protectedPaths = [args.inputFileObj && args.inputFileObj._id,
        args.inputFileObj && args.inputFileObj.file, args.variables.vmafOriginalFile]
        .filter(Boolean);
    var errorCount = 0;
    args.jobLog('=== Cleaning Up Job-Owned Temporary Files ===');
    var cleanup;
    try {
        cleanup = removeJobOwnedCandidates(cacheDir, candidates, protectedPaths, args.jobLog);
    } catch (containmentError) {
        args.variables.vmafCleanupFailedPaths = candidates.filter(Boolean).map(String);
        args.variables.vmafCleanupStatus = 'failed_containment';
        throw new Error('temporary cleanup containment validation failed: ' + containmentError.message);
    }
    if (cleanup.failed.length) {
        errorCount += cleanup.failed.length;
        args.variables.vmafCleanupFailedPaths = cleanup.failed.map(function (item) { return item.path; });
    } else {
        delete args.variables.vmafCleanupFailedPaths;
    }
    args.variables.vmafTemporaryFiles = cleanup.failed.map(function (item) { return item.path; });
    var checkpointRecord = args.variables.vmafPostEncodeCheckpoint;
    if (checkpointRecord) {
        var retirementBoundary =
            deliveryRetirementBoundaryExists(checkpointRecord);
        if (!retirementBoundary) {
            args.variables.vmafPostEncodeCheckpointRetired = false;
            args.variables.vmafReplacementAttestationVerified = false;
            args.variables.vmafDeliveryFinalizationVerified = false;
            args.variables.vmafDeliveryFinalizationFailureReason =
                'no durable delivery transaction or retirement tombstone exists';
            args.jobLog(
                'Retaining protected post-encode checkpoint because no delivery boundary exists.');
        } else try {
            var retirement = retireDeliveredCheckpoint(
                checkpointRecord, vmafdb.openDb());
            args.variables.vmafPostEncodeCheckpointRetired = true;
            args.variables.vmafReplacementAttestationVerified = true;
            args.variables.vmafDeliveryFinalizationVerified = true;
            args.variables.vmafDeliveryRetirementTombstone =
                retirement.tombstonePath;
            delete args.variables.vmafReplacementAttestationFailureReason;
            delete args.variables.vmafDeliveryFinalizationFailureReason;
            args.jobLog(
                'Retired protected post-encode payload after journal-, tombstone-, and DB-authenticated delivery: ' +
                checkpointRecord.checkpoint_key +
                ' (permanent retirement tombstone retained)');
        } catch (checkpointCleanupError) {
            errorCount++;
            args.variables.vmafPostEncodeCheckpointRetired = false;
            args.variables.vmafReplacementAttestationVerified = false;
            args.variables.vmafDeliveryFinalizationVerified = false;
            args.variables.vmafDeliveryFinalizationFailureReason =
                checkpointCleanupError.message;
            args.jobLog(
                'Retaining protected post-encode checkpoint because the journal/tombstone/DB retirement authority is incomplete: ' +
                checkpointCleanupError.message +
                ' (delivery boundary requires recovery)');
        }
    } else {
        args.variables.vmafPostEncodeCheckpointRetired = false;
    }
    if (errorCount) {
        args.variables.vmafCleanupStatus = 'failed';
        throw new Error('temporary cleanup did not complete: ' + errorCount +
            ' deletion or checkpoint retirement error(s)');
    }
    args.variables.vmafCleanupStatus = 'success';
    args.jobLog('Cleanup completed: ' + cleanup.deleted.length + ' job-owned files deleted, ' +
        cleanup.protectedSkipped.length + ' protected paths skipped, ' + cleanup.missing.length + ' already absent'
        + (errorCount ? ', ' + errorCount + ' errors' : ''));
    return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
exports.plugin = plugin;
exports._test = {
    canonicalJobRoot: canonicalJobRoot,
    inspectCleanupCandidate: inspectCleanupCandidate,
    removeJobOwnedCandidates: removeJobOwnedCandidates,
    DELIVERED_ROW_SELECT: DELIVERED_ROW_SELECT,
    retireDeliveredCheckpoint: retireDeliveredCheckpoint,
    deliveryRetirementBoundaryExists:
        deliveryRetirementBoundaryExists,
};
