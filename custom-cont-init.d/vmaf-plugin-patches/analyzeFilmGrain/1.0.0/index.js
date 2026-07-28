'use strict';

Object.defineProperty(exports, '__esModule', { value: true });
exports.plugin = exports.details = void 0;

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const artifactLib = require('../../_lib/grainAnalysisArtifact.js');
const nvenccKnn = require('../../_lib/nvenccKnn.js');
const gpuPipelineLock = require('../../_lib/gpuPipelineLock.js');

const details = () => ({
    name: 'Analyze Film Grain',
    description: 'Fit one direct, unmodified grav1synth table from a short lossless source clip and the same clip after GPU KNN denoising. The untouched library source remains the Flow input.',
    style: { borderColor: 'gold' },
    tags: 'video,grain,analysis,vmaf,validation',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faMagnifyingGlassChart',
    inputs: [
        {
            label: 'Rollout Mode',
            name: 'mode',
            type: 'string',
            defaultValue: 'active',
            inputUI: { type: 'dropdown', options: ['disabled', 'canary', 'active'] },
            tooltip: 'disabled bypasses analysis. canary and active both prepare the same immutable handoff; replacement policy remains in Synthesize Film Grain.',
        },
        {
            label: 'Mounted Source Scope Regex',
            name: 'sourcePathRegex',
            type: 'string',
            defaultValue: '^/media/',
            inputUI: { type: 'text' },
            tooltip: 'Required in canary and active modes. The default matches every file beneath the mounted /media root; it is not a title allowlist.',
        },
        {
            label: 'Source Path Regex Flags',
            name: 'sourcePathRegexFlags',
            type: 'string',
            defaultValue: 'i',
            inputUI: { type: 'text' },
            tooltip: 'JavaScript regular-expression flags for the mounted-source scope.',
        },
        {
            label: 'Eligible Color Profiles',
            name: 'eligibleProfiles',
            type: 'string',
            defaultValue: 'sdrAndPq',
            inputUI: { type: 'dropdown', options: ['sdrAndPq', 'sdrOnly', 'pqOnly'] },
            tooltip: 'Known/inferred SDR and static PQ are eligible. Compatible dynamic HDR is provisional only when Check HDR Content authorized static HDR10 fallback.',
        },
        {
            label: 'Pipeline Path',
            name: 'pipelinePath',
            type: 'string',
            defaultValue: '/opt/grain-pipeline/current/grain_pipeline_v5_direct.py',
            inputUI: { type: 'text' },
            tooltip: 'Checksum-pinned direct grav1synth pipeline.',
        },
        {
            label: 'Python Path',
            name: 'pythonPath',
            type: 'string',
            defaultValue: 'python3',
            inputUI: { type: 'text' },
            tooltip: 'Python executable used to run the fitting pipeline.',
        },
        {
            label: 'grav1synth Path',
            name: 'grav1synthPath',
            type: 'string',
            defaultValue: '/usr/local/bin/grav1synth',
            inputUI: { type: 'text' },
            tooltip: 'Absolute path to the validated grav1synth executable.',
        },
        {
            label: 'NVEncC Path',
            name: 'nvenccPath',
            type: 'string',
            defaultValue: '/usr/local/bin/nvencc',
            inputUI: { type: 'text' },
            tooltip: 'Pinned NVEncC 9.25 binary used for the exact production KNN denoiser.',
        },
        {
            label: 'NVEncC/FFmpeg Coordinator',
            name: 'coordinatorPath',
            type: 'string',
            defaultValue: '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js',
            inputUI: { type: 'text' },
            tooltip: 'Pinned raw-NUT producer/consumer coordinator.',
        },
        {
            label: 'Job Work Subdirectory',
            name: 'workRoot',
            type: 'string',
            defaultValue: 'grain-analysis',
            inputUI: { type: 'text' },
            tooltip: 'Relative child of args.workDir. Absolute or escaping paths fail closed so Cleanup Temporary Files can delete every published artifact.',
        },
        {
            label: 'Pipeline Timeout Minutes',
            name: 'pipelineTimeoutMinutes',
            type: 'number',
            defaultValue: '45',
            inputUI: { type: 'text' },
            tooltip: 'Hard timeout for source-only fitting.',
        },
    ],
    outputs: [
        { number: 1, tooltip: 'PREPARED: continue through metadata and VMAF optimization' },
        { number: 2, tooltip: 'BYPASS/INELIGIBLE/ANALYSIS UNAVAILABLE: continue normal VMAF transcode; post synthesis will bypass' },
        { number: 3, tooltip: 'UNREADABLE/MISSING SOURCE: cleanup and keep the library original' },
    ],
});
exports.details = details;

