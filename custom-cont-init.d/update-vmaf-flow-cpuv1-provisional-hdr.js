#!/bin/sh
':' //; exit 0
'use strict';

// 2026-07-29 provisional-HDR CPU-v1 authorization (user-approved):
//   - calculateVMAF.vmafCpuV1ProductionAllowProvisionalHdr: false -> true
//
// Why: CPU-v1 scores VMAF and full-reference CAMBI in ONE native-10-bit pass. The GPU-v0
// contract this replaces cannot score 10-bit at all (libvmaf_cuda rejects p010le), so on
// HDR it runs libvmaf_cuda over a yuv420p8 proxy AND a separate required CPU pre-FGS CAMBI
// pass - strictly more work than folding VMAF into the CAMBI pass. GPU-v0 also never
// releases the GPU pipeline lock during scoring (only the CPU-v1 path does), so a blocked
// job pins the GPU for the whole scoring phase: measured 15m04s on Dutton Ranch S01E09
// (2026-07-29), against a previously measured 9.4 min CPU-only phase that was "GPU idle but
// locked" before the release fix landed.
//
// CPU-v1 production is already enabled; this flag is the separate fail-closed authorization
// that gates it for HDR/PQ content while HDR calibration remains provisional. Real terminal
// evidence for the provisional HDR/PQ CPU-v1 contract exists (Spider-Noir S01E04, job
// gDTqXFYwOU: native-10-bit integrated CAMBI, no GPU-v0 scoring, holdout measured, replaced).
//
// KNOWN CONSEQUENCE - not a pure speedup. Native-10-bit CPU VMAF and 8-bit-proxy GPU VMAF are
// different score scales. Provisional-HDR titles scored after this flip are not directly
// comparable to the same titles scored before it, which affects CQ selection and the vmafdb
// training rows for that cohort. Roll back with --revert if the cohort's scores shift enough
// to matter.
//
// Run inside the container:
//   node /custom-cont-init.d/update-vmaf-flow-cpuv1-provisional-hdr.js            (dry run)
//   node /custom-cont-init.d/update-vmaf-flow-cpuv1-provisional-hdr.js --apply
//   node /custom-cont-init.d/update-vmaf-flow-cpuv1-provisional-hdr.js --revert --apply

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = '/app/server/Tdarr/DB2/SQL/database.db';
const backupPath = '/app/server/Tdarr/DB2/SQL/database.db.bak-cpuv1-provisional-hdr-20260729';
const flowId = 'YR5PZ1QaD';
const apply = process.argv.includes('--apply');
const revert = process.argv.includes('--revert');
const target = revert ? 'false' : 'true';
const desired = {
  calculateVMAF: { vmafCpuV1ProductionAllowProvisionalHdr: target },
};

const db = new DatabaseSync(dbPath);
const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId);
if (!row) throw new Error(`Flow ${flowId} not found`);
const flow = JSON.parse(row.json_data);
const changes = [];

for (const [pluginName, inputs] of Object.entries(desired)) {
  const plugin = (flow.flowPlugins || []).find((item) => item.pluginName === pluginName);
  if (!plugin) throw new Error(`${pluginName} node not found`);
  plugin.inputsDB = plugin.inputsDB || {};
  for (const [key, value] of Object.entries(inputs)) {
    const previous = plugin.inputsDB[key];
    if (String(previous ?? '') !== value) {
      changes.push(`${pluginName}.${key}: ${previous ?? '(unset)'} -> ${value}`);
      plugin.inputsDB[key] = value;
    }
  }
}

// Enabling the authorization is meaningless unless CPU-v1 production itself is on; fail loudly
// rather than leaving a flag set that silently does nothing.
if (!revert) {
  const vmafNode = flow.flowPlugins.find((item) => item.pluginName === 'calculateVMAF');
  const production = String(vmafNode.inputsDB?.vmafCpuV1ProductionEnabled ?? '');
  if (production !== 'true') {
    throw new Error(
      `vmafCpuV1ProductionEnabled is "${production || '(unset)'}", not "true" - ` +
      'authorizing provisional HDR would have no effect. Enable CPU-v1 production first.');
  }
}

if (!apply) {
  console.log(changes.length
    ? `Dry run:\n${changes.join('\n')}`
    : `Dry run: vmafCpuV1ProductionAllowProvisionalHdr already ${target}`);
  process.exit(0);
}
if (!changes.length) {
  console.log(`Live flow already has vmafCpuV1ProductionAllowProvisionalHdr=${target}`);
  process.exit(0);
}
if (!fs.existsSync(backupPath)) db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

db.exec('BEGIN IMMEDIATE');
try {
  db.prepare('UPDATE flowsjsondb SET json_data = ?, timestamp = ? WHERE id = ?')
    .run(JSON.stringify(flow), Date.now(), flowId);
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

const verify = JSON.parse(db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId).json_data);
for (const [pluginName, inputs] of Object.entries(desired)) {
  const plugin = verify.flowPlugins.find((item) => item.pluginName === pluginName);
  for (const [key, value] of Object.entries(inputs)) {
    if (!plugin || String(plugin.inputsDB?.[key]) !== value) {
      throw new Error(`Live-flow verification failed for ${pluginName}.${key}`);
    }
  }
}
console.log(`Updated live flow ${flowId}:\n${changes.join('\n')}`);
console.log(`Backup: ${backupPath}`);
