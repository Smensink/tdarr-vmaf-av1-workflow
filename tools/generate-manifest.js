'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const flowPath = path.join(root, 'flow', 'tdarr-flow-vmaf-av1.json');
const initPath = path.join(root, 'custom-cont-init.d', '96-apply-vmaf-plugin-patches.sh');
const manifestPath = path.join(root, 'manifest.json');

function relative(filePath) {
  return path.relative(root, filePath).replaceAll(path.sep, '/');
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function matchingNames(source, expression) {
  return [...source.matchAll(expression)].map((match) => match[1]);
}

function listPlugins() {
  const pluginRoot = path.join(root, 'plugins');
  const plugins = [];
  for (const category of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryPath = path.join(pluginRoot, category.name);
    for (const plugin of fs.readdirSync(categoryPath, { withFileTypes: true })) {
      if (!plugin.isDirectory() || plugin.name === '_lib') continue;
      const versionPath = path.join(categoryPath, plugin.name, '1.0.0', 'index.js');
      if (!fs.existsSync(versionPath)) continue;
      plugins.push({
        name: plugin.name,
        category: category.name,
        version: '1.0.0',
        path: relative(versionPath),
        sha256: sha256(versionPath),
      });
    }
  }
  return plugins.sort((left, right) =>
    `${left.category}/${left.name}`.localeCompare(`${right.category}/${right.name}`));
}

function supportKind(name) {
  if (
    name === 'size_failure_shadow_hgb.json'
    || /\.(?:onnx|pt|pth|safetensors)$/i.test(name)
  ) {
    return 'models';
  }
  if (
    /(?:^test_|\.test\.|_testcases\.)/i.test(name)
  ) {
    return 'tests';
  }
  if (/^(?:ab_|backfill_|recover_)/i.test(name)) {
    return 'maintenance';
  }
  return 'modules';
}

function listHelperFiles(deployedHelpers) {
  const helperRoot = path.join(root, 'plugins', 'vmaf', '_lib');
  const files = fs.readdirSync(helperRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => !entry.name.match(/\.(?:bak|log)/i))
    .filter((entry) => entry.name !== 'size_failure_shadow_hgb.json')
    .map((entry) => {
      const filePath = path.join(helperRoot, entry.name);
      return {
        name: entry.name,
        path: relative(filePath),
        sha256: sha256(filePath),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const runtimeHelpers = files.filter((entry) => deployedHelpers.has(entry.name));
  const supportAssets = {
    models: [],
    tests: [],
    maintenance: [],
    modules: [],
  };
  for (const entry of files) {
    if (deployedHelpers.has(entry.name)) continue;
    supportAssets[supportKind(entry.name)].push(entry);
  }
  return { runtimeHelpers, supportAssets };
}

function main() {
  const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  const initSource = fs.readFileSync(initPath, 'utf8');
  const trackedLocalPlugins = new Set(
    flow.flowPlugins
      .filter((plugin) => plugin.sourceRepo === 'Local')
      .map((plugin) => plugin.pluginName),
  );
  const pinnedVmafPlugins = new Set(
    matchingNames(initSource, /apply_patch_file '([^']+)\/1\.0\.0'/g),
  );
  const pinnedFilterPlugins = new Set(
    matchingNames(initSource, /apply_filter_patch_file '([^']+)\/1\.0\.0'/g),
  );
  const pinnedToolsPlugins = new Set(
    matchingNames(initSource, /apply_tools_patch_file '([^']+)\/1\.0\.0'/g),
  );
  const deployedHelpers = new Set(
    matchingNames(initSource, /apply_shared_lib_file '([^']+)'/g),
  );
  const helperFiles = listHelperFiles(deployedHelpers);

  const plugins = listPlugins().map((plugin) => ({
    ...plugin,
    activeInTrackedFlow: trackedLocalPlugins.has(plugin.name),
    pinnedAtContainerStart:
      (plugin.category === 'vmaf' && pinnedVmafPlugins.has(plugin.name))
      || (plugin.category === 'filter' && pinnedFilterPlugins.has(plugin.name))
      || (plugin.category === 'tools' && pinnedToolsPlugins.has(plugin.name)),
  }));
  const manifest = {
    schema: 'tdarr-vmaf-av1-manifest/v4',
    generatedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: {
      type: 'tracked redacted flow plus checkout-parity-verified deployment payloads',
      flowId: flow._id,
      flowName: flow.name,
      flowNodes: flow.flowPlugins.length,
      flowEdges: flow.flowEdges.length,
    },
    privacy: {
      rawTdarrDatabaseIncluded: false,
      rawLearningDatabaseIncluded: false,
      publicLearningSnapshot: 'data/public/vmaf-learning-public.sqlite3',
      policy: 'Aggregate-only database and redacted flow configuration.',
    },
    plugins,
    runtimeHelpers: helperFiles.runtimeHelpers,
    supportAssets: helperFiles.supportAssets,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `wrote ${relative(manifestPath)}: ${plugins.length} plugins, `
      + `${manifest.runtimeHelpers.length} runtime helpers, `
      + `${Object.values(manifest.supportAssets).flat().length} support assets`,
  );
}

main();
