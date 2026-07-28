# Post-recovery private evidence

`build-scripts/create-post-recovery-evidence.js` creates one private,
apply-ready rollback generation after retained-candidate recovery. It is a
read-only observer of the live Tdarr volumes and API. It does not pause nodes,
change worker limits, cancel work, remove locks, restart Tdarr, or write live
state.

Run it only after active jobs have finished naturally, admission and every
node are paused, all worker limits are zero, and the independent terminal
recovery review is complete. The helper performs its own quiescence and
exact-four-library checks both before and after capture. A failed check
publishes no completed destination.

Its `/proc` proof covers the shared Tdarr/internal-node PID namespace only.
Prove every external node's process and lock state on that host separately and
keep those nodes paused throughout the capture.

## Required reviewed inputs

The helper never derives an approval list from the live API. Supply the
separately reviewed `tdarr-reviewed-library-identities` manifest described in
[installation.md](installation.md). Its four IDs must exactly equal both live
library samples.

The terminal proof must be the actual output of the frozen private watcher
`watch-controlled-retained-recovery.js`, not a new operator-authored
attestation. Supply all three frozen files:

- its schema-1 receipt with contract
  `vmaf-private-controlled-retained-terminal-receipt-v1`;
- its schema-1 JSONL journal with contract
  `vmaf-private-controlled-retained-terminal-journal-v1`; and
- the watcher implementation itself, basename
  `watch-controlled-retained-recovery.js`, size `66898`, SHA-256
  `1bad22b5c92f087be3922ed67f95e57f8f2a95bd3897725bf1bf0a1d4177c53e`.

The receipt is an external prerequisite: this backup helper does not observe
enough state to recreate terminal recovery proof. It accepts only
`outcome: "success"` with `ok: true`, no violations, all twelve watcher
milestones true, matching API and report decisions of `Transcode success`,
non-empty staging/retirement/terminal evidence, and two successful terminal
quiescence samples. Its `journal.path`, `sha256_full`, `size_bytes`, and
`event_count` must bind the supplied journal exactly.

The journal must contain the declared number of sequential schema-1 events,
start with `journal_opened`, and end with the sole `watcher_terminal` event.
That final event must carry `outcome: "success"`, the same all-true milestones,
`quiescence_ok: true`, and `violation_count: 0`.

The receipt must be no more than seven days old. The generator separately
requires its bytes to match
`TDARR_TERMINAL_RECOVERY_RECEIPT_SHA256`, rehashes the journal and the frozen
watcher, copies all three unchanged, and binds their digests into the evidence
manifest. Retain the expected receipt digest outside the destination volume;
computing a new digest from an unreviewed receipt at run time is not an
independent review.

## One-shot helper container

Use a unique Docker volume and a unique child name for every attempt. The
helper must share Tdarr's network namespace for the loopback API, its PID
namespace for `/proc`, and all of its live mounts read-only at the same paths.
The inherited mounts must include `/temp`, otherwise the production GPU-lock
check is not observing the real lock. `--volumes-from` does not copy
environment variables, so pass the API key separately without putting its
value in the command.

The following PowerShell example uses the currently deployed image only as the
Node/Python runtime and mounts the reviewed script from this checkout:

```powershell
$Repo = (Resolve-Path 'C:\path\to\tdarr-vmaf-av1-workflow').Path
$ReviewedLibraries = (Resolve-Path 'C:\private\reviewed-libraries.json').Path
$TerminalReceipt = (Resolve-Path 'C:\private\terminal-recovery-receipt.json').Path
$TerminalJournal = (Resolve-Path 'C:\private\terminal-recovery-journal.jsonl').Path
$TerminalJournalName = [IO.Path]::GetFileName($TerminalJournal)
$FrozenWatcher = (Resolve-Path 'C:\private\watch-controlled-retained-recovery.js').Path
$ExpectedTerminalSha256 = '<digest recorded by the independent review>'

$ActualTerminalSha256 = (Get-FileHash -LiteralPath $TerminalReceipt -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualTerminalSha256 -cne $ExpectedTerminalSha256) {
  throw 'Terminal-recovery receipt differs from the reviewed digest'
}

$env:TDARR_TERMINAL_RECOVERY_RECEIPT_SHA256 = $ExpectedTerminalSha256
$EvidenceVolume = 'tdarr-private-evidence-' + [guid]::NewGuid().ToString('N')
$Generation = 'post-recovery-' + [guid]::NewGuid().ToString('N')
$HelperImage = (docker inspect tdarr --format '{{.Config.Image}}').Trim()
docker volume create $EvidenceVolume | Out-Null

docker run --rm `
  --name "tdarr-evidence-$Generation" `
  --read-only `
  --cap-drop ALL `
  --security-opt no-new-privileges:true `
  --network container:tdarr `
  --pid container:tdarr `
  --volumes-from tdarr:ro `
  --mount "type=volume,source=$EvidenceVolume,target=/private-output" `
  --mount "type=bind,source=$Repo\build-scripts,target=/tool,readonly" `
  --mount "type=bind,source=$ReviewedLibraries,target=/review/reviewed-libraries.json,readonly" `
  --mount "type=bind,source=$TerminalReceipt,target=/review/terminal-recovery-receipt.json,readonly" `
  --mount "type=bind,source=$TerminalJournal,target=/review/$TerminalJournalName,readonly" `
  --mount "type=bind,source=$FrozenWatcher,target=/review/watch-controlled-retained-recovery.js,readonly" `
  --env TDARR_API_KEY `
  --env ALLOW_TDARR_POST_RECOVERY_EVIDENCE=1 `
  --env "TDARR_PRIVATE_EVIDENCE_DESTINATION=/private-output/$Generation" `
  --env TDARR_REVIEWED_LIBRARY_IDENTITY_MANIFEST=/review/reviewed-libraries.json `
  --env TDARR_TERMINAL_RECOVERY_RECEIPT=/review/terminal-recovery-receipt.json `
  --env TDARR_TERMINAL_RECOVERY_RECEIPT_SHA256 `
  --env "TDARR_TERMINAL_RECOVERY_JOURNAL=/review/$TerminalJournalName" `
  --env TDARR_TERMINAL_RECOVERY_WATCHER=/review/watch-controlled-retained-recovery.js `
  --entrypoint node `
  $HelperImage /tool/create-post-recovery-evidence.js
