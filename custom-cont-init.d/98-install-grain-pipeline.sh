#!/bin/bash
# Install the checksum-pinned grain pipeline into the container layer.

set -euo pipefail

ARTIFACT_ROOT="${GRAIN_PIPELINE_ARTIFACT_ROOT:-/opt/grain-pipeline-artifact}"
RELEASE_ID="v5-20260728-r2"
ARTIFACT_VERSION="5"
EXPECTED_SHA256="646384c3a0d79f720cb46e8b733846a42d920ab704b9327b6b376c151dc8b615"
PIPELINE_NAME="grain_pipeline_v5_direct.py"

ARTIFACT_RELEASE="$ARTIFACT_ROOT/releases/$RELEASE_ID"
ARTIFACT_PIPELINE="$ARTIFACT_RELEASE/$PIPELINE_NAME"
ARTIFACT_PROVENANCE="$ARTIFACT_RELEASE/PROVENANCE.txt"
ARTIFACT_SUMS="$ARTIFACT_RELEASE/SHA256SUMS"

INSTALL_ROOT="/opt/grain-pipeline"
INSTALL_RELEASES="$INSTALL_ROOT/releases"
INSTALL_NAME="${RELEASE_ID}-${EXPECTED_SHA256:0:12}"
INSTALL_RELEASE="$INSTALL_RELEASES/$INSTALL_NAME"
INSTALL_PIPELINE="$INSTALL_RELEASE/$PIPELINE_NAME"
CURRENT_LINK="$INSTALL_ROOT/current"
STABLE_PIPELINE="$CURRENT_LINK/$PIPELINE_NAME"
COMMAND_LINK="/usr/local/bin/tdarr-grain-pipeline"

STAGE_DIR=""
CURRENT_TMP=""
COMMAND_TMP=""

cleanup_temporary() {
    if [[ -n "$STAGE_DIR" && "$STAGE_DIR" == "$INSTALL_RELEASES/.${INSTALL_NAME}.install."* ]]; then
        rm -rf -- "$STAGE_DIR" 2>/dev/null || true
    fi
    [[ -z "$CURRENT_TMP" ]] || rm -f -- "$CURRENT_TMP" 2>/dev/null || true
    [[ -z "$COMMAND_TMP" ]] || rm -f -- "$COMMAND_TMP" 2>/dev/null || true
}

fatal_startup() {
    trap - ERR
    cleanup_temporary
    echo "[grain pipeline] FATAL: $*" >&2
    # Tdarr's upstream custom-init runner ignores hook exit codes. Request s6
    # shutdown and terminate that fail-open runner so Tdarr cannot start.
    if [[ -f /.dockerenv ]]; then
        if [[ -x /run/s6/basedir/bin/halt ]]; then
            /run/s6/basedir/bin/halt >/dev/null 2>&1 || true
        elif [[ -d /run/service ]] && command -v s6-svscanctl >/dev/null 2>&1; then
            s6-svscanctl -t /run/service >/dev/null 2>&1 || true
        fi
        local parent_command=""
        parent_command="$(tr '\0' ' ' <"/proc/${PPID}/cmdline" 2>/dev/null || true)"
        if [[ "$parent_command" == *"/etc/s6-overlay/s6-rc.d/init-custom-files/run"* ]]; then
            kill -TERM "$PPID" 2>/dev/null || true
        fi
    fi
    exit 1
}

trap 'status=$?; fatal_startup "installer command failed with status $status"' ERR

echo "[grain pipeline] Installing $RELEASE_ID..."

[[ -f "$ARTIFACT_PIPELINE" ]] || fatal_startup "artifact not found: $ARTIFACT_PIPELINE"
[[ -f "$ARTIFACT_PROVENANCE" ]] || fatal_startup "provenance not found: $ARTIFACT_PROVENANCE"
[[ -f "$ARTIFACT_SUMS" ]] || fatal_startup "checksum manifest not found: $ARTIFACT_SUMS"

if ! (cd "$ARTIFACT_RELEASE" && sha256sum --check --strict SHA256SUMS); then
    fatal_startup "artifact checksum manifest validation failed"
