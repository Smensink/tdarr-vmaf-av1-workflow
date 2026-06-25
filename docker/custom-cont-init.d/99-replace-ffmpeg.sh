#!/usr/bin/with-contenv bash
# Durable Tdarr FFmpeg repair.
# Tdarr's own /etc/cont-init.d/03-setup-ffmpeg creates Jellyfin ffmpeg symlinks at startup.
# This script runs from the host-mounted custom-cont-init.d directory after that and replaces
# them with wrappers for Seb's known-good custom FFmpeg build.

set -u

echo "=== Custom FFmpeg Setup (Seb VMAF/NVENC build) ==="

CUSTOM_ROOT="/usr/local/ffmpeg-custom"
CUSTOM_FFMPEG="$CUSTOM_ROOT/bin/ffmpeg"
CUSTOM_FFPROBE="$CUSTOM_ROOT/bin/ffprobe"
CUSTOM_LIB_DIR="$CUSTOM_ROOT/lib"
CUSTOM_VMAF_LIB_DIR="/custom-libvmaf-lib"

# Keep this conservative. Previous versions prepended /usr/local/lib/x86_64-linux-gnu and
# LD_PRELOADed CUDA 13.1 libcudart; that made the runtime fragile after image/CUDA refreshes.
# Put the newer host-mounted libvmaf first: the older libvmaf bundled in ffmpeg-custom
# exposes libvmaf_cuda but aborts on RTX 50-series with init_fex_cuda assertions.
WRAPPER_LD_LIBRARY_PATH="/custom-libvmaf-lib:/usr/local/ffmpeg-custom/lib:/usr/local/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/lib:\${LD_LIBRARY_PATH:-}"

install_wrapper() {
  local target="$1"
  local binary="$2"
  local label="$3"

  rm -f "$target"
  cat > "$target" << EOF
#!/bin/sh
export LD_LIBRARY_PATH=$WRAPPER_LD_LIBRARY_PATH
exec $binary "\$@"
EOF
  chmod +x "$target"
  echo "Installed $label wrapper: $target -> $binary"
}

if [ ! -x "$CUSTOM_FFMPEG" ]; then
  echo "ERROR: custom FFmpeg not executable at $CUSTOM_FFMPEG"
  echo "VMAF sample extraction and NVENC transcodes will fail until the custom build is restored."
  exit 0
fi

if [ ! -x "$CUSTOM_FFPROBE" ]; then
  echo "ERROR: custom ffprobe not executable at $CUSTOM_FFPROBE"
  echo "Continuing with ffmpeg wrapper only, but media probing may fail."
fi

# Tdarr 2.77 Docker production resolves ffmpegPath to the PATH command `tdarr-ffmpeg`.
# Older notes/scripts also used /temp/tdarr-ffmpeg. Install both so either path works.
install_wrapper "/usr/local/bin/tdarr-ffmpeg" "$CUSTOM_FFMPEG" "Tdarr FFmpeg"
install_wrapper "/temp/tdarr-ffmpeg" "$CUSTOM_FFMPEG" "legacy /temp Tdarr FFmpeg"

if [ -x "$CUSTOM_FFPROBE" ]; then
  install_wrapper "/usr/local/bin/tdarr-ffprobe" "$CUSTOM_FFPROBE" "Tdarr ffprobe"
  install_wrapper "/temp/tdarr-ffprobe" "$CUSTOM_FFPROBE" "legacy /temp Tdarr ffprobe"
fi

# Also fix generic ffmpeg/ffprobe so manual/plugin calls do not hit the broken Jellyfin symlink.
# Use wrappers rather than plain symlinks so direct manual calls get the matching promoted
# libvmaf/FFmpeg shared libraries even if /tmp build rpaths disappear after a restart.
install_wrapper "/usr/local/bin/ffmpeg" "$CUSTOM_FFMPEG" "generic FFmpeg"
if [ -x "$CUSTOM_FFPROBE" ]; then
  install_wrapper "/usr/local/bin/ffprobe" "$CUSTOM_FFPROBE" "generic ffprobe"
fi

echo ""
echo "=== FFmpeg version ==="
/usr/local/bin/tdarr-ffmpeg -version 2>&1 | head -5 || true

echo ""
echo "=== Required filters/encoders ==="
/usr/local/bin/tdarr-ffmpeg -hide_banner -filters 2>/dev/null | grep -iE 'libvmaf|vmaf' || true
/usr/local/bin/tdarr-ffmpeg -hide_banner -encoders 2>/dev/null | grep -iE 'av1_nvenc|hevc_nvenc|h264_nvenc' || true

echo ""
echo "=== Wrapper targets ==="
for p in /usr/local/bin/tdarr-ffmpeg /temp/tdarr-ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/tdarr-ffprobe /temp/tdarr-ffprobe /usr/local/bin/ffprobe; do
  [ -e "$p" ] && ls -l "$p"
done

echo "=== Custom FFmpeg Setup Complete ==="
