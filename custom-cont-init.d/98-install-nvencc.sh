#!/bin/bash
# Install the checksum-pinned NVEncC binary and KNN/FFmpeg coordinator.

set -euo pipefail

ARTIFACT_ROOT="${NVENCC_ARTIFACT_ROOT:-/opt/nvencc-artifact}"
ARTIFACT_BIN="$ARTIFACT_ROOT/bin/nvencc"
ARTIFACT_COORDINATOR="$ARTIFACT_ROOT/libexec/tdarr-nvencc-knn-ffmpeg.js"
ARTIFACT_PROVENANCE="$ARTIFACT_ROOT/PROVENANCE.txt"
ARTIFACT_SUMS="$ARTIFACT_ROOT/SHA256SUMS"

VERSION_ID="9.25-r3"
EXPECTED_VERSION_LINE="NVEnc (x64) 9.25 (r1) by rigaya, Jul 24 2026 07:25:18 (gcc 13.3.0/Linux)"
EXPECTED_COMMIT="8c873e4d15aefb93dd50396e5c70fffb842f7d22"
EXPECTED_PATCH="nvencc-9.25-optional-metadata-libs.patch"
EXPECTED_PATCH_SHA256="8fb6dd6c3770f1e239b56686e0e4e1b02f6f28513ad21c7f5d5e3920f62ea64e"
EXPECTED_BIN_SHA256="03d8a26631fef47881f30243e4442dcb26a66cabbb586ae9637c9e22b9776294"
EXPECTED_COORDINATOR_SHA256="6ba05f26647611c1be0986ffee218858f1c0b0734f94bf21af7759e067954576"

INSTALL_ROOT="/opt/nvencc"
INSTALL_RELEASES="$INSTALL_ROOT/releases"
INSTALL_NAME="${VERSION_ID}-${EXPECTED_BIN_SHA256:0:12}-${EXPECTED_COORDINATOR_SHA256:0:12}"
INSTALL_RELEASE="$INSTALL_RELEASES/$INSTALL_NAME"
INSTALL_BIN="$INSTALL_RELEASE/bin/nvencc"
INSTALL_COORDINATOR="$INSTALL_RELEASE/libexec/tdarr-nvencc-knn-ffmpeg.js"
CURRENT_LINK="$INSTALL_ROOT/current"
STABLE_BIN="$CURRENT_LINK/bin/nvencc"
STABLE_COORDINATOR="$CURRENT_LINK/libexec/tdarr-nvencc-knn-ffmpeg.js"
COMMAND_LINK="/usr/local/bin/nvencc"
COORDINATOR_LINK="/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js"

STAGE_DIR=""
CURRENT_TMP=""
COMMAND_TMP=""
COORDINATOR_TMP=""

cleanup_temporary() {
    if [[ -n "$STAGE_DIR" && "$STAGE_DIR" == "$INSTALL_RELEASES/.${INSTALL_NAME}.install."* ]]; then
        rm -rf -- "$STAGE_DIR" 2>/dev/null || true
    fi
    [[ -z "$CURRENT_TMP" ]] || rm -f -- "$CURRENT_TMP" 2>/dev/null || true
    [[ -z "$COMMAND_TMP" ]] || rm -f -- "$COMMAND_TMP" 2>/dev/null || true
    [[ -z "$COORDINATOR_TMP" ]] || rm -f -- "$COORDINATOR_TMP" 2>/dev/null || true
}

fatal_startup() {
    trap - ERR
    cleanup_temporary
    echo "[NVEncC] FATAL: $*" >&2
    if [[ -f /.dockerenv ]]; then
        if [[ -x /run/s6/basedir/bin/halt ]]; then
            /run/s6/basedir/bin/halt >/dev/null 2>&1 || true
        elif [[ -d /run/service ]] && command -v s6-svscanctl >/dev/null 2>&1; then
            s6-svscanctl -t /run/service >/dev/null 2>&1 || true
        fi
        local parent_command=""
        if [[ "$PPID" =~ ^[1-9][0-9]*$ && -r "/proc/${PPID}/cmdline" ]]; then
            parent_command="$(tr '\0' ' ' <"/proc/${PPID}/cmdline" 2>/dev/null || true)"
        fi
        if [[ "$parent_command" == *"/etc/s6-overlay/s6-rc.d/init-custom-files/run"* ]]; then
            kill -TERM "$PPID" 2>/dev/null || true
        fi
    fi
    exit 1
}

require_unique_provenance() {
    local expected="$1"
    local count
    count="$(grep -Fxc -- "$expected" "$ARTIFACT_PROVENANCE" || true)"
    [[ "$count" == "1" ]] || \
        fatal_startup "artifact provenance must contain exactly one '$expected' entry (found $count)"
}

verify_installed_release() {
    [[ -f "$INSTALL_BIN" && ! -L "$INSTALL_BIN" && -x "$INSTALL_BIN" ]] || \
        fatal_startup "installed NVEncC binary is missing or unsafe: $INSTALL_BIN"
    [[ -f "$INSTALL_COORDINATOR" && ! -L "$INSTALL_COORDINATOR" && -x "$INSTALL_COORDINATOR" ]] || \
        fatal_startup "installed coordinator is missing or unsafe: $INSTALL_COORDINATOR"
    [[ "$(sha256sum "$INSTALL_BIN" | awk '{print $1}')" == "$EXPECTED_BIN_SHA256" ]] || \
        fatal_startup "installed NVEncC checksum mismatch"
    [[ "$(sha256sum "$INSTALL_COORDINATOR" | awk '{print $1}')" == "$EXPECTED_COORDINATOR_SHA256" ]] || \
        fatal_startup "installed coordinator checksum mismatch"
}

