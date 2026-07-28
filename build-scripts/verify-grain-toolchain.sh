#!/bin/bash
# Lightweight deployment preflight for the grain-synthesis pipeline.

set -euo pipefail

GRAV1SYNTH="${TDARR_GRAV1SYNTH:-/usr/local/bin/grav1synth}"
GRAV1SYNTH_ARTIFACT_ROOT="${GRAV1SYNTH_ARTIFACT_ROOT:-/opt/grav1synth-artifact}"
GRAV1SYNTH_ARTIFACT_BIN="$GRAV1SYNTH_ARTIFACT_ROOT/bin/grav1synth"
GRAV1SYNTH_ARTIFACT_PROVENANCE="$GRAV1SYNTH_ARTIFACT_ROOT/PROVENANCE.txt"
GRAV1SYNTH_ARTIFACT_SUMS="$GRAV1SYNTH_ARTIFACT_ROOT/SHA256SUMS"
GRAV1SYNTH_NVENC_REGRESSION="${GRAV1SYNTH_NVENC_REGRESSION:-/usr/local/build-scripts/test-grav1synth-nvenc-sequence-header.sh}"
NVENCC="${TDARR_NVENCC:-/usr/local/bin/nvencc}"
NVENCC_COORDINATOR="${TDARR_NVENCC_COORDINATOR:-/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js}"
NVENCC_ARTIFACT_ROOT="${NVENCC_ARTIFACT_ROOT:-/opt/nvencc-artifact}"
NVENCC_ARTIFACT_BIN="$NVENCC_ARTIFACT_ROOT/bin/nvencc"
NVENCC_ARTIFACT_COORDINATOR="$NVENCC_ARTIFACT_ROOT/libexec/tdarr-nvencc-knn-ffmpeg.js"
NVENCC_ARTIFACT_PROVENANCE="$NVENCC_ARTIFACT_ROOT/PROVENANCE.txt"
NVENCC_ARTIFACT_SUMS="$NVENCC_ARTIFACT_ROOT/SHA256SUMS"
NVENCC_KNN_SMOKE="${NVENCC_KNN_SMOKE:-/usr/local/build-scripts/test-nvencc-knn-smoke.sh}"
GPU_PIPELINE_LOCK_DIR="${TDARR_GPU_PIPELINE_LOCK_DIR:-/temp/tdarr-vmaf-gpu-pipeline.lock}"
GPU_SELFTEST_RUNNER="${TDARR_GRAIN_GPU_SELFTEST_RUNNER:-/usr/local/build-scripts/run-grain-gpu-selftests.js}"
GPU_LOCK_HELPER="${TDARR_GPU_LOCK_HELPER:-/custom-cont-init.d/vmaf-plugin-patches/_lib/gpuPipelineLock.js}"
PIPELINE="${TDARR_GRAIN_PIPELINE:-/opt/grain-pipeline/current/grain_pipeline_v5_direct.py}"
FFMPEG="${TDARR_FFMPEG:-/usr/local/bin/tdarr-ffmpeg}"
FFPROBE="${TDARR_FFPROBE:-/usr/local/bin/tdarr-ffprobe}"
MKVMERGE="${TDARR_MKVMERGE:-mkvmerge}"
RUNTIME_USER="${TDARR_RUNTIME_USER:-abc}"
NVENCC_CONTRACT_ENABLED=false
GPU_RUNTIME_SELFTESTS_RAN=false
if [[ "${TDARR_NVENCC_REQUIRED:-0}" == "1" ||
      -n "${TDARR_NVENCC+x}" ||
      -n "${TDARR_NVENCC_COORDINATOR+x}" ||
      -e "$NVENCC_ARTIFACT_ROOT" ||
      -e /usr/local/bin/nvencc ]]; then
    NVENCC_CONTRACT_ENABLED=true
fi

