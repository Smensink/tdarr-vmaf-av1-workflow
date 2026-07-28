'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const verifier = require('./build-scripts/verify-compose-security-model');

const API_KEY_PREFIX = 'tapi_';
const SECRET = `${API_KEY_PREFIX}${[
  'private',
  'test',
  'key',
  'value',
  '1234567890',
].join('_')}`;

function expectedBase() {
  return Object.freeze({
    image: 'tdarr-r3:test',
    privateVolume: 'private-evidence-test',
    bindSources: Object.freeze({
      init: 'C:\\staged\\init',
      build: 'C:\\staged\\build',
      nvencc: 'C:\\staged\\nvencc',
    }),
    hostPorts: Object.freeze({
      web: 8265,
      server: 8266,
    }),
    projectName: 'tdarr-vmaf-av1',
    networkName: 'tdarr-vmaf-av1_default',
  });
}

function goodModel() {
  const target = expectedBase();
  return {
    name: target.projectName,
    services: {
      tdarr: {
        image: target.image,
        command: null,
        entrypoint: null,
        gpus: [{ count: -1 }],
        restart: 'unless-stopped',
        networks: {
          default: null,
        },
        environment: {
          auth: 'true',
          internalNode: 'true',
          inContainer: 'true',
          serverURL: 'http://127.0.0.1:8266',
          apiKey: SECRET,
          seededApiKey: SECRET,
          enableDockerAutoUpdater: 'false',
          cronPluginUpdate: '',
          TDARR_FLOW_PARITY_BOOTSTRAP: '0',
          TDARR_TMDB_API_KEY: '',
        },
        labels: {
          'com.centurylinklabs.watchtower.enable': 'false',
        },
        ports: [
          {
            mode: 'ingress',
            host_ip: '127.0.0.1',
            target: 8265,
            published: String(target.hostPorts.web),
            protocol: 'tcp',
          },
          {
            mode: 'ingress',
            host_ip: '127.0.0.1',
            target: 8266,
            published: String(target.hostPorts.server),
            protocol: 'tcp',
          },
        ],
        healthcheck: {
          test: [
            'CMD',
            'bash',
            '-c',
            'exec 3<>/dev/tcp/127.0.0.1/8266',
          ],
        },
        volumes: [
          {
            type: 'volume',
            source: verifier.PRIVATE_RUNTIME_VOLUME_KEY,
            target: '/private/tdarr-runtime',
            read_only: true,
          },
          {
            type: 'bind',
            source: target.bindSources.init,
            target: '/custom-cont-init.d',
            read_only: true,
          },
          {
            type: 'bind',
            source: target.bindSources.build,
            target: '/usr/local/build-scripts',
            read_only: true,
          },
          {
            type: 'bind',
            source: target.bindSources.nvencc,
            target: '/opt/nvencc-artifact',
            read_only: true,
          },
        ],
      },
    },
    volumes: {
      [verifier.PRIVATE_RUNTIME_VOLUME_KEY]: {
        name: target.privateVolume,
        external: true,
      },
    },
    networks: {
      default: {
        name: target.networkName,
        ipam: {},
      },
    },
  };
}

function expectedFor(model) {
  return Object.freeze({
    ...expectedBase(),
    sanitizedModelSha256: verifier.sanitizedModelSha256(model),
  });
}

