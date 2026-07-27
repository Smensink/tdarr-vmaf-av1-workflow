'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const verify = fs.readFileSync('build-scripts/verify-grain-toolchain.sh', 'utf8');
const installer = fs.readFileSync('custom-cont-init.d/98-install-grain-pipeline.sh', 'utf8');
const gravInstaller = fs.readFileSync('custom-cont-init.d/98-install-grav1synth.sh', 'utf8');
const gravRebuild = fs.readFileSync('build-scripts/rebuild-grav1synth.sh', 'utf8');
const gravRegression = fs.readFileSync(
  'build-scripts/test-grav1synth-nvenc-sequence-header.sh', 'utf8');
const startup = fs.readFileSync('custom-cont-init.d/99-verify-grain-toolchain.sh', 'utf8');
const healthcheck = fs.readFileSync('build-scripts/healthcheck-grain-toolchain.sh', 'utf8');
const compose = fs.readFileSync('docker-compose.example.yml', 'utf8');

function capture(text, expression, description) {
  const match = text.match(expression);
  assert(match, `missing ${description}`);
  return match[1];
}

const installerRelease = capture(installer, /^RELEASE_ID="([^"]+)"$/m,
  'installer grain release pin');
const installerSha = capture(installer, /^EXPECTED_SHA256="([0-9a-f]{64})"$/m,
  'installer grain SHA-256 pin');
const verifyRelease = capture(verify, /^EXPECTED_PIPELINE_RELEASE="([^"]+)"$/m,
  'preflight grain release pin');
const verifySha = capture(verify, /^EXPECTED_PIPELINE_SHA256="([0-9a-f]{64})"$/m,
  'preflight grain SHA-256 pin');
const verifyReal = capture(verify, /^EXPECTED_PIPELINE_REAL="([^"]+)"$/m,
  'preflight immutable release path');
const pipelineName = capture(installer, /^PIPELINE_NAME="([^"]+)"$/m,
  'installer grain pipeline artifact name');

assert.strictEqual(verifyRelease, installerRelease,
  'installer and preflight grain release pins diverged');
assert.strictEqual(verifySha, installerSha,
  'installer and preflight grain checksum pins diverged');
assert.strictEqual(verifyReal,
  `/opt/grain-pipeline/releases/${installerRelease}-${installerSha.slice(0, 12)}/${pipelineName}`,
  'preflight immutable release path does not match its release/checksum pins');

const artifactDir = path.join('custom-grain-pipeline', 'releases', installerRelease);
const artifactPath = path.join(artifactDir, pipelineName);
const provenancePath = path.join(artifactDir, 'PROVENANCE.txt');
const sumsPath = path.join(artifactDir, 'SHA256SUMS');
for (const required of [artifactPath, provenancePath, sumsPath]) {
  assert(fs.statSync(required).isFile(), `missing pinned release artifact ${required}`);
}
const artifactSha = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
assert.strictEqual(artifactSha, installerSha,
  'pinned release artifact does not match installer/preflight checksum');
const provenance = fs.readFileSync(provenancePath, 'utf8').split(/\r?\n/);
assert(provenance.includes(`release_id=${installerRelease}`),
  'release provenance has the wrong release ID');
assert(provenance.includes(`sha256=${installerSha}`),
  'release provenance has the wrong checksum');
const sums = fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/).filter(Boolean);
assert.deepStrictEqual(sums, [`${installerSha}  ${pipelineName}`],
  'release checksum manifest is not the exact pinned artifact');
assert.match(installer, /sha256sum --check --strict SHA256SUMS/,
  'installer does not strictly validate the release checksum manifest');
assert.match(installer, /chmod 0555 "\$STAGE_DIR"/,
  'installer can publish a root-only mktemp release directory');
assert.match(installer, /chmod 0555 "\$INSTALL_RELEASE"/,
  'installer does not repair permissions on a reused release directory');
assert.match(installer, /INSTALL_RELEASE_MODE.*== "555"/s,
  'installer does not verify the published release directory mode');

const gravInstallerCommit = capture(gravInstaller,
  /^EXPECTED_COMMIT="([0-9a-f]{40})"$/m, 'grav1synth installer commit pin');
const gravInstallerPatch = capture(gravInstaller,
  /^EXPECTED_PATCH="([^"]+)"$/m, 'grav1synth installer patch name');
const gravInstallerPatchSha = capture(gravInstaller,
  /^EXPECTED_PATCH_SHA256="([0-9a-f]{64})"$/m, 'grav1synth installer patch pin');
