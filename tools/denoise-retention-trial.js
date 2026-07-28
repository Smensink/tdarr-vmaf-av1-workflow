#!/usr/bin/env node
'use strict';

/*
 * Bounded, sample-only screening for stronger NVEncC KNN settings.
 *
 * This is deliberately isolated from Tdarr plugins, Flow state, and the
 * learning database. It can only use the hard-coded settings below, writes to
 * one new private output directory, and never promotes a setting to production.
 */

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = 3;
const PROVENANCE_RECEIPT_SCHEMA = 1;
const PROVENANCE_RECEIPT_KIND =
    'tdarr-denoise-retention-provenance-v1';
const MAX_PROVENANCE_RECEIPT_BYTES = 1024 * 1024;
const MIN_REVIEWED_EVIDENCE_ARTIFACTS = 2;
const MAX_REVIEWED_EVIDENCE_ARTIFACTS = 16;
const MAX_CASES = 5;
const MIN_CLIPS_PER_CASE = 3;
const MAX_CLIPS_PER_CASE = 5;
const MIN_CLIP_SECONDS = 4;
const MAX_CLIP_SECONDS = 12;
const MAX_CASE_CLIP_SECONDS = 36;
const MAX_TOTAL_CLIP_SECONDS = 180;
const SETTING_WALL_MS = 12 * 60 * 1000;
const GRAIN_DIFF_TIMEOUT_MS = 4 * 60 * 1000;
const COMMAND_OUTPUT_LIMIT = 8 * 1024 * 1024;
const LUMA_WIDTH = 320;
const METRIC_WIDTH_CAP = 1920;
const DIRECT_GLOBAL_GRAIN_END = 9223372036854775807n;
const GRAIN_FIT_FRAMES = 144;
const GRAIN_FIT_MAX_CANDIDATES = 3;
const GRAIN_PROXY_WIDTH = 192;
const GRAIN_PROXY_HEIGHT = 108;
const GRAIN_PROXY_FRAMES = 3;
const GRAIN_PROXY_SPACING_SECONDS = 2;
const GRAIN_PROXY_POSITION_COUNT = 24;
const DEFAULT_PRODUCTION_GPU_LOCK_PATH =
    '/temp/tdarr-vmaf-gpu-pipeline.lock';
const PRODUCTION_GPU_LEASE_HEARTBEAT_MS = 5000;
const TOOL_KEYS = Object.freeze([
    'ffmpeg',
    'ffprobe',
    'nvencc',
    'grav1synth',
]);
const PRODUCTION_KNN_SETTINGS =
    'radius=3,d=0,strength=0.08,lerp=0.2,th_lerp=0.8';
const PRODUCTION_DENOISE_ID =
    'nvencc-9.25-knn-radius3-d0-strength008-lerp020-thlerp080-v1';
const PRODUCTION_REFERENCE_CONTRACT_ID =
    'nvencc-knn-r3-d0-s008-l020-th080-tf0-gpu8vmaf-v1';
const PROTECTED_ROOT_GROUPS = Object.freeze([
    'media',
    'tdarr_database',
    'tdarr_config',
    'tdarr_plugins',
    'git',
    'backups',
]);

let ACTIVE_AUTHENTICATED_TOOLS = null;
let ACTIVE_PRODUCTION_GPU_LEASE = null;

const VARIANTS = Object.freeze([
    Object.freeze({
        key: 's008-control',
        strength: 0.08,
        role: 'production-control',
        settings: PRODUCTION_KNN_SETTINGS,
        denoiseId: PRODUCTION_DENOISE_ID,
        referenceContractId: PRODUCTION_REFERENCE_CONTRACT_ID,
        grainContractId: 'grav1synth-direct-global-short-clip-nvencc-knn-v1',
        productionCanonical: true,
    }),
    Object.freeze({
        key: 's010-trial',
        strength: 0.10,
        role: 'trial-only',
        settings: 'radius=3,d=0,strength=0.10,lerp=0.2,th_lerp=0.8',
        denoiseId:
            'trial-only-nvencc-9.25-knn-radius3-d0-strength010-lerp020-thlerp080-v1',
        referenceContractId:
            'trial-only-nvencc-knn-r3-d0-s010-l020-th080-tf0-grav1synth-v1',
        grainContractId:
            'trial-only-grav1synth-direct-global-short-clip-nvencc-knn-s010-v1',
        productionCanonical: false,
    }),
    Object.freeze({
        key: 's012-trial',
        strength: 0.12,
        role: 'trial-only',
        settings: 'radius=3,d=0,strength=0.12,lerp=0.2,th_lerp=0.8',
        denoiseId:
            'trial-only-nvencc-9.25-knn-radius3-d0-strength012-lerp020-thlerp080-v1',
        referenceContractId:
            'trial-only-nvencc-knn-r3-d0-s012-l020-th080-tf0-grav1synth-v1',
        grainContractId:
            'trial-only-grav1synth-direct-global-short-clip-nvencc-knn-s012-v1',
        productionCanonical: false,
    }),
    Object.freeze({
        key: 's014-trial',
        strength: 0.14,
        role: 'explicit-escalation-trial-only',
        settings: 'radius=3,d=0,strength=0.14,lerp=0.2,th_lerp=0.8',
        denoiseId:
            'trial-only-nvencc-9.25-knn-radius3-d0-strength014-lerp020-thlerp080-v1',
        referenceContractId:
            'trial-only-nvencc-knn-r3-d0-s014-l020-th080-tf0-grav1synth-v1',
        grainContractId:
            'trial-only-grav1synth-direct-global-short-clip-nvencc-knn-s014-v1',
        productionCanonical: false,
    }),
]);

const NVENC_PROFILES = Object.freeze({
    enhanced: Object.freeze([
        '-tune', 'uhq',
        '-multipass', 'fullres',
        '-spatial-aq', '1',
        '-temporal-aq', '1',
        '-aq-strength', '10',
        '-rc-lookahead', '48',
        '-lookahead_level', 'auto',
        '-b_ref_mode', 'middle',
    ]),
    baseline: Object.freeze([
        '-tune', 'hq',
        '-multipass', 'fullres',
        '-spatial-aq', '1',
        '-temporal-aq', '1',
        '-aq-strength', '10',
        '-rc-lookahead', '32',
    ]),
});

const LUMA_BANDS = Object.freeze([
    Object.freeze({ key: 'dark', min: 0, max: 63 }),
    Object.freeze({ key: 'shadow', min: 64, max: 111 }),
    Object.freeze({ key: 'midtone', min: 112, max: 175 }),
    Object.freeze({ key: 'highlight', min: 176, max: 255 }),
]);

function usage() {
    return [
        'Usage:',
        '  node denoise-retention-trial.js --input /private/spec.json',
        '    --output /private/denoise-runs/new-run-directory --node-drained',
        '',
        'The Tdarr node must already be paused and have zero active workers.',
        'The input JSON must independently acknowledge that condition.',
        'The output must be a new child of its declared private_output_root.',
    ].join('\n');
}

function parseCli(argv) {
    const parsed = { input: '', output: '', nodeDrained: false, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--help' || token === '-h') {
            parsed.help = true;
        } else if (token === '--node-drained') {
            parsed.nodeDrained = true;
        } else if (token === '--input' || token === '--output') {
            if (index + 1 >= argv.length) throw new Error(`missing value for ${token}`);
            parsed[token.slice(2)] = argv[index + 1];
            index += 1;
        } else {
            throw new Error(`unknown option ${token}`);
        }
    }
    if (!parsed.help && (!parsed.input || !parsed.output)) {
        throw new Error('--input and --output are required');
    }
    return parsed;
}

function finiteNumber(value, description) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${description} must be a finite number`);
    }
    return value;
}

function positiveSafeInteger(value, description) {
    if (typeof value !== 'number') {
        throw new Error(`${description} must be a positive safe integer`);
    }
    const number = finiteNumber(value, description);
    if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error(`${description} must be a positive safe integer`);
    }
    return number;
}

function sha256Hex(value, description) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
        throw new Error(`${description} must be a lowercase SHA-256`);
    }
    return value;
}

function exactObjectKeys(value, requiredKeys, description) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${description} must be an object`);
    }
    const expected = new Set(requiredKeys);
    const missing = requiredKeys.filter(
        (key) => !Object.prototype.hasOwnProperty.call(value, key)
    );
    if (missing.length) {
        throw new Error(`${description} is missing ${missing[0]}`);
    }
    const unknown = Object.keys(value).filter((key) => !expected.has(key));
    if (unknown.length) {
        throw new Error(`${description} contains unknown field ${unknown[0]}`);
    }
    return value;
}

