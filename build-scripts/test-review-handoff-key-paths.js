'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const generator = require('./generate-review-handoff-key-paths.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-r34-handoff-paths-'));
const releaseRoot = path.join(root, 'release-r34-fixture');
const handoffPath = path.join(root, 'CLAUDE_R34_CODE_REVIEW_HANDOFF.md');

try {
  for (const group of generator.KEY_PATH_GROUPS) {
    for (const releasePath of group.selectors) {
      const target = path.join(releaseRoot, ...releasePath.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${releasePath}\n`);
    }
  }

  const sections = generator.KEY_PATH_GROUPS.map((group) => [
    group.heading,
    '',
    'Key paths:',
    '',
    '- `fictional/old-path.js`',
    '',
    'Section narrative.',
  ].join('\n'));
  const initial = [
    '# Fixture handoff',
    '',
    `- Immutable release: \`${releaseRoot}\``,
    '',
    ...sections,
    '',
  ].join('\n');
  fs.writeFileSync(handoffPath, initial);

  const generated = generator.generateHandoff(initial, releaseRoot);
  fs.writeFileSync(handoffPath, generated);
  assert.strictEqual(generator.generateHandoff(generated, releaseRoot), generated,
    'generation must be idempotent');

  const expectedCount = generator.KEY_PATH_GROUPS.reduce(
    (total, group) => total + group.selectors.length, 0);
  assert.strictEqual(generator.validateListedPaths(generated, releaseRoot), expectedCount);
  assert(!generated.includes('fictional/old-path.js'),
    'generation must replace the hand-written path list');
  assert(generator.listedGeneratedPaths(generated).every((releasePath) =>
    !releasePath.includes('*') && !path.isAbsolute(releasePath)),
  'generated paths must be concrete and release-relative');

  const cliPass = spawnSync(process.execPath, [
    path.join(__dirname, 'generate-review-handoff-key-paths.js'),
    '--check',
    '--handoff', handoffPath,
    '--skip-file-map',
  ], { encoding: 'utf8' });
  assert.strictEqual(cliPass.status, 0, cliPass.stderr || cliPass.stdout);
  assert.match(cliPass.stdout, new RegExp(`PASS ${expectedCount} generated key paths resolve`));

  const removedPath = generator.KEY_PATH_GROUPS[0].selectors[0];
  fs.unlinkSync(path.join(releaseRoot, ...removedPath.split('/')));
  assert.throws(() => generator.validateListedPaths(generated, releaseRoot),
    /does not exist in the claimed release/,
    'checker must fail when a listed release path disappears');
  const cliFail = spawnSync(process.execPath, [
    path.join(__dirname, 'generate-review-handoff-key-paths.js'),
    '--check',
    '--handoff', handoffPath,
    '--skip-file-map',
  ], { encoding: 'utf8' });
  assert.notStrictEqual(cliFail.status, 0,
    'CLI checker must fail when a listed release path is absent');
  assert.match(cliFail.stderr, /does not exist in the claimed release/);

  console.log(`PASS review-handoff key-path generator/checker (${expectedCount} paths)`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
