#!/usr/bin/env bash
set -euo pipefail
CONTAINER="${1:-tdarr}"
ROOT="${2:-plugins}"
SERVER_BASE='/app/server/Tdarr/Plugins/FlowPlugins/LocalFlowPlugins'
NODE_BASE='/app/Tdarr_Node/assets/app/plugins/FlowPlugins/LocalFlowPlugins'

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

docker restart "$CONTAINER"
