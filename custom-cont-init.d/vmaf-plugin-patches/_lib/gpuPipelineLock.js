"use strict";

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var DEFAULT_LOCK_DIR = '/temp/tdarr-vmaf-gpu-pipeline.lock';

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

function configuredLockDir() {
    return path.resolve(process.env.TDARR_GPU_PIPELINE_LOCK_DIR || DEFAULT_LOCK_DIR);
}

function resolveLockDir(requestedPath) {
    var configured = configuredLockDir();
    var resolved = path.resolve(requestedPath || configured);
    if (resolved !== configured) {
        throw new Error('GPU pipeline lockDir must match the configured fixed path: ' + configured);
    }
    return resolved;
}

function isManagedRetiredPath(targetPath, lockDir) {
    var resolved = path.resolve(targetPath);
    var base = path.resolve(lockDir);
    return path.dirname(resolved) === path.dirname(base) &&
        (path.basename(resolved).indexOf(path.basename(base) + '.stale.') === 0 ||
         path.basename(resolved).indexOf(path.basename(base) + '.release.') === 0 ||
         path.basename(resolved).indexOf(path.basename(base) + '.failed.') === 0);
}

function removeManagedLockDir(targetPath, lockDir) {
    if (!targetPath || !fs.existsSync(targetPath)) {
        return;
    }
    if (!isManagedRetiredPath(targetPath, lockDir)) {
        throw new Error('Refusing to remove unmanaged GPU lock path: ' + targetPath);
    }
    var rootStat = fs.lstatSync(targetPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new Error('Refusing to remove non-directory or symlink GPU lock path: ' + targetPath);
    }
    var allowed = {
        'owner.json': true,
        'heartbeat.json': true
    };
    var entries = fs.readdirSync(targetPath);
    for (var i = 0; i < entries.length; i++) {
        if (!allowed[entries[i]]) {
            throw new Error('Refusing to remove unexpected GPU lock entry: ' + entries[i]);
        }
        var entryPath = path.join(targetPath, entries[i]);
        var stat = fs.lstatSync(entryPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error('Refusing to remove non-file or symlink GPU lock entry: ' + entryPath);
        }
    }
    for (var j = 0; j < entries.length; j++) {
        var managedEntryPath = path.join(targetPath, entries[j]);
        fs.unlinkSync(managedEntryPath);
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
        if (process.platform !== 'linux') {
            return isPidAlive(ownerPid);
        }
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

function writeHeartbeat(lockDir, token, leaseGeneration) {
    var heartbeat = {
        token: token,
        leaseGeneration: leaseGeneration,
        pid: process.pid,
        timestamp: nowIso()
    };
    fs.writeFileSync(path.join(lockDir, 'heartbeat.json'), JSON.stringify(heartbeat, null, 2));
}

function startHeartbeat(lockDir, token, leaseGeneration, intervalSeconds, ownerPid, ownerStartTime) {
    var interval = Math.max(5, Number(intervalSeconds) || 30);
    var script = [
        'var fs=require("fs");',
        'var path=require("path");',
        'var lockDir=process.argv[1];',
        'var token=process.argv[2];',
        'var generation=process.argv[3];',
        'var interval=Math.max(5,Number(process.argv[4])||30)*1000;',
        'var ownerPid=process.argv[5];',
        'var ownerStartTime=process.argv[6];',
        'function tick(){',
        '  try {',
        '    var owner=JSON.parse(fs.readFileSync(path.join(lockDir,"owner.json"),"utf8"));',
        '    if(owner.token!==token || owner.leaseGeneration!==generation){process.exit(0);}',
        '    if(ownerPid){',
        '      try{',
        '        var stat=fs.readFileSync("/proc/"+ownerPid+"/stat","utf8");',
        '        var cut=stat.lastIndexOf(")");',
        '        if(cut>0){var rest=stat.slice(cut+2).split(" ");var st=Number(rest[19]);',
        '          if(ownerStartTime && st!==Number(ownerStartTime)){process.exit(0);}',
        '        }}catch(e){process.exit(0);}',
        '    }',
        '    fs.writeFileSync(path.join(lockDir,"heartbeat.json"), JSON.stringify({token:token,leaseGeneration:generation,pid:process.pid,timestamp:new Date().toISOString()}, null, 2));',
        '  } catch(e) { process.exit(0); }',
        '}',
        'tick();',
        'setInterval(tick, interval);'
    ].join('\n');
    try {
        var child = childProcess.spawn(process.execPath, ['-e', script, lockDir, token,
            String(leaseGeneration), String(interval), String(ownerPid),
            String(ownerStartTime != null ? ownerStartTime : '')], {
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
    var created = false;
    try {
        fs.mkdirSync(lockDir);
        created = true;
        owner.token = owner.token || buildToken(owner.ownerId);
        owner.leaseGeneration = owner.leaseGeneration || buildToken('lease');
        owner.acquiredAt = nowIso();
        owner.heartbeatAt = owner.acquiredAt;
        owner.lockDir = lockDir;
        owner.pid = process.pid;
        // Record starttime of the acquiring process so future checks are container-restart safe.
        // starttime is set at exec() and survives container restarts — unlike PID numbers which
        // get recycled.  This is the authoritative signal that the original worker is still alive.
        owner.workerStartTime = getProcStartTime(process.pid);
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner, null, 2));
        writeHeartbeat(lockDir, owner.token, owner.leaseGeneration);
        var heartbeatPid = startHeartbeat(lockDir, owner.token, owner.leaseGeneration,
            opts.heartbeatIntervalSeconds || 30, owner.pid, owner.workerStartTime);
        if (heartbeatPid) {
            owner.heartbeatPid = heartbeatPid;
            owner.heartbeatAt = nowIso();
            fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner, null, 2));
            writeHeartbeat(lockDir, owner.token, owner.leaseGeneration);
        }
        return { acquired: true, owner: owner };
    } catch (err) {
        if (err && err.code === 'EEXIST') {
            return { acquired: false, owner: readOwner(lockDir), reason: 'held' };
        }
        if (created && fs.existsSync(lockDir)) {
            var failedPath = lockDir + '.failed.' + Date.now() + '.' + process.pid;
            try {
                fs.renameSync(lockDir, failedPath);
                removeManagedLockDir(failedPath, lockDir);
            } catch (_) {}
        }
        throw err;
    }
}

function tryAcquireOnce(opts) {
    opts = opts || {};
    var lockDir = resolveLockDir(opts.lockDir);
    return tryAcquire(lockDir, opts.owner || {}, opts);
}

function shouldBreakStale(lockDir, owner, opts) {
    var staleHeartbeatSeconds = Math.max(300, Number(opts.staleHeartbeatSeconds) || 7200);
    var maxLockAgeSeconds = Math.max(staleHeartbeatSeconds, Number(opts.maxLockAgeSeconds) || 28800);
    var orphanProcessGraceSeconds = Math.max(30, Number(opts.orphanProcessGraceSeconds) || 180);
    var hbAge = heartbeatAgeSeconds(lockDir, owner);
    var lockAge = owner && owner.acquiredAt ? secondsSinceIso(owner.acquiredAt) : null;

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
    // CASE 1: a confirmed-live owner is authoritative. Neither same-file identity
    // nor elapsed wall time is sufficient to revoke its lease.
    if (workerAlive === true) {
        return { stale: false, hbAge: hbAge, lockAge: lockAge, reason: 'owner worker identity is live' };
    }

    // Maintenance self-tests deliberately choose a non-stealable lease. If
    // their supervisor is hard-killed, an encoder child may still exist outside
    // the supervisor PID. Keep the lock fail-closed for manual recovery rather
    // than automatically overlapping unknown GPU work.
    if (owner && owner.automaticStaleBreakDisabled === true) {
        return {
            stale: false,
            hbAge: hbAge,
            lockAge: lockAge,
            reason: 'owner requires manual recovery after supervisor loss'
        };
    }

    // CASE 2: owner worker confirmed dead (PID recycled or genuinely gone)
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

    // CASE 3: owner PID unknown but heartbeat process definitely dead
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

    // CASE 4: heartbeat is still fresh — lock is live
    if (hbAge !== null && hbAge < staleHeartbeatSeconds) {
        return { stale: false, hbAge: hbAge, lockAge: lockAge, reason: 'heartbeat fresh' };
    }

    // CASE 5: heartbeat process still alive. Without a contradictory owner
    // identity signal, do not steal the lease.
    if (heartbeatPidAlive === true) {
        return { stale: false, hbAge: hbAge, lockAge: lockAge, reason: 'heartbeat process still alive' };
    }

    // CASE 6: inside overall safety window
    if (lockAge !== null && lockAge < maxLockAgeSeconds && hbAge !== null && hbAge < maxLockAgeSeconds) {
        return { stale: false, hbAge: hbAge, lockAge: lockAge, reason: 'inside max lock age safety window' };
    }

    // CASE 7: everything is stale and there is no live owner evidence
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
        removeManagedLockDir(stalePath, lockDir);
        return true;
    } catch (err) {
        return false;
    }
}

