"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Calculate VMAF',
    description: 'Calculates VMAF scores for encoded samples comparing against originals. Supports GPU-accelerated VMAF (libvmaf_cuda) for up to 36x faster processing, with parallel CPU fallback.',
    style: {
        borderColor: 'purple',
    },
    tags: 'video,vmaf,quality,gpu',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faChartBar',
    inputs: [
        {
            label: 'Max Parallel VMAF (CPU fallback)',
            name: 'maxParallelVmaf',
            type: 'number',
            defaultValue: '4',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Maximum number of parallel VMAF calculations when using CPU. Set to 1 for sequential processing. GPU VMAF always runs sequentially.',
        },
        {
            label: 'Max Parallel GPU VMAF',
            name: 'maxParallelGpuVmaf',
            type: 'number',
            defaultValue: '2',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Maximum number of GPU VMAF jobs to run concurrently (libvmaf_cuda). Keeps a small cap to avoid VRAM exhaustion. Default: 2',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'VMAF calculation completed',
        },
    ],
}); };
exports.details = details;

// Async wrapper for spawn to enable parallel execution
function runCommand(cmd, args, options) {
    return new Promise(function(resolve, reject) {
        var spawn = require('child_process').spawn;
        var process = spawn(cmd, args, options);
        var stdout = '';
        var stderr = '';
        
        if (process.stdout) {
            process.stdout.on('data', function(data) {
                stdout += data.toString();
            });
        }
        if (process.stderr) {
            process.stderr.on('data', function(data) {
                stderr += data.toString();
            });
        }
        
        process.on('close', function(code) {
            resolve({ code: code, stdout: stdout, stderr: stderr });
        });
        
        process.on('error', function(err) {
            reject(err);
        });
    });
}

// Compute SSIM (CPU, fast on short samples) as a secondary perceptual metric.
// Resolves a 0-100 scaled score, or null on any failure - SSIM is advisory, never fatal.
function runSsimAsync(ffmpegPath, distortedPath, referencePath) {
    return new Promise(function(resolve) {
        try {
            var spawn = require('child_process').spawn;
            // The distorted clip is AV1 and this FFmpeg build has no software AV1 decoder,
            // so decode it with NVDEC (av1_cuvid). The reference (hevc/h264/etc) decodes in
            // software. The ssim filter graph auto-negotiates the common pixel format.
            var fargs = ['-hide_banner',
                '-hwaccel', 'nvdec', '-hwaccel_device', '0', '-c:v', 'av1_cuvid', '-i', distortedPath,
                '-i', referencePath,
                '-filter_complex', '[0:v]settb=1/1000,setpts=N[d];[1:v]settb=1/1000,setpts=N[r];[d][r]ssim',
                '-f', 'null', '-'];
            var child = spawn(ffmpegPath, fargs, { stdio: ['ignore', 'pipe', 'pipe'] });
            var out = '';
            var timer = setTimeout(function() { try { child.kill('SIGKILL'); } catch (e) {} }, 180000);
            if (child.stderr) child.stderr.on('data', function(d) { out += d.toString(); });
            child.on('error', function() { clearTimeout(timer); resolve(null); });
            child.on('close', function(code) {
                clearTimeout(timer);
                if (code !== 0) { resolve(null); return; }
                var all = out.match(/All:\s*([0-9.]+)/g);
                if (!all || all.length === 0) { resolve(null); return; }
                var last = all[all.length - 1].match(/All:\s*([0-9.]+)/);
                var v = last ? parseFloat(last[1]) : NaN;
                resolve(isFinite(v) ? Math.round(v * 10000) / 100 : null);
            });
        } catch (e) {
            resolve(null);
        }
    });
}

// Run a single GPU VMAF job asynchronously (libvmaf_cuda primary method only)
function calculateSingleVmafGpuAsync(args, result, samples, cacheDir, modelPath) {
    return new Promise(function(resolve) {
        var fs = require('fs');
        var execSpawn = require('child_process').spawn;
        
        var originalSample = result.originalSamplePath || samples[result.sampleIndex];
        var logPath = cacheDir + '/vmaf_' + result.parameterSetId + '_s' + (result.sampleIndex + 1) + '.json';
        var distortedEncoder = (result.parameterSet && result.parameterSet.encoder) || args.variables.vmafTargetCodec || '';
        
        function runOnce(useCpuFormatConversion, prevStderr) {
            var cmd = buildGpuVmafCommand(args.ffmpegPath, result.outputPath, originalSample, logPath, modelPath, args.inputFileObj, useCpuFormatConversion, distortedEncoder);
            var start = Date.now();
            var child = execSpawn(cmd, {
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: process.env,
                detached: true
            });
            var stderr = '';
            var timedOut = false;
            var timeoutMs = 300000;
            var timeoutHandle = setTimeout(function() {
                timedOut = true;
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch (killGroupErr) {
                    try { child.kill('SIGKILL'); } catch (killErr) {}
                }
            }, timeoutMs);
            if (child.stderr) child.stderr.on('data', function(d) { stderr += d.toString(); });
            child.on('close', function(code) {
                clearTimeout(timeoutHandle);
                var duration = (Date.now() - start) / 1000;
                if (timedOut) {
                    resolve({ success: false, error: 'GPU VMAF timed out after ' + Math.round(timeoutMs / 1000) + 's: ' + stderr.trim().slice(-2000) });
                    return;
                }
                if (code !== 0) {
                    // If the pure-GPU path fails, retry once with CPU format conversion (hwdownload/format/hwupload_cuda).
                    if (!useCpuFormatConversion) {
                        try {
                            if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
                        } catch (e) {}
                        runOnce(true, stderr);
                        return;
                    }
                    var combined = '';
                    if (prevStderr) combined += prevStderr.trim() + '\n';
                    combined += stderr.trim();
                    resolve({ success: false, error: 'GPU VMAF failed (code ' + code + '): ' + combined.trim() });
                    return;
                }
                var parsed = parseVmafLog(logPath, fs);
                if (!parsed || parsed.vmafScore === null || parsed.vmafScore === undefined) {
                    resolve({ success: false, error: 'GPU VMAF log parse failed for ' + logPath });
                    return;
                }
                runSsimAsync(args.ffmpegPath, result.outputPath, originalSample).then(function(ssimScore) {
                    resolve({
                        success: true,
                        duration: duration,
                        method: useCpuFormatConversion
                            ? 'GPU VMAF (parallel libvmaf_cuda; CPU format conversion)'
                            : 'GPU VMAF (parallel libvmaf_cuda)',
                        result: {
                            parameterSetId: result.parameterSetId,
                            parameterSet: result.parameterSet,
                            sampleIndex: result.sampleIndex,
                            fileSizeMB: result.fileSizeMB,
                            vmafScore: parsed.vmafScore,
                            vmafMean: parsed.vmafMean,
                            vmafHarmonicMean: parsed.vmafHarmonicMean,
                            vmafMin: parsed.vmafMin,
                            vmafMax: parsed.vmafMax,
                            vmafP1: parsed.vmafP1,
                            cambiMean: parsed.cambiMean,
                            cambiMax: parsed.cambiMax,
                            cambiP95: parsed.cambiP95,
                            ssimScore: ssimScore,
                            vmafMethod: useCpuFormatConversion
                                ? 'GPU VMAF (parallel libvmaf_cuda; CPU format conversion)'
                                : 'GPU VMAF (parallel libvmaf_cuda)',
                            vmafModelPath: modelPath || ''
                        }
                    });
                });
            });
        }

        runOnce(false, '');
    });
}

// Check if libvmaf_cuda is actually usable, not just listed in -filters.
// FFmpeg 8.1/libvmaf 3.1 can expose the filter even when runtime CUDA/model loading is broken,
// so run a tiny explicit-model smoke test once per plugin invocation.
function checkGpuVmafSupport(ffmpegPath) {
    var execSync = require('child_process').execSync;
    var fs = require('fs');
    try {
        var env = Object.assign({}, process.env);
        var preferred = '/custom-libvmaf-lib:/usr/local/ffmpeg-custom/lib:/usr/local/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/lib';
        env.LD_LIBRARY_PATH = preferred + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');

        var filters = execSync('"' + ffmpegPath + '" -hide_banner -filters 2>&1', {
            encoding: 'utf8',
            shell: true,
            timeout: 10000,
            env: env,
            maxBuffer: 10 * 1024 * 1024
        });
        if (filters.indexOf('libvmaf_cuda') === -1) return false;

        var modelPath = '/usr/local/share/model/vmaf_v0.6.1.json';
        var modelParam = fs.existsSync(modelPath) ? ':model=path=' + modelPath : '';
        var logPath = '/temp/vmaf_cuda_capability_check_' + process.pid + '.json';
        try { if (fs.existsSync(logPath)) fs.unlinkSync(logPath); } catch (ignore) {}

        var cmd = '"' + ffmpegPath + '" -hide_banner -y -init_hw_device cuda=cuda0:0 -filter_hw_device cuda0 ' +
                    '-f lavfi -i testsrc2=s=128x128:d=0.25:r=8 ' +
                    '-f lavfi -i testsrc2=s=128x128:d=0.25:r=8 ' +
                    '-filter_complex "[0:v]format=yuv420p,hwupload[dist];[1:v]format=yuv420p,hwupload[ref];[dist][ref]libvmaf_cuda=log_fmt=json:log_path=' + logPath + modelParam + '" ' +
                    '-f null -';
        execSync(cmd, {
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            shell: true,
            timeout: 20000,
            env: env,
            maxBuffer: 10 * 1024 * 1024
        });

        if (!fs.existsSync(logPath)) return false;
        var parsed = parseVmafLog(logPath, fs);
        try { fs.unlinkSync(logPath); } catch (ignore2) {}
        return !!(parsed && parsed.vmafScore !== null && parsed.vmafScore !== undefined && !isNaN(parsed.vmafScore));
    } catch (e) {
        return false;
    }
}