function allowedObjectKeys(value, allowedKeys, description) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${description} must be an object`);
    }
    const allowed = new Set(allowedKeys);
    const unknown = Object.keys(value).filter((key) => !allowed.has(key));
    if (unknown.length) {
        throw new Error(`${description} contains unknown field ${unknown[0]}`);
    }
    return value;
}

function safeId(value, description) {
    if (typeof value !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
        throw new Error(`${description} must use 1-64 safe filename characters`);
    }
    return value;
}

function absolutePath(value, description) {
    if (typeof value !== 'string' ||
        /[\u0000-\u001f\u007f]/.test(value) ||
        !path.posix.isAbsolute(value)) {
        throw new Error(`${description} must be an absolute path inside the container`);
    }
    return path.posix.normalize(value);
}

function normalizeReviewedSymlinkChain(value, description) {
    if (!Array.isArray(value) || value.length > 64) {
        throw new Error(`${description} must be an array of at most 64 symbolic-link hops`);
    }
    const reviewedPaths = new Set();
    return value.map((entry, index) => {
        const hopDescription = `${description}[${index}]`;
        const input = exactObjectKeys(
            entry, ['path', 'target'], hopDescription
        );
        const hopPath = absolutePath(input.path, `${hopDescription}.path`);
        if (reviewedPaths.has(hopPath)) {
            throw new Error(`${description} contains duplicate path ${hopPath}`);
        }
        reviewedPaths.add(hopPath);
        if (typeof input.target !== 'string' ||
            input.target.length < 1 ||
            input.target.length > 4096 ||
            /[\u0000-\u001f\u007f]/.test(input.target)) {
            throw new Error(
                `${hopDescription}.target must be 1-4096 non-control characters`
            );
        }
        return {
            path: hopPath,
            target: input.target,
        };
    });
}

function normalizeExpectedExecutableFile(value, description, includeRequestedPath) {
    const keys = includeRequestedPath
        ? [
            'path',
            'resolved_path',
            'sha256',
            'size_bytes',
            'reviewed_symlink_chain',
        ]
        : [
            'resolved_path',
            'sha256',
            'size_bytes',
            'reviewed_symlink_chain',
        ];
    const input = exactObjectKeys(value, keys, description);
    const normalized = {
        resolvedPath: absolutePath(
            input.resolved_path, `${description}.resolved_path`
        ),
        sha256: sha256Hex(input.sha256, `${description}.sha256`),
        sizeBytes: positiveSafeInteger(
            input.size_bytes, `${description}.size_bytes`
        ),
        reviewedSymlinkChain: normalizeReviewedSymlinkChain(
            input.reviewed_symlink_chain,
            `${description}.reviewed_symlink_chain`
        ),
    };
    if (includeRequestedPath) {
        normalized.path = absolutePath(input.path, `${description}.path`);
    }
    return normalized;
}

function normalizeExpectedToolIdentity(value, description) {
    allowedObjectKeys(value, [
        'resolved_path',
        'sha256',
        'size_bytes',
        'reviewed_symlink_chain',
        'wrapper_contract',
    ], description);
    if (!Object.prototype.hasOwnProperty.call(
        value, 'reviewed_symlink_chain'
    )) {
        throw new Error(`${description} is missing reviewed_symlink_chain`);
    }
    const normalized = normalizeExpectedExecutableFile({
        resolved_path: value.resolved_path,
        sha256: value.sha256,
        size_bytes: value.size_bytes,
        reviewed_symlink_chain: value.reviewed_symlink_chain,
    }, description, false);
    if (value.wrapper_contract === undefined) {
        normalized.wrapperContract = null;
        return normalized;
    }
    const wrapper = exactObjectKeys(value.wrapper_contract, [
        'kind',
        'interpreter',
        'exec_target',
        'ld_library_path',
    ], `${description}.wrapper_contract`);
    if (wrapper.kind !== 'posix-sh-exec-v1') {
        throw new Error(
            `${description}.wrapper_contract.kind must be posix-sh-exec-v1`
        );
    }
    if (typeof wrapper.ld_library_path !== 'string' ||
        !wrapper.ld_library_path.trim() ||
        /[\r\n\0]/.test(wrapper.ld_library_path)) {
        throw new Error(
            `${description}.wrapper_contract.ld_library_path must be one non-empty line`
        );
    }
    normalized.wrapperContract = {
        kind: 'posix-sh-exec-v1',
        interpreter: normalizeExpectedExecutableFile(
            wrapper.interpreter,
            `${description}.wrapper_contract.interpreter`,
            true
        ),
        execTarget: normalizeExpectedExecutableFile(
            wrapper.exec_target,
            `${description}.wrapper_contract.exec_target`,
            true
        ),
        ldLibraryPath: wrapper.ld_library_path,
    };
    return normalized;
}

function normalizeDeclaredRootList(value, description, allowEmpty) {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
        throw new Error(
            `${description} must be ${allowEmpty ? 'an' : 'a non-empty'} array of absolute paths`
        );
    }
    const roots = value.map((entry, index) => {
        const root = absolutePath(entry, `${description}[${index}]`);
        if (root === '/') {
            throw new Error(`${description}[${index}] must not be a filesystem root`);
        }
        return root;
    });
    if (new Set(roots).size !== roots.length) {
        throw new Error(`${description} contains duplicate roots`);
    }
    return roots;
}

function normalizeOutputRootPolicy(raw) {
    const privateOutputRoot = absolutePath(
        raw.private_output_root, 'private_output_root'
    );
    if (privateOutputRoot === '/') {
        throw new Error('private_output_root must not be a filesystem root');
    }
    if (raw.acknowledge_protected_roots_complete !== true) {
        throw new Error(
            'input must set acknowledge_protected_roots_complete=true after declaring every protected root'
        );
    }
    if (raw.acknowledge_no_git_checkout_mounted !== undefined &&
        typeof raw.acknowledge_no_git_checkout_mounted !== 'boolean') {
        throw new Error('acknowledge_no_git_checkout_mounted must be a boolean');
    }
    const input = raw.protected_roots;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('protected_roots must be an object');
    }
    const unknown = Object.keys(input).filter(
        (key) => !PROTECTED_ROOT_GROUPS.includes(key)
    );
    if (unknown.length) {
        throw new Error(`protected_roots contains unknown group ${unknown[0]}`);
    }
    const protectedRoots = {};
    for (const group of PROTECTED_ROOT_GROUPS) {
        protectedRoots[group] = normalizeDeclaredRootList(
            input[group],
            `protected_roots.${group}`,
            group === 'git'
        );
    }
    if (protectedRoots.git.length === 0 &&
        raw.acknowledge_no_git_checkout_mounted !== true) {
        throw new Error(
            'an empty protected_roots.git requires acknowledge_no_git_checkout_mounted=true'
        );
    }
    if (protectedRoots.git.length > 0 &&
        raw.acknowledge_no_git_checkout_mounted === true) {
        throw new Error(
            'acknowledge_no_git_checkout_mounted conflicts with declared Git roots'
        );
    }
    return {
        privateOutputRoot,
        protectedRoots,
        acknowledgeNoGitCheckoutMounted:
            raw.acknowledge_no_git_checkout_mounted === true,
    };
}

function selectedVariants(config) {
    const selected = VARIANTS.slice(0, 3);
    for (const field of [
        'include_strength_014',
        'acknowledge_s012_was_reviewed',
    ]) {
        if (config[field] !== undefined && typeof config[field] !== 'boolean') {
            throw new Error(`${field} must be a boolean`);
        }
    }
    if (config.include_strength_014 === true) {
        if (config.acknowledge_s012_was_reviewed !== true) {
            throw new Error(
                'strength 0.14 requires acknowledge_s012_was_reviewed=true'
            );
        }
        if (typeof config.strength_014_justification !== 'string' ||
            config.strength_014_justification.trim().length < 20) {
            throw new Error(
                'strength 0.14 requires a specific justification of at least 20 characters'
            );
        }
        selected.push(VARIANTS[3]);
    } else if (config.strength_014_justification !== undefined &&
        (typeof config.strength_014_justification !== 'string' ||
            Array.from(config.strength_014_justification.trim()).length < 20)) {
        throw new Error(
            'strength_014_justification must be a string of at least 20 characters'
        );
    }
    return selected;
}

function normalizeConfig(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('input must be a JSON object');
    }
    allowedObjectKeys(raw, [
        'schema',
        'acknowledge_node_paused_and_drained',
        'private_output_root',
        'acknowledge_protected_roots_complete',
        'acknowledge_no_git_checkout_mounted',
        'protected_roots',
        'production_gpu_lock_path',
        'nvenc_quality_profile',
        'minimum_control_saving_pct',
        'minimum_source_estimate_saving_pct',
        'maximum_vmaf_drop',
        'maximum_cambi_increase',
        'maximum_band_mae_increase_pct',
        'include_strength_014',
        'acknowledge_s012_was_reviewed',
        'strength_014_justification',
        'tools',
        'expected_tool_identities',
        'cases',
    ], 'input');
    if (raw.schema !== SCHEMA) throw new Error(`input schema must be ${SCHEMA}`);
    if (raw.acknowledge_node_paused_and_drained !== true) {
        throw new Error(
            'input must set acknowledge_node_paused_and_drained=true after live verification'
        );
    }
    const variants = selectedVariants(raw);
    const outputRootPolicy = normalizeOutputRootPolicy(raw);
    if (typeof raw.nvenc_quality_profile !== 'string') {
        throw new Error('nvenc_quality_profile must be enhanced or baseline');
    }
    const profile = raw.nvenc_quality_profile;
    if (!Object.prototype.hasOwnProperty.call(NVENC_PROFILES, profile)) {
        throw new Error('nvenc_quality_profile must be enhanced or baseline');
    }
    if (!Array.isArray(raw.cases) || raw.cases.length < 1 ||
        raw.cases.length > MAX_CASES) {
        throw new Error(`cases must contain 1-${MAX_CASES} entries`);
    }
    const caseIds = new Set();
    let totalClipSeconds = 0;
    const cases = raw.cases.map((entry, caseIndex) => {
        exactObjectKeys(entry, [
            'case_id',
            'source_path',
            'expected_source_sha256',
            'expected_source_size_bytes',
            'provenance_receipt',
            'cq',
            'clips',
        ], `cases[${caseIndex}]`);
        const caseId = safeId(entry.case_id, `cases[${caseIndex}].case_id`);
        if (caseIds.has(caseId)) throw new Error(`duplicate case_id ${caseId}`);
        caseIds.add(caseId);
        const sourcePath = absolutePath(
            entry.source_path, `cases[${caseIndex}].source_path`
        );
        const cq = finiteNumber(entry.cq, `cases[${caseIndex}].cq`);
        if (!Number.isInteger(cq) || cq < 16 || cq > 51) {
            throw new Error(`cases[${caseIndex}].cq must be an integer from 16 to 51`);
        }
        const expectedSourceSha256 = sha256Hex(
            entry.expected_source_sha256,
            `cases[${caseIndex}].expected_source_sha256`
        );
        const expectedSourceSizeBytes = positiveSafeInteger(
            entry.expected_source_size_bytes,
            `cases[${caseIndex}].expected_source_size_bytes`
        );
        const receiptInput = exactObjectKeys(
            entry.provenance_receipt,
            ['path', 'sha256', 'size_bytes'],
            `cases[${caseIndex}].provenance_receipt`
        );
        const provenanceReceipt = {
            path: absolutePath(
                receiptInput.path,
                `cases[${caseIndex}].provenance_receipt.path`
            ),
            sha256: sha256Hex(
                receiptInput.sha256,
                `cases[${caseIndex}].provenance_receipt.sha256`
            ),
            sizeBytes: positiveSafeInteger(
                receiptInput.size_bytes,
                `cases[${caseIndex}].provenance_receipt.size_bytes`
            ),
        };
        if (provenanceReceipt.sizeBytes > MAX_PROVENANCE_RECEIPT_BYTES) {
            throw new Error(
                `cases[${caseIndex}].provenance_receipt.size_bytes exceeds ` +
                `${MAX_PROVENANCE_RECEIPT_BYTES}`
            );
        }
        if (!Array.isArray(entry.clips) ||
            entry.clips.length < MIN_CLIPS_PER_CASE ||
            entry.clips.length > MAX_CLIPS_PER_CASE) {
            throw new Error(
                `${caseId} must supply ${MIN_CLIPS_PER_CASE}-${MAX_CLIPS_PER_CASE} exact clips`
            );
        }
        let caseClipSeconds = 0;
        const clipIds = new Set();
        const clips = entry.clips.map((clip, clipIndex) => {
            allowedObjectKeys(clip, [
                'clip_id',
                'timestamp_seconds',
                'duration_seconds',
                'review_note',
                'review_crop_x',
                'review_crop_y',
            ], `${caseId}.clips[${clipIndex}]`);
            const clipId = safeId(
                clip.clip_id, `${caseId}.clips[${clipIndex}].clip_id`
            );
            if (clipIds.has(clipId)) {
                throw new Error(`${caseId} has duplicate clip_id ${clipId}`);
            }
            clipIds.add(clipId);
            const timestampSeconds = finiteNumber(
                clip.timestamp_seconds, `${caseId}.${clipId}.timestamp_seconds`
            );
            const durationSeconds = finiteNumber(
                clip.duration_seconds, `${caseId}.${clipId}.duration_seconds`
            );
            if (timestampSeconds < 0) {
                throw new Error(`${caseId}.${clipId} timestamp must be non-negative`);
            }
            if (durationSeconds < MIN_CLIP_SECONDS ||
                durationSeconds > MAX_CLIP_SECONDS) {
                throw new Error(
                    `${caseId}.${clipId} duration must be ${MIN_CLIP_SECONDS}-${MAX_CLIP_SECONDS}s`
                );
            }
            caseClipSeconds += durationSeconds;
            const cropX = clip.review_crop_x === undefined
                ? null : finiteNumber(
                    clip.review_crop_x, `${caseId}.${clipId}.review_crop_x`
                );
            const cropY = clip.review_crop_y === undefined
                ? null : finiteNumber(
                    clip.review_crop_y, `${caseId}.${clipId}.review_crop_y`
                );
            if ((cropX !== null && (!Number.isInteger(cropX) || cropX < 0)) ||
                (cropY !== null && (!Number.isInteger(cropY) || cropY < 0))) {
                throw new Error(
                    `${caseId}.${clipId} review crop coordinates must be non-negative integers`
                );
            }
            if (clip.review_note !== undefined &&
                (typeof clip.review_note !== 'string' ||
                    Array.from(clip.review_note).length > 500)) {
                throw new Error(
                    `${caseId}.${clipId}.review_note must be a string of at most 500 characters`
                );
            }
            return {
                clipId,
                timestampSeconds,
                durationSeconds,
                reviewNote: (clip.review_note || '').trim(),
                cropX,
                cropY,
            };
        });
        if (caseClipSeconds > MAX_CASE_CLIP_SECONDS) {
            throw new Error(
                `${caseId} supplies ${caseClipSeconds}s; cap is ${MAX_CASE_CLIP_SECONDS}s`
            );
        }
        totalClipSeconds += caseClipSeconds;
        return {
            caseId,
            sourcePath,
            expectedSourceSha256,
            expectedSourceSizeBytes,
            provenanceReceipt,
            cq,
            clips,
            caseClipSeconds,
        };
    });
    if (totalClipSeconds > MAX_TOTAL_CLIP_SECONDS) {
        throw new Error(
            `total supplied clip time ${totalClipSeconds}s exceeds ${MAX_TOTAL_CLIP_SECONDS}s`
        );
    }
    const toolInput = exactObjectKeys(raw.tools, TOOL_KEYS, 'tools');
    const tools = {
        ffmpeg: absolutePath(
            toolInput.ffmpeg, 'tools.ffmpeg'
        ),
        ffprobe: absolutePath(
            toolInput.ffprobe, 'tools.ffprobe'
        ),
        nvencc: absolutePath(
            toolInput.nvencc, 'tools.nvencc'
        ),
        grav1synth: absolutePath(
            toolInput.grav1synth, 'tools.grav1synth'
        ),
    };
    const expectedIdentityInput = exactObjectKeys(
        raw.expected_tool_identities,
        TOOL_KEYS,
        'expected_tool_identities'
    );
    const expectedToolIdentities = {};
    for (const toolKey of TOOL_KEYS) {
        expectedToolIdentities[toolKey] = normalizeExpectedToolIdentity(
            expectedIdentityInput[toolKey],
            `expected_tool_identities.${toolKey}`
        );
    }
    const deployedProductionGpuLockPath = absolutePath(
        process.env.TDARR_GPU_PIPELINE_LOCK_DIR ||
            DEFAULT_PRODUCTION_GPU_LOCK_PATH,
        'TDARR_GPU_PIPELINE_LOCK_DIR'
    );
    const productionGpuLockPath = absolutePath(
        raw.production_gpu_lock_path || deployedProductionGpuLockPath,
        'production_gpu_lock_path'
    );
    if (productionGpuLockPath === '/') {
        throw new Error('production_gpu_lock_path must not be a filesystem root');
    }
    if (productionGpuLockPath !== deployedProductionGpuLockPath) {
        throw new Error(
            'production_gpu_lock_path must exactly match ' +
            'TDARR_GPU_PIPELINE_LOCK_DIR or the production default'
        );
    }
    const thresholds = {
        minimumControlSavingPct: raw.minimum_control_saving_pct === undefined
            ? 3 : finiteNumber(
                raw.minimum_control_saving_pct, 'minimum_control_saving_pct'
            ),
        minimumSourceEstimateSavingPct:
            raw.minimum_source_estimate_saving_pct === undefined
                ? 3 : finiteNumber(
                    raw.minimum_source_estimate_saving_pct,
                    'minimum_source_estimate_saving_pct'
                ),
        maximumVmafDrop: raw.maximum_vmaf_drop === undefined
            ? 0.5 : finiteNumber(raw.maximum_vmaf_drop, 'maximum_vmaf_drop'),
        maximumCambiIncrease: raw.maximum_cambi_increase === undefined
            ? 0.25 : finiteNumber(
                raw.maximum_cambi_increase, 'maximum_cambi_increase'
            ),
        maximumBandMaeIncreasePct:
            raw.maximum_band_mae_increase_pct === undefined
                ? 10 : finiteNumber(
                    raw.maximum_band_mae_increase_pct,
                    'maximum_band_mae_increase_pct'
                ),
    };
    const bounds = [
        ['minimum_control_saving_pct', thresholds.minimumControlSavingPct, 0, 50],
        [
            'minimum_source_estimate_saving_pct',
            thresholds.minimumSourceEstimateSavingPct,
            0,
            50,
        ],
        ['maximum_vmaf_drop', thresholds.maximumVmafDrop, 0, 5],
        ['maximum_cambi_increase', thresholds.maximumCambiIncrease, 0, 5],
        [
            'maximum_band_mae_increase_pct',
            thresholds.maximumBandMaeIncreasePct,
            0,
            100,
        ],
    ];
    for (const [name, value, minimum, maximum] of bounds) {
        if (value < minimum || value > maximum) {
            throw new Error(`${name} must be from ${minimum} to ${maximum}`);
        }
    }
    return {
        schema: SCHEMA,
        acknowledgeNodePausedAndDrained: true,
        nvencQualityProfile: profile,
        includeStrength014: variants.length === 4,
        strength014Justification: variants.length === 4
            ? String(raw.strength_014_justification).trim() : null,
        variants,
        cases,
        tools,
        expectedToolIdentities,
        productionGpuLockPath,
        privateOutputRoot: outputRootPolicy.privateOutputRoot,
        protectedRoots: outputRootPolicy.protectedRoots,
        acknowledgeProtectedRootsComplete: true,
        acknowledgeNoGitCheckoutMounted:
            outputRootPolicy.acknowledgeNoGitCheckoutMounted,
        thresholds,
    };
}

function isPathWithin(candidate, root) {
    const relative = path.posix.relative(root, candidate);
    return relative === '' ||
        (relative !== '..' &&
            !relative.startsWith('../') &&
            !path.posix.isAbsolute(relative));
}

function pathsOverlap(left, right) {
    return isPathWithin(left, right) || isPathWithin(right, left);
}

function missingPath(error) {
    return Boolean(error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'));
}

function assertEntryAbsent(filePath, description, fileSystem) {
    try {
        fileSystem.lstatSync(filePath);
    } catch (error) {
        if (missingPath(error)) return;
        throw new Error(
            `${description} could not be inspected (${String(error.code || 'unknown')})`
        );
    }
    throw new Error(`${description} already exists`);
}

function canonicalDirectory(directoryPath, description, fileSystem) {
    let stat;
    try {
        stat = fileSystem.lstatSync(directoryPath);
    } catch (error) {
        throw new Error(
            `${description} could not be inspected (${String(error.code || 'unknown')})`
        );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`${description} must be an existing non-symlink directory`);
    }
    let canonical;
    try {
        canonical = path.posix.normalize(String(fileSystem.realpathSync(directoryPath)));
    } catch (error) {
        throw new Error(
            `${description} could not be resolved (${String(error.code || 'unknown')})`
        );
    }
    const lexical = path.posix.resolve(directoryPath);
    if (canonical !== lexical) {
        throw new Error(
            `${description} has a symlinked or ambiguous canonical path`
        );
    }
    return canonical;
}

function canonicalSourceFile(sourcePath, description, fileSystem) {
    let stat;
    try {
        stat = fileSystem.lstatSync(sourcePath);
    } catch (error) {
        throw new Error(
            `${description} could not be inspected (${String(error.code || 'unknown')})`
        );
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`${description} must be an existing regular non-symlink file`);
    }
    let canonical;
    try {
        canonical = path.posix.normalize(String(fileSystem.realpathSync(sourcePath)));
    } catch (error) {
        throw new Error(
            `${description} could not be resolved (${String(error.code || 'unknown')})`
        );
    }
    if (canonical !== path.posix.resolve(sourcePath)) {
        throw new Error(`${description} has a symlinked or ambiguous canonical path`);
    }
    return canonical;
}

function entryKind(filePath, fileSystem) {
    try {
        const stat = fileSystem.lstatSync(filePath);
        if (stat.isDirectory()) return 'directory';
        if (stat.isFile()) return 'file';
        return 'other';
    } catch (error) {
        if (missingPath(error)) return null;
        throw new Error(
            `Git ancestry could not be inspected (${String(error.code || 'unknown')})`
        );
    }
}

function findGitAncestor(startPath, fileSystem) {
    let current = path.posix.resolve(startPath);
    while (true) {
        if (entryKind(path.posix.join(current, '.git'), fileSystem) !== null) {
            return current;
        }
        const head = entryKind(path.posix.join(current, 'HEAD'), fileSystem);
        const objects = entryKind(path.posix.join(current, 'objects'), fileSystem);
        const refs = entryKind(path.posix.join(current, 'refs'), fileSystem);
        if (head === 'file' && objects === 'directory' && refs === 'directory') {
            return current;
        }
        const parent = path.posix.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

function validateOutputPolicy(config, outputPath, options) {
    options = options || {};
    const fileSystem = options.fileSystem || fs;
    const privateRoot = canonicalDirectory(
        config.privateOutputRoot, 'private_output_root', fileSystem
    );
    const protectedRoots = {};
    for (const group of PROTECTED_ROOT_GROUPS) {
        const declared = config.protectedRoots && config.protectedRoots[group];
        if (!Array.isArray(declared)) {
            throw new Error(`protected_roots.${group} is missing`);
        }
        protectedRoots[group] = declared.map((root, index) =>
            canonicalDirectory(
                root, `protected_roots.${group}[${index}]`, fileSystem
            )
        );
    }
    const allProtected = Object.entries(protectedRoots).flatMap(
        ([group, roots]) => roots.map((root) => ({ group, root }))
    );
    const sourceParents = [];
    const provenanceReceipts = [];
    for (const caseSpec of config.cases || []) {
        const source = canonicalSourceFile(
            caseSpec.sourcePath, `${caseSpec.caseId} source`, fileSystem
        );
        if (!protectedRoots.media.some((root) => isPathWithin(source, root))) {
            throw new Error(
                `${caseSpec.caseId} source is outside every declared media root`
            );
        }
        const sourceParent = canonicalDirectory(
            path.posix.dirname(source),
            `${caseSpec.caseId} source parent`,
            fileSystem
        );
        if (pathsOverlap(privateRoot, sourceParent)) {
            throw new Error(
                'private_output_root overlaps a source-parent directory'
            );
        }
        sourceParents.push(sourceParent);
        const receipt = canonicalSourceFile(
            caseSpec.provenanceReceipt.path,
            `${caseSpec.caseId} provenance receipt`,
            fileSystem
        );
        if (!protectedRoots.backups.some((root) => isPathWithin(receipt, root))) {
            throw new Error(
                `${caseSpec.caseId} provenance receipt is outside every ` +
                'declared protected backup root'
            );
        }
        provenanceReceipts.push(receipt);
    }
    for (const item of allProtected) {
        if (pathsOverlap(privateRoot, item.root)) {
            throw new Error(
                `private_output_root overlaps protected ${item.group} root`
            );
        }
    }

    const normalizedOutput = absolutePath(outputPath, '--output');
    assertEntryAbsent(normalizedOutput, 'output directory', fileSystem);
    const outputParent = canonicalDirectory(
        path.posix.dirname(normalizedOutput), 'output parent', fileSystem
    );
    const resolvedOutput = path.posix.join(
        outputParent, path.posix.basename(normalizedOutput)
    );
    if (resolvedOutput === privateRoot ||
        !isPathWithin(resolvedOutput, privateRoot)) {
        throw new Error(
            'output must be a new child contained by private_output_root'
        );
    }
    if (resolvedOutput === path.posix.parse(resolvedOutput).root) {
        throw new Error('refusing to use a filesystem root as output');
    }
    const gitAncestor = findGitAncestor(outputParent, fileSystem);
    if (gitAncestor) {
        throw new Error('output is inside a Git root');
    }
    return {
        resolvedOutput,
        privateOutputRoot: privateRoot,
        protectedRoots,
        sourceParents,
        provenanceReceipts,
        gitAncestor: null,
    };
}

function frameRate(stream) {
    const value = String(stream.avg_frame_rate || stream.r_frame_rate || '');
    const match = value.match(/^(\d+)(?:\/(\d+))?$/);
    if (!match) throw new Error(`unsupported frame rate ${value || 'missing'}`);
    const fps = Number(match[1]) / Number(match[2] || 1);
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) {
        throw new Error(`frame rate is outside the supported range: ${value}`);
    }
    return fps;
}

function outputDepth(stream) {
    const pixelFormat = String(stream.pix_fmt || '').toLowerCase();
    if (['yuv420p', 'yuvj420p', 'nv12'].includes(pixelFormat)) return 8;
    if (['yuv420p10le', 'p010le'].includes(pixelFormat)) return 10;
    throw new Error(
        `trial requires production-compatible 8/10-bit 4:2:0 input; observed ` +
        `${pixelFormat || 'unknown'}`
    );
}

function colorArgs(stream) {
    const pairs = [
        ['-color_range', stream.color_range],
        ['-color_primaries', stream.color_primaries],
        ['-color_trc', stream.color_transfer],
        ['-colorspace', stream.color_space],
    ];
    const argv = [];
    for (const [option, value] of pairs) {
        const text = String(value || '').trim();
        if (text && text.toLowerCase() !== 'unknown' && text.toLowerCase() !== 'n/a') {
            argv.push(option, text);
        }
    }
    return argv;
}

function av1ColorMetadataBsf(stream) {
    const primaries = String(stream.color_primaries || '').toLowerCase();
    const transfer = String(stream.color_transfer || '').toLowerCase();
    const matrix = String(stream.color_space || '').toLowerCase();
    const primaryCode = primaries.includes('bt2020') ? 9
        : (primaries.includes('bt709') ? 1 : 2);
    const transferCode = transfer.includes('smpte2084') ? 16
        : ((transfer.includes('arib-std-b67') || transfer.includes('hlg')) ? 18
            : (transfer.includes('bt2020-10') ? 14
                : (transfer.includes('bt2020-12') ? 15
                    : (transfer.includes('bt709') ? 1 : 2))));
    const matrixCode = matrix.includes('bt2020') ? 9
        : (matrix.includes('bt709') ? 1 : 2);
    return `av1_metadata=color_primaries=${primaryCode}:` +
        `transfer_characteristics=${transferCode}:matrix_coefficients=${matrixCode}`;
}

function buildExtractArgs(options) {
    const pixelFormat = options.depth === 10 ? 'yuv420p10le' : 'yuv420p';
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-ss', Number(options.timestampSeconds).toFixed(6),
        '-i', options.sourcePath,
        '-map', `0:${options.streamSpecifier || 'v:0'}`,
        '-frames:v', String(options.frames),
        '-an', '-sn', '-dn',
        '-map_metadata', '-1', '-map_chapters', '-1',
        '-vf', 'setpts=PTS-STARTPTS',
        '-fps_mode', 'passthrough',
        '-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1',
        '-g', '1', '-slicecrc', '1', '-pix_fmt', pixelFormat,
    ].concat(colorArgs(options.stream), ['-f', 'matroska', options.outputPath]);
}

function buildProducerArgs(options) {
    return [
        '--disable-nvml', '2',
        '--avsw',
        '--input-analyze', '5',
        '--input-probesize', String(100 * 1024 * 1024),
        '--timestamp-passthrough',
        '-i', options.sourcePath,
        '--vpp-knn', options.variant.settings,
        '-c', 'raw',
        '--output-format', 'nut',
        '--output-csp', 'yuv420',
        '--output-depth', String(options.depth),
        '--frames', String(options.frames),
        '-o', '-',
    ];
}

function buildDenoiseConsumerArgs(options) {
    const pixelFormat = options.depth === 10 ? 'yuv420p10le' : 'yuv420p';
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-f', 'nut', '-i', 'pipe:0',
        '-map', '0:v:0', '-frames:v', String(options.frames),
        '-an', '-sn', '-dn',
        '-map_metadata', '-1', '-map_chapters', '-1',
        '-vf', 'setpts=PTS-STARTPTS',
        '-fps_mode', 'passthrough',
        '-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1',
        '-g', '1', '-slicecrc', '1', '-pix_fmt', pixelFormat,
    ].concat(colorArgs(options.stream), ['-f', 'matroska', options.outputPath]);
}

function buildEncodeArgs(options) {
    const pixelFormat = options.depth === 10 ? 'p010le' : 'yuv420p';
    const profileFlags = NVENC_PROFILES[options.profile];
    if (!profileFlags) throw new Error(`unknown NVENC profile ${options.profile}`);
    const color = colorArgs(options.stream);
    const metadata = [
        '-bsf:v:0', av1ColorMetadataBsf(options.stream),
        '-metadata:s:v:0',
        `COLOR_PRIMARIES=${String(options.stream.color_primaries || 'unknown')}`,
        '-metadata:s:v:0',
        `COLOR_TRANSFER=${String(options.stream.color_transfer || 'unknown')}`,
        '-metadata:s:v:0',
        `COLOR_SPACE=${String(options.stream.color_space || 'unknown')}`,
    ];
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-i', options.inputPath,
        '-map', '0:v:0',
        '-c:v', 'av1_nvenc',
        '-pix_fmt', pixelFormat,
        '-rc', 'vbr', '-cq', String(options.cq), '-b:v', '0',
        '-preset', 'p7',
    ].concat(
        profileFlags,
        ['-g', '96', '-forced-idr', '1'],
        color,
        metadata,
        [
            '-an', '-sn', '-dn',
            '-map_metadata', '-1', '-map_chapters', '-1',
            '-f', 'matroska', options.outputPath,
        ]
    );
}

function buildLumaArgs(inputPath, outputPath, width, height, frames) {
    expectedLumaByteCount(frames, width, height);
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-i', inputPath,
        '-map', '0:v:0',
        '-vf', `scale=${width}:${height}:flags=bicubic,format=gray`,
        '-pix_fmt', 'gray',
        '-f', 'rawvideo', outputPath,
    ];
}

function buildContactSheetArgs(sourcePath, distortedPath, outputPath, frames, crop) {
    const middle = Math.max(1, Math.floor((frames - 1) / 2));
    const last = Math.max(middle + 1, frames - 1);
    const select = `select=eq(n\\,0)+eq(n\\,${middle})+eq(n\\,${last})`;
    const cropFilter = `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`;
    const graph = [
        `[0:v]${select},${cropFilter},tile=3x1[src]`,
        `[1:v]${select},${cropFilter},tile=3x1[trial]`,
        '[src][trial]vstack=inputs=2[out]',
    ].join(';');
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
        '-i', sourcePath, '-i', distortedPath,
        '-filter_complex', graph,
        '-map', '[out]', '-frames:v', '1', outputPath,
    ];
}

function roundSix(value) {
    return Math.round(Number(value) * 1000000) / 1000000;
}

function productionGrainFitStartTimes(durationSeconds, clipSeconds) {
    const duration = Number(durationSeconds);
    const clip = Number(clipSeconds);
    if (!Number.isFinite(duration) || duration <= 0 ||
        !Number.isFinite(clip) || clip <= 0) {
        throw new Error('grain fit selection requires positive duration and clip length');
    }
    const margin = Math.min(Math.max(10, duration * 0.03), 120);
    const latest = Math.max(margin, duration - margin - clip);
    if (latest <= margin) {
        return [Math.max(0, (duration - clip) / 2)];
    }
    return Array.from({ length: GRAIN_PROXY_POSITION_COUNT }, (_, index) =>
        margin + (latest - margin) * index / (GRAIN_PROXY_POSITION_COUNT - 1)
    );
}

function buildGrainProxyArgs(options) {
    const streamIndex = Number(options.streamIndex);
    if (!Number.isSafeInteger(streamIndex) || streamIndex < 0) {
        throw new Error('grain proxy stream index must be a non-negative integer');
    }
    return [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-ss', Number(options.timestampSeconds).toFixed(6),
        '-t', (GRAIN_PROXY_SPACING_SECONDS * GRAIN_PROXY_FRAMES).toFixed(6),
        '-i', options.sourcePath,
        '-map', `0:${streamIndex}`,
        '-vf',
        `fps=1/${GRAIN_PROXY_SPACING_SECONDS},` +
            `scale=${GRAIN_PROXY_WIDTH}:${GRAIN_PROXY_HEIGHT}:flags=area,format=gray`,
        '-frames:v', String(GRAIN_PROXY_FRAMES),
        '-an', '-sn', '-dn',
        '-f', 'rawvideo', 'pipe:1',
    ];
}

function mean(values) {
    return values.length
        ? values.reduce((sum, value) => sum + value, 0) / values.length
        : Number.NaN;
}

function proxyFrameLuma(frame) {
    let total = 0;
    for (const value of frame) total += value;
    return total / frame.length;
}

function proxyFrameGradient(frame) {
    let total = 0;
    let count = 0;
    for (let y = 0; y < GRAIN_PROXY_HEIGHT - 1; y += 1) {
        const row = y * GRAIN_PROXY_WIDTH;
        const nextRow = row + GRAIN_PROXY_WIDTH;
        for (let x = 0; x < GRAIN_PROXY_WIDTH - 1; x += 1) {
            const value = frame[row + x];
            total += Math.abs(value - frame[row + x + 1]);
            total += Math.abs(value - frame[nextRow + x]);
            count += 2;
        }
    }
    return total / count;
}

function proxyFrameMad(left, right) {
    if (!Buffer.isBuffer(left) || !Buffer.isBuffer(right) ||
        left.length !== right.length || left.length < 1) {
        throw new Error('grain proxy frames must be equal non-empty buffers');
    }
    let total = 0;
    for (let index = 0; index < left.length; index += 1) {
        total += Math.abs(left[index] - right[index]);
    }
    return total / left.length;
}

function analyzeGrainProxyBytes(bytes) {
    const frameBytes = GRAIN_PROXY_WIDTH * GRAIN_PROXY_HEIGHT;
    const expectedBytes = frameBytes * GRAIN_PROXY_FRAMES;
    if (!Buffer.isBuffer(bytes) || bytes.length !== expectedBytes) {
        throw new Error('grain proxy render returned an incomplete frame set');
    }
    const frames = Array.from({ length: GRAIN_PROXY_FRAMES }, (_, index) =>
        bytes.subarray(index * frameBytes, (index + 1) * frameBytes)
    );
    const lumas = frames.map(proxyFrameLuma);
    const gradients = frames.map(proxyFrameGradient);
    const temporal = frames.slice(0, -1).map((frame, index) =>
        proxyFrameMad(frame, frames[index + 1])
    );
    const luma = mean(lumas);
    const flatness = mean(gradients);
    const motion = mean(temporal);
    const maximumMotion = Math.max(...temporal);
    const midPenalty = Math.abs(luma - 112) / 16;
    const cutLike = maximumMotion >= 28;
    const rankScore =
        flatness + 0.35 * motion + midPenalty + (cutLike ? 1000 : 0);
    return {
        valid: !cutLike,
        meanLuma8bit: roundSix(luma),
        meanGradient: roundSix(flatness),
        meanTemporalMad: roundSix(motion),
        maximumTemporalMad: roundSix(maximumMotion),
        cutLike,
        rankScore: roundSix(rankScore),
    };
}

function rankProductionGrainFitEvidence(evidence, durationSeconds, clipSeconds) {
    const duration = Number(durationSeconds);
    const clip = Number(clipSeconds);
    const ranked = evidence.filter((item) => item && item.valid === true)
        .slice()
        .sort((left, right) =>
            left.rankScore - right.rankScore ||
            Math.abs(left.startSeconds - duration / 2) -
                Math.abs(right.startSeconds - duration / 2) ||
            left.startSeconds - right.startSeconds
        );
    const selected = [];
    const minimumSpacing = Math.max(clip, duration * 0.08);
    for (const item of ranked) {
        if (selected.every((existing) =>
            Math.abs(item.startSeconds - existing.startSeconds) >= minimumSpacing
        )) {
            selected.push(item);
        }
        if (selected.length >= GRAIN_FIT_MAX_CANDIDATES) break;
    }
    if (!selected.length) {
        return evidence.filter((item) =>
            item && Number.isFinite(item.rankScore)
        ).slice().sort((left, right) =>
            left.rankScore - right.rankScore ||
            left.startSeconds - right.startSeconds
        ).slice(0, GRAIN_FIT_MAX_CANDIDATES);
    }
    return selected;
}

async function buildProductionGrainFitPlan(
    config, caseSpec, media, options
) {
    options = options || {};
    const runner = options.runCommandFn || runCommand;
    const clipSeconds = GRAIN_FIT_FRAMES / media.fps;
    const starts = productionGrainFitStartTimes(
        media.durationSeconds, clipSeconds
    );
    const evidence = [];
    for (const timestamp of starts) {
        try {
            const rendered = await runner(
                config.tools.ffmpeg,
                buildGrainProxyArgs({
                    sourcePath: caseSpec.sourcePath,
                    streamIndex: media.stream.index,
                    timestampSeconds: timestamp,
                }),
                { timeoutMs: 60000 }
            );
            const proxy = analyzeGrainProxyBytes(rendered.stdoutBuffer);
            evidence.push(Object.assign({
                startSeconds: roundSix(timestamp),
            }, proxy));
        } catch (error) {
            evidence.push({
                startSeconds: roundSix(timestamp),
                valid: false,
                reason: String(error && error.message || error).slice(0, 512),
            });
        }
    }
    const candidates = rankProductionGrainFitEvidence(
        evidence, media.durationSeconds, clipSeconds
    ).map((item, index) => Object.assign({
        rank: index + 1,
    }, item));
    return {
        method: 'flat-mid-luma-no-cut-proxy-ranking-v1',
        requestedFrames: GRAIN_FIT_FRAMES,
        requestedCandidateLimit: GRAIN_FIT_MAX_CANDIDATES,
        clipSeconds: roundSix(clipSeconds),
        sourceDurationSeconds: roundSix(media.durationSeconds),
        proxyWidth: GRAIN_PROXY_WIDTH,
        proxyHeight: GRAIN_PROXY_HEIGHT,
        proxyFrames: GRAIN_PROXY_FRAMES,
        proxyPositionCount: starts.length,
        candidates,
        proxyEvidence: evidence,
    };
}

function hasSemanticGrainTable(text) {
    const lines = String(text || '').split(/\r?\n/);
    if (String(lines[0] || '').trim() !== 'filmgrn1') return false;
    let segments;
    try {
        segments = grainTableSegments(text);
    } catch (_) {
        return false;
    }
    if (segments.length < 1) {
        return false;
    }
    for (const line of lines) {
        const match = line.trim().match(/^s(?:Y|Cb|Cr)\s+(\d+)\s+(.*)$/);
        if (!match) continue;
        const count = Number(match[1]);
        const values = match[2].trim().split(/\s+/).map(Number);
        if (!Number.isSafeInteger(count) || count < 1 ||
            values.length < count * 2) {
            continue;
        }
        for (let index = 0; index < count; index += 1) {
            const scale = values[index * 2 + 1];
            if (Number.isFinite(scale) && scale > 0) return true;
        }
    }
    return false;
}

function grainTableSegments(text) {
    const segments = [];
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!/^E(?:\s|$)/.test(line)) continue;
        const match = line.match(/^E\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!match) {
            throw new Error(
                'trial grav1synth table contains a malformed or payload-free segment header'
            );
        }
        const start = BigInt(match[1]);
        const end = BigInt(match[2]);
        if (end < start) {
            throw new Error(
                'trial grav1synth table contains a reversed segment boundary'
            );
        }
        segments.push({ start, end });
    }
    return segments;
}

function assertDirectGlobalGrainTable(text) {
    const segments = grainTableSegments(text);
    if (segments.length !== 1 ||
        segments[0].start !== 0n ||
        segments[0].end !== DIRECT_GLOBAL_GRAIN_END) {
        throw new Error(
            'trial grav1synth table must contain exactly one unmodified global segment'
        );
    }
    if (!hasSemanticGrainTable(text)) {
        throw new Error('trial grav1synth table contains no semantic grain');
    }
    return true;
}

function appendBounded(state, chunk) {
    if (state.bytes >= COMMAND_OUTPUT_LIMIT) return;
    const remaining = COMMAND_OUTPUT_LIMIT - state.bytes;
    const bounded = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    state.chunks.push(bounded);
    state.bytes += bounded.length;
}

function childResult(child, name, stdoutState, stderrState) {
    return new Promise((resolve) => {
        let resolved = false;
        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            const stdoutBuffer = Buffer.concat(stdoutState.chunks);
            const stderrBuffer = Buffer.concat(stderrState.chunks);
            resolve(Object.assign({
                name,
                stdout: stdoutBuffer.toString('utf8'),
                stderr: stderrBuffer.toString('utf8'),
                stdoutBuffer,
            }, result));
        };
        child.once('error', (error) => finish({ code: null, signal: null, error }));
        child.once('exit', (code, signal) => finish({ code, signal, error: null }));
    });
}

function terminate(child, signal) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    try {
        child.kill(signal);
        return true;
    } catch (_) {
        return false;
    }
}

function waitForPromisesOrTimeout(promises, timeoutMs) {
    if (!promises.length) return Promise.resolve(true);
    let timer;
    return Promise.race([
        Promise.all(promises).then(() => true),
        new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
        }),
    ]).finally(() => clearTimeout(timer));
}

function createChildRegistry(options) {
    options = options || {};
    const graceMs = options.graceMs === undefined ? 5000 : Number(options.graceMs);
    if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 30000) {
        throw new Error('child cleanup graceMs must be from 0 to 30000');
    }
    const active = new Map();
    let shutdownPromise = null;
    let shuttingDown = false;

    const register = (child, name) => {
        if (!child || typeof child.once !== 'function') {
            throw new Error('spawned child cannot be supervised');
        }
        if (active.has(child) ||
            child.exitCode !== null ||
            child.signalCode !== null) {
            return child;
        }
        let resolveDone;
        const done = new Promise((resolve) => {
            resolveDone = resolve;
        });
        const finish = () => {
            if (!active.has(child)) return;
            active.delete(child);
            resolveDone();
        };
        active.set(child, {
            child,
            name: String(name || 'child'),
            done,
        });
        child.once('exit', finish);
        child.once('error', finish);
        if (shuttingDown) terminate(child, 'SIGTERM');
        return child;
    };

    const terminateAll = (signal) => {
        for (const entry of active.values()) terminate(entry.child, signal);
    };

    const terminateAndWait = (signal) => {
        if (shutdownPromise) return shutdownPromise;
        shutdownPromise = (async () => {
            shuttingDown = true;
            while (active.size > 0) {
                const initial = Array.from(active.values());
                for (const entry of initial) {
                    terminate(entry.child, signal || 'SIGTERM');
                }
                const graceful = await waitForPromisesOrTimeout(
                    initial.map((entry) => entry.done), graceMs
                );
                if (!graceful) {
                    const remaining = Array.from(active.values());
                    for (const entry of remaining) {
                        terminate(entry.child, 'SIGKILL');
                    }
                    await Promise.all(remaining.map((entry) => entry.done));
                }
            }
        })();
        return shutdownPromise;
    };

    return {
        register,
        terminateAll,
        terminateAndWait,
        size: () => active.size,
        children: () => Array.from(active.values()).map((entry) => entry.child),
        isShuttingDown: () => shuttingDown,
    };
}

const ACTIVE_CHILD_REGISTRY = createChildRegistry();

function installSignalHandlers(registry, processObject) {
    registry = registry || ACTIVE_CHILD_REGISTRY;
    processObject = processObject || process;
    let cleanupPromise = null;
    const handlers = {};
    for (const signal of ['SIGINT', 'SIGTERM']) {
        handlers[signal] = () => {
            if (cleanupPromise) {
                registry.terminateAll('SIGKILL');
                return;
            }
            const exitCode = signal === 'SIGINT' ? 130 : 143;
            processObject.exitCode = exitCode;
            cleanupPromise = registry.terminateAndWait('SIGTERM')
                .catch(() => {});
        };
        processObject.on(signal, handlers[signal]);
    }
    return {
        dispose() {
            for (const signal of Object.keys(handlers)) {
                processObject.removeListener(signal, handlers[signal]);
            }
        },
        waitForCleanup() {
            return cleanupPromise || Promise.resolve();
        },
    };
}

async function runCommand(executable, argv, options) {
    options = options || {};
    assertActiveToolIdentity(executable, 'before spawn');
    const started = Date.now();
    const stdoutState = { chunks: [], bytes: 0 };
    const stderrState = { chunks: [], bytes: 0 };
    const spawn = options.spawn || childProcess.spawn;
    const registry = options.registry || ACTIVE_CHILD_REGISTRY;
    if (registry.isShuttingDown && registry.isShuttingDown()) {
        throw new Error('refusing to start a child while signal cleanup is active');
    }
    const child = spawn(executable, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    registry.register(child, path.basename(executable));
    child.stdout.on('data', (chunk) => appendBounded(stdoutState, chunk));
    child.stderr.on('data', (chunk) => appendBounded(stderrState, chunk));
    const resultPromise = childResult(child, path.basename(executable), stdoutState, stderrState);
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        terminate(child, 'SIGTERM');
        setTimeout(() => terminate(child, 'SIGKILL'), 5000).unref();
    }, options.timeoutMs || 120000);
    timeout.unref();
    const result = await resultPromise;
    clearTimeout(timeout);
    assertActiveToolIdentity(executable, 'after process exit');
    result.durationMs = Date.now() - started;
    result.timedOut = timedOut;
    if (result.error || result.code !== 0 || timedOut) {
        const detail = String(result.stderr || result.stdout || '').trim().slice(-3000);
        const error = new Error(
            `${path.basename(executable)} ${timedOut ? 'timed out' :
                `exited ${result.code}`}${detail ? `: ${detail}` : ''}`
        );
        error.commandResult = result;
        throw error;
    }
    return result;
}

async function runPipeline(nvencc, producerArgs, ffmpeg, consumerArgs, options) {
    options = options || {};
    assertActiveToolIdentity(nvencc, 'before NVEncC pipeline spawn');
    assertActiveToolIdentity(ffmpeg, 'before FFmpeg pipeline spawn');
    const started = Date.now();
    const producerOut = { chunks: [], bytes: 0 };
    const producerErr = { chunks: [], bytes: 0 };
    const consumerOut = { chunks: [], bytes: 0 };
    const consumerErr = { chunks: [], bytes: 0 };
    const spawn = options.spawn || childProcess.spawn;
    const registry = options.registry || ACTIVE_CHILD_REGISTRY;
    if (registry.isShuttingDown && registry.isShuttingDown()) {
        throw new Error('refusing to start a pipeline while signal cleanup is active');
    }
    const producer = spawn(nvencc, producerArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    registry.register(producer, 'NVEncC');
    const consumer = spawn(ffmpeg, consumerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    registry.register(consumer, 'FFmpeg');
    producer.stdout.pipe(consumer.stdin);
    producer.stderr.on('data', (chunk) => appendBounded(producerErr, chunk));
    consumer.stdout.on('data', (chunk) => appendBounded(consumerOut, chunk));
    consumer.stderr.on('data', (chunk) => appendBounded(consumerErr, chunk));
    consumer.stdin.on('error', (error) => {
        if (!error || error.code !== 'EPIPE') {
            appendBounded(consumerErr, Buffer.from(String(error && error.message)));
        }
    });
    const producerResultPromise = childResult(
        producer, 'NVEncC', producerOut, producerErr
    );
    const consumerResultPromise = childResult(
        consumer, 'FFmpeg', consumerOut, consumerErr
    );
    let timedOut = false;
    const stopBoth = (signal) => {
        terminate(producer, signal);
        terminate(consumer, signal);
    };
    const stopOneWithEscalation = (child) => {
        terminate(child, 'SIGTERM');
        setTimeout(() => terminate(child, 'SIGKILL'), 5000).unref();
    };
    const timeout = setTimeout(() => {
        timedOut = true;
        stopBoth('SIGTERM');
        setTimeout(() => stopBoth('SIGKILL'), 5000).unref();
    }, options.timeoutMs || 180000);
    timeout.unref();
    let producerSettled = false;
    let consumerExitedBeforeProducer = false;
    producerResultPromise.then((result) => {
        producerSettled = true;
        if (result.error || result.code !== 0) stopOneWithEscalation(consumer);
    });
    consumerResultPromise.then((result) => {
        if (!producerSettled) consumerExitedBeforeProducer = true;
        if (consumerExitedBeforeProducer || result.error || result.code !== 0) {
            stopOneWithEscalation(producer);
        }
    });
    const results = await Promise.all([
        producerResultPromise, consumerResultPromise,
    ]);
    clearTimeout(timeout);
    assertActiveToolIdentity(nvencc, 'after NVEncC pipeline exit');
    assertActiveToolIdentity(ffmpeg, 'after FFmpeg pipeline exit');
    if (consumerExitedBeforeProducer && !timedOut) {
        throw new Error(
            'FFmpeg consumer exited before NVEncC producer completed'
        );
    }
    for (const result of results) {
        if (result.error || result.code !== 0 || timedOut) {
            const detail = String(result.stderr || result.stdout || '').trim().slice(-3000);
            throw new Error(
                `${result.name} ${timedOut ? 'pipeline timed out' :
                    `exited ${result.code}`}${detail ? `: ${detail}` : ''}`
            );
        }
    }
    return {
        durationMs: Date.now() - started,
        producerStderr: results[0].stderr,
        consumerStderr: results[1].stderr,
    };
}

function executableStatIdentity(stat) {
    return Object.assign(sourceStatIdentity(stat), {
        mode: Number(stat.mode),
        uid: String(stat.uid),
        gid: String(stat.gid),
        linkCount: String(stat.nlink),
    });
}

function requestedExecutableIdentity(
    requestedPath, resolvedPath, requestedStat, linkTarget, symlinkChain
) {
    return {
        requestedPath,
        resolvedPath,
        requestedType: requestedStat.isSymbolicLink() ? 'symbolic-link' : 'file',
        requestedDevice: String(requestedStat.dev),
        requestedInode: String(requestedStat.ino),
        requestedMtimeNs: statNanoseconds(
            requestedStat, 'mtimeNs', 'mtimeMs'
        ),
        requestedCtimeNs: statNanoseconds(
            requestedStat, 'ctimeNs', 'ctimeMs'
        ),
        requestedMode: Number(requestedStat.mode),
        requestedLinkTarget: linkTarget,
        symlinkChain,
    };
}

function executableSymlinkChain(executable, fileSystem) {
    const requestedPath = path.resolve(executable);
    let pendingPath = requestedPath;
    const chain = [];
    const visited = new Set();
    for (let hop = 0; hop < 64; hop += 1) {
        const parsed = path.parse(pendingPath);
        const components = pendingPath
            .slice(parsed.root.length)
            .split(path.sep)
            .filter(Boolean);
        let cursor = parsed.root;
        let followed = false;
        for (let index = 0; index < components.length; index += 1) {
            const candidate = path.join(cursor, components[index]);
            const stat = fileSystem.lstatSync(candidate, { bigint: true });
            if (!stat.isSymbolicLink()) {
                cursor = candidate;
                continue;
            }
            const target = String(fileSystem.readlinkSync(candidate));
            const record = {
                path: path.resolve(candidate),
                target,
                device: String(stat.dev),
                inode: String(stat.ino),
                mtimeNs: statNanoseconds(stat, 'mtimeNs', 'mtimeMs'),
                ctimeNs: statNanoseconds(stat, 'ctimeNs', 'ctimeMs'),
                mode: Number(stat.mode),
            };
            const visitKey =
                `${record.path}\0${record.device}\0${record.inode}\0${target}`;
            if (visited.has(visitKey)) {
                throw new Error(`${executable} contains a symbolic-link cycle`);
            }
            visited.add(visitKey);
            chain.push(record);
            const remaining = components.slice(index + 1);
            const targetPath = path.isAbsolute(target)
                ? target : path.resolve(path.dirname(candidate), target);
            pendingPath = path.resolve(targetPath, ...remaining);
            followed = true;
            break;
        }
        if (!followed) {
            return {
                resolvedPath: path.resolve(cursor),
                chain,
            };
        }
    }
    throw new Error(`${executable} exceeds the symbolic-link traversal limit`);
}

function differingExecutableIdentityFields(left, right, includeHash) {
    const fields = [
        'requestedPath',
        'resolvedPath',
        'requestedType',
        'requestedDevice',
        'requestedInode',
        'requestedMtimeNs',
        'requestedCtimeNs',
        'requestedMode',
        'requestedLinkTarget',
        'symlinkChain',
        'device',
        'inode',
        'sizeBytes',
        'mtimeNs',
        'ctimeNs',
        'mode',
        'uid',
        'gid',
        'linkCount',
    ];
    if (includeHash) fields.push('sha256');
    return fields.filter((field) => {
        if (!left || !right) return true;
        if (field === 'symlinkChain') {
            return JSON.stringify(left[field]) !== JSON.stringify(right[field]);
        }
        return String(left[field]) !== String(right[field]);
    });
}

function readExecutableIdentity(executable, options) {
    options = options || {};
    const fileSystem = options.fileSystem || fs;
    const constants = options.constants || fs.constants;
    const includeHash = options.includeHash === true;
    const chunkBytes = options.chunkBytes || 4 * 1024 * 1024;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 4096 ||
        chunkBytes > 64 * 1024 * 1024) {
        throw new Error('executable hash chunkBytes must be from 4096 to 67108864');
    }
    if (typeof executable !== 'string' || !executable) {
        throw new Error('executable path must be a non-empty string');
    }
    const requestedPath = path.resolve(executable);
    const chainBefore = executableSymlinkChain(executable, fileSystem);
    const requestedBefore = fileSystem.lstatSync(executable, { bigint: true });
    if (!requestedBefore.isFile() && !requestedBefore.isSymbolicLink()) {
        throw new Error(`${executable} must resolve from a file or symbolic link`);
    }
    const requestedLinkBefore = requestedBefore.isSymbolicLink()
        ? String(fileSystem.readlinkSync(executable)) : null;
    const resolvedBefore = path.resolve(fileSystem.realpathSync(executable));
    if (chainBefore.resolvedPath !== resolvedBefore) {
        throw new Error(`${executable} symbolic-link resolution is inconsistent`);
    }
    const finalBefore = fileSystem.lstatSync(resolvedBefore, { bigint: true });
    if (finalBefore.isSymbolicLink() || !finalBefore.isFile()) {
        throw new Error(`${executable} must resolve to a regular non-symlink file`);
    }
    fileSystem.accessSync(executable, constants.X_OK);
    const noFollow = Number(constants.O_NOFOLLOW || 0);
    const fd = fileSystem.openSync(
        resolvedBefore,
        Number(constants.O_RDONLY || 0) | noFollow
    );
    let descriptorBefore;
    let descriptorAfter;
    let digest = null;
    let bytesRead = 0;
    try {
        descriptorBefore = executableStatIdentity(
            fileSystem.fstatSync(fd, { bigint: true })
        );
        const finalBeforeIdentity = executableStatIdentity(finalBefore);
        const openingChanges = differingSourceIdentityFields(
            finalBeforeIdentity, descriptorBefore, false
        );
        if (openingChanges.length) {
            throw new Error(
                `${executable} target identity changed while opening ` +
                `(${openingChanges.join(', ')})`
            );
        }
        if (includeHash) {
            const hash = crypto.createHash('sha256');
            const buffer = Buffer.allocUnsafe(chunkBytes);
            while (true) {
                const count = fileSystem.readSync(
                    fd, buffer, 0, buffer.length, null
                );
                if (!count) break;
                hash.update(buffer.subarray(0, count));
                bytesRead += count;
                if (!Number.isSafeInteger(bytesRead)) {
                    throw new Error('executable hash byte count exceeded safe integer range');
                }
            }
            digest = hash.digest('hex');
        }
        descriptorAfter = executableStatIdentity(
            fileSystem.fstatSync(fd, { bigint: true })
        );
    } finally {
        fileSystem.closeSync(fd);
    }
    if (differingSourceIdentityFields(
        descriptorBefore, descriptorAfter, false
    ).length || (includeHash && bytesRead !== descriptorBefore.sizeBytes)) {
        throw new Error(`${executable} changed while authenticating executable bytes`);
    }
    const finalAfter = fileSystem.lstatSync(resolvedBefore, { bigint: true });
    if (finalAfter.isSymbolicLink() || !finalAfter.isFile() ||
        differingSourceIdentityFields(
            descriptorAfter, executableStatIdentity(finalAfter), false
        ).length) {
        throw new Error(`${executable} resolved target changed during authentication`);
    }
    const chainAfter = executableSymlinkChain(executable, fileSystem);
    const requestedAfter = fileSystem.lstatSync(executable, { bigint: true });
    const requestedLinkAfter = requestedAfter.isSymbolicLink()
        ? String(fileSystem.readlinkSync(executable)) : null;
    const resolvedAfter = path.resolve(fileSystem.realpathSync(executable));
    if (chainAfter.resolvedPath !== resolvedAfter) {
        throw new Error(`${executable} symbolic-link resolution is inconsistent`);
    }
    const requestedIdentityBefore = requestedExecutableIdentity(
        requestedPath,
        resolvedBefore,
        requestedBefore,
        requestedLinkBefore,
        chainBefore.chain
    );
    const requestedIdentityAfter = requestedExecutableIdentity(
        requestedPath,
        resolvedAfter,
        requestedAfter,
        requestedLinkAfter,
        chainAfter.chain
    );
    const requestedFields = [
        'requestedPath',
        'resolvedPath',
        'requestedType',
        'requestedDevice',
        'requestedInode',
        'requestedMtimeNs',
        'requestedCtimeNs',
        'requestedMode',
        'requestedLinkTarget',
        'symlinkChain',
    ];
    if (requestedFields.some((field) =>
        field === 'symlinkChain'
            ? JSON.stringify(requestedIdentityBefore[field]) !==
                JSON.stringify(requestedIdentityAfter[field])
            : String(requestedIdentityBefore[field]) !==
                String(requestedIdentityAfter[field])
    )) {
        throw new Error(`${executable} entrypoint changed during authentication`);
    }
    return Object.assign(
        requestedIdentityAfter,
        executableStatIdentity(finalAfter),
        {
            sha256: digest,
            bytesHashed: includeHash ? bytesRead : null,
        }
    );
}

function fullExecutableIdentity(executable, options) {
    return readExecutableIdentity(
        executable,
        Object.assign({}, options || {}, { includeHash: true })
    );
}

function assertExecutableIdentityUnchanged(executable, expected, phase, options) {
    const observed = readExecutableIdentity(
        executable,
        Object.assign({}, options || {}, { includeHash: false })
    );
    const changes = differingExecutableIdentityFields(expected, observed, false);
    if (changes.length) {
        throw new Error(
            `${path.basename(executable)} identity changed ${phase || 'before use'} ` +
            `(${changes.join(', ')})`
        );
    }
    return observed;
}

function assertMatchesExpectedExecutable(observed, expected, description) {
    const observedReviewedChain = Array.isArray(observed.symlinkChain)
        ? observed.symlinkChain.map((hop) => ({
            path: path.resolve(hop.path),
            target: hop.target,
        }))
        : null;
    const expectedReviewedChain = Array.isArray(expected.reviewedSymlinkChain)
        ? expected.reviewedSymlinkChain.map((hop) => ({
            path: path.resolve(hop.path),
            target: hop.target,
        }))
        : null;
    if (observed.resolvedPath !== path.resolve(expected.resolvedPath) ||
        observed.sha256 !== expected.sha256 ||
        observed.sizeBytes !== expected.sizeBytes ||
        observed.bytesHashed !== expected.sizeBytes ||
        JSON.stringify(observedReviewedChain) !==
            JSON.stringify(expectedReviewedChain)) {
        throw new Error(
            `${description} does not match expected resolved path, SHA-256, ` +
            'size, and reviewed symbolic-link chain'
        );
    }
}

function authenticateExecutableReference(requestedPath, expected, description) {
    if (ACTIVE_PRODUCTION_GPU_LEASE !== null) {
        assertActiveProductionGpuLease();
    }
    const identity = fullExecutableIdentity(requestedPath);
    assertMatchesExpectedExecutable(identity, expected, description);
    if (ACTIVE_PRODUCTION_GPU_LEASE !== null) {
        assertActiveProductionGpuLease();
    }
    return {
        path: requestedPath,
        identity,
    };
}

function parsePosixShExecWrapperText(text, description) {
    const match = String(text).match(
        /^#!(\/[^ \t\r\n]+)\r?\nexport LD_LIBRARY_PATH=([^\r\n]+)\r?\nexec (\/[^ \t\r\n]+) "\$@"\r?\n?$/
    );
    if (!match) {
        throw new Error(
            `${description || 'executable'} is not an exact posix-sh-exec-v1 wrapper`
        );
    }
    return {
        interpreterPath: match[1],
        ldLibraryPath: match[2],
        execTargetPath: match[3],
    };
}

function parsePosixShExecWrapper(executable, entrypointIdentity) {
    if (entrypointIdentity.sizeBytes > 64 * 1024) {
        throw new Error(`${executable} wrapper exceeds 65536 bytes`);
    }
    const bytes = fs.readFileSync(entrypointIdentity.resolvedPath);
    if (bytes.length !== entrypointIdentity.sizeBytes ||
        crypto.createHash('sha256').update(bytes).digest('hex') !==
            entrypointIdentity.sha256) {
        throw new Error(`${executable} wrapper bytes changed after authentication`);
    }
    assertExecutableIdentityUnchanged(
        executable, entrypointIdentity, 'while parsing wrapper'
    );
    return parsePosixShExecWrapperText(bytes.toString('utf8'), executable);
}

function executablePrefix(executable, identity, byteCount) {
    const fd = fs.openSync(
        identity.resolvedPath,
        Number(fs.constants.O_RDONLY || 0) |
            Number(fs.constants.O_NOFOLLOW || 0)
    );
    const buffer = Buffer.alloc(byteCount);
    let count;
    try {
        const descriptor = executableStatIdentity(
            fs.fstatSync(fd, { bigint: true })
        );
        if (differingSourceIdentityFields(
            identity, descriptor, false
        ).length) {
            throw new Error(`${executable} changed before prefix inspection`);
        }
        count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
        fs.closeSync(fd);
    }
    assertExecutableIdentityUnchanged(
        executable, identity, 'during prefix inspection'
    );
    return buffer.subarray(0, count);
}

function authenticateConfiguredTools(config) {
    const authenticated = {};
    for (const toolKey of TOOL_KEYS) {
        const executable = config.tools[toolKey];
        const expected = config.expectedToolIdentities[toolKey];
        const entrypoint = authenticateExecutableReference(
            executable, expected, `${toolKey} entrypoint`
        );
        const prefix = executablePrefix(
            executable, entrypoint.identity, 2
        ).toString('utf8');
        let wrapper = null;
        if (expected.wrapperContract) {
            const parsed = parsePosixShExecWrapper(
                executable, entrypoint.identity
            );
            const wrapperExpected = expected.wrapperContract;
            if (parsed.interpreterPath !== wrapperExpected.interpreter.path ||
                parsed.execTargetPath !== wrapperExpected.execTarget.path ||
                parsed.ldLibraryPath !== wrapperExpected.ldLibraryPath) {
                throw new Error(
                    `${toolKey} wrapper command or environment contract changed`
                );
            }
            wrapper = {
                kind: 'posix-sh-exec-v1',
                ldLibraryPath: parsed.ldLibraryPath,
                interpreter: authenticateExecutableReference(
                    parsed.interpreterPath,
                    wrapperExpected.interpreter,
                    `${toolKey} wrapper interpreter`
                ),
                execTarget: authenticateExecutableReference(
                    parsed.execTargetPath,
                    wrapperExpected.execTarget,
                    `${toolKey} wrapper exec target`
                ),
            };
        } else if (prefix === '#!') {
            throw new Error(
                `${toolKey} is a script but has no authenticated wrapper_contract`
            );
        }
        authenticated[toolKey] = {
            toolKey,
            path: executable,
            authenticated: true,
            entrypoint,
            wrapper,
        };
    }
    return authenticated;
}

function assertToolClosureUnchanged(tool, phase) {
    assertExecutableIdentityUnchanged(
        tool.entrypoint.path, tool.entrypoint.identity, phase
    );
    if (tool.wrapper) {
        assertExecutableIdentityUnchanged(
            tool.wrapper.interpreter.path,
            tool.wrapper.interpreter.identity,
            `${phase}; wrapper interpreter`
        );
        assertExecutableIdentityUnchanged(
            tool.wrapper.execTarget.path,
            tool.wrapper.execTarget.identity,
            `${phase}; wrapper exec target`
        );
    }
    return tool;
}

function activateAuthenticatedTools(authenticated) {
    if (ACTIVE_AUTHENTICATED_TOOLS !== null) {
        throw new Error('authenticated executable enforcement is already active');
    }
    const registry = new Map();
    for (const toolKey of TOOL_KEYS) {
        const tool = authenticated && authenticated[toolKey];
        if (!tool || typeof tool.path !== 'string') {
            throw new Error(`missing authenticated executable identity for ${toolKey}`);
        }
        const key = path.resolve(tool.path);
        if (registry.has(key)) {
            throw new Error(`duplicate authenticated executable path ${tool.path}`);
        }
        registry.set(key, tool);
    }
    ACTIVE_AUTHENTICATED_TOOLS = registry;
    let disposed = false;
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            if (ACTIVE_AUTHENTICATED_TOOLS !== registry) {
                throw new Error('authenticated executable enforcement ownership changed');
            }
            ACTIVE_AUTHENTICATED_TOOLS = null;
        },
    };
}

function assertActiveToolIdentity(executable, phase) {
    if (ACTIVE_AUTHENTICATED_TOOLS === null) return null;
    const tool = ACTIVE_AUTHENTICATED_TOOLS.get(path.resolve(executable));
    if (!tool) {
        throw new Error(
            `refusing unregistered executable ${executable} while authentication is active`
        );
    }
    assertActiveProductionGpuLease();
    assertToolClosureUnchanged(tool, phase);
    return tool;
}

function reauthenticateConfiguredTools(authenticated) {
    const finalIdentities = {};
    for (const toolKey of TOOL_KEYS) {
        const expectedTool = authenticated[toolKey];
        if (ACTIVE_PRODUCTION_GPU_LEASE !== null) {
            assertActiveProductionGpuLease();
        }
        const entrypoint = fullExecutableIdentity(expectedTool.entrypoint.path);
        const entrypointChanges = differingExecutableIdentityFields(
            expectedTool.entrypoint.identity, entrypoint, true
        );
        if (entrypointChanges.length) {
            throw new Error(
                `${toolKey} entrypoint failed final authentication ` +
                `(${entrypointChanges.join(', ')})`
            );
        }
        let wrapper = null;
        if (expectedTool.wrapper) {
            wrapper = {
                kind: expectedTool.wrapper.kind,
                ldLibraryPath: expectedTool.wrapper.ldLibraryPath,
            };
            for (const dependencyName of ['interpreter', 'execTarget']) {
                const expectedDependency =
                    expectedTool.wrapper[dependencyName];
                const observed = fullExecutableIdentity(
                    expectedDependency.path
                );
                const changes = differingExecutableIdentityFields(
                    expectedDependency.identity, observed, true
                );
                if (changes.length) {
                    throw new Error(
                        `${toolKey} wrapper ${dependencyName} failed final ` +
                        `authentication (${changes.join(', ')})`
                    );
                }
                wrapper[dependencyName] = {
                    path: expectedDependency.path,
                    identity: observed,
                };
            }
        }
        if (ACTIVE_PRODUCTION_GPU_LEASE !== null) {
            assertActiveProductionGpuLease();
        }
        finalIdentities[toolKey] = {
            toolKey,
            path: expectedTool.path,
            authenticated: true,
            entrypoint: {
                path: expectedTool.entrypoint.path,
                identity: entrypoint,
            },
            wrapper,
        };
    }
    return finalIdentities;
}

function productionLockEvidence(lockPath) {
    try {
        const stat = fs.lstatSync(lockPath, { bigint: true });
        return {
            path: lockPath,
            type: stat.isDirectory() ? 'directory'
                : (stat.isSymbolicLink() ? 'symbolic-link' : 'filesystem-entry'),
            identity: {
                device: String(stat.dev),
                inode: String(stat.ino),
            },
        };
    } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        throw new Error(
            `cannot inspect production GPU lock ${lockPath}: ${error.message}`
        );
    }
}

function leaseTokenDigest(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function getProcStartTime(pid, procRoot) {
    try {
        const statText = fs.readFileSync(
            path.join(procRoot || '/proc', String(pid), 'stat'),
            'utf8'
        );
        const close = statText.lastIndexOf(')');
        if (close < 0) return null;
        const fields = statText.slice(close + 1).trim().split(/\s+/);
        const startTime = Number(fields[19]);
        return Number.isFinite(startTime) ? startTime : null;
    } catch (_) {
        return null;
    }
}

function stableJsonFile(filePath, description) {
    const before = fs.lstatSync(filePath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
        throw new Error(`${description} must be a regular non-symlink file`);
    }
    const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(
        filePath,
        Number(fs.constants.O_RDONLY || 0) | noFollow
    );
    let descriptorBefore;
    let descriptorAfter;
    let bytes;
    try {
        descriptorBefore = sourceStatIdentity(
            fs.fstatSync(fd, { bigint: true })
        );
        bytes = fs.readFileSync(fd);
        descriptorAfter = sourceStatIdentity(
            fs.fstatSync(fd, { bigint: true })
        );
    } finally {
        fs.closeSync(fd);
    }
    const after = fs.lstatSync(filePath, { bigint: true });
    const beforeIdentity = sourceStatIdentity(before);
    const afterIdentity = sourceStatIdentity(after);
    if (before.isSymbolicLink() || after.isSymbolicLink() ||
        !after.isFile() ||
        differingSourceIdentityFields(beforeIdentity, descriptorBefore, false).length ||
        differingSourceIdentityFields(descriptorBefore, descriptorAfter, false).length ||
        differingSourceIdentityFields(descriptorAfter, afterIdentity, false).length) {
        throw new Error(`${description} identity changed while reading`);
    }
    let payload;
    try {
        payload = JSON.parse(bytes.toString('utf8'));
    } catch (_) {
        throw new Error(`${description} is not valid JSON`);
    }
    return {
        payload,
        identity: afterIdentity,
    };
}

function sameLockDirectoryIdentity(observed, expected) {
    return Boolean(
        observed &&
        expected &&
        observed.type === 'directory' &&
        observed.identity.device === expected.device &&
        observed.identity.inode === expected.inode
    );
}

function assertOwnedProductionGpuLease(lockPath, lease) {
    if (!lease || lease.lockPath !== lockPath) {
        throw new Error('production GPU lease does not match the exact lock path');
    }
    if (lease.heartbeatError) {
        throw new Error(
            `production GPU lease heartbeat failed: ${lease.heartbeatError.message}`
        );
    }
    const observed = productionLockEvidence(lockPath);
    if (!sameLockDirectoryIdentity(observed, lease.lockIdentity)) {
        throw new Error('production GPU lease directory identity changed or disappeared');
    }
    const ownerRecord = stableJsonFile(
        path.join(lockPath, 'owner.json'),
        'production GPU lease owner'
    );
    const owner = ownerRecord.payload;
    if (owner.token !== lease.token ||
        owner.leaseGeneration !== lease.leaseGeneration ||
        Number(owner.pid) !== lease.pid ||
        Number(owner.workerStartTime) !== Number(lease.workerStartTime) ||
        owner.automaticStaleBreakDisabled !== true) {
        throw new Error('production GPU lease ownership changed');
    }
    const heartbeatRecord = stableJsonFile(
        path.join(lockPath, 'heartbeat.json'),
        'production GPU lease heartbeat'
    );
    const heartbeat = heartbeatRecord.payload;
    if (heartbeat.token !== lease.token ||
        heartbeat.leaseGeneration !== lease.leaseGeneration ||
        Number(heartbeat.pid) !== lease.pid) {
        throw new Error('production GPU lease heartbeat ownership changed');
    }
    if (lease.heartbeatFileIdentity &&
        differingSourceIdentityFields(
            lease.heartbeatFileIdentity,
            heartbeatRecord.identity,
            false
        ).length) {
        throw new Error('production GPU lease heartbeat file identity changed');
    }
    if (lease.heartbeatFd !== null &&
        lease.heartbeatFd !== undefined) {
        const descriptorIdentity = sourceStatIdentity(
            fs.fstatSync(lease.heartbeatFd, { bigint: true })
        );
        if (differingSourceIdentityFields(
            heartbeatRecord.identity, descriptorIdentity, false
        ).length) {
            throw new Error(
                'production GPU lease heartbeat descriptor was replaced'
            );
        }
    }
    const heartbeatTime = Date.parse(heartbeat.timestamp);
    const maximumHeartbeatAgeMs = Math.max(
        30000,
        Number(lease.heartbeatIntervalMs ||
            PRODUCTION_GPU_LEASE_HEARTBEAT_MS) * 3
    );
    if (!Number.isFinite(heartbeatTime) ||
        heartbeatTime > Date.now() + 5000 ||
        Date.now() - heartbeatTime > maximumHeartbeatAgeMs) {
        throw new Error('production GPU lease heartbeat is missing or stale');
    }
    return {
        owned: true,
        acquiredAt: lease.acquiredAt,
        ownerPid: lease.pid,
        ownerStartTime: lease.workerStartTime,
        tokenSha256: leaseTokenDigest(lease.token),
        leaseGenerationSha256: leaseTokenDigest(lease.leaseGeneration),
        lockIdentity: lease.lockIdentity,
        heartbeatAt: heartbeat.timestamp,
        automaticStaleBreakDisabled: true,
    };
}

function activateProductionGpuLeaseEnforcement(lease) {
    if (ACTIVE_PRODUCTION_GPU_LEASE !== null) {
        throw new Error('production GPU lease enforcement is already active');
    }
    assertOwnedProductionGpuLease(lease.lockPath, lease);
    ACTIVE_PRODUCTION_GPU_LEASE = lease;
    let disposed = false;
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            if (ACTIVE_PRODUCTION_GPU_LEASE !== lease) {
                throw new Error('production GPU lease enforcement ownership changed');
            }
            ACTIVE_PRODUCTION_GPU_LEASE = null;
        },
    };
}

function assertActiveProductionGpuLease() {
    if (ACTIVE_PRODUCTION_GPU_LEASE === null) {
        throw new Error(
            'refusing media tool use without active production GPU lease enforcement'
        );
    }
    return assertOwnedProductionGpuLease(
        ACTIVE_PRODUCTION_GPU_LEASE.lockPath,
        ACTIVE_PRODUCTION_GPU_LEASE
    );
}

function writeLeaseHeartbeat(lease) {
    assertOwnedProductionGpuLease(lease.lockPath, lease);
    const heartbeat = {
        token: lease.token,
        leaseGeneration: lease.leaseGeneration,
        pid: lease.pid,
        timestamp: new Date().toISOString(),
    };
    const bytes = Buffer.from(`${JSON.stringify(heartbeat, null, 2)}\n`);
    fs.ftruncateSync(lease.heartbeatFd, 0);
    let offset = 0;
    while (offset < bytes.length) {
        offset += fs.writeSync(
            lease.heartbeatFd,
            bytes,
            offset,
            bytes.length - offset,
            offset
        );
    }
    fs.fsyncSync(lease.heartbeatFd);
    lease.heartbeatFileIdentity = sourceStatIdentity(
        fs.fstatSync(lease.heartbeatFd, { bigint: true })
    );
    lease.heartbeatAt = heartbeat.timestamp;
    return heartbeat.timestamp;
}

function removeManagedLeaseDirectory(directoryPath, expectedIdentity) {
    const stat = fs.lstatSync(directoryPath, { bigint: true });
    const observed = {
        type: stat.isDirectory() && !stat.isSymbolicLink()
            ? 'directory' : 'other',
        identity: {
            device: String(stat.dev),
            inode: String(stat.ino),
        },
    };
    if (!sameLockDirectoryIdentity(observed, expectedIdentity)) {
        throw new Error('refusing to remove a changed GPU lease directory');
    }
    const allowed = new Set(['owner.json', 'heartbeat.json']);
    const entries = fs.readdirSync(directoryPath);
    for (const entry of entries) {
        if (!allowed.has(entry)) {
            throw new Error(
                `refusing to remove unexpected GPU lease entry ${entry}`
            );
        }
        const entryPath = path.join(directoryPath, entry);
        const entryStat = fs.lstatSync(entryPath);
        if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
            throw new Error(
                `refusing to remove non-file GPU lease entry ${entry}`
            );
        }
    }
    for (const entry of entries) {
        fs.unlinkSync(path.join(directoryPath, entry));
    }
    fs.rmdirSync(directoryPath);
}

function acquireProductionGpuLease(lockPath, options) {
    options = options || {};
    const resolved = path.resolve(lockPath);
    const configured = path.resolve(
        process.env.TDARR_GPU_PIPELINE_LOCK_DIR ||
            DEFAULT_PRODUCTION_GPU_LOCK_PATH
    );
    if (resolved !== lockPath || resolved !== configured) {
        throw new Error(
            'production GPU lock path must be canonical and exactly match ' +
            'the configured production lock'
        );
    }
    const parentPath = path.dirname(lockPath);
    const parentStat = fs.lstatSync(parentPath);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory() ||
        path.resolve(fs.realpathSync(parentPath)) !== path.resolve(parentPath)) {
        throw new Error(
            'production GPU lock parent must be an existing canonical non-symlink directory'
        );
    }
    try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
        if (error && error.code === 'EEXIST') {
            throw new Error(
                'production GPU lock already exists; refusing to steal or remove it'
            );
        }
        throw error;
    }
    const lockEvidence = productionLockEvidence(lockPath);
    if (!lockEvidence || lockEvidence.type !== 'directory') {
        throw new Error('new production GPU lease is not a directory');
    }
    const acquiredAt = new Date().toISOString();
    const pid = process.pid;
    const workerStartTime = getProcStartTime(pid, options.procRoot);
    if (process.platform === 'linux' && workerStartTime === null) {
        removeManagedLeaseDirectory(lockPath, lockEvidence.identity);
        throw new Error('could not authenticate production GPU lease owner PID');
    }
    const token = `denoise-trial-${crypto.randomBytes(32).toString('hex')}`;
    const leaseGeneration =
        `lease-${crypto.randomBytes(32).toString('hex')}`;
    const owner = {
        ownerId: 'denoise-retention-trial',
        workerName: 'standalone-denoise-retention-trial',
        filePath: 'tools/denoise-retention-trial.js',
        token,
        leaseGeneration,
        acquiredAt,
        heartbeatAt: acquiredAt,
        lockDir: lockPath,
        pid,
        workerStartTime,
        automaticStaleBreakDisabled: true,
    };
    const heartbeat = {
        token,
        leaseGeneration,
        pid,
        timestamp: acquiredAt,
    };
    let heartbeatFd = null;
    try {
        fs.writeFileSync(
            path.join(lockPath, 'owner.json'),
            `${JSON.stringify(owner, null, 2)}\n`,
            { encoding: 'utf8', mode: 0o600, flag: 'wx' }
        );
        fs.writeFileSync(
            path.join(lockPath, 'heartbeat.json'),
            `${JSON.stringify(heartbeat, null, 2)}\n`,
            { encoding: 'utf8', mode: 0o600, flag: 'wx' }
        );
        heartbeatFd = fs.openSync(
            path.join(lockPath, 'heartbeat.json'),
            Number(fs.constants.O_RDWR || 0) |
                Number(fs.constants.O_NOFOLLOW || 0)
        );
    } catch (error) {
        if (heartbeatFd !== null) {
            try { fs.closeSync(heartbeatFd); } catch (_) {}
        }
        try {
            removeManagedLeaseDirectory(lockPath, lockEvidence.identity);
        } catch (_) {
            // Leave an incomplete lock fail-closed rather than deleting
            // anything whose ownership cannot still be proven.
        }
        throw error;
    }
    const intervalMs = options.allowShortHeartbeatForTests === true
        ? Math.max(25, Number(options.heartbeatIntervalMs) || 25)
        : Math.max(
            PRODUCTION_GPU_LEASE_HEARTBEAT_MS,
            Number(options.heartbeatIntervalMs) ||
                PRODUCTION_GPU_LEASE_HEARTBEAT_MS
        );
    const lease = {
        lockPath,
        lockIdentity: lockEvidence.identity,
        token,
        leaseGeneration,
        acquiredAt,
        heartbeatAt: acquiredAt,
        pid,
        workerStartTime,
        heartbeatFd,
        heartbeatFileIdentity: sourceStatIdentity(
            fs.fstatSync(heartbeatFd, { bigint: true })
        ),
        heartbeatIntervalMs: intervalMs,
        heartbeatTimer: null,
        heartbeatError: null,
        registry: options.registry || ACTIVE_CHILD_REGISTRY,
    };
    assertOwnedProductionGpuLease(lockPath, lease);
    lease.heartbeatTimer = setInterval(() => {
        try {
            writeLeaseHeartbeat(lease);
        } catch (error) {
            lease.heartbeatError = error;
            clearInterval(lease.heartbeatTimer);
            lease.heartbeatTimer = null;
            if (lease.registry) {
                lease.registry.terminateAndWait('SIGTERM').catch(() => {});
            }
        }
    }, intervalMs);
    lease.heartbeatTimer.unref();
    return lease;
}

function releaseProductionGpuLease(lease, options) {
    options = options || {};
    const releasedAt = new Date().toISOString();
    if (!lease) {
        return { released: false, releasedAt, reason: 'missing lease' };
    }
    if (lease.heartbeatTimer) {
        clearInterval(lease.heartbeatTimer);
        lease.heartbeatTimer = null;
    }
    try {
        assertOwnedProductionGpuLease(lease.lockPath, lease);
    } catch (error) {
        if (lease.heartbeatFd !== null) {
            try { fs.closeSync(lease.heartbeatFd); } catch (_) {}
            lease.heartbeatFd = null;
        }
        return {
            released: false,
            releasedAt,
            reason: error.message,
            tokenSha256: leaseTokenDigest(lease.token),
            leaseGenerationSha256: leaseTokenDigest(lease.leaseGeneration),
        };
    }
    if (lease.heartbeatFd !== null) {
        fs.closeSync(lease.heartbeatFd);
        lease.heartbeatFd = null;
    }
    try {
        assertOwnedProductionGpuLease(lease.lockPath, lease);
        const retiredPath =
            `${lease.lockPath}.release.${Date.now()}.${process.pid}.` +
            crypto.randomBytes(8).toString('hex');
        fs.renameSync(lease.lockPath, retiredPath);
        try {
            if (typeof options.afterRename === 'function') {
                options.afterRename(retiredPath);
            }
            const retiredOwner = stableJsonFile(
                path.join(retiredPath, 'owner.json'),
                'retired production GPU lease owner'
            ).payload;
            if (retiredOwner.token !== lease.token ||
                retiredOwner.leaseGeneration !== lease.leaseGeneration ||
                Number(retiredOwner.pid) !== lease.pid ||
                Number(retiredOwner.workerStartTime) !==
                    Number(lease.workerStartTime) ||
                retiredOwner.automaticStaleBreakDisabled !== true) {
                throw new Error(
                    'retired production GPU lease ownership changed'
                );
            }
            const retiredHeartbeat = stableJsonFile(
                path.join(retiredPath, 'heartbeat.json'),
                'retired production GPU lease heartbeat'
            ).payload;
            if (retiredHeartbeat.token !== lease.token ||
                retiredHeartbeat.leaseGeneration !== lease.leaseGeneration ||
                Number(retiredHeartbeat.pid) !== lease.pid) {
                throw new Error(
                    'retired production GPU lease heartbeat ownership changed'
                );
            }
            removeManagedLeaseDirectory(retiredPath, lease.lockIdentity);
        } catch (error) {
            if (!fs.existsSync(lease.lockPath) && fs.existsSync(retiredPath)) {
                try { fs.renameSync(retiredPath, lease.lockPath); } catch (_) {}
            }
            throw error;
        }
        return {
            released: true,
            releasedAt,
            reason: 'token-generation-and-directory-identity-matched',
            tokenSha256: leaseTokenDigest(lease.token),
            leaseGenerationSha256: leaseTokenDigest(lease.leaseGeneration),
        };
    } catch (error) {
        return {
            released: false,
            releasedAt,
            reason: error.message,
            tokenSha256: leaseTokenDigest(lease.token),
            leaseGenerationSha256: leaseTokenDigest(lease.leaseGeneration),
        };
    }
}

function parseProcStat(statText, pid) {
    const text = String(statText || '');
    const close = text.lastIndexOf(')');
    if (close < 0) throw new Error(`malformed /proc/${pid}/stat`);
    const fields = text.slice(close + 1).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    if (!Number.isSafeInteger(ppid) || ppid < 0) {
        throw new Error(`malformed parent PID in /proc/${pid}/stat`);
    }
    return ppid;
}

function dangerousProcessReason(argv) {
    if (!Array.isArray(argv) || !argv.length) return null;
    const tokens = argv.map((value) => String(value).toLowerCase());
    const executable = path.posix.basename(tokens[0]);
    const command = tokens.join(' ');
    if (command.includes('tdarr-nvencc-knn-ffmpeg')) {
        return 'Tdarr NVEncC/FFmpeg coordinator';
    }
    if (/^nvencc(?:64)?(?:\.exe)?$/.test(executable) ||
        tokens.some((token) => /(?:^|\/)nvencc(?:64)?(?:\.exe)?$/.test(token))) {
        return 'NVEncC process';
    }
    if (/^grav1synth(?:\.exe)?$/.test(executable) ||
        command.includes('/grav1synth') ||
        command.includes('grain_pipeline_') ||
        command.includes('synthesizefilmgrain')) {
        return 'film-grain process';
    }
    if (command.includes('vmaf-v1-score') ||
        tokens.some((token) => /^vmaf-v1(?:\.py)?$/.test(path.posix.basename(token))) ||
        command.includes('libvmaf')) {
        return 'VMAF process';
    }
    if (/^(?:tdarr-)?ffmpeg(?:\.exe)?$/.test(executable) ||
        tokens.some((token, index) => index < 3 &&
            /(?:^|\/)(?:tdarr-)?ffmpeg(?:\.exe)?$/.test(token))) {
        return 'FFmpeg process';
    }
    if (/(?:av1|hevc|h264)_nvenc|libvmaf_cuda|hwupload_cuda|scale_cuda|_cuvid/.test(
        command
    )) {
        return 'GPU media command';
    }
    if (/(?:tdarr_node|tdarr-node|\/tdarr_node\/|\/tdarr\/)/.test(command) &&
        /(?:subworker|flowworker|worker|transcode|healthcheck.*(?:gpu|vmaf)|gpu-vmaf)/.test(
            command
        )) {
        return 'Tdarr worker process';
    }
    return null;
}

function readProcEntries(procRoot) {
    const root = procRoot || '/proc';
    let directories;
    try {
        directories = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
        throw new Error(`cannot enumerate ${root}: ${error.message}`);
    }
    const entries = [];
    const inspectionErrors = [];
    for (const directory of directories) {
        if (!directory.isDirectory() || !/^\d+$/.test(directory.name)) continue;
        const pid = Number(directory.name);
        const processDir = path.join(root, directory.name);
        try {
            const rawCmdline = fs.readFileSync(path.join(processDir, 'cmdline'));
            const argv = rawCmdline.toString('utf8').split('\0').filter(Boolean);
            if (!argv.length) continue;
            const ppid = parseProcStat(
                fs.readFileSync(path.join(processDir, 'stat'), 'utf8'), pid
            );
            entries.push({ pid, ppid, argv });
        } catch (error) {
            if (error && (error.code === 'ENOENT' || error.code === 'ESRCH')) {
                continue;
            }
            inspectionErrors.push({
                pid,
                error: String(error && error.message ? error.message : error),
            });
        }
    }
    if (inspectionErrors.length) {
        const detail = inspectionErrors.slice(0, 5)
            .map((item) => `pid ${item.pid}: ${item.error}`).join('; ');
        throw new Error(
            `process preflight could not inspect ${inspectionErrors.length} process(es): ${detail}`
        );
    }
    return entries;
}

function isSelfOrDescendant(pid, selfPid, byPid) {
    let cursor = pid;
    const seen = new Set();
    while (Number.isSafeInteger(cursor) && cursor > 0 && !seen.has(cursor)) {
        if (cursor === selfPid) return true;
        seen.add(cursor);
        const entry = byPid.get(cursor);
        if (!entry) return false;
        cursor = entry.ppid;
    }
    return false;
}

function conflictingProcesses(entries, selfPid, options) {
    options = options || {};
    const excludeDescendants = options.excludeDescendants !== false;
    const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
    const conflicts = [];
    for (const entry of entries) {
        if (entry.pid === selfPid ||
            (excludeDescendants &&
                isSelfOrDescendant(entry.pid, selfPid, byPid))) continue;
        const reason = dangerousProcessReason(entry.argv);
        if (!reason) continue;
        conflicts.push({
            pid: entry.pid,
            ppid: entry.ppid,
            executable: path.posix.basename(String(entry.argv[0] || 'unknown')),
            reason,
        });
    }
    return conflicts;
}

function assertFinalGpuProcessDrain(lease, options) {
    options = options || {};
    const registry = options.registry || ACTIVE_CHILD_REGISTRY;
    if (registry.size() !== 0) {
        throw new Error(
            `final GPU drain has ${registry.size()} registered child process(es)`
        );
    }
    const firstLease = assertOwnedProductionGpuLease(
        lease.lockPath, lease
    );
    const entries = options.entries ||
        readProcEntries(options.procRoot || '/proc');
    const selfPid = Number(options.selfPid || process.pid);
    const conflicts = conflictingProcesses(entries, selfPid, {
        excludeDescendants: false,
    });
    const secondLease = assertOwnedProductionGpuLease(
        lease.lockPath, lease
    );
    if (conflicts.length) {
        const detail = conflicts.slice(0, 10).map((item) =>
            `pid ${item.pid} ${item.executable} (${item.reason})`
        ).join(', ');
        throw new Error(
            `final GPU drain found ${conflicts.length} media process(es): ${detail}`
        );
    }
    return {
        checkedAt: new Date().toISOString(),
        inspectedProcessCount: entries.length,
        excludedPidOnly: selfPid,
        descendantsExcluded: false,
        registeredChildren: 0,
        conflicts: 0,
        leaseOwnedBeforeAndAfter: Boolean(firstLease && secondLease),
    };
}

function retainProductionGpuLease(lease, reason) {
    if (lease.heartbeatTimer) {
        clearInterval(lease.heartbeatTimer);
        lease.heartbeatTimer = null;
    }
    if (lease.heartbeatFd !== null) {
        try { fs.closeSync(lease.heartbeatFd); } catch (_) {}
        lease.heartbeatFd = null;
    }
    return {
        retained: true,
        released: false,
        retainedAt: new Date().toISOString(),
        reason: String(reason && reason.message ? reason.message : reason),
        automaticStaleBreakDisabled: true,
        tokenSha256: leaseTokenDigest(lease.token),
        leaseGenerationSha256: leaseTokenDigest(lease.leaseGeneration),
    };
}

function assertGpuQuiescent(lockPath, options) {
    options = options || {};
    const phase = String(options.phase || 'unspecified-boundary');
    const firstLock = productionLockEvidence(lockPath);
    let ownedLeaseEvidence = null;
    if (options.expectedLease) {
        ownedLeaseEvidence = assertOwnedProductionGpuLease(
            lockPath, options.expectedLease
        );
    } else if (firstLock) {
        throw new Error(
            `GPU quiescence preflight failed at ${phase}: production lock exists ` +
            `(${firstLock.type}) at ${firstLock.path}`
        );
    }
    const entries = options.entries || readProcEntries(options.procRoot || '/proc');
    const selfPid = Number(options.selfPid || process.pid);
    const conflicts = conflictingProcesses(entries, selfPid);
    const secondLock = productionLockEvidence(lockPath);
    if (options.expectedLease) {
        ownedLeaseEvidence = assertOwnedProductionGpuLease(
            lockPath, options.expectedLease
        );
    } else if (secondLock) {
        throw new Error(
            `GPU quiescence preflight failed at ${phase}: production lock appeared ` +
            `during inspection at ${secondLock.path}`
        );
    }
    if (conflicts.length) {
        const detail = conflicts.slice(0, 10).map((item) =>
            `pid ${item.pid} ${item.executable} (${item.reason})`
        ).join(', ');
        throw new Error(
            `GPU quiescence preflight failed at ${phase}: ` +
            `${conflicts.length} pre-existing media process(es): ${detail}`
        );
    }
    return {
        phase,
        checkedAt: new Date().toISOString(),
        productionGpuLockPath: lockPath,
        inspectedProcessCount: entries.length,
        excludedProcessTreeRootPid: selfPid,
        conflicts: 0,
        productionGpuLeaseOwned: Boolean(ownedLeaseEvidence),
        productionGpuLease: ownedLeaseEvidence,
    };
}

function recordGpuQuiescence(config, phase) {
    const result = assertGpuQuiescent(config.productionGpuLockPath, {
        phase,
        expectedLease: config.productionGpuLease,
    });
    if (Array.isArray(config.safetyChecks)) config.safetyChecks.push(result);
    return result;
}

async function probe(ffprobe, sourcePath) {
    const result = await runCommand(ffprobe, [
        '-v', 'error',
        '-show_entries',
        'stream=index,codec_type,width,height,pix_fmt,avg_frame_rate,r_frame_rate,color_range,color_space,color_transfer,color_primaries:stream_disposition=attached_pic',
        '-show_entries', 'format=duration',
        '-of', 'json', sourcePath,
    ], { timeoutMs: 30000 });
    const payload = JSON.parse(result.stdout);
    const videoStreams = (payload.streams || []).filter((candidate) =>
        candidate.codec_type === 'video'
    );
    const stream = videoStreams.find((candidate) =>
        candidate.codec_type === 'video' &&
        !(candidate.disposition && Number(candidate.disposition.attached_pic) === 1)
    );
    if (!stream) throw new Error('source has no primary video stream');
    const width = Number(stream.width);
    const height = Number(stream.height);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width < 16 || height < 16) {
        throw new Error('source has invalid video geometry');
    }
    return {
        stream,
        width,
        height,
        depth: outputDepth(stream),
        fps: frameRate(stream),
        durationSeconds: Number(payload.format && payload.format.duration),
        primaryStreamSpecifier: `v:${videoStreams.indexOf(stream)}`,
    };
}

async function packetBytes(ffprobe, inputPath, interval, timeoutMs, streamSpecifier) {
    const argv = ['-v', 'error'];
    if (interval) {
        argv.push(
            '-read_intervals',
            `${Number(interval.start).toFixed(6)}%+${Number(interval.duration).toFixed(6)}`
        );
    }
    argv.push(
        '-select_streams', streamSpecifier || 'v:0',
        '-show_entries', 'packet=size',
        '-of', 'csv=p=0',
        inputPath
    );
    const result = await runCommand(ffprobe, argv, { timeoutMs: timeoutMs || 30000 });
    return result.stdout.split(/\r?\n/).reduce((sum, line) => {
        const value = Number(String(line).trim().split(',')[0]);
        return Number.isFinite(value) && value >= 0 ? sum + value : sum;
    }, 0);
}

function expectedLumaByteCount(frames, width, height) {
    for (const [name, value] of [
        ['frames', frames],
        ['width', width],
        ['height', height],
    ]) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`luma ${name} must be a positive safe integer`);
        }
    }
    const frameBytes = width * height;
    const expectedBytes = frameBytes * frames;
    if (!Number.isSafeInteger(frameBytes) ||
        !Number.isSafeInteger(expectedBytes) ||
        expectedBytes <= 0) {
        throw new Error('expected luma byte count is unsafe');
    }
    return expectedBytes;
}

function readExactLumaFile(filePath, expectedBytes, description, fileSystem) {
    fileSystem = fileSystem || fs;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
        throw new Error('expected luma bytes must be a positive safe integer');
    }
    let stat;
    try {
        stat = fileSystem.lstatSync(filePath);
    } catch (error) {
        throw new Error(
            `${description} could not be inspected (${String(error.code || 'unknown')})`
        );
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`${description} must be a regular non-symlink file`);
    }
    if (stat.size !== expectedBytes) {
        throw new Error(
            `${description} byte count ${stat.size} does not equal expected ${expectedBytes}`
        );
    }
    const value = fileSystem.readFileSync(filePath);
    if (!Buffer.isBuffer(value) || value.length !== expectedBytes) {
        throw new Error(
            `${description} read length does not equal expected ${expectedBytes}`
        );
    }
    return value;
}

async function decodeExactLuma(options) {
    options = options || {};
    const expectedBytes = expectedLumaByteCount(
        options.frames, options.width, options.height
    );
    const runner = options.runCommandFn || runCommand;
    await runner(
        options.ffmpeg,
        buildLumaArgs(
            options.inputPath,
            options.outputPath,
            options.width,
            options.height,
            options.frames
        ),
        { timeoutMs: options.timeoutMs }
    );
    return {
        buffer: readExactLumaFile(
            options.outputPath,
            expectedBytes,
            options.description || 'decoded luma',
            options.fileSystem
        ),
        frames: options.frames,
        width: options.width,
        height: options.height,
        expectedBytes,
    };
}

function normalizeLumaExpectation(expectation) {
    if (!expectation || typeof expectation !== 'object') {
        throw new Error('luma evidence requires an exact frame/geometry expectation');
    }
    const frames = Number(expectation.frames);
    const width = Number(expectation.width);
    const height = Number(expectation.height);
    const expectedBytes = expectedLumaByteCount(frames, width, height);
    return {
        frames,
        width,
        height,
        frameBytes: width * height,
        expectedBytes,
    };
}

function bandEvidence(reference, distorted, expectation) {
    if (!Buffer.isBuffer(reference) || !Buffer.isBuffer(distorted)) {
        throw new Error('luma evidence inputs must be buffers');
    }
    const expected = normalizeLumaExpectation(expectation);
    if (reference.length !== expected.expectedBytes) {
        throw new Error(
            `reference luma byte count ${reference.length} does not equal expected ${expected.expectedBytes}`
        );
    }
    if (distorted.length !== expected.expectedBytes) {
        throw new Error(
            `distorted luma byte count ${distorted.length} does not equal expected ${expected.expectedBytes}`
        );
    }
    if (reference.length !== distorted.length) {
        throw new Error('luma evidence contains unpaired bytes');
    }
    const length = expected.expectedBytes;
    const bands = {};
    for (const band of LUMA_BANDS) {
        bands[band.key] = {
            minCode: band.min,
            maxCode: band.max,
            pixels: 0,
            absoluteErrorSum: 0,
            squaredErrorSum: 0,
            changedPixels: 0,
        };
    }
    for (let index = 0; index < length; index += 1) {
        const source = reference[index];
        const target = distorted[index];
        const band = LUMA_BANDS.find((candidate) =>
            source >= candidate.min && source <= candidate.max
        );
        const state = bands[band.key];
        const difference = Math.abs(source - target);
        state.pixels += 1;
        state.absoluteErrorSum += difference;
        state.squaredErrorSum += difference * difference;
        if (difference > 1) state.changedPixels += 1;
    }
    let totalSquared = 0;
    let totalAbsolute = 0;
    const summarized = {};
    for (const band of LUMA_BANDS) {
        const state = bands[band.key];
        totalSquared += state.squaredErrorSum;
        totalAbsolute += state.absoluteErrorSum;
        const mse = state.pixels ? state.squaredErrorSum / state.pixels : null;
        summarized[band.key] = {
            codeRange: [state.minCode, state.maxCode],
            pixels: state.pixels,
            mae: state.pixels ? state.absoluteErrorSum / state.pixels : null,
            psnr: mse === null ? null : (mse === 0 ? null :
                10 * Math.log10((255 * 255) / mse)),
            changedFraction: state.pixels ? state.changedPixels / state.pixels : null,
        };
    }
    const mse = totalSquared / length;
    return {
        analysisPixelFormat: 'gray8',
        expectedDecodedFrames: expected.frames,
        referenceDecodedFrames: reference.length / expected.frameBytes,
        distortedDecodedFrames: distorted.length / expected.frameBytes,
        decodedFrameBytes: expected.frameBytes,
        expectedLumaBytes: expected.expectedBytes,
        referenceLumaBytes: reference.length,
        distortedLumaBytes: distorted.length,
        exactDecodedEvidence: true,
        pairedPixels: length,
        unpairedReferenceBytes: 0,
        unpairedDistortedBytes: 0,
        mae: totalAbsolute / length,
        psnr: mse === 0 ? null : 10 * Math.log10((255 * 255) / mse),
        bands: summarized,
    };
}

function aggregateBandEvidence(clips) {
    const totals = {};
    for (const band of LUMA_BANDS) {
        totals[band.key] = {
            pixels: 0,
            weightedMae: 0,
            weightedChanged: 0,
        };
    }
    const exactDecodedEvidence = clips.length > 0 && clips.every((clip) => {
        const evidence = clip.bandEvidence || {};
        return evidence.exactDecodedEvidence === true &&
            evidence.unpairedReferenceBytes === 0 &&
            evidence.unpairedDistortedBytes === 0 &&
            Number.isSafeInteger(evidence.expectedDecodedFrames) &&
            evidence.expectedDecodedFrames > 0 &&
            evidence.referenceDecodedFrames === evidence.expectedDecodedFrames &&
            evidence.distortedDecodedFrames === evidence.expectedDecodedFrames &&
            Number.isSafeInteger(evidence.expectedLumaBytes) &&
            evidence.expectedLumaBytes > 0 &&
            evidence.referenceLumaBytes === evidence.expectedLumaBytes &&
            evidence.distortedLumaBytes === evidence.expectedLumaBytes &&
            evidence.pairedPixels === evidence.expectedLumaBytes;
    });
    let expectedLumaBytes = 0;
    let pairedPixels = 0;
    let expectedDecodedFrames = 0;
    let referenceDecodedFrames = 0;
    let distortedDecodedFrames = 0;
    for (const clip of clips) {
        expectedLumaBytes += Number(clip.bandEvidence.expectedLumaBytes) || 0;
        pairedPixels += Number(clip.bandEvidence.pairedPixels) || 0;
        expectedDecodedFrames +=
            Number(clip.bandEvidence.expectedDecodedFrames) || 0;
        referenceDecodedFrames +=
            Number(clip.bandEvidence.referenceDecodedFrames) || 0;
        distortedDecodedFrames +=
            Number(clip.bandEvidence.distortedDecodedFrames) || 0;
        for (const band of LUMA_BANDS) {
            const value = clip.bandEvidence.bands[band.key];
            totals[band.key].pixels += value.pixels;
            totals[band.key].weightedMae += (value.mae || 0) * value.pixels;
            totals[band.key].weightedChanged +=
                (value.changedFraction || 0) * value.pixels;
        }
    }
    const totalPixels = Object.values(totals).reduce(
        (sum, item) => sum + item.pixels, 0
    );
    const bands = {};
    const present = [];
    for (const band of LUMA_BANDS) {
        const value = totals[band.key];
        const share = totalPixels ? value.pixels / totalPixels : 0;
        if (value.pixels >= 1000 && share >= 0.005) present.push(band.key);
        bands[band.key] = {
            pixels: value.pixels,
            sourceShare: share,
            mae: value.pixels ? value.weightedMae / value.pixels : null,
            changedFraction: value.pixels
                ? value.weightedChanged / value.pixels : null,
        };
    }
    const passes = present.length >= 3 && present.includes('midtone') &&
        (present.includes('highlight') || present.includes('shadow'));
    return {
        bands,
        presentBands: present,
        passesMultipleLuminanceBands: passes,
        exactDecodedEvidence,
        expectedDecodedFrames,
        referenceDecodedFrames,
        distortedDecodedFrames,
        expectedLumaBytes,
        pairedPixels,
        unpairedReferenceBytes: clips.reduce(
            (sum, clip) => sum +
                (Number(clip.bandEvidence.unpairedReferenceBytes) || 0), 0
        ),
        unpairedDistortedBytes: clips.reduce(
            (sum, clip) => sum +
                (Number(clip.bandEvidence.unpairedDistortedBytes) || 0), 0
        ),
        policy:
            'exact expected gray8 bytes plus at least three bands including midtone and shadow or highlight',
    };
}

function remainingMs(deadline, cap) {
    const remaining = deadline - Date.now();
    if (remaining < 1000) {
        throw new Error('setting exceeded its twelve-minute wall budget');
    }
    return Math.min(remaining, cap);
}

function escapeFilterValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function pooledMetric(payload, name) {
    const metric = payload && payload.pooled_metrics && payload.pooled_metrics[name];
    if (!metric) return null;
    for (const key of ['mean', 'harmonic_mean', 'min']) {
        const value = Number(metric[key]);
        if (Number.isFinite(value)) return value;
    }
    return null;
}

async function measureVmafCambi(options) {
    const width = Math.min(options.width, METRIC_WIDTH_CAP);
    const height = Math.max(
        2, Math.floor((width * options.height / options.width) / 2) * 2
    );
    const format = options.depth === 10 ? 'yuv420p10le' : 'yuv420p';
    const attempts = [];
    for (const includeCambi of [true, false]) {
        const suffix = includeCambi ? 'vmaf-cambi' : 'vmaf';
        const logPath = path.join(options.outputDir, `${suffix}.json`);
        const filterOptions = [
            `log_fmt=json`,
            `log_path=${escapeFilterValue(logPath)}`,
            'n_threads=2',
        ];
        if (includeCambi) filterOptions.push('feature=name=cambi');
        const graph = [
            `[0:v]scale=${width}:${height}:flags=bicubic,format=${format},setpts=PTS-STARTPTS[dist]`,
            `[1:v]scale=${width}:${height}:flags=bicubic,format=${format},setpts=PTS-STARTPTS[ref]`,
            `[dist][ref]libvmaf=${filterOptions.join(':')}`,
        ].join(';');
        try {
            await runCommand(options.ffmpeg, [
                '-hide_banner', '-loglevel', 'error', '-nostdin',
                '-i', options.distortedPath,
                '-i', options.referencePath,
                '-lavfi', graph,
                '-f', 'null', '-',
            ], {
                timeoutMs: options.deadline
                    ? remainingMs(options.deadline, 60000)
                    : (options.timeoutMs || 60000),
            });
            const payload = JSON.parse(fs.readFileSync(logPath, 'utf8'));
            return {
                available: true,
                contract:
                    'trial-cpu-libvmaf-default-model-native-depth-bicubic-max1920-v1',
                analysisGeometry: { width, height, pixelFormat: format },
                vmaf: pooledMetric(payload, 'vmaf'),
                cambi: pooledMetric(payload, 'cambi'),
                cambiAvailable: includeCambi && pooledMetric(payload, 'cambi') !== null,
                attempts,
                log: path.basename(logPath),
            };
        } catch (error) {
            attempts.push({
                includeCambi,
                error: String(error.message || error).slice(-2000),
            });
        }
    }
    return {
        available: false,
        contract:
            'trial-cpu-libvmaf-default-model-native-depth-bicubic-max1920-v1',
        analysisGeometry: { width, height, pixelFormat: format },
        vmaf: null,
        cambi: null,
        cambiAvailable: false,
        attempts,
        log: null,
    };
}

function aggregateVariant(variantResult) {
    const totalOutputBytes = variantResult.clips.reduce(
        (sum, clip) => sum + clip.grainedVideoPacketBytes, 0
    );
    const totalContainerBytes = variantResult.clips.reduce(
        (sum, clip) => sum + clip.grainedContainerBytes, 0
    );
    const totalSourceEstimateBytes = variantResult.clips.reduce(
        (sum, clip) => sum + clip.originalSourceIntervalPacketBytesEstimate, 0
    );
    const vmafValues = variantResult.clips.map((clip) => clip.metrics.vmaf)
        .filter((value) => Number.isFinite(value));
    const cambiValues = variantResult.clips.map((clip) => clip.metrics.cambi)
        .filter((value) => Number.isFinite(value));
    const totalMetricClipCount = variantResult.clips.length;
    const lumaEvidence = aggregateBandEvidence(variantResult.clips);
    return {
        totalOutputVideoPacketBytes: totalOutputBytes,
        totalOutputContainerBytes: totalContainerBytes,
        totalOriginalSourceIntervalPacketBytesEstimate: totalSourceEstimateBytes,
        meanVmaf: totalMetricClipCount > 0 &&
            vmafValues.length === totalMetricClipCount
            ? vmafValues.reduce((sum, value) => sum + value, 0) / vmafValues.length
            : null,
        meanCambi: totalMetricClipCount > 0 &&
            cambiValues.length === totalMetricClipCount
            ? cambiValues.reduce((sum, value) => sum + value, 0) / cambiValues.length
            : null,
        metricClipCount: vmafValues.length,
        metricCoverage: {
            totalClipCount: totalMetricClipCount,
            vmafClipCount: vmafValues.length,
            cambiClipCount: cambiValues.length,
            vmafComplete: totalMetricClipCount > 0 &&
                vmafValues.length === totalMetricClipCount,
            cambiComplete: totalMetricClipCount > 0 &&
                cambiValues.length === totalMetricClipCount,
        },
        bandEvidence: lumaEvidence,
        exactDecodedEvidence: lumaEvidence.exactDecodedEvidence,
        settingWallMs: variantResult.settingWallMs,
    };
}

function pairedMetricEvidence(control, candidate, metricName) {
    const controlClips = Array.isArray(control && control.clips)
        ? control.clips : [];
    const candidateClips = Array.isArray(candidate && candidate.clips)
        ? candidate.clips : [];
    const controlById = new Map();
    const candidateById = new Map();
    let duplicateClipId = false;
    for (const clip of controlClips) {
        const clipId = String(clip && clip.clipId || '');
        if (!clipId || controlById.has(clipId)) duplicateClipId = true;
        controlById.set(clipId, clip);
    }
    for (const clip of candidateClips) {
        const clipId = String(clip && clip.clipId || '');
        if (!clipId || candidateById.has(clipId)) duplicateClipId = true;
        candidateById.set(clipId, clip);
    }
    const sameClipSet = !duplicateClipId &&
        controlById.size > 0 &&
        controlById.size === candidateById.size &&
        Array.from(controlById.keys()).every((clipId) =>
            candidateById.has(clipId)
        );
    if (!sameClipSet) {
        return {
            metric: metricName,
            status: 'clip_set_mismatch',
            totalClipCount: controlById.size,
            controlAvailableClipCount: 0,
            candidateAvailableClipCount: 0,
            pairedAvailableClipCount: 0,
            pairedUnavailableClipCount: 0,
            asymmetricAvailabilityClipCount: 0,
            invalidMetricRecordClipCount: 0,
            controlMean: null,
            candidateMean: null,
        };
    }

    const controlValues = [];
    const candidateValues = [];
    let pairedUnavailable = 0;
    let asymmetricAvailability = 0;
    let invalidMetricRecord = 0;
    let controlAvailable = 0;
    let candidateAvailable = 0;
    for (const [clipId, controlClip] of controlById.entries()) {
        const candidateClip = candidateById.get(clipId);
        const controlMetrics = controlClip && controlClip.metrics;
        const candidateMetrics = candidateClip && candidateClip.metrics;
        const controlDeclared = Boolean(controlMetrics) &&
            Object.prototype.hasOwnProperty.call(controlMetrics, metricName);
        const candidateDeclared = Boolean(candidateMetrics) &&
            Object.prototype.hasOwnProperty.call(candidateMetrics, metricName);
        if (!controlDeclared || !candidateDeclared) {
            invalidMetricRecord += 1;
            continue;
        }
        const controlValue = controlMetrics[metricName];
        const candidateValue = candidateMetrics[metricName];
        const hasControl = Number.isFinite(controlValue);
        const hasCandidate = Number.isFinite(candidateValue);
        if (hasControl) controlAvailable += 1;
        if (hasCandidate) candidateAvailable += 1;
        if (hasControl && hasCandidate) {
            controlValues.push(controlValue);
            candidateValues.push(candidateValue);
        } else if (!hasControl && !hasCandidate) {
            pairedUnavailable += 1;
        } else {
            asymmetricAvailability += 1;
        }
    }
    const totalClipCount = controlById.size;
    const complete = controlValues.length === totalClipCount;
    const unavailable = pairedUnavailable === totalClipCount;
    const status = complete ? 'complete'
        : (unavailable ? 'unavailable' : 'partial_or_asymmetric');
    return {
        metric: metricName,
        status,
        totalClipCount,
        controlAvailableClipCount: controlAvailable,
        candidateAvailableClipCount: candidateAvailable,
        pairedAvailableClipCount: controlValues.length,
        pairedUnavailableClipCount: pairedUnavailable,
        asymmetricAvailabilityClipCount: asymmetricAvailability,
        invalidMetricRecordClipCount: invalidMetricRecord,
        controlMean: complete
            ? controlValues.reduce((sum, value) => sum + value, 0) /
                totalClipCount
            : null,
        candidateMean: complete
            ? candidateValues.reduce((sum, value) => sum + value, 0) /
                totalClipCount
            : null,
    };
}

function aggregateHasExactDecodedEvidence(aggregate) {
    const evidence = aggregate && aggregate.bandEvidence;
    return Boolean(
        aggregate &&
        aggregate.exactDecodedEvidence === true &&
        evidence &&
        evidence.exactDecodedEvidence === true &&
        Number.isSafeInteger(evidence.expectedDecodedFrames) &&
        evidence.expectedDecodedFrames > 0 &&
        evidence.referenceDecodedFrames === evidence.expectedDecodedFrames &&
        evidence.distortedDecodedFrames === evidence.expectedDecodedFrames &&
        Number.isSafeInteger(evidence.expectedLumaBytes) &&
        evidence.expectedLumaBytes > 0 &&
        evidence.pairedPixels === evidence.expectedLumaBytes &&
        evidence.unpairedReferenceBytes === 0 &&
        evidence.unpairedDistortedBytes === 0
    );
}

function settingIsAvailable(result) {
    return Boolean(
        result &&
        result.status !== 'setting_unavailable' &&
        result.aggregate
    );
}

function unavailableVariantDecision(control, candidate) {
    const controlAvailable = settingIsAvailable(control);
    const candidateAvailable = settingIsAvailable(candidate);
    const metricEvidence = {
        vmaf: {
            metric: 'vmaf',
            status: 'setting_unavailable',
            totalClipCount: 0,
            controlAvailableClipCount: 0,
            candidateAvailableClipCount: 0,
            pairedAvailableClipCount: 0,
            pairedUnavailableClipCount: 0,
            asymmetricAvailabilityClipCount: 0,
            invalidMetricRecordClipCount: 0,
            controlMean: null,
            candidateMean: null,
        },
        cambi: {
            metric: 'cambi',
            status: 'setting_unavailable',
            totalClipCount: 0,
            controlAvailableClipCount: 0,
            candidateAvailableClipCount: 0,
            pairedAvailableClipCount: 0,
            pairedUnavailableClipCount: 0,
            asymmetricAvailabilityClipCount: 0,
            invalidMetricRecordClipCount: 0,
            controlMean: null,
            candidateMean: null,
        },
    };
    const gates = {
        exactDecodedEvidence: false,
        materialSizeSaving: false,
        smallerThanSourceIntervalEstimate: false,
        vmafNotMateriallyWorse: false,
        cambiNotMateriallyWorse: false,
        luminanceBandErrorBounded: false,
        multipleLuminanceBandsCovered: false,
    };
    return {
        variantKey: candidate.variant.key,
        denoiseId: candidate.variant.denoiseId,
        referenceContractId: candidate.variant.referenceContractId,
        savingVsControlPct: null,
        savingVsOriginalSourceIntervalEstimatePct: null,
        vmafDropVsControl: null,
        cambiIncreaseVsControl: null,
        bandMaeIncreasePctVsControl: Object.fromEntries(
            LUMA_BANDS.map((band) => [band.key, null])
        ),
        zeroControlBandRegressions: [],
        maxBandMaeIncreasePctVsControl: null,
        metricEvidence,
        metricEvidenceComplete: false,
        settingAvailability: {
            control: controlAvailable ? 'available' : 'setting_unavailable',
            controlReasonCode: controlAvailable
                ? null
                : String(control.unavailable && control.unavailable.reasonCode ||
                    'grain_fit_unavailable'),
            candidate: candidateAvailable ? 'available' : 'setting_unavailable',
            candidateReasonCode: candidateAvailable
                ? null
                : String(candidate.unavailable && candidate.unavailable.reasonCode ||
                    'grain_fit_unavailable'),
            candidateControlReasonCode: candidateAvailable
                ? null
                : (candidate.unavailable &&
                    candidate.unavailable.controlReasonCode || null),
        },
        gates,
        objectiveScreenPass: false,
        decision: 'setting_unavailable_no_denoise_conclusion',
        productionPromotionAuthorized: false,
        manualChecksRequired: [],
    };
}

function evaluateVariants(variantResults, thresholds) {
    const control = variantResults.find((item) => item.variant.key === 's008-control');
    if (!control) throw new Error('control result is missing');
    return variantResults.filter((item) => item.variant.role !== 'production-control')
        .map((candidate) => {
            if (!settingIsAvailable(control) || !settingIsAvailable(candidate)) {
                return unavailableVariantDecision(control, candidate);
            }
            const controlBytes = control.aggregate.totalOutputVideoPacketBytes;
            const candidateBytes = candidate.aggregate.totalOutputVideoPacketBytes;
            const savingPct = controlBytes > 0
                ? (controlBytes - candidateBytes) / controlBytes * 100 : null;
            const sourceEstimateBytes =
                candidate.aggregate.totalOriginalSourceIntervalPacketBytesEstimate;
            const savingVsSourceEstimatePct = sourceEstimateBytes > 0
                ? (sourceEstimateBytes - candidateBytes) / sourceEstimateBytes * 100
                : null;
            const vmafEvidence = pairedMetricEvidence(
                control, candidate, 'vmaf'
            );
            const cambiEvidence = pairedMetricEvidence(
                control, candidate, 'cambi'
            );
            const vmafDrop = vmafEvidence.status === 'complete'
                ? vmafEvidence.controlMean - vmafEvidence.candidateMean : null;
            const cambiIncrease = cambiEvidence.status === 'complete'
                ? cambiEvidence.candidateMean - cambiEvidence.controlMean : null;
            const bandIncreases = {};
            const zeroControlBandRegressions = [];
            let completeBandComparisons = 0;
            let maxBandIncrease = null;
            for (const band of LUMA_BANDS) {
                const baseline = control.aggregate.bandEvidence.bands[band.key].mae;
                const observed = candidate.aggregate.bandEvidence.bands[band.key].mae;
                let increase = null;
                if (Number.isFinite(baseline) && baseline >= 0 &&
                    Number.isFinite(observed) && observed >= 0) {
                    completeBandComparisons += 1;
                    if (baseline === 0) {
                        if (observed === 0) {
                            increase = 0;
                        } else {
                            zeroControlBandRegressions.push(band.key);
                        }
                    } else {
                        increase = (observed - baseline) / baseline * 100;
                    }
                }
                bandIncreases[band.key] = increase;
                if (Number.isFinite(increase)) {
                    maxBandIncrease = maxBandIncrease === null
                        ? increase : Math.max(maxBandIncrease, increase);
                }
            }
            const gates = {
                exactDecodedEvidence:
                    aggregateHasExactDecodedEvidence(control.aggregate) &&
                    aggregateHasExactDecodedEvidence(candidate.aggregate),
                materialSizeSaving: Number.isFinite(savingPct) &&
                    savingPct >= thresholds.minimumControlSavingPct,
                smallerThanSourceIntervalEstimate:
                    Number.isFinite(savingVsSourceEstimatePct) &&
                    savingVsSourceEstimatePct >=
                        thresholds.minimumSourceEstimateSavingPct,
                vmafNotMateriallyWorse:
                    vmafEvidence.status === 'unavailable' ||
                    (vmafEvidence.status === 'complete' &&
                        vmafDrop <= thresholds.maximumVmafDrop),
                cambiNotMateriallyWorse:
                    cambiEvidence.status === 'unavailable' ||
                    (cambiEvidence.status === 'complete' &&
                        cambiIncrease <= thresholds.maximumCambiIncrease),
                luminanceBandErrorBounded:
                    completeBandComparisons === LUMA_BANDS.length &&
                    zeroControlBandRegressions.length === 0 &&
                    maxBandIncrease !== null &&
                    maxBandIncrease <= thresholds.maximumBandMaeIncreasePct,
                multipleLuminanceBandsCovered:
                    candidate.aggregate.bandEvidence.passesMultipleLuminanceBands,
            };
            const objectiveScreenPass = Object.values(gates).every(Boolean);
            return {
                variantKey: candidate.variant.key,
                denoiseId: candidate.variant.denoiseId,
                referenceContractId: candidate.variant.referenceContractId,
                savingVsControlPct: savingPct,
                savingVsOriginalSourceIntervalEstimatePct:
                    savingVsSourceEstimatePct,
                vmafDropVsControl: vmafDrop,
                cambiIncreaseVsControl: cambiIncrease,
                bandMaeIncreasePctVsControl: bandIncreases,
                zeroControlBandRegressions,
                maxBandMaeIncreasePctVsControl: maxBandIncrease,
                metricEvidence: {
                    vmaf: vmafEvidence,
                    cambi: cambiEvidence,
                },
                metricEvidenceComplete:
                    vmafEvidence.status === 'complete' &&
                    (cambiEvidence.status === 'complete' ||
                        cambiEvidence.status === 'unavailable'),
                gates,
                objectiveScreenPass,
                decision: objectiveScreenPass
                    ? 'manual_visual_review_required'
                    : 'reject_or_retest_different_clips',
                productionPromotionAuthorized: false,
                manualChecksRequired: [
                    'inspect 100-percent crops/contact sheets for waxy faces or texture loss',
                    'inspect dark and shadow detail for smearing or crushed texture',
                    'inspect midtones and highlights for halos and edge damage',
                    'inspect gradients for new banding',
                    'inspect reconstructed grain for pumping, swimming, or mismatch',
                ],
            };
        });
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function atomicJson(filePath, payload) {
    const temporary = `${filePath}.partial-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
    });
    fs.renameSync(temporary, filePath);
}

