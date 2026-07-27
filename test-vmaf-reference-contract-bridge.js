'use strict';

const assert = require('assert');
const predictor = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/vmafpredict.js');
const bridge = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/referenceContractBridge.js');
const canonical = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/canonicalDenoise.js');
const nvenc = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/nvencTemporalFilter.js');
const nvenccKnn = require('./custom-cont-init.d/vmaf-plugin-patches/_lib/nvenccKnn.js');
const parameterTesting = require('./custom-cont-init.d/vmaf-plugin-patches/testEncodingParameters/1.0.0/index.js')._test;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`PASS ${name}`);
}

function legacyRows(nowIso) {
  const rows = [];
  // Uncalibrated legacy rows carry only 0.18 contract reliability. Twenty-four
  // otherwise-perfect jobs still clear the absolute support floor of three.
  for (let job = 0; job < 24; job += 1) {
    [[24, 98], [28, 96], [32, 94], [36, 92]].forEach(([cq, score]) => {
      rows.push({
        job_id: `legacy-${job}`,
        reference_contract_id: canonical.LEGACY_REFERENCE_CONTRACT_ID,
        timestamp: nowIso,
        cq,
        vmaf_harmonic_mean: score,
        vmaf_mean: score + 0.1,
        vmaf_min: score - 1,
        vmaf_max: score + 1,
        bits_per_pixel: 0.08,
        source_codec: 'hevc',
        media_is_animation: 0,
        is_hdr: 0,
      });
    });
  }
  return rows;
}

function attestLegacyRows(rows, profileId = nvenc.REFERENCE_COMPARISON_ENCODER_PROFILE_ID) {
  return rows.map((row) => Object.assign({}, row, {
    reference_comparison_encoder_profile_id: profileId,
  }));
}

function calibrationObservations(options = {}) {
  const rows = [];
  const sourceCount = options.sourceCount || 5;
  const deltas = options.deltas || Array(sourceCount).fill(0.8);
  for (let sourceIndex = 0; sourceIndex < sourceCount; sourceIndex += 1) {
    [28, 34, 40].forEach((cq) => {
      const legacyVmaf = 105 - 0.4 * cq;
      rows.push({
        attested_pair: options.attested === false ? false : true,
        comparison_id: `paired-canary-${sourceIndex}`,
        source_fingerprint: `sha256:${String(sourceIndex).padStart(64, '0')}`,
        encoder_key: options.encoderProfileId ||
          nvenc.REFERENCE_COMPARISON_ENCODER_PROFILE_ID,
        legacy_reference_contract_id: canonical.LEGACY_REFERENCE_CONTRACT_ID,
        canonical_reference_contract_id: canonical.REFERENCE_CONTRACT_ID,
        cq,
        legacy_vmaf: legacyVmaf,
        canonical_vmaf: legacyVmaf + deltas[sourceIndex],
        tier: options.tier || '1080p',
        is_hdr: options.isHdr == null ? 0 : options.isHdr,
        source_codec: options.sourceCodec || 'hevc',
        media_is_animation: options.isAnimation == null ? 0 : options.isAnimation,
      });
    });
  }
  return rows;
}

const nowMs = Date.parse('2026-07-22T00:00:00Z');
const nowIso = new Date(nowMs).toISOString();
const source = {
  tier: '1080p', bits_per_pixel: 0.08, source_codec: 'hevc',
  media_is_animation: 0, is_hdr: 0,
  encoder_profile_id: nvenc.REFERENCE_COMPARISON_ENCODER_PROFILE_ID,
};

test('primary VMAF matches the live harmonic acceptance metric', () => {
  assert.strictEqual(predictor.primaryVmaf({
    vmaf_harmonic_mean: 94.5, vmaf_mean: 95.2, vmaf_min: 90, vmaf_max: 99,
  }), 94.5);
  assert.strictEqual(predictor.primaryVmaf({ vmaf_mean: 95.2 }), 95.2);
  assert.strictEqual(predictor.primaryVmaf({
    vmaf_harmonic_mean: 3.2, vmaf_mean: 69.7, vmaf_min: 49.8, vmaf_max: 97.6,
  }), 69.7, 'impossible backfilled harmonic value must fall back to arithmetic');
});

