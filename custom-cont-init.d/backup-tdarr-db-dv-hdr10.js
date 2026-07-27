#!/bin/sh
':' //; exit 0
'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = '/app/server/Tdarr/DB2/SQL/database.db';
const backupPath = '/app/server/Tdarr/DB2/SQL/database.db.bak-dv-hdr10-requeue-20260711';
const db = new DatabaseSync(dbPath);
if (!fs.existsSync(backupPath)) {
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  console.log(`Created live Tdarr database backup: ${backupPath}`);
} else {
  console.log(`Live Tdarr database backup already exists: ${backupPath}`);
}
const check = new DatabaseSync(backupPath, { readOnly: true });
const result = check.prepare('PRAGMA integrity_check').get();
if (!result || result.integrity_check !== 'ok') throw new Error(`Backup integrity check failed: ${JSON.stringify(result)}`);
console.log('Backup integrity_check: ok');