function statNanoseconds(stat, directName, millisecondName) {
    if (typeof stat[directName] === 'bigint') return String(stat[directName]);
    const milliseconds = Number(stat[millisecondName]);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new Error(`source stat is missing ${directName}`);
    }
    return String(BigInt(Math.round(milliseconds * 1000000)));
}

function sourceStatIdentity(stat) {
    if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
        throw new Error('source identity requires a regular file');
    }
    const sizeBigInt = typeof stat.size === 'bigint'
        ? stat.size : BigInt(stat.size);
    if (sizeBigInt < 1n || sizeBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('source size is outside the supported safe-integer range');
    }
    return {
        device: String(stat.dev),
        inode: String(stat.ino),
        sizeBytes: Number(sizeBigInt),
        mtimeNs: statNanoseconds(stat, 'mtimeNs', 'mtimeMs'),
        ctimeNs: statNanoseconds(stat, 'ctimeNs', 'ctimeMs'),
    };
}

function differingSourceIdentityFields(left, right, includeHash) {
    const fields = ['device', 'inode', 'sizeBytes', 'mtimeNs', 'ctimeNs'];
    if (includeHash) fields.push('sha256');
    return fields.filter((field) =>
        !left || !right || String(left[field]) !== String(right[field])
    );
}

function assertSameSourceIdentity(before, after, description) {
    const changed = differingSourceIdentityFields(before, after, true);
    if (changed.length) {
        throw new Error(
            `${description || 'source'} changed during the trial ` +
            `(identity fields: ${changed.join(', ')})`
        );
    }
    return true;
}