test('lookback fields have unambiguous and separate meanings', () => {
  const resolved = bridge.resolveLookback({ maxAgeDays: 30, recencyHalfLifeDays: 0 });
  assert.strictEqual(resolved.maxAgeDays, 30);
  assert.strictEqual(resolved.recencyHalfLifeDays, 0, 'zero half-life disables decay, not lookback');
  assert.strictEqual(bridge.filterRowsByLookback(legacyRows(nowIso), {
    maxAgeDays: 0, recencyHalfLifeDays: 120, nowMs,
  }).length, 0, 'zero hard lookback disables legacy guidance');
  const weight = predictor.weightForPoint(source, legacyRows(new Date(nowMs - 120 * 86400000).toISOString())[0], {
    recencyHalfLifeDays: 120, nowMs,
  });
  assert(Math.abs(weight - 0.5) < 1e-9, `120-day-old row should have half weight, got ${weight}`);
});

test('legacy bridge enforces a hard HDR/SDR cohort boundary', () => {
  const mixed = legacyRows(nowIso);
  mixed.slice(0, 20).forEach((row) => { row.is_hdr = 1; });
  const matched = bridge.filterRowsByHardSourceMatch(mixed, source);
  assert.strictEqual(matched.length, mixed.length - 20);
  assert(matched.every((row) => row.is_hdr === 0));
  assert.strictEqual(bridge.filterRowsByHardSourceMatch(mixed, { is_hdr: null }).length, 0);
});

test('legacy bridge rejects rows from any other reference contract', () => {
  const mixed = legacyRows(nowIso);
  mixed.slice(0, 8).forEach((row) => {
    row.reference_contract_id = canonical.REFERENCE_CONTRACT_ID;
  });
  const matched = bridge.filterLegacyContractRows(mixed);
  assert.strictEqual(matched.length, mixed.length - 8);
  assert(matched.every((row) => row.reference_contract_id === canonical.LEGACY_REFERENCE_CONTRACT_ID));
});

test('absolute weight rejects many uniformly irrelevant jobs despite high Kish ESS', () => {
  const irrelevant = legacyRows(nowIso);
  // Far enough away to make every job nearly irrelevant, but not so far that
  // IEEE-754 underflow turns the weights into exact zero (which would also make
  // Kish ESS zero and fail to reproduce the scale-invariance hazard).
  irrelevant.forEach((row) => { row.bits_per_pixel = 0.2; });
  const summary = bridge.jobSupportSummary(irrelevant, source,
    { recencyHalfLifeDays: 120 }, { nowMs });
  assert(summary.effectiveJobs >= 9.9, 'uniform tiny weights retain a deceptively high Kish ESS');
  assert(summary.totalWeight < bridge.DEFAULT_MIN_TOTAL_JOB_WEIGHT,
    'absolute similarity mass must expose that the cohort is irrelevant');
  const seed = bridge.buildSeed(irrelevant, source, 95, { nowMs });
  assert.strictEqual(seed.action, 'broad_fresh_sweep');
  assert.strictEqual(seed.reason, 'insufficient_absolute_similarity_weight');
  assert.strictEqual(seed.provenance.minTotalSimilarityWeight, 3);
});

