#!/usr/bin/with-contenv bash
# Durable Tdarr FFmpeg repair.
# Tdarr's own /etc/cont-init.d/03-setup-ffmpeg creates Jellyfin ffmpeg symlinks at startup.
# This host-mounted hook first makes every executable vendor copy inert, then installs
# wrappers for the deployment's known-good custom FFmpeg build.

set -u

echo "=== Custom FFmpeg Setup (VMAF/NVENC build) ==="

CUSTOM_ROOT="/usr/local/ffmpeg-custom"
CUSTOM_FFMPEG="$CUSTOM_ROOT/bin/ffmpeg"
CUSTOM_FFPROBE="$CUSTOM_ROOT/bin/ffprobe"
CUSTOM_LIB_DIR="$CUSTOM_ROOT/lib"
CUSTOM_VMAF_LIB_DIR="/custom-libvmaf-lib"
VENDOR_FFMPEG_INIT="/etc/cont-init.d/03-setup-ffmpeg"
VENDOR_FFMPEG_RECOVERY_DIR="/var/lib/tdarr-init-backups"
NEUTRALIZE_MARKER="disabled by 99-replace-ffmpeg.sh (custom FFmpeg build)"

# Keep this conservative. Previous versions prepended /usr/local/lib/x86_64-linux-gnu and
# LD_PRELOADed CUDA 13.1 libcudart; that made the runtime fragile after image/CUDA refreshes.
# Put the newer host-mounted libvmaf first: the older libvmaf bundled in ffmpeg-custom
# exposes libvmaf_cuda but aborts on RTX 50-series with init_fex_cuda assertions.
WRAPPER_LD_LIBRARY_PATH="/custom-libvmaf-lib:/usr/local/ffmpeg-custom/lib:/usr/local/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/lib:\${LD_LIBRARY_PATH:-}"

install_wrapper() {
  local target="$1"
  local binary="$2"
  local label="$3"
  local temporary="${target}.custom-install.$$"

  # Build beside the destination and rename over it so neither Tdarr nor a
  # health probe can observe a missing or partially written command.
  rm -f "$temporary"
  if ! cat > "$temporary" << EOF
#!/bin/sh
export LD_LIBRARY_PATH=$WRAPPER_LD_LIBRARY_PATH
exec $binary "\$@"
EOF
  then
    echo "ERROR: could not stage $label wrapper at $temporary" >&2
    rm -f "$temporary"
    return 1
  fi
  if ! chmod 0755 "$temporary" || ! mv -f "$temporary" "$target"; then
    echo "ERROR: could not atomically install $label wrapper at $target" >&2
    rm -f "$temporary"
    return 1
  fi
  echo "Installed $label wrapper: $target -> $binary"
}

wrapper_is_current() {
  local target="$1"
  local binary="$2"

  [ -f "$target" ] \
    && [ -x "$target" ] \
    && [ ! -L "$target" ] \
    && grep -Fqx "exec $binary \"\$@\"" "$target" 2>/dev/null \
    && grep -Fq "/custom-libvmaf-lib" "$target" 2>/dev/null
}

preserve_vendor_recovery_copy() {
  local source="$1"
  local preferred_name="$2"
  local destination
  local suffix=0

  if ! mkdir -p "$VENDOR_FFMPEG_RECOVERY_DIR"; then
    echo "WARNING: could not create vendor FFmpeg recovery directory $VENDOR_FFMPEG_RECOVERY_DIR" >&2
    return 1
  fi

  destination="$VENDOR_FFMPEG_RECOVERY_DIR/$preferred_name"
  while [ -e "$destination" ] || [ -L "$destination" ]; do
    suffix=$((suffix + 1))
    destination="$VENDOR_FFMPEG_RECOVERY_DIR/${preferred_name}.${suffix}"
  done
  if ! cp -p "$source" "$destination"; then
    echo "WARNING: could not preserve vendor FFmpeg init recovery copy at $destination" >&2
    return 1
  fi
  chmod 0600 "$destination" 2>/dev/null || true
  PRESERVED_VENDOR_COPY="$destination"
  return 0
}

