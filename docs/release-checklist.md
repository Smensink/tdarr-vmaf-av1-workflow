# Release checklist

This remains the reusable release procedure. The 2026-07-28 initial 34-node
phase, final immutable 36-node/58-edge deployment, explicit recovery waiver,
and still-withheld live canary are recorded separately in
[r3 rollout evidence](r3-rollout-evidence-2026-07-28.md). An unchecked item
below is not retroactive evidence that the dated rollout failed; use the dated
record for that rollout's exact disposition.

## Scope and safety

- [ ] Confirm Git top-level is the dedicated repository checkout, not the live
      deployment or a parent repository.
- [ ] Confirm active jobs are drained before any restart, recreate, live graph
      write, FFmpeg rebuild, or database maintenance.
- [ ] Manually pause all admission and nodes, reduce all four worker limits to
      zero only after workers are idle, then run
      `build-scripts/assert-tdarr-quiescence.js` inside the Linux Tdarr
      container. Retain the two-snapshot pass result.
- [ ] For external nodes, separately confirm each host-local exact lock and
      process tree is clear; the server container cannot inspect another
      host's `/proc`.
- [ ] Preserve unrelated user changes.
- [ ] Record the already-disabled update state:
      `autoUpdateNodes=false`, `autoUpdateServer=false`,
      `pluginAutoUpdate=false`, and `killAllProcessesDuringUpdate=false`.
      Through no-follow descriptor reads of `/run/s6/container_environment`,
      require explicit `enableDockerAutoUpdater=false`, zero-byte
      `cronPluginUpdate`, and `TDARR_FLOW_PARITY_BOOTSTRAP` either explicitly
      `0` or absent and normalized to effective zero. Do not use
      `/proc/1/environ` as the service-environment authority.
- [ ] Independently authenticate `Tdarr_Node_Config.json` and
      `Tdarr_Server_Config.json`: canonical regular single-link files,
      expected ownership, safe modes, bounded size, strict UTF-8 without BOM,
      and exactly one own `cronPluginUpdate` key whose value is empty. Re-prove
      all updater controls immediately before recovery dispatch; do not use
      recovery to mutate them.
- [ ] Preserve a complete private r2 rollback generation: image; exact
      coordinator/NVEncC/FFmpeg bytes and provenance; deployment
      source/server/internal-node and relevant Community catalogs; helpers;
      active Flow; init/build/artifact mounts; online DB/config/report
      evidence; and effective Compose/environment/authentication/API-key
      material. Do not publish secrets or source paths.
- [ ] Create a separately stored original-media backup or filesystem snapshot,
      record matching full hashes, and test its independent restore/read path
      before permitting source replacement.

## Source and graph

- [ ] Export the active flow through `tools/export-live-state.py`.
- [ ] Confirm the two tracked flow snapshots are intentionally identical.
- [ ] Confirm each snapshot has exactly 36 nodes and 58 edges, including
      validator, attested replacer, and delivered-outcome finalizer.
- [ ] Reconcile any desired migration separately; do not silently call it live.
- [ ] Run checkout plugin/deployment-mirror parity.
- [ ] Confirm all active Local identities are pinned by init.
- [ ] Confirm all 23 runtime helpers are verified.
- [ ] Confirm learning DB schema v17 and its guarded
      `candidate_ready -> replacement_committing -> delivery_committing ->
      delivered` state machine.
- [ ] Confirm the delivery-policy helper requires the exact current 30% target,
      20% minimum reduction, and 80% final-ratio cap. Treat the 90% projection
      boundary as separate research evidence.
- [ ] Confirm init seeded the complete persistent server catalog before
      creating `/app/Tdarr_Node/assets/app/plugins/.git`; require that exact
      path to be a canonical, non-symlink, safely owned directory.
- [ ] After the internal node reconnects, keep admission, node pause, and all
      worker limits closed; run full source/server/node deployment parity
      twice at least 15 seconds apart so a late cached plugin download cannot
      escape startup qualification.
- [ ] If the optional private size-shadow model is deployed, verify it outside
      Git and confirm no copy is staged or included in `manifest.json`.
- [ ] Regenerate `manifest.json`.

## Privacy

- [ ] No raw Tdarr DB/WAL/SHM, learning DB, backups, logs, reports, media, or
      generated binaries are staged.
