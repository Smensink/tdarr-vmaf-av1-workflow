"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Detect GPU Encoder',
    description: 'Detects available GPU encoders for use in VMAF parameter testing.',
    style: {
        borderColor: 'green',
    },
    tags: 'video,gpu,encoder',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faMicrochip',
    inputs: [
        {
            label: 'Target Codec',
            name: 'targetCodec',
            type: 'string',
            defaultValue: 'av1',
            inputUI: {
                type: 'dropdown',
                options: ['av1'],
            },
            tooltip: 'Target video codec for GPU encoding (AV1 only).',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'GPU encoder detected',
        },
        {
            number: 2,
            tooltip: 'No GPU encoder found - flow will fail',
        },
    ],
}); };
exports.details = details;
var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    var targetCodec = String(args.inputs.targetCodec) || 'av1';
    var gpuEncoder = null;
    var useGPU = false;
    var execSync = require('child_process').execSync;
    try {
        // Ensure library paths are available (system-wide via ldconfig or fallback to env)
        var env = Object.assign({}, process.env);
        if (!env.LD_LIBRARY_PATH || env.LD_LIBRARY_PATH.indexOf('/usr/local/lib') === -1) {
            var libraryPath = '/usr/local/lib:/usr/local/ffmpeg-custom/lib';
            if (env.LD_LIBRARY_PATH) {
                libraryPath = libraryPath + ':' + env.LD_LIBRARY_PATH;
            }
            env.LD_LIBRARY_PATH = libraryPath;
        }

        args.jobLog('Checking for GPU encoder using: ' + args.ffmpegPath);

        var encoderList = execSync('"' + args.ffmpegPath + '" -hide_banner -encoders 2>&1', {
            encoding: 'utf8',
            env: env,
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        });

        if (targetCodec === 'av1' && encoderList.indexOf('av1_nvenc') !== -1) {
            gpuEncoder = 'av1_nvenc';
            useGPU = true;
            args.jobLog('✅ Detected NVIDIA NVENC encoder: av1_nvenc');
        } else {
            // Debug: check what NVENC encoders are available
            var nvencMatches = encoderList.match(/[\w]+_nvenc/g);
            if (nvencMatches && nvencMatches.length > 0) {
                args.jobLog('⚠️ NVENC encoders found but not av1_nvenc. Available: ' + nvencMatches.join(', '));
            } else {
                args.jobLog('⚠️ No NVENC encoders found. FFmpeg may not have NVENC support compiled in.');
            }
        }
    } catch (err) {
        args.jobLog('❌ Error detecting GPU encoders: ' + err.message);
    }
    if (!useGPU) {
        args.jobLog('ERROR: No AV1 NVENC encoder detected. GPU encoding required for this flow.');
        args.jobLog('Skipping file - cannot proceed without GPU encoder.');
    }
    args.variables.vmafUseGPU = useGPU;
    args.variables.vmafGPUEncoder = gpuEncoder;
    args.variables.vmafTargetCodec = targetCodec;
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: useGPU ? 1 : 2,
        variables: args.variables,
    };
};
exports.plugin = plugin;
