'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const originalLoad = Module._load;
let metadataResponder = null;

function fakeClient() {
  return {
    get(url, options, callback) {
      const req = new EventEmitter();
      req.destroy = () => {};
      process.nextTick(() => metadataResponder(url, options, callback, req));
      return req;
    },
  };
}

Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../../methods/lib') {
    return () => ({ loadDefaultValues(inputs) { return inputs || {}; } });
  }
  if (request === 'http' || request === 'https') return fakeClient();
  return originalLoad.call(this, request, parent, isMain);
};

function response(callback, payload, options = {}) {
  const res = new EventEmitter();
  res.statusCode = options.statusCode || 200;
  res.headers = options.headers || {};
  res.resume = options.resume || (() => {});
  res.destroy = options.destroy || (() => {});
  callback(res);
  if (payload !== undefined) res.emit('data', Buffer.from(payload));
  res.emit('end');
}

function runSimplePlugin(plugin, inputFileObj, inputs) {
  const logs = [];
  const args = {
    inputFileObj,
    inputs,
    variables: {},
    jobLog(message) { logs.push(String(message)); },
  };
  return { result: plugin(args), args, logs };
}

async function main() {
  const bracket = require('./plugins/vmaf/checkCQBracket/1.0.0/index.js')._test;
  assert.deepStrictEqual(bracket.resolveCriticalDefaults({}), bracket.CRITICAL_DEFAULTS);
  assert.strictEqual(bracket.resolveCriticalDefaults({ highMarginVMAFHeadroom: '0' }).highMarginVMAFHeadroom, 0);
  assert.strictEqual(bracket.resolveCriticalDefaults({ expansionCQCount: '-2' }).expansionCQCount, 2);

  const fileLimitsModule = require('./plugins/vmaf/checkFileLimits/1.0.0/index.js');
  assert.strictEqual(fileLimitsModule._test.fileSizeGiB({ file_size: 51200 }), 50);
  let run = runSimplePlugin(fileLimitsModule.plugin, {
    file_size: 60000,
    ffProbeData: { format: { duration: 10 * 3600 } },
  }, { maxFileSizeGB: '0', maxDurationHours: '0' });
  assert.strictEqual(run.result.outputNumber, 1, 'zero must disable both limits');
  run = runSimplePlugin(fileLimitsModule.plugin, {
    file_size: 51201,
    ffProbeData: { format: { duration: 60 } },
  }, { maxFileSizeGB: '50', maxDurationHours: '4' });
  assert.strictEqual(run.result.outputNumber, 2, 'Tdarr MiB size must be converted before comparison');

  const codecModule = require('./plugins/vmaf/checkVideoCodec/1.0.0/index.js');
  run = runSimplePlugin(codecModule.plugin, {
    ffProbeData: { streams: [
      { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'av1' },
      { codec_type: 'video', codec_name: 'hevc' },
    ] },
  }, { targetCodec: 'av1' });
  assert.strictEqual(run.result.outputNumber, 1, 'a non-target ordinary secondary video stream requires transcode');
  run = runSimplePlugin(codecModule.plugin, {
    ffProbeData: { streams: [
      { codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { codec_type: 'video', codec_name: 'av1' },
    ] },
  }, { targetCodec: 'av1' });
  assert.strictEqual(run.result.outputNumber, 2, 'attached artwork must not defeat an exact all-stream match');
  assert.strictEqual(codecModule._test.canonicalCodec('av1_decoder'), 'av1_decoder', 'codec aliases must not substring-match');

  const retiredScene = require('./plugins/vmaf/detectSceneComplexity/1.0.0/index.js');
  run = runSimplePlugin(retiredScene.plugin, { ffProbeData: {} }, {});
  assert.strictEqual(retiredScene.details().name, '[Retired] Detect Scene Complexity');
  assert.strictEqual(run.args.variables.vmafSceneSampleAdjustment, undefined);
  assert.strictEqual(run.args.variables.vmafDetectSceneComplexityRetired, true);

  const retiredLearning = require('./plugins/vmaf/learnCQRanges/1.0.0/index.js');
  run = runSimplePlugin(retiredLearning.plugin, {}, {});
  assert.strictEqual(run.result.outputNumber, 2);
  assert.strictEqual(run.args.variables.vmafLearnCQRangesRetired, true);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-plugin-correctness-'));
  try {
    const exporter = require('./plugins/vmaf/exportVMAFResults/1.0.0/index.js')._test;
    const sidecarPrefix = path.join(tempRoot, 'results.csv');
    const exportedPath = exporter.writeExclusiveSidecar(
      fs, path, sidecarPrefix, 'job/one', 'results', 'header\nrow\n');
    assert.strictEqual(fs.readFileSync(exportedPath, 'utf8'), 'header\nrow\n');
    assert.ok(exportedPath.startsWith(sidecarPrefix + '.d' + path.sep));

    const learner = require('./plugins/vmaf/learnCQRange/1.0.0/index.js')._test;
    assert.strictEqual(learner.preTranscodeOutcomeLabel(), '');
    const legacy = learner.exclusiveTelemetryPath(path, path.join(tempRoot, 'learn.csv'), 'job/two', '.csv');
    fs.mkdirSync(legacy.directory, { recursive: true });
    learner.writeExclusiveText(fs, legacy.file, 'pending\n');
    assert.strictEqual(fs.readFileSync(legacy.file, 'utf8'), 'pending\n');
    assert.throws(() => learner.writeExclusiveText(fs, legacy.file, 'overwrite\n'), /exist/i,
      'exclusive telemetry files must never append or overwrite');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const metadata = require('./plugins/vmaf/fetchMediaMetadata/1.0.0/index.js').plugin;
  const requested = [];
  metadataResponder = (url, options, callback) => {
    requested.push(url);
    if (url.includes('/search/multi')) {
      response(callback, JSON.stringify({ results: [
        { id: 1, media_type: 'movie', title: 'Unrelated', release_date: '2098-01-01' },
        { id: 2, media_type: 'movie', title: 'Synthetic Feature', release_date: '2099-03-31' },
      ] }));
    } else if (url.includes('/movie/2')) {
      response(callback, JSON.stringify({
        genres: [{ name: 'Science Fiction' }],
        release_date: '2099-03-31',
        original_language: 'en',
      }));
    } else {
      response(callback, JSON.stringify({}));
    }
  };
  let metadataArgs = {
    inputFileObj: { _id: 'C:\\media\\Synthetic.Feature.(2099).2160p-[TESTGROUP].mkv' },
    inputs: { enableMetadata: true, tmdbApiKey: 'secret', logMetadata: false },
    variables: {},
    jobLog() {},
  };
  let metadataResult = await metadata(metadataArgs);
  assert.strictEqual(metadataResult.variables.vmafMediaYear, 2099, 'parenthesized year must survive filename parsing');
  assert.strictEqual(metadataResult.variables.vmafReleaseGroup, 'TESTGROUP');
  assert.ok(requested.some((url) => url.includes('/movie/2')));
  assert.ok(!requested.some((url) => url.includes('/movie/1')), 'search result zero must not be accepted blindly');

  let resumed = false;
  metadataResponder = (url, options, callback) => {
    response(callback, undefined, {
      headers: { 'content-length': String(1024 * 1024 + 1) },
      resume() { resumed = true; },
    });
  };
  metadataArgs = {
    inputFileObj: { _id: 'C:\\media\\Bounded.Movie.[2024].mkv' },
    inputs: { enableMetadata: true, tmdbApiKey: 'secret', logMetadata: false },
    variables: {},
    jobLog() {},
  };
  metadataResult = await metadata(metadataArgs);
  assert.strictEqual(resumed, true, 'oversized response must be rejected before buffering');
  assert.strictEqual(metadataResult.variables.vmafMediaMetadataSource, 'none');
  assert.strictEqual(metadataResult.variables.vmafMediaYear, 2024);

  console.log('PASS lower-priority plugin correctness sweep (25 assertions)');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
