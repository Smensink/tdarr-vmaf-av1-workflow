'use strict';

// Container-only real-media comparison of the legacy original/tf4 VMAF
// contract and the canonical hqdn3d/tf0 contract. This is a bounded canary,
// not a replacement for the Flow's independent holdout and final selection.

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ffmpeg = process.env.GRAIN_VMAF_FFMPEG || '/usr/local/bin/tdarr-ffmpeg';
const ffprobe = process.env.GRAIN_VMAF_FFPROBE || '/usr/local/bin/tdarr-ffprobe';
const helperPath = process.env.GRAIN_VMAF_TEMPORAL_HELPER ||
  '/custom-cont-init.d/vmaf-plugin-patches/_lib/nvencTemporalFilter.js';
const nvenc = require(helperPath);
const denoise = 'hqdn3d=12:10:20:15';
const prerollSeconds = 5;
const clipSeconds = Number(process.env.GRAIN_VMAF_CLIP_SECONDS || 5);
const targetVmaf = Number(process.env.GRAIN_VMAF_TARGET || 95);
const frameFloorOverride = process.env.GRAIN_VMAF_FRAME_FLOOR === undefined
  ? null : Number(process.env.GRAIN_VMAF_FRAME_FLOOR);
const cqs = String(process.env.GRAIN_VMAF_CQS || '30,34,38,42')
  .split(',').map(Number).filter(Number.isFinite);
const positions = String(process.env.GRAIN_VMAF_POSITIONS || '0.15,0.50,0.85')
  .split(',').map(Number).filter((value) => Number.isFinite(value) && value > 0 && value < 1);
const resultPath = process.env.GRAIN_VMAF_RESULT || '/temp/grain-vmaf-contract-canary.json';
const scratchRoot = process.env.GRAIN_VMAF_SCRATCH ||
  `/temp/grain-vmaf-contract-canary-${process.pid}-${Date.now()}`;
const encoderProfileId = nvenc.REFERENCE_COMPARISON_ENCODER_PROFILE_ID;

const defaultSources = [
  {
    label: 'grainy-sdr-1080',
    file: '/temp/grain-e2e-sdr-grainy-source.mkv',
    model: '/usr/local/share/model/vmaf_v0.6.1.json',
    isHdr: false,
    mediaIsAnimation: false,
  },
  {
    label: 'static-pq-2160',
    file: '/temp/grain-e2e-pq-source.mkv',
    model: '/usr/local/share/model/vmaf_4k_v0.6.1.json',
    isHdr: true,
    mediaIsAnimation: false,
  },
];
const sources = process.env.GRAIN_VMAF_SOURCES_JSON
  ? JSON.parse(process.env.GRAIN_VMAF_SOURCES_JSON) : defaultSources;

assert(cqs.length >= 3, 'at least three CQ values are required');
assert(positions.length >= 2, 'at least two source positions are required');
assert(Number.isFinite(clipSeconds) && clipSeconds > 0, 'clip duration must be positive');
assert(frameFloorOverride === null ||
  (Number.isFinite(frameFloorOverride) && frameFloorOverride >= 0 && frameFloorOverride <= 100),
'GRAIN_VMAF_FRAME_FLOOR must be between 0 and 100');

function run(binary, args, label, timeoutMs = 300000) {
  process.stdout.write(`${label}\n`);
  const result = childProcess.spawnSync(binary, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.strictEqual(result.status, 0,
    `${label} failed: ${String(result.stderr || result.stdout || '').slice(-8000)}`);
  return result;
}

function probe(file) {
  const result = run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,pix_fmt:format=duration',
    '-of', 'json', file,
  ], `probe ${file}`, 30000);
  const payload = JSON.parse(result.stdout);
  const stream = payload.streams && payload.streams[0];
  const duration = Number(payload.format && payload.format.duration);
  assert(stream && Number.isFinite(duration) && duration > clipSeconds + prerollSeconds,
    `invalid source media: ${file}`);
  return { stream, duration };
}

