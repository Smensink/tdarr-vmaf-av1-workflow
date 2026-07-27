'use strict';
const assert = require('assert');
const policy = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafV1Policy.js');

const sdr = policy.resolve({ isHdr: false });
assert.strictEqual(sdr.cambiBaseLimit, 5.5);
assert.strictEqual(sdr.cambiEffectiveLimit, 5.5);
assert.strictEqual(sdr.contentClass, 'sdr');
assert.strictEqual(sdr.productionEligible, false);
assert.strictEqual(sdr.vmafScoreMaximum, 110);
assert.strictEqual(sdr.authoritativeHoldoutSubsample, 1);

const hdr = policy.resolve({ isHdr: true });
assert.strictEqual(hdr.cambiBaseLimit, 5.0);
assert.strictEqual(hdr.contentClass, 'hdr-pq');
assert.notStrictEqual(hdr.policyVersion, '');

const animation = policy.resolve({ isHdr: true, isAnimation: true });
assert.strictEqual(animation.cambiBaseLimit, 6.0);

const relaxed = policy.resolve({ isHdr: true, sourceCambi: 5.7 });
assert.strictEqual(relaxed.cambiEffectiveLimit, 6.0);
const capped = policy.resolve({ isHdr: false, sourceCambi: 99 });
assert.strictEqual(capped.cambiEffectiveLimit, 6.5);
assert.throws(() => policy.resolve({}), /explicit isHdr/);

console.log('PASS provisional native-10-bit VMAF-v1 SDR/HDR calibration policy');
