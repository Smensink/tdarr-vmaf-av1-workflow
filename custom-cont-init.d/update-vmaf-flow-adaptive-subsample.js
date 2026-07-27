#!/bin/sh
':' //; exit 0
'use strict';

// 2026-07-21 adaptive VMAF frame-subsampling enablement (user-approved):
//   - calculateVMAF.vmafSubsample: 1 -> 4  (coarse/initial rounds score every 4th frame)
//   - checkCQBracket.threeStageVmaf: false -> true  (refinement midpoints may use n=2, but
//     ONLY when a reserved n=1 holdout will validate the winner; otherwise refinement stays n=1)
//   - checkCQBracket.intermediateVmafSubsample: 2 (explicit, matches the default)
// Safety rails that make this sound (all deployed 2026-07-21 before this flips):
//   - refinement/binding probes and incomplete-metric re-tests force n=1 (pre-existing),
//   - the reserved holdout always scores at n=1 (pre-existing),
//   - NEW winner full-rate confirmation in checkCQBracket: a converged winner whose coarsest
//     measurement was n>1 with no reserved holdout is re-measured once at n=1 before selection,
//   - NEW telemetry in selectBestParameters counts any retry-path leakage
//     (vmafWinnerSubsampledUnconfirmed).
// Run inside the container: node /custom-cont-init.d/update-vmaf-flow-adaptive-subsample.js [--apply]

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = '/app/server/Tdarr/DB2/SQL/database.db';
const backupPath = '/app/server/Tdarr/DB2/SQL/database.db.bak-adaptive-subsample-20260721';
const flowId = 'YR5PZ1QaD';
const apply = process.argv.includes('--apply');
const desired = {
  calculateVMAF: { vmafSubsample: '4' },
  checkCQBracket: { threeStageVmaf: 'true', intermediateVmafSubsample: '2' },
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

if (!apply) {
  console.log(changes.length ? `Dry run:\n${changes.join('\n')}` : 'Dry run: adaptive subsample already current');
  process.exit(0);
}
if (!changes.length) {
  console.log('Live flow adaptive subsample already current');
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