function acquireBlocking(opts) {
    opts = opts || {};
    var lockDir = resolveLockDir(opts.lockDir);
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

function sleepAsync(seconds) {
    var waitMs = Math.max(1, Number(seconds) || 1) * 1000;
    return new Promise(function(resolve) {
        setTimeout(resolve, waitMs);
    });
}

async function acquire(opts) {
    opts = opts || {};
    var lockDir = resolveLockDir(opts.lockDir);
    var owner = opts.owner || {};
    var waitPollSeconds = Math.max(1, Number(opts.waitPollSeconds) || 5);
    var waitLogSeconds = Math.max(waitPollSeconds, Number(opts.waitLogSeconds) || 60);
    var maxWaitSeconds = Math.max(waitPollSeconds, Number(opts.maxWaitSeconds) || 43200);
    var started = Date.now();
    var lastLog = 0;

    while (true) {
        var result = tryAcquire(lockDir, owner, opts);
        if (result.acquired) return result;

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
                opts.log('GPU pipeline lock appears stale (' + stale.reason + '). Retiring stale lease: ' +
                    describeOwner(existingOwner));
            }
            if (!breakStaleLock(lockDir)) {
                await sleepAsync(waitPollSeconds);
            }
            continue;
        }

        var elapsed = (Date.now() - started) / 1000;
        if (elapsed >= maxWaitSeconds) {
            throw new Error('Timed out waiting ' + Math.round(elapsed) +
                's for GPU pipeline lock held by ' + describeOwner(existingOwner));
        }
        if (opts.log && (Date.now() - lastLog >= waitLogSeconds * 1000)) {
            lastLog = Date.now();
            opts.log('GPU pipeline lock held by ' + describeOwner(existingOwner) +
                '; waiting asynchronously ' + Math.round(elapsed) + 's');
        }
        await sleepAsync(waitPollSeconds);
    }
}

