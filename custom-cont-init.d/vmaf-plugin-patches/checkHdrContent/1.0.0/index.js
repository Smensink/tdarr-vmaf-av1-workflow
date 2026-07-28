"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isHdr10PlusStaticHdr10Compatible = exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Check HDR Content',
    description: 'Detects HDR content, preserves explicit SDR metadata, and keeps ambiguous color signalling out of the transcode path.',
    style: {
        borderColor: 'purple',
    },
    tags: 'video,hdr,color',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faVideo',
    inputs: [
        {
            label: 'Dynamic HDR Policy',
            name: 'dynamicHdrPolicy',
            type: 'string',
            defaultValue: 'profileAwareHdr10',
            inputUI: { type: 'dropdown', options: ['profileAwareHdr10', 'keepOriginal', 'allowStaticFallback'] },
            tooltip: 'Convert Dolby Vision with an HDR10-compatible base layer (compatibility ID 1 or 6) and HDR10+ sources to static HDR10. Profile 5/incompatible Dolby Vision remains keep-original. allowStaticFallback is the legacy force override.'
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'HDR content detected',
        },
        {
            number: 2,
            tooltip: 'SDR content detected',
        },
        {
            number: 3,
            tooltip: 'Unsupported dynamic HDR or ambiguous color transfer - keep original',
        },
    ],
}); };
exports.details = details;

function getVideoStream(inputFileObj) {
    var streams = inputFileObj && inputFileObj.ffProbeData && inputFileObj.ffProbeData.streams;
    if (!Array.isArray(streams)) return null;
    for (var i = 0; i < streams.length; i++) {
        var stream = streams[i];
        if (stream && stream.codec_type === 'video' &&
            !(stream.disposition && Number(stream.disposition.attached_pic) === 1)) return stream;
    }
    return null;
}

function parseNum(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number') return isFinite(value) ? value : null;
    var str = String(value).trim();
    if (!str) return null;
    if (str.indexOf('/') !== -1) {
        var parts = str.split('/');
        var n = parseFloat(parts[0]);
        var d = parseFloat(parts[1]);
        if (isFinite(n) && isFinite(d) && d !== 0) return n / d;
    }
    var parsed = parseFloat(str);
    return isFinite(parsed) ? parsed : null;
}

function hasVal(value) {
    return value !== undefined && value !== null && value !== '';
}

function firstPresent(obj, names) {
    if (!obj) return null;
    for (var i = 0; i < names.length; i++) {
        if (hasVal(obj[names[i]])) return obj[names[i]];
    }
    return null;
}

function getSideData(stream, needle) {
    var sideData = stream && stream.side_data_list;
    if (!Array.isArray(sideData)) return null;
    needle = String(needle || '').toLowerCase();
    for (var i = 0; i < sideData.length; i++) {
        var item = sideData[i] || {};
        var type = String(item.side_data_type || '').toLowerCase();
        if (type.indexOf(needle) !== -1) return item;
    }
    return null;
}

function hasSideData(stream, needles) {
    for (var i = 0; i < needles.length; i++) {
        if (getSideData(stream, needles[i])) return true;
    }
    return false;
}

function isHdr10PlusDescription(value) {
    var description = String(value || '');
    return /hdr10(?:\s*\+|plus)(?![a-z0-9])/i.test(description) ||
        /smpte(?:\s*st)?[\s._-]*2094(?:[\s._-]*40(?!\d)|[\s._-]*(?:app(?:lication)?\.?)[\s._-]*4(?!\d))/i.test(description);
}

function hasHdr10PlusMediaInfo(track) {
    if (!track) return false;
    var fields = [
        'HDR_Format',
        'HDR_Format_String',
        'HDR_Format_Commercial',
        'HDR_Format_Commercial_IfAny',
        'HDR_Format_Profile',
        'HDR_Format_Compatibility',
    ];
    for (var i = 0; i < fields.length; i++) {
        if (hasVal(track[fields[i]]) && isHdr10PlusDescription(track[fields[i]])) return true;
    }
    return false;
}

function hasHdr10PlusEvidence(stream, mediaInfoTrack) {
    var sideData = stream && stream.side_data_list;
    if (Array.isArray(sideData)) {
        for (var i = 0; i < sideData.length; i++) {
            if (isHdr10PlusDescription(sideData[i] && sideData[i].side_data_type)) return true;
        }
    }
    return hasHdr10PlusMediaInfo(mediaInfoTrack);
}

