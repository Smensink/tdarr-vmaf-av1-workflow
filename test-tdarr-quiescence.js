'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const quiescence = require('./build-scripts/assert-tdarr-quiescence');

function goodNode(overrides = {}) {
  return {
    nodePaused: true,
    workerLimits: {
      healthcheckcpu: 0,
      healthcheckgpu: '0',
      transcodecpu: 0,
      transcodegpu: '0',
    },
    workers: {
      idleWorker: { idle: true, workerType: 'transcodegpu' },
    },
    ...overrides,
  };
}

function enoent() {
  return Object.assign(new Error('not found'), { code: 'ENOENT' });
}

function emptyProcFs(lockResults = [false, false]) {
  let lockRead = 0;
  return {
    existsSync(target) {
      assert.equal(target, '/proc');
      return true;
    },
    readdirSync(target) {
      assert.equal(target, '/proc');
      return [];
    },
    readFileSync() {
      throw new Error('unexpected process read');
    },
    lstatSync(target) {
      assert.equal(target, '/temp/tdarr-vmaf-gpu-pipeline.lock');
      const exists = lockResults[Math.min(lockRead, lockResults.length - 1)];
      lockRead += 1;
      if (!exists) throw enoent();
      return {};
    },
  };
}

function testConfig(overrides = {}) {
  return Object.freeze({
    apiBase: 'http://127.0.0.1:8266/api/v2',
    apiKey: '',
    gpuLockPath: '/temp/tdarr-vmaf-gpu-pipeline.lock',
    intervalMs: 250,
    timeoutMs: 1000,
    ...overrides,
  });
}