// The lock lives on a Windows-backed bind mount, where the retire rename intermittently
// fails with EACCES/EPERM/EBUSY - typically right after acquire, while the freshly
// spawned heartbeat still has the directory open. The same flakiness can let the rename
// succeed but make the immediately following owner.json read fail, which surfaces as a
// null owner and reads exactly like a stolen lease. Both are transient and clear within
// milliseconds, but an unretried release leaves the lock held with no live owner - the
// GPU then sits idle behind a lease nobody will ever free. Retry those two shapes only;
// a real token or generation mismatch is a correctness signal and must never be retried.
var RELEASE_RETRY_ATTEMPTS = 5;
var RELEASE_RETRY_DELAY_MS = 100;
var TRANSIENT_RELEASE_ERROR_CODES = ['EACCES', 'EPERM', 'EBUSY', 'ENOTEMPTY'];

function isTransientReleaseFailure(result) {
    if (!result || result.released === true) return false;
    var reason = String(result.reason || '');
    if (reason.indexOf('atomic release failed:') === 0) {
        for (var i = 0; i < TRANSIENT_RELEASE_ERROR_CODES.length; i++) {
            if (reason.indexOf(TRANSIENT_RELEASE_ERROR_CODES[i]) !== -1) return true;
        }
        return false;
    }
    // A verified-away lease reports the owner it found; a transient read reports none.
    return reason === 'lease changed during release' && !result.owner;
}

function sleepMsBusy(ms) {
    var until = Date.now() + ms;
    while (Date.now() < until) { /* release must stay synchronous for finally blocks */ }
}

function release(lockDir, expectedToken, opts) {
    var result = releaseOnce(lockDir, expectedToken, opts);
    for (var attempt = 1; attempt < RELEASE_RETRY_ATTEMPTS &&
        isTransientReleaseFailure(result); attempt++) {
        sleepMsBusy(RELEASE_RETRY_DELAY_MS);
        result = releaseOnce(lockDir, expectedToken, opts);
    }
    return result;
}

function releaseOnce(lockDir, expectedToken, opts) {
    lockDir = resolveLockDir(lockDir);
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
    var expectedGeneration = opts && opts.expectedGeneration;
    if (expectedGeneration && owner.leaseGeneration !== expectedGeneration && !force) {
        return {
            released: false,
            reason: 'lease generation mismatch',
            owner: owner
        };
    }
    var retiredPath = lockDir + '.release.' + Date.now() + '.' + process.pid;
    var renamed = false;
    try {
        fs.renameSync(lockDir, retiredPath);
        renamed = true;
        var retiredOwner = readOwner(retiredPath);
        if (!force && (!retiredOwner || retiredOwner.token !== expectedToken ||
                (expectedGeneration && retiredOwner.leaseGeneration !== expectedGeneration))) {
            if (!fs.existsSync(lockDir)) fs.renameSync(retiredPath, lockDir);
            return { released: false, reason: 'lease changed during release', owner: retiredOwner };
        }
        removeManagedLockDir(retiredPath, lockDir);
        return { released: true, owner: retiredOwner };
    } catch (error) {
        if (renamed && fs.existsSync(retiredPath) && !fs.existsSync(lockDir)) {
            try { fs.renameSync(retiredPath, lockDir); } catch (_) {}
        }
        return { released: false, reason: 'atomic release failed: ' + error.message, owner: owner };
    }
}

module.exports = {
    acquire: acquire,
    acquireBlocking: acquireBlocking,
    tryAcquireOnce: tryAcquireOnce,
    release: release,
    readOwner: readOwner,
    describeOwner: describeOwner,
    heartbeatAgeSeconds: heartbeatAgeSeconds,
    sleepSeconds: sleepSeconds,
    getProcStartTime: getProcStartTime,
    isWorkerAliveInContainer: isWorkerAliveInContainer,
    resolveLockDir: resolveLockDir
};
