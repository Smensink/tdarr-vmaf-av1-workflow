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
- `healthcheck-grain-toolchain.sh` is the cheap TCP liveness probe used by
  Compose. It never launches FFmpeg, NVEncC, VMAF, grav1synth, or a GPU
  self-test, so routine health monitoring does not contend with active work.
- `verify-grain-toolchain.sh` is the explicit deep qualification. Run it
  manually only in a drained maintenance window.

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

## Post-recovery private evidence

`create-post-recovery-evidence.js` is the one-shot, read-only live-state
capture used after independently proved terminal recovery. It creates online
SQLite backups, exact regular-file config/report archives, the consistent
active-Flow snapshot, and the schema-2 receipt consumed by
`apply-tdarr-runtime-settings.js`. It requires pre/post quiescence, an existing
reviewed exact-four library manifest, and an externally reviewed
terminal-recovery receipt bound by its full SHA-256. It also rehashes the
receipt-bound JSONL journal and the exact frozen watcher implementation before
copying all three into the private generation.

Run it only in the isolated helper-container layout documented in
[`docs/post-recovery-private-evidence.md`](../docs/post-recovery-private-evidence.md).
The live mounts, including `/temp`, remain read-only; only a unique private
destination volume is writable. Generated data is private and must never be
committed.

## Deployment security qualification

`verify-compose-security-model.js` consumes
`docker compose config --format json` on standard input and emits only a
generic result. It requires the exact reviewed image reference, private
evidence volume, staged init/build/NVEncC bind sources, and (when non-default)
host ports through `TDARR_EXPECTED_*` environment values. The host-port
variables default to 8265/8266. It then proves that the resolved model has:

- only loopback-published web/API ports;
- authentication enabled with matching non-empty server/internal-node keys;
- the literal loopback internal-node URL;
- updater and Flow bootstrap controls disabled;
- the cheap TCP health check;
- exact read-only init/build/NVEncC binds; and
- exactly one read-only private evidence volume, declared external under the
  fixed Compose key `tdarr-private-runtime` and bound to the separately
  reviewed volume name;
- no unreviewed additional Compose service.

The verifier additionally requires
`TDARR_EXPECTED_SANITIZED_MODEL_SHA256`, the digest recorded during the
separate review of the complete resolved model. Its
`--print-sanitized-sha256` mode emits only that digest; it replaces API keys,
tokens, passwords, and secret values before hashing. Record the digest after
review, then run normal verification immediately before recreate. This binds
the full service, mount, label, build, logging, volume, and network model
without printing private paths or credentials. Do not derive and approve a
new digest inside the same command that performs release verification.

The resolved Compose JSON contains credentials. Pipe it directly into the
verifier; never print or save it as release evidence.

`verify-tdarr-auth-boundary.js` is the complementary post-start probe. It sends
an intentionally unauthenticated `GET /api/v2/get-nodes` to the literal
loopback API and accepts only HTTP 401 or 403. HTTP 2xx, a missing route,
redirect, oversized response, timeout, or transport error fails
qualification. It never reads or sends the configured API key.

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
