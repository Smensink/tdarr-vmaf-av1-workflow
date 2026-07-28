'use strict';

const assert = require('assert');
const http = require('http');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function mockTdarrRuntime(request, parent, isMain) {
  if (request.endsWith('/methods/lib') || request === '../../../../../methods/lib') {
    return () => ({
      loadDefaultValues(inputs, details) {
        const defaults = Object.fromEntries(
          details().inputs.map((input) => [input.name, input.defaultValue]),
        );
        return { ...defaults, ...(inputs || {}) };
      },
    });
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { plugin } = require('./plugins/tools/unmonitorRadarrOrSonarr/1.0.0/index.js');

function jsonResponse(response, status, body) {
  response.statusCode = status;
  if (body === undefined) {
    response.end();
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

async function createMockArr(responder) {
  const calls = [];
  let serverError = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', async () => {
      const text = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
      const call = {
        method: request.method,
        url: new URL(request.url, 'http://mock.invalid'),
        headers: request.headers,
        body: text ? JSON.parse(text) : null,
      };
      calls.push(call);
      try {
        const reply = await responder(call, calls);
        jsonResponse(response, reply?.status ?? 200, reply?.body);
      } catch (error) {
        serverError = error;
        jsonResponse(response, 500, { error: error.message });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    calls,
    host: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
      if (serverError) throw serverError;
    },
  };
}

function makeArgs(host, overrides = {}) {
  const sourcePath = overrides.sourcePath || '/library/features/Example (2021)/Example (2021).mkv';
  const logs = [];
  const args = {
    inputs: {
      arr: overrides.arr || 'radarr',
      arr_host: host,
      arr_api_key: 'unit-test-key',
      sonarr_scope: overrides.scope || 'episodes',
    },
    inputFileObj: {
      _id: overrides.libraryPath || sourcePath,
    },
    variables: {
      vmafOriginalFile: sourcePath,
    },
    jobLog(message) {
      logs.push(String(message));
    },
  };
  return { args, logs };
}

async function runWithMock(overrides, responder) {
  const mock = await createMockArr(responder);
  const { args, logs } = makeArgs(mock.host, overrides);
  let result;
  try {
    result = await plugin(args);
  } finally {
    await mock.close();
  }
  return { result, logs, calls: mock.calls };
}

function assertApiKey(call) {
  assert.strictEqual(call.headers['x-api-key'], 'unit-test-key');
}

async function testSourceEvidenceMismatchFailsBeforeNetwork() {
  const { args, logs } = makeArgs('http://127.0.0.1:9', {
    sourcePath: '/library/features/Expected/Expected.mkv',
    libraryPath: '/library/features/Different/Different.mkv',
  });
  const result = await plugin(args);
  assert.strictEqual(result.outputNumber, 2);
  assert.ok(logs.some((line) => line.includes('original and library path evidence disagree')));
}

async function testRadarrIdentityAndReadbackSuccess() {
  let monitored = true;
  const file = {
    id: 70,
    movieId: 7,
    path: 'X:\\Library\\Example (2021)\\Example (2021).mkv',
    relativePath: 'Example (2021).mkv',
  };
  const { result, calls } = await runWithMock({}, (call) => {
    assertApiKey(call);
    if (call.method === 'GET' && call.url.pathname === '/api/v3/parse') {
      assert.strictEqual(call.url.searchParams.get('title'), 'Example (2021).mkv');
      return { body: { movie: { id: 7 } } };
    }
    if (call.method === 'GET' && call.url.pathname === '/api/v3/movie/7') {
      return { body: { id: 7, path: 'X:\\Library\\Example (2021)', monitored } };
    }
    if (call.method === 'GET' && call.url.pathname === '/api/v3/moviefile') {
      assert.strictEqual(call.url.searchParams.get('movieId'), '7');
      return { body: [file] };
    }
    if (call.method === 'PUT' && call.url.pathname === '/api/v3/movie/editor') {
      assert.deepStrictEqual(call.body, { movieIds: [7], monitored: false });
      monitored = false;
      return { body: {} };
    }
    throw new Error(`unexpected Radarr request: ${call.method} ${call.url.pathname}`);
  });
  assert.strictEqual(result.outputNumber, 1);
  assert.strictEqual(calls.filter((call) => call.method === 'PUT').length, 1);
  assert.strictEqual(calls.filter((call) => call.url.pathname === '/api/v3/movie/7').length, 2);
  assert.strictEqual(calls.filter((call) => call.url.pathname === '/api/v3/moviefile').length, 2);
}

async function testRadarrPathMismatchFailsBeforeMutation() {
  const { result, calls, logs } = await runWithMock({}, (call) => {
    if (call.url.pathname === '/api/v3/parse') return { body: { movie: { id: 7 } } };
    if (call.url.pathname === '/api/v3/movie/7') {
      return { body: { id: 7, path: 'D:\\FixtureLibrary\\Wrong', monitored: true } };
    }
    if (call.url.pathname === '/api/v3/moviefile') {
      return {
        body: [{
          id: 71,
          movieId: 7,
          path: 'D:\\FixtureLibrary\\Wrong\\Wrong.mkv',
          relativePath: 'Wrong.mkv',
        }],
      };
    }
    throw new Error(`unexpected mutation after path mismatch: ${call.method} ${call.url.pathname}`);
  });
  assert.strictEqual(result.outputNumber, 2);
  assert.strictEqual(calls.some((call) => call.method === 'PUT'), false);
  assert.ok(logs.some((line) => line.includes('not an exact mapped-path match')));
}

async function testRadarrAmbiguityFailsBeforeMutation() {
  const matchingPath = 'X:\\Library\\Example (2021)\\Example (2021).mkv';
  const { result, calls, logs } = await runWithMock({}, (call) => {
    if (call.url.pathname === '/api/v3/parse') return { body: { movie: { id: 7 } } };
    if (call.url.pathname === '/api/v3/movie/7') {
      return { body: { id: 7, path: 'X:\\Library\\Example (2021)', monitored: true } };
    }
    if (call.url.pathname === '/api/v3/moviefile') {
      return {
        body: [
          { id: 70, movieId: 7, path: matchingPath },
          { id: 71, movieId: 7, path: matchingPath },
        ],
      };
    }
    throw new Error(`unexpected mutation after ambiguous identity: ${call.method} ${call.url.pathname}`);
  });
  assert.strictEqual(result.outputNumber, 2);
  assert.strictEqual(calls.some((call) => call.method === 'PUT'), false);
  assert.ok(logs.some((line) => line.includes('file identity is ambiguous')));
}

async function testRadarrReadbackFailureIsNotSuccess() {
  const { result, calls, logs } = await runWithMock({}, (call) => {
    if (call.url.pathname === '/api/v3/parse') return { body: { movie: { id: 7 } } };
    if (call.url.pathname === '/api/v3/movie/7') {
      return { body: { id: 7, path: 'X:\\Library\\Example (2021)', monitored: true } };
    }
    if (call.url.pathname === '/api/v3/moviefile') {
      return {
        body: [{
          id: 70,
          movieId: 7,
          path: 'X:\\Library\\Example (2021)\\Example (2021).mkv',
        }],
      };
    }
    if (call.method === 'PUT' && call.url.pathname === '/api/v3/movie/editor') {
      return { body: {} };
    }
    throw new Error(`unexpected Radarr request: ${call.method} ${call.url.pathname}`);
  });
  assert.strictEqual(result.outputNumber, 2);
  assert.strictEqual(calls.filter((call) => call.method === 'PUT').length, 1);
  assert.ok(logs.some((line) => line.includes('mutation readback')));
}

function sonarrResponder(state, call) {
  assertApiKey(call);
  if (call.method === 'GET' && call.url.pathname === '/api/v3/parse') {
    return { body: { series: { id: 3 } } };
  }
  if (call.method === 'GET' && call.url.pathname === '/api/v3/series/3') {
    return {
      body: {
        id: 3,
        path: 'D:\\FixtureSeries\\Example Show',
        monitored: state.seriesMonitored,
      },
    };
  }
  if (call.method === 'GET' && call.url.pathname === '/api/v3/episode') {
    assert.strictEqual(call.url.searchParams.get('seriesId'), '3');
    return {
      body: state.episodes.map((episode) => ({
        ...episode,
        monitored: state.episodeMonitored,
      })),
    };
  }
  if (call.method === 'GET' && call.url.pathname === '/api/v3/episodefile/90') {
    return {
      body: {
        id: 90,
        seriesId: 3,
        path: 'D:\\FixtureSeries\\Example Show\\Season 01\\Example.Show.S01E01E02.mkv',
        relativePath: 'Season 01\\Example.Show.S01E01E02.mkv',
      },
    };
  }
  return null;
}

async function testSonarrMultiEpisodeIdentityAndReadbackSuccess() {
  const state = {
    seriesMonitored: true,
    episodeMonitored: true,
    episodes: [
      { id: 11, seriesId: 3, seasonNumber: 1, episodeNumber: 1, episodeFileId: 90 },
      { id: 12, seriesId: 3, seasonNumber: 1, episodeNumber: 2, episodeFileId: 90 },
    ],
  };
  const sourcePath = '/library/series/Example Show/Season 01/Example.Show.S01E01E02.mkv';
  const { result, calls } = await runWithMock({ arr: 'sonarr', sourcePath }, (call) => {
    const response = sonarrResponder(state, call);
    if (response) return response;
    if (call.method === 'PUT' && call.url.pathname === '/api/v3/episode/monitor') {
      assert.deepStrictEqual(call.body, { episodeIds: [11, 12], monitored: false });
      state.episodeMonitored = false;
      return { body: {} };
    }
    throw new Error(`unexpected Sonarr request: ${call.method} ${call.url.pathname}`);
  });
  assert.strictEqual(result.outputNumber, 1);
  assert.strictEqual(calls.filter((call) => call.url.pathname === '/api/v3/episode').length, 2);
  assert.strictEqual(calls.filter((call) => call.url.pathname === '/api/v3/episodefile/90').length, 2);
}

async function testSonarrEpisodeAmbiguityFailsBeforeMutation() {
  const state = {
    seriesMonitored: true,
    episodeMonitored: true,
    episodes: [
      { id: 11, seriesId: 3, seasonNumber: 1, episodeNumber: 1, episodeFileId: 90 },
      { id: 13, seriesId: 3, seasonNumber: 1, episodeNumber: 1, episodeFileId: 91 },
      { id: 12, seriesId: 3, seasonNumber: 1, episodeNumber: 2, episodeFileId: 90 },
    ],
  };
  const sourcePath = '/library/series/Example Show/Season 01/Example.Show.S01E01E02.mkv';
  const { result, calls, logs } = await runWithMock(
    { arr: 'sonarr', sourcePath },
    (call) => {
      const response = sonarrResponder(state, call);
      if (response) return response;
      throw new Error(`unexpected mutation after ambiguous episode: ${call.method} ${call.url.pathname}`);
    },
  );
  assert.strictEqual(result.outputNumber, 2);
  assert.strictEqual(calls.some((call) => call.method === 'PUT'), false);
  assert.ok(logs.some((line) => line.includes('episode identity is ambiguous')));
}

async function testSonarrSeriesScopeUsesFileIdentityAndReadback() {
  const state = {
    seriesMonitored: true,
    episodeMonitored: true,
    episodes: [
      { id: 11, seriesId: 3, seasonNumber: 1, episodeNumber: 1, episodeFileId: 90 },
      { id: 12, seriesId: 3, seasonNumber: 1, episodeNumber: 2, episodeFileId: 90 },
    ],
  };
  const sourcePath = '/library/series/Example Show/Season 01/Example.Show.S01E01E02.mkv';
  const { result, calls } = await runWithMock(
    { arr: 'sonarr', sourcePath, scope: 'series' },
    (call) => {
      const response = sonarrResponder(state, call);
      if (response) return response;
      if (call.method === 'PUT' && call.url.pathname === '/api/v3/series/editor') {
        assert.deepStrictEqual(call.body, { seriesIds: [3], monitored: false });
        state.seriesMonitored = false;
        return { body: {} };
      }
      throw new Error(`unexpected Sonarr request: ${call.method} ${call.url.pathname}`);
    },
  );
  assert.strictEqual(result.outputNumber, 1);
  assert.strictEqual(calls.filter((call) => call.url.pathname === '/api/v3/series/3').length, 2);
}

(async () => {
  const previousRadarrKey = process.env.TDARR_RADARR_API_KEY;
  const previousSonarrKey = process.env.TDARR_SONARR_API_KEY;
  process.env.TDARR_RADARR_API_KEY = '';
  process.env.TDARR_SONARR_API_KEY = '';
  try {
    await testSourceEvidenceMismatchFailsBeforeNetwork();
    await testRadarrIdentityAndReadbackSuccess();
    await testRadarrPathMismatchFailsBeforeMutation();
    await testRadarrAmbiguityFailsBeforeMutation();
    await testRadarrReadbackFailureIsNotSuccess();
    await testSonarrMultiEpisodeIdentityAndReadbackSuccess();
    await testSonarrEpisodeAmbiguityFailsBeforeMutation();
    await testSonarrSeriesScopeUsesFileIdentityAndReadback();
    console.log('PASS Arr unmonitor identity and mutation readback contract');
  } finally {
    if (previousRadarrKey === undefined) delete process.env.TDARR_RADARR_API_KEY;
    else process.env.TDARR_RADARR_API_KEY = previousRadarrKey;
    if (previousSonarrKey === undefined) delete process.env.TDARR_SONARR_API_KEY;
    else process.env.TDARR_SONARR_API_KEY = previousSonarrKey;
    Module._load = originalLoad;
  }
})().catch((error) => {
  Module._load = originalLoad;
  console.error(error);
  process.exitCode = 1;
});
