# Tdarr VMAF AV1 workflow

This repository captures a production Tdarr flow that searches for
per-title AV1 NVENC settings, measures sample quality, applies size and
banding constraints, optionally reconstructs film grain, and learns from prior
runs.

The tracked live snapshot was exported on 2026-07-27. It contains 34 nodes and
53 edges. Twenty Local plugin identities are active; four more are retained as
inactive reference implementations. The flow snapshot is credential-redacted.

> **Audit status:** the workflow is operational, but the 2026-07-27 review found
> security and correctness defects that should be fixed before accepting
> untrusted filenames or broadening deployment. In particular, three active
> plugins build shell commands from media paths, CPU VMAF-v1 lacks a complete
> geometry preflight, ambiguous BT.2020 sources can be retagged as PQ, and
> direct film-grain output is not fully decode-validated. See the
> [full audit](docs/audit-2026-07-27.md).

## What the flow does

For each eligible source, the active graph:

1. applies a seven-day file-age gate and checks for an NVIDIA encoder;
2. classifies HDR signalling and analyzes source grain;
3. enriches filename metadata where configured;
4. extracts representative samples;
5. searches AV1 NVENC CQ candidates and scores them with VMAF/CAMBI;
6. selects a candidate under quality and projected-size constraints;
7. records learning data and performs the full transcode;
8. validates the transcode, retries a bounded number of times when needed,
   and optionally synthesizes film grain;
9. reorders streams, replaces the source, notifies Radarr/Sonarr, and cleans
   job-owned temporary files.

This is not a claim that every quality policy has been prospectively
validated. The repository records the policy that is running, its tests, and
the audit evidence that still needs controlled validation.

## Repository map

- `flow/tdarr-flow-vmaf-av1.json` — redacted export of the active 34-node flow.
- `configs/flow_YR5PZ1QaD_CANONICAL.json` — parity input for the active graph.
- `plugins/` — readable Local Flow Plugin source; 24 plugin identities.
- `custom-cont-init.d/` — deployment payload and startup pinning hooks.
- `build-scripts/` — FFmpeg/libvmaf, grain-tool, parity, and canary utilities.
- `runtime/vmaf-v1/` — reproducible CPU VMAF-v1 image layer and scorer wrapper.
- `custom-grain-pipeline/`, `custom-grav1synth/`, `custom-nvencc/` — source,
  provenance, and checksums for the pinned grain toolchain. Runtime binaries
  are deliberately excluded.
- `container-overrides/` — Tdarr init override for the custom FFmpeg contract.
- `test-*.js`, `test-*.sh` — static, contract, and explicit runtime tests for
  the deployed flow. Workload-heavy scripts are not part of routine CI.
- `data/public/vmaf-learning-public.sqlite3` — fresh, aggregate-only learning
  snapshot. It is not a copy of the private runtime database.
- `dashboard/` — local audit/operations dashboard source; generated state and
  dependencies are excluded.
- `tools/` — export, manifest, source-parity, install, validation, and privacy
  helpers.

`plugins/` is the review-facing source tree.
`custom-cont-init.d/*-plugin-patches/` is the container deployment mirror
required by existing absolute helper imports. Release validation must confirm
that the init-pinned deployment subset is byte-identical; inactive reference
plugins may exist only in the review tree or persistent live catalog.

## Safe installation outline

Start with [the installation guide](docs/installation.md). The short version:

```bash
cp .env.example .env
cp docker-compose.example.yml docker-compose.yml

# New empty database only: temporarily set TDARR_FLOW_PARITY_BOOTSTRAP=1.
# Populate the documented FFmpeg, libvmaf, CUDA, grav1synth, grain-pipeline,
# NVEncC, and model artifact directories before starting.
docker compose build
docker compose up -d

# Installs plugin files without restarting Tdarr.
bash tools/install-local-plugins.sh tdarr
bash tools/validate-install.sh tdarr
```

The example compose file:

- builds from the tracked CPU VMAF-v1 runtime context;
- mounts the complete canonical init tree;
- binds web/API ports to loopback and enables authentication;
- uses a cheap TCP liveness check rather than recurring deep GPU tests;
- puts CPU scorer scratch outside Tdarr's `/temp` cache scanner;
- disables automatic container replacement.

On a genuinely new database, follow the two-phase bootstrap in the
[installation guide](docs/installation.md): start once with
`TDARR_FLOW_PARITY_BOOTSTRAP=1`, import the canonical flow, then reset the flag
to `0` and recreate before accepting jobs. Existing deployments must never use
the bootstrap flag to bypass a graph mismatch.

Add media mounts deliberately. Read-only mounts are safest for evaluation, but
the final replacement stage requires an explicitly writable path when used in
production.

For an existing deployment, never run the installer with `--restart`, recreate
the container, rebuild FFmpeg, or change the live graph while jobs are active.
The current audited host also has a live/canonical parity mismatch that must be
reconciled during a drained maintenance window.

## Runtime and data boundaries

The workflow expects:

- NVIDIA decode and AV1 NVENC;
- a pinned custom FFmpeg with the deployed libvmaf CUDA contract;
- the isolated official libvmaf 3.2.0 CPU scorer in `runtime/vmaf-v1/`;
- grav1synth, the direct grain pipeline, and the NVEncC KNN coordinator;
- a writable configuration directory for learning data and protected
  post-encode checkpoints.

The private learning database stores paths, titles, release groups, and exact
timestamps. The Tdarr SQL database stores application state and may contain
integration credentials in flow inputs and backups. Neither belongs in this
public repository. Use SQLite's online backup mechanism for a private backup;
use `tools/export-live-state.py` for the public redacted flow and
aggregate-only learning snapshot.

The optional trained size-failure shadow model is private for the same reason:
its exported category vocabulary contains row-derived titles and release
groups. The model runner is tracked; the trained JSON is ignored and excluded
from the manifest.

## Documentation

- [Architecture and live flow](docs/architecture.md)
- [Plugin and helper reference](docs/plugin-reference.md)
- [Quality policy](docs/quality-policy.md)
- [Runtime image and artifacts](docs/runtime-image.md)
- [Installation and upgrades](docs/installation.md)
- [Troubleshooting and operations](docs/troubleshooting.md)
- [Privacy and database handling](docs/privacy-and-data.md)
- [Release checklist](docs/release-checklist.md)
- [2026-07-27 extensive audit report](docs/audit-2026-07-27.md)

## Licensing

The build path can combine GPL and nonfree FFmpeg options for NVIDIA workflows.
This repository publishes source, recipes, checksums, and provenance rather
than generated binaries. Review the applicable licenses before redistributing
an image or binary bundle.