test('uncalibrated legacy history remains usable only as weak high-uncertainty planning evidence', () => {
  const seed = bridge.buildSeed(legacyRows(nowIso), source, 95, { nowMs });
  assert.strictEqual(seed.action, 'schedule_fresh_seed_probes');
  assert(seed.centerCq >= 28 && seed.centerCq <= 32);
  assert.strictEqual(seed.provenance.adapter.mode, 'neutral_high_uncertainty_prior');
  assert.strictEqual(seed.adapterDeltaCq, 0);
  assert(seed.adapterUncertaintyCq >= bridge.DEFAULT_PRIOR_UNCERTAINTY_CQ);
  assert.strictEqual(seed.legacyEvidenceWeight, bridge.DEFAULT_UNCALIBRATED_WEIGHT);
  assert(seed.rangeMax - seed.rangeMin >= 8, 'uncalibrated probe bracket must be deliberately wide');
  assert.strictEqual(seed.provenance.role, 'probe_planning_only');
  assert.strictEqual(seed.provenance.acceptanceAuthority, 'fresh-current-contract-measurements-only');
  assert.strictEqual(seed.provenance.finalCqReuseAndOutcomeAuthority, false);
  ['passed', 'feasible', 'selectedCq', 'meetsTarget', 'reuse', 'outcome'].forEach((key) => {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(seed, key), false);
  });
});

test('contract reliability is an explicit fail-closed predictor weight', () => {
  const row = legacyRows(nowIso)[0];
  const base = predictor.weightForPoint(source, row, { recencyHalfLifeDays: 0, nowMs });
  const quarter = predictor.weightForPoint(source,
    Object.assign({}, row, { reference_contract_weight: 0.25 }),
    { recencyHalfLifeDays: 0, nowMs });
  assert(Math.abs(quarter - base * 0.25) < 1e-12);
  assert.strictEqual(predictor.weightForPoint(source,
    Object.assign({}, row, { reference_contract_weight: 1.01 }), {}), 0);
  assert.strictEqual(predictor.weightForPoint(source,
    Object.assign({}, row, { reference_contract_weight: Number.NaN }), {}), 0);
});

test('planning clones discard legacy acceptance, CAMBI, size, and outcome evidence', () => {
  const row = Object.assign({}, legacyRows(nowIso)[0], {
    vmaf_p1_low: 99, cambi_mean: 0.1, cambi_p95: 0.2, avg_size_mb: 1,
    selected_cq: 50, transcode_succeeded: 1, met_vmaf_target: 1,
  });
  const adapter = bridge.buildCqAdapter(null, source, 30, {});
  const clean = bridge.sanitizeLegacyRows([row], adapter)[0];
  assert.strictEqual(clean.vmaf_harmonic_mean, row.vmaf_harmonic_mean);
  for (const key of ['vmaf_p1_low', 'cambi_mean', 'cambi_p95', 'avg_size_mb',
    'selected_cq', 'transcode_succeeded', 'met_vmaf_target']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(clean, key), false, `${key} leaked`);
  }
  assert.strictEqual(clean.reference_contract_weight, bridge.DEFAULT_UNCALIBRATED_WEIGHT);
});

test('a file-path coincidence is never treated as a calibration pair', () => {
  const unattested = calibrationObservations({ attested: false }).map((row) =>
    Object.assign({ file_path: '/media/replaced-in-place.mkv' }, row));
  const adapter = bridge.buildCqAdapter(unattested, source, 30, {});
  assert.strictEqual(adapter.mode, 'neutral_high_uncertainty_prior');
  assert.strictEqual(adapter.deltaCq, 0);
  assert.strictEqual(adapter.reason, 'no_attested_calibration');
});

