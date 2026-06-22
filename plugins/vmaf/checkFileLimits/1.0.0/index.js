"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Check File Limits',
    description: 'Checks if file size or duration exceeds limits. Skips processing for very large files that would take too long.',
    style: {
        borderColor: 'orange',
    },
    tags: 'video,filter,limits',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faQuestion',
    inputs: [
        {
            label: 'Maximum File Size (GB)',
            name: 'maxFileSizeGB',
            type: 'number',
            defaultValue: '50',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Maximum file size in GB. Files larger than this will be skipped. Set to 0 to disable. Default: 50 GB',
        },
        {
            label: 'Maximum Duration (hours)',
            name: 'maxDurationHours',
            type: 'number',
            defaultValue: '4',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Maximum video duration in hours. Files longer than this will be skipped. Set to 0 to disable. Default: 4 hours',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'File within limits - proceed with processing',
        },
        {
            number: 2,
            tooltip: 'File exceeds limits - skip processing',
        },
    ],
}); };
exports.details = details;
var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var maxFileSizeGB = Number(args.inputs.maxFileSizeGB) || 50;
    var maxDurationHours = Number(args.inputs.maxDurationHours) || 4;

    // ENHANCEMENT FIX #14: Input validation
    if (isNaN(maxFileSizeGB) || maxFileSizeGB < 0) {
        args.jobLog('WARNING: Invalid maxFileSizeGB (' + args.inputs.maxFileSizeGB + '), using default 50');
        maxFileSizeGB = 50;
    }
    if (isNaN(maxDurationHours) || maxDurationHours < 0) {
        args.jobLog('WARNING: Invalid maxDurationHours (' + args.inputs.maxDurationHours + '), using default 4');
        maxDurationHours = 4;
    }

    var fileSizeGB = 0;
    var durationHours = 0;

    if (args.inputFileObj.file_size) {
        fileSizeGB = args.inputFileObj.file_size / (1024 * 1024 * 1024); // Convert bytes to GB
    }

    if (args.inputFileObj.ffProbeData && args.inputFileObj.ffProbeData.format) {
        var durationSeconds = parseFloat(args.inputFileObj.ffProbeData.format.duration) || 0;
        durationHours = durationSeconds / 3600;
    }

    var skipReason = '';

    if (maxFileSizeGB > 0 && fileSizeGB > maxFileSizeGB) {
        skipReason = 'File size (' + fileSizeGB.toFixed(2) + ' GB) exceeds maximum (' + maxFileSizeGB + ' GB)';
    } else if (maxDurationHours > 0 && durationHours > maxDurationHours) {
        skipReason = 'Duration (' + durationHours.toFixed(2) + ' hours) exceeds maximum (' + maxDurationHours + ' hours)';
    }

    if (skipReason) {
        args.jobLog('Skipping file: ' + skipReason);
        args.jobLog('VMAF optimization would take too long for this file. Consider processing manually or adjusting limits.');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 2,
            variables: args.variables,
        };
    }

    args.jobLog('File within limits: ' + fileSizeGB.toFixed(2) + ' GB, ' + durationHours.toFixed(2) + ' hours');
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