- [ ] Public SQLite is a fresh aggregate schema with minimum cohort 25.
- [ ] Public SQLite `PRAGMA integrity_check` is `ok`.
- [ ] Flow credentials are placeholders/redacted.
- [ ] Run `tools/audit-for-secrets.py` and manually review its findings.
- [ ] Search for personal absolute paths and local hostnames.

## Static verification

```bash
git diff --check
node tools/generate-manifest.js
node tools/verify-source-parity.js
node --check tools/generate-manifest.js
node --check build-scripts/assert-tdarr-quiescence.js
node --test test-tdarr-quiescence.js
node --check build-scripts/apply-tdarr-runtime-settings.js
node test-tdarr-runtime-settings.js
node --check build-scripts/create-post-recovery-evidence.js
node test-post-recovery-evidence.js
node --check build-scripts/verify-compose-security-model.js
node test-compose-security-model.js
node --check build-scripts/verify-tdarr-auth-boundary.js
node test-tdarr-auth-boundary.js
node test-delivery-size-policy.js
node test-delivery-transaction.js
node test-validate-delivery-candidate.js
node test-post-replacement-attestation.js
node test-finalize-delivered-outcome.js
node test-flow-routing-contract.js
node test-vmafdb-schema.js
python -m py_compile tools/export-live-state.py

# Run node --check for every tracked plugin/helper JavaScript file.
# Run the screened non-mutating root test-*.js contracts with this explicit
# exclusion list; do not use an unreviewed wildcard:
# test-gpu-vmaf.js, test-grain-flow-e2e.js,
# test-grain-vmaf-contract-canary.js, and test-hdr-metadata-live.js.
```

- [ ] JSON documents parse.
- [ ] Shell scripts pass `bash -n` or `sh -n` according to shebang.
- [ ] Python files compile.
- [ ] JavaScript files pass `node --check`.
- [ ] Contract tests pass without Docker restart or live mutation.
- [ ] After populating a valid private `TDARR_API_KEY`, the Compose example
      renders with the intended deployment `.env` values. The deliberately
      blank `.env.example` is not itself a runnable credential fixture.

## Legacy retained-candidate gate

Complete this gate before changing authenticated r2 bytes. Mark it not
applicable only when no retained candidate will be recovered. A
recovery-blocking defect discovered before checkpoint reuse may receive one
strictly scoped helper/catalog repair only when no full-title transcode or
replacement occurred, the source/candidate/checkpoint/latch/evidence are
reauthenticated, source/server/node copies are redeployed transactionally, the
old private dispatch spec is invalidated, and the complete execution-path
attestation is regenerated before retry. While recovery remains in scope, this
exception does not permit r3: r3 remains blocked until terminal recovery proof
and fresh post-recovery backups pass.