test('calibration requires exact CQ and a coherent encoder comparison profile', () => {
  const wrongCq = calibrationObservations().map((row) =>
    Object.assign({}, row, { canonical_cq: row.cq + 1 }));
  assert.strictEqual(bridge.buildCqAdapter(wrongCq, source, 30, {}).deltaCq, 0,
    'nearby-but-different CQ measurements are not paired observations');

  const mixedEncoder = calibrationObservations().map((row) =>
    Object.assign({}, row, { encoder_key: `profile-for-cq-${row.cq}` }));
  const adapter = bridge.buildCqAdapter(mixedEncoder, source, 30, {});
  assert.strictEqual(adapter.deltaCq, 0);
  assert.strictEqual(adapter.evidenceSources, 0,
    'points from different encoder profiles must not form a slope');

  const wrongContract = calibrationObservations().map((row) => Object.assign({}, row, {
    canonical_reference_contract_id: canonical.LEGACY_REFERENCE_CONTRACT_ID,
  }));
  assert.strictEqual(bridge.buildCqAdapter(wrongContract, source, 30, {}).deltaCq, 0,
    'mislabelled signal contracts must not train an adapter');

  const coherentWrongEncoder = bridge.buildCqAdapter(
    calibrationObservations({ encoderProfileId: 'coherent-but-wrong-profile' }),
    source, 30, {});
  assert.strictEqual(coherentWrongEncoder.mode, 'neutral_high_uncertainty_prior');
  assert.strictEqual(coherentWrongEncoder.supportSources, 0);
  assert.strictEqual(coherentWrongEncoder.deltaCq, 0,
    'a coherent but different encoder profile must never move probes');

  const missingExpected = Object.assign({}, source);
  delete missingExpected.encoder_profile_id;
  const missingExpectedAdapter = bridge.buildCqAdapter(
    calibrationObservations(), missingExpected, 30, {});
  assert.strictEqual(missingExpectedAdapter.mode, 'neutral_high_uncertainty_prior');
  assert.strictEqual(missingExpectedAdapter.supportSources, 0);
  assert.strictEqual(missingExpectedAdapter.deltaCq, 0);
});

test('reference comparison profile requires exact enhanced p7 canonical NVENC flags', () => {
  const options = {
    codec: 'av1_nvenc',
    presets: ['p7'],
    policy: nvenc.CANONICAL_POLICY,
    qualityFlags: nvenc.ENHANCED_QUALITY_FLAGS_CANONICAL,
  };
  assert.strictEqual(nvenc.referenceComparisonEncoderProfileId(options),
    nvenc.REFERENCE_COMPARISON_ENCODER_PROFILE_ID);
  assert.strictEqual(nvenc.referenceComparisonEncoderProfileId(Object.assign({}, options, {
    qualityFlags: `${nvenc.ENHANCED_QUALITY_FLAGS_CANONICAL} -tf_level 0`,
  })), nvenc.REFERENCE_COMPARISON_ENCODER_PROFILE_ID);
  for (const mutation of [
    { codec: 'libsvtav1' },
    { presets: ['p6'] },
    { presets: ['p7', 'p6'] },
    { policy: nvenc.LEGACY_POLICY, qualityFlags: nvenc.ENHANCED_QUALITY_FLAGS_LEGACY },
    { qualityFlags: nvenc.BASELINE_QUALITY_FLAGS_CANONICAL },
  ]) {
    assert.strictEqual(nvenc.referenceComparisonEncoderProfileId(
      Object.assign({}, options, mutation)), null);
  }
});

test('attested comparable canaries learn a shrunk CQ-domain correction', () => {
  const adapter = bridge.buildCqAdapter(calibrationObservations(), source, 30, {});
  assert.strictEqual(adapter.mode, 'learned_attested_cq_adapter');
  assert.strictEqual(adapter.supportSources, 5);
  assert.strictEqual(adapter.supportPoints, 15);
  // delta VMAF +0.8 / slope -0.4 => raw +2 CQ. Five-source shrinkage
  // is 5/(5+4), so production applies only about +1.11 CQ.
  assert(Math.abs(adapter.rawDeltaCq - 2) < 1e-9);
  assert(Math.abs(adapter.deltaCq - 10 / 9) < 1e-9);
  assert(adapter.uncertaintyCq >= 0.75);
  assert(adapter.legacyWeight > bridge.DEFAULT_UNCALIBRATED_WEIGHT);
  assert(adapter.legacyWeight <= 0.65);
});

test('duplicates cannot inflate attested source or point support', () => {
  const observations = calibrationObservations();
  const adapter = bridge.buildCqAdapter(observations.concat(observations), source, 30, {});
  assert.strictEqual(adapter.supportSources, 5);
  assert.strictEqual(adapter.supportPoints, 15);
});

