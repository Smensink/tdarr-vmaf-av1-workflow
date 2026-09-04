'use strict';

const CONTRACT_ID = 'av1-all-sources-10bit-delivery-v1';
const ENCODER_DOMAIN_BRIDGE_ID = 'ffmpeg-av1-nvenc-to-nvencc-depth-normalized-v1';
const AV1_DELIVERY_PIX_FMT = 'p010le';
const AV1_DELIVERY_BIT_DEPTH = 10;

const PIXEL_FORMAT_DEPTHS = Object.freeze({
  yuv420p: 8,
  yuvj420p: 8,
  nv12: 8,
  yuv420p10le: 10,
  p010le: 10,
});

function normalizePixelFormat(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim().toLowerCase();
}

function outputDepthForPixelFormat(pixelFormat) {
  const normalized = normalizePixelFormat(pixelFormat);
  const depth = PIXEL_FORMAT_DEPTHS[normalized];
  if (!depth) {
    throw new Error(`unsupported 4:2:0 pixel format: ${normalized || 'unknown'}`);
  }
  return depth;
}

function assertEncodedPixelFormat(requestedPixelFormat, observedPixelFormat) {
  const requested = normalizePixelFormat(requestedPixelFormat);
  const observed = normalizePixelFormat(observedPixelFormat);
  const requestedDepth = outputDepthForPixelFormat(requested);
  const observedDepth = outputDepthForPixelFormat(observed);
  if (requestedDepth !== observedDepth) {
    throw new Error(`requested pixel format ${requested} (${requestedDepth}-bit) ` +
      `but ffprobe observed ${observed} (${observedDepth}-bit)`);
  }
  return {
    requestedPixelFormat: requested,
    observedPixelFormat: observed,
    bitDepth: observedDepth,
  };
}

function av1EncoderDomainBridge() {
  return {
    schema: 1,
    contract_id: ENCODER_DOMAIN_BRIDGE_ID,
    measurement_backend: 'ffmpeg-av1_nvenc',
    delivery_backend: 'nvencc-rigaya-av1',
    selected_pixel_format: AV1_DELIVERY_PIX_FMT,
    measurement_bit_depth: AV1_DELIVERY_BIT_DEPTH,
    delivery_bit_depth: AV1_DELIVERY_BIT_DEPTH,
    correction: {
      type: 'selected-pixel-format-depth-normalization',
      cq_offset: 0,
      rationale: 'Both frontends retain the selected NVIDIA NVENC CQ value; the explicit correction is to normalize both domains to the selected 10-bit format and fail closed on delivered-depth drift rather than applying an uncalibrated numeric CQ translation.',
    },
  };
}

module.exports = {
  CONTRACT_ID,
  ENCODER_DOMAIN_BRIDGE_ID,
  AV1_DELIVERY_PIX_FMT,
  AV1_DELIVERY_BIT_DEPTH,
  normalizePixelFormat,
  outputDepthForPixelFormat,
  assertEncodedPixelFormat,
  av1EncoderDomainBridge,
};
