# Sample-only denoise retention trials

`tools/denoise-retention-trial.js` screens whether a modest increase in the
canonical spatial KNN denoiser might make an otherwise size-inefficient title
smaller without an obvious perceptual loss. It does not change the Flow,
plugins, Tdarr jobs, or the learning database, and it cannot authorize a
production setting.

## Observed screen status

Two isolated screens completed on 2026-07-28. Neither produced a valid
comparison output, objective metric, or contact sheet, so neither supports a
visual, size, quality, full-title, or production-setting conclusion. The first
used a predecessor artifact whose reason taxonomy collapsed an operational
fit failure and non-global table rejections. With the corrected harness, the
second recorded its 0.08 control as
`grain_synthesis_fit_runtime_failure` and skipped 0.10/0.12 without GPU work as
`control_setting_unavailable`. The sanitized findings and evidence boundary
are recorded in [live job forensics](live-forensics-2026-07-27.md).

The default comparison is:

| Setting | Role | Contract handling |
| --- | --- | --- |
| NVEncC KNN `strength=0.08` | Control | Uses the canonical production denoise and reference IDs. |
| NVEncC KNN `strength=0.10` | Trial only | Uses distinct `trial-only-...s010...` denoise, reference, and grav1synth IDs. |
| NVEncC KNN `strength=0.12` | Trial only | Uses distinct `trial-only-...s012...` denoise, reference, and grav1synth IDs. |
| NVEncC KNN `strength=0.14` | Explicit escalation only | Excluded by default; requires confirmation that 0.12 was reviewed plus a written justification. |

There is no arbitrary-strength input. The hard cap is 0.14.

## What the harness preserves

For every setting that is executed (stronger settings are skipped when the
control is unavailable), the harness:

1. scans the title at the same 24 evenly distributed low-resolution proxy
   positions as the production v5 analyzer, ranks flat mid-luminance regions
   without cut-like motion, and keeps at most three separated candidates;
2. for each allowlisted strength, extracts exactly 144 native-depth frames from
   each candidate in rank order, stores the source and KNN result as lossless
   FFV1, and runs plain
   `grav1synth diff LOSSLESS_SOURCE LOSSLESS_KNN_DENOISED`;
3. rejects malformed, payload-free, empty, or multi-segment tables and tries the
   next candidate. It atomically publishes the first semantic, unmodified
   `0..9223372036854775807` table byte-for-byte, with no merge, retime, scale, or
   other normalization;
4. separately extracts every supplied review interval to native-depth lossless
   FFV1 and runs NVEncC 9.25 KNN for each interval as a raw NUT producer;
5. encodes the denoised clip with `av1_nvenc`, preset `p7`, VBR/CQ,
   zero bitrate, the selected approved quality profile, and NVENC temporal
   filtering disabled;
6. applies the one byte-stable fitted table across every reviewed interval with
   `grav1synth apply`; and
7. fully decodes the grained result before measuring it.

The fit candidates and the three-to-five review intervals have different jobs.
Fit candidates reproduce production's constant-model selection. Review
intervals provide paired dark, shadow, midtone, highlight, texture, and visual
evidence; their order cannot choose the grain model. If every bounded ranked
candidate (up to three) is validly analyzed but each is semantically empty or
multi-segment, `results.json` records `status=setting_unavailable` with
`grain_synthesis_static_model_unrepresentable`. A command, tool, or timeout
failure instead records `grain_synthesis_fit_runtime_failure`; malformed or
payload-free grav1synth output records `grain_synthesis_invalid_table_output`.
Neither operational failure is misreported as evidence that a constant grain
model is unrepresentable. Every unavailable setting produces no comparison
clips and explicitly withholds a denoise conclusion. The harness never makes a
multi-segment table global.

The 0.08 control is the comparison anchor. If its fit is unavailable for any
reason, 0.10, 0.12, and an explicitly enabled 0.14 are not fitted or evaluated.
Their result records use `control_setting_unavailable`, retain the control's
underlying reason, set `skippedWithoutGpuWork=true`, and report zero setting
wall time. This avoids spending GPU time on results that cannot be compared
with the control while preserving a structurally complete report.

This preserves the important NVENC plus grav1synth shape of production. It is a
bounded screening experiment, not a replacement for the full production
calibration, checkpoint, ancillary-stream, or final validation path.

