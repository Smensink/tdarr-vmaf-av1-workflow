# Installation and upgrades

The project is a deployment source tree, not a prebuilt appliance. It expects
an NVIDIA-capable host, Docker Compose, local artifact directories, and a
maintenance process that drains Tdarr before disruptive changes.

## Before installation

- Read the [audit](audit-2026-07-27.md), deploy the checked-in repairs, and
  verify that the live catalogs match before using untrusted media names.
- Confirm NVIDIA container GPU access.
- Keep media mounts read-only during evaluation.
- Plan private backup storage outside the Git checkout.
- Do not expose an unauthenticated Tdarr UI/API to a network.

## Configure

```bash
git clone https://github.com/Smensink/tdarr-vmaf-av1-workflow.git
cd tdarr-vmaf-av1-workflow
cp .env.example .env
cp docker-compose.example.yml docker-compose.yml
```

The copy step is the manual Unix-style path. On Windows, use the generator as
an alternative—do not copy `.env.example` to `.env` first:

```powershell
Copy-Item docker-compose.example.yml docker-compose.yml
& .\build-scripts\new-private-tdarr-env.ps1 -Target .env
$PrivateVolume = (
  Get-Content .env |
    Where-Object { $_ -clike 'TDARR_PRIVATE_RUNTIME_VOLUME=*' }
).Split('=', 2)[1]
docker volume create $PrivateVolume | Out-Null
```

The helper is compatible with Windows PowerShell 5.1 and PowerShell 7. It
creates a new `.env` with a cryptographically random API key and independent
unique private-volume name, and refuses to overwrite an existing file. Add
the remaining local values from `.env.example` afterward without replacing
those generated entries.

