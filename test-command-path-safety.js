'use strict';

const assert = require('assert');
const fs = require('fs');

const extract = require('./plugins/vmaf/extractVideoSamples/1.0.0/index.js')._test;
const calculate = require('./plugins/vmaf/calculateVMAF/1.0.0/index.js')._test;
const select = require('./plugins/vmaf/selectBestParameters/1.0.0/index.js')._test;

const hostileInput = '/media/Film name; touch SHOULD_NOT_EXIST $(id) & "quoted".mkv';
const hostileOutput = 'C:\\Tdarr Cache\\out & del important ^ $(whoami).mkv';
const hostileExecutable = '/opt/Tdarr Tools/ffmpeg;not-a-command';
const hostilePaths = [
  hostileInput,
  hostileOutput,
  '/media/-leading-option `backtick` and\nnewline.mkv',
];

function assertLiteralArg(argv, expected, label) {
  assert.ok(Array.isArray(argv), `${label}: expected argv array`);
  assert.strictEqual(argv.filter((arg) => arg === expected).length, 1,
    `${label}: path must survive as one exact argv element`);
}

const extractArgs = extract.buildSampleExtractionArgs(
  hostileInput, hostileOutput, 12.345, 8, '0:v:0'
);
assertLiteralArg(extractArgs, hostileInput, 'sample extraction input');
assertLiteralArg(extractArgs, hostileOutput, 'sample extraction output');
assert.deepStrictEqual(extractArgs.slice(0, 4), ['-ss', '12.35', '-i', hostileInput]);

const featureArgs = extract.buildFeatureExtractionArgs(hostileInput,
  '[0:v]metadata=print:file=/tmp/feature values.txt[o1]');
assertLiteralArg(featureArgs, hostileInput, 'feature input');

const gpuCommand = calculate.buildGpuVmafCommand(
  hostileExecutable, hostileOutput, hostileInput, '/tmp/vmaf result.json', '',
  {}, true, 'av1_nvenc', 1
);
assert.strictEqual(gpuCommand.executable, hostileExecutable);
assertLiteralArg(gpuCommand.args, hostileOutput, 'GPU VMAF distorted input');
assertLiteralArg(gpuCommand.args, hostileInput, 'GPU VMAF reference input');
assert.ok(!gpuCommand.args.some((arg) => /^["'].*["']$/.test(arg)),
  'argv values must not carry shell quoting');

const holdoutArgs = select.buildHoldoutVmafArgs({
  distortedPath: hostileOutput,
  referencePath: hostileInput,
  scoringPixelFormat: 'yuv420p',
  filterName: 'libvmaf_cuda',
  logPath: '/tmp/holdout.json',
  modelPath: '',
});
assertLiteralArg(holdoutArgs, hostileOutput, 'holdout distorted input');
assertLiteralArg(holdoutArgs, hostileInput, 'holdout reference input');

const xpsnrArgs = select.buildXpsnrArgs(hostileOutput, hostileInput);
assertLiteralArg(xpsnrArgs, hostileOutput, 'XPSNR distorted input');
assertLiteralArg(xpsnrArgs, hostileInput, 'XPSNR reference input');

for (const hostilePath of hostilePaths) {
  assertLiteralArg(
    extract.buildSampleExtractionArgs(hostilePath, '/tmp/literal-output.mkv', 1, 2, '0:v:0'),
    hostilePath,
    'metacharacter sample input'
  );
  assertLiteralArg(
    calculate.buildGpuVmafCommand(
      hostileExecutable, hostilePath, '/media/reference.mkv', '/tmp/vmaf.json',
      '', {}, true, 'av1_nvenc', 1
    ).args,
    hostilePath,
    'metacharacter VMAF input'
  );
  assertLiteralArg(
    select.buildXpsnrArgs(hostilePath, '/media/reference.mkv'),
    hostilePath,
    'metacharacter XPSNR input'
  );
}

for (const relativePath of [
  'plugins/vmaf/extractVideoSamples/1.0.0/index.js',
  'custom-cont-init.d/vmaf-plugin-patches/extractVideoSamples/1.0.0/index.js',
  'plugins/vmaf/calculateVMAF/1.0.0/index.js',
  'custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js',
  'plugins/vmaf/selectBestParameters/1.0.0/index.js',
  'custom-cont-init.d/vmaf-plugin-patches/selectBestParameters/1.0.0/index.js',
  'plugins/vmaf/detectGPUEncoder/1.0.0/index.js',
  'custom-cont-init.d/vmaf-plugin-patches/detectGPUEncoder/1.0.0/index.js',
]) {
  const source = fs.readFileSync(relativePath, 'utf8');
  assert.ok(!/require\(['"]child_process['"]\)\.execSync/.test(source),
    `${relativePath}: child_process.execSync remains`);
  assert.ok(!/shell\s*:\s*(?:true|['"](?:\/bin\/sh|cmd(?:\.exe)?)['"])/i.test(source),
    `${relativePath}: shell execution remains`);
  assert.ok(!/execFileSync\(\s*['"]\/bin\/sh['"]\s*,\s*\[\s*['"]-c['"]/.test(source),
    `${relativePath}: /bin/sh -c remains`);
}

console.log('PASS command paths remain literal argv values with no shell boundary');
