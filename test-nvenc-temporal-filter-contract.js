'use strict';

const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request === '../../../../FlowHelpers/1.0.0/cliUtils') {
    return { CLI: class MockCLI { runCli() { return Promise.resolve({ cliExitCode: 1 }); } } };
  }
  if (request === '../../../../../methods/lib') {
    return () => ({ loadDefaultValues(inputs) { return Object.assign({}, inputs || {}); } });
  }
  return originalLoad.call(this, request, parent, isMain);
};

const policy = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/nvencTemporalFilter.js');
const denoise = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/canonicalDenoise.js');
const grainVmafContract = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/grainVmafContract.js');
const sampleTest = require('./custom-cont-init.d/vmaf-plugin-patches/testEncodingParameters/1.0.0/index.js')._test;
const holdoutTest = require('./custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js')._test;
const finalTest = require('./custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js')._test;

const losslessUidFixture = finalTest.parseMkvmergeIdentifyJson(
  '{"tracks":[{"properties":{"uid":18446744073709551614}}],' +
  '"attachments":[{"properties":{"uid":18446744073709551613}}]}', 'uid-fixture');
assert.strictEqual(losslessUidFixture.tracks[0].properties.uid, '18446744073709551614');
assert.strictEqual(losslessUidFixture.attachments[0].properties.uid, '18446744073709551613');
const finalPluginSource = require('fs').readFileSync(
  './custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js', 'utf8');
const sourcePreflightCall = finalPluginSource.indexOf(
  'var _sourceMkvPreflight = preflightMatroskaAncillarySource(originalFile);');
const finalFfmpegStart = finalPluginSource.indexOf('new cliUtils_1.CLI({');
const ancillaryRemuxStart = finalPluginSource.indexOf(
  'var _mkvPreservation = preserveMatroskaAncillaryWithMkvmerge(');
assert.ok(sourcePreflightCall >= 0 && sourcePreflightCall < finalFfmpegStart &&
  finalFfmpegStart < ancillaryRemuxStart,
'Matroska source topology must be attested before final FFmpeg encode and ancillary remux');

function count(argv, token) {
  return argv.filter((item) => item === token).length;
}

function value(argv, option) {
  const index = argv.indexOf(option);
  return index < 0 ? undefined : argv[index + 1];
}

function assertCanonical(argv, label) {
  policy.assertAv1NvencCommand(argv, policy.CANONICAL_POLICY, label);
  assert.ok(count(argv, '-tf_level') <= 1, `${label}: duplicate tf_level`);
  if (count(argv, '-tf_level')) assert.strictEqual(value(argv, '-tf_level'), '0');
}

function assertLegacy(argv, label) {
  policy.assertAv1NvencCommand(argv, policy.LEGACY_POLICY, label);
  assert.strictEqual(count(argv, '-tf_level'), 1, `${label}: expected one tf_level`);
  assert.strictEqual(value(argv, '-tf_level'), '4');
}

function assertBypass(argv, label) {
  policy.assertAv1NvencCommand(argv, policy.FGS_BYPASS_POLICY, label);
  assert.ok(count(argv, '-tf_level') <= 1, `${label}: duplicate tf_level`);
  if (count(argv, '-tf_level')) assert.strictEqual(value(argv, '-tf_level'), '0');
}

