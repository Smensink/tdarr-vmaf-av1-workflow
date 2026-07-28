'use strict';
const assert = require('assert');
const helper = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafV1Cpu.js');

// CPU-v1 binds coded geometry, SAR/DAR and the normalization decision into the
// measurement identity, so every buildCommand call must state them explicitly.
const GEO = { sampleAspectRatio: '1:1', displayAspectRatio: '16:9', geometryNormalization: 'none' };

const command = helper.buildCommand({ ...GEO,
  referencePath: '/tmp/reference.y4m',
  distortedPath: '/tmp/candidate.y4m',
  outputPath: '/tmp/metrics.json',
  width: 1920,
  height: 1080,
  transport: 'y4m',
  pixelFormat: 'yuv420p10le',
  bitDepth: 10,
  frameCount: 3,
  subsample: 2,
  pooling: 'harmonic_mean',
  contentClass: 'sdr',
  fullReferenceCambi: true,
  threads: 2,
});
assert.strictEqual(helper.REVISION, '78e11b52c8fc1fcc6d15afd6c7479394fb3bc6af');
assert.strictEqual(command.expectedMeasuredFrames, 2);
assert(command.metricIdentity.id.includes(`revision=${helper.REVISION}`));
assert.strictEqual(command.contractStatus, 'model-documented-sdr-runtime-unqualified');
assert.strictEqual(command.modelValidatedForContent, true);
const modelArg = command.args[command.args.indexOf('--model') + 1];
assert(!modelArg.includes('full_ref'), 'full-reference CAMBI is a CLI feature, not a model option');
assert(modelArg.includes(`name=${command.model.version}`),
  'the direct command must bind the JSON VMAF alias to the pinned model version');
assert.deepStrictEqual(command.args.slice(command.args.indexOf('--feature'), command.args.indexOf('--feature') + 2),
  ['--feature', 'cambi=full_ref=true']);

const vmafAlias = command.model.vmafAlias;
const cambiAlias = command.model.cambiAlias;
function metric(value) { return { harmonic_mean: value }; }
function frame(frameNum, vmaf, cambi, source, fullReference) {
  return { frameNum, metrics: {
    [vmafAlias]: vmaf,
    [cambiAlias]: cambi,
    cambi: cambi + 0.5,
    cambi_source: source,
    cambi_full_reference: fullReference,
  } };
}
const document = {
  frames: [frame(0, 96, 1.2, 0.8, 0.4), frame(2, 94, 1.4, 0.9, 0.5)],
  pooled_metrics: {
    [vmafAlias]: metric(94.95),
    [cambiAlias]: metric(1.29),
    cambi: metric(1.79),
    cambi_source: metric(0.85),
    cambi_full_reference: metric(0.45),
  },
};
const parsed = helper.parseOutput(JSON.stringify(document), command);
assert.strictEqual(parsed.vmaf, 94.95);
assert.strictEqual(parsed.cambi, 1.29, 'must bind the exact model-qualified CAMBI feature');
assert.strictEqual(parsed.cambiDistorted, 1.79,
  'must bind the documented bare full-reference distorted CAMBI separately');
assert.strictEqual(parsed.cambiSource, 0.85);
assert.strictEqual(parsed.cambiFullReference, 0.45);
assert.strictEqual(parsed.aliases.vmaf, vmafAlias);
assert.strictEqual(parsed.aliases.cambi, cambiAlias);
assert.strictEqual(parsed.aliases.cambiDistorted, 'cambi');
assert.deepStrictEqual(parsed.frames.map((item) => item.frameNum), [0, 2]);

const upperBoundResidue = JSON.parse(JSON.stringify(document));
upperBoundResidue.pooled_metrics[vmafAlias].harmonic_mean = 100.0000000000000142;
assert.strictEqual(helper.parseOutput(upperBoundResidue, command).vmaf, 100,
  'floating-point residue at the exact model ceiling must normalize to the ceiling');
const materialUpperBoundViolation = JSON.parse(JSON.stringify(document));
materialUpperBoundViolation.pooled_metrics[vmafAlias].harmonic_mean = 100.000001;
assert.throws(() => helper.parseOutput(materialUpperBoundViolation, command), /outside the allowed range/);

const unexpectedSoleCambi = JSON.parse(JSON.stringify(document));
unexpectedSoleCambi.pooled_metrics.cambi_other_model =
  unexpectedSoleCambi.pooled_metrics[cambiAlias];