function sampledSourceFingerprint(file) {
  const stat = fs.statSync(file);
  const sampleBytes = 1024 * 1024;
  const starts = [0, Math.max(0, Math.floor((stat.size - sampleBytes) / 2)),
    Math.max(0, stat.size - sampleBytes)];
  const uniqueStarts = [...new Set(starts)];
  const hash = crypto.createHash('sha256');
  hash.update(`sampled-source-fingerprint-v1\0${stat.size}\0`);
  const fd = fs.openSync(file, 'r');
  try {
    for (const start of uniqueStarts) {
      const length = Math.min(sampleBytes, Math.max(0, stat.size - start));
      const buffer = Buffer.alloc(length);
      const read = length ? fs.readSync(fd, buffer, 0, length, start) : 0;
      hash.update(`${start}:${read}\0`);
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return `sha256-sampled-v1:${hash.digest('hex')}`;
}

function adapterTier(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w >= 3400 || h >= 2000) return '2160p';
  if (w >= 2400 || h >= 1300) return '1440p';
  if (w >= 1700 || h >= 900) return '1080p';
  if (w >= 1100 || h >= 650) return '720p';
  return 'sd';
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/g, '-');
}

function makeReference(source, sourceProbe, target, index, canonical, root) {
  const seek = Math.max(0, target - prerollSeconds);
  const trimOffset = target - seek;
  const readDuration = trimOffset + clipSeconds;
  const output = path.join(root, `${index}-${canonical ? 'canonical' : 'original'}.ffv1.mkv`);
  const chain = `${canonical ? `${denoise},` : ''}` +
    `trim=start=${trimOffset.toFixed(6)}:duration=${clipSeconds.toFixed(6)},setpts=PTS-STARTPTS`;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', seek.toFixed(6), '-t', readDuration.toFixed(6), '-i', source.file,
    '-filter_complex', `[0:v:0]${chain}[reference]`,
    '-map', '[reference]', '-an', '-sn', '-dn',
    '-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1', '-slicecrc', '1',
    '-pix_fmt', sourceProbe.stream.pix_fmt, '-fps_mode', 'passthrough', output,
  ];
  run(ffmpeg, args, `materialize ${source.label} ${canonical ? 'canonical' : 'legacy'} reference ${index}`);
  return output;
}

function encodeCandidate(reference, sourceProbe, cq, canonical, root, index) {
  const policy = canonical ? nvenc.CANONICAL_POLICY : nvenc.LEGACY_POLICY;
  const output = path.join(root, `${index}-${canonical ? 'canonical' : 'legacy'}-cq${cq}.av1.mkv`);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', reference,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-c:v', 'av1_nvenc',
    // The production VMAF sweep always probes AV1 NVENC in p010le, including
    // SDR sources. Using the source pixel format here would make the canary a
    // different encoder contract from the one that chooses the live CQ.
    '-pix_fmt', 'p010le', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0',
    '-preset', 'p7',
    ...nvenc.qualityFlags(policy, true).split(/\s+/).filter(Boolean),
    '-g', '96', '-forced-idr', '1', output,
  ];
  nvenc.assertAv1NvencCommand(args, policy, `${canonical ? 'canonical' : 'legacy'} threshold canary`);
  run(ffmpeg, args, `encode ${canonical ? 'canonical' : 'legacy'} CQ ${cq} clip ${index}`);
  return output;
}

function percentile(values, fraction) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  // Match calculateVMAF's production order statistic exactly. Interpolation
  // can move a borderline clip across its adaptive 1%-low floor.
  const index = Math.min(sorted.length - 1,
    Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[index];
}

