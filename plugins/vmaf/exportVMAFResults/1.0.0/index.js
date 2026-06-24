"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Export VMAF Results to CSV',
    description: 'Exports all VMAF calculation results, file metadata, and parameter selections to CSV for analysis.',
    style: {
        borderColor: 'orange',
    },
    tags: 'video,vmaf,export,analysis',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faFileCsv',
    inputs: [
        {
            label: 'CSV Output Path',
            name: 'csvPath',
            type: 'string',
            defaultValue: '/app/configs/vmaf_results.csv',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Path where CSV file will be saved. Default: /app/configs/vmaf_results.csv (accessible on host)',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'CSV export completed',
        },
    ],
}); };
exports.details = details;
var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    var fs = require('fs');
    var path = require('path');
    var csvPath = args.inputs.csvPath || '/app/configs/vmaf_results.csv';
    
    // Get all data
    var inputFile = args.inputFileObj;
    var testResults = args.variables.vmafTestResults || [];
    var vmafResults = args.variables.vmafResults || [];
    var aggregatedResults = args.variables.vmafAggregatedResults || [];
    var bestParams = args.variables.vmafBestParameters || null;
    var bestVMAF = args.variables.vmafBestVMAF || null;
    var bestSize = args.variables.vmafBestSize || null;
    var strategy = args.variables.vmafStrategy || 'pareto-efficiency-curve';
    var minVMAF = args.variables.vmafMinVMAF || 90;
    
    // ENHANCEMENT FIX #15: Get retry tracking data
    var retryCount = args.variables.vmafRetryCount || 0;
    var transcodeRetryCount = args.variables.vmafTranscodeRetryCount || 0;
    var transcodeRetryHistory = args.variables.vmafTranscodeRetryHistory || [];
    var sweepRetryHistory = args.variables.vmafSweepRetryHistory || [];
    var cqRangeRetryHistory = args.variables.vmafCQRangeRetryHistory || [];
    var transcodeFailures = args.variables.vmafTranscodeFailures || [];
    
    // Create lookup map for parameter sets from testResults
    var paramSetMap = {};
    for (var t = 0; t < testResults.length; t++) {
        if (testResults[t].parameterSetId && testResults[t].parameterSet) {
            paramSetMap[testResults[t].parameterSetId] = testResults[t].parameterSet;
        }
    }
    
    // Extract file metadata
    var fileMetadata = {
        filePath: inputFile._id || '',
        fileName: path.basename(inputFile._id || ''),
        fileSize: inputFile.file_size || 0,
        duration: (inputFile.ffProbeData && inputFile.ffProbeData.format && inputFile.ffProbeData.format.duration) ? parseFloat(inputFile.ffProbeData.format.duration) : 0,
        videoCodec: (inputFile.ffProbeData && inputFile.ffProbeData.streams && inputFile.ffProbeData.streams[0]) ? inputFile.ffProbeData.streams[0].codec_name : '',
        videoWidth: (inputFile.ffProbeData && inputFile.ffProbeData.streams && inputFile.ffProbeData.streams[0]) ? inputFile.ffProbeData.streams[0].width : 0,
        videoHeight: (inputFile.ffProbeData && inputFile.ffProbeData.streams && inputFile.ffProbeData.streams[0]) ? inputFile.ffProbeData.streams[0].height : 0,
        videoBitrate: (inputFile.ffProbeData && inputFile.ffProbeData.format) ? parseInt(inputFile.ffProbeData.format.bit_rate) || 0 : 0,
        pixelFormat: (inputFile.ffProbeData && inputFile.ffProbeData.streams && inputFile.ffProbeData.streams[0]) ? inputFile.ffProbeData.streams[0].pix_fmt : '',
        frameRate: (inputFile.ffProbeData && inputFile.ffProbeData.streams && inputFile.ffProbeData.streams[0]) ? inputFile.ffProbeData.streams[0].r_frame_rate : '',
        colorPrimaries: (inputFile.ffProbeData && inputFile.ffProbeData.streams && inputFile.ffProbeData.streams[0]) ? (inputFile.ffProbeData.streams[0].color_primaries || '') : '',
        colorTrc: (inputFile.ffProbeData && inputFile.ffProbeData.streams && inputFile.ffProbeData.streams[0]) ? (inputFile.ffProbeData.streams[0].color_trc || '') : '',
        colorspace: (inputFile.ffProbeData && inputFile.ffProbeData.streams && inputFile.ffProbeData.streams[0]) ? (inputFile.ffProbeData.streams[0].color_space || '') : '',
        isHDR: args.variables.isHDR || false,
    };
    var mediaGenres = Array.isArray(args.variables.vmafMediaGenre) ? args.variables.vmafMediaGenre : [];
    var mediaGenresString = mediaGenres.join(', ');
    var mediaIsAnimation = args.variables.vmafMediaIsAnimation === true;
    var mediaType = args.variables.vmafMediaType || 'unknown';
    var mediaYear = args.variables.vmafMediaYear || '';
    var mediaMetadataSource = args.variables.vmafMediaMetadataSource || 'none';
    var mediaSourceType = args.variables.vmafMediaSourceType || 'unknown';
    function deriveReleaseGroup(inputFile) {
        var explicit = args.variables.vmafReleaseGroup || args.variables.vmafReleaseGroupUsed || '';
        if (explicit) return explicit;
        var filePath = '';
        if (inputFile) {
            filePath = inputFile._id || inputFile.file || inputFile.filePath || '';
        }
        var fileName = path.basename(filePath || '');
        var ext = path.extname(fileName);
        var stem = ext ? fileName.slice(0, -ext.length) : fileName;
        stem = stem.replace(/_vmaf_optimized$/i, '').replace(/_tdarr.*$/i, '');
        var candidate = '';
        var bracketMatch = stem.match(/\[([A-Za-z0-9][A-Za-z0-9._-]{1,32})\]\s*$/);
        if (bracketMatch && bracketMatch[1]) {
            candidate = bracketMatch[1];
        }
        if (!candidate) {
            var dashIndex = stem.lastIndexOf('-');
            if (dashIndex !== -1 && dashIndex < stem.length - 1) {
                candidate = stem.slice(dashIndex + 1);
            }
        }
        if (!candidate && filePath) {
            var parts = filePath.split(/[\\/]/);
            var parent = parts.length > 1 ? parts[parts.length - 2] : '';
            var parentDash = parent.lastIndexOf('-');
            if (parentDash !== -1 && parentDash < parent.length - 1) {
                candidate = parent.slice(parentDash + 1);
            }
        }
        candidate = (candidate || '').replace(/^[\s._-]+|[\s._-]+$/g, '');
        var normalized = candidate.replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
        var noise = [
            'webdl', 'webrip', 'bluray', 'bdrip', 'brrip', 'hdtv', 'sdtv', 'amzn', 'nf', 'dsnp', 'hmax', 'imax',
            'remux', 'dvdrip', 'uhd', 'hdr', 'hdr10', 'hdr10plus', 'sdr', 'dv', 'hevc', 'h265', 'h264', 'x265', 'x264', 'av1',
            '10bit', '8bit', '2160p', '1080p', '720p', '480p', '4k',
            'atmos', 'ddp', 'ddp51', 'ddp5', 'ddp5.1', 'aac', 'eac3', 'dts', 'truehd',
            'proper', 'repack', 'real', 'hybrid', 'fix', 'muxed', 'web'
        ];
        if (!normalized || normalized.length < 2) return '';
        var hasLetter = /[a-z]/i.test(candidate);
        if (!hasLetter) return '';
        for (var n = 0; n < noise.length; n++) {
            if (normalized === noise[n].replace(/[^A-Za-z0-9]+/g, '')) {
                return '';
            }
        }
        return candidate;
    }
    var releaseGroup = deriveReleaseGroup(inputFile);
    var trendDropPerCQ = args.variables.vmafTrendAvgDropPerCQ || '';
    var trendIncrementUsed = args.variables.vmafTrendIncrementUsed || '';
    var sourceDurationMinutes = fileMetadata.duration ? (fileMetadata.duration / 60) : '';
    var sourceBitsPerPixel = args.variables.vmafSourceBpp;
    if (sourceBitsPerPixel === undefined || sourceBitsPerPixel === null) {
        sourceBitsPerPixel = '';
    }
    var dynamicGenreAdjustment = args.variables.vmafGenreCQAdjustment || 0;
    var dynamicAnimationAdjustment = args.variables.vmafAnimationCQAdjustment || 0;
    
    // Helper function to escape CSV fields
    function escapeCsvField(field) {
        if (field === null || field === undefined) {
            return '';
        }
        var str = String(field);
        if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }
    
    // Helper function to calculate best parameters for each strategy
    function calculateBestForStrategy(results, strategy, minVMAF) {
        if (!results || results.length === 0) return null;
        
        var validResults = results.filter(function(r) { return r.avgVMAF >= minVMAF; });
        if (validResults.length === 0) return null;
        
        var best = null;
        var bestScore = -1;
        
        if (strategy === 'quality' || strategy === 'pareto-quality') {
            best = validResults.reduce(function(prev, curr) {
                return curr.avgVMAF > prev.avgVMAF ? curr : prev;
            }, validResults[0]);
        } else if (strategy === 'size' || strategy === 'pareto-size') {
            best = validResults.reduce(function(prev, curr) {
                return curr.avgFileSizeMB < prev.avgFileSizeMB ? curr : prev;
            }, validResults[0]);
        } else if (strategy === 'efficiency' || strategy === 'pareto-efficiency') {
            best = validResults.reduce(function(prev, curr) {
                var prevEff = prev.avgVMAF / prev.avgFileSizeMB;
                var currEff = curr.avgVMAF / curr.avgFileSizeMB;
                return currEff > prevEff ? curr : prev;
            }, validResults[0]);
        } else if (strategy === 'balanced') {
            best = validResults.reduce(function(prev, curr) {
                var prevScore = (prev.avgVMAF * prev.avgVMAF) / prev.avgFileSizeMB;
                var currScore = (curr.avgVMAF * curr.avgVMAF) / curr.avgFileSizeMB;
                return currScore > prevScore ? curr : prev;
            }, validResults[0]);
        } else {
            // Default to efficiency
            best = validResults.reduce(function(prev, curr) {
                var prevEff = prev.avgVMAF / prev.avgFileSizeMB;
                var currEff = curr.avgVMAF / curr.avgFileSizeMB;
                return currEff > prevEff ? curr : prev;
            }, validResults[0]);
        }
        
        return best;
    }
    
    // Calculate best parameters for all strategies
    var allStrategies = ['pareto-efficiency', 'pareto-quality', 'pareto-size', 'efficiency-curve', 'pareto-efficiency-curve', 'diminishing-returns', 'balanced', 'quality', 'size', 'efficiency'];
    var strategySelections = {};
    for (var s = 0; s < allStrategies.length; s++) {
        var strat = allStrategies[s];
        var bestForStrat = calculateBestForStrategy(aggregatedResults, strat, minVMAF);
        if (bestForStrat) {
            strategySelections[strat] = {
                parameterSetId: bestForStrat.parameterSetId,
                vmaf: bestForStrat.avgVMAF,
                size: bestForStrat.avgFileSizeMB,
                efficiency: bestForStrat.avgVMAF / bestForStrat.avgFileSizeMB,
            };
        }
    }
    
    // Find the parameterSetId for the selected bestParams
    var selectedParamSetId = '';
    if (bestParams) {
        // Try to find matching parameterSetId from aggregatedResults
        for (var a = 0; a < aggregatedResults.length; a++) {
            var agg = aggregatedResults[a];
            if (agg.parameterSet && JSON.stringify(agg.parameterSet) === JSON.stringify(bestParams)) {
                selectedParamSetId = agg.parameterSetId;
                break;
            }
        }
        // DATA CONSISTENCY FIX #21: More robust parameter set matching
        if (!selectedParamSetId) {
            for (var a2 = 0; a2 < aggregatedResults.length; a2++) {
                var agg2 = aggregatedResults[a2];
                if (agg2.parameterSet) {
                    // Match by key fields: preset, quality/cq, pixFmt
                    var presetMatch = agg2.parameterSet.preset === bestParams.preset;
                    var qualityMatch = (agg2.parameterSet.quality === bestParams.quality || 
                                      agg2.parameterSet.cq === bestParams.quality ||
                                      agg2.parameterSet.quality === bestParams.cq ||
                                      agg2.parameterSet.cq === bestParams.cq);
                    var pixFmtMatch = (!agg2.parameterSet.pixFmt && !bestParams.pixFmt) ||
                                     (agg2.parameterSet.pixFmt === bestParams.pixFmt);
                    
                    if (presetMatch && qualityMatch && pixFmtMatch) {
                        selectedParamSetId = agg2.parameterSetId;
                        break;
                    }
                }
            }
        }
    }
    
    // Build CSV content
    var csvLines = [];
    
    // Header row
    var headers = [
        'timestamp',
        'file_path', 'file_name', 'file_size_mb', 'duration_seconds',
        'video_codec', 'video_width', 'video_height', 'video_bitrate', 'pixel_format', 'frame_rate',
        'color_primaries', 'color_trc', 'colorspace', 'is_hdr',
        'media_genre', 'media_is_animation', 'media_type', 'media_year', 'media_metadata_source', 'media_source_type', 'release_group',
        'vmaf_trend_vmaf_drop_per_cq', 'vmaf_trend_cq_increment_used',
        'source_bits_per_pixel', 'source_duration_minutes',
        'dynamic_cq_adjustment_genre', 'dynamic_cq_adjustment_animation',
        'parameter_set_id', 'parameter_set_json',
        'preset', 'cq', 'tune', 'multipass', 'spatial_aq', 'temporal_aq', 'aq_strength',
        'sample_index', 'sample_vmaf_score', 'sample_vmaf_mean', 'sample_vmaf_harmonic_mean', 'sample_vmaf_min', 'sample_vmaf_max', 'sample_file_size_mb',
        'aggregated_vmaf_harmonic_mean', 'aggregated_vmaf_mean', 'aggregated_vmaf_min', 'aggregated_vmaf_max', 'aggregated_avg_size_mb', 'aggregated_sample_count', 'aggregated_vmaf_stddev', 'aggregated_vmaf_mean_min_gap',
        'selected_strategy', 'selected_parameter_set_id', 'selected_vmaf', 'selected_vmaf_min', 'selected_size_mb',
        'strategy_pareto_efficiency_id', 'strategy_pareto_efficiency_vmaf', 'strategy_pareto_efficiency_size',
        'strategy_pareto_quality_id', 'strategy_pareto_quality_vmaf', 'strategy_pareto_quality_size',
        'strategy_pareto_size_id', 'strategy_pareto_size_vmaf', 'strategy_pareto_size_size',
        'strategy_efficiency_curve_id', 'strategy_efficiency_curve_vmaf', 'strategy_efficiency_curve_size',
        'strategy_balanced_id', 'strategy_balanced_vmaf', 'strategy_balanced_size',
        'strategy_quality_id', 'strategy_quality_vmaf', 'strategy_quality_size',
        'strategy_size_id', 'strategy_size_vmaf', 'strategy_size_size',
        'strategy_efficiency_id', 'strategy_efficiency_vmaf', 'strategy_efficiency_size',
        'cq_range_retry_count', 'cq_range_retry_history',
        'transcode_retry_count', 'transcode_retry_history',
        'sweep_retry_count', 'sweep_retry_history',
        'transcode_failures_count', 'transcode_failures_reasons',
    ];
    csvLines.push(headers.map(escapeCsvField).join(','));
    
    // Data rows - one row per VMAF result
    var timestamp = new Date().toISOString();
    for (var i = 0; i < vmafResults.length; i++) {
        var result = vmafResults[i];
        // Get parameter set from result or lookup map
        var paramSet = result.parameterSet || paramSetMap[result.parameterSetId] || {};
        
        var row = [
            timestamp,
            fileMetadata.filePath,
            fileMetadata.fileName,
            fileMetadata.fileSize,
            fileMetadata.duration,
            fileMetadata.videoCodec,
            fileMetadata.videoWidth,
            fileMetadata.videoHeight,
            fileMetadata.videoBitrate,
            fileMetadata.pixelFormat,
            fileMetadata.frameRate,
            fileMetadata.colorPrimaries,
            fileMetadata.colorTrc,
            fileMetadata.colorspace,
            fileMetadata.isHDR,
            mediaGenresString,
            mediaIsAnimation,
            mediaType,
            mediaYear,
            mediaMetadataSource,
            mediaSourceType,
            releaseGroup,
            trendDropPerCQ,
            trendIncrementUsed,
            sourceBitsPerPixel,
            sourceDurationMinutes,
            dynamicGenreAdjustment,
            dynamicAnimationAdjustment,
            result.parameterSetId || '',
            JSON.stringify(result.parameterSet || {}),
            paramSet.preset || '',
            paramSet.cq || paramSet.quality || '',
            paramSet.tune || '',
            paramSet.multipass || '',
            paramSet.spatial_aq || '',
            paramSet.temporal_aq || '',
            paramSet.aq_strength || '',
            result.sampleIndex !== undefined ? (result.sampleIndex + 1) : '',
            result.vmafScore || '',
            result.vmafMean || '',
            result.vmafHarmonicMean || '',
            result.vmafMin || '',
            result.vmafMax || '',
            result.fileSizeMB || '',
            '', // aggregated_vmaf_harmonic_mean - will fill from aggregated results
            '', // aggregated_vmaf_mean
            '', // aggregated_vmaf_min
            '', // aggregated_vmaf_max
            '', // aggregated_avg_size_mb
            '', // aggregated_sample_count
            '', // aggregated_vmaf_stddev
            '', // aggregated_vmaf_mean_min_gap
            strategy,
            selectedParamSetId,
            bestVMAF || '',
            args.variables.vmafBestMinVMAF || '',
            bestSize || '',
            strategySelections['pareto-efficiency'] ? strategySelections['pareto-efficiency'].parameterSetId : '',
            strategySelections['pareto-efficiency'] ? strategySelections['pareto-efficiency'].vmaf : '',
            strategySelections['pareto-efficiency'] ? strategySelections['pareto-efficiency'].size : '',
            strategySelections['pareto-quality'] ? strategySelections['pareto-quality'].parameterSetId : '',
            strategySelections['pareto-quality'] ? strategySelections['pareto-quality'].vmaf : '',
            strategySelections['pareto-quality'] ? strategySelections['pareto-quality'].size : '',
            strategySelections['pareto-size'] ? strategySelections['pareto-size'].parameterSetId : '',
            strategySelections['pareto-size'] ? strategySelections['pareto-size'].vmaf : '',
            strategySelections['pareto-size'] ? strategySelections['pareto-size'].size : '',
            strategySelections['efficiency-curve'] ? strategySelections['efficiency-curve'].parameterSetId : '',
            strategySelections['efficiency-curve'] ? strategySelections['efficiency-curve'].vmaf : '',
            strategySelections['efficiency-curve'] ? strategySelections['efficiency-curve'].size : '',
            strategySelections['balanced'] ? strategySelections['balanced'].parameterSetId : '',
            strategySelections['balanced'] ? strategySelections['balanced'].vmaf : '',
            strategySelections['balanced'] ? strategySelections['balanced'].size : '',
            strategySelections['quality'] ? strategySelections['quality'].parameterSetId : '',
            strategySelections['quality'] ? strategySelections['quality'].vmaf : '',
            strategySelections['quality'] ? strategySelections['quality'].size : '',
            strategySelections['size'] ? strategySelections['size'].parameterSetId : '',
            strategySelections['size'] ? strategySelections['size'].vmaf : '',
            strategySelections['size'] ? strategySelections['size'].size : '',
            strategySelections['efficiency'] ? strategySelections['efficiency'].parameterSetId : '',
            strategySelections['efficiency'] ? strategySelections['efficiency'].vmaf : '',
            strategySelections['efficiency'] ? strategySelections['efficiency'].size : '',
            retryCount,
            cqRangeRetryHistory.length > 0 ? JSON.stringify(cqRangeRetryHistory) : '',
            transcodeRetryCount,
            transcodeRetryHistory.length > 0 ? JSON.stringify(transcodeRetryHistory) : '',
            sweepRetryHistory.length,
            sweepRetryHistory.length > 0 ? JSON.stringify(sweepRetryHistory) : '',
            transcodeFailures.length,
            transcodeFailures.length > 0 ? transcodeFailures.map(function(f) { return f.reason || 'unknown'; }).join(';') : '',
        ];
        
        // Fill in aggregated data if available
        for (var a = 0; a < aggregatedResults.length; a++) {
            if (aggregatedResults[a].parameterSetId === result.parameterSetId) {
                // aggregated_* columns start at index 43 (see headers)
                row[43] = aggregatedResults[a].avgVMAF; // harmonic mean (legacy name)
                row[44] = aggregatedResults[a].avgVMAFMean || '';
                row[45] = aggregatedResults[a].minVMAF || '';
                row[46] = aggregatedResults[a].maxVMAF || '';
                row[47] = aggregatedResults[a].avgFileSizeMB;
                row[48] = aggregatedResults[a].sampleCount;
                row[49] = aggregatedResults[a].vmafStdDev || '';
                var _mean = aggregatedResults[a].avgVMAFMean;
                var _min = aggregatedResults[a].minVMAF;
                row[50] = (typeof _mean === 'number' && typeof _min === 'number') ? Math.max(0, _mean - _min) : '';
                break;
            }
        }
        
        csvLines.push(row.map(escapeCsvField).join(','));
    }
    
    // If no individual results, create rows from aggregated results
    if (vmafResults.length === 0 && aggregatedResults.length > 0) {
        for (var a = 0; a < aggregatedResults.length; a++) {
            var aggResult = aggregatedResults[a];
            var paramSet2 = aggResult.parameterSet || {};
            
            var row2 = [
                timestamp,
                fileMetadata.filePath,
                fileMetadata.fileName,
                fileMetadata.fileSize,
                fileMetadata.duration,
                fileMetadata.videoCodec,
                fileMetadata.videoWidth,
                fileMetadata.videoHeight,
                fileMetadata.videoBitrate,
                fileMetadata.pixelFormat,
                fileMetadata.frameRate,
                fileMetadata.colorPrimaries,
                fileMetadata.colorTrc,
                fileMetadata.colorspace,
                fileMetadata.isHDR,
                mediaGenresString,
                mediaIsAnimation,
                mediaType,
                mediaYear,
                mediaMetadataSource,
                releaseGroup,
                trendDropPerCQ,
                trendIncrementUsed,
                sourceBitsPerPixel,
                sourceDurationMinutes,
                dynamicGenreAdjustment,
                dynamicAnimationAdjustment,
                aggResult.parameterSetId || '',
                JSON.stringify(aggResult.parameterSet || {}),
                paramSet2.preset || '',
                paramSet2.cq || paramSet2.quality || '',
                paramSet2.tune || '',
                paramSet2.multipass || '',
                paramSet2.spatial_aq || '',
                paramSet2.temporal_aq || '',
                paramSet2.aq_strength || '',
                '', // sample_index
                '', // sample_vmaf_score
                '', // sample_vmaf_mean
                '', // sample_vmaf_harmonic_mean
                '', // sample_vmaf_min
                '', // sample_vmaf_max
                '', // sample_file_size_mb
                aggResult.avgVMAF || '', // harmonic mean
                aggResult.avgVMAFMean || '',
                aggResult.minVMAF || '',
                aggResult.maxVMAF || '',
                aggResult.avgFileSizeMB || '',
                aggResult.sampleCount || '',
                aggResult.vmafStdDev || '',
                (typeof aggResult.avgVMAFMean === 'number' && typeof aggResult.minVMAF === 'number') ? Math.max(0, aggResult.avgVMAFMean - aggResult.minVMAF) : '',
                strategy,
                selectedParamSetId,
                bestVMAF || '',
                args.variables.vmafBestMinVMAF || '',
                bestSize || '',
                strategySelections['pareto-efficiency'] ? strategySelections['pareto-efficiency'].parameterSetId : '',
                strategySelections['pareto-efficiency'] ? strategySelections['pareto-efficiency'].vmaf : '',
                strategySelections['pareto-efficiency'] ? strategySelections['pareto-efficiency'].size : '',
                strategySelections['pareto-quality'] ? strategySelections['pareto-quality'].parameterSetId : '',
                strategySelections['pareto-quality'] ? strategySelections['pareto-quality'].vmaf : '',
                strategySelections['pareto-quality'] ? strategySelections['pareto-quality'].size : '',
                strategySelections['pareto-size'] ? strategySelections['pareto-size'].parameterSetId : '',
                strategySelections['pareto-size'] ? strategySelections['pareto-size'].vmaf : '',
                strategySelections['pareto-size'] ? strategySelections['pareto-size'].size : '',
                strategySelections['efficiency-curve'] ? strategySelections['efficiency-curve'].parameterSetId : '',
                strategySelections['efficiency-curve'] ? strategySelections['efficiency-curve'].vmaf : '',
                strategySelections['efficiency-curve'] ? strategySelections['efficiency-curve'].size : '',
                strategySelections['balanced'] ? strategySelections['balanced'].parameterSetId : '',
                strategySelections['balanced'] ? strategySelections['balanced'].vmaf : '',
                strategySelections['balanced'] ? strategySelections['balanced'].size : '',
                strategySelections['quality'] ? strategySelections['quality'].parameterSetId : '',
                strategySelections['quality'] ? strategySelections['quality'].vmaf : '',
                strategySelections['quality'] ? strategySelections['quality'].size : '',
                strategySelections['size'] ? strategySelections['size'].parameterSetId : '',
                strategySelections['size'] ? strategySelections['size'].vmaf : '',
                strategySelections['size'] ? strategySelections['size'].size : '',
            strategySelections['efficiency'] ? strategySelections['efficiency'].parameterSetId : '',
            strategySelections['efficiency'] ? strategySelections['efficiency'].vmaf : '',
            strategySelections['efficiency'] ? strategySelections['efficiency'].size : '',
            retryCount,
            cqRangeRetryHistory.length > 0 ? JSON.stringify(cqRangeRetryHistory) : '',
            transcodeRetryCount,
            transcodeRetryHistory.length > 0 ? JSON.stringify(transcodeRetryHistory) : '',
            sweepRetryHistory.length,
            sweepRetryHistory.length > 0 ? JSON.stringify(sweepRetryHistory) : '',
            transcodeFailures.length,
            transcodeFailures.length > 0 ? transcodeFailures.map(function(f) { return f.reason || 'unknown'; }).join(';') : '',
            ];
            csvLines.push(row2.map(escapeCsvField).join(','));
        }
    }
    
    // Write CSV file (append mode)
    try {
        // Ensure directory exists
        var dirPath = path.dirname(csvPath);
        if (!fs.existsSync(dirPath)) {
            try {
                fs.mkdirSync(dirPath, { recursive: true, mode: 0o755 });
                args.jobLog('Created directory: ' + dirPath);
            } catch (mkdirErr) {
                args.jobLog('Warning: Could not create directory ' + dirPath + ': ' + mkdirErr.message);
            }
        }
        
        var csvContent = csvLines.join('\n') + '\n';
        var fileExists = fs.existsSync(csvPath);
        
        if (fileExists) {
            // Append to existing file (without header if file exists)
            fs.appendFileSync(csvPath, csvContent.split('\n').slice(1).join('\n'));
            args.jobLog('Appended VMAF results to existing CSV: ' + csvPath);
        } else {
            // Create new file with header
            fs.writeFileSync(csvPath, csvContent, { mode: 0o644 });
            args.jobLog('Created new CSV file with VMAF results: ' + csvPath);
        }
        
        args.jobLog('Exported ' + (vmafResults.length || aggregatedResults.length) + ' result rows to CSV');
        args.jobLog('CSV file location: ' + csvPath);
    } catch (err) {
        args.jobLog('Error writing CSV file: ' + err.message);
        args.jobLog('CSV path: ' + csvPath);
        args.jobLog('Directory exists: ' + fs.existsSync(path.dirname(csvPath)));
        args.jobLog('File exists: ' + fs.existsSync(csvPath));
        
        // Try alternative path in /temp (cache directory) if configs fails
        if (csvPath.indexOf('/app/configs') === 0) {
            var altPath = csvPath.replace('/app/configs', '/temp');
            args.jobLog('Attempting alternative path: ' + altPath);
            try {
                var altDirPath = path.dirname(altPath);
                if (!fs.existsSync(altDirPath)) {
                    fs.mkdirSync(altDirPath, { recursive: true, mode: 0o755 });
                }
                var csvContent = csvLines.join('\n') + '\n';
                var fileExists = fs.existsSync(altPath);
                if (fileExists) {
                    fs.appendFileSync(altPath, csvContent.split('\n').slice(1).join('\n'));
                } else {
                    fs.writeFileSync(altPath, csvContent, { mode: 0o644 });
                }
                args.jobLog('Successfully exported to alternative path: ' + altPath);
                args.jobLog('Note: Original path failed due to permissions. Using cache directory instead.');
            } catch (altErr) {
                args.jobLog('Alternative path also failed: ' + altErr.message);
                // Don't throw - just log the error and continue
                args.jobLog('WARNING: Could not export VMAF results to CSV. Continuing without export.');
            }
        } else {
            // For other paths, just log and continue
            args.jobLog('WARNING: Could not export VMAF results to CSV. Continuing without export.');
        }
    }

    // FFmpeg 8.1/libvmaf 3.1 runtime sidecar export. Keep this separate from the long-lived
    // legacy CSV so older historical rows/header don't need an 80MB schema migration.
    try {
        var runtimeCsvPath = '/app/configs/vmaf_results_runtime.csv';
        var runtimeHeaders = [
            'timestamp', 'file_path', 'file_name', 'parameter_set_id', 'sample_index',
            'vmaf_method', 'vmaf_model_name', 'vmaf_model_path', 'ffmpeg_version', 'libvmaf_version',
            'gpu_vmaf_available', 'gpu_vmaf_used', 'sample_vmaf_score', 'sample_vmaf_mean', 'sample_vmaf_min', 'sample_vmaf_max'
        ];
        var runtimeRows = [];
        var modelName = args.variables.vmafModelName || '';
        var modelPath = args.variables.vmafModelPath || '';
        var ffmpegVersion = args.variables.vmafFfmpegVersion || '';
        var libvmafVersion = args.variables.vmafLibvmafVersion || '';
        var gpuAvailable = args.variables.vmafGpuAccelerated === true;
        var gpuUsed = args.variables.vmafUsedGpuVmaf === true;
        for (var rr = 0; rr < vmafResults.length; rr++) {
            var vr = vmafResults[rr];
            runtimeRows.push([
                timestamp,
                fileMetadata.filePath,
                fileMetadata.fileName,
                vr.parameterSetId || '',
                vr.sampleIndex !== undefined ? (vr.sampleIndex + 1) : '',
                vr.vmafMethod || '',
                modelName,
                vr.vmafModelPath || modelPath,
                ffmpegVersion,
                libvmafVersion,
                gpuAvailable,
                gpuUsed,
                vr.vmafScore || '',
                vr.vmafMean || '',
                vr.vmafMin || '',
                vr.vmafMax || ''
            ]);
        }
        if (runtimeRows.length > 0) {
            var runtimeExists = fs.existsSync(runtimeCsvPath);
            var runtimeContent = '';
            if (!runtimeExists) {
                runtimeContent += runtimeHeaders.map(escapeCsvField).join(',') + '\n';
            }
            runtimeContent += runtimeRows.map(function(row) { return row.map(escapeCsvField).join(','); }).join('\n') + '\n';
            fs.appendFileSync(runtimeCsvPath, runtimeContent);
            args.jobLog('Exported FFmpeg/libvmaf runtime metrics to: ' + runtimeCsvPath);
        }
    } catch (runtimeErr) {
        args.jobLog('WARNING: Could not export FFmpeg/libvmaf runtime metrics sidecar CSV: ' + runtimeErr.message);
    }
    
    // ── Unified SQLite training store (dual-write alongside the CSV) ──
    // Writes the per-CQ sweep curve INCLUDING CAMBI (new signal) plus the job's source +
    // decision facts. Keyed by the shared vmafJobId so learnCQRange can later attach the
    // final outcome to the same row. Non-fatal: a DB failure never breaks the flow.
    try {
        var vmafdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
        var _db = vmafdb.openDb();
        // Derive the job id from the REAL file path + the shared start-time nonce. (The seed in
        // extractVideoSamples can see an empty inputFile._id -> a constant empty-string hash; here
        // the path is reliable, and learnCQRange derives it identically, so they still unify.)
        var _jobId = fileMetadata.filePath
            ? vmafdb.makeJobId(fileMetadata.filePath, args.variables.vmafJobStartTime || '')
            : (args.variables.vmafJobId || vmafdb.makeJobId('', args.variables.vmafJobStartTime || ''));
        function _bitDepth(pf) {
            if (!pf) return null; pf = String(pf).toLowerCase();
            if (pf.indexOf('12le') !== -1 || pf.indexOf('12be') !== -1 || pf.indexOf('p012') !== -1) return 12;
            if (pf.indexOf('10le') !== -1 || pf.indexOf('10be') !== -1 || pf.indexOf('p010') !== -1 || pf.indexOf('yuv420p10') !== -1) return 10;
            return 8;
        }
        vmafdb.upsertJob(_db, {
            job_id: _jobId,
            timestamp: timestamp,
            file_path: fileMetadata.filePath,
            file_name: fileMetadata.fileName,
            source_codec: fileMetadata.videoCodec,
            source_width: fileMetadata.videoWidth,
            source_height: fileMetadata.videoHeight,
            bits_per_pixel: Number(sourceBitsPerPixel) || null,
            source_duration_sec: Number(fileMetadata.duration) || null,
            pixel_format: fileMetadata.pixelFormat,
            bit_depth: _bitDepth(fileMetadata.pixelFormat),
            is_hdr: fileMetadata.isHDR ? 1 : 0,
            color_primaries: fileMetadata.colorPrimaries,
            color_trc: fileMetadata.colorTrc,
            colorspace: fileMetadata.colorspace,
            tier: vmafdb.tierFor(fileMetadata.videoWidth, fileMetadata.videoHeight),
            media_genre: mediaGenresString,
            media_is_animation: mediaIsAnimation ? 1 : 0,
            media_type: mediaType,
            media_year: parseInt(mediaYear) || null,
            media_metadata_source: mediaMetadataSource,
            media_source_type: mediaSourceType,
            release_group: releaseGroup,
            network: args.variables.vmafNetwork || null,
            original_language: args.variables.vmafOriginalLanguage || null,
            source_cambi: (args.variables.vmafSourceCAMBI != null ? Number(args.variables.vmafSourceCAMBI) : null),
            source_cambi_p95: (args.variables.vmafSourceCAMBIP95 != null ? Number(args.variables.vmafSourceCAMBIP95) : null),
            grain: (args.variables.vmafSourceGrain != null ? Number(args.variables.vmafSourceGrain) : null),
            spatial_info: (args.variables.vmafSourceSI != null ? Number(args.variables.vmafSourceSI) : null),
            temporal_info: (args.variables.vmafSourceTI != null ? Number(args.variables.vmafSourceTI) : null),
            dark_fraction: (args.variables.vmafSourceDarkFrac != null ? Number(args.variables.vmafSourceDarkFrac) : null),
            luma_avg: (args.variables.vmafSourceLumaAvg != null ? Number(args.variables.vmafSourceLumaAvg) : null),
            target_min_vmaf: Number(args.variables.vmafMinVMAF) || null,
            selected_parameter_set_id: args.variables.vmafSelectedParameterSetId || (bestParams && bestParams.parameterSetId) || '',
            selected_vmaf: Number(bestVMAF) || null,
            selected_vmaf_min: Number(args.variables.vmafBestMinVMAF) || null,
            selected_size_mb: Number(bestSize) || null
        });
        var _pts = [];
        for (var _ai = 0; _ai < aggregatedResults.length; _ai++) {
            var _ar = aggregatedResults[_ai] || {};
            var _ps = _ar.parameterSet || {};
            _pts.push({
                parameter_set_id: _ar.parameterSetId || '',
                cq: Number(_ps.cq != null ? _ps.cq : _ps.quality) || null,
                preset: _ps.preset || null,
                tune: _ps.tune || null,
                multipass: _ps.multipass != null ? String(_ps.multipass) : null,
                spatial_aq: _ps.spatial_aq != null ? String(_ps.spatial_aq) : null,
                temporal_aq: _ps.temporal_aq != null ? String(_ps.temporal_aq) : null,
                aq_strength: _ps.aq_strength != null ? String(_ps.aq_strength) : null,
                vmaf_mean: _ar.avgVMAFMean != null ? Number(_ar.avgVMAFMean) : (Number(_ar.avgVMAF) || null),
                vmaf_harmonic_mean: Number(_ar.avgVMAF) || null,
                vmaf_min: Number(_ar.minVMAF) || null,
                vmaf_max: Number(_ar.maxVMAF) || null,
                vmaf_p1_low: _ar.vmafP1Low != null ? Number(_ar.vmafP1Low) : null,
                vmaf_stddev: _ar.vmafStdDev != null ? Number(_ar.vmafStdDev) : null,
                ssim: _ar.avgSSIM != null ? Number(_ar.avgSSIM) : null,
                cambi_mean: _ar.avgCAMBI != null ? Number(_ar.avgCAMBI) : null,
                cambi_max: _ar.maxCAMBI != null ? Number(_ar.maxCAMBI) : null,
                cambi_p95: _ar.p95CAMBI != null ? Number(_ar.p95CAMBI) : null,
                avg_size_mb: Number(_ar.avgFileSizeMB) || null,
                sample_count: parseInt(_ar.sampleCount) || null
            });
        }
        var _n = vmafdb.insertSweepPoints(_db, _jobId, _pts);
        args.jobLog('SQLite training store: job ' + _jobId + ' + ' + _n + ' sweep points (CAMBI included)');
    } catch (dbErr) {
        args.jobLog('WARNING: SQLite training-store write failed (non-fatal): ' + (dbErr && dbErr.message ? dbErr.message : String(dbErr)));
    }

    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
