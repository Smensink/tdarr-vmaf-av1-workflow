"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

var details = function () { return ({
    name: 'Release GPU Pipeline Lock',
    description: 'Releases the shared VMAF GPU pipeline lock so another Tdarr worker can begin GPU-heavy work while this job performs post-GPU operations.',
    style: {
        borderColor: 'green',
    },
    tags: 'video,vmaf,gpu,lock,pipeline',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faUnlock',
    inputs: [
        {
            label: 'Lock Directory Override',
            name: 'lockDir',
            type: 'string',
            defaultValue: '',
            inputUI: { type: 'text' },
            tooltip: 'Optional. Leave blank to use the lock path recorded by Acquire GPU Pipeline Lock.',
        },
        {
            label: 'Force Release',
            name: 'forceRelease',
            type: 'boolean',
            defaultValue: 'false',
            inputUI: { type: 'switch' },
            tooltip: 'If enabled, release even when the owner token does not match. Normally leave disabled.',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'GPU pipeline lock released or no owned lock existed',
        },
    ],
}); };
exports.details = details;

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var lock = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/gpuPipelineLock.js');
    var lockInfo = args.variables.vmafGpuPipelineLock || {};
    var lockDir = String(args.inputs.lockDir || lockInfo.lockDir || '/temp/tdarr-vmaf-gpu-pipeline.lock');
    var token = lockInfo.token || null;
    var forceRelease = args.inputs.forceRelease === true || args.inputs.forceRelease === 'true';

    args.jobLog('=== Release GPU Pipeline Lock ===');
    var result = lock.release(lockDir, token, { force: forceRelease });
    if (result.released) {
        args.jobLog('GPU pipeline lock released: ' + lock.describeOwner(result.owner));
        args.variables.vmafGpuPipelineLockReleased = true;
        args.variables.vmafGpuPipelineLockAcquired = false;
    } else {
        args.jobLog('GPU pipeline lock not released: ' + result.reason +
            (result.owner ? ' (' + lock.describeOwner(result.owner) + ')' : ''));
        args.variables.vmafGpuPipelineLockReleased = false;
    }

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
