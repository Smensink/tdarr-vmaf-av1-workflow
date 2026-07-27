#!/bin/bash
# Stream two decoded native-10-bit Y4M inputs into the isolated standalone
# libvmaf runtime without materialising multi-gigabyte raw/Y4M files.
set -euo pipefail

usage() {
  printf '%s\n' 'usage: vmaf-v1-score --reference PATH --distorted PATH --output PATH --model VERSION --coded-width N --coded-height N --sample-aspect-ratio N:D --display-aspect-ratio N:D --geometry-normalization none [--metadata-output PATH] [--cambi-eotf sdr|pq] [--ffmpeg PATH] [--ffprobe PATH] [--threads N] [--subsample N]' >&2
  exit 64
}

reference=''
distorted=''
output=''
model=''
ffmpeg='/usr/local/bin/tdarr-ffmpeg'
ffprobe='/usr/local/bin/tdarr-ffprobe'
threads='4'
subsample='1'
metadata_output=''
cambi_eotf='sdr'
coded_width=''
coded_height=''
sample_aspect_ratio=''
display_aspect_ratio=''
geometry_normalization=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --reference) [ "$#" -ge 2 ] || usage; reference=$2; shift 2 ;;
    --distorted) [ "$#" -ge 2 ] || usage; distorted=$2; shift 2 ;;
    --output) [ "$#" -ge 2 ] || usage; output=$2; shift 2 ;;
    --model) [ "$#" -ge 2 ] || usage; model=$2; shift 2 ;;
    --metadata-output) [ "$#" -ge 2 ] || usage; metadata_output=$2; shift 2 ;;
    --cambi-eotf) [ "$#" -ge 2 ] || usage; cambi_eotf=$2; shift 2 ;;
    --ffmpeg) [ "$#" -ge 2 ] || usage; ffmpeg=$2; shift 2 ;;
    --ffprobe) [ "$#" -ge 2 ] || usage; ffprobe=$2; shift 2 ;;
    --coded-width) [ "$#" -ge 2 ] || usage; coded_width=$2; shift 2 ;;
    --coded-height) [ "$#" -ge 2 ] || usage; coded_height=$2; shift 2 ;;
    --sample-aspect-ratio) [ "$#" -ge 2 ] || usage; sample_aspect_ratio=$2; shift 2 ;;
    --display-aspect-ratio) [ "$#" -ge 2 ] || usage; display_aspect_ratio=$2; shift 2 ;;
    --geometry-normalization) [ "$#" -ge 2 ] || usage; geometry_normalization=$2; shift 2 ;;
    --threads) [ "$#" -ge 2 ] || usage; threads=$2; shift 2 ;;
    --subsample) [ "$#" -ge 2 ] || usage; subsample=$2; shift 2 ;;
    *) usage ;;
  esac
done

[ -n "$reference" ] && [ -f "$reference" ] || { printf 'reference is not readable: %s\n' "$reference" >&2; exit 66; }
[ -n "$distorted" ] && [ -f "$distorted" ] || { printf 'distorted is not readable: %s\n' "$distorted" >&2; exit 66; }
[ -n "$output" ] && [ -n "$model" ] || usage
[ -n "$metadata_output" ] || metadata_output=$output.transport.json
case "$cambi_eotf" in sdr|pq) ;; *) usage ;; esac
case "$model" in *[!A-Za-z0-9_.-]*|'') usage ;; esac
case "$threads:$subsample:$coded_width:$coded_height" in *[!0-9:]*|'':*|*::*) usage ;; esac
[ "$threads" -ge 1 ] && [ "$subsample" -ge 1 ] && [ "$coded_width" -ge 1 ] && [ "$coded_height" -ge 1 ] || usage
printf '%s\n' "$sample_aspect_ratio" | grep -Eq '^[1-9][0-9]*:[1-9][0-9]*$' || usage
printf '%s\n' "$display_aspect_ratio" | grep -Eq '^[1-9][0-9]*:[1-9][0-9]*$' || usage
[ "$geometry_normalization" = 'none' ] || usage
command -v "$ffmpeg" >/dev/null 2>&1 || { printf 'ffmpeg is not executable: %s\n' "$ffmpeg" >&2; exit 69; }
command -v "$ffprobe" >/dev/null 2>&1 || { printf 'ffprobe is not executable: %s\n' "$ffprobe" >&2; exit 69; }
command -v vmaf-v1 >/dev/null 2>&1 || { printf 'vmaf-v1 runtime is unavailable\n' >&2; exit 69; }

