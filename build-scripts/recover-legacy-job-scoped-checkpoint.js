#!/usr/bin/env node
'use strict';

// One-shot migration for an authenticated FFmpeg-exit-0 candidate whose
// checkpoint identity predates the portable <PRODUCER_LOG> token. The legacy
// files are evidence: this utility only reads them, copies the candidate to a
// fresh recovery work directory, and imports that copy through the deployed
// transcode plugin's exhaustive retained-output recovery contract.

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const REQUEST_SCHEMA = 1;
const REQUEST_CONTRACT_ID = 'vmaf-legacy-producer-log-checkpoint-recovery-v1';
const IMPORT_CONTRACT_ID = 'vmaf-retained-postencode-import-v1';
const CHECKPOINT_CONTRACT_ID = 'vmaf-postencode-checkpoint-v1';
const PRE_DISPATCH_CONTRACT_ID = 'vmaf-r2-controlled-reuse-pre-dispatch-v2';
const PRE_DISPATCH_SCHEMA = 2;
const EXECUTION_PATH_CONTRACT_ID = 'vmaf-r2-execution-path-attestation-v2';
const SOURCE_BACKUP_CONTRACT_ID = 'vmaf-independent-source-media-backup-v1';
const PREPARED_GRAIN_REPLAY_RECEIPT_SCHEMA = 1;
const PREPARED_GRAIN_REPLAY_RECEIPT_CONTRACT_ID =
    'vmaf-private-retained-grain-replay-receipt-v1';
const PRODUCER_LOG_TOKEN = '<PRODUCER_LOG>';
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const PINNED_TDARR_DATABASE = '/app/server/Tdarr/DB2/SQL/database.db';
const PINNED_FLOW_ID = 'YR5PZ1QaD';
const PINNED_SERVER_PLUGIN_ROOT =
    '/app/server/Tdarr/Plugins/FlowPlugins';
const PINNED_NODE_PLUGIN_ROOT =
    '/app/Tdarr_Node/assets/app/plugins/FlowPlugins';
const PINNED_LOCAL_SOURCE_ROOTS = Object.freeze({
    local_vmaf: '/custom-cont-init.d/vmaf-plugin-patches',
    local_filter: '/custom-cont-init.d/filter-plugin-patches',
    local_tools: '/custom-cont-init.d/tools-plugin-patches',
});
const PINNED_CHECKPOINT_ROOT = '/temp/.vmaf-postencode-checkpoints-v1';
const PINNED_REUSE_REQUIRED_ROOT = '/app/configs/vmaf-postencode-reuse-required-v1';
const PINNED_WORK_PARENT = '/temp';
const PINNED_FFMPEG_REQUEST = 'tdarr-ffmpeg';
const PINNED_FFMPEG_RESOLVED = '/usr/local/bin/tdarr-ffmpeg';
const PINNED_FFPROBE_REQUEST = 'tdarr-ffprobe';
const PINNED_FFPROBE_RESOLVED = '/usr/local/bin/tdarr-ffprobe';
const PINNED_GRAIN_REPLAY_RUNTIME = Object.freeze({
    pipeline: Object.freeze({
        requestedPath:
            '/opt/grain-pipeline/releases/v5-20260724-r1-d8dba8f0c5d0/' +
            'grain_pipeline_v5_direct.py',
        resolvedPath:
            '/opt/grain-pipeline/releases/v5-20260724-r1-d8dba8f0c5d0/' +
            'grain_pipeline_v5_direct.py',
        sizeBytes: 29173,
        sha256:
            'd8dba8f0c5d02ff7ce3feeaa65b2374c37cc6dabc3d7259120d2229c97836a9f',
    }),
    ffmpeg: Object.freeze({
        requestedPath: '/usr/local/bin/tdarr-ffmpeg',
        resolvedPath: '/usr/local/bin/tdarr-ffmpeg',
        sizeBytes: 218,
        sha256:
            'cb3a46536a8f59f7e4fd35a630e17174be93b4a2c2c33fc940cb1da12d509b7b',
    }),
    ffmpeg_target: Object.freeze({
        requestedPath: '/usr/local/ffmpeg-custom/bin/ffmpeg',
        resolvedPath: '/usr/local/ffmpeg-custom/bin/ffmpeg',
        sizeBytes: 461112,
        sha256:
            '085569a537e04a555ee22dc8f1e68d5c3925601e31b2e710c8e38310fac78ad6',
    }),
    ffprobe: Object.freeze({
        requestedPath: '/usr/local/bin/tdarr-ffprobe',
        resolvedPath: '/usr/local/bin/tdarr-ffprobe',
        sizeBytes: 219,
        sha256:
            '1e5016dfcc0ad78f2322e7ec2318287d49bdd2773595023c16e3db097b8130fa',
    }),
    ffprobe_target: Object.freeze({
        requestedPath: '/usr/local/ffmpeg-custom/bin/ffprobe',
        resolvedPath: '/usr/local/ffmpeg-custom/bin/ffprobe',
        sizeBytes: 211184,
        sha256:
            'd34b9487f5479235d4267fcccf0da92573126c9af749abdccbbc14a0af034583',
    }),
    grav1synth: Object.freeze({
        requestedPath: '/usr/local/bin/grav1synth',
        resolvedPath: '/opt/grav1synth/bin/grav1synth',
        sizeBytes: 3601880,
        sha256:
            '5e6e462e7c6ddf1229e965d1bb4741b698f9cd9d40e4c0c0ec90d419d42c6e9e',
    }),
    nvencc: Object.freeze({
        requestedPath: '/usr/local/bin/nvencc',
        resolvedPath:
            '/opt/nvencc/releases/9.25-r2-03d8a26631fe-bcba1c9d16d3/bin/nvencc',
        sizeBytes: 167373704,
        sha256:
            '03d8a26631fef47881f30243e4442dcb26a66cabbb586ae9637c9e22b9776294',
    }),
    coordinator: Object.freeze({
        requestedPath: '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js',
        resolvedPath:
            '/opt/nvencc/releases/9.25-r2-03d8a26631fe-bcba1c9d16d3/' +
            'libexec/tdarr-nvencc-knn-ffmpeg.js',
        sizeBytes: 10625,
        sha256:
            'bcba1c9d16d3c6342eabbd8fc59397fbff04b30fb8301a338f29a0ba0a077921',
    }),
});
const EXHAUSTIVE_VALIDATOR = 'ffprobe-demux-plus-full-decode-v1';
const REQUIRED_HELPERS = [
    'canonicalDenoise.js',
    'grainAnalysisArtifact.js',
    'grainVmafContract.js',
    'nvenccKnn.js',
    'nvencTemporalFilter.js',
    'postEncodeCheckpoint.js',
];
const REQUIRED_R2_HELPERS = [
    'canonicalDenoise.js',
    'currentContractMeasurementHistory.js',
    'deliveryFinalization.js',
    'deliveryPolicy.js',
    'deliveryTransaction.js',
    'emptyBandShadow.js',
    'feasibility.js',
    'gpuPipelineLock.js',
    'grainAnalysisArtifact.js',
    'grainVmafContract.js',
    'nvenccKnn.js',
    'nvencTemporalFilter.js',
    'pairedCqShadow.js',
    'postEncodeCheckpoint.js',
    'postReplaceAttestation.js',
    'preFgsCambi.js',
    'referenceContractBridge.js',
    'rejectionReasons.js',
    'sizeFailureShadow.js',
    'vmafMetricContract.js',
    'vmafV1Cpu.js',
    'vmafdb.js',
    'vmafpredict.js',
];
const REQUIRED_DISABLED_GLOBAL_SETTINGS = Object.freeze([
    'autoUpdateNodes',
    'autoUpdateServer',
    'pluginAutoUpdate',
    'killAllProcessesDuringUpdate',
]);
const REQUIRED_DISABLED_UPDATER_ENV = Object.freeze({
    enableDockerAutoUpdater: 'false',
    cronPluginUpdate: '',
    TDARR_FLOW_PARITY_BOOTSTRAP: '0',
});
function flowPluginRole(sourceRepo, pluginName, version, instances, area, relative) {
    return Object.freeze({
        kind: 'flow_plugin',
        sourceRepo,
        pluginName,
        version,
        instances,
        sourceArea: area,
        sourceRelative: relative,
        catalogRelative: sourceRepo === 'Community'
            ? relative
            : `LocalFlowPlugins/${area.replace(/^local_/, '')}/${relative}`,
    });
}

function localVmafRole(pluginName, instances) {
    return flowPluginRole(
        'Local',
        pluginName,
        '1.0.0',
        instances,
        'local_vmaf',
        `${pluginName}/1.0.0/index.js`
    );
}

function communityRole(pluginName, version, instances, category) {
    return flowPluginRole(
        'Community',
        pluginName,
        version,
        instances,
        'community_catalog',
        `CommunityFlowPlugins/${category}/${pluginName}/${version}/index.js`
    );
}

