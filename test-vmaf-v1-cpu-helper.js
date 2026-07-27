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
assert.deepStrictEqual(command.args.slice(command.args.indexOf('--feature'), command.args.indexOf('--feature') + 2),
  ['--feature', 'cambi=full_ref=true']);

const cambiAlias = command.model.cambiAlias;
function metric(value) { return { harmonic_mean: value }; }
function frame(frameNum, vmaf, cambi, source, fullReference) {
  return { frameNum, metrics: {
    vmaf,
    [cambiAlias]: cambi,
    cambi: cambi + 0.5,
    cambi_source: source,
    cambi_full_reference: fullReference,
  } };
}
const document = {
  frames: [frame(0, 96, 1.2, 0.8, 0.4), frame(2, 94, 1.4, 0.9, 0.5)],
  pooled_metrics: {
    vmaf: metric(94.95),
    [cambiAlias]: metric(1.29),
    cambi: metric(1.79),
    cambi_source: metric(0.85),
    cambi_full_reference: metric(0.45),
  },
};
const parsed = helper.parseOutput(JSON.stringify(document), command);
assert.strictEqual(parsed.vmaf, 94.95);
assert.strictEqual(parsed.cambi, 1.29, 'must bind exact model-qualified CAMBI, not a duplicate bare feature');
assert.strictEqual(parsed.cambiSource, 0.85);
assert.strictEqual(parsed.cambiFullReference, 0.45);
assert.strictEqual(parsed.aliases.vmaf, 'vmaf');
assert.strictEqual(parsed.aliases.cambi, cambiAlias);
assert.deepStrictEqual(parsed.frames.map((item) => item.frameNum), [0, 2]);

const upperBoundResidue = JSON.parse(JSON.stringify(document));
upperBoundResidue.pooled_metrics.vmaf.harmonic_mean = 100.0000000000000142;
assert.strictEqual(helper.parseOutput(upperBoundResidue, command).vmaf, 100,
  'floating-point residue at the exact model ceiling must normalize to the ceiling');
const materialUpperBoundViolation = JSON.parse(JSON.stringify(document));
materialUpperBoundViolation.pooled_metrics.vmaf.harmonic_mean = 100.000001;
assert.throws(() => helper.parseOutput(materialUpperBoundViolation, command), /outside the allowed range/);

const qualifiedVmaf = JSON.parse(JSON.stringify(document));
qualifiedVmaf.pooled_metrics.vmaf_v1_model = qualifiedVmaf.pooled_metrics.vmaf;
delete qualifiedVmaf.pooled_metrics.vmaf;
for (const item of qualifiedVmaf.frames) {
  item.metrics.vmaf_v1_model = item.metrics.vmaf;
  delete item.metrics.vmaf;
}
assert.strictEqual(helper.parseOutput(qualifiedVmaf, command).aliases.vmaf, 'vmaf_v1_model');

const missingSource = JSON.parse(JSON.stringify(document));
delete missingSource.pooled_metrics.cambi_source;
assert.throws(() => helper.parseOutput(missingSource, command), /missing pooled source CAMBI/);
const badFrameCount = JSON.parse(JSON.stringify(document));
badFrameCount.frames.pop();
assert.throws(() => helper.parseOutput(badFrameCount, command), /does not match expected frame count/);
const nonFinite = JSON.parse(JSON.stringify(document));
nonFinite.frames[0].metrics.vmaf = null;
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
const cropped1080 = helper.buildCommand({ ...GEO,
  referencePath: '/tmp/r.y4m', distortedPath: '/tmp/d.y4m', outputPath: '/tmp/o.json',
  width: 1920, height: 800, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'sdr',
});
assert.strictEqual(cropped1080.model.resolutionClass, '1080p');
const cropped4k = helper.buildCommand({ ...GEO,
  referencePath: '/tmp/r.y4m', distortedPath: '/tmp/d.y4m', outputPath: '/tmp/o.json',
  width: 3840, height: 1604, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'hdr-pq', allowProvisionalHdr: true,
});
assert.strictEqual(cropped4k.model.resolutionClass, '4k');
const fullHeight1080 = helper.buildCommand({ ...GEO,
  referencePath: '/tmp/r.y4m', distortedPath: '/tmp/d.y4m', outputPath: '/tmp/o.json',
  width: 1440, height: 1080, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'sdr',
});
assert.strictEqual(fullHeight1080.model.resolutionClass, '1080p');
const fullHeight4k = helper.buildCommand({ ...GEO,
  referencePath: '/tmp/r.y4m', distortedPath: '/tmp/d.y4m', outputPath: '/tmp/o.json',
  width: 2880, height: 2160, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'hdr-pq', allowProvisionalHdr: true,
});
assert.strictEqual(fullHeight4k.model.resolutionClass, '4k');
assert.throws(() => helper.buildCommand({ ...GEO,
  referencePath: '/tmp/r.y4m', distortedPath: '/tmp/d.y4m', outputPath: '/tmp/o.json',
  width: 1280, height: 720, transport: 'y4m', pixelFormat: 'yuv420p10le', bitDepth: 10,
  frameCount: 1, contentClass: 'sdr',
}), /only 1080p or 4K/);

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
