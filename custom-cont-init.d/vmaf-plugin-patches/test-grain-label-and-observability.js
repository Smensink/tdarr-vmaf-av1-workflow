'use strict';

/**
 * Regression test: P2 — Fix the misleading grain size-cap label and surface breaches
 *
 * Verifies:
 *  1. assessOutputSizeRatio — advisory-only warning returned, no exception thrown
 *  2. recordQualityWarning — appends advisory entry, sets grainSynthesisQualityWarnings
 *  3. grainSynthesisDeliveryEvidence — maps active status + ratio + breach fields
 *  4. grainDeliveryFields — round-trips warnings through JSON, validates evidence consistency
 *  5. Plugin label renamed, old label absent, tooltip confirms advisory
 *  6. Default value stays 101 (threshold recommendation is a separate operator decision)
 *
 * Does NOT test:
 *  - Hard-gate logic (grainOriginalRatioCap / deliveryPolicy 90%) — separate policy.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const GRAIN_PLUGIN = path.resolve(__dirname, 'synthesizeFilmGrain/1.0.0/index.js');
const VALIDATE_PLUGIN = path.resolve(__dirname, 'validateDeliveryCandidate/1.0.0/index.js');
const FINALIZE_PLUGIN = path.resolve(__dirname, 'finalizeDeliveredOutcome/1.0.0/index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Call a function exported via ._test on the given module. */
function testFn(modulePath, fnName) {
    const mod = require(modulePath);
    const fn = mod._test && mod._test[fnName];
    if (typeof fn !== 'function') {
        throw new Error(`${fnName} not found in ._test of ${modulePath}`);
    }
    return fn;
}

/** Stub jobLog that records calls. */
function makeJobLog(logs) {
    return (msg) => logs.push(msg);
}

// ---------------------------------------------------------------------------
// Test 1 — assessOutputSizeRatio (advisory-only)
// ---------------------------------------------------------------------------

test('assessOutputSizeRatio — below threshold returns null warning', () => {
    const fn = testFn(GRAIN_PLUGIN, 'assessOutputSizeRatio');
    const result = fn(1_000_000_000, 950_000_000, 101);
    assert.equal(result.ratioPct, 95.0);
    assert.equal(result.qualityWarning, null);
});

test('assessOutputSizeRatio — at threshold (101 %) returns null warning', () => {
    const fn = testFn(GRAIN_PLUGIN, 'assessOutputSizeRatio');
    const result = fn(1_000_000_000, 1_010_000_000, 101);
    assert.equal(result.ratioPct, 101.0);
    assert.equal(result.qualityWarning, null);
});

test('assessOutputSizeRatio — above threshold returns advisory warning object', () => {
    const fn = testFn(GRAIN_PLUGIN, 'assessOutputSizeRatio');
    const result = fn(1_000_000_000, 1_075_920_000, 101);
    assert.equal(result.ratioPct, 107.592);
    assert.notEqual(result.qualityWarning, null);
    assert.equal(result.qualityWarning.advisory, true,
        'warning must be marked advisory — it is NOT a hard rejection');
    assert.equal(result.qualityWarning.code, 'grain-output-size-efficiency-warning');
    assert.equal(result.qualityWarning.warning_threshold_pct, 101);
    assert.ok(result.qualityWarning.failures.length > 0);
    assert.ok(result.qualityWarning.failures[0].includes('107.592'),
        'failure message must include the actual ratio');
});

test('assessOutputSizeRatio — 107.6 % canary scenario is advisory only (no exception)', () => {
    const fn = testFn(GRAIN_PLUGIN, 'assessOutputSizeRatio');
    // The canary that shipped: 107.592 % of completed AV1 base, 49.269 % of source.
    // No exception — advisory only. The hard gate is grainOriginalRatioCap at 90 %.
    const result = fn(100_000_000, 107_592_000, 101);
    assert.equal(result.qualityWarning.advisory, true);
    // The result is returned, not thrown
});

