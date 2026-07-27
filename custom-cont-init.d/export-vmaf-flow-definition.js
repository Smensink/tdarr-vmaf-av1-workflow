#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/app/server/Tdarr/DB2/SQL/database.db', { readOnly: true });
const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get('YR5PZ1QaD');
if (!row) throw new Error('Live VMAF flow not found');
const flow = JSON.parse(row.json_data);

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
      output[key] = arr === 'sonarr' || host.includes(':8989') ? '${TDARR_SONARR_API_KEY}' : '${TDARR_RADARR_API_KEY}';
    } else output[key] = scrub(raw);
  }
  return output;
}

const target = '/app/configs/flow_YR5PZ1QaD_CANONICAL.json';
fs.writeFileSync(target, `${JSON.stringify(scrub(flow), null, 2)}\n`, 'utf8');
console.log(`Exported sanitized canonical flow: ${target}`);