```

The success line is deliberately generic. A failure prints only a fixed error
code; it does not print API material, paths, Flow data, library IDs, job-report
names, child-process output, or stacks. Keep the Docker volume private and do
not add any generated file to Git.

The production source layout is pinned to:

- `/app/server/Tdarr/DB2/SQL/database.db`;
- `/app/configs/vmaf_training.db`;
- `/app/server/Tdarr/DB2/JobReports`;
- `/app/configs`; and
- Flow `YR5PZ1QaD`.

Changing any of those values requires
`ALLOW_TDARR_EVIDENCE_SOURCE_OVERRIDE=1`. That latch is intended for offline
contract tests or a separately reviewed migration, not this production
runbook. An override generation records
`tdarr-explicit-source-override-v1`; the normal generation records
`tdarr-r3-live-source-layout-v1`.

## Generated contract

The unique destination is assembled under an owner-only staging name,
validated, synced, and atomically renamed without replacement. On Linux every
directory must be `0700` and every file `0600`. All source and output objects
must be non-symlink, regular where applicable, single-link, and confined to
their reviewed roots.

The destination contains:

- online SQLite backups of `database.db` and `vmaf_training.db`, each followed
  by immutable `PRAGMA integrity_check`;
- the active Flow read from the consistent database backup;
- `archives/job-reports.tar.gz`, containing every regular file beneath
  `JobReports`;
- `archives/configs.tar.gz`, excluding the learning database and its
  `-wal`, `-shm`, and `-journal` sidecars;
- the reviewed library manifest and the controlled-recovery receipt, journal,
  and frozen watcher copied byte-for-byte;
- the schema-2 `archive-receipt.json` accepted by
  `apply-tdarr-runtime-settings.js`;
- `SHA256SUMS.txt` for those ten primary artifacts; and
- `evidence-manifest.json`, which records the checksum-manifest hash,
  source/count contracts, integrity results, and pre/post quiescence counts.

Any additional file or directory, including a SQLite sidecar, makes the
generation fail before publication.

In the schema-2 receipt, `reportCount` means descendant regular files whose
name ends exactly in `.txt`; a root-level `.txt` or any non-`.txt` member is
not a report. The archive still contains every regular file. The evidence
manifest records both `reportCount` and the archive's total
`regularFileCount`, without recording member names. This meaning is fixed by
`tdarr-job-report-descendant-txt-v1`.

The producer reopens and fully streams every gzip member before setting
`verified: true`, requires an exact regular-member set and count, then rescans
the source tree. SQLite capture uses the online backup API, not a raw copy of
live WAL files. Completed backups are subsequently opened with
`mode=ro&immutable=1`, so inspection cannot create WAL/SHM sidecars.

## Later apply and trust boundary

Mount the evidence volume read-only into the recreated Tdarr container. If it
is mounted at `/private/tdarr-evidence`, use:

```text
TDARR_PRIVATE_RUNTIME_ROOT=/private/tdarr-evidence/<generation>
TDARR_PRIVATE_LIBRARY_IDENTITY_MANIFEST=/private/tdarr-evidence/<generation>/reviewed-libraries.json
TDARR_PRIVATE_ARCHIVE_RECEIPT=/private/tdarr-evidence/<generation>/archive-receipt.json
```

Run the default runtime-settings dry plan first, then the latched apply, then
a second dry plan as described in [installation.md](installation.md). Do not
mount a mode-losing Windows copy as the runtime root; retain the dedicated
volume or use another copy method that preserves Linux modes and link
semantics.

SHA-256 binds the recorded artifacts against accidental corruption and
post-review byte changes. It is not issuer authentication: anyone who can
rewrite the complete private generation can also rewrite its hashes and
receipts. Provenance therefore depends on owner-only storage, the independently
retained terminal-receipt digest, and the later read-only mount. A future
cross-trust-boundary workflow should add an HMAC or digital signature whose key
is not stored in the evidence volume.
