'use strict';

const path = require('path');

const CONTRACT_ID = 'nvencc-knn-raw-nut-pipe-v1';
const REFERENCE_CONTRACT_ID = 'nvencc-knn-r3-d0-s008-l020-th080-tf0-gpu8vmaf-v1';
const DENOISE_ID = 'nvencc-9.25-knn-radius3-d0-strength008-lerp020-thlerp080-v1';
const KNN_SETTINGS = 'radius=3,d=0,strength=0.08,lerp=0.2,th_lerp=0.8';
const DEFAULT_NVENCC_PATH = '/usr/local/bin/nvencc';
const DEFAULT_COORDINATOR_PATH = '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js';
const INPUT_PROBESIZE = String(100 * 1024 * 1024);

function knownText(value) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    return text && text.toLowerCase() !== 'unknown' && text.toLowerCase() !== 'n/a'
        ? text : '';
}

function outputDepthForStream(stream) {
    const pixFmt = knownText(stream && stream.pix_fmt).toLowerCase();
    if (['yuv420p', 'yuvj420p', 'nv12'].includes(pixFmt)) return 8;
    if (['yuv420p10le', 'p010le'].includes(pixFmt)) return 10;
    throw new Error(`NVEncC KNN requires 8-bit or 10-bit 4:2:0 input; observed ${pixFmt || 'unknown'}`);
}

function normalizedFrameRate(stream) {
    const value = knownText(
        stream && (stream.avg_frame_rate || stream.r_frame_rate)
    );
    const match = value.match(/^(\d+)(?:\/(\d+))?$/);
    if (!match) throw new Error(`cannot determine source frame rate from ${value || 'missing metadata'}`);
    const numerator = Number(match[1]);
    const denominator = Number(match[2] || 1);
    const fps = numerator / denominator;
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) {
        throw new Error(`source frame rate is outside the supported range: ${value}`);
    }
    return { text: value, fps };
}

function frameCount(durationSeconds, stream) {
    const duration = Number(durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) {
        throw new Error('KNN sample duration must be finite and positive');
    }
    // One guard frame lets the FFmpeg trim/select stage own the exact boundary.
    return Math.max(1, Math.ceil(duration * normalizedFrameRate(stream).fps) + 1);
}

function buildProducerArgs(options) {
    options = options || {};
    const depth = Number(options.outputDepth);
    if (![8, 10].includes(depth)) throw new Error('NVEncC output depth must be 8 or 10');
    const source = String(options.sourcePath || '');
    if (!path.isAbsolute(source)) throw new Error('NVEncC source path must be absolute');
    const argv = [
        '--disable-nvml', '2',
        '--avsw',
        '--input-analyze', '5',
        '--input-probesize', INPUT_PROBESIZE,
        '--timestamp-passthrough',
    ];
    if (options.seekSeconds !== undefined && options.seekSeconds !== null) {
        const seek = Number(options.seekSeconds);
        if (!Number.isFinite(seek) || seek < 0) throw new Error('NVEncC seek must be non-negative');
        argv.push('--seek', seek.toFixed(6));
    }
    argv.push(
        '-i', source,
        '--vpp-knn', KNN_SETTINGS,
        '-c', 'raw',
        '--output-format', 'nut',
        '--output-csp', 'yuv420',
        '--output-depth', String(depth)
    );
    if (options.frames !== undefined && options.frames !== null) {
        const frames = Number(options.frames);
        if (!Number.isSafeInteger(frames) || frames <= 0) {
            throw new Error('NVEncC frame limit must be a positive safe integer');
        }
        argv.push('--frames', String(frames));
    }
    argv.push('-o', '-');
    return argv;
}

function buildCoordinatorArgs(options) {
    options = options || {};
    const ffmpegArgs = (options.ffmpegArgs || []).map(String);
    const pipeInputs = [];
    for (let index = 0; index < ffmpegArgs.length - 1; index += 1) {
        if (ffmpegArgs[index] === '-i' && ffmpegArgs[index + 1] === 'pipe:0') {
            pipeInputs.push(index);
        }
    }
    if (pipeInputs.length !== 1) {
        throw new Error(`KNN FFmpeg consumer requires one pipe:0 input; observed ${pipeInputs.length}`);
    }
    const producerLog = String(options.producerLog || '');
    if (!path.isAbsolute(producerLog)) throw new Error('NVEncC producer log path must be absolute');
    const args = [
        '--nvencc', String(options.nvenccPath || DEFAULT_NVENCC_PATH),
        '--source', String(options.sourcePath || ''),
        '--output-depth', String(options.outputDepth),
        '--producer-log', producerLog,
        '--ffmpeg', String(options.ffmpegPath || ''),
    ];
    if (options.seekSeconds !== undefined && options.seekSeconds !== null) {
        args.push('--seek', Number(options.seekSeconds).toFixed(6));
    }
    if (options.frames !== undefined && options.frames !== null) {
        args.push('--frames', String(options.frames));
    }
    args.push('--');
    args.push.apply(args, ffmpegArgs);
    // Recompute the producer argv here so invalid values cannot enter a
    // checkpoint contract that the runtime coordinator would reject later.
    buildProducerArgs(options);
    return args;
}

function contractDescriptor(options) {
    options = options || {};
    return {
        schema: 1,
        contract_id: CONTRACT_ID,
        denoise_id: DENOISE_ID,
        reference_contract_id: REFERENCE_CONTRACT_ID,
        nvencc_path: String(options.nvenccPath || DEFAULT_NVENCC_PATH),
        coordinator_path: String(options.coordinatorPath || DEFAULT_COORDINATOR_PATH),
        output_depth: Number(options.outputDepth),
        pixel_transport: 'raw-yuv420-nut-stdout',
        knn_settings: KNN_SETTINGS,
        producer_argv: buildProducerArgs(options).map(function (value) {
            return value === String(options.sourcePath) ? '<SOURCE>' : value;
        }),
    };
}

function assertNoSecondDenoise(argv, context) {
    const text = (argv || []).map(String).join(' ');
    if (/hqdn3d|nlmeans|knnlm|vpp-knn/i.test(text)) {
        throw new Error(`${context || 'FFmpeg consumer'} must not apply a second denoiser`);
    }
    return argv;
}

module.exports = {
    CONTRACT_ID,
    REFERENCE_CONTRACT_ID,
    DENOISE_ID,
    KNN_SETTINGS,
    DEFAULT_NVENCC_PATH,
    DEFAULT_COORDINATOR_PATH,
    INPUT_PROBESIZE,
    outputDepthForStream,
    normalizedFrameRate,
    frameCount,
    buildProducerArgs,
    buildCoordinatorArgs,
    contractDescriptor,
    assertNoSecondDenoise,
};