test('mismatched or sparse canaries may widen uncertainty but cannot move the seed', () => {
  const hdrMismatch = bridge.buildCqAdapter(
    calibrationObservations({ isHdr: 1 }), source, 30, {});
  assert.strictEqual(hdrMismatch.mode, 'neutral_high_uncertainty_prior');
  assert.strictEqual(hdrMismatch.supportSources, 0);
  assert.strictEqual(hdrMismatch.deltaCq, 0);
  assert(hdrMismatch.evidenceSources > 0);

  const sparse = bridge.buildCqAdapter(
    calibrationObservations({ sourceCount: 2 }), source, 30, {});
  assert.strictEqual(sparse.mode, 'neutral_high_uncertainty_prior');
  assert.strictEqual(sparse.supportSources, 2);
  assert.strictEqual(sparse.deltaCq, 0);
});

test('noisy calibration increases uncertainty and reduces legacy weight', () => {
  const clean = bridge.buildCqAdapter(calibrationObservations(), source, 30, {});
  const noisy = bridge.buildCqAdapter(calibrationObservations({
    deltas: [-0.8, 0, 0.8, 1.6, 2.4],
  }), source, 30, {});
  assert(noisy.uncertaintyCq > clean.uncertaintyCq);
  assert(noisy.legacyWeight < clean.legacyWeight);
});

test('an implausibly large learned correction fails back to the neutral prior', () => {
  const adapter = bridge.buildCqAdapter(calibrationObservations({
    deltas: [2.4, 2.4, 2.4, 2.4, 2.4],
  }), source, 30, {});
  assert.strictEqual(adapter.mode, 'neutral_high_uncertainty_prior');
  assert.strictEqual(adapter.reason, 'attested_adapter_shift_out_of_bounds');
  assert.strictEqual(adapter.deltaCq, 0);
  assert(adapter.uncertaintyCq >= bridge.DEFAULT_PRIOR_UNCERTAINTY_CQ);
});

test('learned adapter shifts only an explicitly row-profile-attested fresh-probe schedule', () => {
  const seed = bridge.buildSeed(attestLegacyRows(legacyRows(nowIso)), source, 95, {
    nowMs, calibrationObservations: calibrationObservations(),
  });
  assert.strictEqual(seed.action, 'schedule_fresh_seed_probes');
  assert(seed.centerCq >= 30 && seed.centerCq <= 32);
  assert(seed.adapterDeltaCq > 1 && seed.adapterDeltaCq < 1.2);
  assert.strictEqual(seed.provenance.adapter.mode, 'learned_attested_cq_adapter');
  assert.strictEqual(seed.provenance.calibrationPairing,
    'explicit-attested-pairs-only; never-file-path-join');
  assert.strictEqual(seed.provenance.legacySizeCambiAndFrameFloorIgnored, true);
  assert.strictEqual(seed.provenance.adapter.legacyRowProfileAttestation.eligible, true);
});

test('a multisource calibration artifact cannot shift unprofiled historical rows', () => {
  const seed = bridge.buildSeed(legacyRows(nowIso), source, 95, {
    nowMs, calibrationObservations: calibrationObservations(),
  });
  assert.strictEqual(seed.action, 'schedule_fresh_seed_probes');
  assert.strictEqual(seed.adapterDeltaCq, 0);
  assert.strictEqual(seed.legacyEvidenceWeight, bridge.DEFAULT_UNCALIBRATED_WEIGHT);
  assert(seed.adapterUncertaintyCq >= bridge.DEFAULT_PRIOR_UNCERTAINTY_CQ);
  assert.strictEqual(seed.provenance.adapter.mode, 'neutral_high_uncertainty_prior');
  assert.strictEqual(seed.provenance.adapter.reason, 'legacy_row_profile_unattested_or_mixed');
  assert.strictEqual(seed.provenance.adapter.legacyRowProfileAttestation.eligible, false);
  assert.strictEqual(seed.provenance.adapter.legacyRowProfileAttestation.unprofiledRows,
    legacyRows(nowIso).length);
});

