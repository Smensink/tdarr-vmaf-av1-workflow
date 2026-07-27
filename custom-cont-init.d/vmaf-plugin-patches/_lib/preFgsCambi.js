'use strict';

const POLICY_ID = 'prefgs-cambi-cpu-libvmaf-yuv420p8-notonemap-v1';

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function positiveInteger(value, fallback, maximum) {
    let number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number < 1) number = fallback;
    return Math.min(number, maximum);
}

function filterSafePath(value, description) {
    const text = String(value || '').trim();
    if (!text) throw new TypeError(description + ' is required');
    // FFmpeg filter option values are colon-delimited. Production paths are
    // absolute Linux paths and must not contain filtergraph metacharacters.
    if (/[:;'"\[\],\\]/.test(text)) {
        throw new TypeError(description + ' contains unsupported filtergraph characters');
    }
    return text;
}

function buildArgs(options) {
    options = options || {};
    const distortedPath = String(options.distortedPath || '').trim();
    const referencePath = String(options.referencePath || '').trim();
    if (!distortedPath || !referencePath) {
        throw new TypeError('pre-FGS CAMBI requires distorted and reference paths');
    }
    const logPath = filterSafePath(options.logPath, 'pre-FGS CAMBI log path');
    const modelPath = filterSafePath(options.modelPath, 'pre-FGS CAMBI model path');
    const pixelFormat = String(options.pixelFormat || 'yuv420p');
    if (pixelFormat !== 'yuv420p') {
        throw new TypeError('pre-FGS CAMBI production contract requires yuv420p');
    }
    const nSubsample = positiveInteger(options.nSubsample, 1, 16);
    const threads = positiveInteger(options.threads, 8, 32);
    const filter = '[0:v]settb=1/1000,setpts=N,format=' + pixelFormat + '[dist];' +
        '[1:v]settb=1/1000,setpts=N,format=' + pixelFormat + '[ref];' +
        '[dist][ref]libvmaf=log_path=' + logPath + ':log_fmt=json' +
        ':model=path=' + modelPath + ':feature=name=cambi' +
        ':n_threads=' + threads + ':n_subsample=' + nSubsample +
        ':shortest=1:repeatlast=0:ts_sync_mode=nearest';
    return [
        '-hide_banner', '-nostats', '-y',
        '-i', distortedPath,
        '-i', referencePath,
        '-filter_complex', filter,
        '-f', 'null', '-',
    ];
}

function parseLogData(data) {
    const frames = data && Array.isArray(data.frames) ? data.frames : [];
    const values = [];
    frames.forEach(function (frame) {
        const value = finiteNumber(frame && frame.metrics && frame.metrics.cambi);
        if (value !== null) values.push(value);
    });
    if (!values.length) throw new Error('CAMBI log contains no finite frame scores');
    values.sort(function (a, b) { return a - b; });
    const pooled = data && data.pooled_metrics && data.pooled_metrics.cambi || {};
    let mean = finiteNumber(pooled.mean);
    let maximum = finiteNumber(pooled.max);
    if (mean === null) mean = values.reduce(function (sum, value) { return sum + value; }, 0) / values.length;
    if (maximum === null) maximum = values[values.length - 1];
    const p95Index = Math.min(values.length - 1,
        Math.max(0, Math.floor(0.95 * (values.length - 1))));
    return {
        cambiMean: mean,
        cambiMax: maximum,
        cambiP95: values[p95Index],
        frameCount: values.length,
    };
}

function parseLogFile(logPath, fsImpl) {
    const fs = fsImpl || require('fs');
    return parseLogData(JSON.parse(fs.readFileSync(logPath, 'utf8')));
}

function aggregateBaselines(measurements) {
    const rows = Array.isArray(measurements) ? measurements : [];
    if (!rows.length) throw new Error('CAMBI source baseline has no measurements');
    const means = rows.map(function (row) { return finiteNumber(row && row.cambiMean); });
    const p95s = rows.map(function (row) { return finiteNumber(row && row.cambiP95); });
    const maxima = rows.map(function (row) { return finiteNumber(row && row.cambiMax); });
    if (means.some(function (value) { return value === null; }) ||
            p95s.some(function (value) { return value === null; }) ||
            maxima.some(function (value) { return value === null; })) {
        throw new Error('CAMBI source baseline contains incomplete measurements');
    }
    return {
        cambiMean: means.reduce(function (sum, value) { return sum + value; }, 0) / means.length,
        cambiP95: Math.max.apply(null, p95s),
        cambiMax: Math.max.apply(null, maxima),
        sampleCount: rows.length,
    };
}

module.exports = {
    POLICY_ID: POLICY_ID,
    buildArgs: buildArgs,
    parseLogData: parseLogData,
    parseLogFile: parseLogFile,
    aggregateBaselines: aggregateBaselines,
};