delete unexpectedSoleCambi.pooled_metrics[cambiAlias];
for (const item of unexpectedSoleCambi.frames) {
  item.metrics.cambi_other_model = item.metrics[cambiAlias];
  delete item.metrics[cambiAlias];
}
assert.throws(() => helper.parseOutput(unexpectedSoleCambi, command),
  /unexpected candidate CAMBI metric aliases/);
const duplicateCandidateCambi = JSON.parse(JSON.stringify(document));
duplicateCandidateCambi.pooled_metrics.cambi_other_model = metric(1.5);
duplicateCandidateCambi.frames[0].metrics.cambi_other_model = 1.5;
assert.throws(() => helper.parseOutput(duplicateCandidateCambi, command),
  /unexpected candidate CAMBI metric aliases/);
const missingBareCambi = JSON.parse(JSON.stringify(document));
delete missingBareCambi.pooled_metrics.cambi;
assert.throws(() => helper.parseOutput(missingBareCambi, command),
  /missing exact full-reference distorted CAMBI metric cambi/);
const bareVmaf = JSON.parse(JSON.stringify(document));
bareVmaf.pooled_metrics.vmaf = bareVmaf.pooled_metrics[vmafAlias];
delete bareVmaf.pooled_metrics[vmafAlias];
for (const item of bareVmaf.frames) {
  item.metrics.vmaf = item.metrics[vmafAlias];
  delete item.metrics[vmafAlias];
}
assert.throws(() => helper.parseOutput(bareVmaf, command),
  /unexpected VMAF metric aliases/);
const wrongQualifiedVmaf = JSON.parse(JSON.stringify(document));
wrongQualifiedVmaf.pooled_metrics.vmaf_other_model =
  wrongQualifiedVmaf.pooled_metrics[vmafAlias];
delete wrongQualifiedVmaf.pooled_metrics[vmafAlias];
for (const item of wrongQualifiedVmaf.frames) {
  item.metrics.vmaf_other_model = item.metrics[vmafAlias];
  delete item.metrics[vmafAlias];
}
assert.throws(() => helper.parseOutput(wrongQualifiedVmaf, command),
  /unexpected VMAF metric aliases/);
const duplicateVmaf = JSON.parse(JSON.stringify(document));
duplicateVmaf.pooled_metrics.vmaf = metric(93);
duplicateVmaf.frames[0].metrics.vmaf = 93;
assert.throws(() => helper.parseOutput(duplicateVmaf, command),
  /unexpected VMAF metric aliases/);

const missingSource = JSON.parse(JSON.stringify(document));
delete missingSource.pooled_metrics.cambi_source;
assert.throws(() => helper.parseOutput(missingSource, command), /missing exact source CAMBI metric/);
const badFrameCount = JSON.parse(JSON.stringify(document));
badFrameCount.frames.pop();
assert.throws(() => helper.parseOutput(badFrameCount, command), /does not match expected frame count/);
const nonFinite = JSON.parse(JSON.stringify(document));
nonFinite.frames[0].metrics[vmafAlias] = null;
assert.throws(() => helper.parseOutput(nonFinite, command), /must be finite/);