EXPECTED_VERSION="grav1synth 0.2.0"
EXPECTED_GRAV1SYNTH_REAL="/opt/grav1synth/bin/grav1synth"
EXPECTED_GRAV1SYNTH_COMMIT="1044228cd411672b565e5762a9b3597f4dd163b0"
EXPECTED_GRAV1SYNTH_PATCH="grav1synth-nvenc-sequence-header.patch"
EXPECTED_GRAV1SYNTH_PATCH_SHA256="0beb125d34a0c8223a27728440a9dcbc05d72787570d5a0c634a48649a67e4a7"
EXPECTED_GRAV1SYNTH_NVENC_FIXTURE_SHA256="04e451508a968b62559e0b07f8829f931411749355dc27a882b18c56b35fb04a"
EXPECTED_GRAV1SYNTH_SHA256="5e6e462e7c6ddf1229e965d1bb4741b698f9cd9d40e4c0c0ec90d419d42c6e9e"
EXPECTED_NVENCC_VERSION_LINE="NVEnc (x64) 9.25 (r1) by rigaya, Jul 24 2026 07:25:18 (gcc 13.3.0/Linux)"
EXPECTED_NVENCC_COMMIT="8c873e4d15aefb93dd50396e5c70fffb842f7d22"
EXPECTED_NVENCC_PATCH="nvencc-9.25-optional-metadata-libs.patch"
EXPECTED_NVENCC_PATCH_SHA256="8fb6dd6c3770f1e239b56686e0e4e1b02f6f28513ad21c7f5d5e3920f62ea64e"
EXPECTED_NVENCC_SHA256="03d8a26631fef47881f30243e4442dcb26a66cabbb586ae9637c9e22b9776294"
EXPECTED_NVENCC_COORDINATOR_SHA256="6ba05f26647611c1be0986ffee218858f1c0b0734f94bf21af7759e067954576"
EXPECTED_NVENCC_RELEASE="/opt/nvencc/releases/9.25-r3-03d8a26631fe-6ba05f266476"
EXPECTED_NVENCC_REAL="$EXPECTED_NVENCC_RELEASE/bin/nvencc"
EXPECTED_NVENCC_COORDINATOR_REAL="$EXPECTED_NVENCC_RELEASE/libexec/tdarr-nvencc-knn-ffmpeg.js"
EXPECTED_PIPELINE="/opt/grain-pipeline/current/grain_pipeline_v5_direct.py"
EXPECTED_PIPELINE_RELEASE="v5-20260724-r1"
EXPECTED_PIPELINE_SHA256="d8dba8f0c5d02ff7ce3feeaa65b2374c37cc6dabc3d7259120d2229c97836a9f"
EXPECTED_PIPELINE_REAL="/opt/grain-pipeline/releases/v5-20260724-r1-d8dba8f0c5d0/grain_pipeline_v5_direct.py"
PIPELINE_COMMAND="/usr/local/bin/tdarr-grain-pipeline"
EXPECTED_FFMPEG="/usr/local/ffmpeg-custom/bin/ffmpeg"
EXPECTED_FFPROBE="/usr/local/ffmpeg-custom/bin/ffprobe"

fail() {
    echo "[grain preflight] ERROR: $*" >&2
    exit 1
}

verify_wrapper() {
    local wrapper="$1"
    local binary="$2"
    local label="$3"

    [[ -f "$wrapper" && -x "$wrapper" ]] || fail "$label wrapper is not executable: $wrapper"
    [[ ! -L "$wrapper" ]] || fail "$label wrapper was replaced by a symlink: $wrapper"
    grep -Fqx "exec $binary \"\$@\"" "$wrapper" || \
        fail "$label wrapper does not launch $binary: $wrapper"
    grep -Fq "/custom-libvmaf-lib" "$wrapper" || \
        fail "$label wrapper lacks the promoted libvmaf path: $wrapper"
}

require_unique_line() {
    local file="$1"
    local expected="$2"
    local description="$3"
    local count
    count="$(grep -Fxc -- "$expected" "$file" || true)"
    [[ "$count" == "1" ]] || \
        fail "$description must occur exactly once in $file (found $count)"
}

