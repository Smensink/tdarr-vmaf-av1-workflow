'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../FlowHelpers/1.0.0/cliUtils') {
    return { CLI: class MockCLI {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-final-knn-path-'));
const sourcePath = path.join(scratch, 'source.mkv');
const workDir = path.join(scratch, 'work');
const checkpointRoot = path.join(scratch, 'checkpoints');
const outputPath = path.join(workDir, 'output.mkv');
const oldCoordinator = process.env.TDARR_NVENCC_COORDINATOR;
const oldNvencc = process.env.TDARR_NVENCC;

try {
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(sourcePath, Buffer.alloc(16384, 0x41));
  process.env.TDARR_NVENCC_COORDINATOR = process.execPath;
  process.env.TDARR_NVENCC = process.execPath;

  const transcode = require(
    './custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js')._test;
  const policy = require(
    './custom-cont-init.d/vmaf-plugin-patches/_lib/nvencTemporalFilter.js');

  assert.strictEqual(
    transcode.resolveExecutablePath(path.basename(process.execPath), 'Node.js'),
    fs.realpathSync(process.execPath)
  );

  const plan = transcode.buildProtectedPostEncodePlan({
    bestParams: {
      id: 'gpu_p7_cq30', encoder: 'av1_nvenc', preset: 'p7', quality: 30,
      isGPU: true, pixFmt: 'p010le',
    },
    variables: {
      vmafNvencFlagArgs: policy.qualityFlags(policy.CANONICAL_POLICY, true),
    },
    originalFile: sourcePath,
    workDir,
    checkpointRoot,
    reuseRequiredRoot: '',
    requireInitializedReuseRequiredRoot: false,
    enforcePinnedStorage: false,
    ffmpegPath: path.basename(process.execPath),
    ffprobePath: process.execPath,
    inputProbeData: {
      format: { duration: '10', format_name: 'matroska,webm' },
      streams: [{
        index: 0, codec_type: 'video', codec_name: 'hevc',
        width: 1920, height: 1080, pix_fmt: 'yuv420p10le',
        avg_frame_rate: '24/1', disposition: { attached_pic: 0 },
      }],
    },
    contractOutputPath: outputPath,
    pixFmt: 'p010le',
    useCQ: 30,
    colorPrimaries: 'bt2020',
    colorTrc: 'smpte2084',
    colorspace: 'bt2020nc',
    useCanonicalDenoise: true,
    temporalPolicy: policy.CANONICAL_POLICY,
    useMatroskaAncillaryBypass: true,
  });

  const ffmpegIndex = plan.spawnArgs.indexOf('--ffmpeg');
  assert(ffmpegIndex >= 0, 'canonical full-title coordinator argv lacks --ffmpeg');
  assert.strictEqual(plan.spawnArgs[ffmpegIndex + 1], fs.realpathSync(process.execPath));
  assert(path.isAbsolute(plan.spawnArgs[ffmpegIndex + 1]));
  assert.strictEqual(plan.encodeContract.consumer_identity.resolved_path,
    fs.realpathSync(process.execPath));

  const source = fs.readFileSync(
    './custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js', 'utf8');
  assert(!/ffmpegPath:\s*options\.ffmpegPath,\s*\n\s*ffmpegArgs: ffmpegConsumerArgs/.test(source),
    'canonical final-title coordinator still receives raw args.ffmpegPath');

  console.log('PASS canonical full-title coordinator receives an absolute FFmpeg path');
} finally {
  Module._load = originalLoad;
  if (oldCoordinator === undefined) delete process.env.TDARR_NVENCC_COORDINATOR;
  else process.env.TDARR_NVENCC_COORDINATOR = oldCoordinator;
  if (oldNvencc === undefined) delete process.env.TDARR_NVENCC;
  else process.env.TDARR_NVENCC = oldNvencc;
  fs.rmSync(scratch, { recursive: true, force: true });
}
