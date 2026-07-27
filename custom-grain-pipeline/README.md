# Pinned grain-pipeline artifact

This directory contains immutable, versioned release snapshots of the validated
grain-synthesis pipeline. Production mounts this directory read-only at
`/opt/grain-pipeline-artifact`; startup verifies the selected release and copies
it into the container layer before Tdarr can start.

Current release: `v5-20260724-r1`

- Source snapshot: `releases/v5-20260724-r1/grain_pipeline_v5_direct.py`
- SHA-256: `d8dba8f0c5d02ff7ce3feeaa65b2374c37cc6dabc3d7259120d2229c97836a9f`
- Stable container path: `/opt/grain-pipeline/current/grain_pipeline_v5_direct.py`

This release ranks flat, mid-luminance, cut-free source regions and runs
unmodified `grav1synth diff` on at most three 144-frame lossless source/KNN
pairs. It publishes only a byte-for-byte semantic table containing one global
`0..9223372036854775807` segment; otherwise FGS is bypassed and the AV1
transcode continues.

Never edit an existing release in place. To promote a later pipeline, create a
new release directory, record its provenance and checksum, update the expected
release/checksum in the installer and preflight, then validate startup in a
disposable container before recreating Tdarr.