// Get the primary video stream, skipping attached pictures, cover images, and other non-primary video.
// Filters out: attached_pic, clean_effects, still_image, very small resolutions (<100px), dependent layers.
function getVideoStream(inputFile) {
    var streams = inputFile && inputFile.ffProbeData && inputFile.ffProbeData.streams;
    if (!Array.isArray(streams)) return null;
    var candidates = [];
    for (var i = 0; i < streams.length; i++) {
        var s = streams[i];
        if (!s || s.codec_type !== 'video') continue;
        // Skip attached pictures (cover images embedded in container)
        if (s.disposition && (s.disposition.attached_pic === 1 || s.disposition.clean_effects === 1)) continue;
        // Skip still images / multilayer (poster frames, cover jpegs)
        if (s.tags && s.tags.filename && /\.(jpg|jpeg|png|gif|bmp)$/i.test(s.tags.filename)) continue;
        if (s.still_image === 1 || s.multilayer === 1) continue;
        // Skip very small resolutions — these are logos/icons, not primary video
        if ((s.width || 0) < 100 || (s.height || 0) < 100) continue;
        // Prefer streams that are not dependent layers
        if (s.disposition && s.disposition.dependent === 1) continue;
        // Prefer default streams, deprioritize non-default
        var priority = 0;
        if (s.disposition) {
            if (s.disposition.default === 1) priority = 2;
            else if (s.disposition.forced === 1) priority = 1;
        }
        candidates.push({ stream: s, priority: priority, index: i });
    }
    if (candidates.length === 0) return null;
    // Sort: highest priority first, then by stream index
    candidates.sort(function(a, b) { return b.priority - a.priority || a.index - b.index; });
    return candidates[0].stream;
}

// Find the exact VMAF model path based on video resolution. Do not silently substitute
// NEG/bootstrap/float model families because their scores are not threshold-equivalent.
function findVmafModel(fs, inputFile) {
    var video = getVideoStream(inputFile);
    var width = video ? (video.width || 0) : 0;
    var height = video ? (video.height || 0) : 0;
    var is4K = width >= 3840 || height >= 2160;
    var requiredModelPaths = is4K ? [
        '/usr/local/share/model/vmaf_4k_v0.6.1.json',
        '/usr/local/share/vmaf/model/vmaf_4k_v0.6.1.json'
    ] : [
        '/usr/local/share/model/vmaf_v0.6.1.json',
        '/usr/local/share/vmaf/model/vmaf_v0.6.1.json'
    ];
    for (var i = 0; i < requiredModelPaths.length; i++) {
        try {
            if (fs.existsSync(requiredModelPaths[i])) return requiredModelPaths[i];
        } catch (e) {}
    }
    return null;
}

// Parse VMAF results from log file
function parseVmafLog(logPath, fs) {
    try {
        var logContent = fs.readFileSync(logPath, 'utf8');
        var jsonData = JSON.parse(logContent);
        
        var result = {
            vmafMean: null,
            vmafHarmonicMean: null,
            vmafMin: null,
            vmafMax: null,
            vmafP1: null,
            vmafScore: null,
            cambiMean: null,
            cambiMax: null,
            cambiP95: null
        };

        // 1%-low from per-frame scores: a far more stable worst-case statistic than the
        // absolute minimum (a single odd frame out of hundreds cannot veto a candidate).
        // CAMBI is Netflix's banding metric: lower is better, ~5 starts to become annoying.
        if (Array.isArray(jsonData.frames) && jsonData.frames.length > 0) {
            var frameScores = [];
            var cambiScores = [];
            for (var fi = 0; fi < jsonData.frames.length; fi++) {
                var fr = jsonData.frames[fi];
                var fv = fr && fr.metrics && fr.metrics.vmaf;
                var cv = fr && fr.metrics && fr.metrics.cambi;
                if (typeof fv === 'number' && isFinite(fv)) frameScores.push(fv);
                if (typeof cv === 'number' && isFinite(cv)) cambiScores.push(cv);
            }
            if (frameScores.length > 0) {
                frameScores.sort(function(a, b) { return a - b; });
                var p1Idx = Math.min(frameScores.length - 1, Math.max(0, Math.floor(0.01 * frameScores.length)));
                result.vmafP1 = frameScores[p1Idx];
            }
            if (cambiScores.length > 0) {
                cambiScores.sort(function(a, b) { return a - b; });
                var c95Idx = Math.min(cambiScores.length - 1, Math.max(0, Math.floor(0.95 * (cambiScores.length - 1))));
                result.cambiP95 = cambiScores[c95Idx];
            }
        }
        
        // Extract all VMAF metrics from pooled_metrics (preferred format)
        if (jsonData.pooled_metrics && jsonData.pooled_metrics.vmaf) {
            var vmafMetrics = jsonData.pooled_metrics.vmaf;
            if (vmafMetrics.mean !== undefined) result.vmafMean = parseFloat(vmafMetrics.mean);
            if (vmafMetrics.harmonic_mean !== undefined) result.vmafHarmonicMean = parseFloat(vmafMetrics.harmonic_mean);
            if (vmafMetrics.min !== undefined) result.vmafMin = parseFloat(vmafMetrics.min);
            if (vmafMetrics.max !== undefined) result.vmafMax = parseFloat(vmafMetrics.max);
            if (jsonData.pooled_metrics.cambi) {
                var cambiMetrics = jsonData.pooled_metrics.cambi;
                if (cambiMetrics.mean !== undefined) result.cambiMean = parseFloat(cambiMetrics.mean);
                if (cambiMetrics.max !== undefined) result.cambiMax = parseFloat(cambiMetrics.max);
            }
        }
        // Try aggregate_metrics.vmaf (alternative format)
        else if (jsonData.aggregate_metrics && jsonData.aggregate_metrics.vmaf !== undefined) {
            result.vmafMean = parseFloat(jsonData.aggregate_metrics.vmaf);
        }
        // Try VMAF score from FFmpeg console output (older format)
        else {
            var scoreMatch = logContent.match(/"VMAF score":\s*([\d.]+)/);
            if (scoreMatch && scoreMatch[1]) {
                result.vmafMean = parseFloat(scoreMatch[1]);
            }
        }
        
        // Use harmonic mean as primary score (Netflix best practice)
        result.vmafScore = result.vmafHarmonicMean !== null ? result.vmafHarmonicMean : result.vmafMean;
        
        return result;
    } catch (e) {
        return null;
    }
}