const REQUIRED_EXECUTION_ROLES = Object.freeze({
    input_file: communityRole('inputFile', '1.0.0', 1, 'input'),
    file_age_gate: flowPluginRole(
        'Local',
        'checkFileAge',
        '1.0.0',
        1,
        'local_filter',
        'checkFileAge/1.0.0/index.js'
    ),
    gpu_capability_gate: localVmafRole('detectGPUEncoder', 1),
    hdr_classifier: localVmafRole('checkHdrContent', 1),
    grain_analysis: localVmafRole('analyzeFilmGrain', 1),
    metadata_fetch: localVmafRole('fetchMediaMetadata', 1),
    sample_extraction: localVmafRole('extractVideoSamples', 1),
    gpu_lock_acquire: localVmafRole('acquireGpuPipelineLock', 2),
    parameter_test: localVmafRole('testEncodingParameters', 1),
    vmaf_measurement: localVmafRole('calculateVMAF', 1),
    cq_bracket: localVmafRole('checkCQBracket', 1),
    parameter_selection: localVmafRole('selectBestParameters', 1),
    retry_controller: localVmafRole('checkCQRangeRetry', 1),
    cq_learning: localVmafRole('learnCQRange', 1),
    result_export: localVmafRole('exportVMAFResults', 1),
    projected_size_gate: communityRole(
        'compareFileSizeRatioLive', '1.0.0', 1, 'file'),
    transcode: localVmafRole('vmafOptimizedTranscode', 1),
    gpu_lock_release: localVmafRole('releaseGpuPipelineLock', 2),
    terminal_monitor: localVmafRole('monitorTranscodeRetry', 1),
    grain_synthesis: localVmafRole('synthesizeFilmGrain', 1),
    remux_start: communityRole(
        'ffmpegCommandStart', '1.0.0', 1, 'ffmpegCommand'),
    stream_reorder: communityRole(
        'ffmpegCommandRorderStreams', '1.0.0', 1, 'ffmpegCommand'),
    remux_execute: communityRole(
        'ffmpegCommandExecute', '1.0.0', 1, 'ffmpegCommand'),
    delivery_validator: localVmafRole('validateDeliveryCandidate', 1),
    replace_original: localVmafRole('replaceOriginalFileAttested', 1),
    delivery_finalizer: localVmafRole('finalizeDeliveredOutcome', 1),
    notification: communityRole(
        'notifyRadarrOrSonarr', '2.0.0', 2, 'tools'),
    unmonitor: flowPluginRole(
        'Local',
        'unmonitorRadarrOrSonarr',
        '1.0.0',
        2,
        'local_tools',
        'unmonitorRadarrOrSonarr/1.0.0/index.js'
    ),
    cleanup: localVmafRole('cleanupTempFiles', 2),
    flow_error_handler: communityRole(
        'onFlowError', '1.0.0', 1, 'tools'),
    technical_failure: communityRole(
        'failFlow', '1.0.0', 1, 'tools'),
    ...Object.fromEntries(REQUIRED_R2_HELPERS.map((fileName) => [
        `helper_${fileName.replace(/\.js$/, '').replace(/([A-Z])/g, '_$1').toLowerCase()}`,
        Object.freeze({
            kind: 'helper',
            fileName,
            sourceArea: 'local_vmaf',
            sourceRelative: `_lib/${fileName}`,
            catalogRelative: `LocalFlowPlugins/vmaf/_lib/${fileName}`,
        }),
    ])),
    vendor_cli_utils: Object.freeze({
        kind: 'vendor_helper',
        fileName: 'cliUtils.js',
        sourceArea: 'community_catalog',
        sourceRelative: 'FlowHelpers/1.0.0/cliUtils.js',
        catalogRelative: 'FlowHelpers/1.0.0/cliUtils.js',
    }),
    vendor_cli_parsers: Object.freeze({
        kind: 'vendor_helper',
        fileName: 'cliParsers.js',
        sourceArea: 'community_catalog',
        sourceRelative: 'FlowHelpers/1.0.0/cliParsers.js',
        catalogRelative: 'FlowHelpers/1.0.0/cliParsers.js',
    }),
    vendor_file_utils: Object.freeze({
        kind: 'vendor_helper',
        fileName: 'fileUtils.js',
        sourceArea: 'community_catalog',
        sourceRelative: 'FlowHelpers/1.0.0/fileUtils.js',
        catalogRelative: 'FlowHelpers/1.0.0/fileUtils.js',
    }),
    vendor_file_move_or_copy: Object.freeze({
        kind: 'vendor_helper',
        fileName: 'fileMoveOrCopy.js',
        sourceArea: 'community_catalog',
        sourceRelative: 'FlowHelpers/1.0.0/fileMoveOrCopy.js',
        catalogRelative: 'FlowHelpers/1.0.0/fileMoveOrCopy.js',
    }),
    vendor_flow_utils: Object.freeze({
        kind: 'vendor_helper',
        fileName: 'flowUtils.js',
        sourceArea: 'community_catalog',
        sourceRelative: 'FlowHelpers/1.0.0/interfaces/flowUtils.js',
        catalogRelative: 'FlowHelpers/1.0.0/interfaces/flowUtils.js',
    }),
});
const QUARANTINE_SUFFIX = /\.invalid-\d+-\d+-[0-9a-f]{12}$/;

function fail(message) {
    throw new Error(String(message));
}

function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === 'object') {
        const output = Object.create(null);
        Object.keys(value).sort().forEach((key) => {
            if (value[key] !== undefined) output[key] = canonicalValue(value[key]);
        });
        return output;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
        fail('recovery contract contains a non-finite number');
    }
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
        fail(`recovery contract contains unsupported ${typeof value} data`);
    }
    return value;
}

function canonicalJson(value) {
    return JSON.stringify(canonicalValue(value));
}

function sha256Text(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function assertSha256(value, description) {
    const digest = String(value || '');
    if (!/^[0-9a-f]{64}$/.test(digest)) fail(`${description} must be a lowercase SHA-256`);
    return digest;
}

function assertExactFields(value, required, optional, description) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(`${description} must be an object`);
    }
    const allowed = new Set(required.concat(optional || []));
    const keys = Object.keys(value);
    const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
    const unexpected = keys.filter((key) => !allowed.has(key));
    if (missing.length || unexpected.length) {
        fail(`${description} fields mismatch (missing: ${missing.join(',') || 'none'}; ` +
            `unexpected: ${unexpected.join(',') || 'none'})`);
    }
    return value;
}

function absolutePath(value, description) {
    const candidate = String(value || '');
    if (!candidate || !path.isAbsolute(candidate)) fail(`${description} must be an absolute path`);
    const resolved = path.resolve(candidate);
    if (resolved === path.parse(resolved).root) fail(`${description} must not be a filesystem root`);
    return resolved;
}

