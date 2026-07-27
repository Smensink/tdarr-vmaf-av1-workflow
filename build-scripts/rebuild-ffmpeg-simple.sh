#!/bin/bash
# Simple FFmpeg rebuild with NVENC, NVDEC, CUVID, and libvmaf_cuda
# Uses whatever compute capability nvcc supports - no specific version required

set -e

echo "=========================================="
echo "Building FFmpeg with NVENC + libvmaf_cuda"
echo "=========================================="
echo ""

# Find CUDA
if [ -f "/usr/local/cuda-13.1/bin/nvcc" ]; then
    export PATH="/usr/local/cuda-13.1/bin:$PATH"
    export CUDA_PATH="/usr/local/cuda-13.1"
elif [ -f "/usr/local/cuda-13.0/bin/nvcc" ]; then
    export PATH="/usr/local/cuda-13.0/bin:$PATH"
    export CUDA_PATH="/usr/local/cuda-13.0"
elif [ -f "/usr/local/cuda/bin/nvcc" ]; then
    export PATH="/usr/local/cuda/bin:$PATH"
    export CUDA_PATH="/usr/local/cuda"
elif [ -f "/usr/bin/nvcc" ]; then
    export CUDA_PATH="/usr"
else
    echo "ERROR: nvcc not found"
    exit 1
fi

export CUDA_HOME="$CUDA_PATH"
export PATH="$PATH:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export LD_LIBRARY_PATH="${CUDA_PATH}/lib64:/usr/local/lib/x86_64-linux-gnu:/usr/local/lib:$LD_LIBRARY_PATH"
export PKG_CONFIG_PATH="/usr/local/lib/pkgconfig:/usr/local/lib/x86_64-linux-gnu/pkgconfig:$PKG_CONFIG_PATH"

echo "Using CUDA at: $CUDA_PATH"
nvcc --version 2>&1 | head -1

WORKDIR="/tmp/ffmpeg-build"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

# Build libvmaf with CUDA (use master branch, no specific version)
echo "[1/3] Building libvmaf with CUDA..."
if [ ! -d "vmaf" ]; then
    git clone --depth=1 https://github.com/Netflix/vmaf.git
fi
cd vmaf/libvmaf
rm -rf build

# Build with CUDA - let meson handle PTX automatically
meson setup build --buildtype release \
    -Denable_cuda=true \
    -Dbuilt_in_models=true \
    -Denable_tests=false \
    -Denable_docs=false

ninja -C build
ninja -C build install
ldconfig 2>/dev/null || true
cd "$WORKDIR"

# Install nv-codec-headers
echo "[2/3] Installing nv-codec-headers..."
if [ ! -d "nv-codec-headers" ]; then
    git clone --depth=1 https://git.videolan.org/git/ffmpeg/nv-codec-headers.git
fi
cd nv-codec-headers
make install
cd "$WORKDIR"

# Build FFmpeg
echo "[3/3] Building FFmpeg..."
if [ ! -d "ffmpeg-latest" ]; then
    git clone --depth=1 --branch n7.0 https://git.ffmpeg.org/ffmpeg.git ffmpeg-latest
fi
cd ffmpeg-latest

make distclean 2>/dev/null || true

# Find nvcc and set environment variables
NVCC_BIN=$(which nvcc 2>/dev/null || echo "${CUDA_PATH}/bin/nvcc")
if [ ! -f "$NVCC_BIN" ]; then
    echo "ERROR: nvcc not found at $NVCC_BIN"
    exit 1
fi

echo "Using nvcc at: $NVCC_BIN"
export NVCC="$NVCC_BIN"
export PATH="${CUDA_PATH}/bin:$PATH"

# Configure FFmpeg - simple, no compute_120 complexity
# Use standard compute capability that nvcc supports
# Ensure all environment variables are exported and PATH is set
export PATH="${CUDA_PATH}/bin:$PATH"
export CUDA_PATH="${CUDA_PATH}"
export CUDA_HOME="${CUDA_PATH}"
export NVCC="${NVCC_BIN}"

