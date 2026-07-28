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
  if (request === '../../../../../methods/lib') {
    return () => ({ loadDefaultValues(inputs) { return inputs || {}; } });
  }
  return originalLoad.call(this, request, parent, isMain);
};

const age = require('./plugins/filter/checkFileAge/1.0.0/index.js')._test;
const cleanupModule = require('./plugins/vmaf/cleanupTempFiles/1.0.0/index.js');
const retry = require('./plugins/vmaf/monitorTranscodeRetry/1.0.0/index.js')._test;
const grain = require('./plugins/vmaf/_lib/grainAnalysisArtifact.js');
const transcode = require('./plugins/vmaf/vmafOptimizedTranscode/1.0.0/index.js')._test;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-plugin-safety-'));

try {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const futureAge = age.calculateFileAge(now + (40 * 86400000), now);
  assert.strictEqual(futureAge.future, true);
  assert.strictEqual(futureAge.ageMs, 0,
    'a future timestamp must be age zero, never its absolute offset');
  const pastAge = age.calculateFileAge(now - (8 * 86400000), now);
  assert.strictEqual(pastAge.future, false);
  assert.strictEqual(pastAge.ageDays, 8);

  const firstSeenRoot = path.join(scratch, 'too-young');
  const firstSeenSource = path.join(scratch, 'first-seen.mkv');
  fs.writeFileSync(firstSeenSource, 'source');
  const first = age.persistTooYoungFirstSeen({
    file: firstSeenSource,
    minAgeDays: 7,
    currentAgeDays: 0,
    eligibleAt: new Date(now + (7 * 86400000)).toISOString(),
    dateTypeUsed: 'creation',
  }, firstSeenRoot);
  const second = age.persistTooYoungFirstSeen({
    file: firstSeenSource,
    minAgeDays: 7,
    currentAgeDays: 1,
    eligibleAt: new Date(now + (6 * 86400000)).toISOString(),
    dateTypeUsed: 'creation',
  }, firstSeenRoot);
  assert.strictEqual(first.created, true);
  assert.strictEqual(second.created, false);
  assert.strictEqual(second.record.firstObservedAt, first.record.firstObservedAt,
    'the first-seen record must be immutable on repeated publication');
  assert.strictEqual(fs.readdirSync(firstSeenRoot)
    .filter((name) => name.endsWith('.json')).length, 1);

  const jobRoot = path.join(scratch, 'job');
  fs.mkdirSync(jobRoot);
  const owned = path.join(jobRoot, 'owned.tmp');
  const protectedSource = path.join(jobRoot, 'original.mkv');
  const foreign = path.join(scratch, 'foreign.tmp');
  fs.writeFileSync(owned, 'owned');
  fs.writeFileSync(protectedSource, 'original');
  fs.writeFileSync(foreign, 'foreign');
  const removed = cleanupModule._test.removeJobOwnedCandidates(
    jobRoot, [owned, protectedSource], [protectedSource]);
  assert.deepStrictEqual(removed.deleted, [path.resolve(owned)]);
  assert.strictEqual(fs.existsSync(owned), false);
  assert.strictEqual(fs.existsSync(protectedSource), true);

  fs.writeFileSync(owned, 'owned-again');
  assert.throws(
    () => cleanupModule._test.removeJobOwnedCandidates(
      jobRoot, [owned, foreign], [protectedSource]),
    /outside the canonical job directory/,
  );
  assert.strictEqual(fs.existsSync(owned), true,
    'the whole mutable cleanup manifest must validate before any deletion');
  assert.strictEqual(fs.existsSync(foreign), true);

  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = function failOwnedUnlink(target) {
    if (path.resolve(String(target)) === path.resolve(owned)) {
      const error = new Error('simulated busy file');
      error.code = 'EBUSY';
      throw error;
    }
    return originalUnlink.apply(this, arguments);
  };
  try {
    const variables = { vmafTemporaryFiles: [owned] };
    assert.throws(
      () => cleanupModule.plugin({
        inputFileObj: { _id: protectedSource },
        inputs: {},
        variables,
        workDir: jobRoot,
        jobLog() {},
      }),
      /cleanup did not complete/,
    );
    assert.deepStrictEqual(variables.vmafTemporaryFiles, [path.resolve(owned)],
      'failed deletions must remain registered for recovery');
    assert.strictEqual(variables.vmafCleanupStatus, 'failed');
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  const partial = path.join(jobRoot, 'partial.mkv');
  fs.writeFileSync(partial, 'partial');
  const retryArgs = {
    workDir: jobRoot,
    inputFileObj: { _id: protectedSource },
    originalLibraryFile: { _id: protectedSource },
    variables: { vmafOriginalFile: protectedSource },
  };
  assert.strictEqual(retry.removePartialOutputForRetry(retryArgs, partial).removed, true);
  assert.strictEqual(fs.existsSync(partial), false);
  assert.throws(
    () => retry.removePartialOutputForRetry(retryArgs, foreign),
    /outside the canonical job work root/,
  );
  assert.strictEqual(fs.existsSync(foreign), true);

  const mediaRoot = path.join(scratch, 'media');
  const outsideRoot = path.join(scratch, 'outside');
  fs.mkdirSync(mediaRoot);
  fs.mkdirSync(outsideRoot);
  const mediaSource = path.join(mediaRoot, 'movie.mkv');
  const outsideSource = path.join(outsideRoot, 'outside.mkv');
  fs.writeFileSync(mediaSource, 'media');
  fs.writeFileSync(outsideSource, 'outside');
  const escapedPattern = '^' + mediaRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    path.sep.replace('\\', '\\\\');
  assert.strictEqual(
    grain.resolveAllowlistedSourcePath(mediaSource, escapedPattern, 'i'),
    fs.realpathSync(mediaSource),
  );
  assert.strictEqual(
    grain.resolveAllowlistedSourcePath(outsideSource, escapedPattern, 'i'),
    null,
  );
  const linkedDirectory = path.join(mediaRoot, 'linked');
  try {
    fs.symlinkSync(outsideRoot, linkedDirectory,
      process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => grain.resolveAllowlistedSourcePath(
        path.join(linkedDirectory, 'outside.mkv'), escapedPattern, 'i'),
      /symlinked path component/,
    );
  } catch (error) {
    if (!error || !['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  }

  const noDuration = transcode.finalTranscodeWatchdogPolicy(0, {}, 'cq20');
  assert.strictEqual(noDuration.timeoutSeconds, 24 * 60 * 60);
  assert.strictEqual(noDuration.basis, 'missing-duration-fallback');
  const noSamples = transcode.finalTranscodeWatchdogPolicy(7200, {}, 'cq20');
  assert.strictEqual(noSamples.timeoutSeconds, (7200 * 12) + (2 * 60 * 60));
  assert.strictEqual(noSamples.basis, 'source-duration-conservative-fallback');
  const measured = transcode.finalTranscodeWatchdogPolicy(7200, {
    vmafSegmentDuration: 5,
    vmafTestResults: [
      { parameterSetId: 'cq20', encodingTimeSeconds: 10 },
      { parameterSetId: 'cq20', encodingTimeSeconds: 12 },
      { parameterSetId: 'cq20', encodingTimeSeconds: 14 },
      { parameterSetId: 'other', encodingTimeSeconds: 1000 },
    ],
  }, 'cq20');
  assert.strictEqual(measured.matchingSampleCount, 3);
  assert.strictEqual(measured.medianSampleEncodeSeconds, 12);
  assert.strictEqual(measured.projectedFullEncodeSeconds, 17280);
  assert.strictEqual(measured.timeoutSeconds, 76320);
  const floor = transcode.finalTranscodeWatchdogPolicy(60, {
    vmafSegmentDuration: 5,
    vmafTestResults: [{ parameterSetId: 'fast', encodingTimeSeconds: 0.5 }],
  }, 'fast');
  assert.strictEqual(floor.timeoutSeconds, 12 * 60 * 60);
  const ceiling = transcode.finalTranscodeWatchdogPolicy(24 * 60 * 60, {
    vmafSegmentDuration: 5,
    vmafTestResults: [{ parameterSetId: 'slow', encodingTimeSeconds: 100 }],
  }, 'slow');
  assert.strictEqual(ceiling.timeoutSeconds, 72 * 60 * 60);

  const parityPairs = [
    ['plugins/filter/checkFileAge/1.0.0/index.js',
      'custom-cont-init.d/filter-plugin-patches/checkFileAge/1.0.0/index.js'],
    ['plugins/vmaf/cleanupTempFiles/1.0.0/index.js',
      'custom-cont-init.d/vmaf-plugin-patches/cleanupTempFiles/1.0.0/index.js'],
    ['plugins/vmaf/monitorTranscodeRetry/1.0.0/index.js',
      'custom-cont-init.d/vmaf-plugin-patches/monitorTranscodeRetry/1.0.0/index.js'],
    ['plugins/vmaf/_lib/grainAnalysisArtifact.js',
      'custom-cont-init.d/vmaf-plugin-patches/_lib/grainAnalysisArtifact.js'],
    ['plugins/vmaf/analyzeFilmGrain/1.0.0/index.js',
      'custom-cont-init.d/vmaf-plugin-patches/analyzeFilmGrain/1.0.0/index.js'],
    ['plugins/vmaf/synthesizeFilmGrain/1.0.0/index.js',
      'custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js'],
    ['plugins/vmaf/vmafOptimizedTranscode/1.0.0/index.js',
      'custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js'],
  ];
  parityPairs.forEach(([source, mirror]) => {
    assert.strictEqual(fs.readFileSync(source, 'utf8'), fs.readFileSync(mirror, 'utf8'),
      `${source} and ${mirror} must remain byte-identical`);
  });

  console.log('PASS plugin safety boundaries (age, cleanup, retry, grain scope, watchdog, mirrors)');
} finally {
  Module._load = originalLoad;
  fs.rmSync(scratch, { recursive: true, force: true });
}
