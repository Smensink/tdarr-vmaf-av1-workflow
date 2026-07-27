#!/bin/sh
set -eu
export LD_LIBRARY_PATH="/opt/vmaf-v1/lib/x86_64-linux-gnu:/opt/vmaf-v1/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec /opt/vmaf-v1/bin/vmaf "$@"
