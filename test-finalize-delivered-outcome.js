'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const validator = require(
  './plugins/vmaf/validateDeliveryCandidate/1.0.0/index.js');
const replacementAttestation = require(
  './plugins/vmaf/_lib/postReplaceAttestation.js');
const deliveryFinalization = require(
  './plugins/vmaf/_lib/deliveryFinalization.js');
const finalizer = require(
  './plugins/vmaf/finalizeDeliveredOutcome/1.0.0/index.js');

const POLICY_VERSION = 'delivered-minimum-reduction-v1';
const TRANSACTION_SCHEMA = 'vmaf-delivery-transaction/v1';
const TRANSACTION_VERSION = 1;
const TRANSACTION_ID = 'd'.repeat(64);
const CHECKPOINT_KEY = 'a'.repeat(64);
const TRANSACTION_STATES = Object.freeze({
  reserved: 1,
  installed_pending_finalize: 2,
  delivery_committing: 3,
  delivered: 4,
});
const TERMINAL_NULL_FIELDS = [
  'transcode_succeeded',
  'met_vmaf_target',
  'final_output_size_mb',
  'final_output_ratio_pct',
  'actual_size_reduction_pct',
  'met_size_target',
  'delivered_at',
  'replacement_attestation_version',
  'replacement_backup_retained',
  'skip_reason',
];

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function candidateRow(jobId, sourcePath, stage, transactionId, checkpointKey) {
  return {
    job_id: jobId,
    file_path: sourcePath,
    transcode_succeeded: null,
    met_vmaf_target: null,
    final_output_size_mb: null,
    final_output_ratio_pct: null,
    actual_size_reduction_pct: null,
    met_size_target: null,
    size_target_status: 'pending_delivery',
    target_size_reduction_pct: 30,
    minimum_size_reduction_pct: 20,
    max_final_output_ratio_pct: 80,
    size_policy_version: POLICY_VERSION,
    outcome_stage: stage || 'delivery_committing',
    delivered_at: null,
    replacement_attestation_version: null,
    replacement_backup_retained: null,
    delivery_transaction_id: transactionId || TRANSACTION_ID,
    delivery_checkpoint_key: checkpointKey || CHECKPOINT_KEY,
    skip_reason: null,
  };
}

function makeDatabase(rows) {
  const rowMap = new Map(rows.map((row) => [row.job_id, { ...row }]));
  const state = {
    rows: rowMap,
    terminalCasCalls: 0,
    terminalMutations: 0,
    terminalBusyRemaining: 0,
    failTerminal: false,
    corruptTerminalField: null,
    corruptTerminalValue: undefined,
  };
  function busy(message) {
    const error = new Error(message || 'database is locked');
    error.code = 'SQLITE_BUSY';
    return error;
  }
  const db = {
    prepare(sql) {
      if (sql.startsWith('SELECT ')) {
        return {
          get(jobId) {
            const row = state.rows.get(jobId);
            return row ? { ...row } : undefined;
          },
        };
      }
      if (sql.includes('SET transcode_succeeded = ?')) {
        return {
          run(...values) {
            state.terminalCasCalls += 1;
            if (state.terminalBusyRemaining > 0) {
              state.terminalBusyRemaining -= 1;
              throw busy('injected terminal CAS busy');
            }
            if (state.failTerminal) {
              throw new Error('injected terminal CAS failure');
            }
            const [
              transcodeSucceeded,
              metVmafTarget,
              finalSizeMb,
              finalRatio,
              actualReduction,
              metSizeTarget,
              sizeStatus,
              target,
              minimum,
              cap,
              policyVersion,
              outcomeStage,
              deliveredAt,
              attestationVersion,
              backupRetained,
              updatedAt,
              jobId,
              transactionId,
              checkpointKey,
            ] = values;
            const row = state.rows.get(jobId);
            if (!row || row.outcome_stage !== 'delivery_committing' ||
                row.delivery_transaction_id !== transactionId ||
                row.delivery_checkpoint_key !== checkpointKey ||
                row.size_target_status !== 'pending_delivery' ||
                TERMINAL_NULL_FIELDS.some((field) => row[field] !== null)) {
              return { changes: 0 };
            }
            Object.assign(row, {
              transcode_succeeded: transcodeSucceeded,
              met_vmaf_target: metVmafTarget,
              final_output_size_mb: finalSizeMb,
              final_output_ratio_pct: finalRatio,
              actual_size_reduction_pct: actualReduction,
              met_size_target: metSizeTarget,
              size_target_status: sizeStatus,
              target_size_reduction_pct: target,
              minimum_size_reduction_pct: minimum,
              max_final_output_ratio_pct: cap,
              size_policy_version: policyVersion,
              outcome_stage: outcomeStage,
              delivered_at: deliveredAt,
              replacement_attestation_version: attestationVersion,
              replacement_backup_retained: backupRetained,
              skip_reason: null,
              updated_at: updatedAt,
            });
            if (state.corruptTerminalField) {
              row[state.corruptTerminalField] = state.corruptTerminalValue;
            }
            state.terminalMutations += 1;
            return { changes: 1 };
          },
        };
      }
      throw new Error(`unexpected SQL in focused DB fake: ${sql}`);
    },
  };
  return {
    db,
    state,
    vmafdb: { openDb() { return db; } },
  };
}

