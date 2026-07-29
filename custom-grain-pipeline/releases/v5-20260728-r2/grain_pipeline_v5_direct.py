#!/usr/bin/env python3
"""Production direct-table AV1 film-grain analysis.

The only grain model emitted by this program is the unmodified output of:

    grav1synth diff LOSSLESS_SOURCE_CLIP KNN_DENOISED_LOSSLESS_CLIP

The source clip is extracted once and then becomes the input to NVEncC, which
guarantees that both sides contain the same frames.  Up to three deterministically
ranked, flat, mid-luminance clips are attempted.  Only a single global
0..INT64_MAX segment is publishable; multi-segment or empty tables cause the next
candidate to be tried.  The program never rewrites, merges, scales, or retimes a
grain table.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterable


PIPELINE_VERSION = 5
MANIFEST_SCHEMA = 5
OUTCOME_SCHEMA = 5
CONTRACT_ID = "grav1synth-direct-global-short-clip-nvencc-knn-v1"
PURPOSE = "direct-default-grav1synth-film-grain-fit"
KNN_SETTINGS = "radius=3,d=0,strength=0.08,lerp=0.2,th_lerp=0.8"
DENOISE_ID = "nvencc-9.25-knn-radius3-d0-strength008-lerp020-thlerp080-v1"
SOURCE_FINGERPRINT_DOMAIN = b"grain-source-sampled-v1\0"
SOURCE_FINGERPRINT_CHUNK_BYTES = 1024 * 1024
GLOBAL_END = 9223372036854775807
DEFAULT_FRAMES = 144
DEFAULT_CANDIDATES = 3
PROXY_WIDTH = 192
PROXY_HEIGHT = 108
PROXY_FRAMES = 3
PROXY_SPACING_SECONDS = 2.0


class PipelineError(RuntimeError):
    pass


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(
        f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.partial"
    )
    temporary.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def full_fingerprint(path: Path) -> dict[str, Any]:
    resolved = path.resolve(strict=True)
    details = resolved.stat()
    if not stat.S_ISREG(details.st_mode) or details.st_size <= 0:
        raise PipelineError(f"not a non-empty regular file: {resolved}")
    return {
        "scheme": "sha256-full-v1",
        "resolved_path": str(resolved),
        "size_bytes": details.st_size,
        "sha256": sha256_file(resolved),
    }


def sampled_source_fingerprint(path: Path) -> dict[str, Any]:
    resolved = path.resolve(strict=True)
    before = resolved.stat()
    if not stat.S_ISREG(before.st_mode) or before.st_size <= 0:
        raise PipelineError(f"source is not a non-empty regular file: {resolved}")
    chunk_size = min(before.st_size, SOURCE_FINGERPRINT_CHUNK_BYTES)
    offsets = sorted(
        {
            0,
            max(0, (before.st_size - chunk_size) // 2),
            max(0, before.st_size - chunk_size),
        }
    )
    digest = hashlib.sha256()
    digest.update(SOURCE_FINGERPRINT_DOMAIN)
    digest.update(str(before.st_size).encode("ascii"))
    with resolved.open("rb") as handle:
        for offset in offsets:
            handle.seek(offset)
            data = handle.read(chunk_size)
            if len(data) != chunk_size:
                raise PipelineError(f"source changed while fingerprinting: {resolved}")
            digest.update(struct.pack(">QQ", offset, len(data)))
            digest.update(data)
    after = resolved.stat()
    if after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns:
        raise PipelineError(f"source changed while fingerprinting: {resolved}")
    return {
        "scheme": "sha256-sampled-v1",
        "sha256": digest.hexdigest(),
        "size_bytes": before.st_size,
        "mtime_ns": before.st_mtime_ns,
        "sample_bytes": chunk_size,
        "sample_offsets": offsets,
        "resolved_path": str(resolved),
    }


def run_checked(
    argv: list[str],
    *,
    timeout: float,
    capture_stdout: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    result = subprocess.run(
        argv,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if result.returncode:
        tail = result.stderr.decode("utf-8", "replace")[-4000:]
        raise PipelineError(
            f"command exited {result.returncode}: {argv[0]}\n{tail}".rstrip()
        )
    return result


def version_line(executable: Path, arguments: list[str]) -> str:
    result = run_checked(
        [str(executable), *arguments], timeout=15, capture_stdout=True
    )
    text = (
        result.stdout.decode("utf-8", "replace")
        + result.stderr.decode("utf-8", "replace")
    )
    return next((line.strip() for line in text.splitlines() if line.strip()), "")


def probe(ffprobe: Path, source: Path) -> dict[str, Any]:
    result = run_checked(
        [
            str(ffprobe),
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            str(source),
        ],
        timeout=120,
        capture_stdout=True,
    )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise PipelineError(f"ffprobe returned invalid JSON: {exc}") from exc
    streams = payload.get("streams")
    if not isinstance(streams, list):
        raise PipelineError("ffprobe returned no stream inventory")
    videos = [
        stream
        for stream in streams
        if stream.get("codec_type") == "video"
        and int((stream.get("disposition") or {}).get("attached_pic") or 0) != 1
    ]
    if len(videos) != 1:
        raise PipelineError(
            f"source requires exactly one ordinary video stream; observed {len(videos)}"
        )
    payload["primary_video"] = videos[0]
    return payload


def fraction(value: Any) -> float:
    text = str(value or "")
    match = re.fullmatch(r"(\d+)(?:/(\d+))?", text)
    if not match:
        return math.nan
    denominator = int(match.group(2) or 1)
    return int(match.group(1)) / denominator if denominator else math.nan


def duration_seconds(payload: dict[str, Any]) -> float:
    candidates = [
        (payload.get("format") or {}).get("duration"),
        payload["primary_video"].get("duration"),
    ]
    for candidate in candidates:
        try:
            value = float(candidate)
        except (TypeError, ValueError):
            continue
        if math.isfinite(value) and value > 0:
            return value
    raise PipelineError("source duration is unavailable")


def frame_rate(stream: dict[str, Any]) -> float:
    for key in ("avg_frame_rate", "r_frame_rate"):
        value = fraction(stream.get(key))
        if math.isfinite(value) and 0 < value <= 240:
            return value
    raise PipelineError("source frame rate is unavailable")


def bit_depth(stream: dict[str, Any]) -> int:
    pixel_format = str(stream.get("pix_fmt") or "").lower()
    if pixel_format in {"yuv420p", "yuvj420p", "nv12"}:
        return 8
    if pixel_format in {"yuv420p10le", "p010le"}:
        return 10
    raise PipelineError(
        "direct KNN analysis supports native 8-bit/10-bit 4:2:0 input; "
        f"observed {pixel_format or 'unknown'}"
    )


def proxy_frames(
    ffmpeg: Path,
    source: Path,
    stream_index: int,
    timestamp: float,
) -> list[bytes]:
    duration = PROXY_SPACING_SECONDS * PROXY_FRAMES
    result = run_checked(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-ss",
            f"{timestamp:.6f}",
            "-t",
            f"{duration:.6f}",
            "-i",
            str(source),
            "-map",
            f"0:{stream_index}",
            "-vf",
            (
                f"fps=1/{PROXY_SPACING_SECONDS:g},"
                f"scale={PROXY_WIDTH}:{PROXY_HEIGHT}:flags=area,format=gray"
            ),
            "-frames:v",
            str(PROXY_FRAMES),
            "-an",
            "-sn",
            "-dn",
            "-f",
            "rawvideo",
            "pipe:1",
        ],
        timeout=60,
        capture_stdout=True,
    )
    frame_bytes = PROXY_WIDTH * PROXY_HEIGHT
    if len(result.stdout) != frame_bytes * PROXY_FRAMES:
        raise PipelineError("proxy render returned an incomplete frame set")
    return [
        result.stdout[index * frame_bytes : (index + 1) * frame_bytes]
        for index in range(PROXY_FRAMES)
    ]


def mean(values: Iterable[float]) -> float:
    materialized = list(values)
    return sum(materialized) / len(materialized) if materialized else math.nan


def frame_luma(frame: bytes) -> float:
    return sum(frame) / len(frame)


def gradient(frame: bytes) -> float:
    width = PROXY_WIDTH
    total = 0
    count = 0
    for y_value in range(PROXY_HEIGHT - 1):
        row = y_value * width
        next_row = row + width
        for x_value in range(width - 1):
            value = frame[row + x_value]
            total += abs(value - frame[row + x_value + 1])
            total += abs(value - frame[next_row + x_value])
            count += 2
    return total / count


def frame_mad(left: bytes, right: bytes) -> float:
    return sum(abs(a - b) for a, b in zip(left, right, strict=True)) / len(left)


def rank_candidates(
    ffmpeg: Path,
    source: Path,
    stream: dict[str, Any],
    duration: float,
    clip_seconds: float,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    margin = min(max(10.0, duration * 0.03), 120.0)
    latest = max(margin, duration - margin - clip_seconds)
    if latest <= margin:
        starts = [max(0.0, (duration - clip_seconds) / 2)]
    else:
        count = 24
        starts = [
            margin + (latest - margin) * index / (count - 1)
            for index in range(count)
        ]
    stream_index = int(stream.get("index") or 0)
    evidence: list[dict[str, Any]] = []
    for timestamp in starts:
        try:
            frames = proxy_frames(ffmpeg, source, stream_index, timestamp)
        except (PipelineError, subprocess.TimeoutExpired) as exc:
            evidence.append(
                {
                    "start_seconds": round(timestamp, 6),
                    "valid": False,
                    "reason": str(exc)[:512],
                }
            )
            continue
        lumas = [frame_luma(frame) for frame in frames]
        gradients = [gradient(frame) for frame in frames]
        temporal = [
            frame_mad(frames[index], frames[index + 1])
            for index in range(len(frames) - 1)
        ]
        luma = mean(lumas)
        flatness = mean(gradients)
        motion = mean(temporal)
        max_motion = max(temporal)
        mid_penalty = abs(luma - 112.0) / 16.0
        cut_like = max_motion >= 28.0
        score = flatness + 0.35 * motion + mid_penalty + (1000.0 if cut_like else 0)
        evidence.append(
            {
                "start_seconds": round(timestamp, 6),
                "valid": not cut_like,
                "mean_luma_8bit": round(luma, 6),
                "mean_gradient": round(flatness, 6),
                "mean_temporal_mad": round(motion, 6),
                "maximum_temporal_mad": round(max_motion, 6),
                "cut_like": cut_like,
                "rank_score": round(score, 6),
            }
        )
    ranked = sorted(
        (item for item in evidence if item.get("valid") is True),
        key=lambda item: (
            float(item["rank_score"]),
            abs(float(item["start_seconds"]) - duration / 2),
            float(item["start_seconds"]),
        ),
    )
    selected: list[dict[str, Any]] = []
    minimum_spacing = max(clip_seconds, duration * 0.08)
    for item in ranked:
        if all(
            abs(float(item["start_seconds"]) - float(existing["start_seconds"]))
            >= minimum_spacing
            for existing in selected
        ):
            selected.append(item)
        if len(selected) >= DEFAULT_CANDIDATES:
            break
    if not selected:
        selected = sorted(
            (item for item in evidence if "rank_score" in item),
            key=lambda item: (float(item["rank_score"]), float(item["start_seconds"])),
        )[:DEFAULT_CANDIDATES]
    return selected, evidence


def color_args(stream: dict[str, Any]) -> list[str]:
    mapping = [
        ("color_range", "-color_range"),
        ("color_space", "-colorspace"),
        ("color_transfer", "-color_trc"),
        ("color_primaries", "-color_primaries"),
        ("chroma_location", "-chroma_sample_location"),
    ]
    arguments: list[str] = []
    for key, option in mapping:
        value = str(stream.get(key) or "")
        if value and value.lower() not in {"unknown", "unspecified", "reserved", "n/a"}:
            arguments.extend([option, value])
    return arguments


def extract_source_clip(
    ffmpeg: Path,
    source: Path,
    stream: dict[str, Any],
    start: float,
    frames: int,
    output: Path,
) -> None:
    depth = bit_depth(stream)
    run_checked(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-ss",
            f"{start:.6f}",
            "-i",
            str(source),
            "-map",
            f"0:{int(stream.get('index') or 0)}",
            "-frames:v",
            str(frames),
            "-an",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-vf",
            "setpts=PTS-STARTPTS",
            "-fps_mode",
            "passthrough",
            "-c:v",
            "ffv1",
            "-level",
            "3",
            "-coder",
            "1",
            "-context",
            "1",
            "-g",
            "1",
            "-slicecrc",
            "1",
            "-pix_fmt",
            "yuv420p10le" if depth == 10 else "yuv420p",
            *color_args(stream),
            "-f",
            "matroska",
            str(output),
        ],
        timeout=300,
    )


def denoise_clip(
    coordinator: Path,
    nvencc: Path,
    ffmpeg: Path,
    source_clip: Path,
    stream: dict[str, Any],
    frames: int,
    output: Path,
    producer_log: Path,
    gpu_lock_run: list[str] | None = None,
) -> None:
    depth = bit_depth(stream)
    consumer = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "nut",
        "-i",
        "pipe:0",
        "-map",
        "0:v:0",
        "-frames:v",
        str(frames),
        "-an",
        "-sn",
        "-dn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-vf",
        "setpts=PTS-STARTPTS",
        "-fps_mode",
        "passthrough",
        "-c:v",
        "ffv1",
        "-level",
        "3",
        "-coder",
        "1",
        "-context",
        "1",
        "-g",
        "1",
        "-slicecrc",
        "1",
        "-pix_fmt",
        "yuv420p10le" if depth == 10 else "yuv420p",
        *color_args(stream),
        "-f",
        "matroska",
        str(output),
    ]
    # This is the only segment of the fit that touches the GPU. When the caller supplies
    # a lock runner, the exclusive GPU lease is scoped to exactly this command instead of
    # the whole pipeline, so candidate ranking, clip extraction, grav1synth diff and
    # hashing no longer hold the GPU against unrelated VMAF and transcode jobs.
    command = [
        str(coordinator),
        "--nvencc",
        str(nvencc),
        "--source",
        str(source_clip),
        "--output-depth",
        str(depth),
        "--frames",
        str(frames),
        "--producer-log",
        str(producer_log),
        "--ffmpeg",
        str(ffmpeg),
        "--",
        *consumer,
    ]
    if gpu_lock_run:
        command = [*gpu_lock_run, "--", *command]
    run_checked(
        command,
        # Under the lock runner this call also covers an unbounded queue wait, which a
        # fixed 600s budget would misreport as a denoise failure. The lock runner caps
        # the wait, and analyzeFilmGrain's own pipeline timeout still bounds the run as
        # a whole, so the wedge case stays covered without punishing a queued job.
        timeout=None if gpu_lock_run else 600,
    )


def table_segments(table: Path) -> list[tuple[int, int]]:
    segments: list[tuple[int, int]] = []
    for raw_line in table.read_text(encoding="utf-8").splitlines():
        if not raw_line.startswith("E "):
            continue
        fields = raw_line.split()
        if len(fields) < 3:
            raise PipelineError("grav1synth table contains a malformed segment header")
        segments.append((int(fields[1]), int(fields[2])))
    return segments


def has_semantic_grain(table: Path) -> bool:
    lines = table.read_text(encoding="utf-8").splitlines()
    if not lines or lines[0].strip() != "filmgrn1":
        return False
    has_segment = any(
        re.fullmatch(r"E\s+\d+\s+\d+\s+.+", line.strip())
        for line in lines
    )
    if not has_segment:
        return False
    for line in lines:
        match = re.fullmatch(r"s(?:Y|Cb|Cr)\s+(\d+)\s+(.*)", line.strip())
        if not match:
            continue
        count = int(match.group(1))
        try:
            values = [float(value) for value in match.group(2).split()]
        except ValueError:
            continue
        if len(values) < count * 2:
            continue
        if any(values[index * 2 + 1] > 0 for index in range(count)):
            return True
    return False


def outcome(
    *,
    reason_code: str,
    source: Path,
    source_fingerprint: dict[str, Any],
    pipeline: Path,
    media_profile: str,
    selection: dict[str, Any],
    output: Path,
) -> None:
    atomic_json(
        output,
        {
            "schema": OUTCOME_SCHEMA,
            "pipeline_version": PIPELINE_VERSION,
            "operation": "fit-direct",
            "purpose": PURPOSE,
            "disposition": "bypass",
            "reason_code": reason_code,
            "production_action": (
                "continue-with-untouched-source-av1-without-film-grain"
            ),
            "source": str(source.resolve()),
            "source_fingerprint": source_fingerprint,
            "pipeline": full_fingerprint(pipeline),
            "media_profile": media_profile,
            "selection": selection,
            "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    )


def fit_direct(args: argparse.Namespace) -> int:
    source = args.source.resolve(strict=True)
    table_output = args.output.resolve()
    manifest_output = args.manifest.resolve()
    outcome_output = args.outcome.resolve()
    pipeline = Path(__file__).resolve(strict=True)
    for executable in (
        args.ffmpeg,
        args.ffprobe,
        args.grav1synth,
        args.nvencc,
        args.coordinator,
    ):
        resolved = executable.resolve(strict=True)
        if not resolved.is_file():
            raise PipelineError(f"tool is not a regular file: {resolved}")
    if table_output.exists() or manifest_output.exists() or outcome_output.exists():
        raise PipelineError("refusing to overwrite an existing output artifact")

    source_fingerprint = sampled_source_fingerprint(source)
    payload = probe(args.ffprobe, source)
    stream = payload["primary_video"]
    duration = duration_seconds(payload)
    fps = frame_rate(stream)
    depth = bit_depth(stream)
    clip_seconds = args.frames / fps
    candidates, proxy_evidence = rank_candidates(
        args.ffmpeg, source, stream, duration, clip_seconds
    )
    selection: dict[str, Any] = {
        "method": "flat-mid-luma-no-cut-proxy-ranking-v1",
        "requested_frames": args.frames,
        "requested_candidate_limit": args.max_candidates,
        "clip_seconds": round(clip_seconds, 6),
        "source_duration_seconds": round(duration, 6),
        "proxy_width": PROXY_WIDTH,
        "proxy_height": PROXY_HEIGHT,
        "proxy_frames": PROXY_FRAMES,
        "ranked_candidates": candidates[: args.max_candidates],
        "proxy_evidence": proxy_evidence,
        "attempts": [],
    }
    if not candidates:
        outcome(
            reason_code="grain_synthesis_insufficient_flat_support",
            source=source,
            source_fingerprint=source_fingerprint,
            pipeline=pipeline,
            media_profile=args.media_profile,
            selection=selection,
            output=outcome_output,
        )
        return 3

    work_root = args.workdir.resolve()
    work_root.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix=".direct-grain-", dir=work_root))
    selected: dict[str, Any] | None = None
    selected_table: Path | None = None
    try:
        for rank, candidate in enumerate(
            candidates[: args.max_candidates], start=1
        ):
            attempt_dir = scratch / f"candidate-{rank}"
            attempt_dir.mkdir()
            source_clip = attempt_dir / "source.mkv"
            denoised_clip = attempt_dir / "denoised.mkv"
            candidate_table = attempt_dir / "grain.txt"
            producer_log = attempt_dir / "nvencc.log"
            attempt: dict[str, Any] = {
                "rank": rank,
                "start_seconds": candidate["start_seconds"],
                "status": "started",
            }
            selection["attempts"].append(attempt)
            try:
                extract_source_clip(
                    args.ffmpeg,
                    source,
                    stream,
                    float(candidate["start_seconds"]),
                    args.frames,
                    source_clip,
                )
                denoise_clip(
                    args.coordinator,
                    args.nvencc,
                    args.ffmpeg,
                    source_clip,
                    stream,
                    args.frames,
                    denoised_clip,
                    producer_log,
                    gpu_lock_run=args.gpu_lock_run,
                )
                run_checked(
                    [
                        str(args.grav1synth),
                        "diff",
                        str(source_clip),
                        str(denoised_clip),
                        "-o",
                        str(candidate_table),
                        "-y",
                    ],
                    timeout=600,
                )
                segments = table_segments(candidate_table)
                attempt.update(
                    {
                        "segments": [
                            {"start": start, "end": end} for start, end in segments
                        ],
                        "semantic_grain": has_semantic_grain(candidate_table),
                        "source_clip_sha256": sha256_file(source_clip),
                        "denoised_clip_sha256": sha256_file(denoised_clip),
                    }
                )
                if segments != [(0, GLOBAL_END)]:
                    attempt["status"] = "rejected_non_global_table"
                    shutil.rmtree(attempt_dir, ignore_errors=True)
                    continue
                if not attempt["semantic_grain"]:
                    attempt["status"] = "rejected_empty_grain"
                    shutil.rmtree(attempt_dir, ignore_errors=True)
                    continue
                attempt["status"] = "selected"
                selected = attempt
                selected_table = candidate_table
                break
            except (PipelineError, subprocess.TimeoutExpired) as exc:
                attempt["status"] = "failed"
                attempt["reason"] = str(exc)[:1024]
                shutil.rmtree(attempt_dir, ignore_errors=True)

        if selected is None or selected_table is None:
            outcome(
                reason_code="grain_synthesis_static_model_unrepresentable",
                source=source,
                source_fingerprint=source_fingerprint,
                pipeline=pipeline,
                media_profile=args.media_profile,
                selection=selection,
                output=outcome_output,
            )
            return 3

        table_output.parent.mkdir(parents=True, exist_ok=True)
        temporary_table = table_output.with_name(
            f".{table_output.name}.{os.getpid()}.partial"
        )
        shutil.copyfile(selected_table, temporary_table)
        os.replace(temporary_table, table_output)
        output_fingerprint = full_fingerprint(table_output)
        manifest = {
            "schema": MANIFEST_SCHEMA,
            "pipeline_version": PIPELINE_VERSION,
            "operation": "fit-direct",
            "purpose": PURPOSE,
            "grain_model_contract_id": CONTRACT_ID,
            "source": str(source),
            "source_fingerprint": source_fingerprint,
            "source_video": {
                "stream_index": int(stream.get("index") or 0),
                "width": int(stream.get("width") or 0),
                "height": int(stream.get("height") or 0),
                "pix_fmt": str(stream.get("pix_fmt") or ""),
                "bit_depth": depth,
                "frame_rate": str(
                    stream.get("avg_frame_rate")
                    or stream.get("r_frame_rate")
                    or ""
                ),
            },
            "media_profile": {"transfer_family": args.media_profile},
            "comparison": {
                "mode": "grav1synth-diff-original-vs-nvencc-knn",
                "source_role": "lossless-original-source-clip",
                "denoised_role": "same-lossless-clip-after-spatial-gpu-knn",
                "encoded_output_used_for_fit": False,
                "direct_unmodified_table": True,
                "global_segment_required": True,
            },
            "denoise": {
                "id": DENOISE_ID,
                "implementation": "NVEncC 9.25 vpp-knn",
                "settings": KNN_SETTINGS,
                "temporal_filtering": False,
                "output_depth": depth,
                "transport": "raw-yuv420-nut-stdout",
            },
            "selection": selection,
            "selected_clip": selected,
            "output": {
                "path": str(table_output),
                "sha256": output_fingerprint["sha256"],
                "bytes": output_fingerprint["size_bytes"],
                "segment_count": 1,
                "segment_start": 0,
                "segment_end": GLOBAL_END,
            },
            "pipeline": {
                "version": PIPELINE_VERSION,
                "script": str(pipeline),
                "sha256": sha256_file(pipeline),
            },
            "toolchain": {
                "ffmpeg": {
                    **full_fingerprint(args.ffmpeg),
                    "version": version_line(args.ffmpeg, ["-hide_banner", "-version"]),
                },
                "ffprobe": {
                    **full_fingerprint(args.ffprobe),
                    "version": version_line(args.ffprobe, ["-hide_banner", "-version"]),
                },
                "grav1synth": {
                    **full_fingerprint(args.grav1synth),
                    "version": version_line(args.grav1synth, ["--version"]),
                },
                "nvencc": {
                    **full_fingerprint(args.nvencc),
                    "version": version_line(args.nvencc, ["--version"]),
                },
                "coordinator": full_fingerprint(args.coordinator),
            },
            "scratch": {"retained": False, "path": None},
            "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        atomic_json(manifest_output, manifest)
        return 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--operation", choices=("fit-direct",), required=True)
    result.add_argument("--source", type=Path, required=True)
    result.add_argument("--workdir", type=Path, required=True)
    result.add_argument("--output", type=Path, required=True)
    result.add_argument("--manifest", type=Path, required=True)
    result.add_argument("--outcome", type=Path, required=True)
    result.add_argument("--ffmpeg", type=Path, required=True)
    result.add_argument("--ffprobe", type=Path, required=True)
    result.add_argument("--grav1synth", type=Path, required=True)
    result.add_argument("--nvencc", type=Path, required=True)
    result.add_argument("--coordinator", type=Path, required=True)
    # Optional so the pipeline stays runnable standalone (research replays, canaries)
    # without a lock runner; omitting it simply leaves the denoise unserialized.
    result.add_argument(
        "--gpu-lock-run",
        nargs="+",
        default=None,
        metavar="ARG",
        help="command prefix that holds the shared GPU lock for the denoise segment",
    )
    result.add_argument("--media-profile", choices=("sdr", "pq"), required=True)
    result.add_argument("--frames", type=int, default=DEFAULT_FRAMES)
    result.add_argument("--max-candidates", type=int, default=DEFAULT_CANDIDATES)
    return result


def main() -> int:
    args = parser().parse_args()
    if not 100 <= args.frames <= 200:
        raise PipelineError("direct grain clip must contain 100-200 frames")
    if not 1 <= args.max_candidates <= 3:
        raise PipelineError("direct grain candidate limit must be 1-3")
    return fit_direct(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.TimeoutExpired as exc:
        print(f"pipeline command timed out: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
    except PipelineError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from exc
