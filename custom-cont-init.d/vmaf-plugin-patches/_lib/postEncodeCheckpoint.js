'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nvenccKnn = require('./nvenccKnn.js');

const SCHEMA = 1;
const CONTRACT_ID = 'vmaf-postencode-checkpoint-v1';
const DEFAULT_DIRECTORY = '.vmaf-postencode-checkpoints-v1';
const MANIFEST_NAME = 'manifest.json';
const CANDIDATE_MANIFEST_NAME = 'candidate.json';
const CANDIDATE_PENDING_MANIFEST_NAME = 'candidate.pending.json';
const REUSE_REQUIRED_SCHEMA = 1;
const REUSE_REQUIRED_CONTRACT_ID = 'vmaf-postencode-reuse-required-v1';
const REUSE_REQUIRED_DIRECTORY = '.reuse-required-v1';
const REUSE_REQUIRED_ROOT_SCHEMA = 1;
const REUSE_REQUIRED_ROOT_CONTRACT_ID = 'vmaf-postencode-reuse-required-root-v1';
const REUSE_REQUIRED_ROOT_SENTINEL = '.root-contract.json';
const REUSE_REQUIRED_ANCHOR_SCHEMA = 1;
const REUSE_REQUIRED_ANCHOR_CONTRACT_ID = 'vmaf-postencode-reuse-required-anchor-v1';
const REUSE_REQUIRED_ANCHOR_NAME = '.vmaf-postencode-reuse-required-active-v1.json';
const PINNED_CHECKPOINT_ROOT = '/temp/.vmaf-postencode-checkpoints-v1';
const PINNED_REUSE_REQUIRED_ROOT = '/app/configs/vmaf-postencode-reuse-required-v1';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;
const CONFIRMED_INVALID = 'confirmed_invalid';
const RETRYABLE_VALIDATION = 'retryable_validation';
const RETIREMENT_INVENTORY_SCHEMA =
    'vmaf-postencode-retirement-inventory/v1';
const RETIREMENT_INVENTORY_VERSION = 1;
const RETIREMENT_FIXED_SIDE_FILES = Object.freeze([
    'manifest.pending.json',
    CANDIDATE_MANIFEST_NAME,
    CANDIDATE_PENDING_MANIFEST_NAME,
]);
const RETIREMENT_QUARANTINE_SUFFIX =
    /\.invalid-\d+-\d+-[0-9a-f]{12}$/;

function checkpointError(message, disposition, cause) {
    const error = new Error(String(message));
    error.postEncodeCheckpointDisposition = disposition || RETRYABLE_VALIDATION;
    if (cause) error.cause = cause;
    return error;
}

function confirmedInvalidError(message, cause) {
    return checkpointError(message, CONFIRMED_INVALID, cause);
}

function isConfirmedInvalidError(error) {
    return Boolean(error && error.postEncodeCheckpointDisposition === CONFIRMED_INVALID);
}

function isRetryableValidationError(error) {
    return Boolean(error && error.postEncodeCheckpointDisposition === RETRYABLE_VALIDATION);
}

function reuseRequiredError(message, cause) {
    const error = new Error(String(message));
    error.postEncodeReuseRequired = true;
    if (cause) error.cause = cause;
    return error;
}

function isReuseRequiredError(error) {
    return Boolean(error && error.postEncodeReuseRequired === true);
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
        throw new Error('checkpoint contract contains a non-finite number');
    }
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
        throw new Error(`checkpoint contract contains unsupported ${typeof value} data`);
    }
    return value;
}

function canonicalJson(value) {
    return JSON.stringify(canonicalValue(value));
}

function sha256Text(value) {
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function sha256FileSync(filePath) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
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

function sourceScopeKey(sourceFingerprint) {
    return sha256Text(canonicalJson({
        contract_id: REUSE_REQUIRED_CONTRACT_ID,
        source_fingerprint: assertFingerprint(sourceFingerprint),
    }));
}

function reuseRequiredLocation(reuseRequiredRoot, sourceFingerprint) {
    const root = path.resolve(String(reuseRequiredRoot || ''));
    if (!root || root === path.parse(root).root) {
        throw new Error('reuse-required marker needs a protected registry root');
    }
    const key = sourceScopeKey(sourceFingerprint);
    const markerRoot = root;
    const bucketDir = path.join(root, key.slice(0, 2));
    const markerPath = path.join(bucketDir, `${key}.json`);
    if (!pathWithin(root, markerPath)) {
        throw new Error('derived reuse-required marker escaped its protected registry root');
    }
    return { key, markerRoot, bucketDir, markerPath };
}

function assertFingerprint(fingerprint) {
    if (!fingerprint || fingerprint.scheme !== 'sha256-sampled-v1' ||
        !/^[0-9a-f]{64}$/.test(String(fingerprint.sha256 || '')) ||
        !Number.isSafeInteger(Number(fingerprint.size_bytes)) || Number(fingerprint.size_bytes) <= 0 ||
        !Number.isFinite(Number(fingerprint.mtime_ns)) || !Number.isInteger(Number(fingerprint.mtime_ns)) ||
        !String(fingerprint.resolved_path || '').trim()) {
        throw new Error('post-encode checkpoint requires a complete sha256-sampled-v1 source fingerprint');
    }
    return canonicalValue(fingerprint);
}

function exactObjectFields(value, required, optional) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const allowed = new Set(required.concat(optional || []));
    const keys = Object.keys(value);
    return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
        keys.every((key) => allowed.has(key));
}

const executableIdentityValidationCache = new Map();

function absoluteShellExecTarget(filePath, sizeBytes) {
    const length = Math.min(Number(sizeBytes), 64 * 1024);
    const buffer = Buffer.alloc(length);
    const handle = fs.openSync(filePath, 'r');
    let count;
    try {
        count = fs.readSync(handle, buffer, 0, length, 0);
    } finally {
        fs.closeSync(handle);
    }
    const text = buffer.subarray(0, count).toString('utf8');
    if (text.slice(0, 2) !== '#!') return null;
    const match = text.match(
        /^[ \t]*exec[ \t]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^ \t\r\n"'$;&|<>]+))[ \t]+["']\$@["'][ \t]*$/m);
    return match ? String(match[1] || match[2] || match[3] || '') : null;
}

function assertExecutableIdentity(identity, expectedRequestedPath, description) {
    const required = ['requested_path', 'resolved_path', 'size_bytes', 'sha256_full'];
    if (!exactObjectFields(identity, required, ['effective_target']) ||
        String(identity.requested_path) !== String(expectedRequestedPath) ||
        !path.isAbsolute(String(identity.resolved_path || '')) ||
        !Number.isSafeInteger(Number(identity.size_bytes)) ||
        Number(identity.size_bytes) <= 0 ||
        !/^[0-9a-f]{64}$/.test(String(identity.sha256_full || ''))) {
        throw new Error(`${description} identity is incomplete or not bound to its requested path`);
    }
    const resolved = fs.realpathSync(identity.resolved_path);
    const stat = fs.statSync(resolved, { bigint: true });
    if (!stat.isFile() || stat.size <= 0n ||
        path.resolve(resolved) !== path.resolve(identity.resolved_path) ||
        Number(stat.size) !== Number(identity.size_bytes)) {
        throw new Error(`${description} identity does not match a current non-empty executable file`);
    }
    const cacheKey = [
        resolved, stat.size, stat.mtimeNs, stat.ctimeNs, stat.dev, stat.ino,
        identity.sha256_full,
    ].map(String).join('\u0000');
    let digestMatches = executableIdentityValidationCache.get(cacheKey);
    if (digestMatches === undefined) {
        digestMatches = sha256FileSync(resolved) === identity.sha256_full;
        executableIdentityValidationCache.set(cacheKey, digestMatches);
        while (executableIdentityValidationCache.size > 32) {
            executableIdentityValidationCache.delete(
                executableIdentityValidationCache.keys().next().value);
        }
    }
    if (!digestMatches) throw new Error(`${description} executable SHA-256 identity mismatch`);
    const effectiveTargetPath = absoluteShellExecTarget(resolved, stat.size);
    if (effectiveTargetPath) {
        if (!path.isAbsolute(effectiveTargetPath) ||
            identity.effective_target === undefined ||
            String(identity.effective_target.requested_path || '') !== effectiveTargetPath) {
            throw new Error(`${description} effective target identity is missing or not bound to its wrapper`);
        }
        assertExecutableIdentity(
            identity.effective_target,
            effectiveTargetPath,
            `${description} effective target`
        );
    } else if (identity.effective_target !== undefined) {
        throw new Error(`${description} declares an effective target not present in its executable bytes`);
    }
    return canonicalValue(identity);
}

function optionValueExactlyOnce(argv, option, description) {
    const indexes = [];
    argv.forEach((value, index) => {
        if (value === option) indexes.push(index);
    });
    if (indexes.length !== 1 || indexes[0] + 1 >= argv.length) {
        throw new Error(`${description} requires exactly one ${option} value`);
    }
    return argv[indexes[0] + 1];
}

