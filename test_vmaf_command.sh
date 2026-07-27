#!/bin/bash
# Test script to diagnose VMAF calculation command issues

TEST_FILE="$1"
ORIG_FILE="$2"

if [ -z "$TEST_FILE" ] || [ -z "$ORIG_FILE" ]; then
    echo "Usage: $0 <test_file> <original_file>"
    exit 1
fi

FFMPEG="/usr/local/ffmpeg-custom/bin/ffmpeg"
MODEL_PARAM=":model=path=/usr/local/share/model/vmaf_v0.6.1.json"
LOG_PATH="/tmp/test_vmaf.json"

echo "=== Test 1: Current command (hwaccel none -c:v av1) ==="
"$FFMPEG" -hide_banner -hwaccel none -c:v av1 -i "$TEST_FILE" -i "$ORIG_FILE" \
    -lavfi "libvmaf=log_path=$LOG_PATH:log_fmt=json$MODEL_PARAM" \
    -f null - 2>&1 | head -20

echo ""
echo "=== Test 2: Explicitly disable hardware devices ==="
"$FFMPEG" -hide_banner -init_hw_device none -hwaccel none -c:v av1 -i "$TEST_FILE" -i "$ORIG_FILE" \
    -lavfi "libvmaf=log_path=$LOG_PATH:log_fmt=json$MODEL_PARAM" \
    -f null - 2>&1 | head -20

echo ""
echo "=== Test 3: Use threads to force software ==="
"$FFMPEG" -hide_banner -threads 0 -hwaccel none -c:v av1 -i "$TEST_FILE" -i "$ORIG_FILE" \
    -lavfi "libvmaf=log_path=$LOG_PATH:log_fmt=json$MODEL_PARAM" \
    -f null - 2>&1 | head -20

echo ""
echo "=== Test 4: Decoder before input ==="
"$FFMPEG" -hide_banner -hwaccel none -i "$TEST_FILE" -c:v av1 -i "$ORIG_FILE" \
    -lavfi "libvmaf=log_path=$LOG_PATH:log_fmt=json$MODEL_PARAM" \
    -f null - 2>&1 | head -20
