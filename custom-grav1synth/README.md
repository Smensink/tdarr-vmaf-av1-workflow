# Pinned grav1synth artifact

This directory is the local artifact slot for the validated Linux x86-64
`grav1synth` binary used by the Tdarr grain-synthesis pipeline. The public
repository records its provenance and checksum, but deliberately does not track
the generated `bin/grav1synth` binary. Place a checksum-matching local build in
that path before deployment. Container startup never downloads or builds the
tool: `98-install-grav1synth.sh` verifies the local artifact and copies it into
the container layer.

- Version: `0.2.0`
- Source: `https://github.com/rust-av/grav1synth`
- Commit: `1044228cd411672b565e5762a9b3597f4dd163b0`
- Local patch: `build-scripts/patches/grav1synth-nvenc-sequence-header.patch`
- Patch SHA-256: `0beb125d34a0c8223a27728440a9dcbc05d72787570d5a0c634a48649a67e4a7`
- Binary SHA-256: `5e6e462e7c6ddf1229e965d1bb4741b698f9cd9d40e4c0c0ec90d419d42c6e9e`

The local patch fixes two Sequence Header rewrite defects exposed by padded
10-bit `av1_nvenc` packets: it changes the actual
`film_grain_params_present` bit instead of the final padding byte, and keeps
the Sequence Header OBU length invariant. The build must pass all Rust tests
and `test-grav1synth-nvenc-sequence-header.sh` before promotion.

The binary is dynamically linked to the FFmpeg 6 ABI supplied by the
digest-pinned Tdarr base image (`libavformat.so.60`, `libavcodec.so.60`, and
`libavutil.so.58`). Run the preflight after every base-image upgrade; rebuild
the artifact if that ABI changes.

## Manual rebuild

Inside a Tdarr build container with the pinned Rust toolchain and FFmpeg
development packages installed:

```bash
bash /usr/local/build-scripts/rebuild-grav1synth.sh
```

The script checks out the exact pinned commit, verifies and applies the pinned
patch, runs the full Rust suite and the real NVENC regression, then builds into
a unique `/temp/grav1synth-build.*` staging directory. Review its version and
checksum, copy `bin/`, `PROVENANCE.txt`, and `SHA256SUMS` into this directory,
and update the pinned checksum and patch provenance in both init/preflight
scripts as one change.

Never replace only the binary: provenance, checksum, and verifier constants
must remain synchronized.