function formatMasterDisplay(md) {
    if (!md) return '';
    var rx = parseNum(firstPresent(md, ['red_x', 'display_primaries_red_x']));
    var ry = parseNum(firstPresent(md, ['red_y', 'display_primaries_red_y']));
    var gx = parseNum(firstPresent(md, ['green_x', 'display_primaries_green_x']));
    var gy = parseNum(firstPresent(md, ['green_y', 'display_primaries_green_y']));
    var bx = parseNum(firstPresent(md, ['blue_x', 'display_primaries_blue_x']));
    var by = parseNum(firstPresent(md, ['blue_y', 'display_primaries_blue_y']));
    var wpx = parseNum(firstPresent(md, ['white_point_x', 'whitepoint_x']));
    var wpy = parseNum(firstPresent(md, ['white_point_y', 'whitepoint_y']));
    var minLum = parseNum(firstPresent(md, ['min_luminance', 'min_luminance_nits']));
    var maxLum = parseNum(firstPresent(md, ['max_luminance', 'max_luminance_nits']));
    var nums = [rx, ry, gx, gy, bx, by, wpx, wpy, minLum, maxLum];
    for (var i = 0; i < nums.length; i++) {
        if (nums[i] === null || !isFinite(nums[i])) return '';
    }
    // FFmpeg expects chromaticity coordinates in 1/50000 units and luminance in 1/10000 nit units.
    return 'G(' + Math.round(gx * 50000) + ',' + Math.round(gy * 50000) + ')' +
        'B(' + Math.round(bx * 50000) + ',' + Math.round(by * 50000) + ')' +
        'R(' + Math.round(rx * 50000) + ',' + Math.round(ry * 50000) + ')' +
        'WP(' + Math.round(wpx * 50000) + ',' + Math.round(wpy * 50000) + ')' +
        'L(' + Math.round(maxLum * 10000) + ',' + Math.round(minLum * 10000) + ')';
}

function formatMaxCll(cll) {
    if (!cll) return '';
    var maxContent = parseNum(firstPresent(cll, ['max_content', 'max_content_light_level', 'maxcll', 'MaxCLL']));
    var maxAverage = parseNum(firstPresent(cll, ['max_average', 'max_frame_average_light_level', 'maxfall', 'MaxFALL']));
    if (maxContent === null || maxAverage === null) return '';
    return Math.round(maxContent) + ',' + Math.round(maxAverage);
}

function getDolbyVisionInfo(stream) {
    var sideData = stream && stream.side_data_list;
    if (!Array.isArray(sideData)) return null;
    for (var i = 0; i < sideData.length; i++) {
        var item = sideData[i] || {};
        if (!/dovi|dolby vision/i.test(String(item.side_data_type || ''))) continue;
        return {
            profile: parseNum(item.dv_profile),
            level: parseNum(item.dv_level),
            compatibilityId: parseNum(item.dv_bl_signal_compatibility_id),
            baseLayerPresent: Number(item.bl_present_flag) === 1,
            enhancementLayerPresent: Number(item.el_present_flag) === 1,
            rpuPresent: Number(item.rpu_present_flag) === 1,
        };
    }
    return null;
}

function isDolbyVisionHdr10Compatible(info, stream) {
    if (!info || (info.compatibilityId !== 1 && info.compatibilityId !== 6)) return false;
    var transfer = String((stream && stream.color_transfer) || '').toLowerCase();
    var primaries = String((stream && stream.color_primaries) || '').toLowerCase();
    var pixFmt = String((stream && stream.pix_fmt) || '').toLowerCase();
    return info.baseLayerPresent && transfer.indexOf('smpte2084') !== -1 &&
        primaries.indexOf('bt2020') !== -1 && (pixFmt.indexOf('10') !== -1 || pixFmt.indexOf('p010') !== -1);
}

function isPqTransfer(value) {
    var transfer = String(value || '').trim().toLowerCase();
    return transfer === 'smpte2084' || transfer === 'smpte-st-2084' ||
        transfer === 'smpte_st_2084' || transfer === 'st2084' || transfer === 'pq';
}