echo "Environment check:"
echo "  PATH: $PATH"
echo "  NVCC: $NVCC"
echo "  CUDA_PATH: $CUDA_PATH"
which nvcc || echo "WARNING: nvcc not in PATH"
nvcc --version 2>&1 | head -1 || echo "WARNING: nvcc not working"

# FFmpeg's configure test uses compute_60 by default, but this nvcc may not support it
# Use a supported architecture for the test (sm_75 is widely supported)
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
    --extra-ldflags="-L/usr/lib/x86_64-linux-gnu -L${CUDA_PATH}/lib64 -Wl,-rpath,${CUDA_PATH}/lib64 -lcudart" \
    --extra-libs="-lcudart" \
    --nvccflags="-gencode arch=compute_75,code=sm_75" \
    > /tmp/ffmpeg-config.log 2>&1

if [ $? -ne 0 ]; then
    echo "ERROR: FFmpeg configure failed. Check /tmp/ffmpeg-config.log"
    tail -30 /tmp/ffmpeg-config.log
    echo ""
    echo "Checking config.log for details:"
    cd /tmp/ffmpeg-build/ffmpeg-latest
    test -f ffbuild/config.log && tail -50 ffbuild/config.log | grep -A 10 -B 5 'nvcc' || echo "No detailed config.log"
    exit 1
fi

# ============================================================================
# CRITICAL FIX: Rebuild scale_cuda PTX with CUDA 13.0 nvcc
# ============================================================================
# Problem: scale_cuda PTX compiled with CUDA 12.0 nvcc causes
#          CUDA_ERROR_UNSUPPORTED_PTX_VERSION on drivers supporting CUDA 13.0
# Solution: Explicitly rebuild PTX with CUDA 13.0 nvcc to match driver version
#
# This fix ensures the PTX version matches the driver's supported CUDA version.
# Check driver version with: nvidia-smi | grep "CUDA Version"
#
# See GPU_VMAF_FIX.md for detailed documentation
# ============================================================================
if [ -f "ffbuild/config.mak" ] && [ -f "/usr/local/cuda-13.0/bin/nvcc" ]; then
    echo "Rebuilding scale_cuda PTX with CUDA 13.0 nvcc (matches driver CUDA version)..."
    if [ -f "libavfilter/vf_scale_cuda.cu" ]; then
        /usr/local/cuda-13.0/bin/nvcc -gencode arch=compute_90,code=compute_90 -std=c++11 -m64 -allow-unsupported-compiler -ptx -c -o libavfilter/vf_scale_cuda.ptx libavfilter/vf_scale_cuda.cu
        echo "✅ Rebuilt scale_cuda PTX with CUDA 13.0"
        echo "   PTX target: compute_90 (forward compatible with RTX 50 series)"
    else
        echo "⚠️  Warning: libavfilter/vf_scale_cuda.cu not found - PTX rebuild skipped"
    fi
else
    if [ ! -f "/usr/local/cuda-13.0/bin/nvcc" ]; then
        echo "⚠️  Warning: CUDA 13.0 nvcc not found at /usr/local/cuda-13.0/bin/nvcc"
        echo "   scale_cuda PTX will be built with default nvcc (may cause PTX version errors)"
        echo "   Check driver CUDA version: nvidia-smi | grep 'CUDA Version'"
    fi
fi

# Build
echo "Building FFmpeg (30-60 minutes)..."
CORES=$(nproc 2>/dev/null || echo 4)
make -j${CORES}

# Install
echo "Installing FFmpeg..."
make install
ldconfig 2>/dev/null || true

echo ""
echo "=========================================="
echo "✅ Build Complete!"
echo "=========================================="
/usr/local/ffmpeg-custom/bin/ffmpeg -version | head -3
echo ""
/usr/local/ffmpeg-custom/bin/ffmpeg -filters 2>&1 | grep -E 'libvmaf_cuda|libvmaf[^_]'
echo ""
