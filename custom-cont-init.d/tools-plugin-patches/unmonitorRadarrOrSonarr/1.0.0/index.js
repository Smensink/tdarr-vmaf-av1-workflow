"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var path = require("path");
var details = function () { return ({
    name: "Unmonitor in Radarr or Sonarr",
    description: "After a successful transcode+replace, verifies the Arr file identity, unmonitors the corresponding movie or episode(s)/series, and reads the result back.",
    style: {
        borderColor: "orange",
    },
    tags: "radarr,sonarr,arr,monitoring",
    isStartPlugin: false,
    pType: "",
    requiresVersion: "2.11.01",
    sidebarPosition: -1,
    icon: "faEyeSlash",
    inputs: [
        {
            label: "Arr",
            name: "arr",
            type: "string",
            defaultValue: "radarr",
            inputUI: {
                type: "dropdown",
                options: ["radarr", "sonarr"],
            },
            tooltip: "Specify which arr to use",
        },
        {
            label: "Arr API Key",
            name: "arr_api_key",
            type: "string",
            defaultValue: "",
            inputUI: { type: "text" },
            tooltip: "Input your arr api key here",
        },
        {
            label: "Arr Host",
            name: "arr_host",
            type: "string",
            defaultValue: "http://host.docker.internal:7878",
            inputUI: { type: "text" },
            tooltip: "Input your arr host here (Radarr :7878 / Sonarr :8989).",
        },
        {
            label: "Sonarr Unmonitor Scope",
            name: "sonarr_scope",
            type: "string",
            defaultValue: "episodes",
            inputUI: {
                type: "dropdown",
                options: ["episodes", "series"],
            },
            tooltip: "For Sonarr: unmonitor only the transcoded episode(s), or the entire series.",
        },
    ],
    outputs: [
        { number: 1, tooltip: "Identity verified and unmonitored" },
        { number: 2, tooltip: "Identity ambiguous, mutation unverified, or skipped" },
    ],
}); };
exports.details = details;
function normalizeHost(host) {
    var trimmed = String(host || "").trim();
    if (!trimmed)
        return "";
    try {
        var parsed = new URL(trimmed);
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
            parsed.username || parsed.password || parsed.search || parsed.hash) {
            return "";
        }
        return parsed.toString().replace(/\/+$/, "");
    }
    catch (_a) {
        return "";
    }
}
function requestJson(url, method, headers, body, timeoutMs) {
    return new Promise(function (resolve) {
        try {
            var http = url.startsWith("https://") ? require("https") : require("http");
            var payload = body ? JSON.stringify(body) : "";
            var settled_1 = false;
            var finish_1 = function (result) {
                if (settled_1)
                    return;
                settled_1 = true;
                resolve(result);
            };
            var req = http.request(url, {
                method: method,
                headers: Object.assign({}, headers, payload
                    ? {
                        "Content-Length": Buffer.byteLength(payload),
                    }
                    : {}),
                timeout: timeoutMs || 10000,
            }, function (res) {
                var chunks = [];
                var bytes = 0;
                var tooLarge = false;
                res.on("data", function (d) {
                    if (tooLarge)
                        return;
                    var chunk = Buffer.isBuffer(d) ? d : Buffer.from(d);
                    bytes += chunk.length;
                    if (bytes > 4 * 1024 * 1024) {
                        tooLarge = true;
                        try {
                            res.destroy();
                        }
                        catch (_a) { }
                        finish_1({ ok: false, status: res.statusCode || 0, data: null, error: "response_too_large" });
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on("end", function () {
                    if (tooLarge)
                        return;
                    var text = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
                    if (!text) {
                        finish_1({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: null });
                        return;
                    }
                    try {
                        var data = JSON.parse(text);
                        finish_1({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: data });
                    }
                    catch (_a) {
                        finish_1({ ok: false, status: res.statusCode, data: null, error: "invalid_json" });
                    }
                });
            });
            req.on("error", function () { return finish_1({ ok: false, status: 0, data: null, error: "request_error" }); });
            req.on("timeout", function () {
                try {
                    req.destroy();
                }
                catch (_a) { }
                finish_1({ ok: false, status: 0, data: null, error: "timeout" });
            });
            if (payload) {
                req.write(payload);
            }
            req.end();
        }
        catch (_a) {
            resolve({ ok: false, status: 0, data: null });
        }
    });
}
function portableBasename(filePath) {
    var normalized = String(filePath || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized.slice(normalized.lastIndexOf("/") + 1);
}
function normalizeComparablePath(filePath) {
    var raw = String(filePath || "").trim().replace(/\\/g, "/");
    if (!raw)
        return "";
    var normalized = path.posix.normalize(raw).replace(/\/+$/, "");
    if (!normalized || normalized === ".")
        return "";
    return normalized.normalize("NFC").toLowerCase();
}
function portablePathIsAbsolute(filePath) {
    var value = String(filePath || "").replace(/\\/g, "/");
    return value.startsWith("/") || value.startsWith("//") || /^[a-zA-Z]:\//.test(value);
}
function portableJoin(rootPath, relativePath) {
    var child = String(relativePath || "").replace(/\\/g, "/");
    if (!child)
        return "";
    if (portablePathIsAbsolute(child))
        return child;
    var root = String(rootPath || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return root ? "".concat(root, "/").concat(child.replace(/^\/+/, "")) : child;
}
function pathSegments(filePath) {
    return normalizeComparablePath(filePath).split("/").filter(function (part) { return part && part !== "."; });
}
function compareFilePaths(sourcePath, candidatePath) {
    var source = normalizeComparablePath(sourcePath);
    var candidate = normalizeComparablePath(candidatePath);
    if (!source || !candidate)
        return null;
    if (source === candidate)
        return { mode: "exact", suffixSegments: pathSegments(source).length };
    var sourceParts = pathSegments(source);
    var candidateParts = pathSegments(candidate);
    if (sourceParts.length < 2 || candidateParts.length < 2 ||
        sourceParts[sourceParts.length - 1] !== candidateParts[candidateParts.length - 1]) {
        return null;
    }
    var common = 0;
    while (common < sourceParts.length && common < candidateParts.length &&
        sourceParts[sourceParts.length - 1 - common] === candidateParts[candidateParts.length - 1 - common]) {
        common += 1;
    }
    return common >= 2 ? { mode: "mapped_suffix", suffixSegments: common } : null;
}
function resolveSourcePath(args) {
    var variables = args.variables || {};
    var input = args.inputFileObj || {};
    var original = String(variables.vmafOriginalFile || "").trim();
    var library = String(input._id || input.file || input.filePath || "").trim();
    if (original && library &&
        normalizeComparablePath(original) !== normalizeComparablePath(library)) {
        throw new Error("Tdarr original and library path evidence disagree");
    }
    var sourcePath = original || library;
    if (!sourcePath || !portablePathIsAbsolute(sourcePath) || pathSegments(sourcePath).length < 2) {
        throw new Error("absolute Tdarr source/library path evidence is required");
    }
    return sourcePath;
}
function requireApiResponse(response, description) {
    if (!response || !response.ok)
        throw new Error("".concat(description, " failed (HTTP ").concat((response && response.status) || 0, ")"));
    return response.data;
}
function positiveId(value) {
    var id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : 0;
}
function requireMonitoredBoolean(value, description) {
    if (typeof value !== "boolean")
        throw new Error("".concat(description, " did not return an explicit monitored state"));
    return value;
}
function fileEvidence(rootPath, record) {
    var evidence = [];
    if (record && record.path)
        evidence.push(String(record.path));
    if (record && record.relativePath)
        evidence.push(portableJoin(rootPath, record.relativePath));
    return Array.from(new Set(evidence.map(normalizeComparablePath).filter(Boolean)));
}
function matchingFileRecords(sourcePath, rootPath, records, description) {
    if (!Array.isArray(records))
        throw new Error("".concat(description, " did not return a file list"));
    var matches = [];
    records.forEach(function (record) {
        var id = positiveId(record && record.id);
        if (!id)
            return;
        var evidence = fileEvidence(rootPath, record);
        var matched = evidence.find(function (candidate) { return compareFilePaths(sourcePath, candidate); });
        if (matched)
            matches.push({ id: id, record: record, matchedPath: matched });
    });
    if (matches.length !== 1)
        throw new Error("".concat(description, " file identity is ").concat(matches.length ? "ambiguous" : "not an exact mapped-path match"));
    return matches[0];
}
function getEpisodeInfoFromFileName(filePath) {
    var base = portableBasename(filePath);
    var patterns = [
        /s(\d{1,2})((?:e\d{1,3})+)/ig,
        /(?:^|[^0-9])(\d{1,2})((?:x\d{1,3})+)(?:[^0-9]|$)/ig,
    ];
    var parsed = [];
    patterns.forEach(function (expression, index) {
        var match;
        while ((match = expression.exec(base)) !== null) {
            var episodeExpression = index === 0 ? /e(\d{1,3})/ig : /x(\d{1,3})/ig;
            var episodeNumbers = [];
            var episodeMatch;
            while ((episodeMatch = episodeExpression.exec(match[2])) !== null) {
                episodeNumbers.push(parseInt(episodeMatch[1], 10));
            }
            parsed.push({
                seasonNumber: parseInt(match[1], 10),
                episodeNumbers: episodeNumbers,
            });
        }
    });
    if (parsed.length !== 1)
        return null;
    var value = parsed[0];
    var uniqueEpisodes = Array.from(new Set(value.episodeNumbers));
    if (!Number.isInteger(value.seasonNumber) || value.seasonNumber < 0 ||
        uniqueEpisodes.length !== value.episodeNumbers.length ||
        uniqueEpisodes.length === 0 || uniqueEpisodes.some(function (episode) { return episode <= 0; })) {
        return null;
    }
    return { seasonNumber: value.seasonNumber, episodeNumbers: uniqueEpisodes };
}
async function loadRadarrIdentity(arrHost, headers, sourcePath, movieId) {
    var movie = requireApiResponse(await requestJson("".concat(arrHost, "/api/v3/movie/").concat(movieId), "GET", headers, null), "Radarr movie read");
    if (!movie || positiveId(movie.id) !== movieId)
        throw new Error("Radarr movie readback ID does not match parsed identity");
    var monitored = requireMonitoredBoolean(movie.monitored, "Radarr movie");
    var movieFiles = requireApiResponse(await requestJson("".concat(arrHost, "/api/v3/moviefile?movieId=").concat(movieId), "GET", headers, null), "Radarr movie-file read");
    var match = matchingFileRecords(sourcePath, movie.path, movieFiles, "Radarr");
    if (match.record.movieId !== undefined && positiveId(match.record.movieId) !== movieId)
        throw new Error("Radarr movie-file record belongs to a different movie");
    return { movieId: movieId, movieFileId: match.id, monitored: monitored };
}
function sameRadarrIdentity(before, after) {
    return before.movieId === after.movieId && before.movieFileId === after.movieFileId;
}
async function parseArrIdentity(arr, arrHost, headers, sourcePath) {
    var title = portableBasename(sourcePath);
    var parseData = requireApiResponse(await requestJson("".concat(arrHost, "/api/v3/parse?title=").concat(encodeURIComponent(title)), "GET", headers, null), "".concat(arr === "radarr" ? "Radarr" : "Sonarr", " parse"));
    var parsed = arr === "radarr" ? parseData && parseData.movie : parseData && parseData.series;
    var id = positiveId(parsed && parsed.id);
    if (!id)
        throw new Error("".concat(arr === "radarr" ? "Radarr movie" : "Sonarr series", " was not resolved by parse"));
    return id;
}
async function unmonitorRadarr(args, arrHost, headers, filePath) {
    var movieId = await parseArrIdentity("radarr", arrHost, headers, filePath);
    var before = await loadRadarrIdentity(arrHost, headers, filePath, movieId);
    if (before.monitored === false) {
        args.jobLog("\u2714 Radarr: movie '".concat(movieId, "' identity verified; already unmonitored"));
        return true;
    }
    var editRes = await requestJson("".concat(arrHost, "/api/v3/movie/editor"), "PUT", headers, { movieIds: [movieId], monitored: false });
    if (!editRes.ok) {
        args.jobLog("Radarr: failed to unmonitor movie '".concat(movieId, "' (HTTP ").concat(editRes.status, ")"));
        return false;
    }
    var after = await loadRadarrIdentity(arrHost, headers, filePath, movieId);
    if (!sameRadarrIdentity(before, after) || after.monitored !== false)
        throw new Error("Radarr mutation readback did not preserve file identity and monitored=false");
    args.jobLog("\u2714 Radarr: unmonitored movie '".concat(movieId, "'; file identity and readback verified"));
    return true;
}
async function loadSonarrIdentity(arrHost, headers, sourcePath, seriesId, epiInfo) {
    var series = requireApiResponse(await requestJson("".concat(arrHost, "/api/v3/series/").concat(seriesId), "GET", headers, null), "Sonarr series read");
    if (!series || positiveId(series.id) !== seriesId)
        throw new Error("Sonarr series readback ID does not match parsed identity");
    var seriesMonitored = requireMonitoredBoolean(series.monitored, "Sonarr series");
    var episodes = requireApiResponse(await requestJson("".concat(arrHost, "/api/v3/episode?seriesId=").concat(seriesId), "GET", headers, null), "Sonarr episode read");
    if (!Array.isArray(episodes))
        throw new Error("Sonarr episode read did not return a list");
    var selected = [];
    epiInfo.episodeNumbers.forEach(function (episodeNumber) {
        var matches = episodes.filter(function (episode) {
            return positiveId(episode && episode.seriesId) === seriesId &&
                Number(episode.seasonNumber) === epiInfo.seasonNumber &&
                Number(episode.episodeNumber) === episodeNumber;
        });
        if (matches.length !== 1)
            throw new Error("Sonarr episode identity is ".concat(matches.length ? "ambiguous" : "missing"));
        var episode = matches[0];
        var episodeId = positiveId(episode.id);
        var episodeFileId = positiveId(episode.episodeFileId);
        if (!episodeId || !episodeFileId)
            throw new Error("Sonarr episode lacks a stable episode/file identity");
        selected.push({
            id: episodeId,
            episodeFileId: episodeFileId,
            monitored: requireMonitoredBoolean(episode.monitored, "Sonarr episode"),
        });
    });
    var fileIds = Array.from(new Set(selected.map(function (episode) { return episode.episodeFileId; })));
    if (fileIds.length !== 1)
        throw new Error("Sonarr multi-episode filename maps to multiple episode files");
    var episodeFileId = fileIds[0];
    var episodeFile = requireApiResponse(await requestJson("".concat(arrHost, "/api/v3/episodefile/").concat(episodeFileId), "GET", headers, null), "Sonarr episode-file read");
    if (!episodeFile || positiveId(episodeFile.id) !== episodeFileId)
        throw new Error("Sonarr episode-file readback ID does not match episode identity");
    if (episodeFile.seriesId !== undefined && positiveId(episodeFile.seriesId) !== seriesId)
        throw new Error("Sonarr episode-file record belongs to a different series");
    var fileMatch = matchingFileRecords(sourcePath, series.path, [episodeFile], "Sonarr");
    return {
        seriesId: seriesId,
        episodeFileId: fileMatch.id,
        episodeIds: selected.map(function (episode) { return episode.id; }).sort(function (a, b) { return a - b; }),
        episodeMonitored: selected.map(function (episode) { return episode.monitored; }),
        seriesMonitored: seriesMonitored,
    };
}
function sameSonarrIdentity(before, after) {
    return before.seriesId === after.seriesId &&
        before.episodeFileId === after.episodeFileId &&
        JSON.stringify(before.episodeIds) === JSON.stringify(after.episodeIds);
}
async function unmonitorSonarr(args, arrHost, headers, filePath, scope) {
    var epiInfo = getEpisodeInfoFromFileName(filePath);
    if (!epiInfo)
        throw new Error("Sonarr filename must contain one unambiguous SxxEyy or 1x01 identity");
    var seriesId = await parseArrIdentity("sonarr", arrHost, headers, filePath);
    var before = await loadSonarrIdentity(arrHost, headers, filePath, seriesId, epiInfo);
    if (scope === "series") {
        if (before.seriesMonitored === false) {
            args.jobLog("\u2714 Sonarr: series '".concat(seriesId, "' file identity verified; already unmonitored"));
            return true;
        }
        var editSeriesRes = await requestJson("".concat(arrHost, "/api/v3/series/editor"), "PUT", headers, { seriesIds: [seriesId], monitored: false });
        if (!editSeriesRes.ok) {
            args.jobLog("Sonarr: failed to unmonitor series '".concat(seriesId, "' (HTTP ").concat(editSeriesRes.status, ")"));
            return false;
        }
        var seriesAfter = await loadSonarrIdentity(arrHost, headers, filePath, seriesId, epiInfo);
        if (!sameSonarrIdentity(before, seriesAfter) || seriesAfter.seriesMonitored !== false)
            throw new Error("Sonarr series mutation readback did not preserve file identity and monitored=false");
        args.jobLog("\u2714 Sonarr: unmonitored series '".concat(seriesId, "'; file identity and readback verified"));
        return true;
    }
    if (before.episodeMonitored.every(function (monitored) { return monitored === false; })) {
        args.jobLog("\u2714 Sonarr: episodes ".concat(before.episodeIds.join(", "), " file identity verified; already unmonitored"));
        return true;
    }
    var monitorRes = await requestJson("".concat(arrHost, "/api/v3/episode/monitor"), "PUT", headers, { episodeIds: before.episodeIds, monitored: false });
    if (!monitorRes.ok) {
        args.jobLog("Sonarr: failed to unmonitor episodes (HTTP ".concat(monitorRes.status, ")"));
        return false;
    }
    var episodesAfter = await loadSonarrIdentity(arrHost, headers, filePath, seriesId, epiInfo);
    if (!sameSonarrIdentity(before, episodesAfter) ||
        !episodesAfter.episodeMonitored.every(function (monitored) { return monitored === false; })) {
        throw new Error("Sonarr episode mutation readback did not preserve file identity and monitored=false");
    }
    args.jobLog("\u2714 Sonarr: unmonitored episodes ".concat(before.episodeIds.join(", "), "; file identity and readback verified"));
    return true;
}
var plugin = async function (args) {
    var lib = require("../../../../../methods/lib")();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    var arr = String(args.inputs.arr || "radarr").toLowerCase();
    var arrHost = normalizeHost(args.inputs.arr_host);
    var envApiKey = arr === "sonarr" ? process.env.TDARR_SONARR_API_KEY : process.env.TDARR_RADARR_API_KEY;
    var apiKey = String(envApiKey || args.inputs.arr_api_key || "").trim();
    var sonarrScope = String(args.inputs.sonarr_scope || "episodes");
    if ((arr !== "radarr" && arr !== "sonarr") ||
        (sonarrScope !== "episodes" && sonarrScope !== "series")) {
        args.jobLog("Arr type or Sonarr scope is invalid - skipping");
        return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
    }
    if (!arrHost || !apiKey) {
        args.jobLog("Arr host/API key missing or host URL is invalid - skipping");
        return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
    }
    var filePath = "";
    try {
        filePath = resolveSourcePath(args);
    }
    catch (err) {
        args.jobLog("Arr identity preflight failed: ".concat((err && err.message) || String(err)));
        return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
    }
    var headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Api-Key": apiKey,
    };
    args.jobLog("Verifying Arr file identity before unmonitoring in ".concat(arr, " for: ").concat(portableBasename(filePath)));
    var ok = false;
    try {
        if (arr === "radarr") {
            ok = await unmonitorRadarr(args, arrHost, headers, filePath);
        }
        else {
            ok = await unmonitorSonarr(args, arrHost, headers, filePath, sonarrScope);
        }
    }
    catch (err) {
        args.jobLog("Unmonitor error: ".concat((err && err.message) || String(err)));
        ok = false;
    }
    return { outputFileObj: args.inputFileObj, outputNumber: ok ? 1 : 2, variables: args.variables };
};
exports.plugin = plugin;
