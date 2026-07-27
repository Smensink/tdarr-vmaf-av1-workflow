'use strict';

const assert = require('assert');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function mockTdarrLib(request, parent, isMain) {
  if (request === '../../../../../methods/lib') {
    return () => ({
      loadDefaultValues(inputs, details) {
        const values = Object.assign({}, inputs || {});
        for (const input of details().inputs || []) {
          if (values[input.name] === undefined) values[input.name] = input.defaultValue;
        }
        return values;
      },
    });
  }
  if (request === '../../../../FlowHelpers/1.0.0/cliUtils') {
    return { CLI: class MockCLI {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const hdrModule = require('./custom-cont-init.d/vmaf-plugin-patches/checkHdrContent/1.0.0/index.js');
const hdrPlugin = hdrModule.plugin;
const hdrPolicyTest = hdrModule._test;
const transcodeTest = require('./custom-cont-init.d/vmaf-plugin-patches/vmafOptimizedTranscode/1.0.0/index.js')._test;

function runStreams(streams, inputs, mediaInfo) {
  const logs = [];
  const args = {
    inputFileObj: {
      ffProbeData: {
        streams: streams.map((stream) => Object.assign({ codec_type: 'video' }, stream)),
      },
      mediaInfo,
    },
    inputs: inputs || {},
    variables: {},
    jobLog(message) { logs.push(String(message)); },
  };
  return { args, logs, result: hdrPlugin(args) };
}

function run(stream, inputs, mediaInfo) {
  return runStreams([stream], inputs, mediaInfo);
}

const sdr = run({ color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709', pix_fmt: 'yuv420p' });
assert.strictEqual(sdr.result.outputNumber, 2);

for (const transfer of ['bt2020-10', 'bt2020-12']) {
  const wcgSdr = run({
    color_transfer: transfer, color_primaries: 'bt2020', color_space: 'bt2020nc',
    pix_fmt: transfer === 'bt2020-12' ? 'yuv420p12le' : 'yuv420p10le',
  });
  assert.strictEqual(wcgSdr.result.outputNumber, 2, `${transfer} is explicit SDR, not inferred HDR`);
  assert.strictEqual(wcgSdr.args.variables.isHDR, false);
  assert.strictEqual(wcgSdr.args.variables.color_primaries, 'bt2020');
  assert.strictEqual(wcgSdr.args.variables.color_trc, transfer);
  assert.strictEqual(wcgSdr.args.variables.colorspace, 'bt2020nc');
  assert.strictEqual(wcgSdr.args.variables.pix_fmt, 'p010le');
  assert.ok(wcgSdr.logs.some((line) => line.includes('Wide-gamut SDR')));
}

const unknownBt2020HighBit = run({
  color_transfer: 'unknown', color_primaries: 'bt2020', color_space: 'bt2020nc', pix_fmt: 'yuv420p10le',
});
assert.strictEqual(unknownBt2020HighBit.result.outputNumber, 1,
  'BT.2020/high-bit heuristic remains available only for unknown transfer');
assert.strictEqual(unknownBt2020HighBit.args.variables.color_trc, 'smpte2084');

const staticHdrStream = {
  color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc', pix_fmt: 'yuv420p10le',
  side_data_list: [
    { side_data_type: 'Mastering display metadata', red_x: '34000/50000', red_y: '16000/50000', green_x: '13250/50000', green_y: '34500/50000', blue_x: '7500/50000', blue_y: '3000/50000', white_point_x: '15635/50000', white_point_y: '16450/50000', min_luminance: '50/10000', max_luminance: '10000000/10000' },
    { side_data_type: 'Content light level metadata', max_content: 1000, max_average: 400 },
  ],
};
const staticHdr = run(staticHdrStream);
assert.strictEqual(staticHdr.result.outputNumber, 1);
assert.strictEqual(staticHdr.args.variables.hdr_max_cll, '1000,400');

const dovi = run(Object.assign({}, staticHdrStream, {
  side_data_list: staticHdrStream.side_data_list.concat([{ side_data_type: 'DOVI configuration record', dv_profile: 5, dv_level: 6, dv_bl_signal_compatibility_id: 0, bl_present_flag: 1, rpu_present_flag: 1 }]),
}));
assert.strictEqual(dovi.result.outputNumber, 3);
assert.strictEqual(dovi.args.variables.vmafProcessingDisposition, 'keep_original_dynamic_hdr');
assert.ok(dovi.logs.some((line) => line.includes('KEEP ORIGINAL')));

const compatibleDoviStream = Object.assign({}, staticHdrStream, {
  side_data_list: staticHdrStream.side_data_list.concat([{ side_data_type: 'Dolby Vision configuration', dv_profile: 8, dv_level: 6, dv_bl_signal_compatibility_id: 1, bl_present_flag: 1, rpu_present_flag: 1 }]),
});
const compatibleDovi = run(compatibleDoviStream);
assert.strictEqual(compatibleDovi.result.outputNumber, 1);
assert.strictEqual(compatibleDovi.args.variables.vmafDynamicHdrStaticFallbackAuthorized, true);
assert.strictEqual(compatibleDovi.args.variables.vmafDynamicHdrConversion, 'dolby_vision_to_hdr10');

const hdr10PlusMetadata = { side_data_type: 'HDR10+ Dynamic Metadata SMPTE2094-40' };
const validHdr10PlusStream = Object.assign({}, staticHdrStream, {
  side_data_list: staticHdrStream.side_data_list.concat([hdr10PlusMetadata]),
});
const validHdr10Plus = run(validHdr10PlusStream);
assert.strictEqual(hdrPolicyTest.isHdr10PlusStaticHdr10Compatible(validHdr10PlusStream), true);
assert.strictEqual(validHdr10Plus.result.outputNumber, 1);
assert.strictEqual(validHdr10Plus.args.variables.vmafHdr10PlusStaticHdr10Compatible, true);
assert.strictEqual(validHdr10Plus.args.variables.vmafDynamicHdrConversion, 'hdr10plus_to_hdr10');

const mediaInfoHdr10PlusTrack = {
  '@type': 'Video',
  HDR_Format: 'SMPTE ST 2094 App 4',
  HDR_Format_Version: '1',
  HDR_Format_Compatibility: 'HDR10+ Profile B',
};
const mediaInfoOnlyHdr10PlusStream = {
  color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc',
  pix_fmt: 'yuv420p10le', side_data_list: [],
};
const mediaInfoOnlyHdr10Plus = run(mediaInfoOnlyHdr10PlusStream, {}, {
  track: [mediaInfoHdr10PlusTrack],
});
assert.strictEqual(hdrPolicyTest.hasHdr10PlusMediaInfo(mediaInfoHdr10PlusTrack), true);
assert.strictEqual(hdrPolicyTest.isHdr10PlusStaticHdr10Compatible(
  mediaInfoOnlyHdr10PlusStream, mediaInfoHdr10PlusTrack,
), true);
assert.strictEqual(mediaInfoOnlyHdr10Plus.result.outputNumber, 1,
  'compatible MediaInfo-only HDR10+ must stay on the HDR processing path');
assert.strictEqual(mediaInfoOnlyHdr10Plus.args.variables.isHDR, true);
assert.strictEqual(mediaInfoOnlyHdr10Plus.args.variables.isHDR10Plus, true);
assert.strictEqual(mediaInfoOnlyHdr10Plus.args.variables.color_primaries, 'bt2020');
assert.strictEqual(mediaInfoOnlyHdr10Plus.args.variables.color_trc, 'smpte2084');
assert.strictEqual(mediaInfoOnlyHdr10Plus.args.variables.colorspace, 'bt2020nc');
assert.strictEqual(mediaInfoOnlyHdr10Plus.args.variables.pix_fmt, 'p010le');
assert.strictEqual(mediaInfoOnlyHdr10Plus.args.variables.vmafHdr10PlusStaticHdr10Compatible, true);
assert.strictEqual(mediaInfoOnlyHdr10Plus.args.variables.vmafDynamicHdrStaticFallbackAuthorized, true);
assert.strictEqual(mediaInfoOnlyHdr10Plus.args.variables.vmafDynamicHdrConversion, 'hdr10plus_to_hdr10');
assert.ok(mediaInfoOnlyHdr10Plus.args.variables.hdr_dynamic_metadata_warning);
assert.strictEqual(mediaInfoOnlyHdr10Plus.args.variables.vmafProcessingDisposition,
  'transcode_static_hdr10_fallback');
assert.strictEqual(mediaInfoOnlyHdr10Plus.args.variables.vmafProcessingDispositionReason,
  'hdr10plus_static_hdr10_base_layer');
assert.ok(mediaInfoOnlyHdr10Plus.logs.some((line) => line.includes('HDR10+ dynamic metadata detected')));

assert.strictEqual(hdrPolicyTest.hasHdr10PlusMediaInfo({
  '@type': 'Video', HDR_Format: 'SMPTE ST 2094-40',
}), true);
assert.strictEqual(hdrPolicyTest.hasHdr10PlusMediaInfo({
  '@type': 'Video', HDR_Format_Compatibility: 'HDR10+ Profile B',
}), true);
assert.strictEqual(hdrPolicyTest.hasHdr10PlusMediaInfo({
  '@type': 'Video', HDR_Format: 'SMPTE ST 2086', HDR_Format_Compatibility: 'HDR10',
}), false);
assert.strictEqual(hdrPolicyTest.hasHdr10PlusMediaInfo({
  '@type': 'Video', HDR_Format: 'SMPTE ST 2094 App 2',
}), false);

for (const marker of [
  'HDR10+',
  'HDR10Plus',
  'SMPTE2094-40',
  'SMPTE ST 2094-40',
  'SMPTE ST 2094 App 4',
  'SMPTE ST 2094 Application 4',
]) {
  assert.strictEqual(hdrPolicyTest.isHdr10PlusDescription(marker), true,
    `explicit HDR10+ marker was not recognized: ${marker}`);
  const markerResult = run(Object.assign({}, staticHdrStream, {
    side_data_list: [{ side_data_type: marker }],
  }));
  assert.strictEqual(markerResult.args.variables.vmafDynamicHdrConversion,
    'hdr10plus_to_hdr10', `explicit HDR10+ marker did not authorize conversion: ${marker}`);
}

for (const marker of [
  'SMPTE2094-10',
  'SMPTE ST 2094 App 2',
  'Dynamic HDR metadata',
  'HDR Vivid metadata',
  'SMPTE2094',
  'HDR10',
]) {
  assert.strictEqual(hdrPolicyTest.isHdr10PlusDescription(marker), false,
    `non-HDR10+ marker was misclassified: ${marker}`);
  assert.strictEqual(hdrPolicyTest.hasHdr10PlusMediaInfo({ '@type': 'Video', HDR_Format: marker }), false,
    `MediaInfo non-HDR10+ marker was misclassified: ${marker}`);
  const markerResult = run(Object.assign({}, staticHdrStream, {
    side_data_list: [{ side_data_type: marker }],
  }));
  assert.strictEqual(markerResult.args.variables.isHDR10Plus, false,
    `FFprobe non-HDR10+ marker was misclassified: ${marker}`);
  assert.strictEqual(markerResult.args.variables.vmafDynamicHdrConversion, undefined);
}

const primeLikeDovi = run(compatibleDoviStream, {}, { track: [mediaInfoHdr10PlusTrack] });
assert.strictEqual(primeLikeDovi.result.outputNumber, 1);
assert.strictEqual(primeLikeDovi.args.variables.isDolbyVision, true);
assert.strictEqual(primeLikeDovi.args.variables.isHDR10Plus, true);
assert.strictEqual(primeLikeDovi.args.variables.vmafDynamicHdrConversion, 'dolby_vision_to_hdr10');
assert.strictEqual(primeLikeDovi.args.variables.vmafHdr10PlusStaticHdr10Compatible, false,
  'Dolby Vision must own a dual-marker conversion');

const attachedHdrArtwork = Object.assign({}, validHdr10PlusStream, {
  disposition: { attached_pic: '1' }, index: 0, width: 1200, height: 1200,
});
const realSdrVideo = {
  disposition: { attached_pic: 0 }, index: 1, width: 1920, height: 1080,
  color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709', pix_fmt: 'yuv420p',
};
const attachedFirst = runStreams([attachedHdrArtwork, realSdrVideo]);
assert.strictEqual(hdrPolicyTest.getVideoStream(attachedFirst.args.inputFileObj),
  attachedFirst.args.inputFileObj.ffProbeData.streams[1]);
assert.strictEqual(attachedFirst.result.outputNumber, 2,
  'attached artwork must not become the primary video stream');
assert.strictEqual(attachedFirst.args.variables.isHDR10Plus, false);

const indexedPqVideo = Object.assign({}, mediaInfoOnlyHdr10PlusStream, {
  index: 1, width: 1920, height: 1080,
});
const unrelatedHdrTrack = Object.assign({}, mediaInfoHdr10PlusTrack, {
  StreamOrder: '0', Width: '3 840 pixels', Height: '2 160 pixels',
});
const matchedPlainTrack = {
  '@type': 'Video', StreamOrder: '1', Width: '1 920 pixels', Height: '1 080 pixels',
};
const unrelatedMediaInfoHdr = run(indexedPqVideo, {}, {
  track: [unrelatedHdrTrack, matchedPlainTrack],
});
assert.strictEqual(unrelatedMediaInfoHdr.args.variables.isHDR10Plus, false,
  'HDR10+ metadata from an unrelated MediaInfo video track must not leak');
assert.strictEqual(unrelatedMediaInfoHdr.args.variables.vmafDynamicHdrConversion, undefined);

const matchedHdrTrack = Object.assign({}, mediaInfoHdr10PlusTrack, matchedPlainTrack);
const matchedMediaInfoHdr = run(indexedPqVideo, {}, {
  track: [unrelatedHdrTrack, matchedHdrTrack],
});
assert.strictEqual(matchedMediaInfoHdr.args.variables.isHDR10Plus, true);
assert.strictEqual(matchedMediaInfoHdr.args.variables.vmafDynamicHdrConversion, 'hdr10plus_to_hdr10');

for (const tracks of [
  [unrelatedHdrTrack, Object.assign({}, matchedHdrTrack, { StreamOrder: '0-1' })],
  [unrelatedHdrTrack, Object.assign({}, matchedHdrTrack, { Width: '3840' })],
  [unrelatedHdrTrack, Object.assign({}, matchedHdrTrack, { StreamOrder: '2' })],
  [matchedPlainTrack, matchedHdrTrack],
]) {
  assert.strictEqual(hdrPolicyTest.getMediaInfoVideoTrack({
    ffProbeData: { streams: [indexedPqVideo] }, mediaInfo: { track: tracks },
  }, indexedPqVideo), null, 'ambiguous or mismatched MediaInfo identity must fail closed');
  const ambiguous = run(indexedPqVideo, {}, { track: tracks });
  assert.strictEqual(ambiguous.args.variables.isHDR10Plus, false);
  assert.strictEqual(ambiguous.args.variables.vmafDynamicHdrConversion, undefined);
}
assert.strictEqual(transcodeTest.selectOutputContainer(
  '/media/library/example-hdr-source.ts', mediaInfoOnlyHdr10Plus.args.variables,
), 'mkv');

for (const incompatibleBase of [
  Object.assign({}, mediaInfoOnlyHdr10PlusStream, { color_transfer: 'arib-std-b67' }),
  Object.assign({}, mediaInfoOnlyHdr10PlusStream, { color_primaries: 'bt709' }),
  Object.assign({}, mediaInfoOnlyHdr10PlusStream, { color_space: 'bt709' }),
  Object.assign({}, mediaInfoOnlyHdr10PlusStream, { pix_fmt: 'yuv420p' }),
  Object.assign({}, mediaInfoOnlyHdr10PlusStream, { pix_fmt: 'yuv420p16le' }),
]) {
  assert.strictEqual(hdrPolicyTest.isHdr10PlusStaticHdr10Compatible(
    incompatibleBase, mediaInfoHdr10PlusTrack,
  ), false);
  const incompatibleMediaInfoHdr10Plus = run(incompatibleBase, {}, {
    track: [mediaInfoHdr10PlusTrack],
  });
  assert.strictEqual(incompatibleMediaInfoHdr10Plus.args.variables.isHDR10Plus, true);
  assert.strictEqual(incompatibleMediaInfoHdr10Plus.result.outputNumber, 3);
  assert.strictEqual(incompatibleMediaInfoHdr10Plus.args.variables.vmafDynamicHdrConversion, undefined);
  assert.strictEqual(incompatibleMediaInfoHdr10Plus.args.variables.vmafProcessingDispositionReason,
    'hdr10plus_base_layer_not_hdr10_compatible');
}

const valid12BitHdr10PlusStream = Object.assign({}, validHdr10PlusStream, { pix_fmt: 'yuv444p12le' });
assert.strictEqual(hdrPolicyTest.isHdr10PlusStaticHdr10Compatible(valid12BitHdr10PlusStream), true);

const invalidHdr10PlusStreams = [
  Object.assign({}, validHdr10PlusStream, { color_transfer: 'arib-std-b67' }),
  Object.assign({}, validHdr10PlusStream, { color_primaries: 'bt709' }),
  Object.assign({}, validHdr10PlusStream, { color_space: 'bt709' }),
  Object.assign({}, validHdr10PlusStream, { pix_fmt: 'yuv420p' }),
  Object.assign({}, validHdr10PlusStream, { pix_fmt: 'yuv420p16le' }),
];
for (const invalidStream of invalidHdr10PlusStreams) {
  assert.strictEqual(hdrPolicyTest.isHdr10PlusStaticHdr10Compatible(invalidStream), false);
  const invalidResult = run(invalidStream);
  assert.strictEqual(invalidResult.result.outputNumber, 3);
  assert.strictEqual(invalidResult.args.variables.vmafHdr10PlusStaticHdr10Compatible, false);
  assert.strictEqual(invalidResult.args.variables.vmafProcessingDispositionReason,
    'hdr10plus_base_layer_not_hdr10_compatible');
}

const ambiguousHdr10PlusDoviStream = Object.assign({}, validHdr10PlusStream, {
  side_data_list: validHdr10PlusStream.side_data_list.concat([{
    side_data_type: 'Dolby Vision configuration', dv_profile: 5, dv_level: 6,
    dv_bl_signal_compatibility_id: 0, bl_present_flag: 1, rpu_present_flag: 1,
  }]),
});
const ambiguousHdr10PlusDovi = run(ambiguousHdr10PlusDoviStream);
assert.strictEqual(hdrPolicyTest.isHdr10PlusStaticHdr10Compatible(ambiguousHdr10PlusDoviStream), false);
assert.strictEqual(ambiguousHdr10PlusDovi.result.outputNumber, 3);
assert.strictEqual(ambiguousHdr10PlusDovi.args.variables.vmafDynamicHdrConversion, undefined);
assert.strictEqual(ambiguousHdr10PlusDovi.args.variables.vmafProcessingDispositionReason,
  'dolby_vision_base_layer_not_hdr10_compatible');

const doviFallback = run(Object.assign({}, staticHdrStream, {
  side_data_list: staticHdrStream.side_data_list.concat([{ side_data_type: 'Dolby Vision configuration', dv_profile: 5, dv_level: 6, dv_bl_signal_compatibility_id: 0, bl_present_flag: 1, rpu_present_flag: 1 }]),
}), { dynamicHdrPolicy: 'allowStaticFallback' });
assert.strictEqual(doviFallback.result.outputNumber, 1);

const mediaInfoFallback = run({
  color_transfer: 'smpte2084', color_primaries: 'bt2020', color_space: 'bt2020nc', pix_fmt: 'yuv420p10le',
}, {}, { track: [{
  '@type': 'Video',
  MasteringDisplay_ColorPrimaries: 'Display P3',
  MasteringDisplay_Luminance: 'min: 0.0050 cd/m2, max: 1000 cd/m2',
  MaxCLL: '1069 cd/m2',
  MaxFALL: '131 cd/m2',
}] });
assert.strictEqual(mediaInfoFallback.args.variables.hdr_master_display,
  'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)');
assert.strictEqual(mediaInfoFallback.args.variables.hdr_max_cll, '1069,131');

const rawMaster = 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)';
const properties = transcodeTest.buildHdrMkvProperties('bt2020', 'smpte2084', 'bt2020nc', rawMaster, '1000,400');
assert.strictEqual(properties.max_luminance, 1000);
assert.strictEqual(properties.min_luminance, 0.005);
assert.strictEqual(properties.max_content_light, 1000);
assert.strictEqual(properties.max_frame_light, 400);
assert.deepStrictEqual(properties.chromaticity_coordinates, [0.68, 0.32, 0.265, 0.69, 0.15, 0.06]);

const verified = transcodeTest.verifyHdrTrackProperties({
  color_primaries: 9, color_transfer_characteristics: 16, color_matrix_coefficients: 9,
  max_content_light: 1000, max_frame_light: 400, max_luminance: 1000, min_luminance: 0.005,
  chromaticity_coordinates: '0.68,0.32,0.265,0.69,0.15,0.06',
  white_color_coordinates: '0.3127,0.329',
}, properties);
assert.strictEqual(verified.ok, true);
assert.strictEqual(transcodeTest.verifyHdrTrackProperties({ color_primaries: 1 }, properties).ok, false);
assert.strictEqual(transcodeTest.selectOutputContainer('/media/movie.mp4', { vmafDynamicHdrConversion: 'dolby_vision_to_hdr10' }), 'mkv');
assert.strictEqual(transcodeTest.selectOutputContainer('/media/movie.mp4', {}), 'mp4');
assert.strictEqual(transcodeTest.selectOutputContainer('/media/mislabeled.ts', {}, {
  format: { format_name: 'matroska,webm' },
}), 'mkv');

console.log('PASS HDR/Dolby Vision/HDR10+ profile-aware policy and static metadata regression suite');
Module._load = originalLoad;