[[ -x "$GRAV1SYNTH" ]] || fail "grav1synth is not executable: $GRAV1SYNTH"
if "$NVENCC_CONTRACT_ENABLED"; then
    [[ -x "$NVENCC" ]] || fail "NVEncC is not executable: $NVENCC"
    [[ -x "$NVENCC_COORDINATOR" ]] || \
        fail "NVEncC coordinator is not executable: $NVENCC_COORDINATOR"
fi
[[ -r "$PIPELINE" ]] || fail "pipeline is not readable: $PIPELINE"
[[ -x "$FFMPEG" ]] || fail "Tdarr FFmpeg is not executable: $FFMPEG"
[[ -x "$FFPROBE" ]] || fail "Tdarr ffprobe is not executable: $FFPROBE"
command -v python3 >/dev/null 2>&1 || fail "python3 is not available"
command -v node >/dev/null 2>&1 || fail "node is not available"
command -v "$MKVMERGE" >/dev/null 2>&1 || \
    fail "mkvmerge is required for lossless Matroska ancillary preservation"
command -v runuser >/dev/null 2>&1 || fail "runuser is not available"
id "$RUNTIME_USER" >/dev/null 2>&1 || fail "runtime user does not exist: $RUNTIME_USER"

PIPELINE_SHA256="$(sha256sum "$PIPELINE" | awk '{print $1}')"
[[ "$PIPELINE_SHA256" == "$EXPECTED_PIPELINE_SHA256" ]] || \
    fail "pipeline checksum mismatch: $PIPELINE_SHA256"
if [[ "$PIPELINE" == "$EXPECTED_PIPELINE" ]]; then
    PIPELINE_REAL="$(readlink -f "$PIPELINE")"
    [[ "$PIPELINE_REAL" == "$EXPECTED_PIPELINE_REAL" ]] || \
        fail "pipeline stable path resolves to an unexpected release: $PIPELINE_REAL"
    [[ -L "$PIPELINE_COMMAND" ]] || fail "pipeline command link is missing: $PIPELINE_COMMAND"
    [[ "$(readlink -f "$PIPELINE_COMMAND")" == "$PIPELINE_REAL" ]] || \
        fail "pipeline command link resolves to the wrong release"
    PIPELINE_PROVENANCE="$(dirname "$PIPELINE_REAL")/PROVENANCE.txt"
    [[ -r "$PIPELINE_PROVENANCE" ]] || fail "installed pipeline provenance is missing"
    grep -Fxq "release_id=$EXPECTED_PIPELINE_RELEASE" "$PIPELINE_PROVENANCE" || \
        fail "installed pipeline provenance has the wrong release ID"
    grep -Fxq "sha256=$EXPECTED_PIPELINE_SHA256" "$PIPELINE_PROVENANCE" || \
        fail "installed pipeline provenance has the wrong checksum"
fi

# Overrides are useful in disposable build containers. Production defaults must
# remain our wrapper scripts; a vendor symlink can still expose av1_nvenc while
# silently losing the promoted libvmaf runtime.
if [[ "$FFMPEG" == "/usr/local/bin/tdarr-ffmpeg" ]]; then
    verify_wrapper "$FFMPEG" "$EXPECTED_FFMPEG" "Tdarr FFmpeg"
    verify_wrapper "/usr/local/bin/ffmpeg" "$EXPECTED_FFMPEG" "generic FFmpeg"
fi
if [[ "$FFPROBE" == "/usr/local/bin/tdarr-ffprobe" ]]; then
    verify_wrapper "$FFPROBE" "$EXPECTED_FFPROBE" "Tdarr ffprobe"
    verify_wrapper "/usr/local/bin/ffprobe" "$EXPECTED_FFPROBE" "generic ffprobe"
fi

ACTUAL_VERSION="$("$GRAV1SYNTH" --version 2>&1)"
[[ "$ACTUAL_VERSION" == "$EXPECTED_VERSION" ]] || \
    fail "expected '$EXPECTED_VERSION', got '$ACTUAL_VERSION'"