function makeTransactionJournal(fixture) {
  const state = {
    transitionCalls: 0,
    failTransitionRemaining: 0,
    journal: {
      schema: TRANSACTION_SCHEMA,
      version: TRANSACTION_VERSION,
      transaction_id: TRANSACTION_ID,
      job_id: fixture.jobId,
      checkpoint_key: fixture.checkpoint.checkpoint_key,
      state: 'delivery_committing',
      revision: TRANSACTION_STATES.delivery_committing,
      pending_proof: {
        evidence: clone(fixture.variables.vmafDeliveryOutcomePending),
      },
      candidate_validation: {
        evidence: clone(fixture.variables.vmafDeliveryCandidateValidation),
      },
      replacement: {
        evidence: clone(fixture.variables.vmafReplacementAttestation),
      },
    },
  };
  const transaction = {
    SCHEMA: TRANSACTION_SCHEMA,
    VERSION: TRANSACTION_VERSION,
    STATES: TRANSACTION_STATES,
    canonicalJson,
    validate() {
      const journal = state.journal;
      if (!journal || journal.schema !== TRANSACTION_SCHEMA ||
          journal.version !== TRANSACTION_VERSION ||
          !TRANSACTION_STATES[journal.state]) {
        return {
          valid: false,
          reason: 'injected invalid transaction journal',
        };
      }
      return { valid: true, reason: null, journal: clone(journal) };
    },
    transition(checkpoint, expectedState, nextState, input) {
      state.transitionCalls += 1;
      if (state.failTransitionRemaining > 0) {
        state.failTransitionRemaining -= 1;
        throw new Error('injected journal transition failure');
      }
      const journal = state.journal;
      assert.strictEqual(
        checkpoint.checkpoint_key,
        journal.checkpoint_key,
        'journal transition checkpoint binding changed',
      );
      const finalization = input && input.deliveryFinalization;
      if (journal.state === nextState) {
        if (!journal.delivered ||
            canonicalJson(journal.delivered.evidence) !==
              canonicalJson(finalization)) {
          throw new Error('immutable delivered fields differ');
        }
        return clone(journal);
      }
      if (journal.state !== expectedState ||
          expectedState !== 'delivery_committing' ||
          nextState !== 'delivered') {
        throw new Error('invalid delivery transaction transition');
      }
      journal.state = 'delivered';
      journal.revision = TRANSACTION_STATES.delivered;
      journal.delivered = {
        schema: finalization.schema,
        evidence: clone(finalization),
      };
      return clone(journal);
    },
  };
  return { state, transaction };
}

