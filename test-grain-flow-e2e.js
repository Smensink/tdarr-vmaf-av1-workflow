'use strict';

// Container-only real-media harness for the installed two-stage Flow plugins.
// The caller creates aligned source/base fixtures and supplies their paths.

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sourcePath = process.env.GRAIN_E2E_SOURCE;
const basePath = process.env.GRAIN_E2E_BASE;
const reviewDir = process.env.GRAIN_E2E_REVIEW || '/temp/grain-e2e-review';
const eligibleProfiles = process.env.GRAIN_E2E_ELIGIBLE_PROFILES || 'sdrOnly';
const fixtureLabel = process.env.GRAIN_E2E_LABEL || 'SDR';
const ffmpegPath = process.env.GRAIN_E2E_FFMPEG || '/usr/local/bin/tdarr-ffmpeg';
const ffprobePath = process.env.GRAIN_E2E_FFPROBE || '/usr/local/bin/tdarr-ffprobe';
const pipelinePath = process.env.GRAIN_E2E_PIPELINE ||
  '/opt/grain-pipeline/current/grain_pipeline_v4_validated.py';
const grav1synthPath = process.env.GRAIN_E2E_GRAV1SYNTH || '/usr/local/bin/grav1synth';
const mkvmergePath = process.env.GRAIN_E2E_MKVMERGE || 'mkvmerge';
const pipelineTimeoutMinutes = Number(process.env.GRAIN_E2E_PIPELINE_TIMEOUT_MINUTES || 45);
const validationTimeoutMinutes = Number(process.env.GRAIN_E2E_VALIDATION_TIMEOUT_MINUTES || 240);
const maxOutputSizeRatioPct = Number(process.env.GRAIN_E2E_MAX_OUTPUT_SIZE_RATIO_PCT || 101);
const keepWork = process.env.GRAIN_E2E_KEEP_WORK === '1';
const reuseManifestPath = process.env.GRAIN_E2E_REUSE_MANIFEST || '';
const reuseTablePath = process.env.GRAIN_E2E_REUSE_TABLE || '';
const reuseJobRoot = process.env.GRAIN_E2E_REUSE_JOB_ROOT || '';
const reuseMediaProfile = process.env.GRAIN_E2E_REUSE_MEDIA_PROFILE || '';
const reuseAnalysis = Boolean(reuseManifestPath || reuseTablePath || reuseJobRoot || reuseMediaProfile);
assert(sourcePath && path.isAbsolute(sourcePath), 'GRAIN_E2E_SOURCE must be an absolute path');
assert(basePath && path.isAbsolute(basePath), 'GRAIN_E2E_BASE must be an absolute path');
assert(fs.statSync(sourcePath).isFile(), 'source fixture is missing');
assert(fs.statSync(basePath).isFile(), 'base fixture is missing');
assert(Number.isFinite(pipelineTimeoutMinutes) && pipelineTimeoutMinutes >= 5,
  'GRAIN_E2E_PIPELINE_TIMEOUT_MINUTES must be at least 5');
assert(Number.isFinite(validationTimeoutMinutes) && validationTimeoutMinutes >= 10,
  'GRAIN_E2E_VALIDATION_TIMEOUT_MINUTES must be at least 10');
assert(Number.isFinite(maxOutputSizeRatioPct) && maxOutputSizeRatioPct >= 1 &&
  maxOutputSizeRatioPct <= 500,
  'GRAIN_E2E_MAX_OUTPUT_SIZE_RATIO_PCT must be between 1 and 500');
if (reuseAnalysis) {
  assert(reuseManifestPath && path.isAbsolute(reuseManifestPath),
    'GRAIN_E2E_REUSE_MANIFEST must be an absolute path');
  assert(reuseTablePath && path.isAbsolute(reuseTablePath),
    'GRAIN_E2E_REUSE_TABLE must be an absolute path');
  assert(reuseJobRoot && path.isAbsolute(reuseJobRoot),
    'GRAIN_E2E_REUSE_JOB_ROOT must be an absolute path');
  assert(reuseMediaProfile, 'GRAIN_E2E_REUSE_MEDIA_PROFILE is required');
  assert(keepWork, 'GRAIN_E2E_KEEP_WORK=1 is required when replaying prepared analysis');
}

