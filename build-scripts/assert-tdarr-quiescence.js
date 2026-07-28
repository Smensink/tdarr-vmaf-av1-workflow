'use strict';

// Read-only maintenance/recovery preflight. This script never pauses nodes,
// changes worker limits, removes locks, kills processes, or writes Tdarr state.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_API_BASE = 'http://127.0.0.1:8266/api/v2';
const DEFAULT_GPU_LOCK_PATH = '/temp/tdarr-vmaf-gpu-pipeline.lock';
const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const WORKER_LIMIT_KEYS = Object.freeze([
  'healthcheckcpu',
  'healthcheckgpu',
  'transcodecpu',
  'transcodegpu',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeLabel(value) {
  const text = String(value === undefined || value === null ? 'unknown' : value);
  return text.replace(/[^A-Za-z0-9_.:@-]/g, '?').slice(0, 80) || 'unknown';
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const selected = value === undefined || value === null || value === ''
    ? fallback
    : Number(value);
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return selected;
}

function isLiteralLoopbackHostname(hostname) {
  const normalized = String(hostname || '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .toLowerCase();
  if (normalized === '::1') return true;
  const octets = normalized.split('.');
  return octets.length === 4
    && octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/.test(octet)
      && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

function normalizeApiBase(value) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_API_BASE));
  } catch (_) {
    throw new TypeError('TDARR_API_BASE must be a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('TDARR_API_BASE must use HTTP or HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('TDARR_API_BASE must not contain credentials, a query, or a fragment');
  }
  if (!isLiteralLoopbackHostname(url.hostname)) {
    throw new TypeError('TDARR_API_BASE must use a literal loopback address');
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (pathname !== '/api/v2') {
    throw new TypeError('TDARR_API_BASE path must be exactly /api/v2');
  }
  url.pathname = pathname;
  return url.toString().replace(/\/+$/, '');
}

function configFromEnv(environment = process.env) {
  const gpuLockPath = String(
    environment.TDARR_GPU_PIPELINE_LOCK_DIR || DEFAULT_GPU_LOCK_PATH
  );
  if (!path.isAbsolute(gpuLockPath) || gpuLockPath.includes('\0')) {
    throw new TypeError('TDARR_GPU_PIPELINE_LOCK_DIR must be an absolute path');
  }
  return Object.freeze({
    apiBase: normalizeApiBase(environment.TDARR_API_BASE || DEFAULT_API_BASE),
    apiKey: String(environment.TDARR_API_KEY || environment.apiKey || ''),
    gpuLockPath,
    intervalMs: boundedInteger(
      environment.TDARR_QUIESCENCE_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
      250,
      5000,
      'TDARR_QUIESCENCE_INTERVAL_MS'
    ),
    timeoutMs: boundedInteger(
      environment.TDARR_API_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      250,
      10000,
      'TDARR_API_TIMEOUT_MS'
    ),
  });
}

function buildRequestHeaders(apiKey, body) {
  const headers = { accept: 'application/json' };
  if (body !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(body);
  }
  if (apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

function safeErrorCode(error) {
  return safeLabel(error && (error.code || error.name) || 'unknown-error');
}

function createJsonRequester(config, transports = { http, https }) {
  return function requestJson(relativePath, options = {}) {
    const suffix = String(relativePath || '').replace(/^\/+/, '');
    if (!/^[A-Za-z0-9_-]+$/.test(suffix)) {
      return Promise.reject(new TypeError('Tdarr API endpoint is not a safe relative name'));
    }
    const url = new URL(`${config.apiBase}/${suffix}`);
    const transport = url.protocol === 'https:' ? transports.https : transports.http;
    const body = options.body === undefined ? null : JSON.stringify(options.body);
    return new Promise((resolve, reject) => {
      const request = transport.request(url, {
        method: options.method || 'GET',
        headers: buildRequestHeaders(config.apiKey, body),
        timeout: config.timeoutMs,
      }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('TDARR_API_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (!response.statusCode ||
              response.statusCode < 200 ||
              response.statusCode >= 300) {
            reject(new Error(
              `Tdarr API ${safeLabel(suffix)} returned HTTP ${response.statusCode || 'unknown'}`
            ));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (_) {
            reject(new Error(`Tdarr API ${safeLabel(suffix)} returned invalid JSON`));
          }
        });
      });
      request.on('timeout', () => request.destroy(new Error('TDARR_API_TIMEOUT')));
      request.on('error', (error) => reject(new Error(
        `Tdarr API ${safeLabel(suffix)} request failed (${safeErrorCode(error)})`
      )));
      if (body !== null) request.write(body);
      request.end();
    });
  };
}

function globalPauseIsManual(settings) {
  return isRecord(settings) && settings.pauseAllNodes === 'manual';
}

function pausedNodeValue(value) {
  return value === true || value === 'manual' || value === 'paused';
}

function isExplicitZero(value) {
  return value === 0 || value === '0';
}

function inspectNodes(nodes) {
  if (!isRecord(nodes)) throw new TypeError('Tdarr get-nodes response must be an object');
  const nodeIds = Object.keys(nodes).sort();
  if (nodeIds.length === 0) throw new Error('Tdarr get-nodes returned no nodes');

  const issues = [];
  for (const nodeId of nodeIds) {
    const node = nodes[nodeId];
    const safeNodeId = safeLabel(nodeId);
    if (!isRecord(node)) {
      issues.push(`${safeNodeId}:invalid-node`);
      continue;
    }

    const pauseKeys = ['nodePaused', 'paused'].filter((key) =>
      Object.prototype.hasOwnProperty.call(node, key));
    if (pauseKeys.length === 0 ||
        pauseKeys.some((key) => !pausedNodeValue(node[key]))) {
      issues.push(`${safeNodeId}:not-paused`);
    }

    if (!isRecord(node.workerLimits)) {
      issues.push(`${safeNodeId}:missing-worker-limits`);
    } else {
      for (const key of WORKER_LIMIT_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(node.workerLimits, key)) {
          issues.push(`${safeNodeId}:missing-limit-${key}`);
        }
      }
      for (const [key, value] of Object.entries(node.workerLimits)) {
        if (!isExplicitZero(value)) {
          issues.push(`${safeNodeId}:nonzero-limit-${safeLabel(key)}`);
        }
      }
    }

    if (!isRecord(node.workers)) {
      issues.push(`${safeNodeId}:missing-workers`);
    } else {
      for (const [workerId, worker] of Object.entries(node.workers)) {
        if (!isRecord(worker) || worker.idle !== true) {
          issues.push(`${safeNodeId}:${safeLabel(workerId)}:not-idle`);
        }
      }
    }
  }

  return Object.freeze({
    nodeIds: Object.freeze(nodeIds),
    issues: Object.freeze([...new Set(issues)]),
  });
}

function argumentBasename(value) {
  const pieces = String(value || '').split(/[\\/]/);
  return (pieces[pieces.length - 1] || '').toLowerCase();
}

function tokenMatches(value, pattern) {
  return pattern.test(String(value || '').toLowerCase());
}

function classifyProcessArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const values = argv.map((value) => String(value || '').toLowerCase());
  const basenames = values.map(argumentBasename);
  const executable = basenames[0];
  // Process-inspection commands carry tool names as search patterns. They do
  // not execute those tools, so scanning every argument would turn `grep
  // ffmpeg` or `pgrep ffprobe` into a false production-process finding.
  if (/^(?:grep|egrep|fgrep|pgrep)(?:\.exe)?$/.test(executable)) return null;
  const shellCommandIndex = values.indexOf('-c');
  const shellCommand = /^(?:ba|da|z|k)?sh(?:\.exe)?$/.test(executable) &&
      shellCommandIndex >= 0
    ? values[shellCommandIndex + 1] || ''
    : '';
  const shellMentions = (pattern) => Boolean(shellCommand) && pattern.test(shellCommand);

  if (basenames.some((name) =>
    /^tdarr-nvencc-knn-ffmpeg(?:\.js)?$/.test(name)) ||
      shellMentions(/(?:^|[\s"'=;|&()\\/])tdarr-nvencc-knn-ffmpeg(?:\.js)?(?:$|[\s"'=;|&()])/)) {
    return 'tdarr-nvencc-knn-ffmpeg.js';
  }
  if (basenames.some((name) => /^nvencc(?:64)?(?:\.exe)?$/.test(name)) ||
      shellMentions(/(?:^|[\s"'=;|&()\\/])nvencc(?:64)?(?:\.exe)?(?:$|[\s"'=;|&()])/)) {
    return 'nvencc';
  }
  if (basenames.some((name) =>
    /^(?:tdarr-)?ffmpeg(?:-static)?(?:\.exe)?$/.test(name)) ||
      shellMentions(/(?:^|[\s"'=;|&()\\/])(?:tdarr-)?ffmpeg(?:-static)?(?:\.exe)?(?:$|[\s"'=;|&()])/)) {
    return 'ffmpeg';
  }
  if (basenames.some((name) =>
    /^(?:tdarr-)?ffprobe(?:-static)?(?:\.exe)?$/.test(name)) ||
      shellMentions(/(?:^|[\s"'=;|&()\\/])(?:tdarr-)?ffprobe(?:-static)?(?:\.exe)?(?:$|[\s"'=;|&()])/)) {
    return 'ffprobe';
  }

  if (basenames.some((name) =>
    /^(?:vmaf|vmaf-v1|vmaf-v1-score|vmaf-v1-score\.sh|libvmaf)(?:\.exe)?$/
      .test(name)) ||
      values.some((value) =>
        tokenMatches(value, /(?:^|[=,:])libvmaf(?:_cuda)?(?:$|[=,:])/)) ||
      shellMentions(/(?:^|[\s"'=;|&()\\/])(?:vmaf|vmaf-v1|vmaf-v1-score(?:\.sh)?|libvmaf(?:_cuda)?)(?:$|[\s"'=;|&()])/)) {
    return 'vmaf/libvmaf';
  }
  if (basenames.some((name) =>
    /^grav1synth(?:\.exe)?$/.test(name) ||
    /^grain[_-]pipeline[^/\\]*\.(?:py|js|sh)$/.test(name)) ||
      shellMentions(/(?:^|[\s"'=;|&()\\/])(?:grav1synth(?:\.exe)?|grain[_-]pipeline[^\s"'=;|&()\\/]*\.(?:py|js|sh))(?:$|[\s"'=;|&()])/)) {
    return 'grain';
  }

  if (values.some((value) =>
    /(?:^|[=,:])(?:h264|hevc|av1)_nvenc(?:$|[=,:])/.test(value) ||
    /^(?:--?[A-Za-z0-9_-]+=)?nvenc$/.test(value)) ||
      /nvenc/.test(executable) ||
      shellMentions(/(?:^|[\s"'=;|&()])(?:h264|hevc|av1)_nvenc(?:$|[\s"'=;|&()])/)) {
    return 'nvenc';
  }
  if (values.some((value) =>
    /^(?:cuda|cuvid|nvdec)$/.test(value) ||
    /(?:^|[=,:])(?:h264|hevc|av1)_cuvid(?:$|[=,:])/.test(value) ||
    /(?:^|[=,:])(?:scale|overlay|hwupload)_cuda(?:$|[=,:])/.test(value) ||
    /^(?:--?[A-Za-z0-9_-]+=)?(?:cuda|cuvid|nvdec)$/.test(value)) ||
      /(?:cuda|cuvid|nvdec)/.test(executable) ||
      shellMentions(/(?:^|[\s"'=;|&()])(?:cuda|cuvid|nvdec|(?:h264|hevc|av1)_cuvid|(?:scale|overlay|hwupload)_cuda)(?:$|[\s"'=;|&()])/)) {
    return 'cuda/cuvid';
  }
  return null;
}

function parseCmdline(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function scanProc(fsImpl, options = {}) {
  const procRoot = options.procRoot || '/proc';
  const ownPid = Number(options.ownPid);
  if (!fsImpl.existsSync(procRoot)) throw new Error('Linux /proc is unavailable');
  let names;
  try {
    names = fsImpl.readdirSync(procRoot);
  } catch (error) {
    throw new Error(`could not enumerate /proc (${safeErrorCode(error)})`);
  }

  const conflicts = [];
  for (const entry of names) {
    const name = typeof entry === 'string' ? entry : entry && entry.name;
    if (!/^[1-9][0-9]*$/.test(String(name || ''))) continue;
    const pid = Number(name);
    if (pid === ownPid) continue;
    let cmdline;
    try {
      cmdline = fsImpl.readFileSync(path.posix.join(procRoot, String(name), 'cmdline'));
    } catch (error) {
      if (error && ['ENOENT', 'ESRCH'].includes(error.code)) continue;
      throw new Error(`could not inspect PID ${pid} (${safeErrorCode(error)})`);
    }
    const identity = classifyProcessArgv(parseCmdline(cmdline));
    if (identity) conflicts.push(Object.freeze({ pid, identity }));
  }
  return Object.freeze(conflicts.sort((left, right) => left.pid - right.pid));
}

function exactEntryExists(fsImpl, targetPath) {
  try {
    fsImpl.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw new Error(
      `could not inspect the production GPU lock (${safeErrorCode(error)})`
    );
  }
}

function formatProcessConflicts(conflicts) {
  return conflicts
    .map((item) => `${Number(item.pid)}/${safeLabel(item.identity)}`)
    .join(', ');
}

function assertSnapshot(snapshot, label) {
  const safeStage = safeLabel(label);
  if (!globalPauseIsManual(snapshot.settings)) {
    throw new Error(`${safeStage}: global manual pause is not asserted`);
  }
  const nodeReport = inspectNodes(snapshot.nodes);
  if (nodeReport.issues.length !== 0) {
    throw new Error(`${safeStage}: node quiescence failed: ${nodeReport.issues.join(', ')}`);
  }
  if (snapshot.lockExists) {
    throw new Error(`${safeStage}: exact production GPU lock exists`);
  }
  if (!Array.isArray(snapshot.processes)) {
    throw new TypeError(`${safeStage}: process snapshot is invalid`);
  }
  if (snapshot.processes.length !== 0) {
    throw new Error(
      `${safeStage}: production processes are active: ` +
      formatProcessConflicts(snapshot.processes)
    );
  }
  return Object.freeze({ nodeIds: nodeReport.nodeIds });
}

function assertStableSnapshots(first, second) {
  if (first.nodeIds.length !== second.nodeIds.length ||
      first.nodeIds.some((nodeId, index) => nodeId !== second.nodeIds[index])) {
    throw new Error('Tdarr node membership changed between quiescence snapshots');
  }
}

function settingsRequestBody() {
  return {
    data: {
      collection: 'SettingsGlobalJSONDB',
      mode: 'getById',
      docID: 'globalsettings',
      obj: {},
    },
    timeout: 20000,
  };
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function captureSnapshot(config, dependencies) {
  const settings = await dependencies.requestJson('cruddb', {
    method: 'POST',
    body: settingsRequestBody(),
  });
  const nodes = await dependencies.requestJson('get-nodes');
  if (dependencies.platform !== 'linux') {
    throw new Error('quiescence process inspection requires Linux /proc');
  }
  return {
    settings,
    nodes,
    lockExists: exactEntryExists(dependencies.fs, config.gpuLockPath),
    processes: scanProc(dependencies.fs, {
      procRoot: dependencies.procRoot || '/proc',
      ownPid: dependencies.pid,
    }),
  };
}

async function assertTdarrQuiescence(config, suppliedDependencies = {}) {
  const dependencies = {
    fs: suppliedDependencies.fs || fs,
    platform: suppliedDependencies.platform || process.platform,
    pid: suppliedDependencies.pid === undefined ? process.pid : suppliedDependencies.pid,
    procRoot: suppliedDependencies.procRoot || '/proc',
    requestJson: suppliedDependencies.requestJson || createJsonRequester(config),
    sleep: suppliedDependencies.sleep || defaultSleep,
  };

  const first = assertSnapshot(
    await captureSnapshot(config, dependencies),
    'snapshot-1'
  );
  await dependencies.sleep(config.intervalMs);
  const second = assertSnapshot(
    await captureSnapshot(config, dependencies),
    'snapshot-2'
  );
  assertStableSnapshots(first, second);
  return Object.freeze({
    checks: 2,
    intervalMs: config.intervalMs,
    nodeCount: second.nodeIds.length,
  });
}

async function main() {
  const result = await assertTdarrQuiescence(configFromEnv());
  console.log(
    `PASS Tdarr quiescence: ${result.checks} stable snapshots across ` +
    `${result.nodeCount} paused node(s); worker limits zero, workers idle, ` +
    'production lock absent, and production processes absent'
  );
}

module.exports = {
  DEFAULT_API_BASE,
  DEFAULT_GPU_LOCK_PATH,
  WORKER_LIMIT_KEYS,
  assertSnapshot,
  assertStableSnapshots,
  assertTdarrQuiescence,
  boundedInteger,
  buildRequestHeaders,
  captureSnapshot,
  classifyProcessArgv,
  configFromEnv,
  createJsonRequester,
  exactEntryExists,
  formatProcessConflicts,
  globalPauseIsManual,
  inspectNodes,
  isLiteralLoopbackHostname,
  normalizeApiBase,
  parseCmdline,
  safeLabel,
  scanProc,
  settingsRequestBody,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`FAIL Tdarr quiescence: ${error.message}`);
    process.exitCode = 1;
  });
}
