"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = exports.details = void 0;
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var deliveryPolicy = require('../../_lib/deliveryPolicy.js');

var VALIDATION_SCHEMA = 'vmaf-delivery-candidate-validation/v1';

function pathKey(filePath) {
    var resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function strictChild(root, candidate) {
    var relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' &&
        !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function sha256FileSync(filePath) {
    var hash = crypto.createHash('sha256');
    var fd = fs.openSync(filePath, 'r');
    var buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    try {
        for (;;) {
            var count = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!count) break;
            hash.update(buffer.subarray(0, count));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function regularFileIdentity(filePath, label) {
    var requested = String(filePath || '').trim();
    if (!requested || !path.isAbsolute(requested)) {
        throw new Error(label + ' path must be absolute');
    }
    var resolved = path.resolve(requested);
    var stat = fs.lstatSync(resolved, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(label + ' must be a non-symlink regular file');
    }
    var canonical = path.resolve(fs.realpathSync(resolved));
    if (pathKey(canonical) !== pathKey(resolved)) {
        throw new Error(label + ' contains a symlinked path component');
    }
    var size = Number(stat.size);
    if (!Number.isSafeInteger(size) || size <= 0) {
        throw new Error(label + ' has an invalid byte count');
    }
    return {
        path: canonical,
        size_bytes: size,
        dev: String(stat.dev),
        ino: String(stat.ino),
        mtime_ms: Math.trunc(Number(stat.mtimeMs)),
        ctime_ms: Math.trunc(Number(stat.ctimeMs)),
        mtime_ns: String(stat.mtimeNs),
        ctime_ns: String(stat.ctimeNs),
        sha256_full: sha256FileSync(canonical),
    };
}

function requirePendingProof(args, policy) {
    var variables = args.variables || {};
    var pending = variables.vmafDeliveryOutcomePending;
    var checkpoint = variables.vmafPostEncodeCheckpoint;
    var jobId = String(variables.vmafCanonicalJobId || '').trim();
    var checkpointKey = checkpoint && String(checkpoint.checkpoint_key || '');
    var source = path.resolve(sourcePath(args));
    if (!pending || pending.schema !== 'vmaf-delivery-outcome-pending/v1' ||
        pending.version !== 1 || pending.status !== 'candidate_ready' ||
        pending.database_recorded !== true) {
        throw new Error('delivery validation requires a durable candidate-ready proof');
    }
    if (!jobId || pending.job_id !== jobId) {
        throw new Error('candidate-ready proof differs from the canonical VMAF job id');
    }
    if (!/^[0-9a-f]{64}$/.test(checkpointKey) ||
        pending.checkpoint_key !== checkpointKey) {
        throw new Error('candidate-ready proof differs from the authenticated checkpoint key');
    }
    if (!pending.source_path || pathKey(pending.source_path) !== pathKey(source)) {
        throw new Error('candidate-ready proof differs from the original source path');
    }
    if (pending.size_policy_version !== policy.version ||
        Number(pending.target_size_reduction_pct) !== policy.targetReductionPct ||
        Number(pending.minimum_size_reduction_pct) !== policy.minimumReductionPct ||
        Number(pending.max_final_output_ratio_pct) !== policy.maxFinalOutputRatioPct) {
        throw new Error('candidate-ready proof differs from the exact delivery policy');
    }
    return pending;
}

function workRoot(workDir) {
    var requested = String(workDir || '').trim();
    if (!requested || !path.isAbsolute(requested)) {
        throw new Error('delivery validation requires an absolute args.workDir');
    }
    var resolved = path.resolve(requested);
    if (resolved === path.parse(resolved).root) {
        throw new Error('delivery validation refuses a filesystem root as args.workDir');
    }
    var stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('delivery validation workDir is not a real directory');
    }
    var canonical = path.resolve(fs.realpathSync(resolved));
    if (pathKey(canonical) !== pathKey(resolved)) {
        throw new Error('delivery validation workDir contains a symlinked component');
    }
    return canonical;
}

function sourcePath(args) {
    return String(args.variables && args.variables.vmafOriginalFile ||
        args.originalLibraryFile &&
            (args.originalLibraryFile._id || args.originalLibraryFile.file) || '');
}

function candidatePath(args) {
    return String(args.inputFileObj &&
        (args.inputFileObj._id || args.inputFileObj.file) || '');
}

function canonicalJobId(args, vmafdb) {
    var jobId = String(args.variables.vmafCanonicalJobId || '');
    if (jobId) return jobId;
    var source = sourcePath(args);
    if (!source) throw new Error('delivery outcome has no canonical job or source identity');
    jobId = vmafdb.makeJobId(source, args.variables.vmafJobStartTime || '');
    args.variables.vmafCanonicalJobId = jobId;
    return jobId;
}

function recordRejectedCandidate(args, assessment, policy, dbOverride) {
    var vmafdb = dbOverride ||
        require('/custom-cont-init.d/vmaf-plugin-patches/_lib/vmafdb.js');
    var db = vmafdb.openDb();
    vmafdb.upsertJob(db, {
        job_id: canonicalJobId(args, vmafdb),
        transcode_succeeded: 0,
        met_vmaf_target: 1,
        met_size_target: 0,
        final_output_size_mb: null,
        final_output_ratio_pct: null,
        actual_size_reduction_pct: null,
        size_target_status: 'candidate_rejected',
        target_size_reduction_pct: policy.targetReductionPct,
        minimum_size_reduction_pct: policy.minimumReductionPct,
        max_final_output_ratio_pct: policy.maxFinalOutputRatioPct,
        size_policy_version: policy.version,
        outcome_stage: 'keep_original',
        delivered_at: null,
        replacement_attestation_version: null,
        replacement_backup_retained: null,
        skip_reason: 'delivery_candidate_exceeds_size_cap',
    });
    return assessment;
}

function validate(args) {
    args.variables = args.variables || {};
    var policy = deliveryPolicy.resolve(args.variables);
    var pending = requirePendingProof(args, policy);
    var root = workRoot(args.workDir);
    var source = regularFileIdentity(sourcePath(args), 'original library file');
    var candidate = regularFileIdentity(candidatePath(args), 'delivery candidate');
    if (!strictChild(root, candidate.path)) {
        throw new Error('delivery candidate is outside the canonical job workDir');
    }
    if (pathKey(source.path) === pathKey(candidate.path) ||
            (source.dev === candidate.dev && source.ino === candidate.ino)) {
        throw new Error('delivery candidate aliases the original library file');
    }
    var assessment = deliveryPolicy.evaluateBytes(
        candidate.size_bytes, source.size_bytes, policy);
    var evidence = {
        schema: VALIDATION_SCHEMA,
        status: assessment.accepted ? 'accepted' : 'rejected',
        validated_at: new Date().toISOString(),
        policy_version: policy.version,
        target_size_reduction_pct: policy.targetReductionPct,
        minimum_size_reduction_pct: policy.minimumReductionPct,
        max_final_output_ratio_pct: policy.maxFinalOutputRatioPct,
        output_ratio_pct: assessment.ratioPct,
        actual_size_reduction_pct: assessment.actualReductionPct,
        job_id: pending.job_id,
        checkpoint_key: pending.checkpoint_key,
        candidate_ready_schema: pending.schema,
        source: source,
        candidate: candidate,
    };
    args.variables.vmafDeliveryCandidateValidation = evidence;
    return {
        policy: policy,
        assessment: assessment,
        evidence: evidence,
    };
}

var details = function () { return ({
    name: 'Validate Delivery Candidate',
    description: 'Applies the exact delivered-byte size policy immediately before replacement. Equality at the 80% cap is accepted; larger candidates keep the original.',
    style: { borderColor: 'orange' },
    tags: 'video,vmaf,size,delivery,safety',
    isStartPlugin: false,
    pType: '',
    requiresVersion: '2.11.01',
    sidebarPosition: -1,
    icon: 'faScaleBalanced',
    inputs: [],
    outputs: [
        { number: 1, tooltip: 'Candidate satisfies the delivered-size policy' },
        { number: 2, tooltip: 'Candidate rejected; keep the original' },
    ],
}); };
exports.details = details;

var plugin = function (args) {
    var lib = require('../../../../../methods/lib')();
    args.inputs = lib.loadDefaultValues(args.inputs, details);
    args.jobLog('=== Validate Delivery Candidate ===');
    var result = validate(args);
    if (result.assessment.rejected) {
        args.variables.vmafDeliveryCandidateRejected = true;
        args.variables.vmafTranscodeSucceeded = false;
        args.variables.vmafTranscodeStatus = 'keep_original_delivery_size_policy';
        args.variables.vmafTranscodeFailureReason =
            'delivery_candidate_exceeds_size_cap';
        recordRejectedCandidate(args, result.assessment, result.policy);
        args.jobLog('DELIVERY REJECTED: candidate is ' +
            result.assessment.ratioPct.toFixed(3) + '% of source; cap is ' +
            result.assessment.capPct.toFixed(3) + '%. Original preserved.');
        return {
            outputFileObj: args.originalLibraryFile || args.inputFileObj,
            outputNumber: 2,
            variables: args.variables,
        };
    }
    args.variables.vmafDeliveryCandidateRejected = false;
    args.jobLog('Delivery candidate accepted at ' +
        result.assessment.ratioPct.toFixed(3) + '% of source (cap ' +
        result.assessment.capPct.toFixed(3) + '%).');
    return {
        outputFileObj: args.inputFileObj,
        outputNumber: 1,
        variables: args.variables,
    };
};
exports.plugin = plugin;
exports._test = {
    pathKey: pathKey,
    strictChild: strictChild,
    regularFileIdentity: regularFileIdentity,
    workRoot: workRoot,
    sha256FileSync: sha256FileSync,
    requirePendingProof: requirePendingProof,
    validate: validate,
    recordRejectedCandidate: recordRejectedCandidate,
    VALIDATION_SCHEMA: VALIDATION_SCHEMA,
};
