#!/bin/bash
# Test script to check if libvmaf_cuda supports 10-bit pixel formats
# Tests: yuv420p10le, p010le, yuv422p10le, yuv444p10le

set -e

echo "=== Testing 10-bit Format Support in libvmaf_cuda ==="
echo ""

# Configuration
FFMPEG_PATH="tdarr-ffmpeg"
CACHE_DIR="/temp/test-10bit-vmaf-$(date +%s)"
MODEL_PATH="/usr/local/ffmpeg-custom/ffmpeg-7.0.2-amd64-static/model/vmaf_v0.6.1.json"

# Create test directory
mkdir -p "$CACHE_DIR"
echo "Test directory: $CACHE_DIR"
echo ""

# Check if FFmpeg has libvmaf_cuda
echo "1. Checking for libvmaf_cuda support..."
if $FFMPEG_PATH -hide_banner -filters 2>&1 | grep -q "libvmaf_cuda"; then
    echo "   ✅ libvmaf_cuda is available"
else
    echo "   ❌ libvmaf_cuda is NOT available"
    echo "   Cannot test 10-bit formats without libvmaf_cuda"
    exit 1
fi
echo ""

# Look for existing test files or create minimal ones
echo "2. Preparing test video files..."
REFERENCE_8BIT=""
DISTORTED_8BIT=""

# Look for files in a configured media-library mount.
TV_DIRS=("/media/library-1" "/media/library-2" "/media/tv" "/tv" "/mnt/tv")

# Also check cache directory
if [ -d "/temp" ]; then
    # Find existing test files
    REFERENCE_8BIT=$(find /temp -name "*sample*.mkv" -type f 2>/dev/null | head -1)
    DISTORTED_8BIT=$(find /temp -name "test_*.mkv" -type f 2>/dev/null | head -1)
fi

# If not found, look in TV directories for any video files
if [ -z "$REFERENCE_8BIT" ] || [ -z "$DISTORTED_8BIT" ]; then
    for tv_dir in "${TV_DIRS[@]}"; do
        if [ -d "$tv_dir" ]; then
            echo "   Checking $tv_dir..."
            # Look for any video file as reference
            if [ -z "$REFERENCE_8BIT" ]; then
                REFERENCE_8BIT=$(find "$tv_dir" -type f \( -name "*.mkv" -o -name "*.mp4" -o -name "*.m4v" \) 2>/dev/null | head -1)
            fi
            # Look for a different file as distorted (or we can use same file)
            if [ -z "$DISTORTED_8BIT" ]; then
                DISTORTED_8BIT=$(find "$tv_dir" -type f \( -name "*.mkv" -o -name "*.mp4" -o -name "*.m4v" \) 2>/dev/null | tail -1)
            fi
            if [ -n "$REFERENCE_8BIT" ] && [ -n "$DISTORTED_8BIT" ]; then
                break
            fi
        fi
    done
fi

# If we found one file but not two, use the same file for both (or create a second)
if [ -n "$REFERENCE_8BIT" ] && [ -z "$DISTORTED_8BIT" ]; then
    DISTORTED_8BIT="$REFERENCE_8BIT"
    echo "   ⚠️  Using same file for both reference and distorted (will test format conversion)"
fi

