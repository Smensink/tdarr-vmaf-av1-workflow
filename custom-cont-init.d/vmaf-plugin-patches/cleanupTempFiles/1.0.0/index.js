"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var postEncodeCheckpoint = require('../../_lib/postEncodeCheckpoint.js');
var details = function () { return ({
    name: 'Cleanup Temporary Files',
    description: 'Deletes only job-owned VMAF temporary files recorded in the flow manifest.',
    style: { borderColor: 'gray' },
    tags: 'video,cleanup,maintenance',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faTrash',
    inputs: [{ label: 'Cleanup Enabled', name: 'cleanupEnabled', type: 'boolean', defaultValue: 'true',
        inputUI: { type: 'switch' }, tooltip: 'Enable deletion of job-owned temporary files.' }],
    outputs: [{ number: 1, tooltip: 'Cleanup completed' }],
}); };
exports.details = details;
var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    if (args.inputs.cleanupEnabled === false || args.inputs.cleanupEnabled === 'false') {
        args.jobLog('Cleanup disabled - temporary files will be preserved');
        return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
    }
    var fs = require('fs');
    var path = require('path');
    var cacheDir = args.workDir || '/temp';
    var candidates = (args.variables.vmafTemporaryFiles || []).slice();
    (args.variables.vmafSamples || []).forEach(function (file) { candidates.push(file); });
    (args.variables.vmafOriginalSourceSamples || []).forEach(function (file) { candidates.push(file); });
    (args.variables.vmafTestResults || []).forEach(function (item) { candidates.push(item && item.outputPath); });
    (args.variables.vmafEncodeFailures || []).forEach(function (item) { candidates.push(item && item.outputPath); });
    if (args.variables.vmafHoldoutSample) {
        candidates.push(args.variables.vmafHoldoutSample.path);
        candidates.push(args.variables.vmafHoldoutSample.originalPath);
    }
    candidates.push(args.variables.vmafTranscodeOutputPath);
    var root = path.resolve(cacheDir);
    var protectedPaths = [args.inputFileObj && args.inputFileObj._id,
        args.inputFileObj && args.inputFileObj.file, args.variables.vmafOriginalFile]
        .filter(Boolean).map(function (file) { return path.resolve(String(file)); });
    var deletedCount = 0, errorCount = 0, skippedCount = 0, seen = {};
    args.jobLog('=== Cleaning Up Job-Owned Temporary Files ===');
    for (var i = 0; i < candidates.length; i++) {
        if (!candidates[i]) continue;
        var resolved = path.resolve(String(candidates[i]));
        if (seen[resolved]) continue;
        seen[resolved] = true;
        if (!((resolved === root || resolved.indexOf(root + path.sep) === 0)) || protectedPaths.indexOf(resolved) !== -1) {
            args.jobLog('Skipping non-job or protected cleanup path: ' + resolved);
            skippedCount++;
            continue;
        }
        if (!fs.existsSync(resolved)) continue;
        try {
            var stat = fs.lstatSync(resolved);
            if (!stat.isFile() && !stat.isSymbolicLink()) { skippedCount++; continue; }
            fs.unlinkSync(resolved);
            deletedCount++;
        } catch (err) {
            args.jobLog('Could not delete job temporary file: ' + resolved + ' - ' + err.message);
            errorCount++;
        }
    }
    args.variables.vmafTemporaryFiles = [];
    var checkpointRecord = args.variables.vmafPostEncodeCheckpoint;
    var grainStatus = String(args.variables.grainSynthesisStatus || '');
    var replacementStatuses = {
        active_validated: true,
        no_grain: true,
        analysis_unavailable: true,
        ineligible: true,
        disabled: true,
    };
    var replacementCompleted = args.variables.vmafTranscodeSucceeded === true &&
        args.variables.vmafTranscodeStatus === 'success' && replacementStatuses[grainStatus] === true;
    if (checkpointRecord && replacementCompleted) {
        try {
            postEncodeCheckpoint.retire(checkpointRecord);
            args.variables.vmafPostEncodeCheckpointRetired = true;
            args.jobLog('Retired protected post-encode checkpoint after successful replacement: ' +
                checkpointRecord.checkpoint_key);
        } catch (checkpointCleanupError) {
            errorCount++;
            args.jobLog('Could not retire protected post-encode checkpoint: ' + checkpointCleanupError.message);
        }
    } else if (checkpointRecord) {
        args.variables.vmafPostEncodeCheckpointRetired = false;
        args.jobLog('Retaining protected post-encode checkpoint because replacement is incomplete or canary-only.');
    }
    args.jobLog('Cleanup completed: ' + deletedCount + ' job-owned files deleted, ' + skippedCount + ' paths skipped'
        + (errorCount ? ', ' + errorCount + ' errors' : ''));
    return { outputFileObj: args.inputFileObj, outputNumber: 1, variables: args.variables };
};
exports.plugin = plugin;
