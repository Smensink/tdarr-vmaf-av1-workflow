"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var cliUtils_1 = require("../../../../FlowHelpers/1.0.0/cliUtils");
var details = function () { return ({
    name: 'VMAF Optimized Transcode',
    description: 'Transcodes the full video using the VMAF-optimized parameters with real-time progress.',
    style: {
        borderColor: 'red',
    },
    tags: 'video,vmaf,transcode',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faVideo',
    inputs: [],
    outputs: [
        {
            number: 1,
            tooltip: 'Transcode successful',
        },
        {
            number: 2,
            tooltip: 'Transcode failed or no parameters',
        },
    ],
}); };
exports.details = details;



// --- HDR metadata helper: parse hdrMasterDisplay / hdrMaxCll strings from checkHdrContent ---
// hdrMasterDisplay format: "G(x,y)B(x,y)R(x,y)WP(x,y)L(max_lum,min_lum)"
// hdrMaxCll format: "max_content_light_level,max_pic_average_light_level"
function parseHdrMasterDisplay(raw) {
    if (!raw) return null;
    var m = raw.match(/L\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/);
    if (!m) return null;
    return { max_lum: parseFloat(m[1]), min_lum: parseFloat(m[2]) };
}

function parseHdrMaxCll(raw) {
    if (!raw) return null;
    var parts = raw.split(',');
    if (parts.length < 2) return null;
    return { max_cll: parseInt(parts[0], 10), max_pall: parseInt(parts[1], 10) };
}

// Map string color primaries to integer values used by mkvpropedit
function colorPrimariesToInt(v) {
    v = String(v || '').toLowerCase();
    if (v.indexOf('bt2020') !== -1) return 9;
    if (v.indexOf('bt709') !== -1 || v.indexOf('709') !== -1) return 1;
    if (v.indexOf('bt601') !== -1 || v.indexOf('601') !== -1) return 5;
    return 2;
}

function colorTrcToInt(v) {
    v = String(v || '').toLowerCase();
    if (v.indexOf('smpte2084') !== -1 || v.indexOf('pq') !== -1) return 16;
    if (v.indexOf('arib-std-b67') !== -1 || v.indexOf('hlg') !== -1) return 18;
    if (v.indexOf('bt709') !== -1 || v.indexOf('709') !== -1) return 1;
    if (v.indexOf('bt601') !== -1 || v.indexOf('601') !== -1) return 4;
    return 2;
}

function colorMatrixToInt(v) {
    v = String(v || '').toLowerCase();
    if (v.indexOf('bt2020') !== -1) return 9;
    if (v.indexOf('bt709') !== -1 || v.indexOf('709') !== -1) return 1;
    if (v.indexOf('bt601') !== -1 || v.indexOf('601') !== -1) return 6;
    return 2;
}

// Run mkvpropedit to apply HDR color container properties from source to output
// This is called after a successful AV1 encode which loses the HDR SEI / container metadata
// Runs synchronously: the tsc __generator state machine in plugin() cannot await
// a raw Promise from a case body (it spins forever on an invalid op tuple).
function applyHdrColorMetadata(outputPath, sourceFile, colorPrimaries, colorTrc, colorspace, hdrMasterDisplay, hdrMaxCll, jobLog) {
    var spawnSync = require('child_process').spawnSync;
    var mdc = parseHdrMasterDisplay(hdrMasterDisplay);
    var mcll = parseHdrMaxCll(hdrMaxCll);
    var cpInt = colorPrimariesToInt(colorPrimaries);
    var ctInt = colorTrcToInt(colorTrc);
    var cmInt = colorMatrixToInt(colorspace);
    var args = ['--edit', 'track:1'];
    args.push('--set', 'color-primaries=' + cpInt);
    args.push('--set', 'color-transfer-characteristics=' + ctInt);
    args.push('--set', 'color-matrix-coefficients=' + cmInt);
    if (mdc) {
        args.push('--set', 'max-luminance=' + mdc.max_lum);
        args.push('--set', 'min-luminance=' + mdc.min_lum);
        jobLog('  HDR mastering display: max_lum=' + mdc.max_lum + ', min_lum=' + mdc.min_lum);
    }
    if (mcll) {
        jobLog('  HDR max CLL: content=' + mcll.max_cll + ', pic_avg=' + mcll.max_pall);
    }
    var res = spawnSync('mkvpropedit', [outputPath].concat(args), { encoding: 'utf8', timeout: 300000 });
    if (res.error) {
        jobLog('  mkvpropedit error (HDR metadata not applied): ' + res.error.message);
        return false;
    }
    if (res.status !== 0) {
        var errTail = String(res.stderr || res.stdout || '').trim().split('\n').slice(-1)[0];
        jobLog('  mkvpropedit warning: exit ' + res.status + ' (HDR color metadata may not be set): ' + errTail);
        return false;
    }
    jobLog('  HDR color metadata applied via mkvpropedit (primaries=' + colorPrimaries + ', trc=' + colorTrc + ', matrix=' + colorspace + ')');
    return true;
}

