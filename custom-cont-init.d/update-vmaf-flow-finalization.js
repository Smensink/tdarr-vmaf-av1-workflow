#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = '/app/server/Tdarr/DB2/SQL/database.db';
const backupPath = '/app/server/Tdarr/DB2/SQL/database.db.bak-gpu-finalizer-20260710';
const flowId = 'YR5PZ1QaD';
const apply = process.argv.includes('--apply');

function ensureFinalizer(flow) {
  flow.flowPlugins = flow.flowPlugins || [];
  flow.flowEdges = flow.flowEdges || [];
  let addedNodes = 0;
  let addedEdges = 0;
  if (!flow.flowPlugins.some((item) => item.id === 'gpuLockErrorHandler1')) {
    flow.flowPlugins.push({
      name: 'On Flow Error - Release GPU Lock', sourceRepo: 'Community', pluginName: 'onFlowError',
      version: '1.0.0', fpEnabled: true, id: 'gpuLockErrorHandler1', position: { x: 760, y: 840 }
    });
    addedNodes += 1;
  }
  if (!flow.flowPlugins.some((item) => item.id === 'gpuLockReleaseError1')) {
    flow.flowPlugins.push({
      name: 'Release GPU Lock After Error', sourceRepo: 'Local', pluginName: 'releaseGpuPipelineLock',
      version: '1.0.0', fpEnabled: true, id: 'gpuLockReleaseError1', position: { x: 760, y: 920 }
    });
    addedNodes += 1;
  }
  if (!flow.flowEdges.some((edge) => edge.source === 'gpuLockErrorHandler1' && edge.target === 'gpuLockReleaseError1')) {
    flow.flowEdges.push({
      source: 'gpuLockErrorHandler1', sourceHandle: '1', target: 'gpuLockReleaseError1', targetHandle: null,
      id: 'gpu-lock-error-finalizer', animated: true, type: 'smoothstep'
    });
    addedEdges += 1;
  }
  return { addedNodes, addedEdges };
}

const db = new DatabaseSync(dbPath);
const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(flowId);
if (!row) throw new Error(`Flow ${flowId} not found`);
const flow = JSON.parse(row.json_data);
const changes = ensureFinalizer(flow);
if (!apply) {
  console.log(`Dry run: add ${changes.addedNodes} finalizer nodes and ${changes.addedEdges} edge(s)`);
  process.exit(0);
}
if (changes.addedNodes || changes.addedEdges) {
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
const handler = saved.flowPlugins.some((item) => item.id === 'gpuLockErrorHandler1' && item.pluginName === 'onFlowError');
const release = saved.flowPlugins.some((item) => item.id === 'gpuLockReleaseError1' && item.pluginName === 'releaseGpuPipelineLock');
const edge = saved.flowEdges.some((item) => item.source === 'gpuLockErrorHandler1' && item.target === 'gpuLockReleaseError1');
const outgoing = saved.flowEdges.some((item) => item.source === 'gpuLockReleaseError1');
if (!handler || !release || !edge || outgoing) throw new Error('GPU error-finalizer verification failed');
console.log(`GPU error finalizer active (added nodes=${changes.addedNodes}, edges=${changes.addedEdges})`);
if (changes.addedNodes || changes.addedEdges) console.log(`Backup: ${backupPath}`);
