"use strict";

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

function nowIso() {
    return new Date().toISOString();
}

function safeJsonRead(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        return null;
    }
}

function safeMkdirParent(targetPath) {
    var parent = path.dirname(targetPath);
    if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
    }
}

function removeDirRecursive(targetPath) {
    if (!targetPath || !fs.existsSync(targetPath)) {
        return;
    }
    if (fs.rmSync) {
        fs.rmSync(targetPath, { recursive: true, force: true });
        return;
    }
    var entries = fs.readdirSync(targetPath);
    for (var i = 0; i < entries.length; i++) {
        var entryPath = path.join(targetPath, entries[i]);
        var stat = fs.lstatSync(entryPath);
        if (stat.isDirectory()) {
            removeDirRecursive(entryPath);
        } else {
            fs.unlinkSync(entryPath);
        }
    }
    fs.rmdirSync(targetPath);
}

function sleepSeconds(seconds) {
    var waitMs = Math.max(1, Number(seconds) || 1) * 1000;
    if (typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined' && Atomics.wait) {
        var sab = new SharedArrayBuffer(4);
        var int32 = new Int32Array(sab);
        Atomics.wait(int32, 0, 0, waitMs);
        return;
    }
    childProcess.execFileSync('sleep', [String(Math.ceil(waitMs / 1000))]);
}

/**
 * Check if a PID is alive USING PROCESS START TIME as the identity signal.
 * Plain `kill(pid, 0)` returns true for PIDs recycled after a container restart,
 * because the new process inherits the number.  starttime is set by the kernel at
 * exec() and is unique within the PID namespace for the lifetime of the system,
 * so it correctly distinguishes "the original Tdarr worker" from "some unrelated
 * process that happens to have taken the same PID number".
 *
 * We check the ownerPid specifically (the Tdarr worker), not the heartbeat
 * subprocess PID, because the heartbeat is designed to outlive the worker — it runs
 * detached. The ownerPid is what actually does the GPU work and must be alive.
 */
function getProcStartTime(pid) {
    var n = Number(pid);
    if (!Number.isFinite(n) || n <= 0) {
        return null;
    }
    try {
        // /proc/<pid>/stat format: pid comm state ppid pgrp session tty tpgid flags
        // minflt cminflt umask cminflt2 majflt cmajflt utime stime cutime cstime
        // priority nice num_threads itrealvalue starttime  <-- field 22 (1-based)
        // vsize rss ...
        // Fields are space-separated.  comm (field 2) is enclosed in parens and may
        // contain spaces, so find the last ')' to locate where field 2 ends.
        var stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        var lastParen = stat.lastIndexOf(')');
        if (lastParen < 0) return null;
        var after = stat.slice(lastParen + 2); // skip ') '
        var fields = after.split(' ');
        // after='state ppid pgrp ... starttime vsize rss ...'
        // starttime is at index 19 (0-based) in the after string's field array
        var starttime = Number(fields[19]);
        return Number.isFinite(starttime) ? starttime : null;
    } catch (err) {
        return null;
    }
}

/**
 * Container-scoped PID liveness check using starttime.
 * The ownerPid is the actual Tdarr worker that holds the GPU lock.
 * Even if PID 2996 exists in the new container, if its starttime differs from
 * the starttime recorded when the lock was acquired, the original worker is gone.
 */
function isWorkerAliveInContainer(ownerPid, ownerStartTime) {
    if (!ownerPid || !Number.isFinite(Number(ownerPid)) || Number(ownerPid) <= 0) {
        return null;
    }
    var currentStartTime = getProcStartTime(ownerPid);
    if (currentStartTime === null) {
        // PID doesn't exist in this container's PID namespace
        return false;
    }
    if (ownerStartTime === undefined || ownerStartTime === null) {
        // No starttime recorded — fall back to basic liveness
        return true;
    }
    // Same PID number AND same starttime → original worker still alive
    // Same PID number but DIFFERENT starttime → PID was recycled (container restarted)
    return currentStartTime === ownerStartTime;
}

function isPidAlive(pid) {
    var n = Number(pid);
    if (!Number.isFinite(n) || n <= 0) {
        return false;
    }
    try {
        process.kill(n, 0);
        return true;
    } catch (err) {
        return false;
    }
}

