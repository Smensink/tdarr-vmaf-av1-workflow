'use strict';

const POLICY_VERSION = 'vmaf-v1-native10-sdr-hdr-calibration-v1';
const THRESHOLDS = Object.freeze({
  sdr: 5.5,
  hdr: 5.0,
  animation: 6.0,
  sourceRelativeRelaxation: 1.0,
  maximumRelaxation: 1.0,
});

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resolve(options) {
  options = options || {};
  if (typeof options.isHdr !== 'boolean') throw new TypeError('v1 policy requires explicit isHdr');
  const contentClass = options.isHdr ? 'hdr-pq' : 'sdr';
  const base = options.isAnimation ? THRESHOLDS.animation
    : (options.isHdr ? THRESHOLDS.hdr : THRESHOLDS.sdr);
  const source = finiteOrNull(options.sourceCambi);
  const effective = source === null ? base
    : Math.max(base, Math.min(base + THRESHOLDS.maximumRelaxation,
      source + THRESHOLDS.sourceRelativeRelaxation));
  return Object.freeze({
    policyVersion: POLICY_VERSION,
    calibrationStatus: 'provisional-requires-real-content-corpus',
    productionEligible: false,
    contentClass,
    isAnimation: options.isAnimation === true,
    cambiBaseLimit: base,
    cambiEffectiveLimit: effective,
    sourceCambi: source,
    sourceRelativeRelaxation: THRESHOLDS.sourceRelativeRelaxation,
    vmafTarget: finiteOrNull(options.vmafTarget) || 95,
    frameFloor: finiteOrNull(options.frameFloor),
    vmafScoreMinimum: 0,
    vmafScoreMaximum: 110,
    authoritativeHoldoutSubsample: 1,
    inferenceAuthorityContractId: 'paired-cq-vmaf-v1-cambi-inference-authority-v1',
  });
}

module.exports = { POLICY_VERSION, THRESHOLDS, resolve };
