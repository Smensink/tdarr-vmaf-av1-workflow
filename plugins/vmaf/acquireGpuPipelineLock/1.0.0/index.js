"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;

var details = function () { return ({
    name: 'Acquire GPU Pipeline Lock',
    description: 'Serializes VMAF GPU-heavy stages across multiple Tdarr GPU workers while allowing pre/post-GPU work to overlap.',
    style: {
        borderColor: 'orange',
    },
    tags: 'video,vmaf,gpu,lock,pipeline',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faLock',
    inputs: [
        {
            label: 'Lock Directory',
            name: 'lockDir',
            type: 'string',
            defaultValue: '/temp/tdarr-vmaf-gpu-pipeline.lock',
            inputUI: { type: 'text' },
            tooltip: 'Shared lock directory visible to all Tdarr workers. Atomic mkdir is used for acquisition.',
        },
        {
            label: 'Poll Interval Seconds',
            name: 'waitPollSeconds',
            type: 'number',
            defaultValue: '5',
            inputUI: { type: 'text' },
            tooltip: 'How often a waiting worker checks whether the lock is free.',
        },
        {
            label: 'Wait Log Seconds',
            name: 'waitLogSeconds',
            type: 'number',
            defaultValue: '60',
            inputUI: { type: 'text' },
            tooltip: 'How often to write a waiting status line to the Tdarr job report.',
        },
        {
            label: 'Max Wait Hours',
            name: 'maxWaitHours',
            type: 'number',
            defaultValue: '12',
            inputUI: { type: 'text' },
            tooltip: 'Maximum time this worker may wait for the GPU lock before failing the job.',
        },
        {
            label: 'Stale Heartbeat Hours',
            name: 'staleHeartbeatHours',
            type: 'number',
            defaultValue: '2',
            inputUI: { type: 'text' },
            tooltip: 'Only break a lock after the owner heartbeat has been stale this long. Keep high because full encodes can be long.',
        },
        {
            label: 'Max Lock Age Hours',
            name: 'maxLockAgeHours',
            type: 'number',
            defaultValue: '8',
            inputUI: { type: 'text' },
            tooltip: 'Safety ceiling for a lock with missing/stale heartbeat metadata.',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'GPU pipeline lock acquired',
        },
    ],
}); };
exports.details = details;

function getFilePath(args) {
    if (args.inputFileObj && args.inputFileObj.file) {
        return args.inputFileObj.file;
    }
    if (args.inputFileObj && args.inputFileObj._id) {
        return args.inputFileObj._id;
    }
    return 'unknown-file';
}

function getWorkerName() {
    return process.env.Tdarr_Node_Name ||
        process.env.TDARR_NODE_NAME ||
        process.env.nodeID ||
        process.env.NODE_ID ||
        process.env.HOSTNAME ||
        'unknown-worker';
}

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);

    var lock = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/gpuPipelineLock.js');
    var lockDir = String(args.inputs.lockDir || '/temp/tdarr-vmaf-gpu-pipeline.lock');
    var filePath = getFilePath(args);
    var ownerId = (args.inputFileObj && args.inputFileObj._id ? args.inputFileObj._id : '') || filePath;
    var workerName = getWorkerName();
    var startedAt = Date.now();

    args.jobLog('=== Acquire GPU Pipeline Lock ===');
    args.jobLog('Requesting GPU pipeline lock at ' + lockDir + ' for ' + filePath);

    var result = lock.acquireBlocking({
        lockDir: lockDir,
        owner: {
            ownerId: ownerId,
            workerName: workerName,
            filePath: filePath,
            stage: 'vmaf-gpu-pipeline',
            plugin: 'acquireGpuPipelineLock'
        },
        waitPollSeconds: Number(args.inputs.waitPollSeconds) || 5,
        waitLogSeconds: Number(args.inputs.waitLogSeconds) || 60,
        maxWaitSeconds: (Number(args.inputs.maxWaitHours) || 12) * 3600,
        staleHeartbeatSeconds: (Number(args.inputs.staleHeartbeatHours) || 2) * 3600,
        maxLockAgeSeconds: (Number(args.inputs.maxLockAgeHours) || 8) * 3600,
        heartbeatIntervalSeconds: 30,
        existingToken: (args.variables.vmafGpuPipelineLockAcquired && args.variables.vmafGpuPipelineLock)
            ? args.variables.vmafGpuPipelineLock.token
            : null,
        log: function (message) { args.jobLog(message); }
    });

    var waitedSeconds = Math.round((Date.now() - startedAt) / 1000);
    args.variables.vmafGpuPipelineLock = {
        lockDir: lockDir,
        token: result.owner.token,
        ownerId: result.owner.ownerId,
        workerName: workerName,
        acquiredAt: result.owner.acquiredAt,
        waitedSeconds: waitedSeconds
    };
    args.variables.vmafGpuPipelineLockAcquired = true;
    args.jobLog('GPU pipeline lock acquired' + (waitedSeconds > 0 ? ' after ' + waitedSeconds + 's' : '') +
        ' (owner=' + result.owner.ownerId + ', heartbeatPid=' + (result.owner.heartbeatPid || 'n/a') + ')');

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