function makeFixture(label, candidateBytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `tdarr-finalize-v2-${label}-`));
  const workDir = path.join(root, 'work');
  const mediaDir = path.join(root, 'media');
  fs.mkdirSync(workDir);
  fs.mkdirSync(mediaDir);
  const originalPath = path.join(mediaDir, 'title.mkv');
  const candidatePath = path.join(workDir, 'title-candidate.mkv');
  fs.writeFileSync(originalPath, Buffer.alloc(1000, 0x31));
  fs.writeFileSync(candidatePath, Buffer.alloc(candidateBytes, 0x42));
  const checkpoint = {
    schema: 'tdarr-vmaf-postencode-checkpoint',
    checkpoint_key: CHECKPOINT_KEY,
  };
  const jobId = 'job-1';
  const logs = [];
  const variables = {
    vmafCanonicalJobId: jobId,
    vmafPostEncodeCheckpoint: checkpoint,
    vmafDeliveryOutcomePending: {
      schema: 'vmaf-delivery-outcome-pending/v1',
      version: 1,
      status: 'candidate_ready',
      recorded_at: new Date().toISOString(),
      database_recorded: true,
      job_id: jobId,
      checkpoint_key: checkpoint.checkpoint_key,
      source_path: originalPath,
      size_policy_version: POLICY_VERSION,
      target_size_reduction_pct: 30,
      minimum_size_reduction_pct: 20,
      max_final_output_ratio_pct: 80,
    },
  };
  const validationArgs = {
    inputFileObj: { _id: candidatePath },
    originalLibraryFile: { _id: originalPath },
    variables,
    workDir,
    jobLog(message) { logs.push(String(message)); },
  };
  const validated = validator._test.validate(validationArgs);
  assert.strictEqual(validated.assessment.accepted, true);
  variables.vmafDeliveryCandidateValidationConsumedAt = new Date().toISOString();
  variables.vmafDeliveryOutcomePending.source_path = validated.evidence.source.path;

  const backupPath = replacementAttestation.exactBackupPath(originalPath);
  fs.renameSync(originalPath, backupPath);
  fs.renameSync(candidatePath, originalPath);
  variables.vmafReplacementAttestation = replacementAttestation.create({
    targetPath: originalPath,
    originalPath,
    checkpointKey: checkpoint.checkpoint_key,
    backupRetained: true,
  });
  const fixture = {
    root,
    workDir,
    originalPath,
    candidatePath,
    backupPath,
    checkpoint,
    jobId,
    variables,
    logs,
    args: {
      inputFileObj: { _id: originalPath },
      originalLibraryFile: { _id: originalPath },
      variables,
      workDir,
      jobLog(message) { logs.push(String(message)); },
    },
  };
  const transaction = makeTransactionJournal(fixture);
  fixture.transactionState = transaction.state;
  fixture.deliveryTransaction = transaction.transaction;
  variables.vmafDeliveryTransactionId = TRANSACTION_ID;
  variables.vmafDeliveryTransactionState = 'delivery_committing';
  variables.vmafDeliveryTransaction = {
    schema: TRANSACTION_SCHEMA,
    version: TRANSACTION_VERSION,
    transaction_id: TRANSACTION_ID,
    job_id: jobId,
    checkpoint_key: checkpoint.checkpoint_key,
    state: 'delivery_committing',
    revision: TRANSACTION_STATES.delivery_committing,
  };
  return fixture;
}

function dependencies(fixture, database, overrides) {
  const state = {
    fsyncDirectories: [],
    dbDelays: [],
  };
  return {
    state,
    value: {
      db: database.db,
      vmafdb: database.vmafdb,
      deliveryTransaction: fixture.deliveryTransaction,
      dbDelay: async (ms) => { state.dbDelays.push(ms); },
      backupDelay: async () => {},
      fsyncParentDirectory: async (directory) => {
        state.fsyncDirectories.push(directory);
      },
      ...(overrides || {}),
    },
  };
}

async function runFinalizer(fixture, database, overrides) {
  const deps = dependencies(fixture, database, overrides);
  const result = await finalizer._test.finalizeDeliveredOutcome(
    fixture.args, deps.value);
  return { result, dependencyState: deps.state };
}

