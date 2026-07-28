'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const authBoundary = require('./build-scripts/verify-tdarr-auth-boundary');

function fakeTransport(statusCode, body = '{}', behavior = {}) {
  const calls = [];
  return {
    calls,
    request(url, options, callback) {
      const request = new EventEmitter();
      request.destroy = (error) => {
        queueMicrotask(() => request.emit('error', error));
      };
      request.end = () => {
        if (behavior.requestError) {
          queueMicrotask(() => request.emit('error', behavior.requestError));
          return;
        }
        if (behavior.timeout) {
          queueMicrotask(() => request.emit('timeout'));
          return;
        }
        const response = new EventEmitter();
        response.statusCode = statusCode;
        calls.push({ url: String(url), options });
        callback(response);
        queueMicrotask(() => {
          if (behavior.responseError) {
            response.emit('error', behavior.responseError);
            return;
          }
          response.emit('data', Buffer.from(body));
          response.emit('end');
        });
      };
      return request;
    },
  };
}

function config(overrides = {}) {
  return Object.freeze({
    apiBase: 'http://127.0.0.1:8266/api/v2',
    timeoutMs: 1000,
    ...overrides,
  });
}

test('uses the exact valid endpoint without any authentication header', async () => {
  for (const statusCode of [401, 403]) {
    const transport = fakeTransport(statusCode);
    const result = await authBoundary.createUnauthenticatedProbe(
      config(),
      { http: transport, https: transport }
    )();
    assert.deepEqual(result, { statusCode });
    assert.equal(transport.calls.length, 1);
    assert.equal(
      transport.calls[0].url,
      'http://127.0.0.1:8266/api/v2/get-nodes'
    );
    assert.equal(transport.calls[0].options.method, 'GET');
    assert.deepEqual(
      transport.calls[0].options.headers,
      { accept: 'application/json' }
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        transport.calls[0].options.headers,
        'x-api-key'
      ),
      false
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        transport.calls[0].options.headers,
        'authorization'
      ),
      false
    );
  }
});

test('fails closed for success, missing-route, redirect, or unknown status', async () => {
  for (const statusCode of [200, 204, 302, 404, 500, undefined]) {
    const transport = fakeTransport(statusCode);
    await assert.rejects(
      authBoundary.createUnauthenticatedProbe(
        config(),
        { http: transport, https: transport }
      )(),
      /unauthenticated get-nodes returned HTTP/
    );
  }
});

test('requires a literal-loopback API base and bounded timeout', () => {
  assert.deepEqual(
    authBoundary.configFromEnv({
      TDARR_API_BASE: 'https://[::1]:8266/api/v2',
      TDARR_API_TIMEOUT_MS: '250',
      TDARR_API_KEY: ['must', 'not', 'be', 'read'].join('-'),
      apiKey: ['must', 'not', 'be', 'read', 'either'].join('-'),
    }),
    {
      apiBase: 'https://[::1]:8266/api/v2',
      timeoutMs: 250,
    }
  );
  assert.throws(
    () => authBoundary.configFromEnv({
      TDARR_API_BASE: 'http://localhost:8266/api/v2',
    }),
    /literal loopback/
  );
  assert.throws(
    () => authBoundary.configFromEnv({ TDARR_API_TIMEOUT_MS: '10001' }),
    /TDARR_API_TIMEOUT_MS/
  );
});

test('bounds response bytes and normalizes transport failures', async () => {
  const oversized = fakeTransport(401, 'x'.repeat(
    authBoundary.MAX_RESPONSE_BYTES + 1
  ));
  await assert.rejects(
    authBoundary.createUnauthenticatedProbe(
      config(),
      { http: oversized, https: oversized }
    )(),
    /TDARR_AUTH_PROBE_RESPONSE_TOO_LARGE/
  );

  for (const transport of [
    fakeTransport(401, '{}', {
      requestError: Object.assign(new Error('secret details'), {
        code: 'ECONNRESET',
      }),
    }),
    fakeTransport(401, '{}', { timeout: true }),
    fakeTransport(401, '{}', {
      responseError: Object.assign(new Error('secret details'), {
        code: 'EPIPE',
      }),
    }),
  ]) {
    await assert.rejects(
      authBoundary.createUnauthenticatedProbe(
        config(),
        { http: transport, https: transport }
      )(),
      /ECONNRESET|TDARR_AUTH_PROBE_TIMEOUT|EPIPE/
    );
  }
});
