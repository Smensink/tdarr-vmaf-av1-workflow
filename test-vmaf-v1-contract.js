'use strict';
const assert = require('assert');
const metric = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafMetricContract.js');

// Coded geometry, SAR/DAR and the normalization decision are mandatory inputs to
// the CPU-v1 contract and are validated before every other field, so even the
// negative cases below must supply them to reach the assertion under test.
// These rasters are square-pixel 16:9.
const GEO = {
  sampleAspectRatio: '1:1',
  displayAspectRatio: '16:9',
  geometryNormalization: 'none',
};

const sdr1080 = metric.resolveCpuV1Candidate({ ...GEO, width: 1920, height: 1080, isHdr: false, frameRate: 24 });
assert.strictEqual(sdr1080.productionEligible, false);
assert.strictEqual(sdr1080.backend, 'cpu');
assert.strictEqual(sdr1080.runtimePath, '/usr/local/bin/vmaf-v1');
assert.strictEqual(sdr1080.scoringBitDepth, 10);
assert.strictEqual(sdr1080.scoringPixelFormat, 'yuv420p10le');
assert.strictEqual(sdr1080.modelVersion, 'vmaf_v1.0.16_3d0h');
assert.strictEqual(sdr1080.contentClass, 'sdr');
assert.strictEqual(sdr1080.tonemap, false);
assert.strictEqual(sdr1080.cambi.integratedInModel, true);
assert.strictEqual(sdr1080.inferenceAuthorityContractId, 'paired-cq-vmaf-v1-cambi-inference-authority-v1');

const promotedSdr1080 = metric.resolveCpuV1Production({ ...GEO, width: 1920, height: 1080, isHdr: false, frameRate: 24, });
assert.strictEqual(promotedSdr1080.productionEligible, true);
assert.strictEqual(promotedSdr1080.qualificationStatus, 'promoted-production-authority');
assert.strictEqual(promotedSdr1080.authorityStatus, 'authoritative-supported-geometry');
assert.strictEqual(promotedSdr1080.metricContractId, sdr1080.metricContractId,
  'promotion must not relabel the calibrated metric identity');
const promotedHdr1080 = metric.resolveCpuV1Production({ ...GEO, width: 1920, height: 1080, isHdr: true, frameRate: 24, });
assert.strictEqual(promotedHdr1080.hdrValidationStatus,
  'provisional-hdr-explicitly-authorized-with-full-holdout');
assert.strictEqual(promotedHdr1080.authorityStatus, 'provisional-hdr-explicit-override');

const hdr1080 = metric.resolveCpuV1Candidate({ ...GEO, width: 1920, height: 1080, isHdr: true, frameRate: 24 });
assert.strictEqual(hdr1080.contentClass, 'hdr-pq');
assert.strictEqual(hdr1080.hdrValidationStatus, 'provisional-needs-real-content-calibration');
assert.notStrictEqual(hdr1080.metricContractId, sdr1080.metricContractId);
assert.strictEqual(hdr1080.modelVersion, sdr1080.modelVersion);

const sdr4k = metric.resolveCpuV1Candidate({ ...GEO, width: 3840, height: 2160, isHdr: false, frameRate: 24 });
assert.strictEqual(sdr4k.modelVersion, 'vmaf_v1.0.16_1d5h_2160');
assert.notStrictEqual(sdr4k.metricContractId, sdr1080.metricContractId);

const hfr4k = metric.resolveCpuV1Candidate({ ...GEO, width: 3840, height: 2160, isHdr: true, frameRate: 60 });
assert.strictEqual(hfr4k.modelVersion, 'vmaf_v1.0.16_hfr_1d5h_2160');
assert(hfr4k.metricContractId.includes('hfr'));

assert.throws(() => metric.resolveCpuV1Candidate({ ...GEO, width: 1920, height: 1080 }), /explicit isHdr/);
assert.throws(() => metric.resolveCpuV1Candidate({ ...GEO, width: 1920, height: 1080, isHdr: false, scoringBitDepth: 8 }), /native 10-bit/);
for (const [width, height] of [
  [1280, 720],
  [2560, 1440],
  [720, 480],
  [1080, 1920],
  [4096, 2160],
]) {
  assert.throws(() => metric.resolveCpuV1Production({
    width,
    height,
    sampleAspectRatio: '1:1',
    displayAspectRatio: `${width}:${height}`,
    geometryNormalization: 'none',
    isHdr: false,
  }), (error) => error.code === 'VMAF_V1_GEOMETRY_UNSUPPORTED');
}
assert.throws(() => metric.resolveCpuV1Production({
  width: 1920,
  height: 800,
  sampleAspectRatio: '1:1',
  displayAspectRatio: '16:9',
  geometryNormalization: 'none',
  isHdr: false,
}), (error) => error.code === 'VMAF_V1_GEOMETRY_ASPECT_MISMATCH');

const production = metric.resolveProduction({ width: 1920, height: 1080 });
assert.strictEqual(production.backend, 'cuda');
assert.strictEqual(production.scoringBitDepth, 8);
assert(!production.metricContractId.includes('v1.0.16-cpu'));

console.log('PASS immutable CPU VMAF-v1/CAMBI SDR and HDR candidate contracts');