// Build GPU VMAF command (libvmaf_cuda) using scale_cuda for format conversion.
// HDR/PQ content is requantized to 8-bit (format=yuv420p) for libvmaf_cuda but NOT tonemapped:
// the 8-bit requirement is the GPU's, tonemapping is a separate step that bands gradients (false
// CAMBI) and measures an SDR rendition the pipeline never produces (the transcode stays 10-bit HDR).
function buildGpuVmafCommand(ffmpegPath, distortedPath, referencePath, logPath, modelPath, inputFileObj, useCpuFormatConversion, distortedEncoder) {
    function mapEncoderToCuvid(enc) {
        var lc = String(enc || '').toLowerCase();
        if (lc.indexOf('av1') !== -1) return 'av1_cuvid';
        if (lc.indexOf('265') !== -1 || lc.indexOf('hevc') !== -1 || lc.indexOf('h265') !== -1) return 'hevc_cuvid';
        if (lc.indexOf('264') !== -1 || lc.indexOf('avc') !== -1) return 'h264_cuvid';
        if (lc.indexOf('vp9') !== -1) return 'vp9_cuvid';
        if (lc.indexOf('vp8') !== -1) return 'vp8_cuvid';
        if (lc.indexOf('mpeg2') !== -1) return 'mpeg2_cuvid';
        if (lc.indexOf('mpeg4') !== -1) return 'mpeg4_cuvid';
        return null;
    }
    
    // libvmaf_cuda requires CUDA frames
    // According to FFmpeg docs, we need to:
    // 1. Initialize CUDA device explicitly for filters
    // 2. Decode both files with CUDA (use appropriate CUVID decoder) and keep in CUDA format
    // 3. Scale/convert both to yuv420p (8-bit) using scale_cuda (pure GPU) or CPU format conversion (fallback)
    // 4. Pass to libvmaf_cuda
    // IMPORTANT: libvmaf_cuda only supports yuv420p (8-bit) format, regardless of source HDR/SDR status
    // The actual encoding can use 10-bit (p010le) for HDR, but VMAF calculation must use 8-bit
    var modelParam = modelPath ? ':model=path=' + modelPath : '';
    var cambiFeatureParam = ':feature=name=cambi';
    useCpuFormatConversion = useCpuFormatConversion === true; // Default to false (use scale_cuda)
    
    // Always use yuv420p for GPU VMAF calculations (libvmaf_cuda limitation)
    // Note: This is different from encoding format - encoding can use p010le for HDR content
    var targetFormat = 'yuv420p';
    
    // Detect reference file codec from input file (reference is original sample, same codec)
    var referenceCodec = 'h264'; // default fallback
    var referenceCuvid = 'h264_cuvid'; // default fallback
    var referenceStream = getVideoStream(inputFileObj);
    if (referenceStream) {
        referenceCodec = referenceStream.codec_name || 'h264';
        // Map codec to CUVID decoder
        switch (referenceCodec.toLowerCase()) {
            case 'h264':
                referenceCuvid = 'h264_cuvid';
                break;
            case 'hevc':
            case 'h265':
                referenceCuvid = 'hevc_cuvid';
                break;
            case 'av1':
                referenceCuvid = 'av1_cuvid';
                break;
            case 'vp8':
                referenceCuvid = 'vp8_cuvid';
                break;
            case 'vp9':
                referenceCuvid = 'vp9_cuvid';
                break;
            case 'vc1':
                referenceCuvid = 'vc1_cuvid';
                break;
            case 'mpeg2video':
            case 'mpeg2':
                referenceCuvid = 'mpeg2_cuvid';
                break;
            case 'mpeg4':
                referenceCuvid = 'mpeg4_cuvid';
                break;
            default:
                // Unsupported codec, will fall back to software decode + hwupload
                referenceCuvid = null;
                break;
        }
    }
    
    // Build command - both inputs use CUVID decode to keep everything in GPU memory
    // Initialize CUDA device with explicit name for filter use
    var distortedCuvid = mapEncoderToCuvid(distortedEncoder);
    var cmdParts = [
        '"' + ffmpegPath + '"',
        '-init_hw_device', 'cuda=cuda0:0',
        '-filter_hw_device', 'cuda0',
        '-hwaccel', 'cuda',
        '-hwaccel_device', '0'
    ];
    
    // cuvid decodes to system memory (NO -hwaccel_output_format cuda). scale_cuda is
    // compute_90-only in this build and crashes on Blackwell (sm_120), so format
    // conversion is done on CPU (format=yuv420p) then re-uploaded with generic hwupload.
    if (distortedCuvid) {
        cmdParts.push('-c:v', distortedCuvid);
    }
    cmdParts.push('-i', '"' + distortedPath + '"');
    
    // Add reference file input with CUVID decoder if supported.
        // This keeps both streams in GPU memory from decode to VMAF calculation.
        // Do NOT tonemap. libvmaf_cuda needs 8-bit (yuv420p) — `format=yuv420p` already provides that;
        // the 8-bit requirement does NOT need a tonemap. tonemap=hable on the PQ signal (no
        // zscale=linear) bands smooth gradients, which CAMBI then reports as false banding, and it
        // measures a tonemapped-SDR rendition that never exists in the pipeline (the final transcode
        // stays 10-bit HDR). Measuring the PQ signal requantized to 8-bit is a faithful (slightly
        // conservative) proxy for the 10-bit output's banding. Native 10-bit VMAF is CPU-only here.
        var tonemapRef = '';
        if (referenceCuvid) {
            cmdParts.push('-hwaccel', 'cuda');
            cmdParts.push('-hwaccel_device', '0');
            cmdParts.push('-c:v', referenceCuvid);
            cmdParts.push('-i', '"' + referencePath + '"');
            // cuvid decodes to system memory; CPU tonemap (HDR) + format=yuv420p makes both
            // streams identical 8-bit, then generic hwupload puts them on the CUDA device for
            // libvmaf_cuda. (hwdownload cannot target yuv420p directly from an nv12/p010 surface.)
            cmdParts.push('-filter_complex', '"[0:v]settb=1/1000,setpts=N' + tonemapRef + ',format=' + targetFormat + ',hwupload[dis];[1:v]settb=1/1000,setpts=N' + tonemapRef + ',format=' + targetFormat + ',hwupload[ref];[dis][ref]libvmaf_cuda=log_path=' + logPath + ':log_fmt=json' + modelParam + cambiFeatureParam + ':shortest=1:repeatlast=0:ts_sync_mode=nearest"');
                    } else {
                                // Reference codec not supported by CUVID; decode in software then upload to GPU.
                                cmdParts.push('-i', '"' + referencePath + '"');
                                cmdParts.push('-filter_complex', '"[0:v]settb=1/1000,setpts=N' + tonemapRef + ',format=' + targetFormat + ',hwupload[dis];[1:v]settb=1/1000,setpts=N' + tonemapRef + ',format=' + targetFormat + ',hwupload[ref];[dis][ref]libvmaf_cuda=log_path=' + logPath + ':log_fmt=json' + modelParam + cambiFeatureParam + ':shortest=1:repeatlast=0:ts_sync_mode=nearest"');
                            }

        cmdParts.push('-f', 'null', '-');
        return cmdParts.join(' ');
}

function buildCpuVmafCommand(ffmpegPath, distortedPath, referencePath, logPath, modelPath, inputFileObj, useGpuDecode) {
    var modelParam = modelPath ? ':model=path=' + modelPath : '';
    var cambiFeatureParam = ':feature=name=cambi';

    // Prefer 10-bit VMAF when the source is 10-bit to avoid forced 8-bit downconversion.
    // Default to yuv420p for widest compatibility.
    var targetFormat = 'yuv420p';
    try {
        var s0 = getVideoStream(inputFileObj);
        var pixFmt = s0 && s0.pix_fmt ? String(s0.pix_fmt) : '';
        var bits = s0 && (s0.bits_per_raw_sample || s0.bits_per_sample) ? parseInt(s0.bits_per_raw_sample || s0.bits_per_sample, 10) : 0;
        if (pixFmt.indexOf('10') !== -1 || pixFmt.indexOf('p010') !== -1 || (bits && bits >= 10)) {
            targetFormat = 'yuv420p10le';
        }
    } catch (e) {
        // Ignore detection errors; keep default.
    }
    
    if (useGpuDecode) {
        // Use GPU for decoding AV1, but CPU for VMAF analysis
        return [
            '"' + ffmpegPath + '"',
            '-hwaccel', 'nvdec',
            '-hwaccel_device', '0',
            '-c:v', 'av1_cuvid',
            '-i', '"' + distortedPath + '"',
            '-hwaccel', 'none',
            '-i', '"' + referencePath + '"',
            '-filter_complex', '"[0:v]settb=1/1000,setpts=N' + ',format=' + targetFormat + '[decoded];[1:v]settb=1/1000,setpts=N' + ',format=' + targetFormat + '[ref];[decoded][ref]libvmaf=log_path=' + logPath + ':log_fmt=json' + modelParam + cambiFeatureParam + ':shortest=1:repeatlast=0:ts_sync_mode=nearest"',
            '-f', 'null',
            '-'
        ].join(' ');
    } else {
        // Pure software decoding and VMAF
        return [
            '"' + ffmpegPath + '"',
            '-i', '"' + distortedPath + '"',
            '-i', '"' + referencePath + '"',
            '-filter_complex', '"[0:v]settb=1/1000,setpts=N' + ',format=' + targetFormat + '[decoded];[1:v]settb=1/1000,setpts=N' + ',format=' + targetFormat + '[ref];[decoded][ref]libvmaf=log_path=' + logPath + ':log_fmt=json' + modelParam + cambiFeatureParam + ':shortest=1:repeatlast=0:ts_sync_mode=nearest"',
            '-f', 'null',
            '-'
        ].join(' ');
    }
}