probe_video_geometry() {
  "$ffprobe" -v error -select_streams v:0 \
    -show_entries stream=width,height,sample_aspect_ratio,display_aspect_ratio \
    -of default=noprint_wrappers=1 "$1"
}
probe_value() {
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -n 1
}
reference_probe=$(probe_video_geometry "$reference") || {
  printf 'reference geometry probe failed: %s\n' "$reference" >&2; exit 65;
}
distorted_probe=$(probe_video_geometry "$distorted") || {
  printf 'distorted geometry probe failed: %s\n' "$distorted" >&2; exit 65;
}
reference_width=$(probe_value "$reference_probe" width)
reference_height=$(probe_value "$reference_probe" height)
reference_sar=$(probe_value "$reference_probe" sample_aspect_ratio)
reference_dar=$(probe_value "$reference_probe" display_aspect_ratio)
distorted_width=$(probe_value "$distorted_probe" width)
distorted_height=$(probe_value "$distorted_probe" height)
distorted_sar=$(probe_value "$distorted_probe" sample_aspect_ratio)
distorted_dar=$(probe_value "$distorted_probe" display_aspect_ratio)
[ "$reference_width" = "$coded_width" ] && [ "$distorted_width" = "$coded_width" ] &&
[ "$reference_height" = "$coded_height" ] && [ "$distorted_height" = "$coded_height" ] &&
[ "$reference_sar" = "$sample_aspect_ratio" ] && [ "$distorted_sar" = "$sample_aspect_ratio" ] &&
[ "$reference_dar" = "$display_aspect_ratio" ] && [ "$distorted_dar" = "$display_aspect_ratio" ] || {
  printf 'coded geometry/SAR/DAR mismatch: expected=%sx%s sar=%s dar=%s reference=%sx%s sar=%s dar=%s distorted=%sx%s sar=%s dar=%s\n' \
    "$coded_width" "$coded_height" "$sample_aspect_ratio" "$display_aspect_ratio" \
    "$reference_width" "$reference_height" "$reference_sar" "$reference_dar" \
    "$distorted_width" "$distorted_height" "$distorted_sar" "$distorted_dar" >&2
  exit 65
}

work_root=${VMAF_V1_WORK_ROOT:-${TMPDIR:-/temp}}
[ -d "$work_root" ] && [ -w "$work_root" ] || {
  printf 'VMAF scorer work root is not writable: %s\n' "$work_root" >&2
  exit 73
}
work_dir=$(mktemp -d "$work_root/vmaf-v1-score.XXXXXX")
output_partial=$output.partial.$$
metadata_partial=$metadata_output.partial.$$
ref_fifo=$work_dir/reference.y4m
dis_fifo=$work_dir/distorted.y4m
ref_log=$work_dir/reference.ffmpeg.log
dis_log=$work_dir/distorted.ffmpeg.log
ref_progress=$work_dir/reference.progress
dis_progress=$work_dir/distorted.progress
ref_pid=''
dis_pid=''
vmaf_pid=''
cleanup() {
  [ -z "$ref_pid" ] || kill "$ref_pid" 2>/dev/null || true
  [ -z "$dis_pid" ] || kill "$dis_pid" 2>/dev/null || true
  [ -z "$vmaf_pid" ] || kill "$vmaf_pid" 2>/dev/null || true
  rm -f "$output_partial" "$metadata_partial"
  rm -rf "$work_dir"
}
trap cleanup EXIT HUP INT TERM
[ ! -e "$output" ] || { printf 'refusing to replace existing VMAF output: %s\n' "$output" >&2; exit 73; }
[ ! -e "$metadata_output" ] || { printf 'refusing to replace existing transport output: %s\n' "$metadata_output" >&2; exit 73; }
rm -f "$output_partial" "$metadata_partial"
mkfifo "$ref_fifo" "$dis_fifo"

# Writers are launched before the reader; opening each FIFO blocks without
# allocating decoded-frame storage until vmaf-v1 opens both inputs.
"$ffmpeg" -hide_banner -loglevel error -nostdin -y -i "$reference" \
  -map 0:v:0 -an -sn -dn -pix_fmt yuv420p10le -strict -1 \
  -progress "$ref_progress" -nostats -f yuv4mpegpipe "$ref_fifo" \
  2>"$ref_log" &
ref_pid=$!
"$ffmpeg" -hide_banner -loglevel error -nostdin -y -i "$distorted" \
  -map 0:v:0 -an -sn -dn -pix_fmt yuv420p10le -strict -1 \
  -progress "$dis_progress" -nostats -f yuv4mpegpipe "$dis_fifo" \
  2>"$dis_log" &
dis_pid=$!

model_spec="version=$model:name=$model"
feature_spec='cambi=full_ref=true'
if [ "$cambi_eotf" = pq ]; then
  model_spec="$model_spec:cambi.cambi_eotf=pq"
  feature_spec="$feature_spec:cambi_eotf=pq"
fi

vmaf-v1 --reference "$ref_fifo" --distorted "$dis_fifo" \
  --model "$model_spec" \
  --feature "$feature_spec" --threads "$threads" --subsample "$subsample" \
  --output "$output_partial" --json &
vmaf_pid=$!