function assertNvenccPipelineEncodeContract(contract) {
    const topLevelFields = [
        'schema', 'executable', 'executable_identity', 'argv', 'pipeline',
        'producer_identity', 'consumer_identity',
    ];
    if (!exactObjectFields(contract, topLevelFields) ||
        !Array.isArray(contract.argv) || contract.argv.length === 0 ||
        !String(contract.executable || '').trim()) {
        throw new Error('post-encode checkpoint requires a complete exact NVEncC pipeline contract');
    }
    const pipelineFields = [
        'schema', 'contract_id', 'denoise_id', 'reference_contract_id',
        'nvencc_path', 'coordinator_path', 'output_depth', 'pixel_transport',
        'knn_settings', 'producer_argv',
    ];
    const pipeline = contract.pipeline;
    if (!exactObjectFields(pipeline, pipelineFields) ||
        Number(pipeline.schema) !== 1 ||
        pipeline.contract_id !== nvenccKnn.CONTRACT_ID ||
        pipeline.denoise_id !== nvenccKnn.DENOISE_ID ||
        pipeline.reference_contract_id !== nvenccKnn.REFERENCE_CONTRACT_ID ||
        pipeline.pixel_transport !== 'raw-yuv420-nut-stdout' ||
        pipeline.knn_settings !== nvenccKnn.KNN_SETTINGS ||
        ![8, 10].includes(Number(pipeline.output_depth)) ||
        pipeline.coordinator_path !== contract.executable ||
        !path.isAbsolute(String(pipeline.nvencc_path || '')) ||
        !path.isAbsolute(String(pipeline.coordinator_path || '')) ||
        !Array.isArray(pipeline.producer_argv)) {
        throw new Error('post-encode checkpoint NVEncC pipeline descriptor mismatch');
    }

    assertExecutableIdentity(
        contract.executable_identity, contract.executable,
        'post-encode coordinator');
    assertExecutableIdentity(
        contract.producer_identity, pipeline.nvencc_path,
        'post-encode NVEncC producer');

    const argv = contract.argv.map(String);
    const delimiterIndexes = [];
    argv.forEach((value, index) => {
        if (value === '--') delimiterIndexes.push(index);
    });
    if (delimiterIndexes.length !== 1 || delimiterIndexes[0] <= 0 ||
        delimiterIndexes[0] >= argv.length - 1) {
        throw new Error('post-encode checkpoint NVEncC coordinator argv delimiter mismatch');
    }
    const consumerArgv = argv.slice(delimiterIndexes[0] + 1);
    const nvenccPath = optionValueExactlyOnce(
        argv.slice(0, delimiterIndexes[0]), '--nvencc',
        'post-encode NVEncC coordinator argv');
    const sourceToken = optionValueExactlyOnce(
        argv.slice(0, delimiterIndexes[0]), '--source',
        'post-encode NVEncC coordinator argv');
    const outputDepth = optionValueExactlyOnce(
        argv.slice(0, delimiterIndexes[0]), '--output-depth',
        'post-encode NVEncC coordinator argv');
    const producerLog = optionValueExactlyOnce(
        argv.slice(0, delimiterIndexes[0]), '--producer-log',
        'post-encode NVEncC coordinator argv');
    const ffmpegPath = optionValueExactlyOnce(
        argv.slice(0, delimiterIndexes[0]), '--ffmpeg',
        'post-encode NVEncC coordinator argv');
    if (nvenccPath !== pipeline.nvencc_path || sourceToken !== '<SOURCE>' ||
        Number(outputDepth) !== Number(pipeline.output_depth) ||
        producerLog !== '<PRODUCER_LOG>' ||
        argv.filter((value) => value === '<PRODUCER_LOG>').length !== 1 ||
        !consumerArgv.includes('<OUTPUT>')) {
        throw new Error('post-encode checkpoint NVEncC coordinator argv is not bound to its pipeline');
    }
    assertExecutableIdentity(
        contract.consumer_identity, ffmpegPath,
        'post-encode FFmpeg consumer');
    nvenccKnn.assertNoSecondDenoise(
        consumerArgv, 'post-encode checkpoint FFmpeg consumer');

    const syntheticSource = path.resolve(
        path.parse(process.cwd()).root, 'postencode-contract-source-token.mkv');
    const syntheticProducerLog = path.resolve(
        path.parse(process.cwd()).root, 'postencode-contract-producer-token.log');
    const expectedProducerArgv = nvenccKnn.buildProducerArgs({
        sourcePath: syntheticSource,
        outputDepth: Number(pipeline.output_depth),
    }).map((value) => value === syntheticSource ? '<SOURCE>' : String(value));
    if (canonicalJson(pipeline.producer_argv.map(String)) !==
        canonicalJson(expectedProducerArgv)) {
        throw new Error('post-encode checkpoint NVEncC producer argv mismatch');
    }
    const expectedCoordinatorArgv = nvenccKnn.buildCoordinatorArgs({
        nvenccPath: pipeline.nvencc_path,
        sourcePath: syntheticSource,
        outputDepth: Number(pipeline.output_depth),
        producerLog: syntheticProducerLog,
        ffmpegPath,
        ffmpegArgs: consumerArgv,
    }).map((value) => {
        if (value === syntheticSource) return '<SOURCE>';
        if (value === syntheticProducerLog) return '<PRODUCER_LOG>';
        return String(value);
    });
    if (canonicalJson(argv) !== canonicalJson(expectedCoordinatorArgv)) {
        throw new Error('post-encode checkpoint NVEncC coordinator argv mismatch');
    }
}

function assertEncodeContract(contract) {
    if (!contract || ![1, 2].includes(contract.schema) ||
        !Array.isArray(contract.argv) || contract.argv.length === 0 ||
        !String(contract.executable || '').trim()) {
        throw new Error('post-encode checkpoint requires a complete exact encode contract');
    }
    if (contract.schema === 2) assertNvenccPipelineEncodeContract(contract);
    const normalized = canonicalValue(contract);
    const serialized = canonicalJson(normalized);
    if (serialized.indexOf('<OUTPUT>') === -1 || serialized.indexOf('<SOURCE>') === -1) {
        throw new Error('exact encode contract must replace source and output paths with explicit tokens');
    }
    return normalized;
}

function pathWithin(rootPath, childPath) {
    const relative = path.relative(path.resolve(rootPath), path.resolve(childPath));
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function ensureDirectory(directory, mode) {
    const resolved = path.resolve(String(directory || ''));
    if (!resolved || resolved === path.parse(resolved).root) {
        throw new Error(`refusing to initialize unsafe checkpoint directory: ${directory}`);
    }
    let existed = true;
    try { fs.lstatSync(resolved); }
    catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
        existed = false;
    }
    fs.mkdirSync(resolved, { recursive: true, mode });
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`checkpoint path is not a real directory: ${resolved}`);
    }
    try { fs.chmodSync(resolved, mode); } catch (_) {}
    // Persist both the directory inode and the parent entry that names a newly
    // created directory. Linux storage errors are never downgraded to success.
    fsyncDirectory(resolved);
    if (!existed) fsyncDirectory(path.dirname(resolved));
    return resolved;
}

function assertPinnedStorage(checkpointRoot, reuseRequiredRoot) {
    if (path.resolve(String(checkpointRoot || '')) !== path.resolve(PINNED_CHECKPOINT_ROOT)) {
        throw new Error(`production checkpoint root must be exactly ${PINNED_CHECKPOINT_ROOT}`);
    }
    if (path.resolve(String(reuseRequiredRoot || '')) !== path.resolve(PINNED_REUSE_REQUIRED_ROOT)) {
        throw new Error(`production reuse-required root must be exactly ${PINNED_REUSE_REQUIRED_ROOT}`);
    }
}

function reuseRequiredAnchorPath(root) {
    const resolved = path.resolve(String(root || ''));
    if (!resolved || resolved === path.parse(resolved).root) {
        throw reuseRequiredError('reuse-required registry root is empty or unsafe');
    }
    return path.join(path.dirname(resolved), REUSE_REQUIRED_ANCHOR_NAME);
}

function readReuseRootIdentity(filePath, description, expectedContractId, expectedKeys) {
    let value;
    try { value = readManifest(filePath); }
    catch (error) {
        throw reuseRequiredError(`${description} cannot be authenticated: ${error.message}`, error);
    }
    if (!value || value.schema !== 1 || value.contract_id !== expectedContractId ||
        !/^[0-9a-f]{64}$/.test(String(value.generation_id || '')) ||
        !path.isAbsolute(String(value.registry_root || '')) ||
        Object.keys(value).sort().join(',') !== expectedKeys) {
        throw reuseRequiredError(`${description} contract is invalid`);
    }
    return value;
}

function assertReuseRequiredRoot(root) {
    const resolved = path.resolve(String(root || ''));
    if (!resolved || resolved === path.parse(resolved).root) {
        throw reuseRequiredError('reuse-required registry root is empty or unsafe');
    }
    let stat;
    try { stat = fs.lstatSync(resolved); }
    catch (error) {
        throw reuseRequiredError(`reuse-required registry root is unavailable: ${error.message}`, error);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw reuseRequiredError('reuse-required registry root is not a real directory');
    }
    let realRoot;
    try { realRoot = fs.realpathSync(resolved); }
    catch (error) {
        throw reuseRequiredError(`reuse-required registry root cannot be resolved: ${error.message}`, error);
    }
    if (path.resolve(realRoot) !== resolved) {
        throw reuseRequiredError('reuse-required registry root contains a symlinked path component');
    }
    const sentinelPath = path.join(resolved, REUSE_REQUIRED_ROOT_SENTINEL);
    const anchorPath = reuseRequiredAnchorPath(resolved);
    const expectedKeys = 'contract_id,generation_id,registry_root,schema';
    const sentinel = readReuseRootIdentity(
        sentinelPath, 'reuse-required registry sentinel', REUSE_REQUIRED_ROOT_CONTRACT_ID, expectedKeys);
    const anchor = readReuseRootIdentity(
        anchorPath, 'reuse-required registry anchor', REUSE_REQUIRED_ANCHOR_CONTRACT_ID, expectedKeys);
    if (sentinel.schema !== REUSE_REQUIRED_ROOT_SCHEMA ||
        anchor.schema !== REUSE_REQUIRED_ANCHOR_SCHEMA ||
        path.resolve(sentinel.registry_root) !== resolved ||
        path.resolve(anchor.registry_root) !== resolved ||
        sentinel.generation_id !== anchor.generation_id) {
        throw reuseRequiredError('reuse-required registry sentinel and durable anchor identity do not match');
    }
    return resolved;
}

