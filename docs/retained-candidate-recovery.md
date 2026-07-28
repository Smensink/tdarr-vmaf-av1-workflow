# Retained candidate recovery

## 2026-07-28 operator disposition

The project owner explicitly waived this failed-job recovery and directed the
drained deployment to proceed to r3. No retry was dispatched. The retained
candidate, source-scoped latch/checkpoint material, rollback copy, and earlier
evidence were preserved rather than consumed or deleted.

This document remains the procedure for a future decision to revisit that
candidate; its terminal-recovery and post-recovery-evidence gates were not
completed in the r3 rollout. The verified private generation used later for
runtime-settings convergence is pre-r3 evidence, not post-recovery evidence.
See the [r3 rollout record](r3-rollout-evidence-2026-07-28.md) for the
deployment boundary.

`build-scripts/recover-legacy-job-scoped-checkpoint.js` is a narrow,
import-and-arm migration utility for one historical checkpoint defect. Older
canonical-denoise contracts included the disposable Tdarr job path used by
`--producer-log`; a later job could not derive the same checkpoint key even
when every encode input and output byte was unchanged.

The public utility does not queue a job, open workers, replace a source,
restart Tdarr, or claim that its checks remain current for a later dispatch.
It authenticates the quarantined FFmpeg-exit-0 evidence, changes exactly one
contract value to `<PRODUCER_LOG>`, proves the normalized contract equals a
fresh plan from the reviewed deployed transcode plugin, copies the retained
candidate to a fresh work directory, and imports it through the existing
full-decode validator. Successful import publishes the normalized checkpoint
and arms the source-scoped reuse-required latch.

The actual one-shot queue dispatcher is private because its spec contains
source paths, Flow inputs, node identities, and deployment evidence. Its
schema-2 gate is described below so the boundary is auditable without
publishing those values.

## Safe sequence

1. Pause admission without cancelling work. Let every current job finish,
   pause every node, set all four worker limits to zero, and prove the API,
   production GPU lock, process tree, and every external node are idle.
2. Preserve the exact r2 generation and take private online database,
   configuration, active-Flow, and report backups.
3. Create an owner-only full-byte source-media copy on a different filesystem
   device beneath a protected root outside every live media root. Verify both
   source and copy against one reviewed size and full SHA-256.
4. Compile the private schema-1 import request from the original quarantined
   evidence. Independently prove that the normalized contract changes only
   the unique value after `--producer-log`.
5. Run the public importer once. Keep the legacy manifest and retained
   candidate unchanged.
6. Build and independently review the private schema-2 dispatch spec. Run its
   one-shot dispatcher while r2 is still installed. The dispatcher repeats all
   state and artifact gates immediately before its FileJSONDB queue write and
   again after queue read-back before opening a worker.
7. Require an exact retained-checkpoint reuse with no encoder launch, then
   prove authoritative terminal success and the installed media identity.
8. While still paused, take fresh post-recovery backups and only then continue
   with a drained r3 rollout.

The quiescence assertion is read-only:

```bash
docker cp build-scripts/assert-tdarr-quiescence.js \
  tdarr:/tmp/assert-tdarr-quiescence.js
docker exec tdarr node /tmp/assert-tdarr-quiescence.js
```

Its pass applies only to the observed PID namespace and instant. It is not a
lease on future idleness.

## Import request: schema 1

The public importer deliberately retains contract
`vmaf-legacy-producer-log-checkpoint-recovery-v1`:

