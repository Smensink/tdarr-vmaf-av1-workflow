# Installation and upgrades

The project is a deployment source tree, not a prebuilt appliance. It expects
an NVIDIA-capable host, Docker Compose, local artifact directories, and a
maintenance process that drains Tdarr before disruptive changes.

## Before installation

- Read the [audit](audit-2026-07-27.md) and decide whether to fix the listed
  critical path-handling defects before using untrusted media names.
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

Populate `.env` locally, including a private `TDARR_API_KEY` beginning with
`tapi_`. It is supplied to both the server's `seededApiKey` and the internal
node's `apiKey`. The example also sets
`serverURL=http://127.0.0.1:8266`; environment variables take precedence over
a stale saved node URL. See Tdarr's
[configuration-variable reference](https://docs.tdarr.io/docs/installation/variables/).

The flow-aware Local plugins read separate
`TDARR_RADARR_API_KEY` and `TDARR_SONARR_API_KEY` values. Metadata enrichment
reads `TDARR_PLEX_URL`, `TDARR_PLEX_TOKEN`, `TDARR_TMDB_API_KEY`, and
`TDARR_TVDB_API_KEY`. The exported flow contains placeholders, not working
credentials.

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

The installer copies all tracked plugin identities and the 19 runtime helpers
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
review every external integration input. The snapshot is not a credential
bundle.

Before accepting any jobs, reset `TDARR_FLOW_PARITY_BOOTSTRAP=0` in `.env` and
recreate the new, idle container so strict parity is active:

```bash
docker compose up -d --force-recreate tdarr
docker exec tdarr node /usr/local/build-scripts/verify-vmaf-deployment-parity.js
```

Never enable bootstrap mode on an existing deployment to bypass a mismatch.
Reconcile the live graph during a drained maintenance window instead.

## Existing deployment upgrade

An existing deployment must be treated differently from a new install:

1. stop accepting new jobs and let active jobs drain;
2. record the active flow export and plugin hashes;
3. create an online SQLite backup of the named-volume Tdarr DB and the learning
   DB to private storage;
4. validate that no WAL-only changes are omitted;
5. reconcile the active graph with the mounted canonical graph;
6. build the new image without replacing the running container;
7. run static and source-parity tests;
8. recreate/restart in the maintenance window;
9. run parity and deep toolchain qualification;
10. process one controlled canary before reopening concurrency.

The deployment audited on 2026-07-27 still had an active/canonical graph
mismatch. Its startup parity hook can halt a recreated container. Do not
restart that deployment until the mismatch is reconciled.

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
