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

function startHeartbeat(lockDir, token, intervalSeconds) {
    var interval = Math.max(5, Number(intervalSeconds) || 30);
    var script = [
        "var fs=require('fs');",
        "var path=require('path');",
        "var lockDir=process.argv[1];",
        "var token=process.argv[2];",
        "var interval=Math.max(5,Number(process.argv[3])||30)*1000;",
        "function tick(){",
        "  try {",
        "    var owner=JSON.parse(fs.readFileSync(path.join(lockDir,'owner.json'),'utf8'));",
        "    if(owner.token!==token){process.exit(0);}",
        "    fs.writeFileSync(path.join(lockDir,'heartbeat.json'), JSON.stringify({token:token,pid:process.pid,timestamp:new Date().toISOString()}, null, 2));",
        "  } catch(e) { process.exit(0); }",
        "}",
        "tick();",
        "setInterval(tick, interval);"
    ].join('\n');
    try {
        var child = childProcess.spawn(process.execPath, ['-e', script, lockDir, token, String(interval)], {
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
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner, null, 2));
        writeHeartbeat(lockDir, owner.token);
        var heartbeatPid = startHeartbeat(lockDir, owner.token, opts.heartbeatIntervalSeconds || 30);
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
    var heartbeat = readHeartbeat(lockDir);
    var ownerPidAlive = owner && owner.pid ? isPidAlive(owner.pid) : null;
    var heartbeatPidAlive = owner && owner.heartbeatPid ? isPidAlive(owner.heartbeatPid) : null;

    // Critical: do not let an orphaned heartbeat or recently-written heartbeat file
    // keep a lock forever after Tdarr has killed/lost the owning worker. This was
    // observed when the owning job entered limbo: owner.pid had exited, no GPU
    // ffmpeg remained, but waiters still trusted the fresh heartbeat window.
    if (ownerPidAlive === false && (lockAge === null || lockAge >= orphanProcessGraceSeconds)) {
        return {
            stale: true,
            hbAge: hbAge,
            lockAge: lockAge,
            reason: 'owner worker process exited' +
                (heartbeatPidAlive === true ? ' (orphan heartbeat ignored)' : '')
        };
    }

    if (ownerPidAlive === null && heartbeatPidAlive === false &&
            (hbAge === null || hbAge >= orphanProcessGraceSeconds) &&
            (lockAge === null || lockAge >= orphanProcessGraceSeconds)) {
        return {
            stale: true,
            hbAge: hbAge,
            lockAge: lockAge,
            reason: 'owner process unknown and heartbeat process exited'
        };
    }

    if (hbAge !== null && hbAge < staleHeartbeatSeconds) {
        return { stale: false, hbAge: hbAge, lockAge: lockAge, reason: 'heartbeat fresh' };
    }

    if (heartbeatPidAlive === true && lockAge !== null && lockAge < maxLockAgeSeconds) {
        return { stale: false, hbAge: hbAge, lockAge: lockAge, reason: 'heartbeat process still alive' };
    }

    if (lockAge !== null && lockAge < maxLockAgeSeconds && hbAge !== null && hbAge < maxLockAgeSeconds) {
        return { stale: false, hbAge: hbAge, lockAge: lockAge, reason: 'inside max lock age safety window' };
    }

    return {
        stale: true,
        hbAge: hbAge,
        lockAge: lockAge,
        reason: 'heartbeat stale' + (heartbeat && heartbeat.timestamp ? '' : ' or missing')
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
    if (expectedToken && owner.token !== expectedToken && !(opts && opts.force)) {
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
    sleepSeconds: sleepSeconds
};