function isBt2020Primaries(value) {
    var primaries = String(value || '').trim().toLowerCase();
    return primaries === 'bt2020' || primaries === 'bt.2020';
}

function isBt2020Matrix(value) {
    var matrix = String(value || '').trim().toLowerCase();
    return ['bt2020nc', 'bt2020ncl', 'bt2020c', 'bt2020cl'].indexOf(matrix) !== -1;
}

function isRecognizedHdrPixelFormat(value) {
    var pixFmt = String(value || '').trim().toLowerCase();
    return /^(?:yuv(?:420|422|444)p(?:10|12)(?:le|be)|p(?:010|012|210|212|410|412)(?:le|be))$/.test(pixFmt);
}

function isHdr10PlusStaticHdr10Compatible(stream, mediaInfoTrack) {
    if (!stream || getDolbyVisionInfo(stream)) return false;
    if (!hasHdr10PlusEvidence(stream, mediaInfoTrack)) return false;
    return isPqTransfer(stream.color_transfer) &&
        isBt2020Primaries(stream.color_primaries) &&
        isBt2020Matrix(stream.color_space) &&
        isRecognizedHdrPixelFormat(stream.pix_fmt);
}
exports.isHdr10PlusStaticHdr10Compatible = isHdr10PlusStaticHdr10Compatible;

function mediaInfoStreamOrder(track) {
    var raw = firstPresent(track, ['StreamOrder', 'StreamOrder_String']);
    if (!hasVal(raw)) return null;
    var value = String(raw).trim();
    return /^\d+$/.test(value) ? Number(value) : null;
}

function dimensionValue(value) {
    if (!hasVal(value)) return null;
    var normalized = String(value).trim().replace(/\u00a0/g, ' ');
    var match = normalized.match(/^(\d{1,3}(?:[ ,]\d{3})+|\d+)(?:\s*(?:pixels?|px))?$/i);
    if (!match) return null;
    var parsed = Number(match[1].replace(/[ ,]/g, ''));
    return isFinite(parsed) && parsed > 0 ? parsed : null;
}

function mediaInfoTrackMatchesStream(track, stream) {
    if (!track || !stream) return false;
    var trackOrder = mediaInfoStreamOrder(track);
    var streamIndex = Number(stream.index);
    if (trackOrder === null || !Number.isInteger(streamIndex) || streamIndex < 0 ||
        trackOrder !== streamIndex) return false;
    var trackWidth = dimensionValue(firstPresent(track, ['Width', 'Width_Original']));
    var trackHeight = dimensionValue(firstPresent(track, ['Height', 'Height_Original']));
    var streamWidth = dimensionValue(stream.width);
    var streamHeight = dimensionValue(stream.height);
    return trackWidth !== null && trackHeight !== null && streamWidth !== null &&
        streamHeight !== null && trackWidth === streamWidth && trackHeight === streamHeight;
}

function getMediaInfoVideoTrack(inputFileObj, stream) {
    var mediaInfo = inputFileObj && (inputFileObj.mediaInfo || inputFileObj.mediaInfoData);
    var tracks = mediaInfo && mediaInfo.track;
    if (!Array.isArray(tracks)) return null;
    var videos = [];
    for (var i = 0; i < tracks.length; i++) {
        if (String(tracks[i] && tracks[i]['@type'] || '').toLowerCase() === 'video') videos.push(tracks[i]);
    }
    if (videos.length === 1) return videos[0];
    if (videos.length === 0 || !stream) return null;
    var matches = videos.filter(function (track) {
        return mediaInfoTrackMatchesStream(track, stream);
    });
    return matches.length === 1 ? matches[0] : null;
}

