#!/usr/bin/env python3
"""Backfill VMAF training DB size/outcome columns from Tdarr job reports.

Dry-run by default:
  docker exec tdarr python3 /custom-cont-init.d/vmaf-plugin-patches/_lib/backfill_size_outcomes_from_job_reports.py

Apply safe NULL-only updates:
  docker exec tdarr sh -lc 'APPLY=1 python3 /custom-cont-init.d/vmaf-plugin-patches/_lib/backfill_size_outcomes_from_job_reports.py'

Env:
  DB_PATH=/app/configs/vmaf_training.db
  JOB_REPORTS_ROOT=/app/server/Tdarr/DB2/JobReports
  OVERWRITE=1   replace existing values; default only fills NULL/unknown status
  ALL_REPORTS=1 parse reports without VMAF size/outcome markers too (slow/noisy)
  LIMIT=100     process first N reports for debugging
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import os
import re
import sqlite3
from pathlib import Path
from typing import Any

DB_PATH = os.environ.get("DB_PATH", "/app/configs/vmaf_training.db")
REPORT_ROOT = Path(os.environ.get("JOB_REPORTS_ROOT", "/app/server/Tdarr/DB2/JobReports"))
APPLY = os.environ.get("APPLY") == "1"
OVERWRITE = os.environ.get("OVERWRITE") == "1"
ALL_REPORTS = os.environ.get("ALL_REPORTS") == "1"
LIMIT = int(os.environ.get("LIMIT") or "0")
MAX_NEAREST_SECONDS = 24 * 60 * 60
MIN_SECOND_BEST_GAP_SECONDS = 30 * 60

MARKERS = (
    b"Projected output guard:",
    b'"vmafLearningData":{"source_bitrate_mbps"',
    b"Transcode completed successfully:",
    b"Transcode was cancelled due to file size exceeding threshold",
    b'"vmafJobStartTime"',
)

NUM = rb"([-+]?[0-9]+(?:\.[0-9]+)?)"
RE_FIRST_TS = re.compile(rb"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)", re.M)
RE_JOB_START = re.compile(rb'"vmafJobStartTime":"([^"\\]+)"')
RE_LOGGED_JOB_ID = re.compile(rb'"vmafJobId":"([^"\\]+)"')
RE_VMAF_ORIGINAL = re.compile(rb'"vmafOriginalFile":"([^"\\]+)"')
RE_MEDIA_ID = re.compile(rb'"_id":"(/media/[^"\\]+)"')
RE_SOURCE_FILE = re.compile(rb'"sourceFile":\{.*?"file":"([^"\\]+)"', re.S)
RE_FILE_SIZE = re.compile(rb'"file_size":' + NUM)
RE_STAT_SIZE = re.compile(rb'"statSync":\{[^}]*"size":' + NUM, re.S)
RE_PROJECTED = re.compile(rb"Projected output guard:\s*" + NUM + rb"% source", re.I)
RE_MIN_SIZE = re.compile(rb"(?:Minimum size reduction target|Target size reduction):\s*" + NUM + rb"%", re.I)
RE_OLD_SIZE = re.compile(rb"Old size:\s*" + NUM, re.I)
RE_NEW_SIZE = re.compile(rb"New size:\s*" + NUM, re.I)
RE_RATIO = re.compile(rb"Ratio:\s*" + NUM + rb"%", re.I)
RE_LEARN_SOURCE_MB = re.compile(rb'"source_file_size_mb":' + NUM)
RE_LEARN_PROJECTED_RATIO = re.compile(rb'"selected_projected_output_ratio_pct":' + NUM)
RE_LEARN_PROJECTED_REDUCTION = re.compile(rb'"projected_size_reduction_pct":' + NUM)
RE_LEARN_STATUS = re.compile(rb'"size_target_status":"([^"\\]+)"')

JOB_COLS = [
    "job_id", "timestamp", "file_path", "file_name", "source_file_size_mb",
    "projected_output_ratio_pct", "projected_size_reduction_pct", "final_output_size_mb",
    "final_output_ratio_pct", "actual_size_reduction_pct", "size_target_status",
    "skip_reason", "met_size_target", "transcode_succeeded", "met_vmaf_target",
]


def b2s(value: bytes | None) -> str | None:
    if value is None:
        return None
    return value.decode("utf-8", "replace")


def fnum(value: bytes | str | None) -> float | None:
    if value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def round6(value: float | None) -> float | None:
    return None if value is None or not math.isfinite(value) else round(value, 6)


def iso_ms(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def make_job_id(file_path: str, start_timestamp: str) -> str:
    digest = hashlib.sha1((file_path or "").encode()).hexdigest()[:8]
    return f"{start_timestamp}-{digest}"


def first_match(regex: re.Pattern[bytes], data: bytes, group: int = 1) -> bytes | None:
    m = regex.search(data)
    return m.group(group) if m else None


def first_num(regex: re.Pattern[bytes], data: bytes) -> float | None:
    return fnum(first_match(regex, data))


def tdarr_size_to_mb(raw: float | None, known_source_mb: float | None) -> float | None:
    if raw is None or raw <= 0:
        return None
    as_gib = raw * 1024
    as_mb = raw
    if known_source_mb and known_source_mb > 0:
        return as_gib if abs(as_gib - known_source_mb) <= abs(as_mb - known_source_mb) else as_mb
    return as_gib


def parse_report(path: Path) -> dict[str, Any]:
    ev: dict[str, Any] = {"report_path": str(path), "cancelled_for_size": False, "transcode_succeeded": False}
    try:
        data = path.read_bytes()
    except OSError:
        return ev
    if not ALL_REPORTS and not any(marker in data for marker in MARKERS):
        return ev

    ev["first_timestamp"] = b2s(first_match(RE_FIRST_TS, data))
    ev["job_start_time"] = b2s(first_match(RE_JOB_START, data))
    ev["logged_vmaf_job_id"] = b2s(first_match(RE_LOGGED_JOB_ID, data))

    file_path = b2s(first_match(RE_VMAF_ORIGINAL, data)) or b2s(first_match(RE_SOURCE_FILE, data)) or b2s(first_match(RE_MEDIA_ID, data))
    if file_path:
        ev["file_path"] = file_path

    source_mb = first_num(RE_LEARN_SOURCE_MB, data) or first_num(RE_FILE_SIZE, data)
    if source_mb is None:
        stat_bytes = first_num(RE_STAT_SIZE, data)
        if stat_bytes:
            source_mb = stat_bytes / 1024 / 1024
    if source_mb:
        ev["source_file_size_mb"] = source_mb

    projected = first_num(RE_LEARN_PROJECTED_RATIO, data) or first_num(RE_PROJECTED, data)
    if projected is not None:
        ev["projected_output_ratio_pct"] = projected
        ev["projected_size_reduction_pct"] = 100 - projected

    projected_reduction = first_num(RE_LEARN_PROJECTED_REDUCTION, data)
    if projected_reduction is not None:
        ev["projected_size_reduction_pct"] = projected_reduction

    min_size = first_num(RE_MIN_SIZE, data)
    if min_size is not None:
        ev["min_size_reduction_pct"] = min_size

    ev["old_size_raw"] = first_num(RE_OLD_SIZE, data)
    ev["new_size_raw"] = first_num(RE_NEW_SIZE, data)
    ev["last_live_size_ratio_pct"] = first_num(RE_RATIO, data)

    # 2026-07-05..07 units bug: the post-transcode size check compared output BYTES against
    # Tdarr's MB-valued file_size, logging absurd ratios (e.g. 38,838,638%) and rerouting every
    # SUCCESSFUL transcode into the size-failure path. In reports carrying that signature, the
    # derived markers ("Final output is larger than source" and monitorTranscodeRetry's
    # "Transcode was cancelled due to file size exceeding threshold") are untrustworthy.
    absurd_final_ratio = any(
        (fnum(m.group(1)) or 0) > 10000
        for m in re.finditer(rb"Final output ratio after VMAF transcode: " + NUM + rb"%", data)
    )

    if b"Ratio is greater than threshold: 100%, cancelling job" in data or (
        not absurd_final_ratio and b"Transcode was cancelled due to file size exceeding threshold" in data
    ):
        ev["cancelled_for_size"] = True
        ev["skip_reason"] = "live_size_guard_exceeded"
    if b"Keeping original file" in data or b"GIVING UP:" in data:
        ev["gave_up"] = True
        if b"GIVING UP: Cannot achieve target VMAF" in data and not ev.get("skip_reason"):
            ev["skip_reason"] = "target_vmaf_unreachable"
    # "Transcode completed successfully:" is logged BEFORE the post-transcode size check, so a
    # completed-then-rejected attempt (output larger than source -> rerouted to retry -> give-up
    # -> remux) still contains it. Delivery means the LAST success marker comes AFTER the last
    # failure/give-up marker in the report.
    giveup_pats = [
        b"Ratio is greater than threshold",
        b"Keeping original file",
        b"GIVING UP:",
    ]
    if not absurd_final_ratio:
        giveup_pats.append(b"Transcode was cancelled due to file size exceeding threshold")
        giveup_pats.append(b"Final output is larger than source")
    last_success = max((m.start() for m in re.finditer(re.escape(b"Transcode completed successfully:"), data)), default=-1)
    last_giveup = max(
        (m.start() for pat in giveup_pats for m in re.finditer(re.escape(pat), data)),
        default=-1,
    )
    if last_success >= 0 and last_success > last_giveup:
        ev["transcode_succeeded"] = True

    status = b2s(first_match(RE_LEARN_STATUS, data))
    if status and status != "unknown":
        ev["explicit_size_target_status"] = status

    old_mb = tdarr_size_to_mb(ev.get("old_size_raw"), ev.get("source_file_size_mb"))
    new_mb = tdarr_size_to_mb(ev.get("new_size_raw"), old_mb or ev.get("source_file_size_mb"))
    if old_mb and new_mb:
        ev["old_size_mb"] = old_mb
        ev["new_size_mb"] = new_mb
        ev["final_output_ratio_pct"] = (new_mb / old_mb) * 100
        ev["actual_size_reduction_pct"] = 100 - ev["final_output_ratio_pct"]

    return ev


def fields_from_evidence(ev: dict[str, Any]) -> dict[str, Any]:
    fields: dict[str, Any] = {}
    for src, dst in [
        ("source_file_size_mb", "source_file_size_mb"),
        ("projected_output_ratio_pct", "projected_output_ratio_pct"),
        ("projected_size_reduction_pct", "projected_size_reduction_pct"),
    ]:
        val = ev.get(src)
        if isinstance(val, (int, float)) and math.isfinite(val):
            fields[dst] = round6(float(val))

    if ev.get("transcode_succeeded") and not ev.get("cancelled_for_size") and ev.get("new_size_mb") and ev.get("final_output_ratio_pct") is not None:
        fields["final_output_size_mb"] = round6(float(ev["new_size_mb"]))
        fields["final_output_ratio_pct"] = round6(float(ev["final_output_ratio_pct"]))
        fields["actual_size_reduction_pct"] = round6(float(ev["actual_size_reduction_pct"]))

    # No delivered VMAF transcode (cancelled or gave up, with no later success evidence):
    # the row written at selection time claims transcode_succeeded=1/met_vmaf_target=1 from
    # the PICK, not the outcome — correct it (remux-only pollution, SweepLog 2026-07-07).
    if (ev.get("cancelled_for_size") or ev.get("gave_up")) and not ev.get("transcode_succeeded"):
        fields["transcode_succeeded"] = 0
        fields["met_vmaf_target"] = 0
        if ev.get("skip_reason") and not ev.get("cancelled_for_size"):
            fields["skip_reason"] = ev["skip_reason"]

    if ev.get("cancelled_for_size"):
        fields["size_target_status"] = "failed"
        fields["skip_reason"] = ev.get("skip_reason") or "live_size_guard_exceeded"
        fields["met_size_target"] = 0
    elif "final_output_ratio_pct" in fields and isinstance(ev.get("min_size_reduction_pct"), (int, float)):
        met = fields["final_output_ratio_pct"] <= (100 - float(ev["min_size_reduction_pct"]))
        fields["size_target_status"] = "met" if met else "failed"
        fields["met_size_target"] = 1 if met else 0
    elif ev.get("explicit_size_target_status"):
        fields["size_target_status"] = ev["explicit_size_target_status"]
    return fields


def load_jobs(conn: sqlite3.Connection) -> tuple[dict[str, sqlite3.Row], dict[str, list[sqlite3.Row]]]:
    conn.row_factory = sqlite3.Row
    by_job: dict[str, sqlite3.Row] = {}
    by_path: dict[str, list[sqlite3.Row]] = {}
    for row in conn.execute("SELECT " + ",".join(JOB_COLS) + " FROM jobs"):
        by_job[row["job_id"]] = row
        fp = row["file_path"]
        if fp:
            by_path.setdefault(fp, []).append(row)
    return by_job, by_path


def choose_job(ev: dict[str, Any], by_job: dict[str, sqlite3.Row], by_path: dict[str, list[sqlite3.Row]], stats: dict[str, Any]) -> tuple[sqlite3.Row, str] | None:
    file_path = ev.get("file_path")
    start = ev.get("job_start_time")
    if file_path and start:
        computed = make_job_id(file_path, start)
        row = by_job.get(computed)
        if row:
            return row, "job_id"
        stats["exact_misses"] += 1
    logged = ev.get("logged_vmaf_job_id")
    if logged and logged in by_job:
        return by_job[logged], "logged_job_id"
    if not file_path:
        return None
    candidates = by_path.get(file_path, [])
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0], "path_single"
    target = iso_ms(start) or iso_ms(ev.get("first_timestamp"))
    if target is None:
        return None
    ranked: list[tuple[float, sqlite3.Row]] = []
    for row in candidates:
        ts = iso_ms(row["timestamp"])
        if ts is not None:
            ranked.append((abs(ts - target), row))
    ranked.sort(key=lambda item: item[0])
    if not ranked or ranked[0][0] > MAX_NEAREST_SECONDS:
        return None
    if len(ranked) > 1 and ranked[1][0] - ranked[0][0] < MIN_SECOND_BEST_GAP_SECONDS:
        stats["ambiguous_matches"] += 1
        return None
    return ranked[0][1], "path_nearest"


def present(value: Any) -> bool:
    return value is not None and value != ""


def should_write(row: sqlite3.Row, col: str, val: Any) -> bool:
    if val is None:
        return False
    if isinstance(val, float) and not math.isfinite(val):
        return False
    if OVERWRITE:
        return True
    if col == "size_target_status":
        return not row[col] or row[col] == "unknown"
    # Downgrade-only correction: rows written at selection time claim success before the
    # transcode ran; give-up/cancel evidence may flip 1 -> 0, but never 0 -> 1 (a true
    # success only fills an empty cell via the default rule below).
    if col in ("transcode_succeeded", "met_vmaf_target") and val == 0:
        return row[col] != 0
    return not present(row[col])


def main() -> None:
    report_files = sorted(REPORT_ROOT.glob("**/*.txt"))
    if LIMIT:
        report_files = report_files[:LIMIT]
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    by_job, by_path = load_jobs(conn)

    stats: dict[str, Any] = {
        "mode": "APPLY" if APPLY else "DRY_RUN",
        "overwrite": OVERWRITE,
        "all_reports": ALL_REPORTS,
        "db_path": DB_PATH,
        "report_root": str(REPORT_ROOT),
        "reports_found": len(report_files),
        "reports_with_evidence": 0,
        "matched_reports": 0,
        "unmatched_reports": 0,
        "ambiguous_matches": 0,
        "exact_misses": 0,
        "rows_would_update": 0,
        "rows_updated": 0,
        "field_updates": {},
        "match_methods": {},
        "evidence": {"source_size": 0, "projected": 0, "final_success": 0, "cancelled_for_size": 0},
    }
    examples: list[dict[str, Any]] = []

    for report in report_files:
        ev = parse_report(report)
        fields = fields_from_evidence(ev)
        if not fields:
            continue
        stats["reports_with_evidence"] += 1
        if ev.get("source_file_size_mb") is not None:
            stats["evidence"]["source_size"] += 1
        if ev.get("projected_output_ratio_pct") is not None:
            stats["evidence"]["projected"] += 1
        if "final_output_size_mb" in fields:
            stats["evidence"]["final_success"] += 1
        if ev.get("cancelled_for_size"):
            stats["evidence"]["cancelled_for_size"] += 1

        chosen = choose_job(ev, by_job, by_path, stats)
        if not chosen:
            stats["unmatched_reports"] += 1
            continue
        row, method = chosen
        stats["matched_reports"] += 1
        stats["match_methods"][method] = stats["match_methods"].get(method, 0) + 1

        cols = [col for col, val in fields.items() if should_write(row, col, val)]
        if not cols:
            continue
        stats["rows_would_update"] += 1
        for col in cols:
            stats["field_updates"][col] = stats["field_updates"].get(col, 0) + 1
        if len(examples) < 8:
            examples.append({"job_id": row["job_id"], "file_name": row["file_name"], "fields": cols})
        if APPLY:
            values = [fields[col] for col in cols]
            values.append(dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"))
            values.append(row["job_id"])
            sql = "UPDATE jobs SET " + ", ".join(f"{col} = ?" for col in cols) + ", updated_at = ? WHERE job_id = ?"
            conn.execute(sql, values)
            conn.commit()
            stats["rows_updated"] += 1
            # Keep in-memory row fresh enough to avoid duplicate updates from repeated reports for the same job.
            fresh = conn.execute("SELECT " + ",".join(JOB_COLS) + " FROM jobs WHERE job_id = ?", (row["job_id"],)).fetchone()
            by_job[row["job_id"]] = fresh
            if fresh["file_path"]:
                by_path[fresh["file_path"]] = [fresh if r["job_id"] == fresh["job_id"] else r for r in by_path.get(fresh["file_path"], [])]

    print(json.dumps({"stats": stats, "examples": examples}, indent=2, sort_keys=True))
    conn.close()


if __name__ == "__main__":
    main()