const parameterSet = {
  id: 'gpu_p7_cq30', isGPU: true, encoder: 'av1_nvenc', preset: 'p7', quality: 30,
  pixFmt: 'p010le', colorPrimaries: 'bt2020', colorTrc: 'bt2020-10', colorspace: 'bt2020nc',
};
const canonicalFlags = policy.qualityFlags(policy.CANONICAL_POLICY, true);
const bypassFlags = policy.qualityFlags(policy.FGS_BYPASS_POLICY, true);
const legacyFlags = policy.qualityFlags(policy.LEGACY_POLICY, true);
assert.strictEqual(denoise.FGS_BYPASS_REFERENCE_CONTRACT_ID, 'fgs-bypass-original-tf0-v1');
assert.deepStrictEqual(grainVmafContract.forDisposition('prepared'), {
  disposition: 'prepared',
  selectorMode: grainVmafContract.SELECTOR_MODE_PREPARED,
  canonical: true,
  id: denoise.REFERENCE_CONTRACT_ID,
  temporalPolicy: policy.CANONICAL_POLICY,
  legacyHistory: false,
});
assert.deepStrictEqual(grainVmafContract.forDisposition('no_grain'), {
  disposition: 'no_grain',
  selectorMode: grainVmafContract.SELECTOR_MODE_BYPASS,
  canonical: false,
  id: denoise.FGS_BYPASS_REFERENCE_CONTRACT_ID,
  temporalPolicy: policy.FGS_BYPASS_POLICY,
  legacyHistory: false,
});
assert.deepStrictEqual(grainVmafContract.forDisposition('analysis_unavailable'), {
  disposition: 'analysis_unavailable',
  selectorMode: grainVmafContract.SELECTOR_MODE_BYPASS,
  canonical: false,
  id: denoise.FGS_BYPASS_REFERENCE_CONTRACT_ID,
  temporalPolicy: policy.FGS_BYPASS_POLICY,
  legacyHistory: false,
});
assert.deepStrictEqual(grainVmafContract.forDisposition(null), {
  disposition: null,
  selectorMode: grainVmafContract.SELECTOR_MODE_LEGACY,
  canonical: false,
  id: denoise.LEGACY_REFERENCE_CONTRACT_ID,
  temporalPolicy: policy.LEGACY_POLICY,
  legacyHistory: true,
});

function comparisonProfile(overrides) {
  return policy.referenceComparisonEncoderProfileId(Object.assign({
    codec: 'av1_nvenc',
    presets: ['p7'],
    policy: policy.CANONICAL_POLICY,
    qualityFlags: canonicalFlags,
  }, overrides || {}));
}

assert.strictEqual(comparisonProfile(), policy.REFERENCE_COMPARISON_ENCODER_PROFILE_ID);
assert.strictEqual(
  comparisonProfile({ qualityFlags: `${canonicalFlags} -tf_level 0` }),
  policy.REFERENCE_COMPARISON_ENCODER_PROFILE_ID,
  'an explicit single tf_level 0 is semantically the same canonical profile'
);
assert.strictEqual(comparisonProfile({ presets: ['p6'] }), null);
assert.strictEqual(comparisonProfile({ presets: ['p7', 'p6'] }), null);
assert.strictEqual(comparisonProfile({ policy: policy.LEGACY_POLICY, qualityFlags: legacyFlags }), null);
assert.strictEqual(comparisonProfile({
  policy: policy.FGS_BYPASS_POLICY, qualityFlags: bypassFlags,
}), null, 'original-source bypass tf0 must not claim the canonical paired-canary profile');
assert.strictEqual(
  comparisonProfile({ qualityFlags: policy.qualityFlags(policy.CANONICAL_POLICY, false) }),
  null,
  'baseline flags must not claim the enhanced paired-canary profile'
);

const canonicalProbe = sampleTest.buildNvencCapabilityProbeArgs(canonicalFlags, policy.CANONICAL_POLICY);
assertCanonical(canonicalProbe, 'canonical capability probe');
const bypassProbe = sampleTest.buildNvencCapabilityProbeArgs(bypassFlags, policy.FGS_BYPASS_POLICY);
assertBypass(bypassProbe, 'FGS bypass capability probe');
const legacyProbe = sampleTest.buildNvencCapabilityProbeArgs(legacyFlags, policy.LEGACY_POLICY);
assertLegacy(legacyProbe, 'legacy capability probe');

const canonicalSample = sampleTest.buildSampleEncodeArgs(
  parameterSet, 'canonical-reference.mkv', 'distorted.mkv', canonicalFlags, { canonicalInput: true },
);
assertCanonical(canonicalSample, 'canonical sample');
assert.strictEqual(count(canonicalSample, '-hwaccel'), 0);
denoise.assertAbsent(canonicalSample, 'already-denoised sample encode');
assert.ok(value(canonicalSample, '-bsf:v').includes('transfer_characteristics=14'));