function formatMasterDisplayFromMediaInfo(track) {
    if (!track) return '';
    var primariesName = String(track.MasteringDisplay_ColorPrimaries || '').toLowerCase();
    var coords = null;
    if (primariesName.indexOf('p3') !== -1) {
        coords = { rx: 0.68, ry: 0.32, gx: 0.265, gy: 0.69, bx: 0.15, by: 0.06 };
    } else if (primariesName.indexOf('2020') !== -1) {
        coords = { rx: 0.708, ry: 0.292, gx: 0.17, gy: 0.797, bx: 0.131, by: 0.046 };
    }
    if (!coords) return '';
    var luminance = String(track.MasteringDisplay_Luminance || '');
    var minMatch = luminance.match(/min\s*:\s*([0-9.]+)/i);
    var maxMatch = luminance.match(/max\s*:\s*([0-9.]+)/i);
    if (!minMatch || !maxMatch) return '';
    var minLum = parseFloat(minMatch[1]);
    var maxLum = parseFloat(maxMatch[1]);
    if (!isFinite(minLum) || !isFinite(maxLum)) return '';
    return 'G(' + Math.round(coords.gx * 50000) + ',' + Math.round(coords.gy * 50000) + ')' +
        'B(' + Math.round(coords.bx * 50000) + ',' + Math.round(coords.by * 50000) + ')' +
        'R(' + Math.round(coords.rx * 50000) + ',' + Math.round(coords.ry * 50000) + ')' +
        'WP(15635,16450)' +
        'L(' + Math.round(maxLum * 10000) + ',' + Math.round(minLum * 10000) + ')';
}