async function fullSourceIdentity(sourcePath, options) {
    options = options || {};
    const promises = options.promises || fs.promises;
    const constants = options.constants || fs.constants;
    const registry = options.registry || ACTIVE_CHILD_REGISTRY;
    const chunkBytes = options.chunkBytes || 4 * 1024 * 1024;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 4096 ||
        chunkBytes > 64 * 1024 * 1024) {
        throw new Error('source hash chunkBytes must be from 4096 to 67108864');
    }

    const lexicalPath = path.resolve(sourcePath);
    const realBefore = path.resolve(await promises.realpath(sourcePath));
    if (realBefore !== lexicalPath) {
        throw new Error('source identity path has a symlinked or ambiguous canonical path');
    }
    const pathStatBefore = await promises.lstat(sourcePath, { bigint: true });
    if (pathStatBefore.isSymbolicLink() || !pathStatBefore.isFile()) {
        throw new Error('source identity requires a regular non-symlink file');
    }

    const noFollow = Number(constants.O_NOFOLLOW || 0);
    const openFlags = Number(constants.O_RDONLY || 0) | noFollow;
    const handle = await promises.open(sourcePath, openFlags);
    let descriptorBefore;
    let descriptorAfter;
    let digest;
    let totalBytes = 0;
    try {
        descriptorBefore = sourceStatIdentity(
            await handle.stat({ bigint: true })
        );
        const pathBefore = sourceStatIdentity(pathStatBefore);
        const openChanged = differingSourceIdentityFields(
            pathBefore, descriptorBefore, false
        );
        if (openChanged.length) {
            throw new Error(
                'source identity changed while opening the file ' +
                `(identity fields: ${openChanged.join(', ')})`
            );
        }

        const hash = crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(chunkBytes);
        while (true) {
            if (registry && typeof registry.isShuttingDown === 'function' &&
                registry.isShuttingDown()) {
                throw new Error('source hashing interrupted by signal cleanup');
            }
            const read = await handle.read(buffer, 0, buffer.length, null);
            if (!read.bytesRead) break;
            hash.update(buffer.subarray(0, read.bytesRead));
            totalBytes += read.bytesRead;
            if (!Number.isSafeInteger(totalBytes)) {
                throw new Error('source hash byte count exceeded safe integer range');
            }
        }
        digest = hash.digest('hex');
        descriptorAfter = sourceStatIdentity(
            await handle.stat({ bigint: true })
        );
    } finally {
        await handle.close();
    }

    const descriptorChanged = differingSourceIdentityFields(
        descriptorBefore, descriptorAfter, false
    );
    if (descriptorChanged.length ||
        totalBytes !== descriptorBefore.sizeBytes) {
        throw new Error(
            'source changed while computing its full SHA-256 identity'
        );
    }
    const pathStatAfter = await promises.lstat(sourcePath, { bigint: true });
    if (pathStatAfter.isSymbolicLink() || !pathStatAfter.isFile()) {
        throw new Error('source path changed after hashing');
    }
    const realAfter = path.resolve(await promises.realpath(sourcePath));
    const pathAfter = sourceStatIdentity(pathStatAfter);
    const pathChanged = differingSourceIdentityFields(
        descriptorAfter, pathAfter, false
    );
    if (realAfter !== realBefore || pathChanged.length) {
        throw new Error('source path identity changed while hashing');
    }
    return Object.assign({
        scheme: 'sha256-full-open-descriptor-v1',
        sha256: digest,
        bytesHashed: totalBytes,
    }, descriptorAfter);
}