```json
{
  "schema": 1,
  "contract_id": "vmaf-legacy-producer-log-checkpoint-recovery-v1",
  "expected_recovery_utility_sha256": "<64 lowercase hex>",
  "plugin_path": "/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/vmaf/vmafOptimizedTranscode/1.0.0/index.js",
  "expected_plugin_sha256": "<64 lowercase hex>",
  "expected_helper_sha256": {
    "canonicalDenoise.js": "<64 lowercase hex>",
    "grainAnalysisArtifact.js": "<64 lowercase hex>",
    "grainVmafContract.js": "<64 lowercase hex>",
    "nvenccKnn.js": "<64 lowercase hex>",
    "nvencTemporalFilter.js": "<64 lowercase hex>",
    "postEncodeCheckpoint.js": "<64 lowercase hex>"
  },
  "source_path": "<absolute current source path>",
  "legacy_candidate_manifest_path": "<absolute candidate.json.invalid-* path>",
  "legacy_retained_candidate_path": "<absolute postencode-candidate*.invalid-* path>",
  "work_dir": "/temp/tdarr-legacy-recovery-<reviewed-id>",
  "checkpoint_root": "/temp/.vmaf-postencode-checkpoints-v1",
  "reuse_required_root": "/app/configs/vmaf-postencode-reuse-required-v1",
  "ffmpeg_path": "tdarr-ffmpeg",
  "ffprobe_path": "tdarr-ffprobe",
  "variables": {
    "<terminal job contract>": "<private value>"
  },
  "expected": {
    "legacy_manifest_sha256_full": "<64 lowercase hex>",
    "legacy_checkpoint_key": "<64 lowercase hex>",
    "legacy_encode_contract_sha256": "<64 lowercase hex>",
    "legacy_job_work_dir": "/temp/tdarr-workDir-<old-job-id>",
    "legacy_producer_log_path": "/temp/tdarr-workDir-<old-job-id>/<output>.nvencc.log",
    "source_fingerprint": {
      "scheme": "sha256-sampled-v1",
      "sha256": "<64 lowercase hex>",
      "size_bytes": "<positive integer>",
      "mtime_ns": "<integer>",
      "sample_bytes": "<positive integer>",
      "sample_offsets": ["<integer>"],
      "resolved_path": "<same source path>"
    },
    "source_sha256_full": "<64 lowercase hex>",
    "retained_sha256_full": "<64 lowercase hex>",
    "retained_size_bytes": "<positive integer>",
    "normalized_encode_contract_sha256": "<64 lowercase hex>",
    "normalized_checkpoint_key": "<64 lowercase hex>"
  }
}
```

An SDR prepared grain generation adds `prepared_grain_replay` with
`manifest_path`, `table_path`, `pipeline_path`, `receipt_path`, a full SHA-256
for each, and `expected_profile: "sdr"`. The receipt must be exact schema 1
`vmaf-private-retained-grain-replay-receipt-v1` in state `prepared`. It binds
identical source-before/source-after stat and sampled-fingerprint evidence,
independent current SDR classification, all eight pinned r2 runtime identities,
the table and manifest hashes and sizes, a clean exit-0 process-group absence
proof, and generation-scoped release of the non-stealable production GPU lock.
The legacy top-level absence/release booleans must agree with the exact
`process_group` and `production_lock` envelopes. A no-grain or failure receipt,
missing receipt, advisory-only hash, retained lock, live process group, runtime
drift, or changed artifact/source cannot authorize import or dispatch.

The request, receipt, and private JSON evidence must be owner-only and
single-link files on Linux. The work directory must not exist. The importer and
private dispatcher reauthenticate the receipt and all bound files; the receipt
must remain available and unchanged through the one-worker aperture.

Run the importer only inside the Tdarr container after reviewing the final
utility hash:

```bash
export VMAF_POSTENCODE_CHECKPOINT_ROOT=/temp/.vmaf-postencode-checkpoints-v1
export VMAF_POSTENCODE_REUSE_REQUIRED_ROOT=/app/configs/vmaf-postencode-reuse-required-v1
export ALLOW_LEGACY_PRODUCER_LOG_CHECKPOINT_RECOVERY=1
node /absolute/owner-only/recover-legacy-job-scoped-checkpoint.js \
  --request /absolute/private/recovery-request.json
```

Success means only that the checkpoint was imported with
`ffprobe-demux-plus-full-decode-v1` and exact reuse was armed. It is not
dispatch or terminal-job success.

### Recovery-blocking alias incident

The first controlled attempt in the audited deployment failed before retained
checkpoint reuse, a full-title transcode, or replacement. The native-Linux FIFO
scorer emitted the model-qualified VMAF alias, while the helper incorrectly
required bare `vmaf`. Global admission and worker controls stayed closed; the
source, retained candidate, source-scoped latch, normalized checkpoint,
independent source rollback copy, and legacy evidence remained unchanged.

