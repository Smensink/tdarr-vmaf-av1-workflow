#!/bin/bash
# Regression for grav1synth's av1_nvenc Sequence Header rewrite.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
GRAV1SYNTH="${1:-${TDARR_GRAV1SYNTH:-/usr/local/bin/grav1synth}}"
FFMPEG="${2:-${TDARR_FFMPEG:-/usr/local/bin/tdarr-ffmpeg}}"
FIXTURE_B64="${GRAV1SYNTH_NVENC_FIXTURE:-$SCRIPT_DIR/fixtures/grav1synth-nvenc-hdr.ivf.b64}"
EXPECTED_INPUT_SHA256="04e451508a968b62559e0b07f8829f931411749355dc27a882b18c56b35fb04a"

fail() {
    echo "[grav1synth NVENC regression] ERROR: $*" >&2
    exit 1
}

[[ -x "$GRAV1SYNTH" ]] || fail "grav1synth is not executable: $GRAV1SYNTH"
[[ -x "$FFMPEG" ]] || fail "FFmpeg is not executable: $FFMPEG"
[[ -r "$FIXTURE_B64" ]] || fail "fixture is not readable: $FIXTURE_B64"
for tool in base64 grep sha256sum mktemp; do
    command -v "$tool" >/dev/null 2>&1 || fail "required tool is missing: $tool"
done

SCRATCH_BASE="${TMPDIR:-/tmp}"
[[ "$SCRATCH_BASE" == /* && -d "$SCRATCH_BASE" ]] || \
    fail "scratch base must be an existing absolute directory: $SCRATCH_BASE"
SCRATCH_ROOT="$(mktemp -d "$SCRATCH_BASE/grav1synth-nvenc-regression.XXXXXX")" || \
    fail "could not create scratch directory"
cleanup() {
    if [[ -n "$SCRATCH_ROOT" && "$SCRATCH_ROOT" == "$SCRATCH_BASE"/grav1synth-nvenc-regression.* ]]; then
        rm -rf -- "$SCRATCH_ROOT"
    else
        echo "[grav1synth NVENC regression] refusing unsafe cleanup: $SCRATCH_ROOT" >&2
    fi
}
trap cleanup EXIT

INPUT="$SCRATCH_ROOT/input.ivf"
OUTPUT="$SCRATCH_ROOT/grained.mkv"
TABLE="$SCRATCH_ROOT/inspected.tbl"

base64 --decode "$FIXTURE_B64" >"$INPUT" || fail "could not decode fixture"
ACTUAL_INPUT_SHA256="$(sha256sum "$INPUT" | awk '{print $1}')"
[[ "$ACTUAL_INPUT_SHA256" == "$EXPECTED_INPUT_SHA256" ]] || \
    fail "fixture checksum mismatch: $ACTUAL_INPUT_SHA256"

"$GRAV1SYNTH" apply --overwrite --iso 400 --output "$OUTPUT" "$INPUT" >/dev/null 2>&1 || \
    fail "grain application failed"
[[ -s "$OUTPUT" ]] || fail "grain application produced no output"

"$GRAV1SYNTH" inspect --overwrite --output "$TABLE" "$OUTPUT" >/dev/null 2>&1 || \
    fail "rewritten output cannot be inspected"
grep -Fxq 'filmgrn1' "$TABLE" || fail "inspect output lacks a film-grain table header"
grep -Eq '^E[[:space:]]+[0-9]+[[:space:]]+[0-9]+[[:space:]]+1[[:space:]]+' "$TABLE" || \
    fail "inspect output has no enabled grain segment"

"$FFMPEG" -hide_banner -loglevel error -nostdin -i "$OUTPUT" \
    -map 0:v:0 -f null - >/dev/null 2>&1 || \
    fail "rewritten output does not fully decode"

if [[ "${GRAV1SYNTH_REGRESSION_QUIET:-0}" != "1" ]]; then
    echo "[grav1synth NVENC regression] OK: apply, inspect, semantic grain, and full decode"
fi