const bypassSample = sampleTest.buildSampleEncodeArgs(
  parameterSet, 'bypass-original-sample.mkv', 'distorted.mkv', bypassFlags,
  { canonicalInput: false, temporalPolicy: policy.FGS_BYPASS_POLICY },
);
assertBypass(bypassSample, 'FGS bypass sample');
assert.strictEqual(value(bypassSample, '-hwaccel'), 'cuda');
denoise.assertAbsent(bypassSample, 'FGS bypass sample encode');

const legacySample = sampleTest.buildSampleEncodeArgs(
  parameterSet, 'original-sample.mkv', 'distorted.mkv', legacyFlags, { canonicalInput: false },
);
assertLegacy(legacySample, 'legacy sample');
assert.strictEqual(value(legacySample, '-hwaccel'), 'cuda');
denoise.assertAbsent(legacySample, 'legacy sample encode');

const canonicalHoldout = holdoutTest.buildHoldoutEncodeArgs({
  inputPath: 'canonical-holdout.mkv', outputPath: 'distorted-holdout.mkv', encoder: 'av1_nvenc',
  preset: 'p7', cq: 30, pixFmt: 'p010le', nvencFlagArgs: canonicalFlags,
  colorPrimaries: 'bt2020', colorTrc: 'bt2020-12', colorspace: 'bt2020nc', canonicalInput: true,
});
assertCanonical(canonicalHoldout, 'canonical holdout');
assert.strictEqual(count(canonicalHoldout, '-hwaccel'), 0);
assert.ok(value(canonicalHoldout, '-bsf:v').includes('transfer_characteristics=15'));

const bypassHoldout = holdoutTest.buildHoldoutEncodeArgs({
  inputPath: 'bypass-original-holdout.mkv', outputPath: 'distorted-holdout.mkv',
  encoder: 'av1_nvenc', preset: 'p7', cq: 30, pixFmt: 'p010le',
  nvencFlagArgs: bypassFlags, colorPrimaries: 'bt709', colorTrc: 'bt709',
  colorspace: 'bt709', canonicalInput: false, temporalPolicy: policy.FGS_BYPASS_POLICY,
});
assertBypass(bypassHoldout, 'FGS bypass holdout');
assert.strictEqual(value(bypassHoldout, '-hwaccel'), 'cuda');

const legacyHoldout = holdoutTest.buildHoldoutEncodeArgs({
  inputPath: 'legacy-holdout.mkv', outputPath: 'distorted-holdout.mkv', encoder: 'av1_nvenc',
  preset: 'p7', cq: 30, pixFmt: 'p010le', nvencFlagArgs: legacyFlags,
  colorPrimaries: 'bt709', colorTrc: 'bt709', colorspace: 'bt709', canonicalInput: false,
});
assertLegacy(legacyHoldout, 'legacy holdout');
assert.strictEqual(value(legacyHoldout, '-hwaccel'), 'cuda');