function initializeReuseRequiredRoot(root) {
    const resolved = path.resolve(String(root || ''));
    if (!resolved || resolved === path.parse(resolved).root) {
        throw reuseRequiredError('reuse-required registry root is empty or unsafe');
    }
    const parent = path.dirname(resolved);
    const anchorPath = reuseRequiredAnchorPath(resolved);
    const sentinelPath = path.join(resolved, REUSE_REQUIRED_ROOT_SENTINEL);
    let rootExists = true;
    let anchorExists = true;
    try { fs.lstatSync(resolved); } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
        rootExists = false;
    }
    try { fs.lstatSync(anchorPath); } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
        anchorExists = false;
    }
    if (rootExists !== anchorExists) {
        throw reuseRequiredError(
            'reuse-required registry or durable anchor is missing; refusing automatic reinitialization');
    }
    if (!rootExists) {
        let parentStat;
        try { parentStat = fs.lstatSync(parent); } catch (error) {
            throw reuseRequiredError(`reuse-required registry parent is unavailable: ${error.message}`, error);
        }
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent) {
            throw reuseRequiredError('reuse-required registry parent is not a real persistent directory');
        }
        ensureDirectory(resolved, 0o700);
        const generationId = crypto.randomBytes(32).toString('hex');
        writeJsonExclusive(sentinelPath, {
            schema: REUSE_REQUIRED_ROOT_SCHEMA,
            contract_id: REUSE_REQUIRED_ROOT_CONTRACT_ID,
            generation_id: generationId,
            registry_root: resolved,
        });
        fsyncDirectory(resolved);
        writeJsonExclusive(anchorPath, {
            schema: REUSE_REQUIRED_ANCHOR_SCHEMA,
            contract_id: REUSE_REQUIRED_ANCHOR_CONTRACT_ID,
            generation_id: generationId,
            registry_root: resolved,
        });
        fsyncDirectory(parent);
    }
    return assertReuseRequiredRoot(resolved);
}

function resolveCheckpointRoot(workDir, configuredRoot) {
    const resolvedWorkDir = path.resolve(String(workDir || ''));
    if (!resolvedWorkDir || resolvedWorkDir === path.parse(resolvedWorkDir).root) {
        throw new Error('cannot derive protected checkpoint storage from an empty/root work directory');
    }
    const root = configuredRoot
        ? path.resolve(String(configuredRoot))
        : path.resolve(path.dirname(resolvedWorkDir), DEFAULT_DIRECTORY);
    if (root === resolvedWorkDir || pathWithin(resolvedWorkDir, root)) {
        throw new Error('post-encode checkpoint root must be outside the disposable Tdarr work directory');
    }
    if (root === path.parse(root).root) throw new Error('post-encode checkpoint root cannot be a filesystem root');
    ensureDirectory(root, 0o700);
    return root;
}

function safeStem(sourcePath) {
    let stem = path.basename(String(sourcePath || ''), path.extname(String(sourcePath || '')))
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!stem) stem = 'media';
    return stem.slice(0, 80);
}

function safeExtension(extension) {
    const normalized = String(extension || '.mkv').toLowerCase();
    if (!/^\.[a-z0-9]{1,8}$/.test(normalized)) {
        throw new Error(`unsafe post-encode checkpoint extension: ${extension}`);
    }
    return normalized;
}

