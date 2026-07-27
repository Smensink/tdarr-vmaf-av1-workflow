#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = '/app/server/Tdarr/DB2/SQL/database.db';
const backupPath = '/app/server/Tdarr/DB2/SQL/database.db.bak-retire-scene-heuristic-20260710';
const flowId = 'YR5PZ1QaD';
const apply = process.argv.includes('--apply');

function retire(flow) {
  const beforeNodes = (flow.flowPlugins || []).length;
  const beforeEdges = (flow.flowEdges || []).length;
  flow.flowPlugins = (flow.flowPlugins || []).filter((item) => item.id !== 'BCgj_9OBS' && item.pluginName !== 'detectSceneComplexity');
  flow.flowEdges = (flow.flowEdges || []).filter((edge) => edge.source !== 'BCgj_9OBS' && edge.target !== 'BCgj_9OBS');
  if (!flow.flowEdges.some((edge) => edge.source === 'meta1' && edge.target === 'extract1')) {
    flow.flowEdges.push({ source: 'meta1', sourceHandle: '1', target: 'extract1', targetHandle: null,
      id: 'metadata-to-extract-direct', animated: true, type: 'smoothstep' });
  }
  return { removedNodes: beforeNodes - flow.flowPlugins.length, removedEdges: beforeEdges - flow.flowEdges.length };
}

const db = new DatabaseSync(dbPath);
const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId);
if (!row) throw new Error(`Flow ${flowId} not found`);
const flow = JSON.parse(row.json_data);
const changes = retire(flow);
if (!apply) {
  console.log(`Dry run: remove ${changes.removedNodes} heuristic node(s), ${changes.removedEdges} edge(s)`);
  process.exit(0);
}
if (changes.removedNodes || changes.removedEdges) {
  if (!fs.existsSync(backupPath)) db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE flowsjsondb SET json_data = ?, timestamp = ? WHERE id = ?').run(JSON.stringify(flow), Date.now(), flowId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
const saved = JSON.parse(db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId).json_data);
if (saved.flowPlugins.some((item) => item.pluginName === 'detectSceneComplexity')
    || !saved.flowEdges.some((edge) => edge.source === 'meta1' && edge.target === 'extract1')) {
  throw new Error('Scene-heuristic retirement verification failed');
}
console.log(`Scene heuristic retired (removed nodes=${changes.removedNodes}, edges=${changes.removedEdges})`);
if (changes.removedNodes || changes.removedEdges) console.log(`Backup: ${backupPath}`);