assert.throws(() => helper.buildCommand({ ...GEO,
  referencePath: '/tmp/reference.y4m', distortedPath: '/tmp/candidate.y4m', outputPath: '/tmp/o.json',
  width: 1920, height: 1080, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'hdr-pq',
}), /allowProvisionalHdr=true/);
const hdr = helper.buildCommand({ ...GEO,
  referencePath: '/tmp/reference.y4m', distortedPath: '/tmp/candidate.y4m', outputPath: '/tmp/o.json',
  width: 3840, height: 2160, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'hdr-pq', allowProvisionalHdr: true, modelProfile: '4k-3h',
});
assert.strictEqual(hdr.model.maxScore, 110);
assert.strictEqual(hdr.model.cambiAlias, 'cambi_ceot_pq_hrs_1080_cmxv_17_vlt_0.06');
assert.strictEqual(hdr.contractStatus, 'provisional-hdr-unvalidated');
assert(hdr.args[hdr.args.indexOf('--model') + 1].includes('cambi.cambi_eotf=pq'));
const cropped1080 = helper.buildCommand({ ...GEO, displayAspectRatio: '12:5',
  referencePath: '/tmp/r.y4m', distortedPath: '/tmp/d.y4m', outputPath: '/tmp/o.json',
  width: 1920, height: 800, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'sdr',
});
assert.strictEqual(cropped1080.model.resolutionClass, '1080p');
const cropped4k = helper.buildCommand({ ...GEO, displayAspectRatio: '960:401',
  referencePath: '/tmp/r.y4m', distortedPath: '/tmp/d.y4m', outputPath: '/tmp/o.json',
  width: 3840, height: 1604, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'hdr-pq', allowProvisionalHdr: true,
});
assert.strictEqual(cropped4k.model.resolutionClass, '4k');
const fullHeight1080 = helper.buildCommand({ ...GEO,
  sampleAspectRatio: '4:3',
  referencePath: '/tmp/r.y4m', distortedPath: '/tmp/d.y4m', outputPath: '/tmp/o.json',
  width: 1440, height: 1080, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'sdr',
});
assert.strictEqual(fullHeight1080.model.resolutionClass, '1080p');
const fullHeight4k = helper.buildCommand({ ...GEO,
  sampleAspectRatio: '4:3',
  referencePath: '/tmp/r.y4m', distortedPath: '/tmp/d.y4m', outputPath: '/tmp/o.json',
  width: 2880, height: 2160, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'hdr-pq', allowProvisionalHdr: true,
});
assert.strictEqual(fullHeight4k.model.resolutionClass, '4k');
assert.throws(() => helper.buildCommand({ ...GEO,
  referencePath: '/tmp/r.y4m', distortedPath: '/tmp/d.y4m', outputPath: '/tmp/o.json',
  width: 1280, height: 720, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'sdr',
}), /does not support coded geometry/);
for (const [width, height] of [
  [2560, 1440],
  [720, 480],
  [1080, 1920],
  [4096, 2160],
]) {
  assert.throws(() => helper.validateGeometry({
    width,
    height,
    sampleAspectRatio: '1:1',
    displayAspectRatio: `${width}:${height}`,
    geometryNormalization: 'none',
  }), (error) => error.code === 'VMAF_V1_GEOMETRY_UNSUPPORTED');
}
assert.throws(() => helper.validateGeometry({
  width: 1920,
  height: 800,
  sampleAspectRatio: '1:1',
  displayAspectRatio: '16:9',
  geometryNormalization: 'none',
}), (error) => error.code === 'VMAF_V1_GEOMETRY_ASPECT_MISMATCH');

const scorer = helper.buildScorerCommand({
  ...GEO,
  referencePath: '/samples/reference.mkv',
  distortedPath: '/samples/candidate.mkv',
  outputPath: '/temp/result.json',
  metadataOutputPath: '/temp/result.transport.json',
  ffmpegPath: '/usr/local/bin/tdarr-ffmpeg',
  width: 1920,
  height: 1080,
  modelVersion: 'vmaf_v1.0.16_3d0h',
  contentClass: 'sdr',
  subsample: 2,
  threads: 2,
});
assert.strictEqual(scorer.executable, '/usr/local/bin/vmaf-v1-score');
assert.strictEqual(scorer.productionEligible, false);
assert.deepStrictEqual(scorer.args.slice(0, 4),
  ['--reference', '/samples/reference.mkv', '--distorted', '/samples/candidate.mkv']);
// Transport sidecar schema 2 authenticates coded geometry and the SAR/DAR of
// BOTH inputs independently, so a reference/candidate geometry mismatch cannot
// be scored as if the rasters agreed.
const transport = {
  schema: 2,
  referenceFrames: 3,
  distortedFrames: 3,
  pixelFormat: 'yuv420p10le',
  bitDepth: 10,
  subsample: 2,
  codedWidth: 1920,
  codedHeight: 1080,
  referenceSampleAspectRatio: '1:1',
  distortedSampleAspectRatio: '1:1',
  referenceDisplayAspectRatio: '16:9',
  distortedDisplayAspectRatio: '16:9',
  geometryNormalization: 'none',
  model: 'vmaf_v1.0.16_3d0h',
  cambiEotf: 'sdr',
};
assert.strictEqual(helper.parseScorerOutput(document, transport, scorer).vmaf, 94.95);
assert.throws(() => helper.parseScorerOutput(document,
  { ...transport, distortedFrames: 2 }, scorer), /transport metadata/);
assert.throws(() => helper.parseScorerOutput(document,
  { ...transport, model: 'other' }, scorer), /transport metadata/);
assert.strictEqual(helper.profileForModelVersion('vmaf_v1.0.16_hfr_1d5h_2160'), '4k-hfr-1.5h');

console.log('PASS pinned native-10-bit CPU VMAF-v1/CAMBI command and fail-closed parser');