function buildToken(ownerId) {
    var seed = String(ownerId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
    return seed + '-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
}

function readOwner(lockDir) {
    return safeJsonRead(path.join(lockDir, 'owner.json'));
}

function readHeartbeat(lockDir) {
    return safeJsonRead(path.join(lockDir, 'heartbeat.json'));
}

function describeOwner(owner) {
    if (!owner) {
        return 'unknown owner';
    }
    var parts = [];
    if (owner.ownerId) {
        parts.push(owner.ownerId);
    }
    if (owner.workerName) {
        parts.push('worker=' + owner.workerName);
    }
    if (owner.filePath) {
        parts.push('file=' + owner.filePath);
    }
    if (owner.acquiredAt) {
        parts.push('acquired=' + owner.acquiredAt);
    }
    return parts.length > 0 ? parts.join(' | ') : 'unknown owner';
}

function secondsSinceIso(ts) {
    if (!ts) {
        return null;
    }
    var t = Date.parse(ts);
    if (!Number.isFinite(t)) {
        return null;
    }
    return Math.max(0, (Date.now() - t) / 1000);
}

function heartbeatAgeSeconds(lockDir, owner) {
    var heartbeat = readHeartbeat(lockDir);
    if (heartbeat && heartbeat.timestamp) {
        return secondsSinceIso(heartbeat.timestamp);
    }
    if (owner && owner.heartbeatAt) {
        return secondsSinceIso(owner.heartbeatAt);
    }
    if (owner && owner.acquiredAt) {
        return secondsSinceIso(owner.acquiredAt);
    }
    return null;
}

function writeHeartbeat(lockDir, token) {
    var heartbeat = {
        token: token,
        pid: process.pid,
        timestamp: nowIso()
    };
    fs.writeFileSync(path.join(lockDir, 'heartbeat.json'), JSON.stringify(heartbeat, null, 2));
}

function startHeartbeat(lockDir, token, intervalSeconds, ownerPid, ownerStartTime, maxLockAgeSeconds) {
    var interval = Math.max(5, Number(intervalSeconds) || 30);
    var maxAgeMs = Math.max(3600, Number(maxLockAgeSeconds) || 28800) * 1000;
    var script = [
        'var fs=require("fs");',
        'var path=require("path");',
        'var lockDir=process.argv[1];',
        'var token=process.argv[2];',
        'var interval=Math.max(5,Number(process.argv[3])||30)*1000;',
        'var ownerPid=process.argv[4];',
        'var ownerStartTime=process.argv[5];',
        'var maxAgeMs=Number(process.argv[6])||28800000;',
        // Self-expire at the lock age ceiling: heartbeat freshness must never keep a lock
        // alive past maxLockAge (the heartbeat only proves the node process is alive, not
        // the owning job — see the 2026-07-04 stuck-lock incident).
        'var t=setTimeout(function(){process.exit(0);}, maxAgeMs); if (t.unref) t.unref();',
        'function tick(){',
        '  try {',
        '    var owner=JSON.parse(fs.readFileSync(path.join(lockDir,"owner.json"),"utf8"));',
        '    if(owner.token!==token){process.exit(0);}',
        '    if(ownerPid){',
        '      try{',
        '        var stat=fs.readFileSync("/proc/"+ownerPid+"/stat","utf8");',
        '        var m=stat.match(/^\\d+ \\([^)]+\\) (.+)$/);',
        '        if(m){var rest=m[1].split(" ");var st=Number(rest[19]);',
        '          if(ownerStartTime && st!==Number(ownerStartTime)){process.exit(0);}',
        '        }}catch(e){process.exit(0);}',
        '    }',
        '    fs.writeFileSync(path.join(lockDir,"heartbeat.json"), JSON.stringify({token:token,pid:process.pid,timestamp:new Date().toISOString()}, null, 2));',
        '  } catch(e) { process.exit(0); }',
        '}',
        'tick();',
        'setInterval(tick, interval);'
    ].join('\n');
    try {
        var child = childProcess.spawn(process.execPath, ['-e', script, lockDir, token, String(interval), String(ownerPid), String(ownerStartTime != null ? ownerStartTime : ''), String(maxAgeMs)], {
            detached: true,
            stdio: 'ignore'
        });
        child.unref();
        return child.pid;
    } catch (err) {
        return null;
    }
}

function tryAcquire(lockDir, owner, opts) {
    safeMkdirParent(lockDir);
    try {
        fs.mkdirSync(lockDir);
        owner.token = owner.token || buildToken(owner.ownerId);
        owner.acquiredAt = nowIso();
        owner.heartbeatAt = owner.acquiredAt;
        owner.lockDir = lockDir;
        owner.pid = process.pid;
        // Record starttime of the acquiring process so future checks are container-restart safe.
        // starttime is set at exec() and survives container restarts — unlike PID numbers which
        // get recycled.  This is the authoritative signal that the original worker is still alive.
        owner.workerStartTime = getProcStartTime(process.pid);
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner, null, 2));
        writeHeartbeat(lockDir, owner.token);
        var heartbeatPid = startHeartbeat(lockDir, owner.token, opts.heartbeatIntervalSeconds || 30, owner.pid, owner.workerStartTime, opts.maxLockAgeSeconds);
        if (heartbeatPid) {
            owner.heartbeatPid = heartbeatPid;
            owner.heartbeatAt = nowIso();
            fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner, null, 2));
            writeHeartbeat(lockDir, owner.token);
        }
        return { acquired: true, owner: owner };
    } catch (err) {
        if (err && err.code === 'EEXIST') {
            return { acquired: false, owner: readOwner(lockDir), reason: 'held' };
        }
        throw err;
    }
}

