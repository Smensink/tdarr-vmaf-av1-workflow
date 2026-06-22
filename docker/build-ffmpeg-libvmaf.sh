#!/usr/bin/env bash
# Build a staged Tdarr FFmpeg/libvmaf stack without touching the active /usr/local/ffmpeg-custom install.
# Intended container invocation:
#   docker exec tdarr bash /usr/local/build-scripts/rebuild-ffmpeg-8.1-libvmaf-3.1-staged.sh

set -Eeuo pipefail

: "${VMAF_TAG:=v3.1.0}"
: "${FFMPEG_TAG:=n8.1.1}"
# libvmaf v3.1.0 uses CUDA driver symbols that are present on nv-codec-headers
# master and commit 876af32..., but not in the n13.0.19.0 release tag. Pin the
# minimum upstream commit mentioned by libvmaf's meson error.
: "${NV_CODEC_HEADERS_TAG:=876af32a202d0de83bd1d36fe74ee0f7fcf86b0d}"
: "${INSTALL_PREFIX:=/usr/local/ffmpeg-custom-next}"
: "${VMAF_STAGE_PREFIX:=/tmp/ffmpeg-build/libvmaf-v3.1-stage}"
: "${PROMOTE:=false}"
: "${WORKDIR:=/tmp/ffmpeg-build}"