function pathWithin(rootPath, childPath) {
    const relative = path.relative(path.resolve(rootPath), path.resolve(childPath));
    return relative !== '' && relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function exactQuarantinedName(name, originalName) {
    const escaped = String(originalName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}\\.invalid-\\d+-\\d+-[0-9a-f]{12}$`).test(String(name));
}

function absolutePosixPath(value, description) {
    const candidate = String(value || '');
    if (!candidate.startsWith('/') || candidate.includes('\u0000')) {
        fail(`${description} must be an absolute POSIX path`);
    }
    const resolved = path.posix.resolve(candidate);
    if (resolved === '/') fail(`${description} must not be a filesystem root`);
    return resolved;
}

function stableStatFields(stat) {
    return {
        dev: String(stat.dev),
        ino: String(stat.ino),
        size: String(stat.size),
        mtime_ns: String(stat.mtimeNs),
        ctime_ns: String(stat.ctimeNs),
        nlink: String(stat.nlink),
        mode: String(stat.mode),
    };
}

function sameStableStat(left, right) {
    return canonicalJson(stableStatFields(left)) === canonicalJson(stableStatFields(right));
}

function inspectCanonicalRegularFile(filePath, description, options) {
    options = options || {};
    const resolved = absolutePath(filePath, description);
    const leafStat = fs.lstatSync(resolved, { bigint: true });
    if (!leafStat.isFile() || leafStat.isSymbolicLink() || leafStat.size <= 0n) {
        fail(`${description} is not a non-empty, non-symlink regular file: ${resolved}`);
    }
    if (options.singleLink === true && leafStat.nlink !== 1n) {
        fail(`${description} must not be a hard-linked file: ${resolved}`);
    }
    if (options.ownerOnly === true && process.platform === 'linux' &&
        (leafStat.mode & 0o077n) !== 0n) {
        fail(`${description} permissions must be owner-only`);
    }
    const real = fs.realpathSync(resolved);
    if (path.resolve(real) !== resolved) {
        fail(`${description} path contains symlink indirection: ${resolved}`);
    }
    if (options.maxBytes !== undefined && leafStat.size > BigInt(options.maxBytes)) {
        fail(`${description} exceeds ${options.maxBytes} bytes`);
    }
    return { resolved, stat: leafStat };
}

function readAuthenticatedRegularFile(filePath, description, options) {
    options = options || {};
    const inspected = inspectCanonicalRegularFile(filePath, description, options);
    const noFollow = process.platform === 'linux' && fs.constants.O_NOFOLLOW
        ? fs.constants.O_NOFOLLOW
        : 0;
    const handle = fs.openSync(inspected.resolved, fs.constants.O_RDONLY | noFollow);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    const captured = options.captureBytes === true ? [] : null;
    let before;
    let after;
    let afterPath;
    try {
        before = fs.fstatSync(handle, { bigint: true });
        let position = 0;
        while (true) {
            const count = fs.readSync(handle, buffer, 0, buffer.length, position);
            if (count === 0) break;
            const chunk = count === buffer.length ? buffer : buffer.subarray(0, count);
            hash.update(chunk);
            if (captured) captured.push(Buffer.from(chunk));
            position += count;
        }
        after = fs.fstatSync(handle, { bigint: true });
        afterPath = fs.lstatSync(inspected.resolved, { bigint: true });
    } finally {
        fs.closeSync(handle);
    }
    if (!afterPath.isFile() || afterPath.isSymbolicLink() ||
        (options.singleLink === true && afterPath.nlink !== 1n) ||
        (options.ownerOnly === true && process.platform === 'linux' &&
            (afterPath.mode & 0o077n) !== 0n) ||
        fs.realpathSync(inspected.resolved) !== inspected.resolved ||
        !sameStableStat(inspected.stat, before) ||
        !sameStableStat(before, after) ||
        !sameStableStat(after, afterPath)) {
        fail(`${description} changed while it was authenticated`);
    }
    const snapshot = {
        resolved: inspected.resolved,
        stat: stableStatFields(after),
        sizeBytes: Number(after.size),
        sha256Full: hash.digest('hex'),
    };
    return {
        snapshot,
        bytes: captured ? Buffer.concat(captured) : null,
    };
}

function snapshotRegularFile(filePath, description, options) {
    return readAuthenticatedRegularFile(
        filePath,
        description,
        { ...(options || {}), captureBytes: false }
    ).snapshot;
}

function readJsonEvidence(filePath, description) {
    const authenticated = readAuthenticatedRegularFile(filePath, description, {
        maxBytes: MAX_MANIFEST_BYTES,
        singleLink: true,
        ownerOnly: true,
        captureBytes: true,
    });
    let value;
    try {
        value = JSON.parse(authenticated.bytes.toString('utf8'));
    } catch (_) {
        fail(`${description} is not valid JSON`);
    }
    return { value, snapshot: authenticated.snapshot };
}

function assertSnapshotUnchanged(snapshot, description, options) {
    const current = snapshotRegularFile(
        snapshot.resolved,
        description,
        options || { singleLink: true }
    );
    if (canonicalJson(current) !== canonicalJson(snapshot)) {
        fail(`${description} changed during recovery`);
    }
    return current;
}

function canonicalDirectory(directory, description, options) {
    options = options || {};
    const resolved = absolutePath(directory, description);
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
        fail(`${description} is not a canonical non-symlink directory: ${resolved}`);
    }
    if (options.ownerOnly === true && process.platform === 'linux' &&
        (stat.mode & 0o077) !== 0) {
        fail(`${description} permissions must be owner-only`);
    }
    return resolved;
}

function assertDifferentFiles(left, right, description) {
    if (left.resolved === right.resolved ||
        (String(left.stat.dev) === String(right.stat.dev) &&
            String(left.stat.ino) === String(right.stat.ino))) {
        fail(`${description} must be distinct files`);
    }
}

function stableObjectSha256(value) {
    return sha256Text(canonicalJson(value));
}

function parseNullDelimitedEnvironment(buffer) {
    const output = {};
    const seen = new Set();
    for (const item of Buffer.from(buffer || '').toString('utf8').split('\u0000')) {
        if (!item) continue;
        const delimiter = item.indexOf('=');
        if (delimiter <= 0) fail('PID 1 environment contains an invalid entry');
        const key = item.slice(0, delimiter);
        if (seen.has(key)) fail('PID 1 environment contains duplicate names');
        seen.add(key);
        output[key] = item.slice(delimiter + 1);
    }
    return output;
}

function readPidOneEnvironment(fsImpl) {
    try {
        return parseNullDelimitedEnvironment(
            (fsImpl || fs).readFileSync('/proc/1/environ')
        );
    } catch (error) {
        if (error && /PID 1 environment/.test(String(error.message || ''))) throw error;
        fail('PID 1 updater environment could not be authenticated');
    }
}

function assertUpdaterEnvironment(expected, actual) {
    assertExactFields(
        expected,
        Object.keys(REQUIRED_DISABLED_UPDATER_ENV),
        [],
        'pre_dispatch.updater_environment'
    );
    for (const [name, disabledValue] of Object.entries(REQUIRED_DISABLED_UPDATER_ENV)) {
        if (expected[name] !== disabledValue || actual[name] !== disabledValue) {
            fail('PID 1 updater environment is not disabled exactly');
        }
    }
}

function validatePreDispatchContract(preDispatch) {
    assertExactFields(preDispatch, [
        'schema',
        'contract_id',
        'live_database_path',
        'live_flow',
        'global_settings',
        'library_settings',
        'updater_environment',
        'execution_path',
        'source_media_backup',
    ], [], 'pre_dispatch');
    if (preDispatch.schema !== PRE_DISPATCH_SCHEMA ||
        preDispatch.contract_id !== PRE_DISPATCH_CONTRACT_ID) {
        fail('pre_dispatch contract identity is invalid');
    }
    if (path.resolve(absolutePath(
        preDispatch.live_database_path,
        'pre_dispatch.live_database_path'
    )) !== path.resolve(PINNED_TDARR_DATABASE)) {
        fail('pre_dispatch live database path is not the pinned production database');
    }
    assertExactFields(preDispatch.live_flow, [
        'id', 'sha256_full_object',
    ], [], 'pre_dispatch.live_flow');
    assertExactFields(preDispatch.global_settings, [
        'id', 'sha256_full_object',
    ], [], 'pre_dispatch.global_settings');
    assertExactFields(preDispatch.library_settings, [
        'sha256_full_collection',
    ], [], 'pre_dispatch.library_settings');
    if (preDispatch.live_flow.id !== PINNED_FLOW_ID ||
        preDispatch.global_settings.id !== 'globalsettings') {
        fail('pre_dispatch live document identities are invalid');
    }
    assertSha256(
        preDispatch.live_flow.sha256_full_object,
        'pre_dispatch.live_flow.sha256_full_object'
    );
    assertSha256(
        preDispatch.global_settings.sha256_full_object,
        'pre_dispatch.global_settings.sha256_full_object'
    );
    assertSha256(
        preDispatch.library_settings.sha256_full_collection,
        'pre_dispatch.library_settings.sha256_full_collection'
    );
    return preDispatch;
}

function authenticateLiveStateDocuments(preDispatch, state, pidOneEnvironment) {
    validatePreDispatchContract(preDispatch);
    const flow = state && state.flow;
    const globalSettings = state && state.globalSettings;
    const libraries = state && state.libraries;
    if (!flow || typeof flow !== 'object' || Array.isArray(flow) ||
        flow._id !== preDispatch.live_flow.id ||
        !Array.isArray(flow.flowPlugins) ||
        !Array.isArray(flow.flowEdges)) {
        fail('exact live Flow identity or shape is invalid');
    }
    if (stableObjectSha256(flow) !== preDispatch.live_flow.sha256_full_object) {
        fail('exact live Flow full-object SHA-256 differs from the reviewed request');
    }
    validateLiveFlowStructure(flow);
    if (!globalSettings || typeof globalSettings !== 'object' ||
        Array.isArray(globalSettings) ||
        globalSettings._id !== preDispatch.global_settings.id) {
        fail('exact live global settings identity or shape is invalid');
    }
    if (stableObjectSha256(globalSettings) !==
        preDispatch.global_settings.sha256_full_object) {
        fail('exact live global settings full-object SHA-256 differs from the reviewed request');
    }
    for (const name of REQUIRED_DISABLED_GLOBAL_SETTINGS) {
        if (globalSettings[name] !== false) {
            fail('a required global automatic-update setting is not boolean false');
        }
    }
    if (!Array.isArray(libraries) || libraries.length === 0) {
        fail('live library settings collection is missing');
    }
    const libraryIds = new Set();
    const mediaRoots = [];
    for (const library of libraries) {
        if (!library || typeof library !== 'object' || Array.isArray(library) ||
            typeof library._id !== 'string' || !library._id ||
            libraryIds.has(library._id) ||
            typeof library.folder !== 'string' ||
            !path.isAbsolute(library.folder)) {
            fail('live library settings collection has an invalid document');
        }
        libraryIds.add(library._id);
        mediaRoots.push(path.resolve(library.folder));
    }
    const orderedLibraries = [...libraries].sort((left, right) =>
        left._id.localeCompare(right._id));
    if (stableObjectSha256(orderedLibraries) !==
        preDispatch.library_settings.sha256_full_collection) {
        fail('live library settings full-collection SHA-256 differs from the reviewed request');
    }
    const declaredRoots = preDispatch.source_media_backup &&
        preDispatch.source_media_backup.media_roots;
    if (!Array.isArray(declaredRoots) ||
        canonicalJson([...new Set(declaredRoots.map((root) =>
            path.resolve(absolutePath(root, 'source-media backup media root'))))].sort()) !==
            canonicalJson([...new Set(mediaRoots)].sort())) {
        fail('source-media backup does not declare the exact live media-root set');
    }
    assertUpdaterEnvironment(
        preDispatch.updater_environment,
        pidOneEnvironment || {}
    );
    return {
        flow,
        globalSettings,
        libraries,
        flowSha256: preDispatch.live_flow.sha256_full_object,
        globalSha256: preDispatch.global_settings.sha256_full_object,
        librarySha256: preDispatch.library_settings.sha256_full_collection,
    };
}

function executionRoleForFlowNode(node) {
    const matches = Object.entries(REQUIRED_EXECUTION_ROLES).filter(([, definition]) =>
        definition.kind === 'flow_plugin' &&
        node &&
        node.sourceRepo === definition.sourceRepo &&
        node.pluginName === definition.pluginName &&
        node.version === definition.version
    );
    if (matches.length !== 1) {
        fail('live Flow contains an unrecognized or ambiguous plugin identity');
    }
    return matches[0][0];
}

function validateLiveFlowStructure(liveFlow) {
    if (!liveFlow || !Array.isArray(liveFlow.flowPlugins) ||
        !Array.isArray(liveFlow.flowEdges) ||
        liveFlow.flowPlugins.length === 0 ||
        liveFlow.flowEdges.length === 0) {
        fail('live Flow graph is empty or malformed');
    }
    const nodes = new Map();
    const nodesByRole = new Map();
    for (const node of liveFlow.flowPlugins) {
        if (!node || typeof node !== 'object' || Array.isArray(node) ||
            typeof node.id !== 'string' || node.id.length === 0 ||
            node.id.length > 512 || nodes.has(node.id)) {
            fail('live Flow plugin node identities are invalid or duplicated');
        }
        const role = executionRoleForFlowNode(node);
        nodes.set(node.id, node);
        if (!nodesByRole.has(role)) nodesByRole.set(role, []);
        nodesByRole.get(role).push(node.id);
    }
    const flowDefinitions = Object.entries(REQUIRED_EXECUTION_ROLES)
        .filter(([, definition]) => definition.kind === 'flow_plugin');
    const requiredNodeCount = flowDefinitions.reduce(
        (sum, [, definition]) => sum + definition.instances,
        0
    );
    if (liveFlow.flowPlugins.length !== requiredNodeCount) {
        fail('live Flow does not contain the exact complete r2 plugin set');
    }
    for (const [role, definition] of flowDefinitions) {
        if ((nodesByRole.get(role) || []).length !== definition.instances) {
            fail('live Flow does not contain the exact required role multiplicity');
        }
    }

    const adjacency = new Map([...nodes.keys()].map((identity) => [identity, []]));
    const indegree = new Map([...nodes.keys()].map((identity) => [identity, 0]));
    const edgeIds = new Set();
    for (const edge of liveFlow.flowEdges) {
        if (!edge || typeof edge !== 'object' || Array.isArray(edge) ||
            typeof edge.id !== 'string' || edge.id.length === 0 ||
            edge.id.length > 512 || edgeIds.has(edge.id) ||
            typeof edge.source !== 'string' || !nodes.has(edge.source) ||
            typeof edge.target !== 'string' || !nodes.has(edge.target) ||
            !['string', 'number'].includes(typeof edge.sourceHandle) ||
            String(edge.sourceHandle).length === 0) {
            fail('live Flow edges contain an invalid identity, endpoint, or handle');
        }
        edgeIds.add(edge.id);
        adjacency.get(edge.source).push(edge.target);
        indegree.set(edge.target, indegree.get(edge.target) + 1);
    }
    const roots = [...nodes.keys()].filter((identity) => indegree.get(identity) === 0);
    const expectedRoots = [
        ...(nodesByRole.get('input_file') || []),
        ...(nodesByRole.get('flow_error_handler') || []),
    ].sort();
    if (canonicalJson(roots.sort()) !== canonicalJson(expectedRoots)) {
        fail('live Flow roots are not the exact admission and error-handler roles');
    }
    const reachable = new Set();
    const pending = [...roots];
    while (pending.length) {
        const identity = pending.pop();
        if (reachable.has(identity)) continue;
        reachable.add(identity);
        pending.push(...adjacency.get(identity));
    }
    if (reachable.size !== nodes.size) {
        fail('live Flow contains a disconnected required execution role');
    }

    function roleCanReach(fromRole, toRole) {
        const targets = new Set(nodesByRole.get(toRole) || []);
        const seen = new Set();
        const queue = [...(nodesByRole.get(fromRole) || [])];
        while (queue.length) {
            const identity = queue.shift();
            if (targets.has(identity) && !(
                fromRole === toRole &&
                (nodesByRole.get(fromRole) || []).includes(identity)
            )) return true;
            if (seen.has(identity)) continue;
            seen.add(identity);
            queue.push(...adjacency.get(identity));
        }
        return false;
    }
    const requiredReachability = [
        ['input_file', 'file_age_gate'],
        ['file_age_gate', 'gpu_capability_gate'],
        ['gpu_capability_gate', 'hdr_classifier'],
        ['hdr_classifier', 'grain_analysis'],
        ['grain_analysis', 'metadata_fetch'],
        ['metadata_fetch', 'sample_extraction'],
        ['sample_extraction', 'parameter_test'],
        ['parameter_test', 'vmaf_measurement'],
        ['vmaf_measurement', 'cq_bracket'],
        ['cq_bracket', 'parameter_selection'],
        ['parameter_selection', 'retry_controller'],
        ['retry_controller', 'cq_learning'],
        ['cq_learning', 'result_export'],
        ['result_export', 'projected_size_gate'],
        ['projected_size_gate', 'transcode'],
        ['transcode', 'terminal_monitor'],
        ['terminal_monitor', 'grain_synthesis'],
        ['grain_synthesis', 'remux_execute'],
        ['grain_synthesis', 'delivery_validator'],
        ['remux_execute', 'delivery_validator'],
        ['delivery_validator', 'replace_original'],
        ['replace_original', 'delivery_finalizer'],
        ['delivery_finalizer', 'notification'],
        ['notification', 'unmonitor'],
        ['unmonitor', 'cleanup'],
        ['flow_error_handler', 'gpu_lock_release'],
        ['gpu_capability_gate', 'technical_failure'],
    ];
    for (const [fromRole, toRole] of requiredReachability) {
        if (!roleCanReach(fromRole, toRole)) {
            fail('live Flow omits a required r2 execution-path relationship');
        }
    }
    return { nodes, nodesByRole, adjacency };
}

function assertRoleBoundToFlow(entry, definition, liveFlow) {
    if (definition.kind !== 'flow_plugin') {
        if (Object.prototype.hasOwnProperty.call(entry, 'flow_node_ids')) {
            fail('helper execution roles must not claim Flow node identities');
        }
        return;
    }
    if (!Array.isArray(entry.flow_node_ids) ||
        entry.flow_node_ids.length !== definition.instances) {
        fail('a required execution role has an invalid Flow node count');
    }
    const requestedIds = new Set();
    for (const identity of entry.flow_node_ids) {
        if (typeof identity !== 'string' || identity.length === 0 ||
            identity.length > 512 || requestedIds.has(identity)) {
            fail('a required execution role has invalid or duplicate Flow node identities');
        }
        requestedIds.add(identity);
    }
    const matching = liveFlow.flowPlugins.filter((node) =>
        node &&
        node.sourceRepo === definition.sourceRepo &&
        node.pluginName === definition.pluginName &&
        node.version === definition.version
    );
    if (matching.length !== definition.instances ||
        matching.some((node) => !requestedIds.has(node.id)) ||
        entry.flow_node_ids.some((identity) =>
            !matching.some((node) => node.id === identity))) {
        fail('a required execution role is not bound to the exact reviewed Flow nodes');
    }
}

function authenticateExecutionPath(executionPath, liveFlow, options) {
    options = options || {};
    const snapshotFile = options.snapshotRegularFile || snapshotRegularFile;
    const inspectDirectory = options.canonicalDirectory || canonicalDirectory;
    const serverRoot = inspectDirectory(
        options.serverPluginRoot || PINNED_SERVER_PLUGIN_ROOT,
        'server plugin catalog root'
    );
    const nodeRoot = inspectDirectory(
        options.nodePluginRoot || PINNED_NODE_PLUGIN_ROOT,
        'internal-node plugin catalog root'
    );
    const localSourceRoots = {};
    for (const [area, pinnedRoot] of Object.entries(PINNED_LOCAL_SOURCE_ROOTS)) {
        localSourceRoots[area] = inspectDirectory(
            (options.localSourceRoots && options.localSourceRoots[area]) ||
                pinnedRoot,
            `local ${area} source root`
        );
    }
    if (pathsOverlap(serverRoot, nodeRoot)) {
        fail('server and internal-node plugin catalog roots overlap');
    }
    assertExactFields(executionPath, [
        'schema', 'contract_id', 'community_source_root', 'roles',
    ], [], 'pre_dispatch.execution_path');
    if (executionPath.schema !== 2 ||
        executionPath.contract_id !== EXECUTION_PATH_CONTRACT_ID ||
        !Array.isArray(executionPath.roles)) {
        fail('execution-path attestation schema is invalid');
    }
    const communitySourceRoot = inspectDirectory(
        executionPath.community_source_root,
        'independent Community source-catalog root',
        { ownerOnly: true }
    );
    const allRoots = [
        serverRoot,
        nodeRoot,
        communitySourceRoot,
        ...Object.values(localSourceRoots),
    ];
    for (let left = 0; left < allRoots.length; left += 1) {
        for (let right = left + 1; right < allRoots.length; right += 1) {
            if (pathsOverlap(allRoots[left], allRoots[right])) {
                fail('execution-path source and deployment roots overlap');
            }
        }
    }
    validateLiveFlowStructure(liveFlow);
    const requiredNames = Object.keys(REQUIRED_EXECUTION_ROLES).sort();
    if (executionPath.roles.length !== requiredNames.length) {
        fail('execution-path attestation role count is incomplete');
    }
    const entries = new Map();
    for (const entry of executionPath.roles) {
        assertExactFields(entry, [
            'role', 'expected_sha256_full', 'copies',
        ], ['flow_node_ids'], 'execution-path role');
        if (typeof entry.role !== 'string' ||
            !Object.prototype.hasOwnProperty.call(REQUIRED_EXECUTION_ROLES, entry.role) ||
            entries.has(entry.role)) {
            fail('execution-path attestation contains an invalid or duplicate role');
        }
        entries.set(entry.role, entry);
    }
    if (canonicalJson([...entries.keys()].sort()) !== canonicalJson(requiredNames)) {
        fail('execution-path attestation omits a required role');
    }

    const byRole = {};
    const seenFiles = new Set();
    for (const roleName of requiredNames) {
        const definition = REQUIRED_EXECUTION_ROLES[roleName];
        const entry = entries.get(roleName);
        assertRoleBoundToFlow(entry, definition, liveFlow);
        const expectedSha256 = assertSha256(
            entry.expected_sha256_full,
            'execution-path role expected_sha256_full'
        );
        assertExactFields(
            entry.copies,
            ['source', 'server', 'node'],
            [],
            'execution-path role copies'
        );
        const snapshots = {};
        for (const copyName of ['source', 'server', 'node']) {
            const copy = entry.copies[copyName];
            assertExactFields(
                copy,
                ['path'],
                [],
                'execution-path role copy'
            );
            const snapshot = snapshotFile(
                copy.path,
                'execution-path artifact copy',
                {
                    singleLink: true,
                    ownerOnly:
                        copyName === 'source' &&
                        definition.sourceArea === 'community_catalog',
                }
            );
            const sourceRoot = definition.sourceArea === 'community_catalog'
                ? communitySourceRoot
                : localSourceRoots[definition.sourceArea];
            const expectedPath = path.resolve(
                copyName === 'source'
                    ? path.join(sourceRoot, definition.sourceRelative)
                    : path.join(
                        copyName === 'server' ? serverRoot : nodeRoot,
                        definition.catalogRelative
                    )
            );
            if (snapshot.resolved !== expectedPath) {
                fail('execution-path artifact copy is outside its exact namespace');
            }
            if (snapshot.sha256Full !== expectedSha256) {
                fail('execution-path artifact copy bytes differ from the reviewed role');
            }
            const fileIdentity = `${snapshot.stat.dev}:${snapshot.stat.ino}`;
            if (seenFiles.has(fileIdentity)) {
                fail('execution-path attestation reuses a file for multiple copies or roles');
            }
            seenFiles.add(fileIdentity);
            snapshots[copyName] = snapshot;
        }
        assertDifferentFiles(
            snapshots.source,
            snapshots.server,
            'execution-path source and server copies'
        );
        assertDifferentFiles(
            snapshots.source,
            snapshots.node,
            'execution-path source and node copies'
        );
        assertDifferentFiles(
            snapshots.server,
            snapshots.node,
            'execution-path server and node copies'
        );
        byRole[roleName] = { definition, snapshots };
    }
    return {
        byRole,
        roleCount: requiredNames.length,
        serverRoot,
        nodeRoot,
        communitySourceRoot,
        localSourceRoots,
        transcodePluginPath: byRole.transcode.snapshots.server.resolved,
        checkpointHelperPath:
            byRole.helper_post_encode_checkpoint.snapshots.server.resolved,
    };
}

function assertExecutionPathUnchanged(attestation) {
    for (const [roleName, item] of Object.entries(attestation.byRole)) {
        for (const [copyName, snapshot] of Object.entries(item.snapshots)) {
            assertSnapshotUnchanged(
                snapshot,
                `execution-path ${roleName} ${copyName} copy`
            );
        }
    }
}

function loadAuthenticatedCommonJs(entrySnapshot, executionPath) {
    const authenticatedModules = new Map();
    for (const item of Object.values(executionPath.byRole)) {
        for (const snapshot of Object.values(item.snapshots)) {
            authenticatedModules.set(path.resolve(snapshot.resolved), snapshot);
        }
    }
    const moduleCache = new Map();

    function compile(snapshot) {
        const filename = path.resolve(snapshot.resolved);
        if (!authenticatedModules.has(filename)) {
            fail('authenticated module is outside the execution-path closure');
        }
        if (moduleCache.has(filename)) return moduleCache.get(filename).exports;
        const authenticated = readAuthenticatedRegularFile(
            filename,
            'authenticated execution module',
            { singleLink: true, captureBytes: true }
        );
        if (canonicalJson(authenticated.snapshot) !== canonicalJson(snapshot)) {
            fail('authenticated execution module changed before loading');
        }
        const loadedModule = new Module(filename, module);
        loadedModule.filename = filename;
        loadedModule.paths = Module._nodeModulePaths(path.dirname(filename));
        moduleCache.set(filename, loadedModule);
        const nativeRequire = loadedModule.require.bind(loadedModule);
        loadedModule.require = (request) => {
            const builtinName = String(request).replace(/^node:/, '');
            if (Module.builtinModules.includes(builtinName)) {
                return nativeRequire(request);
            }
            const resolved = Module._resolveFilename(request, loadedModule);
            const dependency = authenticatedModules.get(path.resolve(resolved));
            if (dependency) return compile(dependency);
            fail('execution module requested an unattested non-builtin dependency');
        };
        try {
            loadedModule._compile(
                authenticated.bytes.toString('utf8'),
                filename
            );
            loadedModule.loaded = true;
        } catch (error) {
            moduleCache.delete(filename);
            throw error;
        }
        assertSnapshotUnchanged(snapshot, 'authenticated execution module');
        return loadedModule.exports;
    }

    return compile(entrySnapshot);
}

function pathsOverlap(left, right) {
    const resolvedLeft = path.resolve(left);
    const resolvedRight = path.resolve(right);
    return resolvedLeft === resolvedRight ||
        pathWithin(resolvedLeft, resolvedRight) ||
        pathWithin(resolvedRight, resolvedLeft);
}

function authenticateSourceMediaBackup(attestation, sourcePath, options) {
    options = options || {};
    const snapshotFile = options.snapshotRegularFile || snapshotRegularFile;
    const inspectDirectory = options.canonicalDirectory || canonicalDirectory;
    assertExactFields(attestation, [
        'schema',
        'contract_id',
        'verified',
        'backup_path',
        'protected_backup_root',
        'media_roots',
        'size_bytes',
        'sha256_full',
        'require_distinct_device',
    ], [], 'pre_dispatch.source_media_backup');
    if (attestation.schema !== 1 ||
        attestation.contract_id !== SOURCE_BACKUP_CONTRACT_ID ||
        attestation.verified !== true ||
        attestation.require_distinct_device !== true) {
        fail('source-media backup attestation identity or verification is invalid');
    }
    if (!Number.isSafeInteger(attestation.size_bytes) ||
        attestation.size_bytes <= 0) {
        fail('source-media backup size must be a positive safe integer');
    }
    const expectedSha256 = assertSha256(
        attestation.sha256_full,
        'source-media backup sha256_full'
    );
    if (!Array.isArray(attestation.media_roots) ||
        attestation.media_roots.length === 0) {
        fail('source-media backup must declare every media root');
    }
    const mediaRoots = attestation.media_roots.map((root, index) =>
        inspectDirectory(root, `media root ${index + 1}`));
    if (new Set(mediaRoots).size !== mediaRoots.length) {
        fail('source-media backup contains duplicate media roots');
    }
    const source = snapshotFile(sourcePath, 'source media', {});
    const containingRoots = mediaRoots.filter((root) =>
        pathWithin(root, source.resolved));
    if (containingRoots.length !== 1) {
        fail('source media must resolve beneath exactly one declared media root');
    }
    const backupRoot = inspectDirectory(
        attestation.protected_backup_root,
        'protected source-media backup root',
        { ownerOnly: true }
    );
    if (mediaRoots.some((root) => pathsOverlap(root, backupRoot))) {
        fail('protected source-media backup root overlaps a media root');
    }
    const backup = snapshotFile(
        attestation.backup_path,
        'independent source-media backup',
        { singleLink: true, ownerOnly: true }
    );
    if (!pathWithin(backupRoot, backup.resolved) ||
        mediaRoots.some((root) => pathsOverlap(root, backup.resolved))) {
        fail('independent source-media backup is not contained outside media roots');
    }
    assertDifferentFiles(source, backup, 'source media and independent backup');
    if (String(source.stat.dev) === String(backup.stat.dev)) {
        fail('source media and independent backup are not on distinct devices');
    }
    if (source.sizeBytes !== attestation.size_bytes ||
        backup.sizeBytes !== attestation.size_bytes ||
        source.sha256Full !== expectedSha256 ||
        backup.sha256Full !== expectedSha256) {
        fail('source media and independent backup do not match the reviewed full identity');
    }
    return { source, backup, backupRoot, mediaRoots };
}

function assertSourceMediaBackupUnchanged(evidence) {
    assertSnapshotUnchanged(evidence.source, 'source media', {});
    assertSnapshotUnchanged(
        evidence.backup,
        'independent source-media backup',
        { singleLink: true, ownerOnly: true }
    );
}

function countExactString(value, expected) {
    if (typeof value === 'string') return value === expected ? 1 : 0;
    if (Array.isArray(value)) {
        return value.reduce((sum, item) => sum + countExactString(item, expected), 0);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value).reduce(
            (sum, key) => sum + countExactString(value[key], expected), 0);
    }
    return 0;
}

function differingLeafPaths(left, right, prefix, output) {
    prefix = prefix || '';
    output = output || [];
    if (canonicalJson(left) === canonicalJson(right)) return output;
    if (Array.isArray(left) && Array.isArray(right) && left.length === right.length) {
        left.forEach((value, index) => {
            differingLeafPaths(value, right[index], `${prefix}[${index}]`, output);
        });
        return output;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object' &&
        !Array.isArray(left) && !Array.isArray(right)) {
        const keys = Array.from(new Set(Object.keys(left).concat(Object.keys(right)))).sort();
        keys.forEach((key) => {
            differingLeafPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key, output);
        });
        return output;
    }
    output.push(prefix || '<root>');
    return output;
}

function normalizeLegacyProducerLogContract(contract, expectedProducerLogPath, legacyJobWorkDir) {
    if (!contract || Number(contract.schema) !== 2 || !Array.isArray(contract.argv)) {
        fail('legacy encode contract must be an NVEncC pipeline schema-2 contract');
    }
    const expectedLog = absolutePosixPath(
        expectedProducerLogPath, 'expected legacy producer-log path');
    const jobWorkDir = absolutePosixPath(legacyJobWorkDir, 'legacy job work directory');
    const logRelative = path.posix.relative(jobWorkDir, expectedLog);
    if (!/^tdarr-workDir[-_.A-Za-z0-9]+$/.test(path.posix.basename(jobWorkDir)) ||
        path.posix.dirname(jobWorkDir) !== PINNED_WORK_PARENT ||
        !logRelative || logRelative === '..' || logRelative.startsWith('../') ||
        path.posix.isAbsolute(logRelative) ||
        !path.posix.basename(expectedLog).endsWith('.nvencc.log')) {
        fail('legacy producer-log path is not a recognized job-owned Tdarr diagnostic path');
    }
    const argv = contract.argv.map(String);
    const delimiters = [];
    const producerOptions = [];
    argv.forEach((value, index) => {
        if (value === '--') delimiters.push(index);
        if (value === '--producer-log') producerOptions.push(index);
    });
    if (delimiters.length !== 1 || producerOptions.length !== 1 ||
        producerOptions[0] >= delimiters[0] || producerOptions[0] + 1 >= delimiters[0]) {
        fail('legacy encode contract must contain one pre-delimiter --producer-log value');
    }
    const valueIndex = producerOptions[0] + 1;
    if (argv[valueIndex] !== expectedLog) {
        fail('legacy --producer-log value does not match the independently expected path');
    }
    if (countExactString(contract, expectedLog) !== 1 ||
        countExactString(contract, PRODUCER_LOG_TOKEN) !== 0) {
        fail('legacy producer-log mutation is ambiguous or was already normalized');
    }
    const normalized = JSON.parse(JSON.stringify(contract));
    normalized.argv[valueIndex] = PRODUCER_LOG_TOKEN;
    const differences = differingLeafPaths(contract, normalized);
    if (differences.length !== 1 || differences[0] !== `argv[${valueIndex}]`) {
        fail('legacy normalization would change more than the producer-log option value');
    }
    return {
        normalizedContract: normalized,
        legacyProducerLogPath: expectedLog,
        producerLogArgvIndex: valueIndex,
        changedPaths: differences,
    };
}

function assertSourceFingerprint(value, description) {
    if (!value || value.scheme !== 'sha256-sampled-v1' ||
        !/^[0-9a-f]{64}$/.test(String(value.sha256 || '')) ||
        !Number.isSafeInteger(Number(value.size_bytes)) || Number(value.size_bytes) <= 0 ||
        !Number.isFinite(Number(value.mtime_ns)) || !Number.isInteger(Number(value.mtime_ns)) ||
        !Array.isArray(value.sample_offsets) || !String(value.resolved_path || '')) {
        fail(`${description} is not a complete sha256-sampled-v1 fingerprint`);
    }
    return canonicalValue(value);
}

function authenticateLegacyEvidence(options) {
    options = options || {};
    const expected = options.expected || {};
    const checkpoint = options.checkpoint;
    if (!checkpoint || typeof checkpoint.assertEncodeContract !== 'function') {
        fail('current checkpoint helper is unavailable');
    }
    const checkpointRoot = canonicalDirectory(options.checkpointRoot, 'checkpoint root');
    const source = inspectCanonicalRegularFile(options.sourcePath, 'source');
    const manifestEvidence = readJsonEvidence(
        options.legacyManifestPath, 'legacy invalid candidate manifest');
    const retained = snapshotRegularFile(
        options.legacyRetainedPath, 'legacy retained candidate',
        { singleLink: true });
    assertDifferentFiles(manifestEvidence.snapshot, retained, 'legacy manifest and retained candidate');
    assertDifferentFiles(source, retained, 'source and retained candidate');

    assertSha256(expected.legacy_manifest_sha256_full,
        'expected.legacy_manifest_sha256_full');
    assertSha256(expected.legacy_checkpoint_key, 'expected.legacy_checkpoint_key');
    assertSha256(expected.legacy_encode_contract_sha256,
        'expected.legacy_encode_contract_sha256');
    assertSha256(expected.source_sha256_full, 'expected.source_sha256_full');
    assertSha256(expected.retained_sha256_full, 'expected.retained_sha256_full');
    assertSha256(expected.normalized_encode_contract_sha256,
        'expected.normalized_encode_contract_sha256');
    assertSha256(expected.normalized_checkpoint_key, 'expected.normalized_checkpoint_key');
    if (manifestEvidence.snapshot.sha256Full !== expected.legacy_manifest_sha256_full) {
        fail('legacy manifest bytes do not match the independently expected SHA-256');
    }
    if (retained.sha256Full !== expected.retained_sha256_full ||
        retained.sizeBytes !== Number(expected.retained_size_bytes)) {
        fail('legacy retained candidate does not match its independently expected SHA-256 and size');
    }

    const manifest = manifestEvidence.value;
    assertExactFields(manifest, [
        'schema', 'contract_id', 'state', 'checkpoint_key', 'source_fingerprint',
        'encode_contract_sha256', 'encode_contract', 'artifact', 'staged_at', 'hashed_at',
    ], [], 'legacy candidate manifest');
    assertExactFields(manifest.artifact, [
        'relative_path', 'staged_relative_path', 'size_bytes', 'sha256_full',
    ], [], 'legacy candidate artifact');
    if (manifest.schema !== 1 || manifest.contract_id !== CHECKPOINT_CONTRACT_ID ||
        manifest.state !== 'ffmpeg_exit_0_pending_validation') {
        fail('legacy manifest is not a fully hashed FFmpeg-exit-0 pending candidate');
    }
    if (manifest.checkpoint_key !== expected.legacy_checkpoint_key ||
        manifest.encode_contract_sha256 !== expected.legacy_encode_contract_sha256) {
        fail('legacy manifest key or encode-contract identity differs from the reviewed request');
    }
    if (manifest.artifact.sha256_full !== expected.retained_sha256_full ||
        Number(manifest.artifact.size_bytes) !== Number(expected.retained_size_bytes)) {
        fail('legacy manifest does not authenticate the reviewed retained candidate identity');
    }
    if (path.basename(String(manifest.artifact.relative_path || '')) !==
            String(manifest.artifact.relative_path || '') ||
        !/^\.encode-partial-[A-Za-z0-9.-]+$/.test(
            String(manifest.artifact.staged_relative_path || ''))) {
        fail('legacy manifest artifact names are unsafe');
    }

    const sourceFingerprint = assertSourceFingerprint(
        manifest.source_fingerprint, 'legacy source fingerprint');
    const expectedFingerprint = assertSourceFingerprint(
        expected.source_fingerprint, 'expected.source_fingerprint');
    if (canonicalJson(sourceFingerprint) !== canonicalJson(expectedFingerprint) ||
        path.resolve(String(sourceFingerprint.resolved_path)) !== source.resolved) {
        fail('legacy source fingerprint differs from the reviewed source identity');
    }
    const legacyContractSha256 = sha256Text(canonicalJson(manifest.encode_contract));
    if (legacyContractSha256 !== manifest.encode_contract_sha256) {
        fail('legacy manifest encode-contract SHA-256 is internally inconsistent');
    }
    const legacyCheckpointKey = sha256Text(canonicalJson({
        contract_id: CHECKPOINT_CONTRACT_ID,
        source_fingerprint: sourceFingerprint,
        encode_contract_sha256: legacyContractSha256,
    }));
    if (legacyCheckpointKey !== manifest.checkpoint_key) {
        fail('legacy manifest checkpoint key is internally inconsistent');
    }

    const entryDir = path.dirname(manifestEvidence.snapshot.resolved);
    const bucketDir = path.dirname(entryDir);
    const manifestBase = path.basename(manifestEvidence.snapshot.resolved);
    const retainedBase = path.basename(retained.resolved);
    if (path.dirname(bucketDir) !== checkpointRoot ||
        path.basename(bucketDir) !== legacyCheckpointKey.slice(0, 2) ||
        path.basename(entryDir) !== legacyCheckpointKey ||
        path.dirname(retained.resolved) !== entryDir ||
        !exactQuarantinedName(manifestBase, 'candidate.json') ||
        !exactQuarantinedName(retainedBase, manifest.artifact.relative_path) ||
        !QUARANTINE_SUFFIX.test(manifestBase) || !QUARANTINE_SUFFIX.test(retainedBase)) {
        fail('legacy evidence is not the exact quarantined pair in its keyed checkpoint entry');
    }
    canonicalDirectory(bucketDir, 'legacy checkpoint bucket');
    canonicalDirectory(entryDir, 'legacy checkpoint entry');

    const normalized = normalizeLegacyProducerLogContract(
        manifest.encode_contract,
        expected.legacy_producer_log_path,
        expected.legacy_job_work_dir);
    checkpoint.assertEncodeContract(normalized.normalizedContract);
    const normalizedEncodeContractSha256 = sha256Text(
        canonicalJson(normalized.normalizedContract));
    const normalizedCheckpointKey = sha256Text(canonicalJson({
        contract_id: CHECKPOINT_CONTRACT_ID,
        source_fingerprint: sourceFingerprint,
        encode_contract_sha256: normalizedEncodeContractSha256,
    }));
    if (normalizedEncodeContractSha256 !== expected.normalized_encode_contract_sha256 ||
        normalizedCheckpointKey !== expected.normalized_checkpoint_key ||
        normalizedEncodeContractSha256 === legacyContractSha256 ||
        normalizedCheckpointKey === legacyCheckpointKey) {
        fail('normalized checkpoint identities differ from the independently reviewed request');
    }

    return {
        checkpointRoot,
        sourcePath: source.resolved,
        sourceFingerprint,
        manifest,
        manifestSnapshot: manifestEvidence.snapshot,
        retainedSnapshot: retained,
        legacyEntryDir: entryDir,
        legacyCheckpointKey,
        legacyEncodeContractSha256: legacyContractSha256,
        normalizedContract: normalized.normalizedContract,
        normalizedCheckpointKey,
        normalizedEncodeContractSha256,
        producerLogArgvIndex: normalized.producerLogArgvIndex,
        changedPaths: normalized.changedPaths,
    };
}

function copyAuthenticatedRetainedCandidate(evidence, workDir) {
    const extension = path.extname(String(evidence.manifest.artifact.relative_path || '')) || '.mkv';
    if (!/^\.[A-Za-z0-9]{1,12}$/.test(extension)) fail('legacy candidate extension is unsafe');
    const destination = path.resolve(workDir, `legacy-retained-import-source${extension}`);
    if (!pathWithin(workDir, destination) || fs.existsSync(destination)) {
        fail('recovery staging destination is not fresh and job-owned');
    }
    fs.copyFileSync(
        evidence.retainedSnapshot.resolved,
        destination,
        fs.constants.COPYFILE_EXCL | (fs.constants.COPYFILE_FICLONE || 0));
    try {
        const handle = fs.openSync(destination, 'r+');
        try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    } catch (error) {
        fail(`recovery staging copy could not be persisted: ${error.message}`);
    }
    const staged = snapshotRegularFile(destination, 'recovery staging copy', { singleLink: true });
    if (staged.sha256Full !== evidence.retainedSnapshot.sha256Full ||
        staged.sizeBytes !== evidence.retainedSnapshot.sizeBytes) {
        fail('recovery staging copy differs from the authenticated legacy candidate');
    }
    assertSnapshotUnchanged(evidence.manifestSnapshot, 'legacy invalid candidate manifest');
    assertSnapshotUnchanged(evidence.retainedSnapshot, 'legacy retained candidate');
    return staged;
}

function performRecovery(options) {
    options = options || {};
    const evidence = options.evidence;
    const recovery = options.recovery;
    const expected = options.expected || {};
    if (!evidence || !recovery ||
        typeof recovery.buildRetainedRecoveryPlan !== 'function' ||
        typeof recovery.importRetainedCheckpoint !== 'function' ||
        recovery.contractId !== IMPORT_CONTRACT_ID) {
        fail('deployed transcode plugin does not expose the retained-output recovery contract');
    }
    const workDir = canonicalDirectory(options.workDir, 'fresh recovery work directory');
    if (fs.readdirSync(workDir).length !== 0) {
        fail('fresh recovery work directory must be empty');
    }
    let context;
    try {
        context = recovery.buildRetainedRecoveryPlan({
            sourcePath: evidence.sourcePath,
            workDir,
            checkpointRoot: options.checkpointRoot,
            reuseRequiredRoot: options.reuseRequiredRoot,
            requireInitializedReuseRequiredRoot: true,
            enforcePinnedStorage: options.enforcePinnedStorage === true,
            ffmpegPath: options.ffmpegPath,
            ffprobePath: options.ffprobePath,
            sourceProbe: options.sourceProbe,
            variables: options.variables,
            preparedGrainReplay: options.preparedGrainReplay || null,
        });
    } catch (error) {
        fail(`fresh current recovery plan could not be built: ${error.message}`);
    }
    if (!context || !context.plan || typeof context.validator !== 'function' ||
        canonicalJson(context.encodeContract || context.plan.encodeContract) !==
            canonicalJson(evidence.normalizedContract) ||
        canonicalJson(context.sourceFingerprint || context.plan.sourceFingerprint) !==
            canonicalJson(evidence.sourceFingerprint)) {
        fail('normalized legacy contract does not exactly equal the fresh current recovery plan');
    }
    const plan = context.plan;
    if (plan.checkpointKey !== expected.normalized_checkpoint_key ||
        plan.encodeContractSha256 !== expected.normalized_encode_contract_sha256 ||
        plan.checkpointKey !== evidence.normalizedCheckpointKey ||
        plan.encodeContractSha256 !== evidence.normalizedEncodeContractSha256 ||
        plan.reused || plan.validationBlocked || plan.pendingCandidate || plan.invalidReason ||
        path.resolve(plan.entryDir) === path.resolve(evidence.legacyEntryDir) ||
        fs.readdirSync(plan.entryDir).length !== 0) {
        fail('fresh normalized checkpoint entry is not empty and exact');
    }
    const staged = copyAuthenticatedRetainedCandidate(evidence, workDir);
    let result;
    try {
        result = recovery.importRetainedCheckpoint(
            plan,
            staged.resolved,
            context.validator,
            {
                expectedCheckpointKey: expected.normalized_checkpoint_key,
                expectedEncodeContractSha256: expected.normalized_encode_contract_sha256,
                expectedSourceFingerprint: expected.source_fingerprint,
                expectedSourceSha256Full: expected.source_sha256_full,
                expectedRetainedSha256: expected.retained_sha256_full,
                expectedRetainedSizeBytes: expected.retained_size_bytes,
            });
    } finally {
        assertSnapshotUnchanged(evidence.manifestSnapshot, 'legacy invalid candidate manifest');
        assertSnapshotUnchanged(evidence.retainedSnapshot, 'legacy retained candidate');
    }
    assert(result && result.plan && result.latch);
    assert.strictEqual(result.plan.reused, true);
    assert.strictEqual(result.plan.checkpointKey, expected.normalized_checkpoint_key);
    assert.strictEqual(result.plan.encodeContractSha256,
        expected.normalized_encode_contract_sha256);
    assert.strictEqual(result.latch.marker.checkpoint_key, expected.normalized_checkpoint_key);
    const validation = result.plan.manifest && result.plan.manifest.media_validation;
    if (!validation || validation.validator !== EXHAUSTIVE_VALIDATOR ||
        validation.full_primary_video_decode !== true) {
        fail('import did not record the required exhaustive full-primary-video validation');
    }
    return { result, staged };
}

function readRequest(requestPath) {
    const requestEvidence = readJsonEvidence(requestPath, 'recovery request');
    const request = requestEvidence.value;
    assertExactFields(request, [
        'schema', 'contract_id', 'expected_recovery_utility_sha256',
        'plugin_path', 'expected_plugin_sha256', 'expected_helper_sha256',
        'source_path', 'legacy_candidate_manifest_path', 'legacy_retained_candidate_path',
        'work_dir', 'checkpoint_root', 'reuse_required_root', 'ffmpeg_path',
        'ffprobe_path', 'variables', 'expected',
    ], ['prepared_grain_replay'], 'recovery request');
    if (request.schema !== REQUEST_SCHEMA || request.contract_id !== REQUEST_CONTRACT_ID) {
        fail(`recovery request must use ${REQUEST_CONTRACT_ID} schema ${REQUEST_SCHEMA}`);
    }
    assertSha256(request.expected_plugin_sha256, 'expected_plugin_sha256');
    assertExactFields(
        request.expected_helper_sha256,
        REQUIRED_HELPERS,
        [],
        'expected_helper_sha256'
    );
    for (const helperName of REQUIRED_HELPERS) {
        assertSha256(
            request.expected_helper_sha256[helperName],
            `expected_helper_sha256.${helperName}`
        );
    }
    if (request.prepared_grain_replay) {
        validatePreparedGrainReplayRequestShape(
            request.prepared_grain_replay);
    }
    return { request, snapshot: requestEvidence.snapshot };
}

function pinnedRuntimeCommand(value, expectedRequest, expectedResolved, description) {
    const requested = String(value || '');
    if (requested !== expectedRequest) {
        fail(`${description} must preserve the exact runtime spelling '${expectedRequest}'`);
    }
    let firstExecutable = null;
    for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(directory, requested);
        try {
            const stat = fs.statSync(candidate);
            if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
            firstExecutable = fs.realpathSync(candidate);
            break;
        } catch (_) {}
    }
    if (!firstExecutable || firstExecutable !== expectedResolved) {
        fail(`${description} does not resolve to the pinned runtime command ${expectedResolved}`);
    }
    const command = snapshotRegularFile(
        firstExecutable,
        `${description} resolved command`,
        { singleLink: true }
    );
    if ((Number(command.stat.mode) & 0o111) === 0) {
        fail(`${description} resolved command is not executable`);
    }
    return Object.freeze({
        requested,
        resolved: command.resolved,
        snapshot: command,
    });
}

function probeSource(ffprobePath, sourcePath) {
    const result = childProcess.spawnSync(ffprobePath, [
        '-v', 'error', '-count_packets', '-show_streams', '-show_format', '-of', 'json', sourcePath,
    ], { encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * 1024 * 1024 });
    if (result.error) fail(`source ffprobe could not run: ${result.error.message}`);
    if (result.status !== 0) fail(`source ffprobe failed: ${String(result.stderr || '').trim()}`);
    let probe;
    try { probe = JSON.parse(result.stdout || '{}'); }
    catch (error) { fail(`source ffprobe returned invalid JSON: ${error.message}`); }
    if (!probe || !probe.format || !Array.isArray(probe.streams) || probe.streams.length === 0) {
        fail('source ffprobe returned an incomplete media inventory');
    }
    return probe;
}

function grainReplayReceiptSourceStat(stat) {
    const size = Number(stat.size);
    const mtimeNs = BigInt(stat.mtimeNs);
    if (!Number.isSafeInteger(size) || size <= 0) {
        fail('prepared grain receipt source size is invalid');
    }
    return {
        dev: String(stat.dev),
        ino: String(stat.ino),
        size,
        mtime_ms: Number(mtimeNs) / 1000000,
    };
}

function authenticatePreparedGrainReplayRuntime(runtime, options) {
    options = options || {};
    const runtimePins =
        options.runtimePins || PINNED_GRAIN_REPLAY_RUNTIME;
    const realpath = options.realpathSync || fs.realpathSync;
    const snapshotFile =
        options.snapshotRegularFile || snapshotRegularFile;
    assertExactFields(
        runtime,
        Object.keys(runtimePins),
        [],
        'prepared grain receipt runtime'
    );
    const snapshots = [];
    for (const [name, expected] of Object.entries(runtimePins)) {
        assertExactFields(runtime[name], [
            'requested_path', 'resolved_path', 'size_bytes', 'sha256_full',
        ], [], 'prepared grain receipt runtime identity');
        assertSha256(
            expected.sha256,
            'pinned prepared grain runtime SHA-256');
        if (runtime[name].requested_path !== expected.requestedPath ||
            runtime[name].resolved_path !== expected.resolvedPath ||
            runtime[name].size_bytes !== expected.sizeBytes ||
            runtime[name].sha256_full !== expected.sha256) {
            fail('prepared grain receipt runtime differs from the pinned r2 identity');
        }
        let resolved;
        try {
            resolved = realpath(expected.requestedPath);
        } catch (_) {
            fail('a pinned prepared grain runtime path could not be resolved');
        }
        if (path.resolve(resolved) !== path.resolve(expected.resolvedPath)) {
            fail('a prepared grain runtime path resolves outside its pinned r2 identity');
        }
        const snapshot = snapshotFile(
            expected.resolvedPath,
            `prepared grain runtime ${name}`,
            { singleLink: true }
        );
        if (snapshot.sizeBytes !== expected.sizeBytes ||
            snapshot.sha256Full !== expected.sha256) {
            fail('current prepared grain runtime bytes differ from the receipt pin');
        }
        snapshots.push({
            name: `runtime ${name}`,
            snapshot,
            options: { singleLink: true },
        });
    }
    return snapshots;
}

function validatePreparedGrainReplayRequestShape(replay) {
    assertExactFields(replay, [
        'manifest_path', 'manifest_sha256_full',
        'table_path', 'table_sha256_full',
        'pipeline_path', 'pipeline_sha256_full',
        'receipt_path', 'receipt_sha256_full',
        'expected_profile',
    ], [], 'prepared_grain_replay');
    if (replay.expected_profile !== 'sdr') {
        fail('prepared_grain_replay.expected_profile must be the reviewed SDR profile');
    }
    for (const name of ['manifest', 'table', 'pipeline', 'receipt']) {
        absolutePath(
            replay[`${name}_path`],
            `prepared_grain_replay.${name}_path`
        );
        assertSha256(
            replay[`${name}_sha256_full`],
            `prepared_grain_replay.${name}_sha256_full`
        );
    }
    return replay;
}

function authenticatePreparedGrainReplayReceipt(
    replay, sourcePath, expectedSourceFingerprint, options) {
    options = options || {};
    validatePreparedGrainReplayRequestShape(replay);
    const manifest = snapshotRegularFile(
        replay.manifest_path,
        'prepared grain manifest',
        { singleLink: true, ownerOnly: true }
    );
    const table = snapshotRegularFile(
        replay.table_path,
        'prepared grain table',
        { singleLink: true, ownerOnly: true }
    );
    const pipeline = snapshotRegularFile(
        replay.pipeline_path,
        'prepared grain pipeline',
        { singleLink: true }
    );
    const receiptEvidence = readJsonEvidence(
        replay.receipt_path,
        'prepared grain replay receipt'
    );
    for (const [name, snapshot] of [
        ['manifest', manifest],
        ['table', table],
        ['pipeline', pipeline],
        ['receipt', receiptEvidence.snapshot],
    ]) {
        if (snapshot.sha256Full !== assertSha256(
            replay[`${name}_sha256_full`],
            `prepared grain ${name} SHA-256`)) {
            fail(`prepared grain ${name} bytes differ from the reviewed request`);
        }
    }
    const replayDirectory = path.dirname(manifest.resolved);
    if (path.dirname(table.resolved) !== replayDirectory ||
        path.dirname(receiptEvidence.snapshot.resolved) !== replayDirectory ||
        path.basename(manifest.resolved) !== 'grain-pipeline-manifest.json' ||
        path.basename(table.resolved) !== 'grain-table.txt' ||
        path.basename(receiptEvidence.snapshot.resolved) !==
            'grain-replay-receipt.json') {
        fail('prepared grain receipt and artifacts do not use the exact reviewed layout');
    }
    canonicalDirectory(
        replayDirectory,
        'prepared grain replay directory',
        { ownerOnly: true }
    );
    const expectedReplayNames = [
        'grain-pipeline-manifest.json',
        'grain-pipeline-private.log',
        'grain-replay-receipt.json',
        'grain-table.txt',
    ];
    if (canonicalJson(fs.readdirSync(replayDirectory).sort()) !==
        canonicalJson(expectedReplayNames)) {
        fail('prepared grain replay directory contains an unreviewed artifact set');
    }
    snapshotRegularFile(
        path.join(replayDirectory, 'grain-pipeline-private.log'),
        'prepared grain private log',
        { singleLink: true, ownerOnly: true }
    );
    const receipt = receiptEvidence.value;
    assertExactFields(receipt, [
        'schema',
        'contract_id',
        'state',
        'source_before',
        'source_after',
        'source_classification',
        'runtime',
        'table',
        'manifest',
        'duration_seconds',
        'process_group_absent',
        'generation_scoped_lock_released',
        'process_group',
        'production_lock',
    ], [], 'prepared grain replay receipt');
    if (receipt.schema !== PREPARED_GRAIN_REPLAY_RECEIPT_SCHEMA ||
        receipt.contract_id !==
            PREPARED_GRAIN_REPLAY_RECEIPT_CONTRACT_ID ||
        receipt.state !== 'prepared' ||
        receipt.process_group_absent !== true ||
        receipt.generation_scoped_lock_released !== true ||
        !Number.isSafeInteger(receipt.duration_seconds) ||
        receipt.duration_seconds < 0 ||
        receipt.duration_seconds > 3600) {
        fail('prepared grain replay receipt does not authorize successful completion');
    }
    assertExactFields(receipt.process_group, [
        'pgid', 'exit_code', 'exit_signal', 'absent',
        'supervision_events',
    ], [], 'prepared grain replay process group');
    if (!Number.isSafeInteger(receipt.process_group.pgid) ||
        receipt.process_group.pgid <= 1 ||
        receipt.process_group.exit_code !== 0 ||
        receipt.process_group.exit_signal !== null ||
        receipt.process_group.absent !== true ||
        !Array.isArray(receipt.process_group.supervision_events) ||
        receipt.process_group.supervision_events.length < 4 ||
        receipt.process_group.supervision_events.length > 64) {
        fail('prepared grain replay process-group proof is incomplete');
    }
    const requiredAbsenceReasons = new Set([
        'leader_completion',
        'post_deadline_cleanup',
        'absence_poll',
        'final_absence_proof',
    ]);
    for (const event of receipt.process_group.supervision_events) {
        assertExactFields(event, [
            'reason', 'check', 'alive',
        ], [], 'prepared grain replay supervision event');
        if (!requiredAbsenceReasons.has(event.reason) ||
            event.check !== 'process_group_alive' ||
            event.alive !== false) {
            fail('prepared grain replay supervision event is not a clean absence proof');
        }
        requiredAbsenceReasons.delete(event.reason);
    }
    if (requiredAbsenceReasons.size !== 0) {
        fail('prepared grain replay process-group proof omits a required boundary');
    }
    assertExactFields(receipt.production_lock, [
        'token',
        'lease_generation',
        'automatic_stale_break_disabled',
        'retained',
        'generation_scoped_release',
    ], [], 'prepared grain replay production lock');
    if (!/^[A-Za-z0-9_.-]{1,512}$/.test(
        String(receipt.production_lock.token || '')) ||
        !/^[A-Za-z0-9_.-]{1,512}$/.test(
            String(receipt.production_lock.lease_generation || '')) ||
        receipt.production_lock.automatic_stale_break_disabled !== true ||
        receipt.production_lock.retained !== false ||
        receipt.production_lock.generation_scoped_release !== true ||
        receipt.process_group_absent !== receipt.process_group.absent ||
        receipt.generation_scoped_lock_released !==
            receipt.production_lock.generation_scoped_release) {
        fail('prepared grain replay production-lock proof is incomplete');
    }
    assertExactFields(receipt.source_classification, [
        'eligible', 'profile', 'label',
    ], [], 'prepared grain replay source classification');
    if (receipt.source_classification.eligible !== true ||
        receipt.source_classification.profile !== 'sdr' ||
        !['SDR', 'inferred SDR'].includes(
            receipt.source_classification.label)) {
        fail('prepared grain replay receipt does not bind an eligible SDR source');
    }
    const source = inspectCanonicalRegularFile(
        sourcePath, 'prepared grain receipt source');
    const expectedReceiptStat =
        grainReplayReceiptSourceStat(source.stat);
    for (const boundary of ['source_before', 'source_after']) {
        assertExactFields(receipt[boundary], [
            'stat', 'fingerprint',
        ], [], `prepared grain receipt ${boundary}`);
        assertExactFields(receipt[boundary].stat, [
            'dev', 'ino', 'size', 'mtime_ms',
        ], [], `prepared grain receipt ${boundary} stat`);
        if (canonicalJson(receipt[boundary].stat) !==
                canonicalJson(expectedReceiptStat) ||
            canonicalJson(receipt[boundary].fingerprint) !==
                canonicalJson(expectedSourceFingerprint)) {
            fail('prepared grain receipt source boundary differs from current reviewed source');
        }
    }
    if (canonicalJson(receipt.source_before) !==
        canonicalJson(receipt.source_after)) {
        fail('prepared grain receipt source changed during generation');
    }
    for (const [name, snapshot] of [
        ['table', table],
        ['manifest', manifest],
    ]) {
        assertExactFields(receipt[name], [
            'size_bytes', 'sha256_full',
        ], [], `prepared grain receipt ${name}`);
        if (!Number.isSafeInteger(receipt[name].size_bytes) ||
            receipt[name].size_bytes !== snapshot.sizeBytes ||
            receipt[name].sha256_full !== snapshot.sha256Full) {
            fail(`prepared grain receipt ${name} identity differs from current bytes`);
        }
    }
    const runtimeSnapshots = authenticatePreparedGrainReplayRuntime(
        receipt.runtime, options);
    const pipelineRuntime = receipt.runtime.pipeline;
    if (pipelineRuntime.resolved_path !== pipeline.resolved ||
        pipelineRuntime.size_bytes !== pipeline.sizeBytes ||
        pipelineRuntime.sha256_full !== pipeline.sha256Full) {
        fail('prepared grain receipt pipeline pin differs from the reviewed pipeline');
    }
    return {
        replay: {
            manifestPath: manifest.resolved,
            tablePath: table.resolved,
            pipelinePath: pipeline.resolved,
            expectedProfile: replay.expected_profile,
        },
        receipt,
        snapshots: [
            {
                name: 'manifest',
                snapshot: manifest,
                options: { singleLink: true, ownerOnly: true },
            },
            {
                name: 'table',
                snapshot: table,
                options: { singleLink: true, ownerOnly: true },
            },
            {
                name: 'pipeline',
                snapshot: pipeline,
                options: { singleLink: true },
            },
            {
                name: 'receipt',
                snapshot: receiptEvidence.snapshot,
                options: { singleLink: true, ownerOnly: true },
            },
            ...runtimeSnapshots,
        ],
    };
}

function assertPreparedGrainReplayUnchanged(evidence) {
    if (!evidence || !Array.isArray(evidence.snapshots)) {
        fail('prepared grain replay evidence is unavailable');
    }
    evidence.snapshots.forEach((item) => {
        assertSnapshotUnchanged(
            item.snapshot,
            `prepared grain ${item.name}`,
            item.options
        );
    });
}

function prepareGrainReplay(request) {
    if (!request.prepared_grain_replay) return null;
    return authenticatePreparedGrainReplayReceipt(
        request.prepared_grain_replay,
        request.source_path,
        request.expected && request.expected.source_fingerprint
    );
}

function createFreshWorkDirectory(workDir) {
    const resolved = absolutePath(workDir, 'work_dir');
    if (path.dirname(resolved) !== path.resolve(PINNED_WORK_PARENT) ||
        !/^tdarr-legacy-recovery-[-_.A-Za-z0-9]+$/.test(path.basename(resolved))) {
        fail('work_dir must be a dedicated /temp/tdarr-legacy-recovery-* directory');
    }
    canonicalDirectory(path.dirname(resolved), 'recovery work parent');
    if (fs.existsSync(resolved)) fail('work_dir must not already exist');
    fs.mkdirSync(resolved, { recursive: false, mode: 0o700 });
    const created = canonicalDirectory(resolved, 'fresh recovery work directory');
    if (fs.readdirSync(created).length !== 0) fail('new recovery work directory is not empty');
    return created;
}

function parseArguments(argv) {
    if (argv.length !== 2 || argv[0] !== '--request') {
        fail('usage: recover-legacy-job-scoped-checkpoint.js --request /absolute/request.json');
    }
    return argv[1];
}

function authenticateRecoveryDeployment(request) {
    const plugin = snapshotRegularFile(
        request.plugin_path,
        'deployed transcode plugin',
        { singleLink: true }
    );
    if (plugin.resolved !== path.resolve(
        '/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/' +
        'vmaf/vmafOptimizedTranscode/1.0.0/index.js'
    ) || plugin.sha256Full !== request.expected_plugin_sha256) {
        fail('deployed transcode plugin differs from the reviewed request');
    }
    const helperRoot = path.resolve(path.dirname(plugin.resolved), '../../_lib');
    const helpers = {};
    for (const helperName of REQUIRED_HELPERS) {
        const helper = snapshotRegularFile(
            path.join(helperRoot, helperName),
            'deployed recovery helper',
            { singleLink: true }
        );
        if (helper.resolved !== path.join(helperRoot, helperName) ||
            helper.sha256Full !== request.expected_helper_sha256[helperName]) {
            fail('deployed recovery helper differs from the reviewed request');
        }
        helpers[helperName] = helper;
    }
    return { plugin, helpers };
}

function main(argv) {
    if (process.env.ALLOW_LEGACY_PRODUCER_LOG_CHECKPOINT_RECOVERY !== '1') {
        fail('set ALLOW_LEGACY_PRODUCER_LOG_CHECKPOINT_RECOVERY=1 for an explicitly reviewed import');
    }
    const requestEvidence = readRequest(parseArguments(argv));
    const request = requestEvidence.request;
    const utility = snapshotRegularFile(
        fs.realpathSync(__filename),
        'recovery utility',
        { singleLink: true }
    );
    if (utility.sha256Full !== assertSha256(
        request.expected_recovery_utility_sha256, 'expected_recovery_utility_sha256')) {
        fail('recovery utility bytes do not match the reviewed request');
    }
    const checkpointRoot = canonicalDirectory(request.checkpoint_root, 'checkpoint_root');
    const reuseRequiredRoot = canonicalDirectory(
        request.reuse_required_root, 'reuse_required_root');
    const runtimeCheckpointRoot = absolutePath(
        process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT, 'VMAF_POSTENCODE_CHECKPOINT_ROOT');
    const runtimeReuseRoot = absolutePath(
        process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT, 'VMAF_POSTENCODE_REUSE_REQUIRED_ROOT');
    if (checkpointRoot !== path.resolve(PINNED_CHECKPOINT_ROOT) ||
        checkpointRoot !== runtimeCheckpointRoot ||
        reuseRequiredRoot !== path.resolve(PINNED_REUSE_REQUIRED_ROOT) ||
        reuseRequiredRoot !== runtimeReuseRoot) {
        fail('recovery roots must equal the effective pinned production roots');
    }
    const ffmpegCommand = pinnedRuntimeCommand(
        request.ffmpeg_path, PINNED_FFMPEG_REQUEST, PINNED_FFMPEG_RESOLVED, 'ffmpeg_path');
    const ffprobeCommand = pinnedRuntimeCommand(
        request.ffprobe_path, PINNED_FFPROBE_REQUEST, PINNED_FFPROBE_RESOLVED, 'ffprobe_path');

    const deployment = authenticateRecoveryDeployment(request);
    if (!request.variables || typeof request.variables !== 'object' ||
        Array.isArray(request.variables)) {
        fail('variables must be the reviewed terminal job contract object');
    }
    assertExactFields(request.expected, [
        'legacy_manifest_sha256_full', 'legacy_checkpoint_key',
        'legacy_encode_contract_sha256', 'legacy_job_work_dir',
        'legacy_producer_log_path', 'source_fingerprint', 'source_sha256_full',
        'retained_sha256_full', 'retained_size_bytes',
        'normalized_encode_contract_sha256', 'normalized_checkpoint_key',
    ], [], 'expected');
    if (!Number.isSafeInteger(Number(request.expected.retained_size_bytes)) ||
        Number(request.expected.retained_size_bytes) <= 0) {
        fail('expected.retained_size_bytes must be a positive safe integer');
    }

    const checkpoint = require(
        deployment.helpers['postEncodeCheckpoint.js'].resolved
    );
    const evidence = authenticateLegacyEvidence({
        checkpoint,
        checkpointRoot,
        sourcePath: request.source_path,
        legacyManifestPath: request.legacy_candidate_manifest_path,
        legacyRetainedPath: request.legacy_retained_candidate_path,
        expected: request.expected,
    });
    const sourceProbe = probeSource(
        ffprobeCommand.resolved,
        evidence.sourcePath
    );
    const preparedGrainEvidence = prepareGrainReplay(request);
    const loaded = require(deployment.plugin.resolved);
    const recovery = loaded && loaded.recovery;

    assertSnapshotUnchanged(requestEvidence.snapshot, 'recovery request', {
        singleLink: true,
        ownerOnly: true,
    });
    assertSnapshotUnchanged(
        utility,
        'recovery utility',
        { singleLink: true }
    );
    assertSnapshotUnchanged(
        ffmpegCommand.snapshot,
        'ffmpeg_path resolved command',
        { singleLink: true }
    );
    assertSnapshotUnchanged(
        ffprobeCommand.snapshot,
        'ffprobe_path resolved command',
        { singleLink: true }
    );
    assertSnapshotUnchanged(deployment.plugin, 'deployed transcode plugin');
    Object.values(deployment.helpers).forEach((snapshot) => {
        assertSnapshotUnchanged(snapshot, 'deployed recovery helper');
    });
    assertSnapshotUnchanged(evidence.manifestSnapshot, 'legacy invalid candidate manifest');
    assertSnapshotUnchanged(evidence.retainedSnapshot, 'legacy retained candidate');
    if (preparedGrainEvidence) {
        assertPreparedGrainReplayUnchanged(preparedGrainEvidence);
    }

    const workDir = createFreshWorkDirectory(request.work_dir);
    let recovered;
    try {
        recovered = performRecovery({
            evidence,
            recovery,
            expected: request.expected,
            workDir,
            checkpointRoot,
            reuseRequiredRoot,
            enforcePinnedStorage: true,
            ffmpegPath: ffmpegCommand.requested,
            ffprobePath: ffprobeCommand.requested,
            sourceProbe,
            variables: request.variables,
            preparedGrainReplay: preparedGrainEvidence && preparedGrainEvidence.replay,
        });
    } finally {
        if (preparedGrainEvidence) {
            assertPreparedGrainReplayUnchanged(preparedGrainEvidence);
        }
        assertSnapshotUnchanged(requestEvidence.snapshot, 'recovery request', {
            singleLink: true,
            ownerOnly: true,
        });
        assertSnapshotUnchanged(
            utility,
            'recovery utility',
            { singleLink: true }
        );
        assertSnapshotUnchanged(
            ffmpegCommand.snapshot,
            'ffmpeg_path resolved command',
            { singleLink: true }
        );
        assertSnapshotUnchanged(
            ffprobeCommand.snapshot,
            'ffprobe_path resolved command',
            { singleLink: true }
        );
        assertSnapshotUnchanged(deployment.plugin, 'deployed transcode plugin');
        Object.values(deployment.helpers).forEach((snapshot) => {
            assertSnapshotUnchanged(snapshot, 'deployed recovery helper');
        });
    }
    const result = recovered.result;
    process.stdout.write(`${JSON.stringify({
        ok: true,
        contract_id: REQUEST_CONTRACT_ID,
        legacy_evidence_preserved: true,
        checkpoint_imported: true,
        exact_reuse_armed: true,
        exhaustive_media_validation: {
            validator: result.plan.manifest.media_validation.validator,
            full_primary_video_decode:
                result.plan.manifest.media_validation.full_primary_video_decode,
        },
    }, null, 2)}\n`);
}

module.exports = {
    REQUEST_SCHEMA,
    REQUEST_CONTRACT_ID,
    IMPORT_CONTRACT_ID,
    CHECKPOINT_CONTRACT_ID,
    PRE_DISPATCH_CONTRACT_ID,
    PRE_DISPATCH_SCHEMA,
    EXECUTION_PATH_CONTRACT_ID,
    SOURCE_BACKUP_CONTRACT_ID,
    PREPARED_GRAIN_REPLAY_RECEIPT_SCHEMA,
    PREPARED_GRAIN_REPLAY_RECEIPT_CONTRACT_ID,
    PINNED_GRAIN_REPLAY_RUNTIME,
    PRODUCER_LOG_TOKEN,
    EXHAUSTIVE_VALIDATOR,
    PINNED_FLOW_ID,
    PINNED_SERVER_PLUGIN_ROOT,
    PINNED_NODE_PLUGIN_ROOT,
    PINNED_LOCAL_SOURCE_ROOTS,
    REQUIRED_DISABLED_GLOBAL_SETTINGS,
    REQUIRED_DISABLED_UPDATER_ENV,
    REQUIRED_EXECUTION_ROLES,
    REQUIRED_HELPERS,
    REQUIRED_R2_HELPERS,
    canonicalJson,
    sha256Text,
    stableObjectSha256,
    snapshotRegularFile,
    readJsonEvidence,
    assertSnapshotUnchanged,
    parseNullDelimitedEnvironment,
    readPidOneEnvironment,
    assertUpdaterEnvironment,
    validatePreDispatchContract,
    authenticateLiveStateDocuments,
    validateLiveFlowStructure,
    authenticateExecutionPath,
    assertExecutionPathUnchanged,
    loadAuthenticatedCommonJs,
    authenticateSourceMediaBackup,
    assertSourceMediaBackupUnchanged,
    grainReplayReceiptSourceStat,
    authenticatePreparedGrainReplayRuntime,
    validatePreparedGrainReplayRequestShape,
    authenticatePreparedGrainReplayReceipt,
    assertPreparedGrainReplayUnchanged,
    normalizeLegacyProducerLogContract,
    authenticateLegacyEvidence,
    copyAuthenticatedRetainedCandidate,
    performRecovery,
    main,
};

if (require.main === module) {
    try {
        main(process.argv.slice(2));
    } catch (_) {
        process.stderr.write(
            'ERROR: legacy retained checkpoint recovery aborted (RECOVERY_GATE_FAILED)\n');
        process.exitCode = 1;
    }
}
