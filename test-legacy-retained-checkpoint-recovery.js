'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const recoveryTool = require('./build-scripts/recover-legacy-job-scoped-checkpoint.js');
const checkpoint = require(
    './custom-cont-init.d/vmaf-plugin-patches/_lib/postEncodeCheckpoint.js');
const nvenccKnn = require(
    './custom-cont-init.d/vmaf-plugin-patches/_lib/nvenccKnn.js');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-legacy-recovery-'));
const checkpointRoot = path.join(scratch, 'protected-checkpoints');
const reuseRequiredRoot = path.join(scratch, 'reuse-required');
const workDir = path.join(scratch, 'recovery-work');
const sourcePath = path.join(scratch, 'source.mkv');
const coordinatorPath = path.join(scratch, 'coordinator');
const producerPath = path.join(scratch, 'nvencc');
const consumerPath = path.join(scratch, 'ffmpeg');
const outputPath = path.join(scratch, 'old-job-output.mkv');
const legacyJobWorkDir = '/temp/tdarr-workDir-fixture-job';
const legacyProducerLog = `${legacyJobWorkDir}/fixture-primary-video.mkv.nvencc.log`;

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function executableIdentity(filePath) {
    return {
        requested_path: filePath,
        resolved_path: filePath,
        size_bytes: fs.statSync(filePath).size,
        sha256_full: sha256File(filePath),
    };
}

function sourceFingerprint() {
    return {
        scheme: 'sha256-sampled-v1',
        sha256: '7'.repeat(64),
        size_bytes: fs.statSync(sourcePath).size,
        mtime_ns: 1782744454000000000,
        sample_bytes: 1024,
        sample_offsets: [0, 65024, 130048],
        resolved_path: sourcePath,
    };
}

function buildLegacyContract() {
    const coordinatorOptions = {
        nvenccPath: producerPath,
        coordinatorPath,
        sourcePath,
        outputDepth: 10,
        producerLog: legacyProducerLog,
        ffmpegPath: consumerPath,
        ffmpegArgs: [
            '-f', 'nut', '-i', 'pipe:0', '-map', '0:v:0',
            '-c:v', 'av1_nvenc', '-cq', '33.5', '-y', outputPath,
        ],
    };
    return {
        schema: 2,
        executable: coordinatorPath,
        executable_identity: executableIdentity(coordinatorPath),
        argv: nvenccKnn.buildCoordinatorArgs(coordinatorOptions).map((value) => {
            if (value === sourcePath) return '<SOURCE>';
            if (value === outputPath) return '<OUTPUT>';
            return value;
        }),
        pipeline: nvenccKnn.contractDescriptor(coordinatorOptions),
        producer_identity: executableIdentity(producerPath),
        consumer_identity: executableIdentity(consumerPath),
    };
}

function checkpointIdentities(fingerprint, contract) {
    const encodeContractSha256 = recoveryTool.sha256Text(
        recoveryTool.canonicalJson(contract));
    const checkpointKey = recoveryTool.sha256Text(recoveryTool.canonicalJson({
        contract_id: recoveryTool.CHECKPOINT_CONTRACT_ID,
        source_fingerprint: fingerprint,
        encode_contract_sha256: encodeContractSha256,
    }));
    return { encodeContractSha256, checkpointKey };
}

