#!/bin/bash
TEST=$(find /temp -name 'test_gpu_*.mkv' -type f 2>/dev/null | head -1)
ORIG=$(find /temp -name '*postbot_sample*.mkv' -type f 2>/dev/null | head -1)

if [ -z "$TEST" ] || [ -z "$ORIG" ]; then
    echo "Test files not found"
    exit 1
fi

FFMPEG="/usr/local/ffmpeg-custom/bin/ffmpeg"
MODEL_PARAM=":model=path=/usr/local/share/model/vmaf_v0.6.1.json"
LOG_PATH="/tmp/test_vmaf_gpu.json"

echo "=== Test 1: av1_cuvid decoder ==="
"$FFMPEG" -hide_banner -hwaccel cuda -hwaccel_device 0 -hwaccel_output_format cuda -c:v av1_cuvid -i "$TEST" -f null - 2>&1 | head -15

echo ""
echo "=== Test 2: av1_cuvid with VMAF (full command) ==="
"$FFMPEG" -hide_banner -hwaccel cuda -hwaccel_device 0 -hwaccel_output_format cuda -c:v av1_cuvid -i "$TEST" -i "$ORIG" \
    -filter_complex "[0:v]hwdownload,format=yuv420p[decoded];[1:v]format=yuv420p[ref];[decoded][ref]libvmaf=log_path=$LOG_PATH:log_fmt=json$MODEL_PARAM" \
    -f null - 2>&1 | head -20

echo ""
echo "=== Test 3: hwaccel cuda without explicit decoder ==="
"$FFMPEG" -hide_banner -hwaccel cuda -hwaccel_device 0 -hwaccel_output_format cuda -i "$TEST" -f null - 2>&1 | head -15