function shouldBreakStale(lockDir, owner, opts) {
    var staleHeartbeatSeconds = Math.max(300, Number(opts.staleHeartbeatSeconds) || 7200);
    var maxLockAgeSeconds = Math.max(staleHeartbeatSeconds, Number(opts.maxLockAgeSeconds) || 28800);
    var orphanProcessGraceSeconds = Math.max(30, Number(opts.orphanProcessGraceSeconds) || 180);
    var hbAge = heartbeatAgeSeconds(lockDir, owner);
    var lockAge = owner && owner.acquiredAt ? secondsSinceIso(owner.acquiredAt) : null;

    // ── CASE 0a: same-file takeover ────────────────────────────────────────────
    // Tdarr never processes one file in two workers concurrently, so if THIS waiter
    // is working on the same file the lock owner recorded, the owning job is dead
    // (crashed worker / server requeue) — its detached heartbeat says nothing about
    // job liveness because owner.pid is the long-lived shared node process.
    // 2026-07-04 incident: a worker died hard during a server-connection outage,
    // Tdarr requeued the same file, and the new attempt waited 12h on its own dead
    // predecessor's lock while the heartbeat stayed "fresh" the whole time.
    var requester = opts.owner || {};
    if (owner && requester.filePath && owner.filePath &&
            String(requester.filePath) === String(owner.filePath)) {
        return {
            stale: true,
            hbAge: hbAge,
            lockAge: lockAge,
            reason: 'lock owned by a previous attempt of THIS file (same-file takeover; the owning job cannot still be running)'
        };
    }

    // ── CASE 0b: hard age ceiling ──────────────────────────────────────────────
    // maxLockAgeSeconds is an absolute ceiling. A fresh heartbeat must NOT override
    // it: the heartbeat process only proves the node is alive, not the owning job
    // (it runs detached and owner.pid is the shared node process, so a job that died
    // without releasing keeps a "fresh" heartbeat until the container restarts).
    if (lockAge !== null && lockAge >= maxLockAgeSeconds) {
        return {
            stale: true,
            hbAge: hbAge,
            lockAge: lockAge,
            reason: 'lock age ' + Math.round(lockAge) + 's exceeds hard ceiling ' + maxLockAgeSeconds + 's (heartbeat freshness does not prove the owning job is alive)'
        };
    }

    // ── Container-restart-safe worker liveness check ──────────────────────────
    // Use starttime comparison for the owner PID.  This is the primary signal.
    // A plain isPidAlive() check passes for recycled PIDs — the new container's
    // Tdarr process can hold the same PID number as the crashed one, making the
    // lock appear live when the original worker is actually gone.
    var workerAlive = null;
    if (owner && owner.pid) {
        workerAlive = isWorkerAliveInContainer(owner.pid, owner.workerStartTime);
    }
    // heartbeatPid is the detached node subprocess — it is allowed to outlive the
    // worker (it runs independently).  Only check it when owner.pid is absent.
    var heartbeatPidAlive = owner && owner.heartbeatPid ? isPidAlive(owner.heartbeatPid) : null;

    // ── Stale lock decision tree ───────────────────────────────────────────────
    // CASE 1: owner worker confirmed dead (PID recycled or genuinely gone)
    if (workerAlive === false) {
        return {
            stale: true,
            hbAge: hbAge,
            lockAge: lockAge,
            reason: 'owner worker process ' +
                (owner.workerStartTime !== undefined ? '(starttime mismatch — PID recycled after restart)' : '(PID does not exist)') +
                ' ownerPid=' + owner.pid +
                (heartbeatPidAlive === true ? ' orphan heartbeat ignored' : '')
        };
    }

    // CASE 2: owner PID unknown but heartbeat process definitely dead
    // (this handles the rare case where neither owner.pid nor workerStartTime were recorded)
    if (workerAlive === null && heartbeatPidAlive === false &&
            (hbAge === null || hbAge >= orphanProcessGraceSeconds) &&
            (lockAge === null || lockAge >= orphanProcessGraceSeconds)) {
        return {
            stale: true,
            hbAge: hbAge,
            lockAge: lockAge,
            reason: 'owner process unknown and heartbeat process exited'
        };
    }

    // CASE 3: heartbeat is still fresh — lock is live
    if (hbAge !== null && hbAge < staleHeartbeatSeconds) {
        return { stale: false, hbAge: hbAge, lockAge: lockAge, reason: 'heartbeat fresh' };
    }

    // CASE 4: heartbeat process still alive and lock is within safety window
    if (heartbeatPidAlive === true && lockAge !== null && lockAge < maxLockAgeSeconds) {
        return { stale: false, hbAge: hbAge, lockAge: lockAge, reason: 'heartbeat process still alive' };
    }

    // CASE 5: inside overall safety window
    if (lockAge !== null && lockAge < maxLockAgeSeconds && hbAge !== null && hbAge < maxLockAgeSeconds) {
        return { stale: false, hbAge: hbAge, lockAge: lockAge, reason: 'inside max lock age safety window' };
    }

    // CASE 6: everything is stale
    return {
        stale: true,
        hbAge: hbAge,
        lockAge: lockAge,
        reason: 'heartbeat stale' + (readHeartbeat(lockDir) && readHeartbeat(lockDir).timestamp ? '' : ' or missing')
    };
}