Before it creates a run directory, the harness hashes the complete source and
requires both that SHA-256 and its exact byte size to match the schema-3 input
and its separately authenticated provenance receipt. The same preflight
identity is reused as the case's before identity, so schema 3 does not add an
otherwise redundant whole-source hash. The harness hashes the source again
after the case. Each hash is bound to the open file descriptor's size,
nanosecond mtime and ctime, device, and inode, and the path must still resolve
to that same regular non-symlink file. Any identity difference invalidates the
case.

Each case supplies three to five 4–12 second clips, with at most 36 seconds of
source material. Every executed denoise setting has a twelve-minute wall budget
per case and runs sequentially. The fail-closed budget covers up to three ranked
production-shaped 144-frame fit attempts plus the review work; a setting that
cannot finish within it is unavailable, not partially accepted. Fitting a
separate table per review clip is both slower and unlike production. The
harness still avoids a full-title experimental transcode.

## Private input and path-policy schema

Do not add trial input, results, media paths, or contact sheets to Git. Create
the JSON in a private directory mounted into the container. The CQ and NVENC
quality profile should come from the actual retained-original job evidence;
do not guess them.

Input schema 3 is defined by
[`denoise-retention-trial-input.schema.json`](denoise-retention-trial-input.schema.json).
The private receipt contract is defined by
[`denoise-retention-provenance-receipt.schema.json`](denoise-retention-provenance-receipt.schema.json).
Schema 1 inputs are rejected because they do not declare a dedicated output
root or protected filesystem roots. Schema 2 inputs are also rejected because
they can assert a source path, CQ, and profile without authenticating the
retained-original evidence or the expected source bytes.

