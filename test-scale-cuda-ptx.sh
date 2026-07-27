#!/bin/bash
# Quick test to check if scale_cuda works or fails with PTX errors

echo "=== Testing scale_cuda for PTX compatibility ==="
echo ""

export LD_LIBRARY_PATH=/usr/local/ffmpeg-custom/lib:/usr/local/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/lib:$LD_LIBRARY_PATH

echo "1. Testing scale_cuda filter..."
echo "   Command: tdarr-ffmpeg -init_hw_device cuda=cuda0:0 -filter_hw_device cuda0 -hwaccel cuda -hwaccel_device 0 -hwaccel_output_format cuda -f lavfi -i testsrc=duration=1:size=1920x1080:rate=30 -vf 'scale_cuda=format=yuv420p' -f null -"
echo ""

OUTPUT=$(timeout 15 tdarr-ffmpeg -init_hw_device cuda=cuda0:0 -filter_hw_device cuda0 \
    -hwaccel cuda -hwaccel_device 0 -hwaccel_output_format cuda \
    -f lavfi -i testsrc=duration=1:size=1920x1080:rate=30 \
    -vf 'scale_cuda=format=yuv420p' \
    -f null - 2>&1)

EXIT_CODE=$?

echo "Exit code: $EXIT_CODE"
echo ""
echo "Output (last 30 lines):"
echo "$OUTPUT" | tail -30
echo ""

# Check for specific errors
if echo "$OUTPUT" | grep -qi "CUDA_ERROR_UNSUPPORTED_PTX_VERSION\|unsupported PTX version\|PTX version"; then
    echo "❌ PTX VERSION ERROR DETECTED"
    echo "   scale_cuda is not compatible with this GPU (likely RTX 50 series)"
    echo "   Solution: Use hwdownload,format=yuv420p,hwupload_cuda fallback"
    exit 1
elif echo "$OUTPUT" | grep -qi "scale_cuda.*error\|Error.*scale_cuda"; then
    echo "❌ scale_cuda FILTER ERROR"
    echo "   scale_cuda failed to initialize or execute"
    exit 1
elif [ $EXIT_CODE -eq 0 ]; then
    echo "✅ scale_cuda WORKING"
    echo "   scale_cuda filter is compatible with this GPU"
    exit 0
else
    echo "⚠️  scale_cuda TEST INCONCLUSIVE"
    echo "   Check output above for details"
    exit 2
fi
