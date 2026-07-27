#!/usr/bin/env python3
"""Export public, reproducible snapshots from a running Tdarr deployment.

The source SQLite databases are opened read-only. The Tdarr flow export redacts
credential-shaped values. The learning export contains aggregate buckets only:
it never copies source rows, paths, filenames, titles, release groups, job IDs,
or exact event timestamps into the public database.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import sqlite3
import sys
import tempfile
from collections import defaultdict
from contextlib import closing
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = "tdarr-vmaf-public-learning/v2"
SECRET_KEY_RE = re.compile(
    r"(?:token|password|secret|authorization|api[_-]?key)",
    re.IGNORECASE,
)
SECRET_PLACEHOLDERS = {
    "plextoken": "${TDARR_PLEX_TOKEN}",
    "tmdbapikey": "${TDARR_TMDB_API_KEY}",
    "tvdbapikey": "${TDARR_TVDB_API_KEY}",
    "arr_api_key": "${TDARR_ARR_API_KEY}",
}


def utc_now() -> str:
    return (
        dt.datetime.now(dt.UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def open_read_only(path: Path) -> sqlite3.Connection:
    resolved = path.resolve(strict=True)
    uri = f"{resolved.as_uri()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=30)
    connection.execute("PRAGMA query_only = ON")
    connection.execute("PRAGMA busy_timeout = 30000")
    return connection


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        newline="\n",
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    os.replace(temp_path, path)


def placeholder_for(key: str) -> str:
    normalized = key.replace("-", "_").lower()
    compact = normalized.replace("_", "")
    if normalized == "arr_api_key":
        return SECRET_PLACEHOLDERS["arr_api_key"]
    return SECRET_PLACEHOLDERS.get(compact, "${REDACTED_SECRET}")


def redact_secrets(value: Any) -> Any:
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    if not isinstance(value, dict):
        return value

    redacted: dict[str, Any] = {}
    for key, item in value.items():
        if SECRET_KEY_RE.search(key):
            redacted[key] = placeholder_for(key)
        else:
            redacted[key] = redact_secrets(item)
    return redacted


def assert_flow_redacted(value: Any) -> None:
    def walk(item: Any) -> Iterable[tuple[str, Any]]:
        if isinstance(item, dict):
            for key, child in item.items():
                yield key, child
                yield from walk(child)
        elif isinstance(item, list):
            for child in item:
                yield from walk(child)

    leaks = []
    for key, item in walk(value):
        if not SECRET_KEY_RE.search(key):
            continue
        if not isinstance(item, str) or not item.startswith("${"):
            leaks.append(key)
    if leaks:
        names = ", ".join(sorted(set(leaks)))
        raise SystemExit(f"refusing to publish unredacted flow fields: {names}")


def export_flow_object(flow: dict[str, Any], flow_id: str, output: Path) -> None:
    if flow.get("_id") != flow_id:
        raise SystemExit(
            f"flow identity mismatch: expected {flow_id}, got {flow.get('_id')}"
        )
    flow = redact_secrets(flow)
    assert_flow_redacted(flow)
    atomic_write_text(output, f"{json.dumps(flow, indent=2)}\n")
    print(
        "exported redacted flow "
        f"{flow_id}: {len(flow.get('flowPlugins', []))} nodes, "
        f"{len(flow.get('flowEdges', []))} edges -> {output}"
    )


def export_flow(database: Path, flow_id: str, output: Path) -> None:
    with closing(open_read_only(database)) as connection:
        row = connection.execute(
            "SELECT json_data FROM flowsjsondb WHERE id = ?",
            (flow_id,),
        ).fetchone()
    if row is None:
        raise SystemExit(f"flow not found in Tdarr database: {flow_id}")
    export_flow_object(json.loads(row[0]), flow_id, output)


def export_flow_from_stdin(flow_id: str, output: Path) -> None:
    try:
        flow = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        raise SystemExit(f"stdin did not contain one valid flow JSON object: {error}")
    export_flow_object(flow, flow_id, output)


def safe_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def quantile(values: list[float], fraction: float) -> float | None:
    ordered = sorted(value for value in values if math.isfinite(value))
    if not ordered:
        return None
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * fraction
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return (
        ordered[lower] * (upper - position)
        + ordered[upper] * (position - lower)
    )


def rounded(value: float | None, digits: int = 3) -> float | None:
    return None if value is None else round(value, digits)


def resolution_tier(width: Any, height: Any) -> str:
    maximum = max(safe_float(width) or 0, safe_float(height) or 0)
    if maximum >= 3840:
        return "4k"
    if maximum >= 2560:
        return "1440p"
    if maximum >= 1920:
        return "1080p"
    if maximum >= 1280:
        return "720p"
    return "sd"


def codec_bucket(value: Any) -> str:
    codec = str(value or "").lower()
    if any(marker in codec for marker in ("hevc", "h265", "h.265")):
        return "hevc"
    if any(marker in codec for marker in ("h264", "h.264", "avc")):
        return "h264"
    if "av1" in codec:
        return "av1"
    if "mpeg" in codec:
        return "mpeg"
    return "other"


def source_bucket(value: Any) -> str:
    source = str(value or "").lower()
    if any(marker in source for marker in ("bluray", "blu-ray", "remux")):
        return "bluray-remux"
    if "web" in source:
        return "web"
    if "hdtv" in source:
        return "hdtv"
    if "dvd" in source:
        return "dvd"
    return "unknown"


def content_bucket(value: Any) -> str:
    return "animation" if str(value).lower() in {"1", "true", "yes"} else "live"


def collect_job_buckets(
    connection: sqlite3.Connection,
) -> tuple[dict[tuple[str, ...], dict[str, list[float]]], int]:
    columns = (
        "source_width, source_height, source_codec, media_source_type, "
        "media_is_animation, bits_per_pixel, selected_cq, selected_vmaf, "
        "selected_vmaf_min, selected_cambi, source_cambi, "
        "final_output_ratio_pct, target_min_vmaf, transcode_succeeded"
    )
    rows = connection.execute(f"SELECT {columns} FROM jobs")
    buckets: dict[tuple[str, ...], dict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    accepted = 0
    for row in rows:
        (
            width,
            height,
            codec,
            source_type,
            is_animation,
            source_bpp,
            selected_cq,
            selected_vmaf,
            selected_vmaf_min,
            selected_cambi,
            source_cambi,
            output_ratio,
            target_vmaf,
            succeeded,
        ) = row
        cq = safe_float(selected_cq)
        vmaf = safe_float(selected_vmaf)
        if succeeded != 1 or cq is None:
            continue
        if vmaf is not None and not 0 <= vmaf <= 100:
            continue
        key = (
            resolution_tier(width, height),
            codec_bucket(codec),
            source_bucket(source_type),
            content_bucket(is_animation),
        )
        metrics = {
            "selected_cq": cq,
            "selected_vmaf": vmaf,
            "selected_vmaf_min": safe_float(selected_vmaf_min),
            "selected_cambi": safe_float(selected_cambi),
            "source_cambi": safe_float(source_cambi),
            "source_bpp": safe_float(source_bpp),
            "output_ratio_pct": safe_float(output_ratio),
            "target_vmaf": safe_float(target_vmaf),
        }
        for name, metric in metrics.items():
            if metric is not None:
                buckets[key][name].append(metric)
        accepted += 1
    return buckets, accepted


def collect_sweep_buckets(
    connection: sqlite3.Connection,
) -> tuple[dict[tuple[str, ...], dict[str, list[float]]], int]:
    rows = connection.execute(
        """
        SELECT
            j.source_width,
            j.source_height,
            j.source_codec,
            j.media_source_type,
            j.media_is_animation,
            s.cq,
            s.vmaf_mean,
            s.vmaf_min,
            s.vmaf_max,
            s.vmaf_p1_low,
            s.ssim,
            s.cambi_mean
        FROM sweep_points AS s
        JOIN jobs AS j ON j.job_id = s.job_id
        WHERE s.cq IS NOT NULL
        """
    )
    buckets: dict[tuple[str, ...], dict[str, list[float]]] = defaultdict(
        lambda: defaultdict(list)
    )
    accepted = 0
    for row in rows:
        (
            width,
            height,
            codec,
            source_type,
            is_animation,
            cq_raw,
            vmaf_mean_raw,
            vmaf_min_raw,
            vmaf_max_raw,
            vmaf_p1_raw,
            ssim_raw,
            cambi_raw,
        ) = row
        cq = safe_float(cq_raw)
        vmaf_mean = safe_float(vmaf_mean_raw)
        vmaf_min = safe_float(vmaf_min_raw)
        vmaf_max = safe_float(vmaf_max_raw)
        if cq is None or vmaf_mean is None:
            continue
        if not 0 <= vmaf_mean <= 100:
            continue
        if (
            vmaf_min is not None
            and vmaf_max is not None
            and not (0 <= vmaf_min <= vmaf_mean <= vmaf_max <= 100)
        ):
            continue
        cq_half_step = round(cq * 2) / 2
        key = (
            resolution_tier(width, height),
            codec_bucket(codec),
            source_bucket(source_type),
            content_bucket(is_animation),
            f"{cq_half_step:.1f}",
        )
        metrics = {
            "vmaf_mean": vmaf_mean,
            "vmaf_min": vmaf_min,
            "vmaf_max": vmaf_max,
            "vmaf_p1_low": safe_float(vmaf_p1_raw),
            "ssim": safe_float(ssim_raw),
            "cambi_mean": safe_float(cambi_raw),
        }
        for name, metric in metrics.items():
            if metric is not None:
                buckets[key][name].append(metric)
        accepted += 1
    return buckets, accepted


def create_public_database(
    source: Path,
    output: Path,
    minimum_bucket_samples: int,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_output = output.with_name(f".{output.name}.{os.getpid()}.tmp")
    temp_output.unlink(missing_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix="tdarr-vmaf-public-") as temp_dir:
            snapshot_path = Path(temp_dir) / "source-snapshot.db"
            with closing(open_read_only(source)) as source_connection:
                if source_connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise SystemExit("source learning database failed PRAGMA quick_check")
                with closing(sqlite3.connect(snapshot_path)) as snapshot_connection:
                    source_connection.backup(
                        snapshot_connection,
                        pages=256,
                        sleep=0.05,
                    )

            with closing(sqlite3.connect(snapshot_path)) as snapshot:
                source_job_count = snapshot.execute(
                    "SELECT COUNT(*) FROM jobs"
                ).fetchone()[0]
                source_sweep_count = snapshot.execute(
                    "SELECT COUNT(*) FROM sweep_points"
                ).fetchone()[0]
                job_buckets, accepted_jobs = collect_job_buckets(snapshot)
                sweep_buckets, accepted_sweeps = collect_sweep_buckets(snapshot)

            with closing(sqlite3.connect(temp_output)) as public:
                public.executescript(
                    """
                PRAGMA journal_mode = DELETE;
                CREATE TABLE snapshot_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE cq_priors (
                    resolution_tier TEXT NOT NULL,
                    source_codec TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    content_class TEXT NOT NULL,
                    samples INTEGER NOT NULL,
                    selected_cq_p25 REAL,
                    selected_cq_p50 REAL,
                    selected_cq_p75 REAL,
                    selected_vmaf_p50 REAL,
                    selected_vmaf_min_p50 REAL,
                    selected_cambi_p50 REAL,
                    source_cambi_p50 REAL,
                    source_bpp_p50 REAL,
                    output_ratio_pct_p50 REAL,
                    target_vmaf_p50 REAL,
                    PRIMARY KEY (
                        resolution_tier,
                        source_codec,
                        source_type,
                        content_class
                    )
                );
                CREATE TABLE sweep_priors (
                    resolution_tier TEXT NOT NULL,
                    source_codec TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    content_class TEXT NOT NULL,
                    cq REAL NOT NULL,
                    samples INTEGER NOT NULL,
                    vmaf_mean_p25 REAL,
                    vmaf_mean_p50 REAL,
                    vmaf_mean_p75 REAL,
                    vmaf_min_p50 REAL,
                    vmaf_max_p50 REAL,
                    vmaf_p1_low_p50 REAL,
                    ssim_p50 REAL,
                    cambi_mean_p50 REAL,
                    PRIMARY KEY (
                        resolution_tier,
                        source_codec,
                        source_type,
                        content_class,
                        cq
                    )
                );
                """
                )
                metadata = {
                    "schema": SCHEMA_VERSION,
                    "generated_at_utc": utc_now(),
                    "privacy": (
                        "Aggregate-only public snapshot. No raw rows, job IDs, "
                        "paths, filenames, titles, release groups, or exact event "
                        "timestamps are present."
                    ),
                    "minimum_bucket_samples": str(minimum_bucket_samples),
                    "source_jobs": str(source_job_count),
                    "source_sweep_points": str(source_sweep_count),
                    "accepted_completed_jobs": str(accepted_jobs),
                    "accepted_valid_sweep_points": str(accepted_sweeps),
                }
                public.executemany(
                    "INSERT INTO snapshot_metadata (key, value) VALUES (?, ?)",
                    sorted(metadata.items()),
                )

                job_rows = []
                for key, metrics in sorted(job_buckets.items()):
                    samples = len(metrics["selected_cq"])
                    if samples < minimum_bucket_samples:
                        continue
                    job_rows.append(
                        (
                            *key,
                            samples,
                            rounded(quantile(metrics["selected_cq"], 0.25), 1),
                            rounded(quantile(metrics["selected_cq"], 0.50), 1),
                            rounded(quantile(metrics["selected_cq"], 0.75), 1),
                            rounded(
                                quantile(metrics["selected_vmaf"], 0.50),
                                2,
                            ),
                            rounded(
                                quantile(metrics["selected_vmaf_min"], 0.50),
                                2,
                            ),
                            rounded(
                                quantile(metrics["selected_cambi"], 0.50),
                                3,
                            ),
                            rounded(
                                quantile(metrics["source_cambi"], 0.50),
                                3,
                            ),
                            rounded(
                                quantile(metrics["source_bpp"], 0.50),
                                5,
                            ),
                            rounded(
                                quantile(metrics["output_ratio_pct"], 0.50),
                                2,
                            ),
                            rounded(quantile(metrics["target_vmaf"], 0.50), 2),
                        )
                    )
                public.executemany(
                    """
                    INSERT INTO cq_priors VALUES (
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                    """,
                    job_rows,
                )

                sweep_rows = []
                for key, metrics in sorted(sweep_buckets.items()):
                    samples = len(metrics["vmaf_mean"])
                    if samples < minimum_bucket_samples:
                        continue
                    sweep_rows.append(
                        (
                            *key[:-1],
                            float(key[-1]),
                            samples,
                            rounded(quantile(metrics["vmaf_mean"], 0.25), 2),
                            rounded(quantile(metrics["vmaf_mean"], 0.50), 2),
                            rounded(quantile(metrics["vmaf_mean"], 0.75), 2),
                            rounded(quantile(metrics["vmaf_min"], 0.50), 2),
                            rounded(quantile(metrics["vmaf_max"], 0.50), 2),
                            rounded(
                                quantile(metrics["vmaf_p1_low"], 0.50),
                                2,
                            ),
                            rounded(quantile(metrics["ssim"], 0.50), 5),
                            rounded(
                                quantile(metrics["cambi_mean"], 0.50),
                                3,
                            ),
                        )
                    )
                public.executemany(
                    """
                    INSERT INTO sweep_priors VALUES (
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                    """,
                    sweep_rows,
                )
                public.commit()
                public.execute("VACUUM")
                if public.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise SystemExit(
                        "generated public database failed integrity check"
                    )

            os.replace(temp_output, output)
    finally:
        temp_output.unlink(missing_ok=True)
    print(
        "exported aggregate public learning database: "
        f"{len(job_rows)} CQ buckets, {len(sweep_rows)} sweep buckets -> {output}"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tdarr-db", type=Path)
    parser.add_argument("--flow-json-stdin", action="store_true")
    parser.add_argument("--flow-id")
    parser.add_argument("--flow-out", type=Path)
    parser.add_argument("--learning-db", type=Path)
    parser.add_argument("--public-learning-out", type=Path)
    parser.add_argument("--minimum-bucket-samples", type=int, default=25)
    args = parser.parse_args()

    flow_requested = args.tdarr_db is not None or args.flow_json_stdin
    if args.tdarr_db is not None and args.flow_json_stdin:
        parser.error("--tdarr-db and --flow-json-stdin are mutually exclusive")
    if flow_requested and (not args.flow_id or not args.flow_out):
        parser.error("flow export also requires --flow-id and --flow-out")
    if not flow_requested and (args.flow_id or args.flow_out):
        parser.error("select --tdarr-db or --flow-json-stdin for flow export")
    learning_values = (args.learning_db, args.public_learning_out)
    if any(learning_values) and not all(learning_values):
        parser.error(
            "--learning-db and --public-learning-out must be used together"
        )
    if not flow_requested and not any(learning_values):
        parser.error("select at least one export")
    if args.minimum_bucket_samples < 25:
        parser.error("--minimum-bucket-samples must be at least 25")
    return args


def main() -> None:
    args = parse_args()
    if args.tdarr_db:
        export_flow(args.tdarr_db, args.flow_id, args.flow_out)
    elif args.flow_json_stdin:
        export_flow_from_stdin(args.flow_id, args.flow_out)
    if args.learning_db:
        create_public_database(
            args.learning_db,
            args.public_learning_out,
            args.minimum_bucket_samples,
        )


if __name__ == "__main__":
    main()