log() { printf '\n[%s] %s\n' "$(date -Is 2>/dev/null || date)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

if [ "$PROMOTE" = "true" ]; then
  fail "PROMOTE=true is intentionally not handled by this staged build script. Validate first, then promote explicitly."
fi

log "Staged FFmpeg/libvmaf build starting"
echo "VMAF_TAG=$VMAF_TAG"
echo "FFMPEG_TAG=$FFMPEG_TAG"
echo "NV_CODEC_HEADERS_TAG=$NV_CODEC_HEADERS_TAG"
echo "INSTALL_PREFIX=$INSTALL_PREFIX"
echo "VMAF_STAGE_PREFIX=$VMAF_STAGE_PREFIX"

# Prefer CUDA 13.1 where available. RTX 50-series compute_120 needs it.
if [ -x /usr/local/cuda-13.1/bin/nvcc ]; then
  export CUDA_PATH=/usr/local/cuda-13.1
elif [ -x /usr/local/cuda/bin/nvcc ]; then
  export CUDA_PATH=/usr/local/cuda
elif [ -x /usr/bin/nvcc ]; then
  export CUDA_PATH=/usr
else
  fail "nvcc not found; CUDA toolkit is required for libvmaf_cuda and CUDA FFmpeg filters"
fi
export CUDA_HOME="$CUDA_PATH"
export PATH="$CUDA_PATH/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
export LD_LIBRARY_PATH="${CUDA_PATH}/lib64:/usr/local/lib/x86_64-linux-gnu:/usr/local/lib:${LD_LIBRARY_PATH:-}"
export PKG_CONFIG_PATH="/usr/local/lib/pkgconfig:/usr/local/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH:-}"

if ! command -v git >/dev/null; then
  log "git not found; will fetch pinned source tarballs with curl/wget"
  command -v curl >/dev/null || command -v wget >/dev/null || fail "git unavailable and neither curl nor wget was found"
fi
command -v meson >/dev/null || fail "meson not found"
command -v ninja >/dev/null || fail "ninja not found"
command -v make >/dev/null || fail "make not found"
command -v pkg-config >/dev/null || fail "pkg-config not found"
command -v python3 >/dev/null || fail "python3 not found"
command -v nvcc >/dev/null || fail "nvcc not found after PATH setup"

fetch_url() {
  local url="$1"
  local out="$2"
  if command -v curl >/dev/null; then
    curl -fL --retry 3 --retry-delay 2 "$url" -o "$out"
  else
    wget -O "$out" "$url"
  fi
}

fetch_github_tarball() {
  local owner="$1"
  local repo="$2"
  local ref="$3"
  local dest="$4"
  local archive="$WORKDIR/${repo}-${ref}.tar.gz"
  local url="https://github.com/${owner}/${repo}/archive/${ref}.tar.gz"
  log "Fetching ${owner}/${repo} ${ref} tarball"
  rm -rf "$dest"
  mkdir -p "$dest"
  fetch_url "$url" "$archive"
  tar -xzf "$archive" --strip-components=1 -C "$dest"
}

fetch_ffmpeg_tarball() {
  local tag="$1"
  local dest="$2"
  fetch_github_tarball "FFmpeg" "FFmpeg" "$tag" "$dest"
}

log "CUDA compiler"
nvcc --version | sed -n '1,4p'

mkdir -p "$WORKDIR"
cd "$WORKDIR"

choose_cuda_arch() {
  if nvcc --list-gpu-code 2>/dev/null | grep -qE 'sm_120|compute_120'; then
    echo compute_120
  elif nvcc --list-gpu-code 2>/dev/null | grep -qE 'sm_100|compute_100'; then
    echo compute_100
  elif nvcc --list-gpu-code 2>/dev/null | grep -qE 'sm_90|compute_90'; then
    echo compute_90
  else
    echo compute_120
  fi
}
PTX_ARCH="${PTX_ARCH:-$(choose_cuda_arch)}"
PTX_CODE="${PTX_CODE:-$PTX_ARCH}"
log "Using CUDA PTX arch/code: $PTX_ARCH / $PTX_CODE"

log "Fetching nv-codec-headers $NV_CODEC_HEADERS_TAG"
cd "$WORKDIR"
if command -v git >/dev/null; then
  if [ ! -d nv-codec-headers/.git ]; then
    rm -rf nv-codec-headers
    git clone https://github.com/FFmpeg/nv-codec-headers.git nv-codec-headers
  fi
  cd nv-codec-headers
  git fetch --tags origin
  git checkout --force "$NV_CODEC_HEADERS_TAG"
else
  fetch_github_tarball "FFmpeg" "nv-codec-headers" "$NV_CODEC_HEADERS_TAG" "$WORKDIR/nv-codec-headers"
  cd nv-codec-headers
fi
make PREFIX=/usr/local install

log "Fetching libvmaf $VMAF_TAG"
if command -v git >/dev/null; then
  if [ ! -d vmaf/.git ]; then
    rm -rf vmaf
    git clone https://github.com/Netflix/vmaf.git vmaf
  fi
  cd "$WORKDIR/vmaf"
  git fetch --tags origin
  git checkout --force "$VMAF_TAG"
else
  fetch_github_tarball "Netflix" "vmaf" "$VMAF_TAG" "$WORKDIR/vmaf"
  cd "$WORKDIR/vmaf"
fi
cd libvmaf

# libvmaf's meson rule does not always set a Blackwell-friendly PTX arch. Patch idempotently.
python3 <<'PY'
from pathlib import Path
import os
p = Path('src/meson.build')
s = p.read_text()
arch = os.environ.get('PTX_ARCH', 'compute_120')
code = os.environ.get('PTX_CODE', arch)
old = "command : [nvcc_exe, '--ptx', '@INPUT@', '-o', '@OUTPUT@' ,"
new = f"command : [nvcc_exe, '--ptx', '-arch={arch}', '-code={code}', '@INPUT@', '-o', '@OUTPUT@' ,"
if old in s:
    p.write_text(s.replace(old, new))
    print(f'patched libvmaf meson PTX command for {arch}/{code}')
elif f"-arch={arch}" in s or "'--ptx', '-arch=" in s:
    print('libvmaf meson PTX command already patched')
else:
    print('warning: expected libvmaf nvcc PTX command pattern not found')
PY

rm -rf build
meson setup build \
  --prefix="$VMAF_STAGE_PREFIX" \
  --libdir=lib \
  --buildtype release \
  -Denable_cuda=true \
  -Denable_float=true \
  -Denable_tests=false \
  -Denable_docs=false
ninja -C build
ninja -C build install

log "Staged libvmaf installed"
find "$VMAF_STAGE_PREFIX" -maxdepth 3 \( -name 'libvmaf.so*' -o -name 'libvmaf.pc' -o -name 'libvmaf_cuda.h' \) -print

log "Fetching FFmpeg $FFMPEG_TAG"
cd "$WORKDIR"
if command -v git >/dev/null; then
  if [ ! -d ffmpeg/.git ]; then
    rm -rf ffmpeg
    git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg || git clone https://github.com/FFmpeg/FFmpeg.git ffmpeg
  fi
  cd ffmpeg
  git fetch --tags origin || true
  git checkout --force "$FFMPEG_TAG"
else
  fetch_ffmpeg_tarball "$FFMPEG_TAG" "$WORKDIR/ffmpeg"
  cd ffmpeg
fi
make distclean >/dev/null 2>&1 || make clean >/dev/null 2>&1 || true

export PKG_CONFIG_PATH="$VMAF_STAGE_PREFIX/lib/pkgconfig:/usr/local/lib/pkgconfig:/usr/local/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH:-}"
export LD_LIBRARY_PATH="$VMAF_STAGE_PREFIX/lib:${CUDA_PATH}/lib64:/usr/local/lib/x86_64-linux-gnu:/usr/local/lib:${LD_LIBRARY_PATH:-}"

NVCC_ABS="$(command -v nvcc)"
log "Configuring FFmpeg"
PATH="$CUDA_PATH/bin:$PATH" \
CUDA_PATH="$CUDA_PATH" \
CUDA_HOME="$CUDA_PATH" \
NVCC="$NVCC_ABS" \
./configure \
  --prefix="$INSTALL_PREFIX" \
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
  --extra-cflags="-I/usr/local/include/ffnvcodec -I$VMAF_STAGE_PREFIX/include -I$CUDA_PATH/include" \
  --extra-ldflags="-L$VMAF_STAGE_PREFIX/lib -L$CUDA_PATH/lib64 -Wl,-rpath,$VMAF_STAGE_PREFIX/lib -lcudart" \
  --nvccflags="-gencode arch=$PTX_ARCH,code=$PTX_CODE -std=c++11 -m64" \
  2>&1 | tee /tmp/ffmpeg81-config.log

log "Building FFmpeg"
CORES="$(nproc 2>/dev/null || echo 4)"
make -j"$CORES" 2>&1 | tee /tmp/ffmpeg81-build.log

log "Installing FFmpeg to staged prefix $INSTALL_PREFIX"
rm -rf "$INSTALL_PREFIX"
mkdir -p "$INSTALL_PREFIX"
make install 2>&1 | tee /tmp/ffmpeg81-install.log
chmod +x "$INSTALL_PREFIX/bin/ffmpeg" "$INSTALL_PREFIX/bin/ffprobe" 2>/dev/null || true

log "Creating staged libvmaf promotion preview under build workspace"
rm -rf "$WORKDIR/promote-preview"
mkdir -p "$WORKDIR/promote-preview/custom-libvmaf-lib" "$WORKDIR/promote-preview/custom-libvmaf-include" "$WORKDIR/promote-preview/custom-libvmaf-pkgconfig"
cp -a "$VMAF_STAGE_PREFIX"/lib/libvmaf.so* "$WORKDIR/promote-preview/custom-libvmaf-lib/"
cp -a "$VMAF_STAGE_PREFIX"/include/libvmaf/. "$WORKDIR/promote-preview/custom-libvmaf-include/" 2>/dev/null || true
cp -a "$VMAF_STAGE_PREFIX"/lib/pkgconfig/libvmaf.pc "$WORKDIR/promote-preview/custom-libvmaf-pkgconfig/"

log "Staged build verification"
NEW_LD="$VMAF_STAGE_PREFIX/lib:$INSTALL_PREFIX/lib:$CUDA_PATH/lib64:/usr/local/lib/x86_64-linux-gnu:/usr/local/lib"
LD_LIBRARY_PATH="$NEW_LD" "$INSTALL_PREFIX/bin/ffmpeg" -version | sed -n '1,8p'
echo
LD_LIBRARY_PATH="$NEW_LD" ldd "$INSTALL_PREFIX/bin/ffmpeg" | grep -E 'libvmaf|libcuda|libnvidia|cudart' || true
echo
LD_LIBRARY_PATH="$NEW_LD" "$INSTALL_PREFIX/bin/ffmpeg" -hide_banner -filters | grep -E 'libvmaf|libvmaf_cuda|scale_cuda|pad_cuda'
echo
LD_LIBRARY_PATH="$NEW_LD" "$INSTALL_PREFIX/bin/ffmpeg" -hide_banner -encoders | grep -E 'av1_nvenc|hevc_nvenc|h264_nvenc'

log "Done. Production wrappers and /usr/local/ffmpeg-custom were not modified."
