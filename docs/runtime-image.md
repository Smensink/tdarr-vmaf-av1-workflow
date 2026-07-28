# Runtime image and artifact contract

The deployment is a pinned Tdarr base plus separately mounted FFmpeg, CUDA,
libvmaf, grav1synth, grain-pipeline, NVEncC, and model artifacts.

## CPU VMAF-v1 layer

`runtime/vmaf-v1/Dockerfile.vmaf-v1-cpu`:

- pins the Tdarr base by digest;
- pins the official Ubuntu 24.04 builder to its immutable linux/amd64 platform
  manifest and verifies `dpkg` reports `amd64`;
- builds official libvmaf 3.2.0 plus the pinned post-release revision;
- enables CPU/float tools and built-in models;
- installs into isolated `/opt/vmaf-v1`;
- adds `vmaf-v1` and `vmaf-v1-score` wrappers;
- does not put `/opt/vmaf-v1` on global `LD_LIBRARY_PATH`.

The builder image, VMAF revision, and final runtime base are immutable inputs,
but Ubuntu package versions are still selected from the ordinary archive at
build time rather than a reviewed snapshot repository. Treat the result as a
content-qualified release, not a claim of bit-for-bit reproducibility, and
record the installed toolchain plus final image hashes with each build.

Build through the root compose example or directly:

```bash
docker build \
  -f runtime/vmaf-v1/Dockerfile.vmaf-v1-cpu \
  -t tdarr-vmaf-av1-workflow:local \
  runtime/vmaf-v1
```

The scorer wrapper uses `VMAF_V1_WORK_ROOT`, which the example maps to a
dedicated named volume. This prevents Tdarr's `/temp` cache scanner from
enumerating scorer scratch every minute. `VMAF_V1_MAX_PARALLEL=1` is a
host-wide `flock` semaphore rather than a per-job promise; each scorer also
starts two software decoders, so raising it requires measured control-plane
headroom.

For a wrapper-only maintenance change on an already qualified immutable
runtime, `Dockerfile.wrapper-overlay` copies and hash-verifies only the two
wrappers. Supply the exact qualified base image and both expected wrapper
digests:

```bash
docker build \
  -f runtime/vmaf-v1/Dockerfile.wrapper-overlay \
  --build-arg TDARR_VMAF_BASE_IMAGE=qualified-image@sha256:... \
  --build-arg VMAF_WRAPPER_SHA256="$(sha256sum runtime/vmaf-v1/vmaf-v1-wrapper.sh | awk '{print $1}')" \
  --build-arg SCORE_WRAPPER_SHA256="$(sha256sum runtime/vmaf-v1/vmaf-v1-score.sh | awk '{print $1}')" \
  -t tdarr-vmaf-av1-workflow:wrapper-overlay \
  runtime/vmaf-v1
```

The overlay is not a shortcut around runtime qualification; it makes the
unchanged libvmaf/base lineage explicit while avoiding an unrelated rebuild.

The build is reproducible source, but production metric authority still
requires a versioned calibration artifact and runtime hash attestation. The
resolver/helper geometry contract now fails closed and falls back to GPU-v0 for
unsupported rasters; HDR support remains explicitly provisional. See
[Quality policy](quality-policy.md).

## Custom FFmpeg/libvmaf

`custom-ffmpeg/` is the mounted prefix used by the Tdarr shims.
`custom-cont-init.d/99-replace-ffmpeg.sh` verifies and installs those shims.
The build scripts under `build-scripts/` target the CUDA/libvmaf capability
required by this flow.

Required validation after a rebuild includes:

- `tdarr-ffmpeg -version` and hash;
- `libvmaf_cuda` filter presence;
- CUDA PTX path;
- 10-bit input path;
- the VMAF-v1 capability contract;
- both 8-bit and 10-bit grain/NVEncC smoke tests.

These are qualification checks, not suitable as a recurring 30-second or
two-minute health check.

The native-Linux CPU scorer qualification must also exercise the FIFO
publisher/parser end to end. The scorer publishes the VMAF metric under the
model-qualified alias exactly equal to the pinned model version, and the
consumer requires that exact sole alias in pooled and every frame metric.
Bare, wrong-qualified, duplicate, and suffixed aliases are deployment
failures. A Windows environment that skips native FIFO execution is not
sufficient release evidence.

`verify-grain-toolchain.sh` routes both GPU-heavy smoke checks through
`run-grain-gpu-selftests.js`. The runner attempts one non-stealing acquisition
of the exact generation-owned `TDARR_GPU_PIPELINE_LOCK_DIR` (default
`/temp/tdarr-vmaf-gpu-pipeline.lock`). If production already owns it, the tests
are skipped. Otherwise the runner holds and heartbeats the same lease through
both checks, then requires a token/generation-matched release. This closes the
check-then-run race for manual and legacy preflight invocations; the example
deployment still uses cheap TCP liveness for recurring health.