ACTUAL_SHA256="$(sha256sum "$GRAV1SYNTH" | awk '{print $1}')"
[[ "$ACTUAL_SHA256" == "$EXPECTED_GRAV1SYNTH_SHA256" ]] || \
    fail "grav1synth checksum mismatch: $ACTUAL_SHA256"

ACTUAL_NVENCC_VERSION_LINE=""
ACTUAL_NVENCC_SHA256=""
ACTUAL_NVENCC_COORDINATOR_SHA256=""
if "$NVENCC_CONTRACT_ENABLED"; then
    ACTUAL_NVENCC_VERSION_LINE="$("$NVENCC" --version 2>&1 | sed -n '1p')"
    [[ "$ACTUAL_NVENCC_VERSION_LINE" == "$EXPECTED_NVENCC_VERSION_LINE" ]] || \
        fail "expected '$EXPECTED_NVENCC_VERSION_LINE', got '$ACTUAL_NVENCC_VERSION_LINE'"
    ACTUAL_NVENCC_SHA256="$(sha256sum "$NVENCC" | awk '{print $1}')"
    [[ "$ACTUAL_NVENCC_SHA256" == "$EXPECTED_NVENCC_SHA256" ]] || \
        fail "NVEncC checksum mismatch: $ACTUAL_NVENCC_SHA256"
    ACTUAL_NVENCC_COORDINATOR_SHA256="$(sha256sum "$NVENCC_COORDINATOR" | awk '{print $1}')"
    [[ "$ACTUAL_NVENCC_COORDINATOR_SHA256" == "$EXPECTED_NVENCC_COORDINATOR_SHA256" ]] || \
        fail "NVEncC coordinator checksum mismatch: $ACTUAL_NVENCC_COORDINATOR_SHA256"
fi

if [[ "$GRAV1SYNTH" == "/usr/local/bin/grav1synth" ]]; then
    [[ -L "$GRAV1SYNTH" ]] || fail "production grav1synth command is not a symlink"
    GRAV1SYNTH_REAL="$(readlink -f "$GRAV1SYNTH")"
    [[ "$GRAV1SYNTH_REAL" == "$EXPECTED_GRAV1SYNTH_REAL" ]] || \
        fail "production grav1synth resolves to an unexpected release: $GRAV1SYNTH_REAL"
    [[ -f "$GRAV1SYNTH_REAL" && ! -L "$GRAV1SYNTH_REAL" && -x "$GRAV1SYNTH_REAL" ]] || \
        fail "installed grav1synth release is not a regular executable: $GRAV1SYNTH_REAL"

    for required in "$GRAV1SYNTH_ARTIFACT_BIN" "$GRAV1SYNTH_ARTIFACT_PROVENANCE" \
        "$GRAV1SYNTH_ARTIFACT_SUMS"; do
        [[ -f "$required" && ! -L "$required" && -r "$required" ]] || \
            fail "grav1synth artifact contract file is missing, unreadable, or a symlink: $required"
    done
    EXPECTED_GRAV1SYNTH_SUM_LINE="$EXPECTED_GRAV1SYNTH_SHA256  bin/grav1synth"
    mapfile -t GRAV1SYNTH_SUM_LINES < <(sed '/^[[:space:]]*$/d' "$GRAV1SYNTH_ARTIFACT_SUMS")
    [[ "${#GRAV1SYNTH_SUM_LINES[@]}" -eq 1 && \
        "${GRAV1SYNTH_SUM_LINES[0]}" == "$EXPECTED_GRAV1SYNTH_SUM_LINE" ]] || \
        fail "grav1synth artifact checksum manifest is not the exact pinned binary"
    (
        cd "$GRAV1SYNTH_ARTIFACT_ROOT"
        sha256sum --check --strict SHA256SUMS
    ) >/dev/null || fail "grav1synth artifact checksum manifest validation failed"
    GRAV1SYNTH_ARTIFACT_SHA256="$(sha256sum "$GRAV1SYNTH_ARTIFACT_BIN" | awk '{print $1}')"
    [[ "$GRAV1SYNTH_ARTIFACT_SHA256" == "$EXPECTED_GRAV1SYNTH_SHA256" && \
        "$GRAV1SYNTH_ARTIFACT_SHA256" == "$ACTUAL_SHA256" ]] || \
        fail "installed and mounted grav1synth artifacts do not match"
    require_unique_line "$GRAV1SYNTH_ARTIFACT_PROVENANCE" \
        "git_commit=$EXPECTED_GRAV1SYNTH_COMMIT" "grav1synth source commit"
    require_unique_line "$GRAV1SYNTH_ARTIFACT_PROVENANCE" \
        "patch=$EXPECTED_GRAV1SYNTH_PATCH" "grav1synth patch name"
    require_unique_line "$GRAV1SYNTH_ARTIFACT_PROVENANCE" \
        "patch_sha256=$EXPECTED_GRAV1SYNTH_PATCH_SHA256" "grav1synth patch checksum"
    require_unique_line "$GRAV1SYNTH_ARTIFACT_PROVENANCE" \
        "nvenc_fixture_sha256=$EXPECTED_GRAV1SYNTH_NVENC_FIXTURE_SHA256" \
        "grav1synth decoded NVENC fixture checksum"
    require_unique_line "$GRAV1SYNTH_ARTIFACT_PROVENANCE" \
        "sha256=$EXPECTED_GRAV1SYNTH_SHA256" "grav1synth binary checksum"
