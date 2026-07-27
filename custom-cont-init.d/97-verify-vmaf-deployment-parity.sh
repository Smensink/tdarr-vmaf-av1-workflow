#!/bin/bash
# Fail startup when Flow plugin copies or the live canonical graph drift.

set -euo pipefail

echo '[deployment parity] Verifying Flow plugins, helpers, and live graph...'
if node /usr/local/build-scripts/verify-vmaf-deployment-parity.js; then
    exit 0
else
    status=$?
fi
echo "[deployment parity] FATAL: verification failed with status $status" >&2
# Tdarr's custom-init runner ignores hook exit codes, so explicitly stop s6 and
# its fail-open parent just like the grain artifact preflight does.
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