# If not found, create minimal test files using available encoder
if [ -z "$REFERENCE_8BIT" ] || [ -z "$DISTORTED_8BIT" ]; then
    echo "   Creating minimal test files..."
    REFERENCE_8BIT="$CACHE_DIR/reference_8bit.mkv"
    DISTORTED_8BIT="$CACHE_DIR/distorted_8bit.mkv"

    # Try different encoders
    if $FFMPEG_PATH -encoders 2>&1 | grep -q "libx264"; then
        echo "   Using libx264 for reference..."
        $FFMPEG_PATH -f lavfi -i testsrc=duration=1:size=1920x1080:rate=30 \
            -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p \
            -t 1 "$REFERENCE_8BIT" -y 2>&1 | grep -v "frame=" || true
    elif $FFMPEG_PATH -encoders 2>&1 | grep -q "h264_nvenc"; then
        echo "   Using h264_nvenc for reference..."
        $FFMPEG_PATH -f lavfi -i testsrc=duration=1:size=1920x1080:rate=30 \
            -c:v h264_nvenc -preset p1 -cq 18 -pix_fmt yuv420p \
            -t 1 "$REFERENCE_8BIT" -y 2>&1 | grep -v "frame=" || true
    else
        echo "   ⚠️  No suitable encoder found, using rawvideo..."
        $FFMPEG_PATH -f lavfi -i testsrc=duration=1:size=1920x1080:rate=30 \
            -c:v rawvideo -pix_fmt yuv420p \
            -t 1 "$REFERENCE_8BIT" -y 2>&1 | grep -v "frame=" || true
    fi

    if $FFMPEG_PATH -encoders 2>&1 | grep -q "av1_nvenc"; then
        echo "   Using av1_nvenc for distorted..."
        $FFMPEG_PATH -f lavfi -i testsrc=duration=1:size=1920x1080:rate=30 \
            -c:v av1_nvenc -preset p7 -cq 35 -pix_fmt yuv420p \
            -t 1 "$DISTORTED_8BIT" -y 2>&1 | grep -v "frame=" || true
    elif $FFMPEG_PATH -encoders 2>&1 | grep -q "hevc_nvenc"; then
        echo "   Using hevc_nvenc for distorted..."
        $FFMPEG_PATH -f lavfi -i testsrc=duration=1:size=1920x1080:rate=30 \
            -c:v hevc_nvenc -preset p7 -cq 35 -pix_fmt yuv420p \
            -t 1 "$DISTORTED_8BIT" -y 2>&1 | grep -v "frame=" || true
    else
        echo "   ⚠️  Using rawvideo for distorted..."
        $FFMPEG_PATH -f lavfi -i testsrc2=duration=1:size=1920x1080:rate=30 \
            -c:v rawvideo -pix_fmt yuv420p \
            -t 1 "$DISTORTED_8BIT" -y 2>&1 | grep -v "frame=" || true
    fi
else
    echo "   ✅ Using existing test files:"
    echo "      Reference: $REFERENCE_8BIT"
    echo "      Distorted: $DISTORTED_8BIT"
fi

echo "   Test files ready"
echo ""

# Detect codecs of input files
echo "3. Detecting input file codecs..."
REFERENCE_CODEC=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$REFERENCE_8BIT" 2>/dev/null || echo "unknown")
DISTORTED_CODEC=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$DISTORTED_8BIT" 2>/dev/null || echo "unknown")
echo "   Reference codec: $REFERENCE_CODEC"
echo "   Distorted codec: $DISTORTED_CODEC"

# Map codecs to CUVID decoders
case "$REFERENCE_CODEC" in
    h264) REFERENCE_CUVID="h264_cuvid" ;;
    hevc|h265) REFERENCE_CUVID="hevc_cuvid" ;;
    av1) REFERENCE_CUVID="av1_cuvid" ;;
    vp8) REFERENCE_CUVID="vp8_cuvid" ;;
    vp9) REFERENCE_CUVID="vp9_cuvid" ;;
    *) REFERENCE_CUVID="" ;;
esac

case "$DISTORTED_CODEC" in
    h264) DISTORTED_CUVID="h264_cuvid" ;;
    hevc|h265) DISTORTED_CUVID="hevc_cuvid" ;;
    av1) DISTORTED_CUVID="av1_cuvid" ;;
    vp8) DISTORTED_CUVID="vp8_cuvid" ;;
    vp9) DISTORTED_CUVID="vp9_cuvid" ;;
    *) DISTORTED_CUVID="" ;;
esac

echo "   Reference CUVID decoder: ${REFERENCE_CUVID:-software decode}"
echo "   Distorted CUVID decoder: ${DISTORTED_CUVID:-software decode}"
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

echo "3. Testing each 10-bit format with libvmaf_cuda..."
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

echo "=== Detailed Logs ==="
echo "Logs stored in: $CACHE_DIR"
echo ""

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
echo "=== Test Complete ==="
