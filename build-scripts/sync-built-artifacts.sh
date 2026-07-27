#!/bin/bash
# Sync built artifacts to persistent storage locations
# This script copies FFmpeg and libvmaf build artifacts to the mounted volumes
# so they persist across container restarts

set -e

echo "=== Syncing Built Artifacts to Persistent Storage ==="

# Source locations (where builds install to)
FFMPEG_INSTALL_PREFIX="/usr/local/ffmpeg-custom"
LIBVMAF_LIB_DIR="/usr/local/lib/x86_64-linux-gnu"
LIBVMAF_INCLUDE_DIR="/usr/local/include/libvmaf"
LIBVMAF_PKGCONFIG_DIR="/usr/local/lib/x86_64-linux-gnu/pkgconfig"

# Persistent locations (mounted from host)
PERSISTENT_FFMPEG="/usr/local/ffmpeg-custom"
PERSISTENT_LIBVMAF_LIB="/custom-libvmaf-lib"
PERSISTENT_LIBVMAF_INCLUDE="/usr/local/include/libvmaf"
PERSISTENT_LIBVMAF_PKGCONFIG="/custom-libvmaf-pkgconfig"

# Sync FFmpeg binaries and libraries
if [ -d "$FFMPEG_INSTALL_PREFIX" ]; then
    echo "📦 Syncing FFmpeg binaries and libraries..."
    # FFmpeg is already in the persistent location (mounted volume)
    # Just ensure it's up to date
    if [ -f "$FFMPEG_INSTALL_PREFIX/bin/ffmpeg" ]; then
        echo "   ✅ FFmpeg binary: $FFMPEG_INSTALL_PREFIX/bin/ffmpeg"
    fi
    if [ -d "$FFMPEG_INSTALL_PREFIX/lib" ]; then
        echo "   ✅ FFmpeg libraries: $FFMPEG_INSTALL_PREFIX/lib"
    fi
fi

# Sync libvmaf libraries
if [ -d "$LIBVMAF_LIB_DIR" ]; then
    echo "📦 Syncing libvmaf libraries..."
    mkdir -p "$PERSISTENT_LIBVMAF_LIB"

    # Copy all libvmaf files
    if ls "$LIBVMAF_LIB_DIR"/libvmaf* 1> /dev/null 2>&1; then
        cp -a "$LIBVMAF_LIB_DIR"/libvmaf* "$PERSISTENT_LIBVMAF_LIB/" 2>/dev/null || true
        echo "   ✅ Copied libvmaf libraries to $PERSISTENT_LIBVMAF_LIB"
        ls -lh "$PERSISTENT_LIBVMAF_LIB"/libvmaf* 2>/dev/null | head -5
    else
        echo "   ⚠️  No libvmaf libraries found in $LIBVMAF_LIB_DIR"
    fi
fi

# Sync libvmaf headers
if [ -d "$LIBVMAF_INCLUDE_DIR" ]; then
    echo "📦 Syncing libvmaf headers..."
    mkdir -p "$PERSISTENT_LIBVMAF_INCLUDE"

    if [ "$(ls -A $LIBVMAF_INCLUDE_DIR 2>/dev/null)" ]; then
        cp -a "$LIBVMAF_INCLUDE_DIR"/* "$PERSISTENT_LIBVMAF_INCLUDE/" 2>/dev/null || true
        echo "   ✅ Copied headers to $PERSISTENT_LIBVMAF_INCLUDE"
        ls -lh "$PERSISTENT_LIBVMAF_INCLUDE"/*.h 2>/dev/null | head -5
    else
        echo "   ⚠️  No headers found in $LIBVMAF_INCLUDE_DIR"
    fi
fi

# Sync pkg-config files
if [ -d "$LIBVMAF_PKGCONFIG_DIR" ]; then
    echo "📦 Syncing pkg-config files..."
    mkdir -p "$PERSISTENT_LIBVMAF_PKGCONFIG"

    if [ -f "$LIBVMAF_PKGCONFIG_DIR/libvmaf.pc" ]; then
        cp -a "$LIBVMAF_PKGCONFIG_DIR"/libvmaf.pc "$PERSISTENT_LIBVMAF_PKGCONFIG/" 2>/dev/null || true
        echo "   ✅ Copied libvmaf.pc to $PERSISTENT_LIBVMAF_PKGCONFIG"
    else
        echo "   ⚠️  No libvmaf.pc found in $LIBVMAF_PKGCONFIG_DIR"
    fi
fi

# Sync VMAF model files
VMAF_MODEL_DIR="/usr/local/share/model"
PERSISTENT_VMAF_MODELS="/custom-vmaf-models"
if [ -d "$VMAF_MODEL_DIR" ]; then
    echo "📦 Syncing VMAF model files..."
    mkdir -p "$PERSISTENT_VMAF_MODELS"

    if ls "$VMAF_MODEL_DIR"/*.json 1> /dev/null 2>&1; then
        cp -a "$VMAF_MODEL_DIR"/*.json "$PERSISTENT_VMAF_MODELS/" 2>/dev/null || true
        echo "   ✅ Copied VMAF models to $PERSISTENT_VMAF_MODELS"
        ls -lh "$PERSISTENT_VMAF_MODELS"/*.json 2>/dev/null | head -5
    else
        echo "   ⚠️  No VMAF model files found in $VMAF_MODEL_DIR"
    fi
fi

echo ""
echo "=== Sync Complete ==="
echo ""
echo "All artifacts have been synced to persistent storage."
echo "They will be available on next container restart."
echo ""
echo "To verify, restart the container and check:"
echo "  docker exec tdarr ls -la /usr/local/lib/x86_64-linux-gnu/libvmaf*"
echo "  docker exec tdarr /usr/local/bin/tdarr-ffmpeg -version | grep libvmaf"
