"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.details = void 0;
var details = function () { return ({
    "_id": "YR5PZ1QaD",
    "name": "VMAF Parameter Optimization + stream reorder",
    "priority": 3,
    "flowPlugins": [
        {
            "name": "Input File",
            "sourceRepo": "Community",
            "pluginName": "inputFile",
            "version": "1.0.0",
            "fpEnabled": true,
            "id": "input1",
            "position": {
                "x": 400,
                "y": 100
            }
        },
        {
            "name": "Check File Age",
            "sourceRepo": "Local",
            "pluginName": "checkFileAge",
            "version": "1.0.0",
            "inputsDB": {
                "minAgeDays": "7"
            },
            "fpEnabled": true,
            "id": "agecheck1",
            "position": {
                "x": 400,
                "y": 200
            }
        },
        {
            "name": "Detect GPU Encoder",
            "sourceRepo": "Local",
            "pluginName": "detectGPUEncoder",
            "version": "1.0.0",
            "fpEnabled": true,
            "id": "gpu1",
            "position": {
                "x": 400,
                "y": 300
            }
        },
        {
            "name": "Check HDR Content",
            "sourceRepo": "Local",
            "pluginName": "checkHdrContent",
            "version": "1.0.0",
            "fpEnabled": true,
            "id": "hdr1",
            "position": {
                "x": 400,
                "y": 350
            }
        },
        {
            "name": "Fetch Media Metadata",
            "sourceRepo": "Local",
            "pluginName": "fetchMediaMetadata",
            "version": "1.0.0",
            "inputsDB": {
                "enableMetadata": "true",
                "plexUrl": "http://host.docker.internal:32400",
                "plexToken": "<PLEXTOKEN>",
                "plexSections": "",
                "tmdbApiKey": "<TMDBAPIKEY>",
                "tvdbApiKey": "<TVDBAPIKEY>",
                "logMetadata": "true"
            },
            "fpEnabled": true,
            "id": "meta1",
            "position": {
                "x": 400,
                "y": 420
            }
        },
        {
            "name": "Extract Video Samples",
            "sourceRepo": "Local",
            "pluginName": "extractVideoSamples",
            "version": "1.0.0",
            "inputsDB": {
                "numSegments": "4",
                "segmentDuration": "5",
                "varianceLowThreshold": "0.8",
                "varianceHighThreshold": "2.5",
                "learningBitrateTolerance": "25",
                "maxSegments": "8"
            },
            "fpEnabled": true,
            "id": "extract1",
            "position": {
                "x": 396,
                "y": 492
            }
        },
        {
            "name": "Test Encoding Parameters",
            "sourceRepo": "Local",
            "pluginName": "testEncodingParameters",
            "version": "1.0.0",
            "inputsDB": {
                "dynamicCQ": "true",
                "targetMinVMAF": "95",
                "targetSizeReduction": "30",
                "cqRangeWidth": "6",
                "cqStep": "2",
                "presets": "p7"
            },
            "fpEnabled": true,
            "id": "test1",
            "position": {
                "x": 396,
                "y": 564
            }
        },
        {
            "name": "Calculate VMAF",
            "sourceRepo": "Local",
            "pluginName": "calculateVMAF",
            "version": "1.0.0",
            "inputsDB": {
                "maxParallelGpuVmaf": "3",
                "maxParallelVmaf": "4"
            },
            "fpEnabled": true,
            "id": "vmaf1",
            "position": {
                "x": 396,
                "y": 636
            }
        },
        {
            "name": "Select Best Parameters",
            "sourceRepo": "Local",
            "pluginName": "selectBestParameters",
            "version": "1.0.0",
            "inputsDB": {
                "strategy": "target-balanced",
                "minSizeReduction": "20",
                "vmafBuffer10Bit": "0",
                "minVMAF": "95",
                "minFrameVMAF": "88"
            },
            "fpEnabled": true,
            "id": "select1",
            "position": {
                "x": 400,
                "y": 700
            }
        },
        {
            "name": "Check CQ Range Retry",
            "sourceRepo": "Local",
            "pluginName": "checkCQRangeRetry",
            "version": "1.0.0",
            "fpEnabled": true,
            "id": "retry1",
            "position": {
                "x": 400,
                "y": 750
            }
        },
        {
            "name": "Learn CQ Range",
            "sourceRepo": "Local",
            "pluginName": "learnCQRange",
            "version": "1.0.0",
            "inputsDB": {
                "csvPath": "/app/configs/vmaf_cq_learning.csv",
                "priorWeight": "0.25",
                "minSamplesForLearning": "4",
                "bitrateTolerance": "25"
            },
            "fpEnabled": true,
            "id": "learn1",
            "position": {
                "x": 400,
                "y": 800
            }
        },
        {
            "name": "Export VMAF Results to CSV",
            "sourceRepo": "Local",
            "pluginName": "exportVMAFResults",
            "version": "1.0.0",
            "inputsDB": {
                "csvPath": "/app/configs/vmaf_results.csv"
            },
            "fpEnabled": true,
            "id": "export1",
            "position": {
                "x": 400,
                "y": 850
            }
        },
        {
            "name": "Compare File Size Ratio Live",
            "sourceRepo": "Community",
            "pluginName": "compareFileSizeRatioLive",
            "version": "1.0.0",
            "inputsDB": {
                "thresholdPerc": "75",
                "checkDelaySeconds": "120"
            },
            "fpEnabled": true,
            "id": "sizeCheck1",
            "position": {
                "x": 400,
                "y": 900
            }
        },
        {
            "name": "VMAF Optimized Transcode",
            "sourceRepo": "Local",
            "pluginName": "vmafOptimizedTranscode",
            "version": "1.0.0",
            "fpEnabled": true,
            "id": "transcode1",
            "position": {
                "x": 400,
                "y": 950
            }
        },
        {
            "name": "Monitor Transcode Retry",
            "sourceRepo": "Local",
            "pluginName": "monitorTranscodeRetry",
            "version": "1.0.0",
            "fpEnabled": true,
            "id": "monitorRetry1",
            "position": {
                "x": 400,
                "y": 1000
            }
        },
        {
            "name": "Reorder Streams (Plex subtitle fix)",
            "sourceRepo": "Community",
            "pluginName": "ffmpegCommandRorderStreams",
            "version": "1.0.0",
            "inputsDB": {
                "processOrder": "languages,streamTypes",
                "languages": "eng,en,und",
                "channels": "",
                "codecs": "",
                "streamTypes": "video,audio,subtitle"
            },
            "fpEnabled": true,
            "id": "reorderStreams1",
            "position": {
                "x": 396,
                "y": 1092
            }
        },
        {
            "name": "Replace Original File",
            "sourceRepo": "Community",
            "pluginName": "replaceOriginalFile",
            "version": "1.0.0",
            "fpEnabled": true,
            "id": "replace1",
            "position": {
                "x": 396,
                "y": 1176
            }
        },
        {
            "name": "Notify Radarr or Sonarr",
            "sourceRepo": "Community",
            "pluginName": "notifyRadarrOrSonarr",
            "version": "2.0.0",
            "inputsDB": {
                "arr_host": "http://host.docker.internal:7878",
                "arr_api_key": "<ARR_API_KEY>"
            },
            "fpEnabled": true,
            "id": "fk_oDdIer",
            "position": {
                "x": 396,
                "y": 1212
            }
        },
        {
            "name": "Notify Radarr or Sonarr",
            "sourceRepo": "Community",
            "pluginName": "notifyRadarrOrSonarr",
            "version": "2.0.0",
            "inputsDB": {
                "arr": "sonarr",
                "arr_api_key": "<ARR_API_KEY>",
                "arr_host": "http://host.docker.internal:8989"
            },
            "fpEnabled": true,
            "id": "ZUeRGecsJ",
            "position": {
                "x": 396,
                "y": 1238
            }
        },
        {
            "name": "Unmonitor in Radarr or Sonarr",
            "sourceRepo": "Local",
            "pluginName": "unmonitorRadarrOrSonarr",
            "version": "1.0.0",
            "inputsDB": {
                "arr_api_key": "<ARR_API_KEY>",
                "arr_host": "http://host.docker.internal:7878"
            },
            "fpEnabled": true,
            "id": "O_r99-sYI",
            "position": {
                "x": 396,
                "y": 1298
            }
        },
        {
            "name": "Unmonitor in Radarr or Sonarr",
            "sourceRepo": "Local",
            "pluginName": "unmonitorRadarrOrSonarr",
            "version": "1.0.0",
            "inputsDB": {
                "arr": "sonarr",
                "arr_api_key": "<ARR_API_KEY>",
                "arr_host": "http://host.docker.internal:8989"
            },
            "fpEnabled": true,
            "id": "wFyzeCkgc",
            "position": {
                "x": 396,
                "y": 1370
            }
        },
        {
            "name": "Cleanup Temporary Files",
            "sourceRepo": "Local",
            "pluginName": "cleanupTempFiles",
            "version": "1.0.0",
            "fpEnabled": true,
            "id": "F1jkDv0qn",
            "position": {
                "x": 396,
                "y": 1430
            }
        },
        {
            "name": "Begin Command",
            "sourceRepo": "Community",
            "pluginName": "ffmpegCommandStart",
            "version": "1.0.0",
            "id": "A811lg3V4",
            "position": {
                "x": 396,
                "y": 1044
            },
            "fpEnabled": true
        },
        {
            "name": "Execute",
            "sourceRepo": "Community",
            "pluginName": "ffmpegCommandExecute",
            "version": "1.0.0",
            "id": "BthcE0uii",
            "position": {
                "x": 396,
                "y": 1140
            },
            "fpEnabled": true
        },
        {
            "name": "Detect Scene Complexity",
            "sourceRepo": "Local",
            "pluginName": "detectSceneComplexity",
            "version": "1.0.0",
            "id": "BCgj_9OBS",
            "position": {
                "x": 396,
                "y": 456
            },
            "fpEnabled": true
        },
        {
            "name": "Check CQ Bracket",
            "sourceRepo": "Local",
            "pluginName": "checkCQBracket",
            "version": "1.0.0",
            "id": "33RG6sdxP",
            "position": {
                "x": 24,
                "y": 672
            },
            "fpEnabled": true,
            "inputsDB": {
                "targetVMAF": "95"
            }
        },
        {
            "name": "Acquire GPU Pipeline Lock",
            "sourceRepo": "Local",
            "pluginName": "acquireGpuPipelineLock",
            "version": "1.0.0",
            "fpEnabled": true,
            "id": "gpuLockAcquire1",
            "position": {
                "x": 144,
                "y": 564
            }
        },
        {
            "name": "Acquire GPU Pipeline Lock",
            "sourceRepo": "Local",
            "pluginName": "acquireGpuPipelineLock",
            "version": "1.0.0",
            "fpEnabled": true,
            "id": "gpuLockAcquireTranscode1",
            "position": {
                "x": 144,
                "y": 950
            }
        },
        {
            "name": "Release GPU Pipeline Lock",
            "sourceRepo": "Local",
            "pluginName": "releaseGpuPipelineLock",
            "version": "1.0.0",
            "fpEnabled": true,
            "id": "gpuLockRelease1",
            "position": {
                "x": 144,
                "y": 1000
            }
        }
    ],
    "flowEdges": [
        {
            "source": "input1",
            "sourceHandle": "1",
            "target": "agecheck1",
            "targetHandle": null,
            "id": "edge0",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "agecheck1",
            "sourceHandle": "1",
            "target": "gpu1",
            "targetHandle": null,
            "id": "edge1",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "gpu1",
            "sourceHandle": "1",
            "target": "hdr1",
            "targetHandle": null,
            "id": "edge2",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "gpu1",
            "sourceHandle": "2",
            "target": "hdr1",
            "targetHandle": null,
            "id": "edge2b",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "hdr1",
            "sourceHandle": "1",
            "target": "meta1",
            "targetHandle": null,
            "id": "edge2c",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "hdr1",
            "sourceHandle": "2",
            "target": "meta1",
            "targetHandle": null,
            "id": "edge2d",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "extract1",
            "sourceHandle": "1",
            "target": "gpuLockAcquire1",
            "targetHandle": null,
            "id": "edge3_to_gpuLockAcquire1",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "test1",
            "sourceHandle": "1",
            "target": "vmaf1",
            "targetHandle": null,
            "id": "edge4",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "select1",
            "sourceHandle": "1",
            "target": "retry1",
            "targetHandle": null,
            "id": "edge6",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "select1",
            "sourceHandle": "2",
            "target": "retry1",
            "targetHandle": null,
            "id": "edge6a",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "retry1",
            "sourceHandle": "1",
            "target": "gpuLockAcquire1",
            "targetHandle": null,
            "id": "edge6b_to_gpuLockAcquire1",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "retry1",
            "sourceHandle": "2",
            "target": "learn1",
            "targetHandle": null,
            "id": "edge6c",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "learn1",
            "sourceHandle": "1",
            "target": "export1",
            "targetHandle": null,
            "id": "edge6d",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "learn1",
            "sourceHandle": "2",
            "target": "export1",
            "targetHandle": null,
            "id": "edge6e",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "export1",
            "sourceHandle": "1",
            "target": "sizeCheck1",
            "targetHandle": null,
            "id": "edge7",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "sizeCheck1",
            "sourceHandle": "1",
            "target": "gpuLockAcquireTranscode1",
            "targetHandle": null,
            "id": "edge7a_to_gpuLockAcquireTranscode1",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "sizeCheck1",
            "sourceHandle": "2",
            "target": "gpuLockAcquireTranscode1",
            "targetHandle": null,
            "id": "edge7a2_to_gpuLockAcquireTranscode1",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "transcode1",
            "sourceHandle": "1",
            "target": "gpuLockRelease1",
            "targetHandle": null,
            "id": "edge7b_to_gpuLockRelease1",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "transcode1",
            "sourceHandle": "2",
            "target": "gpuLockRelease1",
            "targetHandle": null,
            "id": "edge7c_to_gpuLockRelease1",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "monitorRetry1",
            "sourceHandle": "1",
            "target": "gpuLockAcquireTranscode1",
            "targetHandle": null,
            "id": "edge7d_to_gpuLockAcquireTranscode1",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "monitorRetry1",
            "sourceHandle": "3",
            "target": "retry1",
            "targetHandle": null,
            "id": "edge8b",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "replace1",
            "sourceHandle": "1",
            "target": "fk_oDdIer",
            "targetHandle": null,
            "id": "TksTAd-42",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "fk_oDdIer",
            "sourceHandle": "1",
            "target": "ZUeRGecsJ",
            "targetHandle": null,
            "id": "waWWjECgB",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "fk_oDdIer",
            "sourceHandle": "2",
            "target": "ZUeRGecsJ",
            "targetHandle": null,
            "id": "DIryOYgdx",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "ZUeRGecsJ",
            "sourceHandle": "1",
            "target": "O_r99-sYI",
            "targetHandle": null,
            "id": "0xBiO_7bf",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "ZUeRGecsJ",
            "sourceHandle": "2",
            "target": "O_r99-sYI",
            "targetHandle": null,
            "id": "CDKH4mjbv",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "O_r99-sYI",
            "sourceHandle": "1",
            "target": "wFyzeCkgc",
            "targetHandle": null,
            "id": "RpbM3M6Ja",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "O_r99-sYI",
            "sourceHandle": "2",
            "target": "wFyzeCkgc",
            "targetHandle": null,
            "id": "E2-EaSepG",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "wFyzeCkgc",
            "sourceHandle": "1",
            "target": "F1jkDv0qn",
            "targetHandle": null,
            "id": "wKMVwvfA_",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "wFyzeCkgc",
            "sourceHandle": "2",
            "target": "F1jkDv0qn",
            "targetHandle": null,
            "id": "Sngr_MuiN",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "monitorRetry1",
            "sourceHandle": "2",
            "target": "A811lg3V4",
            "targetHandle": null,
            "id": "tfWO43oQX",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "A811lg3V4",
            "sourceHandle": "1",
            "target": "reorderStreams1",
            "targetHandle": null,
            "id": "6-677LHTh",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "reorderStreams1",
            "sourceHandle": "1",
            "target": "BthcE0uii",
            "targetHandle": null,
            "id": "sUYMm_1jH",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "BthcE0uii",
            "sourceHandle": "1",
            "target": "replace1",
            "targetHandle": null,
            "id": "0dIpdmIZC",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "meta1",
            "sourceHandle": "1",
            "target": "BCgj_9OBS",
            "targetHandle": null,
            "id": "oRjHRjyYM",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "BCgj_9OBS",
            "sourceHandle": "1",
            "target": "extract1",
            "targetHandle": null,
            "id": "efOdOBddo",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "vmaf1",
            "sourceHandle": "1",
            "target": "33RG6sdxP",
            "targetHandle": null,
            "id": "rNZdU5K_m",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "33RG6sdxP",
            "sourceHandle": "1",
            "target": "select1",
            "targetHandle": null,
            "id": "K_ZfYqGyh",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "33RG6sdxP",
            "sourceHandle": "2",
            "target": "gpuLockAcquire1",
            "targetHandle": null,
            "id": "rLWbQzi1W_to_gpuLockAcquire1",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "gpuLockAcquire1",
            "sourceHandle": "1",
            "target": "test1",
            "targetHandle": null,
            "id": "edge_gpuLockAcquire1_to_test1",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "gpuLockAcquireTranscode1",
            "sourceHandle": "1",
            "target": "transcode1",
            "targetHandle": null,
            "id": "edge_gpuLockAcquireTranscode1_to_transcode1",
            "animated": true,
            "type": "smoothstep"
        },
        {
            "source": "gpuLockRelease1",
            "sourceHandle": "1",
            "target": "monitorRetry1",
            "targetHandle": null,
            "id": "edge_gpuLockRelease1_to_monitorRetry1",
            "animated": true,
            "type": "smoothstep"
        }
    ],
    "isUiLocked": false
}); };
exports.details = details;