// Execute single VMAF calculation with fallback methods
function calculateSingleVmaf(args, result, samples, cacheDir, modelPath, hasGpuVmaf, jobLog) {
    var fs = require('fs');
    var execSync = require('child_process').execSync;
    
    var originalSample = result.originalSamplePath || samples[result.sampleIndex];
    var logPath = cacheDir + '/vmaf_' + result.parameterSetId + '_s' + (result.sampleIndex + 1) + '.json';
    var distortedEncoder = (result.parameterSet && result.parameterSet.encoder) || args.variables.vmafTargetCodec || '';
    
    var methods = [];
    
    // Method 1: GPU VMAF (libvmaf_cuda) with scale_cuda - fastest, up to 36x speedup
    // Pure GPU pipeline: CUVID decode → scale_cuda → libvmaf_cuda (no CPU conversion)
    if (hasGpuVmaf) {
        methods.push({
            name: 'GPU VMAF (libvmaf_cuda with scale_cuda)',
            cmd: buildGpuVmafCommand(args.ffmpegPath, result.outputPath, originalSample, logPath, modelPath, args.inputFileObj, false, distortedEncoder),
            expectedTime: '2-5 seconds',
            isGpuVmaf: true
        });
        // Method 1b: GPU VMAF with CPU format conversion (fallback if scale_cuda fails)
        // GPU decode → CPU format conversion → GPU VMAF
        // This may work in cases where scale_cuda has issues
        methods.push({
            name: 'GPU VMAF (libvmaf_cuda with CPU format conversion)',
            cmd: buildGpuVmafCommand(args.ffmpegPath, result.outputPath, originalSample, logPath, modelPath, args.inputFileObj, true, distortedEncoder),
            expectedTime: '3-7 seconds',
            isGpuVmaf: true,
            isFallback: true
        });
    } else {
        // Log error if GPU VMAF was expected but not available
        console.error('[VMAF Plugin] ERROR: GPU VMAF (libvmaf_cuda) not available - falling back to CPU methods');
    }
    
    // Method 2: GPU decode + CPU VMAF
    methods.push({
        name: 'GPU decode + CPU VMAF',
        cmd: buildCpuVmafCommand(args.ffmpegPath, result.outputPath, originalSample, logPath, modelPath, args.inputFileObj, true),
        expectedTime: '30-90 seconds'
    });
    
    // Method 3: Pure software (fallback)
    methods.push({
        name: 'Software VMAF',
        cmd: buildCpuVmafCommand(args.ffmpegPath, result.outputPath, originalSample, logPath, modelPath, args.inputFileObj, false),
        expectedTime: '60-120 seconds'
    });
    
    var success = false;
    var usedMethod = null;
    var duration = 0;
    
    for (var m = 0; m < methods.length && !success; m++) {
        var method = methods[m];
        jobLog('  [VMAF] Trying: ' + method.name + ' (expected: ' + method.expectedTime + ')');
        
        try {
            var startTime = Date.now();
            execSync(method.cmd, { 
                stdio: ['ignore', 'pipe', 'pipe'], 
                encoding: 'utf8', 
                maxBuffer: 10 * 1024 * 1024, 
                shell: true,
                timeout: 300000 // 5 minute timeout
            });
            duration = (Date.now() - startTime) / 1000;
            success = true;
            usedMethod = method.name;
            jobLog('  [VMAF] Success: ' + method.name + ' completed in ' + duration.toFixed(1) + 's');
            
            // Log error to Docker logs if using CPU VMAF instead of GPU
            if (method.name.indexOf('CPU VMAF') !== -1 || method.name.indexOf('Software VMAF') !== -1) {
                console.error('[VMAF Plugin] WARNING: Using CPU VMAF method: ' + method.name + ' (took ' + duration.toFixed(1) + 's)');
                console.error('[VMAF Plugin] This is much slower than GPU VMAF (libvmaf_cuda). Check GPU VMAF availability.');
            }
        } catch (err) {
            // Capture both stdout and stderr for better error reporting
            var stdout = err.stdout ? err.stdout.toString() : '';
            var stderr = err.stderr ? err.stderr.toString() : '';
            var errorMsg = stderr || stdout || err.message;
            
            // Extract meaningful error (skip version info and configuration)
            // FFmpeg outputs version info first, then the actual error
            var allLines = errorMsg.split('\n');
            var skipPatterns = [
                'ffmpeg version',
                'Copyright',
                'built with',
                'configuration:',
                'libavutil',
                'libavcodec',
                'libavformat',
                'libavdevice',
                'libavfilter',
                'libswscale',
                'libswresample',
                'libpostproc',
                'Hyper fast',
                'In',
                '^$' // empty lines
            ];
            
            // Filter out version/config lines and find actual error
            var errorLines = allLines.filter(function(line) {
                var trimmed = line.trim();
                if (trimmed.length === 0) return false;
                
                // Skip version/config lines
                for (var p = 0; p < skipPatterns.length; p++) {
                    if (trimmed.indexOf(skipPatterns[p]) !== -1) {
                        return false;
                    }
                }
                return true;
            });
            
            // If no filtered lines, try to get the last few lines (where errors usually are)
            if (errorLines.length === 0) {
                // Get last 10 non-empty lines that aren't version info
                var lastLines = [];
                for (var i = allLines.length - 1; i >= 0 && lastLines.length < 10; i--) {
                    var line = allLines[i].trim();
                    if (line.length > 0) {
                        var isVersionLine = false;
                        for (var p2 = 0; p2 < skipPatterns.length; p2++) {
                            if (line.indexOf(skipPatterns[p2]) !== -1) {
                                isVersionLine = true;
                                break;
                            }
                        }
                        if (!isVersionLine) {
                            lastLines.unshift(line);
                        }
                    }
                }
                errorLines = lastLines;
            }
            
            // Also look for common error patterns
            var errorPatterns = ['Error', 'Invalid', 'Unknown', 'failed', 'not found', 'cannot', "can't", 'No such'];
            var foundErrorLine = null;
            for (var e = 0; e < allLines.length; e++) {
                var line = allLines[e].trim();
                for (var ep = 0; ep < errorPatterns.length; ep++) {
                    if (line.toLowerCase().indexOf(errorPatterns[ep].toLowerCase()) !== -1) {
                        foundErrorLine = line;
                        break;
                    }
                }
                if (foundErrorLine) break;
            }
            
            var meaningfulError = '';
            var isPtxError = false;
            var isScaleCudaError = false;
            
            // Check for scale_cuda PTX version errors (for logging/debugging)
            // Tested error pattern: "cuModuleLoadData(cu_module, data) failed -> CUDA_ERROR_UNSUPPORTED_PTX_VERSION: the provided PTX was compiled with an unsupported toolchain."
            if (errorMsg.indexOf('CUDA_ERROR_UNSUPPORTED_PTX_VERSION') !== -1 || 
                errorMsg.indexOf('unsupported PTX version') !== -1 ||
                (errorMsg.indexOf('PTX version') !== -1 && errorMsg.indexOf('unsupported') !== -1) ||
                (errorMsg.indexOf('cuModuleLoadData') !== -1 && errorMsg.indexOf('failed') !== -1 && errorMsg.indexOf('PTX') !== -1) ||
                (errorMsg.indexOf('unsupported toolchain') !== -1 && errorMsg.indexOf('PTX') !== -1)) {
                isPtxError = true;
                isScaleCudaError = true;
                meaningfulError = 'scale_cuda PTX version error: CUDA filter scale_cuda failed. FFmpeg may need to be rebuilt with compute_120 support for RTX 50 series GPUs.';
                console.error('[VMAF Plugin] CRITICAL: scale_cuda failed with PTX version error');
                console.error('[VMAF Plugin] Error: CUDA_ERROR_UNSUPPORTED_PTX_VERSION - GPU VMAF will fall back to CPU VMAF.');
            }
            // Check for scale_cuda format conversion errors
            else if (errorMsg.indexOf('Impossible to convert between') !== -1 && 
                     errorMsg.indexOf('scale_cuda') !== -1) {
                isScaleCudaError = true;
                meaningfulError = 'scale_cuda format conversion error: The CUDA scaling filter cannot convert between the required formats.';
                console.error('[VMAF Plugin] ERROR: scale_cuda format conversion failed');
                // This will trigger fallback to CPU format conversion method
            }
            // Check for other scale_cuda filter errors (any error involving scale_cuda)
            else if (errorMsg.indexOf('scale_cuda') !== -1 && (
                errorMsg.indexOf('Error') !== -1 || 
                errorMsg.indexOf('failed') !== -1 ||
                errorMsg.indexOf('Invalid') !== -1 ||
                errorMsg.indexOf('reinitializing filters') !== -1)) {
                isScaleCudaError = true;
                meaningfulError = 'scale_cuda filter error: The CUDA scaling filter failed to initialize or execute.';
                console.error('[VMAF Plugin] ERROR: scale_cuda filter failed');
            }
            // Check for libvmaf_cuda assertion error (compute capability mismatch)
            else if (errorMsg.indexOf('init_fex_cuda') !== -1 || errorMsg.indexOf('Assertion') !== -1) {
                meaningfulError = 'libvmaf_cuda assertion error: GPU compute capability mismatch. FFmpeg was built for compute 8.9 but GPU is compute 12.0. libvmaf_cuda may not be compatible.';
                console.error('[VMAF Plugin] CRITICAL: libvmaf_cuda is crashing due to compute capability mismatch');
                console.error('[VMAF Plugin] FFmpeg was built for compute 8.9, but GPU is compute 12.0');
                console.error('[VMAF Plugin] This is a known compatibility issue. Falling back to CPU VMAF.');
            } else if (foundErrorLine) {
                meaningfulError = foundErrorLine;
            } else if (errorLines.length > 0) {
                meaningfulError = errorLines.join('; ');
            } else {
                meaningfulError = errorMsg.substring(0, 500);
            }
            
            // Store error type for fallback logic
            method.ptxError = isPtxError;
            method.scaleCudaError = isScaleCudaError;
            
            jobLog('  [VMAF] Failed: ' + method.name + ' - ' + meaningfulError.substring(0, 200));
            
            // Log error to Docker logs if GPU VMAF fails
            if (method.name.indexOf('GPU VMAF') !== -1 || method.name.indexOf('libvmaf_cuda') !== -1) {
                if (isScaleCudaError) {
                    console.error('[VMAF Plugin] ERROR: scale_cuda filter failed');
                    console.error('[VMAF Plugin] GPU VMAF pipeline failed. Will fall back to CPU VMAF methods.');
                    jobLog('  [VMAF] scale_cuda error detected - will try CPU VMAF fallback');
                } else {
                    console.error('[VMAF Plugin] ERROR: GPU VMAF method failed, trying next method');
                }
                console.error('[VMAF Plugin] Command: ' + method.cmd.substring(0, 200));
                console.error('[VMAF Plugin] Full stderr (last 2000 chars):');
                if (stderr) {
                    var stderrTail = stderr.length > 2000 ? stderr.substring(stderr.length - 2000) : stderr;
                    console.error(stderrTail);
                }
                if (stdout) {
                    var stdoutTail = stdout.length > 2000 ? stdout.substring(stdout.length - 2000) : stdout;
                    console.error('[VMAF Plugin] Full stdout (last 2000 chars):');
                    console.error(stdoutTail);
                }
                console.error('[VMAF Plugin] Extracted error: ' + meaningfulError.substring(0, 1000));
            }
        }
    }
    
    if (!success) {
        return {
            success: false,
            result: result,
            error: 'All VMAF methods failed'
        };
    }
    
    // Parse results
    var vmafData = parseVmafLog(logPath, fs);
    if (!vmafData || vmafData.vmafScore === null || isNaN(vmafData.vmafScore)) {
        return {
            success: false,
            result: result,
            error: 'Failed to parse VMAF score from log'
        };
    }
    
    return {
        success: true,
        result: Object.assign({}, result, {
            vmafScore: vmafData.vmafScore,
            vmafMean: vmafData.vmafMean,
            vmafHarmonicMean: vmafData.vmafHarmonicMean,
            vmafMin: vmafData.vmafMin,
            vmafMax: vmafData.vmafMax,
            vmafP1: vmafData.vmafP1,
            cambiMean: vmafData.cambiMean,
            cambiMax: vmafData.cambiMax,
            cambiP95: vmafData.cambiP95,
            vmafMethod: usedMethod || '',
            vmafModelPath: modelPath || ''
        }),
        method: usedMethod,
        duration: duration
    };
}

