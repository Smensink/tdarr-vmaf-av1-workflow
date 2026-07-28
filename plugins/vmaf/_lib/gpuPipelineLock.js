"use strict";

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var DEFAULT_LOCK_DIR = '/temp/tdarr-vmaf-gpu-pipeline.lock';
var atomicWriteCounter = 0;

function nowIso() {
    return new Date().toISOString();
}

function safeJsonRead(filePath) {
    try {
        var stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        return null;
    }
}

function atomicJsonWrite(filePath, value) {
    var parent = path.dirname(filePath);
    var tempName = '.tdarr-gpu-lock-tmp.' + process.pid + '.' + Date.now() + '.' +
        (++atomicWriteCounter) + '.json';
    var tempPath = path.join(parent, tempName);
    var fd = null;
    try {
        fd = fs.openSync(tempPath, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(value, null, 2), { encoding: 'utf8' });
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tempPath, filePath);
    } catch (err) {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (_) {}
        }
        try {
            var tempStat = fs.lstatSync(tempPath);
            if (tempStat.isFile() && !tempStat.isSymbolicLink()) {
                fs.unlinkSync(tempPath);
            }
        } catch (_) {}
        throw err;
    }
}

function readDirectoryIdentity(targetPath) {
    var stat = fs.lstatSync(targetPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('GPU pipeline lock path is not a real directory: ' + targetPath);
    }
    return {
        dev: String(stat.dev),
        ino: String(stat.ino),
        birthtimeMs: Number(stat.birthtimeMs) || 0
    };
}

function sameDirectoryIdentity(targetPath, expected) {
    if (!expected) return false;
    try {
        var current = readDirectoryIdentity(targetPath);
        if (current.dev !== expected.dev || current.ino !== expected.ino) {
            return false;
        }
        if (current.ino === '0' && expected.birthtimeMs > 0 &&
                current.birthtimeMs !== expected.birthtimeMs) {
            return false;
        }
        return true;
    } catch (_) {
        return false;
    }
}

