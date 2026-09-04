'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const libRoot = fs.existsSync('/custom-cont-init.d/.vmaf-plugin-patches/_lib')
    ? '/custom-cont-init.d/.vmaf-plugin-patches/_lib'
    : path.join(__dirname, '..', 'custom-cont-init.d', '.vmaf-plugin-patches', '_lib');
const deliveryPolicy = require(path.join(libRoot, 'deliveryPolicy.js'));
const vmafdb = require(path.join(libRoot, 'vmafdb.js'));

const variables = {};
const policy = deliveryPolicy.resolve(variables);
assert.deepStrictEqual(policy, {
    version: 'delivered-minimum-reduction-v2',
    targetReductionPct: 30,
    minimumReductionPct: 10,
    maxFinalOutputRatioPct: 90,
});
assert.strictEqual(deliveryPolicy.evaluateBytes(900, 1000, policy).accepted, true,
    'equality at the 90% cap must be accepted');
assert.strictEqual(deliveryPolicy.evaluateBytes(901, 1000, policy).rejected, true,
    'bytes above the 90% cap must be rejected');

const db = vmafdb.openDb(':memory:');
const schemaVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
assert(schemaVersion >= 19,
    'schema must include at minimum the v19 delivery policy triggers; current: ' + schemaVersion);
for (const name of [
    'trg_jobs_candidate_ready_insert_guard',
    'trg_jobs_delivery_committing_insert_guard',
    'trg_jobs_delivered_insert_guard',
]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
    assert(row && row.sql.includes('delivered-minimum-reduction-v2'), `${name} must bind policy v2`);
    assert(row.sql.includes('minimum_size_reduction_pct IS NOT 10'),
        `${name} must bind the 10% reduction floor`);
    assert(row.sql.includes('max_final_output_ratio_pct IS NOT 90'),
        `${name} must bind the 90% ratio ceiling`);
}

console.log('PASS versioned 30/10/90 delivery policy and schema-v19 trigger migration');
