'use strict';
/**
 * Backfill jobs.media_title from jobs.file_name, replicating fetchMediaMetadata.parseFilenameMeta's
 * title logic EXACTLY so backfilled keys match what the live path now writes (vmafSeriesTitle =
 * filenameMeta.title). For TV the title is the show name (prefix before SxxExx); for film it's the
 * cleaned movie name. media_title is a curve-pooling weight only, so this is purely additive — it
 * never alters any past decision and is target-independent.
 *
 * Run inside the container:  docker exec tdarr node /custom-cont-init.d/vmaf-plugin-patches/_lib/backfill_media_title.js
 * DRY_RUN=1 to preview without writing. After a real run (root), re-chown the db to abc:abc + chmod 664.
 */
var path = require('path');
var vdb = require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');

var DRY = process.env.DRY_RUN === '1';

// ── EXACT copy of fetchMediaMetadata.parseFilenameMeta's title derivation (keep in sync) ──
function titleFromFilename(filePath) {
  var base = path.basename(filePath || '', path.extname(filePath || ''));
  var cleaned = base.replace(/[._]/g, ' ');
  cleaned = cleaned.replace(/[\(\[\{][^\)\]\}]*[\)\]\}]/g, ' ');
  var yearMatch = cleaned.match(/(19|20)\d{2}/);
  var tvMatch = cleaned.match(/^(.*?)[\s.-]?s\d{2}e\d{2}/i);
  var title = tvMatch ? tvMatch[1] : cleaned;
  if (yearMatch) {
    var yearStr = yearMatch[0];
    title = title.replace(new RegExp('\\s*[\\(\\[]?' + yearStr + '[\\)\\]]?'), ' ');
  }
  title = title.replace(/(2160p|1080p|720p|480p|4k|uhd|hdr10\+?|hdr|dolbyvision|dv|bluray|web-?dl|webrip|remux|dvdrip|hdtv|amzn|nf|x265|x264|hevc|av1|ddp|ddp5\.?1|atmos|hone|hhweb|ntb)/ig, ' ');
  title = title.replace(/\s+/g, ' ').trim();
  return title || null;
}

// Canonical match key. KEEP IN SYNC with fetchMediaMetadata's canonTitle (live path): collapse
// punctuation/separators + lowercase so dot- vs dash-delimited releases share a key and the live
// and backfill paths are robust to minor parser drift.
function canonTitle(t) {
  if (!t) return null;
  var s = String(t).toLowerCase().replace(/[\s._-]+/g, ' ').replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
  return s || null;
}

var db = vdb.openDb();
var rows = db.prepare("SELECT job_id, file_name FROM jobs WHERE file_name IS NOT NULL AND file_name <> '' AND (media_title IS NULL OR media_title = '')").all();
console.log('candidate rows (file_name present, media_title empty): ' + rows.length + (DRY ? '  [DRY RUN]' : ''));

var upd = db.prepare('UPDATE jobs SET media_title = ? WHERE job_id = ?');
var n = 0, skipped = 0, byTitle = {};
db.exec('PRAGMA synchronous = OFF;'); // bind-mounted Windows volume: per-commit fsync is the bottleneck
db.exec('BEGIN');
try {
  for (var i = 0; i < rows.length; i++) {
    var t = canonTitle(titleFromFilename(rows[i].file_name));
    if (!t) { skipped++; continue; }
    if (!DRY) upd.run(t, rows[i].job_id);
    byTitle[t.toLowerCase()] = (byTitle[t.toLowerCase()] || 0) + 1;
    n++;
  }
  db.exec(DRY ? 'ROLLBACK' : 'COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

var distinct = Object.keys(byTitle).length;
var multi = Object.keys(byTitle).filter(function (k) { return byTitle[k] >= 2; }).length;
console.log((DRY ? 'would update' : 'updated') + ': ' + n + '  (skipped, no parseable title: ' + skipped + ')');
console.log('distinct titles: ' + distinct + '  | titles with >=2 jobs (cross-matchable, mostly TV shows): ' + multi);
var top = Object.keys(byTitle).sort(function (a, b) { return byTitle[b] - byTitle[a]; }).slice(0, 12);
console.log('top titles by job count:');
top.forEach(function (k) { console.log('  ' + byTitle[k] + '\t' + k); });
console.log('\nNOTE: if this was a real run as root, now: chown abc:abc /app/configs/vmaf_training.db* && chmod 664 /app/configs/vmaf_training.db');