fi

if "$NVENCC_CONTRACT_ENABLED" && [[ "$NVENCC" == "/usr/local/bin/nvencc" ]]; then
    [[ -L "$NVENCC" ]] || fail "production NVEncC command is not a symlink"
    [[ -L "$NVENCC_COORDINATOR" ]] || \
        fail "production NVEncC coordinator is not a symlink"
    NVENCC_REAL="$(readlink -f "$NVENCC")"
    NVENCC_COORDINATOR_REAL="$(readlink -f "$NVENCC_COORDINATOR")"
    [[ "$NVENCC_REAL" == "$EXPECTED_NVENCC_REAL" ]] || \
        fail "production NVEncC resolves to an unexpected release: $NVENCC_REAL"
    [[ "$NVENCC_COORDINATOR_REAL" == "$EXPECTED_NVENCC_COORDINATOR_REAL" ]] || \
        fail "production NVEncC coordinator resolves to an unexpected release: $NVENCC_COORDINATOR_REAL"

    for required in "$NVENCC_ARTIFACT_BIN" "$NVENCC_ARTIFACT_COORDINATOR" \
        "$NVENCC_ARTIFACT_PROVENANCE" "$NVENCC_ARTIFACT_SUMS"; do
        [[ -f "$required" && ! -L "$required" && -r "$required" ]] || \
            fail "NVEncC artifact contract file is missing, unreadable, or a symlink: $required"
    done
    EXPECTED_NVENCC_SUM_LINE="$EXPECTED_NVENCC_SHA256  bin/nvencc"
    EXPECTED_NVENCC_COORDINATOR_SUM_LINE="$EXPECTED_NVENCC_COORDINATOR_SHA256  libexec/tdarr-nvencc-knn-ffmpeg.js"
    mapfile -t NVENCC_SUM_LINES < <(sed '/^[[:space:]]*$/d' "$NVENCC_ARTIFACT_SUMS")
    [[ "${#NVENCC_SUM_LINES[@]}" -eq 2 &&
        "${NVENCC_SUM_LINES[0]}" == "$EXPECTED_NVENCC_SUM_LINE" &&
        "${NVENCC_SUM_LINES[1]}" == "$EXPECTED_NVENCC_COORDINATOR_SUM_LINE" ]] || \
        fail "NVEncC artifact checksum manifest is not the exact pinned binary/coordinator pair"
    (
        cd "$NVENCC_ARTIFACT_ROOT"
        sha256sum --check --strict SHA256SUMS
    ) >/dev/null || fail "NVEncC artifact checksum manifest validation failed"
    [[ "$(sha256sum "$NVENCC_ARTIFACT_BIN" | awk '{print $1}')" == "$ACTUAL_NVENCC_SHA256" ]] || \
        fail "installed and mounted NVEncC binary artifacts do not match"
    [[ "$(sha256sum "$NVENCC_ARTIFACT_COORDINATOR" | awk '{print $1}')" == \
        "$ACTUAL_NVENCC_COORDINATOR_SHA256" ]] || \
        fail "installed and mounted NVEncC coordinator artifacts do not match"
    require_unique_line "$NVENCC_ARTIFACT_PROVENANCE" \
        "git_commit=$EXPECTED_NVENCC_COMMIT" "NVEncC source commit"
    require_unique_line "$NVENCC_ARTIFACT_PROVENANCE" \
        "patch=$EXPECTED_NVENCC_PATCH" "NVEncC patch name"
    require_unique_line "$NVENCC_ARTIFACT_PROVENANCE" \
        "patch_sha256=$EXPECTED_NVENCC_PATCH_SHA256" "NVEncC patch checksum"
    require_unique_line "$NVENCC_ARTIFACT_PROVENANCE" \
        "binary_sha256=$EXPECTED_NVENCC_SHA256" "NVEncC binary checksum"
    require_unique_line "$NVENCC_ARTIFACT_PROVENANCE" \
        "coordinator_sha256=$EXPECTED_NVENCC_COORDINATOR_SHA256" \
        "NVEncC coordinator checksum"
