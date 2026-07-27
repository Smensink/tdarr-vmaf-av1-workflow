#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = '/app/server/Tdarr/DB2/SQL/database.db';
const backupPath = '/app/server/Tdarr/DB2/SQL/database.db.bak-dv-hdr10-policy-20260711';
const flowId = 'YR5PZ1QaD';
const apply = process.argv.includes('--apply');
const db = new DatabaseSync(dbPath);
const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId);
if (!row) throw new Error(`Flow ${flowId} not found`);
const flow = JSON.parse(row.json_data);
const plugin = (flow.flowPlugins || []).find((item) => item.pluginName === 'checkHdrContent');
if (!plugin) throw new Error('checkHdrContent node not found');
plugin.inputsDB = plugin.inputsDB || {};
const previous = plugin.inputsDB.dynamicHdrPolicy;
const changed = previous !== 'profileAwareHdr10';
plugin.inputsDB.dynamicHdrPolicy = 'profileAwareHdr10';

if (!apply) {
  console.log(changed
    ? `Dry run: checkHdrContent.dynamicHdrPolicy: ${previous ?? '(unset)'} -> profileAwareHdr10`
    : 'Dry run: Dolby Vision HDR10 policy already current');
  process.exit(0);
}
if (changed) {
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
}
const saved = JSON.parse(db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId).json_data);
const savedPlugin = saved.flowPlugins.find((item) => item.pluginName === 'checkHdrContent');
if (!savedPlugin || savedPlugin.inputsDB?.dynamicHdrPolicy !== 'profileAwareHdr10') {
  throw new Error('Live-flow Dolby Vision policy verification failed');
}
console.log(changed ? `Updated live flow ${flowId}; backup: ${backupPath}` : 'Live flow Dolby Vision HDR10 policy already current');