function appendBounded(existing, chunk, limit) {
    const combined = existing + chunk;
    return combined.length <= limit ? combined : combined.slice(combined.length - limit);
}

function runProcess(executable, argv, options) {
    options = options || {};
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const limit = Math.max(64 * 1024, Number(options.maxOutputBytes) || 16 * 1024 * 1024);
        let timedOut = false;
        let settled = false;
        const detachedGroup = process.platform !== 'win32';
        let child;
        try {
            child = childProcess.spawn(executable, argv, {
                shell: false,
                windowsHide: true,
                detached: detachedGroup,
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: options.cwd || undefined,
                env: process.env,
            });
        } catch (error) {
            reject(error);
            return;
        }
        let timer = null;
        let hardKillTimer = null;
        const signalTree = (signal) => {
            try {
                if (detachedGroup && child.pid > 0) process.kill(-child.pid, signal);
                else child.kill(signal);
            } catch (error) {
                if (!error || error.code !== 'ESRCH') {
                    try { child.kill(signal); } catch (_) {}
                }
            }
        };
        if (options.timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                signalTree('SIGTERM');
                hardKillTimer = setTimeout(() => signalTree('SIGKILL'), 3000);
            }, options.timeoutMs);
        }
        child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk.toString('utf8'), limit); });
        child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk.toString('utf8'), limit); });
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (hardKillTimer) clearTimeout(hardKillTimer);
            if (timedOut) signalTree('SIGKILL');
            reject(error);
        });
        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (hardKillTimer) clearTimeout(hardKillTimer);
            if (timedOut) signalTree('SIGKILL');
            resolve({ code, signal, stdout, stderr, timedOut });
        });
    });
}

function commandTail(result) {
    let text = String(result && (result.stderr || result.stdout) || '').trim();
    if (text.length > 5000) text = text.slice(text.length - 5000);
    return text;
}

const ANALYSIS_DIAGNOSTIC_MAX_CHARS = artifactLib.ANALYSIS_DIAGNOSTIC_MAX_CHARS;

function boundedAnalysisDiagnostic(value) {
    let text = String(value && value.message !== undefined ? value.message : value || '')
        .replace(/\0/g, '').trim();
    if (!text) text = 'film grain analysis unavailable';
    if (text.length <= ANALYSIS_DIAGNOSTIC_MAX_CHARS) return text;
    const marker = '\n...[bounded diagnostic]...\n';
    const headLength = Math.min(512, ANALYSIS_DIAGNOSTIC_MAX_CHARS - marker.length);
    const tailLength = ANALYSIS_DIAGNOSTIC_MAX_CHARS - headLength - marker.length;
    return text.slice(0, headLength) + marker + text.slice(text.length - tailLength);
}

async function runChecked(executable, argv, options) {
    const result = await runProcess(executable, argv, options);
    if (result.timedOut) throw new Error(`command timed out: ${executable} ${argv.slice(0, 3).join(' ')}`);
    if (result.code !== 0) {
        throw new Error(`command failed with exit code ${result.code}: ${executable}` +
            (commandTail(result) ? `\n${commandTail(result)}` : ''));
    }
    return result;
}

function sourcePathFromArgs(args) {
    return String(
        (args.originalLibraryFile && (args.originalLibraryFile._id || args.originalLibraryFile.file)) ||
        (args.variables && args.variables.vmafOriginalFile) ||
        (args.inputFileObj && (args.inputFileObj._id || args.inputFileObj.file)) ||
        ''
    );
}

