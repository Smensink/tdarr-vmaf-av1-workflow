'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const denoise = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/canonicalDenoise.js');
const extract = require('./custom-cont-init.d/vmaf-plugin-patches/extractVideoSamples/1.0.0/index.js')._test;
const vmaf = require('./custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js')._test;

function dockerExec(argv, options) {
  const result = childProcess.spawnSync('docker', ['exec', 'tdarr'].concat(argv), Object.assign({
    encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  }, options || {}));
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`docker exec failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const stem = `/tmp/canonical-reference-${process.pid}-${Date.now()}`;
const source = `${stem}-source.mkv`;
const output = `${stem}-denoised.mkv`;

try {
  assert.strictEqual(
    extract.resolveExecutablePath(path.basename(process.execPath), 'Node.js'),
    fs.realpathSync(process.execPath)
  );
  assert.throws(
    () => extract.resolveExecutablePath('definitely-not-a-real-tdarr-tool', 'fixture tool'),
    /fixture tool executable not found/
  );
  const extractSource = fs.readFileSync(
    'custom-cont-init.d/vmaf-plugin-patches/extractVideoSamples/1.0.0/index.js', 'utf8'
  );
  assert.match(extractSource, /canonicalFfmpegPath\s*=\s*useCanonicalDenoise/);
  assert.match(extractSource, /ffmpegPath:\s*canonicalFfmpegPath/g);
  assert.doesNotMatch(extractSource, /ffmpegPath:\s*args\.ffmpegPath/);

  const selectedStream = extract.getVideoStream({
    ffProbeData: {
      streams: [
        {
          codec_type: 'video', width: 48, height: 48,
          disposition: { attached_pic: 1 }, tags: { filename: 'cover.jpg' },
        },
        {
          codec_type: 'video', codec_name: 'hevc', width: 3840, height: 1920,
          pix_fmt: 'yuv420p10le', color_range: 'tv', color_primaries: 'bt2020',
          color_transfer: 'smpte2084', color_space: 'bt2020nc',
          chroma_location: 'topleft', field_order: 'progressive',
          disposition: { default: 1 },
        },
      ],
    },
  });
  assert.strictEqual(selectedStream.typeIndex, 1);
  assert.strictEqual(selectedStream.width, 3840);
  assert.strictEqual(selectedStream.pix_fmt, 'yuv420p10le');
  const selectedMetadataArgs = extract.buildMkvColorMetadataArgs('selected.mkv', selectedStream);
  assert.ok(selectedMetadataArgs.includes('colour-transfer-characteristics=16'));
  assert.ok(selectedMetadataArgs.includes('colour-primaries=9'));
  assert.ok(selectedMetadataArgs.includes('chroma-siting-horizontal=1'));

  // Material pixel fixture, not a mocked command: 12 seconds of 10-bit FFV1 with
  // explicit BT.2020 SDR metadata exercises the exact production filter/codec path.
  dockerExec([
    'tdarr-ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=12',
    '-vf', 'format=yuv420p10le', '-c:v', 'ffv1', '-level', '3', '-slicecrc', '1',
    '-color_range', 'tv', '-color_primaries', 'bt2020', '-color_trc', 'bt2020-10',
    '-colorspace', 'bt2020nc', source,
  ]);

  const stream = {
    typeIndex: 0, width: 1280, height: 720, pix_fmt: 'yuv420p10le',
    avg_frame_rate: '24/1',
    color_range: 'tv', color_primaries: 'bt2020', color_transfer: 'bt2020-10',
    color_space: 'bt2020nc', chroma_location: 'left', field_order: 'progressive',
  };
  const spec = extract.buildDenoisedSampleArgs({
    sourcePath: source, outputPath: output, targetSeconds: 8, durationSeconds: 2, stream,
    ffmpegPath: '/usr/local/bin/tdarr-ffmpeg',
  });
  assert.strictEqual(spec.executable, denoise.COORDINATOR_PATH);
  assert.strictEqual(spec.seekSeconds, 8);
  assert.strictEqual(spec.trimOffsetSeconds, 0);
  assert.strictEqual(spec.readDurationSeconds, 2);
  assert.strictEqual(spec.outputDepth, 10);
  assert.strictEqual(spec.frames, 49);
  assert.strictEqual(spec.argv.includes('--nvencc'), true);
  assert.strictEqual(spec.argv.includes(denoise.NVENCC_PATH), true);
  assert.strictEqual(spec.argv.includes('--output-depth'), true);
  assert.strictEqual(spec.argv.includes('10'), true);
  assert.strictEqual(spec.argv.includes('--seek'), true);
  assert.strictEqual(spec.argv.includes('8.000000'), true);
  assert.strictEqual(spec.argv.includes('-hwaccel'), false);
  denoise.assertCanonicalExactlyOnce(spec.argv, '10-bit FFV1 reference fixture');
  dockerExec([spec.executable].concat(spec.argv));
  dockerExec(['mkvpropedit'].concat(extract.buildMkvColorMetadataArgs(output, stream)));

  const probe = JSON.parse(dockerExec([
    'tdarr-ffprobe', '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,chroma_location,field_order',
    '-show_entries', 'format=duration', '-of', 'json', output,
  ]));
  const actual = probe.streams[0];
  assert.strictEqual(actual.codec_name, 'ffv1');
  assert.strictEqual(actual.width, 1280);
  assert.strictEqual(actual.height, 720);
  assert.strictEqual(actual.pix_fmt, 'yuv420p10le');
  assert.strictEqual(actual.color_range, 'tv');
  assert.strictEqual(actual.color_primaries, 'bt2020');
  assert.strictEqual(actual.color_transfer, 'bt2020-10');
  assert.strictEqual(actual.color_space, 'bt2020nc');
  assert.strictEqual(actual.chroma_location, 'left');
  assert.strictEqual(actual.field_order, 'progressive');
  assert.ok(Number(probe.format.duration) >= 1.9 && Number(probe.format.duration) <= 2.1);
  dockerExec(['tdarr-ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', output, '-map', '0:v:0', '-f', 'null', '-']);

  const nearStart = extract.buildDenoisedSampleArgs({
    sourcePath: source, outputPath: output, targetSeconds: 2, durationSeconds: 2, stream,
    ffmpegPath: '/usr/local/bin/tdarr-ffmpeg',
  });
  assert.strictEqual(nearStart.seekSeconds, 2);
  assert.strictEqual(nearStart.trimOffsetSeconds, 0);
  assert.strictEqual(nearStart.readDurationSeconds, 2);

  const gpuVmaf = vmaf.buildGpuVmafCommand(
    'tdarr-ffmpeg', 'distorted-av1.mkv', 'canonical-ffv1.mkv', 'vmaf.json', '',
    { ffProbeData: { streams: [{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le' }] } },
    false, 'av1_nvenc', 1,
  );
  assert.ok(gpuVmaf.indexOf('-c:v av1_cuvid -i "distorted-av1.mkv"') >= 0);
  assert.ok(gpuVmaf.indexOf('-i "canonical-ffv1.mkv"') > gpuVmaf.indexOf('-i "distorted-av1.mkv"'));
  assert.ok(!gpuVmaf.includes('hevc_cuvid'), 'reference decoder must not be derived from the source codec');
  assert.ok(!gpuVmaf.includes('ffv1_cuvid'), 'FFV1 reference must software-decode');
  console.log('PASS real 10-bit canonical-denoised FFV1 reference fixture');
} finally {
  for (const file of [source, output]) {
    try { dockerExec(['rm', '-f', file], { timeout: 30000 }); } catch (_) {}
  }
}
