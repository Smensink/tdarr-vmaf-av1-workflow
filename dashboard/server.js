/* eslint-disable no-console */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const readline = require("readline");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 8686);
const CONFIGS_DIR = process.env.CONFIGS_DIR || "/data";
const RESULTS_CSV = process.env.RESULTS_CSV || path.join(CONFIGS_DIR, "vmaf_results.csv");
const LEARNING_CSV = process.env.LEARNING_CSV || path.join(CONFIGS_DIR, "vmaf_cq_learning.csv");
const DB_PATH = process.env.DB_PATH || "/state/vmaf.sqlite";
const TDARR_JOBREPORTS_DIR = process.env.TDARR_JOBREPORTS_DIR || "";
const PUBLIC_DIR = path.join(__dirname, "public");

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readFirstLine(filePath, maxBytes = 256 * 1024) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      const s = buf.subarray(0, n).toString("utf8");
      const idx = s.indexOf("\n");
      if (idx === -1) return s.replace(/\r$/, "");
      return s.slice(0, idx).replace(/\r$/, "");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function computeAppendStartOffset(filePath, previousSizeBytes) {
  if (!Number.isFinite(previousSizeBytes) || previousSizeBytes <= 0) return 0;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const lastPos = Math.max(0, Math.floor(previousSizeBytes) - 1);
      const one = Buffer.alloc(1);
      const n = fs.readSync(fd, one, 0, 1, lastPos);
      if (n === 1 && one[0] === 0x0a) {
        return Math.floor(previousSizeBytes);
      }

      const window = Math.min(64 * 1024, Math.floor(previousSizeBytes));
      const start = Math.max(0, Math.floor(previousSizeBytes) - window);
      const buf = Buffer.alloc(window);
      const n2 = fs.readSync(fd, buf, 0, window, start);
      if (!n2) return Math.floor(previousSizeBytes);
      const slice = buf.subarray(0, n2);
      const idx = slice.lastIndexOf(0x0a);
      if (idx === -1) return 0;
      return start + idx + 1;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

let jobReportCache = {
  loadedAtMs: 0,
  byFilePath: new Map(),
};
let jobReportLoadPromise = null;

let resultsCache = {
  loadedAtMs: 0,
  meta: null,
  runs: null,
};

let learningCache = {
  loadedAtMs: 0,
  meta: null,
  rows: null,
};

let db = null;
let dbCheckCache = {
  checkedAtMs: 0,
  resultsSig: null,
  learningSig: null,
};

function parseBoolLoose(val) {
  if (val === true) return true;
  if (val === false) return false;
  const s = String(val || "").trim().toLowerCase();
  if (!s) return false;
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function initDb() {
  if (db) return db;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  } catch {
    // ignore
  }
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_key TEXT PRIMARY KEY,
      timestamp TEXT,
      file_path TEXT,
      file_name TEXT,
      res_tier TEXT,
      codec_cat TEXT,
      is_hdr INTEGER,
      bitrate_mbps REAL,
      bitrate_bucket TEXT,
      bpp REAL,
      bpp_bucket TEXT,
      media_is_animation INTEGER,
      media_type TEXT,
      media_year INTEGER,
      media_genre TEXT,
      media_source_type TEXT,
      release_group TEXT,
      selected_strategy TEXT,
      sample_count INTEGER,
      selected_sample_count INTEGER,
      vmaf_stddev REAL,
      selected_cq REAL,
      selected_parameter_set_id TEXT,
      selected_vmaf REAL,
      selected_size_mb REAL,
      inferred_selection INTEGER,
      tested_param_count INTEGER,
      backfilled_from_jobreport INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON runs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_runs_res_tier ON runs(res_tier);
    CREATE INDEX IF NOT EXISTS idx_runs_codec_cat ON runs(codec_cat);
    CREATE INDEX IF NOT EXISTS idx_runs_is_hdr ON runs(is_hdr);
    CREATE INDEX IF NOT EXISTS idx_runs_anim ON runs(media_is_animation);
    CREATE INDEX IF NOT EXISTS idx_runs_bitrate_bucket ON runs(bitrate_bucket);
    CREATE INDEX IF NOT EXISTS idx_runs_bpp_bucket ON runs(bpp_bucket);

    CREATE TABLE IF NOT EXISTS learning (
      learning_key TEXT PRIMARY KEY,
      timestamp TEXT,
      res_tier TEXT,
      codec_cat TEXT,
      bitrate_mbps REAL,
      bitrate_bucket TEXT,
      selected_cq REAL,
      estimated_cq_at_target REAL,
      estimated_cq_confidence REAL,
      estimated_cq_method TEXT,
      estimated_cq_support INTEGER,
      estimated_cq_min_abs_delta REAL,
      tested_cq_min REAL,
      tested_cq_max REAL,
      range_width REAL,
      transcode_succeeded INTEGER,
      transcode_retry_count INTEGER,
      sweep_retry_count INTEGER,
      cq_range_retry_count INTEGER,
      media_genre TEXT,
      media_is_animation INTEGER,
      media_type TEXT,
      media_year INTEGER,
      metadata_source TEXT,
      media_source_type TEXT,
      model_slope REAL,
      model_intercept REAL,
      model_std REAL,
      model_training_samples INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_learning_timestamp ON learning(timestamp);

    CREATE TABLE IF NOT EXISTS priors (
      prior_key TEXT PRIMARY KEY,
      timestamp TEXT,
      file_path TEXT,
      param_id TEXT,
      n INTEGER,
      std REAL,
      width INTEGER,
      height INTEGER,
      codec_cat TEXT,
      is_hdr INTEGER,
      media_is_animation INTEGER,
      bitrate_mbps REAL,
      duration_sec REAL,
      release_group TEXT,
      title_key TEXT,
      media_year INTEGER,
      media_source_type TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_priors_timestamp ON priors(timestamp);
    CREATE INDEX IF NOT EXISTS idx_priors_n ON priors(n);
    CREATE INDEX IF NOT EXISTS idx_priors_codec ON priors(codec_cat);

    CREATE TABLE IF NOT EXISTS exclusions (
      exclusion_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      target_key TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_exclusions_kind ON exclusions(kind);
  `);

  const ensureColumns = (table, specs) => {
    try {
      const cols = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => String(r.name));
      for (const [name, type] of specs) {
        if (!cols.includes(name)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
        }
      }
    } catch {
      // ignore
    }
  };

  ensureColumns("runs", [["media_source_type", "TEXT"], ["tested_param_count", "INTEGER"]]);
  ensureColumns("priors", [["media_source_type", "TEXT"]]);

  // Lightweight schema migration for existing DBs.
  try {
    const cols = db.prepare("PRAGMA table_info(learning)").all().map((r) => String(r.name));
    const addIfMissing = (name, type) => {
      if (cols.includes(name)) return;
      db.exec(`ALTER TABLE learning ADD COLUMN ${name} ${type}`);
    };
    addIfMissing("media_source_type", "TEXT");
    addIfMissing("transcode_retry_count", "INTEGER");
    addIfMissing("sweep_retry_count", "INTEGER");
    addIfMissing("cq_range_retry_count", "INTEGER");
    addIfMissing("estimated_cq_at_target", "REAL");
    addIfMissing("estimated_cq_confidence", "REAL");
    addIfMissing("estimated_cq_method", "TEXT");
    addIfMissing("estimated_cq_support", "INTEGER");
    addIfMissing("estimated_cq_min_abs_delta", "REAL");
    addIfMissing("model_slope", "REAL");
    addIfMissing("model_intercept", "REAL");
    addIfMissing("model_std", "REAL");
    addIfMissing("model_training_samples", "INTEGER");
  } catch {
    // ignore
  }
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

function addExclusion({ kind, targetKey, reason }) {
  initDb();
  const exclusionKey = `${kind}::${targetKey}`;
  db.prepare(
    "INSERT INTO exclusions(exclusion_key,kind,target_key,reason,created_at) VALUES(?,?,?,?,?) ON CONFLICT(exclusion_key) DO UPDATE SET reason=excluded.reason",
  ).run(exclusionKey, kind, targetKey, String(reason || ""), nowIso());
  return { exclusionKey, kind, targetKey, reason: String(reason || ""), createdAt: nowIso() };
}

function removeExclusion({ kind, targetKey }) {
  initDb();
  const exclusionKey = `${kind}::${targetKey}`;
  db.prepare("DELETE FROM exclusions WHERE exclusion_key = ?").run(exclusionKey);
  return { ok: true };
}

function listExclusions() {
  initDb();
  return db
    .prepare("SELECT kind,target_key AS targetKey,reason,created_at AS createdAt FROM exclusions ORDER BY created_at DESC")
    .all();
}

function excludedRunKeysSet() {
  initDb();
  const rows = db.prepare("SELECT target_key FROM exclusions WHERE kind = 'run'").all();
  return new Set(rows.map((r) => String(r.target_key)));
}

function excludedPriorKeysSet() {
  initDb();
  const rows = db.prepare("SELECT target_key FROM exclusions WHERE kind = 'prior'").all();
  return new Set(rows.map((r) => String(r.target_key)));
}

function excludedLearningKeysSet() {
  initDb();
  const rows = db.prepare("SELECT target_key FROM exclusions WHERE kind = 'learning'").all();
  return new Set(rows.map((r) => String(r.target_key)));
}

function dbGetMeta(key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function dbSetMeta(key, value) {
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    key,
    String(value ?? ""),
  );
}

function csvSignature(stat) {
  if (!stat) return "missing";
  return `${stat.mtimeMs}:${stat.size}`;
}

function ingestRunsToDbFull(runs, resultsSig, resultsSizeBytes) {
  const insert = db.prepare(`
    INSERT INTO runs (
      run_key,timestamp,file_path,file_name,res_tier,codec_cat,is_hdr,bitrate_mbps,bitrate_bucket,bpp,bpp_bucket,
      media_is_animation,media_type,media_year,media_genre,media_source_type,release_group,selected_strategy,sample_count,selected_sample_count,
      vmaf_stddev,selected_cq,selected_parameter_set_id,selected_vmaf,selected_size_mb,inferred_selection,tested_param_count,backfilled_from_jobreport
    ) VALUES (
      @run_key,@timestamp,@file_path,@file_name,@res_tier,@codec_cat,@is_hdr,@bitrate_mbps,@bitrate_bucket,@bpp,@bpp_bucket,
      @media_is_animation,@media_type,@media_year,@media_genre,@media_source_type,@release_group,@selected_strategy,@sample_count,@selected_sample_count,
      @vmaf_stddev,@selected_cq,@selected_parameter_set_id,@selected_vmaf,@selected_size_mb,@inferred_selection,@tested_param_count,@backfilled_from_jobreport
    )
    ON CONFLICT(run_key) DO UPDATE SET
      timestamp=excluded.timestamp,
      file_path=excluded.file_path,
      file_name=excluded.file_name,
      res_tier=excluded.res_tier,
      codec_cat=excluded.codec_cat,
      is_hdr=excluded.is_hdr,
      bitrate_mbps=excluded.bitrate_mbps,
      bitrate_bucket=excluded.bitrate_bucket,
      bpp=excluded.bpp,
      bpp_bucket=excluded.bpp_bucket,
      media_is_animation=excluded.media_is_animation,
      media_type=excluded.media_type,
      media_year=excluded.media_year,
      media_genre=excluded.media_genre,
      media_source_type=excluded.media_source_type,
      release_group=excluded.release_group,
      selected_strategy=excluded.selected_strategy,
      sample_count=excluded.sample_count,
      selected_sample_count=excluded.selected_sample_count,
      vmaf_stddev=excluded.vmaf_stddev,
      selected_cq=excluded.selected_cq,
      selected_parameter_set_id=excluded.selected_parameter_set_id,
      selected_vmaf=excluded.selected_vmaf,
      selected_size_mb=excluded.selected_size_mb,
      inferred_selection=excluded.inferred_selection,
      tested_param_count=excluded.tested_param_count,
      backfilled_from_jobreport=excluded.backfilled_from_jobreport
  `);

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM runs").run();
    for (const r of runs) {
      insert.run({
        run_key: r.key,
        timestamp: r.timestamp || "",
        file_path: r.filePath || "",
        file_name: r.fileName || "",
        res_tier: r.resTier || "unknown",
        codec_cat: r.codecCat || "unknown",
        is_hdr: r.isHdr ? 1 : 0,
        bitrate_mbps: Number.isFinite(r.bitrateMbps) ? r.bitrateMbps : null,
        bitrate_bucket: r.bitrateBucket || "unknown",
        bpp: Number.isFinite(r.bpp) ? r.bpp : null,
        bpp_bucket: r.bppBucket || "unknown",
        media_is_animation: r.mediaIsAnimation ? 1 : 0,
        media_type: r.mediaType || "unknown",
        media_year: Number.isFinite(r.mediaYear) ? r.mediaYear : null,
        media_genre: Array.isArray(r.mediaGenre) ? r.mediaGenre.join(",") : "",
        media_source_type: r.mediaSourceType || "",
        release_group: r.releaseGroup || "",
        selected_strategy: r.selectedStrategy || "",
        sample_count: Number.isFinite(r.sampleCount) ? Math.round(r.sampleCount) : null,
        selected_sample_count: Number.isFinite(r.selectedSampleCount) ? Math.round(r.selectedSampleCount) : null,
        vmaf_stddev: Number.isFinite(r.vmafStddev) ? r.vmafStddev : null,
        selected_cq: Number.isFinite(r.selectedCq) ? r.selectedCq : null,
        selected_parameter_set_id: r.selectedParamSetId || "",
        selected_vmaf: Number.isFinite(r.selectedVmaf) ? r.selectedVmaf : null,
        selected_size_mb: Number.isFinite(r.selectedSizeMb) ? r.selectedSizeMb : null,
        inferred_selection: r.inferredSelection ? 1 : 0,
        tested_param_count: Number.isFinite(r.testedParamCount) ? Math.round(r.testedParamCount) : null,
        backfilled_from_jobreport: r.backfilledFromJobReport ? 1 : 0,
      });
    }

    dbSetMeta("resultsSig", resultsSig);
    dbSetMeta("resultsSizeBytes", resultsSizeBytes ?? "");
    dbSetMeta("runsIngestedAtMs", Date.now());
    dbSetMeta("runsSchemaV", "2");
  });

  tx();
}

function ingestRunsToDbIncremental(runs, resultsSig, resultsSizeBytes) {
  const insert = db.prepare(`
    INSERT INTO runs (
      run_key,timestamp,file_path,file_name,res_tier,codec_cat,is_hdr,bitrate_mbps,bitrate_bucket,bpp,bpp_bucket,
      media_is_animation,media_type,media_year,media_genre,media_source_type,release_group,selected_strategy,sample_count,selected_sample_count,
      vmaf_stddev,selected_cq,selected_parameter_set_id,selected_vmaf,selected_size_mb,inferred_selection,tested_param_count,backfilled_from_jobreport
    ) VALUES (
      @run_key,@timestamp,@file_path,@file_name,@res_tier,@codec_cat,@is_hdr,@bitrate_mbps,@bitrate_bucket,@bpp,@bpp_bucket,
      @media_is_animation,@media_type,@media_year,@media_genre,@media_source_type,@release_group,@selected_strategy,@sample_count,@selected_sample_count,
      @vmaf_stddev,@selected_cq,@selected_parameter_set_id,@selected_vmaf,@selected_size_mb,@inferred_selection,@tested_param_count,@backfilled_from_jobreport
    )
    ON CONFLICT(run_key) DO UPDATE SET
      timestamp=excluded.timestamp,
      file_path=excluded.file_path,
      file_name=excluded.file_name,
      res_tier=excluded.res_tier,
      codec_cat=excluded.codec_cat,
      is_hdr=excluded.is_hdr,
      bitrate_mbps=excluded.bitrate_mbps,
      bitrate_bucket=excluded.bitrate_bucket,
      bpp=excluded.bpp,
      bpp_bucket=excluded.bpp_bucket,
      media_is_animation=excluded.media_is_animation,
      media_type=excluded.media_type,
      media_year=excluded.media_year,
      media_genre=excluded.media_genre,
      media_source_type=excluded.media_source_type,
      release_group=excluded.release_group,
      selected_strategy=excluded.selected_strategy,
      sample_count=excluded.sample_count,
      selected_sample_count=excluded.selected_sample_count,
      vmaf_stddev=excluded.vmaf_stddev,
      selected_cq=excluded.selected_cq,
      selected_parameter_set_id=excluded.selected_parameter_set_id,
      selected_vmaf=excluded.selected_vmaf,
      selected_size_mb=excluded.selected_size_mb,
      inferred_selection=excluded.inferred_selection,
      tested_param_count=excluded.tested_param_count,
      backfilled_from_jobreport=excluded.backfilled_from_jobreport
  `);

  const tx = db.transaction(() => {
    for (const r of runs) {
      insert.run({
        run_key: r.key,
        timestamp: r.timestamp || "",
        file_path: r.filePath || "",
        file_name: r.fileName || "",
        res_tier: r.resTier || "unknown",
        codec_cat: r.codecCat || "unknown",
        is_hdr: r.isHdr ? 1 : 0,
        bitrate_mbps: Number.isFinite(r.bitrateMbps) ? r.bitrateMbps : null,
        bitrate_bucket: r.bitrateBucket || "unknown",
        bpp: Number.isFinite(r.bpp) ? r.bpp : null,
        bpp_bucket: r.bppBucket || "unknown",
        media_is_animation: r.mediaIsAnimation ? 1 : 0,
        media_type: r.mediaType || "unknown",
        media_year: Number.isFinite(r.mediaYear) ? r.mediaYear : null,
        media_genre: Array.isArray(r.mediaGenre) ? r.mediaGenre.join(",") : "",
        media_source_type: r.mediaSourceType || "",
        release_group: r.releaseGroup || "",
        selected_strategy: r.selectedStrategy || "",
        sample_count: Number.isFinite(r.sampleCount) ? Math.round(r.sampleCount) : null,
        selected_sample_count: Number.isFinite(r.selectedSampleCount) ? Math.round(r.selectedSampleCount) : null,
        vmaf_stddev: Number.isFinite(r.vmafStddev) ? r.vmafStddev : null,
        selected_cq: Number.isFinite(r.selectedCq) ? r.selectedCq : null,
        selected_parameter_set_id: r.selectedParamSetId || "",
        selected_vmaf: Number.isFinite(r.selectedVmaf) ? r.selectedVmaf : null,
        selected_size_mb: Number.isFinite(r.selectedSizeMb) ? r.selectedSizeMb : null,
        inferred_selection: r.inferredSelection ? 1 : 0,
        tested_param_count: Number.isFinite(r.testedParamCount) ? Math.round(r.testedParamCount) : null,
        backfilled_from_jobreport: r.backfilledFromJobReport ? 1 : 0,
      });
    }

    dbSetMeta("resultsSig", resultsSig);
    dbSetMeta("resultsSizeBytes", resultsSizeBytes ?? "");
    dbSetMeta("runsIngestedAtMs", Date.now());
    dbSetMeta("runsSchemaV", "2");
  });

  tx();
}

function ingestPriorsToDbFull(priors) {
  const insert = db.prepare(`
    INSERT INTO priors (
      prior_key,timestamp,file_path,param_id,n,std,width,height,codec_cat,is_hdr,media_is_animation,
      bitrate_mbps,duration_sec,release_group,title_key,media_year,media_source_type
    ) VALUES (
      @prior_key,@timestamp,@file_path,@param_id,@n,@std,@width,@height,@codec_cat,@is_hdr,@media_is_animation,
      @bitrate_mbps,@duration_sec,@release_group,@title_key,@media_year,@media_source_type
    )
    ON CONFLICT(prior_key) DO UPDATE SET
      timestamp=excluded.timestamp,
      file_path=excluded.file_path,
      param_id=excluded.param_id,
      n=excluded.n,
      std=excluded.std,
      width=excluded.width,
      height=excluded.height,
      codec_cat=excluded.codec_cat,
      is_hdr=excluded.is_hdr,
      media_is_animation=excluded.media_is_animation,
      bitrate_mbps=excluded.bitrate_mbps,
      duration_sec=excluded.duration_sec,
      release_group=excluded.release_group,
      title_key=excluded.title_key,
      media_year=excluded.media_year,
      media_source_type=excluded.media_source_type
  `);

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM priors").run();
    for (const p of priors) {
      insert.run({
        prior_key: p.priorKey,
        timestamp: p.timestamp || "",
        file_path: p.filePath || "",
        param_id: p.paramId || "",
        n: Number.isFinite(p.n) ? Math.round(p.n) : null,
        std: Number.isFinite(p.std) ? p.std : null,
        width: Number.isFinite(p.width) ? Math.round(p.width) : null,
        height: Number.isFinite(p.height) ? Math.round(p.height) : null,
        codec_cat: p.codecCat || "unknown",
        is_hdr: p.isHdr ? 1 : 0,
        media_is_animation: p.mediaIsAnimation ? 1 : 0,
        bitrate_mbps: Number.isFinite(p.bitrateMbps) ? p.bitrateMbps : null,
        duration_sec: Number.isFinite(p.durationSec) ? p.durationSec : null,
        release_group: p.releaseGroup || "",
        title_key: p.titleKey || "",
        media_year: Number.isFinite(p.mediaYear) ? Math.round(p.mediaYear) : null,
        media_source_type: p.mediaSourceType || "",
      });
    }
    dbSetMeta("priorsIngestedAtMs", Date.now());
    dbSetMeta("priorsSource", "csv");
  });

  tx();
}

function ingestPriorsToDbIncremental(priors) {
  const insert = db.prepare(`
    INSERT INTO priors (
      prior_key,timestamp,file_path,param_id,n,std,width,height,codec_cat,is_hdr,media_is_animation,
      bitrate_mbps,duration_sec,release_group,title_key,media_year,media_source_type
    ) VALUES (
      @prior_key,@timestamp,@file_path,@param_id,@n,@std,@width,@height,@codec_cat,@is_hdr,@media_is_animation,
      @bitrate_mbps,@duration_sec,@release_group,@title_key,@media_year,@media_source_type
    )
    ON CONFLICT(prior_key) DO UPDATE SET
      timestamp=excluded.timestamp,
      file_path=excluded.file_path,
      param_id=excluded.param_id,
      n=excluded.n,
      std=excluded.std,
      width=excluded.width,
      height=excluded.height,
      codec_cat=excluded.codec_cat,
      is_hdr=excluded.is_hdr,
      media_is_animation=excluded.media_is_animation,
      bitrate_mbps=excluded.bitrate_mbps,
      duration_sec=excluded.duration_sec,
      release_group=excluded.release_group,
      title_key=excluded.title_key,
      media_year=excluded.media_year,
      media_source_type=excluded.media_source_type
  `);

  const tx = db.transaction(() => {
    for (const p of priors) {
      insert.run({
        prior_key: p.priorKey,
        timestamp: p.timestamp || "",
        file_path: p.filePath || "",
        param_id: p.paramId || "",
        n: Number.isFinite(p.n) ? Math.round(p.n) : null,
        std: Number.isFinite(p.std) ? p.std : null,
        width: Number.isFinite(p.width) ? Math.round(p.width) : null,
        height: Number.isFinite(p.height) ? Math.round(p.height) : null,
        codec_cat: p.codecCat || "unknown",
        is_hdr: p.isHdr ? 1 : 0,
        media_is_animation: p.mediaIsAnimation ? 1 : 0,
        bitrate_mbps: Number.isFinite(p.bitrateMbps) ? p.bitrateMbps : null,
        duration_sec: Number.isFinite(p.durationSec) ? p.durationSec : null,
        release_group: p.releaseGroup || "",
        title_key: p.titleKey || "",
        media_year: Number.isFinite(p.mediaYear) ? Math.round(p.mediaYear) : null,
        media_source_type: p.mediaSourceType || "",
      });
    }
    dbSetMeta("priorsIngestedAtMs", Date.now());
    dbSetMeta("priorsSource", "csv");
  });

  tx();
}

function ingestLearningToDbFull(rows, learningSig, learningSizeBytes) {
  const insert = db.prepare(`
    INSERT INTO learning (
      learning_key,timestamp,res_tier,codec_cat,bitrate_mbps,bitrate_bucket,selected_cq,
      estimated_cq_at_target,estimated_cq_confidence,estimated_cq_method,estimated_cq_support,estimated_cq_min_abs_delta,
      tested_cq_min,tested_cq_max,range_width,
      transcode_succeeded,transcode_retry_count,sweep_retry_count,cq_range_retry_count,
      media_genre,media_is_animation,media_type,media_year,metadata_source,media_source_type,
      model_slope,model_intercept,model_std,model_training_samples
    ) VALUES (
      @learning_key,@timestamp,@res_tier,@codec_cat,@bitrate_mbps,@bitrate_bucket,@selected_cq,
      @estimated_cq_at_target,@estimated_cq_confidence,@estimated_cq_method,@estimated_cq_support,@estimated_cq_min_abs_delta,
      @tested_cq_min,@tested_cq_max,@range_width,
      @transcode_succeeded,@transcode_retry_count,@sweep_retry_count,@cq_range_retry_count,
      @media_genre,@media_is_animation,@media_type,@media_year,@metadata_source,@media_source_type,
      @model_slope,@model_intercept,@model_std,@model_training_samples
    )
    ON CONFLICT(learning_key) DO UPDATE SET
      timestamp=excluded.timestamp,
      res_tier=excluded.res_tier,
      codec_cat=excluded.codec_cat,
      bitrate_mbps=excluded.bitrate_mbps,
      bitrate_bucket=excluded.bitrate_bucket,
      selected_cq=excluded.selected_cq,
      estimated_cq_at_target=excluded.estimated_cq_at_target,
      estimated_cq_confidence=excluded.estimated_cq_confidence,
      estimated_cq_method=excluded.estimated_cq_method,
      estimated_cq_support=excluded.estimated_cq_support,
      estimated_cq_min_abs_delta=excluded.estimated_cq_min_abs_delta,
      tested_cq_min=excluded.tested_cq_min,
      tested_cq_max=excluded.tested_cq_max,
      range_width=excluded.range_width,
      transcode_succeeded=excluded.transcode_succeeded,
      transcode_retry_count=excluded.transcode_retry_count,
      sweep_retry_count=excluded.sweep_retry_count,
      cq_range_retry_count=excluded.cq_range_retry_count,
      media_genre=excluded.media_genre,
      media_is_animation=excluded.media_is_animation,
      media_type=excluded.media_type,
      media_year=excluded.media_year,
      metadata_source=excluded.metadata_source,
      media_source_type=excluded.media_source_type,
      model_slope=excluded.model_slope,
      model_intercept=excluded.model_intercept,
      model_std=excluded.model_std,
      model_training_samples=excluded.model_training_samples
  `);

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM learning").run();
    for (const r of rows) {
      const key = [
        r.timestamp || "",
        r.codecCat || "",
        r.width || "",
        r.height || "",
        r.selectedCq ?? "",
        r.testedCqMin ?? "",
        r.testedCqMax ?? "",
      ].join("|");
      insert.run({
        learning_key: key,
        timestamp: r.timestamp || "",
        res_tier: r.resTier || "unknown",
        codec_cat: r.codecCat || "unknown",
        bitrate_mbps: Number.isFinite(r.bitrateMbps) ? r.bitrateMbps : null,
        bitrate_bucket: r.bitrateBucket || "unknown",
        selected_cq: Number.isFinite(r.selectedCq) ? r.selectedCq : null,
        estimated_cq_at_target: Number.isFinite(r.estimatedCqAtTarget) ? r.estimatedCqAtTarget : null,
        estimated_cq_confidence: Number.isFinite(r.estimatedCqConfidence) ? r.estimatedCqConfidence : null,
        estimated_cq_method: r.estimatedCqMethod || "",
        estimated_cq_support: Number.isFinite(r.estimatedCqSupport) ? Math.round(r.estimatedCqSupport) : null,
        estimated_cq_min_abs_delta: Number.isFinite(r.estimatedCqMinAbsDelta) ? r.estimatedCqMinAbsDelta : null,
        tested_cq_min: Number.isFinite(r.testedCqMin) ? r.testedCqMin : null,
        tested_cq_max: Number.isFinite(r.testedCqMax) ? r.testedCqMax : null,
        range_width: Number.isFinite(r.rangeWidth) ? r.rangeWidth : null,
        transcode_succeeded: r.transcodeSucceeded ? 1 : 0,
        transcode_retry_count: Number.isFinite(r.transcodeRetryCount) ? Math.round(r.transcodeRetryCount) : 0,
        sweep_retry_count: Number.isFinite(r.sweepRetryCount) ? Math.round(r.sweepRetryCount) : 0,
        cq_range_retry_count: Number.isFinite(r.cqRangeRetryCount) ? Math.round(r.cqRangeRetryCount) : 0,
        media_genre: Array.isArray(r.mediaGenre) ? r.mediaGenre.join(",") : "",
        media_is_animation: r.mediaIsAnimation ? 1 : 0,
        media_type: r.mediaType || "unknown",
        media_year: Number.isFinite(r.mediaYear) ? r.mediaYear : null,
        metadata_source: r.metadataSource || "none",
        media_source_type: r.mediaSourceType || "",
        model_slope: Number.isFinite(r.modelSlope) ? r.modelSlope : null,
        model_intercept: Number.isFinite(r.modelIntercept) ? r.modelIntercept : null,
        model_std: Number.isFinite(r.modelStd) ? r.modelStd : null,
        model_training_samples: Number.isFinite(r.modelTrainingSamples) ? Math.round(r.modelTrainingSamples) : null,
      });
    }

    dbSetMeta("learningSig", learningSig);
    dbSetMeta("learningSizeBytes", learningSizeBytes ?? "");
    dbSetMeta("learningIngestedAtMs", Date.now());
    dbSetMeta("learningSchemaV", "4");
  });

  tx();
}

function ingestLearningToDbIncremental(rows, learningSig, learningSizeBytes) {
  const insert = db.prepare(`
    INSERT INTO learning (
      learning_key,timestamp,res_tier,codec_cat,bitrate_mbps,bitrate_bucket,selected_cq,
      estimated_cq_at_target,estimated_cq_confidence,estimated_cq_method,estimated_cq_support,estimated_cq_min_abs_delta,
      tested_cq_min,tested_cq_max,range_width,
      transcode_succeeded,transcode_retry_count,sweep_retry_count,cq_range_retry_count,
      media_genre,media_is_animation,media_type,media_year,metadata_source,media_source_type,
      model_slope,model_intercept,model_std,model_training_samples
    ) VALUES (
      @learning_key,@timestamp,@res_tier,@codec_cat,@bitrate_mbps,@bitrate_bucket,@selected_cq,
      @estimated_cq_at_target,@estimated_cq_confidence,@estimated_cq_method,@estimated_cq_support,@estimated_cq_min_abs_delta,
      @tested_cq_min,@tested_cq_max,@range_width,
      @transcode_succeeded,@transcode_retry_count,@sweep_retry_count,@cq_range_retry_count,
      @media_genre,@media_is_animation,@media_type,@media_year,@metadata_source,@media_source_type,
      @model_slope,@model_intercept,@model_std,@model_training_samples
    )
    ON CONFLICT(learning_key) DO UPDATE SET
      timestamp=excluded.timestamp,
      res_tier=excluded.res_tier,
      codec_cat=excluded.codec_cat,
      bitrate_mbps=excluded.bitrate_mbps,
      bitrate_bucket=excluded.bitrate_bucket,
      selected_cq=excluded.selected_cq,
      estimated_cq_at_target=excluded.estimated_cq_at_target,
      estimated_cq_confidence=excluded.estimated_cq_confidence,
      estimated_cq_method=excluded.estimated_cq_method,
      estimated_cq_support=excluded.estimated_cq_support,
      estimated_cq_min_abs_delta=excluded.estimated_cq_min_abs_delta,
      tested_cq_min=excluded.tested_cq_min,
      tested_cq_max=excluded.tested_cq_max,
      range_width=excluded.range_width,
      transcode_succeeded=excluded.transcode_succeeded,
      transcode_retry_count=excluded.transcode_retry_count,
      sweep_retry_count=excluded.sweep_retry_count,
      cq_range_retry_count=excluded.cq_range_retry_count,
      media_genre=excluded.media_genre,
      media_is_animation=excluded.media_is_animation,
      media_type=excluded.media_type,
      media_year=excluded.media_year,
      metadata_source=excluded.metadata_source,
      media_source_type=excluded.media_source_type,
      model_slope=excluded.model_slope,
      model_intercept=excluded.model_intercept,
      model_std=excluded.model_std,
      model_training_samples=excluded.model_training_samples
  `);

  const tx = db.transaction(() => {
    for (const r of rows) {
      const key = [
        r.timestamp || "",
        r.codecCat || "",
        r.width || "",
        r.height || "",
        r.selectedCq ?? "",
        r.testedCqMin ?? "",
        r.testedCqMax ?? "",
      ].join("|");
      insert.run({
        learning_key: key,
        timestamp: r.timestamp || "",
        res_tier: r.resTier || "unknown",
        codec_cat: r.codecCat || "unknown",
        bitrate_mbps: Number.isFinite(r.bitrateMbps) ? r.bitrateMbps : null,
        bitrate_bucket: r.bitrateBucket || "unknown",
        selected_cq: Number.isFinite(r.selectedCq) ? r.selectedCq : null,
        estimated_cq_at_target: Number.isFinite(r.estimatedCqAtTarget) ? r.estimatedCqAtTarget : null,
        estimated_cq_confidence: Number.isFinite(r.estimatedCqConfidence) ? r.estimatedCqConfidence : null,
        estimated_cq_method: r.estimatedCqMethod || "",
        estimated_cq_support: Number.isFinite(r.estimatedCqSupport) ? Math.round(r.estimatedCqSupport) : null,
        estimated_cq_min_abs_delta: Number.isFinite(r.estimatedCqMinAbsDelta) ? r.estimatedCqMinAbsDelta : null,
        tested_cq_min: Number.isFinite(r.testedCqMin) ? r.testedCqMin : null,
        tested_cq_max: Number.isFinite(r.testedCqMax) ? r.testedCqMax : null,
        range_width: Number.isFinite(r.rangeWidth) ? r.rangeWidth : null,
        transcode_succeeded: r.transcodeSucceeded ? 1 : 0,
        transcode_retry_count: Number.isFinite(r.transcodeRetryCount) ? Math.round(r.transcodeRetryCount) : 0,
        sweep_retry_count: Number.isFinite(r.sweepRetryCount) ? Math.round(r.sweepRetryCount) : 0,
        cq_range_retry_count: Number.isFinite(r.cqRangeRetryCount) ? Math.round(r.cqRangeRetryCount) : 0,
        media_genre: Array.isArray(r.mediaGenre) ? r.mediaGenre.join(",") : "",
        media_is_animation: r.mediaIsAnimation ? 1 : 0,
        media_type: r.mediaType || "unknown",
        media_year: Number.isFinite(r.mediaYear) ? r.mediaYear : null,
        metadata_source: r.metadataSource || "none",
        media_source_type: r.mediaSourceType || "",
        model_slope: Number.isFinite(r.modelSlope) ? r.modelSlope : null,
        model_intercept: Number.isFinite(r.modelIntercept) ? r.modelIntercept : null,
        model_std: Number.isFinite(r.modelStd) ? r.modelStd : null,
        model_training_samples: Number.isFinite(r.modelTrainingSamples) ? Math.round(r.modelTrainingSamples) : null,
      });
    }

    dbSetMeta("learningSig", learningSig);
    dbSetMeta("learningSizeBytes", learningSizeBytes ?? "");
    dbSetMeta("learningIngestedAtMs", Date.now());
    dbSetMeta("learningSchemaV", "4");
  });

  tx();
}

async function ensureDbFresh() {
  initDb();

  const resultsStat = safeStat(RESULTS_CSV);
  const learningStat = safeStat(LEARNING_CSV);
  const resultsSig = csvSignature(resultsStat);
  const learningSig = csvSignature(learningStat);

  const now = Date.now();
  if (
    dbCheckCache.resultsSig === resultsSig &&
    dbCheckCache.learningSig === learningSig &&
    now - dbCheckCache.checkedAtMs < 2000
  ) {
    return;
  }
  dbCheckCache = { checkedAtMs: now, resultsSig, learningSig };

  const dbResultsSig = dbGetMeta("resultsSig");
  const dbLearningSig = dbGetMeta("learningSig");
  const dbLearningSchemaV = dbGetMeta("learningSchemaV") || "1";
  const dbRunsSchemaV = dbGetMeta("runsSchemaV") || "1";
  const prevResultsSize = Number(dbGetMeta("resultsSizeBytes") || 0);
  const prevLearningSize = Number(dbGetMeta("learningSizeBytes") || 0);

  if (resultsSig !== "missing" && resultsStat) {
    const curSize = resultsStat.size;
    const needsRunsRebuildForSchema = dbRunsSchemaV !== "2";
    if (!dbResultsSig || needsRunsRebuildForSchema) {
      const { runs, priors } = await loadRunsFromResultsCsv(200000, { disableCache: true });
      ingestRunsToDbFull(runs, resultsSig, curSize);
      ingestPriorsToDbFull(priors);
    } else if (curSize > prevResultsSize) {
      const startOffset = computeAppendStartOffset(RESULTS_CSV, prevResultsSize);
      const { runs, priors } = await loadRunsFromResultsCsv(200000, { disableCache: true, startOffset });
      ingestRunsToDbIncremental(runs, resultsSig, curSize);
      ingestPriorsToDbIncremental(priors);
    } else if (curSize < prevResultsSize) {
      const { runs, priors } = await loadRunsFromResultsCsv(200000, { disableCache: true });
      ingestRunsToDbFull(runs, resultsSig, curSize);
      ingestPriorsToDbFull(priors);
    } else if (dbResultsSig !== resultsSig) {
      dbSetMeta("resultsSig", resultsSig);
    }
  }

  // If results CSV doesn't contain usable aggregated stddev priors (common when exporter was previously broken),
  // rebuild priors from Tdarr JobReports which contain vmafAggregatedResults with sampleCount+vmafStdDev.
  try {
    const priorsCount = initDb().prepare("SELECT COUNT(*) AS c FROM priors").get().c;
    if (priorsCount < 50 && TDARR_JOBREPORTS_DIR) {
      const priors = await loadPriorsFromJobReports({ maxFiles: 600 });
      if (priors.length >= 50) {
        ingestPriorsToDbFull(priors);
        dbSetMeta("priorsSource", "jobreports");
      }
    }
  } catch {
    // ignore
  }

  if (learningSig !== "missing" && learningStat) {
    const curSize = learningStat.size;
    const needsRebuildForSchema = dbLearningSchemaV !== "4";
    if (!dbLearningSig || needsRebuildForSchema) {
      const { rows } = await loadLearningRows(200000, { disableCache: true });
      ingestLearningToDbFull(rows, learningSig, curSize);
    } else if (curSize > prevLearningSize) {
      const startOffset = computeAppendStartOffset(LEARNING_CSV, prevLearningSize);
      const { rows } = await loadLearningRows(200000, { disableCache: true, startOffset });
      ingestLearningToDbIncremental(rows, learningSig, curSize);
    } else if (curSize < prevLearningSize) {
      const { rows } = await loadLearningRows(200000, { disableCache: true });
      ingestLearningToDbFull(rows, learningSig, curSize);
    } else if (dbLearningSig !== learningSig) {
      dbSetMeta("learningSig", learningSig);
    }
  }
}

function dbQueryRuns(limit = 2500) {
  initDb();
  const excludedRuns = excludedRunKeysSet();
  return db
    .prepare("SELECT * FROM runs ORDER BY timestamp DESC LIMIT ?")
    .all(limit)
    .map((r) => ({
      key: r.run_key,
      timestamp: r.timestamp,
      filePath: r.file_path,
      fileName: r.file_name,
      excluded: excludedRuns.has(String(r.run_key)),
      resTier: r.res_tier,
      codecCat: r.codec_cat,
      isHdr: !!r.is_hdr,
      bitrateMbps: r.bitrate_mbps,
      bitrateBucket: r.bitrate_bucket,
      bpp: r.bpp,
      bppBucket: r.bpp_bucket,
      mediaIsAnimation: !!r.media_is_animation,
      mediaType: r.media_type,
      mediaYear: r.media_year,
      mediaGenre: String(r.media_genre || "")
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean),
      mediaSourceType: r.media_source_type || "",
      releaseGroup: r.release_group || "",
      selectedStrategy: r.selected_strategy || "",
      sampleCount: r.sample_count,
      selectedSampleCount: r.selected_sample_count,
      vmafStddev: r.vmaf_stddev,
      selectedCq: r.selected_cq,
      selectedParamSetId: r.selected_parameter_set_id,
      selectedVmaf: r.selected_vmaf,
      selectedSizeMb: r.selected_size_mb,
      inferredSelection: !!r.inferred_selection,
      testedParamCount: r.tested_param_count,
      backfilledFromJobReport: !!r.backfilled_from_jobreport,
    }));
}

function dbQueryLearning(limit = 20000) {
  initDb();
  const excludedLearning = excludedLearningKeysSet();
  return db
    .prepare("SELECT * FROM learning ORDER BY timestamp DESC LIMIT ?")
    .all(limit)
    .map((r) => ({
      learningKey: r.learning_key,
      timestamp: r.timestamp,
      resTier: r.res_tier,
      codecCat: r.codec_cat,
      bitrateMbps: r.bitrate_mbps,
      bitrateBucket: r.bitrate_bucket,
      selectedCq: r.selected_cq,
      estimatedCqAtTarget: r.estimated_cq_at_target,
      estimatedCqConfidence: r.estimated_cq_confidence,
      estimatedCqMethod: r.estimated_cq_method,
      estimatedCqSupport: r.estimated_cq_support,
      estimatedCqMinAbsDelta: r.estimated_cq_min_abs_delta,
      testedCqMin: r.tested_cq_min,
      testedCqMax: r.tested_cq_max,
      rangeWidth: r.range_width,
      transcodeSucceeded: !!r.transcode_succeeded,
      excluded: excludedLearning.has(String(r.learning_key)),
      mediaGenre: String(r.media_genre || "")
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean),
      mediaIsAnimation: !!r.media_is_animation,
      mediaType: r.media_type,
      mediaYear: r.media_year,
      metadataSource: r.metadata_source,
      mediaSourceType: r.media_source_type || "",
      modelSlope: r.model_slope,
      modelIntercept: r.model_intercept,
      modelStd: r.model_std,
      modelTrainingSamples: r.model_training_samples,
    }));
}

function dbQueryPriors(limit = 4000) {
  initDb();
  const excludedPriors = excludedPriorKeysSet();
  return db
    .prepare(
      "SELECT prior_key,timestamp,n,std,width,height,codec_cat,is_hdr,media_is_animation,bitrate_mbps,duration_sec,release_group,title_key,media_year,media_source_type,file_path,param_id FROM priors ORDER BY timestamp DESC LIMIT ?",
    )
    .all(limit);
}

function parseIsoFromLinePrefix(line) {
  const m = String(line || "").match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

function maybeUpdateOverride(map, filePath, override, tsMs) {
  if (!filePath) return;
  const existing = map.get(filePath);
  if (!existing) {
    map.set(filePath, { ...override, tsMs: tsMs ?? 0 });
    return;
  }
  const existingTs = existing.tsMs ?? 0;
  const nextTs = tsMs ?? 0;
  if (nextTs >= existingTs) {
    map.set(filePath, { ...existing, ...override, tsMs: nextTs });
  }
}

async function loadJobReportOverrides({ maxFiles = 120, ttlMs = 5 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (!TDARR_JOBREPORTS_DIR) return jobReportCache.byFilePath;
  if (jobReportCache.loadedAtMs && now - jobReportCache.loadedAtMs < ttlMs) return jobReportCache.byFilePath;

  const dirStat = safeStat(TDARR_JOBREPORTS_DIR);
  if (!dirStat || !dirStat.isDirectory()) return jobReportCache.byFilePath;

  const byFilePath = new Map();
  const reportFiles = [];

  const top = fs.readdirSync(TDARR_JOBREPORTS_DIR, { withFileTypes: true });
  for (const d of top) {
    if (!d.isDirectory()) continue;
    const subdir = path.join(TDARR_JOBREPORTS_DIR, d.name);
    try {
      const files = fs.readdirSync(subdir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        if (!f.name.endsWith(".txt")) continue;
        const full = path.join(subdir, f.name);
        const st = safeStat(full);
        if (!st) continue;
        reportFiles.push({ full, mtimeMs: st.mtimeMs });
      }
    } catch {
      // ignore
    }
  }

  reportFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = reportFiles.slice(0, maxFiles);

  // Parse job report lines containing the variables blob; these include vmafSampleCount and vmafSelectedStdDev.
  // Example:
  // ...:{"_id":"<file>","outputNumber":1,"variables":{...,"vmafSampleCount":4,...,"vmafSelectedStdDev":1.08}}
  const idRe = /"_id"\s*:\s*"([^"]+)"/;
  const sampleCountRe = /"vmafSampleCount"\s*:\s*(\d+)/;
  const stdRe = /"vmafSelectedStdDev"\s*:\s*([0-9]+(?:\.[0-9]+)?)/;

  for (const rf of limited) {
    try {
      const rl = readline.createInterface({
        input: fs.createReadStream(rf.full, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      let lineCount = 0;
      for await (const line of rl) {
        lineCount += 1;
        if (lineCount % 4000 === 0) {
          await new Promise((r) => setImmediate(r));
        }
        if (!line.includes('"variables"')) continue;
        if (!line.includes("vmafSampleCount") && !line.includes("vmafSelectedStdDev")) continue;

        const idm = line.match(idRe);
        if (!idm) continue;
        const filePath = idm[1];
        const tsMs = parseIsoFromLinePrefix(line) ?? rf.mtimeMs;

        const scm = line.match(sampleCountRe);
        const sdm = line.match(stdRe);
        const override = {};
        if (scm) override.sampleCount = Number(scm[1]);
        if (sdm) override.vmafStddev = Number(sdm[1]);
        if (Object.keys(override).length === 0) continue;

        maybeUpdateOverride(byFilePath, filePath, override, tsMs);
      }
    } catch {
      // ignore individual file errors
    }

    // If we already have a healthy number of overrides, stop early to keep the API responsive.
    if (byFilePath.size >= 800) break;
  }

  jobReportCache = { loadedAtMs: now, byFilePath };
  return byFilePath;
}

function getJobReportOverridesNonBlocking() {
  if (!TDARR_JOBREPORTS_DIR) return jobReportCache.byFilePath;
  const now = Date.now();
  const stale = !jobReportCache.loadedAtMs || now - jobReportCache.loadedAtMs > 5 * 60 * 1000;
  if (stale && !jobReportLoadPromise) {
    jobReportLoadPromise = loadJobReportOverrides()
      .catch(() => jobReportCache.byFilePath)
      .finally(() => {
        jobReportLoadPromise = null;
      });
  }
  return jobReportCache.byFilePath;
}

async function loadPriorsFromJobReports({ maxFiles = 400 } = {}) {
  if (!TDARR_JOBREPORTS_DIR) return [];
  const dirStat = safeStat(TDARR_JOBREPORTS_DIR);
  if (!dirStat || !dirStat.isDirectory()) return [];

  const reportFiles = [];
  const top = fs.readdirSync(TDARR_JOBREPORTS_DIR, { withFileTypes: true });
  for (const d of top) {
    if (!d.isDirectory()) continue;
    const subdir = path.join(TDARR_JOBREPORTS_DIR, d.name);
    try {
      const files = fs.readdirSync(subdir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        if (!f.name.endsWith(".txt")) continue;
        const full = path.join(subdir, f.name);
        const st = safeStat(full);
        if (!st) continue;
        reportFiles.push({ full, mtimeMs: st.mtimeMs });
      }
    } catch {
      // ignore
    }
  }

  reportFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = reportFiles.slice(0, maxFiles);

  const priors = [];
  for (const rf of limited) {
    try {
      const rl = readline.createInterface({
        input: fs.createReadStream(rf.full, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      let lineCount = 0;
      for await (const line of rl) {
        lineCount += 1;
        if (lineCount % 4000 === 0) {
          await new Promise((r) => setImmediate(r));
        }
        if (!line.includes('"variables"')) continue;
        if (!line.includes("vmafAggregatedResults")) continue;
        const ts = _isoPrefixToIso(line) || null;
        const blob = _extractJsonBlob(line);
        if (!blob) continue;
        const filePath = String(blob._id || "");
        const vars = blob.variables || {};
        if (!filePath || !vars || typeof vars !== "object") continue;
        const agg = vars.vmafAggregatedResults;
        if (!Array.isArray(agg) || !agg.length) continue;

        const learning = vars.vmafLearningData || {};
        const width = Number(learning.source_width || 0) || 0;
        const height = Number(learning.source_height || 0) || 0;
        const codecCat = codecCategory(learning.source_codec || "");
        const bitrateMbps = Number(learning.source_bitrate_mbps || 0) || null;
        const durationSec = Number(learning.source_duration_sec || 0) || null;
        const isHdr = parseBoolLoose(vars.isHDR);
        const mediaIsAnimation = parseBoolLoose(vars.vmafMediaIsAnimation);
        const releaseGroup = String(vars.vmafReleaseGroupUsed || vars.vmafReleaseGroup || "");
        const mediaYear = Number(vars.vmafMediaYear || 0) || null;
        const titleKey = deriveTitleKey(vars.fileName || filePath);
        const mediaSourceType = normalizeSourceType(
          learning.media_source_type || vars.vmafMediaSourceType || learning.mediaSourceType,
        );

        const runKey = `${ts || new Date(rf.mtimeMs).toISOString()}||${filePath}`;
        for (const r of agg) {
          if (!r || typeof r !== "object") continue;
          const paramId = String(r.parameterSetId || r.id || "");
          const n = Number(r.sampleCount || 0);
          const std = Number(r.vmafStdDev || 0);
          if (!paramId) continue;
          if (!Number.isFinite(n) || n <= 0) continue;
          if (!Number.isFinite(std) || std <= 0) continue;
          priors.push({
            priorKey: `${runKey}||${paramId}`,
            timestamp: ts || new Date(rf.mtimeMs).toISOString(),
            filePath,
            paramId,
            n: Math.round(n),
            std,
            width,
            height,
            codecCat,
            isHdr,
            mediaIsAnimation,
          bitrateMbps,
          durationSec,
          releaseGroup,
          titleKey,
          mediaYear,
          mediaSourceType,
        });
      }
      }
    } catch {
      // ignore file
    }
  }

  return priors;
}

function _isoPrefixToIso(line) {
  const m = String(line || "").match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/);
  return m ? m[1] : null;
}

function _extractJsonBlob(line) {
  const brace = String(line || "").indexOf("{");
  if (brace === -1) return null;
  try {
    return JSON.parse(line.slice(brace));
  } catch {
    return null;
  }
}

async function findJobReportForFilePath(filePath, { maxFiles = 500 } = {}) {
  if (!TDARR_JOBREPORTS_DIR) return null;
  const dirStat = safeStat(TDARR_JOBREPORTS_DIR);
  if (!dirStat || !dirStat.isDirectory()) return null;

  const reportFiles = [];
  const top = fs.readdirSync(TDARR_JOBREPORTS_DIR, { withFileTypes: true });
  for (const d of top) {
    if (!d.isDirectory()) continue;
    const subdir = path.join(TDARR_JOBREPORTS_DIR, d.name);
    try {
      const files = fs.readdirSync(subdir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        if (!f.name.endsWith(".txt")) continue;
        const full = path.join(subdir, f.name);
        const st = safeStat(full);
        if (!st) continue;
        reportFiles.push({ full, mtimeMs: st.mtimeMs });
      }
    } catch {
      // ignore
    }
  }
  reportFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = reportFiles.slice(0, maxFiles);

  const idNeedle = `"${String(filePath).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  for (const rf of limited) {
    try {
      const rl = readline.createInterface({
        input: fs.createReadStream(rf.full, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.includes('"_id"')) continue;
        if (!line.includes(idNeedle)) continue;
        return rf.full;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

async function parseVmafScoresFromJobReport(jobReportPath) {
  const result = {
    jobReportPath,
    vmafScores: {}, // paramId => [{ sample: n, vmaf: score }]
    keyframeAlign: null,
    sampleCount: null,
  };
  const queuedRe = /\[\d+\/\d+\]\s+(\S+)\s+sample\s+(\d+)\s+\(GPU queued\)/;
  const queuedCpuRe = /\[\d+\/\d+\]\s+(\S+)\s+sample\s+(\d+)\s+\(CPU\)/;
  const scoreRe = /VMAF Score:\s*([0-9]+(?:\.[0-9]+)?)\s*\(harmonic\)/;
  const keyframeRe = /"keyframeAlign"\s*:\s*"?(\w+)"?/;
  const sampleCountRe = /"vmafSampleCount"\s*:\s*(\d+)/;

  let lastCtx = null; // { paramId, sample }

  const rl = readline.createInterface({
    input: fs.createReadStream(jobReportPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let lineCount = 0;
  for await (const line of rl) {
    lineCount += 1;
    if (lineCount % 4000 === 0) {
      await new Promise((r) => setImmediate(r));
    }

    if (result.keyframeAlign === null && line.includes("keyframeAlign")) {
      const m = line.match(keyframeRe);
      if (m) result.keyframeAlign = m[1] === "true" || m[1] === "1" || m[1] === "TRUE";
    }
    if (result.sampleCount === null && line.includes("vmafSampleCount")) {
      const m = line.match(sampleCountRe);
      if (m) result.sampleCount = Number(m[1]);
    }

    const qm = line.match(queuedRe) || line.match(queuedCpuRe);
    if (qm) {
      lastCtx = { paramId: qm[1], sample: Number(qm[2]) };
      continue;
    }
    const sm = line.match(scoreRe);
    if (sm && lastCtx) {
      const vmaf = Number(sm[1]);
      if (!Number.isFinite(vmaf)) continue;
      const k = lastCtx.paramId;
      if (!result.vmafScores[k]) result.vmafScores[k] = [];
      result.vmafScores[k].push({ sample: lastCtx.sample, vmaf });
      lastCtx = null;
    }
  }
  return result;
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function toNumber(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function codecCategory(codec) {
  const lc = String(codec || "").toLowerCase();
  if (lc.includes("av1")) return "av1";
  if (lc.includes("265") || lc.includes("hevc") || lc.includes("h265")) return "hevc";
  if (lc.includes("264") || lc.includes("avc") || lc.includes("h264")) return "h264";
  return lc ? "other" : "unknown";
}

function resolutionTier(width, height) {
  const w = Number(width || 0);
  const h = Number(height || 0);
  const pixels = w * h;
  if (pixels >= 3840 * 2160) return "4K";
  if (pixels >= 2560 * 1440) return "1440p";
  if (pixels >= 1920 * 1080) return "1080p";
  if (pixels >= 1280 * 720) return "720p";
  if (pixels > 0) return "sd";
  return "unknown";
}

function deriveTitleKey(name) {
  if (!name) return "";
  let base = String(name).replace(/\.[^.]+$/, "");
  const m = base.match(/^(.*?)[ ._-]?s\d{1,2}e\d{1,2}/i);
  if (m && m[1]) base = m[1];
  base = base.replace(/[_\-.]+/g, " ").trim().toLowerCase();
  return base;
}

function normalizeSourceType(raw) {
  if (raw === null || raw === undefined) return "";
  const cleaned = String(raw).trim().toLowerCase();
  if (!cleaned) return "";
  return cleaned.replace(/\s+/g, "_");
}

function hashStr(str, buckets) {
  if (!str) return 0;
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) + h + str.charCodeAt(i);
  }
  return Math.abs(h) % buckets;
}

function percentile(sortedAsc, p) {
  if (!sortedAsc || !sortedAsc.length) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

function bitrateBucket(mbps) {
  if (!Number.isFinite(mbps) || mbps <= 0) return "unknown";
  if (mbps < 1) return "<1";
  if (mbps < 2) return "1-2";
  if (mbps < 4) return "2-4";
  if (mbps < 8) return "4-8";
  if (mbps < 15) return "8-15";
  if (mbps < 25) return "15-25";
  return "25+";
}

function bppBucket(bpp) {
  if (!Number.isFinite(bpp) || bpp <= 0) return "unknown";
  if (bpp < 0.05) return "<0.05";
  if (bpp < 0.08) return "0.05-0.08";
  if (bpp < 0.11) return "0.08-0.11";
  if (bpp < 0.15) return "0.11-0.15";
  return "0.15+";
}

function parseSelectedCqFromId(paramId) {
  const m = String(paramId || "").match(/cq(\d{1,2}(?:\.\d+)?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function pickParamClosestToVmaf(perParamAgg, targetVmaf = 93) {
  if (!perParamAgg || perParamAgg.size === 0) return null;
  let best = null;
  for (const [paramId, agg] of perParamAgg.entries()) {
    const derivedVmaf =
      agg && Array.isArray(agg.sampleScores) && agg.sampleScores.length > 0
        ? harmonicMean(agg.sampleScores) ?? mean(agg.sampleScores.filter((v) => Number.isFinite(v)))
        : null;
    const vmaf =
      agg && Number.isFinite(agg.vmafHarmonic)
        ? agg.vmafHarmonic
        : Number.isFinite(derivedVmaf)
          ? derivedVmaf
          : null;
    const size = agg && Number.isFinite(agg.avgSizeMb) ? agg.avgSizeMb : null;
    if (!Number.isFinite(vmaf)) continue;
    const score = Math.abs(vmaf - targetVmaf);
    if (!best) {
      best = { paramId, score, size };
      continue;
    }
    if (score < best.score) {
      best = { paramId, score, size };
      continue;
    }
    if (score === best.score) {
      if (Number.isFinite(size) && Number.isFinite(best.size) && size < best.size) {
        best = { paramId, score, size };
      }
    }
  }
  return best ? best.paramId : null;
}

function mean(values) {
  if (!values.length) return null;
  const s = values.reduce((a, b) => a + b, 0);
  return s / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function basicStats(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (!nums.length) {
    return { count: 0, mean: null, median: null, p20: null, p80: null, min: null, max: null };
  }
  return {
    count: nums.length,
    mean: mean(nums),
    median: median(nums),
    p20: quantile(nums, 0.2),
    p80: quantile(nums, 0.8),
    min: Math.min(...nums),
    max: Math.max(...nums),
  };
}

function stddev(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length < 2) return null;
  const m = mean(nums);
  const variance = nums.reduce((acc, v) => acc + (v - m) * (v - m), 0) / nums.length;
  return Math.sqrt(variance);
}

function harmonicMean(values) {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!nums.length) return null;
  const denom = nums.reduce((acc, v) => acc + 1 / v, 0);
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return nums.length / denom;
}

async function loadRunsFromResultsCsv(limitRuns = 2500, opts = {}) {
  const stat = safeStat(RESULTS_CSV);
  if (!stat) {
    return { runs: [], meta: { exists: false, path: RESULTS_CSV } };
  }
  const meta = { exists: true, path: RESULTS_CSV, sizeBytes: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs };
  const now = Date.now();
  const startOffset = Number.isFinite(opts.startOffset) ? Math.max(0, Math.floor(opts.startOffset)) : 0;
  if (
    !opts.disableCache &&
    startOffset === 0 &&
    resultsCache.runs &&
    resultsCache.meta &&
    resultsCache.meta.mtimeMs === meta.mtimeMs &&
    resultsCache.meta.sizeBytes === meta.sizeBytes &&
    now - resultsCache.loadedAtMs < 30 * 1000
  ) {
    return { runs: resultsCache.runs.slice(0, limitRuns), meta };
  }

  const stream = fs.createReadStream(RESULTS_CSV, { encoding: "utf8", start: startOffset || 0 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headers = null;
  const headerIndex = new Map();
  const runMap = new Map(); // key => run object (first seen row)
  const selectedAggMap = new Map(); // key => Map(paramId => {sampleCount,stddev,vmafHarmonic,avgSizeMb,sampleIdxSet,sampleScores})
  const runStatsMap = new Map(); // key => { sampleIdxSet: Set<number>, maxAggSampleCount: number|null }

  if (startOffset > 0) {
    const first = readFirstLine(RESULTS_CSV);
    if (first) {
      headers = parseCsvLine(first).map((h) => String(h).trim().replace(/^"|"$/g, ""));
      headers.forEach((h, idx) => headerIndex.set(h, idx));
    }
  }

  let parsedLines = 0;
  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLine(line).map((h) => String(h).trim().replace(/^"|"$/g, ""));
      headers.forEach((h, idx) => headerIndex.set(h, idx));
      continue;
    }
    if (!line || !line.trim()) continue;
    parsedLines += 1;
    if (parsedLines % 5000 === 0) {
      await new Promise((r) => setImmediate(r));
    }

    const cols = parseCsvLine(line);
    const get = (name) => {
      const idx = headerIndex.get(name);
      if (idx === undefined) return "";
      return (cols[idx] || "").replace(/^"|"$/g, "");
    };

    const ts = get("timestamp");
    const filePath = get("file_path");
    if (!ts || !filePath) continue;
    const key = `${ts}||${filePath}`;
    const selStrategy = get("selected_strategy");
    const selParam = get("selected_parameter_set_id");
    if (!runStatsMap.has(key)) {
      runStatsMap.set(key, { sampleIdxSet: new Set(), maxAggSampleCount: null });
    }

    if (!runMap.has(key)) {
      const width = toNumber(get("video_width")) || 0;
      const height = toNumber(get("video_height")) || 0;
      const codec = get("video_codec");
      const isHdr = parseBoolLoose(get("is_hdr"));
      const mediaIsAnimation = parseBoolLoose(get("media_is_animation"));
      const mediaGenre = String(get("media_genre") || "")
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
      const videoBitrate = toNumber(get("video_bitrate")) || 0;
      const bitrateMbps = videoBitrate > 0 ? videoBitrate / 1_000_000 : null;
      const bpp = toNumber(get("source_bits_per_pixel"));
      const durationSeconds = toNumber(get("duration_seconds"));
      const releaseGroup = get("release_group") || "";
      const selectedVmaf = toNumber(get("selected_vmaf"));
      const selectedSizeMb = toNumber(get("selected_size_mb"));
      const titleKey = deriveTitleKey(get("file_name") || filePath);
      const mediaSourceType = normalizeSourceType(get("media_source_type"));

      runMap.set(key, {
        key,
        timestamp: ts,
        filePath,
        fileName: get("file_name"),
        width,
        height,
        resTier: resolutionTier(width, height),
        codec,
        codecCat: codecCategory(codec),
        isHdr,
        mediaType: get("media_type") || "unknown",
        mediaYear: toNumber(get("media_year")),
        mediaIsAnimation,
        mediaGenre,
        mediaSourceType,
        bitrateMbps,
        bitrateBucket: bitrateBucket(bitrateMbps),
        bpp,
        bppBucket: bppBucket(bpp),
        releaseGroup,
        titleKey,
        durationSeconds,
        selectedStrategy: selStrategy,
        selectedParamSetId: selParam,
        selectedVmaf,
        selectedSizeMb,
      });
    } else {
      const run = runMap.get(key);
      if (run) {
        if (!run.selectedStrategy && selStrategy) run.selectedStrategy = selStrategy;
        if (!run.selectedParamSetId && selParam) run.selectedParamSetId = selParam;
        if ((!Number.isFinite(run.selectedVmaf) || run.selectedVmaf === null) && Number.isFinite(toNumber(get("selected_vmaf")))) {
          run.selectedVmaf = toNumber(get("selected_vmaf"));
        }
        if ((!Number.isFinite(run.selectedSizeMb) || run.selectedSizeMb === null) && Number.isFinite(toNumber(get("selected_size_mb")))) {
          run.selectedSizeMb = toNumber(get("selected_size_mb"));
        }
        if (!run.releaseGroup && get("release_group")) run.releaseGroup = get("release_group");
        if (!run.titleKey && (get("file_name") || filePath)) run.titleKey = deriveTitleKey(get("file_name") || filePath);
        if ((!Number.isFinite(run.durationSeconds) || run.durationSeconds === null) && Number.isFinite(toNumber(get("duration_seconds")))) {
          run.durationSeconds = toNumber(get("duration_seconds"));
        }
        if (!run.mediaSourceType && get("media_source_type")) {
          run.mediaSourceType = normalizeSourceType(get("media_source_type"));
        }
      }
    }

    const paramSetId = get("parameter_set_id");
    const aggSampleCount = toNumber(get("aggregated_sample_count"));
    const aggStddev = toNumber(get("aggregated_vmaf_stddev"));
    const aggVmafHarmonic = toNumber(get("aggregated_vmaf_harmonic_mean"));
    const aggAvgSize = toNumber(get("aggregated_avg_size_mb"));
    const sampleIndex = toNumber(get("sample_index"));
    const sampleVmaf = toNumber(get("sample_vmaf_score"));
    if (!paramSetId) continue;
    if (
      !Number.isFinite(aggSampleCount) &&
      !Number.isFinite(aggStddev) &&
      !Number.isFinite(aggVmafHarmonic) &&
      !Number.isFinite(aggAvgSize) &&
      !Number.isFinite(sampleIndex) &&
      !Number.isFinite(sampleVmaf)
    ) {
      continue;
    }

    if (!selectedAggMap.has(key)) selectedAggMap.set(key, new Map());
    const m = selectedAggMap.get(key);
    if (!m.has(paramSetId)) {
      m.set(paramSetId, {
        sampleCount: null,
        stddev: null,
        vmafHarmonic: null,
        avgSizeMb: null,
        sampleIdxSet: new Set(),
        sampleScores: [],
      });
    }
    const entry = m.get(paramSetId);
    if (Number.isFinite(aggSampleCount)) entry.sampleCount = aggSampleCount;
    if (Number.isFinite(aggStddev)) entry.stddev = aggStddev;
    if (Number.isFinite(aggVmafHarmonic)) entry.vmafHarmonic = aggVmafHarmonic;
    if (Number.isFinite(aggAvgSize)) entry.avgSizeMb = aggAvgSize;
    if (Number.isFinite(sampleIndex)) entry.sampleIdxSet.add(sampleIndex);
    if (Number.isFinite(sampleVmaf)) entry.sampleScores.push(sampleVmaf);

    const runStats = runStatsMap.get(key);
    if (runStats) {
      if (Number.isFinite(sampleIndex)) runStats.sampleIdxSet.add(sampleIndex);
      if (Number.isFinite(aggSampleCount)) {
        runStats.maxAggSampleCount =
          runStats.maxAggSampleCount === null ? aggSampleCount : Math.max(runStats.maxAggSampleCount, aggSampleCount);
      }
    }
  }

  const runs = [];
  const priors = [];
  const overrides = getJobReportOverridesNonBlocking();
  for (const run of runMap.values()) {
    const runStats = runStatsMap.get(run.key);
    const runSampleCount =
      runStats && Number.isFinite(runStats.maxAggSampleCount)
        ? runStats.maxAggSampleCount
        : runStats && runStats.sampleIdxSet && runStats.sampleIdxSet.size > 0
          ? runStats.sampleIdxSet.size
          : null;

    const perParam = selectedAggMap.get(run.key);
    const rawCq = parseSelectedCqFromId(run.selectedParamSetId);
    const needsInference = !run.selectedParamSetId || rawCq === null;
    const inferredId = needsInference ? pickParamClosestToVmaf(perParam, 93) : null;
    const selectedId = (needsInference ? inferredId : run.selectedParamSetId) || inferredId || "";
    const selectedAgg = selectedId && perParam ? perParam.get(selectedId) : null;
    const selectedCq = parseSelectedCqFromId(selectedId);
    const inferredSampleCount =
      selectedAgg && !Number.isFinite(selectedAgg.sampleCount) && selectedAgg.sampleIdxSet && selectedAgg.sampleIdxSet.size > 0
        ? selectedAgg.sampleIdxSet.size
        : null;
    const inferredStd =
      selectedAgg && !Number.isFinite(selectedAgg.stddev) && selectedAgg.sampleScores && selectedAgg.sampleScores.length >= 2
        ? stddev(selectedAgg.sampleScores)
        : null;
    const selectedSampleCount =
      selectedAgg && Number.isFinite(selectedAgg.sampleCount)
        ? selectedAgg.sampleCount
        : Number.isFinite(inferredSampleCount)
          ? inferredSampleCount
          : null;
    const override = overrides.get(run.filePath);
    const finalSampleCount =
      (runSampleCount === null || runSampleCount <= 1) && override && Number.isFinite(override.sampleCount)
        ? override.sampleCount
        : runSampleCount;
    const finalStddev =
      (selectedAgg && (selectedAgg.stddev === null || selectedAgg.stddev === 0) && override && Number.isFinite(override.vmafStddev))
        ? override.vmafStddev
        : selectedAgg
          ? Number.isFinite(selectedAgg.stddev)
            ? selectedAgg.stddev
            : inferredStd
          : null;

    runs.push({
      ...run,
      selectedParamSetId: selectedId,
      selectedCq,
      // `sampleCount` represents the number of samples used for the run (what Extract Video Samples chose).
      // This is the most useful signal for the adaptive sampling dashboard.
      sampleCount: finalSampleCount,
      selectedSampleCount,
      vmafStddev: finalStddev,
      inferredSelection: !!inferredId && needsInference,
      testedParamCount: perParam ? perParam.size : null,
      backfilledFromJobReport: !!override && ((runSampleCount === null || runSampleCount <= 1) || (selectedAgg && selectedAgg.stddev === 0)),
    });

    if (perParam) {
      for (const [paramId, agg] of perParam.entries()) {
        const n = Number.isFinite(agg.sampleCount)
          ? agg.sampleCount
          : agg.sampleIdxSet && agg.sampleIdxSet.size > 0
            ? agg.sampleIdxSet.size
            : null;
        const s = Number.isFinite(agg.stddev)
          ? agg.stddev
          : agg.sampleScores && agg.sampleScores.length >= 2
            ? stddev(agg.sampleScores)
            : null;
        if (!Number.isFinite(n) || n <= 0) continue;
        if (!Number.isFinite(s) || s <= 0) continue;
        priors.push({
          priorKey: `${run.key}||${paramId}`,
          timestamp: run.timestamp,
          filePath: run.filePath,
          paramId,
          n: Math.round(n),
          std: s,
          width: run.width,
          height: run.height,
          codecCat: run.codecCat,
          isHdr: run.isHdr,
          mediaIsAnimation: run.mediaIsAnimation,
          bitrateMbps: run.bitrateMbps,
          durationSec: run.durationSeconds,
          releaseGroup: run.releaseGroup,
          titleKey: run.titleKey,
          mediaYear: run.mediaYear,
          mediaSourceType: run.mediaSourceType,
        });
      }
    }
  }

  runs.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  if (startOffset === 0 && !opts.disableCache) {
    resultsCache = { loadedAtMs: now, meta, runs };
  }
  return {
    runs: runs.slice(0, limitRuns),
    priors,
    meta,
  };
}

async function loadLearningRows(limitRows = 20000, opts = {}) {
  const stat = safeStat(LEARNING_CSV);
  if (!stat) {
    return { rows: [], meta: { exists: false, path: LEARNING_CSV } };
  }
  const meta = { exists: true, path: LEARNING_CSV, sizeBytes: stat.size, mtime: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs };
  const now = Date.now();
  const startOffset = Number.isFinite(opts.startOffset) ? Math.max(0, Math.floor(opts.startOffset)) : 0;
  if (
    !opts.disableCache &&
    startOffset === 0 &&
    learningCache.rows &&
    learningCache.meta &&
    learningCache.meta.mtimeMs === meta.mtimeMs &&
    learningCache.meta.sizeBytes === meta.sizeBytes &&
    now - learningCache.loadedAtMs < 30 * 1000
  ) {
    return { rows: learningCache.rows.slice(0, limitRows), meta };
  }

  const stream = fs.createReadStream(LEARNING_CSV, { encoding: "utf8", start: startOffset || 0 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headers = null;
  const headerIndex = new Map();
  const rows = [];

  if (startOffset > 0) {
    const first = readFirstLine(LEARNING_CSV);
    if (first) {
      headers = parseCsvLine(first).map((h) => String(h).trim().replace(/^"|"$/g, ""));
      headers.forEach((h, idx) => headerIndex.set(h, idx));
    }
  }

  let parsedLines = 0;
  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLine(line).map((h) => String(h).trim().replace(/^"|"$/g, ""));
      headers.forEach((h, idx) => headerIndex.set(h, idx));
      continue;
    }
    if (!line || !line.trim()) continue;
    if (rows.length >= limitRows) break;
    parsedLines += 1;
    if (parsedLines % 8000 === 0) {
      await new Promise((r) => setImmediate(r));
    }
    const cols = parseCsvLine(line);
    const get = (name) => {
      const idx = headerIndex.get(name);
      if (idx === undefined) return "";
      return (cols[idx] || "").replace(/^"|"$/g, "");
    };

    const w = toNumber(get("source_width")) || 0;
    const h = toNumber(get("source_height")) || 0;
    const bitrateMbps = toNumber(get("source_bitrate_mbps"));
    const cq = toNumber(get("selected_cq"));
    const cqMin = toNumber(get("tested_cq_min"));
    const cqMax = toNumber(get("tested_cq_max"));
    const transcodeRetryCount = toNumber(get("transcode_retry_count"));
    const sweepRetryCount = toNumber(get("sweep_retry_count"));
    const cqRangeRetryCount = toNumber(get("cq_range_retry_count"));
    const estimatedCqAtTarget = toNumber(get("estimated_cq_at_target"));
    const estimatedCqConfidence = toNumber(get("estimated_cq_confidence"));
    const estimatedCqSupport = toNumber(get("estimated_cq_support"));
    const estimatedCqMinAbsDelta = toNumber(get("estimated_cq_min_abs_delta"));
    const modelSlope = toNumber(get("model_slope"));
    const modelIntercept = toNumber(get("model_intercept"));
    const modelStd = toNumber(get("model_std"));
    const modelTrainingSamples = toNumber(get("model_training_samples"));
    const mediaSourceType = normalizeSourceType(get("media_source_type"));

    rows.push({
      timestamp: get("timestamp"),
      resTier: resolutionTier(w, h),
      codecCat: codecCategory(get("source_codec")),
      width: w,
      height: h,
      bitrateMbps,
      bitrateBucket: bitrateBucket(bitrateMbps),
      selectedCq: cq,
      testedCqMin: cqMin,
      testedCqMax: cqMax,
      rangeWidth: Number.isFinite(cqMin) && Number.isFinite(cqMax) ? cqMax - cqMin : null,
      transcodeSucceeded: parseBoolLoose(get("transcode_succeeded")),
      transcodeRetryCount: Number.isFinite(transcodeRetryCount) ? Math.round(transcodeRetryCount) : 0,
      sweepRetryCount: Number.isFinite(sweepRetryCount) ? Math.round(sweepRetryCount) : 0,
      cqRangeRetryCount: Number.isFinite(cqRangeRetryCount) ? Math.round(cqRangeRetryCount) : 0,
      estimatedCqAtTarget: Number.isFinite(estimatedCqAtTarget) ? estimatedCqAtTarget : null,
      estimatedCqConfidence: Number.isFinite(estimatedCqConfidence) ? Math.max(0, Math.min(1, estimatedCqConfidence)) : null,
      estimatedCqMethod: get("estimated_cq_method") || "",
      estimatedCqSupport: Number.isFinite(estimatedCqSupport) ? Math.round(estimatedCqSupport) : null,
      estimatedCqMinAbsDelta: Number.isFinite(estimatedCqMinAbsDelta) ? estimatedCqMinAbsDelta : null,
      modelSlope: Number.isFinite(modelSlope) ? modelSlope : null,
      modelIntercept: Number.isFinite(modelIntercept) ? modelIntercept : null,
      modelStd: Number.isFinite(modelStd) ? modelStd : null,
      modelTrainingSamples: Number.isFinite(modelTrainingSamples) ? Math.round(modelTrainingSamples) : null,
      mediaGenre: String(get("media_genre") || "")
        .split(/[;,]/)
        .map((g) => g.trim())
        .filter(Boolean),
      mediaIsAnimation: parseBoolLoose(get("media_is_animation")),
      mediaType: get("media_type") || "unknown",
      mediaYear: toNumber(get("media_year")),
      metadataSource: get("media_metadata_source") || "none",
      mediaSourceType,
    });
  }

  rows.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  if (startOffset === 0 && !opts.disableCache) {
    learningCache = { loadedAtMs: now, meta, rows };
  }
  return {
    rows: rows.slice(0, limitRows),
    meta,
  };
}

function breakdown(items, groupKeyFn, valueFn) {
  const buckets = new Map();
  for (const item of items) {
    const k = groupKeyFn(item);
    if (!buckets.has(k)) buckets.set(k, []);
    const v = valueFn(item);
    if (Number.isFinite(v)) buckets.get(k).push(v);
  }
  const out = [];
  for (const [k, vals] of buckets.entries()) {
    out.push({ key: k, ...basicStats(vals) });
  }
  out.sort((a, b) => (b.count || 0) - (a.count || 0));
  return out;
}

let sampleStdModelCache = {
  resultsSig: null,
  builtAtMs: 0,
  model: null,
};

function trainSampleStdModelFromPriors(priorsRows) {
  const rows = [];
  const excludedPriors = excludedPriorKeysSet();
  for (const r of priorsRows) {
    if (excludedPriors.has(String(r.prior_key || r.priorKey || ""))) continue;
    const n = Number(r.n);
    const std = Number(r.std);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (!Number.isFinite(std) || std <= 0) continue;

    let weight = 1;
    const t = Date.parse(r.timestamp || "");
    if (Number.isFinite(t)) {
      const days = (Date.now() - t) / (1000 * 60 * 60 * 24);
      weight = Math.exp(-days / 180);
    }

    rows.push({
      n,
      std,
      w: weight,
      width: Number(r.width || 0) || 0,
      height: Number(r.height || 0) || 0,
      codec: String(r.codec_cat || r.codec || "unknown"),
      hdr: !!r.is_hdr,
      anim: !!r.media_is_animation,
      bitrateMbps: Number.isFinite(Number(r.bitrate_mbps)) ? Number(r.bitrate_mbps) : 0.1,
      duration: Number.isFinite(Number(r.duration_sec)) ? Number(r.duration_sec) : 1,
      release: String(r.release_group || ""),
      title: String(r.title_key || ""),
      year: Number.isFinite(Number(r.media_year)) ? Number(r.media_year) : 0,
      sourceType: normalizeSourceType(r.media_source_type),
    });
  }
  if (rows.length < 5) return null;

  const RG_BUCKETS = 12;
  const TITLE_BUCKETS = 16;
  const SOURCE_BUCKETS = 8;

  function makeFeatures(row, overrideN = null) {
    const n = overrideN !== null ? overrideN : row.n;
    const pixels = Math.max(1, (row.width || 0) * (row.height || 0));
    const f = [];
    f.push(1);
    f.push(1 / Math.sqrt(Math.max(1, n)));
    f.push(Math.log10(Math.max(0.1, row.bitrateMbps || 0.1)));
    f.push(Math.log10(Math.max(1, row.duration || 1)));
    f.push(Math.log10(Math.max(1, pixels)));
    f.push(row.hdr ? 1 : 0);
    f.push(row.anim ? 1 : 0);
    f.push(row.codec === "hevc" ? 1 : 0);
    f.push(row.codec === "av1" ? 1 : 0);
    f.push(row.year ? row.year / 2100 : 0);

    const rgBucket = hashStr(String(row.release || "").toLowerCase(), RG_BUCKETS);
    for (let i = 0; i < RG_BUCKETS; i++) f.push(i === rgBucket ? 1 : 0);
    const titleBucket = hashStr(String(row.title || "").toLowerCase(), TITLE_BUCKETS);
    for (let j = 0; j < TITLE_BUCKETS; j++) f.push(j === titleBucket ? 1 : 0);
    const sourceBucket = hashStr(String(row.sourceType || ""), SOURCE_BUCKETS);
    for (let s = 0; s < SOURCE_BUCKETS; s++) f.push(s === sourceBucket ? 1 : 0);
    return f;
  }

  const d = makeFeatures(rows[0]).length;
  const XtWX = Array.from({ length: d }, () => Array.from({ length: d }, () => 0));
  const XtWy = Array.from({ length: d }, () => 0);
  const lambda = 0.1;

  for (const r of rows) {
    const fvec = makeFeatures(r);
    const w = r.w;
    for (let a = 0; a < d; a++) {
      XtWy[a] += fvec[a] * r.std * w;
      for (let b = 0; b < d; b++) {
        XtWX[a][b] += fvec[a] * fvec[b] * w;
      }
    }
  }
  for (let k = 0; k < d; k++) XtWX[k][k] += lambda;

  function solve(A, b) {
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      if (Math.abs(M[pivot][col]) < 1e-12) continue;
      if (pivot !== col) {
        const tmp = M[col];
        M[col] = M[pivot];
        M[pivot] = tmp;
      }
      const div = M[col][col];
      for (let c = col; c < n + 1; c++) M[col][c] /= div;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = M[r][col];
        for (let c = col; c < n + 1; c++) M[r][c] -= factor * M[col][c];
      }
    }
    return M.map((row) => row[n]);
  }

  const beta = solve(XtWX, XtWy);

  function predict(row, overrideN = null) {
    const f = makeFeatures(row, overrideN);
    let s = 0;
    for (let i = 0; i < beta.length && i < f.length; i++) s += beta[i] * f[i];
    return s;
  }

  let se = 0;
  let count = 0;
  for (const r of rows) {
    const p = predict(r);
    if (!Number.isFinite(p)) continue;
    const e = p - r.std;
    se += e * e;
    count += 1;
  }
  const rmse = count ? Math.sqrt(se / count) : null;

  return { beta, rmse, count: rows.length, featureCount: d, buckets: { RG_BUCKETS, TITLE_BUCKETS } };
}

function inferDefaultsFromBuckets({ resTier, bitrateBucket: bb }) {
  const tier = resTier || "1080p";
  const dims =
    tier === "4K"
      ? { width: 3840, height: 2160 }
      : tier === "1440p"
        ? { width: 2560, height: 1440 }
        : tier === "1080p"
          ? { width: 1920, height: 1080 }
          : tier === "720p"
            ? { width: 1280, height: 720 }
            : tier === "sd"
              ? { width: 720, height: 480 }
              : { width: 1920, height: 1080 };

  const bucket = bb || "";
  const bitrateMbps =
    bucket === "<1"
      ? 0.8
      : bucket === "1-2"
        ? 1.5
        : bucket === "2-4"
          ? 3
          : bucket === "4-8"
            ? 6
            : bucket === "8-15"
              ? 11.5
              : bucket === "15-25"
                ? 20
                : bucket === "25+"
                  ? 30
                  : null;
  return { ...dims, bitrateMbps };
}

function tdarrLearnedCqRangeFromDb({
  width,
  height,
  codec,
  bitrateMbps,
  mediaIsAnimation = null,
  mediaType = null,
  mediaYear = null,
  mediaSourceType = "",
  genreContains = "",
  learningBitrateTolerance = 20,
  learningMinSamples = 5,
  learningOnlySuccesses = true,
}) {
  if (!Number.isFinite(bitrateMbps) || bitrateMbps <= 0) {
    return { ok: false, reason: "source bitrate unknown" };
  }
  const tier = resolutionTier(width, height);
  const srcCodecCat = codecCategory(codec);
  const tol = Number(learningBitrateTolerance) / 100;
  const sigma = Math.max(0.05, tol / 2);

  const successClause = learningOnlySuccesses ? "WHERE transcode_succeeded = 1" : "";
  const rows = db
    .prepare(
      `SELECT learning_key AS learningKey, selected_cq AS cq, bitrate_mbps AS bitrate, res_tier AS tier, codec_cat AS codecCat,
              media_genre AS genre, media_is_animation AS anim, media_type AS mediaType, media_year AS year,
              media_source_type AS mediaSourceType,
              estimated_cq_at_target AS estCq, estimated_cq_confidence AS estConf, estimated_cq_method AS estMethod,
              transcode_retry_count AS tcr, sweep_retry_count AS scr, cq_range_retry_count AS crr
       FROM learning ${successClause}`,
    )
    .all();

  const excludedLearning = excludedLearningKeysSet();
  const scored = [];
  let strictCount = 0;
  let estimatedUsed = 0;
  let estimatedConfSum = 0;
  for (const r of rows) {
    // Note: existing DBs before migration may not have learning_key selected here; filter is best-effort.
    if (r.learningKey && excludedLearning.has(String(r.learningKey))) continue;
    const estCq = Number(r.estCq);
    const cq = Number.isFinite(estCq) ? estCq : Number(r.cq);
    const hb = Number(r.bitrate);
    if (!Number.isFinite(cq)) continue;
    if (!Number.isFinite(hb) || hb <= 0) continue;

    let w = 1.0;
    w *= String(r.tier || "") === tier ? 1.0 : 0.05;

    const rel = Math.abs(hb - bitrateMbps) / Math.max(0.01, bitrateMbps);
    w *= Math.exp(-(rel * rel) / (2 * sigma * sigma));

    const hCodec = String(r.codecCat || "unknown");
    w *= hCodec === srcCodecCat ? 1.0 : 0.55;
    if (hCodec === srcCodecCat) strictCount += 1;

    if (mediaIsAnimation !== null) {
      const hAnim = !!r.anim;
      w *= hAnim === !!mediaIsAnimation ? 1.0 : 0.7;
    }

    if (mediaType && mediaType !== "unknown") {
      const hType = String(r.mediaType || "").toLowerCase();
      if (hType && hType !== "unknown") w *= hType === String(mediaType).toLowerCase() ? 1.1 : 0.85;
    }

    if (Number.isFinite(mediaYear)) {
      const hYear = Number(r.year);
      if (Number.isFinite(hYear) && hYear > 0) {
        const dy = Math.abs(hYear - mediaYear);
        w *= Math.exp(-dy / 25);
      }
    }

    if (genreContains) {
      const g = String(r.genre || "").toLowerCase();
      const needle = String(genreContains).toLowerCase();
      if (needle && g.includes(needle)) w *= 1.25;
    }

    if (mediaSourceType) {
      const rowSource = normalizeSourceType(r.mediaSourceType);
      if (!rowSource) {
        w *= 0.92;
      } else if (rowSource === mediaSourceType) {
        w *= 1.15;
      } else {
        w *= 0.85;
      }
    }

    const retries = Number(r.tcr || 0) + Number(r.scr || 0) + Number(r.crr || 0);
    if (Number.isFinite(retries) && retries > 0) w *= 1.0 / (1.0 + retries);

    const estConf = Number(r.estConf);
    const estMethod = String(r.estMethod || "").toLowerCase();
    if (Number.isFinite(estCq)) {
      estimatedUsed += 1;
      if (Number.isFinite(estConf)) estimatedConfSum += Math.max(0, Math.min(1, estConf));
      if (Number.isFinite(estConf)) w *= 0.75 + 0.5 * Math.max(0, Math.min(1, estConf));
      if (estMethod.includes("clamped")) w *= 0.6;
    }

    if (!Number.isFinite(w) || w <= 0) continue;
    scored.push({ v: Math.round(cq), w });
  }

  const sumW = scored.reduce((a, p) => a + p.w, 0);
  const sumW2 = scored.reduce((a, p) => a + p.w * p.w, 0);
  const effN = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;
  if (effN < learningMinSamples) {
    return {
      ok: false,
      reason: `insufficient similar samples (${effN.toFixed(1)} < ${learningMinSamples})`,
      details: { tier, srcCodecCat, rows: scored.length, strictCodecRows: strictCount },
    };
  }

  const items = scored.slice().sort((a, b) => a.v - b.v);
  const wq = (q) => {
    const target = sumW * q;
    let c = 0;
    for (const it of items) {
      c += it.w;
      if (c >= target) return it.v;
    }
    return items.length ? items[items.length - 1].v : null;
  };

  const q20 = wq(0.2);
  const q80 = wq(0.8);
  const med = wq(0.5);
  if (!Number.isFinite(q20) || !Number.isFinite(q80) || !Number.isFinite(med)) {
    return { ok: false, reason: "unable to compute weighted quantiles" };
  }

  let learnedMin = Math.max(16, Math.floor(q20) - 1);
  let learnedMax = Math.min(51, Math.ceil(q80) + 1);
  if (learnedMax - learnedMin < 4) {
    learnedMin = Math.max(16, Math.round(med) - 2);
    learnedMax = Math.min(51, learnedMin + 4);
  }
  return {
    ok: true,
    tier,
    codecCat: srcCodecCat,
    bitrateMbps,
    looseUsed: strictCount < learningMinSamples,
    sampleCount: Math.round(effN),
    confidence: Math.min(1.0, effN / 20),
    estimatedUsed,
    estimatedMeanConfidence: estimatedUsed > 0 ? estimatedConfSum / estimatedUsed : null,
    min: learnedMin,
    max: learnedMax,
  };
}

function topGenres(runs, limit = 12) {
  const counts = new Map();
  for (const r of runs) {
    for (const g of r.mediaGenre || []) {
      const key = String(g).toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const arr = [...counts.entries()].map(([genre, count]) => ({ genre, count }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, limit);
}

function serveStatic(reqPath, res) {
  const resolved = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "forbidden");
    return;
  }
  const stat = safeStat(resolved);
  if (!stat || !stat.isFile()) {
    sendText(res, 404, "not found");
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  const contentType =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".js"
        ? "application/javascript; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  fs.createReadStream(resolved).pipe(res);
}

function sqlMedianExpr(col) {
  // Median without window functions: average of the two middle values.
  // Works in SQLite by using ORDER BY + LIMIT/OFFSET computed from COUNT.
  return `(
    SELECT AVG(${col}) FROM (
      SELECT ${col}
      FROM _t
      WHERE ${col} IS NOT NULL
      ORDER BY ${col}
      LIMIT 2 - (SELECT COUNT(*) FROM _t WHERE ${col} IS NOT NULL) % 2
      OFFSET (SELECT (COUNT(*) - 1) / 2 FROM _t WHERE ${col} IS NOT NULL)
    )
  )`;
}

function sqlQuantileExpr(col, q) {
  const clamped = Math.max(0, Math.min(1, Number(q)));
  // Nearest-rank quantile.
  return `(
    SELECT ${col} FROM (
      SELECT ${col}
      FROM _t
      WHERE ${col} IS NOT NULL
      ORDER BY ${col}
      LIMIT 1
      OFFSET CAST(ROUND((SELECT (COUNT(*) - 1) * ${clamped} FROM _t WHERE ${col} IS NOT NULL)) AS INT)
    )
  )`;
}

function buildWhereFromQuery(q, mapping) {
  const clauses = [];
  const params = {};
  for (const [key, spec] of Object.entries(mapping)) {
    const raw = q[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (spec.type === "int") {
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      clauses.push(`${spec.col} = @${key}`);
      params[key] = Math.trunc(v);
      continue;
    }
    if (spec.type === "number") {
      const v = Number(raw);
      if (!Number.isFinite(v)) continue;
      clauses.push(`${spec.col} = @${key}`);
      params[key] = v;
      continue;
    }
    // string (default)
    const s = String(raw);
    if (!s) continue;
    if (spec.like) {
      clauses.push(`${spec.col} LIKE @${key}`);
      params[key] = spec.like === "contains" ? `%${s}%` : s;
    } else {
      clauses.push(`${spec.col} = @${key}`);
      params[key] = s;
    }
  }
  return { whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function dbOptions() {
  initDb();
  const distinct = (table, col) =>
    db
      .prepare(`SELECT DISTINCT ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != '' ORDER BY ${col}`)
      .all()
      .map((r) => r.v);

  return {
    resTier: distinct("runs", "res_tier"),
    codecCat: distinct("runs", "codec_cat"),
    bitrateBucket: distinct("runs", "bitrate_bucket"),
    bppBucket: distinct("runs", "bpp_bucket"),
    mediaType: distinct("runs", "media_type"),
    sourceType: distinct("runs", "media_source_type"),
    // Genres come from CSV strings; expose common ones via the existing summary topGenres (fast).
  };
}

async function handleApi(req, res, parsedUrl) {
  const pathname = parsedUrl.pathname || "";
  if (pathname === "/api/health") {
    initDb();
    sendJson(res, 200, {
      ok: true,
      resultsCsv: { path: RESULTS_CSV, exists: !!safeStat(RESULTS_CSV) },
      learningCsv: { path: LEARNING_CSV, exists: !!safeStat(LEARNING_CSV) },
      db: { path: DB_PATH, exists: !!safeStat(DB_PATH) },
    });
    return;
  }

  await ensureDbFresh();

  const resultsStat = safeStat(RESULTS_CSV);
  const learningStat = safeStat(LEARNING_CSV);
  const resultsMeta = resultsStat
    ? { exists: true, path: RESULTS_CSV, sizeBytes: resultsStat.size, mtime: resultsStat.mtime.toISOString(), mtimeMs: resultsStat.mtimeMs }
    : { exists: false, path: RESULTS_CSV };
  const learningMeta = learningStat
    ? { exists: true, path: LEARNING_CSV, sizeBytes: learningStat.size, mtime: learningStat.mtime.toISOString(), mtimeMs: learningStat.mtimeMs }
    : { exists: false, path: LEARNING_CSV };

  const runs = dbQueryRuns(2500);
  const learningRows = dbQueryLearning(20000);
  const totalRuns = initDb().prepare("SELECT COUNT(*) AS c FROM runs").get().c;
  const totalLearning = initDb().prepare("SELECT COUNT(*) AS c FROM learning").get().c;
  const totalPriors = initDb().prepare("SELECT COUNT(*) AS c FROM priors").get().c;

  if (pathname === "/api/summary") {
    const sampleCounts = runs.map((r) => r.sampleCount).filter((v) => Number.isFinite(v));
    const cqs = runs.map((r) => r.selectedCq).filter((v) => Number.isFinite(v));
    const learningCqs = learningRows
      .map((r) => (Number.isFinite(r.estimatedCqAtTarget) ? r.estimatedCqAtTarget : r.selectedCq))
      .filter((v) => Number.isFinite(v));
    const learningWidths = learningRows.map((r) => r.rangeWidth).filter((v) => Number.isFinite(v));

    sendJson(res, 200, {
      csv: { results: resultsMeta, learning: learningMeta },
      counts: {
        runsParsed: runs.length,
        runsTotal: totalRuns,
        runsWithSampleCount: sampleCounts.length,
        runsWithSelectedCq: cqs.length,
        learningRows: learningRows.length,
        learningRowsTotal: totalLearning,
      },
      db: {
        path: DB_PATH,
        exists: !!safeStat(DB_PATH),
        runsIngestedAt: dbGetMeta("runsIngestedAtMs") ? new Date(Number(dbGetMeta("runsIngestedAtMs"))).toISOString() : null,
        learningIngestedAt: dbGetMeta("learningIngestedAtMs") ? new Date(Number(dbGetMeta("learningIngestedAtMs"))).toISOString() : null,
        priorsTotal: totalPriors,
        priorsIngestedAt: dbGetMeta("priorsIngestedAtMs") ? new Date(Number(dbGetMeta("priorsIngestedAtMs"))).toISOString() : null,
        priorsSource: dbGetMeta("priorsSource") || "unknown",
      },
      jobReports: {
        enabled: !!TDARR_JOBREPORTS_DIR,
        cacheEntries: jobReportCache.byFilePath.size,
        cacheLoadedAt: jobReportCache.loadedAtMs ? new Date(jobReportCache.loadedAtMs).toISOString() : null,
        cacheLoading: !!jobReportLoadPromise,
      },
      stats: {
        sampleCount: basicStats(sampleCounts),
        selectedCq: basicStats(cqs),
        learnedSelectedCq: basicStats(learningCqs),
        learnedRangeWidth: basicStats(learningWidths),
      },
      topGenres: topGenres(runs),
    });
    return;
  }

  if (pathname === "/api/samples/breakdown") {
    const by = (parsedUrl.query && parsedUrl.query.by) || "resTier";
    const keyFn =
      by === "codecCat"
        ? (r) => r.codecCat
        : by === "isHdr"
          ? (r) => (r.isHdr ? "HDR" : "SDR")
          : by === "mediaIsAnimation"
            ? (r) => (r.mediaIsAnimation ? "animation" : "live")
            : by === "bitrateBucket"
              ? (r) => r.bitrateBucket
              : by === "bppBucket"
                ? (r) => r.bppBucket
                : by === "resTier"
                  ? (r) => r.resTier
                  : (r) => String(r[by] || "unknown");
    sendJson(res, 200, {
      by,
      breakdown: breakdown(runs, keyFn, (r) => r.sampleCount),
    });
    return;
  }

  if (pathname === "/api/cq/breakdown") {
    const by = (parsedUrl.query && parsedUrl.query.by) || "resTier";
    const keyFn =
      by === "codecCat"
        ? (r) => r.codecCat
        : by === "isHdr"
          ? (r) => (r.isHdr ? "HDR" : "SDR")
          : by === "mediaIsAnimation"
            ? (r) => (r.mediaIsAnimation ? "animation" : "live")
            : by === "bitrateBucket"
              ? (r) => r.bitrateBucket
              : by === "bppBucket"
                ? (r) => r.bppBucket
                : by === "resTier"
                  ? (r) => r.resTier
                  : (r) => String(r[by] || "unknown");
    sendJson(res, 200, {
      by,
      breakdown: breakdown(runs, keyFn, (r) => r.selectedCq),
    });
    return;
  }

  if (pathname === "/api/learning/breakdown") {
    const by = (parsedUrl.query && parsedUrl.query.by) || "resTier";
    const metric = (parsedUrl.query && parsedUrl.query.metric) || "rangeWidth";
    const keyFn =
      by === "codecCat"
        ? (r) => r.codecCat
        : by === "mediaType"
          ? (r) => r.mediaType
          : by === "mediaIsAnimation"
            ? (r) => (r.mediaIsAnimation ? "animation" : "live")
            : by === "bitrateBucket"
              ? (r) => r.bitrateBucket
              : by === "resTier"
                ? (r) => r.resTier
                : (r) => String(r[by] || "unknown");
    const valueFn =
      metric === "selectedCq"
        ? (r) => r.selectedCq
        : metric === "rangeWidth"
          ? (r) => r.rangeWidth
          : (r) => r[metric];
    sendJson(res, 200, {
      by,
      metric,
      breakdown: breakdown(learningRows, keyFn, valueFn),
    });
    return;
  }

  if (pathname === "/api/retries/overtime") {
    initDb();
    const q = (parsedUrl && parsedUrl.query) || {};
    const days = Math.max(1, Math.min(365, Number.isFinite(Number(q.days)) ? Number(q.days) : 120));
    const rows = db
      .prepare(
        `WITH daily AS (
           SELECT substr(COALESCE(timestamp, ''), 1, 10) AS day,
                  COALESCE(sweep_retry_count, 0) AS retries
           FROM learning
           WHERE timestamp IS NOT NULL
             AND timestamp != ''
         )
         SELECT day,
                AVG(retries) AS avgRetries,
                AVG(retries + 1) AS avgSweeps,
                COUNT(*) AS jobs
         FROM daily
         GROUP BY day
         ORDER BY day DESC
         LIMIT @limit`,
      )
      .all({ limit: days })
      .map((r) => ({
        day: r.day,
        avgRetries: Number.isFinite(Number(r.avgRetries)) ? Number(r.avgRetries) : null,
        avgSweeps: Number.isFinite(Number(r.avgSweeps)) ? Number(r.avgSweeps) : null,
        jobs: Number(r.jobs || 0),
      }))
      .filter((r) => r.day);
    rows.sort((a, b) => String(a.day).localeCompare(String(b.day)));
    sendJson(res, 200, { points: rows, days });
    return;
  }

  if (pathname === "/api/encodes/overtime") {
    initDb();
    const q = (parsedUrl && parsedUrl.query) || {};
    const limit = Math.max(1, Math.min(365, Number.isFinite(Number(q.days)) ? Number(q.days) : 120));
    const rows = db
      .prepare(
        `SELECT substr(timestamp,1,10) AS day,
                SUM(COALESCE(sample_count,0) * COALESCE(tested_param_count,0)) AS encodes,
                SUM(COALESCE(sample_count,0)) AS samples,
                SUM(COALESCE(tested_param_count,0)) AS tested
         FROM runs
         WHERE timestamp IS NOT NULL AND timestamp != ''
         GROUP BY day
         ORDER BY day DESC
         LIMIT @limit`,
      )
      .all({ limit })
      .map((r) => ({
        day: r.day,
        encodes: Number.isFinite(Number(r.encodes)) ? Number(r.encodes) : 0,
        samples: Number.isFinite(Number(r.samples)) ? Number(r.samples) : 0,
        tested: Number.isFinite(Number(r.tested)) ? Number(r.tested) : 0,
      }))
      .filter((r) => r.day);
    rows.sort((a, b) => String(a.day).localeCompare(String(b.day)));
    sendJson(res, 200, { points: rows, days: limit });
    return;
  }

  if (pathname === "/api/runs") {
    const limit = Math.max(1, Math.min(5000, Number((parsedUrl.query && parsedUrl.query.limit) || 200)));
    sendJson(res, 200, { runs: dbQueryRuns(limit) });
    return;
  }

  if (pathname === "/api/config/options") {
    sendJson(res, 200, {
      options: dbOptions(),
      topGenres: topGenres(runs),
    });
    return;
  }

  if (pathname === "/api/exclusions") {
    sendJson(res, 200, { exclusions: listExclusions() });
    return;
  }

  if (pathname === "/api/exclusions/add") {
    const q = (parsedUrl && parsedUrl.query) || {};
    const kind = String(q.kind || "");
    const targetKey = String(q.targetKey || "");
    const reason = String(q.reason || "");
    if (!kind || !targetKey) {
      sendJson(res, 400, { error: "missing kind/targetKey" });
      return;
    }
    if (!["run", "learning", "prior"].includes(kind)) {
      sendJson(res, 400, { error: "invalid kind" });
      return;
    }
    const added = addExclusion({ kind, targetKey, reason });
    sendJson(res, 200, { added, exclusions: listExclusions() });
    return;
  }

  if (pathname === "/api/exclusions/remove") {
    const q = (parsedUrl && parsedUrl.query) || {};
    const kind = String(q.kind || "");
    const targetKey = String(q.targetKey || "");
    if (!kind || !targetKey) {
      sendJson(res, 400, { error: "missing kind/targetKey" });
      return;
    }
    removeExclusion({ kind, targetKey });
    sendJson(res, 200, { ok: true, exclusions: listExclusions() });
    return;
  }

  if (pathname === "/api/exclusions/bulk/priorStd") {
    initDb();
    const q = (parsedUrl && parsedUrl.query) || {};
    const stdMin = Number.isFinite(Number(q.stdMin)) ? Number(q.stdMin) : 10;
    const dryRun = parseBoolLoose(q.dryRun);
    const reason = String(q.reason || `stddev>=${stdMin} (likely misaligned samples)`);

    const rows = db
      .prepare(
        `SELECT prior_key AS priorKey, std
         FROM priors
         WHERE std IS NOT NULL
           AND std >= @stdMin
           AND prior_key NOT IN (SELECT target_key FROM exclusions WHERE kind = 'prior')
         ORDER BY std DESC`,
      )
      .all({ stdMin });

    if (!dryRun) {
      const tx = db.transaction(() => {
        for (const r of rows) addExclusion({ kind: "prior", targetKey: String(r.priorKey), reason });
      });
      tx();
    }

    sendJson(res, 200, {
      ok: true,
      stdMin,
      dryRun,
      matched: rows.length,
      added: dryRun ? 0 : rows.length,
      top: rows.slice(0, 10),
      exclusions: listExclusions().slice(0, 200),
    });
    return;
  }

  if (pathname === "/api/outliers/priors") {
    initDb();
    const q = (parsedUrl && parsedUrl.query) || {};
    const stdMin = Number.isFinite(Number(q.stdMin)) ? Number(q.stdMin) : 3.0;
    const limit = Math.max(1, Math.min(500, Number((parsedUrl.query && parsedUrl.query.limit) || 50)));
    const excludedPriors = excludedPriorKeysSet();

    const rows = db
      .prepare(
        `SELECT prior_key AS priorKey, timestamp, file_path AS filePath, param_id AS paramId, n, std
         FROM priors
         WHERE std IS NOT NULL AND std >= @stdMin
         ORDER BY std DESC
         LIMIT @limit`,
      )
      .all({ stdMin, limit })
      .map((r) => ({ ...r, excluded: excludedPriors.has(String(r.priorKey)) }));

    sendJson(res, 200, { stdMin, outliers: rows });
    return;
  }

  if (pathname === "/api/priors/std/distribution") {
    initDb();
    const q = (parsedUrl && parsedUrl.query) || {};
    const binWidthRaw = Number(q.binWidth);
    const maxRaw = Number(q.max);
    const binWidth = Number.isFinite(binWidthRaw) ? Math.max(0.05, Math.min(5, binWidthRaw)) : 0.25;
    const max = Number.isFinite(maxRaw) ? Math.max(binWidth, Math.min(200, maxRaw)) : 20;

    const stats = db
      .prepare(
        `WITH _t AS (
           SELECT std
           FROM priors
           WHERE std IS NOT NULL
             AND prior_key NOT IN (SELECT target_key FROM exclusions WHERE kind = 'prior')
         )
         SELECT
           (SELECT COUNT(*) FROM _t) AS n,
           (SELECT MIN(std) FROM _t) AS min,
           (SELECT MAX(std) FROM _t) AS max,
           ${sqlMedianExpr("std")} AS p50,
           ${sqlQuantileExpr("std", 0.9)} AS p90,
           ${sqlQuantileExpr("std", 0.95)} AS p95,
           ${sqlQuantileExpr("std", 0.99)} AS p99
        `,
      )
      .get();

    const bins = [];
    const binCount = Math.max(1, Math.ceil(max / binWidth));
    for (let i = 0; i < binCount; i++) {
      const start = i * binWidth;
      bins.push({ start, end: start + binWidth, count: 0 });
    }

    const rows = db
      .prepare(
        `SELECT CAST(std / @binWidth AS INT) AS bin, COUNT(*) AS c
         FROM priors
         WHERE std IS NOT NULL
           AND std >= 0
           AND std < @max
           AND prior_key NOT IN (SELECT target_key FROM exclusions WHERE kind = 'prior')
         GROUP BY bin
         ORDER BY bin`,
      )
      .all({ binWidth, max });

    for (const r of rows) {
      const idx = Number(r.bin);
      if (!Number.isFinite(idx) || idx < 0 || idx >= bins.length) continue;
      bins[idx].count = Number(r.c) || 0;
    }

    const tail = db
      .prepare(
        `SELECT COUNT(*) AS c
         FROM priors
         WHERE std IS NOT NULL
           AND std >= @max
           AND prior_key NOT IN (SELECT target_key FROM exclusions WHERE kind = 'prior')`,
      )
      .get({ max }).c;

    const nAllWithStd = db.prepare("SELECT COUNT(*) AS c FROM priors WHERE std IS NOT NULL").get().c;
    const nExcluded = db.prepare("SELECT COUNT(*) AS c FROM priors WHERE prior_key IN (SELECT target_key FROM exclusions WHERE kind = 'prior')").get().c;

    sendJson(res, 200, {
      binWidth,
      max,
      stats: {
        n: stats.n || 0,
        min: stats.min,
        max: stats.max,
        p50: stats.p50,
        p90: stats.p90,
        p95: stats.p95,
        p99: stats.p99,
      },
      counts: {
        priorsWithStdTotal: nAllWithStd || 0,
        priorsExcluded: nExcluded || 0,
        priorsIncluded: (nAllWithStd || 0) - (nExcluded || 0),
        tail: tail || 0,
      },
      bins,
    });
    return;
  }

  if (pathname === "/api/outliers/jobreport") {
    const q = (parsedUrl && parsedUrl.query) || {};
    const filePath = String(q.filePath || "");
    if (!filePath) {
      sendJson(res, 400, { error: "missing filePath" });
      return;
    }
    const jr = await findJobReportForFilePath(filePath, { maxFiles: 800 });
    if (!jr) {
      sendJson(res, 404, { error: "jobreport_not_found" });
      return;
    }
    const parsed = await parseVmafScoresFromJobReport(jr);
    sendJson(res, 200, parsed);
    return;
  }

  if (pathname === "/api/config/recommend") {
    initDb();
    const q = (parsedUrl && parsedUrl.query) || {};

    const runFilter = buildWhereFromQuery(q, {
      resTier: { col: "res_tier" },
      codecCat: { col: "codec_cat" },
      bitrateBucket: { col: "bitrate_bucket" },
      bppBucket: { col: "bpp_bucket" },
      mediaType: { col: "media_type" },
      isHdr: { col: "is_hdr", type: "int" },
      mediaIsAnimation: { col: "media_is_animation", type: "int" },
      genre: { col: "media_genre", like: "contains" },
    });

    const learningFilter = buildWhereFromQuery(q, {
      resTier: { col: "res_tier" },
      codecCat: { col: "codec_cat" },
      bitrateBucket: { col: "bitrate_bucket" },
      mediaType: { col: "media_type" },
      mediaIsAnimation: { col: "media_is_animation", type: "int" },
      genre: { col: "media_genre", like: "contains" },
    });

    const runStats = db
      .prepare(
        `WITH _t AS (SELECT sample_count AS sample_count, selected_cq AS selected_cq FROM runs ${runFilter.whereSql})
         SELECT
           (SELECT COUNT(*) FROM _t) AS n,
           ${sqlMedianExpr("sample_count")} AS sample_median,
           ${sqlQuantileExpr("sample_count", 0.2)} AS sample_p20,
           ${sqlQuantileExpr("sample_count", 0.8)} AS sample_p80,
           ${sqlMedianExpr("selected_cq")} AS cq_median,
           ${sqlQuantileExpr("selected_cq", 0.2)} AS cq_p20,
           ${sqlQuantileExpr("selected_cq", 0.8)} AS cq_p80
        `,
      )
      .get(runFilter.params);

    const learnStats = db
      .prepare(
        `WITH _t AS (
           SELECT tested_cq_min AS cq_min, tested_cq_max AS cq_max, range_width AS range_width, selected_cq AS selected_cq
           FROM learning ${learningFilter.whereSql}
         )
         SELECT
           (SELECT COUNT(*) FROM _t) AS n,
           ${sqlMedianExpr("cq_min")} AS cq_min_median,
           ${sqlMedianExpr("cq_max")} AS cq_max_median,
           ${sqlMedianExpr("range_width")} AS width_median,
           ${sqlMedianExpr("selected_cq")} AS learned_cq_median,
           ${sqlQuantileExpr("selected_cq", 0.2)} AS learned_cq_p20,
           ${sqlQuantileExpr("selected_cq", 0.8)} AS learned_cq_p80
        `,
      )
      .get(learningFilter.params);

    const clampCq = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      return Math.max(16, Math.min(51, n));
    };

    const sampleRec = Number.isFinite(runStats && runStats.sample_median) ? Math.round(runStats.sample_median) : null;

    // Prefer recommending a search range that covers the typical selected CQ distribution (p20..p80),
    // because "tested_cq_min/max" are the sweep bounds and selection often clusters near one end.
    let cqMinRec = clampCq(learnStats && learnStats.learned_cq_p20);
    let cqMaxRec = clampCq(learnStats && learnStats.learned_cq_p80);
    if (cqMinRec !== null && cqMaxRec !== null) {
      cqMinRec = clampCq(Math.floor(cqMinRec) - 1);
      cqMaxRec = clampCq(Math.ceil(cqMaxRec) + 1);
      if (cqMaxRec !== null && cqMinRec !== null && cqMaxRec - cqMinRec < 4) {
        cqMaxRec = clampCq(cqMinRec + 4);
      }
    } else {
      cqMinRec = clampCq(learnStats && learnStats.cq_min_median);
      cqMaxRec = clampCq(learnStats && learnStats.cq_max_median);
      if (cqMinRec === null || cqMaxRec === null) {
        const center = clampCq(runStats && runStats.cq_median);
        const width = Number.isFinite(learnStats && learnStats.width_median) ? learnStats.width_median : null;
        if (center !== null && Number.isFinite(width) && width > 0) {
          cqMinRec = clampCq(Math.floor(center - width / 2));
          cqMaxRec = clampCq(Math.ceil(center + width / 2));
        }
      }
    }
    if (cqMinRec !== null && cqMaxRec !== null && cqMaxRec < cqMinRec) {
      const t = cqMinRec;
      cqMinRec = cqMaxRec;
      cqMaxRec = t;
    }

    sendJson(res, 200, {
      filters: {
        resTier: q.resTier || "",
        codecCat: q.codecCat || "",
        isHdr: q.isHdr ?? "",
        mediaIsAnimation: q.mediaIsAnimation ?? "",
        bitrateBucket: q.bitrateBucket || "",
        bppBucket: q.bppBucket || "",
        mediaType: q.mediaType || "",
        genre: q.genre || "",
      },
      matches: {
        runs: runStats ? runStats.n : 0,
        learning: learnStats ? learnStats.n : 0,
      },
      recommended: {
        samples: sampleRec,
        cqMin: cqMinRec,
        cqMax: cqMaxRec,
      },
      stats: {
        samples: {
          median: runStats ? runStats.sample_median : null,
          p20: runStats ? runStats.sample_p20 : null,
          p80: runStats ? runStats.sample_p80 : null,
        },
        selectedCq: {
          median: runStats ? runStats.cq_median : null,
          p20: runStats ? runStats.cq_p20 : null,
          p80: runStats ? runStats.cq_p80 : null,
        },
        learnedRange: {
          cqMinMedian: learnStats ? learnStats.cq_min_median : null,
          cqMaxMedian: learnStats ? learnStats.cq_max_median : null,
          widthMedian: learnStats ? learnStats.width_median : null,
          selectedCqMedian: learnStats ? learnStats.learned_cq_median : null,
          selectedCqP20: learnStats ? learnStats.learned_cq_p20 : null,
          selectedCqP80: learnStats ? learnStats.learned_cq_p80 : null,
        },
      },
    });
    return;
  }

  if (pathname === "/api/config/tdarr-recommend") {
    initDb();
    const q = (parsedUrl && parsedUrl.query) || {};

    const resTier = String(q.resTier || "");
    const codecCat = String(q.codecCat || "");
    const codec = codecCat || "unknown";
    const isHdr = q.isHdr === "" || q.isHdr === undefined ? null : Number(q.isHdr) === 1;
    const mediaIsAnimation = q.mediaIsAnimation === "" || q.mediaIsAnimation === undefined ? null : Number(q.mediaIsAnimation) === 1;

    const defaults = inferDefaultsFromBuckets({
      resTier: resTier || "1080p",
      bitrateBucket: String(q.bitrateBucket || ""),
    });

    const width = Number.isFinite(Number(q.width)) ? Number(q.width) : defaults.width;
    const height = Number.isFinite(Number(q.height)) ? Number(q.height) : defaults.height;
    const bitrateMbps = Number.isFinite(Number(q.bitrateMbps))
      ? Number(q.bitrateMbps)
      : Number.isFinite(defaults.bitrateMbps)
        ? defaults.bitrateMbps
        : null;
    const durationSec = Number.isFinite(Number(q.durationSec)) ? Number(q.durationSec) : Number.isFinite(Number(q.durationMin)) ? Number(q.durationMin) * 60 : 1800;
    const mediaYear = Number.isFinite(Number(q.mediaYear)) ? Number(q.mediaYear) : null;
    const releaseGroup = String(q.releaseGroup || "");
    const titleKey = deriveTitleKey(String(q.title || ""));
    const mediaSourceType = normalizeSourceType(q.sourceType || q.mediaSourceType);

    const learningMinSamples = Number.isFinite(Number(q.learningMinSamples)) ? Number(q.learningMinSamples) : 5;
    const learningBitrateTolerance = Number.isFinite(Number(q.learningBitrateTolerance)) ? Number(q.learningBitrateTolerance) : 20;
    const learningOnlySuccesses = q.learningOnlySuccesses === undefined ? true : parseBoolLoose(String(q.learningOnlySuccesses));

    const minSegments = Number.isFinite(Number(q.minSegments)) ? Math.max(1, Math.round(Number(q.minSegments))) : 3;
    const maxSegments = Number.isFinite(Number(q.maxSegments)) ? Math.max(minSegments, Math.round(Number(q.maxSegments))) : 10;
    const targetStd = 1.5; // matches Tdarr Extract Video Samples

    const resultsSig = dbGetMeta("resultsSig") || null;
    if (!sampleStdModelCache.model || sampleStdModelCache.resultsSig !== resultsSig) {
      const priorsRows = dbQueryPriors(4000);
      sampleStdModelCache = {
        resultsSig,
        builtAtMs: Date.now(),
        model: trainSampleStdModelFromPriors(priorsRows),
      };
    }

    const model = sampleStdModelCache.model;
    let sampleRec = null;
    let samplePred = null;
    let sampleReason = "";
    let modelInfo = null;
    if (!model) {
      sampleReason = "no historical stddev model available";
    } else {
      const src = {
        width,
        height,
        codec: codecCategory(codec),
        hdr: isHdr === null ? false : isHdr,
        anim: mediaIsAnimation === null ? false : mediaIsAnimation,
        bitrateMbps: Number.isFinite(bitrateMbps) ? bitrateMbps : 0.1,
        duration: Number.isFinite(durationSec) ? durationSec : 1800,
        release: releaseGroup,
        title: titleKey,
        year: Number.isFinite(mediaYear) ? mediaYear : 0,
        sourceType: mediaSourceType,
      };

      const RG_BUCKETS = 12;
      const TITLE_BUCKETS = 16;
      const SOURCE_BUCKETS = 8;
      const pixels = Math.max(1, src.width * src.height);
      function buildFeaturesFor(n) {
        const f = [];
        f.push(1);
        f.push(1 / Math.sqrt(Math.max(1, n)));
        f.push(Math.log10(Math.max(0.1, src.bitrateMbps || 0.1)));
        f.push(Math.log10(Math.max(1, src.duration || 1)));
        f.push(Math.log10(Math.max(1, pixels)));
        f.push(src.hdr ? 1 : 0);
        f.push(src.anim ? 1 : 0);
        f.push(src.codec === "hevc" ? 1 : 0);
        f.push(src.codec === "av1" ? 1 : 0);
        f.push(src.year ? src.year / 2100 : 0);
        const rgBucket = hashStr(String(src.release || "").toLowerCase(), RG_BUCKETS);
        for (let i = 0; i < RG_BUCKETS; i++) f.push(i === rgBucket ? 1 : 0);
        const titleBucket = hashStr(String(src.title || "").toLowerCase(), TITLE_BUCKETS);
        for (let j = 0; j < TITLE_BUCKETS; j++) f.push(j === titleBucket ? 1 : 0);
        const sourceBucket = hashStr(String(src.sourceType || ""), SOURCE_BUCKETS);
        for (let s = 0; s < SOURCE_BUCKETS; s++) f.push(s === sourceBucket ? 1 : 0);
        return f;
      }
      function predict(n) {
        const f = buildFeaturesFor(n);
        let s = 0;
        for (let i = 0; i < model.beta.length && i < f.length; i++) s += model.beta[i] * f[i];
        return s;
      }

      let chosen = null;
      for (let n = minSegments; n <= maxSegments; n++) {
        const pred = predict(n);
        if (Number.isFinite(pred) && pred <= targetStd) {
          chosen = { n, pred };
          break;
        }
      }
      if (!chosen) {
        const predMax = predict(maxSegments);
        chosen = { n: maxSegments, pred: predMax };
      }
      sampleRec = chosen.n;
      samplePred = chosen.pred;
      sampleReason = `Learned target std<=${targetStd} (pred=${Number.isFinite(samplePred) ? samplePred.toFixed(3) : "n/a"}, rows=${model.count}, rmse=${model.rmse !== null ? model.rmse.toFixed(3) : "n/a"})`;
      modelInfo = { rows: model.count, rmse: model.rmse, builtAtMs: sampleStdModelCache.builtAtMs };
    }

    const learned = tdarrLearnedCqRangeFromDb({
      width,
      height,
      codec,
      bitrateMbps,
      mediaIsAnimation,
      mediaType: String(q.mediaType || ""),
      mediaYear,
      mediaSourceType,
      genreContains: String(q.genre || ""),
      learningBitrateTolerance,
      learningMinSamples,
      learningOnlySuccesses,
    });

    sendJson(res, 200, {
      effectiveInput: {
        width,
        height,
        resTier: resolutionTier(width, height),
        codecCat: codecCategory(codec),
        bitrateMbps,
        durationSec,
        isHdr,
        mediaIsAnimation,
        mediaYear,
        mediaSourceType,
        releaseGroup,
        titleKey,
        learningMinSamples,
        learningBitrateTolerance,
        learningOnlySuccesses,
        minSegments,
        maxSegments,
        targetStd,
      },
      adaptiveSamples: {
        recommended: sampleRec,
        predictedStd: samplePred,
        reason: sampleReason,
        model: modelInfo,
      },
      learnedCqRange: learned,
    });
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = url.parse(req.url || "/", true);
    const pathname = parsedUrl.pathname || "/";
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, parsedUrl);
      return;
    }
    if (pathname === "/" || pathname === "/index.html") {
      serveStatic("index.html", res);
      return;
    }
    serveStatic(pathname.replace(/^\//, ""), res);
  } catch (err) {
    sendJson(res, 500, { error: "internal_error", message: String(err && err.message ? err.message : err) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`dashboard listening on :${PORT}`);
  console.log(`RESULTS_CSV=${RESULTS_CSV}`);
  console.log(`LEARNING_CSV=${LEARNING_CSV}`);
  console.log(`DB_PATH=${DB_PATH}`);
  if (TDARR_JOBREPORTS_DIR) {
    console.log(`TDARR_JOBREPORTS_DIR=${TDARR_JOBREPORTS_DIR}`);
  }
  // Warm caches in background for responsive first page load.
  setTimeout(() => {
    ensureDbFresh().catch(() => {});
    getJobReportOverridesNonBlocking();
  }, 250);
});
