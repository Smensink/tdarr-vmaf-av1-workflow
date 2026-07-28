ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG NVENCC_RELEASE_ID=9.25-r3-03d8a26631fe-6ba05f266476

LABEL org.opencontainers.image.title="Tdarr r3 denoise retention trial runtime" \
      org.opencontainers.image.description="Batch-only authenticated r3 media toolchain; no Tdarr server state" \
      org.opencontainers.image.tdarr.scope="sample-only-denoise-retention-trial" \
      org.opencontainers.image.tdarr.production-promotion-authorized="false"

# These are named build contexts. They are supplied from the reviewed host
# artifacts so large binaries remain outside Git while the resulting local
# image is immutable and independently inspectable.
COPY --from=ffmpeg . /usr/local/ffmpeg-custom/
COPY --from=libvmaf libvmaf.so.3.0.0 /custom-libvmaf-lib/libvmaf.so.3.0.0
COPY --from=nvencc . /opt/nvencc-artifact/
COPY --from=grav1synth . /opt/grav1synth/

COPY --chmod=0555 runtime/denoise-trial/tdarr-ffmpeg /opt/denoise-trial/tdarr-ffmpeg
COPY --chmod=0555 runtime/denoise-trial/tdarr-ffprobe /opt/denoise-trial/tdarr-ffprobe
COPY --chmod=0444 tools/denoise-retention-trial.js /usr/local/libexec/denoise-retention-trial.js

RUN set -eu; \
    test -x /usr/local/ffmpeg-custom/bin/ffmpeg; \
    test -x /usr/local/ffmpeg-custom/bin/ffprobe; \
    test -f /custom-libvmaf-lib/libvmaf.so.3.0.0; \
    ln -s libvmaf.so.3.0.0 /custom-libvmaf-lib/libvmaf.so.3; \
    ln -s libvmaf.so.3 /custom-libvmaf-lib/libvmaf.so; \
    (cd /opt/nvencc-artifact && sha256sum --check --strict SHA256SUMS); \
    (cd /opt/grav1synth && sha256sum --check --strict SHA256SUMS); \
    release="/opt/nvencc/releases/${NVENCC_RELEASE_ID}"; \
    test ! -e "$release"; \
    mkdir -p \
      "$release" \
      /usr/local/libexec \
      /custom-cont-init.d \
      /usr/local/build-scripts \
      /opt/grav1synth-artifact \
      /opt/grain-pipeline-artifact; \
    chmod 0555 \
      /usr/local/libexec \
      /custom-cont-init.d \
      /usr/local/build-scripts \
      /opt/grav1synth-artifact \
      /opt/grain-pipeline-artifact \
      /opt/nvencc-artifact; \
    rm -f /usr/local/bin/tdarr-ffmpeg /usr/local/bin/tdarr-ffprobe; \
    install -m 0555 /opt/denoise-trial/tdarr-ffmpeg /usr/local/bin/tdarr-ffmpeg; \
    install -m 0555 /opt/denoise-trial/tdarr-ffprobe /usr/local/bin/tdarr-ffprobe; \
    cp -a /opt/nvencc-artifact/. "$release/"; \
    ln -s "releases/${NVENCC_RELEASE_ID}" /opt/nvencc/current; \
    ln -s /opt/nvencc/current/bin/nvencc /usr/local/bin/nvencc; \
    ln -s /opt/nvencc/current/libexec/tdarr-nvencc-knn-ffmpeg.js \
      /usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js; \
    ln -s /opt/grav1synth/bin/grav1synth /usr/local/bin/grav1synth; \
    chmod 0555 \
      /usr/local/ffmpeg-custom/bin/ffmpeg \
      /usr/local/ffmpeg-custom/bin/ffprobe \
      /opt/grav1synth/bin/grav1synth \
      "$release/bin/nvencc" \
      "$release/libexec/tdarr-nvencc-knn-ffmpeg.js"; \
    test "$(readlink /opt/nvencc/current)" = \
      "releases/${NVENCC_RELEASE_ID}"; \
    test "$(readlink /usr/local/bin/nvencc)" = \
      "/opt/nvencc/current/bin/nvencc"; \
    test "$(readlink /usr/local/bin/grav1synth)" = \
      "/opt/grav1synth/bin/grav1synth"; \
    node --check /usr/local/libexec/denoise-retention-trial.js

ENV TDARR_GPU_PIPELINE_LOCK_DIR=/temp/tdarr-vmaf-gpu-pipeline.lock

WORKDIR /
USER abc
HEALTHCHECK NONE
ENTRYPOINT ["node", "/usr/local/libexec/denoise-retention-trial.js"]