The scoped helper repair binds `vmafAlias` to the exact pinned model version,
passes `name=<model version>` on the direct path, and requires that exact sole
alias in pooled and every frame metric. Bare, wrong-qualified, duplicate, and
suffixed aliases fail closed. A retry is permitted only after reauthenticating
all protected evidence, transactionally reconciling the source/server/node
execution copies, invalidating the old private dispatch spec, and regenerating
the complete execution-path attestation. This narrow pre-reuse repair does not
permit r3 installation before terminal recovery proof and fresh
post-recovery backups.

The final two sentences above record the original recovery-first gate. The
2026-07-28 operator waiver chose not to execute that recovery path. The helper
correction and complete 359-file server/internal-node catalog reconciliation
were nevertheless included and parity-qualified in r3. The catalog correction
also restored the FlowHelper file required by Tdarr_Node's
enabled-FFmpeg-encoder probe. Neither correction is evidence that checkpoint
reuse or terminal recovery occurred.

## Dispatch-bound schema 2

The private one-shot dispatcher rejects its former schema 1. Its outer
contract is `vmaf-private-controlled-retained-dispatch-v2` and includes a
required `pre_dispatch` object with:

- schema 2 and contract `vmaf-r2-controlled-reuse-pre-dispatch-v2`;
- the exact Flow ID `YR5PZ1QaD` and stable full-object SHA-256;
- stable full-object global-settings SHA-256 and the ID-sorted full library
  collection SHA-256;
- boolean `false` for `autoUpdateNodes`, `autoUpdateServer`,
  `pluginAutoUpdate`, and `killAllProcessesDuringUpdate`;
- descriptor-bound S6 container-environment values
  `enableDockerAutoUpdater=false`, a zero-byte `cronPluginUpdate`, and
  `TDARR_FLOW_PARITY_BOOTSTRAP` either explicitly `0` or absent and normalized
  to effective zero;
- independently authenticated `Tdarr_Node_Config.json` and
  `Tdarr_Server_Config.json` files, each canonical, regular, single-link,
  correctly owned, safely permissioned, size-bounded, strict UTF-8 without a
  BOM, and containing exactly one own `cronPluginUpdate` key whose value is
  empty;
- schema-2 execution-path contract
  `vmaf-r2-execution-path-attestation-v2`; and
- schema-1 source-copy contract
  `vmaf-independent-source-media-backup-v1`.

Stable JSON hashing recursively sorts object keys and preserves array order.
It also preserves own keys named `__proto__`; those keys cannot disappear
through JavaScript prototype assignment and cannot create full-object hash
collisions.

The dispatcher reads the Flow/global/library documents through exact loopback
CRUD calls immediately before queue mutation. It does not trust a reviewed
offline database as proof of current live state. S6 PID 1 does not retain the
service environment as an authoritative `/proc/1/environ` snapshot. The
recovery tools instead use no-follow, descriptor-bound reads of
`/run/s6/container_environment` and separately validate both runtime
configuration JSON files. They do not trust the environment of a later
`docker exec`. Tdarr exposes no compare-and-swap transaction spanning those
documents and a FileJSONDB queue update, so all other
Flow/settings/queue/config writers must remain stopped. The immediate reread
minimizes that residual race but cannot turn separate API calls into an atomic
database transaction.

### Exact r2 role set

Every Flow node must match one of these exact plugin roles, with the reviewed
multiplicity and exact node IDs:

- `input_file`, `file_age_gate`, `gpu_capability_gate`, `hdr_classifier`,
  `grain_analysis`, `metadata_fetch`, `sample_extraction`,
  `gpu_lock_acquire`, `parameter_test`, `vmaf_measurement`, `cq_bracket`,
  `parameter_selection`, `retry_controller`, `cq_learning`,
  `result_export`, and `projected_size_gate`;
