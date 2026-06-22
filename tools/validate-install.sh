#!/usr/bin/env bash
set -euo pipefail
CONTAINER="${1:-tdarr}"

echo "== Local plugin syntax =="
shopt -s nullglob
plugin_files=(plugins/*/*/1.0.0/index.js)
if [ "${#plugin_files[@]}" -eq 0 ]; then
  echo "No plugin files found under plugins/" >&2
  exit 1
fi
for f in "${plugin_files[@]}"; do
  node --check "$f"
done

echo "== Running container checks: $CONTAINER =="
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Container not running: $CONTAINER" >&2
  exit 2
fi

DOCKER_EXEC=(docker exec "$CONTAINER")

echo "== FFmpeg version =="
"${DOCKER_EXEC[@]}" tdarr-ffmpeg -version | sed -n '1,8p'

echo "== VMAF filters =="
"${DOCKER_EXEC[@]}" sh -lc 'tdarr-ffmpeg -hide_banner -filters 2>/dev/null | grep -iE "libvmaf|vmaf"'

echo "== libvmaf feature/CAMBI hook =="
if "${DOCKER_EXEC[@]}" sh -lc 'tdarr-ffmpeg -hide_banner -h filter=libvmaf 2>&1 | grep -i cambi'; then
  echo "CAMBI is explicitly listed by FFmpeg help"
else
  "${DOCKER_EXEC[@]}" sh -lc 'tdarr-ffmpeg -hide_banner -h filter=libvmaf 2>&1 | grep -i "feature"'
  echo "CAMBI is not enumerated by this FFmpeg help output; libvmaf feature= support is present, so verify CAMBI on real jobs/log JSON for this build."
fi

echo "== NVENC encoders =="
"${DOCKER_EXEC[@]}" sh -lc 'tdarr-ffmpeg -hide_banner -encoders 2>/dev/null | grep -iE "av1_nvenc|hevc_nvenc|h264_nvenc"'

echo "== Plugin runtime files =="
"${DOCKER_EXEC[@]}" sh -lc '
set -e
for p in calculateVMAF selectBestParameters learnCQRange vmafOptimizedTranscode; do
  test -f "/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf/$p/1.0.0/index.js"
done
test -f "/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/filter/checkFileAge/1.0.0/index.js"
echo ok
'

echo "validation passed"