```json
{
  "schema": 3,
  "acknowledge_node_paused_and_drained": true,
  "private_output_root": "/denoise-trial-output",
  "acknowledge_protected_roots_complete": true,
  "acknowledge_no_git_checkout_mounted": true,
  "protected_roots": {
    "media": [
      "/media"
    ],
    "tdarr_database": [
      "/app/server/Tdarr/DB2"
    ],
    "tdarr_config": [
      "/app/configs"
    ],
    "tdarr_plugins": [
      "/app/server/Tdarr/Plugins",
      "/custom-cont-init.d",
      "/usr/local/build-scripts",
      "/opt/grav1synth-artifact",
      "/opt/grain-pipeline-artifact",
      "/opt/nvencc-artifact"
    ],
    "git": [],
    "backups": [
      "/protected-host/backups",
      "/private/denoise-input"
    ]
  },
  "production_gpu_lock_path": "/temp/tdarr-vmaf-gpu-pipeline.lock",
  "nvenc_quality_profile": "enhanced",
  "minimum_control_saving_pct": 3,
  "minimum_source_estimate_saving_pct": 3,
  "maximum_vmaf_drop": 0.5,
  "maximum_cambi_increase": 0.25,
  "maximum_band_mae_increase_pct": 10,
  "tools": {
    "ffmpeg": "/usr/local/bin/tdarr-ffmpeg",
    "ffprobe": "/usr/local/bin/tdarr-ffprobe",
    "nvencc": "/usr/local/bin/nvencc",
    "grav1synth": "/usr/local/bin/grav1synth"
  },
  "expected_tool_identities": {
    "ffmpeg": {
      "resolved_path": "/usr/local/bin/tdarr-ffmpeg",
      "sha256": "5555555555555555555555555555555555555555555555555555555555555555",
      "size_bytes": 512,
      "reviewed_symlink_chain": [],
      "wrapper_contract": {
        "kind": "posix-sh-exec-v1",
        "interpreter": {
          "path": "/bin/sh",
          "resolved_path": "/usr/bin/dash",
          "sha256": "6666666666666666666666666666666666666666666666666666666666666666",
          "size_bytes": 125640,
          "reviewed_symlink_chain": [
            {
              "path": "/bin",
              "target": "usr/bin"
            },
            {
              "path": "/usr/bin/sh",
              "target": "dash"
            }
          ]
        },
        "exec_target": {
          "path": "/usr/local/ffmpeg-custom/bin/ffmpeg",
          "resolved_path": "/usr/local/ffmpeg-custom/bin/ffmpeg",
          "sha256": "7777777777777777777777777777777777777777777777777777777777777777",
          "size_bytes": 123456789,
          "reviewed_symlink_chain": []
        },
        "ld_library_path": "/custom-libvmaf-lib:/usr/local/ffmpeg-custom/lib:/usr/local/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/lib:${LD_LIBRARY_PATH:-}"
      }
    },
    "ffprobe": {
      "resolved_path": "/usr/local/bin/tdarr-ffprobe",
      "sha256": "8888888888888888888888888888888888888888888888888888888888888888",
      "size_bytes": 512,
      "reviewed_symlink_chain": [],
      "wrapper_contract": {
        "kind": "posix-sh-exec-v1",
        "interpreter": {
          "path": "/bin/sh",
          "resolved_path": "/usr/bin/dash",
          "sha256": "6666666666666666666666666666666666666666666666666666666666666666",
          "size_bytes": 125640,
          "reviewed_symlink_chain": [
            {
              "path": "/bin",
              "target": "usr/bin"
            },
            {
              "path": "/usr/bin/sh",
              "target": "dash"
            }
          ]
        },
        "exec_target": {
          "path": "/usr/local/ffmpeg-custom/bin/ffprobe",
          "resolved_path": "/usr/local/ffmpeg-custom/bin/ffprobe",
          "sha256": "9999999999999999999999999999999999999999999999999999999999999999",
          "size_bytes": 12345678,
          "reviewed_symlink_chain": []
        },
        "ld_library_path": "/custom-libvmaf-lib:/usr/local/ffmpeg-custom/lib:/usr/local/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/lib:${LD_LIBRARY_PATH:-}"
      }
    },
    "nvencc": {
      "resolved_path": "/opt/nvencc/releases/qualified-r3/bin/nvencc",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "size_bytes": 23456789,
      "reviewed_symlink_chain": [
        {
          "path": "/usr/local/bin/nvencc",
          "target": "/opt/nvencc/current/bin/nvencc"
        },
        {
          "path": "/opt/nvencc/current",
          "target": "releases/qualified-r3"
        }
      ]
    },
    "grav1synth": {
      "resolved_path": "/opt/grav1synth/bin/grav1synth",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "size_bytes": 3456789,
      "reviewed_symlink_chain": [
        {
          "path": "/usr/local/bin/grav1synth",
          "target": "/opt/grav1synth/bin/grav1synth"
        }
      ]
    }
  },
  "cases": [
    {
      "case_id": "private-title-id",
      "source_path": "/media/private/title.mkv",
      "expected_source_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
      "expected_source_size_bytes": 1234567890,
      "provenance_receipt": {
        "path": "/private/denoise-input/private-title-provenance.json",
        "sha256": "2222222222222222222222222222222222222222222222222222222222222222",
        "size_bytes": 1024
      },
      "cq": 16,
      "clips": [
        {
          "clip_id": "dark-texture",
          "timestamp_seconds": 183.250,
          "duration_seconds": 8,
          "review_note": "Dark clothing, wall texture, and a face",
          "review_crop_x": 1280,
          "review_crop_y": 540
        },
        {
          "clip_id": "midtone-face",
          "timestamp_seconds": 1284.500,
          "duration_seconds": 8,
          "review_note": "Skin, hair, fabric, and fine edges"
        },
        {
          "clip_id": "bright-gradient",
          "timestamp_seconds": 2410.750,
          "duration_seconds": 8,
          "review_note": "Sky or smooth highlight gradient plus texture"
        }
      ]
    }
  ]
}
```

Every placeholder path, release name, hash, and size above is a documentation
value only. Never copy it into a real input. Regenerate all tool pins inside
the independently qualified trial runtime after its immutable image and
read-only filesystem boundary are fixed. Existing private schema-3 inputs
without these pins are intentionally unrunnable.

The referenced receipt is private JSON with this exact shape:

```json
{
  "schema": 1,
  "kind": "tdarr-denoise-retention-provenance-v1",
  "case_id": "private-title-id",
  "source_sha256": "1111111111111111111111111111111111111111111111111111111111111111",
  "source_size_bytes": 1234567890,
  "cq": 16,
  "nvenc_quality_profile": "enhanced",
  "retained_original": true,
  "job_decision": "no_feasible_parameters",
  "profile_evidence": "explicit-enhanced",
  "reviewed_evidence_artifacts": [
    {
      "artifact_id": "tdarr-job-report",
      "sha256": "3333333333333333333333333333333333333333333333333333333333333333",
      "size_bytes": 234567
    },
    {
      "artifact_id": "tdarr-jobsjsondb-row",
      "sha256": "4444444444444444444444444444444444444444444444444444444444444444",
      "size_bytes": 3456
    }
  ]
}
```

The provenance receipt is case evidence only. It deliberately does not repeat
runtime executable identities or symbolic-link chains; those deployment-wide
pins belong in `expected_tool_identities` in the trial input.