async function assertFatal(fixture, database, pattern, overrides) {
  const checkpointBefore = JSON.stringify(fixture.variables.vmafPostEncodeCheckpoint);
  await assert.rejects(
    () => runFinalizer(fixture, database, overrides),
    (error) => {
      assert.strictEqual(error.code, 'TDARR_VMAF_DELIVERY_FINALIZATION_FATAL');
      return pattern.test(error.message);
    },
  );
  assert.strictEqual(fixture.variables.vmafDeliveryFinalization, undefined);
  assert.strictEqual(fixture.variables.vmafDeliveryFinalizationStatus, 'failed');
  assert.strictEqual(
    JSON.stringify(fixture.variables.vmafPostEncodeCheckpoint),
    checkpointBefore,
    'fatal finalization must preserve the protected checkpoint record',
  );
}

async function main() {
  const created = [];
  try {
    const exact = makeFixture('exact-boundary', 800);
    created.push(exact.root);
    const exactDb = makeDatabase([
      candidateRow(exact.jobId, exact.originalPath),
    ]);
    const exactRun = await runFinalizer(exact, exactDb);
    assert.strictEqual(exactRun.result.outputNumber, 1);
    assert.strictEqual(exactRun.result.outputFileObj._id, exact.originalPath);
    assert.strictEqual(fs.existsSync(exact.backupPath), false);
    assert.deepStrictEqual(exactRun.dependencyState.fsyncDirectories,
      [path.dirname(exact.backupPath)]);
    assert.strictEqual(exactDb.state.terminalCasCalls, 1);
    assert.strictEqual(exact.transactionState.transitionCalls, 1);
    const exactRow = exactDb.state.rows.get(exact.jobId);
    assert.strictEqual(exactRow.outcome_stage, 'delivered');
    assert.strictEqual(exactRow.transcode_succeeded, 1);
    assert.strictEqual(exactRow.met_vmaf_target, 1);
    assert.strictEqual(exactRow.met_size_target, 1);
    assert.strictEqual(exactRow.final_output_ratio_pct, 80,
      'equality at the exact delivered-size cap must be accepted');
    assert.strictEqual(exactRow.actual_size_reduction_pct, 20);
    assert.strictEqual(exactRow.replacement_attestation_version,
      'tdarr-vmaf-post-replace-attestation/v2');
    assert.strictEqual(exactRow.replacement_backup_retained, 0);
    assert.strictEqual(exact.variables.vmafDeliveryFinalization.schema,
      'vmaf-delivery-finalization/v2');
    assert.strictEqual(exact.variables.vmafDeliveryFinalization.backup_disposition,
      'backup_removed');
    assert.strictEqual(deliveryFinalization.validate(
      exact.variables.vmafDeliveryFinalization,
      {
        checkpointRecord: exact.checkpoint,
        inputPath: exact.originalPath,
        originalPath: exact.originalPath,
        replacementAttestation: exact.variables.vmafReplacementAttestation,
      },
    ).valid, true);

    const retained = makeFixture('retained', 790);
    created.push(retained.root);
    const retainedDb = makeDatabase([
      candidateRow(retained.jobId, retained.originalPath),
    ]);
    const retainedOperations = {
      lstat: fs.promises.lstat.bind(fs.promises),
      unlink: async () => {
        const error = new Error('injected sharing violation');
        error.code = 'EPERM';
        throw error;
      },
    };
    const retainedRun = await runFinalizer(retained, retainedDb, {
      backupOperations: retainedOperations,
    });
    assert.strictEqual(fs.existsSync(retained.backupPath), true);
    assert.strictEqual(retainedRun.dependencyState.fsyncDirectories.length, 0);
    assert.strictEqual(
      retainedDb.state.rows.get(retained.jobId).replacement_backup_retained, 1);
    assert.strictEqual(
      retained.variables.vmafDeliveryFinalization.backup_disposition,
      'backup_retained');

    const resume = makeFixture('resume-committing', 790);
    created.push(resume.root);
    const resumeDb = makeDatabase([
      candidateRow(resume.jobId, resume.originalPath, 'delivery_committing'),
    ]);
    await runFinalizer(resume, resumeDb);
    assert.strictEqual(resumeDb.state.rows.get(resume.jobId).outcome_stage, 'delivered');
    assert.strictEqual(fs.existsSync(resume.backupPath), false);

    const removedCrash = makeFixture('resume-after-unlink', 790);
    created.push(removedCrash.root);
    fs.unlinkSync(removedCrash.backupPath);
    const removedCrashDb = makeDatabase([
      candidateRow(removedCrash.jobId, removedCrash.originalPath, 'delivery_committing'),
    ]);
    const removedCrashRun = await runFinalizer(removedCrash, removedCrashDb);
    assert.deepStrictEqual(removedCrashRun.dependencyState.fsyncDirectories,
      [path.dirname(removedCrash.backupPath)]);
    assert.strictEqual(
      removedCrashDb.state.rows.get(removedCrash.jobId).replacement_backup_retained, 0);

    const premature = makeFixture('premature-candidate-ready', 790);
    created.push(premature.root);
    const prematureDb = makeDatabase([
      candidateRow(
        premature.jobId,
        premature.originalPath,
        'candidate_ready',
      ),
    ]);
    await assertFatal(premature, prematureDb, /not in delivery_committing/);
    assert.strictEqual(fs.existsSync(premature.backupPath), true,
      'finalizer must not settle a backup before the replacement phase commits');
    assert.strictEqual(prematureDb.state.terminalCasCalls, 0);
    assert.strictEqual(premature.transactionState.transitionCalls, 0);

    const terminalFailure = makeFixture('terminal-failure', 790);
    created.push(terminalFailure.root);
    const terminalFailureDb = makeDatabase([
      candidateRow(terminalFailure.jobId, terminalFailure.originalPath),
    ]);
    terminalFailureDb.state.failTerminal = true;
    await assertFatal(
      terminalFailure, terminalFailureDb, /injected terminal CAS failure/);
    assert.strictEqual(
      terminalFailureDb.state.rows.get(terminalFailure.jobId).outcome_stage,
      'delivery_committing');
    assert.strictEqual(fs.existsSync(terminalFailure.backupPath), false);
    terminalFailureDb.state.failTerminal = false;
    await runFinalizer(terminalFailure, terminalFailureDb);
    assert.strictEqual(
      terminalFailureDb.state.rows.get(terminalFailure.jobId).outcome_stage,
      'delivered');

    const journalCrash = makeFixture('db-delivered-journal-committing', 790);
    created.push(journalCrash.root);
    const journalCrashDb = makeDatabase([
      candidateRow(journalCrash.jobId, journalCrash.originalPath),
    ]);
    journalCrash.transactionState.failTransitionRemaining = 1;
    await assertFatal(
      journalCrash,
      journalCrashDb,
      /injected journal transition failure/,
    );
    const crashDeliveredAt =
      journalCrashDb.state.rows.get(journalCrash.jobId).delivered_at;
    assert.strictEqual(
      journalCrashDb.state.rows.get(journalCrash.jobId).outcome_stage,
      'delivered',
      'DB delivery commit must remain immutable across a later journal fault',
    );
    assert.strictEqual(journalCrash.transactionState.journal.state,
      'delivery_committing');
    assert.strictEqual(fs.existsSync(journalCrash.backupPath), false);
    await runFinalizer(journalCrash, journalCrashDb);
    assert.strictEqual(journalCrash.transactionState.journal.state, 'delivered');
    assert.strictEqual(
      journalCrashDb.state.rows.get(journalCrash.jobId).delivered_at,
      crashDeliveredAt,
      'journal recovery must reuse the immutable DB delivered_at',
    );
    assert.strictEqual(
      journalCrash.variables.vmafDeliveryFinalization.delivered_at,
      crashDeliveredAt,
    );

    const busy = makeFixture('busy-retries', 790);
    created.push(busy.root);
    const busyDb = makeDatabase([
      candidateRow(busy.jobId, busy.originalPath),
    ]);
    busyDb.state.terminalBusyRemaining = 2;
    const busyRun = await runFinalizer(busy, busyDb);
    assert.strictEqual(busyDb.state.terminalCasCalls, 3);
    assert.deepStrictEqual(busyRun.dependencyState.dbDelays, [50, 150]);

    const idempotent = makeFixture('delivered-idempotent', 790);
    created.push(idempotent.root);
    const idempotentDb = makeDatabase([
      candidateRow(idempotent.jobId, idempotent.originalPath),
    ]);
    await runFinalizer(idempotent, idempotentDb);
    const immutableDeliveredAt =
      idempotentDb.state.rows.get(idempotent.jobId).delivered_at;
    const terminalCalls = idempotentDb.state.terminalCasCalls;
    await runFinalizer(idempotent, idempotentDb);
    assert.strictEqual(idempotentDb.state.terminalCasCalls, terminalCalls);
    assert.strictEqual(
      idempotentDb.state.rows.get(idempotent.jobId).delivered_at,
      immutableDeliveredAt,
      'a delivered rerun must not rewrite immutable delivered_at');
    delete idempotent.variables.vmafDeliveryFinalization;
    await runFinalizer(idempotent, idempotentDb);
    assert.strictEqual(
      idempotent.variables.vmafDeliveryFinalization.delivered_at,
      immutableDeliveredAt,
      'missing flow evidence must reconstruct from the exact immutable row');
    assert.strictEqual(idempotentDb.state.terminalCasCalls, terminalCalls);

    const wrongTransaction = makeFixture('wrong-transaction-row', 790);
    created.push(wrongTransaction.root);
    const wrongTransactionDb = makeDatabase([
      candidateRow(
        wrongTransaction.jobId,
        wrongTransaction.originalPath,
        undefined,
        'e'.repeat(64),
      ),
    ]);
    await assertFatal(
      wrongTransaction,
      wrongTransactionDb,
      /differs from the delivery transaction journal/,
    );
    assert.strictEqual(fs.existsSync(wrongTransaction.backupPath), true);
    assert.strictEqual(wrongTransactionDb.state.terminalCasCalls, 0);

    const wrongFlowTransaction = makeFixture('wrong-flow-transaction', 790);
    created.push(wrongFlowTransaction.root);
    wrongFlowTransaction.variables.vmafDeliveryTransactionId = 'e'.repeat(64);
    const wrongFlowTransactionDb = makeDatabase([
      candidateRow(wrongFlowTransaction.jobId, wrongFlowTransaction.originalPath),
    ]);
    await assertFatal(
      wrongFlowTransaction,
      wrongFlowTransactionDb,
      /flow delivery-transaction proof differs/,
    );
    assert.strictEqual(fs.existsSync(wrongFlowTransaction.backupPath), true);

    const journalEvidenceMismatch =
      makeFixture('journal-evidence-mismatch', 790);
    created.push(journalEvidenceMismatch.root);
    journalEvidenceMismatch.transactionState.journal.pending_proof
      .evidence.max_final_output_ratio_pct = 79;
    const journalEvidenceMismatchDb = makeDatabase([
      candidateRow(
        journalEvidenceMismatch.jobId,
        journalEvidenceMismatch.originalPath,
      ),
    ]);
    await assertFatal(
      journalEvidenceMismatch,
      journalEvidenceMismatchDb,
      /transaction pending proof differs from flow evidence/,
    );
    assert.strictEqual(fs.existsSync(journalEvidenceMismatch.backupPath), true);

    const wrongJob = makeFixture('wrong-existing-job', 790);
    created.push(wrongJob.root);
    const otherSource = path.join(wrongJob.root, 'other-source.mkv');
    fs.writeFileSync(otherSource, Buffer.alloc(1000, 0x55));
    const wrongJobDb = makeDatabase([
      candidateRow(wrongJob.jobId, otherSource),
    ]);
    await assertFatal(wrongJob, wrongJobDb, /not bound to the validated source/);

    const missingPending = makeFixture('missing-pending', 790);
    created.push(missingPending.root);
    delete missingPending.variables.vmafDeliveryOutcomePending;
    const missingPendingDb = makeDatabase([
      candidateRow(missingPending.jobId, missingPending.originalPath),
    ]);
    await assertFatal(missingPending, missingPendingDb,
      /exact recorded pending-delivery proof/);

    for (const [label, value] of [
      ['nan', NaN],
      ['text', 'not-a-number'],
      ['numeric-text', '79'],
      ['undefined', undefined],
      ['infinity', Infinity],
    ]) {
      const corrupt = makeFixture(`numeric-${label}`, 790);
      created.push(corrupt.root);
      const corruptDb = makeDatabase([
        candidateRow(corrupt.jobId, corrupt.originalPath),
      ]);
      corruptDb.state.corruptTerminalField = 'final_output_ratio_pct';
      corruptDb.state.corruptTerminalValue = value;
      await assertFatal(corrupt, corruptDb,
        /final_output_ratio_pct differs from the exact delivered outcome/);
      assert.strictEqual(corrupt.variables.vmafDeliveryFinalization, undefined);
    }

    const checkpointMismatch = JSON.parse(JSON.stringify(
      exact.variables.vmafDeliveryFinalization));
    assert.strictEqual(deliveryFinalization.validate(
      checkpointMismatch,
      {
        checkpointRecord: { checkpoint_key: 'b'.repeat(64) },
        inputPath: exact.originalPath,
        originalPath: exact.originalPath,
        replacementAttestation: exact.variables.vmafReplacementAttestation,
      },
    ).valid, false, 'finalization evidence must bind to the exact checkpoint');

    const finalizationContext = {
      checkpointRecord: exact.checkpoint,
      inputPath: exact.originalPath,
      originalPath: exact.originalPath,
      replacementAttestation: exact.variables.vmafReplacementAttestation,
    };
    for (const [label, mutate, pattern] of [
      [
        'source hash',
        (evidence) => { evidence.source_identity.sha256_full = 'f'.repeat(64); },
        /source identity differs from the attested original backup/,
      ],
      [
        'source size',
        (evidence) => { evidence.source_identity.size_bytes -= 1; },
        /source identity differs from the attested original backup/,
      ],
      [
        'delivered hash',
        (evidence) => {
          evidence.installed_identity.sha256_full = 'f'.repeat(64);
        },
        /installed file .*changed|replacement-installed file .*changed/,
      ],
      [
        'delivered size',
        (evidence) => { evidence.delivered_size_bytes -= 1; },
        /size evidence differs from the installed file/,
      ],
    ]) {
      const tampered = clone(exact.variables.vmafDeliveryFinalization);
      mutate(tampered);
      const validation = deliveryFinalization.validate(
        tampered,
        finalizationContext,
      );
      assert.strictEqual(validation.valid, false,
        `tampered ${label} must fail finalization validation`);
      assert.match(validation.reason, pattern);
    }
    const mismatchedDbRow = {
      ...exactRow,
      delivery_transaction_id: 'e'.repeat(64),
    };
    assert.strictEqual(deliveryFinalization.validateDatabaseRow(
      exact.variables.vmafDeliveryFinalization,
      mismatchedDbRow,
    ).valid, false, 'DB-row validation must bind the transaction id');

    const source = fs.readFileSync(
      'plugins/vmaf/finalizeDeliveredOutcome/1.0.0/index.js');
    const mirror = fs.readFileSync(
      'custom-cont-init.d/vmaf-plugin-patches/finalizeDeliveredOutcome/1.0.0/index.js');
    assert(source.equals(mirror), 'delivery finalizer source and deployment mirror differ');
    const helperSource = fs.readFileSync('plugins/vmaf/_lib/deliveryFinalization.js');
    const helperMirror = fs.readFileSync(
      'custom-cont-init.d/vmaf-plugin-patches/_lib/deliveryFinalization.js');
    assert(helperSource.equals(helperMirror),
      'delivery finalization helper source and deployment mirror differ');

    console.log(
      'PASS two-phase delivered finalizer: CAS, backup retirement, crash resume, immutable retry'
    );
  } finally {
    for (const directory of created) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
