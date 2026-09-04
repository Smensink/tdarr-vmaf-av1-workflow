#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const FLOW_ID = 'YR5PZ1QaD';
const RELEASE_ID = 'gpuLockReleaseSamples1';
const RELEASE_EDGE_ID = 'edgeLockA_release_to_vmaf';
const DB_PATH = process.env.TDARR_SQL_DB || '/app/server/Tdarr/DB2/SQL/database.db';
const APPLY_ENV = 'ALLOW_TDARR_NVENC_LOCK_SCOPE_MIGRATION';

function createBackup(db) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const backup = process.env.TDARR_NVENC_LOCK_SCOPE_BACKUP ||
    `${DB_PATH}.bak-nvenc-lock-scope-${stamp}-${process.pid}`;
  if (fs.existsSync(backup)) throw new Error(`refusing to overwrite migration backup: ${backup}`);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  return backup;
}

function applyNvencLockScope(flow) {
  const plugins = Array.isArray(flow.flowPlugins) ? flow.flowPlugins : [];
  const edges = Array.isArray(flow.flowEdges) ? flow.flowEdges : [];
  const test = plugins.find((item) => item.id === 'test1' && item.pluginName === 'testEncodingParameters');
  const vmaf = plugins.find((item) => item.id === 'vmaf1' && item.pluginName === 'calculateVMAF');
  if (!test || !vmaf) throw new Error('canonical test1/vmaf1 nodes are missing');

  let release = plugins.find((item) => item.id === RELEASE_ID);
  if (release && release.pluginName !== 'releaseGpuPipelineLock') {
    throw new Error(`${RELEASE_ID} collides with ${release.pluginName || 'unknown plugin'}`);
  }
  if (!release) {
    release = {
      name: 'Release NVENC Lock After Sample Encoding',
      sourceRepo: 'Local',
      pluginName: 'releaseGpuPipelineLock',
      version: '1.0.0',
      inputsDB: {
        lockDir: '/transcode-cache/tdarr-vmaf-gpu-pipeline.lock',
        forceRelease: 'false',
      },
      fpEnabled: true,
      id: RELEASE_ID,
      position: { x: 560, y: 600 },
    };
    plugins.push(release);
  }

  const direct = edges.filter((edge) => edge.source === 'test1' && edge.target === 'vmaf1');
  const toRelease = edges.filter((edge) => edge.source === 'test1' && edge.target === RELEASE_ID);
  if (direct.length > 1 || toRelease.length > 1) {
    throw new Error('ambiguous sample-encode success routing');
  }
  if (direct.length === 1) direct[0].target = RELEASE_ID;
  else if (toRelease.length === 0) {
    edges.push({
      source: 'test1', sourceHandle: '1', target: RELEASE_ID, targetHandle: null,
      id: 'edgeLockA_release_in', animated: true, type: 'smoothstep',
    });
  }

  const releaseEdges = edges.filter((edge) => edge.source === RELEASE_ID && edge.target === 'vmaf1');
  if (releaseEdges.length > 1) throw new Error('ambiguous release-to-VMAF routing');
  if (releaseEdges.length === 0) {
    edges.push({
      source: RELEASE_ID, sourceHandle: '1', target: 'vmaf1', targetHandle: null,
      id: RELEASE_EDGE_ID, animated: true, type: 'smoothstep',
    });
  }

  flow.flowPlugins = plugins;
  flow.flowEdges = edges;
  return flow;
}

function verifyNvencLockScope(flow) {
  const plugins = Array.isArray(flow.flowPlugins) ? flow.flowPlugins : [];
  const edges = Array.isArray(flow.flowEdges) ? flow.flowEdges : [];
  const release = plugins.filter((item) => item.id === RELEASE_ID && item.pluginName === 'releaseGpuPipelineLock');
  const direct = edges.filter((edge) => edge.source === 'test1' && edge.target === 'vmaf1');
  const into = edges.filter((edge) => edge.source === 'test1' && edge.target === RELEASE_ID);
  const out = edges.filter((edge) => edge.source === RELEASE_ID && edge.target === 'vmaf1');
  if (release.length !== 1 || direct.length !== 0 || into.length !== 1 || out.length !== 1) {
    throw new Error('NVENC sample-lock release graph is not exact');
  }
  return true;
}

function main() {
  const apply = process.argv.includes('--apply');
  if (process.env[APPLY_ENV] !== '1' || !apply) {
    console.log(`[flow migration] SKIP: explicit ${APPLY_ENV}=1 and --apply required`);
    return { applied: false, changed: false };
  }

  const db = new DatabaseSync(DB_PATH);
  try {
    const row = db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(FLOW_ID);
    if (!row) throw new Error(`Flow ${FLOW_ID} not found`);
    const before = JSON.parse(row.json_data);
    const after = applyNvencLockScope(JSON.parse(JSON.stringify(before)));
    verifyNvencLockScope(after);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    let backup = null;
    if (changed) {
      backup = createBackup(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE flowsjsondb SET json_data = ?, timestamp = ? WHERE id = ?')
          .run(JSON.stringify(after), Date.now(), FLOW_ID);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    const saved = JSON.parse(db.prepare('SELECT json_data FROM flowsjsondb WHERE id = ?').get(FLOW_ID).json_data);
    verifyNvencLockScope(saved);
    console.log(`NVENC sample-lock scope active (changed=${changed}${backup ? `, backup=${backup}` : ''})`);
    return { applied: true, changed, backup };
  } finally {
    db.close();
  }
}

module.exports = { APPLY_ENV, DB_PATH, RELEASE_ID, applyNvencLockScope, main, verifyNvencLockScope };
if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}
