'use strict';

const assert = require('assert');
const fs = require('fs');
const { spawnSync } = require('child_process');
const test = require('/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf/vmafOptimizedTranscode/1.0.0/index.js')._test;

const output = `/temp/tdarr-hdr-roundtrip-${process.pid}.mkv`;
try {
  const encode = spawnSync('tdarr-ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'testsrc2=size=128x72:duration=1', '-c:v', 'ffv1', '-y', output], { encoding: 'utf8' });
  assert.strictEqual(encode.status, 0, encode.stderr || encode.stdout);
  const result = test.applyHdrColorMetadata(output, '', 'bt2020', 'smpte2084', 'bt2020nc',
    'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)',
    '1000,400', () => {});
  assert.strictEqual(result.ok, true, result.reason);
  console.log('PASS live Matroska HDR metadata apply/read-back');
} finally {
  try { fs.unlinkSync(output); } catch (_) {}
}
