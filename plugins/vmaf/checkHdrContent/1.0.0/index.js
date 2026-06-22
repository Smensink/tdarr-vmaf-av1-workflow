"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Check HDR Content',
    description: 'Detects HDR content and sets color metadata variables for proper encoding.',
    style: {
        borderColor: 'purple',
    },
    tags: 'video,hdr,color',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faVideo',
    inputs: [],
    outputs: [
        {
            number: 1,
            tooltip: 'HDR content detected',
        },
        {
            number: 2,
            tooltip: 'SDR content detected',
        },
    ],
}); };
exports.details = details;

function getVideoStream(inputFileObj) {
    var streams = inputFileObj && inputFileObj.ffProbeData && inputFileObj.ffProbeData.streams;
    if (!Array.isArray(streams)) return null;
    for (var i = 0; i < streams.length; i++) {
        if (streams[i] && streams[i].codec_type === 'video') return streams[i];
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
    var stream = getVideoStream(args.inputFileObj);

    if (stream) {
        var colorTransfer = String(stream.color_transfer || '').toLowerCase();
        var primaries = String(stream.color_primaries || '').toLowerCase();
        var space = String(stream.color_space || '').toLowerCase();
        var pix = String(stream.pix_fmt || '').toLowerCase();
        var masteringSideData = getSideData(stream, 'mastering display');
        var cllSideData = getSideData(stream, 'content light');
        hasDolbyVision = hasSideData(stream, ['dovi', 'dolby vision']);
        hasHDR10Plus = hasSideData(stream, ['smpte2094', 'dynamic hdr', 'hdr10+']);

        if (colorTransfer.indexOf('smpte2084') !== -1 || colorTransfer.indexOf('arib-std-b67') !== -1 ||
            colorTransfer.indexOf('hlg') !== -1 || masteringSideData || cllSideData || hasDolbyVision || hasHDR10Plus ||
            (primaries.indexOf('bt2020') !== -1 && (pix.indexOf('10') !== -1 || pix.indexOf('p010') !== -1))) {
            isHDR = true;
        }

        if (isHDR) {
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
        }
    }

    if (!isHDR) {
        args.jobLog('SDR content detected. Using bt709 color space.');
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
            args.jobLog('⚠ Dolby Vision metadata detected. This AV1/NVENC flow does not preserve Dolby Vision RPU/profile metadata; output should be treated as HDR10/HLG only.');
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
    if (hasDolbyVision || hasHDR10Plus) {
        args.variables.hdr_dynamic_metadata_warning = 'Dynamic HDR metadata detected; AV1/NVENC flow preserves static HDR10/HLG signalling only.';
    }
    if (hdrMasterDisplay) {
        args.variables.hdr_master_display = hdrMasterDisplay;
    }
    if (hdrMaxCll) {
        args.variables.hdr_max_cll = hdrMaxCll;
    }
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: isHDR ? 1 : 2,
        variables: args.variables,
    };
};
exports.plugin = plugin;