- `transcode`, `gpu_lock_release`, `terminal_monitor`, `grain_synthesis`,
  `remux_start`, `stream_reorder`, `remux_execute`, `replace_original`,
  `notification`, `unmonitor`, and `cleanup`; and
- `flow_error_handler` and `technical_failure`.

The complete Local helper closure is:

- `helper_canonical_denoise`,
  `helper_current_contract_measurement_history`, `helper_empty_band_shadow`,
  `helper_feasibility`, `helper_gpu_pipeline_lock`,
  `helper_grain_analysis_artifact`, `helper_grain_vmaf_contract`,
  `helper_nvencc_knn`, `helper_nvenc_temporal_filter`,
  `helper_paired_cq_shadow`, `helper_post_encode_checkpoint`,
  `helper_pre_fgs_cambi`, `helper_reference_contract_bridge`,
  `helper_rejection_reasons`, `helper_size_failure_shadow`,
  `helper_vmaf_metric_contract`, `helper_vmaf_v1_cpu`, `helper_vmafdb`, and
  `helper_vmafpredict`.

The Community helper closure is `vendor_cli_utils`, `vendor_cli_parsers`,
`vendor_file_utils`, `vendor_file_move_or_copy`, and `vendor_flow_utils`.
This follows the pinned upstream dependencies in
[`ffmpegCommandExecute`](https://github.com/HaveAGitGat/Tdarr_Plugins/blob/2f8f50eb959208adf73967d23b3fafdd586f93b9/FlowPlugins/CommunityFlowPlugins/ffmpegCommand/ffmpegCommandExecute/1.0.0/index.js),
[`cliUtils`](https://github.com/HaveAGitGat/Tdarr_Plugins/blob/2f8f50eb959208adf73967d23b3fafdd586f93b9/FlowPlugins/FlowHelpers/1.0.0/cliUtils.js),
and
[`replaceOriginalFile`](https://github.com/HaveAGitGat/Tdarr_Plugins/blob/2f8f50eb959208adf73967d23b3fafdd586f93b9/FlowPlugins/CommunityFlowPlugins/file/replaceOriginalFile/1.0.0/index.js).
The private spec must hash the exact preserved/deployed bytes; upstream is not
substituted for live evidence.

For every role, `source`, `server`, and `node` must be distinct canonical,
non-symlink, single-link files with one reviewed full SHA-256. Paths must equal
their exact namespace-relative locations. Local source roots are pinned to the
mounted VMAF/filter/tools payloads. Community and FlowHelpers source files are
pinned beneath an owner-only independent source-catalog root. Server and node
files are pinned beneath their exact Community, Local, or FlowHelpers catalog
namespaces. Suffix-only and cross-repository matches fail.

The authenticated Flow must contain globally unique node and edge IDs, valid
edge endpoints/handles, exactly the required role multiplicities, only the
admission and error-handler roots, no disconnected roles, and the required
admission-through-terminal reachability.

### Source-copy boundary

The private dispatch spec declares every live media root, one protected backup
root outside all of them, exact source/copy size and full SHA-256,
`verified: true`, and `require_distinct_device: true`. The dispatcher hashes
both files immediately before queueing and repeats the proof before opening a
worker.

This proves a distinct-file, distinct-filesystem-device copy. It does not
claim that Docker/virtual device numbers guarantee a separate physical
failure domain; disaster-recovery independence must be established
operationally.

## Terminal verification

Assignment is not completion. Keep admission and unrelated concurrency paused
until all of these are independently proved:

- the authoritative Tdarr state records terminal success;
- exact checkpoint reuse occurred and no NVEncC/FFmpeg encoder launched;
- the installed library file has the expected full SHA-256;
- the full primary video decodes and stream set, colour signalling, duration,
  and size pass;
- the independent source copy remains readable with its recorded hash;
- the normalized checkpoint and source-scoped latch are retired while legacy
  evidence remains unchanged; and
- final API, process, GPU-lock, and external-node quiescence passes.

Both public importer and private dispatcher use non-identifying success output
and fixed CLI failure text. They do not print request paths, Flow/node/job
identities, hashes, API material, raw child output, or stacks.
