#!/bin/bash
# Setup libvmaf libraries and ensure they're available
# This script ensures libvmaf (with CUDA support) is properly installed and accessible

echo "=== libvmaf Setup ==="

# Ensure libvmaf directories exist
mkdir -p /usr/local/lib/x86_64-linux-gnu
mkdir -p /usr/local/include/libvmaf
mkdir -p /usr/local/lib/x86_64-linux-gnu/pkgconfig

# Persistent locations (mounted from host)
PERSISTENT_LIB_DIR="/custom-libvmaf-lib"
PERSISTENT_INCLUDE_DIR="/usr/local/include/libvmaf"
PERSISTENT_PKGCONFIG_DIR="/custom-libvmaf-pkgconfig"

# System locations (where libraries should be)
SYSTEM_LIB_DIR="/usr/local/lib/x86_64-linux-gnu"
SYSTEM_PKGCONFIG_DIR="/usr/local/lib/x86_64-linux-gnu/pkgconfig"

# Retry loop for volume mount visibility (overlay filesystem can lag)
wait_for_volume() {
    local dir="$1"
    local marker="${2:-libvmaf.so.3.0.0}"
    local timeout=30
    local waited=0
    while [ $waited -lt $timeout ]; do
        if [ -f "$dir/$marker" ] 2>/dev/null; then
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    return 1
}

# Copy libraries from persistent location to system location if they exist
if [ -d "$PERSISTENT_LIB_DIR" ]; then
    wait_for_volume "$PERSISTENT_LIB_DIR" && {
        echo "📦 Copying libvmaf libraries from persistent location..."
        cp -a "$PERSISTENT_LIB_DIR"/* "$SYSTEM_LIB_DIR/" 2>/dev/null || true
        echo "✅ Libraries copied to $SYSTEM_LIB_DIR"
    } || echo "⚠️  Persistent libvmaf not visible after 30s wait"
fi

# Copy pkgconfig from persistent location
if [ -d "$PERSISTENT_PKGCONFIG_DIR" ]; then
    if wait_for_volume "$PERSISTENT_PKGCONFIG_DIR" "libvmaf.pc"; then
        echo "📦 Copying pkgconfig from persistent location..."
        cp -a "$PERSISTENT_PKGCONFIG_DIR"/* "$SYSTEM_PKGCONFIG_DIR/" 2>/dev/null || true
        echo "✅ pkgconfig copied to $SYSTEM_PKGCONFIG_DIR"
    fi
fi

# Check if libvmaf libraries exist in system location
LIBVMAF_SO="$SYSTEM_LIB_DIR/libvmaf.so.3.0.0"
LIBVMAF_CUDA_H="$PERSISTENT_INCLUDE_DIR/libvmaf_cuda.h"

if [ -f "$LIBVMAF_SO" ] && [ -f "$LIBVMAF_CUDA_H" ]; then
    echo "✅ libvmaf libraries found"

    # Create symlinks if they don't exist
    cd "$SYSTEM_LIB_DIR"
    [ ! -f libvmaf.so.3 ] && ln -sf libvmaf.so.3.0.0 libvmaf.so.3 2>/dev/null || true
    [ ! -f libvmaf.so ] && ln -sf libvmaf.so.3 libvmaf.so 2>/dev/null || true

    # Update library cache
    ldconfig 2>/dev/null || true

    echo "✅ libvmaf setup complete (with CUDA support)"
    echo "   Library: $LIBVMAF_SO"
    echo "   Header: $LIBVMAF_CUDA_H"
else
    echo "⚠️  libvmaf libraries not found in persistent location"
    echo "   They will be built on first container start or can be rebuilt with:"
    echo "   /usr/local/build-scripts/rebuild-ffmpeg-compute120.sh"

    # Check if they exist in system location (from previous build)
    if [ -f "$SYSTEM_LIB_DIR/libvmaf.so.3.0.0" ]; then
        echo "   Found in system location, will be available but not persistent"
    fi
fi

# Set PKG_CONFIG_PATH to include libvmaf
export PKG_CONFIG_PATH="$SYSTEM_PKGCONFIG_DIR:/usr/local/lib/pkgconfig:$PKG_CONFIG_PATH"

# Verify pkg-config can find libvmaf
if pkg-config --exists libvmaf 2>/dev/null; then
    echo "✅ pkg-config can find libvmaf"
    pkg-config --modversion libvmaf 2>/dev/null | head -1
else
    echo "⚠️  pkg-config cannot find libvmaf (may need rebuild)"
fi

echo "=== libvmaf Setup Complete ==="