fi

MISSING_LIBS="$(ldd "$GRAV1SYNTH" | awk '/not found/ { print $1 }')"
[[ -z "$MISSING_LIBS" ]] || fail "grav1synth libraries missing: $MISSING_LIBS"
if "$NVENCC_CONTRACT_ENABLED"; then
    NVENCC_MISSING_LIBS="$(ldd "$NVENCC" | awk '/not found/ { print $1 }')"
    [[ -z "$NVENCC_MISSING_LIBS" ]] || fail "NVEncC libraries missing: $NVENCC_MISSING_LIBS"
fi

# Compile in memory so the immutable installed release never receives __pycache__ files.
python3 -c 'import pathlib, sys; p = pathlib.Path(sys.argv[1]); compile(p.read_bytes(), str(p), "exec")' \
    "$PIPELINE"
python3 "$PIPELINE" --help >/dev/null
# Startup and health checks run as root, but Flow plugins run as abc. Exercise
# both stable paths as that real runtime user so a root-only release cannot pass.
runuser -u "$RUNTIME_USER" -- stat "$PIPELINE" >/dev/null 2>&1 || \
    fail "pipeline is not accessible to runtime user $RUNTIME_USER: $PIPELINE"
runuser -u "$RUNTIME_USER" -- python3 "$PIPELINE" --help >/dev/null 2>&1 || \
    fail "pipeline CLI failed for runtime user $RUNTIME_USER"
runuser -u "$RUNTIME_USER" -- "$GRAV1SYNTH" --version >/dev/null 2>&1 || \
    fail "grav1synth failed for runtime user $RUNTIME_USER"
if "$NVENCC_CONTRACT_ENABLED"; then
    runuser -u "$RUNTIME_USER" -- "$NVENCC" --version >/dev/null 2>&1 || \
        fail "NVEncC failed for runtime user $RUNTIME_USER"
    runuser -u "$RUNTIME_USER" -- node --check "$NVENCC_COORDINATOR" >/dev/null 2>&1 || \
        fail "NVEncC coordinator syntax/access check failed for runtime user $RUNTIME_USER"
fi
"$GRAV1SYNTH" diff --help >/dev/null
"$GRAV1SYNTH" apply --help >/dev/null
"$GRAV1SYNTH" inspect --help >/dev/null
if "$NVENCC_CONTRACT_ENABLED"; then
    NVENCC_HELP="$("$NVENCC" --help 2>&1)"
    grep -Fq -- "--vpp-knn" <<<"$NVENCC_HELP" || fail "NVEncC lacks the CUDA KNN filter"
    grep -Fq "temporal radius" <<<"$NVENCC_HELP" || \
        fail "NVEncC KNN help lacks temporal-radius support"