function measureVmaf(candidate, reference, model, root, label) {
  const logPath = path.join(root, `${safeName(label)}.json`);
  const graph = '[0:v]settb=1/1000,setpts=N,format=yuv420p,hwupload[dis];' +
    '[1:v]settb=1/1000,setpts=N,format=yuv420p,hwupload[ref];' +
    `[dis][ref]libvmaf_cuda=log_path=${logPath}:log_fmt=json:model=path=${model}` +
    ':feature=name=cambi:shortest=1:repeatlast=0:ts_sync_mode=nearest';
  run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-init_hw_device', 'cuda=cuda0:0', '-filter_hw_device', 'cuda0',
    '-hwaccel', 'cuda', '-hwaccel_device', '0', '-c:v', 'av1_cuvid', '-i', candidate,
    '-i', reference, '-filter_complex', graph, '-f', 'null', '-',
  ], `measure ${label}`);
  const payload = JSON.parse(fs.readFileSync(logPath, 'utf8'));
  const pooled = payload.pooled_metrics && payload.pooled_metrics.vmaf;
  const frames = (payload.frames || []).map((frame) => Number(frame.metrics && frame.metrics.vmaf))
    .filter(Number.isFinite);
  assert(pooled && frames.length, `VMAF log has no scores: ${logPath}`);
  return {
    harmonic: Number(pooled.harmonic_mean),
    mean: Number(pooled.mean),
    min: Number(pooled.min),
    p1: percentile(frames, 0.01),
    frames: frames.length,
  };
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function productionFrameFloor(source, sourceProbe) {
  if (frameFloorOverride !== null) return frameFloorOverride;
  const width = Number(sourceProbe.stream.width) || 0;
  const height = Number(sourceProbe.stream.height) || 0;
  const pixels = width * height;
  let tier = 'sd';
  if (width >= 3800 || height >= 1800 || pixels >= 7000000) tier = '4k';
  else if (width >= 2500 || height >= 1300 || pixels >= 3000000) tier = '1440p';
  else if (width >= 1700 || height >= 900 || pixels >= 1600000) tier = '1080p';
  else if (width >= 1100 || height >= 650 || pixels >= 800000) tier = '720p';
  const isHdr = source.isHdr === true;
  const floors = {
    '4k': isHdr ? 86.0 : 85.5,
    '1440p': isHdr ? 85.5 : 85.0,
    '1080p': isHdr ? 85.0 : 84.5,
    '720p': 83.5,
    'sd': 82.5,
  };
  let floor = floors[tier];
  const sourceType = String(source.sourceType || '').toLowerCase();
  const mediaType = String(source.mediaType || '').toLowerCase();
  if (sourceType.includes('bluray') || sourceType.includes('blu-ray')) floor += 0.3;
  if (tier === '4k' && mediaType.includes('movie')) floor += 0.2;
  return Math.min(94, floor);
}

