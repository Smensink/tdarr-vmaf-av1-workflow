'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const configsDir = path.join(__dirname, 'configs');
const files = fs.readdirSync(configsDir).filter((name) => /^flow.*\.json$/i.test(name));
const secretKeys = new Set(['plexToken', 'tmdbApiKey', 'tvdbApiKey', 'arr_api_key']);
const violations = [];

function scan(value, location) {
  if (Array.isArray(value)) return value.forEach((item, index) => scan(item, `${location}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (secretKeys.has(key)) {
      const text = String(child || '');
      if (text && !/^\$\{TDARR_[A-Z_]+\}$/.test(text) && !/^<[A-Z_]+>$/.test(text)) {
        violations.push(`${location}.${key}`);
      }
    }
    scan(child, `${location}.${key}`);
  }
}

for (const file of files) {
  const raw = fs.readFileSync(path.join(configsDir, file), 'utf8');
  try {
    scan(JSON.parse(raw), file);
  } catch (_) {
    const pattern = /"(plexToken|tmdbApiKey|tvdbApiKey|arr_api_key)"\s*:\s*"([^"]*)"/g;
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      if (match[2] && !/^\$\{TDARR_[A-Z_]+\}$/.test(match[2]) && !/^<[A-Z_]+>$/.test(match[2])) {
        violations.push(`${file}.${match[1]}`);
      }
    }
  }
}
assert.deepStrictEqual(violations, [], `plaintext credential fields: ${violations.join(', ')}`);
console.log(`PASS flow snapshot secret redaction (${files.length} files)`);
