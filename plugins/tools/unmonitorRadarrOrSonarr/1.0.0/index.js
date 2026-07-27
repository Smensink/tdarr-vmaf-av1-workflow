"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var path = require("path");
var details = function () { return ({
    name: "Unmonitor in Radarr or Sonarr",
    description: "After a successful transcode+replace, unmonitors the corresponding movie (Radarr) or episode(s)/series (Sonarr) to prevent future upgrades.",
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
        { number: 1, tooltip: "Unmonitored" },
        { number: 2, tooltip: "Not found / skipped" },
    ],
}); };
exports.details = details;
function normalizeHost(host) {
    var trimmed = String(host || "").trim();
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}
function requestJson(url, method, headers, body, timeoutMs) {
    return new Promise(function (resolve) {
        try {
            var http = url.startsWith("https://") ? require("https") : require("http");
            var payload = body ? JSON.stringify(body) : "";
            var req = http.request(url, {
                method: method,
                headers: Object.assign({}, headers, payload
                    ? {
                        "Content-Length": Buffer.byteLength(payload),
                    }
                    : {}),
                timeout: timeoutMs || 10000,
            }, function (res) {
                var chunks = "";
                res.on("data", function (d) { return (chunks += d); });
                res.on("end", function () {
                    if (!chunks) {
                        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: null });
                        return;
                    }
                    try {
                        var data = JSON.parse(chunks);
                        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: data });
                    }
                    catch (_a) {
                        resolve({ ok: false, status: res.statusCode, data: null });
                    }
                });
            });
            req.on("error", function () { return resolve({ ok: false, status: 0, data: null }); });
            req.on("timeout", function () {
                try {
                    req.destroy();
                }
                catch (_a) { }
                resolve({ ok: false, status: 0, data: null });
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
function getEpisodeInfoFromFileName(filePath) {
    var base = path.basename(filePath || "");
    var match = base.match(/s(\d{1,2})e(\d{1,2})(?:e(\d{1,2}))?/i);
    if (!match) {
        var alt = base.match(/(\d{1,2})x(\d{1,2})(?:x(\d{1,2}))?/i);
        if (!alt)
            return null;
        return {
            seasonNumber: parseInt(alt[1], 10),
            episodeNumbers: [parseInt(alt[2], 10)].concat(alt[3] ? [parseInt(alt[3], 10)] : []),
        };
    }
    return {
        seasonNumber: parseInt(match[1], 10),
        episodeNumbers: [parseInt(match[2], 10)].concat(match[3] ? [parseInt(match[3], 10)] : []),
    };
}
function getIdFromParseResponse(arr, parseResponse) {
    var _a, _b, _c, _d;
    if (arr === "radarr") {
        return Number((_d = (_c = (_b = (_a = parseResponse === null || parseResponse === void 0 ? void 0 : parseResponse.movie) !== null && _a !== void 0 ? _a : parseResponse === null || parseResponse === void 0 ? void 0 : parseResponse.movie) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : -1) !== null && _d !== void 0 ? _d : -1);
    }
    return Number((_d = (_c = (_b = (_a = parseResponse === null || parseResponse === void 0 ? void 0 : parseResponse.series) !== null && _a !== void 0 ? _a : parseResponse === null || parseResponse === void 0 ? void 0 : parseResponse.series) === null || _b === void 0 ? void 0 : _b.id) !== null && _c !== void 0 ? _c : -1) !== null && _d !== void 0 ? _d : -1);
}
async function unmonitorRadarr(args, arrHost, headers, filePath) {
    var title = path.basename(filePath || "");
    var parseRes = await requestJson("".concat(arrHost, "/api/v3/parse?title=").concat(encodeURIComponent(title)), "GET", headers, null);
    var parseData = parseRes && parseRes.data ? parseRes.data : null;
    var movieId = getIdFromParseResponse("radarr", parseData);
    if (!movieId || movieId === -1) {
        args.jobLog("Radarr: movie not found for '".concat(title, "'"));
        return false;
    }
    var editRes = await requestJson("".concat(arrHost, "/api/v3/movie/editor"), "PUT", headers, { movieIds: [movieId], monitored: false });
    if (!editRes.ok) {
        args.jobLog("Radarr: failed to unmonitor movie '".concat(movieId, "' (HTTP ").concat(editRes.status, ")"));
        return false;
    }
    args.jobLog("\u2714 Radarr: unmonitored movie '".concat(movieId, "'"));
    return true;
}
async function unmonitorSonarr(args, arrHost, headers, filePath, scope) {
    var title = path.basename(filePath || "");
    var parseRes = await requestJson("".concat(arrHost, "/api/v3/parse?title=").concat(encodeURIComponent(title)), "GET", headers, null);
    var parseData = parseRes && parseRes.data ? parseRes.data : null;
    var seriesId = getIdFromParseResponse("sonarr", parseData);
    if (!seriesId || seriesId === -1) {
        args.jobLog("Sonarr: series not found for '".concat(title, "'"));
        return false;
    }
    if (scope === "series") {
        var editSeriesRes = await requestJson("".concat(arrHost, "/api/v3/series/editor"), "PUT", headers, { seriesIds: [seriesId], monitored: false });
        if (!editSeriesRes.ok) {
            args.jobLog("Sonarr: failed to unmonitor series '".concat(seriesId, "' (HTTP ").concat(editSeriesRes.status, ")"));
            return false;
        }
        args.jobLog("\u2714 Sonarr: unmonitored series '".concat(seriesId, "'"));
        return true;
    }
    var epiInfo = getEpisodeInfoFromFileName(filePath);
    if (!epiInfo) {
        args.jobLog("Sonarr: could not detect SxxEyy in filename; set 'Sonarr Unmonitor Scope' to 'series' if desired");
        return false;
    }
    var episodesRes = await requestJson("".concat(arrHost, "/api/v3/episode?seriesId=").concat(seriesId), "GET", headers, null);
    var episodes = Array.isArray(episodesRes.data) ? episodesRes.data : [];
    var targetIds = episodes
        .filter(function (e) {
        return Number(e.seasonNumber) === epiInfo.seasonNumber && epiInfo.episodeNumbers.indexOf(Number(e.episodeNumber)) !== -1;
    })
        .map(function (e) { return Number(e.id); })
        .filter(function (id) { return id && id > 0; });
    if (targetIds.length === 0) {
        args.jobLog("Sonarr: no matching episode IDs found for S".concat(epiInfo.seasonNumber, "E").concat(epiInfo.episodeNumbers.join(",")));
        return false;
    }
    var monitorRes = await requestJson("".concat(arrHost, "/api/v3/episode/monitor"), "PUT", headers, { episodeIds: targetIds, monitored: false });
    if (!monitorRes.ok) {
        args.jobLog("Sonarr: failed to unmonitor episodes (HTTP ".concat(monitorRes.status, ")"));
        return false;
    }
    args.jobLog("\u2714 Sonarr: unmonitored episodes ".concat(targetIds.join(", ")));
    return true;
}
var plugin = async function (args) {
    var lib = require("../../../../../methods/lib")();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    var arr = String(args.inputs.arr || "radarr");
    var arrHost = normalizeHost(args.inputs.arr_host);
    var envApiKey = arr === "sonarr" ? process.env.TDARR_SONARR_API_KEY : process.env.TDARR_RADARR_API_KEY;
    var apiKey = String(envApiKey || args.inputs.arr_api_key || "").trim();
    var sonarrScope = String(args.inputs.sonarr_scope || "episodes");
    if (!arrHost || !apiKey) {
        args.jobLog("Arr host/api key missing - skipping");
        return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
    }
    var filePath = (args.inputFileObj && args.inputFileObj._id) || "";
    if (!filePath) {
        args.jobLog("No input file path - skipping");
        return { outputFileObj: args.inputFileObj, outputNumber: 2, variables: args.variables };
    }
    var headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Api-Key": apiKey,
    };
    args.jobLog("Unmonitoring in ".concat(arr, " for: ").concat(path.basename(filePath)));
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
