#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = '/app/server/Tdarr/DB2/SQL/database.db';
const backupPath = '/app/server/Tdarr/DB2/SQL/database.db.bak-vmaf-v1-promotion-20260726';
const flowId = 'YR5PZ1QaD';
const apply = process.argv.includes('--apply');
const desired = {
  calculateVMAF: {
    vmafCpuV1QualificationEnabled: 'false',
    vmafCpuV1ProductionEnabled: 'true',
    vmafCpuV1ProductionAllowProvisionalHdr: 'true',
    maxParallelCpuV1: '2',
    vmafPairedCqActingEnabled: 'true',
    pairedCqShadow: 'true',
    pairedCqShadowForceFull: 'true',
    pairedCqShadowAnchors: '6',
  },
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
  console.log(changes.length ? `Dry run:\n${changes.join('\n')}` : 'Dry run: CPU-v1 promotion controls already current');
  process.exit(0);
}
if (!changes.length) {
  console.log('Live CPU-v1 promotion controls already current');
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
console.log('Paired-CQ is armed but force-full remains a hard interlock until exact schema-v4 evidence clears review.');
