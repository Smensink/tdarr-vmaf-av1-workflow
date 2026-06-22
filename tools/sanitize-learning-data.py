#!/usr/bin/env python3
"""Create aggregate-only seed priors from Tdarr VMAF learning data.

This tool is allowlist-based. It never emits raw rows, file paths, titles,
release groups, exact timestamps, or API identifiers.
"""
from __future__ import annotations

import argparse, csv, json, math, datetime
from pathlib import Path
from collections import defaultdict


def safe_float(v):
    try:
        if v is None or v == "": return None
        x = float(str(v).strip())
        if math.isnan(x) or math.isinf(x): return None
        return x
    except Exception:
        return None


def resolution_tier(w, h):
    w = safe_float(w) or 0
    h = safe_float(h) or 0
    m = max(w, h)
    if m >= 3840: return "4k"
    if m >= 2560: return "1440p"
    if m >= 1920: return "1080p"
    if m >= 1280: return "720p"
    return "sd"


def codec_bucket(codec):
    s = str(codec or "").lower()
    if "hevc" in s or "h265" in s or "h.265" in s: return "hevc"
    if "h264" in s or "h.264" in s or "avc" in s: return "h264"
    if "av1" in s: return "av1"
    if "mpeg" in s: return "mpeg"
    return "other"


def source_bucket(s):
    s = str(s or "").lower()
    if "bluray" in s or "blu-ray" in s or "remux" in s: return "bluray/remux"
    if "web" in s: return "web"
    if "hdtv" in s: return "hdtv"
    if "dvd" in s: return "dvd"
    return "unknown"


def bool_bucket(v):
    return str(v or "").strip().lower() in {"true", "1", "yes", "y", "animation", "animated"}


def quantile(vals, p):
    vals = sorted(v for v in vals if v is not None)
    if not vals: return None
    if len(vals) == 1: return vals[0]
    pos = (len(vals) - 1) * p
    lo, hi = math.floor(pos), math.ceil(pos)
    if lo == hi: return vals[lo]
    return vals[lo] * (hi - pos) + vals[hi] * (pos - lo)


def rnd(v, nd=2):
    return None if v is None else round(float(v), nd)


def build_priors(learning_csv: Path, min_samples: int):
    buckets = defaultdict(lambda: defaultdict(list))
    with learning_csv.open("r", encoding="utf-8", errors="replace", newline="") as f:
        for r in csv.DictReader(f):
            key = (
                resolution_tier(r.get("source_width"), r.get("source_height")),
                codec_bucket(r.get("source_codec")),
                source_bucket(r.get("media_source_type")),
                "animation" if bool_bucket(r.get("media_is_animation")) else "live",
            )
            cols = {
                "selected_cq": "selected_cq",
                "selected_vmaf": "selected_vmaf",
                "selected_ssim": "selected_ssim",
                "selected_cambi": "selected_cambi",
                "selected_projected_output_bpp": "output_bpp",
                "selected_projected_output_ratio_pct": "output_ratio_pct",
                "bits_per_pixel": "source_bpp",
                "adaptive_frame_floor_used": "adaptive_frame_floor",
            }
            for src, dst in cols.items():
                val = safe_float(r.get(src))
                if val is not None:
                    buckets[key][dst].append(val)
    out = []
    for (tier, codec, source, content_class), b in sorted(buckets.items()):
        n = len(b["selected_cq"])
        if n < min_samples: continue
        out.append({
            "resolution_tier": tier,
            "source_codec": codec,
            "source_type": source,
            "content_class": content_class,
            "samples": n,
            "selected_cq_p25": rnd(quantile(b["selected_cq"], .25), 1),
            "selected_cq_p50": rnd(quantile(b["selected_cq"], .50), 1),
            "selected_cq_p75": rnd(quantile(b["selected_cq"], .75), 1),
            "selected_vmaf_p50": rnd(quantile(b["selected_vmaf"], .50), 2),
            "selected_ssim_p50": rnd(quantile(b["selected_ssim"], .50), 5),
            "selected_cambi_p50": rnd(quantile(b["selected_cambi"], .50), 3),
            "output_bpp_p50": rnd(quantile(b["output_bpp"], .50), 5),
            "output_ratio_pct_p50": rnd(quantile(b["output_ratio_pct"], .50), 2),
            "source_bpp_p50": rnd(quantile(b["source_bpp"], .50), 5),
            "adaptive_frame_floor_p50": rnd(quantile(b["adaptive_frame_floor"], .50), 1),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--learning-csv", type=Path, required=True)
    ap.add_argument("--ema-json", type=Path)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--min-samples", type=int, default=3)
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    seed = {
        "schema": "tdarr-vmaf-av1-seed-priors/v1",
        "privacy": "Aggregate-only warm-start priors. No file paths, filenames, titles, release groups, exact timestamps, API identifiers, or raw rows are included.",
        "generated_at_utc": datetime.datetime.now(datetime.UTC).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        "minimum_bucket_samples": args.min_samples,
        "buckets": build_priors(args.learning_csv, args.min_samples),
    }
    (args.out_dir / "vmaf_cq_priors.seed.json").write_text(json.dumps(seed, indent=2), encoding="utf-8")
    if args.ema_json and args.ema_json.exists():
        raw = json.loads(args.ema_json.read_text(encoding="utf-8"))
        ema = {"schema": "tdarr-vmaf-av1-ema-seed/v1", "privacy": "Rounded CQ EMA by resolution tier only; no timestamp retained.", "ema": {}, "sampleCounts": {}}
        for k, v in raw.get("ema", {}).items(): ema["ema"][k] = rnd(v, 2)
        for k, v in raw.get("sampleCounts", {}).items(): ema["sampleCounts"][k] = int(v)
        (args.out_dir / "ema_cq_state.seed.json").write_text(json.dumps(ema, indent=2), encoding="utf-8")
    print(f"wrote sanitized aggregate seed data to {args.out_dir}")

if __name__ == "__main__":
    main()
