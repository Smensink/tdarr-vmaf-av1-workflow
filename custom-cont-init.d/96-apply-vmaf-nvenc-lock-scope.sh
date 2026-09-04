#!/bin/bash
set -euo pipefail

INIT_DIR="${TDARR_CUSTOM_CONT_INIT_DIR:-/custom-cont-init.d}"

echo '[flow migration] SKIP: NVENC lock-scope migration requires an explicit operator action'
node "$INIT_DIR/export-vmaf-flow-definition.js"