for (const useCQ of [28, 38]) {
  const canonicalFinal = finalTest.buildFinalTranscodeArgs({
    bestParams: { isGPU: true, encoder: 'av1_nvenc', preset: 'p7' },
    originalFile: 'source.mkv', outputPath: `canonical-${useCQ}.mkv`, pixFmt: 'p010le', useCQ,
    nvencFlagArgs: canonicalFlags, colorPrimaries: 'bt2020', colorTrc: 'bt2020-10',
    colorspace: 'bt2020nc', canonicalDenoise: true,
  });
  assertCanonical(canonicalFinal, `canonical final CQ ${useCQ}`);
  assert.strictEqual(count(canonicalFinal, '-hwaccel'), 0);
  assert.strictEqual(count(canonicalFinal, '-vf'), 0);
  assert.strictEqual(count(canonicalFinal, '-filter:v:0'), 0,
    'external canonical KNN NUT input must not receive another FFmpeg denoiser');
  assert.strictEqual(value(canonicalFinal, '-filter:v:0'), undefined);
  denoise.assertCanonicalExactlyOnce(canonicalFinal, 'canonical final');

  const bypassFinal = finalTest.buildFinalTranscodeArgs({
    bestParams: { isGPU: true, encoder: 'av1_nvenc', preset: 'p7' },
    originalFile: 'source.mkv', outputPath: `bypass-${useCQ}.mkv`, pixFmt: 'p010le', useCQ,
    nvencFlagArgs: bypassFlags, colorPrimaries: 'bt709', colorTrc: 'bt709',
    colorspace: 'bt709', canonicalDenoise: false,
    temporalPolicy: policy.FGS_BYPASS_POLICY,
  });
  assertBypass(bypassFinal, `FGS bypass final CQ ${useCQ}`);
  assert.strictEqual(value(bypassFinal, '-hwaccel'), 'cuda');
  denoise.assertAbsent(bypassFinal, 'FGS bypass final');

  const legacyFinal = finalTest.buildFinalTranscodeArgs({
    bestParams: { isGPU: true, encoder: 'av1_nvenc', preset: 'p7' },
    originalFile: 'source.mkv', outputPath: `legacy-${useCQ}.mkv`, pixFmt: 'p010le', useCQ,
    nvencFlagArgs: legacyFlags, colorPrimaries: 'bt709', colorTrc: 'bt709', colorspace: 'bt709',
    canonicalDenoise: false,
  });
  assertLegacy(legacyFinal, `legacy final CQ ${useCQ}`);
  assert.strictEqual(value(legacyFinal, '-hwaccel'), 'cuda');
  denoise.assertAbsent(legacyFinal, 'legacy final');
}

const coverArtProbe = {
  streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } },
    { index: 1, codec_type: 'video', codec_name: 'hevc', disposition: { attached_pic: 0 } },
    { index: 2, codec_type: 'audio', codec_name: 'eac3' },
    { index: 3, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
    { index: '4', codec_type: 'video', codec_name: 'png', disposition: { attached_pic: '1' } },
  ],
};
const coverArtPlan = finalTest.buildVideoStreamPlan(coverArtProbe);
assert.deepStrictEqual(coverArtPlan, {
  primaryInputMap: '0:0',
  attachedPictureInputMaps: ['0:3', '0:4'],
});
assert.throws(() => finalTest.buildVideoStreamPlan(coverArtProbe, true),
  /exactly one non-attached video stream; found 2/,
  'production inventory checks must not silently discard a secondary ordinary video');
const networkLikeFfprobe = { streams: coverArtProbe.streams.filter(
  (stream) => stream.index === 0 || stream.index === 3) };
