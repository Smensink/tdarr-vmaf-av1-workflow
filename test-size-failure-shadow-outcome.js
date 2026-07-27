'use strict';

const assert = require('assert');
const shadow = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/sizeFailureShadow.js');

assert.strictEqual(shadow.labelOutcome({ size_target_status: 'failed' }), 1);
assert.strictEqual(shadow.labelOutcome({ skip_reason: 'live_size_guard_exceeded' }), 1);
assert.strictEqual(shadow.labelOutcome({ final_output_ratio_pct: 91 }), 1);
assert.strictEqual(shadow.labelOutcome({ size_target_status: 'met', final_output_ratio_pct: 70 }), 0);
assert.strictEqual(shadow.labelOutcome({ final_output_ratio_pct: 90 }), 0);
assert.strictEqual(shadow.labelOutcome({ size_target_status: 'failed', final_output_ratio_pct: 70 }), 1,
  'positive evidence wins over an otherwise negative ratio');
assert.strictEqual(shadow.labelOutcome({ size_target_status: 'unknown' }), null);
assert.strictEqual(shadow.labelOutcome({}), null);

console.log('PASS size-failure shadow terminal label contract');