install_inert_vendor_stub() {
  local target="$1"
  local temporary="${target}.custom-disable.$$"

  rm -f "$temporary"
  if ! cat > "$temporary" << EOF
#!/usr/bin/with-contenv bash
# $NEUTRALIZE_MARKER. Recovery copies are stored outside the executable init
# directory under $VENDOR_FFMPEG_RECOVERY_DIR.
echo "[03-setup-ffmpeg] $NEUTRALIZE_MARKER; using custom FFmpeg build."
exit 0
EOF
  then
    echo "ERROR: could not stage inert vendor FFmpeg init stub at $temporary" >&2
    rm -f "$temporary"
    return 1
  fi
  if ! chmod 0755 "$temporary" || ! mv -f "$temporary" "$target"; then
    echo "ERROR: could not install inert vendor FFmpeg init stub at $target" >&2
    rm -f "$temporary"
    return 1
  fi
}

secure_vendor_ffmpeg_init() {
  local legacy_backup
  local backup_name

  # The init runner executes every matching file in /etc/cont-init.d, regardless
  # of our .orig-bak-* suffix. Migrate backups left by older revisions before
  # any custom-binary validation can exit this script.
  for legacy_backup in "${VENDOR_FFMPEG_INIT}.orig-bak-"*; do
    if [ ! -e "$legacy_backup" ] && [ ! -L "$legacy_backup" ]; then
      continue
    fi
    backup_name="${legacy_backup##*/}"
    PRESERVED_VENDOR_COPY=""
    if preserve_vendor_recovery_copy "$legacy_backup" "$backup_name"; then
      if rm -f "$legacy_backup"; then
        echo "Moved executable vendor FFmpeg backup out of init directory: $PRESERVED_VENDOR_COPY"
      else
        echo "WARNING: could not remove $legacy_backup after preserving it; making it inert" >&2
        install_inert_vendor_stub "$legacy_backup" || return 1
      fi
    else
      echo "WARNING: could not relocate $legacy_backup; making it inert in place" >&2
      install_inert_vendor_stub "$legacy_backup" || return 1
    fi
  done

  if [ -f "$VENDOR_FFMPEG_INIT" ] \
    && ! grep -q "$NEUTRALIZE_MARKER" "$VENDOR_FFMPEG_INIT" 2>/dev/null; then
    PRESERVED_VENDOR_COPY=""
    if preserve_vendor_recovery_copy "$VENDOR_FFMPEG_INIT" "03-setup-ffmpeg.vendor-original"; then
      echo "Preserved vendor FFmpeg init recovery copy: $PRESERVED_VENDOR_COPY"
    else
      echo "WARNING: neutralizing vendor FFmpeg init without a recovery copy" >&2
    fi
    install_inert_vendor_stub "$VENDOR_FFMPEG_INIT" || return 1
    echo "Neutralized vendor $VENDOR_FFMPEG_INIT"
  else
    echo "Vendor $VENDOR_FFMPEG_INIT already neutralized or absent"
  fi

  # Fail closed if an unexpected legacy backup survived and is not our no-op.
  for legacy_backup in "${VENDOR_FFMPEG_INIT}.orig-bak-"*; do
    if { [ -e "$legacy_backup" ] || [ -L "$legacy_backup" ]; } \
      && ! grep -q "$NEUTRALIZE_MARKER" "$legacy_backup" 2>/dev/null; then
      echo "ERROR: executable vendor FFmpeg backup remains active: $legacy_backup" >&2
      return 1
    fi
  done
}

if ! secure_vendor_ffmpeg_init; then
  echo "ERROR: could not secure vendor FFmpeg init scripts" >&2
  exit 1
fi

if [ ! -x "$CUSTOM_FFMPEG" ]; then
  echo "ERROR: custom FFmpeg not executable at $CUSTOM_FFMPEG"
  echo "VMAF sample extraction and NVENC transcodes will fail until the custom build is restored."
  exit 1
fi

if [ ! -x "$CUSTOM_FFPROBE" ]; then
  echo "ERROR: custom ffprobe not executable at $CUSTOM_FFPROBE"
  echo "Continuing with ffmpeg wrapper only, but media probing may fail."
fi

