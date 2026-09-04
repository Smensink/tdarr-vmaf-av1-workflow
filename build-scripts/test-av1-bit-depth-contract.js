'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../FlowHelpers/1.0.0/cliUtils') {
    return { CLI: class MockCLI {} };
  }
  if (request === '../../../../../methods/lib') {
    return function () {
      return { loadDefaultValues(inputs) { return inputs || {}; } };
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const patchRoot = fs.existsSync('/custom-cont-init.d/.vmaf-plugin-patches')
  ? '/custom-cont-init.d/.vmaf-plugin-patches'
  : path.resolve(__dirname, '../custom-cont-init.d/.vmaf-plugin-patches');
const nvencc = require(path.join(patchRoot, '_lib/nvenccKnn.js'));
const transcode = require(path.join(
  patchRoot, 'vmafOptimizedTranscode/1.0.0/index.js'
))._test;
const selector = require(path.join(
  patchRoot, 'selectBestParameters/1.0.0/index.js'
))._test;
const samples = require(path.join(
  patchRoot, 'testEncodingParameters/1.0.0/index.js'
))._test;
const grain = require(path.join(
  patchRoot, 'synthesizeFilmGrain/1.0.0/index.js'
))._test;
const temporal = require(path.join(patchRoot, '_lib/nvencTemporalFilter.js'));

const variables = { vmafRecommendedPixFmt: 'p010le' };
const selectedPixFmt = variables.vmafRecommendedPixFmt;
const directArgs = nvencc.buildDirectEncodeArgs({
  sourcePath: '/media/eight-bit-sdr-h264.mkv',
  outputPath: '/work/video-only-av1.mkv',
  pixFmt: selectedPixFmt,
  // A stale source-derived value must not override the selected output format.
  outputDepth: 8,
  cq: 24,
  preset: 'p7',
  tfLevel: 0,
  sourceStream: {
    codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p',
    color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709',
  },
  colorPrimaries: 'bt709',
  colorTrc: 'bt709',
  colorspace: 'bt709',
});
const outputDepthAt = directArgs.indexOf('--output-depth');
assert(outputDepthAt >= 0, 'direct NVEncC must declare its selected output depth');
assert.strictEqual(directArgs[outputDepthAt + 1], '10',
  'direct NVEncC output depth must derive from selected p010le, not the 8-bit source');
for (const [flag, value] of [
  ['--colorprim', 'bt709'], ['--transfer', 'bt709'], ['--colormatrix', 'bt709'],
]) {
  const at = directArgs.indexOf(flag);
  assert(at >= 0 && directArgs[at + 1] === value, `direct NVEncC must preserve ${flag}=${value}`);
}

const sampleArgs = samples.buildSampleEncodeArgs({
  encoder: 'av1_nvenc', isGPU: true, pixFmt: selectedPixFmt,
  quality: 24, preset: 'p7',
  colorPrimaries: 'bt709', colorTrc: 'bt709', colorspace: 'bt709',
}, '/work/eight-bit-source-sample.mkv', '/work/measured-av1-sample.mkv',
  temporal.qualityFlags(temporal.CANONICAL_POLICY, false),
  { canonicalInput: true, temporalPolicy: temporal.CANONICAL_POLICY });
const samplePixFmtAt = sampleArgs.indexOf('-pix_fmt');
assert(samplePixFmtAt >= 0);
assert.strictEqual(sampleArgs[samplePixFmtAt + 1], selectedPixFmt);
assert.strictEqual(nvencc.outputDepthForPixelFormat(sampleArgs[samplePixFmtAt + 1]),
  Number(directArgs[outputDepthAt + 1]),
  'sample and final AV1 encodes must share one selected bit depth');
const bridge = selector.publishEncoderDomainBridge(
  variables, { encoder: 'av1_nvenc' }, sampleArgs[samplePixFmtAt + 1],
  variables.vmafRecommendedPixFmt, 24);
assert.strictEqual(bridge.measurement_bit_depth, 10);
assert.strictEqual(bridge.delivery_bit_depth, 10);
assert.strictEqual(bridge.correction.cq_offset, 0);
assert.strictEqual(bridge.measurement_cq, bridge.delivery_cq,
  'selector must explicitly record the cross-frontend CQ correction');

const ancillaryArgs = transcode.buildMkvmergeAncillaryArgs(
  '/work/video-only-av1.mkv', '/media/eight-bit-sdr-h264.mkv',
  '/work/delivered.partial.mkv', 'Episode title');
assert.deepStrictEqual(ancillaryArgs.slice(-2), [
  '--no-video', '/media/eight-bit-sdr-h264.mkv',
], 'delivery remux must retain all ancillary payloads from the untouched source');
assert(grain.hasSemanticGrain([
  'filmgrn1', 'E 0 9223372036854775807 1', 'sY 1 0 24',
].join('\n')), 'grain contract fixture must carry a non-zero semantic grain header');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-av1-depth-contract-'));
const artifactPath = path.join(scratch, 'video-only-av1.mkv');
fs.writeFileSync(artifactPath, Buffer.alloc(4096, 0x61));
const sourceProbe = {
  format: { duration: '100' },
  streams: [
    {
      index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p',
      width: 1920, height: 1080, avg_frame_rate: '24/1',
      color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709',
      disposition: { attached_pic: 0 },
    },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
    { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
  ],
};
let probedPixFmt = 'yuv420p10le';
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function mockSpawnSync(command) {
  if (command === 'ffprobe') {
    return {
      status: 0,
      stdout: JSON.stringify({
        format: { format_name: 'matroska,webm', duration: '100' },
        streams: [{
          index: 0, codec_type: 'video', codec_name: 'av1', pix_fmt: probedPixFmt,
          width: 1920, height: 1080, avg_frame_rate: '24/1', r_frame_rate: '24/1',
          color_primaries: 'bt709', color_transfer: 'bt709', color_space: 'bt709',
          disposition: { attached_pic: 0 },
        }],
      }),
      stderr: '',
    };
  }
  assert.strictEqual(command, 'ffmpeg');
  return { status: 0, stdout: '', stderr: '' };
};

try {
  const report = transcode.validatePostEncodeMedia(
    'ffprobe', 'ffmpeg', artifactPath, sourceProbe,
    { width: 1920, height: 1080 }, true,
    { sourcePath: '/media/eight-bit-sdr-h264.mkv', requestedPixFmt: selectedPixFmt }
  );
  assert.strictEqual(report.primary.pix_fmt, 'yuv420p10le');
  assert.strictEqual(report.primary.requested_pix_fmt, selectedPixFmt);
  assert.strictEqual(report.primary.bit_depth, 10);
  assert.strictEqual(report.duration_seconds, 100, 'duration parity must remain exact');

  probedPixFmt = 'yuv420p';
  assert.throws(() => transcode.validatePostEncodeMedia(
    'ffprobe', 'ffmpeg', artifactPath, sourceProbe,
    { width: 1920, height: 1080 }, true,
    { sourcePath: '/media/eight-bit-sdr-h264.mkv', requestedPixFmt: selectedPixFmt }
  ), /pixel format.*p010le.*yuv420p|bit depth.*10.*8/i,
  'post-encode validation must fail closed when a requested 10-bit AV1 is delivered as 8-bit');

  console.log('PASS 8-bit SDR H.264 -> selected/measured/delivered 10-bit AV1 contract');
} finally {
  childProcess.spawnSync = originalSpawnSync;
  Module._load = originalLoad;
  fs.rmSync(scratch, { recursive: true, force: true });
}
