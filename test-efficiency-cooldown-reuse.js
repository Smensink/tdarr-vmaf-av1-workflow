'use strict';

// Regression contract for the 2026-07-20 efficiency trio:
// 1. mandatory authenticated pre-FGS source-CAMBI baseline (calculateVMAF),
// 2. cross-job sweep-measurement reuse (testEncodingParameters -> selectBestParameters,
//    with exportVMAFResults refusing to re-write revived rows),
// 3. retired infeasible-file cooldown: priors remain telemetry, but a new sweep runs so
//    advisory-limit fallback can select the closest technically valid CQ.
// These features live inline in plugin flows, so this is a source-wiring contract plus
// the invariants that keep them safe.

const assert = require('assert');
const fs = require('fs');

const read = (p) => fs.readFileSync(`./custom-cont-init.d/vmaf-plugin-patches/${p}/1.0.0/index.js`, 'utf8');
const selector = read('selectBestParameters');
const encoding = read('testEncodingParameters');
const calculate = read('calculateVMAF');
const retry = read('checkCQRangeRetry');
const exporter = read('exportVMAFResults');

// ── 1. Mandatory source-CAMBI ──
assert.ok(calculate.includes('measureSourceCambiBaselines'),
  'authenticated source-CAMBI measurement is missing');
assert.ok(calculate.includes('vmafSourceCambiSignature'),
  'source-CAMBI cache must retain exact contract/path/subsample identity');
assert.ok(calculate.includes('metricContract.cambi.required === true'),
  'current metric contract must force CAMBI coverage');
assert.ok(!selector.includes('vmafLazyCambi'),
  'obsolete lazy-CAMBI bypass must not weaken the mandatory safety gate');

// ── 2. Cross-job reuse ──
// Producer: kill switch, era floor, quality requirements, fresh-probe guarantee.
assert.ok(encoding.includes('vmafCrossJobReuse'), 'reuse kill switch missing (producer)');
assert.ok(encoding.includes("'2026-07-08'"), 'reuse era floor missing');
assert.ok(encoding.includes('s.sample_count >= 8'), 'reuse must require >=8 measured clips');
assert.ok(encoding.includes('s.vmaf_p1_low IS NOT NULL'), 'reuse must require 1%-low presence');
assert.ok(encoding.includes('_cjReusable.length >= crfValues.length'),
  'fresh-probe guarantee missing: all-reusable sweeps must keep one fresh CQ');
assert.ok(encoding.includes('vmafReusedSweepRows'), 'reuse handoff variable missing (producer)');
assert.ok(encoding.includes("COALESCE(s.reference_contract_id, 'legacy-original-tf4-v1') = ?"),
  'exact sweep reuse must be isolated by reference/encoder contract');
assert.ok(encoding.includes("COALESCE(j.reference_contract_id, 'legacy-original-tf4-v1') = ?"),
  'exact sweep reuse must require the joined job contract too');
assert.ok(encoding.includes("COALESCE(s.reference_contract_id, 'legacy-original-tf4-v1')") &&
  encoding.includes("COALESCE(j.reference_contract_id, 'legacy-original-tf4-v1')"),
  'exact sweep reuse must reject mismatched job/sweep contracts');
assert.ok(encoding.includes('args.variables.vmafCrossJobReuse = false'),
  'canonical denoised jobs must disable cross-job exact reuse');
// Consumer: revive under current policy, template from a fresh result, provenance marker.
assert.ok(selector.includes('vmafReusedSweepRows'), 'reuse handoff variable missing (consumer)');
assert.ok(selector.includes('reusedFromJobId'), 'revived rows must carry provenance');
assert.ok(selector.includes('_cjrTemplate'), 'revive must clone parameterSet from a fresh result');
// Export must never re-write revived rows under the new job id.
assert.ok(exporter.includes('if (_ar.reusedFromJobId) continue;'),
  'exportVMAFResults must skip revived rows or age-gating breaks');

// ── 3. Prior infeasible results are advisory ──
assert.ok(encoding.includes('vmafInfeasibleCooldown'), 'cooldown kill switch missing');
assert.ok(encoding.includes("_cdEraFloor = '2026-07-20'"), 'cooldown feasibility-era floor missing');
assert.ok(encoding.includes("IN ('no_feasible_parameters','target_vmaf_unreachable')"),
  'cooldown must only trigger on terminal quality/feasibility failures');
assert.ok(encoding.includes('job_id IN (SELECT DISTINCT job_id FROM sweep_points WHERE'),
  'cooldown priors must come from real sweeps - cooldown skips must never re-arm the cooldown');
assert.ok(encoding.includes("COALESCE(reference_contract_id, 'legacy-original-tf4-v1') = ?"),
  'cooldown priors must match the current reference/encoder contract');
assert.ok(encoding.includes('target_min_vmaf = ?'), 'cooldown must match the current VMAF target');
// Cooldown must not fire on retry passes of the same job.
assert.ok(encoding.includes('_cdIsRetryPass'), 'cooldown must be first-attempt only');
assert.ok(encoding.includes('vmafPriorInfeasibleAdvisory'),
  'prior infeasible result must be retained as advisory telemetry');
assert.ok(encoding.includes('Prior keep-original cooldown is retired'),
  'producer must explicitly re-sweep instead of keeping the original');
assert.ok(!encoding.includes('args.variables.vmafCooldownSkip = {'),
  'testEncodingParameters must not arm the obsolete keep-original cooldown');
// Retain legacy downstream guards for already-running/pre-upgrade state, but the producer
// above must never arm them for a new job.
for (const [name, src] of [['calculateVMAF', calculate], ['selectBestParameters', selector], ['checkCQRangeRetry', retry]]) {
  assert.ok(src.includes('vmafCooldownSkip'), `${name} missing cooldown guard`);
}

console.log('PASS efficiency contract (mandatory CAMBI, cross-job reuse, prior-infeasible advisory)');