async function withAnalysisGpuLease(
    args, sourcePath, operation, lockOverride) {
    if (typeof operation !== 'function') {
        throw new Error('grain analysis GPU lease requires an operation');
    }
    const lock = lockOverride || gpuPipelineLock;
    const lockDir = lock.resolveLockDir(
        process.env.TDARR_GPU_PIPELINE_LOCK_DIR ||
        '/temp/tdarr-vmaf-gpu-pipeline.lock');
    const existing = args.variables &&
        args.variables.vmafGpuPipelineLockAcquired === true &&
        args.variables.vmafGpuPipelineLock;
    const result = await lock.acquire({
        lockDir,
        owner: {
            ownerId: `grain-analysis-${artifactLib.stableId(sourcePath)}`,
            workerName: process.env.Tdarr_Node_Name ||
                process.env.TDARR_NODE_NAME ||
                process.env.nodeID ||
                process.env.NODE_ID ||
                process.env.HOSTNAME ||
                'unknown-worker',
            stage: 'grain-analysis-knn',
            plugin: 'analyzeFilmGrain',
        },
        waitPollSeconds: 5,
        waitLogSeconds: 60,
        maxWaitSeconds: 43200,
        staleHeartbeatSeconds: 7200,
        maxLockAgeSeconds: 28800,
        initializationGraceSeconds: 30,
        heartbeatIntervalSeconds: 30,
        existingToken: existing && existing.token || null,
        log: (message) => args.jobLog(message),
    });
    const reentrant = result.reentrant === true;
    let operationError = null;
    try {
        return await operation();
    } catch (error) {
        operationError = error;
        throw error;
    } finally {
        if (!reentrant) {
            const released = lock.release(
                lockDir,
                result.owner && result.owner.token,
                {
                    expectedGeneration:
                        result.owner && result.owner.leaseGeneration,
                },
            );
            if (!released || released.released !== true) {
                const releaseError = new Error(
                    'grain analysis GPU lease release failed: ' +
                    String(released && released.reason || 'unknown reason'));
                if (operationError) releaseError.cause = operationError;
                throw releaseError;
            }
        }
    }
}

function clearPublishedVariables(variables) {
    for (const key of artifactLib.ANALYSIS_UNAVAILABLE_FORBIDDEN_VARIABLES) delete variables[key];
}

function makeResult(args, outputNumber, status, reason) {
    args.variables.grainAnalysisStatus = status;
    args.variables.grainAnalysisReason = reason || null;
    args.variables.grainAnalysisCompletedAt = new Date().toISOString();
    return {
        outputFileObj: args.inputFileObj,
        outputNumber,
        variables: args.variables,
    };
}

function makeAnalysisUnavailableResult(args, reason) {
    const diagnostic = boundedAnalysisDiagnostic(reason);
    clearPublishedVariables(args.variables);
    args.jobLog(`FILM GRAIN ANALYSIS UNAVAILABLE: ${diagnostic}\n` +
        'Continuing normal AV1 optimization from the untouched source with NVENC temporal filtering disabled.');
    const result = makeResult(
        args, 2, artifactLib.ANALYSIS_UNAVAILABLE_STATUS, diagnostic);
    artifactLib.validateAnalysisUnavailableDisposition(args.variables);
    return result;
}

function buildFitPipelineArgs(options) {
    return [
        options.pipelinePath,
        '--operation', 'fit-direct',
        '--source', options.sourcePath,
        '--workdir', options.jobDir,
        '--output', options.tablePath,
        '--manifest', options.manifestPath,
        '--outcome', options.outcomePath,
        '--ffmpeg', options.ffmpegPath,
        '--ffprobe', options.ffprobePath,
        '--grav1synth', options.grav1synthPath,
        '--nvencc', options.nvenccPath,
        '--coordinator', options.coordinatorPath,
        '--media-profile', options.mediaProfile,
        '--frames', '144',
        '--max-candidates', '3',
    ];
}

function resolveExecutablePath(value, description) {
    const requested = String(value || '').trim();
    if (!requested) throw new Error(`${description} path is required`);
    const candidates = path.isAbsolute(requested)
        ? [requested]
        : String(process.env.PATH || '').split(path.delimiter)
            .filter(Boolean).map((directory) => path.join(directory, requested));
    for (const candidate of candidates) {
        try {
            fs.accessSync(candidate, fs.constants.R_OK | fs.constants.X_OK);
            return fs.realpathSync(candidate);
        } catch (_) {}
    }
    throw new Error(`${description} executable not found: ${requested}`);
}

