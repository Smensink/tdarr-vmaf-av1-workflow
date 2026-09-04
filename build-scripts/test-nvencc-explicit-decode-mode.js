'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const patchRoot = fs.existsSync('/custom-cont-init.d/.vmaf-plugin-patches')
  ? '/custom-cont-init.d/.vmaf-plugin-patches'
  : path.join(__dirname, '..', 'custom-cont-init.d', '.vmaf-plugin-patches');
const nvenccRoot = fs.existsSync('/opt/nvencc-artifact')
  ? '/opt/nvencc-artifact'
  : path.join(__dirname, '..', 'custom-nvencc');
const grainRoot = fs.existsSync('/opt/grain-pipeline-artifact')
  ? '/opt/grain-pipeline-artifact'
  : path.join(__dirname, '..', '..', '..', 'custom-grain-pipeline');
const helper = require(path.join(
  patchRoot, '_lib', 'nvenccKnn.js'
));
const temporalPolicy = require(path.join(
  patchRoot, '_lib', 'nvencTemporalFilter.js'
));
const coordinator = require(path.join(
  nvenccRoot, 'libexec', 'tdarr-nvencc-knn-ffmpeg.js'
));

const base = {
  sourcePath: '/tmp/source.mkv',
  outputDepth: 10,
  producerLog: '/tmp/producer.log',
  nvenccPath: '/usr/local/bin/nvencc',
  ffmpegPath: '/usr/local/bin/tdarr-ffmpeg',
  ffmpegArgs: ['-i', 'pipe:0', '-f', 'null', '-'],
};

const hardwareProducer = helper.buildProducerArgs(base);
assert(hardwareProducer.includes('--avhw'));
const softwareProducer = helper.buildProducerArgs({ ...base, decodeMode: 'software' });
assert(!softwareProducer.includes('--avhw'));

const softwareCoordinator = helper.buildCoordinatorArgs({ ...base, decodeMode: 'software' });
const modeAt = softwareCoordinator.indexOf('--decode-mode');
assert(modeAt >= 0);
assert.strictEqual(softwareCoordinator[modeAt + 1], 'software');

const parsed = coordinator.parseArgs(softwareCoordinator);
assert.strictEqual(parsed.decodeMode, 'software');
assert(!coordinator.buildProducerArgs(parsed).includes('--avhw'));
assert.throws(() => helper.buildProducerArgs({ ...base, decodeMode: 'mystery' }),
  /decode mode must be hardware or software/);

const directArgs = helper.buildDirectEncodeArgs({
  sourcePath: '/tmp/source.mkv', outputPath: '/tmp/output.mkv', pixFmt: 'p010le',
  cq: 24, preset: 'p7', tfLevel: 0, sourceStream: { pix_fmt: 'yuv420p10le' },
});
assert(directArgs.includes('--aq'));
assert(directArgs.includes('--aq-strength'));
assert(directArgs.includes('--weightp'));
assert(!directArgs.includes('--aq-temporal'));
const ffmpegProfiles = [
  temporalPolicy.ENHANCED_QUALITY_FLAGS_CANONICAL,
  temporalPolicy.BASELINE_QUALITY_FLAGS_CANONICAL,
].map(temporalPolicy.tokenize);
for (const ffmpegQuality of ffmpegProfiles) {
  for (const option of ['-spatial-aq', '-aq-strength']) {
    assert(ffmpegQuality.includes(option), `FFmpeg measured profile requires ${option}`);
  }
  // FFmpeg 8.1.1 exposes -weighted_pred for av1_nvenc, but the RTX 5070 Ti
  // driver rejects every AV1 session that enables it with "No capable devices found".
  // The capability probe and all measured/final encodes must therefore omit it.
  assert(!ffmpegQuality.includes('-weighted_pred'));
  assert(!ffmpegQuality.includes('-temporal-aq'));
}
assert(temporalPolicy.REFERENCE_COMPARISON_ENCODER_PROFILE_ID.includes('no-weightp'));

const extractPlugin = require(path.join(
  patchRoot, 'extractVideoSamples', '1.0.0', 'index.js'
));
const sampleSpec = extractPlugin._test.buildDenoisedSampleArgs({
  sourcePath: '/tmp/source.mkv',
  outputPath: '/tmp/sample.mkv',
  targetSeconds: 100,
  durationSeconds: 5,
  stream: { pix_fmt: 'yuv420p10le', avg_frame_rate: '24000/1001' },
  ffmpegPath: '/usr/local/bin/tdarr-ffmpeg',
  nvenccPath: '/usr/local/bin/nvencc',
  coordinatorPath: '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js',
});
const requestedFramesAt = sampleSpec.argv.indexOf('--frames');
assert(requestedFramesAt >= 0);
assert.strictEqual(Number(sampleSpec.argv[requestedFramesAt + 1]), sampleSpec.frames + 2,
  'NVEncC producer must receive two boundary-headroom frames');
const consumerFramesAt = sampleSpec.argv.lastIndexOf('-frames:v');
assert(consumerFramesAt >= 0);
assert.strictEqual(Number(sampleSpec.argv[consumerFramesAt + 1]), sampleSpec.frames - 1,
  'FFmpeg output frame count must remain exact and unchanged');

const pipelineSource = fs.readFileSync(path.join(
  grainRoot, 'releases', 'v5-20260803-r4', 'grain_pipeline_v5_direct.py'
), 'utf8');
assert.match(pipelineSource, /"--decode-mode",\s*"software"/,
  'FFV1 grain-fit intermediates must request software decode explicitly');

console.log('PASS explicit software decode for FFV1 grain fitting and NVDEC default elsewhere');
