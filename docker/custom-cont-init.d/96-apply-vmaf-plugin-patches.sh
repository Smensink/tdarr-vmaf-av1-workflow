#!/bin/sh
set -e

echo '=== Applying Seb VMAF flow plugin patches ==='
PATCH_ROOT='/custom-cont-init.d/vmaf-plugin-patches'
NODE_TARGET_ROOT='/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/vmaf'
SERVER_TARGET_ROOT='/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf'

apply_patch_file() {
  rel="$1"
  src="$PATCH_ROOT/$rel/index.js"
  if [ ! -f "$src" ]; then
    echo "Patch payload missing, skipping: $src"
    return 0
  fi
  for root in "$SERVER_TARGET_ROOT" "$NODE_TARGET_ROOT"; do
    dst="$root/$rel/index.js"
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    chmod 666 "$dst" || true
    echo "Applied VMAF plugin patch: $rel -> $dst"
  done
}

apply_patch_file 'calculateVMAF/1.0.0'
apply_patch_file 'checkCQBracket/1.0.0'
apply_patch_file 'vmafOptimizedTranscode/1.0.0'
apply_patch_file 'checkHdrContent/1.0.0'
apply_patch_file 'exportVMAFResults/1.0.0'
apply_patch_file 'extractVideoSamples/1.0.0'
apply_patch_file 'testEncodingParameters/1.0.0'
apply_patch_file 'selectBestParameters/1.0.0'
apply_patch_file 'checkCQRangeRetry/1.0.0'
apply_patch_file 'learnCQRange/1.0.0'
apply_patch_file 'fetchMediaMetadata/1.0.0'
apply_patch_file 'acquireGpuPipelineLock/1.0.0'
apply_patch_file 'releaseGpuPipelineLock/1.0.0'

if [ -d "$PATCH_ROOT/_lib" ]; then
  chmod 666 "$PATCH_ROOT"/_lib/*.js 2>/dev/null || true
  echo 'VMAF shared helper library available at /custom-cont-init.d/vmaf-plugin-patches/_lib'
fi

echo '=== VMAF plugin patches complete ==='
