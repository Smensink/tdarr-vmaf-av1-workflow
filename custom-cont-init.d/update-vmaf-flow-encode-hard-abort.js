#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = '/app/server/Tdarr/DB2/SQL/database.db';
const backupPath = '/app/server/Tdarr/DB2/SQL/database.db.bak-disable-encode-hard-abort-20260713';
const flowId = 'YR5PZ1QaD';
const apply = process.argv.includes('--apply');
const desired = {
  encodeHardAbort: 'false',
  encodeHardAbortK: '4',
  encodeHardAbortMargin: '1.5',
};

const db = new DatabaseSync(dbPath);
const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId);
if (!row) throw new Error(`Flow ${flowId} not found`);
const flow = JSON.parse(row.json_data);
const plugin = (flow.flowPlugins || []).find((item) => item.pluginName === 'testEncodingParameters');
if (!plugin) throw new Error('testEncodingParameters node not found');
plugin.inputsDB = plugin.inputsDB || {};
const changes = [];
for (const [key, value] of Object.entries(desired)) {
  const previous = plugin.inputsDB[key];
  if (String(previous ?? '') !== value) {
    changes.push(`testEncodingParameters.${key}: ${previous ?? '(unset)'} -> ${value}`);
    plugin.inputsDB[key] = value;
  }
}

if (!apply) {
  console.log(changes.length ? `Dry run:\n${changes.join('\n')}` : 'Dry run: encode hard-abort is already disabled');
  process.exit(0);
}
if (!changes.length) {
  console.log('Live flow encode hard-abort is already disabled');
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
const verifiedPlugin = verify.flowPlugins.find((item) => item.pluginName === 'testEncodingParameters');
for (const [key, value] of Object.entries(desired)) {
  if (!verifiedPlugin || String(verifiedPlugin.inputsDB?.[key]) !== value) {
    throw new Error(`Live-flow verification failed for testEncodingParameters.${key}`);
  }
}
console.log(`Updated live flow ${flowId}:\n${changes.join('\n')}`);
console.log(`Backup: ${backupPath}`);
