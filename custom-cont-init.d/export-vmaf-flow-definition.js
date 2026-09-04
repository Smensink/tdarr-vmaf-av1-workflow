#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const FLOW_ID = 'YR5PZ1QaD';
const DB_PATH = process.env.TDARR_SQL_DB || '/app/server/Tdarr/DB2/SQL/database.db';
const TARGET = process.env.TDARR_CANONICAL_FLOW_TARGET ||
  '/app/configs/flow_YR5PZ1QaD_CANONICAL.json';
const SECRET_SHAPED_KEY = /token|key|secret|password|passwd|auth|credential|webhook/i;
const PLACEHOLDER_VALUE = /^\$\{[A-Z_][A-Z0-9_]*\}$/;

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'plexToken') output[key] = '${TDARR_PLEX_TOKEN}';
    else if (key === 'tmdbApiKey') output[key] = '${TDARR_TMDB_API_KEY}';
    else if (key === 'tvdbApiKey') output[key] = '${TDARR_TVDB_API_KEY}';
    else if (key === 'arr_api_key') {
      const arr = String(value.arr || '').toLowerCase();
      const host = String(value.arr_host || '');
      output[key] = arr === 'sonarr' || host.includes(':8989')
        ? '${TDARR_SONARR_API_KEY}' : '${TDARR_RADARR_API_KEY}';
    } else output[key] = scrub(raw);
  }
  return output;
}

function assertNoUnscrubbedSecrets(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUnscrubbedSecrets(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, raw] of Object.entries(value)) {
    const path = `${location}.${key}`;
    const isPlaceholder = typeof raw === 'string' && PLACEHOLDER_VALUE.test(raw);
    if (SECRET_SHAPED_KEY.test(key) && !isPlaceholder) {
      throw new Error(`Refusing canonical export: unscrubbed secret-shaped key at ${path}`);
    }
    assertNoUnscrubbedSecrets(raw, path);
  }
}

function main() {
  // Canonical snapshots are reviewed release inputs, never startup output. Require
  // two explicit operator signals so legacy init callers remain side-effect free.
  if (process.env.ALLOW_TDARR_CANONICAL_FLOW_EXPORT !== '1' ||
      !process.argv.includes('--apply')) {
    console.log('[canonical export] SKIP: explicit ALLOW_TDARR_CANONICAL_FLOW_EXPORT=1 and --apply required');
    return { written: false };
  }

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(FLOW_ID);
    if (!row) throw new Error(`Live VMAF flow ${FLOW_ID} not found`);
    const flow = JSON.parse(row.json_data);
    const sanitized = scrub(flow);
    assertNoUnscrubbedSecrets(sanitized);
    const payload = `${JSON.stringify(sanitized, null, 2)}\n`;
    const temporary = `${TARGET}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, payload, { encoding: 'utf8', flag: 'wx' });
    try {
      fs.renameSync(temporary, TARGET);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch (_) {}
      throw error;
    }
    console.log(`Exported sanitized canonical flow: ${TARGET}`);
    return { written: true, target: TARGET };
  } finally {
    db.close();
  }
}

module.exports = { FLOW_ID, DB_PATH, TARGET, scrub, assertNoUnscrubbedSecrets, main };

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}