function authenticateJsonBytes(reference, bytes, description) {
    const label = description || 'authenticated JSON';
    if (!Buffer.isBuffer(bytes)) {
        throw new Error(`${label} bytes must be a Buffer`);
    }
    if (bytes.length !== reference.sizeBytes) {
        throw new Error(`${label} size does not match its authenticated reference`);
    }
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== reference.sha256) {
        throw new Error(`${label} SHA-256 does not match its authenticated reference`);
    }
    let payload;
    try {
        payload = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new Error(`${label} is not valid JSON`);
    }
    return payload;
}

function validateProvenanceReceipt(payload, caseSpec, nvencQualityProfile) {
    exactObjectKeys(payload, [
        'schema',
        'kind',
        'case_id',
        'source_sha256',
        'source_size_bytes',
        'cq',
        'nvenc_quality_profile',
        'retained_original',
        'job_decision',
        'profile_evidence',
        'reviewed_evidence_artifacts',
    ], 'provenance receipt');
    if (payload.schema !== PROVENANCE_RECEIPT_SCHEMA) {
        throw new Error(
            `provenance receipt schema must be ${PROVENANCE_RECEIPT_SCHEMA}`
        );
    }
    if (payload.kind !== PROVENANCE_RECEIPT_KIND) {
        throw new Error(`provenance receipt kind must be ${PROVENANCE_RECEIPT_KIND}`);
    }
    if (safeId(payload.case_id, 'provenance receipt case_id') !== caseSpec.caseId) {
        throw new Error('provenance receipt case_id does not match the case');
    }
    const receiptSourceSha256 = sha256Hex(
        payload.source_sha256, 'provenance receipt source_sha256'
    );
    const receiptSourceSizeBytes = positiveSafeInteger(
        payload.source_size_bytes, 'provenance receipt source_size_bytes'
    );
    if (receiptSourceSha256 !== caseSpec.expectedSourceSha256 ||
        receiptSourceSizeBytes !== caseSpec.expectedSourceSizeBytes) {
        throw new Error('provenance receipt source identity does not match the case');
    }
    if (typeof payload.cq !== 'number') {
        throw new Error('provenance receipt cq must be an integer');
    }
    const receiptCq = finiteNumber(payload.cq, 'provenance receipt cq');
    if (!Number.isInteger(receiptCq) || receiptCq !== caseSpec.cq) {
        throw new Error('provenance receipt CQ does not match the case');
    }
    if (payload.nvenc_quality_profile !== nvencQualityProfile) {
        throw new Error('provenance receipt NVENC profile does not match the input');
    }
    if (payload.retained_original !== true ||
        payload.job_decision !== 'no_feasible_parameters') {
        throw new Error(
            'provenance receipt must prove a retained-original no_feasible_parameters job'
        );
    }
    const requiredProfileEvidence = nvencQualityProfile === 'enhanced'
        ? 'explicit-enhanced' : 'explicit-baseline';
    if (payload.profile_evidence !== requiredProfileEvidence) {
        throw new Error(
            'provenance receipt profile evidence does not prove the selected profile'
        );
    }
    if (!Array.isArray(payload.reviewed_evidence_artifacts) ||
        payload.reviewed_evidence_artifacts.length <
            MIN_REVIEWED_EVIDENCE_ARTIFACTS ||
        payload.reviewed_evidence_artifacts.length >
            MAX_REVIEWED_EVIDENCE_ARTIFACTS) {
        throw new Error(
            `provenance receipt must bind ${MIN_REVIEWED_EVIDENCE_ARTIFACTS}-` +
            `${MAX_REVIEWED_EVIDENCE_ARTIFACTS} reviewed evidence artifacts`
        );
    }
    const artifactIds = new Set();
    const artifactIdentities = new Set();
    const artifacts = payload.reviewed_evidence_artifacts.map((entry, index) => {
        exactObjectKeys(
            entry,
            ['artifact_id', 'sha256', 'size_bytes'],
            `provenance receipt artifact[${index}]`
        );
        const artifactId = safeId(
            entry.artifact_id,
            `provenance receipt artifact[${index}].artifact_id`
        );
        const artifactSha256 = sha256Hex(
            entry.sha256,
            `provenance receipt artifact[${index}].sha256`
        );
        const artifactSizeBytes = positiveSafeInteger(
            entry.size_bytes,
            `provenance receipt artifact[${index}].size_bytes`
        );
        const identity = `${artifactSha256}:${artifactSizeBytes}`;
        if (artifactIds.has(artifactId) || artifactIdentities.has(identity)) {
            throw new Error('provenance receipt contains duplicate evidence artifacts');
        }
        artifactIds.add(artifactId);
        artifactIdentities.add(identity);
        return {
            artifactId,
            sha256: artifactSha256,
            sizeBytes: artifactSizeBytes,
        };
    });
    return {
        schema: PROVENANCE_RECEIPT_SCHEMA,
        kind: PROVENANCE_RECEIPT_KIND,
        caseId: caseSpec.caseId,
        sourceSha256: receiptSourceSha256,
        sourceSizeBytes: receiptSourceSizeBytes,
        cq: receiptCq,
        nvencQualityProfile,
        retainedOriginal: true,
        jobDecision: 'no_feasible_parameters',
        profileEvidence: requiredProfileEvidence,
        reviewedEvidenceArtifacts: artifacts,
    };
}

