# Release checklist

## Scope and safety

- [ ] Confirm Git top-level is the dedicated repository checkout, not the live
      deployment or a parent repository.
- [ ] Confirm active jobs are drained before any restart, recreate, live graph
      write, FFmpeg rebuild, or database maintenance.
- [ ] Preserve unrelated user changes.
- [ ] Record rollback image, flow export, plugin hashes, and private online DB
      backups.

## Source and graph

- [ ] Export the active flow through `tools/export-live-state.py`.
- [ ] Confirm the two tracked active snapshots are intentionally identical.
- [ ] Reconcile any desired migration separately; do not silently call it live.
- [ ] Run checkout plugin/deployment-mirror parity.
- [ ] Confirm all active Local identities are pinned by init.
- [ ] Confirm all 19 runtime helpers are verified.
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
python -m py_compile tools/export-live-state.py

# Run node --check for every tracked plugin/helper JavaScript file.
# Run the screened non-mutating root test-*.js contracts.
```

- [ ] JSON documents parse.
- [ ] Shell scripts pass `bash -n` or `sh -n` according to shebang.
- [ ] Python files compile.
- [ ] JavaScript files pass `node --check`.
- [ ] Contract tests pass without Docker restart or live mutation.
- [ ] Compose example renders with placeholder `.env` values.

## Runtime qualification

Only during a drained maintenance window:

- [ ] Build the pinned image.
- [ ] Verify FFmpeg hash and `libvmaf_cuda`.
- [ ] Run PTX, 10-bit, CPU-v1, grav1synth, and NVEncC checks.
- [ ] Run in-container plugin/helper/flow parity.
- [ ] Process one controlled canary.
- [ ] Verify output decode, streams, colour signalling, duration, size,
      checkpoint retirement, and database terminal outcome.

Do not treat entry into a flow stage or a passing static test as proof that the
final encode completed correctly.

## Publication

- [ ] Review the complete staged diff and file-size list.
- [ ] Commit with an imperative scoped message.
- [ ] Push a topic branch.
- [ ] Open a draft pull request with impact, known risks, checks, and the
      explicit statement that runtime jobs were not interrupted.