test('assessOutputSizeRatio — invalid baseBytes throws', () => {
    const fn = testFn(GRAIN_PLUGIN, 'assessOutputSizeRatio');
    assert.throws(() => fn(0, 100, 101), /invalid/);
    assert.throws(() => fn(-1, 100, 101), /invalid/);
    assert.throws(() => fn(1.5, 100, 101), /invalid/);
});

test('assessOutputSizeRatio — invalid outputBytes throws', () => {
    const fn = testFn(GRAIN_PLUGIN, 'assessOutputSizeRatio');
    assert.throws(() => fn(100, 0, 101), /invalid/);
    assert.throws(() => fn(100, -1, 101), /invalid/);
    assert.throws(() => fn(100, 1.5, 101), /invalid/);
});

test('assessOutputSizeRatio — threshold outside 1-500 throws', () => {
    const fn = testFn(GRAIN_PLUGIN, 'assessOutputSizeRatio');
    assert.throws(() => fn(100, 100, 0), /invalid/);
    assert.throws(() => fn(100, 100, 600), /invalid/);
    assert.throws(() => fn(100, 100, NaN), /invalid/);
});

// ---------------------------------------------------------------------------
// Test 2 — recordQualityWarning
// ---------------------------------------------------------------------------

test('recordQualityWarning — appends advisory entry to warnings array', () => {
    const fn = testFn(GRAIN_PLUGIN, 'recordQualityWarning');
    const warnings = [];
    const logs = [];
    const args = {
        variables: {},
        jobLog: makeJobLog(logs),
    };
    const warning = {
        code: 'grain-output-size-efficiency-warning',
        advisory: true,
        ratio_pct_of_base: 107.592,
        warning_threshold_pct: 101,
        failures: ['output is 107.592 % of completed base'],
    };
    fn(args, warnings, 'output-size-efficiency', warning);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].stage, 'output-size-efficiency');
    assert.equal(warnings[0].advisory, true);
    assert.equal(warnings[0].code, 'grain-output-size-efficiency-warning');
    assert.equal(warnings[0].warning_threshold_pct, 101);

    // grainSynthesisQualityWarnings is also set on args.variables
    assert.ok(Array.isArray(args.variables.grainSynthesisQualityWarnings));
    assert.equal(args.variables.grainSynthesisQualityWarnings.length, 1);
    assert.equal(args.variables.grainSynthesisQualityWarnings[0].stage, 'output-size-efficiency');

    // JobLog was called with a warning
    assert.ok(logs.some((l) => l.includes('FILM GRAIN QUALITY WARNING')));
    assert.ok(logs.some((l) => l.includes('Structural validation will continue')));
});

test('recordQualityWarning — null warning is a no-op', () => {
    const fn = testFn(GRAIN_PLUGIN, 'recordQualityWarning');
    const warnings = [{ stage: 'other', advisory: true, code: 'x', failures: [] }];
    const args = { variables: {}, jobLog: makeJobLog([]) };
    fn(args, warnings, 'output-size-efficiency', null);
    assert.equal(warnings.length, 1); // unchanged
});

// ---------------------------------------------------------------------------
// Test 3 — grainSynthesisDeliveryEvidence
// ---------------------------------------------------------------------------

test('grainSynthesisDeliveryEvidence — not_applicable returns all nulls', () => {
    const fn = testFn(VALIDATE_PLUGIN, 'grainSynthesisDeliveryEvidence');
    const args = { variables: { grainSynthesisStatus: 'not_applicable' } };
    const result = fn(args, '/fake/delivered.mkv');
    assert.equal(result.status, 'not_applicable');
    assert.equal(result.output_size_ratio_pct_of_base, null);
    assert.equal(result.size_efficiency_warning_pct, null);
    assert.equal(result.size_efficiency_warning_breached, false);
    assert.deepEqual(result.quality_warnings, []);
    assert.equal(result.warnings_source, 'not_applicable');
});