fi

ENCODERS="$("$FFMPEG" -hide_banner -encoders 2>&1)"
grep -Fq "av1_nvenc" <<<"$ENCODERS" || fail "Tdarr FFmpeg lacks av1_nvenc"
"$FFPROBE" -version >/dev/null 2>&1
"$MKVMERGE" --version >/dev/null 2>&1 || \
    fail "mkvmerge version probe failed"
[[ -f "$GPU_SELFTEST_RUNNER" && ! -L "$GPU_SELFTEST_RUNNER" && \
    -r "$GPU_SELFTEST_RUNNER" ]] || \
    fail "owned GPU self-test runner is not a readable regular file: $GPU_SELFTEST_RUNNER"
[[ -f "$GPU_LOCK_HELPER" && ! -L "$GPU_LOCK_HELPER" && -r "$GPU_LOCK_HELPER" ]] || \
    fail "GPU lock helper is not a readable regular file: $GPU_LOCK_HELPER"
[[ -f "$GRAV1SYNTH_NVENC_REGRESSION" && ! -L "$GRAV1SYNTH_NVENC_REGRESSION" && \
    -r "$GRAV1SYNTH_NVENC_REGRESSION" ]] || \
    fail "grav1synth NVENC regression is not a readable regular file: $GRAV1SYNTH_NVENC_REGRESSION"
NVENCC_CONTRACT_FLAG=0
if "$NVENCC_CONTRACT_ENABLED"; then
    NVENCC_CONTRACT_FLAG=1
    [[ -f "$NVENCC_KNN_SMOKE" && ! -L "$NVENCC_KNN_SMOKE" && -r "$NVENCC_KNN_SMOKE" ]] || \
        fail "NVEncC KNN smoke test is not a readable regular file: $NVENCC_KNN_SMOKE"
fi
GPU_SELFTEST_RESULT="$(
    TDARR_GPU_PIPELINE_LOCK_DIR="$GPU_PIPELINE_LOCK_DIR" \
    TDARR_GPU_LOCK_HELPER="$GPU_LOCK_HELPER" \
    TDARR_RUNTIME_USER="$RUNTIME_USER" \
    TDARR_GRAV1SYNTH="$GRAV1SYNTH" \
    GRAV1SYNTH_NVENC_REGRESSION="$GRAV1SYNTH_NVENC_REGRESSION" \
    TDARR_FFMPEG="$FFMPEG" \
    TDARR_NVENCC_CONTRACT_ENABLED="$NVENCC_CONTRACT_FLAG" \
    TDARR_NVENCC="$NVENCC" \
    NVENCC_KNN_SMOKE="$NVENCC_KNN_SMOKE" \
    NVENCC_SMOKE_BASE="${TMPDIR:-/tmp}" \
    node "$GPU_SELFTEST_RUNNER"
)" || fail "owned GPU runtime self-tests failed"
case "$GPU_SELFTEST_RESULT" in
    RAN)
        GPU_RUNTIME_SELFTESTS_RAN=true
        ;;
    SKIPPED_BUSY)
        echo "[grain preflight] INFO: GPU pipeline is busy; runtime GPU self-tests were not started"
        ;;
    *)
        fail "owned GPU self-test runner returned an invalid result"
        ;;
esac