const gravInstallerFixtureSha = capture(gravInstaller,
  /^EXPECTED_NVENC_FIXTURE_SHA256="([0-9a-f]{64})"$/m,
  'grav1synth installer decoded fixture pin');
const gravInstallerSha = capture(gravInstaller,
  /^EXPECTED_SHA256="([0-9a-f]{64})"$/m, 'grav1synth installer binary pin');
const gravVerifyCommit = capture(verify,
  /^EXPECTED_GRAV1SYNTH_COMMIT="([0-9a-f]{40})"$/m, 'grav1synth preflight commit pin');
const gravVerifyPatchSha = capture(verify,
  /^EXPECTED_GRAV1SYNTH_PATCH_SHA256="([0-9a-f]{64})"$/m,
  'grav1synth preflight patch pin');
const gravVerifyFixtureSha = capture(verify,
  /^EXPECTED_GRAV1SYNTH_NVENC_FIXTURE_SHA256="([0-9a-f]{64})"$/m,
  'grav1synth preflight decoded fixture pin');
const gravVerifySha = capture(verify,
  /^EXPECTED_GRAV1SYNTH_SHA256="([0-9a-f]{64})"$/m, 'grav1synth preflight binary pin');
const gravRebuildCommit = capture(gravRebuild,
  /^GRAV1SYNTH_COMMIT="([0-9a-f]{40})"$/m, 'grav1synth rebuild commit pin');
const gravRebuildPatchSha = capture(gravRebuild,
  /^PATCH_SHA256="([0-9a-f]{64})"$/m, 'grav1synth rebuild patch pin');
const gravRebuildFixtureSha = capture(gravRebuild,
  /^NVENC_FIXTURE_SHA256="([0-9a-f]{64})"$/m, 'grav1synth rebuild fixture pin');
const gravRegressionFixtureSha = capture(gravRegression,
  /^EXPECTED_INPUT_SHA256="([0-9a-f]{64})"$/m, 'grav1synth regression fixture pin');

assert.strictEqual(gravInstallerCommit, gravRebuildCommit,
  'grav1synth installer/rebuild commit pins diverged');
assert.strictEqual(gravInstallerCommit, gravVerifyCommit,
  'grav1synth installer/preflight commit pins diverged');
assert.strictEqual(gravInstallerPatchSha, gravRebuildPatchSha,
  'grav1synth installer/rebuild patch pins diverged');
assert.strictEqual(gravInstallerPatchSha, gravVerifyPatchSha,
  'grav1synth installer/preflight patch pins diverged');
assert.strictEqual(gravInstallerFixtureSha, gravRebuildFixtureSha,
  'grav1synth installer/rebuild fixture pins diverged');
assert.strictEqual(gravInstallerFixtureSha, gravVerifyFixtureSha,
  'grav1synth installer/preflight fixture pins diverged');
assert.strictEqual(gravInstallerFixtureSha, gravRegressionFixtureSha,
  'grav1synth installer/regression fixture pins diverged');
assert.strictEqual(gravInstallerSha, gravVerifySha,
  'grav1synth installer/preflight binary pins diverged');

const gravBinaryPath = path.join('custom-grav1synth', 'bin', 'grav1synth');
const gravProvenancePath = path.join('custom-grav1synth', 'PROVENANCE.txt');
const gravSumsPath = path.join('custom-grav1synth', 'SHA256SUMS');
const gravPatchPath = path.join('build-scripts', 'patches', gravInstallerPatch);
const gravFixturePath = path.join(
  'build-scripts', 'fixtures', 'grav1synth-nvenc-hdr.ivf.b64');
for (const required of [gravProvenancePath, gravSumsPath, gravPatchPath, gravFixturePath]) {
  assert(fs.statSync(required).isFile(), `missing grav1synth contract artifact ${required}`);
}
function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
if (fs.existsSync(gravBinaryPath)) {
  assert.strictEqual(fileSha256(gravBinaryPath), gravInstallerSha,
    'local grav1synth binary does not match installer/preflight pin');
}
assert.strictEqual(fileSha256(gravPatchPath), gravInstallerPatchSha,
  'grav1synth source patch does not match installer/rebuild pin');
const decodedFixture = Buffer.from(
  fs.readFileSync(gravFixturePath, 'utf8').replace(/\s+/g, ''), 'base64');
assert.strictEqual(crypto.createHash('sha256').update(decodedFixture).digest('hex'),
  gravInstallerFixtureSha, 'decoded NVENC fixture does not match its pin');