function requestSequence(nodeSnapshots, options = {}) {
  const calls = [];
  let settingsRead = 0;
  let nodesRead = 0;
  return {
    calls,
    async requestJson(endpoint, requestOptions = {}) {
      calls.push({ endpoint, options: requestOptions });
      if (endpoint === 'cruddb') {
        const value = options.settings
          ? options.settings[Math.min(settingsRead, options.settings.length - 1)]
          : { _id: 'globalsettings', pauseAllNodes: 'manual' };
        settingsRead += 1;
        return value;
      }
      if (endpoint === 'get-nodes') {
        const value = nodeSnapshots[Math.min(nodesRead, nodeSnapshots.length - 1)];
        nodesRead += 1;
        return value;
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };
}

test('requires an exact literal-loopback API base and bounded settings', () => {
  assert.equal(
    quiescence.normalizeApiBase('http://127.0.0.1:8266/api/v2/'),
    'http://127.0.0.1:8266/api/v2'
  );
  assert.equal(
    quiescence.normalizeApiBase('https://[::1]:8266/api/v2'),
    'https://[::1]:8266/api/v2'
  );
  for (const value of [
    'http://localhost:8266/api/v2',
    'http://0.0.0.0:8266/api/v2',
    'http://tdarr.example.invalid:8266/api/v2',
    'file:///api/v2',
    'http://127.0.0.1:8266/api/v2/other',
    'http://user:secret@127.0.0.1:8266/api/v2',
  ]) {
    assert.throws(() => quiescence.normalizeApiBase(value), /TDARR_API_BASE/);
  }

  const config = quiescence.configFromEnv({
    TDARR_API_KEY: 'primary-key',
    apiKey: 'fallback-key',
    TDARR_QUIESCENCE_INTERVAL_MS: '250',
    TDARR_API_TIMEOUT_MS: '10000',
  });
  assert.equal(config.apiKey, 'primary-key');
  assert.equal(config.intervalMs, 250);
  assert.equal(config.timeoutMs, 10000);
  assert.equal(quiescence.configFromEnv({ apiKey: 'fallback-key' }).apiKey,
    'fallback-key');
  assert.throws(() => quiescence.configFromEnv({
    TDARR_QUIESCENCE_INTERVAL_MS: '5001',
  }), /TDARR_QUIESCENCE_INTERVAL_MS/);
});

test('adds the optional API key without exposing it elsewhere', () => {
  const withKey = quiescence.buildRequestHeaders('tapi_private_value', null);
  assert.equal(withKey['x-api-key'], 'tapi_private_value');
  const withoutKey = quiescence.buildRequestHeaders('', null);
  assert.equal(Object.prototype.hasOwnProperty.call(withoutKey, 'x-api-key'), false);
  const bodyHeaders = quiescence.buildRequestHeaders('key', '{"read":true}');
  assert.equal(bodyHeaders['content-type'], 'application/json');
  assert.equal(bodyHeaders['content-length'], 13);
});

test('requires every node paused, all four limits zero, and every worker idle', () => {
  const pausedAliasNode = goodNode({ paused: 'manual', workers: {} });
  delete pausedAliasNode.nodePaused;
  const report = quiescence.inspectNodes({
    alpha: goodNode(),
    beta: pausedAliasNode,
  });
  assert.deepEqual(report.nodeIds, ['alpha', 'beta']);
  assert.deepEqual(report.issues, []);

  assert.deepEqual(
    quiescence.inspectNodes({
      alpha: goodNode({ nodePaused: false }),
    }).issues,
    ['alpha:not-paused']
  );
  assert(
    quiescence.inspectNodes({
      alpha: goodNode({
        workerLimits: {
          healthcheckcpu: 0,
          healthcheckgpu: 0,
          transcodecpu: 0,
          transcodegpu: 1,
        },
      }),
    }).issues.includes('alpha:nonzero-limit-transcodegpu')
  );
  assert(
    quiescence.inspectNodes({
      alpha: goodNode({
        workerLimits: {
          healthcheckcpu: 0,
          healthcheckgpu: 0,
          transcodecpu: 0,
        },
      }),
    }).issues.includes('alpha:missing-limit-transcodegpu')
  );
  assert.deepEqual(
    quiescence.inspectNodes({
      alpha: goodNode({ workers: { busy: { idle: false } } }),
    }).issues,
    ['alpha:busy:not-idle']
  );
  assert.throws(() => quiescence.inspectNodes({}), /no nodes/);
});

test('classifies production tools without returning command lines or media paths', () => {
  const cases = [
    [['node', '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js', '/media/private.mkv'],
      'tdarr-nvencc-knn-ffmpeg.js'],
    [['/usr/local/bin/NVEncC64', '--input', '/media/private.mkv'], 'nvencc'],
    [['/usr/local/bin/tdarr-ffmpeg', '-i', '/media/private.mkv'], 'ffmpeg'],
    [['bash', '/usr/local/bin/vmaf-v1-score.sh', '--reference', '/media/private.mkv'],
      'vmaf/libvmaf'],
    [['python3', '/opt/grain-pipeline/current/grain_pipeline_v5_direct.py',
      '/media/private.mkv'], 'grain'],
    [['bash', '-c', 'exec /usr/local/bin/tdarr-ffmpeg -i "/media/private.mkv"'],
      'ffmpeg'],
    [['timeout', '30', '/usr/local/bin/ffmpeg-static', '-i', '/media/private.mkv'],
      'ffmpeg'],
    [['other-tool', '-c:v=av1_nvenc'], 'nvenc'],
    [['other-tool', '--codec=nvenc'], 'nvenc'],
    [['other-tool', '-hwaccel', 'cuda'], 'cuda/cuvid'],
  ];
  for (const [argv, expected] of cases) {
    assert.equal(quiescence.classifyProcessArgv(argv), expected);
  }
  assert.equal(
    quiescence.classifyProcessArgv(['Tdarr_Node', '/media/Movie.NVENC.CUDA.mkv']),
    null,
    'the persistent node and a release-style media name are not tool identity'
  );
  for (const argv of [
    ['grep', '-E', 'ffmpeg|ffprobe|nvencc|libvmaf|cuda', '/proc/processes'],
    ['/usr/bin/egrep', 'ffmpeg', '/tmp/process-snapshot'],
    ['/usr/bin/fgrep', 'ffprobe', '/tmp/process-snapshot'],
    ['/usr/bin/pgrep', '-af', 'tdarr-ffmpeg'],
  ]) {
    assert.equal(
      quiescence.classifyProcessArgv(argv),
      null,
      'process-inspection patterns are not production executables'
    );
  }
  assert.equal(
    quiescence.classifyProcessArgv([
      'timeout',
      '30',
      '/usr/local/bin/ffmpeg-static',
      '-i',
      '/media/private.mkv',
    ]),
    'ffmpeg',
    'a real wrapped executable remains detectable'
  );
});

test('proc scanning fails closed on unreadable stable processes and sanitizes errors', () => {
  const denied = {
    existsSync() { return true; },
    readdirSync() { return ['12']; },
    readFileSync() {
      throw Object.assign(new Error('/media/Private Title.mkv'), { code: 'EACCES' });
    },
  };
  assert.throws(
    () => quiescence.scanProc(denied, { ownPid: 99 }),
    (error) => /PID 12 \(EACCES\)/.test(error.message)
      && !error.message.includes('Private Title')
  );

  const raced = {
    existsSync() { return true; },
    readdirSync() { return ['12', '99', 'self', 'thread-self']; },
    readFileSync() { throw enoent(); },
  };
  assert.deepEqual(quiescence.scanProc(raced, { ownPid: 99 }), []);
});

test('runs two complete read-only snapshots separated by the bounded interval', async () => {
  const nodes = [{ alpha: goodNode() }, { alpha: goodNode() }];
  const api = requestSequence(nodes);
  const slept = [];
  const result = await quiescence.assertTdarrQuiescence(testConfig(), {
    fs: emptyProcFs(),
    platform: 'linux',
    pid: 999,
    requestJson: api.requestJson,
    sleep(milliseconds) {
      slept.push(milliseconds);
      return Promise.resolve();
    },
  });
  assert.deepEqual(result, { checks: 2, intervalMs: 250, nodeCount: 1 });
  assert.deepEqual(slept, [250]);
  assert.deepEqual(api.calls.map((call) => call.endpoint), [
    'cruddb', 'get-nodes', 'cruddb', 'get-nodes',
  ]);
  for (const call of api.calls.filter((entry) => entry.endpoint === 'cruddb')) {
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.body.data.collection, 'SettingsGlobalJSONDB');
    assert.equal(call.options.body.data.mode, 'getById');
  }
  for (const call of api.calls.filter((entry) => entry.endpoint === 'get-nodes')) {
    assert.equal(call.options.method, undefined);
    assert.equal(call.options.body, undefined);
  }
});

test('fails if manual pause, node membership, lock, or processes change', async (context) => {
  await context.test('global pause is not manual', async () => {
    const api = requestSequence([{ alpha: goodNode() }], {
      settings: [{ pauseAllNodes: true }],
    });
    await assert.rejects(
      quiescence.assertTdarrQuiescence(testConfig(), {
        fs: emptyProcFs(),
        platform: 'linux',
        pid: 999,
        requestJson: api.requestJson,
        sleep: () => Promise.resolve(),
      }),
      /global manual pause is not asserted/
    );
  });

  await context.test('node membership races between snapshots', async () => {
    const api = requestSequence([
      { alpha: goodNode() },
      { alpha: goodNode(), beta: goodNode() },
    ]);
    await assert.rejects(
      quiescence.assertTdarrQuiescence(testConfig(), {
        fs: emptyProcFs(),
        platform: 'linux',
        pid: 999,
        requestJson: api.requestJson,
        sleep: () => Promise.resolve(),
      }),
      /node membership changed/
    );
  });

  await context.test('production lock appears in the second snapshot', async () => {
    const api = requestSequence([{ alpha: goodNode() }, { alpha: goodNode() }]);
    await assert.rejects(
      quiescence.assertTdarrQuiescence(testConfig(), {
        fs: emptyProcFs([false, true]),
        platform: 'linux',
        pid: 999,
        requestJson: api.requestJson,
        sleep: () => Promise.resolve(),
      }),
      /exact production GPU lock exists/
    );
  });

  await context.test('a production process appears without leaking its arguments', async () => {
    let scan = 0;
    let current = {};
    const procSnapshots = [
      {},
      { 321: ['tdarr-ffmpeg', '-i', '/media/Private Title.mkv'] },
    ];
    const procFs = {
      existsSync() { return true; },
      lstatSync() { throw enoent(); },
      readdirSync() {
        current = procSnapshots[Math.min(scan, procSnapshots.length - 1)];
        scan += 1;
        return Object.keys(current);
      },
      readFileSync(target) {
        const pid = Number(String(target).split('/').at(-2));
        return Buffer.from(`${current[pid].join('\0')}\0`);
      },
    };
    const api = requestSequence([{ alpha: goodNode() }, { alpha: goodNode() }]);
    await assert.rejects(
      quiescence.assertTdarrQuiescence(testConfig(), {
        fs: procFs,
        platform: 'linux',
        pid: 999,
        requestJson: api.requestJson,
        sleep: () => Promise.resolve(),
      }),
      (error) => /321\/ffmpeg/.test(error.message)
        && !error.message.includes('/media/')
        && !error.message.includes('Private Title')
    );
  });
});

test('rejects non-Linux execution instead of silently skipping process evidence', async () => {
  const api = requestSequence([{ alpha: goodNode() }]);
  await assert.rejects(
    quiescence.assertTdarrQuiescence(testConfig(), {
      fs: emptyProcFs(),
      platform: 'win32',
      pid: 999,
      requestJson: api.requestJson,
      sleep: () => Promise.resolve(),
    }),
    /requires Linux \/proc/
  );
});
