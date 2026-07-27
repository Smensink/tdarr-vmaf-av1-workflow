'use strict';

// Regression: 2026-07-21 adaptive VMAF frame-subsampling safety rails.
//  - checkCQBracket.chooseWinnerFullRateConfirmation: a converged winner measured at n>1 with
//    no reserved holdout must be scheduled for one full-rate re-measure; every guard (kill
//    switch, holdout, per-CQ once, total cap, unstamped legacy rows) must hold.
//  - checkCQBracket.chooseRefinementSubsample: n>1 refinement only with three-stage enabled
//    AND a reserved holdout.
//  - calculateVMAF.parseXpsnrStderr: XPSNR shadow stderr parsing incl. inf channels.

const assert = require('assert');

const bracket = require('./custom-cont-init.d/vmaf-plugin-patches/checkCQBracket/1.0.0/index.js')._test;
const calc = require('./custom-cont-init.d/vmaf-plugin-patches/calculateVMAF/1.0.0/index.js')._test;

function agg(cq, sub) {
  const entry = { parameterSet: { quality: cq } };
  if (sub !== undefined) entry.measurementSubsample = sub;
  return entry;
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS [' + name + ']');
}

// ── chooseWinnerFullRateConfirmation ──
check('n=4 winner, no holdout -> confirm at winner CQ', () => {
  const out = bracket.chooseWinnerFullRateConfirmation([agg(30, 4), agg(33, 4)], [30, 33], {});
  assert.strictEqual(out, 33);
});

check('winner is MAX feasible even when listed first', () => {
  const out = bracket.chooseWinnerFullRateConfirmation([agg(35, 4), agg(30, 4)], [35, 30], {});
  assert.strictEqual(out, 35);
});

check('holdout reserved -> no confirmation (holdout validates at n=1)', () => {
  const out = bracket.chooseWinnerFullRateConfirmation([agg(33, 4)], [33], { vmafHoldoutSample: { path: '/x' } });
  assert.strictEqual(out, null);
});

check('kill switch vmafWinnerFullRate=false -> null', () => {
  const out = bracket.chooseWinnerFullRateConfirmation([agg(33, 4)], [33], { vmafWinnerFullRate: false });
  assert.strictEqual(out, null);
});

check('winner already measured at n=1 -> null', () => {
  const out = bracket.chooseWinnerFullRateConfirmation([agg(33, 1)], [33], {});
  assert.strictEqual(out, null);
});

check('legacy row without measurementSubsample stamp -> treated as n=1, null', () => {
  const out = bracket.chooseWinnerFullRateConfirmation([agg(33)], [33], {});
  assert.strictEqual(out, null);
});

check('per-CQ once: already-confirmed winner CQ -> null', () => {
  const vars = { vmafWinnerFullRateConfirmed: { '33.0': true } };
  const out = bracket.chooseWinnerFullRateConfirmation([agg(33, 4)], [33], vars);
  assert.strictEqual(out, null);
});

check('different CQ than the confirmed one -> still confirms', () => {
  const vars = { vmafWinnerFullRateConfirmed: { '33.0': true } };
  const out = bracket.chooseWinnerFullRateConfirmation([agg(32.5, 4)], [32.5], vars);
  assert.strictEqual(out, 32.5);
});

check('total cap 3 -> null even for a new CQ', () => {
  const vars = { vmafWinnerFullRateConfirmed: { '30.0': true, '31.0': true, '32.0': true } };
  const out = bracket.chooseWinnerFullRateConfirmation([agg(33, 4)], [33], vars);
  assert.strictEqual(out, null);
});

check('no feasible CQs -> null', () => {
  const out = bracket.chooseWinnerFullRateConfirmation([agg(33, 4)], [], {});
  assert.strictEqual(out, null);
});

check('winner CQ missing from aggregated -> null (nothing to judge)', () => {
  const out = bracket.chooseWinnerFullRateConfirmation([agg(30, 4)], [33], {});
  assert.strictEqual(out, null);
});

check('fractional CQ keying: 32.1 at n=4 confirms with .1-precision key', () => {
  const out = bracket.chooseWinnerFullRateConfirmation([agg(32.1, 4)], [32.1], {});
  assert.strictEqual(out, 32.1);
});

// ── chooseRefinementSubsample ──
function refineArgs(enabled, holdout, requested) {
  return {
    inputs: { threeStageVmaf: enabled, intermediateVmafSubsample: requested },
    variables: holdout ? { vmafHoldoutSample: { path: '/x' } } : {},
  };
}

check('three-stage off -> refinement stays n=1', () => {
  assert.strictEqual(bracket.chooseRefinementSubsample(refineArgs(false, true, 2)), 1);
});

check('three-stage on but NO holdout -> refinement stays n=1', () => {
  assert.strictEqual(bracket.chooseRefinementSubsample(refineArgs(true, false, 2)), 1);
});

check('three-stage on with holdout -> n=2', () => {
  assert.strictEqual(bracket.chooseRefinementSubsample(refineArgs(true, true, 2)), 2);
});

check('requested subsample clamps to [2,4]', () => {
  assert.strictEqual(bracket.chooseRefinementSubsample(refineArgs(true, true, 9)), 4);
  assert.strictEqual(bracket.chooseRefinementSubsample(refineArgs(true, true, 0)), 2);
});

// ── parseXpsnrStderr ──
check('typical xpsnr summary parses', () => {
  const out = calc.parseXpsnrStderr('[Parsed_xpsnr_0 @ 0x7a31] XPSNR  y: 28.8841  u: 28.3575  v: 28.7533  (minimum: 28.3575)');
  assert.ok(out);
  assert.strictEqual(out.y, 28.8841);
  assert.strictEqual(out.u, 28.3575);
  assert.strictEqual(out.v, 28.7533);
  assert.strictEqual(out.min, 28.3575);
});

check('inf channels parse (identical planes)', () => {
  const out = calc.parseXpsnrStderr('XPSNR  y: inf  u: inf  v: inf');
  assert.ok(out);
  assert.strictEqual(out.y, Infinity);
  assert.strictEqual(out.min, Infinity);
});

check('mixed finite/inf takes finite minimum', () => {
  const out = calc.parseXpsnrStderr('XPSNR  y: 41.2  u: inf  v: 39.9');
  assert.ok(out);
  assert.strictEqual(out.min, 39.9);
});

check('garbage stderr -> null', () => {
  assert.strictEqual(calc.parseXpsnrStderr('frame= 12 fps=3.4 speed=0.1x'), null);
  assert.strictEqual(calc.parseXpsnrStderr(''), null);
  assert.strictEqual(calc.parseXpsnrStderr(null), null);
});

console.log('\nPASS adaptive-subsample safety rails (' + passed + ' cases)');