// Async version for parallel execution
function calculateSingleVmafAsync(args, result, samples, cacheDir, modelPath, hasGpuVmaf) {
    return new Promise(function(resolve) {
        var fs = require('fs');
        var originalSample = result.originalSamplePath || samples[result.sampleIndex];
        var logPath = cacheDir + '/vmaf_' + result.parameterSetId + '_s' + (result.sampleIndex + 1) + '.json';
        
        var methods = [];
        
        // For parallel CPU execution, skip GPU VMAF (it's better to run sequentially)
        // Method 1: GPU decode + CPU VMAF
        methods.push({
            name: 'GPU decode + CPU VMAF',
            cmd: buildCpuVmafCommand(args.ffmpegPath, result.outputPath, originalSample, logPath, modelPath, args.inputFileObj, true)
        });
        
        // Method 2: Pure software (fallback)
        methods.push({
            name: 'Software VMAF',
            cmd: buildCpuVmafCommand(args.ffmpegPath, result.outputPath, originalSample, logPath, modelPath, args.inputFileObj, false)
        });
        
        function tryMethod(methodIndex) {
            if (methodIndex >= methods.length) {
                resolve({
                    success: false,
                    result: result,
                    error: 'All VMAF methods failed'
                });
                return;
            }
            
            var method = methods[methodIndex];
            var startTime = Date.now();
            
            runCommand('bash', ['-c', method.cmd], { 
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 300000
            }).then(function(cmdResult) {
                var duration = (Date.now() - startTime) / 1000;
                
                if (cmdResult.code === 0) {
                    var vmafData = parseVmafLog(logPath, fs);
                    if (vmafData && vmafData.vmafScore !== null && !isNaN(vmafData.vmafScore)) {
                        runSsimAsync(args.ffmpegPath, result.outputPath, originalSample, logPath, args.inputFileObj).then(function(ssimScore) {
                            resolve({
                                success: true,
                                result: Object.assign({}, result, {
                                    vmafScore: vmafData.vmafScore,
                                    vmafMean: vmafData.vmafMean,
                                    vmafHarmonicMean: vmafData.vmafHarmonicMean,
                                    vmafMin: vmafData.vmafMin,
                                    vmafMax: vmafData.vmafMax,
                                    vmafP1: vmafData.vmafP1,
                                    cambiMean: vmafData.cambiMean,
                                    cambiMax: vmafData.cambiMax,
                                    cambiP95: vmafData.cambiP95,
                                    vmafMethod: method.name || '',
                                    vmafModelPath: modelPath || '',
                                    ssimScore: ssimScore
                                }),
                                method: method.name,
                                duration: duration
                            });
                        });
                        return;
                    }
                }
                // Try next method
                tryMethod(methodIndex + 1);
            }).catch(function() {
                tryMethod(methodIndex + 1);
            });
        }
        
        tryMethod(0);
    });
}

// Process results in batches for parallel execution
function processBatch(batch, args, samples, cacheDir, modelPath, hasGpuVmaf) {
    var promises = batch.map(function(result) {
        return calculateSingleVmafAsync(args, result, samples, cacheDir, modelPath, hasGpuVmaf);
    });
    return Promise.all(promises);
}