async function readAuthenticatedProvenanceReceipt(
    caseSpec, nvencQualityProfile, options
) {
    options = options || {};
    const promises = options.promises || fs.promises;
    const constants = options.constants || fs.constants;
    const reference = caseSpec.provenanceReceipt;
    const lexicalPath = path.resolve(reference.path);
    const realBefore = path.resolve(await promises.realpath(reference.path));
    if (realBefore !== lexicalPath) {
        throw new Error('provenance receipt path has a symlinked or ambiguous path');
    }
    const pathStatBefore = await promises.lstat(reference.path, { bigint: true });
    if (pathStatBefore.isSymbolicLink() || !pathStatBefore.isFile()) {
        throw new Error('provenance receipt must be a regular non-symlink file');
    }
    const pathBefore = sourceStatIdentity(pathStatBefore);
    if (pathBefore.sizeBytes !== reference.sizeBytes ||
        pathBefore.sizeBytes > MAX_PROVENANCE_RECEIPT_BYTES) {
        throw new Error('provenance receipt size is invalid or unauthenticated');
    }

    const noFollow = Number(constants.O_NOFOLLOW || 0);
    const openFlags = Number(constants.O_RDONLY || 0) | noFollow;
    const handle = await promises.open(reference.path, openFlags);
    let descriptorBefore;
    let descriptorAfter;
    let bytes;
    try {
        descriptorBefore = sourceStatIdentity(await handle.stat({ bigint: true }));
        if (differingSourceIdentityFields(
            pathBefore, descriptorBefore, false
        ).length) {
            throw new Error('provenance receipt changed while opening');
        }
        bytes = Buffer.alloc(descriptorBefore.sizeBytes);
        let offset = 0;
        while (offset < bytes.length) {
            const read = await handle.read(
                bytes, offset, bytes.length - offset, offset
            );
            if (!read.bytesRead) break;
            offset += read.bytesRead;
        }
        if (offset !== bytes.length) {
            throw new Error('provenance receipt was truncated while reading');
        }
        descriptorAfter = sourceStatIdentity(await handle.stat({ bigint: true }));
    } finally {
        await handle.close();
    }
    if (differingSourceIdentityFields(
        descriptorBefore, descriptorAfter, false
    ).length) {
        throw new Error('provenance receipt changed while reading');
    }
    const pathStatAfter = await promises.lstat(reference.path, { bigint: true });
    const realAfter = path.resolve(await promises.realpath(reference.path));
    const pathAfter = sourceStatIdentity(pathStatAfter);
    if (pathStatAfter.isSymbolicLink() || !pathStatAfter.isFile() ||
        realAfter !== realBefore ||
        differingSourceIdentityFields(
            descriptorAfter, pathAfter, false
        ).length) {
        throw new Error('provenance receipt path identity changed while reading');
    }
    const payload = authenticateJsonBytes(
        reference, bytes, 'provenance receipt'
    );
    return validateProvenanceReceipt(
        payload, caseSpec, nvencQualityProfile
    );
}

