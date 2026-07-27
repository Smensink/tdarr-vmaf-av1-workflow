'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const initPath = path.join(
  root,
  'custom-cont-init.d',
  '96-apply-vmaf-plugin-patches.sh',
);

function sha256(filePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function matches(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]);
}

function assertPair(left, right, errors) {
  const leftRelative = path.relative(root, left).replaceAll(path.sep, '/');
  const rightRelative = path.relative(root, right).replaceAll(path.sep, '/');
  if (!fs.existsSync(left)) {
    errors.push(`missing review source: ${leftRelative}`);
    return;
  }
  if (!fs.existsSync(right)) {
    errors.push(`missing deployment mirror: ${rightRelative}`);
    return;
  }
  if (sha256(left) !== sha256(right)) {
    errors.push(`content drift: ${leftRelative} != ${rightRelative}`);
  }
}

function main() {
  const source = fs.readFileSync(initPath, 'utf8');
  const errors = [];
  let compared = 0;

  const pluginGroups = [
    {
      names: matches(source, /apply_patch_file '([^']+\/1\.0\.0)'/g),
      reviewRoot: path.join(root, 'plugins', 'vmaf'),
      mirrorRoot: path.join(root, 'custom-cont-init.d', 'vmaf-plugin-patches'),
    },
    {
      names: matches(source, /apply_filter_patch_file '([^']+\/1\.0\.0)'/g),
      reviewRoot: path.join(root, 'plugins', 'filter'),
      mirrorRoot: path.join(root, 'custom-cont-init.d', 'filter-plugin-patches'),
    },
    {
      names: matches(source, /apply_tools_patch_file '([^']+\/1\.0\.0)'/g),
      reviewRoot: path.join(root, 'plugins', 'tools'),
      mirrorRoot: path.join(root, 'custom-cont-init.d', 'tools-plugin-patches'),
    },
  ];

  for (const group of pluginGroups) {
    for (const relative of group.names) {
      assertPair(
        path.join(group.reviewRoot, relative, 'index.js'),
        path.join(group.mirrorRoot, relative, 'index.js'),
        errors,
      );
      compared += 1;
    }
  }

  const helpers = matches(source, /apply_shared_lib_file '([^']+)'/g);
  for (const helper of helpers) {
    assertPair(
      path.join(root, 'plugins', 'vmaf', '_lib', helper),
      path.join(
        root,
        'custom-cont-init.d',
        'vmaf-plugin-patches',
        '_lib',
        helper,
      ),
      errors,
    );
    compared += 1;
  }

  if (errors.length > 0) {
    console.error(`source parity failed with ${errors.length} error(s):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`source parity passed: ${compared} pinned files`);
}

main();
