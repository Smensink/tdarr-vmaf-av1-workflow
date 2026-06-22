"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
/* eslint no-plusplus: ["error", { "allowForLoopAfterthoughts": true }] */
var fs = require("fs");

var details = function () { return ({
    name: 'Check File Age',
    description: 'Filter files by age. Files younger than the specified threshold (default: 30 days) will cause the flow to fail. '
        + 'Useful for preventing transcoding of recently added files.',
    style: {
        borderColor: 'orange',
    },
    tags: 'filter,video,audio',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faQuestion',
    inputs: [
        {
            label: 'Minimum Age (Days)',
            name: 'minAgeDays',
            type: 'number',
            defaultValue: '30',
            inputUI: {
                type: 'text',
            },
            tooltip: 'Minimum age in days a file must be before processing. Default is 30 (1 month).',
        },
        {
            label: 'Date Type',
            name: 'dateType',
            type: 'string',
            defaultValue: 'creation',
            inputUI: {
                type: 'dropdown',
                options: [
                    'creation',
                    'modification',
                    'tdarr-added',
                ],
            },
            tooltip: 'Which date to use for age calculation: creation (file system birthtime), modification (file system mtime), or tdarr-added (when Tdarr first discovered the file).',
        },
    ],
    outputs: [
        {
            number: 1,
            tooltip: 'File is old enough (>= threshold) - proceed with processing',
        },
    ],
}); };
exports.details = details;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
var plugin = function (args) {
    try {
        var lib = require('../../../../../methods/lib')();
        // eslint-disable-next-line @typescript-eslint/no-unused-vars,no-param-reassign
        args.inputs = lib.loadDefaultValues(args.inputs, details);

        // Get the minimum age from user input, ensuring it's a valid number
        var inputMinAge = args.inputs.minAgeDays;
        args.jobLog("DEBUG: Raw input value for minAgeDays: ".concat(JSON.stringify(inputMinAge), " (type: ").concat(typeof inputMinAge, ")"));

        var minAgeDays = 30; // Default fallback

        if (inputMinAge !== undefined && inputMinAge !== null && inputMinAge !== '') {
            var parsed = Number(inputMinAge);
            if (!isNaN(parsed) && parsed > 0) {
                minAgeDays = parsed;
                args.jobLog("DEBUG: Using user-provided minimum age: ".concat(minAgeDays, " days"));
            } else {
                args.jobLog("WARNING: Invalid minAgeDays input value (".concat(inputMinAge, "), using default 30 days"));
            }
        } else {
            args.jobLog("DEBUG: No user input provided, using default minimum age: 30 days");
        }

        var minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;

        args.jobLog("Check File Age: Starting age check (minimum: ".concat(minAgeDays, " days, date type: ").concat(args.inputs.dateType || 'creation', ")"));

        // Try to use Tdarr's statSync first (more reliable), fallback to fs.statSync
        var stats = null;
        try {
            if (args.originalLibraryFile && args.originalLibraryFile.statSync) {
                stats = args.originalLibraryFile.statSync;
                args.jobLog("Using originalLibraryFile.statSync for age calculation");
            } else {
                var filePath = args.inputFileObj._id;
                stats = fs.statSync(filePath);
                args.jobLog("Using fs.statSync for age calculation");
            }
        } catch (err) {
            args.jobLog("Error getting file stats: ".concat(err.message));
            throw new Error("Could not get file stats: ".concat(err.message));
        }

        // Get the appropriate date based on user selection
        var fileDate;
        var dateUsed = args.inputs.dateType || 'creation';

        if (args.inputs.dateType === 'tdarr-added') {
            // Use Tdarr's createdAt timestamp (when file was first discovered/added to library)
            var createdAt = null;

            // Extract createdAt value from either location
            if (args.originalLibraryFile && args.originalLibraryFile.createdAt) {
                createdAt = args.originalLibraryFile.createdAt;
            } else if (args.originalLibraryFile && args.originalLibraryFile.sourceFile && args.originalLibraryFile.sourceFile.createdAt) {
                createdAt = args.originalLibraryFile.sourceFile.createdAt;
            }

            // Validate createdAt is a valid number (milliseconds timestamp)
            if (createdAt && typeof createdAt === 'number' && createdAt > 0 && createdAt < Date.now() + 86400000) {
                // createdAt should be a reasonable timestamp (not in the far future)
                fileDate = createdAt;
                dateUsed = 'tdarr-added';
                args.jobLog("Using Tdarr library createdAt timestamp for age calculation: " + new Date(createdAt).toISOString());
            } else {
                // Fallback to file system dates if createdAt not available or invalid
                args.jobLog("WARNING: Tdarr createdAt not available or invalid (" + (createdAt ? typeof createdAt + ": " + createdAt : "missing") + "), falling back to file system creation date");
                if (stats.birthtimeMs && stats.birthtimeMs > 0) {
                    fileDate = stats.birthtimeMs;
                    dateUsed = 'creation (fallback)';
                } else if (stats.birthtime && new Date(stats.birthtime).getTime() > 0) {
                    fileDate = new Date(stats.birthtime).getTime();
                    dateUsed = 'creation (fallback)';
                } else {
                    fileDate = stats.ctimeMs || new Date(stats.ctime).getTime();
                    dateUsed = 'ctime (fallback)';
                }
            }
        } else if (args.inputs.dateType === 'modification') {
            fileDate = stats.mtimeMs || stats.mtime;
            if (!fileDate || fileDate <= 0) {
                args.jobLog("WARNING: mtime not available, falling back to ctime");
                fileDate = stats.ctimeMs || new Date(stats.ctime).getTime();
                dateUsed = 'ctime (fallback)';
            }
        } else {
            // Default to creation (birthtime)
            // Use birthtime if available, otherwise fallback to ctime
            if (stats.birthtimeMs && stats.birthtimeMs > 0) {
                fileDate = stats.birthtimeMs;
            } else if (stats.birthtime && new Date(stats.birthtime).getTime() > 0) {
                fileDate = new Date(stats.birthtime).getTime();
            } else {
                // Fallback to ctime if birthtime is not available or invalid
                fileDate = stats.ctimeMs || new Date(stats.ctime).getTime();
                dateUsed = 'ctime (fallback)';
                args.jobLog("Warning: birthtime not available, using ctime for age calculation");
            }
        }

        // Calculate file age
        var now = Date.now();
        var fileAgeMs = now - fileDate;
        var ageDays = fileAgeMs / (24 * 60 * 60 * 1000);

        // Validate calculated age (should be positive and reasonable)
        if (fileAgeMs < 0) {
            args.jobLog("WARNING: File date is in the future (age calculation negative). Using file date as-is.");
            fileAgeMs = Math.abs(fileAgeMs); // Treat as positive for comparison
            ageDays = Math.abs(ageDays);
        }

        // Log detailed information
        args.jobLog("File ".concat(dateUsed, " date: ").concat(new Date(fileDate).toISOString()));
        args.jobLog("File age: ".concat(ageDays.toFixed(1), " days (minimum required: ").concat(minAgeDays, " days)"));

        // Check if file is old enough
        var isOldEnough = fileAgeMs >= minAgeMs;

        if (!isOldEnough) {
            var daysRemaining = minAgeDays - ageDays;
            var errorMessage = "File is too young (".concat(ageDays.toFixed(1), " days old, minimum: ").concat(minAgeDays, " days). Will be eligible in ").concat(daysRemaining.toFixed(1), " days.");
            args.jobLog(errorMessage);
            args.jobLog("Failing flow - file must be at least ".concat(minAgeDays, " days old before processing."));

            // Track too-young files for later requeue
            if (!args.variables.tooYoungFiles) {
                args.variables.tooYoungFiles = [];
            }
            var eligibleAt = new Date(fileDate + minAgeMs).toISOString();
            var record = {
                file: args.inputFileObj._id,
                minAgeDays: minAgeDays,
                currentAgeDays: parseFloat(ageDays.toFixed(2)),
                eligibleAt: eligibleAt,
                dateTypeUsed: dateUsed
            };
            args.variables.tooYoungFiles.push(record);

            // Optional persistent record in /app/configs/too_young_files.json (best-effort)
            var recordPath = '/app/configs/too_young_files.json';
            try {
                var existing = [];
                if (fs.existsSync(recordPath)) {
                    var raw = fs.readFileSync(recordPath, 'utf8');
                    existing = JSON.parse(raw);
                    if (!Array.isArray(existing)) existing = [];
                }
                // avoid duplicates
                var dedup = existing.filter(function(entry) { return entry && entry.file !== record.file; });
                dedup.push(record);
                fs.writeFileSync(recordPath, JSON.stringify(dedup, null, 2));
                args.jobLog("Recorded too-young file for later requeue: ".concat(record.file));
            } catch (writeErr) {
                args.jobLog("WARNING: Could not persist too-young list: ".concat(writeErr.message));
            }

            throw new Error(errorMessage);
        } else {
            args.jobLog("File age OK (".concat(ageDays.toFixed(1), " days old). Proceeding with processing."));
        }

        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    } catch (err) {
        // If it's our intentional failure (file too young), re-throw it
        if (err.message && err.message.includes("File is too young")) {
            throw err;
        }
        // For other errors (like file stats issues), log and fail
        args.jobLog("Check File Age ERROR: ".concat(err.message));
        args.jobLog("Stack: ".concat(err.stack));
        args.jobLog("Failing flow due to error checking file age");
        throw new Error("Check File Age plugin error: ".concat(err.message));
    }
};
exports.plugin = plugin;
