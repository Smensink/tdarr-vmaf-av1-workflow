'use strict';

const fs = require('fs');
const path = require('path');

const ARR_PLACEHOLDERS = Object.freeze({
  radarr: '${TDARR_RADARR_API_KEY}',
  sonarr: '${TDARR_SONARR_API_KEY}',
});

function arrService(inputs) {
  const declared = String(inputs.arr || '').trim().toLowerCase();
  if (declared && !Object.prototype.hasOwnProperty.call(ARR_PLACEHOLDERS, declared)) {
    throw new Error('refusing to redact arr_api_key with an unknown Arr service');
  }
  const host = String(inputs.arr_host || '').trim().toLowerCase();
  const portMatch = host.match(/:(7878|8989)(?:[/?#]|$)/u);
  const hostService = portMatch
    ? (portMatch[1] === '7878' ? 'radarr' : 'sonarr')
    : '';
  if (declared && hostService && declared !== hostService) {
    throw new Error('refusing to redact conflicting Arr service evidence');
  }
  const service = declared || hostService;
  if (!service) {
    throw new Error(
      'refusing to redact arr_api_key without an unambiguous Radarr/Sonarr identity',
    );
  }
  return service;
}

function arrPlaceholder(inputs) {
  return ARR_PLACEHOLDERS[arrService(inputs)];
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

function snapshotFiles() {
  const configsDir = path.join(__dirname, 'configs');
  const files = fs.readdirSync(configsDir)
    .filter((name) => /^flow.*\.json$/i.test(name))
    .map((name) => path.join(configsDir, name));
  const publicFlow = path.join(__dirname, 'flow', 'tdarr-flow-vmaf-av1.json');
  if (fs.existsSync(publicFlow)) files.push(publicFlow);
  return [...new Set(files.map((file) => path.resolve(file)))];
}

function main() {
  const files = snapshotFiles();
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      throw new Error(
        `refusing to redact malformed flow snapshot: ${path.basename(file)}`,
      );
    }
    fs.writeFileSync(file, `${JSON.stringify(scrub(parsed), null, 2)}\n`, 'utf8');
  }
  console.log(`Redacted credential fields in ${files.length} flow snapshots.`);
}

if (require.main === module) main();

module.exports = Object.freeze({
  ARR_PLACEHOLDERS,
  arrPlaceholder,
  arrService,
  scrub,
  snapshotFiles,
});
