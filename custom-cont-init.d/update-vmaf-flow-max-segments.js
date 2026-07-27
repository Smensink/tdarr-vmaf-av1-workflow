#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = '/app/server/Tdarr/DB2/SQL/database.db';
const backupPath = '/app/server/Tdarr/DB2/SQL/database.db.bak-maxsegments16-20260710';
const flowId = 'YR5PZ1QaD';
const desired = '16';
const apply = process.argv.includes('--apply');

const db = new DatabaseSync(dbPath);
const row = db.prepare('SELECT id, json_data FROM flowsjsondb WHERE id = ?').get(flowId);
if (!row) throw new Error(`Flow ${flowId} not found`);
const flow = JSON.parse(row.json_data);
const plugin = (flow.flowPlugins || []).find((item) => item.pluginName === 'extractVideoSamples');
if (!plugin) throw new Error('extractVideoSamples node not found');
plugin.inputsDB = plugin.inputsDB || {};
const previous = String(plugin.inputsDB.maxSegments || '');

if (!apply) {
  console.log(`Dry run: ${flowId} maxSegments ${previous || '(unset)'} -> ${desired}`);
  process.exit(0);
}

if (previous === desired) {
  console.log(`Live flow already has maxSegments=${desired}`);
  process.exit(0);
}

if (!fs.existsSync(backupPath)) {
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
}
plugin.inputsDB.maxSegments = desired;
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
const verifyPlugin = verify.flowPlugins.find((item) => item.pluginName === 'extractVideoSamples');
if (!verifyPlugin || String(verifyPlugin.inputsDB.maxSegments) !== desired) {
  throw new Error('Live-flow verification failed');
}
console.log(`Updated live flow ${flowId}: maxSegments ${previous} -> ${desired}`);
console.log(`Backup: ${backupPath}`);
