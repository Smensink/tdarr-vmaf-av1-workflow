"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
/* eslint no-plusplus: ["error", { "allowForLoopAfterthoughts": true }] */
var fs = require("fs");
var crypto = require("crypto");
var path = require("path");

var MAX_RECOVERY_JSON_BYTES = 64 * 1024;
var TOO_YOUNG_RECORD_ROOT = '/app/configs/too_young_files.d';

function sha256Text(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function calculateFileAge(fileDate, now) {
    var timestamp = Number(fileDate);
    var currentTime = now === undefined ? Date.now() : Number(now);
    if (!Number.isFinite(timestamp) || timestamp <= 0 ||
        !Number.isFinite(currentTime) || currentTime <= 0) {
        throw new Error('file age calculation requires valid positive timestamps');
    }
    var future = timestamp > currentTime;
    var ageMs = future ? 0 : currentTime - timestamp;
    return {
        timestamp: timestamp,
        ageMs: ageMs,
        ageDays: ageMs / (24 * 60 * 60 * 1000),
        future: future,
    };
}

function persistTooYoungFirstSeen(record, recordRoot) {
    var sourcePath = path.resolve(String(record && record.file || ''));
    if (!sourcePath || sourcePath === path.parse(sourcePath).root) {
        throw new Error('too-young record source path is empty or unsafe');
    }
    var root = path.resolve(String(recordRoot || TOO_YOUNG_RECORD_ROOT));
    fs.mkdirSync(root, { recursive: true });
    var rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
        path.resolve(fs.realpathSync(root)) !== root) {
        throw new Error('too-young record root is not a canonical real directory');
    }
    var sourceKey = sha256Text(sourcePath);
    var recordPath = path.join(root, sourceKey + '.json');
    if (!pathWithin(root, recordPath)) {
        throw new Error('too-young record path escaped its protected root');
    }
    var firstSeenRecord = Object.assign({}, record, {
        schema: 1,
        sourceKey: sourceKey,
        file: sourcePath,
        firstObservedAt: new Date().toISOString(),
    });
    var payload = JSON.stringify(firstSeenRecord, null, 2) + '\n';
    if (Buffer.byteLength(payload, 'utf8') > MAX_RECOVERY_JSON_BYTES) {
        throw new Error('too-young first-seen record is too large');
    }

    // Publish a complete inode with an atomic no-replace hard link. Concurrent
    // workers for the same source race only on the link: exactly one wins and
    // the immutable first-seen timestamp cannot be overwritten.
    var temporaryPath = path.join(root, '.' + sourceKey + '.' + process.pid + '.' +
        crypto.randomBytes(8).toString('hex') + '.tmp');
    try {
        fs.writeFileSync(temporaryPath, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        try {
            fs.linkSync(temporaryPath, recordPath);
            return { created: true, path: recordPath, record: firstSeenRecord };
        } catch (linkError) {
            if (!linkError || linkError.code !== 'EEXIST') throw linkError;
        }
    } finally {
        try { fs.unlinkSync(temporaryPath); } catch (cleanupError) {
            if (!cleanupError || cleanupError.code !== 'ENOENT') throw cleanupError;
        }
    }

    var existing = readBoundedJson(recordPath, 'too-young first-seen record');
    if (existing.schema !== 1 || existing.sourceKey !== sourceKey ||
        path.resolve(String(existing.file || '')) !== sourcePath ||
        !Number.isFinite(Date.parse(String(existing.firstObservedAt || '')))) {
        throw new Error('existing too-young first-seen record identity is invalid');
    }
    return { created: false, path: recordPath, record: existing };
}

function pathWithin(rootPath, childPath) {
    var relative = path.relative(path.resolve(rootPath), path.resolve(childPath));
    return relative !== '' && relative !== '..' &&
        !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function assertRealDirectory(directory, description) {
    var resolved = path.resolve(String(directory || ''));
    if (!resolved || resolved === path.parse(resolved).root) {
        throw new Error(description + ' path is empty or unsafe');
    }
    var stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(description + ' is not a real directory');
    }
    if (path.resolve(fs.realpathSync(resolved)) !== resolved) {
        throw new Error(description + ' contains a symlinked path component');
    }
    return resolved;
}

function readBoundedJson(filePath, description) {
    var resolved = path.resolve(String(filePath || ''));
    var stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() ||
        stat.size <= 0 || stat.size > MAX_RECOVERY_JSON_BYTES) {
        throw new Error(description + ' is not a bounded regular file');
    }
    if (path.resolve(fs.realpathSync(resolved)) !== resolved) {
        throw new Error(description + ' contains a symlinked path component');
    }
    var value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(description + ' is not a JSON object');
    }
    return value;
}

