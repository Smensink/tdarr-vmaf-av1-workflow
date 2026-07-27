'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'win32') {
  console.log('SKIP CPU-v1 FIFO publication harness (run in a native Linux environment)');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vmaf-v1-scorer-publication-'));
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
const scorer = path.join(__dirname,
  'runtime/vmaf-v1/vmaf-v1-score.sh');

function shellPath(target) {
  const resolved = path.resolve(target);
  if (process.platform !== 'win32') return resolved;
  const match = resolved.match(/^([A-Za-z]):[\\/](.*)$/);
  assert(match, `cannot translate Windows path for WSL Bash: ${resolved}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

function executable(name, content) {
  const target = path.join(bin, name);
  fs.writeFileSync(target, content, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
  return target;
}

const fakeFfmpeg = executable('fake-ffmpeg', `#!/bin/sh
set -eu
progress=''
source=''
output=''
while [ "$#" -gt 0 ]; do
  output=$1
  case "$1" in
    -progress) progress=$2; shift 2 ;;
    -i) source=$2; shift 2 ;;
    *) shift ;;
  esac
done
frames=2
case "$source" in *short*) frames=1 ;; esac
printf 'frame=%s\\nprogress=end\\n' "$frames" > "$progress"
printf 'fake-y4m-%s\\n' "$source" > "$output"
`);

executable('vmaf-v1', `#!/bin/bash
set -eu
reference=''
distorted=''
output=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --reference) reference=$2; shift 2 ;;
    --distorted) distorted=$2; shift 2 ;;
    --output) output=$2; shift 2 ;;
    *) shift ;;
  esac
done
exec 3<"$reference"
exec 4<"$distorted"
while IFS= read -r _ <&3; do :; done
while IFS= read -r _ <&4; do :; done
[ "\${VMAF_FAKE_FAIL:-0}" != 1 ] || exit 42
printf '{"pooled_metrics":{"vmaf":{"mean":100}}}\\n' > "$output"
`);

// The scorer independently probes reference and candidate geometry and refuses
// to score mismatched rasters, so the harness needs a deterministic ffprobe.
const fakeFfprobe = executable('fake-ffprobe', `#!/bin/sh
set -eu
printf 'width=1920\\nheight=1080\\nsample_aspect_ratio=1:1\\ndisplay_aspect_ratio=16:9\\n'
`);

function input(name) {
  const file = path.join(root, name);
  fs.writeFileSync(file, name);
  return file;
}
const reference = input('reference.mkv');
const distorted = input('distorted.mkv');
const distortedShort = input('distorted-short.mkv');


function run(label, distortedPath, extraEnv = {}) {
  const output = path.join(root, `${label}.json`);
  const metadata = path.join(root, `${label}.transport.json`);
  const result = childProcess.spawnSync('bash', [
    shellPath(scorer),
    '--reference', shellPath(reference),
    '--distorted', shellPath(distortedPath),
    '--output', shellPath(output),
    '--metadata-output', shellPath(metadata),
    '--model', 'vmaf_v1.0.16',
    // Coded geometry, SAR/DAR and the normalization decision are required and
    // are echoed into the transport sidecar; the scorer never infers them.
    '--coded-width', '1920',
    '--coded-height', '1080',
    '--sample-aspect-ratio', '1:1',
    '--display-aspect-ratio', '16:9',
    '--geometry-normalization', 'none',
    '--ffmpeg', shellPath(fakeFfmpeg),
    '--ffprobe', shellPath(fakeFfprobe),
    '--threads', '4',
    '--subsample', '1',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      PATH: process.platform === 'win32'
        ? `${shellPath(bin)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
        : `${bin}${path.delimiter}${process.env.PATH}`,
    },
    timeout: 30000,
  });
  return { result, output, metadata };
}

try {
  const success = run('success', distorted);
  assert.strictEqual(success.result.status, 0, success.result.stderr);
  assert.strictEqual(fs.existsSync(success.output), true);
  assert.strictEqual(fs.existsSync(success.metadata), true);
  const transport = JSON.parse(fs.readFileSync(success.metadata, 'utf8'));
  assert.strictEqual(transport.referenceFrames, 2);
  assert.strictEqual(transport.distortedFrames, 2);
  assert.strictEqual(transport.pixelFormat, 'yuv420p10le');

  const mismatch = run('mismatch', distortedShort);
  assert.strictEqual(mismatch.result.status, 65, mismatch.result.stderr);
  assert.match(mismatch.result.stderr, /decoded frame-count mismatch/);
  assert.strictEqual(fs.existsSync(mismatch.output), false,
    'frame mismatch published final metric JSON');
  assert.strictEqual(fs.existsSync(mismatch.metadata), false,
    'frame mismatch published final transport JSON');

  const failedMetric = run('metric-failure', distorted, { VMAF_FAKE_FAIL: '1' });
  assert.strictEqual(failedMetric.result.status, 70, failedMetric.result.stderr);
  assert.strictEqual(fs.existsSync(failedMetric.output), false,
    'failed metric process published final metric JSON');
  assert.strictEqual(fs.existsSync(failedMetric.metadata), false,
    'failed metric process published final transport JSON');


  const refusal = {
    output: path.join(root, 'existing-output.json'),
    metadata: path.join(root, 'existing-output.transport.json'),
  };
  fs.writeFileSync(refusal.output, 'authority-must-not-be-overwritten');
  const refused = childProcess.spawnSync('bash', [
    shellPath(scorer),
    '--reference', shellPath(reference),
    '--distorted', shellPath(distorted),
    '--output', shellPath(refusal.output),
    '--metadata-output', shellPath(refusal.metadata),
    '--model', 'vmaf_v1.0.16',
    '--coded-width', '1920',
    '--coded-height', '1080',
    '--sample-aspect-ratio', '1:1',
    '--display-aspect-ratio', '16:9',
    '--geometry-normalization', 'none',
    '--ffmpeg', shellPath(fakeFfmpeg),
    '--ffprobe', shellPath(fakeFfprobe),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: process.platform === 'win32'
        ? `${shellPath(bin)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`
        : `${bin}${path.delimiter}${process.env.PATH}`,
    },
    timeout: 30000,
  });
  assert.strictEqual(refused.status, 73, refused.stderr);
  assert.strictEqual(fs.readFileSync(refusal.output, 'utf8'),
    'authority-must-not-be-overwritten');
  assert.strictEqual(fs.existsSync(refusal.metadata), false);

  console.log('PASS CPU-v1 scorer publishes only authenticated complete result pairs');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