Each smoke command runs as a detached process-group leader and has a
five-minute deadline. Normal completion is accepted only when the group is
empty. Timeout and `SIGINT`/`SIGTERM` termination send `SIGTERM` to the entire
group, retain the lease through a bounded grace period, escalate the group to
`SIGKILL`, and prove the group absent before release. If group termination
cannot be proved, the runner leaves its `automaticStaleBreakDisabled` lease in
place and fails. That deliberate fail-closed state requires manual recovery
using
[`troubleshooting.md`](troubleshooting.md#gpu-lock-appears-stuck); automatic
production acquisition will not steal it.

## Sample-only denoise trial image

[`runtime/denoise-trial/Dockerfile`](../runtime/denoise-trial/Dockerfile)
derives a batch-only trial image from the exact qualified r3 base. It uses
named `ffmpeg`, `libvmaf`, `nvencc`, and `grav1synth` build contexts, bakes the
trial harness and immutable wrappers, disables the health check, and explicitly
forbids production promotion.

On Windows, a local FFmpeg context containing `.so` reparse points is not a
valid substitute for the reviewed Linux artifact tree. Supply FFmpeg through a
Linux artifact-image context whose symbolic links were preserved. Prefer a
RepoDigest reference; when a locally imported artifact has no RepoDigest, an
operator must prove the dedicated local tag maps to the reviewed image ID
immediately before and after the build. The libvmaf context supplies only the
real versioned library file; the image creates its own soname links.

The image runs as `abc` with UID/GID `1000:1000` and supplementary group
`100` (`users`). Its fresh private output volume must already be owned by
`1000:1000` with mode `0700`; the trial does not run as root to repair volume
ownership. Empty database/configuration/plugin/artifact containment roots are
mounted read-only, while only the exact production `/temp` bind and dedicated
output volume are writable.

See [Sample-only denoise retention trials](denoise-retention-trials.md) for
the build-context rules, exact protected mountpoints, output-volume
preparation, and isolated run template.

## Grain toolchain

The runtime expects stable paths:

```text
/usr/local/bin/grav1synth
/opt/grain-pipeline/current/grain_pipeline_v5_direct.py
/usr/local/bin/nvencc
/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js
```

The init hooks install those paths from read-only artifact mounts after
checksum/provenance checks. The repository omits large/generated binaries.

Coordinator release `9.25-r3` supervises the producer/consumer pair
asymmetrically: if FFmpeg exits first, even with status zero, it terminates a
still-running NVEncC producer; if NVEncC exits successfully first, FFmpeg may
finish draining the pipe. The installer and qualification script authenticate
the coordinator release directory and checksum.

Direct film-grain synthesis rewrites AV1 bitstreams. Structural inspection is
not enough: the plugin now requires a complete strict decode of the rewritten
output before replacement. It uses NVDEC/CUVID after a capability preflight,
or a complete software decode when the GPU decoder is unavailable.

## Startup hooks

The canonical root is `custom-cont-init.d/`; the former stale `docker/` init
tree has been removed. Hooks:

- prepare the build environment and libvmaf;
- install models and the custom FFmpeg shims;
- copy pinned Local plugins/helpers to server and internal-node catalogs;
- after the complete server-to-node seed and all pinned patches, create
  Tdarr_Node's own `<pluginsPath>/.git` development-preservation sentinel so
  its post-init cached `nodePlugins.Zip` download cannot roll the internal
  catalog back to older bytes;
- initialize protected checkpoint storage;
- verify plugin/helper/flow parity;
- install and qualify the grain toolchain.

The parity hook is deliberately fail-closed. A canonical/live mismatch can
halt startup, so graph changes and restarts must be maintenance-window actions.
The internal-node sentinel deliberately disables automatic plugin download for
the bundled node. Catalog upgrades therefore occur only through a drained
recreate that reseeds the complete persistent server catalog, reapplies every
pin, recreates the sentinel, and verifies source/server/node parity before any
worker aperture opens.

## Updates

Disable automatic Tdarr server, node, plugin, and container replacement for
the pinned runtime. Upgrade as one versioned unit:

1. base image digest;
2. VMAF revision and wrapper;
3. FFmpeg/libvmaf/CUDA artifacts;
4. plugin/helper payload;
5. flow canonical;
6. tests and manifest;
7. canary evidence and rollback snapshot.
