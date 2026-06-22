# Public recipe image for Tdarr + VMAF workflow plumbing.
# This image copies plugin/init/build sources. It does not publish a prebuilt
# nonfree FFmpeg binary. Build FFmpeg locally with docker/build-ffmpeg-libvmaf.sh
# or mount your own /usr/local/ffmpeg-custom-compatible build.
FROM ghcr.io/haveagitgat/tdarr:latest

COPY custom-cont-init.d/ /custom-cont-init.d/
COPY build-ffmpeg-libvmaf.sh /usr/local/build-scripts/build-ffmpeg-libvmaf.sh
RUN chmod +x /custom-cont-init.d/*.sh /usr/local/build-scripts/build-ffmpeg-libvmaf.sh || true