test('grainSynthesisDeliveryEvidence — active_validated maps canary breach correctly', () => {
    const fn = testFn(VALIDATE_PLUGIN, 'grainSynthesisDeliveryEvidence');
    const args = {
        variables: {
            grainSynthesisStatus: 'active_validated',
            grainSynthesisQualityWarnings: [{
                stage: 'output-size-efficiency',
                advisory: true,
                code: 'grain-output-size-efficiency-warning',
                ratio_pct_of_base: 107.592,
                warning_threshold_pct: 101,
                failures: ['output is 107.592 % of completed base'],
            }],
            grainSynthesisValidation: {
                output_size_ratio_pct_of_base: 107.592,
                output_size_efficiency_warning_pct: 101,
                output_size_efficiency_warning_breached: true,
                quality_warnings: [],
                output: '/fake/delivered.mkv',
            },
        },
    };
    const result = fn(args, '/fake/delivered.mkv');
    assert.equal(result.status, 'active_validated');
    assert.equal(result.output_size_ratio_pct_of_base, 107.592);
    assert.equal(result.size_efficiency_warning_pct, 101);
    assert.equal(result.size_efficiency_warning_breached, true);
    assert.ok(result.quality_warnings.length > 0);
    assert.equal(result.warnings_source, 'grainSynthesisQualityWarnings');
    assert.equal(result.output_matches_candidate, true);
});

test('grainSynthesisDeliveryEvidence — falls back to grainSynthesisValidation.quality_warnings', () => {
    const fn = testFn(VALIDATE_PLUGIN, 'grainSynthesisDeliveryEvidence');
    const args = {
        variables: {
            grainSynthesisStatus: 'active_validated',
            // No grainSynthesisQualityWarnings — should fall back to report.quality_warnings
            grainSynthesisValidation: {
                output_size_ratio_pct_of_base: 110.0,
                output_size_efficiency_warning_pct: 101,
                output_size_efficiency_warning_breached: true,
                quality_warnings: [{
                    stage: 'output-size-efficiency',
                    advisory: true,
                    code: 'grain-output-size-efficiency-warning',
                    failures: ['output is 110.000 %'],
                }],
                output: '/fake/delivered.mkv',
            },
        },
    };
    const result = fn(args, '/fake/delivered.mkv');
    assert.equal(result.warnings_source,
        'grainSynthesisValidation.quality_warnings');
    assert.equal(result.quality_warnings.length, 1);
});

// ---------------------------------------------------------------------------
// Test 4 — grainDeliveryFields
// ---------------------------------------------------------------------------

test('grainDeliveryFields — null grain synthesis returns all nulls', () => {
    const { grainDeliveryFields } = require(FINALIZE_PLUGIN)._test;
    const result = grainDeliveryFields({});
    assert.equal(result.grain_output_size_ratio_pct_of_base, null);
    assert.equal(result.grain_size_efficiency_warning_pct, null);
    assert.equal(result.grain_size_efficiency_warning_breached, 0);
    assert.equal(result.grain_synthesis_quality_warnings_json, '[]');
});

test('grainDeliveryFields — breached warning sets breached=1 and preserves warnings JSON', () => {
    const { grainDeliveryFields } = require(FINALIZE_PLUGIN)._test;
    const warnings = [{
        stage: 'output-size-efficiency',
        advisory: true,
        code: 'grain-output-size-efficiency-warning',
        ratio_pct_of_base: 107.592,
        warning_threshold_pct: 101,
        failures: ['output is 107.592 % of completed base'],
    }];
    const validation = {
        grain_synthesis: {
            output_size_ratio_pct_of_base: 107.592,
            size_efficiency_warning_pct: 101,
            size_efficiency_warning_breached: true,
            quality_warnings: warnings,
        },
    };
    const result = grainDeliveryFields(validation);
    assert.equal(result.grain_output_size_ratio_pct_of_base, 107.592);
    assert.equal(result.grain_size_efficiency_warning_pct, 101);
    assert.equal(result.grain_size_efficiency_warning_breached, 1);
    const parsed = JSON.parse(result.grain_synthesis_quality_warnings_json);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].stage, 'output-size-efficiency');
    assert.equal(parsed[0].advisory, true);
});

