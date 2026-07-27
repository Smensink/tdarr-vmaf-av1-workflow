'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'custom-cont-init.d');
const scripts = fs.readdirSync(root)
  .filter((name) => name.endsWith('.js'))
  .sort();

assert(scripts.length > 0, 'expected top-level Node maintenance utilities');
for (const name of scripts) {
  const filePath = path.join(root, name);
  const source = fs.readFileSync(filePath, 'utf8');
  assert(source.startsWith("#!/bin/sh\n':' //; exit 0\n'use strict';"),
    `${name} lacks the shell-neutral, Node-compatible prologue`);

  const nodeCheck = childProcess.spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
  });
  assert.strictEqual(nodeCheck.status, 0,
    `${name} is not valid Node syntax: ${nodeCheck.stderr || nodeCheck.stdout}`);

  const shellPath = path.posix.join('custom-cont-init.d', name);
  const shellRun = childProcess.spawnSync('bash', [shellPath], {
    encoding: 'utf8',
    // Windows launches Bash through WSL, whose cold start can exceed five seconds.
    timeout: process.platform === 'win32' ? 30000 : 5000,
  });
  assert.strictEqual(shellRun.status, 0,
    `${name} did not neutralize under bash: ${shellRun.stderr || shellRun.stdout}`);
  assert.strictEqual(shellRun.stdout, '', `${name} emitted output under the init shell runner`);
  assert.strictEqual(shellRun.stderr, '', `${name} emitted errors under the init shell runner`);
}

console.log(`PASS ${scripts.length} top-level Node utilities are inert under the custom-init shell runner`);
