#!/bin/bash
# Rebuild FFmpeg with compute capability 12.0 support for libvmaf_cuda
# This script rebuilds both libvmaf and FFmpeg with compute 12.0 support
# Run this inside the Docker container: docker exec -it tdarr bash /path/to/this/script.sh

set -e

echo "=========================================="
echo "Rebuilding FFmpeg with Compute 12.0 Support"
echo "=========================================="
echo ""

# Ensure PATH includes essential directories (prefer CUDA 13.1 for compute_120 support)
# Check for CUDA 13.1 first (required for RTX 50 series compute_120)
if [ -f "/usr/local/cuda-13.1/bin/nvcc" ]; then
    export PATH="/usr/local/cuda-13.1/bin:$PATH"
    export CUDA_PATH="/usr/local/cuda-13.1"
    export CUDA_HOME="/usr/local/cuda-13.1"
    echo "✅ Found CUDA 13.1 at /usr/local/cuda-13.1 (supports compute_120)"
elif [ -f "/usr/local/cuda-13.0/bin/nvcc" ]; then
    export PATH="/usr/local/cuda-13.0/bin:$PATH"
    export CUDA_PATH="/usr/local/cuda-13.0"
    export CUDA_HOME="/usr/local/cuda-13.0"
    echo "⚠️  Using CUDA 13.0 (may not support compute_120)"
else
    export PATH="/usr/local/cuda/bin:$PATH"
    export CUDA_PATH="/usr/local/cuda"
    export CUDA_HOME="/usr/local/cuda"
fi
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Find and add xxd to PATH if not already there
if ! command -v xxd &> /dev/null; then
    XXD_PATH=$(find /usr /bin -name xxd -type f 2>/dev/null | head -1)
    if [ -n "$XXD_PATH" ]; then
        export PATH="$(dirname $XXD_PATH):$PATH"
        echo "Found xxd at: $XXD_PATH, added to PATH"
    fi
fi

# Set CUDA library paths (use detected CUDA_PATH)
export LD_LIBRARY_PATH="${CUDA_PATH}/lib64:/usr/local/lib/x86_64-linux-gnu:/usr/local/lib:$LD_LIBRARY_PATH"
export PKG_CONFIG_PATH="/usr/local/lib/pkgconfig:/usr/local/lib/x86_64-linux-gnu/pkgconfig:$PKG_CONFIG_PATH"

# Ensure we have all necessary tools
if ! command -v git &> /dev/null; then
    # Try to find git in common locations
    for git_path in /usr/bin/git /usr/local/bin/git; do
        if [ -x "$git_path" ]; then
            export PATH="$(dirname $git_path):$PATH"
            break
        fi
    done
fi

# Verify nvcc is accessible (should already be in PATH from above)
# If not found, check system locations
if ! command -v nvcc &> /dev/null; then
    if [ -f "/usr/bin/nvcc" ] || [ -f "/usr/lib/nvidia-cuda-toolkit/bin/nvcc" ]; then
        echo "CUDA toolkit found (nvidia-cuda-toolkit package)"
        export CUDA_PATH="/usr"
        export CUDA_HOME="/usr"
        export PATH="/usr/bin:/usr/lib/nvidia-cuda-toolkit/bin:$PATH"
        export LD_LIBRARY_PATH="/usr/lib/nvidia-cuda-toolkit/lib64:/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH"
    else
        echo "⚠️  nvcc not found in PATH, but CUDA_PATH is set to: $CUDA_PATH"
    fi
fi

# Verify nvcc is available
if ! command -v nvcc &> /dev/null; then
    echo "ERROR: nvcc not found in PATH. CUDA toolkit may not be properly installed."
    echo "Please ensure nvidia-cuda-toolkit package is installed."
    exit 1
fi

echo "Using CUDA at: $CUDA_PATH"
nvcc --version 2>&1 | head -3

WORKDIR="/tmp/ffmpeg-build"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

# Step 1: Rebuild libvmaf with compute 12.0 PTX
echo "[1/4] Rebuilding libvmaf with compute 12.0 support..."
if [ ! -d "vmaf" ]; then
    git clone https://github.com/Netflix/vmaf.git
