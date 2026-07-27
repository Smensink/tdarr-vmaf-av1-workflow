'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../FlowHelpers/1.0.0/cliUtils') {
    return { CLI: class MockCLI {} };
  }
  if (request === '../../../../../methods/lib') {
    return () => ({ loadDefaultValues(inputs) { return inputs || {}; } });
  }
  return originalLoad.call(this, request, parent, isMain);
};
const transcodePlugin = require('./plugins/vmaf/vmafOptimizedTranscode/1.0.0/index.js').plugin;
const monitorPlugin = require('./plugins/vmaf/monitorTranscodeRetry/1.0.0/index.js').plugin;

function makeArgs(variables) {
  const logs = [];
  return {
    inputFileObj: {
      _id: 'C:/media/test.mkv',
      file_size: 1000,
      ffProbeData: { format: { duration: '3600' }, streams: [] },
    },
    inputs: {},
    variables: variables || {},
    workDir: 'C:/temp',
    ffmpegPath: 'ffmpeg',
    jobLog(message) { logs.push(String(message)); },
    _logs: logs,
  };
}

async function main() {
  const noParamsArgs = makeArgs({});
  const noParamsResult = await transcodePlugin(noParamsArgs);
  assert.strictEqual(noParamsResult.outputNumber, 2, 'transcode plugin should route no-parameter state to monitor');
  assert.strictEqual(noParamsArgs.variables.vmafTranscodeSucceeded, false);
  assert.strictEqual(noParamsArgs.variables.vmafTranscodeStatus, 'keep_original_no_parameters');
  assert.strictEqual(noParamsArgs.variables.vmafTranscodeFailureReason, 'no_optimal_parameters');

  const keepResult = monitorPlugin(noParamsArgs);
  assert.strictEqual(keepResult.outputNumber, 4, 'no-parameter state must bypass the success/replacement branch');
  assert.strictEqual(noParamsArgs.variables.vmafTranscodeGaveUp, true);
  assert.ok(!noParamsArgs._logs.some((line) => line.includes('Transcode completed successfully')),
    'keep-original path must never log transcode success');

  const successArgs = makeArgs({
    vmafTranscodeStatus: 'success',
    vmafTranscodeSucceeded: true,
    vmafBestParameters: { quality: 30 },
  });
  const successResult = monitorPlugin(successArgs);
  assert.strictEqual(successResult.outputNumber, 2, 'only explicit success may reach downstream replacement');
  assert.ok(successArgs._logs.some((line) => line.includes('Transcode completed successfully')));

  const technicalArgs = makeArgs({
    vmafTranscodeStatus: 'technical_failure',
    vmafTranscodeSucceeded: false,
    vmafTranscodeFailureReason: 'ffmpeg_exit_code_1',
  });
  assert.throws(
    () => monitorPlugin(technicalArgs),
    /did not complete successfully/,
    'technical failures must fail closed',
  );

  const unknownArgs = makeArgs({});
  assert.throws(
    () => monitorPlugin(unknownArgs),
    /did not complete successfully/,
    'missing outcome state must fail closed',
  );

  const exhaustedSizeArgs = makeArgs({
    vmafTranscodeStatus: 'size_failed',
    vmafTranscodeSucceeded: false,
    vmafTranscodeFailureReason: 'live_size_guard_exceeded',
    vmafTranscodeRetryCount: 3,
    vmafBestParameters: { quality: 30 },
    liveSizeCompare: { enabled: true, error: true, errorType: 'upperThreshold' },
  });
  const exhaustedSizeResult = monitorPlugin(exhaustedSizeArgs);
  assert.strictEqual(exhaustedSizeResult.outputNumber, 4, 'exhausted size retries must keep the original without replacement');
  assert.strictEqual(exhaustedSizeArgs.variables.vmafTranscodeStatus, 'keep_original_size_retries_exhausted');

  console.log('PASS transcode outcome state machine (5 cases)');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
});