const gravProvenance = fs.readFileSync(gravProvenancePath, 'utf8')
  .split(/\r?\n/).filter(Boolean);
for (const expected of [
  `git_commit=${gravInstallerCommit}`,
  `patch=${gravInstallerPatch}`,
  `patch_sha256=${gravInstallerPatchSha}`,
  `nvenc_fixture_sha256=${gravInstallerFixtureSha}`,
  `sha256=${gravInstallerSha}`,
]) {
  assert.strictEqual(gravProvenance.filter((line) => line === expected).length, 1,
    `grav1synth provenance must contain exactly one ${expected}`);
}
assert.deepStrictEqual(
  fs.readFileSync(gravSumsPath, 'utf8').split(/\r?\n/).filter(Boolean),
  [`${gravInstallerSha}  bin/grav1synth`],
  'grav1synth checksum manifest is not the exact pinned binary');
assert.match(gravInstaller, /sha256sum --check --strict SHA256SUMS/,
  'grav1synth installer does not strictly validate SHA256SUMS');
assert.match(verify,
  /runuser -u "\$RUNTIME_USER" -- env GRAV1SYNTH_REGRESSION_QUIET=1[\s\\]+bash "\$GRAV1SYNTH_NVENC_REGRESSION" "\$GRAV1SYNTH" "\$FFMPEG"/,
  'grain preflight does not execute the NVENC regression as the runtime user');
assert.match(compose,
  /\.\/custom-grav1synth:\/opt\/grav1synth-artifact:ro/,
  'Compose does not mount the grav1synth artifact read-only');
assert.match(compose, /\.\/build-scripts:\/usr\/local\/build-scripts:ro/,
  'Compose does not mount build scripts read-only');
assert.match(compose,
  /test:\s*\["CMD",\s*"bash",\s*"-c",\s*"exec 3<>\/dev\/tcp\/127\.0\.0\.1\/8266"\]/,
  'Compose healthcheck must remain a cheap TCP liveness probe');
assert.match(compose, /Run build-scripts\/verify-grain-toolchain\.sh[\s\S]*queue is idle/,
  'Compose must direct operators to the idle-time grain qualification');

assert.match(verify, /grep -Fq -- "--vpp-knn"/,
  'grain preflight does not require the selected NVEncC CUDA KNN filter');
assert.match(verify, /NVEncC 8-bit\/10-bit KNN smoke test failed/,
  'grain preflight does not exercise both supported native KNN bit depths');
assert.match(verify, /mkvmerge is required for lossless Matroska ancillary preservation/,
  'grain preflight does not require MKVToolNix for ancillary FFmpeg bypass');
assert.match(verify, /"\$MKVMERGE" --version/,
  'grain preflight does not execute an MKVToolNix version probe');
assert.match(verify, /RUNTIME_USER="\$\{TDARR_RUNTIME_USER:-abc\}"/,
  'grain preflight is not pinned to the Tdarr runtime user');
assert.match(verify, /runuser -u "\$RUNTIME_USER" -- stat "\$PIPELINE"/,
  'grain preflight does not verify runtime-user path traversal');
assert.match(verify, /runuser -u "\$RUNTIME_USER" -- python3 "\$PIPELINE" --help/,
  'grain preflight does not execute the pipeline as the runtime user');
assert.match(verify, /runuser -u "\$RUNTIME_USER" -- "\$GRAV1SYNTH" --version/,
  'grain preflight does not execute grav1synth as the runtime user');
assert.match(verify, /-c:v ffv1 -level 3/,
  'grain preflight does not perform an FFV1 encode');
assert.match(verify, /stream=codec_name/,
  'grain preflight does not verify that the intermediate codec is FFV1');
assert.match(verify, /FFV1 self-test round trip was not lossless/,
  'grain preflight does not compare pre/post FFV1 decoded pixels');
assert.match(verify, /mktemp -d/,
  'grain preflight does not isolate media self-test artifacts');
assert.match(verify, /refusing unsafe scratch cleanup/,
  'grain preflight scratch cleanup lacks a path guard');
assert.ok(startup.includes('/usr/local/build-scripts/verify-grain-toolchain.sh'),
  'container startup does not enforce the extended grain preflight');
assert.ok(healthcheck.includes('/usr/local/build-scripts/verify-grain-toolchain.sh'),
  'container healthcheck does not enforce the extended grain preflight');

console.log('PASS grain toolchain media self-test contract');