fi
cd vmaf
# Use master branch (latest) - v3.0.0 tag may not exist
git checkout master || git checkout main || true
git pull origin master || git pull origin main || true
cd libvmaf

# Patch meson.build to use compute_120 for PTX generation
if [ ! -f "src/meson.build.bak" ]; then
    cp src/meson.build src/meson.build.bak
fi

# Check what compute capabilities are supported by nvcc
echo "Checking supported compute capabilities..."
NVCC_VERSION=$(nvcc --version 2>&1 | grep "release" | sed 's/.*release \([0-9]\+\.[0-9]\+\).*/\1/' || echo "unknown")
echo "CUDA version: $NVCC_VERSION"

# Check if nvcc supports compute_120/sm_120 (requires CUDA 13.1+)
PTX_ARCH="compute_120"
PTX_CODE="compute_120"

if nvcc --list-gpu-code 2>&1 | grep -qE "sm_120|compute_120"; then
    echo "✅ CUDA supports compute_120/sm_120 - using for RTX 50 series"
    PTX_ARCH="compute_120"
    PTX_CODE="compute_120"
elif nvcc --list-gpu-code 2>&1 | grep -qE "sm_121|compute_121"; then
    echo "✅ CUDA supports compute_121/sm_121 - using for RTX 50 series"
    PTX_ARCH="compute_121"
    PTX_CODE="compute_121"
elif nvcc --list-gpu-code 2>&1 | grep -qE "sm_100|compute_100"; then
    echo "⚠️  CUDA 12.4+ detected but compute_120 not available"
    echo "   RTX 50 series requires CUDA 13.1+ with compute_120 support"
    echo "   Using compute_100 as fallback (may not work with RTX 50)"
    PTX_ARCH="compute_100"
    PTX_CODE="compute_100"
elif nvcc --list-gpu-code 2>&1 | grep -qE "sm_90|compute_90"; then
    echo "⚠️  CUDA 12.0 detected - compute_120 not available"
    echo "   RTX 50 series requires CUDA 13.1+ with compute_120 support"
    echo "   Using compute_90 as fallback (will NOT work with RTX 50 - will use plugin fallback)"
    PTX_ARCH="compute_90"
    PTX_CODE="compute_90"
else
    echo "⚠️  Warning: Could not detect compute capabilities"
    echo "   Attempting to use compute_120 (build may fail if unsupported)"
    PTX_ARCH="compute_120"
    PTX_CODE="compute_120"
fi

echo "Using PTX arch: $PTX_ARCH, code: $PTX_CODE for libvmaf"

# Export PTX_ARCH and PTX_CODE for Python script
export PTX_ARCH="$PTX_ARCH"
export PTX_CODE="$PTX_CODE"

# Apply patch using Python
python3 << PYTHON_SCRIPT
import re
import os
ptx_arch = os.environ.get('PTX_ARCH', 'compute_90')
ptx_code = os.environ.get('PTX_CODE', 'compute_90')
with open('src/meson.build', 'r') as f:
    content = f.read()
old_str = "command : [nvcc_exe, '--ptx', '@INPUT@', '-o', '@OUTPUT@' ,"
new_str = f"command : [nvcc_exe, '--ptx', '-arch={ptx_arch}', '-code={ptx_code}', '@INPUT@', '-o', '@OUTPUT@' ,"
if old_str in content:
    content = content.replace(old_str, new_str)
    with open('src/meson.build', 'w') as f:
        f.write(content)
    print(f"Patched meson.build for {ptx_arch}")
else:
    print("Pattern not found - may already be patched")
PYTHON_SCRIPT

# Rebuild libvmaf
rm -rf build

# Find nvcc explicitly and ensure it's in PATH
NVCC_BIN=$(which nvcc 2>/dev/null || echo "${CUDA_PATH}/bin/nvcc")
if [ ! -f "$NVCC_BIN" ]; then
    # Try common locations
    for loc in "/usr/local/cuda-13.1/bin/nvcc" "/usr/local/cuda/bin/nvcc" "/usr/bin/nvcc"; do
        if [ -f "$loc" ]; then
            NVCC_BIN="$loc"
            break
        fi
    done