async function plugin(args) {
    const lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    args.variables = args.variables || {};
    clearPublishedVariables(args.variables);

    const mode = String(args.inputs.mode || 'active');
    let sourcePath = sourcePathFromArgs(args);
    args.jobLog(`=== Analyze Film Grain (${mode}) ===`);
    if (mode === 'disabled') {
        args.jobLog('Film-grain analysis is disabled; continuing normal VMAF processing.');
        return makeResult(args, 2, 'disabled', 'rollout_disabled');
    }
    if (!sourcePath) return makeResult(args, 3, 'failed', 'missing_source_path');
    try {
        artifactLib.assertRegularFile(sourcePath, 'original library source');
    } catch (sourceError) {
        const diagnostic = boundedAnalysisDiagnostic(sourceError);
        args.jobLog(`FILM GRAIN SOURCE UNREADABLE: ${diagnostic}`);
        clearPublishedVariables(args.variables);
        return makeResult(args, 3, 'failed', diagnostic);
    }
    if (mode !== 'canary' && mode !== 'active') {
        return makeAnalysisUnavailableResult(args, `invalid_rollout_mode: ${mode}`);
    }
    const regexText = String(args.inputs.sourcePathRegex || '').trim();
    if (!regexText) {
        return makeAnalysisUnavailableResult(args, 'source_path_allowlist_required');
    }
    try {
        const canonicalSourcePath = artifactLib.resolveAllowlistedSourcePath(
            sourcePath, regexText, args.inputs.sourcePathRegexFlags);
        if (!canonicalSourcePath) {
            args.jobLog(`Original path is outside the mounted film-grain source scope: ${sourcePath}`);
            return makeResult(args, 2, 'ineligible', 'source_path_not_allowlisted');
        }
        sourcePath = canonicalSourcePath;
    } catch (error) {
        return makeAnalysisUnavailableResult(args,
            `invalid_or_unsafe_source_scope: ${boundedAnalysisDiagnostic(error)}`);
    }

    const sourceProbe = args.inputFileObj && args.inputFileObj.ffProbeData;
    let eligibility;
    try {
        eligibility = artifactLib.classifySource(
            sourceProbe,
            args.variables,
            String(args.inputs.eligibleProfiles || 'sdrAndPq')
        );
    } catch (eligibilityError) {
        return makeAnalysisUnavailableResult(args,
            `source_eligibility_analysis_failed: ${boundedAnalysisDiagnostic(eligibilityError)}`);
    }
    if (!eligibility.eligible) {
        args.jobLog(`Film-grain source is ineligible: ${eligibility.reason}`);
        return makeResult(args, 2, 'ineligible', eligibility.reason);
    }

    let jobDir = null;
    try {
        const pipelinePath = String(args.inputs.pipelinePath);
        const pythonPath = String(args.inputs.pythonPath || 'python3');
        const grav1synthPath = resolveExecutablePath(args.inputs.grav1synthPath, 'grav1synth');
        const nvenccPath = resolveExecutablePath(
            args.inputs.nvenccPath || nvenccKnn.DEFAULT_NVENCC_PATH, 'NVEncC');
        const coordinatorPath = resolveExecutablePath(
            args.inputs.coordinatorPath || nvenccKnn.DEFAULT_COORDINATOR_PATH,
            'NVEncC/FFmpeg coordinator');
        const ffmpegPath = resolveExecutablePath(
            args.ffmpegPath || '/usr/local/bin/tdarr-ffmpeg', 'FFmpeg');
        const ffprobePath = resolveExecutablePath(args.ffprobePath || 'ffprobe', 'ffprobe');
        artifactLib.assertRegularFile(pipelinePath, 'validated grain pipeline');
        if (nvenccKnn.KNN_SETTINGS !==
            'radius=3,d=0,strength=0.08,lerp=0.2,th_lerp=0.8') {
            throw new Error('compiled NVEncC KNN contract drifted from the approved production settings');
        }
        await runChecked(pythonPath, ['--version'], { timeoutMs: 10000 });
        await runChecked(grav1synthPath, ['--version'], { timeoutMs: 10000 });
        await runChecked(nvenccPath, ['--version'], { timeoutMs: 15000 });
        await runChecked(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 10000 });
        await runChecked(ffprobePath, ['-hide_banner', '-version'], { timeoutMs: 10000 });

        const roots = artifactLib.resolveJobOwnedRoot(args, args.inputs.workRoot, 'grain-analysis');
        const prefix = `${artifactLib.safeSlug(path.basename(sourcePath, path.extname(sourcePath)))}-${artifactLib.stableId(sourcePath)}-`;
        jobDir = fs.mkdtempSync(path.join(roots.workRoot, prefix));
        artifactLib.assertJobOwnedPath(args, jobDir, 'grain analysis job directory');
        const tablePath = path.join(jobDir, 'grain-table.txt');
        const manifestPath = path.join(jobDir, 'grain-pipeline-manifest.json');
        const outcomePath = path.join(jobDir, 'grain-fit-outcome.json');
        const timeoutMs = Math.min(240, Math.max(5,
            artifactLib.finiteNumber(args.inputs.pipelineTimeoutMinutes, 45))) * 60 * 1000;
        const pipelineArgs = buildFitPipelineArgs({
            pipelinePath,
            sourcePath,
            jobDir,
            tablePath,
            manifestPath,
            outcomePath,
            ffmpegPath,
            ffprobePath,
            grav1synthPath,
            nvenccPath,
            coordinatorPath,
            mediaProfile: eligibility.profile,
        });
        args.jobLog(`Fitting one direct unmodified grav1synth table from a 144-frame ` +
            `source/KNN pair (${eligibility.label}, ${nvenccKnn.KNN_SETTINGS}).`);
        if (eligibility.dynamicEvidence) {
            args.jobLog(`Dynamic HDR accepted provisionally from Check HDR Content: ${eligibility.dynamicEvidence.conversion}.`);
        }
        if (args.updateWorker) args.updateWorker({ CLIType: pythonPath, preset: pipelineArgs.join(' ') });
        const pipelineResult = await withAnalysisGpuLease(
            args,
            sourcePath,
            () => runProcess(pythonPath, pipelineArgs, {
                timeoutMs,
                maxOutputBytes: 16 * 1024 * 1024,
            }),
        );
        if (pipelineResult.timedOut) throw new Error('grain analysis pipeline timed out');
        // Python writes progress to stdout and the decisive fail-closed reason
        // to stderr. Preserve stderr priority even when progress was emitted.
        const tail = commandTail(pipelineResult);
        if (tail) args.jobLog(`Grain analysis pipeline tail:\n${tail}`);
        if (pipelineResult.code === 3) {
            if (fs.existsSync(tablePath) || fs.existsSync(manifestPath)) {
                throw new Error('no-grain bypass unexpectedly published a table or fit manifest');
            }
            artifactLib.assertRegularFile(outcomePath, 'no-grain outcome report');
            const report = JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
            const noGrainArtifact = artifactLib.buildNoGrainArtifact(report, {
                sourcePath,
                pipelinePath,
                tablePath,
                manifestPath,
                outcomePath,
                expectedProfile: eligibility.profile,
                ffmpegPath,
                ffprobePath,
                grav1synthPath,
                nvenccPath,
                coordinatorPath,
            });
            args.variables.grainAnalysisNoGrainArtifact = noGrainArtifact;
            args.variables.grainAnalysisSourcePath = sourcePath;
            args.variables.grainAnalysisJobDir = jobDir;
            args.variables.grainAnalysisWorkRoot = roots.workRoot;
            args.variables.grainAnalysisOutcomeReportPath = artifactLib.registerTemporaryFile(
                args.variables, args, outcomePath
            );
            args.variables.grainAnalysisPreparedAt = noGrainArtifact.preparedAt;
            args.variables.grainAnalysisProfile = noGrainArtifact.mediaProfile;
            if (Number(noGrainArtifact.schema) === artifactLib.DIRECT_ARTIFACT_SCHEMA) {
                args.jobLog('FGS BYPASS: none of the bounded short source/KNN pairs produced one trustworthy global grav1synth table; continuing from the untouched source with tf0.');
            } else if (noGrainArtifact.reasonCode === artifactLib.NO_GRAIN_REASON_CODE) {
                args.jobLog('NO GRAIN: exact canonical source/denoised fit, calibration, and final-validation pairs; continuing with normal VMAF/CQ from the untouched source.');
            } else if (noGrainArtifact.reasonCode ===
                artifactLib.NO_GRAIN_NO_NOTICEABLE_SOURCE_NOISE_REASON_CODE) {
                args.jobLog('FGS BYPASS: eight independent native-resolution source regions have no noticeable noise under the av1-grain estimator; continuing with normal VMAF/CQ from the untouched source.');
            } else if (noGrainArtifact.reasonCode ===
                artifactLib.NO_GRAIN_INSUFFICIENT_FLAT_SUPPORT_REASON_CODE) {
                args.jobLog('FGS BYPASS: native source crops lack enough estimator-valid flat support for a trustworthy grain model; continuing with normal VMAF/CQ from the untouched source.');
            } else if (noGrainArtifact.reasonCode ===
                artifactLib.NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE) {
                args.jobLog('FGS BYPASS: independent regions cannot be represented by one static grain model; continuing with normal VMAF/CQ from the untouched source.');
            } else {
                args.jobLog('ADVISORY NO SYNTHETIC GRAIN: insufficient source-removed energy support; continuing with normal VMAF/CQ from the untouched source.');
            }
            return makeResult(args, 1, 'no_grain', noGrainArtifact.reasonCode);
        }
        if (pipelineResult.code !== 0) {
            throw new Error(`grain analysis pipeline failed with exit code ${pipelineResult.code}` +
                (tail ? `\n${tail}` : ''));
        }
        if (fs.existsSync(outcomePath)) {
            throw new Error('successful grain fit unexpectedly published a bypass outcome report');
        }
        artifactLib.assertRegularFile(tablePath, 'prepared grain table');
        artifactLib.assertRegularFile(manifestPath, 'grain analysis manifest');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const artifact = artifactLib.buildPreparedArtifact(manifest, {
            sourcePath,
            tablePath,
            manifestPath,
            pipelinePath,
            expectedProfile: eligibility.profile,
            dynamicEvidence: eligibility.dynamicEvidence,
            ffmpegPath,
            ffprobePath,
            grav1synthPath,
            nvenccPath,
            coordinatorPath,
        });
        const leakedScratch = fs.readdirSync(jobDir).filter((name) =>
            name.startsWith('.direct-grain-') || name.startsWith('.grain-pipeline-run-'));
        if (leakedScratch.length) throw new Error(`pipeline retained internal clip scratch: ${leakedScratch.join(', ')}`);

        args.variables.grainAnalysisArtifact = artifact;
        args.variables.grainAnalysisSourcePath = sourcePath;
        args.variables.grainAnalysisJobDir = jobDir;
        args.variables.grainAnalysisWorkRoot = roots.workRoot;
        args.variables.grainAnalysisTablePath = artifactLib.registerTemporaryFile(args.variables, args, tablePath);
        args.variables.grainAnalysisManifestPath = artifactLib.registerTemporaryFile(args.variables, args, manifestPath);
        args.variables.grainAnalysisPreparedAt = artifact.preparedAt;
        args.variables.grainAnalysisProfile = artifact.mediaProfile;
        args.variables.grainAnalysisDynamicHdrProvisional = artifact.provisionalDynamicHdr;
        args.jobLog(`PREPARED: direct unmodified global grain table published ${tablePath}`);
        return makeResult(args, 1, 'prepared', null);
    } catch (error) {
        if (jobDir) {
            try { artifactLib.removeOwnedJobDir(args, jobDir); } catch (cleanupError) {
                args.jobLog(`Grain analysis cleanup also failed: ${boundedAnalysisDiagnostic(cleanupError)}`);
            }
        }
        return makeAnalysisUnavailableResult(args, error);
    }
}
exports.plugin = plugin;

exports._test = {
    runProcess,
    commandTail,
    sourcePathFromArgs,
    clearPublishedVariables,
    boundedAnalysisDiagnostic,
    withAnalysisGpuLease,
    ANALYSIS_DIAGNOSTIC_MAX_CHARS,
    makeAnalysisUnavailableResult,
    buildPipelineArgsForContract: buildFitPipelineArgs,
};