function summarize(rows, frameFloor) {
  const grouped = {};
  for (const row of rows) {
    const key = `${row.contract}|${row.cq}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row.metrics);
  }
  return Object.keys(grouped).map((key) => {
    const [contract, cqText] = key.split('|');
    const metrics = grouped[key];
    const summary = {
      contract,
      cq: Number(cqText),
      clips: metrics.length,
      harmonic: mean(metrics.map((item) => item.harmonic)),
      mean: mean(metrics.map((item) => item.mean)),
      // Production treats the lowest clip-level 1%-low as authoritative. An
      // average can hide a failing clip and falsely label a CQ as feasible.
      p1: Math.min(...metrics.map((item) => item.p1)),
      minimum: Math.min(...metrics.map((item) => item.min)),
    };
    summary.passesCanaryQuality = summary.harmonic >= targetVmaf && summary.p1 >= frameFloor;
    return summary;
  }).sort((a, b) => a.contract.localeCompare(b.contract) || a.cq - b.cq);
}

fs.mkdirSync(scratchRoot, { recursive: true });
const report = {
  schema: 1,
  generatedUtc: new Date().toISOString(),
  purpose: 'compare-legacy-original-tf4-vs-canonical-hqdn3d-tf0-vmaf-contracts',
  interpretation: 'raw contract deltas and quality-only gates; not a replacement for production CAMBI, size, BPP, hard-clip, or holdout selection',
  denoise,
  prerollSeconds,
  clipSeconds,
  positions,
  cqs,
  encoderProfileId,
  thresholds: {
    harmonicVmaf: targetVmaf,
    frameP1: frameFloorOverride === null ? 'production-adaptive-per-source' : frameFloorOverride,
  },
  sources: [],
};

try {
  for (const source of sources) {
    assert(source && path.isAbsolute(source.file) && fs.statSync(source.file).isFile(),
      `missing source fixture: ${source && source.file}`);
    assert(path.isAbsolute(source.model) && fs.statSync(source.model).isFile(),
      `missing VMAF model: ${source.model}`);
    assert(typeof source.isHdr === 'boolean' && typeof source.mediaIsAnimation === 'boolean',
      `${source.label} must declare isHdr and mediaIsAnimation for adapter cohorting`);
    const sourceFingerprint = sampledSourceFingerprint(source.file);
    const sourceProbe = probe(source.file);
    assert(sourceProbe.stream.codec_name, `${source.label} probe has no source codec`);
    const root = path.join(scratchRoot, safeName(source.label));
    fs.mkdirSync(root, { recursive: true });
    const rows = [];
    for (let index = 0; index < positions.length; index += 1) {
      const target = sourceProbe.duration * positions[index];
      const canonicalReference = makeReference(source, sourceProbe, target, index, true, root);
      const legacyReference = makeReference(source, sourceProbe, target, index, false, root);
      for (const cq of cqs) {
        for (const contract of ['canonical', 'legacy']) {
          const reference = contract === 'canonical' ? canonicalReference : legacyReference;
          const candidate = encodeCandidate(reference, sourceProbe, cq, contract === 'canonical', root, index);
          rows.push({
            clipIndex: index,
            sourcePosition: positions[index],
            contract,
            cq,
            metrics: measureVmaf(candidate, reference, source.model, root,
              `${source.label}-${contract}-cq${cq}-clip${index}`),
          });
        }
      }
    }
    const effectiveFrameFloor = productionFrameFloor(source, sourceProbe);
    const summary = summarize(rows, effectiveFrameFloor);
    const selected = {};
    for (const contract of ['canonical', 'legacy']) {
      const passing = summary.filter((item) => item.contract === contract && item.passesCanaryQuality);
      selected[contract] = passing.length ? Math.max(...passing.map((item) => item.cq)) : null;
    }
    assert.strictEqual(sampledSourceFingerprint(source.file), sourceFingerprint,
      `${source.label} changed while its paired contract canary was running`);
    report.sources.push({
      label: source.label,
      file: source.file,
      source_fingerprint: sourceFingerprint,
      encoderProfileId,
      durationSeconds: sourceProbe.duration,
      width: sourceProbe.stream.width,
      height: sourceProbe.stream.height,
      tier: adapterTier(sourceProbe.stream.width, sourceProbe.stream.height),
      pixelFormat: sourceProbe.stream.pix_fmt,
      is_hdr: source.isHdr ? 1 : 0,
      source_codec: sourceProbe.stream.codec_name,
      media_is_animation: source.mediaIsAnimation ? 1 : 0,
      model: source.model,
      candidatePixelFormat: 'p010le',
      effectiveFrameFloor,
      summary,
      highestPassingTestedCq: selected,
    });
  }
  fs.writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`PASS VMAF contract canary; report=${resultPath}`);
} finally {
  if (process.env.GRAIN_VMAF_KEEP_SCRATCH !== '1') {
    const resolved = path.resolve(scratchRoot);
    assert(resolved.startsWith('/temp/grain-vmaf-contract-canary-'),
      `refusing unsafe cleanup: ${resolved}`);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