# Reap whichever of the two decoders or scorer exits first. A decoder can fail
# before opening its FIFO (bad input, permissions, unsupported stream); waiting
# for VMAF first would then deadlock forever in open(2). Any child failure kills
# the other two, while successful early decoder exits are retained until all
# three statuses are known.
ref_done=0
dis_done=0
vmaf_done=0
ref_rc=125
dis_rc=125
vmaf_rc=125
remaining=3
failure_seen=0
while [ "$remaining" -gt 0 ]; do
  finished_pid=''
  set +e
  wait -n -p finished_pid
  child_rc=$?
  set -e
  if [ -z "${finished_pid:-}" ]; then
    if [ "$failure_seen" -eq 1 ]; then
      [ "$ref_done" -eq 1 ] || { ref_done=1; ref_rc=137; }
      [ "$dis_done" -eq 1 ] || { dis_done=1; dis_rc=137; }
      [ "$vmaf_done" -eq 1 ] || { vmaf_done=1; vmaf_rc=137; }
      remaining=0
      break
    fi
    printf 'child supervisor lost all tracked processes\n' >&2
    kill "$ref_pid" "$dis_pid" "$vmaf_pid" 2>/dev/null || true
    exit 70
  fi
  case "$finished_pid" in
    "$ref_pid") ref_done=1; ref_rc=$child_rc ;;
    "$dis_pid") dis_done=1; dis_rc=$child_rc ;;
    "$vmaf_pid") vmaf_done=1; vmaf_rc=$child_rc ;;
    *)
      printf 'child supervisor reaped an unknown process: %s\n' "$finished_pid" >&2
      kill "$ref_pid" "$dis_pid" "$vmaf_pid" 2>/dev/null || true
      exit 70
      ;;
  esac
  remaining=$((remaining - 1))
  if [ "$child_rc" -ne 0 ] && [ "$failure_seen" -eq 0 ]; then
    failure_seen=1
    [ "$ref_done" -eq 1 ] || kill -TERM "$ref_pid" 2>/dev/null || true
    [ "$dis_done" -eq 1 ] || kill -TERM "$dis_pid" 2>/dev/null || true
    [ "$vmaf_done" -eq 1 ] || kill -TERM "$vmaf_pid" 2>/dev/null || true
    sleep 0.1
    [ "$ref_done" -eq 1 ] || kill -KILL "$ref_pid" 2>/dev/null || true
    [ "$dis_done" -eq 1 ] || kill -KILL "$dis_pid" 2>/dev/null || true
    [ "$vmaf_done" -eq 1 ] || kill -KILL "$vmaf_pid" 2>/dev/null || true
  fi
done
ref_pid=''; dis_pid=''; vmaf_pid=''

if [ "$vmaf_rc" -ne 0 ] || [ "$ref_rc" -ne 0 ] || [ "$dis_rc" -ne 0 ]; then
  printf 'vmaf-v1-score failed: vmaf=%s reference_decode=%s distorted_decode=%s\n' "$vmaf_rc" "$ref_rc" "$dis_rc" >&2
  [ ! -s "$ref_log" ] || { printf '%s\n' 'reference decoder:' >&2; sed -n '1,80p' "$ref_log" >&2; }
  [ ! -s "$dis_log" ] || { printf '%s\n' 'distorted decoder:' >&2; sed -n '1,80p' "$dis_log" >&2; }
  exit 70
fi
[ -s "$output_partial" ] || { printf 'vmaf-v1 produced no JSON output\n' >&2; exit 65; }
ref_frames=$(sed -n 's/^frame=//p' "$ref_progress" | tail -n 1)
dis_frames=$(sed -n 's/^frame=//p' "$dis_progress" | tail -n 1)
case "$ref_frames:$dis_frames" in *[!0-9:]*|'':*|*:) printf 'decoder progress did not publish finite frame counts\n' >&2; exit 65 ;; esac
[ "$ref_frames" -eq "$dis_frames" ] || {
  printf 'decoded frame-count mismatch: reference=%s distorted=%s\n' "$ref_frames" "$dis_frames" >&2
  exit 65
}
[ "$ref_frames" -ge 1 ] || { printf 'decoded frame count is zero\n' >&2; exit 65; }
printf '{"schema":2,"referenceFrames":%s,"distortedFrames":%s,"pixelFormat":"yuv420p10le","bitDepth":10,"subsample":%s,"model":"%s","cambiEotf":"%s","codedWidth":%s,"codedHeight":%s,"referenceSampleAspectRatio":"%s","distortedSampleAspectRatio":"%s","referenceDisplayAspectRatio":"%s","distortedDisplayAspectRatio":"%s","geometryNormalization":"%s"}\n' \
  "$ref_frames" "$dis_frames" "$subsample" "$model" "$cambi_eotf" \
  "$coded_width" "$coded_height" "$reference_sar" "$distorted_sar" \
  "$reference_dar" "$distorted_dar" "$geometry_normalization" > "$metadata_partial"
[ -s "$metadata_partial" ] || { printf 'transport metadata publication failed\n' >&2; exit 65; }

# The caller cannot inspect either final path until this process exits. Publish
# only after both decoders and VMAF have succeeded and frame identity is proven;
# roll back the first rename if the second cannot complete.
mv "$output_partial" "$output"
if ! mv "$metadata_partial" "$metadata_output"; then
  rm -f "$output"
  printf 'transport metadata finalization failed\n' >&2
  exit 74
fi
