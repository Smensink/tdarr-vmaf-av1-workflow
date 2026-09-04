'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FIXTURE_PATH = path.join(__dirname, 'synthetic-hevc-fallback-cohort.json');
const SYNTHETIC_PATH = /^\/synthetic\/review\/fixture-[0-9]{2}\.mkv$/;

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function lengthPrefixedSha256(values) {
  const hash = crypto.createHash('sha256');
  values.forEach((value) => {
    const raw = Buffer.from(String(value), 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(raw.length));
    hash.update(length);
    hash.update(raw);
  });
  return hash.digest('hex');
}

function sourceBindingSha256(entry) {
  return lengthPrefixedSha256([
    entry.file_id,
    entry.file_path,
    Number(entry.source_size_bytes),
    entry.source_sampled_sha256,
  ]);
}

function sourceBindingsSnapshotSha256(entries) {
  const projection = entries.map((entry) => [
    entry.file_id,
    entry.file_path,
    Number(entry.source_size_bytes),
    entry.source_sampled_sha256,
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])) ||
    String(left[1]).localeCompare(String(right[1])));
  return digest(canonicalJson(projection));
}

function selectionSha256(entries) {
  const hash = crypto.createHash('sha256');
  entries.slice().sort((left, right) =>
    String(left.path_sha256).localeCompare(String(right.path_sha256)))
    .forEach((entry) => {
      hash.update(`${JSON.stringify([
        String(entry.path_sha256), Number(entry.source_size_bytes),
      ])}\n`);
    });
  return hash.digest('hex');
}

function sourceSampleOffsets(sourceBytes) {
  return [
    0,
    Math.max(0, Math.floor((sourceBytes - 1024 * 1024) / 2)),
    Math.max(0, sourceBytes - 1024 * 1024),
  ].filter((value, index, all) => all.indexOf(value) === index)
    .sort((left, right) => left - right);
}

function sampledSourceSha256(sourcePath, sourceBytes, offsets) {
  const resolved = path.resolve(sourcePath);
  const stat = fs.lstatSync(resolved);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'fixture source must be a direct regular file');
  assert.strictEqual(path.resolve(fs.realpathSync(resolved)), resolved,
    'fixture source must not contain a symlinked path component');
  assert.strictEqual(stat.size, sourceBytes, 'fixture source size mismatch');
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const hash = crypto.createHash('sha256');
    hash.update(`tdarr-sampled-source-sha256-v1\0${sourceBytes}\0`);
    offsets.forEach((offset) => {
      const length = Math.min(1024 * 1024, sourceBytes - offset);
      const buffer = Buffer.allocUnsafe(length);
      assert.strictEqual(fs.readSync(fd, buffer, 0, length, offset), length,
        'fixture source sample was short');
      hash.update(`${offset}:${length}\0`);
      hash.update(buffer);
    });
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function assertSyntheticTemplate(manifest) {
  assert.strictEqual(manifest.fixture_notice,
    'Synthetic review fixture only; contains no production media metadata.');
  assert(Array.isArray(manifest.entries));
  assert.strictEqual(manifest.entries.length, 30);
  manifest.entries.forEach((entry) => {
    assert(SYNTHETIC_PATH.test(String(entry.file_id || '')),
      'review fixture contains a non-synthetic file ID');
    assert.strictEqual(entry.file_path, entry.file_id,
      'review fixture path and ID must use the same synthetic value');
    assert(Number.isSafeInteger(entry.source_size_bytes) &&
      entry.source_size_bytes >= 2049 && entry.source_size_bytes <= 2078,
    'review fixture contains a non-synthetic source size');
  });
}

function finalizeManifest(inputManifest) {
  const manifest = JSON.parse(JSON.stringify(inputManifest));
  delete manifest.manifest_sha256;
  manifest.entries.forEach((entry) => {
    entry.path_sha256 = digest(String(entry.file_id));
    entry.source_sample_offsets = sourceSampleOffsets(Number(entry.source_size_bytes));
    entry.source_binding_sha256 = sourceBindingSha256(entry);
  });
  manifest.selection_sha256 = selectionSha256(manifest.entries);
  manifest.snapshotProvenance.selectedSourceBindingsSha256 =
    sourceBindingsSnapshotSha256(manifest.entries);
  manifest.manifest_sha256 = digest(canonicalJson(manifest));
  return manifest;
}

function buildSyntheticCohort(options = {}) {
  const templatePath = options.templatePath || FIXTURE_PATH;
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  assertSyntheticTemplate(template);
  const manifest = JSON.parse(JSON.stringify(template));
  if (options.source) {
    const sourcePath = path.resolve(String(options.source.filePath || ''));
    const sourceBytes = Number(options.source.sourceSizeBytes);
    const entry = manifest.entries[0];
    entry.file_id = String(options.source.fileId || sourcePath);
    entry.file_path = sourcePath;
    entry.source_size_bytes = sourceBytes;
    entry.source_sample_offsets = sourceSampleOffsets(sourceBytes);
    entry.source_sampled_sha256 = sampledSourceSha256(
      sourcePath, sourceBytes, entry.source_sample_offsets
    );
  }
  const completed = finalizeManifest(manifest);
  const raw = `${JSON.stringify(completed, null, 2)}\n`;
  if (options.outputPath) fs.writeFileSync(options.outputPath, raw, { encoding: 'utf8' });
  return {
    manifest: completed,
    raw,
    manifestFileSha256: digest(raw),
    manifestCanonicalSha256: completed.manifest_sha256,
  };
}

module.exports = {
  FIXTURE_PATH,
  buildSyntheticCohort,
  canonicalJson,
  finalizeManifest,
};