function regularHexDigest(value) {
    return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function loadRecoveryLibraries() {
    // The persistent patch payload and the deployed Tdarr catalogs have
    // different directory layouts. Only these two pinned sibling locations are
    // accepted; neither is influenced by media metadata or Flow input.
    var candidates = [
        path.resolve(__dirname, '../../../vmaf/_lib'),
        path.resolve(__dirname, '../../../vmaf-plugin-patches/_lib'),
    ];
    for (var index = 0; index < candidates.length; index++) {
        var helperRoot = candidates[index];
        var checkpointPath = path.join(helperRoot, 'postEncodeCheckpoint.js');
        var grainArtifactPath = path.join(helperRoot, 'grainAnalysisArtifact.js');
        if (fs.existsSync(checkpointPath) && fs.existsSync(grainArtifactPath)) {
            return {
                checkpoint: require(checkpointPath),
                grainArtifact: require(grainArtifactPath),
            };
        }
    }
    throw new Error('pinned retained-recovery helpers are unavailable');
}

function authenticateRetainedRecoveryAgeBypass(sourcePath) {
    try {
        var libraries = loadRecoveryLibraries();
        var checkpoint = libraries.checkpoint;
        var grainArtifact = libraries.grainArtifact;
        var checkpointRoot = path.resolve(process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT ||
            checkpoint.PINNED_CHECKPOINT_ROOT);
        var reuseRequiredRoot = path.resolve(process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT ||
            checkpoint.PINNED_REUSE_REQUIRED_ROOT);
        var unitTestStorageOverride = process.platform === 'win32' &&
            process.env.NODE_ENV === 'test' &&
            process.env.VMAF_POSTENCODE_TEST_UNPINNED_STORAGE === '1';
        if (!unitTestStorageOverride) {
            checkpoint.assertPinnedStorage(checkpointRoot, reuseRequiredRoot);
        }
        checkpoint.assertReuseRequiredRoot(reuseRequiredRoot);
        checkpointRoot = assertRealDirectory(checkpointRoot, 'post-encode checkpoint root');

        var requestedSource = path.resolve(String(sourcePath || ''));
        var resolvedSource = fs.realpathSync(requestedSource);
        if (path.resolve(resolvedSource) !== requestedSource) {
            throw new Error('source contains a symlinked path component');
        }
        var sourceFingerprint = grainArtifact.sampledSourceFingerprint(resolvedSource);
        var sourceScopeKey = sha256Text(checkpoint.canonicalJson({
            contract_id: checkpoint.REUSE_REQUIRED_CONTRACT_ID,
            source_fingerprint: sourceFingerprint,
        }));
        var markerBucket = path.join(reuseRequiredRoot, sourceScopeKey.slice(0, 2));
        var markerPath = path.join(markerBucket, sourceScopeKey + '.json');
        if (!pathWithin(reuseRequiredRoot, markerPath)) {
            throw new Error('derived recovery marker escaped its protected root');
        }
        assertRealDirectory(markerBucket, 'reuse-required marker bucket');
        var marker = readBoundedJson(markerPath, 'reuse-required marker');
        if (marker.schema !== checkpoint.REUSE_REQUIRED_SCHEMA ||
            marker.contract_id !== checkpoint.REUSE_REQUIRED_CONTRACT_ID ||
            marker.state !== 'reuse_required' ||
            marker.created_by !== 'retained-output-import-v1' ||
            marker.source_scope_key !== sourceScopeKey ||
            checkpoint.canonicalJson(marker.source_fingerprint) !==
                checkpoint.canonicalJson(sourceFingerprint) ||
            !regularHexDigest(marker.checkpoint_key) ||
            !regularHexDigest(marker.encode_contract_sha256) ||
            !marker.source || !regularHexDigest(marker.source.sha256_full) ||
            !marker.artifact || !Number.isSafeInteger(Number(marker.artifact.size_bytes)) ||
            Number(marker.artifact.size_bytes) <= 0 ||
            !regularHexDigest(marker.artifact.sha256_full)) {
            throw new Error('reuse-required marker identity is invalid');
        }

        var checkpointBucket = path.join(checkpointRoot, marker.checkpoint_key.slice(0, 2));
        var checkpointEntry = path.join(checkpointBucket, marker.checkpoint_key);
        var manifestPath = path.join(checkpointEntry, 'manifest.json');
        if (!pathWithin(checkpointRoot, manifestPath)) {
            throw new Error('derived checkpoint manifest escaped its protected root');
        }
        assertRealDirectory(checkpointBucket, 'checkpoint bucket');
        assertRealDirectory(checkpointEntry, 'checkpoint entry');
        var manifest = readBoundedJson(manifestPath, 'checkpoint manifest');
        var encodeContractDigest = sha256Text(checkpoint.canonicalJson(manifest.encode_contract));
        var expectedCheckpointKey = sha256Text(checkpoint.canonicalJson({
            contract_id: checkpoint.CONTRACT_ID,
            source_fingerprint: sourceFingerprint,
            encode_contract_sha256: encodeContractDigest,
        }));
        if (manifest.schema !== checkpoint.SCHEMA ||
            manifest.contract_id !== checkpoint.CONTRACT_ID ||
            manifest.checkpoint_key !== marker.checkpoint_key ||
            expectedCheckpointKey !== marker.checkpoint_key ||
            manifest.encode_contract_sha256 !== encodeContractDigest ||
            encodeContractDigest !== marker.encode_contract_sha256 ||
            checkpoint.canonicalJson(manifest.source_fingerprint) !==
                checkpoint.canonicalJson(sourceFingerprint) ||
            !manifest.artifact ||
            Number(manifest.artifact.size_bytes) !== Number(marker.artifact.size_bytes) ||
            manifest.artifact.sha256_full !== marker.artifact.sha256_full) {
            throw new Error('checkpoint manifest identity does not match the recovery latch');
        }

        var artifactName = String(manifest.artifact.relative_path || '');
        if (!artifactName || artifactName === '.' || artifactName === '..' ||
            path.basename(artifactName) !== artifactName) {
            throw new Error('checkpoint artifact path is unsafe');
        }
        var artifactPath = path.join(checkpointEntry, artifactName);
        if (!pathWithin(checkpointEntry, artifactPath)) {
            throw new Error('checkpoint artifact escaped its protected entry');
        }
        var artifactStatBefore = fs.lstatSync(artifactPath);
        if (!artifactStatBefore.isFile() || artifactStatBefore.isSymbolicLink() ||
            artifactStatBefore.size !== Number(marker.artifact.size_bytes) ||
            path.resolve(fs.realpathSync(artifactPath)) !== path.resolve(artifactPath)) {
            throw new Error('checkpoint artifact is not the expected regular file');
        }
        var mediaValidation = manifest.media_validation || {};
        var primary = mediaValidation.primary || {};
        if (mediaValidation.validator !== 'ffprobe-demux-plus-full-decode-v1' ||
            mediaValidation.full_primary_video_decode !== true ||
            Number(mediaValidation.size_bytes) !== artifactStatBefore.size ||
            Number(mediaValidation.ordinary_video_streams) !== 1 ||
            primary.codec_name !== 'av1' ||
            !Number.isFinite(Number(primary.width)) || Number(primary.width) <= 0 ||
            !Number.isFinite(Number(primary.height)) || Number(primary.height) <= 0 ||
            !Number.isFinite(Number(primary.packet_count)) || Number(primary.packet_count) <= 0) {
            throw new Error('checkpoint media validation is incomplete');
        }

        // The retained artifact is small enough to authenticate here. The much
        // larger source receives a sampled identity check now and its mandatory
        // full SHA-256 check again in vmafOptimizedTranscode immediately before
        // checkpoint reuse. That later latch is the final no-encoder authority.
        var artifactDigest = checkpoint.sha256FileSync(artifactPath);
        var artifactStatAfter = fs.lstatSync(artifactPath);
        if (artifactDigest !== marker.artifact.sha256_full ||
            artifactStatAfter.size !== artifactStatBefore.size ||
            artifactStatAfter.mtimeMs !== artifactStatBefore.mtimeMs) {
            throw new Error('checkpoint artifact bytes do not match the recovery latch');
        }
        var sourceStatAfter = fs.statSync(resolvedSource, { bigint: true });
        if (!sourceStatAfter.isFile() ||
            sourceStatAfter.size !== BigInt(sourceFingerprint.size_bytes) ||
            Number(sourceStatAfter.mtimeNs) !== Number(sourceFingerprint.mtime_ns)) {
            throw new Error('source changed during retained-recovery authentication');
        }
        return {
            authorized: true,
            checkpointKey: marker.checkpoint_key,
            sourceScopeKey: sourceScopeKey,
            artifactPath: artifactPath,
            artifactSha256: artifactDigest,
        };
    } catch (error) {
        return {
            authorized: false,
            reason: error && error.message ? error.message : String(error),
        };
    }
}

var details = function () { return ({
    name: 'Check File Age',
    description: 'Filter files by age. Files younger than the specified threshold (default: 30 days) will cause the flow to fail. '
        + 'Useful for preventing transcoding of recently added files.',
    style: {
        borderColor: 'orange',
    },
    tags: 'filter,video,audio',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faQuestion',
    inputs: [
        {
            label: 'Minimum Age (Days)',
            name: 'minAgeDays',
            type: 'number',
            defaultValue: '30',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Minimum age in days a file must be before processing. Default is 30 (1 month).',
        },
        {
            label: 'Date Type',
            name: 'dateType',
            type: 'string',
            defaultValue: 'creation',
            inputUI: {
                type: 'dropdown',
                options: [
                    'creation',
                    'modification',
                    'tdarr-added',
                ],
            },
            tooltip: 'Which date to use for age calculation: creation (file system birthtime), modification (file system mtime), or tdarr-added (when Tdarr first discovered the file).',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'File is old enough (>= threshold) - proceed with processing',
        },
    ],
}); };
exports.details = details;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
var plugin = function (args) {
    try {
        var lib = require('../../../../../methods/lib')();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        // Get the minimum age from user input, ensuring it's a valid number
        var inputMinAge = args.inputs.minAgeDays;
        args.jobLog("DEBUG: Raw input value for minAgeDays: ".concat(JSON.stringify(inputMinAge), " (type: ").concat(typeof inputMinAge, ")"));

        var minAgeDays = 30; // Default fallback

        if (inputMinAge !== undefined && inputMinAge !== null && inputMinAge !== '') {
            var parsed = Number(inputMinAge);
            if (!isNaN(parsed) && parsed > 0) {
                minAgeDays = parsed;
                args.jobLog("DEBUG: Using user-provided minimum age: ".concat(minAgeDays, " days"));
            } else {
                args.jobLog("WARNING: Invalid minAgeDays input value (".concat(inputMinAge, "), using default 30 days"));
            }
        } else {
            args.jobLog("DEBUG: No user input provided, using default minimum age: 30 days");
        }

        var minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;

        args.jobLog("Check File Age: Starting age check (minimum: ".concat(minAgeDays, " days, date type: ").concat(args.inputs.dateType || 'creation', ")"));

        // Try to use Tdarr's statSync first (more reliable), fallback to fs.statSync
        var stats = null;
        try {
            if (args.originalLibraryFile && args.originalLibraryFile.statSync) {
                stats = args.originalLibraryFile.statSync;
                args.jobLog("Using originalLibraryFile.statSync for age calculation");
            } else {
                var filePath = args.inputFileObj._id;
                stats = fs.statSync(filePath);
                args.jobLog("Using fs.statSync for age calculation");
            }
        } catch (err) {
            args.jobLog("Error getting file stats: ".concat(err.message));
            throw new Error("Could not get file stats: ".concat(err.message));
        }

        // Get the appropriate date based on user selection
        var fileDate;
        var dateUsed = args.inputs.dateType || 'creation';

        if (args.inputs.dateType === 'tdarr-added') {
            // Use Tdarr's createdAt timestamp (when file was first discovered/added to library)
            var createdAt = null;

            // Extract createdAt value from either location
            if (args.originalLibraryFile && args.originalLibraryFile.createdAt) {
                createdAt = args.originalLibraryFile.createdAt;
            } else if (args.originalLibraryFile && args.originalLibraryFile.sourceFile && args.originalLibraryFile.sourceFile.createdAt) {
                createdAt = args.originalLibraryFile.sourceFile.createdAt;
            }

            // Validate createdAt is a valid number (milliseconds timestamp)
            if (createdAt && typeof createdAt === 'number' && createdAt > 0 && createdAt < Date.now() + 86400000) {
                // createdAt should be a reasonable timestamp (not in the far future)
                fileDate = createdAt;
                dateUsed = 'tdarr-added';
                args.jobLog("Using Tdarr library createdAt timestamp for age calculation: " + new Date(createdAt).toISOString());
            } else {
                // Fallback to file system dates if createdAt not available or invalid
                args.jobLog("WARNING: Tdarr createdAt not available or invalid (" + (createdAt ? typeof createdAt + ": " + createdAt : "missing") + "), falling back to file system creation date");
                if (stats.birthtimeMs && stats.birthtimeMs > 0) {
                    fileDate = stats.birthtimeMs;
                    dateUsed = 'creation (fallback)';
                } else if (stats.birthtime && new Date(stats.birthtime).getTime() > 0) {
                    fileDate = new Date(stats.birthtime).getTime();
                    dateUsed = 'creation (fallback)';
                } else {
                    fileDate = stats.ctimeMs || new Date(stats.ctime).getTime();
                    dateUsed = 'ctime (fallback)';
                }
            }
        } else if (args.inputs.dateType === 'modification') {
            fileDate = stats.mtimeMs || stats.mtime;
            if (!fileDate || fileDate <= 0) {
                args.jobLog("WARNING: mtime not available, falling back to ctime");
                fileDate = stats.ctimeMs || new Date(stats.ctime).getTime();
                dateUsed = 'ctime (fallback)';
            }
        } else {
            // Default to creation (birthtime)
            // Use birthtime if available, otherwise fallback to ctime
            if (stats.birthtimeMs && stats.birthtimeMs > 0) {
                fileDate = stats.birthtimeMs;
            } else if (stats.birthtime && new Date(stats.birthtime).getTime() > 0) {
                fileDate = new Date(stats.birthtime).getTime();
            } else {
                // Fallback to ctime if birthtime is not available or invalid
                fileDate = stats.ctimeMs || new Date(stats.ctime).getTime();
                dateUsed = 'ctime (fallback)';
                args.jobLog("Warning: birthtime not available, using ctime for age calculation");
            }
        }

        // Calculate file age
        var now = Date.now();
        var age = calculateFileAge(fileDate, now);
        fileDate = age.timestamp;
        var fileAgeMs = age.ageMs;
        var ageDays = age.ageDays;

        // A future timestamp is never evidence that a file is old. Treat it as
        // age zero so clock skew or malicious metadata cannot pass this gate.
        if (age.future) {
            args.jobLog("WARNING: File date is in the future. Treating the file as age zero; it cannot pass the age gate.");
        }

        // Log detailed information
        args.jobLog("File ".concat(dateUsed, " date: ").concat(new Date(fileDate).toISOString()));
        args.jobLog("File age: ".concat(ageDays.toFixed(1), " days (minimum required: ").concat(minAgeDays, " days)"));

        // Check if file is old enough
        var isOldEnough = fileAgeMs >= minAgeMs;

        if (!isOldEnough) {
            var retainedRecovery = authenticateRetainedRecoveryAgeBypass(args.inputFileObj._id);
            if (retainedRecovery.authorized) {
                args.variables.vmafRetainedRecoveryAgeBypass = {
                    schema: 1,
                    contract_id: 'vmaf-retained-recovery-age-bypass-v1',
                    checkpoint_key: retainedRecovery.checkpointKey,
                    source_scope_key: retainedRecovery.sourceScopeKey,
                    artifact_sha256_full: retainedRecovery.artifactSha256,
                    reason: 'filesystem_ctime_changed_after_protected_comparison_hardlink',
                };
                args.jobLog('Authenticated retained-output recovery checkpoint; bypassing only the file-age gate.');
                args.jobLog('The title encoder remains prohibited unless vmafOptimizedTranscode performs exact checkpoint reuse and full source authentication.');
                isOldEnough = true;
            } else {
                args.jobLog('Retained-output recovery age bypass not authorized: ' + retainedRecovery.reason);
            }
        }

        if (!isOldEnough) {
            var daysRemaining = minAgeDays - ageDays;
            var errorMessage = "File is too young (".concat(ageDays.toFixed(1), " days old, minimum: ").concat(minAgeDays, " days). Will be eligible in ").concat(daysRemaining.toFixed(1), " days.");
            args.jobLog(errorMessage);
            args.jobLog("Failing flow - file must be at least ".concat(minAgeDays, " days old before processing."));

            // Track too-young files for later requeue
            if (!args.variables.tooYoungFiles) {
                args.variables.tooYoungFiles = [];
            }
            var eligibleAt = new Date(fileDate + minAgeMs).toISOString();
            var record = {
                file: args.inputFileObj._id,
                minAgeDays: minAgeDays,
                currentAgeDays: parseFloat(ageDays.toFixed(2)),
                eligibleAt: eligibleAt,
                dateTypeUsed: dateUsed
            };
            args.variables.tooYoungFiles.push(record);

            // Persist immutable per-source first-seen evidence. Per-key atomic
            // publication avoids the lost updates of a shared JSON array.
            try {
                var persisted = persistTooYoungFirstSeen(record);
                args.jobLog((persisted.created ? 'Recorded' : 'Retained') +
                    " atomic too-young first-seen evidence for later requeue: ".concat(record.file));
            } catch (writeErr) {
                args.jobLog("WARNING: Could not persist too-young first-seen evidence: ".concat(writeErr.message));
            }

            throw new Error(errorMessage);
        } else {
            args.jobLog("File age OK (".concat(ageDays.toFixed(1), " days old). Proceeding with processing."));
        }

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    } catch (err) {
        // If it's our intentional failure (file too young), re-throw it
        if (err.message && err.message.includes("File is too young")) {
            throw err;
        }
        // For other errors (like file stats issues), log and fail
        args.jobLog("Check File Age ERROR: ".concat(err.message));
        args.jobLog("Stack: ".concat(err.stack));
        args.jobLog("Failing flow due to error checking file age");
        throw new Error("Check File Age plugin error: ".concat(err.message));
    }
};
exports.plugin = plugin;
exports._test = {
    calculateFileAge: calculateFileAge,
    persistTooYoungFirstSeen: persistTooYoungFirstSeen,
};