assert.deepStrictEqual(finalTest.buildVideoStreamPlan(networkLikeFfprobe, true), {
  primaryInputMap: '0:0', attachedPictureInputMaps: ['0:3'],
}, 'Network-like ffprobe attached_pic pseudo-streams are classified separately from ordinary video');
assert.deepStrictEqual(finalTest.buildVideoStreamPlan({ streams: [
  { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
  { index: 2, codec_type: 'video', codec_name: 'h264', disposition: { attached_pic: 0 } },
  { index: 5, codec_type: 'video', codec_name: 'hevc', disposition: { attached_pic: 0 } },
] }), {
  primaryInputMap: '0:2',
  attachedPictureInputMaps: ['0:0'],
}, 'an attached picture preceding the primary must not become the AV1 encode input');
const coverArtFinal = finalTest.buildFinalTranscodeArgs({
  bestParams: { isGPU: true, encoder: 'av1_nvenc', preset: 'p7' },
  originalFile: 'source-with-cover.mkv', outputPath: 'canonical-with-cover.mkv',
  pixFmt: 'p010le', useCQ: 30, nvencFlagArgs: canonicalFlags,
  colorPrimaries: 'bt709', colorTrc: 'bt709', colorspace: 'bt709',
  canonicalDenoise: true, ffProbeData: coverArtProbe,
});
const coverArtMaps = [];
for (let index = 0; index < coverArtFinal.length - 1; index += 1) {
  if (coverArtFinal[index] === '-map') coverArtMaps.push(coverArtFinal[index + 1]);
}
assert.deepStrictEqual(coverArtMaps, ['0:v:0', '1:3', '1:4', '1:a?', '1:s?', '1:t?'],
  'canonical NUT video is input zero while ancillary source streams come from input one');
assert.ok(!coverArtMaps.includes('1:1'), 'secondary ordinary source video must not be mapped');
assert.strictEqual(value(coverArtFinal, '-c:v:1'), 'copy');
assert.strictEqual(value(coverArtFinal, '-c:v:2'), 'copy');
assert.strictEqual(value(coverArtFinal, '-disposition:v:1'), 'attached_pic');
assert.strictEqual(value(coverArtFinal, '-disposition:v:2'), 'attached_pic');
assert.strictEqual(count(coverArtFinal, '-vf'), 0);
assert.strictEqual(value(coverArtFinal, '-filter:v:0'), undefined);
assert.strictEqual(count(coverArtFinal, '-bsf:v'), 0);
assert.ok(value(coverArtFinal, '-bsf:v:0').includes('transfer_characteristics=1'));
assert.throws(() => finalTest.buildVideoStreamPlan({ streams: [
  { index: 0, codec_type: 'video', disposition: { attached_pic: 0 } },
  { codec_type: 'video', disposition: { attached_pic: 1 } },
] }), /attached-picture video stream has no valid ffprobe stream index/);
assert.throws(() => finalTest.buildVideoStreamPlan(undefined, true),
  /ffprobe stream inventory is required to preserve attached pictures/);

assert.strictEqual(finalTest.shouldUseMatroskaAncillaryBypass(
  'source.mkv', 'mkv', { format: { format_name: 'matroska,webm' } }), true);
assert.strictEqual(finalTest.shouldUseMatroskaAncillaryBypass(
  'source.mp4', 'mkv', { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } }), false,
  'MP4-to-Matroska fallback stays on scoped FFmpeg copy because MP4 cover art is a video track');
assert.strictEqual(finalTest.shouldUseMatroskaAncillaryBypass(
  'source.mkv', 'mp4', { format: { format_name: 'matroska,webm' } }), false);
assert.strictEqual(finalTest.shouldUseMatroskaAncillaryBypass(
  'source.mkv', 'mkv', { streams: [] }), true,
  'an MKV with missing format_name must use the fail-closed MKVToolNix path');

const matroskaVideoOnly = finalTest.buildFinalTranscodeArgs({
  bestParams: { isGPU: true, encoder: 'av1_nvenc', preset: 'p7' },
  originalFile: 'source-with-compressed-pgs.mkv', outputPath: 'primary-video-only.mkv',
  pixFmt: 'p010le', useCQ: 30, nvencFlagArgs: canonicalFlags,
  colorPrimaries: 'bt709', colorTrc: 'bt709', colorspace: 'bt709',
  canonicalDenoise: true, ffProbeData: { streams: [coverArtProbe.streams[0]] },
  requireStreamInventory: true,
  matroskaVideoOnly: true,
});
const matroskaVideoOnlyMaps = [];
for (let index = 0; index < matroskaVideoOnly.length - 1; index += 1) {
  if (matroskaVideoOnly[index] === '-map') matroskaVideoOnlyMaps.push(matroskaVideoOnly[index + 1]);
}
assert.deepStrictEqual(matroskaVideoOnlyMaps, ['0:v:0']);
assert.strictEqual(value(matroskaVideoOnly, '-map_metadata'), '-1');
assert.strictEqual(value(matroskaVideoOnly, '-map_chapters'), '-1');
assert.ok(matroskaVideoOnly.includes('-an'));
assert.ok(matroskaVideoOnly.includes('-sn'));
assert.ok(matroskaVideoOnly.includes('-dn'));
assert.strictEqual(count(matroskaVideoOnly, '-c:a'), 0);
assert.strictEqual(count(matroskaVideoOnly, '-c:s'), 0);
assert.strictEqual(count(matroskaVideoOnly, '-c:t'), 0);
assert.strictEqual(count(matroskaVideoOnly, '-c:v:1'), 0);
assert.strictEqual(value(matroskaVideoOnly, '-filter:v:0'), undefined);
assert.ok(value(matroskaVideoOnly, '-bsf:v:0').includes('transfer_characteristics=1'));