test('one unprofiled or wrong-profile row makes a legacy cohort neutral', () => {
  const mixed = attestLegacyRows(legacyRows(nowIso));
  delete mixed[0].reference_comparison_encoder_profile_id;
  mixed[1].reference_comparison_encoder_profile_id = 'different-comparison-profile';
  const seed = bridge.buildSeed(mixed, source, 95, {
    nowMs, calibrationObservations: calibrationObservations(),
  });
  assert.strictEqual(seed.adapterDeltaCq, 0);
  assert.strictEqual(seed.provenance.adapter.mode, 'neutral_high_uncertainty_prior');
  const attestation = seed.provenance.adapter.legacyRowProfileAttestation;
  assert.strictEqual(attestation.eligible, false);
  assert.strictEqual(attestation.unprofiledRows, 1);
  assert.strictEqual(attestation.mismatchedRows, 1);
});

test('historical hqdn3d canary cannot be relabelled as KNN calibration', () => {
  const artifact = {
    schema: 1,
    purpose: 'compare-legacy-original-tf4-vs-canonical-hqdn3d-tf0-vmaf-contracts',
    denoise: 'hqdn3d=1.5:1.5:6:6',
    prerollSeconds: canonical.PREROLL_SECONDS,
    sources: [0, 1].map((index) => ({
      label: `canary-${index}`, file: `/temp/canary-${index}.mkv`, durationSeconds: 60,
      width: 1920, height: 1080, pixelFormat: 'yuv420p',
      summary: [
        { contract: 'legacy', cq: 30, harmonic: 94 },
        { contract: 'canonical', cq: 30, harmonic: 94.5 },
        { contract: 'legacy', cq: 36, harmonic: 91 },
        { contract: 'canonical', cq: 36, harmonic: 91.8 },
      ],
    })),
  };
  const parsed = bridge.observationsFromCalibrationArtifact(artifact);
  assert.strictEqual(parsed.length, 0);
  const adapter = bridge.buildCqAdapter(artifact, source, 33, {});
  assert.strictEqual(adapter.mode, 'neutral_high_uncertainty_prior');
  assert.strictEqual(adapter.supportSources, 0);
  assert.strictEqual(adapter.evidenceSources, 0);
  assert.strictEqual(adapter.deltaCq, 0);
});

test('a future explicitly attested KNN canary can train the CQ adapter', () => {
  const artifact = {
    schema: bridge.CALIBRATION_ARTIFACT_SCHEMA,
    purpose: bridge.CALIBRATION_PURPOSE,
    legacyReferenceContractId: canonical.LEGACY_REFERENCE_CONTRACT_ID,
    canonicalReferenceContractId: canonical.REFERENCE_CONTRACT_ID,
    denoiseId: nvenccKnn.DENOISE_ID,
    denoiseSettings: nvenccKnn.KNN_SETTINGS,
    prerollSeconds: canonical.PREROLL_SECONDS,
    encoderProfileId: nvenc.REFERENCE_COMPARISON_ENCODER_PROFILE_ID,
    sources: [0, 1, 2].map((index) => ({
      label: `contextual-canary-${index}`,
      file: `/temp/contextual-canary-${index}.mkv`,
      source_fingerprint: `sha256-sampled-v1:${String(index + 1).padStart(64, '0')}`,
      durationSeconds: 60,
      width: 1920,
      height: 1080,
      tier: '1080p',
      pixelFormat: 'yuv420p10le',
      is_hdr: 0,
      source_codec: 'hevc',
      media_is_animation: 0,
      summary: [28, 34, 40].flatMap((cq) => {
        const legacyVmaf = 105 - 0.4 * cq;
        return [
          { contract: 'legacy', cq, harmonic: legacyVmaf },
          { contract: 'canonical', cq, harmonic: legacyVmaf + 0.8 },
        ];
      }),
    })),
  };
  const adapter = bridge.buildCqAdapter(artifact, source, 30, {});
  assert.strictEqual(adapter.mode, 'learned_attested_cq_adapter');
  assert.strictEqual(adapter.supportSources, 3);
  assert.strictEqual(adapter.supportPoints, 9);
  assert(adapter.deltaCq > 0 && adapter.deltaCq < adapter.rawDeltaCq,
    'artifact correction must be shrunken toward the neutral prior');
});

