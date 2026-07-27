#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const reportRoot = '/app/server/Tdarr/DB2/JobReports';
const since = Date.parse(process.env.DV_SKIP_SINCE || '2026-07-10T00:00:00+10:00');
const skipped = new Map();

function extractSourceFileFromReport(text) {
  const marker = 'fileVersionOriginalLogJSONString:';
  const line = text.split(/\r?\n/).find((item) => item.includes(marker));
  if (!line) return null;
  try {
    const payload = JSON.parse(line.slice(line.indexOf(marker) + marker.length));
    return payload && payload.sourceFile ? payload.sourceFile : null;
  } catch (_) {
    return null;
  }
}

function getMediaInfoVideo(sourceFile) {
  const tracks = sourceFile && sourceFile.mediaInfo && sourceFile.mediaInfo.track;
  return Array.isArray(tracks)
    ? tracks.find((track) => String(track && track['@type']).toLowerCase() === 'video') || null
    : null;
}

for (const footprint of fs.readdirSync(reportRoot, { withFileTypes: true })) {
  if (!footprint.isDirectory()) continue;
  const directory = path.join(reportRoot, footprint.name);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;
    const report = path.join(directory, entry.name);
    const stat = fs.statSync(report);
    if (stat.mtimeMs < since) continue;
    const text = fs.readFileSync(report, 'utf8');
    if (!text.includes('KEEP ORIGINAL: Dynamic HDR') &&
        !text.includes('dolby_vision_metadata_not_preservable')) continue;
    const original = text.match(/Received file, original: "([^"]+)"/);
    if (!original) continue;
    const sourceFile = extractSourceFileFromReport(text);
    const mediaInfoVideo = getMediaInfoVideo(sourceFile);
    const jobId = entry.name.match(/\(\)transcode\(\)([^()]+)\(\)/);
    skipped.set(original[1], {
      file: original[1],
      footprintId: footprint.name,
      jobId: jobId ? jobId[1] : null,
      report,
      skippedAt: stat.mtime.toISOString(),
      masteringPrimaries: mediaInfoVideo && mediaInfoVideo.MasteringDisplay_ColorPrimaries || null,
      masteringLuminance: mediaInfoVideo && mediaInfoVideo.MasteringDisplay_Luminance || null,
      maxCll: mediaInfoVideo && mediaInfoVideo.MaxCLL || null,
      maxFall: mediaInfoVideo && mediaInfoVideo.MaxFALL || null,
    });
  }
}

const rows = [];
for (const record of skipped.values()) {
  const probe = spawnSync('/usr/local/bin/tdarr-ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries',
    'stream=codec_name,pix_fmt,color_space,color_transfer,color_primaries:stream_side_data',
    '-of', 'json', record.file,
  ], { encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (probe.status !== 0) {
    rows.push({ ...record, exists: fs.existsSync(record.file), probeError: (probe.stderr || '').trim() });
    continue;
  }
  const parsed = JSON.parse(probe.stdout);
  const stream = parsed.streams && parsed.streams[0] ? parsed.streams[0] : {};
  const sideData = Array.isArray(stream.side_data_list) ? stream.side_data_list : [];
  const dovi = sideData.find((item) => /dovi/i.test(String(item.side_data_type || ''))) || null;
  const hdr10plus = sideData.some((item) => /smpte.?2094|dynamic hdr|hdr10\+/i.test(String(item.side_data_type || '')));
  rows.push({
    ...record,
    exists: true,
    codec: stream.codec_name || null,
    pixFmt: stream.pix_fmt || null,
    colorSpace: stream.color_space || null,
    colorTransfer: stream.color_transfer || null,
    colorPrimaries: stream.color_primaries || null,
    dvProfile: dovi ? Number(dovi.dv_profile) : null,
    dvLevel: dovi ? Number(dovi.dv_level) : null,
    compatibilityId: dovi ? Number(dovi.dv_bl_signal_compatibility_id) : null,
    baseLayerPresent: dovi ? Number(dovi.bl_present_flag) === 1 : null,
    enhancementLayerPresent: dovi ? Number(dovi.el_present_flag) === 1 : null,
    rpuPresent: dovi ? Number(dovi.rpu_present_flag) === 1 : null,
    hdr10PlusPresent: hdr10plus,
  });
}

const summary = {};
for (const row of rows) {
  const key = row.probeError ? 'probe_error' : `p${row.dvProfile}_compat${row.compatibilityId}`;
  summary[key] = (summary[key] || 0) + 1;
}
summary.withMasteringDisplay = rows.filter((row) => row.masteringPrimaries && row.masteringLuminance).length;
summary.withContentLight = rows.filter((row) => row.maxCll && row.maxFall).length;

const output = { since: new Date(since).toISOString(), count: rows.length, summary, rows };
if (process.argv.includes('--summary')) {
  output.rows = rows.filter((row) => row.probeError || row.dvProfile !== 8 || row.compatibilityId !== 1);
}
console.log(JSON.stringify(output, null, 2));