assert.deepStrictEqual(finalTest.buildMkvmergeAncillaryArgs(
  'primary-video-only.mkv', 'original.mkv', 'output.partial.mkv', 'Example Container Title'), [
  '--quiet', '--disable-track-statistics-tags', '--output', 'output.partial.mkv',
  '--title', 'Example Container Title',
  '--no-audio', '--no-subtitles', '--no-buttons', '--no-chapters',
  '--no-attachments', '--no-global-tags', '--no-track-tags', 'primary-video-only.mkv',
  '--no-video', 'original.mkv',
]);
assert.ok(!finalTest.buildMkvmergeAncillaryArgs(
  'primary-video-only.mkv', 'original.mkv', 'output.partial.mkv', '').includes('--title'));

const sourceIdentify = {
  container: { supported: true, properties: { title: 'Example Container Title' } },
  tracks: [
    { type: 'video', codec: 'HEVC', properties: {
      codec_id: 'V_MPEGH/ISO/HEVC', codec_private_data: 'hevc-private',
      uid: '11000000000000000001', number: 1, display_unit: 0,
    } },
    { type: 'audio', codec: 'AAC', properties: {
      codec_id: 'A_AAC', codec_private_data: '1188', uid: '11000000000000000002',
      number: 2, language: 'eng', default_track: false,
      audio_channels: 1, audio_sampling_frequency: 48000, minimum_timestamp: 20000000,
    } },
    { type: 'subtitles', codec: 'HDMV PGS', properties: {
      codec_id: 'S_HDMV/PGS', uid: '3', number: 3, language: 'eng', default_track: false,
      content_encoding_algorithms: '0',
    } },
  ],
  attachments: [{
    content_type: 'image/jpeg', description: '', file_name: 'cover.jpg', size: 115232,
    properties: { uid: '17900561051986937079' },
  }],
  chapters: [{ num_entries: 12 }],
  global_tags: [{ num_entries: 2 }],
};
const networkLikeSourceIdentify = clone(sourceIdentify);
assert.deepStrictEqual(finalTest.preflightMatroskaAncillarySource('example.mkv', (sourcePath) => {
  assert.strictEqual(sourcePath, 'example.mkv');
  return networkLikeSourceIdentify;
}).inventory, { video_tracks: 1, attachments: 1 },
'one actual Matroska video plus a cover attachment must pass before FFmpeg');
const twoActualVideoSourceIdentify = clone(sourceIdentify);
twoActualVideoSourceIdentify.tracks.push({
  type: 'video', codec: 'V_MJPEG', properties: { codec_id: 'V_MJPEG' },
});
assert.throws(() => finalTest.preflightMatroskaAncillarySource(
  'alternate-angle.mkv', () => twoActualVideoSourceIdentify),
  /exactly one actual video track for ancillary bypass; found 2/,
  'a true second Matroska video track must fail the pre-encode mkvmerge inventory gate');
