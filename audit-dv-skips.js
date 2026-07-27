'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'server', 'Tdarr', 'DB2', 'JobReports');
const since = Date.parse(process.env.DV_SKIP_SINCE || '2026-07-10T00:00:00+10:00');
const patterns = [
  'KEEP ORIGINAL: Dynamic HDR',
  'dolby_vision_metadata_not_preservable',
];

const rows = [];
for (const footprint of fs.readdirSync(root, { withFileTypes: true })) {
  if (!footprint.isDirectory()) continue;
  const directory = path.join(root, footprint.name);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;
    const file = path.join(directory, entry.name);
    const stat = fs.statSync(file);
    if (stat.mtimeMs < since) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!patterns.some((pattern) => text.includes(pattern))) continue;
    const original = text.match(/Received file, original: "([^"]+)"/);
    const jobId = entry.name.match(/\(\)transcode\(\)([^()]+)\(\)/);
    const dynamicLines = text.split(/\r?\n/).filter((line) =>
      patterns.some((pattern) => line.includes(pattern)));
    rows.push({
      footprintId: footprint.name,
      jobId: jobId ? jobId[1] : null,
      report: file,
      modified: stat.mtime.toISOString(),
      file: original ? original[1] : null,
      dynamicLines,
    });
  }
}

rows.sort((a, b) => a.modified.localeCompare(b.modified));
console.log(JSON.stringify({ since: new Date(since).toISOString(), count: rows.length, rows }, null, 2));
