'use strict';

// Regression contract for the 2026-07-21 rejectionReasons.js centralisation:
// checkCQRangeRetry's size-terminal detection was migrated from an inline OR-of-.indexOf()
// chain (reconstructed below exactly as it read before the migration, see
// checkCQRangeRetry/1.0.0/index.js.bak-rejectionreasons-20260721 lines 738-740) to the new
// shared custom-cont-init.d/vmaf-plugin-patches/_lib/rejectionReasons.js helper. This is a
// pure refactor: for every input, the old inline check and the new helper must agree.

const assert = require('assert');

const rejectionReasons = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/rejectionReasons.js');

// OLD logic, reconstructed verbatim from the pre-migration inline check:
//   if (_minRejReason.indexOf('insufficient size benefit') !== -1
//       || _minRejReason.indexOf('emergency cutoff') !== -1
//       || _minRejReason.indexOf('legacy cap') !== -1) { sizeBenefitTerminal = true; }
function oldInlineIsSizeTerminalReason(_minRejReason) {
  return _minRejReason.indexOf('insufficient size benefit') !== -1
    || _minRejReason.indexOf('emergency cutoff') !== -1
    || _minRejReason.indexOf('legacy cap') !== -1;
}

const cases = [
  // Retired pre-2026-07-20 wording.
  {
    label: 'retired insufficient-size-benefit wording',
    reason: 'Projected output 91.2% of source (>= 90% cap) - insufficient size benefit to justify a lossy re-encode',
    expected: true
  },
  // Demoted-gate era emergency-cutoff wording (2026-07-20+).
  {
    label: 'demoted-gate emergency-cutoff wording',
    reason: 'Projected output 120.8% of source (>= 110% emergency cutoff) - even worst-case projection error cannot make this a beneficial re-encode',
    expected: true
  },
  // Demoted-gate era legacy-cap wording (2026-07-20+, budget exhausted).
  {
    label: 'demoted-gate legacy-cap wording',
    reason: 'Projected output 92.4% of source (>= 90% legacy cap) - forced-full label budget exhausted (12/12), legacy gate in effect',
    expected: true
  },
  // Unrelated rejection reasons that must NOT be treated as size-terminal.
  {
    label: 'unrelated: shared feasibility rejection',
    reason: 'Shared feasibility: harmonic VMAF 88.10 below threshold 90',
    expected: false
  },
  {
    label: 'unrelated: CAMBI banding rejection',
    reason: 'CAMBI banding risk 6.20 above floor 5.5 (lower is better; ~6 starts annoying)',
    expected: false
  },
  {
    label: 'unrelated: too-small projected output rejection',
    reason: 'Projected output too small for 4k HDR movie tier',
    expected: false
  },
  {
    label: 'empty string',
    reason: '',
    expected: false
  }
];

let failures = 0;
for (const testCase of cases) {
  const oldResult = oldInlineIsSizeTerminalReason(testCase.reason);
  const newResult = rejectionReasons.isSizeTerminalReason(testCase.reason);
  try {
    assert.strictEqual(oldResult, testCase.expected,
      `[${testCase.label}] OLD logic expected ${testCase.expected}, got ${oldResult}`);
    assert.strictEqual(newResult, testCase.expected,
      `[${testCase.label}] NEW helper expected ${testCase.expected}, got ${newResult}`);
    assert.strictEqual(oldResult, newResult,
      `[${testCase.label}] OLD/NEW disagree: old=${oldResult} new=${newResult}`);
    console.log(`PASS [${testCase.label}]: old=${oldResult} new=${newResult}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${error.message}`);
  }
}

// Non-string / nullish inputs: the new helper must be at least as safe as the old inline
// check (which required a caller to have already done String(reason || '')).
assert.strictEqual(rejectionReasons.isSizeTerminalReason(null), false, 'null must not throw and must be false');
assert.strictEqual(rejectionReasons.isSizeTerminalReason(undefined), false, 'undefined must not throw and must be false');
console.log('PASS [null/undefined safety]');

if (failures > 0) {
  console.error(`\n${failures} case(s) FAILED`);
  process.exit(1);
}
console.log(`\nPASS all ${cases.length} cases: OLD inline logic and NEW rejectionReasons.isSizeTerminalReason() agree`);