function formatMaxCllFromMediaInfo(track) {
    if (!track) return '';
    var maxCllMatch = String(track.MaxCLL || '').match(/([0-9.]+)/);
    var maxFallMatch = String(track.MaxFALL || '').match(/([0-9.]+)/);
    if (!maxCllMatch || !maxFallMatch) return '';
    return Math.round(parseFloat(maxCllMatch[1])) + ',' + Math.round(parseFloat(maxFallMatch[1]));
}

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    var isHDR = false;
    var colorPrimaries = 'bt709';
    var colorTrc = 'bt709';
    var colorspace = 'bt709';
    var pixFmt = 'yuv420p';
    var hdrMasterDisplay = '';
    var hdrMaxCll = '';
    var hasDolbyVision = false;
    var hasHDR10Plus = false;
    var dolbyVisionInfo = null;
    var keepOriginalUnsupportedColor = false;
    var dynamicHdrPolicy = String(args.inputs.dynamicHdrPolicy || 'profileAwareHdr10');
    var stream = getVideoStream(args.inputFileObj);
    var mediaInfoVideo = getMediaInfoVideoTrack(args.inputFileObj, stream);

    if (stream) {
        var colorTransfer = String(stream.color_transfer || '').toLowerCase().trim();
        var primaries = String(stream.color_primaries || '').toLowerCase().trim();
        var space = String(stream.color_space || '').toLowerCase().trim();
        var pix = String(stream.pix_fmt || '').toLowerCase().trim();
        var explicitSdrTransfers = ['bt709', 'iec61966-2-1', 'gamma22', 'gamma28', 'smpte170m',
            'smpte240m', 'bt470bg', 'bt470m', 'bt2020-10', 'bt2020-12'];
        var transferIsExplicitSdr = explicitSdrTransfers.indexOf(colorTransfer) !== -1;
        var transferIsUnknown = colorTransfer === '' || colorTransfer === 'unknown' ||
            colorTransfer === 'unspecified' || colorTransfer === 'reserved';
        var highBitBt2020WithoutTransfer = transferIsUnknown && primaries.indexOf('bt2020') !== -1 &&
            (pix.indexOf('10') !== -1 || pix.indexOf('12') !== -1 || pix.indexOf('p010') !== -1 || pix.indexOf('p012') !== -1);
        var masteringSideData = getSideData(stream, 'mastering display');
        var cllSideData = getSideData(stream, 'content light');
        dolbyVisionInfo = getDolbyVisionInfo(stream);
        hasDolbyVision = !!dolbyVisionInfo;
        hasHDR10Plus = hasHdr10PlusEvidence(stream, mediaInfoVideo);

        if (colorTransfer.indexOf('smpte2084') !== -1 || colorTransfer.indexOf('arib-std-b67') !== -1 ||
            colorTransfer.indexOf('hlg') !== -1 || masteringSideData || cllSideData ||
            hasDolbyVision || hasHDR10Plus) {
            isHDR = true;
        }

        // An explicit SDR transfer is authoritative. In particular, BT.2020 10/12-bit
        // wide-gamut SDR must not be rewritten to PQ merely because it is high bit depth.
        if (transferIsExplicitSdr && !masteringSideData && !cllSideData && !hasDolbyVision && !hasHDR10Plus) {
            isHDR = false;
        }

        // BT.2020 primaries plus 10/12-bit samples do not identify an EOTF.
        // They can represent PQ, HLG, or wide-gamut SDR. Never invent PQ: keep
        // the untouched source and require corrected metadata or manual review.
        if (highBitBt2020WithoutTransfer) {
            keepOriginalUnsupportedColor = true;
            isHDR = false;
            colorPrimaries = primaries || 'unknown';
            colorTrc = colorTransfer || 'unknown';
            colorspace = space || 'unknown';
            pixFmt = pix || 'unknown';
        } else if (isHDR) {
            colorPrimaries = primaries.indexOf('bt2020') !== -1 ? 'bt2020' : 'bt2020';
            if (colorTransfer.indexOf('smpte2084') !== -1) {
                colorTrc = 'smpte2084';
            } else if (colorTransfer.indexOf('arib-std-b67') !== -1 || colorTransfer.indexOf('hlg') !== -1) {
                colorTrc = 'arib-std-b67';
            } else {
                colorTrc = 'smpte2084';
            }
            colorspace = space.indexOf('bt2020nc') !== -1 || space.indexOf('bt2020') !== -1 ? 'bt2020nc' : 'bt2020nc';
            pixFmt = 'p010le';
            hdrMasterDisplay = formatMasterDisplay(masteringSideData || stream.mastering_display_metadata);
            hdrMaxCll = formatMaxCll(cllSideData || stream.content_light_level_metadata);
            if (!hdrMasterDisplay) hdrMasterDisplay = formatMasterDisplayFromMediaInfo(mediaInfoVideo);
            if (!hdrMaxCll) hdrMaxCll = formatMaxCllFromMediaInfo(mediaInfoVideo);
        } else if (colorTransfer === 'bt2020-10' || colorTransfer === 'bt2020-12') {
            colorPrimaries = primaries.indexOf('bt2020') !== -1 ? 'bt2020' : 'bt2020';
            colorTrc = colorTransfer;
            colorspace = space.indexOf('bt2020') !== -1 ? space : 'bt2020nc';
            // AV1 NVENC accepts p010le for high-bit-depth input; retain the explicit
            // SDR transfer even when a 12-bit source must be represented at 10 bit.
            pixFmt = 'p010le';
        }
    }

    if (keepOriginalUnsupportedColor) {
        args.jobLog('KEEP ORIGINAL: 10/12-bit BT.2020 source has an unknown transfer function; ' +
            'PQ/HLG/SDR cannot be inferred safely and no color tags will be rewritten.');
    } else if (!isHDR) {
        args.jobLog(colorTrc.indexOf('bt2020-') === 0
            ? 'Wide-gamut SDR content detected. Preserving BT.2020 SDR transfer and 10/12-bit signal.'
            : 'SDR content detected. Using bt709 color space.');
    } else {
        args.jobLog('HDR content detected. Using bt2020 color space with ' + colorTrc + ' transfer.');
        if (hdrMasterDisplay) {
            args.jobLog('HDR Master Display: ' + hdrMasterDisplay);
        } else {
            args.jobLog('⚠ HDR static mastering metadata was not found; output will preserve HDR color tags but not master-display metadata.');
        }
        if (hdrMaxCll) {
            args.jobLog('HDR MaxCLL/MaxFALL: ' + hdrMaxCll);
        } else {
            args.jobLog('⚠ HDR MaxCLL/MaxFALL metadata was not found.');
        }
        if (hasDolbyVision) {
            args.jobLog('⚠ Dolby Vision detected: profile ' + dolbyVisionInfo.profile +
                ', base-layer compatibility ID ' + dolbyVisionInfo.compatibilityId +
                '. AV1/NVENC will not preserve the RPU; an authorized fallback becomes static HDR10.');
        }
        if (hasHDR10Plus) {
            args.jobLog('⚠ HDR10+ dynamic metadata detected. This flow does not currently preserve HDR10+ dynamic metadata; static HDR tags only.');
        }
    }
    args.variables.color_primaries = colorPrimaries;
    args.variables.color_trc = colorTrc;
    args.variables.colorspace = colorspace;
    args.variables.pix_fmt = pixFmt;
    args.variables.isHDR = isHDR;
    args.variables.isDolbyVision = hasDolbyVision;
    args.variables.isHDR10Plus = hasHDR10Plus;
    args.variables.vmafDolbyVisionInfo = dolbyVisionInfo;
    args.variables.vmafDynamicHdrPolicy = dynamicHdrPolicy;
    if (keepOriginalUnsupportedColor) {
        args.variables.vmafColorMetadataUnsupported = true;
        args.variables.vmafProcessingDisposition = 'keep_original_ambiguous_color_transfer';
        args.variables.vmafProcessingDispositionReason =
            'bt2020_high_bit_depth_unknown_transfer';
    }
    var dolbyHdr10Compatible = hasDolbyVision && isDolbyVisionHdr10Compatible(dolbyVisionInfo, stream);
    var hdr10PlusHdr10Compatible = hasHDR10Plus && isHdr10PlusStaticHdr10Compatible(stream, mediaInfoVideo);
    args.variables.vmafHdr10PlusStaticHdr10Compatible = hdr10PlusHdr10Compatible;
    var staticFallbackAuthorized = false;
    var keepOriginalDynamicHdr = false;
    if ((hasDolbyVision || hasHDR10Plus) && !keepOriginalUnsupportedColor) {
        args.variables.hdr_dynamic_metadata_warning = 'Dynamic HDR metadata detected; AV1/NVENC flow preserves static HDR10/HLG signalling only.';
        staticFallbackAuthorized = dynamicHdrPolicy === 'allowStaticFallback' ||
            (dynamicHdrPolicy === 'profileAwareHdr10' && ((hasDolbyVision && dolbyHdr10Compatible) || hdr10PlusHdr10Compatible));
        keepOriginalDynamicHdr = !staticFallbackAuthorized;
        if (staticFallbackAuthorized) {
            args.variables.vmafDynamicHdrStaticFallbackAuthorized = true;
            args.variables.vmafDynamicHdrConversion = hasDolbyVision ? 'dolby_vision_to_hdr10' : 'hdr10plus_to_hdr10';
            args.variables.vmafProcessingDisposition = 'transcode_static_hdr10_fallback';
            args.variables.vmafProcessingDispositionReason = hasDolbyVision
                ? 'dolby_vision_hdr10_compatible_base_layer'
                : 'hdr10plus_static_hdr10_base_layer';
            args.jobLog('STATIC HDR10 FALLBACK AUTHORIZED: compatible HDR base layer will be transcoded; dynamic metadata will be removed.');
        } else {
            args.variables.vmafProcessingDisposition = 'keep_original_dynamic_hdr';
            args.variables.vmafProcessingDispositionReason = hasDolbyVision
                ? 'dolby_vision_base_layer_not_hdr10_compatible'
                : 'hdr10plus_base_layer_not_hdr10_compatible';
            if (hasHDR10Plus && !hasDolbyVision && !hdr10PlusHdr10Compatible) {
                args.jobLog('HDR10+ static fallback rejected: source must have PQ transfer, BT.2020 primaries/matrix, and a recognized 10/12-bit pixel format.');
            }
            args.jobLog('KEEP ORIGINAL: Dynamic HDR has no policy-authorized HDR10-compatible fallback.');
        }
    }
    if (hdrMasterDisplay) {
        args.variables.hdr_master_display = hdrMasterDisplay;
    }
    if (hdrMaxCll) {
        args.variables.hdr_max_cll = hdrMaxCll;
    }
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: (keepOriginalDynamicHdr || keepOriginalUnsupportedColor)
            ? 3 : (isHDR ? 1 : 2),
        variables: args.variables,
    };
};
exports.plugin = plugin;
exports._test = {
    getVideoStream: getVideoStream,
    getMediaInfoVideoTrack: getMediaInfoVideoTrack,
    mediaInfoTrackMatchesStream: mediaInfoTrackMatchesStream,
    getDolbyVisionInfo: getDolbyVisionInfo,
    isDolbyVisionHdr10Compatible: isDolbyVisionHdr10Compatible,
    isHdr10PlusDescription: isHdr10PlusDescription,
    hasHdr10PlusMediaInfo: hasHdr10PlusMediaInfo,
    isHdr10PlusStaticHdr10Compatible: isHdr10PlusStaticHdr10Compatible,
    isRecognizedHdrPixelFormat: isRecognizedHdrPixelFormat,
    formatMasterDisplayFromMediaInfo: formatMasterDisplayFromMediaInfo,
    formatMaxCllFromMediaInfo: formatMaxCllFromMediaInfo,
};