function assertExpectedSourceIdentity(caseSpec, identity) {
    if (!identity ||
        identity.sha256 !== caseSpec.expectedSourceSha256 ||
        identity.sizeBytes !== caseSpec.expectedSourceSizeBytes ||
        identity.bytesHashed !== caseSpec.expectedSourceSizeBytes) {
        throw new Error(
            `${caseSpec.caseId} source does not match its expected authenticated identity`
        );
    }
    return true;
}

async function toolVersion(executable, argv) {
    const result = await runCommand(executable, argv, { timeoutMs: 15000 });
    const firstLine = String(result.stdout || result.stderr)
        .split(/\r?\n/)[0].trim();
    if (!firstLine) {
        throw new Error(
            `${path.basename(executable)} did not emit version identity`
        );
    }
    return firstLine;
}

async function prepareCase(config, caseSpec, caseDir, media) {
    const prepared = [];
    for (const clip of caseSpec.clips) {
        const clipDir = path.join(caseDir, 'source-clips', clip.clipId);
        fs.mkdirSync(clipDir, { recursive: true, mode: 0o700 });
        const sourceClip = path.join(clipDir, 'source-lossless.mkv');
        const sourceLuma = path.join(clipDir, 'source-luma-gray8.raw');
        const frames = Math.max(1, Math.round(clip.durationSeconds * media.fps));
        await runCommand(config.tools.ffmpeg, buildExtractArgs({
            sourcePath: caseSpec.sourcePath,
            outputPath: sourceClip,
            timestampSeconds: clip.timestampSeconds,
            frames,
            depth: media.depth,
            stream: media.stream,
            streamSpecifier: media.primaryStreamSpecifier,
        }), { timeoutMs: 120000 });
        const lumaHeight = Math.max(
            2, Math.floor((LUMA_WIDTH * media.height / media.width) / 2) * 2
        );
        const sourceDecode = await decodeExactLuma({
            ffmpeg: config.tools.ffmpeg,
            inputPath: sourceClip,
            outputPath: sourceLuma,
            width: LUMA_WIDTH,
            height: lumaHeight,
            frames,
            timeoutMs: 60000,
            description: `${caseSpec.caseId}/${clip.clipId} source luma`,
        });
        prepared.push({
            clipId: clip.clipId,
            timestampSeconds: clip.timestampSeconds,
            durationSeconds: clip.durationSeconds,
            reviewNote: clip.reviewNote,
            cropX: clip.cropX,
            cropY: clip.cropY,
            frames,
            sourceClip,
            sourceLuma,
            expectedLumaBytes: sourceDecode.expectedBytes,
            lumaGeometry: { width: LUMA_WIDTH, height: lumaHeight },
            originalSourceIntervalPacketBytesEstimate: await packetBytes(
                config.tools.ffprobe,
                caseSpec.sourcePath,
                { start: clip.timestampSeconds, duration: clip.durationSeconds },
                30000,
                media.primaryStreamSpecifier
            ),
        });
    }
    return prepared;
}

function publishBytesAtomically(filePath, bytes, fileSystem) {
    fileSystem = fileSystem || fs;
    if (!Buffer.isBuffer(bytes) || bytes.length < 1) {
        throw new Error('atomic publication requires non-empty bytes');
    }
    if (fileSystem.existsSync(filePath)) {
        throw new Error(`refusing to replace existing atomic output ${filePath}`);
    }
    const temporary = `${filePath}.partial-${process.pid}-` +
        crypto.randomBytes(8).toString('hex');
    let descriptor = null;
    try {
        fileSystem.writeFileSync(temporary, bytes, {
            mode: 0o600,
            flag: 'wx',
        });
        descriptor = fileSystem.openSync(temporary, 'r+');
        fileSystem.fsyncSync(descriptor);
        fileSystem.closeSync(descriptor);
        descriptor = null;
        fileSystem.renameSync(temporary, filePath);
    } catch (error) {
        if (descriptor !== null) {
            try { fileSystem.closeSync(descriptor); } catch (_) {}
        }
        try { fileSystem.unlinkSync(temporary); } catch (_) {}
        throw error;
    }
    const published = fileSystem.readFileSync(filePath);
    if (!Buffer.isBuffer(published) || !published.equals(bytes)) {
        throw new Error('atomically published grain table changed byte identity');
    }
    return {
        sizeBytes: published.length,
        sha256: crypto.createHash('sha256').update(published).digest('hex'),
    };
}

function serializedGrainSegments(segments) {
    return segments.map((segment) => ({
        start: segment.start.toString(),
        end: segment.end.toString(),
    }));
}

function grainFitUnavailableDisposition(fitPlan, attempts) {
    const records = Array.isArray(attempts) ? attempts : [];
    const failureSummary = {
        candidateCount: Array.isArray(fitPlan && fitPlan.candidates)
            ? fitPlan.candidates.length : 0,
        attemptedCount: records.length,
        semanticRejectionCount: records.filter((attempt) =>
            attempt && [
                'rejected_non_global_table',
                'rejected_empty_grain',
            ].includes(attempt.status)
        ).length,
        malformedTableFailureCount: records.filter((attempt) =>
            attempt && attempt.status === 'failed_invalid_table'
        ).length,
        runtimeFailureCount: records.filter((attempt) =>
            attempt && attempt.status === 'failed'
        ).length,
    };
    let reasonCode;
    if (failureSummary.candidateCount < 1) {
        reasonCode = 'grain_synthesis_insufficient_flat_support';
    } else if (failureSummary.malformedTableFailureCount > 0) {
        reasonCode = 'grain_synthesis_invalid_table_output';
    } else if (failureSummary.runtimeFailureCount > 0 ||
        failureSummary.attemptedCount !== failureSummary.candidateCount) {
        reasonCode = 'grain_synthesis_fit_runtime_failure';
    } else if (failureSummary.semanticRejectionCount ===
        failureSummary.candidateCount) {
        reasonCode = 'grain_synthesis_static_model_unrepresentable';
    } else {
        reasonCode = 'grain_synthesis_fit_runtime_failure';
    }
    return { reasonCode, failureSummary };
}

async function fitVariantGlobalGrainTable(
    config, caseSpec, media, variantDir, variant, fitPlan, deadline, options
) {
    options = options || {};
    const commandRunner = options.runCommandFn || runCommand;
    const pipelineRunner = options.runPipelineFn || runPipeline;
    const identityReader = options.fullSourceIdentityFn || fullSourceIdentity;
    const grainTable = path.join(variantDir, 'grain-table.txt');
    const fitRoot = path.join(variantDir, 'grain-fit-candidates');
    fs.mkdirSync(fitRoot, { recursive: false, mode: 0o700 });
    const selection = {
        method: fitPlan.method,
        requestedFrames: fitPlan.requestedFrames,
        requestedCandidateLimit: fitPlan.requestedCandidateLimit,
        clipSeconds: fitPlan.clipSeconds,
        sourceDurationSeconds: fitPlan.sourceDurationSeconds,
        proxyWidth: fitPlan.proxyWidth,
        proxyHeight: fitPlan.proxyHeight,
        proxyFrames: fitPlan.proxyFrames,
        proxyPositionCount: fitPlan.proxyPositionCount,
        candidates: fitPlan.candidates,
        proxyEvidence: fitPlan.proxyEvidence,
        attempts: [],
    };
    let selectedFit = null;
    for (const candidate of fitPlan.candidates.slice(
        0, GRAIN_FIT_MAX_CANDIDATES
    )) {
        const candidateDir = path.join(
            fitRoot, `candidate-${String(candidate.rank)}`
        );
        fs.mkdirSync(candidateDir, { recursive: false, mode: 0o700 });
        const sourceClip = path.join(candidateDir, 'source-lossless-144.mkv');
        const denoisedClip = path.join(candidateDir, 'denoised-lossless-144.mkv');
        const candidateTable = path.join(candidateDir, 'grain-table.txt');
        const producerLog = path.join(candidateDir, 'nvencc-diagnostics.log');
        const attempt = {
            rank: candidate.rank,
            startSeconds: candidate.startSeconds,
            status: 'started',
        };
        selection.attempts.push(attempt);
        try {
            try {
                await commandRunner(config.tools.ffmpeg, buildExtractArgs({
                    sourcePath: caseSpec.sourcePath,
                    outputPath: sourceClip,
                    timestampSeconds: candidate.startSeconds,
                    frames: GRAIN_FIT_FRAMES,
                    depth: media.depth,
                    stream: media.stream,
                    streamSpecifier: String(media.stream.index),
                }), { timeoutMs: remainingMs(deadline, 120000) });
                const producerArgs = buildProducerArgs({
                    sourcePath: sourceClip,
                    frames: GRAIN_FIT_FRAMES,
                    depth: media.depth,
                    variant,
                });
                const consumerArgs = buildDenoiseConsumerArgs({
                    outputPath: denoisedClip,
                    frames: GRAIN_FIT_FRAMES,
                    depth: media.depth,
                    stream: media.stream,
                });
                const pipeline = await pipelineRunner(
                    config.tools.nvencc,
                    producerArgs,
                    config.tools.ffmpeg,
                    consumerArgs,
                    { timeoutMs: remainingMs(deadline, 150000) }
                );
                fs.writeFileSync(producerLog, pipeline.producerStderr, {
                    encoding: 'utf8',
                    mode: 0o600,
                    flag: 'wx',
                });
                await commandRunner(config.tools.grav1synth, [
                    'diff', sourceClip, denoisedClip,
                    '-o', candidateTable, '-y',
                ], {
                    timeoutMs: remainingMs(deadline, GRAIN_DIFF_TIMEOUT_MS),
                });
                const sourceIdentity = await identityReader(sourceClip);
                const denoisedIdentity = await identityReader(denoisedClip);
                attempt.sourceClipSha256 = sourceIdentity.sha256;
                attempt.sourceClipSizeBytes = sourceIdentity.sizeBytes;
                attempt.denoisedClipSha256 = denoisedIdentity.sha256;
                attempt.denoisedClipSizeBytes = denoisedIdentity.sizeBytes;
            } catch (error) {
                attempt.status = 'failed';
                attempt.reason =
                    String(error && error.message || error).slice(0, 1024);
                continue;
            }

            const tableBytes = fs.readFileSync(candidateTable);
            let segments;
            try {
                segments = grainTableSegments(tableBytes.toString('utf8'));
            } catch (error) {
                attempt.status = 'failed_invalid_table';
                attempt.reason =
                    String(error && error.message || error).slice(0, 1024);
                continue;
            }
            attempt.segments = serializedGrainSegments(segments);
            attempt.semanticGrain = hasSemanticGrainTable(
                tableBytes.toString('utf8')
            );
            if (segments.length !== 1 ||
                segments[0].start !== 0n ||
                segments[0].end !== DIRECT_GLOBAL_GRAIN_END) {
                attempt.status = 'rejected_non_global_table';
                continue;
            }
            if (!attempt.semanticGrain) {
                attempt.status = 'rejected_empty_grain';
                continue;
            }
            assertDirectGlobalGrainTable(tableBytes.toString('utf8'));
            const published = publishBytesAtomically(grainTable, tableBytes);
            attempt.status = 'selected';
            attempt.tableSha256 = published.sha256;
            attempt.tableSizeBytes = published.sizeBytes;
            selectedFit = Object.freeze({
                candidateRank: candidate.rank,
                startSeconds: candidate.startSeconds,
                frames: GRAIN_FIT_FRAMES,
                sizeBytes: published.sizeBytes,
                sha256: published.sha256,
            });
        } finally {
            fs.rmSync(candidateDir, { recursive: true, force: true });
        }
        if (selectedFit) break;
    }
    try { fs.rmdirSync(fitRoot); } catch (_) {}
    if (!selectedFit) {
        const unavailable = grainFitUnavailableDisposition(
            fitPlan, selection.attempts
        );
        return {
            status: 'setting_unavailable',
            reasonCode: unavailable.reasonCode,
            failureSummary: unavailable.failureSummary,
            tablePath: null,
            grainFit: null,
            selection,
        };
    }
    return {
        status: 'available',
        reasonCode: null,
        tablePath: grainTable,
        grainFit: selectedFit,
        selection,
    };
}

async function runVariant(
    config, caseSpec, caseDir, media, preparedClips, variant, fitPlan
) {
    const settingStarted = Date.now();
    const deadline = settingStarted + SETTING_WALL_MS;
    const variantDir = path.join(caseDir, variant.key);
    fs.mkdirSync(variantDir, { recursive: true, mode: 0o700 });
    const result = {
        variant: {
            key: variant.key,
            strength: variant.strength,
            role: variant.role,
            settings: variant.settings,
            denoiseId: variant.denoiseId,
            referenceContractId: variant.referenceContractId,
            grainContractId: variant.grainContractId,
            productionCanonical: variant.productionCanonical,
        },
        clips: [],
        settingWallBudgetMs: SETTING_WALL_MS,
    };
    const fit = await fitVariantGlobalGrainTable(
        config, caseSpec, media, variantDir, variant, fitPlan, deadline
    );
    result.status = fit.status;
    result.grainFit = fit.grainFit;
    result.grainFitSelection = fit.selection;
    if (fit.status !== 'available') {
        result.unavailable = {
            reasonCode: fit.reasonCode,
            failureSummary: fit.failureSummary,
            denoiseConclusion: 'withheld',
            tableContractRelaxed: false,
        };
        result.settingWallMs = Date.now() - settingStarted;
        result.aggregate = null;
        return result;
    }
    const grainTable = fit.tablePath;
    const grainFit = fit.grainFit;
    for (const prepared of preparedClips) {
        const clipDir = path.join(variantDir, prepared.clipId);
        fs.mkdirSync(clipDir, { recursive: true, mode: 0o700 });
        const denoised = path.join(clipDir, 'denoised-lossless.mkv');
        const producerArgs = buildProducerArgs({
            sourcePath: prepared.sourceClip,
            frames: prepared.frames,
            depth: media.depth,
            variant,
        });
        const consumerArgs = buildDenoiseConsumerArgs({
            outputPath: denoised,
            frames: prepared.frames,
            depth: media.depth,
            stream: media.stream,
        });
        const pipeline = await runPipeline(
            config.tools.nvencc, producerArgs,
            config.tools.ffmpeg, consumerArgs,
            { timeoutMs: remainingMs(deadline, 150000) }
        );
        fs.writeFileSync(
            path.join(clipDir, 'nvencc-diagnostics.log'),
            pipeline.producerStderr,
            { encoding: 'utf8', mode: 0o600, flag: 'wx' }
        );

        const tableBytes = fs.readFileSync(grainTable);
        const tableSha256 =
            crypto.createHash('sha256').update(tableBytes).digest('hex');
        if (tableBytes.length !== grainFit.sizeBytes ||
            tableSha256 !== grainFit.sha256) {
            throw new Error('variant-level global grain table changed between clips');
        }

        const encoded = path.join(clipDir, 'av1-pre-grain.mkv');
        await runCommand(config.tools.ffmpeg, buildEncodeArgs({
            inputPath: denoised,
            outputPath: encoded,
            depth: media.depth,
            cq: caseSpec.cq,
            profile: config.nvencQualityProfile,
            stream: media.stream,
        }), { timeoutMs: remainingMs(deadline, 120000) });

        const grained = path.join(clipDir, 'av1-grav1synth.mkv');
        await runCommand(config.tools.grav1synth, [
            'apply', '-y', '-g', grainTable, '-o', grained, encoded,
        ], { timeoutMs: remainingMs(deadline, 90000) });
        await runCommand(config.tools.ffmpeg, [
            '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-i', grained, '-map', '0:v:0', '-f', 'null', '-',
        ], { timeoutMs: remainingMs(deadline, 90000) });

        const distortedLuma = path.join(clipDir, 'distorted-luma-gray8.raw');
        const distortedDecode = await decodeExactLuma({
            ffmpeg: config.tools.ffmpeg,
            inputPath: grained,
            outputPath: distortedLuma,
            width: prepared.lumaGeometry.width,
            height: prepared.lumaGeometry.height,
            frames: prepared.frames,
            timeoutMs: remainingMs(deadline, 60000),
            description:
                `${caseSpec.caseId}/${prepared.clipId}/${variant.key} distorted luma`,
        });
        const evidence = bandEvidence(
            readExactLumaFile(
                prepared.sourceLuma, prepared.expectedLumaBytes,
                `${caseSpec.caseId}/${prepared.clipId} source luma`
            ),
            distortedDecode.buffer,
            {
                frames: prepared.frames,
                width: prepared.lumaGeometry.width,
                height: prepared.lumaGeometry.height,
            }
        );
        fs.unlinkSync(distortedLuma);

        const sheet = path.join(clipDir, 'comparison-source-top-trial-bottom.png');
        const cropWidth = Math.min(640, media.width);
        const cropHeight = Math.min(360, media.height);
        const cropX = prepared.cropX === null
            ? Math.floor((media.width - cropWidth) / 2) : prepared.cropX;
        const cropY = prepared.cropY === null
            ? Math.floor((media.height - cropHeight) / 2) : prepared.cropY;
        await runCommand(config.tools.ffmpeg, buildContactSheetArgs(
            prepared.sourceClip, grained, sheet, prepared.frames, {
                width: cropWidth,
                height: cropHeight,
                x: cropX,
                y: cropY,
            }
        ), { timeoutMs: remainingMs(deadline, 45000) });

        const preGrainVideoPacketBytes = await packetBytes(
            config.tools.ffprobe, encoded, null, remainingMs(deadline, 30000)
        );
        const grainedVideoPacketBytes = await packetBytes(
            config.tools.ffprobe, grained, null, remainingMs(deadline, 30000)
        );
        const metrics = await measureVmafCambi({
            ffmpeg: config.tools.ffmpeg,
            distortedPath: grained,
            referencePath: prepared.sourceClip,
            outputDir: clipDir,
            width: media.width,
            height: media.height,
            depth: media.depth,
            deadline,
        });
        result.clips.push({
            clipId: prepared.clipId,
            timestampSeconds: prepared.timestampSeconds,
            durationSeconds: prepared.durationSeconds,
            reviewNote: prepared.reviewNote,
            reviewCrop: {
                width: cropWidth,
                height: cropHeight,
                x: cropX,
                y: cropY,
                scale: '1:1-source-pixels',
            },
            frames: prepared.frames,
            originalSourceIntervalPacketBytesEstimate:
                prepared.originalSourceIntervalPacketBytesEstimate,
            preGrainVideoPacketBytes,
            grainedVideoPacketBytes,
            grainedContainerBytes: fs.statSync(grained).size,
            tableBytes: grainFit.sizeBytes,
            grainFitCandidateRank: grainFit.candidateRank,
            grainFitStartSeconds: grainFit.startSeconds,
            bandEvidence: evidence,
            metrics,
            contactSheet: path.relative(caseDir, sheet).replace(/\\/g, '/'),
        });
    }
    result.settingWallMs = Date.now() - settingStarted;
    result.aggregate = aggregateVariant(result);
    return result;
}

function skippedVariantForUnavailableControl(variant, controlResult) {
    if (!controlResult || controlResult.status !== 'setting_unavailable') {
        throw new Error('stronger setting skip requires an unavailable control result');
    }
    const controlReasonCode = String(
        controlResult.unavailable && controlResult.unavailable.reasonCode ||
        'grain_fit_unavailable'
    );
    return {
        variant: {
            key: variant.key,
            strength: variant.strength,
            role: variant.role,
            settings: variant.settings,
            denoiseId: variant.denoiseId,
            referenceContractId: variant.referenceContractId,
            grainContractId: variant.grainContractId,
            productionCanonical: variant.productionCanonical,
        },
        status: 'setting_unavailable',
        clips: [],
        settingWallBudgetMs: SETTING_WALL_MS,
        settingWallMs: 0,
        grainFit: null,
        grainFitSelection: null,
        aggregate: null,
        unavailable: {
            reasonCode: 'control_setting_unavailable',
            controlReasonCode,
            denoiseConclusion: 'withheld',
            tableContractRelaxed: false,
            skipped: true,
            skippedWithoutGpuWork: true,
        },
    };
}

async function runConfiguredVariants(
    config, caseSpec, caseDir, media, prepared, fitPlan, options
) {
    options = options || {};
    const variantRunner = options.runVariantFn || runVariant;
    const quiescenceRecorder =
        options.recordGpuQuiescenceFn || recordGpuQuiescence;
    const results = [];
    let unavailableControl = null;
    for (const variant of config.variants) {
        if (unavailableControl &&
            variant.role !== 'production-control') {
            results.push(skippedVariantForUnavailableControl(
                variant, unavailableControl
            ));
            continue;
        }
        quiescenceRecorder(
            config, `before-setting:${caseSpec.caseId}:${variant.key}`
        );
        const result = await variantRunner(
            config, caseSpec, caseDir, media, prepared, variant, fitPlan
        );
        results.push(result);
        quiescenceRecorder(
            config, `after-setting:${caseSpec.caseId}:${variant.key}`
        );
        if (variant.role === 'production-control' &&
            result.status === 'setting_unavailable') {
            unavailableControl = result;
        }
    }
    return results;
}

