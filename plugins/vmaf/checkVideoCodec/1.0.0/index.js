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
var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var targetCodec = String(args.inputs.targetCodec || 'av1').toLowerCase();
    var currentCodec = '';

    if (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.streams) {
        for (var i = 0; i < args.inputFileObj.ffProbeData.streams.length; i++) {
            var stream = args.inputFileObj.ffProbeData.streams[i];
            if (stream.codec_type === 'video') {
                currentCodec = String(stream.codec_name || '').toLowerCase();
                break;
            }
        }
    }

    if (!currentCodec) {
        args.jobLog('WARNING: Could not determine video codec. Proceeding with transcoding.');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    // Normalize codec names for comparison
    var codecMap = {
        'av1': ['av1'],
        'hevc': ['hevc', 'h265'],
        'h264': ['h264', 'avc', 'x264'],
    };

    var targetCodecs = codecMap[targetCodec] || [targetCodec];
    var isTargetCodec = false;

    for (var j = 0; j < targetCodecs.length; j++) {
        if (currentCodec.indexOf(targetCodecs[j]) !== -1) {
            isTargetCodec = true;
            break;
        }
    }

    if (isTargetCodec) {
        args.jobLog('File is already in target codec (' + currentCodec + '). Skipping VMAF optimization to avoid unnecessary re-encoding.');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 2,
            variables: args.variables,
        };
    }

    args.jobLog('File codec: ' + currentCodec + ' (target: ' + targetCodec + ') - proceeding with transcoding');
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