const analysisPluginPath = process.env.GRAIN_E2E_ANALYSIS_PLUGIN ||
  '/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf/analyzeFilmGrain/1.0.0/index.js';
const synthesisPluginPath = process.env.GRAIN_E2E_PLUGIN ||
  '/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf/synthesizeFilmGrain/1.0.0/index.js';
const analysisPlugin = require(analysisPluginPath);
const synthesisPlugin = require(synthesisPluginPath);

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('end', () => resolve(digest.digest('hex')));
  });
}

function immutableIdentity(filePath) {
  const stat = fs.statSync(filePath, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
  };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function probeMedia(filePath) {
  const result = childProcess.spawnSync(ffprobePath, [
    '-v', 'error',
    '-show_streams',
    '-show_format',
    '-show_chapters',
    '-of', 'json',
    filePath,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0,
    `ffprobe failed for ${filePath}: ${String(result.stderr || '').trim()}`);
  return JSON.parse(result.stdout);
}

function identifyMatroska(filePath) {
  const result = childProcess.spawnSync(mkvmergePath, ['-J', filePath], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0,
    `mkvmerge identify failed for ${filePath}: ${String(result.stderr || '').trim()}`);
  const losslessJson = String(result.stdout || '{}').replace(
    /("uid"\s*:\s*)(-?\d+)(?=\s*[,}])/g, '$1"$2"'
  );
  const identified = JSON.parse(losslessJson);
  assert(identified && identified.container && identified.container.supported === true,
    `mkvmerge did not identify a supported container at ${filePath}`);
  assert.deepStrictEqual(identified.errors || [], [], `mkvmerge reported errors for ${filePath}`);
  assert.deepStrictEqual(identified.warnings || [], [], `mkvmerge reported warnings for ${filePath}`);
  return identified;
}

function primaryVideo(probe) {
  return (probe.streams || []).find((stream) => stream.codec_type === 'video' &&
    Number(stream.disposition && stream.disposition.attached_pic) !== 1);
}

function stableAttachment(attachment) {
  return {
    content_type: attachment && attachment.content_type,
    description: attachment && attachment.description || '',
    file_name: attachment && attachment.file_name,
    size: attachment && attachment.size,
    uid: attachment && attachment.properties && attachment.properties.uid,
  };
}

function stableAncillaryTrack(track) {
  const properties = track && track.properties || {};
  return {
    type: track && track.type,
    codec: track && track.codec,
    codec_id: properties.codec_id,
    uid: properties.uid,
  };
}

function sortedCanonical(items) {
  return (items || []).map((item) => JSON.stringify(item)).sort();
}

function assertWithin(root, candidate, description) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  assert(resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`),
    `${description} escaped ${resolvedRoot}: ${resolvedCandidate}`);
}

const logs = [];
let suppliedVariables = {};
if (process.env.GRAIN_E2E_VARIABLES_JSON) {
  suppliedVariables = JSON.parse(process.env.GRAIN_E2E_VARIABLES_JSON);
  assert(suppliedVariables && typeof suppliedVariables === 'object' && !Array.isArray(suppliedVariables),
    'GRAIN_E2E_VARIABLES_JSON must contain a JSON object');
}

const workParent = path.resolve(process.env.GRAIN_E2E_WORK_PARENT || '/temp');
const jobRoot = reuseAnalysis
  ? path.resolve(reuseJobRoot)
  : path.join(workParent, `grain-e2e-job-${process.pid}-${Date.now()}`);
assertWithin(workParent, jobRoot, 'generated e2e job root');
if (reuseAnalysis) {
  assert(fs.statSync(jobRoot).isDirectory(), 'prepared-analysis replay job root is missing');
} else {
  fs.mkdirSync(jobRoot, { recursive: true });
}

function logMessage(message) {
  const line = String(message);
  logs.push(line);
  process.stdout.write(`${line}\n`);
}

function baseArgs() {
  return {
    workDir: jobRoot,
    ffmpegPath,
    ffprobePath,
    jobLog: logMessage,
    updateWorker() {},
  };
}

(async () => {
  let sourceBefore;
  let baseBefore;
  try {
    sourceBefore = { identity: immutableIdentity(sourcePath), sha256: await sha256(sourcePath) };
    baseBefore = { identity: immutableIdentity(basePath), sha256: await sha256(basePath) };
    assert.notStrictEqual(fs.realpathSync(sourcePath), fs.realpathSync(basePath),
      'source and completed base resolve to the same file');
    const sourceProbe = probeMedia(sourcePath);
    const baseProbe = probeMedia(basePath);
    const sourceObj = { _id: sourcePath, file: sourcePath, ffProbeData: sourceProbe };
    const baseObj = { _id: basePath, file: basePath, ffProbeData: baseProbe };

    let analysisResult;
    if (reuseAnalysis) {
      const manifestPath = path.resolve(reuseManifestPath);
      const tablePath = path.resolve(reuseTablePath);
      assert(fs.statSync(manifestPath).isFile(), 'prepared replay manifest is missing');
      assert(fs.statSync(tablePath).isFile(), 'prepared replay table is missing');
      assertWithin(jobRoot, manifestPath, 'prepared replay manifest');
      assertWithin(jobRoot, tablePath, 'prepared replay table');
      const artifactLibPath = path.resolve(
        path.dirname(analysisPluginPath), '../../_lib/grainAnalysisArtifact.js');
      const artifactLib = require(artifactLibPath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const replayEligibility = artifactLib.classifySource(
        sourceProbe, suppliedVariables, eligibleProfiles);
      assert(replayEligibility.eligible,
        `retained analysis source is no longer eligible: ${replayEligibility.reason}`);
      assert.strictEqual(replayEligibility.profile, reuseMediaProfile,
        'retained analysis media profile does not match current source evidence');
      const artifact = artifactLib.buildPreparedArtifact(manifest, {
        sourcePath,
        tablePath,
        manifestPath,
        pipelinePath,
        expectedProfile: reuseMediaProfile,
        dynamicEvidence: replayEligibility.dynamicEvidence || null,
      });
      const analysisJobDir = path.dirname(manifestPath);
      const analysisWorkRoot = path.dirname(analysisJobDir);
      logMessage(`PREPARED: reauthenticated retained source-only analysis at ${manifestPath}`);
      analysisResult = {
        outputNumber: 1,
        outputFileObj: sourceObj,
        variables: {
          ...suppliedVariables,
          vmafOriginalFile: sourcePath,
          vmafTemporaryFiles: [tablePath, manifestPath],
          grainAnalysisArtifact: artifact,
          grainAnalysisSourcePath: sourcePath,
          grainAnalysisJobDir: analysisJobDir,
          grainAnalysisWorkRoot: analysisWorkRoot,
          grainAnalysisTablePath: tablePath,
          grainAnalysisManifestPath: manifestPath,
          grainAnalysisPreparedAt: artifact.preparedAt,
          grainAnalysisProfile: artifact.mediaProfile,
          grainAnalysisDynamicHdrProvisional: artifact.provisionalDynamicHdr,
          grainAnalysisStatus: 'prepared',
          grainAnalysisReason: null,
          grainAnalysisCompletedAt: new Date().toISOString(),
        },
      };
    } else {
      analysisResult = await analysisPlugin.plugin({
        ...baseArgs(),
        inputs: {
          mode: 'canary',
          sourcePathRegex: `^${escapeRegex(sourcePath)}$`,
          sourcePathRegexFlags: '',
          eligibleProfiles,
          pipelinePath,
          pythonPath: 'python3',
          grav1synthPath,
          workRoot: 'grain-analysis',
          workers: '1',
          pipelineTimeoutMinutes: String(pipelineTimeoutMinutes),
        },
        inputFileObj: sourceObj,
        originalLibraryFile: sourceObj,
        variables: {
          ...suppliedVariables,
          vmafOriginalFile: sourcePath,
          vmafTemporaryFiles: [],
        },
      });
    }
    assert.strictEqual(analysisResult.outputNumber, 1,
      `expected analysis PREPARED output 1, got ${analysisResult.outputNumber}`);
    assert.strictEqual(analysisResult.variables.grainAnalysisStatus, 'prepared');
    assert.strictEqual(analysisResult.outputFileObj._id, sourcePath,
      'analysis changed the untouched Flow input');
    for (const key of ['grainAnalysisTablePath', 'grainAnalysisManifestPath']) {
      const artifact = analysisResult.variables[key];
      assert(artifact && fs.statSync(artifact).isFile(), `missing prepared artifact ${key}`);
      assertWithin(jobRoot, artifact, `prepared artifact ${key}`);
      assert(analysisResult.variables.vmafTemporaryFiles.includes(path.resolve(artifact)),
        `${key} was not individually registered for cleanup`);
    }
    assert(analysisResult.variables.grainAnalysisArtifact,
      'analysis did not publish the immutable prepared-artifact handoff');

    const synthesisResult = await synthesisPlugin.plugin({
      ...baseArgs(),
      inputs: {
        mode: 'canary',
        sourcePathRegex: `^${escapeRegex(sourcePath)}$`,
        sourcePathRegexFlags: '',
        eligibleProfiles,
        pipelinePath,
        pythonPath: 'python3',
        grav1synthPath,
        workRoot: 'grain-synthesis',
        reviewDir,
        workers: '1',
        scalingGain: '1.0',
        highPassSigma: '4.0',
        energyTrimFraction: '0.10',
        energyTimeoutSeconds: '180',
        energyMinDelta: '0.05',
        energyGainMin: '0.25',
        energyGainMax: '2.00',
        energyMaxLogMad: '0.12',
        energyMaxLogDeviation: '0.30',
        energyMinLumaSpacing: '8.0',
        energyMinLumaSpan: '24.0',
        energyMaxLumaSpan: '8.0',
        energyMaxLogSlopePerCode: '0.04',
        energyMaxGainRatio: '6.0',
        energyAggregateTolerancePct: '8.0',
        energyRegionTolerancePct: '15.0',
        maxOutputSizeRatioPct: String(maxOutputSizeRatioPct),
        durationToleranceSeconds: '0.25',
        pipelineTimeoutMinutes: String(pipelineTimeoutMinutes),
        validationTimeoutMinutes: String(validationTimeoutMinutes),
        requireExistingGpuLock: 'false',
        lockDir: path.join(jobRoot, 'gpu-pipeline.lock'),
      },
      inputFileObj: baseObj,
      originalLibraryFile: sourceObj,
      variables: analysisResult.variables,
    });
    assert.strictEqual(synthesisResult.outputNumber, 2,
      `expected canary output 2, got ${synthesisResult.outputNumber}`);
    assert.strictEqual(synthesisResult.variables.grainSynthesisStatus, 'canary_validated');
    assert.strictEqual(synthesisResult.outputFileObj._id, sourcePath,
      'canary did not keep the source fixture');
    for (const key of [
      'grainSynthesisReviewOutput',
      'grainSynthesisReviewTable',
      'grainSynthesisReviewFitTable',
      'grainSynthesisReviewManifest',
      'grainSynthesisReviewCalibrationReport',
      'grainSynthesisReviewEnergyValidationReport',
      'grainSynthesisValidationReport',
    ]) {
      const artifact = synthesisResult.variables[key];
      assert(artifact && fs.statSync(artifact).isFile(), `missing canary artifact ${key}`);
      assertWithin(reviewDir, artifact, `canary artifact ${key}`);
    }
    const validation = JSON.parse(fs.readFileSync(
      synthesisResult.variables.grainSynthesisValidationReport, 'utf8'
    ));
    const fitManifest = JSON.parse(fs.readFileSync(
      synthesisResult.variables.grainSynthesisReviewManifest, 'utf8'
    ));
    assert.strictEqual(fitManifest.schema, 3,
      'canary fit manifest did not use the representability-diagnostic schema');
    assert.strictEqual(
      fitManifest.source_residual_representability.enforcement,
      'advisory-quality-model-diagnostic-v1'
    );
    assert.strictEqual(typeof fitManifest.source_residual_representability.valid, 'boolean');
    if (fitManifest.source_residual_representability.valid === false) {
      assert.strictEqual(
        fitManifest.source_residual_representability.disposition,
        'continue-with-quality-warning'
      );
      assert.strictEqual(
        fitManifest.source_residual_representability.quality_warning.code,
        'source-residual-representability-mismatch'
      );
    }
    assert.strictEqual(fitManifest.source_residual_representability.pair_count, 4,
      'representability gate did not use four frozen calibration/held-out pairs');
    assert.strictEqual(fitManifest.pipeline.sha256, await sha256(pipelinePath),
      'fit manifest pipeline identity does not match the supplied candidate');
    assert.strictEqual(validation.prepared_analysis.schema, 3);
    assert.strictEqual(validation.prepared_analysis.comparison.mode, 'hqdn3d');
    assert.strictEqual(
      validation.prepared_analysis.comparison.purpose,
      'source-denoise-grain-fit'
    );
    assert.strictEqual(validation.energy_calibration.operation, 'calibrate-energy');
    assert.strictEqual(validation.energy_calibration.schema, 3);
    const selectedCalibrationModel =
      validation.energy_calibration.correction_selection.selected_model;
    assert(['luma-log-affine-v1', 'robust-global-log-median-v1',
      'fit-table-identity-gain1-v1']
      .includes(selectedCalibrationModel));
    assert.strictEqual(validation.calibration_model, selectedCalibrationModel);
    if (/network/i.test(fixtureLabel)) {
      assert.strictEqual(selectedCalibrationModel, 'robust-global-log-median-v1',
        'the retained Network canary is expected to exercise scalar fallback');
    }
    assert.strictEqual(validation.adaptive_gain_semantics,
      'deprecated-representative-telemetry-only');
    assert.strictEqual(validation.calibration_summary.transformId,
      selectedCalibrationModel === 'luma-log-affine-v1'
        ? 'multiply-av1-scaling-curves-v1' : null);
    assert.strictEqual(validation.energy_validation.operation, 'validate-energy');
    assert.strictEqual(validation.energy_validation.schema, 2);
    assert.strictEqual(validation.energy_validation.validated, true);
    assert.strictEqual(validation.energy_validation.accepted, true);
    assert(['accepted', 'accepted_with_quality_warning']
      .includes(validation.energy_validation.disposition));
    assert.strictEqual(
      validation.energy_validation.quality_thresholds_met,
      validation.energy_validation.evaluation.validated
    );
    if (validation.energy_validation.disposition === 'accepted_with_quality_warning') {
      assert.strictEqual(validation.energy_validation.quality_warning.advisory, true);
      assert.deepStrictEqual(
        validation.energy_validation.quality_warning.failures,
        validation.energy_validation.evaluation.failures
      );
    }
    assert(['quality_thresholds_met', 'completed_with_quality_warning']
      .includes(validation.quality_disposition));
    assert(Array.isArray(validation.quality_warnings));
    if (fitManifest.source_residual_representability.valid === false) {
      assert(validation.quality_warnings.some((warning) =>
        warning.code === 'source-residual-representability-mismatch'));
    }
    if (validation.energy_calibration.correction_selection.quality_warning === true) {
      assert(validation.quality_warnings.some((warning) =>
        warning.stage === 'postencode-calibration'));
    }
    if (validation.energy_validation.disposition === 'accepted_with_quality_warning') {
      assert(validation.quality_warnings.some((warning) =>
        warning.code === 'heldout-energy-tolerance-mismatch'));
    }
    if (validation.output_size_ratio_pct_of_base > maxOutputSizeRatioPct) {
      assert(validation.quality_warnings.some((warning) =>
        warning.code === 'grain-output-size-ratio-above-policy'),
      'an output-size policy overshoot was not surfaced as an advisory warning');
    }
    assert.strictEqual(validation.semantic_grain_inspected, true);
    assert.strictEqual(validation.full_decode_validated, true);
    assert.strictEqual(validation.stream_count, (sourceProbe.streams || []).length,
      'final stream count does not match the source');
    assert.strictEqual(validation.chapter_count, (sourceProbe.chapters || []).length,
      'final chapter count does not match the source');
    const sourcePrimary = primaryVideo(sourceProbe);
    assert(sourcePrimary, 'source fixture has no ordinary primary video');
    const expectedPayloadIndexes = (sourceProbe.streams || [])
      .filter((stream) => stream.index !== sourcePrimary.index && stream.codec_type !== 'attachment')
      .map((stream) => stream.index);
    assert.deepStrictEqual(validation.payload_parity.checked_stream_indexes,
      expectedPayloadIndexes, 'canary did not hash every non-primary source payload');
    assert.strictEqual(validation.payload_parity.hashes.length, expectedPayloadIndexes.length,
      'payload parity report is incomplete');
    validation.payload_parity.hashes.forEach((entry) => {
      assert(/^[0-9a-f]{64}$/.test(String(entry.hash || '')),
        'payload parity report contains an invalid SHA-256 digest');
    });
    const sourceFormats = String(sourceProbe.format && sourceProbe.format.format_name || '')
      .split(',').map((name) => name.trim().toLowerCase());
    if (sourceFormats.includes('matroska')) {
      assert.strictEqual(validation.ancillary_remux_method,
        'mkvmerge-source-no-video-v1');
      assert(logs.some((line) => line.includes(
        'Remuxing grain video with original Matroska ancillary payloads via MKVToolNix')),
      'canary did not log the MKVToolNix original-source ancillary bypass');
      const sourceIdentify = identifyMatroska(sourcePath);
      const outputIdentify = identifyMatroska(synthesisResult.variables.grainSynthesisReviewOutput);
      assert.strictEqual(sourceIdentify.tracks.filter((track) => track.type === 'video').length, 1,
        'source fixture is not eligible for the one-primary-video Matroska bypass');
      assert.deepStrictEqual(
        sortedCanonical(outputIdentify.tracks.filter((track) => track.type !== 'video')
          .map(stableAncillaryTrack)),
        sortedCanonical(sourceIdentify.tracks.filter((track) => track.type !== 'video')
          .map(stableAncillaryTrack)),
        'Matroska ancillary track codec or 64-bit UID changed'
      );
      assert.deepStrictEqual(
        sortedCanonical((outputIdentify.attachments || []).map(stableAttachment)),
        sortedCanonical((sourceIdentify.attachments || []).map(stableAttachment)),
        'Matroska attachment name, MIME type, size, or UID changed'
      );
      assert.strictEqual((outputIdentify.chapters || []).length,
        (sourceIdentify.chapters || []).length, 'Matroska chapter edition count changed');
      assert.strictEqual(
        String(outputIdentify.container.properties.title || ''),
        String(sourceIdentify.container.properties.title || ''),
        'Matroska segment title changed'
      );
      assert(validation.matroska_inventory, 'validation report lacks Matroska inventory attestation');
      assert.strictEqual(validation.matroska_inventory.schema, 1);
      assert.strictEqual(validation.matroska_inventory.verifier,
        'mkvmerge-identify-lossless-directional-v1');
      assert.strictEqual(validation.matroska_inventory.uid_fields_lossless_decimal_strings, true);
      assert.strictEqual(validation.matroska_inventory.primary_video_tracks, 1);
      assert.strictEqual(validation.matroska_inventory.non_video_tracks,
        sourceIdentify.tracks.filter((track) => track.type !== 'video').length);
      assert.strictEqual(validation.matroska_inventory.attachments,
        (sourceIdentify.attachments || []).length);
      assert.strictEqual(validation.matroska_inventory.chapter_editions,
        (sourceIdentify.chapters || []).length);
      assert.strictEqual(validation.matroska_inventory.global_tag_sets,
        (sourceIdentify.global_tags || []).length);
    }
    assert(logs.some((line) => line.includes('PREPARED:')),
      'source-only preparation completion was not logged');
    assert(logs.some((line) => /CANARY (?:VALIDATED|STRUCTURALLY VALIDATED WITH QUALITY WARNING):/
      .test(line)),
      'canary validation completion was not logged');
    if (/network/i.test(fixtureLabel)) {
      assert(logs.some((line) => line.includes(
        'CANARY STRUCTURALLY VALIDATED WITH QUALITY WARNING:')),
      'the retained Network canary did not surface its advisory completion');
    }
    console.log(`PASS real ${fixtureLabel} two-stage grain Flow canary end-to-end`);
  } finally {
    try {
      if (sourceBefore) {
        assert.deepStrictEqual(
          { identity: immutableIdentity(sourcePath), sha256: await sha256(sourcePath) },
          sourceBefore,
          'source fixture changed during canary'
        );
      }
      if (baseBefore) {
        assert.deepStrictEqual(
          { identity: immutableIdentity(basePath), sha256: await sha256(basePath) },
          baseBefore,
          'completed base fixture changed during canary'
        );
      }
    } finally {
      assertWithin(workParent, jobRoot, 'e2e cleanup target');
      if (keepWork) console.log(`RETAINED E2E work directory: ${jobRoot}`);
      else fs.rmSync(jobRoot, { recursive: true, force: true });
    }
  }
})().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
