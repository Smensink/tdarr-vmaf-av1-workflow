#!/usr/bin/env python3
"""Focused fail-closed tests for the aggregate public learning exporter."""

from __future__ import annotations

import importlib.util
import os
import sqlite3
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "export_live_state",
    ROOT / "tools" / "export-live-state.py",
)
assert SPEC and SPEC.loader
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)


def expect_system_exit(callable_obj, message: str) -> None:
    try:
        callable_obj()
    except SystemExit:
        return
    raise AssertionError(message)


with tempfile.TemporaryDirectory(prefix="tdarr-public-export-test-") as temp:
    root = Path(temp)
    database = root / "learning.db"
    connection = sqlite3.connect(database)
    connection.execute(
        """
        CREATE TABLE jobs (
            source_width INTEGER,
            source_height INTEGER,
            source_codec TEXT,
            media_source_type TEXT,
            media_is_animation INTEGER,
            bits_per_pixel REAL,
            selected_cq REAL,
            selected_vmaf REAL,
            selected_vmaf_min REAL,
            selected_cambi REAL,
            source_cambi REAL,
            final_output_ratio_pct REAL,
            target_min_vmaf REAL,
            transcode_succeeded INTEGER,
            outcome_stage TEXT,
            size_policy_version TEXT,
            target_size_reduction_pct REAL,
            minimum_size_reduction_pct REAL,
            max_final_output_ratio_pct REAL
        )
        """
    )
    row = (
        1920,
        1080,
        "h264",
        "web",
        0,
        0.1,
        30,
        96,
        90,
        1.5,
        2,
        75,
        95,
        1,
    )
    connection.executemany(
        "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            row + ("delivered", exporter.DELIVERY_SIZE_POLICY_VERSION, 30, 20, 80),
            row + ("candidate_ready", exporter.DELIVERY_SIZE_POLICY_VERSION, 30, 20, 80),
            row + ("delivered", exporter.DELIVERY_SIZE_POLICY_VERSION, 35, 20, 80),
            row + ("delivered", "legacy-any-shrink", 30, 0, 100),
            row + (None, None, None, None, None),
        ],
    )
    connection.commit()
    buckets, accepted = exporter.collect_job_buckets(connection)
    assert accepted == 1
    assert sum(len(metrics["selected_cq"]) for metrics in buckets.values()) == 1
    connection.close()

    expect_system_exit(
        lambda: exporter.create_public_database(database, database, 25),
        "source/output alias must be rejected",
    )

    hard_link = root / "hard-link.sqlite3"
    os.link(database, hard_link)
    expect_system_exit(
        lambda: exporter.create_public_database(database, hard_link, 25),
        "source/output hard-link alias must be rejected",
    )

    missing = sqlite3.connect(":memory:")
    missing.execute("CREATE TABLE jobs (selected_cq REAL)")
    expect_system_exit(
        lambda: exporter.collect_job_buckets(missing),
        "missing delivery provenance columns must fail closed",
    )
    missing.close()

print("PASS public learning export accepts only delivered v3 policy rows and rejects aliases")
