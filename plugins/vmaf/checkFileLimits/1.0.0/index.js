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

function parseLimit(value, defaultValue) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return defaultValue;
    }
    var parsed = Number(value);
    return isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function fileSizeGiB(inputFileObj) {
    var file = inputFileObj || {};
    // Tdarr's file_size field is expressed in MiB, not bytes.
    var tdarrSizeMiB = Number(file.file_size);
    if (isFinite(tdarrSizeMiB) && tdarrSizeMiB >= 0) {
        return tdarrSizeMiB / 1024;
    }
    // ffprobe format.size is a byte count and is a safe fallback when Tdarr has
    // not populated file_size.
    var ffprobeBytes = Number(file.ffProbeData && file.ffProbeData.format
        && file.ffProbeData.format.size);
    return isFinite(ffprobeBytes) && ffprobeBytes >= 0
        ? ffprobeBytes / (1024 * 1024 * 1024)
        : 0;
}

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var maxFileSizeGB = parseLimit(args.inputs.maxFileSizeGB, 50);
    var maxDurationHours = parseLimit(args.inputs.maxDurationHours, 4);

    if (Number(args.inputs.maxFileSizeGB) < 0 || (String(args.inputs.maxFileSizeGB || '').trim() !== ''
        && !isFinite(Number(args.inputs.maxFileSizeGB)))) {
        args.jobLog('WARNING: Invalid maxFileSizeGB (' + args.inputs.maxFileSizeGB + '), using default 50');
    }
    if (Number(args.inputs.maxDurationHours) < 0 || (String(args.inputs.maxDurationHours || '').trim() !== ''
        && !isFinite(Number(args.inputs.maxDurationHours)))) {
        args.jobLog('WARNING: Invalid maxDurationHours (' + args.inputs.maxDurationHours + '), using default 4');
    }

    var fileSizeGB = fileSizeGiB(args.inputFileObj);
    var durationHours = 0;

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
exports._test = {
    parseLimit: parseLimit,
    fileSizeGiB: fileSizeGiB,
};