function expected() {
  return expectedFor(goodModel());
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('accepts the exact fail-closed r3 Compose model', () => {
  assert.deepEqual(
    verifier.validateComposeModel(goodModel(), expected()),
    {
      serviceCount: 1,
      publishedPortCount: 2,
      immutableBindCount: 3,
      privateRuntimeMountCount: 1,
      privateRuntimeExternalVolumeCount: 1,
    }
  );
  assert.deepEqual(
    verifier.expectedFromEnv({
      TDARR_EXPECTED_IMAGE: expected().image,
      TDARR_EXPECTED_PRIVATE_RUNTIME_VOLUME: expected().privateVolume,
      TDARR_EXPECTED_INIT_SOURCE: expected().bindSources.init,
      TDARR_EXPECTED_BUILD_SOURCE: expected().bindSources.build,
      TDARR_EXPECTED_NVENCC_SOURCE: expected().bindSources.nvencc,
      TDARR_EXPECTED_WEB_PORT: String(expected().hostPorts.web),
      TDARR_EXPECTED_SERVER_PORT: String(expected().hostPorts.server),
      TDARR_EXPECTED_PROJECT_NAME: expected().projectName,
      TDARR_EXPECTED_NETWORK_NAME: expected().networkName,
      TDARR_EXPECTED_SANITIZED_MODEL_SHA256:
        expected().sanitizedModelSha256,
    }),
    expected()
  );
});

test('rejects auth, API-key, endpoint, port, updater, and bootstrap drift', () => {
  const mutations = [
    (model) => { model.services.tdarr.environment.auth = 'false'; },
    (model) => {
      model.services.tdarr.environment.apiKey =
        ['private', 'test', 'key'].join('_');
    },
    (model) => { model.services.tdarr.environment.apiKey = 'tapi_short'; },
    (model) => {
      model.services.tdarr.environment.apiKey =
        `${API_KEY_PREFIX}invalid-key-value`;
    },
    (model) => {
      model.services.tdarr.environment.apiKey =
        'tapi_different_private_key_value';
    },
    (model) => { model.services.tdarr.environment.serverURL = 'http://tdarr:8266'; },
    (model) => { model.services.tdarr.ports[0].host_ip = '0.0.0.0'; },
    (model) => { model.services.tdarr.ports.push(clone(model.services.tdarr.ports[0])); },
    (model) => { model.services.tdarr.environment.enableDockerAutoUpdater = 'true'; },
    (model) => { model.services.tdarr.environment.cronPluginUpdate = '0 * * * *'; },
    (model) => { delete model.services.tdarr.environment.cronPluginUpdate; },
    (model) => { model.services.tdarr.environment.TDARR_FLOW_PARITY_BOOTSTRAP = '1'; },
    (model) => { model.services.sidecar = {}; },
  ];
  for (const mutate of mutations) {
    const model = clone(goodModel());
    mutate(model);
    assert.throws(
      () => verifier.validateComposeModel(model, expected()),
      /AUTH_NOT_ENABLED|API_KEY_INVALID|API_KEYS_DIFFER|SERVER_URL_NOT_LOOPBACK|PORT_PUBLICATION_INVALID|UPDATER_NOT_DISABLED|FLOW_BOOTSTRAP_NOT_DISABLED|UNEXPECTED_SERVICE_SET/
    );
  }
});

test('rejects host networking, process overrides, privilege fields, and extra networks', () => {
  const mutations = [
    (model) => { model.services.tdarr.network_mode = 'host'; },
    (model) => { model.services.tdarr.privileged = true; },
    (model) => { model.services.tdarr.volumes_from = ['other']; },
    (model) => { model.services.tdarr.command = ['sh', '-c', 'true']; },
    (model) => { model.services.tdarr.entrypoint = ['/bin/sh']; },
    (model) => { model.services.tdarr.gpus = []; },
    (model) => { model.services.tdarr.restart = 'always'; },
    (model) => { model.services.tdarr.networks.extra = null; },
  ];
  for (const mutate of mutations) {
    const model = clone(goodModel());
    mutate(model);
    assert.throws(
      () => verifier.validateComposeModel(model, expected()),
      /UNREVIEWED_SERVICE_OPTION|PROCESS_OVERRIDE_NOT_ALLOWED|GPU_REQUEST_INVALID|RESTART_POLICY_INVALID|NETWORK_SET_INVALID/
    );
  }
});

test('accepts only the exact reviewed loopback host ports', () => {
  const model = goodModel();
  model.services.tdarr.ports[0].published = '18265';
  model.services.tdarr.ports[1].published = '18266';
  const target = Object.freeze({
    ...expectedBase(),
    hostPorts: Object.freeze({
      web: 18265,
      server: 18266,
    }),
    sanitizedModelSha256: verifier.sanitizedModelSha256(model),
  });
  assert.doesNotThrow(() => verifier.validateComposeModel(model, target));
  assert.throws(
    () => verifier.validateComposeModel(model, expected()),
    /PORT_PUBLICATION_INVALID/
  );
  assert.throws(
    () => verifier.expectedFromEnv({
      TDARR_EXPECTED_IMAGE: expected().image,
      TDARR_EXPECTED_PRIVATE_RUNTIME_VOLUME: expected().privateVolume,
      TDARR_EXPECTED_INIT_SOURCE: expected().bindSources.init,
      TDARR_EXPECTED_BUILD_SOURCE: expected().bindSources.build,
      TDARR_EXPECTED_NVENCC_SOURCE: expected().bindSources.nvencc,
      TDARR_EXPECTED_WEB_PORT: '0',
    }),
    /EXPECTED_WEB_PORT_INVALID/
  );
});

test('requires the exact private volume and immutable bind sources', () => {
  const mutations = [
    (model) => { model.services.tdarr.volumes[0].read_only = false; },
    (model) => { model.services.tdarr.volumes[0].type = 'bind'; },
    (model) => {
      model.services.tdarr.volumes[0].source = 'other-volume';
    },
    (model) => {
      model.volumes[verifier.PRIVATE_RUNTIME_VOLUME_KEY].name =
        'other-volume';
    },
    (model) => {
      model.volumes[verifier.PRIVATE_RUNTIME_VOLUME_KEY].external = false;
    },
    (model) => {
      delete model.volumes[verifier.PRIVATE_RUNTIME_VOLUME_KEY];
    },
    (model) => { model.services.tdarr.volumes[1].source = 'C:\\wrong'; },
    (model) => { model.services.tdarr.volumes[2].read_only = false; },
    (model) => { model.services.tdarr.volumes[3].type = 'volume'; },
    (model) => { model.services.tdarr.volumes.push(clone(model.services.tdarr.volumes[0])); },
  ];
  for (const mutate of mutations) {
    const model = clone(goodModel());
    mutate(model);
    assert.throws(
      () => verifier.validateComposeModel(model, expected()),
      /PRIVATE_RUNTIME_MOUNT_INVALID|PRIVATE_RUNTIME_VOLUME_DECLARATION_INVALID|IMMUTABLE_BIND_INVALID|MOUNT_CARDINALITY_INVALID/
    );
  }
});

test('rejects ancestor and descendant mounts that shadow protected roots', () => {
  const targets = [
    '/private',
    '/private/tdarr-runtime/shadow',
    '/custom-cont-init.d/late',
    '/usr/local',
    '/usr/local/build-scripts/override',
    '/opt/nvencc-artifact/bin',
  ];
  for (const target of targets) {
    const model = clone(goodModel());
    model.services.tdarr.volumes.push({
      type: 'bind',
      source: 'C:\\unreviewed',
      target,
      read_only: false,
    });
    assert.throws(
      () => verifier.validateComposeModel(model, expected()),
      /PROTECTED_MOUNT_OVERLAP/
    );
  }
  assert.equal(
    verifier.mountTargetsOverlap(
      '/private/tdarr-runtime',
      '/private/tdarr-runtime/shadow'
    ),
    true
  );
  assert.throws(
    () => verifier.normalizedMountTarget('/private/../private/tdarr-runtime'),
    /MOUNT_TARGET_INVALID/
  );
});

test('the reviewed-model digest rejects unrelated mounts, labels, and network drift', () => {
  const mutations = [
    (model) => {
      model.services.tdarr.volumes.push({
        type: 'bind',
        source: 'C:\\unreviewed',
        target: '/etc/cont-init.d/00-unreviewed',
        read_only: false,
      });
    },
    (model) => {
      model.services.tdarr.labels['traefik.enable'] = 'true';
    },
    (model) => {
      model.networks.default = {
        name: 'external-proxy',
        external: true,
      };
    },
    (model) => {
      model.services.tdarr.volumes.push({
        type: 'bind',
        source: 'C:\\different-media',
        target: '/media/reviewed',
        read_only: true,
      });
    },
  ];
  for (const mutate of mutations) {
    const model = clone(goodModel());
    mutate(model);
    assert.throws(
      () => verifier.validateComposeModel(model, expected()),
      /SANITIZED_MODEL_MISMATCH|WATCHTOWER_NOT_DISABLED|TOP_LEVEL_NETWORK_INVALID/
    );
  }
});

test('tracked Compose example mounts the required external evidence volume', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'docker-compose.example.yml'),
    'utf8'
  );
  assert.match(
    source,
    /source:\s*tdarr-private-runtime\s+target:\s*\/private\/tdarr-runtime\s+read_only:\s*true/
  );
  assert.match(
    source,
    /tdarr-private-runtime:\s+name:\s*"\$\{TDARR_PRIVATE_RUNTIME_VOLUME:\?[^}]+\}"\s+external:\s*true/
  );
});

test('never includes resolved secret values in validation errors', () => {
  const model = clone(goodModel());
  model.services.tdarr.environment.apiKey = SECRET;
  model.services.tdarr.environment.seededApiKey = `${SECRET}_different`;
  let thrown;
  try {
    verifier.validateComposeModel(model, expected());
  } catch (error) {
    thrown = error;
  }
  assert(thrown);
  assert.equal(String(thrown).includes(SECRET), false);
  assert.equal(verifier.safeCode(thrown), 'API_KEYS_DIFFER');
  const rotated = clone(goodModel());
  rotated.services.tdarr.environment.apiKey =
    'tapi_rotated_private_test_key_1234567890';
  rotated.services.tdarr.environment.seededApiKey =
    rotated.services.tdarr.environment.apiKey;
  rotated.services.tdarr.environment.TDARR_TMDB_API_KEY =
    'private_metadata_key_value';
  assert.equal(
    verifier.sanitizedModelSha256(rotated),
    expected().sanitizedModelSha256
  );
});
