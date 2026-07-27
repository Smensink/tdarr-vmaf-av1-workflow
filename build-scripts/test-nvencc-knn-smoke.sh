#!/bin/bash
# Exercise NVEncC's CUDA KNN filter with short 8-bit and 10-bit raw clips.

set -euo pipefail

NVENCC="${TDARR_NVENCC:-/usr/local/bin/nvencc}"
FFMPEG="${TDARR_FFMPEG:-/usr/local/bin/tdarr-ffmpeg}"
RUNTIME_USER="${TDARR_RUNTIME_USER:-abc}"
SMOKE_BASE="${NVENCC_SMOKE_BASE:-/tmp}"
WIDTH=128
HEIGHT=72
FRAMES=4
FPS=24
EXPECTED_8BIT_BYTES=$((WIDTH * HEIGHT * 3 / 2 * FRAMES))
EXPECTED_10BIT_BYTES=$((EXPECTED_8BIT_BYTES * 2))
KNN_SETTINGS="radius=3,d=0,strength=0.08,lerp=0.20,th_lerp=0.80"

fail() {
    echo "[NVEncC KNN smoke] ERROR: $*" >&2
    exit 1
}

[[ "$SMOKE_BASE" == /* && -d "$SMOKE_BASE" && ! -L "$SMOKE_BASE" ]] || \
    fail "scratch base must be an absolute real directory: $SMOKE_BASE"
[[ -x "$NVENCC" ]] || fail "NVEncC is not executable: $NVENCC"
[[ -x "$FFMPEG" ]] || fail "FFmpeg is not executable: $FFMPEG"
command -v runuser >/dev/null 2>&1 || fail "runuser is not available"
id "$RUNTIME_USER" >/dev/null 2>&1 || fail "runtime user does not exist: $RUNTIME_USER"

SMOKE_ROOT="$(mktemp -d "$SMOKE_BASE/tdarr-nvencc-knn-smoke.XXXXXX")" || \
    fail "could not create smoke-test directory"
cleanup() {
    if [[ -n "${SMOKE_ROOT:-}" &&
          "$SMOKE_ROOT" == "$SMOKE_BASE"/tdarr-nvencc-knn-smoke.* ]]; then
        rm -rf -- "$SMOKE_ROOT"
    else
        echo "[NVEncC KNN smoke] refusing unsafe cleanup: ${SMOKE_ROOT:-<unset>}" >&2
    fi
}
trap cleanup EXIT
chown "$RUNTIME_USER":"$(id -gn "$RUNTIME_USER")" "$SMOKE_ROOT"
chmod 0700 "$SMOKE_ROOT"

run_case() {
    local label="$1"
    local pixel_format="$2"
    local input_csp="$3"
    local output_depth="$4"
    local expected_bytes="$5"
    local input_path="$SMOKE_ROOT/input-${label}.yuv"
    local output_path="$SMOKE_ROOT/output-${label}.yuv"
    local log_path="$SMOKE_ROOT/nvencc-${label}.log"

    runuser -u "$RUNTIME_USER" -- "$FFMPEG" \
        -hide_banner -loglevel error \
        -f lavfi -i "testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}" \
        -frames:v "$FRAMES" -pix_fmt "$pixel_format" -f rawvideo \
        -y "$input_path" || fail "$label FFmpeg fixture generation failed"

    runuser -u "$RUNTIME_USER" -- "$NVENCC" \
        --raw --input-res "${WIDTH}x${HEIGHT}" --fps "${FPS}/1" \
        --input-csp "$input_csp" --frames "$FRAMES" \
        --codec raw --output-csp yuv420 --output-depth "$output_depth" \
        --vpp-knn "$KNN_SETTINGS" \
        -i "$input_path" -o "$output_path" >"$log_path" 2>&1 || {
            tail -80 "$log_path" >&2 || true
            fail "$label NVEncC KNN pass failed"
        }

    [[ -f "$output_path" && ! -L "$output_path" ]] || \
        fail "$label output is missing or unsafe"
    local actual_bytes
    actual_bytes="$(stat -c '%s' "$output_path")"
    [[ "$actual_bytes" == "$expected_bytes" ]] || \
        fail "$label output size mismatch: expected $expected_bytes, got $actual_bytes"
    grep -Fq "denoise(knn):" "$log_path" || \
        fail "$label log does not prove that the KNN filter ran"
    grep -Fq "encoded ${FRAMES} frames" "$log_path" || \
        fail "$label log does not prove that every frame completed"
}

run_case "8bit" "yuv420p" "yuv420p" "8" "$EXPECTED_8BIT_BYTES"
run_case "10bit" "p010le" "p010" "10" "$EXPECTED_10BIT_BYTES"

echo "[NVEncC KNN smoke] OK: 8-bit and 10-bit CUDA KNN paths completed as $RUNTIME_USER"
