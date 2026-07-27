# Build Scripts for FFmpeg + libvmaf with Compute 120 Support

This directory contains the main script for building FFmpeg and libvmaf with RTX 50 series GPU support (compute_120).

## Main Build Script

### `rebuild-ffmpeg-compute120.sh`
Full rebuild of both libvmaf and FFmpeg with compute_120 support.

- Uses CUDA 13.1 (if available) or falls back to CUDA 13.0
- Builds libvmaf with compute_120 PTX (using master branch)
- Builds FFmpeg with compute_120/121 support
- Properly links against libcudart for scale_cuda support
- **Time**: 30-60 minutes

## Usage

The script is available in the container at `/usr/local/build-scripts/`:

```bash
# Full rebuild with compute_120
docker exec -it tdarr bash /usr/local/build-scripts/rebuild-ffmpeg-compute120.sh
```

### Grain-synthesis tooling

- `rebuild-grav1synth.sh` checks out the exact pinned grav1synth revision,
  verifies and applies the pinned NVENC Sequence Header patch, runs the full
  Rust suite plus `test-grav1synth-nvenc-sequence-header.sh`, and builds into a
  unique staging directory. It is not run at container startup.
- `test-nvencc-knn-smoke.sh` sends four-frame 8-bit and P010/10-bit fixtures
  through NVEncC's CUDA KNN filter as Tdarr's unprivileged runtime user. The
  production preflight uses it to catch missing GPU access, unsupported
  high-bit-depth paths, or a build without `--vpp-knn`.
- `verify-grain-toolchain.sh` verifies the persisted binary checksum, pipeline
  syntax, CLI subcommands, exact FFmpeg wrapper identity, `av1_nvenc`
  availability, and the pinned NVEncC binary/coordinator artifact.
- `healthcheck-grain-toolchain.sh` is an on-demand quiet wrapper around that
  deep preflight. The tracked Compose health check is a cheap TCP liveness
  probe so routine health monitoring does not contend with active GPU work.

```bash
docker exec tdarr bash /usr/local/build-scripts/verify-grain-toolchain.sh
```

## Artifact locations

FFmpeg/libvmaf rebuild scripts target the mounted host directories below.
grav1synth and NVEncC builds are staged and must be deliberately promoted with
their matching provenance/checksum files; they are not published
automatically.

- FFmpeg binaries: `./custom-ffmpeg/` (mounted to `/usr/local/ffmpeg-custom`)
- libvmaf libraries: `./custom-libvmaf-lib/` (mounted to
  `/custom-libvmaf-lib`; init copies the pinned files into the runtime linker
  location)
- libvmaf headers: `./custom-libvmaf-include/` (mounted to `/usr/local/include/libvmaf`)
- Build workspace: `./build-workspace/` (mounted to `/tmp/ffmpeg-build`)
- grav1synth binary: `./custom-grav1synth/` (mounted read-only as an artifact)
- Grain pipeline releases: `./custom-grain-pipeline/` (mounted read-only as an artifact)
- NVEncC and its KNN-to-FFmpeg coordinator: `./custom-nvencc/` (mounted
  read-only as one checksummed artifact)
- Grain canary evidence: `./grain-pilot-review/`

## Reproducibility and runtime pinning

The deployment inputs are controlled:

1. All build scripts are version-controlled
2. Tdarr's runtime image is pinned by digest in the tracked
   `docker-compose.example.yml` (copied locally to `docker-compose.yml`)
3. grav1synth source, local patch, regression fixture, and Rust versions are
   pinned and its artifact is verified by SHA-256
4. NVEncC 9.25 source, the local optional-metadata-library patch, binary, and
   coordinator are pinned and verified by SHA-256
5. The promoted Python pipeline is a versioned artifact verified by SHA-256
6. Native FFmpeg/NVEncC development libraries and linker output still depend on the
   selected builder image; treat a rebuild as a new reviewed artifact rather
   than assuming a bit-for-bit-identical binary
7. Selected output directories persist on the host; staged grain/NVEncC
   artifacts require explicit promotion
8. Init scripts verify the pinned environment at startup; deep qualification
   is run manually while the queue is idle, not continuously