function breakStaleLock(lockDir) {
    var stalePath = lockDir + '.stale.' + Date.now() + '.' + process.pid;
    try {
        fs.renameSync(lockDir, stalePath);
        removeDirRecursive(stalePath);
        return true;
    } catch (err) {
        return false;
    }
}

function acquireBlocking(opts) {
    var lockDir = opts.lockDir || '/temp/tdarr-vmaf-gpu-pipeline.lock';
    var owner = opts.owner || {};
    var waitPollSeconds = Math.max(1, Number(opts.waitPollSeconds) || 5);
    var waitLogSeconds = Math.max(waitPollSeconds, Number(opts.waitLogSeconds) || 60);
    var maxWaitSeconds = Math.max(waitPollSeconds, Number(opts.maxWaitSeconds) || 43200);
    var started = Date.now();
    var lastLog = 0;

    while (true) {
        var result = tryAcquire(lockDir, owner, opts);
        if (result.acquired) {
            return result;
        }

        var existingOwner = result.owner;
        if (opts.existingToken && existingOwner && existingOwner.token === opts.existingToken) {
            result.acquired = true;
            result.reentrant = true;
            result.owner = existingOwner;
            return result;
        }

        var stale = shouldBreakStale(lockDir, existingOwner, opts);
        if (stale.stale) {
            if (opts.log) {
                opts.log('GPU pipeline lock appears stale (' + stale.reason + '; heartbeat age=' +
                    (stale.hbAge === null ? 'unknown' : Math.round(stale.hbAge) + 's') +
                    ', lock age=' + (stale.lockAge === null ? 'unknown' : Math.round(stale.lockAge) + 's') +
                    '). Breaking stale lock: ' + describeOwner(existingOwner));
            }
            breakStaleLock(lockDir);
            continue;
        }

        var elapsed = (Date.now() - started) / 1000;
        if (elapsed >= maxWaitSeconds) {
            throw new Error('Timed out waiting ' + Math.round(elapsed) + 's for GPU pipeline lock held by ' + describeOwner(existingOwner));
        }

        if (opts.log && (Date.now() - lastLog >= waitLogSeconds * 1000)) {
            lastLog = Date.now();
            opts.log('GPU pipeline lock held by ' + describeOwner(existingOwner) +
                '; waiting ' + Math.round(elapsed) + 's' +
                (stale.hbAge === null ? '' : ' (heartbeat age ' + Math.round(stale.hbAge) + 's)'));
        }
        sleepSeconds(waitPollSeconds);
    }
}

function release(lockDir, expectedToken, opts) {
    var owner = readOwner(lockDir);
    if (!owner) {
        return { released: false, reason: 'no lock owner found' };
    }
    var force = !!(opts && opts.force);
    if (!expectedToken && !force) {
        return {
            released: false,
            reason: 'missing owner token',
            owner: owner
        };
    }
    if (owner.token !== expectedToken && !force) {
        return {
            released: false,
            reason: 'lock owned by another job',
            owner: owner
        };
    }
    removeDirRecursive(lockDir);
    return { released: true, owner: owner };
}

module.exports = {
    acquireBlocking: acquireBlocking,
    release: release,
    readOwner: readOwner,
    describeOwner: describeOwner,
    heartbeatAgeSeconds: heartbeatAgeSeconds,
    sleepSeconds: sleepSeconds,
    getProcStartTime: getProcStartTime,
    isWorkerAliveInContainer: isWorkerAliveInContainer
};