The input authenticates the complete receipt by its exact lowercase SHA-256
and byte size. The receipt must independently bind the same case ID, full
source digest and size, CQ, and NVENC profile. It must prove
`retained_original=true`, the `no_feasible_parameters` decision, and explicit
enhanced or baseline profile evidence that agrees with the selected profile.
It must also bind two to sixteen distinct reviewed evidence artifacts by
lowercase SHA-256 and exact byte size. An inferred profile, an unverified
fallback assumption, or a receipt that merely repeats the input is not
evidence.

The receipt file is opened without following symlinks, read from one stable
descriptor, and checked against the input hash and size before parsing. Any
unknown receipt field, duplicate artifact, mismatched field, changed path
identity, malformed hash, unsafe size, or receipt larger than 1 MiB fails
before the run directory is created.

The four `tools` values are the actual production entry points, not convenient
substitutes. The expected identity for each entry point binds its final
resolved path, complete SHA-256, exact size, descriptor identity, and every
hop in its symbolic-link publication chain. `reviewed_symlink_chain` is
mandatory for every entrypoint, wrapper interpreter, and wrapper target. It
lists each exact `{path,target}` hop in traversal order; an empty array is an
explicit review finding that the requested path has no symbolic-link hops.
FFmpeg and ffprobe are production
shell wrappers because their exact `LD_LIBRARY_PATH` selects the promoted
libvmaf/CUDA closure. Their
`wrapper_contract` additionally binds the exact three-line wrapper grammar,
the `/bin/sh` interpreter and its resolved executable bytes, the absolute
`exec` target and its executable bytes, and the literal library-path value.
Changing an unchanged wrapper's effective target therefore fails.

All identities are authenticated before output creation. The owned production
GPU lease and the complete effective executable closure are rechecked before
and after every version probe, command, and both sides of the NVEncC-to-FFmpeg
pipeline. The complete bytes are hashed again before release. A symlink
retarget, wrapper edit, target replacement, same-size mutation, inode change,
or dependency mismatch invalidates the run. The final verify-to-exec boundary
still relies on the immutable qualified trial image and its read-only root;
Node does not provide `fexecve`, so writable tool paths are prohibited.

`private_output_root` must already exist as a dedicated private directory.
Every listed protected root must also exist and be a non-symlink directory.
Declare every media mount, Tdarr database root, Tdarr configuration root,
deployed/plugin-source root, and mounted Git checkout visible in the
container. Also declare every backup tree except the separate dedicated trial
output root. The example uses an empty `git` list only because the harness is
baked into the qualified image and no checkout is mounted; that case requires
the separate `acknowledge_no_git_checkout_mounted=true` declaration. If a
checkout is mounted, list its root under `git` and omit that acknowledgement.

The harness resolves every root, source, source parent, and output parent
before creating output. It rejects missing roots, symlinks or canonical-path
aliases, an output root that overlaps a source parent or any protected root, a
source outside all declared media roots, and an output parent beneath a
detected normal or bare Git repository. Ambiguous inspection errors fail
closed. `acknowledge_protected_roots_complete` is an operator assertion that
the category lists are exhaustive; it is not permission to omit a root.

Keep provenance receipts and their source evidence under a declared protected
backup root or a separate read-only private-input mount. They are inputs, not
trial output. A receipt outside every declared `protected_roots.backups` root
is rejected. Declare a separate read-only private-input mount in that group.
Do not make the evidence tree writable merely to satisfy the output policy,
and do not reuse that tree as `private_output_root`.

Timestamps are never discovered or substituted by the harness. Supply exact
timestamps selected from the title. Choose clips that collectively exercise
dark, shadow, midtone, and highlight content; a dark-only set is not adequate.
The harness verifies the resulting pixel population spans at least three
fixed gray8 analysis bands, including midtones and either shadows or
highlights. Optional `review_crop_x` and `review_crop_y` select the top-left
corner of the 640×360 detail crop. Omit them for a centered crop. Use the
coordinates to put faces, fabric, edges, or gradients inside the evidence
rather than relying on an arbitrary corner.

To add 0.14 after reviewing 0.12, add all three fields:

```json
{
  "include_strength_014": true,
  "acknowledge_s012_was_reviewed": true,
  "strength_014_justification": "The 0.12 samples passed review but missed the size target."
}
```

## Qualified trial runtime image

[`runtime/denoise-trial/Dockerfile`](../runtime/denoise-trial/Dockerfile)
builds a batch-only image from the exact qualified r3 base. It bakes in the
harness and reviewed tool closure, disables the health check, publishes
`production-promotion-authorized=false`, and contains no Tdarr server state.
The Dockerfile requires the repository as its ordinary build context plus four
named contexts:

