#!/usr/bin/env node
'use strict';

// One-shot, fail-closed recovery of an exact FFmpeg-exit-0 AV1 into the
// production post-encode checkpoint contract. This utility never launches an
// encoder. It requires independently recorded source, plugin, command-plan,
// and retained-file identities before it will copy or publish anything.

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REQUEST_SCHEMA = 1;
const REQUEST_CONTRACT_ID = 'vmaf-retained-postencode-import-v1';
const MAX_REQUEST_BYTES = 1024 * 1024;
const PINNED_CHECKPOINT_ROOT = '/temp/.vmaf-postencode-checkpoints-v1';
const PINNED_REUSE_REQUIRED_ROOT = '/app/configs/vmaf-postencode-reuse-required-v1';
const PINNED_FFMPEG_REQUEST = 'tdarr-ffmpeg';
const PINNED_FFMPEG_RESOLVED = '/usr/local/bin/tdarr-ffmpeg';
const PINNED_FFPROBE_REQUEST = 'tdarr-ffprobe';
const PINNED_FFPROBE_RESOLVED = '/usr/local/bin/tdarr-ffprobe';

function fail(message) {
    throw new Error(String(message));
}

function sha256File(filePath) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    const handle = fs.openSync(filePath, 'r');
    try {
        let position = 0;
        while (true) {
            const count = fs.readSync(handle, buffer, 0, buffer.length, position);
            if (count === 0) break;
            hash.update(count === buffer.length ? buffer : buffer.subarray(0, count));
            position += count;
        }
    } finally {
        fs.closeSync(handle);
    }
    return hash.digest('hex');
}

function boundedRegularFile(filePath, description) {
    const resolved = path.resolve(String(filePath || ''));
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
        fail(`${description} is not a non-empty, non-symlink regular file: ${resolved}`);
    }
    return { resolved, stat };
}

function absolutePath(value, description) {
    const candidate = String(value || '');
    if (!candidate || !path.isAbsolute(candidate)) fail(`${description} must be an absolute path`);
    return path.resolve(candidate);
}

