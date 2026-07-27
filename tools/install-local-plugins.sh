#!/usr/bin/env bash
set -euo pipefail
CONTAINER="${1:-tdarr}"
ROOT="${2:-plugins}"
RESTART_MODE="${3:-}"
SERVER_BASE='/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins'
NODE_BASE='/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins'

if [[ "$RESTART_MODE" != "" && "$RESTART_MODE" != "--restart" ]]; then
  echo "usage: $0 [container] [plugin-root] [--restart]" >&2
  exit 64
fi
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Container not running: $CONTAINER" >&2
  exit 2
fi

shopt -s nullglob
sources=("$ROOT"/*/*/1.0.0/index.js)
if [ "${#sources[@]}" -eq 0 ]; then
  echo "No plugin index.js files found under $ROOT" >&2
  exit 1
fi

for src in "${sources[@]}"; do
  category="$(basename "$(dirname "$(dirname "$(dirname "$src")")")")"
  plugin="$(basename "$(dirname "$(dirname "$src")")")"
  for target_base in "$SERVER_BASE" "$NODE_BASE"; do
    target_dir="$target_base/$category/$plugin/1.0.0"
    docker exec "$CONTAINER" mkdir -p "$target_dir"
    docker cp "$src" "$CONTAINER:$target_dir/index.js"
  done
  echo "installed $category/$plugin"
done

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
for helper in "${runtime_helpers[@]}"; do
  src="$ROOT/vmaf/_lib/$helper"
  [[ -f "$src" ]] || {
    echo "Required runtime helper missing: $src" >&2
    exit 1
  }
  for target_base in "$SERVER_BASE" "$NODE_BASE"; do
    target_dir="$target_base/vmaf/_lib"
    docker exec "$CONTAINER" mkdir -p "$target_dir"
    docker cp "$src" "$CONTAINER:$target_dir/$helper"
  done
  echo "installed vmaf/_lib/$helper"
done

model="${VMAF_SIZE_FAILURE_SHADOW_MODEL_SOURCE:-$ROOT/vmaf/_lib/size_failure_shadow_hgb.json}"
if [[ -f "$model" ]]; then
  for target_base in "$SERVER_BASE" "$NODE_BASE"; do
    target_dir="$target_base/vmaf/_lib"
    docker exec "$CONTAINER" mkdir -p "$target_dir"
    docker cp "$model" "$CONTAINER:$target_dir/size_failure_shadow_hgb.json"
  done
  echo "installed private size-failure shadow model from $model"
else
  echo "private size-failure shadow model not installed; advisory scoring remains disabled"
fi

if [[ "$RESTART_MODE" == "--restart" ]]; then
  echo "Restart requested. Ensure the Tdarr queue and workers are drained first." >&2
  docker restart "$CONTAINER"
else
  cat >&2 <<'EOF'
Plugin files were synchronized without restarting Tdarr.
The running node may retain loaded modules until its next safe restart.
Drain all workers before restarting; never restart during an active transcode.
EOF
fi