trap 'status=$?; fatal_startup "installer command failed with status $status"' ERR

echo "[NVEncC] Installing pinned $VERSION_ID artifact..."

for required in "$ARTIFACT_BIN" "$ARTIFACT_COORDINATOR" \
    "$ARTIFACT_PROVENANCE" "$ARTIFACT_SUMS"; do
    [[ -f "$required" && ! -L "$required" && -r "$required" ]] || \
        fatal_startup "artifact contract file is missing, unreadable, or a symlink: $required"
done

EXPECTED_BIN_SUM_LINE="$EXPECTED_BIN_SHA256  bin/nvencc"
EXPECTED_COORDINATOR_SUM_LINE="$EXPECTED_COORDINATOR_SHA256  libexec/tdarr-nvencc-knn-ffmpeg.js"
mapfile -t ARTIFACT_SUM_LINES < <(sed '/^[[:space:]]*$/d' "$ARTIFACT_SUMS")
if [[ "${#ARTIFACT_SUM_LINES[@]}" -ne 2 ||
      "${ARTIFACT_SUM_LINES[0]}" != "$EXPECTED_BIN_SUM_LINE" ||
      "${ARTIFACT_SUM_LINES[1]}" != "$EXPECTED_COORDINATOR_SUM_LINE" ]]; then
    fatal_startup "artifact checksum manifest is not the exact pinned binary/coordinator pair"
fi
(
    cd "$ARTIFACT_ROOT"
    sha256sum --check --strict SHA256SUMS
) >/dev/null || fatal_startup "artifact checksum manifest validation failed"

ACTUAL_VERSION_LINE="$("$ARTIFACT_BIN" --version 2>&1 | sed -n '1p')"
[[ "$ACTUAL_VERSION_LINE" == "$EXPECTED_VERSION_LINE" ]] || \
    fatal_startup "unexpected NVEncC version: $ACTUAL_VERSION_LINE"
require_unique_provenance "git_commit=$EXPECTED_COMMIT"
require_unique_provenance "patch=$EXPECTED_PATCH"
require_unique_provenance "patch_sha256=$EXPECTED_PATCH_SHA256"
require_unique_provenance "binary_sha256=$EXPECTED_BIN_SHA256"
require_unique_provenance "coordinator_sha256=$EXPECTED_COORDINATOR_SHA256"

mkdir -p "$INSTALL_RELEASES" /usr/local/bin /usr/local/libexec
if [[ -e "$INSTALL_RELEASE" ]]; then
    verify_installed_release
else
    STAGE_DIR="$(mktemp -d "$INSTALL_RELEASES/.${INSTALL_NAME}.install.XXXXXX")"
    mkdir -p "$STAGE_DIR/bin" "$STAGE_DIR/libexec"
    install -m 0555 "$ARTIFACT_BIN" "$STAGE_DIR/bin/nvencc"
    install -m 0555 "$ARTIFACT_COORDINATOR" \
        "$STAGE_DIR/libexec/tdarr-nvencc-knn-ffmpeg.js"
    install -m 0444 "$ARTIFACT_PROVENANCE" "$STAGE_DIR/PROVENANCE.txt"
    install -m 0444 "$ARTIFACT_SUMS" "$STAGE_DIR/SHA256SUMS"
    chmod 0555 "$STAGE_DIR" "$STAGE_DIR/bin" "$STAGE_DIR/libexec"
    mv "$STAGE_DIR" "$INSTALL_RELEASE"
    STAGE_DIR=""
    verify_installed_release
fi

CURRENT_TMP="$INSTALL_ROOT/.current.$$"
ln -s "releases/$INSTALL_NAME" "$CURRENT_TMP"
mv -Tf "$CURRENT_TMP" "$CURRENT_LINK"
CURRENT_TMP=""

COMMAND_TMP="/usr/local/bin/.nvencc.$$"
ln -s "$STABLE_BIN" "$COMMAND_TMP"
mv -Tf "$COMMAND_TMP" "$COMMAND_LINK"
COMMAND_TMP=""

COORDINATOR_TMP="/usr/local/libexec/.tdarr-nvencc-knn-ffmpeg.js.$$"
ln -s "$STABLE_COORDINATOR" "$COORDINATOR_TMP"
mv -Tf "$COORDINATOR_TMP" "$COORDINATOR_LINK"
COORDINATOR_TMP=""

verify_installed_release
[[ "$(readlink -f "$COMMAND_LINK")" == "$INSTALL_BIN" ]] || \
    fatal_startup "published NVEncC link resolves to the wrong release"
[[ "$(readlink -f "$COORDINATOR_LINK")" == "$INSTALL_COORDINATOR" ]] || \
    fatal_startup "published coordinator link resolves to the wrong release"

trap - ERR
echo "[NVEncC] Installed $ACTUAL_VERSION_LINE"
echo "[NVEncC] Binary SHA-256: $EXPECTED_BIN_SHA256"
echo "[NVEncC] Coordinator SHA-256: $EXPECTED_COORDINATOR_SHA256"
