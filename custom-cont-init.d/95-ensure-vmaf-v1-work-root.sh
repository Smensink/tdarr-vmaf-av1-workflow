#!/bin/bash
# Ensure the CPU VMAF-v1 scorer's work root is writable by the Tdarr runtime user.
#
# `vmaf-v1-score` resolves `work_root=${VMAF_V1_WORK_ROOT:-${TMPDIR:-/temp}}` and hard-fails with
# `exit 73: VMAF scorer work root is not writable` when it cannot write there. Because the CPU-v1
# contract disables cross-contract fallback, that turns into
# `CPU VMAF-v1 production runtime is required ... but failed for N sample(s)` and the whole job
# errors - for SDR and HDR alike.
#
# This happened for real: the named volume `tdarr-vmaf-v1-score` was created 2026-07-28 06:52 as
# root:root 0755 and never chowned, so every CPU-v1 score failed for ~32h before anyone connected
# the job failures to a directory permission. Docker creates named volumes root-owned, so a volume
# recreate reintroduces it silently. This guard makes that self-healing.

set -uo pipefail

RUNTIME_USER="${VMAF_V1_RUNTIME_USER:-abc}"

# Deliberately act ONLY on an explicitly configured work root. Falling back to the scorer's own
# ${TMPDIR:-/temp} default here would chown /temp, which is the large host-backed media/scratch
# mount - expensive and not ours to re-own.
if [[ -z "${VMAF_V1_WORK_ROOT:-}" ]]; then
    echo "[vmaf-v1 work root] VMAF_V1_WORK_ROOT is unset; scorer falls back to TMPDIR//temp - nothing to do."
    exit 0
fi

WORK_ROOT="$VMAF_V1_WORK_ROOT"

if ! id -u "$RUNTIME_USER" >/dev/null 2>&1; then
    echo "[vmaf-v1 work root] WARNING: runtime user '$RUNTIME_USER' does not exist; leaving $WORK_ROOT alone." >&2
    exit 0
fi

mkdir -p "$WORK_ROOT" 2>/dev/null || true
if [[ ! -d "$WORK_ROOT" ]]; then
    echo "[vmaf-v1 work root] WARNING: $WORK_ROOT is not a directory and could not be created; CPU VMAF-v1 will fail." >&2
    exit 0
fi

chown "$RUNTIME_USER:$RUNTIME_USER" "$WORK_ROOT" 2>/dev/null || true
chmod 0775 "$WORK_ROOT" 2>/dev/null || true

# Verify as the runtime user rather than trusting the chown: on some mount types ownership changes
# are silently ignored, and a false "fixed" here would recreate the original silent breakage.
if su "$RUNTIME_USER" -s /bin/sh -c "test -w '$WORK_ROOT'"; then
    echo "[vmaf-v1 work root] OK: $WORK_ROOT writable by $RUNTIME_USER ($(stat -c '%U:%G %a' "$WORK_ROOT"))"
else
    echo "[vmaf-v1 work root] WARNING: $WORK_ROOT is STILL not writable by $RUNTIME_USER" \
         "($(stat -c '%U:%G %a' "$WORK_ROOT")). CPU VMAF-v1 scoring will fail with exit 73 and" \
         "every affected job will error - fix this before relying on the CPU-v1 contract." >&2
fi

exit 0
