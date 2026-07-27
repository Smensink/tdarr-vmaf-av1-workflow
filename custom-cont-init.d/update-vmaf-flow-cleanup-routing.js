#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const dbPath = '/app/server/Tdarr/DB2/SQL/database.db';
const backupPath = '/app/server/Tdarr/DB2/SQL/database.db.bak-cleanup-routing-20260710';
const flowId = 'YR5PZ1QaD';
const apply = process.argv.includes('--apply');
const required = [
  { source: 'monitorRetry1', sourceHandle: '4', target: 'F1jkDv0qn', id: 'keep-original-to-cleanup' },
  { source: 'gpuLockReleaseError1', sourceHandle: '1', target: 'F1jkDv0qn', id: 'error-release-to-cleanup' },
  { source: 'hdr1', sourceHandle: '3', target: 'F1jkDv0qn', id: 'dynamic-hdr-to-cleanup' },
];
function addRoutes(flow) {
  flow.flowEdges = flow.flowEdges || [];
  var added = 0;
  required.forEach(function (route) {
    if (!flow.flowEdges.some(function (edge) { return edge.source === route.source && edge.sourceHandle === route.sourceHandle && edge.target === route.target; })) {
      flow.flowEdges.push({ source: route.source, sourceHandle: route.sourceHandle, target: route.target,
        targetHandle: null, id: route.id, animated: true, type: 'smoothstep' });
      added++;
    }
  });
  return added;
}
const db = new DatabaseSync(dbPath);
const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId);
if (!row) throw new Error(`Flow ${flowId} not found`);
const flow = JSON.parse(row.json_data);
const added = addRoutes(flow);
if (!apply) { console.log(`Dry run: add ${added} cleanup route(s)`); process.exit(0); }
if (added) {
  if (!fs.existsSync(backupPath)) db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE flowsjsondb SET json_data = ?, timestamp = ? WHERE id = ?').run(JSON.stringify(flow), Date.now(), flowId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
const saved = JSON.parse(db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId).json_data);
required.forEach(function (route) {
  if (!saved.flowEdges.some(function (edge) { return edge.source === route.source && edge.sourceHandle === route.sourceHandle && edge.target === route.target; })) {
    throw new Error(`Missing cleanup route ${route.id}`);
  }
});
console.log(`Cleanup routing active (added=${added})`);
if (added) console.log(`Backup: ${backupPath}`);