fi

if [ ! -f "$NVCC_BIN" ]; then
    echo "❌ ERROR: nvcc not found. Cannot build libvmaf with CUDA support."
    exit 1
fi

echo "Using nvcc at: $NVCC_BIN"
export NVCC="$NVCC_BIN"
# Ensure nvcc is in PATH for meson to find
export PATH="$(dirname $NVCC_BIN):$PATH"

meson setup build --buildtype release \
    -Denable_cuda=true \
    -Denable_float=true \
    -Denable_tests=false \
    -Denable_docs=false

ninja -C build
ninja -C build install
ldconfig 2>/dev/null || true
cd "$WORKDIR"

# Step 2: Rebuild FFmpeg with compute 12.0
echo ""
echo "[2/4] Rebuilding FFmpeg with compute 12.0 support..."
FFMPEG_DIR="ffmpeg-latest"
if [ ! -d "$FFMPEG_DIR" ]; then
    # Use FFmpeg 7.0 branch for stability (master may have build issues)
    git clone --depth 1 --branch n7.0 https://git.ffmpeg.org/ffmpeg.git "$FFMPEG_DIR" || \
    git clone --depth 1 --branch master https://git.ffmpeg.org/ffmpeg.git "$FFMPEG_DIR"
fi
cd "$FFMPEG_DIR"
# Use stable branch instead of master
git fetch origin n7.0 2>/dev/null || git fetch origin master 2>/dev/null || true
git checkout n7.0 2>/dev/null || git checkout master 2>/dev/null || true

# Clean previous build completely
make distclean 2>/dev/null || make clean 2>/dev/null || true
git clean -fdx 2>/dev/null || true
git checkout -- ffbuild/ 2>/dev/null || true

# Configure FFmpeg
# Ensure nvcc is in PATH for configure script
export PATH="${CUDA_PATH}/bin:$PATH"
export CUDA_PATH="${CUDA_PATH}"
export CUDA_HOME="${CUDA_PATH}"

# Verify nvcc is accessible before configure
if ! command -v nvcc &> /dev/null; then
    echo "❌ ERROR: nvcc not found in PATH. Cannot configure FFmpeg with CUDA support."
    echo "   CUDA_PATH: $CUDA_PATH"
    echo "   PATH: $PATH"
    exit 1
fi

echo "Verifying nvcc before configure..."
nvcc --version 2>&1 | head -1
echo "Using CUDA at: $CUDA_PATH"

export PKG_CONFIG_PATH="/usr/local/lib/pkgconfig:/usr/local/lib/x86_64-linux-gnu/pkgconfig:$PKG_CONFIG_PATH"

# Get absolute path to nvcc
NVCC_ABS=$(command -v nvcc 2>/dev/null || echo "${CUDA_PATH}/bin/nvcc")
if [ ! -f "$NVCC_ABS" ]; then
    echo "❌ ERROR: nvcc not found at $NVCC_ABS"
    exit 1
fi

echo "Using nvcc at: $NVCC_ABS"

# Configure FFmpeg - explicitly set CUDA paths and ensure nvcc is found
# NOTE: FFmpeg's configure test uses --ptx which doesn't work with multiple architectures
# So we use a single architecture for the test, then apply all architectures during build
PATH="${CUDA_PATH}/bin:$PATH" \
CUDA_PATH="${CUDA_PATH}" \
CUDA_HOME="${CUDA_PATH}" \
NVCC="${NVCC_ABS}" \
./configure \
    --prefix=/usr/local/ffmpeg-custom \
    --enable-gpl \
    --enable-version3 \
    --enable-nonfree \
    --enable-static \
    --enable-shared \
    --enable-libvmaf \
    --enable-nvdec \
    --enable-nvenc \
    --enable-cuda \
    --enable-cuda-nvcc \
    --enable-cuvid \
    --extra-cflags="-I/usr/local/include/ffnvcodec -I${CUDA_PATH}/include" \
    --extra-ldflags="-L/usr/lib/x86_64-linux-gnu -L${CUDA_PATH}/lib64 -lcudart" \
    --nvccflags="-gencode arch=compute_120,code=sm_120" \
    > /tmp/ffmpeg-config.log 2>&1

