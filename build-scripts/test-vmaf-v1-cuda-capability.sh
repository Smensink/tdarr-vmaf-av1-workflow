#!/bin/bash
set -euo pipefail

# Reproducible, read-only VMAF v1 CUDA capability probe.
#
# This does not install, rebuild, or promote FFmpeg/libvmaf artifacts. It tests
# the official standard v1 model against the active libvmaf_cuda filter and
# records the currently expected unsupported result as JSON.

FFMPEG_BIN="${VMAF_FFMPEG_BIN:-/usr/local/bin/tdarr-ffmpeg}"
REPORT_PATH="${VMAF_V1_CAPABILITY_REPORT:-/tmp/vmaf-v1-cuda-capability.json}"
EXPECTED_SHA256="${VMAF_V1_MODEL_SHA256:-e4cf8c147e1368b35497d772920bc92f98c1ad7853c1033d8a836947f427140e}"
MODEL_URL="${VMAF_V1_MODEL_URL:-https://raw.githubusercontent.com/Netflix/vmaf/v3.2.0/model/vmaf_v1.0.16/vmaf_v1.0.16_3d0h.json}"
CAPABILITY_ID="vmaf-v1.0.16-libvmaf-cuda-upstream-3.2.0-unsupported-v1"
EXPECTED_ERROR='could not initialize feature extractor "Cambi_feature_cambi_score"'

PROBE_DIR="$(mktemp -d /tmp/vmaf-v1-cuda-probe.XXXXXX)"
trap 'rm -rf -- "$PROBE_DIR"' EXIT

MODEL_PATH="${VMAF_V1_MODEL_PATH:-}"
if [[ -z "$MODEL_PATH" ]]; then
  for candidate in \
    /usr/local/share/model/vmaf_v1.0.16/vmaf_v1.0.16_3d0h.json \
    /tmp/vmaf-v3.2.0-audit/model/vmaf_v1.0.16/vmaf_v1.0.16_3d0h.json; do
    if [[ -f "$candidate" ]]; then
      MODEL_PATH="$candidate"
      break
    fi
  done
fi
if [[ -z "$MODEL_PATH" ]]; then
  MODEL_PATH="$PROBE_DIR/vmaf_v1.0.16_3d0h.json"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error "$MODEL_URL" --output "$MODEL_PATH"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --output-document="$MODEL_PATH" "$MODEL_URL"
  else
    echo "Neither curl nor wget is available to fetch the official VMAF v1 model" >&2
    exit 4
  fi
fi

if [[ ! -x "$FFMPEG_BIN" ]]; then
  echo "FFmpeg is not executable: $FFMPEG_BIN" >&2
  exit 4
fi
if [[ ! -f "$MODEL_PATH" ]]; then
  echo "VMAF v1 model is not readable: $MODEL_PATH" >&2
  exit 4
fi

ACTUAL_SHA256="$(sha256sum "$MODEL_PATH" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "VMAF v1 model SHA-256 mismatch: expected $EXPECTED_SHA256, observed $ACTUAL_SHA256" >&2
  exit 4
fi

LOG_PATH="$PROBE_DIR/vmaf.json"
STDOUT_PATH="$PROBE_DIR/ffmpeg.stdout"
STDERR_PATH="$PROBE_DIR/ffmpeg.stderr"
PREFERRED_LIBS="/custom-libvmaf-lib:/usr/local/ffmpeg-custom/lib:/usr/local/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/lib"
PROBE_LD_LIBRARY_PATH="$PREFERRED_LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

set +e
LD_LIBRARY_PATH="$PROBE_LD_LIBRARY_PATH" "$FFMPEG_BIN" \
  -hide_banner -y \
  -init_hw_device cuda=cuda0:0 \
  -filter_hw_device cuda0 \
  -f lavfi -i "testsrc2=size=128x128:rate=8:duration=0.5" \
  -f lavfi -i "testsrc2=size=128x128:rate=8:duration=0.5" \
  -filter_complex "[0:v]format=yuv420p,hwupload[dist];[1:v]format=yuv420p,hwupload[ref];[dist][ref]libvmaf_cuda=log_fmt=json:log_path=$LOG_PATH:model=path=$MODEL_PATH" \
  -f null - >"$STDOUT_PATH" 2>"$STDERR_PATH"
PROBE_RC=$?
set -e

STATUS="unexpected_failure"
SCRIPT_RC=3
if [[ "$PROBE_RC" -eq 0 && -s "$LOG_PATH" ]]; then
  STATUS="unexpected_supported"
  SCRIPT_RC=2
elif grep -Fq "$EXPECTED_ERROR" "$STDERR_PATH"; then
  STATUS="expected_unsupported"
  SCRIPT_RC=0
fi

FFMPEG_VERSION="$("$FFMPEG_BIN" -hide_banner -version 2>/dev/null | head -n 1 || true)"
node - "$REPORT_PATH" "$STATUS" "$PROBE_RC" "$CAPABILITY_ID" "$FFMPEG_VERSION" \
  "$MODEL_PATH" "$ACTUAL_SHA256" "$EXPECTED_SHA256" "$EXPECTED_ERROR" \
  "$STDOUT_PATH" "$STDERR_PATH" <<'NODE'
const fs = require('fs');
const [
  reportPath, status, probeRc, capabilityId, ffmpegVersion, modelPath,
  actualSha256, expectedSha256, expectedError, stdoutPath, stderrPath,
] = process.argv.slice(2);
function tail(file, max) {
  try {
    const value = fs.readFileSync(file, 'utf8');
    return value.length > max ? value.slice(-max) : value;
  } catch (_) {
    return '';
  }
}
const report = {
  schema: 1,
  capability_id: capabilityId,
  checked_at: new Date().toISOString(),
  status,
  expected_supported: false,
  production_eligible: false,
  probe_return_code: Number(probeRc),
  ffmpeg_version: ffmpegVersion,
  backend: 'libvmaf_cuda',
  scoring_pixel_format: 'yuv420p',
  model: {
    name: 'vmaf_v1.0.16_3d0h',
    path: modelPath,
    sha256: actualSha256,
    expected_sha256: expectedSha256,
  },
  expected_error: expectedError,
  stdout_tail: tail(stdoutPath, 4000),
  stderr_tail: tail(stderrPath, 8000),
};
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
NODE

echo "VMAF v1 CUDA capability: $STATUS"
echo "Report: $REPORT_PATH"
exit "$SCRIPT_RC"
