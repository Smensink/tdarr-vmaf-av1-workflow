#!/bin/bash
# Cheap Docker liveness check for the Tdarr API.
#
# Full CUDA, NVEncC, grav1synth, FFmpeg, and grain-pipeline qualification is
# intentionally not a recurring healthcheck: those probes consume the same
# GPU/process resources as live work. Run verify-grain-toolchain.sh explicitly
# during startup qualification or while the queue is drained.

set -euo pipefail

exec bash -c 'exec 3<>/dev/tcp/127.0.0.1/8266'
