'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RELEASE_PAYLOAD = 'custom-cont-init.d/.vmaf-plugin-patches';

// These are semantic entry points, not a second inventory. Each selector must
// resolve to a regular file in the immutable release before it can be emitted.
const KEY_PATH_GROUPS = [
  {
    id: 'quality-policy-and-candidate-selection',
    heading: '### 1. Quality policy and candidate selection',
    selectors: [
      `${RELEASE_PAYLOAD}/_lib/feasibility.js`,
      `${RELEASE_PAYLOAD}/_lib/adaptiveFrameFloor.js`,
      `${RELEASE_PAYLOAD}/_lib/bindingCrossing.js`,
      `${RELEASE_PAYLOAD}/_lib/vmafMetricContract.js`,
      `${RELEASE_PAYLOAD}/_lib/pixelFormatContract.js`,
      `${RELEASE_PAYLOAD}/calculateVMAF/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/selectBestParameters/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/testEncodingParameters/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/checkCQRangeRetry/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/checkCQBracket/1.0.0/index.js`,
    ],
  },
  {
    id: 'delivery-policy-integrity-and-replacement',
    heading: '### 2. Delivery policy, full-file integrity, and replacement',
    selectors: [
      `${RELEASE_PAYLOAD}/_lib/deliveryPolicy.js`,
      `${RELEASE_PAYLOAD}/_lib/postEncodeCheckpoint.js`,
      `${RELEASE_PAYLOAD}/_lib/deliveryTransaction.js`,
      `${RELEASE_PAYLOAD}/_lib/deliveryFinalization.js`,
      `${RELEASE_PAYLOAD}/_lib/postReplaceAttestation.js`,
      `${RELEASE_PAYLOAD}/validateDeliveryCandidate/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/replaceOriginalFileAttested/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/finalizeDeliveredOutcome/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/cleanupTempFiles/1.0.0/index.js`,
    ],
  },
  {
    id: 'film-grain-analysis-and-synthesis',
    heading: '### 3. Film-grain analysis and direct synthesis',
    selectors: [
      `${RELEASE_PAYLOAD}/_lib/grainAnalysisArtifact.js`,
      `${RELEASE_PAYLOAD}/analyzeFilmGrain/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/synthesizeFilmGrain/1.0.0/index.js`,
      'custom-cont-init.d/98-install-grain-pipeline.sh',
    ],
  },
  {
    id: 'checkpoint-lifecycle-and-database-schema',
    heading: '### 4. Checkpoint lifecycle and database schema',
    selectors: [
      `${RELEASE_PAYLOAD}/_lib/vmafdb.js`,
      `${RELEASE_PAYLOAD}/_lib/postEncodeCheckpoint.js`,
      `${RELEASE_PAYLOAD}/_lib/deliveryTransaction.js`,
      `${RELEASE_PAYLOAD}/_lib/deliveryFinalization.js`,
      `${RELEASE_PAYLOAD}/_lib/postReplaceAttestation.js`,
      `${RELEASE_PAYLOAD}/cleanupTempFiles/1.0.0/index.js`,
    ],
  },
  {
    id: 'hevc-fallback-retained-but-disabled',
    heading: '### 5. HEVC fallback retained but disabled',
    selectors: [
      `${RELEASE_PAYLOAD}/activateHevcFallback/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/testEncodingParameters/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/checkCQRangeRetry/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/checkCQBracket/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/selectBestParameters/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/vmafOptimizedTranscode/1.0.0/index.js`,
      'build-scripts/rollback-av1-80-70-hevc-off.js',
      'configs/flow_YR5PZ1QaD_CANONICAL.json',
    ],
  },
  {
    id: 'gpu-lock-and-concurrency-scope',
    heading: '### 6. GPU lock and concurrency scope',
    selectors: [
      `${RELEASE_PAYLOAD}/_lib/gpuPipelineLock.js`,
      `${RELEASE_PAYLOAD}/_lib/gpuLockRun.js`,
      `${RELEASE_PAYLOAD}/_lib/pixelFormatContract.js`,
      `${RELEASE_PAYLOAD}/acquireGpuPipelineLock/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/releaseGpuPipelineLock/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/testEncodingParameters/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/calculateVMAF/1.0.0/index.js`,
      `${RELEASE_PAYLOAD}/vmafOptimizedTranscode/1.0.0/index.js`,
    ],
  },
  {
    id: 'deployment-startup-rollback-and-release-machinery',
    heading: '### 8. Deployment, startup protection, rollback, and release machinery',
    selectors: [
      'custom-cont-init.d/96-apply-vmaf-plugin-patches.sh',
      'custom-cont-init.d/96-apply-vmaf-nvenc-lock-scope.sh',
      'custom-cont-init.d/export-vmaf-flow-definition.js',
      'build-scripts/deploy-grain-flow-canary.js',
      'build-scripts/rollback-av1-80-70-hevc-off.js',
      'build-scripts/test-startup-canonical-protection.js',
      'build-scripts/verify-vmaf-deployment-parity.js',
      'build-scripts/assert-tdarr-quiescence.js',
      'build-scripts/set-tdarr-global-pause.js',
      'build-scripts/apply-tdarr-runtime-settings.js',
    ],
  },
];