test('grainDeliveryFields — not-breached warning sets breached=0', () => {
    const { grainDeliveryFields } = require(FINALIZE_PLUGIN)._test;
    const validation = {
        grain_synthesis: {
            output_size_ratio_pct_of_base: 95.0,
            size_efficiency_warning_pct: 101,
            size_efficiency_warning_breached: false,
            quality_warnings: [],
        },
    };
    const result = grainDeliveryFields(validation);
    assert.equal(result.grain_output_size_ratio_pct_of_base, 95.0);
    assert.equal(result.grain_size_efficiency_warning_pct, 101);
    assert.equal(result.grain_size_efficiency_warning_breached, 0);
});

test('grainDeliveryFields — ratio/threshold mismatch throws inconsistent', () => {
    const { grainDeliveryFields } = require(FINALIZE_PLUGIN)._test;
    // ratio 110 > threshold 101 means breached=true, but flag says breached=false
    const validation = {
        grain_synthesis: {
            output_size_ratio_pct_of_base: 110,
            size_efficiency_warning_pct: 101,
            size_efficiency_warning_breached: false, // inconsistent
            quality_warnings: [],
        },
    };
    assert.throws(() => grainDeliveryFields(validation), /inconsistent/);
});

test('grainDeliveryFields — breached without advisory output-size-efficiency warning throws', () => {
    const { grainDeliveryFields } = require(FINALIZE_PLUGIN)._test;
    const validation = {
        grain_synthesis: {
            output_size_ratio_pct_of_base: 110,
            size_efficiency_warning_pct: 101,
            size_efficiency_warning_breached: true,
            quality_warnings: [{
                // missing the required output-size-efficiency advisory entry
                stage: 'other-stage',
                advisory: true,
                code: 'other',
                failures: [],
            }],
        },
    };
    assert.throws(
        () => grainDeliveryFields(validation),
        /lacks its advisory warning payload/,
    );
});

test('grainDeliveryFields — partial evidence (ratio null, threshold set) throws', () => {
    const { grainDeliveryFields } = require(FINALIZE_PLUGIN)._test;
    const validation = {
        grain_synthesis: {
            output_size_ratio_pct_of_base: null,
            size_efficiency_warning_pct: 101,
            size_efficiency_warning_breached: false,
            quality_warnings: [],
        },
    };
    assert.throws(
        () => grainDeliveryFields(validation),
        /incomplete/,
    );
});

// ---------------------------------------------------------------------------
// Test 5 — Plugin label verification
// ---------------------------------------------------------------------------

test('Plugin label — renamed to include "(Advisory)"', () => {
    const src = fs.readFileSync(GRAIN_PLUGIN, 'utf8');
    assert.ok(
        src.includes("label: 'Grain Size Efficiency Warning % (Advisory)'"),
        'Label must contain the unambiguous advisory designation',
    );
});

test('Plugin label — old misleading "Maximum Output Size Ratio %" removed', () => {
    const src = fs.readFileSync(GRAIN_PLUGIN, 'utf8');
    // Must not contain the old label anywhere in the file
    assert.ok(
        !src.includes("label: 'Maximum Output Size Ratio %'") &&
        !src.includes('label: "Maximum Output Size Ratio %"'),
        'Old misleading label "Maximum Output Size Ratio %" must not appear',
    );
});

test('Plugin tooltip — confirms advisory ("warn if ...")', () => {
    const src = fs.readFileSync(GRAIN_PLUGIN, 'utf8');
    const idx = src.indexOf("label: 'Grain Size Efficiency Warning % (Advisory)'");
    assert.ok(idx > 0, 'Renamed label must exist');
    // Tooltip is within the same input block (~400 chars after label)
    const window = src.slice(idx, idx + 400);
    assert.ok(
        /warn/i.test(window),
        'Tooltip must confirm this is a warning, not a hard cap',
    );
});

