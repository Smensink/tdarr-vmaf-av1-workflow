'use strict';

// Consumes `docker compose config --format json` on stdin and emits only a
// generic pass/fail result. The resolved model can contain credentials, so no
// parsed value is ever included in output or error messages.

const path = require('node:path');
const crypto = require('node:crypto');

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const PRIVATE_RUNTIME_TARGET = '/private/tdarr-runtime';
const PRIVATE_RUNTIME_VOLUME_KEY = 'tdarr-private-runtime';
const DEFAULT_PROJECT_NAME = 'tdarr-vmaf-av1';
const ALLOWED_SERVICE_KEYS = Object.freeze(new Set([
  'build',
  'command',
  'container_name',
  'entrypoint',
  'environment',
  'gpus',
  'healthcheck',
  'image',
  'labels',
  'logging',
  'networks',
  'ports',
  'restart',
  'volumes',
]));
const IMMUTABLE_BIND_TARGETS = Object.freeze({
  init: '/custom-cont-init.d',
  build: '/usr/local/build-scripts',
  nvencc: '/opt/nvencc-artifact',
});

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 ||
      /[\0\r\n]/.test(value)) {
    fail(code);
  }
  return value;
}

function expectedPort(value, fallback, code) {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    fail(code);
  }
  return parsed;
}

function requiredSha256(value, code) {
  const text = requiredText(value, code);
  if (!/^[0-9a-f]{64}$/.test(text)) fail(code);
  return text;
}

function expectedFromEnv(environment = process.env) {
  const projectName = requiredText(
    environment.TDARR_EXPECTED_PROJECT_NAME || DEFAULT_PROJECT_NAME,
    'EXPECTED_PROJECT_NAME_INVALID'
  );
  return Object.freeze({
    image: requiredText(
      environment.TDARR_EXPECTED_IMAGE,
      'EXPECTED_IMAGE_INVALID'
    ),
    privateVolume: requiredText(
      environment.TDARR_EXPECTED_PRIVATE_RUNTIME_VOLUME,
      'EXPECTED_PRIVATE_VOLUME_INVALID'
    ),
    bindSources: Object.freeze({
      init: requiredText(
        environment.TDARR_EXPECTED_INIT_SOURCE,
        'EXPECTED_INIT_SOURCE_INVALID'
      ),
      build: requiredText(
        environment.TDARR_EXPECTED_BUILD_SOURCE,
        'EXPECTED_BUILD_SOURCE_INVALID'
      ),
      nvencc: requiredText(
        environment.TDARR_EXPECTED_NVENCC_SOURCE,
        'EXPECTED_NVENCC_SOURCE_INVALID'
      ),
    }),
    hostPorts: Object.freeze({
      web: expectedPort(
        environment.TDARR_EXPECTED_WEB_PORT,
        8265,
        'EXPECTED_WEB_PORT_INVALID'
      ),
      server: expectedPort(
        environment.TDARR_EXPECTED_SERVER_PORT,
        8266,
        'EXPECTED_SERVER_PORT_INVALID'
      ),
    }),
    projectName,
    networkName: requiredText(
      environment.TDARR_EXPECTED_NETWORK_NAME ||
        `${projectName}_default`,
      'EXPECTED_NETWORK_NAME_INVALID'
    ),
    sanitizedModelSha256: requiredSha256(
      environment.TDARR_EXPECTED_SANITIZED_MODEL_SHA256,
      'EXPECTED_SANITIZED_MODEL_SHA256_INVALID'
    ),
  });
}

function exactPort(port, hostPort, containerPort) {
  return isRecord(port) &&
    port.host_ip === '127.0.0.1' &&
    String(port.published) === String(hostPort) &&
    Number(port.target) === containerPort &&
    port.protocol === 'tcp' &&
    port.mode === 'ingress';
}

function exactMount(volumes, target) {
  const matches = volumes.filter((volume) =>
    isRecord(volume) && volume.target === target
  );
  if (matches.length !== 1) fail('MOUNT_CARDINALITY_INVALID');
  return matches[0];
}

function normalizedMountTarget(value) {
  if (typeof value !== 'string' || value.length < 2 ||
      value.length > 4096 || !value.startsWith('/') ||
      /[\0\r\n]/.test(value)) {
    fail('MOUNT_TARGET_INVALID');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '/') {
    fail('MOUNT_TARGET_INVALID');
  }
  return normalized;
}

function mountTargetsOverlap(left, right) {
  const first = normalizedMountTarget(left);
  const second = normalizedMountTarget(right);
  return first === second ||
    first.startsWith(`${second}/`) ||
    second.startsWith(`${first}/`);
}

