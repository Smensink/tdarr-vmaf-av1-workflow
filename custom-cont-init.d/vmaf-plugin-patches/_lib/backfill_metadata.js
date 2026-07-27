'use strict';
/**
 * One-off metadata backfill for jobs with a file_name but no media metadata (source 'none'/null).
 * Parses the title from the filename, resolves via Plex (local, fast) then TMDB (rate-limited),
 * caches by title so the many episodes of a show cost one lookup, and updates the jobs rows with
 * media_genre / media_type / media_year / media_is_animation / network / original_language.
 *
 *   docker exec -e T=<tmdbkey> -e P=<plextoken> tdarr node \
 *     /custom-cont-init.d/vmaf-plugin-patches/_lib/backfill_metadata.js [limit]
 */
var http = require('http'); var https = require('https');
var vmafdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');

var TMDB = process.env.T || '';
var PTOK = process.env.P || '';
var PLEX = (process.env.PLEX_URL || 'http://host.docker.internal:32400').replace(/\/$/, '');
var TMDB_DELAY_MS = Number(process.env.TMDB_DELAY_MS || 250); // ~4 req/s
var LIMIT = Number(process.argv[2] || 0); // 0 = all

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function getJSON(lib, url, headers, timeout) {
  return new Promise(function (resolve) {
    var req = lib.get(url, { headers: headers || {} }, function (res) {
      var b = ''; res.on('data', function (c) { b += c; });
      res.on('end', function () { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', function () { resolve({ status: 0, json: null }); });
    req.setTimeout(timeout || 8000, function () { resolve({ status: 0, json: null }); req.destroy(); });
  });
}

// ── filename -> {title, year, type} ──
var QUAL = /\b(2160p|1080p|720p|480p|web-?dl|web-?rip|webrip|bluray|blu-ray|bdrip|brrip|hdtv|remux|uhd|hdr\d*|dv|x26[45]|h\.?26[45]|hevc|av1|aac|ddp?5?\.?1?|atmos|truehd|proper|repack|internal|amzn|nf|dsnp|hmax|atvp|max)\b/i;
function parseFilename(name) {
  var s = String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ').replace(/_vmaf_optimized.*$/i, '').trim();
  var tv = s.match(/^(.*?)\s*[-\s]\s*S(\d{1,2})E\d{1,3}/i);
  if (tv) return { title: tv[1].replace(/\s*-\s*$/, '').trim(), year: null, type: 'tv', isMedia: true };
  var mv = s.match(/^(.*?)\s*\((19|20)(\d{2})\)/);
  if (mv) return { title: mv[1].trim(), year: parseInt(mv[2] + mv[3], 10), type: 'movie', isMedia: true };
  var q = s.search(QUAL);
  var hasQual = q > 0;
  var title = (hasQual ? s.slice(0, q) : s).replace(/\s*-\s*$/, '').trim();
  // bare trailing year ("Title 2024") common in movie filenames without parens
  var year = null;
  var ym = title.match(/^(.*?)\s+(19|20)(\d{2})$/);
  if (ym) { title = ym[1].trim(); year = parseInt(ym[2] + ym[3], 10); }
  // only treat as media if there is a media signal: a quality/source tag or a year
  return { title: title, year: year, type: year ? 'movie' : null, isMedia: hasQual || !!year };
}

function genresAnim(genres) {
  var g = (genres || []).map(function (x) { return String(x).toLowerCase(); }).join(',');
  return (g.indexOf('animation') !== -1 || g.indexOf('anime') !== -1) ? 1 : 0;
}

async function plexLookup(title) {
  if (!PTOK) return null;
  var u = PLEX + '/hubs/search?query=' + encodeURIComponent(title) + '&X-Plex-Token=' + encodeURIComponent(PTOK);
  var r = await getJSON(PLEX.indexOf('https') === 0 ? https : http, u, { Accept: 'application/json' }, 6000);
  if (r.status !== 200 || !r.json) return null;
  var hubs = (r.json.MediaContainer && r.json.MediaContainer.Hub) || [];
  var best = null;
  hubs.forEach(function (h) {
    (h.Metadata || []).forEach(function (m) {
      if ((m.type === 'show' || m.type === 'movie') && String(m.title || '').toLowerCase().indexOf(title.toLowerCase().slice(0, 8)) !== -1 && !best) best = m;
    });
  });
  if (!best) return null;
  return {
    genres: (best.Genre || []).map(function (g) { return g.tag; }),
    year: best.year || (best.originallyAvailableAt ? parseInt(String(best.originallyAvailableAt).slice(0, 4), 10) : null),
    type: best.type === 'show' ? 'tv' : 'movie',
    source: 'plex'
  };
}

async function tmdbLookup(title, year) {
  if (!TMDB) return null;
  await sleep(TMDB_DELAY_MS);
  var su = 'https://api.themoviedb.org/3/search/multi?query=' + encodeURIComponent(title) + '&api_key=' + TMDB;
  var s = await getJSON(https, su);
  if (s.status !== 200 || !s.json || !(s.json.results || []).length) return null;
  var res = s.json.results.filter(function (x) { return x.media_type === 'tv' || x.media_type === 'movie'; });
  if (!res.length) return null;
  var first = res[0];
  var mt = first.media_type;
  await sleep(TMDB_DELAY_MS);
  var d = await getJSON(https, 'https://api.themoviedb.org/3/' + mt + '/' + first.id + '?api_key=' + TMDB);
  var det = (d.status === 200 && d.json) ? d.json : first;
  var date = det.first_air_date || det.release_date || '';
  return {
    genres: (det.genres || []).map(function (g) { return g.name; }),
    year: date ? parseInt(date.slice(0, 4), 10) : (year || null),
    type: mt,
    network: (det.networks || []).map(function (n) { return n.name; })[0] || null,
    original_language: det.original_language || null,
    source: 'tmdb'
  };
}

async function main() {
  var db = vmafdb.openDb();
  var rows = db.prepare(
    "SELECT job_id, file_name FROM jobs WHERE file_name IS NOT NULL AND file_name <> '' " +
    "AND (media_genre IS NULL OR media_genre = '' OR media_metadata_source IS NULL OR media_metadata_source = 'none')"
  ).all();
  if (LIMIT) rows = rows.slice(0, LIMIT);
  console.log('jobs needing metadata: ' + rows.length);

  // group by parsed title
  var byTitle = {}, skipped = 0;
  rows.forEach(function (r) {
    var p = parseFilename(r.file_name);
    if (!p.title || p.title.length < 2 || !p.isMedia) { skipped++; return; } // skip non-media (lectures/home video)
    var key = p.title.toLowerCase();
    (byTitle[key] = byTitle[key] || { meta: p, jobs: [] }).jobs.push(r.job_id);
  });
  var titles = Object.keys(byTitle);
  console.log('unique media titles to resolve: ' + titles.length + ' (skipped ' + skipped + ' non-media files)');

  var resolved = 0, updated = 0, tmdbCalls = 0, plexHits = 0, t0 = Date.now();
  for (var i = 0; i < titles.length; i++) {
    var ent = byTitle[titles[i]];
    var p = ent.meta;
    var plex = await plexLookup(p.title);
    var tmdb = await tmdbLookup(p.title, p.year); tmdbCalls += tmdb ? 2 : 1;
    if (plex) plexHits++;
    if (!plex && !tmdb) continue;
    var genres = (plex && plex.genres && plex.genres.length) ? plex.genres : (tmdb ? tmdb.genres : []);
    var meta = {
      media_genre: (genres && genres.length) ? genres.join(', ') : null,
      media_type: (plex && plex.type) || (tmdb && tmdb.type) || p.type || null,
      media_year: (tmdb && tmdb.year) || (plex && plex.year) || p.year || null,
      media_is_animation: genresAnim(genres),
      network: tmdb && tmdb.network,
      original_language: tmdb && tmdb.original_language,
      media_metadata_source: plex ? (tmdb ? 'plex+tmdb' : 'plex') : 'tmdb'
    };
    if (!meta.media_genre && !meta.network) continue;
    resolved++;
    ent.jobs.forEach(function (jid) { meta.job_id = jid; vmafdb.upsertJob(db, meta); updated++; });
    if (i % 25 === 0 || i === titles.length - 1) {
      console.log('  [' + (i + 1) + '/' + titles.length + '] resolved=' + resolved + ' jobsUpdated=' + updated +
        ' plexHits=' + plexHits + ' tmdbCalls=' + tmdbCalls + ' elapsed=' + Math.round((Date.now() - t0) / 1000) + 's');
    }
  }
  console.log('DONE. titles resolved=' + resolved + '/' + titles.length + ', jobs updated=' + updated +
    ', plexHits=' + plexHits + ', tmdbCalls=' + tmdbCalls);
  db.close();
}
main();
