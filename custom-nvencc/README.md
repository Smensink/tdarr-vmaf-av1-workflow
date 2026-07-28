# Pinned NVEncC KNN artifact

This directory persists the reviewed Linux x86-64 NVEncC build and the
non-shell coordinator used to stream its CUDA KNN output into the production
FFmpeg AV1 encode. Container startup does not download or rebuild either file.

- Artifact release: `9.25-r3` (NVEncC reports `9.25 (r1)`)
- Source: `https://github.com/rigaya/NVEnc`
- Tag: `9.25`
- Commit: `8c873e4d15aefb93dd50396e5c70fffb842f7d22`
- Local build patch:
  `build-scripts/patches/nvencc-9.25-optional-metadata-libs.patch`
- Binary SHA-256:
  `03d8a26631fef47881f30243e4442dcb26a66cabbb586ae9637c9e22b9776294`
- Coordinator SHA-256:
  `6ba05f26647611c1be0986ffee218858f1c0b0734f94bf21af7759e067954576`

The r3 coordinator treats any FFmpeg-consumer exit while NVEncC is still
running as a failed pipeline and terminates the producer. This prevents a
zero-exit early consumer from leaving a hidden NVEncC process and GPU lease
alive after Tdarr reports its worker idle.

The local patch makes bundled Dolby Vision and HDR10+ Rust metadata libraries
optional. This artifact was built with both disabled; those formats are
normalized elsewhere before the static-HDR10/SDR grain path. The KNN filter,
raw 8-bit output, and raw P010/10-bit output remain enabled and are exercised
by `build-scripts/test-nvencc-knn-smoke.sh`.

`98-install-nvencc.sh` verifies the exact two-entry checksum manifest and
provenance, copies both files into an immutable release below `/opt/nvencc`,
and atomically publishes:

- `/usr/local/bin/nvencc`
- `/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js`

The binary is dynamically linked to libraries in the digest-pinned Tdarr base
image, including FFmpeg 6, CUDA, VA-API, OpenCL, and the image's media codec
libraries. Re-run the complete preflight after every image upgrade and rebuild
the artifact if any dependency becomes unresolved.

Never replace only one file. Update the binary/coordinator checksums,
`PROVENANCE.txt`, `SHA256SUMS`, installer constants, preflight constants, and
deployment documentation together.