const videoIdentify = {
  container: { supported: true, properties: {} },
  tracks: [{ type: 'video', codec: 'AV1', properties: {
    codec_id: 'V_AV1', codec_private_data: 'av1-private',
    uid: '12000000000000000001', number: 1, display_unit: 0,
  } }],
  attachments: [], chapters: [],
  global_tags: [{ num_entries: 1 }],
  track_tags: [{ num_entries: 2, track_id: 0 }],
};
const outputAudioTrack = clone(sourceIdentify.tracks[1]);
outputAudioTrack.properties.language_ietf = 'en';
outputAudioTrack.properties.enabled_track = true;
outputAudioTrack.properties.forced_track = false;
const outputSubtitleTrack = clone(sourceIdentify.tracks[2]);
outputSubtitleTrack.properties.language_ietf = 'en';
outputSubtitleTrack.properties.enabled_track = true;
outputSubtitleTrack.properties.forced_track = false;
const outputIdentify = {
  container: { supported: true, properties: { title: 'Example Container Title' } },
  tracks: [
    { type: 'video', codec: 'AV1', properties: {
      codec_id: 'V_AV1', codec_private_data: 'av1-private',
      uid: '12000000000000000001', number: 1, display_unit: 0,
      language_ietf: 'und', enabled_track: true, forced_track: false,
    } },
    outputAudioTrack, outputSubtitleTrack,
  ],
  attachments: sourceIdentify.attachments,
  chapters: sourceIdentify.chapters,
  global_tags: sourceIdentify.global_tags,
};
assert.deepStrictEqual(finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoIdentify, outputIdentify), {
  video_tracks: 1, non_video_tracks: 2, attachments: 1,
  chapter_editions: 1, global_tag_sets: 1,
});
function clone(value) { return JSON.parse(JSON.stringify(value)); }
const sourceWithoutTags = clone(sourceIdentify);
sourceWithoutTags.global_tags = [];
sourceWithoutTags.track_tags = [];
const outputWithoutSourceTags = clone(outputIdentify);
outputWithoutSourceTags.global_tags = [];
outputWithoutSourceTags.track_tags = [];
assert.doesNotThrow(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceWithoutTags, videoIdentify, outputWithoutSourceTags),
  'FFmpeg-generated intermediate tags must not become source-owned output metadata');
const outputWithRewrittenTrackStatistics = clone(outputWithoutSourceTags);
outputWithRewrittenTrackStatistics.track_tags = [{ num_entries: 1, track_id: 0 }];
assert.doesNotThrow(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceWithoutTags, videoIdentify, outputWithRewrittenTrackStatistics),
  'track statistic summaries are muxer-managed and intentionally outside the stable inventory');
const leakedIntermediateGlobalTags = clone(outputWithoutSourceTags);
leakedIntermediateGlobalTags.global_tags = clone(videoIdentify.global_tags);
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceWithoutTags, videoIdentify, leakedIntermediateGlobalTags), /global tag inventory changed/);
const intermediateWithAttachment = clone(videoIdentify);
intermediateWithAttachment.attachments = [{ content_type: 'image/jpeg', file_name: 'generated.jpg', size: 1 }];
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, intermediateWithAttachment, outputIdentify), /intermediate unexpectedly contains ancillary/);
const intermediateWithChapter = clone(videoIdentify);
intermediateWithChapter.chapters = [{ num_entries: 1 }];
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, intermediateWithChapter, outputIdentify), /intermediate unexpectedly contains ancillary/);
const intermediateWithNonVideo = clone(videoIdentify);
intermediateWithNonVideo.tracks.push({ type: 'audio', codec: 'AAC', properties: { codec_id: 'A_AAC' } });
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, intermediateWithNonVideo, outputIdentify), /intermediate is not exactly one video track/);
// Real mkvmerge v98 shape: language_ietf can be absent from an input identify
// result and materialized on the remuxed output. Output-only stable properties
// are allowed, but an authoritative input declaration remains mandatory.
const sourceWithLanguageIetf = clone(sourceIdentify);
sourceWithLanguageIetf.tracks[1].properties.language_ietf = 'en';
const changedDeclaredAudioLanguage = clone(outputIdentify);
changedDeclaredAudioLanguage.tracks[1].properties.language_ietf = 'fr';
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceWithLanguageIetf, videoIdentify, changedDeclaredAudioLanguage),
  /non-video track inventory changed.*language_ietf/);