function parseArguments(argv) {
  const options = {
    mode: 'check',
    handoff: path.resolve(__dirname, '..', 'review-handoffs',
      'CLAUDE_R34_CODE_REVIEW_HANDOFF.md'),
    releaseRoot: '',
    fileMap: '',
    skipFileMap: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check' || argument === '--write') {
      options.mode = argument.slice(2);
    } else if (argument === '--handoff' && argv[index + 1]) {
      options.handoff = path.resolve(argv[++index]);
    } else if (argument === '--release-root' && argv[index + 1]) {
      options.releaseRoot = path.resolve(argv[++index]);
    } else if (argument === '--file-map' && argv[index + 1]) {
      options.fileMap = path.resolve(argv[++index]);
    } else if (argument === '--skip-file-map') {
      options.skipFileMap = true;
    } else {
      throw new Error(`unsupported or incomplete argument: ${argument}`);
    }
  }
  return options;
}

function claimedReleaseRoot(handoffText) {
  const match = handoffText.match(/^- Immutable release: `([^`]+)`\s*$/m);
  if (!match) throw new Error('handoff does not declare an immutable release path');
  return path.resolve(match[1]);
}

function resolveReleaseFile(releaseRoot, releasePath) {
  if (!releasePath || path.posix.isAbsolute(releasePath) ||
      releasePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid release-relative key path: ${releasePath}`);
  }
  const root = path.resolve(releaseRoot);
  const candidate = path.resolve(root, ...releasePath.split('/'));
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!candidate.startsWith(prefix)) {
    throw new Error(`key path escapes the release root: ${releasePath}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`key path does not exist in the claimed release: ${releasePath}`);
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`key path is not a direct regular release file: ${releasePath}`);
  }
  return candidate;
}

function marker(group, edge) {
  return `<!-- ${edge} GENERATED KEY PATHS: ${group.id} -->`;
}

function generatedLines(group, releaseRoot) {
  const unique = new Set();
  const lines = [];
  for (const selector of group.selectors) {
    if (unique.has(selector)) throw new Error(`duplicate key-path selector: ${selector}`);
    unique.add(selector);
    resolveReleaseFile(releaseRoot, selector);
    lines.push(`- \`${selector}\``);
  }
  return [marker(group, 'BEGIN'), ...lines, marker(group, 'END')];
}

function replaceGroup(lines, group, releaseRoot) {
  const headingIndex = lines.indexOf(group.heading);
  if (headingIndex < 0) throw new Error(`handoff heading not found: ${group.heading}`);
  const nextHeadingIndex = lines.findIndex((line, index) =>
    index > headingIndex && line.startsWith('### '));
  const sectionEnd = nextHeadingIndex < 0 ? lines.length : nextHeadingIndex;
  const keyPathsIndex = lines.findIndex((line, index) =>
    index > headingIndex && index < sectionEnd && line === 'Key paths:');
  if (keyPathsIndex < 0) throw new Error(`Key paths block not found under: ${group.heading}`);

  const begin = marker(group, 'BEGIN');
  const end = marker(group, 'END');
  let replaceStart = lines.indexOf(begin, keyPathsIndex + 1);
  let replaceEnd;
  if (replaceStart >= 0 && replaceStart < sectionEnd) {
    replaceEnd = lines.indexOf(end, replaceStart + 1);
    if (replaceEnd < 0 || replaceEnd >= sectionEnd) {
      throw new Error(`generated key-path end marker not found for: ${group.heading}`);
    }
    replaceEnd += 1;
  } else {
    replaceStart = keyPathsIndex + 1;
    while (replaceStart < sectionEnd && lines[replaceStart] === '') replaceStart += 1;
    replaceEnd = replaceStart;
    while (replaceEnd < sectionEnd && /^- `[^`]+`$/.test(lines[replaceEnd])) replaceEnd += 1;
    if (replaceEnd === replaceStart) {
      throw new Error(`existing key-path bullets not found under: ${group.heading}`);
    }
  }

  lines.splice(replaceStart, replaceEnd - replaceStart,
    ...generatedLines(group, releaseRoot));
}

function generateHandoff(handoffText, releaseRoot) {
  const newline = handoffText.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = handoffText.endsWith('\n');
  const lines = handoffText.replace(/\r\n/g, '\n').split('\n');
  if (hadTrailingNewline) lines.pop();
  for (const group of KEY_PATH_GROUPS) replaceGroup(lines, group, releaseRoot);
  return `${lines.join(newline)}${hadTrailingNewline ? newline : ''}`;
}

function listedGeneratedPaths(handoffText) {
  const lines = handoffText.replace(/\r\n/g, '\n').split('\n');
  const listed = [];
  for (const group of KEY_PATH_GROUPS) {
    const beginIndex = lines.indexOf(marker(group, 'BEGIN'));
    const endIndex = lines.indexOf(marker(group, 'END'));
    if (beginIndex < 0 || endIndex <= beginIndex) {
      throw new Error(`generated key-path markers missing for: ${group.heading}`);
    }
    for (const line of lines.slice(beginIndex + 1, endIndex)) {
      const match = line.match(/^- `([^`]+)`$/);
      if (!match) throw new Error(`invalid generated key-path line: ${line}`);
      listed.push(match[1]);
    }
  }
  return listed;
}