function av1ColorMetadataArgs(colorPrimaries, colorTrc, colorspace) {
    function mapPrimaries(v) {
        v = String(v || '').toLowerCase();
        if (v.indexOf('bt2020') !== -1) return 9;
        if (v.indexOf('bt709') !== -1) return 1;
        return 2;
    }
    function mapTransfer(v) {
        v = String(v || '').toLowerCase();
        if (v.indexOf('smpte2084') !== -1) return 16;
        if (v.indexOf('arib-std-b67') !== -1 || v.indexOf('hlg') !== -1) return 18;
        if (v.indexOf('bt709') !== -1) return 1;
        return 2;
    }
    function mapMatrix(v) {
        v = String(v || '').toLowerCase();
        if (v.indexOf('bt2020') !== -1) return 9;
        if (v.indexOf('bt709') !== -1) return 1;
        return 2;
    }
    return {
        bsf: 'av1_metadata=color_primaries=' + mapPrimaries(colorPrimaries) + ':transfer_characteristics=' + mapTransfer(colorTrc) + ':matrix_coefficients=' + mapMatrix(colorspace)
    };
}

var plugin = async function (args) {
    return __awaiter(this, void 0, void 0, function () {
        var lib, path, bestParams, originalFile, cacheDir, fileName, container, pixFmt, colorPrimaries, colorTrc, colorspace, hdrMasterDisplay, hdrMaxCll, outputPath, spawnArgs, cli, res, err;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    lib = require('../../../../../methods/lib')();
                    args.inputs = lib.loadDefaultValues(args.inputs, details);
                    path = require('path');
                    bestParams = args.variables.vmafBestParameters;
                    originalFile = args.variables.vmafOriginalFile || args.inputFileObj._id;
                    cacheDir = args.workDir || '/temp';
                    fileName = path.basename(originalFile, path.extname(originalFile));
                    container = path.extname(originalFile).slice(1);
                    
                    if (!bestParams) {
                        args.jobLog('Error: No optimal parameters found. Run Select Best Parameters first.');
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }
                    
                    var finalGpuRequired = args.variables.vmafRequireGpuTranscode !== false;
                    if (finalGpuRequired && (!bestParams.isGPU || String(bestParams.encoder || '').indexOf('_nvenc') === -1)) {
                        args.jobLog('ERROR: GPU final transcode is required, but selected parameters are not NVENC/GPU: ' + JSON.stringify(bestParams));
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }
                    args.variables.vmafFinalTranscodeGpuRequired = finalGpuRequired;
                    args.variables.vmafFinalTranscodeGpuEncoder = bestParams.encoder;
                    
                    // Use recommended pixel format from VMAF analysis if available
                    pixFmt = args.variables.vmafRecommendedPixFmt || args.variables.pix_fmt || bestParams.pixFmt || 'yuv420p';
                    colorPrimaries = args.variables.color_primaries || bestParams.colorPrimaries || 'bt709';
                    colorTrc = args.variables.color_trc || bestParams.colorTrc || 'bt709';
                    colorspace = args.variables.colorspace || bestParams.colorspace || 'bt709';
                    hdrMasterDisplay = args.variables.hdr_master_display || '';
                    hdrMaxCll = args.variables.hdr_max_cll || '';
                    outputPath = cacheDir + '/' + fileName + '_vmaf_optimized.' + container;
                    
                    // Check for retry CQ (from monitorTranscodeRetry)
                    var useCQ = bestParams.quality;
                    var retryCQ = args.variables.vmafTranscodeRetryCQ;
                    var retryCount = args.variables.vmafTranscodeRetryCount || 0;
                    var isRetry = retryCQ !== undefined && retryCQ !== null;
                    
                    if (isRetry) {
                        useCQ = retryCQ;
                        // Store output path for cleanup on retry
                        args.variables.vmafTranscodeOutputPath = outputPath;
                    }
                    
                    args.jobLog('=== VMAF Optimized Transcode ===');
                    if (isRetry) {
                        args.jobLog('⚠ RETRY ATTEMPT #' + retryCount);
                        args.jobLog('Original CQ: ' + bestParams.quality);
                        args.jobLog('Retry CQ: ' + useCQ + ' (incremented for smaller file size)');
                    }
                    args.jobLog('Parameter set: ' + bestParams.id);
                    args.jobLog('Encoder: ' + bestParams.encoder);
                    args.jobLog('GPU final encode required: ' + ((args.variables.vmafFinalTranscodeGpuRequired !== false) ? 'Yes' : 'No'));
                    args.jobLog('Preset: ' + bestParams.preset);
                    args.jobLog('Quality (CQ): ' + useCQ + (isRetry ? ' (retry)' : ''));
                    args.jobLog('Pixel Format: ' + pixFmt + (args.variables.vmafRecommendedPixFmt ? ' (VMAF recommended)' : ''));
                    args.jobLog('Color: ' + colorPrimaries + '/' + colorTrc + '/' + colorspace);
                    if (args.variables.hdr_dynamic_metadata_warning) {
                        args.jobLog('⚠ ' + args.variables.hdr_dynamic_metadata_warning);
                    }
                    if (pixFmt === 'p010le') {
                        args.jobLog('10-bit encoding enabled' + (args.variables.isHDR ? ' (HDR content)' : ' (VMAF analysis showed quality benefit)'));
                    }
                    args.jobLog('Output: ' + outputPath);
                    args.jobLog('');
                    
                    // Enable live size monitoring
                    args.variables.liveSizeCompare = {
                        enabled: true,
                        compareMethod: 'estimatedFinalSize',
                        thresholdPerc: 100, // Cancel if > 100% of original
                        checkDelaySeconds: 60, // Wait 60s before checking
                        error: false
                    };
                    
                    // Build FFmpeg arguments array for CLI helper
                    spawnArgs = [];
                    if (bestParams.isGPU && bestParams.encoder.indexOf('av1_nvenc') !== -1) {
                        spawnArgs.push('-hwaccel', 'cuda');
                    }
                    spawnArgs.push('-i', originalFile);
                    spawnArgs.push('-c:v', bestParams.encoder);
                    
                    if (bestParams.isGPU && bestParams.encoder.indexOf('av1_nvenc') !== -1) {
                        spawnArgs.push('-pix_fmt', pixFmt);
                        spawnArgs.push('-rc', 'vbr', '-cq', String(useCQ), '-b:v', '0');
                        spawnArgs.push('-preset', bestParams.preset);
                        // Use exactly the flag set the VMAF sweep was measured with (decided
                        // once per job by testEncodingParameters via a capability probe).
                        var nvencFlagArgs = args.variables.vmafNvencFlagArgs
                            || '-tune hq -multipass fullres -spatial-aq 1 -temporal-aq 1 -aq-strength 10 -rc-lookahead 32';
                        nvencFlagArgs.split(' ').forEach(function (fa) {
                            if (fa) spawnArgs.push(fa);
                        });
                        spawnArgs.push('-g', '96', '-forced-idr', '1');
                        spawnArgs.push('-color_primaries', colorPrimaries);
                        spawnArgs.push('-color_trc', colorTrc);
                        spawnArgs.push('-colorspace', colorspace);
                        var av1Meta = av1ColorMetadataArgs(colorPrimaries, colorTrc, colorspace);
                        spawnArgs.push('-bsf:v', av1Meta.bsf);
                        spawnArgs.push('-metadata:s:v:0', 'COLOR_PRIMARIES=' + colorPrimaries);
                        spawnArgs.push('-metadata:s:v:0', 'COLOR_TRANSFER=' + colorTrc);
                        spawnArgs.push('-metadata:s:v:0', 'COLOR_SPACE=' + colorspace);
                        if (hdrMasterDisplay || hdrMaxCll) {
                            args.jobLog('⚠ Static HDR mastering/CLL metadata detected but av1_nvenc in this FFmpeg build does not support -master_display/-max_cll. Preserving HDR color primaries/TRC/matrix only.');
                        }
                        spawnArgs.push('-max_muxing_queue_size', '4096');
                    }
                    // Explicit stream mapping: without -map, ffmpeg keeps only ONE audio and
                    // ONE subtitle stream (default selection), silently dropping the rest on
                    // multi-track files. Map primary video + ALL audio/subtitle/attachment
                    // streams, chapters, and global metadata.
                    spawnArgs.push('-map', '0:v:0', '-map', '0:a?', '-map', '0:s?', '-map', '0:t?');
                    spawnArgs.push('-map_metadata', '0', '-map_chapters', '0', '-dn');
                    spawnArgs.push('-c:a', 'copy', '-c:s', 'copy', '-c:t', 'copy', '-y', outputPath);
                    
                    args.jobLog('FFmpeg command: ' + args.ffmpegPath + ' ' + spawnArgs.join(' '));
                    
                    // Update worker with CLI info for progress display
                    if (args.updateWorker) {
                        args.updateWorker({
                            CLIType: args.ffmpegPath,
                            preset: spawnArgs.join(' '),
                        });
                    }
                    
                    _a.trys.push([0, 2, , 3]);

                    // WATCHDOG: hard wall-clock cap on the FINAL transcode so a pathologically slow encode
                    // (e.g. NVDEC decode-fallback to CPU software decode -> a few fps -> 10+ hours) can't run
                    // forever holding the GPU pipeline lock and blocking the queue. Cap = 2x the source
                    // runtime, clamped to 30min..4h. On expiry Node SIGKILLs ffmpeg -> non-zero exit ->
                    // failure path (outputNumber 2) -> the flow's Release GPU Pipeline Lock node frees the
                    // lock and the job fails cleanly + re-queues, instead of wedging the whole node.
                    var _srcDur = parseFloat(args.inputFileObj && args.inputFileObj.ffProbeData
                        && args.inputFileObj.ffProbeData.format && args.inputFileObj.ffProbeData.format.duration) || 0;
                    var _capMs = Math.round(Math.min(14400, Math.max(1800, _srcDur * 2.0)) * 1000);
                    args.jobLog('Transcode watchdog: hard timeout ' + Math.round(_capMs / 60000) + ' min'
                        + ' (source ' + Math.round(_srcDur) + 's x2, clamped 30min-4h) -> SIGKILL if exceeded');

                    cli = new cliUtils_1.CLI({
                        cli: args.ffmpegPath,
                        spawnArgs: spawnArgs,
                        spawnOpts: { timeout: _capMs, killSignal: 'SIGKILL' },
                        jobLog: args.jobLog,
                        outputFilePath: outputPath,
                        inputFileObj: args.inputFileObj,
                        logFullCliOutput: args.logFullCliOutput,
                        updateWorker: args.updateWorker,
                        args: args,
                    });
                    
                    return [4 /*yield*/, cli.runCli()];
                case 1:
                    res = _a.sent();
                    if (res.cliExitCode !== 0) {
                        args.jobLog('Transcode failed with exit code: ' + res.cliExitCode);
                        return [2 /*return*/, {
                            outputFileObj: args.inputFileObj,
                            outputNumber: 2,
                            variables: args.variables,
                        }];
                    }
                    args.jobLog('Transcode completed successfully: ' + outputPath);
                    args.variables.vmafTranscodeSucceeded = true;
                    args.variables.vmafTranscodeCompletedAt = new Date().toISOString();

                    // Apply HDR color metadata from source to output file via mkvpropedit.
                    // Must run synchronously: returning a raw Promise from a __generator
                    // case body makes the state machine spin forever (job stuck at 100%).
                    if (colorPrimaries && colorPrimaries !== 'bt709') {
                        args.jobLog('  Preserving HDR color metadata from source...');
                        applyHdrColorMetadata(outputPath, originalFile, colorPrimaries, colorTrc, colorspace, hdrMasterDisplay, hdrMaxCll, args.jobLog);
                    }

                    return [2 /*return*/, {
                        outputFileObj: { _id: outputPath },
                        outputNumber: 1,
                        variables: args.variables,
                    }];
                case 2:
                    err = _a.sent();
                    args.jobLog('Transcode failed: ' + err.message);
                    return [2 /*return*/, {
                        outputFileObj: args.inputFileObj,
                        outputNumber: 2,
                        variables: args.variables,
                    }];
                case 3:
                    return [2 /*return*/];
            }
        });
    });
};
exports.plugin = plugin;
