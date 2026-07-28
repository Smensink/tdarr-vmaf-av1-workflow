'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const coordinator = require('./custom-nvencc/libexec/tdarr-nvencc-knn-ffmpeg.js');

const running = { exitCode: null, signalCode: null };
const exited = { exitCode: 0, signalCode: null };

assert.strictEqual(coordinator.childIsRunning(running), true);
assert.strictEqual(coordinator.childIsRunning(exited), false);

assert.strictEqual(
  coordinator.shouldStopPeerAfterExit('FFmpeg', { code: 0, error: null }, true),
  true,
  'an early successful FFmpeg exit must still terminate the live producer'
);
assert.strictEqual(
  coordinator.shouldStopPeerAfterExit('FFmpeg', { code: 1, error: null }, true),
  true
);
assert.strictEqual(
  coordinator.shouldStopPeerAfterExit('NVEncC', { code: 0, error: null }, true),
  false,
  'FFmpeg must be allowed to drain after a successful producer exit'
);
assert.strictEqual(
  coordinator.shouldStopPeerAfterExit('NVEncC', { code: 1, error: null }, true),
  true
);
assert.strictEqual(
  coordinator.shouldStopPeerAfterExit('NVEncC', { code: 0, error: null }, false),
  false
);

async function runLinuxIntegration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvencc-coordinator-supervision-'));
  const producer = path.join(root, 'fake-nvencc');
  const consumer = path.join(root, 'fake-ffmpeg');
  const source = path.join(root, 'source.mkv');
  const producerLog = path.join(root, 'producer.log');
  const producerPid = path.join(root, 'producer.pid');
  const producerTerminated = path.join(root, 'producer.terminated');

  fs.writeFileSync(source, 'synthetic coordinator fixture\n');
  fs.writeFileSync(producer, `#!/bin/sh
set -eu
printf '%s\\n' "$$" > "$FAKE_PRODUCER_PID"
trap 'printf terminated > "$FAKE_PRODUCER_TERMINATED"; exit 143' TERM INT
elapsed=0
while [ "$elapsed" -lt 8 ]; do
  sleep 1
  elapsed=$((elapsed + 1))
done
printf self-timeout > "$FAKE_PRODUCER_TERMINATED"
exit 124
`, { mode: 0o755 });
  fs.writeFileSync(consumer, `#!/bin/sh
exit 0
`, { mode: 0o755 });
  fs.chmodSync(producer, 0o755);
  fs.chmodSync(consumer, 0o755);

  const previousPidPath = process.env.FAKE_PRODUCER_PID;
  const previousTerminatedPath = process.env.FAKE_PRODUCER_TERMINATED;
  process.env.FAKE_PRODUCER_PID = producerPid;
  process.env.FAKE_PRODUCER_TERMINATED = producerTerminated;
  try {
    const parsed = coordinator.validate(coordinator.parseArgs([
      '--nvencc', producer,
      '--source', source,
      '--output-depth', '10',
      '--producer-log', producerLog,
      '--ffmpeg', consumer,
      '--',
      '-i', 'pipe:0',
      '-f', 'null',
      '-',
    ]));
    await assert.rejects(
      coordinator.run(parsed),
      /NVEncC exited with code 143/,
      'an early successful consumer exit must fail after terminating its producer'
    );
    assert.strictEqual(fs.readFileSync(producerTerminated, 'utf8'), 'terminated');
    const pid = Number(fs.readFileSync(producerPid, 'utf8').trim());
    assert(Number.isSafeInteger(pid) && pid > 1, 'fake producer did not publish a valid PID');
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error && error.code === 'ESRCH',
      'fake producer survived coordinator completion'
    );
  } finally {
    if (previousPidPath === undefined) delete process.env.FAKE_PRODUCER_PID;
    else process.env.FAKE_PRODUCER_PID = previousPidPath;
    if (previousTerminatedPath === undefined) {
      delete process.env.FAKE_PRODUCER_TERMINATED;
    } else {
      process.env.FAKE_PRODUCER_TERMINATED = previousTerminatedPath;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform === 'win32') {
    console.log(
      'SKIP NVEncC coordinator process supervision integration (run in native Linux)'
    );
  } else {
    await runLinuxIntegration();
  }
  console.log('PASS NVEncC coordinator terminates a producer orphaned by early FFmpeg exit');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