function assertCredentialValue(value) {
  if (typeof value !== 'string' ||
      !/^tapi_[A-Za-z0-9_]{11,507}$/.test(value)) {
    fail('API_KEY_INVALID');
  }
}

function sensitiveEnvironmentKey(key) {
  return /(?:api[_-]?key|token|password|secret)$/i.test(key) ||
    key === 'apiKey' ||
    key === 'seededApiKey';
}

function sanitizedSortedClone(value, keyPath = []) {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      sanitizedSortedClone(item, [...keyPath, String(index)]));
  }
  if (!isRecord(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const environmentValue =
      keyPath.length >= 2 &&
      keyPath[keyPath.length - 1] === 'environment' &&
      sensitiveEnvironmentKey(key);
    output[key] = environmentValue
      ? '[REDACTED]'
      : sanitizedSortedClone(value[key], [...keyPath, key]);
  }
  return output;
}

function sanitizedModelSha256(model) {
  if (!isRecord(model)) fail('COMPOSE_MODEL_INVALID');
  return crypto.createHash('sha256')
    .update(JSON.stringify(sanitizedSortedClone(model)))
    .digest('hex');
}

function validateComposeModel(model, expected) {
  if (!isRecord(model) || !isRecord(model.services) ||
      !isRecord(model.services.tdarr)) {
    fail('TDARR_SERVICE_MISSING');
  }
  if (Object.keys(model.services).length !== 1) {
    fail('UNEXPECTED_SERVICE_SET');
  }
  if (model.name !== expected.projectName) fail('PROJECT_NAME_INVALID');
  if (!isRecord(model.networks) ||
      JSON.stringify(Object.keys(model.networks).sort()) !==
        JSON.stringify(['default']) ||
      !isRecord(model.networks.default) ||
      JSON.stringify(model.networks.default) !== JSON.stringify({
        name: expected.networkName,
        ipam: {},
      })) {
    fail('TOP_LEVEL_NETWORK_INVALID');
  }
  const service = model.services.tdarr;
  if (Object.keys(service).some((key) => !ALLOWED_SERVICE_KEYS.has(key))) {
    fail('UNREVIEWED_SERVICE_OPTION');
  }
  if ((service.command !== undefined && service.command !== null) ||
      (service.entrypoint !== undefined && service.entrypoint !== null)) {
    fail('PROCESS_OVERRIDE_NOT_ALLOWED');
  }
  if (!Array.isArray(service.gpus) || service.gpus.length !== 1 ||
      !isRecord(service.gpus[0]) ||
      JSON.stringify(service.gpus[0]) !== JSON.stringify({ count: -1 })) {
    fail('GPU_REQUEST_INVALID');
  }
  if (service.restart !== 'unless-stopped') fail('RESTART_POLICY_INVALID');
  if (!isRecord(service.networks) ||
      JSON.stringify(Object.keys(service.networks).sort()) !==
        JSON.stringify(['default'])) {
    fail('NETWORK_SET_INVALID');
  }
  if (service.image !== expected.image) fail('IMAGE_MISMATCH');
  if (!isRecord(service.environment)) fail('ENVIRONMENT_INVALID');
  const environment = service.environment;
  if (String(environment.auth) !== 'true') fail('AUTH_NOT_ENABLED');
  if (String(environment.internalNode) !== 'true') {
    fail('INTERNAL_NODE_NOT_ENABLED');
  }
  if (String(environment.inContainer) !== 'true') {
    fail('IN_CONTAINER_NOT_ENABLED');
  }
  if (environment.serverURL !== 'http://127.0.0.1:8266') {
    fail('SERVER_URL_NOT_LOOPBACK');
  }
  if (String(environment.enableDockerAutoUpdater) !== 'false' ||
      environment.cronPluginUpdate !== '') {
    fail('UPDATER_NOT_DISABLED');
  }
  if (environment.TDARR_FLOW_PARITY_BOOTSTRAP !== undefined &&
      String(environment.TDARR_FLOW_PARITY_BOOTSTRAP) !== '0') {
    fail('FLOW_BOOTSTRAP_NOT_DISABLED');
  }
  assertCredentialValue(environment.apiKey);
  assertCredentialValue(environment.seededApiKey);
  if (environment.apiKey !== environment.seededApiKey) {
    fail('API_KEYS_DIFFER');
  }

  if (!Array.isArray(service.ports) || service.ports.length !== 2 ||
      !service.ports.some((port) =>
        exactPort(port, expected.hostPorts.web, 8265)) ||
      !service.ports.some((port) =>
        exactPort(port, expected.hostPorts.server, 8266))) {
    fail('PORT_PUBLICATION_INVALID');
  }
  if (!isRecord(service.labels) ||
      JSON.stringify(service.labels) !== JSON.stringify({
        'com.centurylinklabs.watchtower.enable': 'false',
      })) {
    fail('WATCHTOWER_NOT_DISABLED');
  }
  if (!isRecord(service.healthcheck) ||
      JSON.stringify(service.healthcheck.test) !== JSON.stringify([
        'CMD',
        'bash',
        '-c',
        'exec 3<>/dev/tcp/127.0.0.1/8266',
      ])) {
    fail('HEALTHCHECK_NOT_CHEAP_TCP');
  }

  if (!Array.isArray(service.volumes)) fail('VOLUMES_INVALID');
  const privateMount = exactMount(service.volumes, PRIVATE_RUNTIME_TARGET);
  if (privateMount.type !== 'volume' ||
      privateMount.source !== PRIVATE_RUNTIME_VOLUME_KEY ||
      privateMount.read_only !== true) {
    fail('PRIVATE_RUNTIME_MOUNT_INVALID');
  }
  if (!isRecord(model.volumes) ||
      !isRecord(model.volumes[PRIVATE_RUNTIME_VOLUME_KEY]) ||
      model.volumes[PRIVATE_RUNTIME_VOLUME_KEY].name !==
        expected.privateVolume ||
      model.volumes[PRIVATE_RUNTIME_VOLUME_KEY].external !== true) {
    fail('PRIVATE_RUNTIME_VOLUME_DECLARATION_INVALID');
  }
  for (const [name, target] of Object.entries(IMMUTABLE_BIND_TARGETS)) {
    const mount = exactMount(service.volumes, target);
    if (mount.type !== 'bind' ||
        mount.source !== expected.bindSources[name] ||
        mount.read_only !== true) {
      fail('IMMUTABLE_BIND_INVALID');
    }
  }
  const protectedMounts = new Set([
    privateMount,
    ...Object.values(IMMUTABLE_BIND_TARGETS).map((target) =>
      exactMount(service.volumes, target)),
  ]);
  const protectedTargets = [
    PRIVATE_RUNTIME_TARGET,
    ...Object.values(IMMUTABLE_BIND_TARGETS),
  ];
  for (const mount of service.volumes) {
    if (!isRecord(mount)) fail('VOLUMES_INVALID');
    normalizedMountTarget(mount.target);
    if (protectedMounts.has(mount)) continue;
    if (protectedTargets.some((target) =>
      mountTargetsOverlap(mount.target, target))) {
      fail('PROTECTED_MOUNT_OVERLAP');
    }
  }
  if (sanitizedModelSha256(model) !== expected.sanitizedModelSha256) {
    fail('SANITIZED_MODEL_MISMATCH');
  }

  return Object.freeze({
    serviceCount: Object.keys(model.services).length,
    publishedPortCount: service.ports.length,
    immutableBindCount: Object.keys(IMMUTABLE_BIND_TARGETS).length,
    privateRuntimeMountCount: 1,
    privateRuntimeExternalVolumeCount: 1,
  });
}