function randomToken() {
    return `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function readManifest(manifestPath) {
    let stat;
    try { stat = fs.lstatSync(manifestPath); }
    catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            throw confirmedInvalidError('checkpoint manifest is missing', error);
        }
        throw checkpointError(`checkpoint manifest could not be read: ${error.message}`, RETRYABLE_VALIDATION, error);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_MANIFEST_BYTES) {
        throw confirmedInvalidError('checkpoint manifest is not a bounded regular file');
    }
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (error) {
        if (error instanceof SyntaxError) {
            throw confirmedInvalidError(`checkpoint manifest is invalid JSON: ${error.message}`, error);
        }
        throw checkpointError(`checkpoint manifest could not be read: ${error.message}`, RETRYABLE_VALIDATION, error);
    }
    return manifest;
}

function regularFileStat(filePath, description) {
    let stat;
    try { stat = fs.lstatSync(filePath); }
    catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
            throw confirmedInvalidError(`${description} is missing`, error);
        }
        throw checkpointError(`${description} could not be inspected: ${error.message}`, RETRYABLE_VALIDATION, error);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
        throw confirmedInvalidError(`${description} is not a non-empty regular file`);
    }
    return stat;
}

function fsyncFile(filePath) {
    // Windows requires a writable handle for FlushFileBuffers/fsync.
    const handle = fs.openSync(filePath, 'r+');
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
}

function fsyncDirectory(directory) {
    let handle;
    try {
        handle = fs.openSync(directory, 'r');
        fs.fsyncSync(handle);
    } catch (error) {
        // Windows does not expose a portable directory FlushFileBuffers path.
        // Ignore only the documented family of unsupported-directory errors on
        // Windows; Linux EIO/ENOSPC/permission errors must abort the commit.
        const unsupportedOnWindows = new Set([
            'EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM',
        ]);
        if (process.platform !== 'win32' || !error || !unsupportedOnWindows.has(error.code)) {
            throw error;
        }
    } finally {
        if (handle !== undefined) fs.closeSync(handle);
    }
}

function writeJsonExclusive(filePath, value) {
    const handle = fs.openSync(filePath, 'wx', 0o600);
    try {
        fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
        fs.fsyncSync(handle);
    } finally {
        fs.closeSync(handle);
    }
}

function manifestMatchesPlan(manifest, plan) {
    if (!manifest || manifest.schema !== SCHEMA || manifest.contract_id !== CONTRACT_ID ||
        manifest.checkpoint_key !== plan.checkpointKey ||
        manifest.encode_contract_sha256 !== plan.encodeContractSha256 ||
        canonicalJson(manifest.source_fingerprint) !== canonicalJson(plan.sourceFingerprint) ||
        canonicalJson(manifest.encode_contract) !== canonicalJson(plan.encodeContract)) {
        throw confirmedInvalidError('checkpoint manifest identity does not match the current source and encode contract');
    }
    if (!manifest.artifact || manifest.artifact.relative_path !== plan.artifactName ||
        !Number.isSafeInteger(Number(manifest.artifact.size_bytes)) || Number(manifest.artifact.size_bytes) <= 0 ||
        !/^[0-9a-f]{64}$/.test(String(manifest.artifact.sha256_full || ''))) {
        throw confirmedInvalidError('checkpoint manifest artifact record is incomplete');
    }
}

function validateCommitted(plan, manifestPath, validateArtifact) {
    const manifest = readManifest(manifestPath);
    manifestMatchesPlan(manifest, plan);
    const stat = regularFileStat(plan.artifactPath, 'checkpoint artifact');
    if (stat.size !== Number(manifest.artifact.size_bytes)) {
        throw confirmedInvalidError('checkpoint artifact size does not match its committed manifest');
    }
    const digest = sha256FileSync(plan.artifactPath);
    if (digest !== manifest.artifact.sha256_full) {
        throw confirmedInvalidError('checkpoint artifact SHA-256 does not match its committed manifest');
    }
    // The full artifact digest proves the bits are identical to the committed
    // encode. Re-run the current strict validator, but do not reject a healthy
    // artifact solely because a newer ffprobe formats equivalent telemetry
    // differently from the version that wrote the manifest.
    const mediaValidation = canonicalValue(validateArtifact(plan.artifactPath));
    return { manifest, mediaValidation };
}

function recoverPendingManifest(plan, validateArtifact) {
    if (fs.existsSync(plan.manifestPath) || !fs.existsSync(plan.pendingManifestPath) ||
        !fs.existsSync(plan.artifactPath)) return null;
    const validated = validateCommitted(plan, plan.pendingManifestPath, validateArtifact);
    fs.renameSync(plan.pendingManifestPath, plan.manifestPath);
    fsyncDirectory(plan.entryDir);
    return validated;
}

function buildPlan(options) {
    options = options || {};
    if (typeof options.validateArtifact !== 'function') {
        throw new Error('post-encode checkpoint requires a strict media validator');
    }
    const sourceFingerprint = assertFingerprint(options.sourceFingerprint);
    const encodeContract = assertEncodeContract(options.encodeContract);
    const encodeContractSha256 = sha256Text(canonicalJson(encodeContract));
    const checkpointKey = sha256Text(canonicalJson({
        contract_id: CONTRACT_ID,
        source_fingerprint: sourceFingerprint,
        encode_contract_sha256: encodeContractSha256,
    }));
    const checkpointRoot = resolveCheckpointRoot(options.workDir, options.checkpointRoot);
    const reuseRequiredRoot = options.reuseRequiredRoot
        ? path.resolve(String(options.reuseRequiredRoot))
        : path.join(checkpointRoot, REUSE_REQUIRED_DIRECTORY);
    const resolvedWorkDir = path.resolve(String(options.workDir || ''));
    if (!reuseRequiredRoot || reuseRequiredRoot === path.parse(reuseRequiredRoot).root ||
        reuseRequiredRoot === resolvedWorkDir || pathWithin(resolvedWorkDir, reuseRequiredRoot)) {
        throw new Error('reuse-required registry root must be absolute, non-root, and outside disposable work storage');
    }
    if (options.enforcePinnedStorage === true) {
        assertPinnedStorage(checkpointRoot, reuseRequiredRoot);
    }
    if (options.requireInitializedReuseRequiredRoot === true) {
        assertReuseRequiredRoot(reuseRequiredRoot);
    }
    const bucketDir = path.join(checkpointRoot, checkpointKey.slice(0, 2));
    const entryDir = path.join(bucketDir, checkpointKey);
    ensureDirectory(bucketDir, 0o700);
    ensureDirectory(entryDir, 0o700);
    if (!pathWithin(checkpointRoot, entryDir)) throw new Error('derived checkpoint entry escaped its protected root');

    const extension = safeExtension(options.extension);
    const artifactName = `${safeStem(sourceFingerprint.resolved_path)}.postencode${extension}`;
    const candidateName = `${safeStem(sourceFingerprint.resolved_path)}.postencode-candidate${extension}`;
    const token = randomToken();
    const plan = {
        schema: SCHEMA,
        contractId: CONTRACT_ID,
        checkpointRoot,
        reuseRequiredRoot,
        requireInitializedReuseRequiredRoot: options.requireInitializedReuseRequiredRoot === true,
        checkpointKey,
        entryDir,
        artifactName,
        artifactPath: path.join(entryDir, artifactName),
        manifestPath: path.join(entryDir, MANIFEST_NAME),
        pendingManifestPath: path.join(entryDir, 'manifest.pending.json'),
        candidateName,
        candidatePath: path.join(entryDir, candidateName),
        candidateManifestPath: path.join(entryDir, CANDIDATE_MANIFEST_NAME),
        candidatePendingManifestPath: path.join(entryDir, CANDIDATE_PENDING_MANIFEST_NAME),
        encodePath: path.join(entryDir, `.encode-partial-${token}${extension}`),
        sourceFingerprint,
        encodeContract,
        encodeContractSha256,
        reused: false,
        invalidReason: null,
        validationBlocked: false,
        validationBlockedReason: null,
        pendingCandidate: false,
        candidateStaged: false,
        manifest: null,
    };

    try {
        let validated = null;
        if (fs.existsSync(plan.manifestPath)) {
            validated = validateCommitted(plan, plan.manifestPath, options.validateArtifact);
        } else {
            validated = recoverPendingManifest(plan, options.validateArtifact);
        }
        if (validated) {
            plan.reused = true;
            plan.manifest = validated.manifest;
            return plan;
        }
    } catch (error) {
        if (!isConfirmedInvalidError(error)) {
            plan.validationBlocked = true;
            plan.validationBlockedReason = error.message;
            return plan;
        }
        plan.invalidReason = error.message;
        quarantineCommitted(plan);
    }

    const hasCandidate = fs.existsSync(plan.candidateManifestPath) ||
        fs.existsSync(plan.candidatePendingManifestPath) || fs.existsSync(plan.candidatePath);
    if (hasCandidate) {
        try {
            const candidate = recoverCandidate(plan);
            const validated = validateCandidate(plan, candidate, options.validateArtifact);
            publishCandidate(plan, candidate, validated, true);
            return plan;
        } catch (error) {
            if (isConfirmedInvalidError(error)) {
                plan.invalidReason = error.message;
                quarantineCandidate(plan);
            } else {
                const retryable = normalizeRetryableError(error);
                plan.pendingCandidate = true;
                plan.validationBlocked = true;
                plan.validationBlockedReason = retryable.message;
            }
        }
    }
    return plan;
}

function moveAside(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const quarantined = `${filePath}.invalid-${randomToken()}`;
    fs.renameSync(filePath, quarantined);
    return quarantined;
}

function normalizeRetryableError(error) {
    if (isRetryableValidationError(error)) return error;
    return checkpointError(error && error.message ? error.message : String(error), RETRYABLE_VALIDATION, error);
}

function quarantineFiles(filePaths) {
    const quarantined = [];
    for (const filePath of filePaths) {
        if (fs.existsSync(filePath)) quarantined.push(moveAside(filePath));
    }
    return quarantined;
}

function quarantineCommitted(plan) {
    return quarantineFiles([plan.manifestPath, plan.pendingManifestPath, plan.artifactPath]);
}

function quarantineCandidate(plan) {
    plan.pendingCandidate = false;
    plan.candidateStaged = false;
    return quarantineFiles([
        plan.candidateManifestPath,
        plan.candidatePendingManifestPath,
        plan.candidatePath,
    ]);
}

function candidateManifestMatchesPlan(manifest, plan) {
    const hashPending = manifest && manifest.state === 'ffmpeg_exit_0_hash_pending';
    if (!manifest || manifest.schema !== SCHEMA || manifest.contract_id !== CONTRACT_ID ||
        (!hashPending && manifest.state !== 'ffmpeg_exit_0_pending_validation') ||
        manifest.checkpoint_key !== plan.checkpointKey ||
        manifest.encode_contract_sha256 !== plan.encodeContractSha256 ||
        canonicalJson(manifest.source_fingerprint) !== canonicalJson(plan.sourceFingerprint) ||
        canonicalJson(manifest.encode_contract) !== canonicalJson(plan.encodeContract)) {
        throw confirmedInvalidError('pending checkpoint candidate identity does not match the current source and encode contract');
    }
    const stagedName = String(manifest.artifact && manifest.artifact.staged_relative_path || '');
    if (!manifest.artifact || manifest.artifact.relative_path !== plan.candidateName ||
        !/^\.encode-partial-[A-Za-z0-9.-]+$/.test(stagedName) || path.basename(stagedName) !== stagedName ||
        !Number.isSafeInteger(Number(manifest.artifact.size_bytes)) || Number(manifest.artifact.size_bytes) <= 0 ||
        (!hashPending && !/^[0-9a-f]{64}$/.test(String(manifest.artifact.sha256_full || '')))) {
        throw confirmedInvalidError('pending checkpoint candidate artifact record is incomplete');
    }
    return { hashPending };
}

function recoverCandidate(plan) {
    let manifestPath = null;
    if (fs.existsSync(plan.candidateManifestPath)) manifestPath = plan.candidateManifestPath;
    else if (fs.existsSync(plan.candidatePendingManifestPath)) manifestPath = plan.candidatePendingManifestPath;
    if (!manifestPath) {
        throw confirmedInvalidError('pending checkpoint candidate lacks its authenticated identity manifest');
    }
    const manifest = readManifest(manifestPath);
    const state = candidateManifestMatchesPlan(manifest, plan);
    const stagedPath = path.join(plan.entryDir, manifest.artifact.staged_relative_path);
    if (!pathWithin(plan.entryDir, stagedPath)) {
        throw confirmedInvalidError('pending checkpoint candidate staging path escaped its protected entry');
    }
    const readablePath = fs.existsSync(plan.candidatePath) ? plan.candidatePath : stagedPath;
    const stagedStat = regularFileStat(readablePath, 'staged checkpoint candidate');
    if (stagedStat.size !== Number(manifest.artifact.size_bytes)) {
        throw confirmedInvalidError('staged checkpoint candidate size does not match its authenticated identity');
    }
    const digest = sha256FileSync(readablePath);
    let readyManifest = manifest;
    if (state.hashPending) {
        readyManifest = Object.assign({}, manifest, {
            state: 'ffmpeg_exit_0_pending_validation',
            artifact: Object.assign({}, manifest.artifact, { sha256_full: digest }),
            hashed_at: new Date().toISOString(),
        });
        if (fs.existsSync(plan.candidateManifestPath)) moveAside(plan.candidateManifestPath);
        writeJsonExclusive(plan.candidateManifestPath, readyManifest);
        fsyncDirectory(plan.entryDir);
    } else if (digest !== manifest.artifact.sha256_full) {
        throw confirmedInvalidError('staged checkpoint candidate does not match its authenticated manifest');
    }
    if (!fs.existsSync(plan.candidatePath)) {
        fs.renameSync(stagedPath, plan.candidatePath);
        fsyncDirectory(plan.entryDir);
    }
    const stat = regularFileStat(plan.candidatePath, 'pending checkpoint candidate');
    if (stat.size !== Number(readyManifest.artifact.size_bytes)) {
        throw confirmedInvalidError('pending checkpoint candidate size does not match its authenticated manifest');
    }
    if (digest !== readyManifest.artifact.sha256_full) {
        throw confirmedInvalidError('pending checkpoint candidate SHA-256 does not match its authenticated manifest');
    }
    if (!fs.existsSync(plan.candidateManifestPath)) {
        writeJsonExclusive(plan.candidateManifestPath, readyManifest);
        fsyncDirectory(plan.entryDir);
    }
    if (fs.existsSync(plan.candidatePendingManifestPath)) {
        fs.unlinkSync(plan.candidatePendingManifestPath);
        fsyncDirectory(plan.entryDir);
    }
    plan.pendingCandidate = true;
    plan.candidateStaged = true;
    return readyManifest;
}

function recordExitZeroCandidate(plan) {
    if (!plan || plan.schema !== SCHEMA || plan.reused) return plan;
    const resolvedEncode = path.resolve(plan.encodePath);
    if (!pathWithin(plan.entryDir, resolvedEncode)) {
        throw confirmedInvalidError('checkpoint encoder output escaped its protected entry');
    }
    const stat = regularFileStat(resolvedEncode, 'completed encoder output');
    fsyncFile(resolvedEncode);
    const manifest = {
        schema: SCHEMA,
        contract_id: CONTRACT_ID,
        state: 'ffmpeg_exit_0_hash_pending',
        checkpoint_key: plan.checkpointKey,
        source_fingerprint: plan.sourceFingerprint,
        encode_contract_sha256: plan.encodeContractSha256,
        encode_contract: plan.encodeContract,
        artifact: {
            relative_path: plan.candidateName,
            staged_relative_path: path.basename(resolvedEncode),
            size_bytes: stat.size,
        },
        staged_at: new Date().toISOString(),
    };

    quarantineFiles([
        plan.candidateManifestPath,
        plan.candidatePendingManifestPath,
        plan.candidatePath,
    ]);
    writeJsonExclusive(plan.candidatePendingManifestPath, manifest);
    fsyncDirectory(plan.entryDir);
    plan.pendingCandidate = true;
    plan.candidateStaged = true;
    return manifest;
}

function stageCandidate(plan) {
    const pendingManifest = recordExitZeroCandidate(plan);
    const resolvedEncode = path.resolve(plan.encodePath);
    const digest = sha256FileSync(resolvedEncode);
    const manifest = Object.assign({}, pendingManifest, {
        state: 'ffmpeg_exit_0_pending_validation',
        artifact: Object.assign({}, pendingManifest.artifact, { sha256_full: digest }),
        hashed_at: new Date().toISOString(),
    });
    writeJsonExclusive(plan.candidateManifestPath, manifest);
    fsyncDirectory(plan.entryDir);
    fs.renameSync(resolvedEncode, plan.candidatePath);
    fsyncDirectory(plan.entryDir);
    fs.unlinkSync(plan.candidatePendingManifestPath);
    fsyncDirectory(plan.entryDir);
    return manifest;
}

function validateCandidate(plan, candidateManifest, validateArtifact) {
    candidateManifestMatchesPlan(candidateManifest, plan);
    const mediaValidation = canonicalValue(validateArtifact(plan.candidatePath));
    return { mediaValidation };
}

function publishCandidate(plan, candidateManifest, validated, recovered) {
    const manifest = {
        schema: SCHEMA,
        contract_id: CONTRACT_ID,
        checkpoint_key: plan.checkpointKey,
        source_fingerprint: plan.sourceFingerprint,
        encode_contract_sha256: plan.encodeContractSha256,
        encode_contract: plan.encodeContract,
        artifact: {
            relative_path: plan.artifactName,
            size_bytes: Number(candidateManifest.artifact.size_bytes),
            sha256_full: candidateManifest.artifact.sha256_full,
        },
        media_validation: validated.mediaValidation,
        committed_at: new Date().toISOString(),
    };

    if (fs.existsSync(plan.pendingManifestPath)) moveAside(plan.pendingManifestPath);
    writeJsonExclusive(plan.pendingManifestPath, manifest);
    if (fs.existsSync(plan.manifestPath)) moveAside(plan.manifestPath);
    if (fs.existsSync(plan.artifactPath)) moveAside(plan.artifactPath);
    fs.renameSync(plan.candidatePath, plan.artifactPath);
    fsyncDirectory(plan.entryDir);
    fs.renameSync(plan.pendingManifestPath, plan.manifestPath);
    fsyncDirectory(plan.entryDir);
    try { fs.unlinkSync(plan.candidateManifestPath); } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
    }

    plan.reused = recovered === true;
    plan.invalidReason = null;
    plan.validationBlocked = false;
    plan.validationBlockedReason = null;
    plan.pendingCandidate = false;
    plan.candidateStaged = false;
    plan.manifest = manifest;
    return plan;
}

function commit(plan, validateArtifact) {
    if (!plan || plan.schema !== SCHEMA || typeof validateArtifact !== 'function') {
        throw new Error('invalid checkpoint commit request');
    }
    if (plan.reused) return plan;
    let candidateManifest;
    try {
        candidateManifest = plan.pendingCandidate ? recoverCandidate(plan) : stageCandidate(plan);
        const validated = validateCandidate(plan, candidateManifest, validateArtifact);
        return publishCandidate(plan, candidateManifest, validated, false);
    } catch (error) {
        if (isConfirmedInvalidError(error)) {
            plan.invalidReason = error.message;
            quarantineCandidate(plan);
            throw error;
        }
        const retryable = normalizeRetryableError(error);
        plan.pendingCandidate = true;
        plan.validationBlocked = true;
        plan.validationBlockedReason = retryable.message;
        throw retryable;
    }
}

function validateReuseRequiredMarker(marker, plan, markerLocation) {
    if (!marker || marker.schema !== REUSE_REQUIRED_SCHEMA ||
        marker.contract_id !== REUSE_REQUIRED_CONTRACT_ID ||
        marker.state !== 'reuse_required' ||
        marker.source_scope_key !== markerLocation.key ||
        canonicalJson(marker.source_fingerprint) !== canonicalJson(plan.sourceFingerprint)) {
        throw reuseRequiredError('reuse-required marker source identity is invalid');
    }
    if (marker.checkpoint_key !== plan.checkpointKey ||
        marker.encode_contract_sha256 !== plan.encodeContractSha256) {
        throw reuseRequiredError(
            'reuse-required marker expected a different exact encode contract; refusing to launch FFmpeg');
    }
    if (!marker.source ||
        !/^[0-9a-f]{64}$/.test(String(marker.source.sha256_full || ''))) {
        throw reuseRequiredError('reuse-required marker full source identity is incomplete');
    }
    if (!marker.artifact ||
        !Number.isSafeInteger(Number(marker.artifact.size_bytes)) ||
        Number(marker.artifact.size_bytes) <= 0 ||
        !/^[0-9a-f]{64}$/.test(String(marker.artifact.sha256_full || ''))) {
        throw reuseRequiredError('reuse-required marker artifact identity is incomplete');
    }
    return marker;
}

function lstatReuseMarkerOptional(markerPath) {
    let stat;
    try { stat = fs.lstatSync(markerPath); }
    catch (error) {
        // Only a genuinely absent marker means this source is not latched.
        // ENOTDIR, EACCES, EIO, and all other storage errors are fail-closed.
        if (error && error.code === 'ENOENT') return null;
        throw reuseRequiredError(`reuse-required marker cannot be inspected: ${error.message}`, error);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_MANIFEST_BYTES) {
        throw reuseRequiredError('reuse-required marker is not a bounded regular file');
    }
    return stat;
}

function readReuseRequiredMarker(plan) {
    if (!plan || plan.schema !== SCHEMA || !plan.reuseRequiredRoot || !plan.sourceFingerprint) {
        throw new Error('invalid reuse-required marker lookup plan');
    }
    if (plan.requireInitializedReuseRequiredRoot === true) {
        assertReuseRequiredRoot(plan.reuseRequiredRoot);
    }
    const location = reuseRequiredLocation(plan.reuseRequiredRoot, plan.sourceFingerprint);
    if (!lstatReuseMarkerOptional(location.markerPath)) return { required: false, location };
    let marker;
    try {
        marker = readManifest(location.markerPath);
    } catch (error) {
        throw reuseRequiredError(`reuse-required marker cannot be authenticated: ${error.message}`, error);
    }
    validateReuseRequiredMarker(marker, plan, location);
    return { required: true, location, marker };
}

function armReuseRequired(plan, artifactIdentity, sourceIdentity) {
    if (!plan || plan.schema !== SCHEMA || !plan.reuseRequiredRoot || !plan.sourceFingerprint ||
        !/^[0-9a-f]{64}$/.test(String(plan.checkpointKey || '')) ||
        !/^[0-9a-f]{64}$/.test(String(plan.encodeContractSha256 || '')) ||
        !sourceIdentity || !/^[0-9a-f]{64}$/.test(String(sourceIdentity.sha256_full || '')) ||
        !artifactIdentity || !Number.isSafeInteger(Number(artifactIdentity.size_bytes)) ||
        Number(artifactIdentity.size_bytes) <= 0 ||
        !/^[0-9a-f]{64}$/.test(String(artifactIdentity.sha256_full || ''))) {
        throw new Error('invalid reuse-required marker arming request');
    }
    const location = reuseRequiredLocation(plan.reuseRequiredRoot, plan.sourceFingerprint);
    if (plan.requireInitializedReuseRequiredRoot === true) {
        assertReuseRequiredRoot(location.markerRoot);
    } else {
        ensureDirectory(location.markerRoot, 0o700);
    }
    ensureDirectory(location.bucketDir, 0o700);
    const marker = {
        schema: REUSE_REQUIRED_SCHEMA,
        contract_id: REUSE_REQUIRED_CONTRACT_ID,
        state: 'reuse_required',
        source_scope_key: location.key,
        source_fingerprint: plan.sourceFingerprint,
        checkpoint_key: plan.checkpointKey,
        encode_contract_sha256: plan.encodeContractSha256,
        source: {
            sha256_full: String(sourceIdentity.sha256_full),
        },
        artifact: {
            size_bytes: Number(artifactIdentity.size_bytes),
            sha256_full: String(artifactIdentity.sha256_full),
        },
        created_by: 'retained-output-import-v1',
        created_at: new Date().toISOString(),
    };
    if (lstatReuseMarkerOptional(location.markerPath)) {
        const existing = readReuseRequiredMarker(plan);
        if (existing.marker.source.sha256_full !== marker.source.sha256_full ||
            Number(existing.marker.artifact.size_bytes) !== marker.artifact.size_bytes ||
            existing.marker.artifact.sha256_full !== marker.artifact.sha256_full) {
            throw reuseRequiredError(
                'an existing reuse-required marker protects different committed artifact bytes');
        }
        return { created: false, markerPath: location.markerPath, marker: existing.marker };
    }
    writeJsonExclusive(location.markerPath, marker);
    fsyncDirectory(location.bucketDir);
    return { created: true, markerPath: location.markerPath, marker };
}

function createReuseRequired(plan, sourceIdentity) {
    if (!plan || plan.schema !== SCHEMA || !plan.reused || !plan.manifest) {
        throw new Error('reuse-required marker can only protect a committed checkpoint');
    }
    manifestMatchesPlan(plan.manifest, plan);
    return armReuseRequired(plan, plan.manifest.artifact, sourceIdentity);
}

function authenticateFullSource(plan, expectedSha256) {
    if (!/^[0-9a-f]{64}$/.test(String(expectedSha256 || ''))) {
        throw reuseRequiredError('reuse-required full source SHA-256 is invalid');
    }
    let sourcePath;
    let before;
    try {
        sourcePath = fs.realpathSync(path.resolve(String(plan.sourceFingerprint.resolved_path || '')));
        before = fs.statSync(sourcePath, { bigint: true });
    } catch (error) {
        throw reuseRequiredError(`reuse-required source cannot be inspected: ${error.message}`, error);
    }
    if (!before.isFile() || before.size <= 0n ||
        sourcePath !== path.resolve(String(plan.sourceFingerprint.resolved_path || '')) ||
        before.size !== BigInt(plan.sourceFingerprint.size_bytes)) {
        throw reuseRequiredError('reuse-required source path or size no longer matches the imported source');
    }
    let digest;
    try { digest = sha256FileSync(sourcePath); }
    catch (error) {
        throw reuseRequiredError(`reuse-required source full SHA-256 failed: ${error.message}`, error);
    }
    let after;
    try { after = fs.statSync(sourcePath, { bigint: true }); }
    catch (error) {
        throw reuseRequiredError(`reuse-required source changed during full authentication: ${error.message}`, error);
    }
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
        throw reuseRequiredError('reuse-required source changed during full SHA-256 authentication');
    }
    if (digest !== expectedSha256) {
        throw reuseRequiredError('reuse-required source full SHA-256 does not match the imported source');
    }
    return { sha256_full: digest };
}

function enforceReuseRequired(plan) {
    const required = readReuseRequiredMarker(plan);
    if (!required.required) return required;
    if (!plan.reused || !plan.manifest) {
        throw reuseRequiredError(
            'this source is latched to an imported checkpoint, but the expected committed checkpoint was not reused; refusing to launch FFmpeg');
    }
    const artifact = plan.manifest.artifact || {};
    if (Number(artifact.size_bytes) !== Number(required.marker.artifact.size_bytes) ||
        String(artifact.sha256_full || '') !== required.marker.artifact.sha256_full) {
        throw reuseRequiredError(
            'the reused checkpoint bytes do not match the reuse-required marker; refusing to launch FFmpeg');
    }
    authenticateFullSource(plan, required.marker.source.sha256_full);
    plan.reuseRequired = {
        markerPath: required.location.markerPath,
        sourceScopeKey: required.location.key,
        satisfied: true,
    };
    return { required: true, satisfied: true, location: required.location, marker: required.marker };
}

function assertExpectedImportIdentity(plan, options) {
    options = options || {};
    if (!/^[0-9a-f]{64}$/.test(String(options.expectedCheckpointKey || '')) ||
        options.expectedCheckpointKey !== plan.checkpointKey) {
        throw new Error('retained import checkpoint key does not match the independently expected plan');
    }
    if (!/^[0-9a-f]{64}$/.test(String(options.expectedEncodeContractSha256 || '')) ||
        options.expectedEncodeContractSha256 !== plan.encodeContractSha256) {
        throw new Error('retained import encode contract does not match the independently expected plan');
    }
    if (!options.expectedSourceFingerprint ||
        canonicalJson(assertFingerprint(options.expectedSourceFingerprint)) !==
            canonicalJson(plan.sourceFingerprint)) {
        throw new Error('retained import source fingerprint does not match the independently expected source');
    }
    if (!/^[0-9a-f]{64}$/.test(String(options.expectedSourceSha256Full || ''))) {
        throw new Error('retained import requires an independently expected full source SHA-256');
    }
    if (!/^[0-9a-f]{64}$/.test(String(options.expectedRetainedSha256 || '')) ||
        !Number.isSafeInteger(Number(options.expectedRetainedSizeBytes)) ||
        Number(options.expectedRetainedSizeBytes) <= 0) {
        throw new Error('retained import requires an expected full SHA-256 and exact byte size');
    }
}

function importRetained(plan, retainedPath, validateArtifact, options) {
    if (!plan || plan.schema !== SCHEMA || typeof validateArtifact !== 'function') {
        throw new Error('invalid retained checkpoint import request');
    }
    assertExpectedImportIdentity(plan, options);
    const sourceIdentity = authenticateFullSource(plan, options.expectedSourceSha256Full);
    const retained = fs.realpathSync(path.resolve(String(retainedPath || '')));
    const retainedStat = regularFileStat(retained, 'retained encoder output');
    const realCheckpointRoot = fs.realpathSync(plan.checkpointRoot);
    if (pathWithin(realCheckpointRoot, retained) || retained === realCheckpointRoot) {
        throw new Error('retained encoder output must be outside protected checkpoint storage');
    }
    if (retainedStat.size !== Number(options.expectedRetainedSizeBytes)) {
        throw new Error('retained encoder output size does not match the independently expected size');
    }
    const retainedDigest = sha256FileSync(retained);
    if (retainedDigest !== options.expectedRetainedSha256) {
        throw new Error('retained encoder output SHA-256 does not match the independently expected digest');
    }

    if (plan.reused) {
        if (Number(plan.manifest.artifact.size_bytes) !== retainedStat.size ||
            plan.manifest.artifact.sha256_full !== retainedDigest) {
            throw new Error('existing committed checkpoint does not match the retained encoder output');
        }
        const latch = createReuseRequired(plan, sourceIdentity);
        return { alreadyCommitted: true, stagingMethod: null, latch, plan };
    }
    // Arm the source-scoped latch before the first checkpoint-entry write. A
    // process crash, disk error, or validator failure can therefore never leave
    // an unlatched recovery window in which Tdarr is allowed to encode.
    const latch = armReuseRequired(plan, {
        size_bytes: retainedStat.size,
        sha256_full: retainedDigest,
    }, sourceIdentity);
    if (plan.validationBlocked || plan.pendingCandidate || plan.invalidReason ||
        fs.existsSync(plan.manifestPath) || fs.existsSync(plan.pendingManifestPath) ||
        fs.existsSync(plan.candidateManifestPath) || fs.existsSync(plan.candidatePendingManifestPath) ||
        fs.existsSync(plan.candidatePath) || fs.existsSync(plan.artifactPath) ||
        fs.existsSync(plan.encodePath) || fs.readdirSync(plan.entryDir).length !== 0) {
        throw new Error('retained import requires a fresh exact checkpoint entry with no prior generation');
    }

    let stagingMethod = 'copy';
    try {
        fs.copyFileSync(retained, plan.encodePath,
            fs.constants.COPYFILE_EXCL | (fs.constants.COPYFILE_FICLONE || 0));
        if (fs.constants.COPYFILE_FICLONE) stagingMethod = 'copy-on-write-or-copy';
        const stagedStat = regularFileStat(plan.encodePath, 'staged retained encoder output');
        if (stagedStat.size !== retainedStat.size || sha256FileSync(plan.encodePath) !== retainedDigest) {
            throw new Error('staged retained encoder output failed exact byte authentication');
        }
        fsyncFile(plan.encodePath);
        commit(plan, validateArtifact);
        // commit() labels a newly published generation as non-reused because it
        // normally follows an encoder invocation. Imported bytes must be exposed
        // to the next controlled job as an existing reusable checkpoint.
        plan.reused = true;
        return { alreadyCommitted: false, stagingMethod, latch, plan };
    } catch (error) {
        try {
            if (!plan.pendingCandidate && !plan.candidateStaged) fs.unlinkSync(plan.encodePath);
        } catch (_) {}
        throw error;
    }
}

function abandon(plan) {
    if (!plan || !plan.encodePath) return;
    // Once the exit-0 artifact has an authenticated pending manifest it is a
    // durable recovery candidate, not disposable encoder scratch.
    if (plan.pendingCandidate || plan.candidateStaged ||
        fs.existsSync(plan.candidateManifestPath || '') ||
        fs.existsSync(plan.candidatePendingManifestPath || '')) return;
    try { fs.unlinkSync(plan.encodePath); } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
    }
}

function materialize(plan, destination, allowedRoot) {
    if (!plan || !plan.manifest) throw new Error('cannot materialize an uncommitted checkpoint');
    const source = path.resolve(plan.artifactPath);
    const target = path.resolve(String(destination || ''));
    const root = path.resolve(String(allowedRoot || ''));
    if (!pathWithin(root, target) || target === source) {
        throw new Error('checkpoint materialization destination is not a distinct job-owned path');
    }
    const sourceStat = regularFileStat(source, 'committed checkpoint artifact');
    const partial = `${target}.checkpoint-partial-${randomToken()}`;
    try {
        fs.copyFileSync(source, partial, fs.constants.COPYFILE_FICLONE);
        const copied = regularFileStat(partial, 'materialized checkpoint artifact');
        if (copied.size !== sourceStat.size) throw new Error('checkpoint materialization size mismatch');
        fsyncFile(partial);
        try { fs.unlinkSync(target); } catch (error) {
            if (!error || error.code !== 'ENOENT') throw error;
        }
        fs.renameSync(partial, target);
        fsyncDirectory(path.dirname(target));
    } catch (error) {
        try { fs.unlinkSync(partial); } catch (_) {}
        throw error;
    }
    return target;
}

function retirementLocation(record) {
    if (!record || record.schema !== SCHEMA || record.contract_id !== CONTRACT_ID ||
        !/^[0-9a-f]{64}$/.test(String(record.checkpoint_key || ''))) {
        throw new Error('invalid post-encode checkpoint record');
    }
    if (!path.isAbsolute(String(record.manifest_path || '')) ||
        !path.isAbsolute(String(record.artifact_path || ''))) {
        throw new Error('checkpoint record paths must be absolute');
    }
    const manifestPath = path.resolve(String(record.manifest_path || ''));
    const artifactPath = path.resolve(String(record.artifact_path || ''));
    const entryDir = path.dirname(manifestPath);
    const bucketDir = path.dirname(entryDir);
    const root = path.dirname(bucketDir);
    const key = String(record.checkpoint_key);
    if (path.basename(manifestPath) !== MANIFEST_NAME || path.dirname(artifactPath) !== entryDir ||
        path.basename(entryDir) !== key || path.basename(bucketDir) !== key.slice(0, 2) ||
        root === path.parse(root).root || !pathWithin(root, entryDir)) {
        throw new Error('checkpoint record is outside its keyed protected entry');
    }
    const entryStat = fs.lstatSync(entryDir);
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink() ||
        path.resolve(fs.realpathSync(entryDir)) !== entryDir) {
        throw new Error(
            'checkpoint record entry is not a canonical real directory');
    }
    const explicitReuseRequiredRoot = String(record.reuse_required_root || '');
    const reuseRequiredRoot = explicitReuseRequiredRoot
        ? path.resolve(explicitReuseRequiredRoot)
        : path.join(root, REUSE_REQUIRED_DIRECTORY);
    if (!reuseRequiredRoot || reuseRequiredRoot === path.parse(reuseRequiredRoot).root) {
        throw new Error('checkpoint record has an unsafe reuse-required root');
    }
    return {
        key,
        manifestPath,
        artifactPath,
        entryDir,
        bucketDir,
        root,
        reuseRequiredRoot,
        requireInitializedReuseRequiredRoot:
            Boolean(explicitReuseRequiredRoot),
    };
}

function authenticateRecord(record) {
    const located = retirementLocation(record);
    const key = located.key;
    const manifestPath = located.manifestPath;
    const artifactPath = located.artifactPath;
    const entryDir = located.entryDir;
    const bucketDir = located.bucketDir;
    const root = located.root;
    const reuseRequiredRoot = located.reuseRequiredRoot;
    const manifest = readManifest(manifestPath);
    if (manifest.schema !== SCHEMA || manifest.contract_id !== CONTRACT_ID ||
        manifest.checkpoint_key !== key || !manifest.artifact ||
        path.basename(artifactPath) !== manifest.artifact.relative_path) {
        throw new Error('checkpoint record has mismatched committed identity');
    }
    const retirementPlan = {
        schema: SCHEMA,
        checkpointRoot: root,
        reuseRequiredRoot,
        requireInitializedReuseRequiredRoot:
            located.requireInitializedReuseRequiredRoot,
        checkpointKey: key,
        sourceFingerprint: manifest.source_fingerprint,
        encodeContractSha256: manifest.encode_contract_sha256,
    };
    const reuseMarker = readReuseRequiredMarker(retirementPlan);
    if (reuseMarker.required &&
        (Number(reuseMarker.marker.artifact.size_bytes) !== Number(manifest.artifact.size_bytes) ||
        reuseMarker.marker.artifact.sha256_full !== manifest.artifact.sha256_full)) {
        throw new Error('checkpoint reuse-required marker protects different bytes');
    }
    const artifactStat = regularFileStat(artifactPath, 'checkpoint retirement artifact');
    if (artifactStat.size !== Number(manifest.artifact.size_bytes) ||
        sha256FileSync(artifactPath) !== manifest.artifact.sha256_full) {
        throw new Error('checkpoint bytes do not match the committed manifest');
    }
    return {
        key,
        manifestPath,
        artifactPath,
        entryDir,
        bucketDir,
        root,
        manifest,
        reuseRequiredRoot,
        retirementPlan,
        reuseMarker,
        artifact: {
            size_bytes: artifactStat.size,
            sha256_full: manifest.artifact.sha256_full,
        },
    };
}

function retirementFileProof(root, filePath, relativeName, description) {
    if (!relativeName || path.isAbsolute(relativeName) ||
        path.normalize(relativeName) !== relativeName ||
        relativeName === '..' ||
        relativeName.startsWith(`..${path.sep}`)) {
        throw new Error(`${description} relative name is unsafe`);
    }
    const resolved = path.resolve(root, relativeName);
    if (!pathWithin(root, resolved)) {
        throw new Error(`${description} escaped its protected root`);
    }
    const stat = regularFileStat(resolved, description);
    if (path.resolve(fs.realpathSync(resolved)) !== resolved) {
        throw new Error(`${description} contains a symlinked path component`);
    }
    return {
        relative_name: relativeName,
        size_bytes: stat.size,
        sha256_full: sha256FileSync(resolved),
    };
}

function retirementInventory(authenticated) {
    if (!authenticated || !authenticated.manifest ||
        !authenticated.reuseMarker) {
        throw new Error(
            'checkpoint retirement inventory requires authenticated bytes');
    }
    const sideFiles = [];
    const fixed = new Set(RETIREMENT_FIXED_SIDE_FILES);
    for (const name of fs.readdirSync(authenticated.entryDir).sort()) {
        if (path.basename(name) !== name ||
            (!fixed.has(name) && !RETIREMENT_QUARANTINE_SUFFIX.test(name))) {
            continue;
        }
        sideFiles.push(retirementFileProof(
            authenticated.entryDir,
            path.join(authenticated.entryDir, name),
            name,
            `checkpoint retirement side file ${name}`));
    }
    let reuseMarker = null;
    if (authenticated.reuseMarker.required) {
        const markerLocation = authenticated.reuseMarker.location;
        const relativeName = path.relative(
            markerLocation.markerRoot, markerLocation.markerPath);
        reuseMarker = Object.assign({
            marker_root: markerLocation.markerRoot,
        }, retirementFileProof(
            markerLocation.markerRoot,
            markerLocation.markerPath,
            relativeName,
            'checkpoint retirement reuse marker'));
    }
    const inventory = {
        schema: RETIREMENT_INVENTORY_SCHEMA,
        version: RETIREMENT_INVENTORY_VERSION,
        checkpoint_key: authenticated.key,
        artifact: retirementFileProof(
            authenticated.entryDir,
            authenticated.artifactPath,
            path.basename(authenticated.artifactPath),
            'checkpoint retirement artifact'),
        manifest: retirementFileProof(
            authenticated.entryDir,
            authenticated.manifestPath,
            MANIFEST_NAME,
            'checkpoint retirement manifest'),
        side_files: sideFiles,
        reuse_marker: reuseMarker,
    };
    validateRetirementInventory(
        authenticated, inventory, { requireAllFiles: true });
    return inventory;
}

function assertRetirementProof(proof, label) {
    if (!exactObjectFields(proof,
        ['relative_name', 'size_bytes', 'sha256_full'], [])) {
        throw new Error(`${label} has unsupported fields`);
    }
    const relativeName = String(proof.relative_name || '');
    if (!relativeName || path.isAbsolute(relativeName) ||
        path.normalize(relativeName) !== relativeName ||
        relativeName === '..' ||
        relativeName.startsWith(`..${path.sep}`) ||
        !Number.isSafeInteger(Number(proof.size_bytes)) ||
        Number(proof.size_bytes) <= 0 ||
        !/^[0-9a-f]{64}$/.test(String(proof.sha256_full || ''))) {
        throw new Error(`${label} identity is invalid`);
    }
    return proof;
}

function inspectRetirementProof(root, proof, label, requirePresent) {
    const normalizedProof = proof && proof.marker_root !== undefined ? {
        relative_name: proof.relative_name,
        size_bytes: proof.size_bytes,
        sha256_full: proof.sha256_full,
    } : proof;
    assertRetirementProof(normalizedProof, label);
    const filePath = path.resolve(root, proof.relative_name);
    if (!pathWithin(root, filePath)) {
        throw new Error(`${label} escaped its protected root`);
    }
    let stat;
    try {
        stat = fs.lstatSync(filePath, { bigint: true });
    } catch (error) {
        if (error && error.code === 'ENOENT' && !requirePresent) {
            return { exists: false, path: filePath };
        }
        throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() ||
        Number(stat.size) !== Number(proof.size_bytes) ||
        path.resolve(fs.realpathSync(filePath)) !== filePath ||
        sha256FileSync(filePath) !== proof.sha256_full) {
        throw new Error(`${label} differs from its retirement inventory`);
    }
    return {
        exists: true,
        path: filePath,
        dev: String(stat.dev),
        ino: String(stat.ino),
    };
}

function validateRetirementInventory(authenticatedOrLocation, inventory,
    options) {
    const locationValue = authenticatedOrLocation &&
        authenticatedOrLocation.entryDir
        ? authenticatedOrLocation
        : retirementLocation(authenticatedOrLocation);
    if (!exactObjectFields(inventory, [
        'schema', 'version', 'checkpoint_key', 'artifact', 'manifest',
        'side_files', 'reuse_marker',
    ], []) ||
        inventory.schema !== RETIREMENT_INVENTORY_SCHEMA ||
        inventory.version !== RETIREMENT_INVENTORY_VERSION ||
        inventory.checkpoint_key !== locationValue.key ||
        !Array.isArray(inventory.side_files)) {
        throw new Error('checkpoint retirement inventory schema is invalid');
    }
    assertRetirementProof(inventory.artifact,
        'checkpoint retirement artifact proof');
    assertRetirementProof(inventory.manifest,
        'checkpoint retirement manifest proof');
    if (inventory.artifact.relative_name !==
            path.basename(locationValue.artifactPath) ||
        inventory.manifest.relative_name !== MANIFEST_NAME) {
        throw new Error(
            'checkpoint retirement fixed artifact/manifest names differ');
    }
    const sideNames = new Set();
    const fixed = new Set(RETIREMENT_FIXED_SIDE_FILES);
    for (const proof of inventory.side_files) {
        assertRetirementProof(proof,
            'checkpoint retirement side-file proof');
        const name = proof.relative_name;
        if (path.basename(name) !== name ||
            (!fixed.has(name) && !RETIREMENT_QUARANTINE_SUFFIX.test(name)) ||
            sideNames.has(name)) {
            throw new Error(
                'checkpoint retirement side-file inventory is unsafe');
        }
        sideNames.add(name);
    }
    for (const name of fs.readdirSync(locationValue.entryDir)) {
        if ((fixed.has(name) || RETIREMENT_QUARANTINE_SUFFIX.test(name)) &&
            !sideNames.has(name)) {
            throw new Error(
                `unenumerated checkpoint retirement side file appeared: ${name}`);
        }
    }
    if (inventory.reuse_marker !== null) {
        if (!exactObjectFields(inventory.reuse_marker, [
            'marker_root', 'relative_name', 'size_bytes', 'sha256_full',
        ], []) ||
            path.resolve(String(inventory.reuse_marker.marker_root || '')) !==
                path.resolve(locationValue.reuseRequiredRoot)) {
            throw new Error(
                'checkpoint retirement reuse-marker root is invalid');
        }
        assertRetirementProof({
            relative_name: inventory.reuse_marker.relative_name,
            size_bytes: inventory.reuse_marker.size_bytes,
            sha256_full: inventory.reuse_marker.sha256_full,
        }, 'checkpoint retirement reuse-marker proof');
    }
    const requireAll = options && options.requireAllFiles === true;
    inspectRetirementProof(
        locationValue.entryDir, inventory.artifact,
        'checkpoint retirement artifact', requireAll);
    inspectRetirementProof(
        locationValue.entryDir, inventory.manifest,
        'checkpoint retirement manifest', requireAll);
    for (const proof of inventory.side_files) {
        inspectRetirementProof(
            locationValue.entryDir, proof,
            `checkpoint retirement side file ${proof.relative_name}`,
            requireAll);
    }
    if (inventory.reuse_marker !== null) {
        inspectRetirementProof(
            inventory.reuse_marker.marker_root,
            inventory.reuse_marker,
            'checkpoint retirement reuse marker', requireAll);
    }
    return locationValue;
}

function retireInventory(record, inventory, options) {
    const located = retirementLocation(record);
    validateRetirementInventory(located, inventory);
    const callback = options && options.afterFile;
    const removeProof = (root, proof, kind) => {
        const inspected = inspectRetirementProof(
            root, proof, `checkpoint retirement ${kind}`, false);
        if (!inspected.exists) return false;
        const current = fs.lstatSync(inspected.path, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() ||
            String(current.dev) !== inspected.dev ||
            String(current.ino) !== inspected.ino) {
            throw new Error(
                `checkpoint retirement ${kind} identity changed before unlink`);
        }
        fs.unlinkSync(inspected.path);
        fsyncDirectory(path.dirname(inspected.path));
        if (typeof callback === 'function') {
            callback(kind, proof.relative_name);
        }
        return true;
    };
    const removed = [];
    if (removeProof(located.entryDir, inventory.artifact, 'artifact')) {
        removed.push(inventory.artifact.relative_name);
    }
    if (removeProof(located.entryDir, inventory.manifest, 'manifest')) {
        removed.push(inventory.manifest.relative_name);
    }
    for (const proof of inventory.side_files) {
        if (removeProof(located.entryDir, proof, 'side_file')) {
            removed.push(proof.relative_name);
        }
    }
    if (inventory.reuse_marker !== null &&
        removeProof(
            inventory.reuse_marker.marker_root,
            inventory.reuse_marker, 'reuse_marker')) {
        removed.push(inventory.reuse_marker.relative_name);
        const markerBucket = path.dirname(path.resolve(
            inventory.reuse_marker.marker_root,
            inventory.reuse_marker.relative_name));
        try {
            fs.rmdirSync(markerBucket);
            fsyncDirectory(inventory.reuse_marker.marker_root);
        } catch (error) {
            if (!error ||
                (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST')) {
                throw error;
            }
        }
    }
    validateRetirementInventory(located, inventory);
    return {
        retired: true,
        checkpointKey: located.key,
        removed,
        entryRetained: true,
    };
}

function retire(record, inventory, options) {
    if (inventory) {
        return retireInventory(record, inventory, options);
    }
    const authenticated = authenticateRecord(record);
    const boundaryNames = [
        'delivery-transaction-v1.json',
        'delivery-retirement-v1.json',
    ];
    const boundaryLockPath = path.join(
        authenticated.entryDir, 'delivery-transaction-v1.lock');
    const lockHandle = fs.openSync(boundaryLockPath, 'wx', 0o600);
    let lockIdentity;
    let operationError = null;
    let result;
    try {
        fs.writeFileSync(lockHandle, `${JSON.stringify({
            schema: 'vmaf-delivery-transaction-lock/v1',
            pid: process.pid,
            token: crypto.randomBytes(16).toString('hex'),
            created_at: new Date().toISOString(),
        }, null, 2)}\n`, 'utf8');
        fs.fsyncSync(lockHandle);
        fs.closeSync(lockHandle);
        const lockStat =
            fs.lstatSync(boundaryLockPath, { bigint: true });
        lockIdentity = {
            dev: String(lockStat.dev),
            ino: String(lockStat.ino),
        };
        fsyncDirectory(authenticated.entryDir);
        for (const boundaryName of boundaryNames) {
            if (fs.existsSync(path.join(
                authenticated.entryDir, boundaryName))) {
                throw new Error(
                    'checkpoint has entered the delivery transaction boundary; ' +
                    'a permanent retirement tombstone is required');
            }
        }
        const preDeliveryInventory =
            retirementInventory(authenticated);
        result = retireInventory(
            record, preDeliveryInventory, options);
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        if (lockIdentity) {
            try {
                const lockStat =
                    fs.lstatSync(boundaryLockPath, { bigint: true });
                if (!lockStat.isFile() || lockStat.isSymbolicLink() ||
                    String(lockStat.dev) !== lockIdentity.dev ||
                    String(lockStat.ino) !== lockIdentity.ino) {
                    throw new Error(
                        'pre-delivery retirement lock identity changed');
                }
                fs.unlinkSync(boundaryLockPath);
                fsyncDirectory(authenticated.entryDir);
            } catch (releaseError) {
                if (!operationError) throw releaseError;
                operationError.lockReleaseError = releaseError;
            }
        } else {
            try { fs.closeSync(lockHandle); } catch (_) {}
        }
    }
    // The encode stage may discard a size-rejected checkpoint before a
    // delivery transaction exists. Keep this compatibility path narrowly
    // pre-delivery; once a journal exists only tombstone-authorized retirement
    // above is permitted.
    try {
        fs.rmdirSync(authenticated.entryDir);
        fsyncDirectory(authenticated.bucketDir);
    } catch (error) {
        if (!error ||
            (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST')) {
            throw error;
        }
    }
    try {
        fs.rmdirSync(authenticated.bucketDir);
        fsyncDirectory(authenticated.root);
    } catch (error) {
        if (!error ||
            (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST' &&
                error.code !== 'ENOENT')) {
            throw error;
        }
    }
    if (fs.existsSync(authenticated.entryDir) &&
        fs.readdirSync(authenticated.entryDir).some((name) =>
            boundaryNames.includes(name))) {
        throw new Error(
            'delivery authority appeared during pre-delivery retirement');
    }
    return result;
}

module.exports = {
    SCHEMA,
    CONTRACT_ID,
    DEFAULT_DIRECTORY,
    PINNED_CHECKPOINT_ROOT,
    PINNED_REUSE_REQUIRED_ROOT,
    REUSE_REQUIRED_SCHEMA,
    REUSE_REQUIRED_CONTRACT_ID,
    REUSE_REQUIRED_ROOT_SCHEMA,
    REUSE_REQUIRED_ROOT_CONTRACT_ID,
    REUSE_REQUIRED_ROOT_SENTINEL,
    REUSE_REQUIRED_ANCHOR_SCHEMA,
    REUSE_REQUIRED_ANCHOR_CONTRACT_ID,
    REUSE_REQUIRED_ANCHOR_NAME,
    canonicalJson,
    sha256FileSync,
    assertEncodeContract,
    confirmedInvalidError,
    isConfirmedInvalidError,
    isRetryableValidationError,
    isReuseRequiredError,
    assertPinnedStorage,
    assertReuseRequiredRoot,
    reuseRequiredAnchorPath,
    initializeReuseRequiredRoot,
    resolveCheckpointRoot,
    buildPlan,
    recordExitZeroCandidate,
    stageCandidate,
    commit,
    createReuseRequired,
    enforceReuseRequired,
    importRetained,
    abandon,
    materialize,
    retirementLocation,
    authenticateRecord,
    RETIREMENT_INVENTORY_SCHEMA,
    RETIREMENT_INVENTORY_VERSION,
    retirementInventory,
    validateRetirementInventory,
    retireInventory,
    retire,
};
