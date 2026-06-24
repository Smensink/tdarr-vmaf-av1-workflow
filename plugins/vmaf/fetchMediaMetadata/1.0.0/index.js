"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var details = function () { return ({
    name: 'Fetch Media Metadata',
    description: 'Fetches genre/style metadata from Plex/TMDB/TVDB to guide CQ decisions. Falls back to filename parsing when APIs are unavailable.',
    style: {
        borderColor: 'blue',
    },
    tags: 'video,vmaf,metadata,plex,tmdb,tvdb',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faInfoCircle',
    inputs: [
        {
            label: 'Enable Metadata Fetching',
            name: 'enableMetadata',
            type: 'boolean',
            defaultValue: 'true',
            inputUI: { type: 'switch' },
            tooltip: 'Toggle metadata fetching. If disabled, filename parsing is used only.'
        },
        {
            label: 'Plex URL',
            name: 'plexUrl',
            type: 'string',
            defaultValue: '',
            inputUI: { type: 'text' },
            tooltip: 'Optional Plex base URL (e.g., http://192.168.1.100:32400)'
        },
        {
            label: 'Plex Token',
            name: 'plexToken',
            type: 'string',
            defaultValue: '',
            inputUI: { type: 'text' },
            tooltip: 'Optional Plex token for authenticated metadata lookups'
        },
        {
            label: 'Plex Library Section IDs',
            name: 'plexSections',
            type: 'string',
            defaultValue: '',
            inputUI: { type: 'text' },
            tooltip: 'Comma-separated section IDs to speed up Plex lookups (optional)'
        },
        {
            label: 'TMDB API Key',
            name: 'tmdbApiKey',
            type: 'string',
            defaultValue: '',
            inputUI: { type: 'text' },
            tooltip: 'Optional TMDB API key for metadata when Plex is unavailable'
        },
        {
            label: 'TVDB API Key',
            name: 'tvdbApiKey',
            type: 'string',
            defaultValue: '',
            inputUI: { type: 'text' },
            tooltip: 'Optional TVDB API key (fallback for TV series)'
        },
        {
            label: 'Log Metadata Details',
            name: 'logMetadata',
            type: 'boolean',
            defaultValue: 'false',
            inputUI: { type: 'switch' },
            tooltip: 'If true, prints resolved metadata (genres, type, animation, source) to the log for debugging.'
        },
    ],
    outputs: [
        { number: 1, tooltip: 'Metadata fetched' },
    ],
}); };
exports.details = details;

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    
    var https = require('https');
    var http = require('http');
    var path = require('path');
    
    var enableMetadata = args.inputs.enableMetadata !== false && args.inputs.enableMetadata !== 'false';
    var plexUrl = (args.inputs.plexUrl || '').trim();
    var plexToken = (args.inputs.plexToken || '').trim();
    var plexSections = (args.inputs.plexSections || '').trim();
    var tmdbApiKey = (args.inputs.tmdbApiKey || '').trim();
    var tvdbApiKey = (args.inputs.tvdbApiKey || '').trim();
    var logMetadata = args.inputs.logMetadata !== false && args.inputs.logMetadata !== 'false';
    
    var defaultResult = {
        vmafMediaGenre: [],
        vmafMediaIsAnimation: false,
        vmafMediaType: 'unknown',
        vmafMediaYear: null,
        vmafMediaMetadataSource: 'none',
        vmafMediaSourceType: 'unknown',
        vmafMediaGenresString: ''
    };
    
    // Ensure defaults are set to avoid stale data
    Object.keys(defaultResult).forEach(function(key) {
        args.variables[key] = defaultResult[key];
    });
    
    if (!enableMetadata) {
        args.jobLog('Metadata fetching disabled - using defaults');
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }
    
    function requestJson(url, headers, timeoutMs) {
        return new Promise(function(resolve) {
            var client = url.indexOf('https://') === 0 ? https : http;
            var req = client.get(url, { headers: headers || {}, timeout: timeoutMs || 8000 }, function(res) {
                var body = '';
                res.on('data', function(chunk) { body += chunk; });
                res.on('end', function() {
                    try {
                        var parsed = JSON.parse(body);
                        resolve(parsed);
                    } catch (err) {
                        resolve(null);
                    }
                });
            });
            req.on('error', function() { resolve(null); });
            req.on('timeout', function() { req.destroy(); resolve(null); });
        });
    }
    
    function requestText(url, headers, timeoutMs) {
        return new Promise(function(resolve) {
            var client = url.indexOf('https://') === 0 ? https : http;
            var req = client.get(url, { headers: headers || {}, timeout: timeoutMs || 8000 }, function(res) {
                var body = '';
                res.on('data', function(chunk) { body += chunk; });
                res.on('end', function() { resolve(body || ''); });
            });
            req.on('error', function() { resolve(''); });
            req.on('timeout', function() { req.destroy(); resolve(''); });
        });
    }
    
    var SOURCE_TYPE_PATTERNS = [
        { name: 'bluray', regex: /\b(?:blu[-]?ray|bluray|bdrip|br(?:rip)?|remux|uhdremux|bd(?:rip)?)\b/i },
        { name: 'dvd-rip', regex: /\b(?:dvdrip|dvd)\b/i },
        { name: 'web-dl', regex: /\b(?:web[-_. ]?dl|dsnp|nf|netflix|amzn|prime(?:video)?|hbo|max|disney|apple[- ]?tv|appletv|peacock|paramount|starz(?:play)?|mubi|curiosity|criterion)\b/i },
        { name: 'webrip', regex: /\bwebrip\b/i },
        { name: 'hdrip', regex: /\bhdrip\b/i },
        { name: 'hdtv', regex: /\bhdtv\b/i }
    ];

    function inferSourceTypeFromFilename(filePath) {
        if (!filePath) return 'unknown';
        var candidate = String(filePath).toLowerCase();
        for (var pi = 0; pi < SOURCE_TYPE_PATTERNS.length; pi++) {
            if (SOURCE_TYPE_PATTERNS[pi].regex.test(candidate)) {
                return SOURCE_TYPE_PATTERNS[pi].name;
            }
        }
        return 'unknown';
    }

    function parseFilenameMeta(filePath) {
        var base = path.basename(filePath || '', path.extname(filePath || ''));
        var sourceType = inferSourceTypeFromFilename(base);
        var cleaned = base.replace(/[._]/g, ' ');
        // Strip bracketed bits
        cleaned = cleaned.replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, ' ');
        // Extract year if present
        var yearMatch = cleaned.match(/(19|20)\d{2}/);
        var year = yearMatch ? parseInt(yearMatch[0], 10) : null;
        // Trim season/episode markers for TV shows
        var tvMatch = cleaned.match(/^(.*?)[\s.-]?s\d{2}e\d{2}/i);
        var title = tvMatch ? tvMatch[1] : cleaned;
        if (yearMatch) {
            var yearStr = yearMatch[0];
            title = title.replace(new RegExp('\\s*[\\(\\[]?' + yearStr + '[\\)\\]]?'), ' ');
        }
        // Drop common quality/resolution/release tokens
        title = title.replace(/(2160p|1080p|720p|480p|4k|uhd|hdr10\+?|hdr|dolbyvision|dv|bluray|web-?dl|webrip|remux|dvdrip|hdtv|amzn|nf|x265|x264|hevc|av1|ddp|ddp5\.?1|atmos|hone|hhweb|ntb)/ig, ' ');
        title = title.replace(/\s+/g, ' ').trim();
        return { title: title, year: year, sourceType: sourceType };
    }
    
    function normalizeGenres(genres) {
        if (!Array.isArray(genres)) return [];
        var seen = {};
        var out = [];
        for (var i = 0; i < genres.length; i++) {
            var g = String(genres[i]).trim();
            if (g && !seen[g.toLowerCase()]) {
                seen[g.toLowerCase()] = true;
                out.push(g);
            }
        }
        return out;
    }
    
    function detectAnimation(genres, keywords, libraryName) {
        var lowerGenres = (genres || []).map(function(g) { return g.toLowerCase(); });
        var lowerKeywords = (keywords || []).map(function(g) { return String(g).toLowerCase(); });
        var animationWords = ['animation', 'anime', 'cartoon', 'animated'];
        var hit = animationWords.some(function(word) {
            return lowerGenres.indexOf(word) !== -1 || lowerKeywords.some(function(k) { return k.indexOf(word) !== -1; });
        });
        if (!hit && libraryName) {
            var libLower = String(libraryName).toLowerCase();
            hit = animationWords.some(function(word) { return libLower.indexOf(word) !== -1; });
        }
        return hit;
    }
    
    function normalizeTitle(str) {
        return String(str || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    }
    
    function selectBestPlexMeta(metaArray, filenameMeta, inputFilePath) {
        if (!Array.isArray(metaArray) || metaArray.length === 0) return null;
        var targetYear = filenameMeta.year || null;
        var targetTitle = normalizeTitle(filenameMeta.title);
        var targetBase = normalizeTitle(require('path').basename(inputFilePath || '', require('path').extname(inputFilePath || '')));
        
        var best = null;
        var bestScore = -1;
        
        for (var i = 0; i < metaArray.length; i++) {
            var m = metaArray[i];
            var score = 0;
            var metaTitle = normalizeTitle(m.title || '');
            if (metaTitle === targetTitle) score += 5;
            else if (metaTitle.indexOf(targetTitle) !== -1 || targetTitle.indexOf(metaTitle) !== -1) score += 3;
            
            if (targetYear && m.year) {
                if (Number(m.year) === targetYear) score += 4;
                else if (Math.abs(Number(m.year) - targetYear) <= 1) score += 2;
            }
            
            // Prefer entries whose Part file basename matches the current file basename
            if (m.Media && Array.isArray(m.Media)) {
                for (var mi = 0; mi < m.Media.length; mi++) {
                    var media = m.Media[mi];
                    if (media.Part && Array.isArray(media.Part)) {
                        for (var pi = 0; pi < media.Part.length; pi++) {
                            var part = media.Part[pi];
                            var partBase = normalizeTitle(require('path').basename(part.file || '', require('path').extname(part.file || '')));
                            if (partBase && partBase === targetBase) {
                                score += 6;
                            } else if (partBase && partBase.indexOf(targetBase) !== -1) {
                                score += 3;
                            }
                        }
                    }
                }
            }
            
            if (score > bestScore) {
                bestScore = score;
                best = m;
            }
        }
        
        return best || metaArray[0];
    }
    
    function extractReleaseGroup(filePath) {
        if (!filePath) return '';
        var base = path.basename(filePath, path.extname(filePath));
        var parts = base.trim().split(/\s+/);
        if (parts.length === 0) return '';
        return parts[parts.length - 1];
    }
    
    function parsePlexXml(xml) {
        if (!xml || xml.indexOf('<MediaContainer') === -1) return null;
        var genres = [];
        var genreRegex = /<Genre[^>]*tag="([^"]+)"/g;
        var match;
        while ((match = genreRegex.exec(xml)) !== null) {
            genres.push(match[1]);
        }
        var typeMatch = xml.match(/<Metadata[^>]*type="([^"]+)"/);
        var yearMatch = xml.match(/<Metadata[^>]*year="([^"]+)"/);
        var libraryMatch = xml.match(/librarySectionTitle="([^"]+)"/);
        return {
            source: 'plex',
            genres: normalizeGenres(genres),
            type: (typeMatch && typeMatch[1]) || 'unknown',
            year: yearMatch && !isNaN(parseInt(yearMatch[1], 10)) ? parseInt(yearMatch[1], 10) : null,
            libraryName: libraryMatch ? libraryMatch[1] : ''
        };
    }
    
    function plexSearch(title, year) {
        if (!plexUrl || !plexToken) return Promise.resolve(null);
        var baseUrl = plexUrl.replace(/\/$/, '');
        var query = encodeURIComponent(title || '');
        var sectionParam = plexSections ? '&sectionId=' + encodeURIComponent(plexSections) : '';
        var clientId = 'tdarr-vmaf-plugin';
        var commonQuery = '&X-Plex-Token=' + encodeURIComponent(plexToken) +
            '&X-Plex-Client-Identifier=' + clientId +
            '&X-Plex-Product=Tdarr' +
            '&X-Plex-Version=1.0' +
            '&X-Plex-Platform=Tdarr';
        var url = baseUrl + '/search?query=' + query + sectionParam + commonQuery;
        var headers = { 'X-Plex-Token': plexToken, 'Accept': 'application/json' };
        
        function attempt(urlToTry) {
            if (logMetadata) {
                args.jobLog('Plex search: ' + urlToTry);
            }
            return requestJson(urlToTry, headers, 7000).then(function(data) {
                if (data && data.MediaContainer && Array.isArray(data.MediaContainer.Metadata) && data.MediaContainer.Metadata.length > 0) {
                    var chosen = selectBestPlexMeta(data.MediaContainer.Metadata, filenameMeta, args.inputFileObj && args.inputFileObj._id);
                    if (chosen) {
                        var genres = (chosen.Genre || []).map(function(g) { return g.tag; });
                        return {
                            source: 'plex',
                            genres: normalizeGenres(genres),
                            type: chosen.type || 'unknown',
                            year: chosen.year || year || null,
                            libraryName: data.MediaContainer.librarySectionTitle || ''
                        };
                    }
                }
                return requestText(urlToTry, headers, 7000).then(function(body) {
                    return parsePlexXml(body);
                });
            });
        }
        
        return attempt(url).then(function(result) {
            if (result || baseUrl.indexOf('host.docker.internal') === -1) return result;
            // Dev/local fallback: try localhost when host.docker.internal is unreachable outside Docker
            var fallbackUrl = url.replace('host.docker.internal', 'localhost');
            return attempt(fallbackUrl);
        });
    }
    
    function tmdbSearch(title, year) {
        if (!tmdbApiKey) return Promise.resolve(null);
        var searchUrl = 'https://api.themoviedb.org/3/search/multi?query=' + encodeURIComponent(title || '') +
            (year ? '&year=' + year : '') + '&api_key=' + encodeURIComponent(tmdbApiKey);
        if (logMetadata) {
            args.jobLog('TMDB search: ' + searchUrl);
        }
        return requestJson(searchUrl, {}, 8000).then(function(searchRes) {
            if (!searchRes || !Array.isArray(searchRes.results) || searchRes.results.length === 0) return null;
            var first = searchRes.results[0];
            if (!first.id) return null;
            var type = first.media_type === 'tv' ? 'tv' : 'movie';
            var detailUrl = 'https://api.themoviedb.org/3/' + type + '/' + first.id + '?api_key=' + encodeURIComponent(tmdbApiKey);
            return requestJson(detailUrl, {}, 8000).then(function(detail) {
                if (!detail) return null;
                var genres = normalizeGenres((detail.genres || []).map(function(g) { return g.name; }));
                var keywords = [];
                var yearOut = (type === 'tv' ? (detail.first_air_date || '') : (detail.release_date || '')).slice(0, 4);
                return {
                    source: 'tmdb',
                    genres: genres,
                    keywords: keywords,
                    type: type,
                    year: yearOut ? Number(yearOut) : (year || null),
                    network: ((detail.networks || [])[0] || {}).name || null,            // streaming/style proxy (Apple TV+, etc.)
                    originalLanguage: detail.original_language || null                   // anime (ja) vs western
                };
            });
        });
    }
    
    // TVDB v4 search (simple auth flow: use API key directly in header)
    function tvdbSearch(title, year) {
        if (!tvdbApiKey) return Promise.resolve(null);
        var searchUrl = 'https://api4.thetvdb.com/v4/search?query=' + encodeURIComponent(title || '');
        if (logMetadata) {
            args.jobLog('TVDB search: ' + searchUrl);
        }
        return new Promise(function(resolve) {
            var https = require('https');
            var req = https.get(searchUrl, { headers: { 'Authorization': 'Bearer ' + tvdbApiKey }, timeout: 8000 }, function(res) {
                var body = '';
                res.on('data', function(chunk) { body += chunk; });
                res.on('end', function() {
                    try {
                        var parsed = JSON.parse(body);
                        if (!parsed || !parsed.data || !Array.isArray(parsed.data) || parsed.data.length === 0) return resolve(null);
                        var first = parsed.data[0];
                        var type = (first.type === 'series') ? 'tv' : 'movie';
                        var tvdbYear = first.year || first.firstRelease || null;
                        return resolve({
                            source: 'tvdb',
                            genres: [], // TVDB v4 search doesn't return genres; could fetch detail if needed
                            keywords: [],
                            type: type,
                            year: tvdbYear ? Number(tvdbYear) : (year || null)
                        });
                    } catch (e) {
                        return resolve(null);
                    }
                });
            });
            req.on('error', function() { resolve(null); });
            req.on('timeout', function() { req.destroy(); resolve(null); });
        });
    }
    
    var filenameMeta = parseFilenameMeta(args.inputFileObj._id || '');
    var lookupChain = [];
    if (plexUrl && plexToken) lookupChain.push(function() { return plexSearch(filenameMeta.title, filenameMeta.year); });
    if (tmdbApiKey) lookupChain.push(function() { return tmdbSearch(filenameMeta.title, filenameMeta.year); });
    if (tvdbApiKey) lookupChain.push(function() { return tvdbSearch(filenameMeta.title, filenameMeta.year); });
    
    function runLookup(index) {
        if (index >= lookupChain.length) return Promise.resolve(null);
        return lookupChain[index]().then(function(res) {
            if (res) return res;
            return runLookup(index + 1);
        });
    }
    
    return runLookup(0).then(function(meta) {
        var resolved = meta || {
            source: 'none',
            genres: [],
            keywords: [],
            type: 'unknown',
            year: filenameMeta.year
        };
        
        var genres = normalizeGenres(resolved.genres || []);
        var isAnimation = detectAnimation(genres, resolved.keywords || [], resolved.libraryName || '');
        
        args.variables.vmafMediaGenre = genres;
        args.variables.vmafMediaGenresString = genres.join(', ');
        args.variables.vmafMediaIsAnimation = isAnimation;
        args.variables.vmafMediaType = resolved.type || 'unknown';
        args.variables.vmafMediaYear = resolved.year || filenameMeta.year || null;
        args.variables.vmafMediaMetadataSource = resolved.source || 'none';
        args.variables.vmafMediaSourceType = filenameMeta.sourceType || 'unknown';
        args.variables.vmafReleaseGroup = extractReleaseGroup(args.inputFileObj._id || '');
        args.variables.vmafNetwork = resolved.network || null;                 // -> jobs.network (encode-style proxy)
        args.variables.vmafOriginalLanguage = resolved.originalLanguage || null; // -> jobs.original_language
        
        if (logMetadata) {
            args.jobLog('Metadata search inputs: title=' + filenameMeta.title + ', year=' + filenameMeta.year);
            args.jobLog('Metadata source: ' + args.variables.vmafMediaMetadataSource + (genres.length ? (' | Genres: ' + genres.join(', ')) : ' | No genres found'));
            if (isAnimation) {
                args.jobLog('Detected animation/animated content from metadata');
            }
            args.jobLog('Metadata details: type=' + args.variables.vmafMediaType + ', year=' + args.variables.vmafMediaYear + ', sourceType=' + args.variables.vmafMediaSourceType);
        }
        
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    }).catch(function(err) {
        args.jobLog('Metadata fetch failed: ' + err.message);
        return {
            outputFileObj: args.inputFileObj,
            outputNumber: 1,
            variables: args.variables,
        };
    });
};
exports.plugin = plugin;
