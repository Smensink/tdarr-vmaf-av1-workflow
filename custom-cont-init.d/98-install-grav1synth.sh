#!/bin/bash
# Install the pinned, host-persisted grav1synth artifact into the container layer.

set -euo pipefail

ARTIFACT_ROOT="${GRAV1SYNTH_ARTIFACT_ROOT:-/opt/grav1synth-artifact}"
ARTIFACT_BIN="$ARTIFACT_ROOT/bin/grav1synth"
ARTIFACT_PROVENANCE="$ARTIFACT_ROOT/PROVENANCE.txt"
ARTIFACT_SUMS="$ARTIFACT_ROOT/SHA256SUMS"
INSTALL_ROOT="/opt/grav1synth"
INSTALL_BIN="$INSTALL_ROOT/bin/grav1synth"
COMMAND_LINK="/usr/local/bin/grav1synth"

EXPECTED_VERSION="grav1synth 0.2.0"
EXPECTED_COMMIT="1044228cd411672b565e5762a9b3597f4dd163b0"
EXPECTED_PATCH="grav1synth-nvenc-sequence-header.patch"
EXPECTED_PATCH_SHA256="0beb125d34a0c8223a27728440a9dcbc05d72787570d5a0c634a48649a67e4a7"
EXPECTED_NVENC_FIXTURE_SHA256="04e451508a968b62559e0b07f8829f931411749355dc27a882b18c56b35fb04a"
EXPECTED_SHA256="5e6e462e7c6ddf1229e965d1bb4741b698f9cd9d40e4c0c0ec90d419d42c6e9e"

fatal_startup() {
    trap - ERR
    echo "[grav1synth] FATAL: $*" >&2
    # Tdarr's upstream custom-init runner logs child failures but then returns
    # success. Request an s6 container shutdown so a bad artifact cannot produce a
    # running, partially initialized container. The guard makes host-side lint
    # or maintenance invocations safe.
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
    exit 1
}

trap 'status=$?; fatal_startup "installer command failed with status $status"' ERR

echo "[grav1synth] Installing pinned artifact..."

for required in "$ARTIFACT_BIN" "$ARTIFACT_PROVENANCE" "$ARTIFACT_SUMS"; do
    [[ -f "$required" && ! -L "$required" && -r "$required" ]] || \
        fatal_startup "artifact contract file is missing, unreadable, or a symlink: $required"
done

EXPECTED_SUM_LINE="$EXPECTED_SHA256  bin/grav1synth"
mapfile -t ARTIFACT_SUM_LINES < <(sed '/^[[:space:]]*$/d' "$ARTIFACT_SUMS")
if [[ "${#ARTIFACT_SUM_LINES[@]}" -ne 1 || "${ARTIFACT_SUM_LINES[0]}" != "$EXPECTED_SUM_LINE" ]]; then
    fatal_startup "artifact checksum manifest is not the exact pinned binary"
fi
(
    cd "$ARTIFACT_ROOT"
    sha256sum --check --strict SHA256SUMS
) >/dev/null || fatal_startup "artifact checksum manifest validation failed"

ACTUAL_SHA256="$(sha256sum "$ARTIFACT_BIN" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
    echo "[grav1synth] ERROR: artifact checksum mismatch" >&2
    echo "[grav1synth] expected: $EXPECTED_SHA256" >&2
    echo "[grav1synth] actual:   $ACTUAL_SHA256" >&2
    fatal_startup "refusing to install unverified artifact"
fi

ACTUAL_VERSION="$("$ARTIFACT_BIN" --version 2>&1)"
if [[ "$ACTUAL_VERSION" != "$EXPECTED_VERSION" ]]; then
    fatal_startup "expected '$EXPECTED_VERSION', got '$ACTUAL_VERSION'"
fi

require_unique_provenance() {
    local expected="$1"
    local count
    count="$(grep -Fxc -- "$expected" "$ARTIFACT_PROVENANCE" || true)"
    [[ "$count" == "1" ]] || fatal_startup \
        "artifact provenance must contain exactly one '$expected' entry (found $count)"
}

require_unique_provenance "git_commit=$EXPECTED_COMMIT"
require_unique_provenance "patch=$EXPECTED_PATCH"
require_unique_provenance "patch_sha256=$EXPECTED_PATCH_SHA256"
require_unique_provenance "nvenc_fixture_sha256=$EXPECTED_NVENC_FIXTURE_SHA256"
require_unique_provenance "sha256=$EXPECTED_SHA256"

mkdir -p "$INSTALL_ROOT/bin" /usr/local/bin
TMP_BIN="$INSTALL_ROOT/bin/.grav1synth.install.$$"
trap 'rm -f "$TMP_BIN"' EXIT
install -m 0755 "$ARTIFACT_BIN" "$TMP_BIN"
mv -f "$TMP_BIN" "$INSTALL_BIN"
ln -sfn "$INSTALL_BIN" "$COMMAND_LINK"
trap - EXIT

echo "[grav1synth] Installed $ACTUAL_VERSION"
echo "[grav1synth] Source commit: $EXPECTED_COMMIT"
echo "[grav1synth] SHA-256: $ACTUAL_SHA256"