| Context | Required form |
| --- | --- |
| `ffmpeg` | Reviewed Linux artifact image containing the complete custom FFmpeg prefix with its symbolic links preserved. |
| `libvmaf` | Reviewed local context containing the real `libvmaf.so.3.0.0` file. The image creates the `.so.3` and `.so` links itself. |
| `nvencc` | Reviewed local NVEncC artifact context, including its strict checksum manifest. |
| `grav1synth` | Reviewed local grav1synth artifact context, including its strict checksum manifest. |

A generic BuildKit invocation is:

```powershell
docker buildx build --load `
  --file runtime/denoise-trial/Dockerfile `
  --build-arg "BASE_IMAGE=<exact-qualified-r3-base-reference>" `
  --build-arg "NVENCC_RELEASE_ID=<reviewed-release-id>" `
  --build-context "ffmpeg=docker-image://<reviewed-linux-ffmpeg-artifact-reference>" `
  --build-context "libvmaf=<reviewed-libvmaf-context>" `
  --build-context "nvencc=<reviewed-nvencc-context>" `
  --build-context "grav1synth=<reviewed-grav1synth-context>" `
  --tag <qualified-trial-image> `
  .
```

On Windows, do not pass a custom FFmpeg tree containing `.so` reparse points
as a local named context. The validated local-context attempt failed while
BuildKit traversed those reparse points. Do not “fix” that by flattening or
dereferencing the library links. Create or import the reviewed FFmpeg context
as a Linux artifact image from a Linux tar stream that preserves the symbolic
links, inspect its contents, then use the `docker-image://` context above.

When the artifact image has a real registry RepoDigest, reference
`docker-image://name@sha256:<digest>`. A locally imported image can have only
an image ID and no RepoDigest. In that case use a dedicated local tag only
after independently verifying that the tag maps to the reviewed image ID
immediately before the build; verify the same mapping afterward and retain
that evidence. A mutable tag by itself is not identity evidence.

The image installs immutable mode-`0555` wrappers at
`/usr/local/bin/tdarr-ffmpeg` and `/usr/local/bin/tdarr-ffprobe`. Each wrapper
exports the exact library path shown in the schema-3
`wrapper_contract`, then `exec`s the corresponding binary under
`/usr/local/ffmpeg-custom/bin`. The runtime input must authenticate the wrapper,
`/bin/sh` resolution, executable target, and literal `LD_LIBRARY_PATH`; a
successful image build does not replace those runtime checks.

The image default is exactly `USER abc`. The validated runtime identity is
UID `1000` (`abc`), primary GID `1000` (`abc`), with supplementary GID `100`
(`users`). Do not override `--user` for the trial: a numeric override can
discard the reviewed supplementary-group identity. The default entrypoint is
the baked Node harness, so do not mount a second harness over it.

### Empty protected roots and output ownership

The schema-3 `tdarr_plugins` group deliberately declares all six of these
protected destinations:

```text
/app/server/Tdarr/Plugins
/custom-cont-init.d
/usr/local/build-scripts
/opt/grav1synth-artifact
/opt/grain-pipeline-artifact
/opt/nvencc-artifact
```

They are containment sentinels, not permission to expose live Tdarr state.
The image supplies immutable mountpoints for the latter five. The qualified
run overmounted each with a separate pre-seeded empty read-only bind. A
separate pre-seeded scratch tree containing only empty `Tdarr/DB2` and
`Tdarr/Plugins` directory structures was mounted read-only at `/app/server`;
another empty read-only scratch bind supplied `/app/configs`. Do not mount the
live server database, configuration, or plugin catalog merely to make a
declared root exist. Every additional root declared by the private input must
likewise exist through an intentionally isolated read-only mount.

A newly created named volume is normally root-owned and is not immediately
writable by `abc`. Before the trial, prepare the fresh private output volume in
a separate one-shot container that has no live mounts, then verify its root is
owned by `1000:1000` with mode `0700`:

```powershell
docker volume create <new-private-output-volume>
docker run --rm --network none --user 0:0 --entrypoint /bin/sh `
  --mount "type=volume,src=<new-private-output-volume>,dst=/prepare-output" `
  <qualified-trial-image> `
  -c 'chown 1000:1000 /prepare-output && chmod 0700 /prepare-output && test "$(stat -c %u:%g:%a /prepare-output)" = "1000:1000:700"'
