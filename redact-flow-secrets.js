'use strict';

const fs = require('fs');
const path = require('path');

const configsDir = path.join(__dirname, 'configs');
const files = fs.readdirSync(configsDir)
  .filter((name) => /^flow.*\.json$/i.test(name))
  .map((name) => path.join(configsDir, name));

function arrPlaceholder(inputs) {
  const arr = String(inputs.arr || '').toLowerCase();
  const host = String(inputs.arr_host || '');
  return arr === 'sonarr' || host.includes(':8989')
    ? '${TDARR_SONARR_API_KEY}'
    : '${TDARR_RADARR_API_KEY}';
}

function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'plexToken') output[key] = '${TDARR_PLEX_TOKEN}';
    else if (key === 'tmdbApiKey') output[key] = '${TDARR_TMDB_API_KEY}';
    else if (key === 'tvdbApiKey') output[key] = '${TDARR_TVDB_API_KEY}';
    else if (key === 'arr_api_key') output[key] = arrPlaceholder(value);
    else output[key] = scrub(raw);
  }
  return output;
}

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    fs.writeFileSync(file, `${JSON.stringify(scrub(parsed))}\n`, 'utf8');
  } catch (_) {
    const redacted = raw
      .replace(/("plexToken"\s*:\s*")[^"]*(")/g, '$1${TDARR_PLEX_TOKEN}$2')
      .replace(/("tmdbApiKey"\s*:\s*")[^"]*(")/g, '$1${TDARR_TMDB_API_KEY}$2')
      .replace(/("tvdbApiKey"\s*:\s*")[^"]*(")/g, '$1${TDARR_TVDB_API_KEY}$2')
      .replace(/("arr_api_key"\s*:\s*")[^"]*(")/g, '$1${TDARR_ARR_API_KEY}$2');
    fs.writeFileSync(file, redacted, 'utf8');
    console.warn(`Redacted malformed snapshot without parsing: ${path.basename(file)}`);
  }
}

console.log(`Redacted credential fields in ${files.length} flow snapshots.`);
