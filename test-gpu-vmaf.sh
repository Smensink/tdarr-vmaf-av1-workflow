#!/bin/bash
# Test script to verify GPU VMAF (libvmaf_cuda) works correctly
# This emulates the calculateVMAF plugin's GPU VMAF command

set -e

echo "=== GPU VMAF Test Script ==="
echo ""

# Configuration
FFMPEG_PATH="tdarr-ffmpeg"
CACHE_DIR="/temp/test-vmaf-$(date +%s)"
MODEL_PATH="${VMAF_MODEL_PATH:-/usr/local/share/model/vmaf_v0.6.1.json}"

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
    exit 1
fi
echo ""

# Check for test files or create them
echo "2. Checking for test files..."
DISTORTED_FILE=""
REFERENCE_FILE=""

# Look for existing test files in cache
if [ -d "/temp" ]; then
    # Find any AV1 encoded test file (distorted)
    DISTORTED_FILE=$(find /temp -name "test_*.mkv" -type f 2>/dev/null | head -1)
    # Find any original sample file (reference)
    REFERENCE_FILE=$(find /temp -name "*_sample_*.mkv" -type f 2>/dev/null | head -1)
fi

if [ -z "$DISTORTED_FILE" ] || [ -z "$REFERENCE_FILE" ]; then
    echo "   ⚠️  Test files not found. Creating minimal test files..."
    echo "   This will create a simple test pattern for testing."

    # Create a simple test pattern as reference (H.264)
    REFERENCE_FILE="$CACHE_DIR/reference_test.mkv"
    $FFMPEG_PATH -f lavfi -i testsrc=duration=2:size=1920x1080:rate=30 \
        -c:v libx264 -preset ultrafast -crf 18 -pix_fmt yuv420p \
        -t 2 "$REFERENCE_FILE" -y 2>/dev/null
    echo "   Created reference: $REFERENCE_FILE"

    # Create a distorted version (AV1, lower quality)
    DISTORTED_FILE="$CACHE_DIR/distorted_test.mkv"
    $FFMPEG_PATH -f lavfi -i testsrc=duration=2:size=1920x1080:rate=30 \
        -c:v libsvtav1 -preset 8 -crf 35 -pix_fmt yuv420p \
        -t 2 "$DISTORTED_FILE" -y 2>/dev/null
    echo "   Created distorted: $DISTORTED_FILE"
else
    echo "   ✅ Found test files:"
    echo "      Distorted: $DISTORTED_FILE"
    echo "      Reference: $REFERENCE_FILE"
fi
echo ""

# Detect reference codec
echo "3. Detecting reference file codec..."
REFERENCE_CODEC=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 "$REFERENCE_FILE" 2>/dev/null || echo "h264")
echo "   Reference codec: $REFERENCE_CODEC"

# Map codec to CUVID decoder
case "$REFERENCE_CODEC" in
    h264)
        REFERENCE_CUVID="h264_cuvid"
        ;;
    hevc|h265)
        REFERENCE_CUVID="hevc_cuvid"
        ;;
    av1)
        REFERENCE_CUVID="av1_cuvid"
        ;;
    vp8)
        REFERENCE_CUVID="vp8_cuvid"
        ;;
    vp9)
        REFERENCE_CUVID="vp9_cuvid"
        ;;
    vc1)
        REFERENCE_CUVID="vc1_cuvid"
        ;;
    mpeg2video|mpeg2)
        REFERENCE_CUVID="mpeg2_cuvid"
        ;;
    mpeg4)
        REFERENCE_CUVID="mpeg4_cuvid"
        ;;
    *)
        REFERENCE_CUVID=""
        echo "   ⚠️  Codec $REFERENCE_CODEC not supported by CUVID, will use software decode"
        ;;
esac

if [ -n "$REFERENCE_CUVID" ]; then
    echo "   Using CUVID decoder: $REFERENCE_CUVID"
else
    echo "   Will use software decode + hwupload"
fi
echo ""

# Build GPU VMAF command
echo "4. Building GPU VMAF command..."
LOG_PATH="$CACHE_DIR/vmaf_test.json"
MODEL_PARAM=""
if [ -f "$MODEL_PATH" ]; then
    MODEL_PARAM=":model=path=$MODEL_PATH"
    echo "   Using VMAF model: $MODEL_PATH"
else
    echo "   ⚠️  Model file not found, using default"
fi
echo ""

# Build command parts
CMD_PARTS=(
    "$FFMPEG_PATH"
    "-init_hw_device" "cuda=cuda0:0"
    "-filter_hw_device" "cuda0"
    "-hwaccel" "cuda"
    "-hwaccel_device" "0"
    "-hwaccel_output_format" "cuda"
    "-c:v" "av1_cuvid"
    "-i" "$DISTORTED_FILE"
)

# Always use software decode for reference file (more reliable with container formats)
# Distorted file uses CUVID, reference uses software decode + hwupload
# Use regular scale for reference (scale_cuda may have PTX version issues with some GPUs)
CMD_PARTS+=("-i" "$REFERENCE_FILE")
FILTER_COMPLEX="[0:v]scale_cuda=format=yuv420p[dis];[1:v]scale=format=yuv420p,hwupload_cuda[ref];[dis][ref]libvmaf_cuda=log_path=$LOG_PATH:log_fmt=json$MODEL_PARAM"

CMD_PARTS+=(
    "-filter_complex" "$FILTER_COMPLEX"
    "-f" "null"
    "-"
)

echo "5. Executing GPU VMAF command..."
echo "   Command: ${CMD_PARTS[*]}"
echo ""

# Execute command
START_TIME=$(date +%s)
if "${CMD_PARTS[@]}" 2>&1 | tee "$CACHE_DIR/ffmpeg_output.log"; then
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    echo ""
    echo "   ✅ GPU VMAF command succeeded in ${DURATION}s"

    # Check if log file was created and parse results
    if [ -f "$LOG_PATH" ]; then
        echo ""
        echo "6. Parsing VMAF results..."
        if command -v jq &> /dev/null; then
            echo "   VMAF Results:"
            jq -r '.pooled_metrics.vmaf // .aggregate_metrics.vmaf // "N/A"' "$LOG_PATH" 2>/dev/null || echo "   Could not parse JSON"
        else
            echo "   Log file created: $LOG_PATH"
            echo "   (Install jq to parse JSON results)"
        fi
    else
        echo "   ⚠️  Warning: VMAF log file not created at $LOG_PATH"
    fi
else
    END_TIME=$(date +%s)
    DURATION=$((END_TIME - START_TIME))
    echo ""
    echo "   ❌ GPU VMAF command FAILED after ${DURATION}s"
    echo ""
    echo "   Error output saved to: $CACHE_DIR/ffmpeg_output.log"
    echo ""
    echo "   Last 50 lines of error:"
    tail -50 "$CACHE_DIR/ffmpeg_output.log" | grep -v "ffmpeg version" | grep -v "Copyright" | grep -v "built with" | grep -v "configuration:" | grep -v "libav" | tail -20
    exit 1
fi

echo ""
echo "=== Test Complete ==="
echo "Log file: $LOG_PATH"
echo "Output log: $CACHE_DIR/ffmpeg_output.log"