```

Use a new volume for each evidence run. The preparation container must never
mount media, Tdarr state, the production lock root, or private evidence.

## Safe invocation after the node drains

Do not run the trial alongside Tdarr GPU work. First pause the node, let every
existing worker finish naturally, and verify that the node has zero active
workers. Pausing is not the same as cancelling. An idle Tdarr API response is
not sufficient: a detached coordinator or encoder can outlive its worker
record.

Before it authenticates tools or sources, creates the output directory, or
starts any media process, the harness fails closed when either of these is
true:

- any filesystem entry exists at the exact production GPU lock path (default
  `/temp/tdarr-vmaf-gpu-pipeline.lock`, or
  `TDARR_GPU_PIPELINE_LOCK_DIR`/`production_gpu_lock_path` when production uses
  a different exact path);
- `/proc/*/cmdline` contains a pre-existing Tdarr media worker, NVEncC,
  FFmpeg, VMAF, grav1synth, grain-pipeline, NVENC, CUDA-video, or CUVID
  process.

The process scan also fails if a non-racing process cannot be inspected. It
does not treat the persistent Tdarr node service alone as active media work.
The input lock path must exactly equal `TDARR_GPU_PIPELINE_LOCK_DIR`, or the
production default when that environment variable is absent; an input cannot
redirect the guard to a harmless alternate path.

After the absent-lock scan, the harness performs one atomic `mkdir` at that
exact production lock path. An existing path of any type is a busy result:
the harness never invokes stale-break logic, never waits by deleting a lock,
and never removes an existing owner's bytes. Its owner and heartbeat records
use the production token/generation protocol, identify the harness PID and
process start time, and set `automaticStaleBreakDisabled=true`. A heartbeat
runs every five seconds. The real production lock helper treats this lease as
held and cannot automatically revoke it even if the harness supervisor dies.

Once acquired, each boundary check requires that exact same directory inode,
owner token, lease generation, PID/start time, heartbeat file descriptor, and
fresh heartbeat. Initial and in-run scans exclude the harness PID and its
descendants so supervised children are not false positives. The owned
lock/process gate runs before and after every case and denoise setting, and
the owned lease plus effective tool closure are checked before and after every
spawn. Passing one boundary is not cached.

Every spawned FFmpeg, ffprobe, NVEncC, and grav1synth process is registered
with the harness. `SIGINT` and `SIGTERM` stop all registered children,
escalate non-exiting children to `SIGKILL` after the bounded grace period, and
wait for every child before the harness can finish. In the NVEncC-to-FFmpeg
pipeline, an FFmpeg consumer that exits first always terminates its producer,
even when FFmpeg reports exit code zero. A producer that completes
successfully first is allowed to let FFmpeg drain the remaining pipe data.

Before release, the harness permanently closes the spawn gate, waits for the
registered-child set to reach zero, re-hashes every tool closure and every
authenticated source, and performs a distinct final `/proc` scan that excludes
only the harness PID—not its descendants. A surviving child, grandchild,
uninspectable process, stale/replaced heartbeat, changed owner, tool/source
identity mismatch, or other cleanup uncertainty retains the non-stealable lock
for manual recovery. A confirmed release renames the lock atomically, re-reads
the retired owner and heartbeat, verifies token, generation, PID/start time and
directory identity again, and removes only the two managed files. Release
evidence contains token/generation hashes, never raw ownership tokens.

Never remove or steal the production lock merely to make the trial start.
Investigate the lock owner and any surviving coordinator/encoder, let the
process exit safely, then repeat the preflight. A failed startup safety check
leaves no trial output directory.

The harness makes no Tdarr API calls and cannot verify the UI worker count for
you, so both the input acknowledgement and the command-line acknowledgement
remain required in addition to the independent lock/process checks.

Do not copy the tool into, or execute it inside, the live Tdarr container. Do
not use `--volumes-from tdarr:ro`: that makes the live `/temp` mount read-only
and prevents atomic acquisition of the exact production lock. Do not make all
inherited Tdarr mounts writable to work around that failure.

Use a deliberately isolated, disposable container from the qualified trial
image with this mount policy:

- `--pid=container:tdarr`, so `/proc` sees the same Tdarr process namespace;
- `--network=none` and a read-only container root;
- the exact host bind used by live `/temp` mounted at `/temp` read-write, only
  so the shared production lease can be acquired;
- one fresh, pre-owned private output volume mounted read-write;
- every media and private input/receipt tree mounted read-only;
- isolated empty read-only scratch mounts for every declared database,
  configuration, plugin, build, and artifact protected root;
- the immutable executable and library closure already baked into the
  read-only image root; and
- no other read-write mount.

The following is a mount-shape template, not a ready-to-run command. Replace
every placeholder only from the reviewed release and private input. The trial
image must publish the same wrapper/symlink entry points and qualified resolved
paths named by the input:

```powershell
docker run --rm --name tdarr-denoise-retention-trial `
  --pid "container:tdarr" `
  --network none `
  --gpus all `
  --read-only `
  --env TDARR_GPU_PIPELINE_LOCK_DIR=/temp/tdarr-vmaf-gpu-pipeline.lock `
  --env TMPDIR=/denoise-trial-output `
  --mount "type=bind,src=<exact-live-temp-host-bind>,dst=/temp" `
  --mount "type=volume,src=<new-private-output-volume>,dst=/denoise-trial-output" `
  --mount "type=bind,src=<private-input-root>,dst=/private/denoise-input,readonly" `
  --mount "type=bind,src=<media-root>,dst=/media,readonly" `
  --mount "type=bind,src=<empty-app-server-scratch>,dst=/app/server,readonly" `
  --mount "type=bind,src=<empty-config-scratch>,dst=/app/configs,readonly" `
  --mount "type=bind,src=<empty-custom-init-scratch>,dst=/custom-cont-init.d,readonly" `
  --mount "type=bind,src=<empty-build-scripts-scratch>,dst=/usr/local/build-scripts,readonly" `
  --mount "type=bind,src=<empty-grav1synth-artifact-scratch>,dst=/opt/grav1synth-artifact,readonly" `
  --mount "type=bind,src=<empty-grain-pipeline-artifact-scratch>,dst=/opt/grain-pipeline-artifact,readonly" `
  --mount "type=bind,src=<empty-nvencc-artifact-scratch>,dst=/opt/nvencc-artifact,readonly" `
  <qualified-trial-image> `
  --input /private/denoise-input/private-input.json `
  --output /denoise-trial-output/run-<unique-id> `
  --node-drained
```

The `/app/server` scratch source must contain only empty `Tdarr/DB2` and
`Tdarr/Plugins` directories. Each of the other scratch placeholders is a
distinct pre-seeded empty directory. Add every other root declared by the
private input as an isolated read-only mount. Do not run if the immutable
wrapper/symlink closure in the trial image differs from its reviewed input
identity.

The `--output` path must not exist and must be a strict child contained by the
declared `private_output_root`; the root itself cannot be the run directory.
The dedicated private root must be outside every source parent, media mount,
Tdarr database/configuration/plugin tree, Git root, and protected backup root.
Do not use
`/var/lib/tdarr-vmaf-score`, `/app/configs`, `/app/server`, a media mount, the
repository, or any subdirectory of them. An ordinary failed run leaves
`failure.json` and bounded artifacts for diagnosis after confirmed child
cleanup and lease release; it does not delete or replace a source. A safety
failure can intentionally retain the exact production lock instead. In that
case, inspect the recorded owner and all GPU/media processes and recover it
manually—never force-delete it merely to resume work.

## Evidence and decision rule

`results.json` records per setting and, where a valid trial output exists, per
clip:

- the production-shaped proxy evidence, ranked fit candidates, every bounded
  fit attempt and its disposition, and the SHA-256/size of the one atomically
  published table when available;
- final AV1 video packet bytes and container bytes;
- a source-interval video-packet estimate for context;
- default-model CPU libvmaf VMAF and CAMBI when the installed build exposes
  them;
- per-metric clip coverage, with partial or asymmetric VMAF/CAMBI availability
  rejected rather than averaging different clip subsets;
- gray8 luma MAE, PSNR, and changed-pixel fraction separately for dark,
  shadow, midtone, and highlight source pixels;
- expected and observed decoded frame counts and gray8 luma byte counts, with
  exactly zero unpaired bytes;
- a 1:1-pixel contact sheet with three frames from the lossless source on the
  top row and the same three frames from the grav1synth-applied trial result on
  the bottom row.

The VMAF/CAMBI pass is capped at 1920 pixels wide and is deliberately labelled
as a trial metric contract. It is useful for relative screening but is not
production VMAF authority. If libvmaf or CAMBI is unavailable, the result says
so and retains multi-band luma evidence; it never fabricates a score.

A setting unavailable before valid trial output—whether because no ranked
candidate yields one direct global table, fitting fails operationally, or the
output is malformed—is different from an unavailable VMAF or CAMBI metric. It
has no valid comparison output and always yields
`setting_unavailable_no_denoise_conclusion`; every objective gate is false and
production promotion remains forbidden. If the 0.08 control is unavailable,
all stronger settings are skipped before GPU work and their comparisons are
withheld. The reason field preserves semantic unrepresentability,
runtime/tool/timeout failure, and malformed grain-table output as distinct
classes.

A stronger setting is only a candidate for manual review when it:

- has the exact expected decoded frame count and gray8 luma byte count for
  every source/trial pair, with zero unpaired bytes;
- has the identical full source SHA-256 and descriptor identity before and
  after the case;
- saves at least 3% of final video packet bytes versus the 0.08 control at the
  same CQ and encoder profile;
- saves at least 3% versus the aggregated original-source interval packet
  estimate (a directional sample check, not a full-title size prediction);
- loses no more than 0.5 mean trial VMAF, when VMAF is available;
- increases mean CAMBI by no more than 0.25, when CAMBI is available;
- increases no luminance-band MAE by more than 10%;
- covers the required multiple luminance bands.

The band comparison is fail-closed at a zero control MAE. A candidate must
also have zero MAE in that band; any positive candidate MAE is recorded as a
zero-control regression and fails the objective screen rather than being
ignored or serialized as an infinite percentage.

For each metric, "available" means complete paired evidence for every supplied
clip in both the 0.08 control and the candidate. A metric unavailable for every
clip on both sides is reported as unavailable and leaves the decision dependent
on the remaining evidence and manual review. In that fully paired-unavailable
case the remaining objective gates may pass, but `metricEvidenceComplete`
remains `false`, the outcome still requires manual visual review, and production
promotion remains forbidden. Any partial, asymmetric, or mismatched clip
coverage fails the objective screen.

Those gates do not mean that the setting “looks good.” Open `review.html` and
inspect the contact sheets at 100% scale. Check faces, hair, fabric, natural
texture, dark detail, edges, and gradients. Reject waxiness, smearing, halos,
crushed texture, new banding, and grain that pumps, swims, or no longer matches
the scene. A result only “looks good and shrinks” after both the byte target and
that manual review pass.

Even then, `productionPromotionAuthorized` remains `false`. A separately
reviewed production canary, using the new explicit contracts throughout the
Flow, is required before any production setting can change.

## Contract test

Run the non-media contract test on the host:

```powershell
node test-denoise-retention-trial.js
```

It verifies the hard strength allowlist, the 0.08 production identity, distinct
trial identities, 0.14 escalation guard, exact NVENC/grav1synth command shape,
the production 24-position proxy ranking and spacing, exact 144-frame fit
candidates, the three-candidate cap, strict malformed/payload-free segment
rejection, first-valid atomic byte publication, explicit unrepresentable-setting
semantics, runtime/malformed failure reason separation, unavailable-control GPU
short-circuiting with explicit skipped records, and one byte-stable
variant-level global table reused across every reviewed clip,
the four-minute `grav1synth diff` cap, twelve-minute per-setting wall budget,
the production INT64_MAX grain boundary and rejection of the obsolete 32-bit
boundary, schema-2 rejection, authenticated receipt bytes, exact receipt/case
field binding, explicit profile evidence, distinct evidence-artifact
identities, expected full source digest/size matching before output creation,
complete pre/post source identity binding, exact decoded-frame/luma
accounting (including an exit-zero truncation), multi-band evidence,
zero-control MAE regression handling, explicit fully-unavailable metric
semantics, fail-closed partial VMAF/CAMBI coverage, strict parser/schema
additional-property and primitive-type parity, protected-root containment and
ambiguous/control-character path failures, both pipeline exit orders
(including a producer that handles termination and exits zero), signal cleanup
of every mocked child,
fixed-root atomic lock acquisition without stale breaking, compatibility with
the deployed production lock helper, non-stealable dead-owner behavior,
wrong-token and post-rename owner-race release refusal, heartbeat-failure spawn
shutdown, normal descendant-excluding boundary scans, the final
PID-only-excluding child-extinction scan, full executable hashing, same-byte
inode and in-place target replacement detection, every-hop recursive symlink
identity, reviewed-chain matching for every pinned entrypoint and wrapper
dependency, strict wrapper grammar/effective-target binding, both pipeline
executables authenticated before either spawn, and the permanent
manual-review/no-promotion outcome. It does not run a media trial or contact
Tdarr.