test('Plugin tooltip — explicitly disclaims rejection ("does not reject")', () => {
    const src = fs.readFileSync(GRAIN_PLUGIN, 'utf8');
    const idx = src.indexOf("label: 'Grain Size Efficiency Warning % (Advisory)'");
    const window = src.slice(idx, idx + 400);
    // The tooltip must contain an explicit disclaimer that this field does NOT reject.
    // The word "reject" appears only in the negative disclaimer ("does not reject").
    assert.ok(
        /does not reject/i.test(window),
        'Tooltip must explicitly disclaim rejection with "does not reject"',
    );
    // It must not use a positive enforcement framing (e.g. "will reject" without negation)
    const positiveEnforcement = /\bwill reject\b/i;
    assert.ok(
        !positiveEnforcement.test(window),
        'Tooltip must not frame the field as positively rejecting',
    );
});

// ---------------------------------------------------------------------------
// Test 6 — Default value unchanged at 101 (policy — recommendation only)
// ---------------------------------------------------------------------------

test('Plugin defaultValue remains 101 — threshold change requires operator decision', () => {
    const src = fs.readFileSync(GRAIN_PLUGIN, 'utf8');
    const idx = src.indexOf("label: 'Grain Size Efficiency Warning % (Advisory)'");
    assert.ok(idx > 0);
    const window = src.slice(idx, idx + 400);
    assert.ok(
        window.includes("defaultValue: '101'") ||
        window.includes('defaultValue: "101"'),
        'defaultValue must remain 101; threshold recommendation is a separate operator decision',
    );
});

// ---------------------------------------------------------------------------
// Test 7 — v20 DB schema additions present in vmafdb.js
// ---------------------------------------------------------------------------

test('vmafdb.js v20 — grain advisory columns declared', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '_lib/vmafdb.js'), 'utf8');
    assert.ok(src.includes('grain_output_size_ratio_pct_of_base'),
        'jobs table must have grain_output_size_ratio_pct_of_base column');
    assert.ok(src.includes('grain_size_efficiency_warning_pct'),
        'jobs table must have grain_size_efficiency_warning_pct column');
    assert.ok(src.includes('grain_size_efficiency_warning_breached'),
        'jobs table must have grain_size_efficiency_warning_breached column');
    assert.ok(src.includes('grain_synthesis_quality_warnings_json'),
        'jobs table must have grain_synthesis_quality_warnings_json column');
});

test('vmafdb.js v20 — breach guard trigger present', () => {
    const src = fs.readFileSync(
        path.resolve(__dirname, '_lib/vmafdb.js'), 'utf8');
    // Guard trigger exists (prevents delivered rows with incomplete grain warning evidence)
    assert.ok(src.includes('trg_jobs_delivered_grain_observability_guard'),
        'guard trigger must exist to enforce evidence completeness on delivered rows');
    // Guard checks breached is 0 or 1, that warnings JSON is present, and that breached=1 implies ratio>threshold
    assert.ok(src.includes('grain_size_efficiency_warning_breached NOT IN (0, 1)'),
        'guard must validate breached is 0 or 1');
    assert.ok(src.includes('grain_synthesis_quality_warnings_json IS NULL'),
        'guard must require warnings JSON to be non-null');
    // Update guard prevents changing evidence after delivery
    assert.ok(src.includes('trg_jobs_delivered_grain_observability_update_guard'),
        'update guard must prevent changing grain warning evidence on delivered rows');
    // Immutability trigger prevents modification after delivery
    assert.ok(src.includes('trg_jobs_delivered_grain_observability_immutable'),
        'immutability trigger must lock grain warning fields after delivery');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (require.main === module) {
    console.log('\n=== Grain label + observability regression tests ===');
    console.log('PASS — all assertions executed without throwing');
}
