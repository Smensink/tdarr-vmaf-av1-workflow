#!/bin/bash
# Install VMAF model files to standard location for libvmaf_cuda

set -e

MODEL_DIR="/usr/local/share/model"
VMAF_SOURCE="/tmp/ffmpeg-build/vmaf/model"

echo "[VMAF Models] Installing VMAF model files..."

# Create model directory if it doesn't exist
mkdir -p "$MODEL_DIR"

# Copy essential VMAF models if source exists
if [ -d "$VMAF_SOURCE" ]; then
    # Copy standard models
    if [ -f "$VMAF_SOURCE/vmaf_v0.6.1.json" ]; then
        cp -f "$VMAF_SOURCE/vmaf_v0.6.1.json" "$MODEL_DIR/" 2>/dev/null || true
        echo "[VMAF Models] Installed vmaf_v0.6.1.json"
    fi

    if [ -f "$VMAF_SOURCE/vmaf_4k_v0.6.1.json" ]; then
        cp -f "$VMAF_SOURCE/vmaf_4k_v0.6.1.json" "$MODEL_DIR/" 2>/dev/null || true
        echo "[VMAF Models] Installed vmaf_4k_v0.6.1.json"
    fi

    if [ -f "$VMAF_SOURCE/vmaf_b_v0.6.3.json" ]; then
        cp -f "$VMAF_SOURCE/vmaf_b_v0.6.3.json" "$MODEL_DIR/" 2>/dev/null || true
        echo "[VMAF Models] Installed vmaf_b_v0.6.3.json"
    fi

    # Verify installation
    if [ -f "$MODEL_DIR/vmaf_v0.6.1.json" ]; then
        echo "[VMAF Models] ✅ VMAF models installed successfully"
        ls -lh "$MODEL_DIR"/*.json 2>/dev/null | head -5
    else
        echo "[VMAF Models] ⚠️  Warning: VMAF models not found in source directory"
    fi
else
    echo "[VMAF Models] ⚠️  Warning: VMAF source directory not found: $VMAF_SOURCE"
    echo "[VMAF Models] Models may need to be installed manually or from build artifacts"
fi