function writePrivateFile(filePath, contents) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, contents, { mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

function buildExecutionAttestation(root) {
    const flowPlugins = [];
    const flowNodeIdsByRole = new Map();
    const roles = [];
    for (const [roleName, definition] of Object.entries(
        recoveryTool.REQUIRED_EXECUTION_ROLES
    )) {
        const flowNodeIds = [];
        if (definition.kind === 'flow_plugin') {
            for (let index = 0; index < definition.instances; index += 1) {
                const identity = `${roleName}-${index + 1}`;
                flowNodeIds.push(identity);
                flowPlugins.push({
                    id: identity,
                    sourceRepo: definition.sourceRepo,
                    pluginName: definition.pluginName,
                    version: definition.version,
                });
            }
            flowNodeIdsByRole.set(roleName, flowNodeIds);
        }
        const contents = Buffer.from(`authenticated-r2-role:${roleName}\n`);
        const sourceRoot = definition.sourceArea === 'community_catalog'
            ? path.join(root, 'community-source')
            : path.join(root, `source-${definition.sourceArea}`);
        const copies = {
            source: {
                path: path.join(sourceRoot, definition.sourceRelative),
            },
            server: {
                path: path.join(root, 'server', definition.catalogRelative),
            },
            node: {
                path: path.join(root, 'node', definition.catalogRelative),
            },
        };
        for (const copyName of ['source', 'server', 'node']) {
            const copyPath = copies[copyName].path;
            writePrivateFile(copyPath, contents);
        }
        roles.push({
            role: roleName,
            expected_sha256_full: crypto.createHash('sha256')
                .update(contents).digest('hex'),
            copies,
            ...(definition.kind === 'flow_plugin'
                ? { flow_node_ids: flowNodeIds }
                : {}),
        });
    }
    const flowEdges = [];
    const mainRoleChain = [
        'input_file',
        'file_age_gate',
        'gpu_capability_gate',
        'hdr_classifier',
        'grain_analysis',
        'metadata_fetch',
        'sample_extraction',
        'gpu_lock_acquire',
        'parameter_test',
        'vmaf_measurement',
        'cq_bracket',
        'parameter_selection',
        'retry_controller',
        'cq_learning',
        'result_export',
        'projected_size_gate',
        'gpu_lock_acquire',
        'transcode',
        'gpu_lock_release',
        'terminal_monitor',
        'grain_synthesis',
        'remux_start',
        'stream_reorder',
        'remux_execute',
        'delivery_validator',
        'replace_original',
        'delivery_finalizer',
        'notification',
        'notification',
        'unmonitor',
        'unmonitor',
        'cleanup',
    ];
    const roleOccurrences = new Map();
    const nodeForOccurrence = (roleName) => {
        const index = roleOccurrences.get(roleName) || 0;
        roleOccurrences.set(roleName, index + 1);
        return flowNodeIdsByRole.get(roleName)[index];
    };
    const mainNodes = mainRoleChain.map(nodeForOccurrence);
    const connect = (source, target, handle) => {
        flowEdges.push({
            id: `edge-${flowEdges.length + 1}`,
            source,
            sourceHandle: String(handle || 1),
            target,
            targetHandle: null,
        });
    };
    for (let index = 0; index + 1 < mainNodes.length; index += 1) {
        connect(mainNodes[index], mainNodes[index + 1], 1);
    }
    const errorRoot = nodeForOccurrence('flow_error_handler');
    const errorRelease = nodeForOccurrence('gpu_lock_release');
    const errorCleanup = nodeForOccurrence('cleanup');
    const technicalFailure = nodeForOccurrence('technical_failure');
    connect(errorRoot, errorRelease, 1);
    connect(errorRelease, errorCleanup, 1);
    connect(errorCleanup, technicalFailure, 1);
    connect(
        flowNodeIdsByRole.get('gpu_capability_gate')[0],
        technicalFailure,
        2
    );
    return {
        flow: {
            _id: recoveryTool.PINNED_FLOW_ID,
            name: 'private exact r2 fixture',
            flowPlugins,
            flowEdges,
            privateSetting: 'a full-object hash must cover this value',
        },
        executionPath: {
            schema: 2,
            contract_id: recoveryTool.EXECUTION_PATH_CONTRACT_ID,
            community_source_root: path.join(root, 'community-source'),
            roles,
        },
        localSourceRoots: {
            local_vmaf: path.join(root, 'source-local_vmaf'),
            local_filter: path.join(root, 'source-local_filter'),
            local_tools: path.join(root, 'source-local_tools'),
        },
    };
}

function makeGlobalSettings(overrides) {
    return {
        _id: 'globalsettings',
        autoUpdateNodes: false,
        autoUpdateServer: false,
        pluginAutoUpdate: false,
        killAllProcessesDuringUpdate: false,
        pauseAllNodes: 'manual',
        ...(overrides || {}),
    };
}

function makePreDispatch(
    flow,
    globalSettings,
    libraries,
    executionPath,
    sourceMediaBackup
) {
    return {
        schema: recoveryTool.PRE_DISPATCH_SCHEMA,
        contract_id: recoveryTool.PRE_DISPATCH_CONTRACT_ID,
        live_database_path: '/app/server/Tdarr/DB2/SQL/database.db',
        live_flow: {
            id: recoveryTool.PINNED_FLOW_ID,
            sha256_full_object: recoveryTool.stableObjectSha256(flow),
        },
        global_settings: {
            id: 'globalsettings',
            sha256_full_object: recoveryTool.stableObjectSha256(globalSettings),
        },
        library_settings: {
            sha256_full_collection: recoveryTool.stableObjectSha256(
                [...libraries].sort((left, right) =>
                    left._id.localeCompare(right._id))
            ),
        },
        updater_environment: {
            ...recoveryTool.REQUIRED_DISABLED_UPDATER_ENV,
        },
        execution_path: executionPath,
        source_media_backup: sourceMediaBackup || {},
    };
}

function testPreDispatchStateAndExecutionAttestation() {
    const expectedRoleNames = [
        'input_file',
        'file_age_gate',
        'gpu_capability_gate',
        'hdr_classifier',
        'grain_analysis',
        'metadata_fetch',
        'sample_extraction',
        'parameter_test',
        'vmaf_measurement',
        'cq_bracket',
        'parameter_selection',
        'cq_learning',
        'result_export',
        'projected_size_gate',
        'gpu_lock_acquire',
        'transcode',
        'gpu_lock_release',
        'terminal_monitor',
        'retry_controller',
        'grain_synthesis',
        'remux_start',
        'stream_reorder',
        'remux_execute',
        'delivery_validator',
        'replace_original',
        'delivery_finalizer',
        'notification',
        'unmonitor',
        'cleanup',
        'flow_error_handler',
        'technical_failure',
        'helper_canonical_denoise',
        'helper_current_contract_measurement_history',
        'helper_delivery_finalization',
        'helper_delivery_policy',
        'helper_delivery_transaction',
        'helper_empty_band_shadow',
        'helper_feasibility',
        'helper_gpu_pipeline_lock',
        'helper_grain_analysis_artifact',
        'helper_grain_vmaf_contract',
        'helper_nvencc_knn',
        'helper_nvenc_temporal_filter',
        'helper_paired_cq_shadow',
        'helper_post_encode_checkpoint',
        'helper_post_replace_attestation',
        'helper_pre_fgs_cambi',
        'helper_reference_contract_bridge',
        'helper_rejection_reasons',
        'helper_size_failure_shadow',
        'helper_vmaf_metric_contract',
        'helper_vmaf_v1_cpu',
        'helper_vmafdb',
        'helper_vmafpredict',
        'vendor_cli_utils',
        'vendor_cli_parsers',
        'vendor_file_utils',
        'vendor_file_move_or_copy',
        'vendor_flow_utils',
    ];
    assert.deepStrictEqual(
        Object.keys(recoveryTool.REQUIRED_EXECUTION_ROLES).sort(),
        expectedRoleNames.sort(),
        'the generic r2 role schema must be exact: no missing or surplus roles'
    );
    const attestationRoot = path.join(scratch, 'r2-attestation');
    const built = buildExecutionAttestation(attestationRoot);
    const globalSettings = makeGlobalSettings();
    const liveMediaRoot = path.join(scratch, 'declared-live-media');
    fs.mkdirSync(liveMediaRoot, { mode: 0o700 });
    const libraries = [{
        _id: 'private-library-fixture',
        folder: liveMediaRoot,
        name: 'private fixture',
    }];
    const preDispatch = makePreDispatch(
        built.flow,
        globalSettings,
        libraries,
        built.executionPath,
        { media_roots: [liveMediaRoot] }
    );
    const pidOneEnvironment = {
        ...recoveryTool.REQUIRED_DISABLED_UPDATER_ENV,
        PRIVATE_API_KEY: ['must', 'never', 'be', 'rendered'].join('-'),
    };
    assert.deepStrictEqual(
        recoveryTool.parseNullDelimitedEnvironment(Buffer.from(
            'enableDockerAutoUpdater=false\u0000cronPluginUpdate=\u0000' +
            'VALUE_WITH_EQUALS=a=b\u0000'
        )),
        {
            enableDockerAutoUpdater: 'false',
            cronPluginUpdate: '',
            VALUE_WITH_EQUALS: 'a=b',
        }
    );
    assert.throws(() => recoveryTool.parseNullDelimitedEnvironment(Buffer.from(
        'cronPluginUpdate=\u0000cronPluginUpdate=again\u0000'
    )), /duplicate names/);
    const live = recoveryTool.authenticateLiveStateDocuments(
        preDispatch,
        { flow: built.flow, globalSettings, libraries },
        pidOneEnvironment
    );
    assert.strictEqual(live.flow, built.flow);
    const executionOptions = {
        serverPluginRoot: path.join(attestationRoot, 'server'),
        nodePluginRoot: path.join(attestationRoot, 'node'),
        localSourceRoots: built.localSourceRoots,
    };
    const authenticated = recoveryTool.authenticateExecutionPath(
        built.executionPath,
        built.flow,
        executionOptions
    );
    assert.strictEqual(
        authenticated.roleCount,
        Object.keys(recoveryTool.REQUIRED_EXECUTION_ROLES).length
    );
    assert(authenticated.transcodePluginPath.endsWith(
        path.join('vmafOptimizedTranscode', '1.0.0', 'index.js')));
    assert(authenticated.checkpointHelperPath.endsWith(
        path.join('_lib', 'postEncodeCheckpoint.js')));

    const changedFlow = JSON.parse(JSON.stringify(built.flow));
    changedFlow.privateSetting = 'one-byte semantic drift';
    assert.throws(() => recoveryTool.authenticateLiveStateDocuments(
        preDispatch,
        { flow: changedFlow, globalSettings, libraries },
        pidOneEnvironment
    ), /full-object SHA-256/,
    'any full Flow object drift, not only node identity drift, must reject dispatch');

    const prototypeKeyOne = JSON.parse(JSON.stringify(built.flow));
    const prototypeKeyTwo = JSON.parse(JSON.stringify(built.flow));
    prototypeKeyOne.flowPlugins[0].inputsDB =
        JSON.parse('{"__proto__":{"reviewed":1}}');
    prototypeKeyTwo.flowPlugins[0].inputsDB =
        JSON.parse('{"__proto__":{"reviewed":2}}');
    assert.notStrictEqual(
        recoveryTool.stableObjectSha256(prototypeKeyOne),
        recoveryTool.stableObjectSha256(prototypeKeyTwo),
        'full-object hashing must retain own __proto__ JSON keys'
    );

    const disconnectedFlow = JSON.parse(JSON.stringify(built.flow));
    disconnectedFlow.flowEdges = [];
    const disconnectedPreDispatch = makePreDispatch(
        disconnectedFlow,
        globalSettings,
        libraries,
        built.executionPath,
        { media_roots: [liveMediaRoot] }
    );
    assert.throws(() => recoveryTool.authenticateLiveStateDocuments(
        disconnectedPreDispatch,
        { flow: disconnectedFlow, globalSettings, libraries },
        pidOneEnvironment
    ), /graph is empty|disconnected|required r2/,
    'a full-object hash must not authorize disconnected role declarations');

    const duplicateNodeFlow = JSON.parse(JSON.stringify(built.flow));
    duplicateNodeFlow.flowPlugins[1].id =
        duplicateNodeFlow.flowPlugins[0].id;
    const duplicateNodePreDispatch = makePreDispatch(
        duplicateNodeFlow,
        globalSettings,
        libraries,
        built.executionPath,
        { media_roots: [liveMediaRoot] }
    );
    assert.throws(() => recoveryTool.authenticateLiveStateDocuments(
        duplicateNodePreDispatch,
        {
            flow: duplicateNodeFlow,
            globalSettings,
            libraries,
        },
        pidOneEnvironment
    ), /invalid or duplicated/,
    'Flow node IDs must be globally unique before roles are bound');

    const stringFalseGlobal = makeGlobalSettings({ pluginAutoUpdate: 'false' });
    const stringFalsePreDispatch = makePreDispatch(
        built.flow,
        stringFalseGlobal,
        libraries,
        built.executionPath,
        { media_roots: [liveMediaRoot] }
    );
    assert.throws(() => recoveryTool.authenticateLiveStateDocuments(
        stringFalsePreDispatch,
        {
            flow: built.flow,
            globalSettings: stringFalseGlobal,
            libraries,
        },
        pidOneEnvironment
    ), /not boolean false/,
    'string false must not satisfy the global updater gate');

    assert.throws(() => recoveryTool.authenticateLiveStateDocuments(
        preDispatch,
        { flow: built.flow, globalSettings, libraries },
        {
            ...pidOneEnvironment,
            cronPluginUpdate: '0 3 * * *',
        }
    ), /updater environment/,
    'a non-empty PID 1 plugin updater schedule must reject dispatch');

    const secondMediaRoot = path.join(scratch, 'second-live-media');
    fs.mkdirSync(secondMediaRoot, { mode: 0o700 });
    const twoLibraries = libraries.concat([{
        _id: 'second-private-library-fixture',
        folder: secondMediaRoot,
    }]);
    const missingMediaRootPreDispatch = makePreDispatch(
        built.flow,
        globalSettings,
        twoLibraries,
        built.executionPath,
        { media_roots: [liveMediaRoot] }
    );
    assert.throws(() => recoveryTool.authenticateLiveStateDocuments(
        missingMediaRootPreDispatch,
        {
            flow: built.flow,
            globalSettings,
            libraries: twoLibraries,
        },
        pidOneEnvironment
    ), /exact live media-root set/,
    'a request cannot omit another live library media root');

    const missingRole = JSON.parse(JSON.stringify(built.executionPath));
    missingRole.roles.pop();
    assert.throws(() => recoveryTool.authenticateExecutionPath(
        missingRole,
        built.flow,
        executionOptions
    ), /role count is incomplete/);

    const duplicateRole = JSON.parse(JSON.stringify(built.executionPath));
    duplicateRole.roles[duplicateRole.roles.length - 1] =
        JSON.parse(JSON.stringify(duplicateRole.roles[0]));
    assert.throws(() => recoveryTool.authenticateExecutionPath(
        duplicateRole,
        built.flow,
        executionOptions
    ), /invalid or duplicate role/);

    const wrongNode = JSON.parse(JSON.stringify(built.executionPath));
    const flowRole = wrongNode.roles.find((entry) =>
        Array.isArray(entry.flow_node_ids));
    flowRole.flow_node_ids[0] = 'unreviewed-private-node';
    assert.throws(() => recoveryTool.authenticateExecutionPath(
        wrongNode,
        built.flow,
        executionOptions
    ), /not bound to the exact reviewed Flow nodes/);

    const mislabeledCatalog = JSON.parse(JSON.stringify(built.executionPath));
    mislabeledCatalog.roles[0].copies.source.path =
        mislabeledCatalog.roles[0].copies.server.path;
    assert.throws(() => recoveryTool.authenticateExecutionPath(
        mislabeledCatalog,
        built.flow,
        executionOptions
    ), /outside its exact namespace/,
    'a server file cannot be relabeled as the independently reviewed source copy');

    const wrongNamespace = JSON.parse(JSON.stringify(built.executionPath));
    const communityRole = wrongNamespace.roles.find((entry) =>
        entry.role === 'notification');
    const wrongNamespacePath = path.join(
        attestationRoot,
        'community-source',
        'CommunityFlowPlugins',
        'file',
        'notifyRadarrOrSonarr',
        '2.0.0',
        'index.js'
    );
    fs.mkdirSync(path.dirname(wrongNamespacePath), {
        recursive: true,
        mode: 0o700,
    });
    fs.copyFileSync(communityRole.copies.source.path, wrongNamespacePath);
    try { fs.chmodSync(wrongNamespacePath, 0o600); } catch (_) {}
    communityRole.copies.source.path = wrongNamespacePath;
    assert.throws(() => recoveryTool.authenticateExecutionPath(
        wrongNamespace,
        built.flow,
        executionOptions
    ), /outside its exact namespace/,
    'a same-hash Community plugin in the wrong category must not satisfy a role');

    const drifted = JSON.parse(JSON.stringify(built.executionPath));
    const driftedPath = drifted.roles[0].copies.node.path;
    fs.appendFileSync(driftedPath, 'drift');
    assert.throws(() => recoveryTool.authenticateExecutionPath(
        drifted,
        built.flow,
        executionOptions
    ), /bytes differ from the reviewed role/);
}

function testIndependentSourceBackupGate() {
    const mediaRoot = path.join(scratch, 'media-root');
    const backupRoot = path.join(scratch, 'private-backup-root');
    fs.mkdirSync(mediaRoot, { mode: 0o700 });
    fs.mkdirSync(backupRoot, { mode: 0o700 });
    const mediaSource = path.join(mediaRoot, 'title.mkv');
    const backupPath = path.join(backupRoot, 'title.full-backup.mkv');
    const contents = Buffer.alloc(8192, 0x5a);
    writePrivateFile(mediaSource, contents);
    writePrivateFile(backupPath, contents);
    const digest = crypto.createHash('sha256').update(contents).digest('hex');
    const attestation = {
        schema: 1,
        contract_id: recoveryTool.SOURCE_BACKUP_CONTRACT_ID,
        verified: true,
        backup_path: backupPath,
        protected_backup_root: backupRoot,
        media_roots: [mediaRoot],
        size_bytes: contents.length,
        sha256_full: digest,
        require_distinct_device: true,
    };
    const syntheticDistinctDevices = (filePath, description, options) => {
        const snapshot = recoveryTool.snapshotRegularFile(
            filePath,
            description,
            options
        );
        return {
            ...snapshot,
            stat: {
                ...snapshot.stat,
                dev: description === 'source media'
                    ? 'synthetic-media-device'
                    : 'synthetic-backup-device',
            },
        };
    };
    const evidence = recoveryTool.authenticateSourceMediaBackup(
        attestation,
        mediaSource,
        { snapshotRegularFile: syntheticDistinctDevices }
    );
    assert.strictEqual(evidence.source.sha256Full, digest);
    assert.strictEqual(evidence.backup.sha256Full, digest);

    assert.throws(() => recoveryTool.authenticateSourceMediaBackup(
        attestation,
        mediaSource
    ), /not on distinct devices/,
    'a same-device copy must not be described as an independent backup');

    const wrongHash = { ...attestation, sha256_full: '0'.repeat(64) };
    assert.throws(() => recoveryTool.authenticateSourceMediaBackup(
        wrongHash,
        mediaSource,
        { snapshotRegularFile: syntheticDistinctDevices }
    ), /do not match the reviewed full identity/);

    const overlappingBackupRoot = path.join(mediaRoot, 'backup');
    fs.mkdirSync(overlappingBackupRoot, { mode: 0o700 });
    const overlapAttestation = {
        ...attestation,
        protected_backup_root: overlappingBackupRoot,
    };
    assert.throws(() => recoveryTool.authenticateSourceMediaBackup(
        overlapAttestation,
        mediaSource,
        { snapshotRegularFile: syntheticDistinctDevices }
    ), /overlaps a media root/);

    const hardLinkBackup = path.join(backupRoot, 'hardlink-backup.mkv');
    fs.linkSync(backupPath, hardLinkBackup);
    try {
        assert.throws(() => recoveryTool.authenticateSourceMediaBackup(
            { ...attestation, backup_path: hardLinkBackup },
            mediaSource,
            { snapshotRegularFile: syntheticDistinctDevices }
        ), /hard-linked/);
    } finally {
        fs.unlinkSync(hardLinkBackup);
    }
}

function testAuthenticatedCommonJsLoader() {
    const loaderRoot = path.join(scratch, 'authenticated-loader');
    const helperPath = path.join(loaderRoot, 'helper.js');
    const entryPath = path.join(loaderRoot, 'entry.js');
    writePrivateFile(helperPath, 'module.exports = { value: "authenticated" };\n');
    writePrivateFile(
        entryPath,
        'module.exports = { value: require("./helper.js").value };\n'
    );
    const helper = recoveryTool.snapshotRegularFile(
        helperPath,
        'authenticated loader helper',
        { singleLink: true }
    );
    const entry = recoveryTool.snapshotRegularFile(
        entryPath,
        'authenticated loader entry',
        { singleLink: true }
    );
    const executionPath = {
        serverRoot: loaderRoot,
        nodeRoot: path.join(scratch, 'unrelated-loader-node-root'),
        byRole: {
            fixture_entry: { snapshots: { server: entry } },
            fixture_helper: { snapshots: { server: helper } },
        },
    };
    assert.deepStrictEqual(
        recoveryTool.loadAuthenticatedCommonJs(entry, executionPath),
        { value: 'authenticated' }
    );

    const unattestedPath = path.join(loaderRoot, 'unattested.js');
    const unsafeEntryPath = path.join(loaderRoot, 'unsafe-entry.js');
    writePrivateFile(unattestedPath, 'module.exports = "not attested";\n');
    writePrivateFile(
        unsafeEntryPath,
        'module.exports = require("./unattested.js");\n'
    );
    const unsafeEntry = recoveryTool.snapshotRegularFile(
        unsafeEntryPath,
        'unsafe authenticated loader entry',
        { singleLink: true }
    );
    const unsafeExecutionPath = {
        ...executionPath,
        byRole: {
            ...executionPath.byRole,
            unsafe_entry: { snapshots: { server: unsafeEntry } },
        },
    };
    assert.throws(() => recoveryTool.loadAuthenticatedCommonJs(
        unsafeEntry,
        unsafeExecutionPath
    ), /unattested non-builtin dependency/);

    const outsidePath = path.join(scratch, 'outside-unattested.js');
    const outsideEntryPath = path.join(loaderRoot, 'outside-entry.js');
    writePrivateFile(outsidePath, 'module.exports = "outside";\n');
    writePrivateFile(
        outsideEntryPath,
        `module.exports = require(${JSON.stringify(outsidePath)});\n`
    );
    const outsideEntry = recoveryTool.snapshotRegularFile(
        outsideEntryPath,
        'outside dependency loader entry',
        { singleLink: true }
    );
    assert.throws(() => recoveryTool.loadAuthenticatedCommonJs(
        outsideEntry,
        {
            ...executionPath,
            byRole: {
                ...executionPath.byRole,
                outside_entry: { snapshots: { server: outsideEntry } },
            },
        }
    ), /unattested non-builtin dependency/,
    'unattested files outside both catalog roots must not escape to native require');

    const packageRoot = path.join(scratch, 'unattested-package');
    const packageEntryPath = path.join(loaderRoot, 'package-entry.js');
    writePrivateFile(
        path.join(packageRoot, 'package.json'),
        '{"main":"index.js"}\n'
    );
    writePrivateFile(
        path.join(packageRoot, 'index.js'),
        'module.exports = "package-main";\n'
    );
    writePrivateFile(
        packageEntryPath,
        `module.exports = require(${JSON.stringify(packageRoot)});\n`
    );
    const packageEntry = recoveryTool.snapshotRegularFile(
        packageEntryPath,
        'package dependency loader entry',
        { singleLink: true }
    );
    assert.throws(() => recoveryTool.loadAuthenticatedCommonJs(
        packageEntry,
        {
            ...executionPath,
            byRole: {
                ...executionPath.byRole,
                package_entry: { snapshots: { server: packageEntry } },
            },
        }
    ), /unattested non-builtin dependency/,
    'an unattested package main must not escape to native require');

    fs.appendFileSync(helperPath, 'module.exports.value = "drifted";\n');
    assert.throws(() => recoveryTool.loadAuthenticatedCommonJs(
        entry,
        executionPath
    ), /changed before loading/,
    'module dependency bytes must remain bound to their authenticated descriptor snapshot');
}

function testPrivateCliErrorsAreSanitized() {
    const secretPath = path.join(scratch, 'PRIVATE_SOURCE_PATH_MUST_NOT_LEAK.json');
    const result = childProcess.spawnSync(process.execPath, [
        path.join(__dirname, 'build-scripts', 'recover-legacy-job-scoped-checkpoint.js'),
        '--request',
        secretPath,
    ], {
        encoding: 'utf8',
        env: {
            ...process.env,
            ALLOW_LEGACY_PRODUCER_LOG_CHECKPOINT_RECOVERY: '1',
        },
    });
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(
        result.stderr,
        'ERROR: legacy retained checkpoint recovery aborted (RECOVERY_GATE_FAILED)\n'
    );
    assert(!result.stderr.includes(secretPath));
}

function testPreparedGrainReplayReceiptAuthorization() {
    const root = path.join(scratch, 'prepared-grain-receipt');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const replayRoot = path.join(root, 'replay');
    fs.mkdirSync(replayRoot, { recursive: true, mode: 0o700 });
    const fixtureSource = path.join(root, 'source.mkv');
    const manifestPath = path.join(
        replayRoot, 'grain-pipeline-manifest.json');
    const tablePath = path.join(replayRoot, 'grain-table.txt');
    const receiptPath = path.join(
        replayRoot, 'grain-replay-receipt.json');
    writePrivateFile(fixtureSource, Buffer.alloc(8192, 0x61));
    writePrivateFile(manifestPath, '{"fixture":"prepared"}\n');
    writePrivateFile(tablePath, '0.1 0.2 0.3\n');
    writePrivateFile(
        path.join(replayRoot, 'grain-pipeline-private.log'),
        'private replay fixture log\n');

    const runtimePins = {};
    const runtimeReceipt = {};
    for (const name of Object.keys(
        recoveryTool.PINNED_GRAIN_REPLAY_RUNTIME)) {
        const runtimePath = name === 'pipeline'
            ? path.join(root, 'runtime', 'grain-pipeline-v5.py')
            : path.join(root, 'runtime', `runtime-${name}`);
        writePrivateFile(runtimePath, `runtime:${name}\n`);
        const identity = {
            requestedPath: runtimePath,
            resolvedPath: runtimePath,
            sizeBytes: fs.statSync(runtimePath).size,
            sha256: sha256File(runtimePath),
        };
        runtimePins[name] = identity;
        runtimeReceipt[name] = {
            requested_path: identity.requestedPath,
            resolved_path: identity.resolvedPath,
            size_bytes: identity.sizeBytes,
            sha256_full: identity.sha256,
        };
    }
    const fixtureFingerprint = {
        scheme: 'sha256-sampled-v1',
        sha256: '8'.repeat(64),
        size_bytes: fs.statSync(fixtureSource).size,
        mtime_ns: 1782744454000000000,
        sample_bytes: 1024,
        sample_offsets: [0, 3584, 7168],
        resolved_path: fixtureSource,
    };
    const sourceStat = recoveryTool.grainReplayReceiptSourceStat(
        fs.lstatSync(fixtureSource, { bigint: true }));
    const receipt = {
        schema: recoveryTool.PREPARED_GRAIN_REPLAY_RECEIPT_SCHEMA,
        contract_id:
            recoveryTool.PREPARED_GRAIN_REPLAY_RECEIPT_CONTRACT_ID,
        state: 'prepared',
        source_before: {
            stat: sourceStat,
            fingerprint: fixtureFingerprint,
        },
        source_after: {
            stat: sourceStat,
            fingerprint: fixtureFingerprint,
        },
        source_classification: {
            eligible: true,
            profile: 'sdr',
            label: 'SDR',
        },
        runtime: runtimeReceipt,
        table: {
            size_bytes: fs.statSync(tablePath).size,
            sha256_full: sha256File(tablePath),
        },
        manifest: {
            size_bytes: fs.statSync(manifestPath).size,
            sha256_full: sha256File(manifestPath),
        },
        duration_seconds: 120,
        process_group_absent: true,
        generation_scoped_lock_released: true,
        process_group: {
            pgid: 4242,
            exit_code: 0,
            exit_signal: null,
            absent: true,
            supervision_events: [
                {
                    reason: 'leader_completion',
                    check: 'process_group_alive',
                    alive: false,
                },
                {
                    reason: 'post_deadline_cleanup',
                    check: 'process_group_alive',
                    alive: false,
                },
                {
                    reason: 'absence_poll',
                    check: 'process_group_alive',
                    alive: false,
                },
                {
                    reason: 'final_absence_proof',
                    check: 'process_group_alive',
                    alive: false,
                },
            ],
        },
        production_lock: {
            token: ['private', 'retained', 'grain', 'replay', '4242', '1', '100']
                .join('-'),
            lease_generation: 'lease-4242-1-101',
            automatic_stale_break_disabled: true,
            retained: false,
            generation_scoped_release: true,
        },
    };
    writePrivateFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    const replay = {
        manifest_path: manifestPath,
        manifest_sha256_full: sha256File(manifestPath),
        table_path: tablePath,
        table_sha256_full: sha256File(tablePath),
        pipeline_path: runtimePins.pipeline.resolvedPath,
        pipeline_sha256_full: runtimePins.pipeline.sha256,
        receipt_path: receiptPath,
        receipt_sha256_full: sha256File(receiptPath),
        expected_profile: 'sdr',
    };
    const authenticated =
        recoveryTool.authenticatePreparedGrainReplayReceipt(
            replay,
            fixtureSource,
            fixtureFingerprint,
            { runtimePins }
        );
    assert.strictEqual(authenticated.receipt.state, 'prepared');
    assert.strictEqual(authenticated.snapshots.length, 12);
    recoveryTool.assertPreparedGrainReplayUnchanged(authenticated);

    const unsafeReceipt = {
        ...receipt,
        generation_scoped_lock_released: false,
    };
    fs.writeFileSync(
        receiptPath,
        `${JSON.stringify(unsafeReceipt)}\n`,
        { mode: 0o600 });
    assert.throws(() =>
        recoveryTool.authenticatePreparedGrainReplayReceipt(
            {
                ...replay,
                receipt_sha256_full: sha256File(receiptPath),
            },
            fixtureSource,
            fixtureFingerprint,
            { runtimePins }
        ),
    /does not authorize successful completion/,
    'a receipt without proved lease release must not authorize replay');
    fs.writeFileSync(
        receiptPath,
        `${JSON.stringify(receipt)}\n`,
        { mode: 0o600 });
    replay.receipt_sha256_full = sha256File(receiptPath);

    const advisoryOnlyReceipt = {
        ...receipt,
        process_group: {
            ...receipt.process_group,
            absent: false,
        },
    };
    fs.writeFileSync(
        receiptPath,
        `${JSON.stringify(advisoryOnlyReceipt)}\n`,
        { mode: 0o600 });
    assert.throws(() =>
        recoveryTool.authenticatePreparedGrainReplayReceipt(
            {
                ...replay,
                receipt_sha256_full: sha256File(receiptPath),
            },
            fixtureSource,
            fixtureFingerprint,
            { runtimePins }
        ),
    /process-group proof is incomplete/,
    'a top-level advisory boolean cannot override a failed process-group proof');
    fs.writeFileSync(
        receiptPath,
        `${JSON.stringify(receipt)}\n`,
        { mode: 0o600 });
    replay.receipt_sha256_full = sha256File(receiptPath);

    const runtimeDriftReceipt = {
        ...receipt,
        runtime: {
            ...receipt.runtime,
            nvencc: {
                ...receipt.runtime.nvencc,
                sha256_full: 'f'.repeat(64),
            },
        },
    };
    fs.writeFileSync(
        receiptPath,
        `${JSON.stringify(runtimeDriftReceipt)}\n`,
        { mode: 0o600 });
    assert.throws(() =>
        recoveryTool.authenticatePreparedGrainReplayReceipt(
            {
                ...replay,
                receipt_sha256_full: sha256File(receiptPath),
            },
            fixtureSource,
            fixtureFingerprint,
            { runtimePins }
        ),
    /runtime differs from the pinned r2 identity/,
    'receipt authorization must bind all reviewed runtime identities');
    fs.writeFileSync(
        receiptPath,
        `${JSON.stringify(receipt)}\n`,
        { mode: 0o600 });
    replay.receipt_sha256_full = sha256File(receiptPath);

    assert.throws(() =>
        recoveryTool.authenticatePreparedGrainReplayReceipt(
            {
                ...replay,
                receipt_sha256_full: '0'.repeat(64),
            },
            fixtureSource,
            fixtureFingerprint,
            { runtimePins }
        ),
    /receipt bytes differ/,
    'the recovery request must bind the exact receipt bytes');

    const wrongFingerprint = {
        ...fixtureFingerprint,
        sha256: '9'.repeat(64),
    };
    assert.throws(() =>
        recoveryTool.authenticatePreparedGrainReplayReceipt(
            replay,
            fixtureSource,
            wrongFingerprint,
            { runtimePins }
        ),
    /source boundary differs/,
    'receipt source boundaries must equal independently reviewed source evidence');
}

try {
    fs.mkdirSync(checkpointRoot);
    fs.mkdirSync(workDir);
    fs.writeFileSync(sourcePath, Buffer.alloc(131072, 0x41));
    fs.writeFileSync(coordinatorPath, Buffer.alloc(4096, 0x51));
    fs.writeFileSync(producerPath, Buffer.alloc(4096, 0x52));
    fs.writeFileSync(consumerPath, Buffer.alloc(4096, 0x53));
    [coordinatorPath, producerPath, consumerPath].forEach((filePath) => {
        fs.chmodSync(filePath, 0o755);
    });
    checkpoint.initializeReuseRequiredRoot(reuseRequiredRoot);

    testPreDispatchStateAndExecutionAttestation();
    testIndependentSourceBackupGate();
    testAuthenticatedCommonJsLoader();
    testPrivateCliErrorsAreSanitized();
    testPreparedGrainReplayReceiptAuthorization();

    const fingerprint = sourceFingerprint();
    const legacyContract = buildLegacyContract();
    const normalized = recoveryTool.normalizeLegacyProducerLogContract(
        legacyContract, legacyProducerLog, legacyJobWorkDir);
    assert.deepStrictEqual(normalized.changedPaths, [
        `argv[${normalized.producerLogArgvIndex}]`,
    ]);
    assert.strictEqual(
        normalized.normalizedContract.argv[normalized.producerLogArgvIndex],
        recoveryTool.PRODUCER_LOG_TOKEN);
    checkpoint.assertEncodeContract(normalized.normalizedContract);
    assert.throws(() => checkpoint.assertEncodeContract(legacyContract),
        /not bound to its pipeline/,
        'ordinary planning must not silently accept a job-scoped legacy path');

    const repeatedPath = JSON.parse(JSON.stringify(legacyContract));
    repeatedPath.unreviewed_diagnostic = legacyProducerLog;
    assert.throws(() => recoveryTool.normalizeLegacyProducerLogContract(
        repeatedPath, legacyProducerLog, legacyJobWorkDir), /ambiguous/,
    'the old path may occur in exactly one reviewed argv slot');
    const duplicateOption = JSON.parse(JSON.stringify(legacyContract));
    duplicateOption.argv.splice(
        duplicateOption.argv.indexOf('--'), 0, '--producer-log', legacyProducerLog);
    assert.throws(() => recoveryTool.normalizeLegacyProducerLogContract(
        duplicateOption, legacyProducerLog, legacyJobWorkDir), /one pre-delimiter/,
    'a second producer-log option must fail closed');
    assert.throws(() => recoveryTool.normalizeLegacyProducerLogContract(
        legacyContract, '/temp/unrelated/producer.nvencc.log', legacyJobWorkDir),
    /recognized job-owned|independently expected/,
    'normalization must not rewrite an unrelated absolute path');

    const legacyIds = checkpointIdentities(fingerprint, legacyContract);
    const normalizedIds = checkpointIdentities(
        fingerprint, normalized.normalizedContract);
    const bucketDir = path.join(checkpointRoot, legacyIds.checkpointKey.slice(0, 2));
    const entryDir = path.join(bucketDir, legacyIds.checkpointKey);
    fs.mkdirSync(entryDir, { recursive: true });
    const quarantineSuffix = '.invalid-1782744454000-123-abcdef123456';
    const retainedName = `fixture.postencode-candidate.mkv${quarantineSuffix}`;
    const retainedPath = path.join(entryDir, retainedName);
    fs.writeFileSync(retainedPath, Buffer.alloc(32768, 0x62));
    const retainedSha256 = sha256File(retainedPath);
    const manifestPath = path.join(entryDir, `candidate.json${quarantineSuffix}`);
    const manifest = {
        schema: 1,
        contract_id: recoveryTool.CHECKPOINT_CONTRACT_ID,
        state: 'ffmpeg_exit_0_pending_validation',
        checkpoint_key: legacyIds.checkpointKey,
        source_fingerprint: fingerprint,
        encode_contract_sha256: legacyIds.encodeContractSha256,
        encode_contract: legacyContract,
        artifact: {
            relative_path: 'fixture.postencode-candidate.mkv',
            staged_relative_path: '.encode-partial-fixture.mkv',
            size_bytes: fs.statSync(retainedPath).size,
            sha256_full: retainedSha256,
        },
        staged_at: '2026-07-25T00:00:00.000Z',
        hashed_at: '2026-07-25T00:01:00.000Z',
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const expected = {
        legacy_manifest_sha256_full: sha256File(manifestPath),
        legacy_checkpoint_key: legacyIds.checkpointKey,
        legacy_encode_contract_sha256: legacyIds.encodeContractSha256,
        legacy_job_work_dir: legacyJobWorkDir,
        legacy_producer_log_path: legacyProducerLog,
        source_fingerprint: fingerprint,
        source_sha256_full: sha256File(sourcePath),
        retained_sha256_full: retainedSha256,
        retained_size_bytes: fs.statSync(retainedPath).size,
        normalized_encode_contract_sha256: normalizedIds.encodeContractSha256,
        normalized_checkpoint_key: normalizedIds.checkpointKey,
    };

    let evidence = recoveryTool.authenticateLegacyEvidence({
        checkpoint,
        checkpointRoot,
        sourcePath,
        legacyManifestPath: manifestPath,
        legacyRetainedPath: retainedPath,
        expected,
    });
    assert.strictEqual(evidence.legacyCheckpointKey, legacyIds.checkpointKey);
    assert.strictEqual(evidence.normalizedCheckpointKey, normalizedIds.checkpointKey);
    assert.deepStrictEqual(evidence.normalizedContract, normalized.normalizedContract);

    const wrongManifestIdentity = Object.assign({}, expected, {
        legacy_manifest_sha256_full: '0'.repeat(64),
    });
    assert.throws(() => recoveryTool.authenticateLegacyEvidence({
        checkpoint,
        checkpointRoot,
        sourcePath,
        legacyManifestPath: manifestPath,
        legacyRetainedPath: retainedPath,
        expected: wrongManifestIdentity,
    }), /manifest bytes do not match/,
    'a request cannot relabel different legacy manifest bytes');
    const outsideRetainedPath = path.join(scratch, 'outside-retained-candidate.mkv');
    fs.copyFileSync(retainedPath, outsideRetainedPath);
    assert.throws(() => recoveryTool.authenticateLegacyEvidence({
        checkpoint,
        checkpointRoot,
        sourcePath,
        legacyManifestPath: manifestPath,
        legacyRetainedPath: outsideRetainedPath,
        expected,
    }), /exact quarantined pair/,
    'candidate bytes outside the authenticated keyed entry must be rejected');

    const hardLinkPath = path.join(scratch, 'hard-linked-candidate.mkv');
    fs.linkSync(retainedPath, hardLinkPath);
    assert.throws(() => recoveryTool.snapshotRegularFile(
        retainedPath, 'hard-linked fixture', { singleLink: true }), /hard-linked/,
    'legacy evidence with another writable name must be rejected');
    fs.unlinkSync(hardLinkPath);
    evidence = recoveryTool.authenticateLegacyEvidence({
        checkpoint,
        checkpointRoot,
        sourcePath,
        legacyManifestPath: manifestPath,
        legacyRetainedPath: retainedPath,
        expected,
    });

    const mutablePath = path.join(scratch, 'mutable-evidence.bin');
    fs.writeFileSync(mutablePath, Buffer.alloc(128, 0x70));
    const mutableSnapshot = recoveryTool.snapshotRegularFile(
        mutablePath, 'mutable fixture', { singleLink: true });
    fs.appendFileSync(mutablePath, Buffer.from([0x71]));
    assert.throws(() => recoveryTool.assertSnapshotUnchanged(
        mutableSnapshot, 'mutable fixture'), /changed during recovery/,
    'post-authentication mutation must be detected');

    let buildCalls = 0;
    let importCalls = 0;
    const validator = (candidatePath) => ({
        validator: recoveryTool.EXHAUSTIVE_VALIDATOR,
        full_primary_video_decode: true,
        codec: 'av1',
        size_bytes: fs.statSync(candidatePath).size,
    });
    const fakeRecovery = {
        contractId: recoveryTool.IMPORT_CONTRACT_ID,
        buildRetainedRecoveryPlan(request) {
            buildCalls += 1;
            assert.strictEqual(request.sourcePath, sourcePath);
            assert.strictEqual(request.requireInitializedReuseRequiredRoot, true);
            const plan = checkpoint.buildPlan({
                workDir: request.workDir,
                checkpointRoot: request.checkpointRoot,
                reuseRequiredRoot: request.reuseRequiredRoot,
                requireInitializedReuseRequiredRoot: true,
                sourceFingerprint: fingerprint,
                encodeContract: normalized.normalizedContract,
                extension: '.mkv',
                validateArtifact: validator,
            });
            return {
                plan,
                validator,
                sourceFingerprint: fingerprint,
                encodeContract: normalized.normalizedContract,
            };
        },
        importRetainedCheckpoint() {
            importCalls += 1;
            return checkpoint.importRetained.apply(checkpoint, arguments);
        },
    };
    const mismatchWorkDir = path.join(scratch, 'mismatch-work');
    fs.mkdirSync(mismatchWorkDir);
    let mismatchImportCalls = 0;
    assert.throws(() => recoveryTool.performRecovery({
        evidence,
        recovery: {
            contractId: recoveryTool.IMPORT_CONTRACT_ID,
            buildRetainedRecoveryPlan() {
                return {
                    plan: { encodeContract: legacyContract },
                    encodeContract: legacyContract,
                    sourceFingerprint: fingerprint,
                    validator,
                };
            },
            importRetainedCheckpoint() {
                mismatchImportCalls += 1;
            },
        },
        expected,
        workDir: mismatchWorkDir,
        checkpointRoot,
        reuseRequiredRoot,
    }), /does not exactly equal/,
    'a fresh planner contract mismatch must abort before staging or import');
    assert.strictEqual(mismatchImportCalls, 0);
    assert.deepStrictEqual(fs.readdirSync(mismatchWorkDir), []);

    const recovered = recoveryTool.performRecovery({
        evidence,
        recovery: fakeRecovery,
        expected,
        workDir,
        checkpointRoot,
        reuseRequiredRoot,
        enforcePinnedStorage: false,
        ffmpegPath: 'fixture-ffmpeg',
        ffprobePath: 'fixture-ffprobe',
        sourceProbe: { streams: [{ codec_type: 'video' }], format: { duration: '10' } },
        variables: { fixture: true },
    });
    assert.strictEqual(buildCalls, 1);
    assert.strictEqual(importCalls, 1);
    assert.strictEqual(recovered.result.plan.reused, true);
    assert.strictEqual(
        recovered.result.plan.manifest.media_validation.validator,
        recoveryTool.EXHAUSTIVE_VALIDATOR);
    assert.strictEqual(
        recovered.result.plan.manifest.media_validation.full_primary_video_decode, true);
    assert.strictEqual(recovered.result.latch.marker.checkpoint_key,
        normalizedIds.checkpointKey);
    assert(fs.existsSync(manifestPath), 'legacy manifest must remain in place');
    assert(fs.existsSync(retainedPath), 'legacy retained candidate must remain in place');
    assert.strictEqual(sha256File(manifestPath), expected.legacy_manifest_sha256_full);
    assert.strictEqual(sha256File(retainedPath), expected.retained_sha256_full);
    assert(fs.existsSync(recovered.staged.resolved),
        'the import source must be a separate authenticated copy outside checkpoint storage');

    const freshPlan = checkpoint.buildPlan({
        workDir,
        checkpointRoot,
        reuseRequiredRoot,
        requireInitializedReuseRequiredRoot: true,
        sourceFingerprint: fingerprint,
        encodeContract: normalized.normalizedContract,
        extension: '.mkv',
        validateArtifact: validator,
    });
    assert.strictEqual(freshPlan.reused, true,
        'the exact normalized plan must reuse the imported generation');
    assert.strictEqual(freshPlan.checkpointKey, normalizedIds.checkpointKey);

    console.log('PASS legacy job-scoped producer-log recovery authenticates both generations, ' +
        'binds the prepared replay receipt, imports through exhaustive validation, ' +
        'arms reuse, and preserves legacy evidence');
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}