var plugin = async function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    var fs = require('fs');
    var execSync = require('child_process').execSync;
    
    var maxParallel = parseInt(args.inputs.maxParallelVmaf) || 4;
    var maxParallelGpu = parseInt(args.inputs.maxParallelGpuVmaf) || 2;
    if (maxParallelGpu < 1) maxParallelGpu = 1;
    if (maxParallelGpu > 6) maxParallelGpu = 6;
    var testResults = args.variables.vmafTestResults || [];
    var samples = args.variables.vmafSamples || [];
    
    if (testResults.length === 0) {
        var errorMsg = 'VMAF calculation failed: No test results found. Run Test Encoding Parameters first.';
        args.jobLog('Error: ' + errorMsg);
        throw new Error(errorMsg);
    }
    
    var cacheDir = args.workDir || '/temp';
    
    // Check for GPU VMAF support (libvmaf_cuda)
    args.jobLog('=== VMAF Capability Detection ===');
    args.jobLog('Using FFmpeg: ' + args.ffmpegPath);
    
    var hasGpuVmaf = checkGpuVmafSupport(args.ffmpegPath);
    if (hasGpuVmaf) {
        args.jobLog('GPU VMAF (libvmaf_cuda): available');
    } else {
        args.jobLog('GPU VMAF (libvmaf_cuda): not available, using CPU VMAF');
    }
    
    var requireGpuVmaf = args.variables.vmafRequireGpuVmaf === true;
    args.variables.vmafGpuVmafAvailable = hasGpuVmaf;
    args.variables.vmafGpuVmafRequired = requireGpuVmaf;
    args.variables.vmafGpuVmafFallbackUsed = false;
    if (requireGpuVmaf && !hasGpuVmaf) {
        var gpuRequiredMsg = 'GPU VMAF is required for this flow but libvmaf_cuda is not usable with the configured FFmpeg/model path.';
        args.jobLog('ERROR: ' + gpuRequiredMsg);
        throw new Error(gpuRequiredMsg);
    }
    if (args.variables.isHDR) {
        args.variables.vmafHdrPolicy = 'HDR/PQ content is requantized to 8-bit (format=yuv420p) for libvmaf_cuda WITHOUT tonemapping. No tonemap = no false gradient banding, and the measured signal matches the 10-bit HDR transcode (just fewer bits), so VMAF/CAMBI track the real output. Native 10-bit VMAF is CPU-only in this stack.';
        args.jobLog('HDR VMAF policy: using the resolution-specific standard VMAF model on libvmaf_cuda. Native HDR VMAF is not available in this stack; scores are a consistent proxy, not a dynamic-HDR preservation guarantee.');
    }
    
    // Find VMAF model based on resolution
    var modelPath = findVmafModel(fs, args.inputFileObj);
    if (modelPath) {
        args.variables.vmafModelPath = modelPath;
        try {
            var pathModule = require('path');
            args.variables.vmafModelName = pathModule.basename(modelPath);
        } catch (modelNameErr) {
            args.variables.vmafModelName = modelPath;
        }
        try {
            var versionOutput = execSync('"' + args.ffmpegPath + '" -hide_banner -version 2>&1', { encoding: 'utf8', shell: true, timeout: 10000, maxBuffer: 1024 * 1024 });
            args.variables.vmafFfmpegVersion = (versionOutput.split('\n')[0] || '').trim();
        } catch (versionErr) {
            args.variables.vmafFfmpegVersion = '';
        }
        args.variables.vmafLibvmafVersion = 'libvmaf.so.3 (runtime path via /custom-libvmaf-lib; upgraded stack v3.1.0)';
        // Determine resolution for logging
        var width = 0;
        var height = 0;
        var is4K = false;
        var videoStreamForModel = getVideoStream(args.inputFileObj);
        if (videoStreamForModel) {
            width = videoStreamForModel.width || 0;
            height = videoStreamForModel.height || 0;
            is4K = width >= 3840 || height >= 2160;
        }
        
        var modelType = modelPath.indexOf('vmaf_4k') !== -1 ? '4K optimized' : 'Standard (1080p)';
        args.jobLog('Using VMAF model: ' + modelPath);
        args.jobLog('  Model type: ' + modelType + ' for resolution ' + width + 'x' + height);
        
        // Log warning if wrong model type is being used
        if (is4K && modelPath.indexOf('vmaf_4k') === -1) {
            console.error('[VMAF Plugin] WARNING: 4K content detected but using standard VMAF model. Results may be less accurate.');
            args.jobLog('  ⚠️  WARNING: 4K content detected but using standard model - consider using vmaf_4k_v0.6.1.json');
        } else if (!is4K && modelPath.indexOf('vmaf_4k') !== -1) {
            args.jobLog('  ℹ️  Using 4K model for non-4K content (acceptable but not optimal)');
        }
    } else {
        var videoForMissingModel = getVideoStream(args.inputFileObj);
        var missingW = videoForMissingModel ? (videoForMissingModel.width || 0) : 0;
        var missingH = videoForMissingModel ? (videoForMissingModel.height || 0) : 0;
        var missingModelName = (missingW >= 3840 || missingH >= 2160) ? 'vmaf_4k_v0.6.1.json' : 'vmaf_v0.6.1.json';
        var missingMsg = 'Required explicit VMAF model not found: ' + missingModelName + ' for ' + missingW + 'x' + missingH + '. Refusing to fall back to non-equivalent built-in/NEG/bootstrap models.';
        args.variables.vmafModelPath = '';
        args.variables.vmafModelName = 'missing_' + missingModelName;
        args.jobLog('ERROR: ' + missingMsg);
        throw new Error(missingMsg);
    }
    
    // Filter valid test results
    var validResults = [];
    var skippedResults = [];
    
    for (var i = 0; i < testResults.length; i++) {
        var result = testResults[i];
        var skipReason = null;
        
        if (!result || !result.outputPath) {
            skipReason = 'missing outputPath';
        } else if (result.sampleIndex === undefined || result.sampleIndex === null) {
            skipReason = 'missing sampleIndex';
        } else if (result.sampleIndex < 0 || result.sampleIndex >= samples.length) {
            skipReason = 'invalid sampleIndex ' + result.sampleIndex;
        } else {
            var originalSample = result.originalSamplePath || samples[result.sampleIndex];
            if (!originalSample) {
                skipReason = 'missing original sample';
            }
        }
        
        if (skipReason) {
            skippedResults.push({ result: result, reason: skipReason });
        } else {
            validResults.push(result);
        }
    }
    
    if (skippedResults.length > 0) {
        args.jobLog('Skipped ' + skippedResults.length + ' invalid results');
    }
    
    args.jobLog('');
    args.jobLog('=== Starting VMAF Calculations ===');
    args.jobLog('Total samples to process: ' + validResults.length);
    
    if (args.updateWorker) {
        args.updateWorker({ percentage: 0 });
    }
    
    var vmafResults = [];
    var successfulCalculations = 0;
    var failedCalculations = 0;
    var gpuVmafActuallyUsed = false; // Track if GPU VMAF was actually used (not just available)
    var completedCount = 0;
    var cpuFallbackQueue = [];
    var stopGpuFastPath = false;

    // ── Per-file SEQUENTIAL sampling (per-CQ early stop) ──
    // Stop measuring a parameter set's clips once THIS FILE's own per-clip VMAF spread makes the
    // mean precise enough (CI half-width <= seqTol) AND its worst clip clears the 1%-low floor with
    // margin (so we never under-sample a binding floor). Uses the real per-file sigma instead of the
    // conservative between-content historical sigma, so low-variance content stops early and saves
    // the (CQ x clip) VMAF measurements that dominate sweep cost. Fully guarded: any issue -> measure
    // every clip. Kill switch: args.variables.vmafSequentialSampling === false.
    var seqEnabled = (args.variables.vmafSequentialSampling !== false) && validResults.length > 0;
    var seqTol = Number(args.variables.vmafSampleStopTol); if (!isFinite(seqTol) || seqTol <= 0) seqTol = 0.5;
    var seqMinClips = Math.max(4, Math.min(Number(args.variables.vmafSampleStopMin) || 6, samples.length || 6));
    var seqMaxClips = samples.length || seqMinClips;
    var seqFrameFloor = Number(args.variables.vmafMinFrameVMAF); if (!isFinite(seqFrameFloor)) seqFrameFloor = 0;
    var seqFloorMargin = 2.0;
    var psSeqScores = {}, psSeqMins = {}, psSeqDone = {}, seqSkipped = 0;
    if (seqEnabled) {
        // RANDOMISE the clip measurement order (one shared permutation across all paramsets, so each
        // CQ is still compared on identical clips), then process breadth-first. This removes the
        // POSITIONAL bias an early stop would otherwise have: the first clips measured become a random
        // sample across the whole title, not the opening minutes (often easier than the climax), so
        // the per-file sigma / mean / 1%-low the stop relies on are unbiased estimates of the title.
        var _nSamp = samples.length || 0;
        var _perm = []; for (var _pi = 0; _pi < _nSamp; _pi++) _perm.push(_pi);
        for (var _pj = _nSamp - 1; _pj > 0; _pj--) { var _pk = Math.floor(Math.random() * (_pj + 1)); var _pt = _perm[_pj]; _perm[_pj] = _perm[_pk]; _perm[_pk] = _pt; }
        var _rank = {}; for (var _ri = 0; _ri < _perm.length; _ri++) _rank[_perm[_ri]] = _ri;
        validResults.sort(function (a, b) {
            var ra = (_rank[a.sampleIndex] != null ? _rank[a.sampleIndex] : a.sampleIndex);
            var rb = (_rank[b.sampleIndex] != null ? _rank[b.sampleIndex] : b.sampleIndex);
            if (ra !== rb) return ra - rb;
            return String(a.parameterSetId).localeCompare(String(b.parameterSetId));
        });
        args.jobLog('Sequential sampling ON (randomised clip order): stop a CQ at >=' + seqMinClips + ' clips when decision is confident (90% CI clear of target ± ' + seqTol.toFixed(2) + ') AND 1%-low>=floor+' + seqFloorMargin + ' (cap ' + seqMaxClips + '/CQ)');
    }
    
    // GPU VMAF: Run sequentially (GPU handles parallelism internally)
    // CPU VMAF: Run in parallel batches
    if (hasGpuVmaf) {
        args.jobLog('Processing with GPU VMAF (parallel up to ' + maxParallelGpu + ')...');
        
        var queue = validResults.slice();
        var active = 0;
        var completed = 0;
        
        function runNext() {
            if (active >= maxParallelGpu) return null;
            if (stopGpuFastPath) return null;
            // pull the next measurable item, skipping clips of paramsets already satisfied (seq stop)
            var calcResult = null;
            while (queue.length > 0) {
                var _c = queue.shift();
                if (seqEnabled && psSeqDone[_c.parameterSetId]) { seqSkipped++; completedCount++; continue; }
                calcResult = _c; break;
            }
            if (!calcResult) return null;
            active++;
            var idxLabel = completed + active;
            args.jobLog('[' + idxLabel + '/' + validResults.length + '] ' + calcResult.parameterSetId + ' sample ' + (calcResult.sampleIndex + 1) + ' (GPU queued)');
            return calculateSingleVmafGpuAsync(args, calcResult, samples, cacheDir, modelPath).then(function(vmafCalcResult) {
                active--;
                if (vmafCalcResult.success) {
                    vmafResults.push(vmafCalcResult.result);
                    successfulCalculations++;
                    gpuVmafActuallyUsed = true;
                    completedCount++;
                    args.jobLog('  VMAF Score: ' + vmafCalcResult.result.vmafScore.toFixed(2) +
                        ' (harmonic), Method: ' + vmafCalcResult.method + ', Time: ' + vmafCalcResult.duration.toFixed(1) + 's');
                    if (seqEnabled) {
                        try {
                            var _psid = vmafCalcResult.result.parameterSetId;
                            var _sv = Number(vmafCalcResult.result.vmafScore);
                            if (isFinite(_sv)) (psSeqScores[_psid] = psSeqScores[_psid] || []).push(_sv);
                            var _pmn = Number(vmafCalcResult.result.vmafMin);
                            if (isFinite(_pmn)) (psSeqMins[_psid] = psSeqMins[_psid] || []).push(_pmn);
                            var _nC = (psSeqScores[_psid] || []).length;
                            if (!psSeqDone[_psid] && _nC >= seqMinClips && _nC < seqMaxClips) {
                                // ── Decision-aware sequential stop ──
                                // Instead of a fixed CI tolerance, we evaluate whether the running
                                // estimate is confident enough to DECIDE: clearly pass the target
                                // (lower CI bound >= target + δ) or clearly fail it (upper CI bound
                                // <= target - δ). δ provides a small noise band so we don't oscillate
                                // on marginal decisions. The per-file sigma automatically makes the
                                // effective tolerance scale with margin to the constraint — far from
                                // target → stop fast, near the binding floor → keep sampling.
                                var _decTarget = Number(args.variables.vmafMinVMAF);
                                if (!isFinite(_decTarget) || _decTarget <= 0) _decTarget = 95;
                                var _decFloor = seqFrameFloor; // already set from vmafMinFrameVMAF
                                var _z = 1.64; // 90% CI (one-sided ~95%)
                                var _delta = 0.5; // confidence band
                                var _svs = psSeqScores[_psid];
                                var _sMean = _svs.reduce(function(a,b){return a+b;}, 0) / _svs.length;
                                var _sVar = 0;
                                if (_svs.length > 1) {
                                    _sVar = _svs.reduce(function(ss,v){var d=v-_sMean;return ss+d*d;},0) / (_svs.length - 1);
                                }
                                var _sStd = Math.sqrt(_sVar);
                                var _h = _z * _sStd / Math.sqrt(_svs.length); // CI half-width
                                var _clearlyPasses = (_sMean - _h) >= (_decTarget + _delta);
                                var _clearlyFails = (_sMean + _h) <= (_decTarget - _delta);
                                var _floorOk = true;
                                if (_decFloor > 0 && psSeqMins[_psid] && psSeqMins[_psid].length) {
                                    _floorOk = Math.min.apply(null, psSeqMins[_psid]) >= (_decFloor + seqFloorMargin);
                                }
                                if ((_clearlyPasses || _clearlyFails) && _floorOk) {
                                    psSeqDone[_psid] = true;
                                    args.jobLog('  Sequential stop ' + _psid + ' at ' + _nC + ' clips (mean=' + _sMean.toFixed(2) + ' ± ' + _h.toFixed(2) + ' VMAF, decision=' + (_clearlyPasses ? 'PASS' : 'FAIL') + ', 1%-low clears floor)');
                                }
                            }
                        } catch (eSeqT) { /* non-fatal: keep measuring all clips */ }
                    }
                } else {
                    args.jobLog('  FAILED (GPU fast path): ' + vmafCalcResult.error + ' - disabling GPU fast path for remaining samples');
                    stopGpuFastPath = true;
                    cpuFallbackQueue.push(calcResult);
                    while (queue.length > 0) {
                        cpuFallbackQueue.push(queue.shift());
                    }
                }
                var progressPercent = Math.round((completedCount / validResults.length) * 100);
                if (args.updateWorker) {
                    args.updateWorker({ 
                        percentage: progressPercent,
                        ETA: Math.max(0, Math.round((validResults.length - completedCount) * 5))
                    });
                }
                return runNext();
            });
        }
        
        var runners = [];
        for (var r = 0; r < Math.min(maxParallelGpu, validResults.length); r++) {
            var nxt = runNext();
            if (nxt) runners.push(nxt);
        }
        if (runners.length > 0) {
            await Promise.all(runners);
        }
        
        if (cpuFallbackQueue.length > 0) {
            args.variables.vmafGpuVmafFallbackUsed = true;
            if (requireGpuVmaf) {
                var strictGpuMsg = 'GPU VMAF is required, but the libvmaf_cuda fast path failed for ' + cpuFallbackQueue.length + ' sample(s). Refusing CPU fallback.';
                args.jobLog('ERROR: ' + strictGpuMsg);
                throw new Error(strictGpuMsg);
            }
            args.jobLog('GPU fast path disabled; processing ' + cpuFallbackQueue.length + ' remaining samples with CPU VMAF (parallel up to ' + maxParallel + ')...');
            var cpuQueue = cpuFallbackQueue.slice();
            cpuFallbackQueue = [];
            while (cpuQueue.length > 0) {
                var batch = cpuQueue.splice(0, Math.max(1, maxParallel));
                var cpuResults = await processBatch(batch, args, samples, cacheDir, modelPath, false);
                for (var cr = 0; cr < cpuResults.length; cr++) {
                    var res = cpuResults[cr];
                    completedCount++;
                    if (res.success) {
                        vmafResults.push(res.result);
                        successfulCalculations++;
                        args.jobLog('  CPU fallback success: ' + res.method + ' | Sample ' + (res.result.sampleIndex + 1) + ' | VMAF ' + res.result.vmafScore.toFixed(2));
                    } else {
                        failedCalculations++;
                        args.jobLog('  CPU fallback FAILED: ' + res.error);
                    }
                    var progressPercentCpu = Math.round((completedCount / validResults.length) * 100);
                    if (args.updateWorker) {
                        args.updateWorker({ percentage: progressPercentCpu });
                    }
                }
            }
        }
    } else {
        // CPU VMAF: Process in parallel batches
        console.error('[VMAF Plugin] ERROR: Processing with CPU VMAF instead of GPU VMAF - This will be much slower!');
        console.error('[VMAF Plugin] Total samples to process: ' + validResults.length);
        args.jobLog('Processing with CPU VMAF (' + maxParallel + ' parallel workers)...');
        
        var cpuQueueAll = validResults.slice();
        while (cpuQueueAll.length > 0) {
            var batchCpuOnly = cpuQueueAll.splice(0, Math.max(1, maxParallel));
            
            // Log queued samples for visibility
            for (var q = 0; q < batchCpuOnly.length; q++) {
                var queuedItem = batchCpuOnly[q];
                args.jobLog('[' + (completedCount + q + 1) + '/' + validResults.length + '] ' + queuedItem.parameterSetId + ' sample ' + (queuedItem.sampleIndex + 1) + ' (CPU queued)');
            }
            
            var cpuResultsOnly = await processBatch(batchCpuOnly, args, samples, cacheDir, modelPath, false);
            for (var bc = 0; bc < cpuResultsOnly.length; bc++) {
                var resCpu = cpuResultsOnly[bc];
                completedCount++;
                
                if (resCpu.success) {
                    vmafResults.push(resCpu.result);
                    successfulCalculations++;
                    args.jobLog('  CPU VMAF success: ' + resCpu.method + ' | Sample ' + (resCpu.result.sampleIndex + 1) + ' | VMAF ' + resCpu.result.vmafScore.toFixed(2));
                    
                    if (resCpu.method && (resCpu.method.indexOf('CPU VMAF') !== -1 || resCpu.method.indexOf('Software VMAF') !== -1)) {
                        console.error('[VMAF Plugin] CPU VMAF used: Sample ' + completedCount + '/' + validResults.length + 
                            ' - Method: ' + resCpu.method + ' - Time: ' + resCpu.duration.toFixed(1) + 's');
                    }
                    
                    if (resCpu.result.vmafMin !== null && resCpu.result.vmafMin < 70) {
                        args.jobLog('  ⚠️  Warning: Min VMAF ' + resCpu.result.vmafMin.toFixed(2) + ' - some frames may have artifacts');
                    }
                } else {
                    failedCalculations++;
                    // Include the last-per-method meaningful error (already logged via jobLog in the VMAF function)
                    // to give the reader actionable failure info without needing the Node log.
                    var _vmafErr = resCpu.error || 'All methods failed';
                    // Try to find the per-method failure detail from the error object
                    if (resCpu.lastMethodError) {
                        _vmafErr = resCpu.lastMethodError;
                    }
                    args.jobLog('  CPU VMAF FAILED: ' + _vmafErr);
                }
                
                var progressPercentCpu = Math.round((completedCount / validResults.length) * 100);
                if (args.updateWorker) {
                    args.updateWorker({ 
                        percentage: progressPercentCpu,
                        ETA: Math.round((validResults.length - completedCount) * 60) // ~60s per sample with CPU VMAF
                    });
                }
            }
        }
    }
    
    // Validation. Exclude clips intentionally skipped by sequential sampling from the denominator -
    // they were never attempted, so they must not count against the success rate.
    var totalAttempts = Math.max(1, validResults.length - seqSkipped);
    if (seqEnabled && seqSkipped > 0) {
        args.jobLog('Sequential sampling skipped ' + seqSkipped + ' clip-measurements (mean precise + 1%-low clear early)');
    }

    if (totalAttempts === 0) {
        throw new Error('VMAF calculation failed: No valid test results to process');
    }
    
    if (successfulCalculations === 0) {
        throw new Error('VMAF calculation failed: All ' + totalAttempts + ' calculation attempts failed');
    }
    
    var successRate = successfulCalculations / totalAttempts;
    if (successRate < 0.5) {
        throw new Error('VMAF calculation success rate too low (' + (successRate * 100).toFixed(1) + '%)');
    }
    
    if (successRate < 0.8) {
        args.jobLog('WARNING: VMAF success rate is ' + (successRate * 100).toFixed(1) + '%');
    }
    
    // Aggregate results by parameter set
    args.jobLog('');
    args.jobLog('=== Aggregating Results ===');
    
    var aggregated = {};
    for (var n = 0; n < vmafResults.length; n++) {
        var r = vmafResults[n];
        if (!aggregated[r.parameterSetId]) {
            aggregated[r.parameterSetId] = {
                parameterSetId: r.parameterSetId,
                parameterSet: r.parameterSet,
                vmafScores: [],
                vmafMeans: [],
                vmafHarmonicMeans: [],
                vmafMins: [],
                vmafMaxs: [],
                vmafP1s: [],
                ssimScores: [],
                cambiMeans: [],
                cambiMaxs: [],
                cambiP95s: [],
                fileSizes: [],
            };
        }
        aggregated[r.parameterSetId].vmafScores.push(r.vmafScore);
        if (r.vmafMean !== null && r.vmafMean !== undefined) {
            aggregated[r.parameterSetId].vmafMeans.push(r.vmafMean);
        }
        if (r.vmafHarmonicMean !== null && r.vmafHarmonicMean !== undefined) {
            aggregated[r.parameterSetId].vmafHarmonicMeans.push(r.vmafHarmonicMean);
        }
        if (r.vmafMin !== null && r.vmafMin !== undefined) {
            aggregated[r.parameterSetId].vmafMins.push(r.vmafMin);
        }
        if (r.vmafMax !== null && r.vmafMax !== undefined) {
            aggregated[r.parameterSetId].vmafMaxs.push(r.vmafMax);
        }
        if (r.vmafP1 !== null && r.vmafP1 !== undefined) {
            aggregated[r.parameterSetId].vmafP1s.push(r.vmafP1);
        }
        if (r.ssimScore !== null && r.ssimScore !== undefined) {
            aggregated[r.parameterSetId].ssimScores.push(r.ssimScore);
        }
        if (r.cambiMean !== null && r.cambiMean !== undefined) {
            aggregated[r.parameterSetId].cambiMeans.push(r.cambiMean);
        }
        if (r.cambiMax !== null && r.cambiMax !== undefined) {
            aggregated[r.parameterSetId].cambiMaxs.push(r.cambiMax);
        }
        if (r.cambiP95 !== null && r.cambiP95 !== undefined) {
            aggregated[r.parameterSetId].cambiP95s.push(r.cambiP95);
        }
        aggregated[r.parameterSetId].fileSizes.push(r.fileSizeMB);
    }
    
    var aggregatedResults = [];
    for (var key in aggregated) {
        var item = aggregated[key];
        var avgVMAF = item.vmafScores.reduce(function(a, b) { return a + b; }, 0) / item.vmafScores.length;
        var avgSize = item.fileSizes.reduce(function(a, b) { return a + b; }, 0) / item.fileSizes.length;
        var avgMean = item.vmafMeans.length > 0 ? item.vmafMeans.reduce(function(a, b) { return a + b; }, 0) / item.vmafMeans.length : null;
        var avgHarmonicMean = item.vmafHarmonicMeans.length > 0 ? item.vmafHarmonicMeans.reduce(function(a, b) { return a + b; }, 0) / item.vmafHarmonicMeans.length : null;
        var overallMin = item.vmafMins.length > 0 ? Math.min.apply(null, item.vmafMins) : null;
        var overallMax = item.vmafMaxs.length > 0 ? Math.max.apply(null, item.vmafMaxs) : null;
        var overallP1 = item.vmafP1s.length > 0 ? Math.min.apply(null, item.vmafP1s) : null;
        var avgSSIM = item.ssimScores.length > 0
            ? item.ssimScores.reduce(function(a, b) { return a + b; }, 0) / item.ssimScores.length
            : null;
        var avgCAMBI = item.cambiMeans.length > 0
            ? item.cambiMeans.reduce(function(a, b) { return a + b; }, 0) / item.cambiMeans.length
            : null;
        var maxCAMBI = item.cambiMaxs.length > 0 ? Math.max.apply(null, item.cambiMaxs) : null;
        var p95CAMBI = item.cambiP95s.length > 0 ? Math.max.apply(null, item.cambiP95s) : null;
        var variance = 0;
        if (item.vmafScores.length > 1) {
            var mean = avgVMAF;
            variance = item.vmafScores.reduce(function(acc, v) {
                var diff = v - mean;
                return acc + diff * diff;
            }, 0) / item.vmafScores.length;
        }
        var stdDev = Math.sqrt(variance);
        
        aggregatedResults.push({
            parameterSetId: item.parameterSetId,
            parameterSet: item.parameterSet,
            avgVMAF: avgVMAF,
            avgVMAFMean: avgMean,
            avgVMAFHarmonicMean: avgHarmonicMean,
            minVMAF: overallMin,
            maxVMAF: overallMax,
            vmafP1Low: overallP1,
            avgFileSizeMB: avgSize,
            avgSSIM: avgSSIM,
            avgCAMBI: avgCAMBI,
            maxCAMBI: maxCAMBI,
            p95CAMBI: p95CAMBI,
            sampleCount: item.vmafScores.length,
            vmafStdDev: stdDev,
            clipVmafs: item.vmafScores,
        });
        
        args.jobLog(key + ': VMAF=' + avgVMAF.toFixed(2) + ', 1%low=' +
            (overallP1 !== null ? overallP1.toFixed(2) : 'N/A') + ', Min=' +
            (overallMin !== null ? overallMin.toFixed(2) : 'N/A') + ', SSIM=' +
            (avgSSIM !== null ? avgSSIM.toFixed(2) : 'N/A') + ', CAMBI=' +
            (avgCAMBI !== null ? avgCAMBI.toFixed(2) : 'N/A') + ', Size=' + avgSize.toFixed(2) + 'MB');
    }
    
    args.variables.vmafAggregatedResults = aggregatedResults;
    args.variables.vmafResults = vmafResults;
    args.variables.vmafGpuAccelerated = gpuVmafActuallyUsed;
    args.variables.vmafUsedGpuVmaf = gpuVmafActuallyUsed; // Track if GPU VMAF was actually used (not just available)
    args.variables.vmafGpuVmafActuallyUsed = gpuVmafActuallyUsed;
    
    args.jobLog('');
    args.jobLog('=== VMAF Calculation Complete ===');
    args.jobLog('Processed: ' + successfulCalculations + '/' + totalAttempts + ' samples');
    args.jobLog('Parameter sets: ' + aggregatedResults.length);
    args.jobLog('GPU VMAF available: ' + (hasGpuVmaf ? 'Yes' : 'No'));
    args.jobLog('GPU VMAF actually used: ' + (gpuVmafActuallyUsed ? 'Yes' : 'No'));
    
    if (args.updateWorker) {
        args.updateWorker({ percentage: 100 });
    }
    
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