For the 2026-07-28 rollout, the owner explicitly waived the failed-job
retained-candidate recovery and directed r3 to proceed. The gate below was
therefore **not applicable by operator decision**, not completed. No retry was
dispatched, protected recovery artifacts were preserved, and the verified
pre-r3 evidence generation was not relabelled as post-recovery evidence. See
the [dated rollout record](r3-rollout-evidence-2026-07-28.md#operator-decision-and-evidence-boundary).

- [ ] Authenticate the narrow recovery request and separately attest the actual
      r2 controlled-retry path end to end. Include every gate, lock/retry
      plugin and helper, `synthesizeFilmGrain`, Community
      `replaceOriginalFile`, notification/unmonitor branches, and cleanup.
- [ ] Confirm source, persistent server, and internal-node copies agree for
      every pinned Local identity on that path; preserve exact relevant
      Community catalog bytes.
- [ ] Re-run quiescence and re-prove all six disabled update controls
      immediately before importer execution and again before controlled
      dispatch.
- [ ] Complete exactly one retained-checkpoint reuse and prove from process
      evidence that no encoder or hidden producer launched.
- [ ] Require an authoritative terminal database success, full final-file hash,
      complete decode plus stream/colour/duration/size checks, and independent
      confirmation of source replacement.
- [ ] Prove the normalized checkpoint and source-scoped reuse-required latch
      are retired, preserve the legacy quarantine evidence, and pass final
      process/lock quiescence.
- [ ] While still paused, create and verify a fresh post-recovery DB backup,
      configuration/active-Flow snapshot, and report archive. Create the
      version-2 runtime-settings receipt from that new DB backup and archive
      using the independently reviewed terminal receipt and
      [one-shot private evidence runbook](post-recovery-private-evidence.md).
- [ ] Keep r2 installed and the original-media backup available until every
      item above passes. Any failed proof blocks r3 installation.

## Runtime qualification

Only during a drained maintenance window and, when applicable, after the
legacy recovery gate has completed:

- [ ] Re-run the read-only quiescence assertion immediately before the first
      disruptive operation; do not rely on an earlier pass.
- [ ] Build the pinned image.
- [ ] Verify FFmpeg hash and `libvmaf_cuda`.
- [ ] Run PTX, 10-bit, CPU-v1, grav1synth, and NVEncC checks.
- [ ] Verify coordinator release `9.25-r3` and prove that an early FFmpeg
      consumer exit terminates its still-running producer.
- [ ] Review the complete resolved Compose model without publishing it. Record
      the output of `verify-compose-security-model.js
      --print-sanitized-sha256` separately, then pipe a fresh resolved model
      directly into normal verification with that reviewed digest supplied as
      `TDARR_EXPECTED_SANITIZED_MODEL_SHA256`.
- [ ] Before recreate, pipe the resolved Compose JSON directly into
      `verify-compose-security-model.js`, supplying the exact reviewed image,
      evidence-volume name, and staged init/build/NVEncC sources through its
      `TDARR_EXPECTED_*` environment variables. Supply
      `TDARR_EXPECTED_WEB_PORT` and `TDARR_EXPECTED_SERVER_PORT` when the
      reviewed host ports are not the 8265/8266 defaults. Do not print the
      resolved JSON because it contains the API key.
- [ ] Recreate/restart once, establish the authenticated loopback API with the
      new key, and prove the internal node reconnects through that endpoint.
- [ ] Compare `docker inspect tdarr --format '{{.Image}}'` with the independently
      reviewed staged image ID; the Compose verifier authenticates the image
      reference string, not the running image bytes.
- [ ] Run `verify-tdarr-auth-boundary.js` inside the recreated container and
      require HTTP 401 or 403 from the valid unauthenticated `get-nodes`
      endpoint. A 2xx response or 404 does not qualify authentication.
- [ ] Run in-container source/server/internal-node plugin, helper, and active
      Flow parity before changing runtime settings.
- [ ] Confirm the reviewed private evidence is exposed to the recreated
      container through the exact external named volume, mounted read-only at
      `/private/tdarr-runtime`; an environment path alone is not a mount and a
      host bind does not satisfy this contract. If recovery occurred, this
      must be fresh post-recovery evidence. If recovery was explicitly waived,
      retain the written waiver and label the generation pre-recovery/pre-r3.
- [ ] Run reviewed runtime-settings convergence first as a dry plan and then
      apply it from the applicable reviewed version-2 receipt. Retain exact
      apply/readback evidence and finish with a second dry plan showing no
      pending change. A waiver does not turn a pre-r3 receipt into
      post-recovery evidence.
- [ ] If any runtime-settings mutation or readback partially fails, keep
      admission and nodes paused. Investigate, rerun the idempotent apply, and
      require the zero-change dry plan before restart or unpause.
- [ ] Process one controlled canary.
- [ ] Verify output decode, streams, colour signalling, duration, size,
      candidate validation, attested replacement, authenticated backup
      disposition, immutable schema-v17 `delivered` outcome, permanent
      delivery-retirement tombstone, and exact journal/checkpoint retirement.

The dated 2026-07-28 live canary remains outstanding because the paused queue
could not be isolated to a provable one-file admission aperture. The
deployment stayed paused rather than admitting unrelated queued work; runtime
qualification is not substituted for terminal live-flow evidence. This also
means the deployed 36/58 delivery path has no live terminal-canary evidence.

Do not treat entry into a flow stage or a passing static test as proof that the
final encode completed correctly.

## Publication

- [ ] Review the complete staged diff and file-size list.
- [ ] Commit with an imperative scoped message.
- [ ] Push a topic branch.
- [ ] Open a draft pull request with impact, known risks, checks, and the
      explicit statement that runtime jobs were not interrupted.