# Exercise the exact lossless intermediate codec used by source analysis. CUDA
# KNN itself is exercised above at both supported bit depths; this independent
# FFV1 round trip detects a broken analysis intermediate without repeating more
# GPU work during every recurring health check.
GRAIN_SELFTEST_BASE="${TMPDIR:-/tmp}"
[[ "$GRAIN_SELFTEST_BASE" == /* ]] || fail "grain preflight scratch base must be absolute"
GRAIN_SELFTEST_ROOT="$(mktemp -d "$GRAIN_SELFTEST_BASE/tdarr-grain-preflight.XXXXXX")" || \
    fail "could not create grain preflight scratch directory"
cleanup_selftest() {
    if [[ -n "$GRAIN_SELFTEST_ROOT" && "$GRAIN_SELFTEST_ROOT" == "$GRAIN_SELFTEST_BASE"/tdarr-grain-preflight.* ]]; then
        rm -rf -- "$GRAIN_SELFTEST_ROOT"
    else
        echo "[grain preflight] refusing unsafe scratch cleanup: $GRAIN_SELFTEST_ROOT" >&2
    fi
}
trap cleanup_selftest EXIT
GRAIN_SELFTEST_SOURCE="$GRAIN_SELFTEST_ROOT/source.ffv1.mkv"
GRAIN_SELFTEST_INPUT='testsrc2=size=64x64:rate=12:duration=0.5'

"$FFMPEG" -hide_banner -loglevel error -nostdin \
    -f lavfi -i "$GRAIN_SELFTEST_INPUT" -map 0:v:0 -frames:v 6 -an \
    -c:v ffv1 -level 3 -coder 1 -context 1 -g 1 -slicecrc 1 \
    -pix_fmt yuv420p -y "$GRAIN_SELFTEST_SOURCE" || \
    fail "FFV1 self-test encode failed"
GRAIN_SELFTEST_CODEC="$("$FFPROBE" -v error -select_streams v:0 \
    -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 \
    "$GRAIN_SELFTEST_SOURCE")" || fail "FFV1 self-test probe failed"
[[ "$GRAIN_SELFTEST_CODEC" == "ffv1" ]] || \
    fail "FFV1 self-test produced unexpected codec: $GRAIN_SELFTEST_CODEC"

GRAIN_SELFTEST_REFERENCE_MD5="$("$FFMPEG" -hide_banner -loglevel error -nostdin \
    -f lavfi -i "$GRAIN_SELFTEST_INPUT" -map 0:v:0 -frames:v 6 \
    -c:v rawvideo -pix_fmt yuv420p -f md5 -)" || \
    fail "FFV1 self-test reference decode failed"
GRAIN_SELFTEST_DECODED_MD5="$("$FFMPEG" -hide_banner -loglevel error -nostdin \
    -i "$GRAIN_SELFTEST_SOURCE" -map 0:v:0 -frames:v 6 \
    -c:v rawvideo -pix_fmt yuv420p -f md5 -)" || \
    fail "FFV1 self-test decode failed"
[[ "$GRAIN_SELFTEST_DECODED_MD5" == "$GRAIN_SELFTEST_REFERENCE_MD5" ]] || \
    fail "FFV1 self-test round trip was not lossless"

if [[ "${GRAIN_PREFLIGHT_QUIET:-0}" != "1" ]]; then
    echo "[grain preflight] OK: $ACTUAL_VERSION ($ACTUAL_SHA256)"
    if "$NVENCC_CONTRACT_ENABLED"; then
        echo "[grain preflight] OK: $ACTUAL_NVENCC_VERSION_LINE ($ACTUAL_NVENCC_SHA256)"
        if "$GPU_RUNTIME_SELFTESTS_RAN"; then
            echo "[grain preflight] OK: NVEncC CUDA KNN 8-bit and 10-bit runtime-user paths"
        else
            echo "[grain preflight] INFO: NVEncC CUDA KNN runtime paths were not exercised while busy"
        fi
    else
        echo "[grain preflight] INFO: NVEncC contract deferred until the new artifact mount is deployed"
    fi
    echo "[grain preflight] OK: pipeline $PIPELINE ($PIPELINE_SHA256)"
    echo "[grain preflight] OK: FFmpeg wrappers expose av1_nvenc"
    echo "[grain preflight] OK: MKVToolNix is available for FFmpeg-bypass ancillary remux"
    echo "[grain preflight] OK: FFV1 encode/decode round trip is lossless"
fi