test('calibration artifact loader falls through malformed files and reports the chosen path', () => {
  const errors = [];
  const fakeFs = {
    existsSync: (file) => ['/bad.json', '/good.json'].includes(file),
    readFileSync: (file) => file === '/bad.json' ? '{broken' : '{"schema":1}',
  };
  const loaded = parameterTesting.loadReferenceContractCalibration(
    fakeFs, ['/missing.json', '/bad.json', '/good.json'],
    (file) => errors.push(file));
  assert.strictEqual(loaded.path, '/good.json');
  assert.deepStrictEqual(loaded.artifact, { schema: 1 });
  assert.deepStrictEqual(errors, ['/bad.json']);
});

test('legacy seed becomes three distinct fresh current-contract probes', () => {
  const seed = bridge.buildSeed(legacyRows(nowIso), source, 95, { nowMs });
  const freshCqs = parameterTesting.buildFreshProbeSeed(seed.centerCq, seed.rangeMin, seed.rangeMax);
  assert.strictEqual(freshCqs.length, 3);
  assert.strictEqual(new Set(freshCqs).size, 3);
  assert(freshCqs.every((cq) => cq >= 16 && cq <= 51));
  assert.deepStrictEqual(parameterTesting.buildFreshProbeSeed(16, 16, 16), [16, 18, 20]);
});

test('history can act only on the first unguided round', () => {
  assert.strictEqual(parameterTesting.shouldApplyHistoricalProbeSeed({
    dynamicCQ: true, isRetry: false, guidedCount: 0, alreadySeeded: false,
  }), true);
  assert.strictEqual(parameterTesting.shouldApplyHistoricalProbeSeed({
    dynamicCQ: true, isRetry: true, guidedCount: 0, alreadySeeded: false,
  }), false, 'retry must stay on the fresh current-file curve');
  assert.strictEqual(parameterTesting.shouldApplyHistoricalProbeSeed({
    dynamicCQ: true, isRetry: false, guidedCount: 2, alreadySeeded: false,
  }), false, 'guided next-CQ state must stay on the fresh current-file curve');
  assert.strictEqual(parameterTesting.shouldApplyHistoricalProbeSeed({
    dynamicCQ: true, isRetry: false, guidedCount: 0, alreadySeeded: true,
  }), false, 'history must never seed twice');
  assert.strictEqual(parameterTesting.shouldApplyHistoricalProbeSeed({
    dynamicCQ: false, isRetry: false, guidedCount: 0, alreadySeeded: false,
  }), false, 'manual CQ mode must never be overwritten by history');
});

test('predictor DB wrappers preserve explicit reference-contract filters', () => {
  const calls = [];
  const rows = legacyRows(nowIso);
  const fakeDbModule = {
    getSimilarSweepCurves(db, src, options) {
      calls.push(['similar', options.referenceContractId]);
      return rows;
    },
    getSameFileSweepCurves(db, filePath, options) {
      calls.push(['same', options.referenceContractId]);
      return [];
    },
  };
  predictor.selectCQFromDb({}, fakeDbModule, Object.assign({ file_path: '/media/a.mkv' }, source),
    { targetVmaf: 95 }, {
      referenceContractId: canonical.LEGACY_REFERENCE_CONTRACT_ID,
      recencyHalfLifeDays: 0,
      nowMs,
      minSupport: 0.1,
    });
  predictor.sampleStatsFromDb({}, fakeDbModule, Object.assign({ file_path: '/media/a.mkv' }, source), {
    referenceContractId: canonical.REFERENCE_CONTRACT_ID,
  });
  assert.deepStrictEqual(calls, [
    ['similar', canonical.LEGACY_REFERENCE_CONTRACT_ID],
    ['same', canonical.LEGACY_REFERENCE_CONTRACT_ID],
    ['similar', canonical.REFERENCE_CONTRACT_ID],
    ['same', canonical.REFERENCE_CONTRACT_ID],
  ]);
});

console.log(`\n${passed} VMAF reference-contract bridge tests passed.`);
