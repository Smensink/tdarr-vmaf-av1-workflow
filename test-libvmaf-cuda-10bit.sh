#!/bin/bash
# Synthetic-only test to check if libvmaf_cuda supports 10-bit pixel formats.
# It never searches /temp or mounted media for input files.
# Tests: yuv420p10le, p010le, yuv422p10le, yuv444p10le

set -euo pipefail

echo "=== Testing 10-bit Format Support in libvmaf_cuda ==="
echo ""

# Configuration
FFMPEG_PATH="${VMAF_FFMPEG_BIN:-tdarr-ffmpeg}"
CACHE_ROOT="${VMAF_10BIT_TEST_ROOT:-/temp}"
MODEL_PATH="/usr/local/ffmpeg-custom/ffmpeg-7.0.2-amd64-static/model/vmaf_v0.6.1.json"

[ -d "$CACHE_ROOT" ] && [ -w "$CACHE_ROOT" ] || {
    echo "Synthetic 10-bit test root is not a writable directory" >&2
    exit 1
}
CACHE_DIR="$(mktemp -d "${CACHE_ROOT%/}/test-10bit-vmaf.XXXXXX")"
cleanup() {
    rm -rf -- "$CACHE_DIR"
}
trap cleanup EXIT

# Check if FFmpeg has libvmaf_cuda
echo "1. Checking for libvmaf_cuda support..."
FILTERS="$("$FFMPEG_PATH" -hide_banner -filters 2>&1)"
if grep -q "libvmaf_cuda" <<<"$FILTERS"; then
    echo "   ✅ libvmaf_cuda is available"
else
    echo "   ❌ libvmaf_cuda is NOT available"
    echo "   Cannot test 10-bit formats without libvmaf_cuda"
    exit 1
fi
echo ""

# Formats to test
FORMATS=(
    "yuv420p10le:10-bit 4:2:0 planar"
    "p010le:10-bit 4:2:0 packed"
    "yuv422p10le:10-bit 4:2:2 planar"
    "yuv444p10le:10-bit 4:4:4 planar"
)

# Results storage
SUPPORTED_FORMATS=()
UNSUPPORTED_FORMATS=()

echo "2. Testing each 10-bit format with synthetic lavfi sources..."
echo "   (Converting 8-bit source to 10-bit format in filter, then testing libvmaf_cuda acceptance)"
echo ""

for format_entry in "${FORMATS[@]}"; do
    IFS=':' read -r format_name format_desc <<< "$format_entry"
    echo "   Testing: $format_name ($format_desc)..."

    LOG_PATH="$CACHE_DIR/vmaf_${format_name}.json"
    MODEL_PARAM=""
    if [ -f "$MODEL_PATH" ]; then
        MODEL_PARAM=":model=path=$MODEL_PATH"
    fi

    # Build test command using lavfi synthetic sources
    # This directly tests if libvmaf_cuda accepts the 10-bit format
    TEST_CMD=(
        "$FFMPEG_PATH"
        "-init_hw_device" "cuda=cuda0:0"
        "-filter_hw_device" "cuda0"
        "-f" "lavfi"
        "-i" "testsrc=duration=1:size=1920x1080:rate=30"
        "-f" "lavfi"
        "-i" "testsrc2=duration=1:size=1920x1080:rate=30"
    )

    # Filter: convert both to the 10-bit format using scale_cuda, then test libvmaf_cuda
    # Start with yuv420p (from lavfi), upload to GPU, convert to 10-bit, then test
    FILTER_COMPLEX="[0:v]format=yuv420p,hwupload_cuda,scale_cuda=w=iw:h=ih:format=$format_name[dis];[1:v]format=yuv420p,hwupload_cuda,scale_cuda=w=iw:h=ih:format=$format_name[ref];[dis][ref]libvmaf_cuda=log_path=$LOG_PATH:log_fmt=json$MODEL_PARAM"
    TEST_CMD+=(
        "-filter_complex" "$FILTER_COMPLEX"
        "-f" "null"
        "-"
        "-t" "1"
    )

    # Run test and capture output
    OUTPUT_LOG="$CACHE_DIR/test_${format_name}.log"
    if "${TEST_CMD[@]}" > "$OUTPUT_LOG" 2>&1; then
        # Check if log file was created and has valid content
        if [ -f "$LOG_PATH" ] && [ -s "$LOG_PATH" ]; then
            # Try to verify it's valid JSON and has VMAF data
            if grep -q "vmaf" "$LOG_PATH" 2>/dev/null; then
                echo "      ✅ SUPPORTED - Format $format_name works!"
                SUPPORTED_FORMATS+=("$format_name:$format_desc")
            else
                echo "      ❌ FAILED - Log file created but no VMAF data"
                UNSUPPORTED_FORMATS+=("$format_name:$format_desc")
            fi
        else
            echo "      ❌ FAILED - No log file created"
            UNSUPPORTED_FORMATS+=("$format_name:$format_desc")
        fi
    else
        # Check error message for unsupported format
        if grep -qi "unsupported.*format\|Unsupported input format" "$OUTPUT_LOG" 2>/dev/null; then
            echo "      ❌ NOT SUPPORTED - Format $format_name rejected"
        else
            echo "      ❌ FAILED - Error occurred (check log)"
        fi
        UNSUPPORTED_FORMATS+=("$format_name:$format_desc")
    fi

    echo ""
done

# Print summary
echo "=== Test Results Summary ==="
echo ""

if [ ${#SUPPORTED_FORMATS[@]} -gt 0 ]; then
    echo "✅ SUPPORTED 10-bit formats:"
    for format_entry in "${SUPPORTED_FORMATS[@]}"; do
        IFS=':' read -r format_name format_desc <<< "$format_entry"
        echo "   - $format_name ($format_desc)"
    done
    echo ""
    echo "📝 CONCLUSION: libvmaf_cuda DOES support 10-bit formats!"
    echo "   Recommendation: Update code to use native 10-bit format instead of converting to 8-bit"
    echo ""
else
    echo "❌ NO 10-bit formats are supported"
    echo ""
    for format_entry in "${UNSUPPORTED_FORMATS[@]}"; do
        IFS=':' read -r format_name format_desc <<< "$format_entry"
        echo "   - $format_name ($format_desc)"
    done
    echo ""
    echo "📝 CONCLUSION: libvmaf_cuda does NOT support any 10-bit formats"
    echo "   Recommendation: Implement VMAF threshold buffer to account for 8-bit conversion artifacts"
    echo ""
fi

# Show error details for failed formats
if [ ${#UNSUPPORTED_FORMATS[@]} -gt 0 ]; then
    echo "Error details for unsupported formats:"
    for format_entry in "${UNSUPPORTED_FORMATS[@]}"; do
        IFS=':' read -r format_name format_desc <<< "$format_entry"
        ERROR_LOG="$CACHE_DIR/test_${format_name}.log"
        if [ -f "$ERROR_LOG" ]; then
            echo ""
            echo "--- $format_name errors ---"
            grep -i "error\|unsupported\|failed" "$ERROR_LOG" | head -5 || echo "   (No clear error messages found)"
        fi
    done
fi

echo ""
echo "Synthetic scratch and diagnostic logs will now be removed."
echo "=== Test Complete ==="
