#!/bin/bash
# Test CUVID decode and libvmaf_cuda separately

echo "=== CUVID Decode and libvmaf_cuda Diagnostic ==="
echo ""

# Find test files
REF=$(find /temp -name '*sample*.mkv' -type f 2>/dev/null | head -1)
DIST=$(find /temp -name 'test_*.mkv' -type f 2>/dev/null | head -1)

if [ -z "$REF" ] || [ -z "$DIST" ]; then
    echo "⚠️  No existing test files found, using simple test patterns"
    REF="testsrc=duration=1:size=1920x1080:rate=30"
    DIST="testsrc2=duration=1:size=1920x1080:rate=30"
    USE_LAVFI=1
else
    echo "Found test files:"
    echo "  Reference: $REF"
    echo "  Distorted: $DIST"
    USE_LAVFI=0
fi

echo ""
echo "1. Testing CUVID decode on reference file..."
if [ "$USE_LAVFI" = "0" ]; then
    REF_CODEC=$(tdarr-ffmpeg -hide_banner -i "$REF" 2>&1 | grep -i "Video:" | head -1 | sed 's/.*Video: \([^,]*\).*/\1/' | tr -d ' ' || echo "h264")
    echo "   Codec: $REF_CODEC"

    case "$REF_CODEC" in
        h264) CUVID="h264_cuvid" ;;
        hevc|h265) CUVID="hevc_cuvid" ;;
        av1) CUVID="av1_cuvid" ;;
        *) CUVID="h264_cuvid" ;;
    esac

    echo "   Testing with: $CUVID"
    if tdarr-ffmpeg -init_hw_device cuda=cuda0:0 -filter_hw_device cuda0 \
        -hwaccel cuda -hwaccel_device 0 -hwaccel_output_format cuda \
        -c:v "$CUVID" -i "$REF" -frames:v 5 -f null - 2>&1 | tee /tmp/cuvid_test.log | grep -q "frame="; then
        echo "   ✅ CUVID decode SUCCESS"
    else
        echo "   ❌ CUVID decode FAILED"
        echo "   Error details:"
        grep -i "error\|invalid\|failed\|extradata\|nal" /tmp/cuvid_test.log | head -5
    fi
else
    echo "   ⏭️  Skipping (using test pattern)"
    CUVID="h264_cuvid"
fi

echo ""
echo "2. Testing libvmaf_cuda filter..."
if tdarr-ffmpeg -init_hw_device cuda=cuda0:0 -filter_hw_device cuda0 \
    -f lavfi -i testsrc=duration=1:size=1920x1080:rate=30 \
    -f lavfi -i testsrc2=duration=1:size=1920x1080:rate=30 \
    -filter_complex '[0:v]format=yuv420p,hwupload_cuda[dis];[1:v]format=yuv420p,hwupload_cuda[ref];[dis][ref]libvmaf_cuda=log_path=/tmp/test_libvmaf_cuda.json:log_fmt=json' \
    -f null - 2>&1 | tee /tmp/libvmaf_test.log | grep -q "frame="; then
    echo "   ✅ libvmaf_cuda SUCCESS"
    if [ -f /tmp/test_libvmaf_cuda.json ]; then
        echo "   VMAF log created: /tmp/test_libvmaf_cuda.json"
        if command -v jq &> /dev/null; then
            echo "   VMAF score: $(jq -r '.pooled_metrics.vmaf.harmonic_mean // .aggregate_metrics.vmaf // "N/A"' /tmp/test_libvmaf_cuda.json 2>/dev/null)"
        fi
    fi
else
    echo "   ❌ libvmaf_cuda FAILED"
    echo "   Error details:"
    grep -i "error\|invalid\|failed\|ptx" /tmp/libvmaf_test.log | head -5
fi

echo ""
echo "3. Testing full GPU VMAF pipeline with CUVID decode..."
if [ -n "$REF" ] && [ -n "$DIST" ]; then
    LOG="/tmp/full_gpu_vmaf_test.json"
    CMD="tdarr-ffmpeg -init_hw_device cuda=cuda0:0 -filter_hw_device cuda0 \
        -hwaccel cuda -hwaccel_device 0 -hwaccel_output_format cuda -c:v av1_cuvid -i \"$DIST\" \
        -hwaccel cuda -hwaccel_device 0 -hwaccel_output_format cuda -c:v $CUVID -i \"$REF\" \
        -filter_complex '[0:v]format=yuv420p,hwupload_cuda[dis];[1:v]format=yuv420p,hwupload_cuda[ref];[dis][ref]libvmaf_cuda=log_path=$LOG:log_fmt=json' \
        -f null -"

    if eval "$CMD" 2>&1 | tee /tmp/full_test.log | grep -q "frame="; then
        echo "   ✅ Full GPU VMAF pipeline SUCCESS"
        if [ -f "$LOG" ]; then
            echo "   VMAF log: $LOG"
        fi
    else
        echo "   ❌ Full GPU VMAF pipeline FAILED"
        echo "   Error details:"
        grep -i "error\|invalid\|failed\|ptx\|scale_cuda" /tmp/full_test.log | head -5
    fi
fi

echo ""
echo "=== Diagnostic Complete ==="
