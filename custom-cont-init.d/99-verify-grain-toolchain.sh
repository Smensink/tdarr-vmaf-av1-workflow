#!/bin/bash
# Fail container initialization if the production grain toolchain is incomplete.

set -euo pipefail

echo "[grain preflight] Verifying production toolchain..."
if bash /usr/local/build-scripts/verify-grain-toolchain.sh; then
    exit 0
else
    status=$?
    echo "[grain preflight] FATAL: startup preflight failed with status $status" >&2
    # The upstream custom-init loop ignores hook exit codes. Requesting an s6
    # shutdown is therefore the reliable way for this hook to fail container start.
    if [[ -f /.dockerenv ]]; then
        if [[ -x /run/s6/basedir/bin/halt ]]; then
            /run/s6/basedir/bin/halt >/dev/null 2>&1 || true
        elif [[ -d /run/service ]] && command -v s6-svscanctl >/dev/null 2>&1; then
            s6-svscanctl -t /run/service >/dev/null 2>&1 || true
        fi
        parent_command="$(tr '\0' ' ' <"/proc/${PPID}/cmdline" 2>/dev/null || true)"
        if [[ "$parent_command" == *"/etc/s6-overlay/s6-rc.d/init-custom-files/run"* ]]; then
            kill -TERM "$PPID" 2>/dev/null || true
        fi
    fi
    exit "$status"
fi