function safeCode(error) {
  const value = error && (error.code || error.name) || 'UNKNOWN_ERROR';
  return String(value).replace(/[^A-Za-z0-9_:-]/g, '?').slice(0, 80);
}

async function readStdin(input = process.stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_INPUT_BYTES) fail('COMPOSE_MODEL_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  if (size < 2) fail('COMPOSE_MODEL_EMPTY');
  let model;
  try {
    model = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (_) {
    fail('COMPOSE_MODEL_JSON_INVALID');
  }
  return model;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 ||
      (argv.length === 1 && argv[0] !== '--print-sanitized-sha256')) {
    fail('INVALID_ARGUMENTS');
  }
  const model = await readStdin();
  if (argv.length === 1) {
    process.stdout.write(`${sanitizedModelSha256(model)}\n`);
    return;
  }
  const expected = expectedFromEnv();
  validateComposeModel(model, expected);
  process.stdout.write(
    'PASS Compose security model: r3 image, loopback ports, auth, ' +
    'immutable binds, and private evidence mount\n'
  );
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `ERROR Compose security model verification failed (${safeCode(error)})\n`
    );
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  IMMUTABLE_BIND_TARGETS,
  ALLOWED_SERVICE_KEYS,
  DEFAULT_PROJECT_NAME,
  MAX_INPUT_BYTES,
  PRIVATE_RUNTIME_TARGET,
  PRIVATE_RUNTIME_VOLUME_KEY,
  exactPort,
  expectedPort,
  mountTargetsOverlap,
  normalizedMountTarget,
  expectedFromEnv,
  requiredSha256,
  readStdin,
  safeCode,
  sanitizedModelSha256,
  sanitizedSortedClone,
  validateComposeModel,
});
