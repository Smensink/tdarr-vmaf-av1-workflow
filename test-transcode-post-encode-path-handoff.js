'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-transcode-handoff-'));
// Reproduce the live canary: the filename says .ts, while ffprobe identifies the
// actual container as Matroska and the authorized HDR10+ fallback selects MKV.
const sourcePath = path.join(scratch, 'source.ts');
const expectedOutputPath = path.join(scratch, 'source_vmaf_optimized.mkv');
const checkpointStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-transcode-checkpoints-'));
const checkpointRoot = path.join(checkpointStorage, 'checkpoints');
const reuseRequiredRoot = path.join(checkpointStorage, 'reuse-required');
let encodedPath = null;
let mergeCalls = 0;

class MockCLI {
  constructor(options) {
    this.options = options;
  }

  async runCli() {
    encodedPath = this.options.outputFilePath;
    fs.writeFileSync(encodedPath, Buffer.alloc(2048, 0x31));
    await Promise.resolve();
    return { cliExitCode: 0 };
  }
}

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../FlowHelpers/1.0.0/cliUtils') {
    return { CLI: MockCLI };
  }
  if (request === '../../../../../methods/lib') {
    return () => ({ loadDefaultValues(inputs) { return inputs || {}; } });
  }
  return originalLoad.call(this, request, parent, isMain);
};

const pluginPath = path.join(__dirname,
  'plugins/vmaf/vmafOptimizedTranscode/1.0.0/index.js');
const plugin = require(pluginPath).plugin;
const checkpoint = require(path.join(__dirname,
  'plugins/vmaf/_lib/postEncodeCheckpoint.js'));

function identify(containerTitle, tracks) {
  return {
    attachments: [],
    chapters: [],
    container: { supported: true, properties: { title: containerTitle } },
    errors: [],
    global_tags: [],
    tracks,
    warnings: [],
  };
}

const oldVideo = {
  type: 'video',
  codec: 'HEVC',
  properties: { codec_id: 'V_MPEGH/ISO/HEVC', uid: '101' },
};
const newVideo = {
  type: 'video',
  codec: 'AV1',
  properties: { codec_id: 'V_AV1', uid: '201' },
};
const sourceAudio = {
  type: 'audio',
  codec: 'AAC',
  properties: {
    codec_id: 'A_AAC',
    uid: '102',
    language: 'eng',
    default_track: true,
  },
};
const sourceIdentify = identify('handoff fixture', [oldVideo, sourceAudio]);
const videoIdentify = identify('', [newVideo]);
const outputIdentify = identify('handoff fixture', [newVideo, sourceAudio]);

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = function mockSpawnSync(command, argv) {
  if (command === 'ffprobe') {
    return {
      status: 0,
      stdout: JSON.stringify({
        streams: [{
          index: 0, codec_type: 'video', codec_name: 'av1',
          pix_fmt: 'yuv420p10le', avg_frame_rate: '24/1',
          nb_read_packets: '240', disposition: { attached_pic: 0 },
        }],
        format: { duration: '10', format_name: 'matroska,webm' },
      }),
      stderr: '',
    };
  }
  if (command === 'tdarr-ffmpeg') {
    return { status: 0, stdout: '', stderr: '' };
  }
  assert.strictEqual(command, 'mkvmerge', `unexpected child command: ${command}`);
  if (argv[0] === '-J') {
    const target = path.resolve(String(argv[1]));
    let payload;
    if (target === path.resolve(sourcePath)) payload = sourceIdentify;
    else if (target.endsWith('_vmaf_primary_video_only.mkv') ||
      target.endsWith('source.postencode.mkv')) payload = videoIdentify;
    else if (target.endsWith('.mkvmerge-partial.mkv')) payload = outputIdentify;
    else throw new Error(`unexpected mkvmerge identify target: ${target}`);
    return { status: 0, stdout: JSON.stringify(payload), stderr: '' };
  }

  mergeCalls += 1;
  const outputIndex = argv.indexOf('--output');
  assert(outputIndex >= 0 && argv[outputIndex + 1], 'mkvmerge output path is missing');
  fs.writeFileSync(argv[outputIndex + 1], Buffer.alloc(3072, 0x32));
  return { status: 0, stdout: '', stderr: '' };
};

async function main() {
  process.env.NODE_ENV = 'test';
  process.env.VMAF_POSTENCODE_TEST_UNPINNED_STORAGE = '1';
  process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT = checkpointRoot;
  process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT = reuseRequiredRoot;
  checkpoint.initializeReuseRequiredRoot(reuseRequiredRoot);
  fs.writeFileSync(sourcePath, Buffer.alloc(16384, 0x30));
  const logs = [];
  const args = {
    inputFileObj: {
      _id: sourcePath,
      file_size: 16384 / (1024 * 1024),
      ffProbeData: {
        format: { duration: '10', format_name: 'matroska,webm' },
        streams: [
          { index: 0, codec_type: 'video', disposition: { attached_pic: 0 } },
          { index: 1, codec_type: 'audio' },
        ],
      },
    },
    inputs: {},
    variables: {
      vmafBestParameters: {
        id: 'gpu_p7_cq28',
        encoder: 'av1_nvenc',
        preset: 'p7',
        quality: 28,
        isGPU: true,
        pixFmt: 'yuv420p10le',
      },
      vmafFinalSelectedCQ: 28,
      vmafSelectedParameterSetId: 'gpu_p7_cq28',
      vmafReferenceContractId: 'legacy-original-tf4-v1',
      vmafReferenceSelectorMode: 'legacy-original',
      vmafCanonicalDenoiseActive: false,
      vmafNvencTemporalPolicy: 'legacy-original',
      vmafDynamicHdrConversion: 'hdr10plus_to_hdr10',
      color_primaries: 'bt709',
      color_trc: 'bt709',
      colorspace: 'bt709',
    },
    workDir: scratch,
    ffmpegPath: 'tdarr-ffmpeg',
    jobLog(message) { logs.push(String(message)); },
  };

  const result = await plugin(args);
  assert.strictEqual(result.outputNumber, 1,
    `a successful video-only encode must survive the async resume and reach ancillary merge:\n${logs.join('\n')}`);
  assert.strictEqual(args.variables.vmafTranscodeStatus, 'success');
  assert.strictEqual(args.variables.vmafTranscodeSucceeded, true);
  assert.strictEqual(args.variables.vmafAncillaryPreservationMethod, 'mkvmerge-source-no-video-v1');
  assert.strictEqual(mergeCalls, 1, 'the Matroska ancillary merge must run exactly once');
  assert(encodedPath && path.resolve(encodedPath).startsWith(path.resolve(checkpointRoot) + path.sep) &&
    path.basename(encodedPath).startsWith('.encode-partial-'),
    'FFmpeg must write the isolated primary-video intermediate inside protected checkpoint storage');
  assert.strictEqual(path.resolve(result.outputFileObj._id), path.resolve(expectedOutputPath));
  assert.strictEqual(fs.existsSync(expectedOutputPath), true,
    'the verified final output must exist after the merge');
  assert.strictEqual(fs.existsSync(encodedPath), false,
    'the verified video-only intermediate should be removed after merge');
  assert(logs.some((line) => line.includes('Primary video encode completed')),
    'the post-await Matroska branch did not execute');
  assert(!logs.some((line) => line.includes('Final output size check failed')),
    'the final size check must inspect the merged output, not a nonexistent path');

  console.log('PASS transcode post-encode Matroska path handoff');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}).finally(() => {
  childProcess.spawnSync = originalSpawnSync;
  Module._load = originalLoad;
  fs.rmSync(scratch, { recursive: true, force: true });
});
