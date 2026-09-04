'use strict';

/**
 * Regression test for P2: grain size efficiency warning — label, observability, threshold.
 *
 * Verified in r34 + subsequent changes. Covers:
 * 1. Input label is unambiguous (advisory not cap).
 * 2. assessOutputSizeRatio returns enriched warning fields.
 * 3. Warning code changed to grain-output-size-efficiency-warning.
 * 4. grainSynthesisQualityWarnings accumulated in variables.
 * 5. validateDeliveryCandidate surfaces grain_synthesis evidence on every delivery.
 * 6. vmafdb v20 schema columns and observability triggers.
 * 7. deliveryFinalization requireGrainSynthesisEvidence validates round-trip.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const patchRoot = fs.existsSync('/custom-cont-init.d/.vmaf-plugin-patches')
    ? '/custom-cont-init.d/.vmaf-plugin-patches'
    : path.resolve(__dirname, 'custom-cont-init.d', 'vmaf-plugin-patches');

const grain = require(path.join(patchRoot, 'synthesizeFilmGrain', '1.0.0', 'index.js'))._test;
const delivery = require(path.join(patchRoot, 'validateDeliveryCandidate', '1.0.0', 'index.js'))._test;
const finalizer = require(path.join(patchRoot, 'finalizeDeliveredOutcome', '1.0.0', 'index.js'))._test;
const finalizationLib = require(path.join(patchRoot, '_lib', 'deliveryFinalization.js'));
const vmafdb = require(path.join(patchRoot, '_lib', 'vmafdb.js'));

// ── 1. Label test: the details() input definition must say (Advisory) ─────────
const details = require(path.join(patchRoot, 'synthesizeFilmGrain', '1.0.0', 'index.js')).details();
const sizeInput = details.inputs.find((input) => input.name === 'maxOutputSizeRatioPct');
assert(sizeInput, 'maxOutputSizeRatioPct input must exist');
assert(!sizeInput.label.includes('Maximum Output Size Ratio'),
    `label must not say "Maximum Output Size Ratio"; got: ${sizeInput.label}`);
assert(sizeInput.label.toLowerCase().includes('advisory'),
    `label must mention "Advisory"; got: ${sizeInput.label}`);
assert(sizeInput.tooltip.toLowerCase().includes('advisory'),
    `tooltip must mention advisory; got: ${sizeInput.tooltip}`);
assert(sizeInput.tooltip.toLowerCase().includes('does not reject'),
    `tooltip must state it does not reject; got: ${sizeInput.tooltip}`);

// ── 2/3. assessOutputSizeRatio returns enriched fields and updated code ────────
const noWarn = grain.assessOutputSizeRatio(1000, 1000, 101);
assert.strictEqual(noWarn.qualityWarning, null, 'exact-threshold output must not warn');
assert.strictEqual(noWarn.ratioPct, 100);

const warned = grain.assessOutputSizeRatio(1000, 1076, 101);
assert.ok(warned.qualityWarning, 'above-threshold output must produce a warning');
assert.strictEqual(warned.qualityWarning.code, 'grain-output-size-efficiency-warning',
    `warning code must be 'grain-output-size-efficiency-warning'; got ${warned.qualityWarning.code}`);
assert.strictEqual(warned.qualityWarning.advisory, true, 'warning must be advisory');
assert.ok(Math.abs(warned.qualityWarning.ratio_pct_of_base - 107.6) < 0.01,
    `ratio_pct_of_base must be ~107.6; got ${warned.qualityWarning.ratio_pct_of_base}`);
assert.strictEqual(warned.qualityWarning.warning_threshold_pct, 101,
    'warning_threshold_pct must equal the configured threshold');
assert.ok(
    warned.qualityWarning.failures[0].includes('advisory warning threshold'),
    `failures text must reference advisory warning threshold; got: ${warned.qualityWarning.failures[0]}`
);
assert.ok(
    !warned.qualityWarning.failures[0].includes('advisory limit'),
    `failures text must not use old "advisory limit" phrase`
);

// ── 4. grainSynthesisQualityWarnings reaches the variables ────────────────────
const qualityLogs = [];
const qualityVarArgs = {
    variables: {},
    jobLog: (message) => qualityLogs.push(message),
};
const warnings = [];
grain.recordQualityWarning(qualityVarArgs, warnings, 'output-size-efficiency',
    warned.qualityWarning);
assert.strictEqual(warnings.length, 1);
assert.strictEqual(qualityVarArgs.variables.grainSynthesisQualityWarnings.length, 1);
const recorded = qualityVarArgs.variables.grainSynthesisQualityWarnings[0];
assert.strictEqual(recorded.advisory, true, 'persisted warning must be advisory');
assert.strictEqual(recorded.stage, 'output-size-efficiency');
assert.ok(typeof recorded.ratio_pct_of_base === 'number',
    'persisted warning must carry ratio_pct_of_base');
assert.ok(typeof recorded.warning_threshold_pct === 'number',
    'persisted warning must carry warning_threshold_pct');

// ── 5. validateDeliveryCandidate surfacing ─────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-vdc-'));
try {
    const sourcePath = path.join(tmpDir, 'source.mkv');
    const candidatePath = path.join(tmpDir, 'candidate.mkv');
    fs.writeFileSync(sourcePath, Buffer.alloc(1000, 0x31));
    fs.writeFileSync(candidatePath, Buffer.alloc(200, 0x42));

    const grainEvidence = delivery.grainSynthesisDeliveryEvidence(
        { variables: {} }, candidatePath);
    assert.strictEqual(grainEvidence.status, 'not_applicable');
    assert.strictEqual(grainEvidence.size_efficiency_warning_breached, false);
    assert.deepStrictEqual(grainEvidence.quality_warnings, []);

    const grainEvidenceActive = delivery.grainSynthesisDeliveryEvidence({
        variables: {
            grainSynthesisStatus: 'active_validated',
            grainSynthesisQualityWarnings: [
                {
                    stage: 'output-size-efficiency',
                    code: 'grain-output-size-efficiency-warning',
                    advisory: true,
                    ratio_pct_of_base: 107.592,
                    warning_threshold_pct: 101,
                    failures: ['output is 107.592% of completed base'],
                },
            ],
            grainSynthesisValidation: {
                output: candidatePath,
                output_size_ratio_pct_of_base: 107.592,
                output_size_efficiency_warning_pct: 101,
                output_size_efficiency_warning_breached: true,
                quality_warnings: [],
            },
        },
    }, candidatePath);
    assert.strictEqual(grainEvidenceActive.status, 'active_validated');
    assert.strictEqual(grainEvidenceActive.size_efficiency_warning_breached, true,
        'active grain with breach in variables must report breached');
    assert.ok(grainEvidenceActive.quality_warnings.length > 0,
        'active grain with warning must surface it');
    assert.ok(typeof grainEvidenceActive.output_size_ratio_pct_of_base === 'number',
        'active grain evidence must include ratio');
    assert.strictEqual(grainEvidenceActive.output_size_ratio_pct_of_base, 107.592);
    assert.strictEqual(grainEvidenceActive.size_efficiency_warning_pct, 101);

    const grainEvidenceClean = delivery.grainSynthesisDeliveryEvidence({
        variables: {
            grainSynthesisStatus: 'active_validated',
            grainSynthesisQualityWarnings: [],
            grainSynthesisValidation: {
                output: candidatePath,
                output_size_ratio_pct_of_base: 98.5,
                output_size_efficiency_warning_pct: 101,
                output_size_efficiency_warning_breached: false,
                quality_warnings: [],
            },
        },
    }, candidatePath);
    assert.strictEqual(grainEvidenceClean.size_efficiency_warning_breached, false,
        'clean active grain must report not breached');
} finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── 6. vmafdb v20 schema ──────────────────────────────────────────────────────
const db = vmafdb.openDb(':memory:');
assert.strictEqual(Number(db.prepare('PRAGMA user_version').get().user_version), 20,
    'vmafdb must be at schema version 20');

const v20Cols = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((row) => row.name));
for (const col of [
    'grain_output_size_ratio_pct_of_base',
    'grain_size_efficiency_warning_pct',
    'grain_size_efficiency_warning_breached',
    'grain_synthesis_quality_warnings_json',
]) {
    assert(v20Cols.has(col), `jobs table must have v20 column ${col}`);
}

const v20Triggers = new Set(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger'"
).all().map((row) => row.name));
for (const t of [
    'trg_jobs_delivered_grain_observability_guard',
    'trg_jobs_delivered_grain_observability_update_guard',
    'trg_jobs_delivered_grain_observability_immutable',
]) {
    assert(v20Triggers.has(t), `trigger ${t} must exist in schema v20`);
}

// ── 7. deliveryFinalization requireGrainSynthesisEvidence round-trip ──────────
const goodGrainEvidence = {
    status: 'active_validated',
    size_efficiency_warning_breached: false,
    output_size_ratio_pct_of_base: null,
    size_efficiency_warning_pct: null,
    quality_warnings: [],
};
const validated = finalizationLib.requireGrainSynthesisEvidence(goodGrainEvidence);
assert.strictEqual(validated.size_efficiency_warning_breached, false);
assert.deepStrictEqual(validated.quality_warnings, []);

const breachEvidence = {
    status: 'active_validated',
    size_efficiency_warning_breached: true,
    output_size_ratio_pct_of_base: 107.592,
    size_efficiency_warning_pct: 101,
    quality_warnings: [
        {
            stage: 'output-size-efficiency',
            code: 'grain-output-size-efficiency-warning',
            advisory: true,
            ratio_pct_of_base: 107.592,
            warning_threshold_pct: 101,
            failures: ['output is 107.592% of completed base'],
        },
    ],
};
const validatedBreach = finalizationLib.requireGrainSynthesisEvidence(breachEvidence);
assert.strictEqual(validatedBreach.size_efficiency_warning_breached, true);
assert.strictEqual(validatedBreach.quality_warnings.length, 1);

// Inconsistency should throw
assert.throws(() => finalizationLib.requireGrainSynthesisEvidence({
    size_efficiency_warning_breached: true,
    quality_warnings: [],
    output_size_ratio_pct_of_base: null,
    size_efficiency_warning_pct: null,
}), /advisory warning/, 'breach without advisory warning entry must throw');

assert.throws(() => finalizationLib.requireGrainSynthesisEvidence({
    size_efficiency_warning_breached: true,
    quality_warnings: [
        { stage: 'output-size-efficiency', advisory: true },
    ],
    output_size_ratio_pct_of_base: 98,
    size_efficiency_warning_pct: 101,
}), /inconsistent/, 'breach flag inconsistent with ratio <= threshold must throw');

assert.throws(() => finalizationLib.requireGrainSynthesisEvidence(null),
    /grain warning evidence is missing/, 'null grain evidence must throw');

console.log('PASS grain size efficiency warning: label, observability, threshold, schema-v20, and delivery finalization');
