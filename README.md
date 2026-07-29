# Tdarr VMAF AV1 workflow

Quality-targeted AV1 encoding on an **NVIDIA GPU**, in Tdarr. Instead of picking
one CQ for your whole library and hoping, this measures each title and picks the
lowest bitrate that still hits a quality target you set.

## The short version

A fixed CQ is a compromise. Set it low and grainy or dark films fall apart; set
it high and you waste space on easy content. Software encoders have tooling to
solve this — but they're slow, and that tooling assumes you're using them.

This does it with `av1_nvenc`, so a film takes tens of minutes rather than
overnight. Two real results from the library it runs on:

| Title | Source | AV1 output | Size |
|---|---|---|---|
| 4K HDR WEB-DL episode | 11.34 GB | 3.49 GB | 31% |
| 4K HDR Bluray episode | 17.01 GB | 10.12 GB | 59% |

Same quality target, very different outcomes — which is the entire point. The
second title genuinely needed most of its bitrate; a fixed CQ tuned for it would
have wasted several GB on the first.

## Three things this measures

**VMAF** — Netflix's perceptual quality score (0–100). Better than PSNR or SSIM
at matching what people actually notice. The flow targets a harmonic-mean VMAF
of 95 across samples, so one bad scene can't be hidden by easy ones.

**1%-low frame VMAF** — the worst frames, not the average. A file can average 96
and still contain a scene that visibly falls apart. There's a per-title floor
(around 86 for 4K HDR) that a candidate has to clear.

**CAMBI** — a banding detector. Banding is the blotchy stair-stepping you see in
skies, smoke and dark gradients. It's the artifact AV1 encoders most often trade
away for bitrate, and VMAF barely registers it — so it gets its own limit. In
practice it's frequently the constraint that binds.

## Film grain synthesis, and why it's here

AV1 has a trick: rather than spending bitrate encoding grain (which is noise,
and compresses terribly), strip it, then have the *decoder* regenerate it on
playback from a small parameter table. Grainy films get dramatically smaller
without the plasticky smear of just denoising them.

`SVT-AV1` and `libaom` support this natively. **NVENC's AV1 encoder does not
expose it.** So this measures the grain on the source, encodes without it, and
writes the grain table into the output itself — which is the main reason this
repo exists rather than being a config file.

## Why hardware

