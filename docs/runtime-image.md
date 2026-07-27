# Runtime image and artifact contract

The deployment is a pinned Tdarr base plus separately mounted FFmpeg, CUDA,
libvmaf, grav1synth, grain-pipeline, NVEncC, and model artifacts.

## CPU VMAF-v1 layer

`runtime/vmaf-v1/Dockerfile.vmaf-v1-cpu`:

- pins the Tdarr base by digest;
- builds official libvmaf 3.2.0 plus the pinned post-release revision;
- enables CPU/float tools and built-in models;
- installs into isolated `/opt/vmaf-v1`;
- adds `vmaf-v1` and `vmaf-v1-score` wrappers;
- does not put `/opt/vmaf-v1` on global `LD_LIBRARY_PATH`.

Build through the root compose example or directly:

```bash
docker build \
  -f runtime/vmaf-v1/Dockerfile.vmaf-v1-cpu \
  -t tdarr-vmaf-av1-workflow:local \
  runtime/vmaf-v1
```

The scorer wrapper uses `VMAF_V1_WORK_ROOT`, which the example maps to a
dedicated named volume. This prevents Tdarr's `/temp` cache scanner from
enumerating scorer scratch every minute.

The build is reproducible source, but production metric authority still
requires a versioned calibration artifact and runtime hash attestation. The
current helper has incomplete geometry coverage and provisional HDR support;
see [Quality policy](quality-policy.md).

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

Direct film-grain synthesis rewrites AV1 bitstreams. Structural inspection is
not enough: release qualification must include a bounded full-title decode of
the rewritten output before replacement.

## Startup hooks

The canonical root is `custom-cont-init.d/`; the former stale `docker/` init
tree has been removed. Hooks:

- prepare the build environment and libvmaf;
- install models and the custom FFmpeg shims;
- copy pinned Local plugins/helpers to server and internal-node catalogs;
- initialize protected checkpoint storage;
- verify plugin/helper/flow parity;
- install and qualify the grain toolchain.

The parity hook is deliberately fail-closed. A canonical/live mismatch can
halt startup, so graph changes and restarts must be maintenance-window actions.

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
