#!/bin/bash
# Setup build environment for reproducible FFmpeg/libvmaf builds
# Ensures all build tools and dependencies are available

echo "=== Build Environment Setup ==="

# Ensure build scripts directory exists and is accessible
if [ -d "/usr/local/build-scripts" ]; then
    echo "✅ Build scripts available at /usr/local/build-scripts"
    ls -1 /usr/local/build-scripts/*.sh 2>/dev/null | while read script; do
        chmod +x "$script" 2>/dev/null || true
        echo "   - $(basename $script)"
    done
else
    echo "⚠️  Build scripts directory not found"
    echo "   Mount ./build-scripts to /usr/local/build-scripts in docker-compose.yml"
fi

# Ensure build workspace exists
mkdir -p /tmp/ffmpeg-build
echo "✅ Build workspace: /tmp/ffmpeg-build"

# Set up environment variables for builds
export PATH="/usr/local/cuda-13.0/bin:/usr/local/cuda-13.1/bin:/usr/local/cuda/bin:/usr/local/ffmpeg-custom/bin:$PATH"
export PKG_CONFIG_PATH="/usr/local/lib/x86_64-linux-gnu/pkgconfig:/usr/local/lib/pkgconfig:$PKG_CONFIG_PATH"
export LD_LIBRARY_PATH="/usr/local/ffmpeg-custom/lib:/usr/local/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/lib:$LD_LIBRARY_PATH"

# Check for CUDA toolkits
echo ""
echo "CUDA Toolkit Availability:"
for cuda_ver in 13.1 13.0 12.6; do
    if [ -f "/usr/local/cuda-${cuda_ver}/bin/nvcc" ]; then
        echo "   ✅ CUDA ${cuda_ver} at /usr/local/cuda-${cuda_ver}"
    fi
done

if [ -f "/usr/local/cuda/bin/nvcc" ]; then
    CUDA_LINK=$(readlink -f /usr/local/cuda 2>/dev/null || echo "/usr/local/cuda")
    echo "   ✅ /usr/local/cuda -> $CUDA_LINK"
fi

# Check for build dependencies
echo ""
echo "Build Dependencies:"
for tool in git meson ninja nasm pkg-config python3 nvcc; do
    if command -v $tool &> /dev/null; then
        echo "   ✅ $tool: $(command -v $tool)"
    else
        echo "   ⚠️  $tool: not found"
    fi
done

echo ""
echo "=== Build Environment Setup Complete ==="
