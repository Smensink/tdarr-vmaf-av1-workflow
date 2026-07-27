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
plugin_relpaths=(
  filter/checkFileAge/1.0.0/index.js
  tools/unmonitorRadarrOrSonarr/1.0.0/index.js
  vmaf/acquireGpuPipelineLock/1.0.0/index.js
  vmaf/analyzeFilmGrain/1.0.0/index.js
  vmaf/calculateVMAF/1.0.0/index.js
  vmaf/checkCQBracket/1.0.0/index.js
  vmaf/checkCQRangeRetry/1.0.0/index.js
  vmaf/checkFileLimits/1.0.0/index.js
  vmaf/checkHdrContent/1.0.0/index.js
  vmaf/checkVideoCodec/1.0.0/index.js
  vmaf/cleanupTempFiles/1.0.0/index.js
  vmaf/detectGPUEncoder/1.0.0/index.js
  vmaf/detectSceneComplexity/1.0.0/index.js
  vmaf/exportVMAFResults/1.0.0/index.js
  vmaf/extractVideoSamples/1.0.0/index.js
  vmaf/fetchMediaMetadata/1.0.0/index.js
  vmaf/learnCQRange/1.0.0/index.js
  vmaf/learnCQRanges/1.0.0/index.js
  vmaf/monitorTranscodeRetry/1.0.0/index.js
  vmaf/releaseGpuPipelineLock/1.0.0/index.js
  vmaf/selectBestParameters/1.0.0/index.js
  vmaf/synthesizeFilmGrain/1.0.0/index.js
  vmaf/testEncodingParameters/1.0.0/index.js
  vmaf/vmafOptimizedTranscode/1.0.0/index.js
)
runtime_helpers=(
  canonicalDenoise.js
  currentContractMeasurementHistory.js
  emptyBandShadow.js
  feasibility.js
  gpuPipelineLock.js
  grainAnalysisArtifact.js
  grainVmafContract.js
  nvenccKnn.js
  nvencTemporalFilter.js
  pairedCqShadow.js
  postEncodeCheckpoint.js
  preFgsCambi.js
  referenceContractBridge.js
  rejectionReasons.js
  sizeFailureShadow.js
  vmafdb.js
  vmafMetricContract.js
  vmafpredict.js
  vmafV1Cpu.js
)
catalog_roots=(
  /app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins
  /app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins
)
for root in "${catalog_roots[@]}"; do
  for relpath in "${plugin_relpaths[@]}"; do
    "${DOCKER_EXEC[@]}" test -f "$root/$relpath"
  done
  for helper in "${runtime_helpers[@]}"; do
    "${DOCKER_EXEC[@]}" test -f "$root/vmaf/_lib/$helper"
  done
done
echo "verified ${#plugin_relpaths[@]} plugin identities and ${#runtime_helpers[@]} helpers in both catalogs"

echo "validation passed"