function validateListedPaths(handoffText, releaseRoot) {
  const listed = listedGeneratedPaths(handoffText);
  for (const releasePath of listed) resolveReleaseFile(releaseRoot, releasePath);
  return listed.length;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function gitFile(repo, revision, repoPath) {
  const result = spawnSync('git', ['-C', repo, 'show', `${revision}:${repoPath}`], {
    encoding: null,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0) return result.stdout;
  const stderr = String(result.stderr || '');
  if (/does not exist in|exists on disk, but not in|Path .* does not exist/.test(stderr)) return null;
  throw new Error(`git show failed for ${repoPath}: ${stderr.trim()}`);
}

function verifyFileMap(fileMapPath, releaseRoot) {
  const fileMap = JSON.parse(fs.readFileSync(fileMapPath, 'utf8'));
  if (!/^[0-9a-f]{40}$/.test(String(fileMap.baseline_head || ''))) {
    throw new Error('file map baseline_head is not a full Git commit');
  }
  const repo = path.resolve(fileMap.repo || '');
  const revision = spawnSync('git', ['-C', repo, 'rev-parse',
    `${fileMap.baseline_head}^{commit}`], { encoding: 'utf8', windowsHide: true });
  if (revision.status !== 0 || revision.stdout.trim() !== fileMap.baseline_head) {
    throw new Error('file map baseline_head does not resolve exactly in its repository');
  }

  const counts = { same: 0, changed: 0, added: 0 };
  const problems = [];
  for (const [index, record] of fileMap.records.entries()) {
    let releaseFile;
    try {
      releaseFile = resolveReleaseFile(releaseRoot, record.release_path);
    } catch (error) {
      problems.push(`record ${index}: ${error.message}`);
      continue;
    }
    const releaseDigest = sha256(fs.readFileSync(releaseFile));
    if (releaseDigest !== record.release_sha256) {
      problems.push(`record ${index}: release SHA-256 mismatch for ${record.release_path}`);
    }
    const repoBytes = gitFile(repo, fileMap.baseline_head, record.repo_path);
    const repoDigest = repoBytes === null ? null : sha256(repoBytes);
    const actualStatus = repoBytes === null
      ? 'added'
      : (repoDigest === releaseDigest ? 'same' : 'changed');
    counts[actualStatus] += 1;
    if (repoDigest !== record.repo_sha256) {
      problems.push(`record ${index}: repository SHA-256 mismatch for ${record.repo_path}`);
    }
    if (actualStatus !== record.status) {
      problems.push(`record ${index}: status is ${record.status}, actual ${actualStatus}`);
    }
  }
  for (const status of Object.keys(counts)) {
    if (counts[status] !== fileMap.mapped_record_counts[status]) {
      problems.push(`mapped ${status} count is ${fileMap.mapped_record_counts[status]}, actual ${counts[status]}`);
    }
  }
  if (problems.length) {
    throw new Error(`file-map verification failed:\n${problems.slice(0, 20).join('\n')}`);
  }
  return counts;
}

function run(options) {
  const original = fs.readFileSync(options.handoff, 'utf8');
  const claimedRoot = claimedReleaseRoot(original);
  const releaseRoot = options.releaseRoot || claimedRoot;
  if (path.resolve(releaseRoot) !== claimedRoot) {
    throw new Error('--release-root does not match the immutable release claimed by the handoff');
  }
  const generated = generateHandoff(original, releaseRoot);

  if (options.mode === 'write') {
    if (generated !== original) fs.writeFileSync(options.handoff, generated, 'utf8');
  } else if (generated !== original) {
    throw new Error('handoff key-path sections are stale; run with --write to regenerate them');
  }

  const finalText = fs.readFileSync(options.handoff, 'utf8');
  const pathCount = validateListedPaths(finalText, releaseRoot);
  if (generateHandoff(finalText, releaseRoot) !== finalText) {
    throw new Error('handoff key-path regeneration is not idempotent');
  }
  console.log(`PASS ${pathCount} generated key paths resolve in ${releaseRoot}`);

  if (!options.skipFileMap) {
    const fileMapPath = options.fileMap || path.join(path.dirname(options.handoff),
      'r34-vs-git-head-file-map.json');
    const counts = verifyFileMap(fileMapPath, releaseRoot);
    console.log(`PASS file map reconciles: same=${counts.same} changed=${counts.changed} added=${counts.added}`);
  }
}

if (require.main === module) {
  try {
    run(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(`FAIL ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  KEY_PATH_GROUPS,
  claimedReleaseRoot,
  generateHandoff,
  listedGeneratedPaths,
  parseArguments,
  resolveReleaseFile,
  run,
  validateListedPaths,
  verifyFileMap,
};
