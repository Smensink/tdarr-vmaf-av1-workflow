#!/usr/bin/env bash
set -euo pipefail
CONTAINER="${1:-tdarr}"
ROOT="${2:-plugins/vmaf}"
SERVER_ROOT='/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins/vmaf'
NODE_ROOT='/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins/vmaf'

for src in "$ROOT"/*/1.0.0/index.js; do
  plugin="$(basename "$(dirname "$(dirname "$src")")")"
  for target_root in "$SERVER_ROOT" "$NODE_ROOT"; do
    docker exec "$CONTAINER" mkdir -p "$target_root/$plugin/1.0.0"
    docker cp "$src" "$CONTAINER:$target_root/$plugin/1.0.0/index.js"
  done
  echo "installed $plugin"
done

docker restart "$CONTAINER"
