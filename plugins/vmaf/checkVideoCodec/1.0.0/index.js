"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Check Video Codec',
    description: 'Checks if video is already in target codec format. Skips processing if already AV1 to avoid unnecessary re-encoding.',
    style: {
        borderColor: 'orange',
    },
    tags: 'video,codec,filter',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faQuestion',
    inputs: [
        {
            label: 'Target Codec',
            name: 'targetCodec',
            type: 'string',
            defaultValue: 'av1',
            inputUI: {
                type: 'dropdown',
                options: ['av1', 'hevc', 'h264'],
            },
            tooltip: 'Target video codec. If file is already this codec, processing will be skipped.',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'File needs transcoding (not in target codec)',
        },
        {
            number: 2,
            tooltip: 'File already in target codec - skip processing',
        },
    ],
}); };
exports.details = details;

var CODEC_ALIASES = {
    av1: { av1: true },
    hevc: { hevc: true, h265: true },
    h264: { h264: true, avc: true, x264: true },
};

function canonicalCodec(codecName) {
    var codec = String(codecName || '').trim().toLowerCase();
    var targets = Object.keys(CODEC_ALIASES);
    for (var i = 0; i < targets.length; i++) {
        if (CODEC_ALIASES[targets[i]][codec] === true) return targets[i];
    }
    return codec;
}

function ordinaryVideoStreams(inputFileObj) {
    var streams = (((inputFileObj || {}).ffProbeData || {}).streams || []);
    return streams.filter(function(stream) {
        if (!stream || stream.codec_type !== 'video') return false;
        var disposition = stream.disposition || {};
        return Number(disposition.attached_pic || 0) !== 1;
    });
}

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var targetCodec = canonicalCodec(args.inputs.targetCodec || 'av1');
    var videoStreams = ordinaryVideoStreams(args.inputFileObj);
    var currentCodecs = videoStreams.map(function(stream) {
        return canonicalCodec(stream.codec_name);
    });

    if (currentCodecs.length === 0 || currentCodecs.some(function(codec) { return !codec; })) {
        args.jobLog('WARNING: Could not determine every ordinary video-stream codec. Proceeding with transcoding.');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    // Skip only when every ordinary video stream is exactly the requested
    // codec. Attached pictures are deliberately ignored.
    var isTargetCodec = currentCodecs.every(function(codec) {
        return codec === targetCodec;
    });

    if (isTargetCodec) {
        args.jobLog('All ordinary video streams are already in target codec (' + targetCodec + '). Skipping VMAF optimization to avoid unnecessary re-encoding.');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 2,
            variables: args.variables,
        };
    }

    args.jobLog('Ordinary video codecs: ' + currentCodecs.join(', ') + ' (target: ' + targetCodec + ') - proceeding with transcoding');
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
exports._test = {
    canonicalCodec: canonicalCodec,
    ordinaryVideoStreams: ordinaryVideoStreams,
};