Quality-targeted encoding is well-trodden ground for software encoders —
[`ab-av1`](https://github.com/alexheretic/ab-av1) does VMAF-targeted CRF search
for SVT-AV1 and libaom, and does it well. But software AV1 at 4K is slow enough
that a large library becomes a months-long project, and those tools target
software encoders specifically.

The trade-off is real and worth stating plainly: NVENC is less efficient per bit
than a slow SVT-AV1 preset. You give up some compression to get a library
finished this year rather than next.

## Who this is for

Probably you, if: you run Tdarr with an NVIDIA card, you have a large 4K/HDR
library, and you've been uneasy picking one CQ for everything.

Probably not, if you want plug-and-play. This is a working production setup, not
a distributable plugin — it expects specific build artifacts (a custom FFmpeg
with libvmaf, NVEncC, grav1synth) and is deliberately opinionated about safety.
Read [Safe installation outline](#safe-installation-outline) first, and treat it
as something to adapt rather than drop in.

**It will not touch your originals unless a candidate passes every gate** —
quality, worst-frame floor, banding and size — and replacement goes through a
validator and an attested transaction. Titles that can't hit the target are left
alone, deliberately.

---

## Technical detail

This repository captures a production Tdarr flow that searches for
per-title AV1 NVENC settings, measures sample quality, applies size and
banding constraints, optionally reconstructs film grain, and learns from prior
runs.

The tracked flow was exported on 2026-07-27 and then received the audited r3
fail-closed routing and delivery migration. It now contains 36 nodes and 58
edges. Twenty-three Local plugin identities occur in the tracked graph; four
more are retained as inactive reference implementations. The flow snapshot is
credential-redacted.

> **Audit status:** the 2026-07-27 repair source addresses the identified
> security and correctness blockers. Media-path commands now use literal argv
> with no shell boundary; the two audited graph routes fail closed; CPU-v1
> geometry is authenticated before authority; ambiguous BT.2020 transfer keeps
> the original; the GPU lock uses atomic generation-owned lease state; direct
> grain rewrites require a full-title decode, with GPU decode under a narrow
> lease;
> and delivery uses a validator, attested replacement transaction, and final
> database authority. A checkout is not proof of live deployment:
> verify process-level drain, catalog/flow parity, runtime hashes, and a
> controlled canary. CPU-v1 HDR calibration and the remaining design work are
> tracked in the [full audit](docs/audit-2026-07-27.md).

> **Current deployment evidence (2026-07-28):** immutable release
> `r3-20260727T233311Z-7b625a1f-final` is live and healthy. The active Flow,
> canonical, and redacted export agree at 36 nodes/58 edges; learning schema 17
> passed integrity checks; and 366 catalog files plus 23 runtime helpers passed
> parity twice. Authentication, Compose, settings, and toolchain qualification
> passed. The node remains paused and quiescent because the queue-isolated live
> canary is still withheld.

## What the flow does

For each eligible source, the tracked graph:

1. applies a seven-day file-age gate and checks for an NVIDIA encoder;
2. classifies HDR signalling and analyzes source grain;
3. enriches filename metadata where configured;
4. extracts representative samples;
5. searches AV1 NVENC CQ candidates and scores them with VMAF/CAMBI;
6. selects a candidate under quality constraints and a separately bounded
   projected-size research contract;
7. records learning data and performs the full transcode;
8. validates the base transcode, retries a bounded number of times when needed,
   and optionally synthesizes film grain;
9. remuxes as needed, applies the exact delivered-byte policy, performs a
   crash-safe attested replacement, and finalizes the immutable delivered
   database outcome; and
10. notifies Radarr/Sonarr, unmonitors only a path-verified Arr identity, and
    cleans job-owned temporary files.

The current delivered-size policy is one versioned contract: a 30% search
target, a 20% minimum delivered reduction, and an 80% maximum final
output/source ratio. The historical 90% projected-ratio boundary is separate
research/advisory evidence and is not a delivered-success threshold.

This is not a claim that every quality policy has been prospectively
validated. The repository records the policy represented by the tracked graph,
its tests, and the audit evidence that still needs controlled validation.

## Repository map

- `flow/tdarr-flow-vmaf-av1.json` — redacted 36-node audited flow.
- `configs/flow_YR5PZ1QaD_CANONICAL.json` — parity input for the tracked graph.
- `plugins/` — readable Local Flow Plugin source; 27 plugin identities.
- `custom-cont-init.d/` — deployment payload and startup pinning hooks.
- `build-scripts/` — FFmpeg/libvmaf, grain-tool, parity, and canary utilities.
- `runtime/vmaf-v1/` — reproducible CPU VMAF-v1 image layer and scorer wrapper.
- `custom-grain-pipeline/`, `custom-grav1synth/`, `custom-nvencc/` — source,
  provenance, and checksums for the pinned grain toolchain. Runtime binaries
  are deliberately excluded.
- `container-overrides/` — Tdarr init override for the custom FFmpeg contract.
- `test-*.js`, `test-*.sh` — static, contract, and explicit runtime tests for
  the tracked flow and deployment contract. Workload-heavy scripts are not part
  of routine CI.
  `test-plugin-safety-boundaries.js` covers age-record publication, cleanup and
  retry containment, grain real-path scope, the final watchdog, and source/init
  mirror parity.
- `data/public/vmaf-learning-public.sqlite3` — fresh, aggregate-only learning
  snapshot using public export schema `tdarr-vmaf-public-learning/v3`. It is
  not a copy of the private schema-17 runtime database.
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

# Before build/start, generate or populate the required private TDARR_API_KEY,
# create a unique external Docker volume for private runtime evidence, and set
# TDARR_PRIVATE_RUNTIME_VOLUME to its exact name. Never commit .env.
# On Windows, use build-scripts/new-private-tdarr-env.ps1 instead of copying
# .env.example; it generates both values, then create the named Docker volume.
# New empty database only: temporarily set TDARR_FLOW_PARITY_BOOTSTRAP=1.
# Populate the documented FFmpeg, libvmaf, CUDA, grav1synth, grain-pipeline,
# NVEncC, and model artifact directories before starting.
docker compose build
docker compose up -d

# On a new, idle deployment, installs plugin files without restarting Tdarr.
bash tools/install-local-plugins.sh tdarr
bash tools/validate-install.sh tdarr
```

The example compose file:

- builds from the tracked CPU VMAF-v1 runtime context;
- mounts the complete canonical init tree;
- binds web/API ports to loopback and enables authentication;
- uses a cheap TCP liveness check rather than recurring deep GPU tests;
- puts CPU scorer scratch outside Tdarr's `/temp` cache scanner;
- mounts the explicitly named private-runtime evidence volume read-only; and
- disables automatic container replacement.

On a genuinely new database, follow the two-phase bootstrap in the
[installation guide](docs/installation.md): start once with
`TDARR_FLOW_PARITY_BOOTSTRAP=1`, import the canonical flow, then reset the flag
to `0` and recreate before accepting jobs. Existing deployments must never use
the bootstrap flag to bypass a graph mismatch.

Add media mounts deliberately. Read-only mounts are safest for evaluation, but
the final replacement stage requires an explicitly writable path when used in
production.

For an existing deployment, drain before copying plugin or helper bytes at
all. Omitting `--restart` avoids an interruption, but it does not make a live
catalog mutation safe: a partial copy or an already-loaded module can create a
mixed generation. Never run the installer with `--restart`, recreate the
container, rebuild FFmpeg, or change the live graph while jobs are active. Do
not trust the API's idle flag alone: require the production GPU lock to be
absent and inspect the real process tree for coordinators, NVEncC, FFmpeg,
VMAF, and grain work. Reconcile any live/canonical mismatch only in that
process-level drained maintenance window.

The exceptional retained-candidate migration is split deliberately: the public
schema-1 utility only imports and arms exact reuse, while the private one-shot
schema-2 dispatcher binds safety gates to the actual FileJSONDB queue write.
Immediately before queueing it authenticates the exact unredacted live Flow,
global settings, complete library-root collection, descriptor-bound updater
controls from `/run/s6/container_environment`, both strict runtime
configuration JSON files, every plugin/helper in the full r2 graph across
exact source/server/node namespaces, and a full-byte source copy on a distinct
device outside every media root. It treats an absent
`TDARR_FLOW_PARITY_BOOTSTRAP` entry as effective zero, but requires explicit
`enableDockerAutoUpdater=false` and a zero-byte `cronPluginUpdate`. It repeats
the proof before opening the worker aperture and prints no paths, hashes,
Flow/job identities, or raw errors. See
[Retained-candidate recovery](docs/retained-candidate-recovery.md).

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

- [Architecture and tracked flow](docs/architecture.md)
- [Plugin and helper reference](docs/plugin-reference.md)
- [Quality policy](docs/quality-policy.md)
- [Runtime image and artifacts](docs/runtime-image.md)
- [Installation and upgrades](docs/installation.md)
- [Troubleshooting and operations](docs/troubleshooting.md)
- [Privacy and database handling](docs/privacy-and-data.md)
- [Release checklist](docs/release-checklist.md)
- [2026-07-27 extensive audit report](docs/audit-2026-07-27.md)
- [2026-07-28 r3 rollout evidence and limits](docs/r3-rollout-evidence-2026-07-28.md)
- [Live job forensics and remediation](docs/live-forensics-2026-07-27.md)
- [Retained-candidate recovery](docs/retained-candidate-recovery.md)
- [Post-recovery private evidence](docs/post-recovery-private-evidence.md)
- [Sample-only denoise retention trials](docs/denoise-retention-trials.md)

## Licensing

The build path can combine GPL and nonfree FFmpeg options for NVIDIA workflows.
This repository publishes source, recipes, checksums, and provenance rather
than generated binaries. Review the applicable licenses before redistributing
an image or binary bundle.