function directoryAgeSeconds(targetPath) {
    try {
        var stat = fs.lstatSync(targetPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        var timestamp = Number(stat.mtimeMs) || Number(stat.ctimeMs) || Number(stat.birthtimeMs);
        if (!Number.isFinite(timestamp)) return null;
        return Math.max(0, (Date.now() - timestamp) / 1000);
    } catch (_) {
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
        var isAtomicTemp = /^\.tdarr-gpu-lock-tmp\.\d+\.\d+\.\d+\.json$/.test(entries[i]);
        if (!allowed[entries[i]] && !isAtomicTemp) {
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
    atomicJsonWrite(path.join(lockDir, 'heartbeat.json'), heartbeat);
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
        'var counter=0;',
        'function identity(){',
        '  try{var s=fs.lstatSync(lockDir);if(!s.isDirectory()||s.isSymbolicLink())return null;',
        '    return {dev:String(s.dev),ino:String(s.ino),birthtimeMs:Number(s.birthtimeMs)||0};}catch(e){return null;}',
        '}',
        'var initialIdentity=identity();',
        'if(!initialIdentity){process.exit(0);}',
        'function sameIdentity(){var current=identity();if(!current)return false;',
        '  if(current.dev!==initialIdentity.dev||current.ino!==initialIdentity.ino)return false;',
        '  return !(current.ino==="0"&&initialIdentity.birthtimeMs>0&&current.birthtimeMs!==initialIdentity.birthtimeMs);',
        '}',
        'function atomicHeartbeat(){',
        '  var target=path.join(lockDir,"heartbeat.json");',
        '  var temp=path.join(lockDir,".tdarr-gpu-lock-tmp."+process.pid+"."+Date.now()+"."+(++counter)+".json");',
        '  var fd=null;',
        '  try{',
        '    if(!sameIdentity())throw new Error("lock directory identity changed");',
        '    var current=JSON.parse(fs.readFileSync(path.join(lockDir,"owner.json"),"utf8"));',
        '    if(current.token!==token||current.leaseGeneration!==generation)throw new Error("lease changed");',
        '    fd=fs.openSync(temp,"wx",0o600);',
        '    fs.writeFileSync(fd,JSON.stringify({token:token,leaseGeneration:generation,pid:process.pid,timestamp:new Date().toISOString()},null,2),{encoding:"utf8"});',
        '    fs.fsyncSync(fd);fs.closeSync(fd);fd=null;',
        '    if(!sameIdentity())throw new Error("lock directory identity changed");',
        '    current=JSON.parse(fs.readFileSync(path.join(lockDir,"owner.json"),"utf8"));',
        '    if(current.token!==token||current.leaseGeneration!==generation)throw new Error("lease changed");',
        '    fs.renameSync(temp,target);',
        '  }catch(e){',
        '    if(fd!==null){try{fs.closeSync(fd);}catch(_){}}',
        '    try{var s=fs.lstatSync(temp);if(s.isFile()&&!s.isSymbolicLink())fs.unlinkSync(temp);}catch(_){}',
        '    throw e;',
        '  }',
        '}',
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
        '    atomicHeartbeat();',
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
    var createdIdentity = null;
    try {
        fs.mkdirSync(lockDir);
        created = true;
        createdIdentity = readDirectoryIdentity(lockDir);
        if (typeof opts._testAfterDirectoryCreated === 'function') {
            opts._testAfterDirectoryCreated({
                lockDir: lockDir,
                identity: createdIdentity
            });
        }
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
        atomicJsonWrite(path.join(lockDir, 'owner.json'), owner);
        writeHeartbeat(lockDir, owner.token, owner.leaseGeneration);
        var heartbeatPid = startHeartbeat(lockDir, owner.token, owner.leaseGeneration,
            opts.heartbeatIntervalSeconds || 30, owner.pid, owner.workerStartTime);
        if (heartbeatPid) {
            owner.heartbeatPid = heartbeatPid;
            owner.heartbeatAt = nowIso();
            atomicJsonWrite(path.join(lockDir, 'owner.json'), owner);
            writeHeartbeat(lockDir, owner.token, owner.leaseGeneration);
        }
        return { acquired: true, owner: owner };
    } catch (err) {
        if (err && err.code === 'EEXIST') {
            return { acquired: false, owner: readOwner(lockDir), reason: 'held' };
        }
        if (created && sameDirectoryIdentity(lockDir, createdIdentity)) {
            var failedPath = lockDir + '.failed.' + Date.now() + '.' + process.pid;
            try {
                fs.renameSync(lockDir, failedPath);
                if (sameDirectoryIdentity(failedPath, createdIdentity)) {
                    removeManagedLockDir(failedPath, lockDir);
                } else if (!fs.existsSync(lockDir)) {
                    fs.renameSync(failedPath, lockDir);
                }
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
    opts = opts || {};
    var staleHeartbeatSeconds = Math.max(300, Number(opts.staleHeartbeatSeconds) || 7200);
    var maxLockAgeSeconds = Math.max(staleHeartbeatSeconds, Number(opts.maxLockAgeSeconds) || 28800);
    var initializationGraceSeconds = Math.max(5, Number(opts.initializationGraceSeconds) || 30);
    var hbAge = heartbeatAgeSeconds(lockDir, owner);
    var lockAge = owner && owner.acquiredAt ? secondsSinceIso(owner.acquiredAt) : null;
    var lockDirectoryAge = directoryAgeSeconds(lockDir);
    var lockIdentity = null;
    try { lockIdentity = readDirectoryIdentity(lockDir); } catch (_) {}
    var ownerValid = !!(owner && typeof owner === 'object' &&
        typeof owner.token === 'string' && owner.token &&
        typeof owner.leaseGeneration === 'string' && owner.leaseGeneration);

    // mkdir publishes the exclusion boundary before owner.json can be written.
    // A waiter must therefore treat a fresh empty/partial directory as an
    // in-progress acquisition, not as an immediately stale lease.
    if (!ownerValid) {
        if (lockDirectoryAge === null || lockDirectoryAge < initializationGraceSeconds) {
            return {
                stale: false,
                hbAge: hbAge,
                lockAge: lockAge,
                lockIdentity: lockIdentity,
                reason: 'lock initialization grace'
            };
        }
        var ownerFileExists = fs.existsSync(path.join(lockDir, 'owner.json'));
        var heartbeatFileExists = fs.existsSync(path.join(lockDir, 'heartbeat.json'));
        if (ownerFileExists || heartbeatFileExists) {
            return {
                stale: false,
                hbAge: hbAge,
                lockAge: lockAge,
                lockIdentity: lockIdentity,
                reason: 'invalid lease metadata requires manual recovery'
            };
        }
        return {
            stale: true,
            hbAge: hbAge,
            lockAge: lockAge,
            lockIdentity: lockIdentity,
            reason: 'abandoned empty lock initialization'
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
    var heartbeatPidAlive = owner && owner.heartbeatPid ? isPidAlive(owner.heartbeatPid) : null;

    // ── Stale lock decision tree ───────────────────────────────────────────────
    // CASE 1: a confirmed-live owner is authoritative. Neither same-file identity
    // nor elapsed wall time is sufficient to revoke its lease.
    if (workerAlive === true) {
        return {
            stale: false,
            hbAge: hbAge,
            lockAge: lockAge,
            lockIdentity: lockIdentity,
            reason: 'owner worker identity is live'
        };
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
            lockIdentity: lockIdentity,
            reason: 'owner requires manual recovery after supervisor loss'
        };
    }

    // A worker can die while an FFmpeg/NVEncC descendant remains alive. The
    // lease does not record every producer process-group identity, so owner
    // death is not proof that the GPU is idle. Established leases are
    // deliberately fail-closed and require the quiescence recovery procedure.
    if (workerAlive === false) {
        return {
            stale: false,
            hbAge: hbAge,
            lockAge: lockAge,
            lockIdentity: lockIdentity,
            reason: 'owner worker identity is gone; possible GPU descendants require manual recovery'
        };
    }

    if (hbAge !== null && hbAge < staleHeartbeatSeconds) {
        return {
            stale: false,
            hbAge: hbAge,
            lockAge: lockAge,
            lockIdentity: lockIdentity,
            reason: 'heartbeat fresh'
        };
    }

    if (heartbeatPidAlive === true) {
        return {
            stale: false,
            hbAge: hbAge,
            lockAge: lockAge,
            lockIdentity: lockIdentity,
            reason: 'heartbeat process still alive'
        };
    }

    if (lockAge !== null && lockAge < maxLockAgeSeconds && hbAge !== null && hbAge < maxLockAgeSeconds) {
        return {
            stale: false,
            hbAge: hbAge,
            lockAge: lockAge,
            lockIdentity: lockIdentity,
            reason: 'inside max lock age safety window'
        };
    }

    // A valid lease with no provably live supervisor is still not safe to
    // steal: long-running descendants can survive their Tdarr worker.
    return {
        stale: false,
        hbAge: hbAge,
        lockAge: lockAge,
        lockIdentity: lockIdentity,
        reason: 'established lease is stale but requires manual quiescence recovery'
    };
}

function breakStaleLock(lockDir, expectedIdentity) {
    if (!sameDirectoryIdentity(lockDir, expectedIdentity)) {
        return false;
    }
    var stalePath = lockDir + '.stale.' + Date.now() + '.' + process.pid;
    var renamed = false;
    try {
        fs.renameSync(lockDir, stalePath);
        renamed = true;
        if (!sameDirectoryIdentity(stalePath, expectedIdentity)) {
            if (!fs.existsSync(lockDir)) fs.renameSync(stalePath, lockDir);
            return false;
        }
        removeManagedLockDir(stalePath, lockDir);
        return true;
    } catch (err) {
        if (renamed && fs.existsSync(stalePath) && !fs.existsSync(lockDir)) {
            try { fs.renameSync(stalePath, lockDir); } catch (_) {}
        }
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
            breakStaleLock(lockDir, stale.lockIdentity);
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
            if (!breakStaleLock(lockDir, stale.lockIdentity)) {
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

function release(lockDir, expectedToken, opts) {
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
