#!/bin/bash
# Continuous Docker healthcheck for the deployed grain and FFmpeg toolchain.

set -euo pipefail

export GRAIN_PREFLIGHT_QUIET=1
exec bash /usr/local/build-scripts/verify-grain-toolchain.sh
