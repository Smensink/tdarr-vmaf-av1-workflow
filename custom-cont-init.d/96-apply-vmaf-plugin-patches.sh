#!/bin/sh
set -e

echo '=== Applying VMAF flow plugin patches ==='
PATCH_ROOT='/custom-cont-init.d/vmaf-plugin-patches'
FILTER_PATCH_ROOT='/custom-cont-init.d/filter-plugin-patches'
TOOLS_PATCH_ROOT='/custom-cont-init.d/tools-plugin-patches'
LOCAL_NODE_ROOT='/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins'
LOCAL_SERVER_ROOT='/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins'
NODE_TARGET_ROOT="$LOCAL_NODE_ROOT/vmaf"
SERVER_TARGET_ROOT="$LOCAL_SERVER_ROOT/vmaf"
FILTER_NODE_TARGET_ROOT='/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/filter'
FILTER_SERVER_TARGET_ROOT='/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/filter'
TOOLS_NODE_TARGET_ROOT='/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/tools'
TOOLS_SERVER_TARGET_ROOT='/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/tools'

# The server catalog is persistent, while the internal node catalog lives in the
# container image and is lost on recreation. Seed every local plugin before the
# pinned payloads below are applied so an existing Flow cannot reference a plugin
# that the internal node has never indexed.
if [ -d "$LOCAL_SERVER_ROOT" ]; then
  mkdir -p "$LOCAL_NODE_ROOT"
  cp -a "$LOCAL_SERVER_ROOT/." "$LOCAL_NODE_ROOT/"
  echo "Seeded internal-node local plugin catalog from $LOCAL_SERVER_ROOT"
fi

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

apply_filter_patch_file() {
  rel="$1"
  src="$FILTER_PATCH_ROOT/$rel/index.js"
  if [ ! -f "$src" ]; then
    echo "Filter patch payload missing, skipping: $src"
    return 0
  fi
  for root in "$FILTER_SERVER_TARGET_ROOT" "$FILTER_NODE_TARGET_ROOT"; do
    dst="$root/$rel/index.js"
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    chmod 666 "$dst" || true
    echo "Applied filter plugin patch: $rel -> $dst"
  done
}

apply_tools_patch_file() {
  rel="$1"
  src="$TOOLS_PATCH_ROOT/$rel/index.js"
  if [ ! -f "$src" ]; then
    echo "Tools patch payload missing, skipping: $src"
    return 0
  fi
  for root in "$TOOLS_SERVER_TARGET_ROOT" "$TOOLS_NODE_TARGET_ROOT"; do
    dst="$root/$rel/index.js"
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    chmod 666 "$dst" || true
    echo "Applied tools plugin patch: $rel -> $dst"
  done
}

apply_shared_lib_file() {
  name="$1"
  src="$PATCH_ROOT/_lib/$name"
  if [ ! -f "$src" ]; then
    echo "Shared VMAF helper missing, skipping: $src"
    return 0
  fi
  for root in "$SERVER_TARGET_ROOT" "$NODE_TARGET_ROOT"; do
    dst="$root/_lib/$name"
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    chmod 666 "$dst" || true
    echo "Applied VMAF shared helper: $name -> $dst"
  done
}

apply_patch_file 'calculateVMAF/1.0.0'
apply_patch_file 'detectGPUEncoder/1.0.0'
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
apply_patch_file 'monitorTranscodeRetry/1.0.0'
apply_patch_file 'acquireGpuPipelineLock/1.0.0'
apply_patch_file 'releaseGpuPipelineLock/1.0.0'
apply_patch_file 'analyzeFilmGrain/1.0.0'
apply_patch_file 'synthesizeFilmGrain/1.0.0'
apply_patch_file 'cleanupTempFiles/1.0.0'
apply_filter_patch_file 'checkFileAge/1.0.0'
apply_tools_patch_file 'unmonitorRadarrOrSonarr/1.0.0'
apply_shared_lib_file 'feasibility.js'
apply_shared_lib_file 'gpuPipelineLock.js'
apply_shared_lib_file 'sizeFailureShadow.js'
apply_shared_lib_file 'vmafdb.js'
apply_shared_lib_file 'vmafpredict.js'
apply_shared_lib_file 'referenceContractBridge.js'
apply_shared_lib_file 'pairedCqShadow.js'
apply_shared_lib_file 'emptyBandShadow.js'
apply_shared_lib_file 'rejectionReasons.js'
apply_shared_lib_file 'grainAnalysisArtifact.js'
apply_shared_lib_file 'postEncodeCheckpoint.js'
apply_shared_lib_file 'canonicalDenoise.js'
apply_shared_lib_file 'nvencTemporalFilter.js'
apply_shared_lib_file 'nvenccKnn.js'
apply_shared_lib_file 'grainVmafContract.js'
apply_shared_lib_file 'preFgsCambi.js'
apply_shared_lib_file 'vmafMetricContract.js'
apply_shared_lib_file 'currentContractMeasurementHistory.js'
apply_shared_lib_file 'vmafV1Cpu.js'

if [ -d "$PATCH_ROOT/_lib" ]; then
  chmod 666 "$PATCH_ROOT"/_lib/*.js 2>/dev/null || true
  echo 'VMAF shared helper library available at /custom-cont-init.d/vmaf-plugin-patches/_lib'
fi

# Bootstrap the durable reuse-required registry once, before Tdarr can launch a
# title encode. Runtime validates this sentinel on every protected plan and
# marker lookup; a missing, unreadable, malformed, or partially lost registry
# fails closed. These roots are mandatory rather than enabled by a flag.
: "${VMAF_POSTENCODE_CHECKPOINT_ROOT:?missing fixed checkpoint root}"
: "${VMAF_POSTENCODE_REUSE_REQUIRED_ROOT:?missing fixed reuse-required root}"
REUSE_REQUIRED_ANCHOR="${VMAF_POSTENCODE_REUSE_REQUIRED_ROOT%/*}/.vmaf-postencode-reuse-required-active-v1.json"
node -e 'const h=require(process.argv[1]);h.assertPinnedStorage(process.env.VMAF_POSTENCODE_CHECKPOINT_ROOT,process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT);h.initializeReuseRequiredRoot(process.env.VMAF_POSTENCODE_REUSE_REQUIRED_ROOT);' "$PATCH_ROOT/_lib/postEncodeCheckpoint.js"
if id abc >/dev/null 2>&1; then
  chown -R abc:abc "$VMAF_POSTENCODE_REUSE_REQUIRED_ROOT"
  chown abc:abc "$REUSE_REQUIRED_ANCHOR"
fi
echo "Initialized protected post-encode reuse registry: $VMAF_POSTENCODE_REUSE_REQUIRED_ROOT"

# Tdarr_Node runs as abc and refreshes nodePlugins.Zip after init. Leaving any
# pre-seeded file owned by root makes that refresh abort on chmod before later
# local plugins are indexed (detectGPUEncoder was the first observed casualty).
if id abc >/dev/null 2>&1 && [ -d "$LOCAL_NODE_ROOT" ]; then
  chown -R abc:abc "$LOCAL_NODE_ROOT"
  echo "Assigned internal-node local plugin catalog to abc"
fi

echo '=== VMAF plugin patches complete ==='