function pinnedRuntimeCommand(value, expectedRequest, expectedResolved, description) {
    const requested = String(value || '');
    if (requested !== expectedRequest) {
        fail(`${description} must preserve the exact Tdarr runtime spelling '${expectedRequest}'`);
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
    if (!firstExecutable) fail(`${description} is not executable through the runtime PATH`);
    if (firstExecutable !== expectedResolved) {
        fail(`${description} resolves to ${firstExecutable}, expected ${expectedResolved}`);
    }
    const commandFile = boundedRegularFile(firstExecutable, `${description} resolved command`);
    if ((commandFile.stat.mode & 0o111) === 0) {
        fail(`${description} resolved command is not executable: ${firstExecutable}`);
    }
    return requested;
}

function readRequest(requestPath) {
    const requestFile = boundedRegularFile(requestPath, 'recovery request');
    if (requestFile.stat.size > MAX_REQUEST_BYTES) fail('recovery request exceeds 1 MiB');
    let request;
    try { request = JSON.parse(fs.readFileSync(requestFile.resolved, 'utf8')); }
    catch (error) { fail(`recovery request is not valid JSON: ${error.message}`); }
    if (!request || request.schema !== REQUEST_SCHEMA || request.contract_id !== REQUEST_CONTRACT_ID) {
        fail(`recovery request must use ${REQUEST_CONTRACT_ID} schema ${REQUEST_SCHEMA}`);
    }
    return request;
}

function probeSource(ffprobePath, sourcePath) {
    const result = childProcess.spawnSync(ffprobePath, [
        '-v', 'error', '-show_streams', '-show_format', '-of', 'json', sourcePath,
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

function parseArguments(argv) {
    if (argv.length !== 2 || argv[0] !== '--request') {
        fail('usage: import-retained-postencode-checkpoint.js --request /absolute/request.json');
    }
    return argv[1];
}

function main(argv) {
    if (process.env.ALLOW_RETAINED_POSTENCODE_IMPORT !== '1') {
        fail('set ALLOW_RETAINED_POSTENCODE_IMPORT=1 for an explicitly reviewed one-shot import');
    }
    const request = readRequest(parseArguments(argv));
    if (!/^[0-9a-f]{64}$/.test(String(request.expected_importer_sha256 || '')) ||
        sha256File(fs.realpathSync(__filename)) !== request.expected_importer_sha256) {
        fail('importer bytes do not match expected_importer_sha256');
    }
    const pluginPath = absolutePath(request.plugin_path, 'plugin_path');
    const sourcePath = absolutePath(request.source_path, 'source_path');
    const retainedPath = absolutePath(request.retained_candidate_path, 'retained_candidate_path');
    const workDir = absolutePath(request.work_dir, 'work_dir');
    const checkpointRoot = absolutePath(request.checkpoint_root, 'checkpoint_root');
    const reuseRequiredRoot = absolutePath(request.reuse_required_root, 'reuse_required_root');
    const ffmpegRequest = String(request.ffmpeg_path || '');
    const ffprobeRequest = String(request.ffprobe_path || '');

    const runtimeCheckpointRoot = absolutePath(
        process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT, 'VMAF_POSTENCODE_CHECKPOINT_ROOT');
    const runtimeReuseRequiredRoot = absolutePath(
        process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT, 'VMAF_POSTENCODE_REUSE_REQUIRED_ROOT');
    if (checkpointRoot !== runtimeCheckpointRoot || checkpointRoot !== path.resolve(PINNED_CHECKPOINT_ROOT)) {
        fail(`checkpoint_root must equal the effective production root ${PINNED_CHECKPOINT_ROOT}`);
    }
    if (reuseRequiredRoot !== runtimeReuseRequiredRoot ||
        reuseRequiredRoot !== path.resolve(PINNED_REUSE_REQUIRED_ROOT)) {
        fail(`reuse_required_root must equal the effective production root ${PINNED_REUSE_REQUIRED_ROOT}`);
    }

    // The original Flow and every normal retry invoke these commands by their
    // Tdarr runtime names. Requested spelling is part of the exact encode
    // contract, so importing with an absolute synonym would publish a valid
    // artifact under a key the real job can never reuse. Resolve and
    // authenticate the runtime names, but preserve those names in the plan.
    const ffmpegPath = pinnedRuntimeCommand(
        ffmpegRequest, PINNED_FFMPEG_REQUEST, PINNED_FFMPEG_RESOLVED, 'ffmpeg_path');
    const ffprobePath = pinnedRuntimeCommand(
        ffprobeRequest, PINNED_FFPROBE_REQUEST, PINNED_FFPROBE_RESOLVED, 'ffprobe_path');

    const pluginFile = boundedRegularFile(pluginPath, 'transcode plugin');
    boundedRegularFile(sourcePath, 'source');
    boundedRegularFile(retainedPath, 'retained encoder output');
    if (!/^[0-9a-f]{64}$/.test(String(request.expected_plugin_sha256 || '')) ||
        sha256File(pluginFile.resolved) !== request.expected_plugin_sha256) {
        fail('transcode plugin bytes do not match expected_plugin_sha256');
    }
    const expectedHelpers = request.expected_helper_sha256;
    if (!expectedHelpers || typeof expectedHelpers !== 'object' || Array.isArray(expectedHelpers)) {
        fail('recovery request lacks expected_helper_sha256 identities');
    }
    const helperRoot = path.resolve(path.dirname(pluginFile.resolved), '../../_lib');
    for (const helperName of [
        'postEncodeCheckpoint.js', 'grainAnalysisArtifact.js',
        'nvencTemporalFilter.js', 'canonicalDenoise.js',
    ]) {
        const expectedDigest = String(expectedHelpers[helperName] || '');
        const helperFile = boundedRegularFile(path.join(helperRoot, helperName), `recovery helper ${helperName}`);
        if (!/^[0-9a-f]{64}$/.test(expectedDigest) || sha256File(helperFile.resolved) !== expectedDigest) {
            fail(`recovery helper ${helperName} does not match its expected SHA-256`);
        }
    }
    if (!request.variables || typeof request.variables !== 'object' || Array.isArray(request.variables)) {
        fail('recovery request variables must be the terminal job contract object');
    }
    if (!request.expected || typeof request.expected !== 'object') {
        fail('recovery request lacks independently recorded expected identities');
    }
    if (!/^[0-9a-f]{64}$/.test(String(request.expected.source_sha256_full || ''))) {
        fail('recovery request lacks independently recorded expected.source_sha256_full');
    }
    let preparedGrainReplay = null;
    if (request.variables.grainAnalysisStatus === 'prepared') {
        if (!request.prepared_grain_replay || typeof request.prepared_grain_replay !== 'object') {
            fail('prepared grain recovery requires authenticated prepared_grain_replay inputs');
        }
        const replayManifestPath = absolutePath(
            request.prepared_grain_replay.manifest_path, 'prepared_grain_replay.manifest_path');
        const replayTablePath = absolutePath(
            request.prepared_grain_replay.table_path, 'prepared_grain_replay.table_path');
        const replayPipelinePath = absolutePath(
            request.prepared_grain_replay.pipeline_path, 'prepared_grain_replay.pipeline_path');
        boundedRegularFile(replayManifestPath, 'retained grain manifest');
        boundedRegularFile(replayTablePath, 'retained grain table');
        boundedRegularFile(replayPipelinePath, 'pinned grain pipeline');
        if (request.prepared_grain_replay.expected_profile !== 'pq' &&
            request.prepared_grain_replay.expected_profile !== 'sdr') {
            fail('prepared_grain_replay.expected_profile must be pq or sdr');
        }
        preparedGrainReplay = {
            manifestPath: replayManifestPath,
            tablePath: replayTablePath,
            pipelinePath: replayPipelinePath,
            expectedProfile: request.prepared_grain_replay.expected_profile,
        };
    }
    if (path.resolve(workDir) === path.resolve(checkpointRoot) ||
        path.relative(workDir, checkpointRoot).split(path.sep)[0] !== '..') {
        fail('checkpoint_root must be outside the disposable recovery work_dir');
    }
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(checkpointRoot, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(workDir) !== workDir || fs.realpathSync(checkpointRoot) !== checkpointRoot) {
        fail('work_dir and checkpoint_root must resolve without symlink indirection');
    }
    const reuseRequiredStat = fs.lstatSync(reuseRequiredRoot);
    if (!reuseRequiredStat.isDirectory() || reuseRequiredStat.isSymbolicLink() ||
        fs.realpathSync(reuseRequiredRoot) !== reuseRequiredRoot) {
        fail('reuse_required_root must be the initialized, non-symlink production registry');
    }

    // Loading the deployed candidate plugin, rather than reimplementing its
    // planner here, guarantees that command construction and executable-byte
    // identity are the exact production implementation under review.
    const loaded = require(pluginFile.resolved);
    const recovery = loaded && loaded.recovery;
    if (!recovery || typeof recovery.buildRetainedRecoveryPlan !== 'function' ||
        typeof recovery.importRetainedCheckpoint !== 'function' ||
        recovery.contractId !== REQUEST_CONTRACT_ID) {
        fail('transcode plugin does not expose the retained-recovery contract');
    }
    const sourceProbe = probeSource(ffprobePath, sourcePath);
    const protectedContext = recovery.buildRetainedRecoveryPlan({
        sourcePath,
        workDir,
        checkpointRoot,
        reuseRequiredRoot,
        requireInitializedReuseRequiredRoot: true,
        enforcePinnedStorage: true,
        ffmpegPath,
        ffprobePath,
        sourceProbe,
        variables: request.variables,
        preparedGrainReplay,
    });
    const expected = request.expected;
    const result = recovery.importRetainedCheckpoint(
        protectedContext.plan,
        retainedPath,
        protectedContext.validator,
        {
            expectedCheckpointKey: expected.checkpoint_key,
            expectedEncodeContractSha256: expected.encode_contract_sha256,
            expectedSourceFingerprint: expected.source_fingerprint,
            expectedSourceSha256Full: expected.source_sha256_full,
            expectedRetainedSha256: expected.retained_sha256_full,
            expectedRetainedSizeBytes: expected.retained_size_bytes,
        });

    assert.strictEqual(result.plan.reused, true);
    assert.strictEqual(result.plan.checkpointKey, expected.checkpoint_key);
    assert.strictEqual(result.plan.encodeContractSha256, expected.encode_contract_sha256);
    assert.strictEqual(result.latch.marker.checkpoint_key, expected.checkpoint_key);
    process.stdout.write(`${JSON.stringify({
        ok: true,
        contract_id: REQUEST_CONTRACT_ID,
        checkpoint_key: result.plan.checkpointKey,
        encode_contract_sha256: result.plan.encodeContractSha256,
        checkpoint_root: result.plan.checkpointRoot,
        reuse_required_root: result.plan.reuseRequiredRoot,
        source_sha256_full: expected.source_sha256_full,
        artifact_path: result.plan.artifactPath,
        manifest_path: result.plan.manifestPath,
        reuse_required_marker_path: result.latch.markerPath,
        retained_sha256_full: result.plan.manifest.artifact.sha256_full,
        retained_size_bytes: result.plan.manifest.artifact.size_bytes,
        already_committed: result.alreadyCommitted,
        staging_method: result.stagingMethod,
        full_media_validation: result.plan.manifest.media_validation,
    }, null, 2)}\n`);
}

try {
    main(process.argv.slice(2));
} catch (error) {
    process.stderr.write(`ERROR: retained checkpoint import aborted: ${error.stack || error.message || error}\n`);
    process.exitCode = 1;
}