# After configure succeeds, we need to handle PTX vs SASS differently
# PTX can only use one architecture (we use compute_120, forward compatible)
# SASS can use multiple architectures
# FFmpeg's build system uses NVCCFLAGS for both, so we need to modify it
if [ -f "ffbuild/config.mak" ]; then
    echo "Updating config.mak for PTX compatibility..."
    # The issue: FFmpeg adds -ptx to NVCCFLAGS for PTX generation
    # nvcc doesn't allow -ptx with multiple architectures
    # Solution: Use only compute_120 for PTX (forward compatible PTX)
    # PTX from compute_120 will work on all newer GPUs including RTX 50 series
    # Remove the multiple architectures - PTX is forward compatible
    sed -i 's/NVCCFLAGS=.*-ptx/NVCCFLAGS=-gencode arch=compute_120,code=compute_120 -std=c++11 -m64 -ptx/g' ffbuild/config.mak
    # For non-PTX builds (SASS), we can use multiple architectures
    # But FFmpeg's build system uses the same flags, so we'll stick with compute_120 PTX
    # Update the configuration string too
    sed -i "s/--nvccflags='-gencode arch=compute_120,code=sm_120'/--nvccflags='-gencode arch=compute_120,code=compute_120'/g" ffbuild/config.mak
    echo "✅ Updated config.mak to use compute_120 PTX (forward compatible)"
    echo "   PTX from compute_120 will work on RTX 50 series and newer GPUs"
fi

# Build FFmpeg
echo "[3/4] Building FFmpeg (this will take 30-60 minutes)..."
CORES=$(nproc 2>/dev/null || echo "4")
make -j${CORES} > /tmp/ffmpeg-build.log 2>&1

# Step 3: Install to persistent location
echo ""
echo "[4/4] Installing FFmpeg to persistent location..."
INSTALL_DIR="/usr/local/ffmpeg-custom"
mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/lib"

# Install directly to persistent location (mounted from ./custom-ffmpeg on host)
make install > /dev/null 2>&1 || {
    echo "Warning: make install failed, trying DESTDIR method..."
    make DESTDIR=/tmp/ffmpeg-install install > /dev/null 2>&1
    cp /tmp/ffmpeg-install/usr/local/ffmpeg-custom/bin/ffmpeg "$INSTALL_DIR/bin/" 2>/dev/null || true
    cp /tmp/ffmpeg-install/usr/local/ffmpeg-custom/bin/ffprobe "$INSTALL_DIR/bin/" 2>/dev/null || true
    cp -a /tmp/ffmpeg-install/usr/local/ffmpeg-custom/lib/*.so* "$INSTALL_DIR/lib/" 2>/dev/null || true
}

chmod +x "$INSTALL_DIR/bin"/* 2>/dev/null || true
ldconfig 2>/dev/null || true

# Verify build
echo ""
echo "=========================================="
echo "Build Complete! Verifying..."
echo "=========================================="
export LD_LIBRARY_PATH="$INSTALL_DIR/lib:/usr/local/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/lib:$LD_LIBRARY_PATH"
"$INSTALL_DIR/bin/ffmpeg" -version | head -3
echo ""

if "$INSTALL_DIR/bin/ffmpeg" -hide_banner -filters 2>&1 | grep -q "libvmaf_cuda"; then
    echo "✅ libvmaf_cuda filter: ENABLED"
else
    echo "❌ libvmaf_cuda filter: NOT FOUND"
fi

echo ""
echo "FFmpeg installed to: $INSTALL_DIR (persistent in ./custom-ffmpeg on host)"
echo ""
echo "The init script will automatically use this FFmpeg on container restart"
echo "=========================================="
