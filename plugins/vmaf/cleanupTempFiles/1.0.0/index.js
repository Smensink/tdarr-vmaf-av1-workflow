"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Cleanup Temporary Files',
    description: 'Cleans up temporary files created during VMAF optimization (samples, test encodes, VMAF logs).',
    style: {
        borderColor: 'gray',
    },
    tags: 'video,cleanup,maintenance',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faTrash',
    inputs: [
        {
            label: 'Cleanup Enabled',
            name: 'cleanupEnabled',
            type: 'boolean',
            defaultValue: 'true',
            inputUI: {
                type: 'switch',
            },
            tooltip: 'Enable cleanup of temporary files. Disable for debugging. Default: true',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'Cleanup completed',
        },
    ],
}); };
exports.details = details;
var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var cleanupEnabled = args.inputs.cleanupEnabled !== false && args.inputs.cleanupEnabled !== 'false';

    if (!cleanupEnabled) {
        args.jobLog('Cleanup disabled - temporary files will be preserved');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }

    var fs = require('fs');
    var path = require('path');
    var cacheDir = args.workDir || '/temp';
    var samples = args.variables.vmafSamples || [];
    var testResults = args.variables.vmafTestResults || [];
    var deletedCount = 0;
    var errorCount = 0;

    args.jobLog('=== Cleaning Up Temporary Files ===');

    // Clean up sample files
    for (var i = 0; i < samples.length; i++) {
        if (samples[i] && fs.existsSync(samples[i])) {
            try {
                fs.unlinkSync(samples[i]);
                deletedCount++;
            } catch (err) {
                args.jobLog('Could not delete sample: ' + samples[i] + ' - ' + err.message);
                errorCount++;
            }
        }
    }

    // Clean up test encode files
    for (var j = 0; j < testResults.length; j++) {
        if (testResults[j].outputPath && fs.existsSync(testResults[j].outputPath)) {
            try {
                fs.unlinkSync(testResults[j].outputPath);
                deletedCount++;
            } catch (err) {
                args.jobLog('Could not delete test encode: ' + testResults[j].outputPath + ' - ' + err.message);
                errorCount++;
            }
        }
    }

    // Clean up VMAF log files (pattern: vmaf_*.json)
    try {
        var files = fs.readdirSync(cacheDir);
        for (var k = 0; k < files.length; k++) {
            if (files[k].indexOf('vmaf_') === 0 && files[k].endsWith('.json')) {
                var logPath = path.join(cacheDir, files[k]);
                try {
                    fs.unlinkSync(logPath);
                    deletedCount++;
                } catch (err) {
                    errorCount++;
                }
            }
        }
    } catch (err) {
        args.jobLog('Could not read cache directory for VMAF logs: ' + err.message);
    }

    args.jobLog('Cleanup completed: ' + deletedCount + ' files deleted' + (errorCount > 0 ? ', ' + errorCount + ' errors' : ''));

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