install_all_wrappers() {
  local status=0

  # Tdarr 2.77 Docker production resolves ffmpegPath to the PATH command `tdarr-ffmpeg`.
  # Older notes/scripts also used /temp/tdarr-ffmpeg. Install both so either path works.
  install_wrapper "/usr/local/bin/tdarr-ffmpeg" "$CUSTOM_FFMPEG" "Tdarr FFmpeg" || status=1
  install_wrapper "/temp/tdarr-ffmpeg" "$CUSTOM_FFMPEG" "legacy /temp Tdarr FFmpeg" || status=1

  if [ -x "$CUSTOM_FFPROBE" ]; then
    install_wrapper "/usr/local/bin/tdarr-ffprobe" "$CUSTOM_FFPROBE" "Tdarr ffprobe" || status=1
    install_wrapper "/temp/tdarr-ffprobe" "$CUSTOM_FFPROBE" "legacy /temp Tdarr ffprobe" || status=1
  fi

  # Also fix generic ffmpeg/ffprobe so manual/plugin calls do not hit the broken Jellyfin symlink.
  # Use wrappers rather than plain symlinks so direct manual calls get the matching promoted
  # libvmaf/FFmpeg shared libraries even if /tmp build rpaths disappear after a restart.
  install_wrapper "/usr/local/bin/ffmpeg" "$CUSTOM_FFMPEG" "generic FFmpeg" || status=1
  if [ -x "$CUSTOM_FFPROBE" ]; then
    install_wrapper "/usr/local/bin/ffprobe" "$CUSTOM_FFPROBE" "generic ffprobe" || status=1
  fi

  return "$status"
}

if ! install_all_wrappers; then
  echo "ERROR: one or more custom FFmpeg wrappers could not be installed" >&2
  exit 1
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

# Rear-guard against Tdarr_Server's OWN ffmpeg self-heal (found 2026-07-21, distinct from
# the /etc/cont-init.d/03-setup-ffmpeg mechanism neutralized above). Independent of any
# cont-init.d script, Tdarr_Server's own startup reads the `ffmpegVersion` env var (blank
# in our docker-compose.yml -> defaults to "7") and unconditionally wget+apt-installs
# jellyfin-ffmpeg7 fresh from GitHub, then re-links /usr/local/bin/tdarr-ffmpeg (and
# /usr/local/bin/ffmpeg) to it as a raw symlink -- clobbering the wrappers this script just
# installed. Observed 2026-07-21: that reinstall completes ~15-40s after this script exits,
# roughly 30s before Tdarr_Server's own first ffmpeg validation log line ("Binary test 2:
# ffmpegPath working"), so there is a real race to win, not a one-time startup quirk.
# No config-level disable was found for this: Tdarr's global settings DB (settingsglobaljsondb
# in DB2/SQL/database.db) has no ffmpegVersion key; the documented `ffmpegPath` setting only
# changes which binary Tdarr's own process *invokes*, not this background reinstall; and an
# exhaustive grep of /etc, /custom-cont-init.d, /defaults, and /etc/s6-overlay/s6-rc.d found no
# editable script that triggers it (it appears to be compiled into Tdarr_Server itself). Given
# no clean hook to run right before it, keep a lightweight rear guard for the container's
# lifetime. It polls every second during the startup window and every 15 seconds thereafter.
# Replacement is atomic, and content checks catch symlinks, binaries, and malformed wrappers.
reassert_wrapper_if_drifted() {
  if ! wrapper_is_current /usr/local/bin/tdarr-ffmpeg "$CUSTOM_FFMPEG" \
    || ! wrapper_is_current /usr/local/bin/ffmpeg "$CUSTOM_FFMPEG" \
    || ! wrapper_is_current /usr/local/bin/tdarr-ffprobe "$CUSTOM_FFPROBE" \
    || ! wrapper_is_current /usr/local/bin/ffprobe "$CUSTOM_FFPROBE"; then
    echo "[rear-guard $(date +%H:%M:%S)] detected vendor ffmpeg self-heal clobber -- reinstalling wrappers"
    install_all_wrappers || echo "[rear-guard] ERROR: wrapper repair failed" >&2
  fi
}
(
  exec 9>/run/tdarr-ffmpeg-rear-guard.lock
  if ! flock -n 9; then
    echo "[rear-guard] another wrapper guard is already active"
    exit 0
  fi
  started_at=$SECONDS
  echo "[rear-guard] monitoring custom FFmpeg wrappers"
  while true; do
    reassert_wrapper_if_drifted
    if [ $((SECONDS - started_at)) -lt 180 ]; then
      sleep 1
    else
      sleep 15
    fi
  done
) &
disown 2>/dev/null || true

echo "=== Custom FFmpeg Setup Complete ==="