Populate `.env` locally, including a private `TDARR_API_KEY` beginning with
`tapi_`, at least 16 characters long, and containing only letters, numbers,
and underscores. It is supplied to both the server's `seededApiKey` and the
internal node's `apiKey`; it is not the web UI password. On the first
authentication-enabled start, Tdarr prompts for a UI username and password.
See Tdarr's [authentication guide](https://docs.tdarr.io/docs/other/authentication/).
The example also sets
`serverURL=http://127.0.0.1:8266`; environment variables take precedence over
a stale saved node URL. See Tdarr's
[configuration-variable reference](https://docs.tdarr.io/docs/installation/variables/).

For a manual new-instance setup, choose a unique
`TDARR_PRIVATE_RUNTIME_VOLUME`, create it with `docker volume create`, and put
  the exact name in `.env` before `docker compose up`. Existing deployments
  must instead use the reviewed private evidence volume described below. When
  retained-candidate recovery is performed that volume must contain fresh
  post-recovery evidence; an explicit operator waiver must retain and label a
  pre-r3 generation as such rather than calling it post-recovery evidence.

The flow-aware Local unmonitor plugin reads separate
`TDARR_RADARR_API_KEY` and `TDARR_SONARR_API_KEY` values. The redacted Flow
also preserves those service-specific placeholders on both Community
notification nodes; it never substitutes one shared Arr key. Community
`notifyRadarrOrSonarr` reads its `arr_api_key` input rather than those
environment variables directly, so verify Tdarr's private input substitution
or configure each notification node privately before enabling it. Metadata
enrichment reads `TDARR_PLEX_URL`, `TDARR_PLEX_TOKEN`,
`TDARR_TMDB_API_KEY`, and `TDARR_TVDB_API_KEY`. The exported flow contains
placeholders, not working credentials.

Add media bind mounts to the copied compose file. Final replacement requires a
writable source mount; evaluation does not. Never commit local drive letters,
NAS names, mount paths, or `.env`.

## Provide runtime artifacts

The compose example mounts these directories:

| Host directory | Container purpose |
|---|---|
| `custom-ffmpeg/` | Pinned FFmpeg/ffprobe and libraries |
| `custom-libvmaf-lib/` | libvmaf shared libraries |
| `custom-libvmaf-include/` | libvmaf headers |
| `custom-libvmaf-pkgconfig/` | pkg-config metadata |
| `custom-cuda/` | CUDA toolkit used by the custom build |
| `custom-vmaf-models/` | VMAF models |
| `custom-grav1synth/` | Verified grav1synth release artifact |
| `custom-grain-pipeline/` | Direct grain-pipeline artifact |
| `custom-nvencc/` | NVEncC artifact and provenance |

Generated binaries are ignored by Git. Tracked checksum/provenance files
describe the expected artifacts. Build scripts live in `build-scripts/`.

The CPU VMAF-v1 layer is reproducible from
`runtime/vmaf-v1/Dockerfile.vmaf-v1-cpu`:

```bash
docker compose build
```

The base Tdarr image and VMAF revision are pinned. Review and update them
deliberately; do not enable automatic image or plugin updates for this custom
runtime.

## Start a new instance

The startup verifier is fail-closed and normally requires the canonical flow
to exist in the live Tdarr database. For the first start of a genuinely new,
empty named volume only, set this in `.env`:

```text
TDARR_FLOW_PARITY_BOOTSTRAP=1
```

Bootstrap mode skips only live-DB flow equality. Plugin, helper, catalog, and
canonical Local-plugin checks still run.

```bash
docker compose up -d
docker compose ps
```

The example health check is a cheap TCP liveness probe. Run the deep grain/GPU
qualification once after build or while the queue is idle:

```bash
docker exec tdarr bash /usr/local/build-scripts/verify-grain-toolchain.sh
docker exec tdarr node /usr/local/build-scripts/verify-vmaf-deployment-parity.js
```

Do not make the deep toolchain test a frequent Docker health check; it launches
real GPU contexts.

## Install Local plugins

```bash
bash tools/install-local-plugins.sh tdarr
```

The installer copies all tracked plugin identities and the 23 runtime helpers
to server and internal-node catalogs. It does not restart the container by
default. `--restart` is intentionally opt-in:

```bash
# Only after the queue is drained and a rollback is ready:
bash tools/install-local-plugins.sh tdarr /path/to/repo/plugins --restart
```

The advisory size-failure model is deliberately private because its exported
category vocabulary contains media titles and release groups. To install a
local copy without adding it to Git, set
`VMAF_SIZE_FAILURE_SHADOW_MODEL_SOURCE` to its host path. If it is omitted,
only that advisory shadow is disabled.

The compose mount of `custom-cont-init.d/` is still required: current plugins
use `/custom-cont-init.d/vmaf-plugin-patches/_lib` as a runtime fallback and
startup hooks pin the deployed catalogs.

Import `flow/tdarr-flow-vmaf-av1.json` through Tdarr, configure libraries, and
review every external integration input. Confirm that both Radarr nodes resolve
only `TDARR_RADARR_API_KEY` and both Sonarr nodes resolve only
`TDARR_SONARR_API_KEY`; never replace them with a shared Arr key. The snapshot
is not a credential bundle.

The tracked graph must import as exactly 36 nodes and 58 edges. Its final
delivery chain is `validateDeliveryCandidate ->
replaceOriginalFileAttested -> finalizeDeliveredOutcome`; do not substitute
the Community replacer or route notifications directly from replacement.
Opening the learning database with the tracked helper migrates it to schema
v17, whose guarded delivery path is
`candidate_ready -> replacement_committing -> delivery_committing ->
delivered`. Back up the database first and perform that migration only while
drained.

The current delivered-size policy is an exact 30% search target, 20% minimum
actual reduction, and 80% maximum final output/source ratio. The 90% projected
ratio is a separate research boundary and must not be configured or reported
as the delivered-success threshold.

The bundled internal node is intentionally pinned against its normal
post-init plugin download. After seeding the complete persistent server
catalog and applying all Local pins, init creates
`/app/Tdarr_Node/assets/app/plugins/.git`; Tdarr_Node treats that exact
development-preservation sentinel as an instruction not to overwrite the
catalog from cached `nodePlugins.Zip`. Do not create it before the full seed,
and do not remove it on a running deployment. Deliberate plugin changes require
a drained recreate plus source/server/node parity before workers reopen.

Before accepting any jobs, reset `TDARR_FLOW_PARITY_BOOTSTRAP=0` in `.env` and
recreate the new, idle container so strict parity is active:

```bash
docker compose up -d --force-recreate tdarr
docker exec tdarr node /usr/local/build-scripts/verify-vmaf-deployment-parity.js
```

Never enable bootstrap mode on an existing deployment to bypass a mismatch.
Reconcile the live graph during a drained maintenance window instead.

## Read-only quiescence assertion

`build-scripts/assert-tdarr-quiescence.js` is the fail-closed preflight for an
existing deployment. It is read-only: it does not pause a node, change worker
limits, remove or steal the production lock, kill a process, or write Tdarr
state.

Before running it, manually pause admission and every node without cancelling
work. Let existing jobs finish naturally. Once every worker is idle, set all
four worker limits on every node to zero. Then run the assertion inside the
Linux Tdarr container so its `/proc` view covers the internal node:

```bash
docker cp build-scripts/assert-tdarr-quiescence.js \
  tdarr:/tmp/assert-tdarr-quiescence.js
docker exec tdarr node /tmp/assert-tdarr-quiescence.js
```

The default API is the literal-loopback endpoint
`http://127.0.0.1:8266/api/v2`. The script optionally sends `x-api-key` from
the existing `TDARR_API_KEY` or `apiKey` environment variable. Override only
with another literal-loopback URL through `TDARR_API_BASE`; `localhost`,
wildcard, LAN, and credential-bearing URLs are rejected. If production uses a
different exact lock path, set `TDARR_GPU_PIPELINE_LOCK_DIR` to that absolute
path.

One invocation checks the global manual pause, per-node pause state, zero
worker limits, idle workers, the exact lock, and `/proc` twice with a bounded
two-second interval. Process failures report only PID and a fixed tool
identity, never command lines or media paths. A pass applies only to the PID
namespace in which the script ran. Deployments with external nodes still need
an equivalent host-local process/lock proof for every external node.

## Reviewed runtime settings convergence

`build-scripts/apply-tdarr-runtime-settings.js` converges the reviewed settings
without printing library identities. Its fixed target keeps filesystem events
enabled on exactly four libraries, changes the folder-watch interval from 30
to 300 seconds, keeps scheduled discovery enabled as the hourly fallback for
Windows bind-mounted/network media, and disables only startup discovery.
`holdFor` is deliberately not a target: its existing value is preserved and
the exact readback rejects any change to it. The script also reduces
`backupLimit` from 30 to 10; the reviewed 10 GiB job-history limit is left
unchanged.

The default is a read-only plan and still requires the quiescence assertion to
pass. Copy both scripts together and run the dry plan first:

```bash
docker cp build-scripts/assert-tdarr-quiescence.js \
  tdarr:/tmp/assert-tdarr-quiescence.js
docker cp build-scripts/apply-tdarr-runtime-settings.js \
  tdarr:/tmp/apply-tdarr-runtime-settings.js
docker exec tdarr node /tmp/apply-tdarr-runtime-settings.js
```

Applying requires `--apply`, `ALLOW_TDARR_RUNTIME_SETTINGS_APPLY=1`, and these
three absolute paths:

- `TDARR_PRIVATE_RUNTIME_ROOT`: an explicit non-symlink private directory;
- `TDARR_PRIVATE_LIBRARY_IDENTITY_MANIFEST`: the reviewed identity manifest
  beneath that root; and
- `TDARR_PRIVATE_ARCHIVE_RECEIPT`: the fresh archive receipt beneath that root.

On Linux the private root must be owner-only (`0700`) and the manifest,
receipt, archive, and database backup must be owner-only regular non-symlink
files (`0600`) with exactly one hard link. Artifact paths in the receipt are
relative to the private root; canonical-path checks reject escapes through
`..` or symlinks. Reads are bound to no-follow file descriptors and reject an
inode, metadata, pathname, or private-root identity change while an artifact
is being consumed. The identity manifest schema is:

```json
{
  "schemaVersion": 1,
  "kind": "tdarr-reviewed-library-identities",
  "reviewedAt": "2026-07-27T09:00:00.000Z",
  "libraryIds": [
    "<exact-reviewed-id-1>",
    "<exact-reviewed-id-2>",
    "<exact-reviewed-id-3>",
    "<exact-reviewed-id-4>"
  ]
}
```

The IDs must be distinct and must exactly equal the four libraries discovered
immediately before apply. They remain in private storage and are never printed.
The archive receipt schema is version 2:

```json
{
  "schemaVersion": 2,
  "kind": "tdarr-private-job-report-archive",
  "verified": true,
  "reportCount": 42,
  "createdAt": "2026-07-27T09:30:00.000Z",
  "archive": {
    "path": "archives/job-reports.tar.gz",
    "sha256": "<64-lowercase-hex>"
  },
  "databaseBackup": {
    "path": "backups/database.db",
    "sha256": "<64-lowercase-hex>"
  }
}
```

Apply recomputes both SHA-256 values with descriptor-bound streaming reads.
The container's isolated Python 3 runtime then rehashes the database through
the same open descriptor before SQLite opens `/proc/self/fd/<fd>` in read-only,
immutable mode on Linux and runs `PRAGMA integrity_check`; the only accepted
result is exactly `ok`. This does not depend on the `sqlite3` command-line
program. The receipt must be no more than seven days old. If
retained-candidate recovery was performed, it must be the new receipt created
while still paused after terminal recovery verification, from the fresh
post-recovery database backup and report archive. A pre-recovery receipt is
not a valid post-recovery rollback baseline. When recovery is explicitly
waived, a reviewed pre-r3 receipt may gate the settings operation under that
recorded waiver, but it remains labelled pre-r3 and proves neither recovery nor
post-recovery state. A future change to
`jobHistorySizeLimitGB` additionally requires
`ALLOW_TDARR_JOB_RETENTION_CHANGE=1`.

When recovery was performed, create that generation with the reviewed one-shot
process in
[post-recovery-private-evidence.md](post-recovery-private-evidence.md). Under
an explicit waiver, preserve an equivalently protected and verified pre-r3
generation and keep the waiver and pre-r3 label with it; do not use the
post-recovery name or claim.
For its schema-2 receipt, `reportCount` is the number of descendant regular
`.txt` report files. The accompanying evidence manifest separately records the
total regular-file count in the complete report archive; neither manifest
records report member names.

For an existing-deployment rollout, settings convergence is a post-restart
operation. First resolve the retained-candidate branch: either complete
recovery and its post-recovery DB/config/Flow/report snapshot, or record an
explicit operator waiver while preserving the protected artifacts and verified
pre-r3 generation. Then install and recreate r3, establish the authenticated
loopback API with the new key, prove the internal node has reconnected, and
pass source/server/internal-node catalog, helper, and active Flow parity. Keep
admission and nodes paused throughout.

An environment path does not mount a directory. The tracked Compose example
requires the unique, pre-created Docker volume produced by the reviewed
private-evidence process and mounts it read-only:

```yaml
services:
  tdarr:
    volumes:
      - type: volume
        source: tdarr-private-runtime
        target: /private/tdarr-runtime
        read_only: true
volumes:
  tdarr-private-runtime:
    name: "${TDARR_PRIVATE_RUNTIME_VOLUME:?Set TDARR_PRIVATE_RUNTIME_VOLUME in .env}"
    external: true
```

Set `TDARR_PRIVATE_RUNTIME_VOLUME` to that exact unique volume name. Do not use
a host bind as a substitute: the apply helper requires Linux ownership, mode,
regular-file, link-count, and non-symlink semantics. Pipe
`docker compose config --format json` directly into
`build-scripts/verify-compose-security-model.js` with the reviewed
`TDARR_EXPECTED_*` values as documented in the release checklist; the resolved
model contains the API key and must never be printed or saved. After recreate,
inspect only the running mount:

```bash
docker inspect tdarr \
  --format '{{range .Mounts}}{{if eq .Destination "/private/tdarr-runtime"}}{{.Type}} {{.Name}} {{.Destination}} {{.RW}}{{end}}{{end}}'
```

The inspection must identify the exact reviewed volume and destination and end
in `false`, meaning the mount is not writable.

Run apply only after the post-restart dry plan passes, supplying paths beneath
that mounted root without copying their contents into this repository:

```bash
docker exec \
  -e ALLOW_TDARR_RUNTIME_SETTINGS_APPLY=1 \
  -e TDARR_PRIVATE_RUNTIME_ROOT=/private/tdarr-runtime/<reviewed-generation> \
  -e TDARR_PRIVATE_LIBRARY_IDENTITY_MANIFEST=/private/tdarr-runtime/<reviewed-generation>/reviewed-libraries.json \
  -e TDARR_PRIVATE_ARCHIVE_RECEIPT=/private/tdarr-runtime/<reviewed-generation>/archive-receipt.json \
  tdarr node /tmp/apply-tdarr-runtime-settings.js --apply
```

`python3` must be available with its standard `sqlite3` module. The script
performs three full quiescence checks. After the private gates and second
quiescence pass, it
reauthenticates all reviewed library and global documents with aggregate and
exact-ID reads before issuing partial API updates. Final exact-ID readback
proves every non-target field stayed unchanged.
Read calls require valid JSON. Mutation calls additionally accept an empty
successful 2xx response, HTTP 204, or the exact plain response `success`.
Tdarr CRUD has no compare-and-swap or transaction spanning these documents, so
an external settings writer can still race the final read and a mutation. Keep
all other settings writers stopped for this maintenance operation. A detected
partial failure must remain paused and be rerun idempotently after
investigation. After a successful apply, run the default dry plan again and
require zero pending changes before any further restart or unpause.

## Existing deployment upgrade

An existing deployment must be treated differently from a new install:

1. pause admission without cancelling active jobs and let them drain;
2. set all worker limits to zero only after every worker is idle, run the
   read-only quiescence assertion above, retain its pass result, and separately
   prove each external node's process/lock state;
3. record and re-prove
   `autoUpdateNodes=false`, `autoUpdateServer=false`,
   `pluginAutoUpdate=false`, and `killAllProcessesDuringUpdate=false`; use
   descriptor-bound reads of `/run/s6/container_environment` to require
   explicit `enableDockerAutoUpdater=false`, zero-byte `cronPluginUpdate`,
   and `TDARR_FLOW_PARITY_BOOTSTRAP` explicitly `0` or absent and normalized
   to effective zero; independently validate both runtime configuration JSON
   files as canonical, single-link, safely owned and permissioned, bounded
   strict UTF-8/no-BOM documents with exactly one own empty
   `cronPluginUpdate`; preserve rather than mutate these controls during
   recovery;
4. create private online backups of the named-volume Tdarr DB and learning DB,
   prove no WAL-only state is omitted, and copy the active Flow,
   configuration, and reports;
5. create an owner-only full-byte backup of any source that can be replaced on
   a distinct device outside every live media root, verify matching full
   hashes, and test its read path;
6. resolve the retained-candidate branch. If recovery will run, preserve exact
   r2 coordinator, NVEncC, FFmpeg, artifact/init/build,
   source/server/internal-node catalog, Flow, Compose, environment,
   authentication, and API-key material privately. If the owner waives
   recovery, record that decision and preserve the candidate, checkpoint/latch,
   rollback, and pre-r3 evidence without relabelling it;
7. only when recovery will run, attest every plugin/helper on the actual r2
   controlled-retry route, including its gates, lock/retry path,
   `synthesizeFilmGrain`, Community `replaceOriginalFile`,
   notification/unmonitor branches, and cleanup;
8. only when recovery will run, complete the documented producer-log-only
   import and controlled exact reuse while r2 remains installed;
9. only when recovery will run, require terminal database success, no encoder
   launch, final full-file hash and complete
   decode/stream/colour/duration/size checks, checkpoint and source-scoped
   latch retirement, and final quiescence;
10. while still paused, create and verify the applicable private database
    backup, configuration/active-Flow snapshot, report archive, and version-2
    archive receipt. It is post-recovery only if steps 7-9 completed;
11. reconcile the active graph with the mounted 36-node/58-edge canonical
    graph, build the new image without replacing the running container, and
    run static, schema-v17 delivery, and source-parity tests;
12. add and validate the real read-only private-root mount described above,
    then recreate/restart once in the maintenance window;
13. establish the authenticated loopback API with the new key, prove the
    internal node reconnects, and run source/server/internal-node catalog,
    helper, active-Flow, and deep toolchain parity;
14. use the applicable reviewed receipt to dry-run, apply, read back, and
    zero-change dry-run the reviewed runtime settings. A partial failure blocks
    another restart or unpause; a recovery waiver does not convert pre-r3
    evidence into post-recovery evidence;
15. process one controlled canary and prove candidate validation, attested
    replacement, backup disposition, final
    decode/stream/colour/duration/exact-byte validity, immutable schema-v17
    delivered state, permanent delivery-retirement tombstone, and exact
    journal/checkpoint retirement before reopening admission or concurrency.

The UI/API can report a worker idle while an orphaned or still-supervised
producer continues to encode. The lock and process checks are therefore
mandatory at both the start and end of the maintenance window. Re-run the
assertion immediately before each disruptive operation; a prior pass is not a
lease on future idle state.

If a quarantined checkpoint needs the documented
[producer-log-only recovery](retained-candidate-recovery.md), recover and
complete its controlled exact reuse while the legacy coordinator/NVEncC/FFmpeg
bytes remain installed. Only then install coordinator release `9.25-r3` and
recreate the container; changing executable identity first correctly makes the
migration fail closed.

If the owner instead explicitly waives recovery, preserve the protected
candidate and evidence, record that no recovery was attempted, and proceed
without making any terminal-recovery or post-recovery-evidence claim. That was
the disposition for the
[2026-07-28 r3 rollout](r3-rollout-evidence-2026-07-28.md).

The deployment audited on 2026-07-27 still had an active/canonical graph
mismatch. Its startup parity hook can halt a recreated container. Do not
restart that deployment until the mismatch is reconciled.

That dated mismatch was reconciled before the 2026-07-28 recreate, which
deployed the earlier reviewed 34-node/53-edge SDR-authority generation recorded
in the rollout evidence. The repository later advanced to the 36/58 delivery
design described above, and the final immutable release subsequently deployed
it with schema-17 integrity and two-pass catalog/helper parity. The node
remained paused and quiescent because the live canary was withheld; future
upgrades still must pass the same parity, drain, and canary gates.

## FFmpeg rebuild

Use the tracked compute-120/121 scripts only in a maintenance window. A full
build can take 30–60 minutes and changes the runtime contract:

```bash
docker exec -it tdarr \
  bash /usr/local/build-scripts/rebuild-ffmpeg-compute120.sh
```

After any CUDA, libvmaf, FFmpeg, or init-hook change, run:

```bash
docker exec tdarr tdarr-ffmpeg -hide_banner -filters 2>&1 \
  | grep libvmaf_cuda
docker exec tdarr bash /usr/local/build-scripts/test-vmaf-v1-cuda-capability.sh
docker exec tdarr bash /usr/local/build-scripts/verify-grain-toolchain.sh
```

Capture GPU driver/CUDA versions and `tdarr-ffmpeg -version` with the test
result. Do not run these workload-heavy tests beside active encodes.