const missingDeclaredAudioLanguage = clone(outputIdentify);
delete missingDeclaredAudioLanguage.tracks[1].properties.language_ietf;
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceWithLanguageIetf, videoIdentify, missingDeclaredAudioLanguage),
  /non-video track inventory changed.*language_ietf.*missing/);
const videoWithLanguageIetf = clone(videoIdentify);
videoWithLanguageIetf.tracks[0].properties.language_ietf = 'und';
const changedDeclaredVideoLanguage = clone(outputIdentify);
changedDeclaredVideoLanguage.tracks[0].properties.language_ietf = 'en';
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoWithLanguageIetf, changedDeclaredVideoLanguage),
  /primary video track inventory changed.*language_ietf/);
const missingDeclaredVideoLanguage = clone(outputIdentify);
delete missingDeclaredVideoLanguage.tracks[0].properties.language_ietf;
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoWithLanguageIetf, missingDeclaredVideoLanguage),
  /primary video track inventory changed.*language_ietf.*missing/);
const missingPgs = clone(outputIdentify);
missingPgs.tracks.splice(2, 1);
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoIdentify, missingPgs), /non-video track count changed/);
const changedPgs = clone(outputIdentify);
changedPgs.tracks[2].codec = 'SubRip/SRT';
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoIdentify, changedPgs), /non-video track inventory changed/);
const lostPgsCompression = clone(outputIdentify);
delete lostPgsCompression.tracks[2].properties.content_encoding_algorithms;
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoIdentify, lostPgsCompression), /non-video track inventory changed/);
const changedAncillaryTrackUid = clone(outputIdentify);
changedAncillaryTrackUid.tracks[1].properties.uid = '11000000000000000999';
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoIdentify, changedAncillaryTrackUid),
  /non-video track inventory changed.*properties\.uid changed value/);
const missingAttachment = clone(outputIdentify);
missingAttachment.attachments = [];
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoIdentify, missingAttachment), /attachment inventory changed/);
const changedAttachmentUid = clone(outputIdentify);
changedAttachmentUid.attachments[0].properties.uid = '17900561051986937080';
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoIdentify, changedAttachmentUid),
  /attachment inventory changed.*\.uid changed value/);
const missingChapters = clone(outputIdentify);
missingChapters.chapters = [];
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoIdentify, missingChapters), /chapter inventory changed/);
const changedTitle = clone(outputIdentify);
changedTitle.container.properties.title = '';
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoIdentify, changedTitle), /segment title changed/);
const extraVideo = clone(outputIdentify);
extraVideo.tracks.push({ type: 'video', codec: 'MJPEG', properties: { codec_id: 'V_MJPEG' } });
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceIdentify, videoIdentify, extraVideo), /exactly one primary video track/);
const sourceWithExtraVideo = clone(sourceIdentify);
sourceWithExtraVideo.tracks.push({ type: 'video', codec: 'MJPEG', properties: { codec_id: 'V_MJPEG' } });
assert.throws(() => finalTest.verifyMkvmergeAncillaryInventory(
  sourceWithExtraVideo, videoIdentify, outputIdentify),
  /source Matroska must contain exactly one actual video track for ancillary bypass; found 2/);

for (const invalidCanonical of ['-tf_level 4', '-tf_level 0 -tf_level 0', '-tf_level=0']) {
  assert.throws(() => policy.assertTemporalFilterPolicy(
    invalidCanonical, policy.CANONICAL_POLICY, 'canonical invalid'), /disabled/);
}
for (const invalidLegacy of ['', '-tf_level 0', '-tf_level 4 -tf_level 4', '-tf_level=4']) {
  assert.throws(() => policy.assertTemporalFilterPolicy(
    invalidLegacy, policy.LEGACY_POLICY, 'legacy invalid'), /exactly one/);
}
assert.doesNotThrow(() => policy.assertTemporalFilterPolicy('-tf_level 0', policy.CANONICAL_POLICY));
assert.doesNotThrow(() => policy.assertTemporalFilterPolicy('-tf_level 4', policy.LEGACY_POLICY));

console.log('PASS conditional NVENC temporal-filter and canonical-denoise contract');