fi

ACTUAL_SHA256="$(sha256sum "$ARTIFACT_PIPELINE" | awk '{print $1}')"
[[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256" ]] || \
    fatal_startup "expected SHA-256 $EXPECTED_SHA256, got $ACTUAL_SHA256"
grep -Fxq "artifact_version=$ARTIFACT_VERSION" "$ARTIFACT_PROVENANCE" || \
    fatal_startup "artifact version missing from provenance"
grep -Fxq "release_id=$RELEASE_ID" "$ARTIFACT_PROVENANCE" || \
    fatal_startup "release ID missing from provenance"
grep -Fxq "sha256=$EXPECTED_SHA256" "$ARTIFACT_PROVENANCE" || \
    fatal_startup "artifact checksum missing from provenance"

mkdir -p "$INSTALL_RELEASES" /usr/local/bin
if [[ -e "$INSTALL_RELEASE" ]]; then
    [[ -f "$INSTALL_PIPELINE" ]] || fatal_startup "installed release is incomplete: $INSTALL_RELEASE"
    INSTALLED_SHA256="$(sha256sum "$INSTALL_PIPELINE" | awk '{print $1}')"
    [[ "$INSTALLED_SHA256" == "$EXPECTED_SHA256" ]] || \
        fatal_startup "installed release checksum mismatch: $INSTALLED_SHA256"
else
    STAGE_DIR="$(mktemp -d "$INSTALL_RELEASES/.${INSTALL_NAME}.install.XXXXXX")"
    install -m 0555 "$ARTIFACT_PIPELINE" "$STAGE_DIR/$PIPELINE_NAME"
    install -m 0444 "$ARTIFACT_PROVENANCE" "$STAGE_DIR/PROVENANCE.txt"
    install -m 0444 "$ARTIFACT_SUMS" "$STAGE_DIR/SHA256SUMS"
    STAGED_SHA256="$(sha256sum "$STAGE_DIR/$PIPELINE_NAME" | awk '{print $1}')"
    [[ "$STAGED_SHA256" == "$EXPECTED_SHA256" ]] || \
        fatal_startup "staged release checksum mismatch: $STAGED_SHA256"
    # mktemp creates directories as 0700. Tdarr's plugins run as the unprivileged
    # abc user, so publish the immutable release with read/traverse permission.
    chmod 0555 "$STAGE_DIR"
    mv "$STAGE_DIR" "$INSTALL_RELEASE"
    STAGE_DIR=""
fi

# Repair an already-installed copy from an older installer as well. The files
# remain immutable; only directory traversal for the runtime user is granted.
chmod 0555 "$INSTALL_RELEASE"
INSTALL_RELEASE_MODE="$(stat -c '%a' "$INSTALL_RELEASE")"
[[ "$INSTALL_RELEASE_MODE" == "555" ]] || \
    fatal_startup "installed release directory has unsafe mode: $INSTALL_RELEASE_MODE"

# Publish both stable links by rename so readers see the old complete release
# or the new complete release, never a partially installed path.
CURRENT_TMP="$INSTALL_ROOT/.current.$$"
ln -s "releases/$INSTALL_NAME" "$CURRENT_TMP"
mv -Tf "$CURRENT_TMP" "$CURRENT_LINK"
CURRENT_TMP=""

COMMAND_TMP="/usr/local/bin/.tdarr-grain-pipeline.$$"
ln -s "$STABLE_PIPELINE" "$COMMAND_TMP"
mv -Tf "$COMMAND_TMP" "$COMMAND_LINK"
COMMAND_TMP=""

FINAL_SHA256="$(sha256sum "$STABLE_PIPELINE" | awk '{print $1}')"
[[ "$FINAL_SHA256" == "$EXPECTED_SHA256" ]] || \
    fatal_startup "published pipeline checksum mismatch: $FINAL_SHA256"
trap - ERR

echo "[grain pipeline] Installed $RELEASE_ID"
echo "[grain pipeline] Stable path: $STABLE_PIPELINE"
echo "[grain pipeline] SHA-256: $FINAL_SHA256"