async function runCase(config, caseSpec, outputDir, authenticatedCase) {
    const caseDir = path.join(outputDir, caseSpec.caseId);
    fs.mkdirSync(caseDir, { recursive: true, mode: 0o700 });
    const sourceStat = fs.lstatSync(caseSpec.sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`${caseSpec.caseId} source must be a regular non-symlink file`);
    }
    if (!authenticatedCase || !authenticatedCase.sourceIdentity ||
        !authenticatedCase.provenance) {
        throw new Error(`${caseSpec.caseId} is missing authenticated preflight evidence`);
    }
    canonicalSourceFile(caseSpec.sourcePath, `${caseSpec.caseId} source`, fs);
    const currentStatIdentity = sourceStatIdentity(
        fs.lstatSync(caseSpec.sourcePath, { bigint: true })
    );
    if (differingSourceIdentityFields(
        authenticatedCase.sourceIdentity, currentStatIdentity, false
    ).length) {
        throw new Error(
            `${caseSpec.caseId} source identity changed after authenticated preflight`
        );
    }
    const sourceIdentityBefore = authenticatedCase.sourceIdentity;
    const media = await probe(config.tools.ffprobe, caseSpec.sourcePath);
    if (!Number.isFinite(media.durationSeconds) || media.durationSeconds <= 0) {
        throw new Error(`${caseSpec.caseId} source duration is unavailable`);
    }
    for (const clip of caseSpec.clips) {
        if (clip.timestampSeconds + clip.durationSeconds > media.durationSeconds + 0.001) {
            throw new Error(
                `${caseSpec.caseId}/${clip.clipId} extends beyond source duration`
            );
        }
        const cropWidth = Math.min(640, media.width);
        const cropHeight = Math.min(360, media.height);
        if ((clip.cropX !== null && clip.cropX + cropWidth > media.width) ||
            (clip.cropY !== null && clip.cropY + cropHeight > media.height)) {
            throw new Error(
                `${caseSpec.caseId}/${clip.clipId} review crop exceeds source geometry`
            );
        }
    }
    const prepared = await prepareCase(config, caseSpec, caseDir, media);
    recordGpuQuiescence(
        config, `before-grain-fit-selection:${caseSpec.caseId}`
    );
    const fitPlan = await buildProductionGrainFitPlan(
        config, caseSpec, media
    );
    recordGpuQuiescence(
        config, `after-grain-fit-selection:${caseSpec.caseId}`
    );
    const variants = await runConfiguredVariants(
        config, caseSpec, caseDir, media, prepared, fitPlan
    );
    for (const clip of prepared) {
        try { fs.unlinkSync(clip.sourceLuma); } catch (_) {}
    }
    const sourceIdentityAfter = await fullSourceIdentity(caseSpec.sourcePath);
    assertSameSourceIdentity(
        sourceIdentityBefore,
        sourceIdentityAfter,
        `${caseSpec.caseId} source`
    );
    return {
        caseId: caseSpec.caseId,
        sourcePath: caseSpec.sourcePath,
        sourceIdentity: {
            stable: true,
            before: sourceIdentityBefore,
            after: sourceIdentityAfter,
        },
        provenance: {
            authenticated: true,
            receiptSchema: authenticatedCase.provenance.schema,
            receiptKind: authenticatedCase.provenance.kind,
            receiptSha256: caseSpec.provenanceReceipt.sha256,
            receiptSizeBytes: caseSpec.provenanceReceipt.sizeBytes,
            reviewedEvidenceArtifactCount:
                authenticatedCase.provenance.reviewedEvidenceArtifacts.length,
        },
        cq: caseSpec.cq,
        nvencQualityProfile: config.nvencQualityProfile,
        media: {
            width: media.width,
            height: media.height,
            depth: media.depth,
            fps: media.fps,
            durationSeconds: media.durationSeconds,
            pixelFormat: media.stream.pix_fmt,
            colorPrimaries: media.stream.color_primaries || null,
            colorTransfer: media.stream.color_transfer || null,
            colorSpace: media.stream.color_space || null,
        },
        variants,
        decisions: evaluateVariants(variants, config.thresholds),
    };
}

function renderReviewHtml(report) {
    const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
    const rows = [];
    for (const caseResult of report.cases) {
        rows.push(`<h2>${escape(caseResult.caseId)}</h2>`);
        rows.push(
            '<p>Each sheet has the lossless source on top and the trial output below. ' +
            'Review at 100% scale.</p>'
        );
        for (const variant of caseResult.variants) {
            rows.push(
                `<h3>${escape(variant.variant.key)} — ${escape(variant.variant.referenceContractId)}</h3>`
            );
            if (variant.status === 'setting_unavailable') {
                const reason = String(
                    variant.unavailable && variant.unavailable.reasonCode ||
                    'grain_fit_unavailable'
                );
                const explanation = reason === 'control_setting_unavailable'
                    ? 'Skipped without GPU work because the 0.08 control was unavailable.'
                    : (reason === 'grain_synthesis_static_model_unrepresentable'
                        ? 'All bounded candidates were semantically rejected; no direct global grain model was representable.'
                        : 'The bounded grain fit was unavailable because selection, tool execution, timeout, or table validation did not complete successfully.');
                rows.push(
                    '<p><strong>Setting unavailable:</strong> ' +
                    `${escape(explanation)} No denoise conclusion is available ` +
                    'for this setting.</p>'
                );
                continue;
            }
            for (const clip of variant.clips) {
                const sheet = `${encodeURIComponent(caseResult.caseId)}/` +
                    `${encodeURIComponent(variant.variant.key)}/` +
                    `${encodeURIComponent(clip.clipId)}/` +
                    'comparison-source-top-trial-bottom.png';
                rows.push(
                    `<figure><figcaption>${escape(clip.clipId)} at ` +
                    `${escape(clip.timestampSeconds)}s; ${escape(clip.reviewNote)}</figcaption>` +
                    `<img src="${sheet}" loading="lazy"></figure>`
                );
            }
        }
    }
    return [
        '<!doctype html><meta charset="utf-8">',
        '<title>Denoise retention trial review</title>',
        '<style>body{font-family:sans-serif;max-width:1940px;margin:2rem auto;background:#111;color:#eee}' +
        'img{max-width:100%;height:auto;border:1px solid #555}figure{margin:1rem 0 3rem}' +
        'code{word-break:break-all}</style>',
        '<h1>Denoise retention trial — manual review required</h1>',
        '<p>No result on this page authorizes a production setting change.</p>',
        rows.join('\n'),
    ].join('\n');
}

async function reauthenticateAuthenticatedSources(config, authenticatedCases) {
    const evidence = [];
    const reauthenticationRegistry = {
        isShuttingDown: () => false,
    };
    for (const caseSpec of config.cases) {
        const authenticated = authenticatedCases.get(caseSpec.caseId);
        if (!authenticated) continue;
        if (ACTIVE_PRODUCTION_GPU_LEASE !== null) {
            assertActiveProductionGpuLease();
        }
        const observed = await fullSourceIdentity(caseSpec.sourcePath, {
            registry: reauthenticationRegistry,
        });
        assertSameSourceIdentity(
            authenticated.sourceIdentity,
            observed,
            `${caseSpec.caseId} source`
        );
        evidence.push({
            caseId: caseSpec.caseId,
            stable: true,
            sha256: observed.sha256,
            sizeBytes: observed.sizeBytes,
            device: observed.device,
            inode: observed.inode,
            mtimeNs: observed.mtimeNs,
            ctimeNs: observed.ctimeNs,
        });
        if (ACTIVE_PRODUCTION_GPU_LEASE !== null) {
            assertActiveProductionGpuLease();
        }
    }
    return evidence;
}

function appendExecutionError(primary, secondary, label) {
    if (!secondary) return primary;
    const detail = String(
        secondary && secondary.message ? secondary.message : secondary
    );
    if (!primary) {
        return new Error(`${label}: ${detail}`);
    }
    const combined = new Error(
        `${primary.message}; ${label}: ${detail}`
    );
    combined.cause = primary;
    return combined;
}

async function execute(cli) {
    if (!cli.nodeDrained) {
        throw new Error(
            '--node-drained is required after verifying the paused node has zero active workers'
        );
    }
    const inputPath = absolutePath(cli.input, '--input');
    const outputPath = absolutePath(cli.output, '--output');
    const config = normalizeConfig(readJson(inputPath));
    const outputPolicy = validateOutputPolicy(config, outputPath);
    const resolvedOutput = outputPolicy.resolvedOutput;
    const startupSafety = assertGpuQuiescent(config.productionGpuLockPath, {
        phase: 'startup-before-authenticated-preflight',
    });
    const authenticatedCases = new Map();
    let lease = null;
    let leaseEnforcement = null;
    let toolEnforcement = null;
    let authenticatedTools = null;
    let finalToolIdentities = null;
    let finalSourceIdentities = null;
    let finalDrain = null;
    let leaseDisposition = null;
    let report = null;
    let outputCreated = false;
    let executionError = null;
    let cleanupSafetyError = null;
    const startedAt = new Date().toISOString();
    try {
        lease = acquireProductionGpuLease(config.productionGpuLockPath, {
            registry: ACTIVE_CHILD_REGISTRY,
        });
        config.productionGpuLease = lease;
        leaseEnforcement = activateProductionGpuLeaseEnforcement(lease);
        const acquiredLeaseEvidence = assertOwnedProductionGpuLease(
            config.productionGpuLockPath, lease
        );
        const postAcquireSafety = assertGpuQuiescent(
            config.productionGpuLockPath,
            {
                phase: 'startup-after-lease-acquisition',
                expectedLease: lease,
            }
        );
        authenticatedTools = authenticateConfiguredTools(config);
        toolEnforcement = activateAuthenticatedTools(authenticatedTools);
        const versions = {
            ffmpeg: await toolVersion(config.tools.ffmpeg, ['-version']),
            ffprobe: await toolVersion(config.tools.ffprobe, ['-version']),
            nvencc: await toolVersion(config.tools.nvencc, ['--version']),
            grav1synth: await toolVersion(
                config.tools.grav1synth, ['--version']
            ),
        };
        for (const caseSpec of config.cases) {
            assertActiveProductionGpuLease();
            const provenance = await readAuthenticatedProvenanceReceipt(
                caseSpec, config.nvencQualityProfile
            );
            const sourceIdentity = await fullSourceIdentity(caseSpec.sourcePath);
            assertExpectedSourceIdentity(caseSpec, sourceIdentity);
            assertActiveProductionGpuLease();
            authenticatedCases.set(caseSpec.caseId, {
                provenance,
                sourceIdentity,
            });
        }
        const beforeOutputSafety = assertGpuQuiescent(
            config.productionGpuLockPath,
            {
                phase: 'startup-before-output',
                expectedLease: lease,
            }
        );
        fs.mkdirSync(resolvedOutput, { mode: 0o700 });
        outputCreated = true;
        config.safetyChecks = [
            startupSafety,
            postAcquireSafety,
            beforeOutputSafety,
        ];
        report = {
            schema: SCHEMA,
            purpose: 'sample-only-increased-denoise-retention-screen',
            startedAt,
            mediaCompletedAt: null,
            completedAt: null,
            productionMutation: false,
            tdarrApiCalls: 0,
            databaseWrites: 0,
            restartPerformed: false,
            nodeDrainAcknowledged: true,
            constraints: {
                nvencEncoder: 'av1_nvenc',
                nvencPreset: 'p7',
                nvencTemporalFilter: 'disabled-tf0',
                grav1synthRequired: true,
                grainFitSelectionMethod:
                    'flat-mid-luma-no-cut-proxy-ranking-v1',
                grainFitFrames: GRAIN_FIT_FRAMES,
                grainFitMaximumCandidates: GRAIN_FIT_MAX_CANDIDATES,
                grainFitProxyPositions: GRAIN_PROXY_POSITION_COUNT,
                grainTableTransformation: 'none-byte-identical-direct-output',
                strongerSettingsRequireAvailableControl: true,
                maximumStrength: 0.14,
                defaultStrengths: [0.08, 0.10, 0.12],
                perSettingWallBudgetMs: SETTING_WALL_MS,
                maximumCaseClipSeconds: MAX_CASE_CLIP_SECONDS,
                manualVisualReviewAlwaysRequired: true,
                productionGpuLockPath: config.productionGpuLockPath,
                productionGpuLeaseHeldForAllMediaWork: true,
                productionGpuLeaseAutomaticStaleBreakDisabled: true,
                procCmdlinePreflight: true,
                boundaryRechecks:
                    'owned-lease-before-and-after-every-executed-case-setting-and-spawn',
                privateOutputRoot: outputPolicy.privateOutputRoot,
                outputContainedByPrivateRoot: true,
                protectedRootsValidated: true,
                exactDecodedFrameAndLumaBytesRequired: true,
                unpairedLumaBytesAllowed: 0,
                sourceIdentity:
                    'expected-full-sha256-size-plus-open-descriptor-before-and-after',
                provenanceReceipt:
                    'authenticated-schema-1-receipt-before-output-creation',
                executableIdentity:
                    'expected-sha256-size-resolved-descriptor-wrapper-closure-v1',
                partialMetricCoverageAllowed: false,
                activeChildSignalCleanup: ['SIGINT', 'SIGTERM'],
            },
            thresholds: config.thresholds,
            toolVersions: versions,
            authenticatedTools: {
                beforeOutput: authenticatedTools,
                final: null,
            },
            sourceReauthentication: null,
            productionGpuLease: {
                acquisition: acquiredLeaseEvidence,
                finalDrain: null,
                disposition: null,
            },
            cases: [],
            safetyChecks: config.safetyChecks,
            productionPromotionAuthorized: false,
        };
        atomicJson(path.join(resolvedOutput, 'normalized-private-input.json'), {
            schema: config.schema,
            nvencQualityProfile: config.nvencQualityProfile,
            includeStrength014: config.includeStrength014,
            strength014Justification: config.strength014Justification,
            cases: config.cases,
            tools: config.tools,
            expectedToolIdentities: config.expectedToolIdentities,
            productionGpuLockPath: config.productionGpuLockPath,
            privateOutputRoot: config.privateOutputRoot,
            protectedRoots: config.protectedRoots,
            acknowledgeProtectedRootsComplete:
                config.acknowledgeProtectedRootsComplete,
            acknowledgeNoGitCheckoutMounted:
                config.acknowledgeNoGitCheckoutMounted,
            thresholds: config.thresholds,
        });
        for (const caseSpec of config.cases) {
            recordGpuQuiescence(config, `before-case:${caseSpec.caseId}`);
            report.cases.push(await runCase(
                config,
                caseSpec,
                resolvedOutput,
                authenticatedCases.get(caseSpec.caseId)
            ));
            recordGpuQuiescence(config, `after-case:${caseSpec.caseId}`);
        }
        report.mediaCompletedAt = new Date().toISOString();
        fs.writeFileSync(
            path.join(resolvedOutput, 'review.html'),
            renderReviewHtml(report),
            { encoding: 'utf8', mode: 0o600, flag: 'wx' }
        );
    } catch (error) {
        executionError = error;
    }
    if (lease) {
        try {
            await ACTIVE_CHILD_REGISTRY.terminateAndWait('SIGTERM');
        } catch (error) {
            cleanupSafetyError = appendExecutionError(
                cleanupSafetyError, error, 'child cleanup failed'
            );
            executionError = appendExecutionError(
                executionError, error, 'child cleanup failed'
            );
        }
        if (authenticatedTools) {
            try {
                finalToolIdentities =
                    reauthenticateConfiguredTools(authenticatedTools);
            } catch (error) {
                cleanupSafetyError = appendExecutionError(
                    cleanupSafetyError, error,
                    'final tool authentication failed'
                );
                executionError = appendExecutionError(
                    executionError, error, 'final tool authentication failed'
                );
            }
        }
        try {
            finalSourceIdentities = await reauthenticateAuthenticatedSources(
                config, authenticatedCases
            );
        } catch (error) {
            cleanupSafetyError = appendExecutionError(
                cleanupSafetyError, error,
                'final source authentication failed'
            );
            executionError = appendExecutionError(
                executionError, error, 'final source authentication failed'
            );
        }
        try {
            finalDrain = assertFinalGpuProcessDrain(lease, {
                registry: ACTIVE_CHILD_REGISTRY,
            });
        } catch (error) {
            cleanupSafetyError = appendExecutionError(
                cleanupSafetyError, error,
                'final GPU process drain failed'
            );
            executionError = appendExecutionError(
                executionError, error, 'final GPU process drain failed'
            );
        }
        if (toolEnforcement) {
            try { toolEnforcement.dispose(); } catch (error) {
                cleanupSafetyError = appendExecutionError(
                    cleanupSafetyError, error,
                    'tool enforcement cleanup failed'
                );
                executionError = appendExecutionError(
                    executionError, error,
                    'tool enforcement cleanup failed'
                );
            }
        }
        if (leaseEnforcement) {
            try { leaseEnforcement.dispose(); } catch (error) {
                cleanupSafetyError = appendExecutionError(
                    cleanupSafetyError, error,
                    'lease enforcement cleanup failed'
                );
                executionError = appendExecutionError(
                    executionError, error,
                    'lease enforcement cleanup failed'
                );
            }
        }
        if (cleanupSafetyError || !finalDrain) {
            leaseDisposition = retainProductionGpuLease(
                lease,
                cleanupSafetyError ||
                    new Error('final drain evidence is unavailable')
            );
        } else {
            leaseDisposition = releaseProductionGpuLease(lease);
            if (!leaseDisposition.released) {
                executionError = appendExecutionError(
                    executionError,
                    new Error(leaseDisposition.reason),
                    'production GPU lease release failed'
                );
            }
        }
    }
    if (report) {
        report.authenticatedTools.final = finalToolIdentities;
        report.sourceReauthentication = finalSourceIdentities;
        report.productionGpuLease.finalDrain = finalDrain;
        report.productionGpuLease.disposition = leaseDisposition;
    }
    if (executionError) {
        if (outputCreated) {
            atomicJson(path.join(resolvedOutput, 'failure.json'), {
                schema: SCHEMA,
                purpose: report
                    ? report.purpose
                    : 'sample-only-increased-denoise-retention-screen',
                startedAt,
                failedAt: new Date().toISOString(),
                productionMutation: false,
                productionPromotionAuthorized: false,
                productionGpuLease: report
                    ? report.productionGpuLease
                    : { disposition: leaseDisposition },
                authenticatedTools: report
                    ? report.authenticatedTools : null,
                sourceReauthentication: finalSourceIdentities,
                error: String(
                    executionError && executionError.stack
                        ? executionError.stack : executionError
                ),
            });
        }
        throw executionError;
    }
    if (!report || !leaseDisposition || !leaseDisposition.released) {
        throw new Error('trial completed without confirmed lease release evidence');
    }
    report.completedAt = new Date().toISOString();
    atomicJson(path.join(resolvedOutput, 'results.json'), report);
    return report;
}

async function main() {
    const signalHandlers = installSignalHandlers(ACTIVE_CHILD_REGISTRY, process);
    try {
        const cli = parseCli(process.argv.slice(2));
        if (cli.help) {
            process.stdout.write(`${usage()}\n`);
            return;
        }
        const report = await execute(cli);
        process.stdout.write(
            `${JSON.stringify({
                completedAt: report.completedAt,
                cases: report.cases.map((item) => item.caseId),
                productionPromotionAuthorized: false,
            })}\n`
        );
    } catch (error) {
        process.stderr.write(`ERROR: ${error && error.message ? error.message : error}\n`);
        if (process.exitCode !== 130 && process.exitCode !== 143) {
            process.exitCode = 2;
        }
    } finally {
        signalHandlers.dispose();
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    SCHEMA,
    PROVENANCE_RECEIPT_SCHEMA,
    PROVENANCE_RECEIPT_KIND,
    MAX_PROVENANCE_RECEIPT_BYTES,
    MIN_REVIEWED_EVIDENCE_ARTIFACTS,
    MAX_REVIEWED_EVIDENCE_ARTIFACTS,
    VARIANTS,
    NVENC_PROFILES,
    LUMA_BANDS,
    PRODUCTION_KNN_SETTINGS,
    PRODUCTION_DENOISE_ID,
    PRODUCTION_REFERENCE_CONTRACT_ID,
    DIRECT_GLOBAL_GRAIN_END,
    GRAIN_FIT_FRAMES,
    GRAIN_FIT_MAX_CANDIDATES,
    GRAIN_PROXY_WIDTH,
    GRAIN_PROXY_HEIGHT,
    GRAIN_PROXY_FRAMES,
    GRAIN_PROXY_SPACING_SECONDS,
    GRAIN_PROXY_POSITION_COUNT,
    DEFAULT_PRODUCTION_GPU_LOCK_PATH,
    PRODUCTION_GPU_LEASE_HEARTBEAT_MS,
    TOOL_KEYS,
    PROTECTED_ROOT_GROUPS,
    SETTING_WALL_MS,
    GRAIN_DIFF_TIMEOUT_MS,
    parseCli,
    selectedVariants,
    normalizeConfig,
    normalizeOutputRootPolicy,
    normalizeDeclaredRootList,
    isPathWithin,
    pathsOverlap,
    canonicalDirectory,
    canonicalSourceFile,
    findGitAncestor,
    validateOutputPolicy,
    outputDepth,
    frameRate,
    colorArgs,
    av1ColorMetadataBsf,
    buildExtractArgs,
    buildProducerArgs,
    buildDenoiseConsumerArgs,
    buildEncodeArgs,
    buildLumaArgs,
    buildContactSheetArgs,
    productionGrainFitStartTimes,
    buildGrainProxyArgs,
    analyzeGrainProxyBytes,
    rankProductionGrainFitEvidence,
    buildProductionGrainFitPlan,
    hasSemanticGrainTable,
    grainTableSegments,
    assertDirectGlobalGrainTable,
    publishBytesAtomically,
    grainFitUnavailableDisposition,
    fitVariantGlobalGrainTable,
    skippedVariantForUnavailableControl,
    runConfiguredVariants,
    expectedLumaByteCount,
    readExactLumaFile,
    decodeExactLuma,
    normalizeLumaExpectation,
    bandEvidence,
    aggregateBandEvidence,
    pooledMetric,
    aggregateVariant,
    pairedMetricEvidence,
    aggregateHasExactDecodedEvidence,
    settingIsAvailable,
    unavailableVariantDecision,
    evaluateVariants,
    renderReviewHtml,
    productionLockEvidence,
    getProcStartTime,
    stableJsonFile,
    assertOwnedProductionGpuLease,
    acquireProductionGpuLease,
    releaseProductionGpuLease,
    retainProductionGpuLease,
    activateProductionGpuLeaseEnforcement,
    assertActiveProductionGpuLease,
    parseProcStat,
    dangerousProcessReason,
    readProcEntries,
    isSelfOrDescendant,
    conflictingProcesses,
    assertFinalGpuProcessDrain,
    assertGpuQuiescent,
    recordGpuQuiescence,
    createChildRegistry,
    installSignalHandlers,
    sourceStatIdentity,
    assertSameSourceIdentity,
    fullSourceIdentity,
    fullExecutableIdentity,
    assertExecutableIdentityUnchanged,
    assertMatchesExpectedExecutable,
    parsePosixShExecWrapperText,
    authenticateConfiguredTools,
    assertToolClosureUnchanged,
    activateAuthenticatedTools,
    reauthenticateConfiguredTools,
    authenticateJsonBytes,
    validateProvenanceReceipt,
    readAuthenticatedProvenanceReceipt,
    assertExpectedSourceIdentity,
    runCommand,
    runPipeline,
    execute,
};
