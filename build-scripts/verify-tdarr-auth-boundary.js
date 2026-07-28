'use strict';

// Read-only deployment qualification. This deliberately sends no API key and
// proves that a valid loopback Tdarr endpoint rejects the request.

const http = require('http');
const https = require('https');

const quiescence = require('./assert-tdarr-quiescence');

const DEFAULT_API_BASE = 'http://127.0.0.1:8266/api/v2';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REJECTED_STATUS_CODES = Object.freeze(new Set([401, 403]));

function boundedTimeout(value) {
  const timeout = value === undefined || value === null || value === ''
    ? DEFAULT_TIMEOUT_MS
    : Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 250 || timeout > 10000) {
    throw new RangeError('TDARR_API_TIMEOUT_MS must be an integer from 250 through 10000');
  }
  return timeout;
}

function safeErrorCode(error) {
  const value = error && (error.code || error.name) || 'unknown-error';
  return String(value).replace(/[^A-Za-z0-9_.:@-]/g, '?').slice(0, 80);
}

function configFromEnv(environment = process.env) {
  return Object.freeze({
    apiBase: quiescence.normalizeApiBase(
      environment.TDARR_API_BASE || DEFAULT_API_BASE
    ),
    timeoutMs: boundedTimeout(environment.TDARR_API_TIMEOUT_MS),
  });
}

function createUnauthenticatedProbe(
  config,
  transports = { http, https }
) {
  return function probe() {
    const url = new URL(`${config.apiBase}/get-nodes`);
    const transport = url.protocol === 'https:' ? transports.https : transports.http;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const request = transport.request(url, {
        method: 'GET',
        headers: Object.freeze({ accept: 'application/json' }),
        timeout: config.timeoutMs,
      }, (response) => {
        let size = 0;
        response.on('data', (chunk) => {
          size += Buffer.byteLength(chunk);
          if (size > MAX_RESPONSE_BYTES) {
            const error = Object.assign(
              new Error('TDARR_AUTH_PROBE_RESPONSE_TOO_LARGE'),
              { code: 'TDARR_AUTH_PROBE_RESPONSE_TOO_LARGE' }
            );
            finishReject(error);
            request.destroy(error);
          }
        });
        response.on('end', () => {
          if (settled) return;
          const statusCode = Number(response.statusCode);
          if (!REJECTED_STATUS_CODES.has(statusCode)) {
            finishReject(new Error(
              `Tdarr unauthenticated get-nodes returned HTTP ${
                Number.isSafeInteger(statusCode) ? statusCode : 'unknown'
              }`
            ));
            return;
          }
          settled = true;
          resolve(Object.freeze({ statusCode }));
        });
        response.on('error', (error) => finishReject(new Error(
          `Tdarr unauthenticated response failed (${safeErrorCode(error)})`
        )));
      });
      request.on('timeout', () => request.destroy(
        Object.assign(new Error('TDARR_AUTH_PROBE_TIMEOUT'), {
          code: 'TDARR_AUTH_PROBE_TIMEOUT',
        })
      ));
      request.on('error', (error) => finishReject(new Error(
        `Tdarr unauthenticated request failed (${safeErrorCode(error)})`
      )));
      request.end();
    });
  };
}

async function main() {
  const config = configFromEnv();
  const result = await createUnauthenticatedProbe(config)();
  process.stdout.write(
    `PASS Tdarr auth boundary: unauthenticated get-nodes rejected with HTTP ${result.statusCode}\n`
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `ERROR Tdarr auth boundary verification failed (${safeErrorCode(error)})\n`
    );
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  DEFAULT_API_BASE,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  REJECTED_STATUS_CODES,
  boundedTimeout,
  configFromEnv,
  createUnauthenticatedProbe,
  safeErrorCode,
});
