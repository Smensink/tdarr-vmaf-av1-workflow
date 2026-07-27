#!/bin/bash
# Rebuild grav1synth from its pinned source revision into a staging directory.
# This is a manual maintenance command; container startup uses the persisted artifact.

set -euo pipefail

GRAV1SYNTH_GIT_URL="https://github.com/rust-av/grav1synth"
GRAV1SYNTH_COMMIT="1044228cd411672b565e5762a9b3597f4dd163b0"
GRAV1SYNTH_VERSION="0.2.0"
RUST_TOOLCHAIN="1.97.1"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PATCH_FILE="$SCRIPT_DIR/patches/grav1synth-nvenc-sequence-header.patch"
PATCH_SHA256="0beb125d34a0c8223a27728440a9dcbc05d72787570d5a0c634a48649a67e4a7"
NVENC_FIXTURE_SHA256="04e451508a968b62559e0b07f8829f931411749355dc27a882b18c56b35fb04a"

export CARGO_HOME="${CARGO_HOME:-/opt/cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-/opt/rustup}"
export PATH="$CARGO_HOME/bin:$PATH"

for tool in bash cargo rustc clang git install pkg-config sha256sum; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "ERROR: required build tool is missing: $tool" >&2
        exit 1
    }
done

ACTUAL_RUST="$(rustc --version | awk '{print $2}')"
if [[ "$ACTUAL_RUST" != "$RUST_TOOLCHAIN" ]]; then
    echo "ERROR: rustc $RUST_TOOLCHAIN is required; found $ACTUAL_RUST" >&2
    exit 1
fi

for module in libavformat libavcodec libavutil; do
    pkg-config --exists "$module" || {
        echo "ERROR: pkg-config module is missing: $module" >&2
        echo "Install the matching Tdarr-image FFmpeg development packages first." >&2
        exit 1
    }
done

STAGE_PARENT="${GRAV1SYNTH_STAGE_PARENT:-/temp}"
[[ -d "$STAGE_PARENT" ]] || {
    echo "ERROR: staging parent does not exist: $STAGE_PARENT" >&2
    exit 1
}
STAGE_ROOT="$(mktemp -d "$STAGE_PARENT/grav1synth-build.XXXXXX")"
SOURCE_ROOT="$STAGE_ROOT/source"
BUILT_BIN="$STAGE_ROOT/bin/grav1synth"

echo "Building grav1synth $GRAV1SYNTH_VERSION"
echo "Pinned commit: $GRAV1SYNTH_COMMIT"
echo "Pinned patch: $PATCH_SHA256"
echo "Staging root: $STAGE_ROOT"

[[ -r "$PATCH_FILE" ]] || {
    echo "ERROR: source patch is missing: $PATCH_FILE" >&2
    exit 1
}
ACTUAL_PATCH_SHA256="$(sha256sum "$PATCH_FILE" | awk '{print $1}')"
[[ "$ACTUAL_PATCH_SHA256" == "$PATCH_SHA256" ]] || {
    echo "ERROR: source patch checksum mismatch: $ACTUAL_PATCH_SHA256" >&2
    exit 1
}

git clone --quiet --no-checkout "$GRAV1SYNTH_GIT_URL" "$SOURCE_ROOT"
git -C "$SOURCE_ROOT" checkout --quiet --detach "$GRAV1SYNTH_COMMIT"
ACTUAL_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse HEAD)"
[[ "$ACTUAL_COMMIT" == "$GRAV1SYNTH_COMMIT" ]] || {
    echo "ERROR: checked out unexpected commit: $ACTUAL_COMMIT" >&2
    exit 1
}
git -C "$SOURCE_ROOT" apply --check "$PATCH_FILE"
git -C "$SOURCE_ROOT" apply "$PATCH_FILE"
git -C "$SOURCE_ROOT" diff --check

# Run the upstream suite plus the exact NVENC Sequence Header unit regression
# carried by our patch before producing a release binary.
cargo test --locked --manifest-path "$SOURCE_ROOT/Cargo.toml"
cargo build --release --locked --manifest-path "$SOURCE_ROOT/Cargo.toml"
mkdir -p "$(dirname "$BUILT_BIN")"
install -m 0755 "$SOURCE_ROOT/target/release/grav1synth" "$BUILT_BIN"

ACTUAL_VERSION="$("$BUILT_BIN" --version 2>&1)"
[[ "$ACTUAL_VERSION" == "grav1synth $GRAV1SYNTH_VERSION" ]] || {
    echo "ERROR: unexpected built version: $ACTUAL_VERSION" >&2
    exit 1
}

bash "$SCRIPT_DIR/test-grav1synth-nvenc-sequence-header.sh" \
    "$BUILT_BIN" "${TDARR_FFMPEG:-/usr/local/bin/tdarr-ffmpeg}"

BUILT_SHA256="$(sha256sum "$BUILT_BIN" | awk '{print $1}')"
cat >"$STAGE_ROOT/PROVENANCE.txt" <<EOF
name=grav1synth
version=$GRAV1SYNTH_VERSION
git_url=$GRAV1SYNTH_GIT_URL
git_commit=$GRAV1SYNTH_COMMIT
patch=grav1synth-nvenc-sequence-header.patch
patch_sha256=$PATCH_SHA256
nvenc_fixture_sha256=$NVENC_FIXTURE_SHA256
rustc=$(rustc --version)
cargo=$(cargo --version)
sha256=$BUILT_SHA256
EOF
printf '%s  %s\n' "$BUILT_SHA256" "bin/grav1synth" >"$STAGE_ROOT/SHA256SUMS"

echo "Build complete: $BUILT_BIN"
echo "SHA-256: $BUILT_SHA256"
echo "Review the result, then copy the staged bin/, PROVENANCE.txt, and SHA256SUMS"
echo "to the host custom-grav1synth/ directory before recreating Tdarr."
