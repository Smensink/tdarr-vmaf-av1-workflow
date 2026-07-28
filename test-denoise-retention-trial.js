'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const trial = require('./tools/denoise-retention-trial.js');
const production = require('./plugins/vmaf/_lib/nvenccKnn.js');
const initProduction = require(
  './custom-cont-init.d/vmaf-plugin-patches/_lib/nvenccKnn.js'
);
const productionGrain = require(
  './plugins/vmaf/_lib/grainAnalysisArtifact.js'
);
const productionGpuLock = require(
  './plugins/vmaf/_lib/gpuPipelineLock.js'
);
const productionTemporalFilter = require(
  './plugins/vmaf/_lib/nvencTemporalFilter.js'
);
const initProductionTemporalFilter = require(
  './custom-cont-init.d/vmaf-plugin-patches/_lib/nvencTemporalFilter.js'
);

const EXPECTED_SOURCE_SHA256 = '1'.repeat(64);
const RECEIPT_SHA256 = '2'.repeat(64);
const EVIDENCE_A_SHA256 = '3'.repeat(64);
const EVIDENCE_B_SHA256 = '4'.repeat(64);
const TOOL_SHA256 = Object.freeze({
  ffmpeg: '5'.repeat(64),
  ffprobe: '6'.repeat(64),
  nvencc: '7'.repeat(64),
  grav1synth: '8'.repeat(64),
});

function baseConfig(overrides) {
  return Object.assign({
    schema: 3,
    acknowledge_node_paused_and_drained: true,
    private_output_root: '/private/denoise-runs',
    acknowledge_protected_roots_complete: true,
    acknowledge_no_git_checkout_mounted: true,
    protected_roots: {
      media: ['/media'],
      tdarr_database: ['/app/server/Tdarr/DB2'],
      tdarr_config: ['/app/configs'],
      tdarr_plugins: ['/app/server/Tdarr/Plugins'],
      git: [],
      backups: ['/protected-host/backups'],
    },
    nvenc_quality_profile: 'enhanced',
    tools: {
      ffmpeg: '/usr/local/ffmpeg-custom/bin/ffmpeg',
      ffprobe: '/usr/local/ffmpeg-custom/bin/ffprobe',
      nvencc: '/opt/nvencc-artifact/bin/nvencc',
      grav1synth: '/opt/grav1synth-artifact/bin/grav1synth',
    },
    expected_tool_identities: {
      ffmpeg: {
        resolved_path: '/usr/local/ffmpeg-custom/bin/ffmpeg',
        sha256: TOOL_SHA256.ffmpeg,
        size_bytes: 1001,
        reviewed_symlink_chain: [],
      },
      ffprobe: {
        resolved_path: '/usr/local/ffmpeg-custom/bin/ffprobe',
        sha256: TOOL_SHA256.ffprobe,
        size_bytes: 1002,
        reviewed_symlink_chain: [],
      },
      nvencc: {
        resolved_path: '/opt/nvencc-artifact/bin/nvencc',
        sha256: TOOL_SHA256.nvencc,
        size_bytes: 1003,
        reviewed_symlink_chain: [],
      },
      grav1synth: {
        resolved_path: '/opt/grav1synth-artifact/bin/grav1synth',
        sha256: TOOL_SHA256.grav1synth,
        size_bytes: 1004,
        reviewed_symlink_chain: [],
      },
    },
    cases: [{
      case_id: 'kept-original-example',
      source_path: '/media/private/example.mkv',
      expected_source_sha256: EXPECTED_SOURCE_SHA256,
      expected_source_size_bytes: 123456789,
      provenance_receipt: {
        path: '/protected-host/backups/private-provenance.json',
        sha256: RECEIPT_SHA256,
        size_bytes: 1024,
      },
      cq: 16,
      clips: [
        { clip_id: 'dark-texture', timestamp_seconds: 60.25, duration_seconds: 8 },
        { clip_id: 'face-midtone', timestamp_seconds: 600.5, duration_seconds: 8 },
        { clip_id: 'bright-gradient', timestamp_seconds: 1200.75, duration_seconds: 8 },
      ],
    }],
  }, overrides || {});
}

const variants = trial.VARIANTS;
const inputSchema = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'docs', 'denoise-retention-trial-input.schema.json'),
  'utf8'
));
const provenanceSchema = JSON.parse(fs.readFileSync(
  path.join(
    __dirname,
    'docs',
    'denoise-retention-provenance-receipt.schema.json'
  ),
  'utf8'
));
const trialSource = fs.readFileSync(
  path.join(__dirname, 'tools', 'denoise-retention-trial.js'),
  'utf8'
);
const productionGrainPipelineSource = fs.readFileSync(
  path.join(
    __dirname,
    'custom-grain-pipeline',
    'releases',
    'v5-20260724-r1',
    'grain_pipeline_v5_direct.py'
  ),
  'utf8'
);
assert.strictEqual(trial.SCHEMA, 3);
assert.strictEqual(inputSchema.properties.schema.const, trial.SCHEMA);
assert.strictEqual(
  provenanceSchema.properties.schema.const,
  trial.PROVENANCE_RECEIPT_SCHEMA
);
assert.strictEqual(
  provenanceSchema.properties.kind.const,
  trial.PROVENANCE_RECEIPT_KIND
);
assert.deepStrictEqual(
  inputSchema.$defs.case.required,
  [
    'case_id',
    'source_path',
    'expected_source_sha256',
    'expected_source_size_bytes',
    'provenance_receipt',
    'cq',
    'clips',
  ]
);
assert.strictEqual(provenanceSchema.additionalProperties, false);
assert.strictEqual(
  provenanceSchema.properties.reviewed_evidence_artifacts.minItems,
  trial.MIN_REVIEWED_EVIDENCE_ARTIFACTS
);
assert.deepStrictEqual(
  inputSchema.properties.protected_roots.required,
  [
    'media',
    'tdarr_database',
    'tdarr_config',
    'tdarr_plugins',
    'git',
    'backups',
  ]
);
assert.strictEqual(
  inputSchema.required.includes('tools'),
  true
);
assert.strictEqual(
  inputSchema.required.includes('expected_tool_identities'),
  true
);
assert.deepStrictEqual(
  inputSchema.properties.tools.required,
  ['ffmpeg', 'ffprobe', 'nvencc', 'grav1synth']
);
assert.strictEqual(
  inputSchema.$defs.toolIdentity.required.includes('resolved_path'),
  true
);
assert.strictEqual(
  inputSchema.$defs.toolIdentity.required.includes('reviewed_symlink_chain'),
  true
);
assert.strictEqual(
  inputSchema.$defs.executableDependencyIdentity.required.includes(
    'reviewed_symlink_chain'
  ),
  true
);
assert.strictEqual(inputSchema.$defs.reviewedSymlinkChain.maxItems, 64);
assert.match(
  provenanceSchema.description,
  /chains belong to the denoise-retention trial input/
);
assert.strictEqual(trial.SETTING_WALL_MS, 12 * 60 * 1000);
assert.strictEqual(trial.GRAIN_DIFF_TIMEOUT_MS, 4 * 60 * 1000);
assert.strictEqual(trial.GRAIN_FIT_FRAMES, 144);
assert.strictEqual(trial.GRAIN_FIT_MAX_CANDIDATES, 3);
assert.strictEqual(trial.GRAIN_PROXY_POSITION_COUNT, 24);
assert.match(productionGrainPipelineSource, /DEFAULT_FRAMES = 144/);
assert.match(productionGrainPipelineSource, /DEFAULT_CANDIDATES = 3/);
assert.match(productionGrainPipelineSource, /PROXY_WIDTH = 192/);
assert.match(productionGrainPipelineSource, /PROXY_HEIGHT = 108/);
assert.match(productionGrainPipelineSource, /PROXY_FRAMES = 3/);
assert.match(productionGrainPipelineSource, /PROXY_SPACING_SECONDS = 2\.0/);
assert.match(productionGrainPipelineSource, /count = 24/);
assert.match(
  trialSource,
  /const grainTable = path\.join\(variantDir, 'grain-table\.txt'\);/
);
assert.match(
  trialSource,
  /flat-mid-luma-no-cut-proxy-ranking-v1/
);
assert.match(
  trialSource,
  /fitVariantGlobalGrainTable\(/
);
assert.doesNotMatch(
  trialSource,
  /path\.join\(clipDir, 'grain-table\.txt'\)/,
  'a trial setting must fit one production-shaped global table, not one per clip'
);
assert.strictEqual(
  trial.DIRECT_GLOBAL_GRAIN_END,
  productionGrain.DIRECT_GLOBAL_SEGMENT_END,
  'the trial must use the exact production INT64_MAX global segment'
);
assert.deepStrictEqual(
  variants.map((variant) => variant.strength),
  [0.08, 0.10, 0.12, 0.14],
  'the allowlist must remain modest and capped at 0.14'
);
assert.strictEqual(variants[0].settings, production.KNN_SETTINGS);
assert.strictEqual(variants[0].denoiseId, production.DENOISE_ID);
assert.strictEqual(
  variants[0].referenceContractId,
  production.REFERENCE_CONTRACT_ID
);
assert.strictEqual(production.KNN_SETTINGS, initProduction.KNN_SETTINGS);
assert.strictEqual(production.DENOISE_ID, initProduction.DENOISE_ID);
assert.strictEqual(
  production.REFERENCE_CONTRACT_ID,
  initProduction.REFERENCE_CONTRACT_ID
);
assert.deepStrictEqual(
  trial.NVENC_PROFILES.enhanced,
  productionTemporalFilter.tokenize(
    productionTemporalFilter.ENHANCED_QUALITY_FLAGS_CANONICAL
  ),
  'the standalone enhanced trial profile must match canonical production flags'
);
assert.deepStrictEqual(
  trial.NVENC_PROFILES.baseline,
  productionTemporalFilter.tokenize(
    productionTemporalFilter.BASELINE_QUALITY_FLAGS_CANONICAL
  ),
  'the standalone baseline trial profile must match canonical production flags'
);
assert.strictEqual(
  productionTemporalFilter.ENHANCED_QUALITY_FLAGS_CANONICAL,
  initProductionTemporalFilter.ENHANCED_QUALITY_FLAGS_CANONICAL
);
assert.strictEqual(
  productionTemporalFilter.BASELINE_QUALITY_FLAGS_CANONICAL,
  initProductionTemporalFilter.BASELINE_QUALITY_FLAGS_CANONICAL
);

const denoiseIds = new Set(variants.map((variant) => variant.denoiseId));
const referenceIds = new Set(variants.map((variant) => variant.referenceContractId));
const grainIds = new Set(variants.map((variant) => variant.grainContractId));
assert.strictEqual(denoiseIds.size, variants.length);
assert.strictEqual(referenceIds.size, variants.length);
assert.strictEqual(grainIds.size, variants.length);
for (const variant of variants.slice(1)) {
  assert.match(variant.denoiseId, /^trial-only-/);
  assert.match(variant.referenceContractId, /^trial-only-/);
  assert.match(variant.grainContractId, /^trial-only-/);
  assert.strictEqual(variant.productionCanonical, false);
}

const normalized = trial.normalizeConfig(baseConfig());
assert.deepStrictEqual(
  normalized.variants.map((variant) => variant.key),
  ['s008-control', 's010-trial', 's012-trial']
);
assert.strictEqual(normalized.cases[0].cq, 16);
assert.strictEqual(normalized.cases[0].caseClipSeconds, 24);
assert.strictEqual(
  normalized.cases[0].expectedSourceSha256,
  EXPECTED_SOURCE_SHA256
);
assert.strictEqual(
  normalized.cases[0].expectedSourceSizeBytes,
  123456789
);
assert.deepStrictEqual(normalized.cases[0].provenanceReceipt, {
  path: '/protected-host/backups/private-provenance.json',
  sha256: RECEIPT_SHA256,
  sizeBytes: 1024,
});
assert.strictEqual(normalized.nvencQualityProfile, 'enhanced');
assert.deepStrictEqual(normalized.expectedToolIdentities.ffmpeg, {
  resolvedPath: '/usr/local/ffmpeg-custom/bin/ffmpeg',
  sha256: TOOL_SHA256.ffmpeg,
  sizeBytes: 1001,
  reviewedSymlinkChain: [],
  wrapperContract: null,
});
const normalizedWrapperContract = trial.normalizeConfig(baseConfig({
  tools: {
    ...baseConfig().tools,
    ffmpeg: '/usr/local/bin/tdarr-ffmpeg',
  },
  expected_tool_identities: {
    ...baseConfig().expected_tool_identities,
    ffmpeg: {
      resolved_path: '/usr/local/bin/tdarr-ffmpeg',
      sha256: TOOL_SHA256.ffmpeg,
      size_bytes: 1001,
      reviewed_symlink_chain: [],
      wrapper_contract: {
        kind: 'posix-sh-exec-v1',
        interpreter: {
          path: '/bin/sh',
          resolved_path: '/usr/bin/dash',
          sha256: '9'.repeat(64),
          size_bytes: 2001,
          reviewed_symlink_chain: [
            { path: '/bin', target: 'usr/bin' },
            { path: '/usr/bin/sh', target: 'dash' },
          ],
        },
        exec_target: {
          path: '/usr/local/ffmpeg-custom/bin/ffmpeg',
          resolved_path: '/usr/local/ffmpeg-custom/bin/ffmpeg',
          sha256: 'a'.repeat(64),
          size_bytes: 2002,
          reviewed_symlink_chain: [],
        },
        ld_library_path:
          '/custom-libvmaf-lib:/usr/local/ffmpeg-custom/lib:${LD_LIBRARY_PATH:-}',
      },
    },
  },
}));
assert.strictEqual(
  normalizedWrapperContract.expectedToolIdentities.ffmpeg
    .wrapperContract.execTarget.path,
  '/usr/local/ffmpeg-custom/bin/ffmpeg'
);
assert.deepStrictEqual(
  normalizedWrapperContract.expectedToolIdentities.ffmpeg
    .wrapperContract.interpreter.reviewedSymlinkChain,
  [
    { path: '/bin', target: 'usr/bin' },
    { path: '/usr/bin/sh', target: 'dash' },
  ]
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    expected_tool_identities: {
      ...baseConfig().expected_tool_identities,
      ffmpeg: {
        ...baseConfig().expected_tool_identities.ffmpeg,
        wrapper_contract: {
          kind: 'posix-sh-exec-v1',
          interpreter: {
            path: '/bin/sh',
          resolved_path: '/usr/bin/dash',
          sha256: '9'.repeat(64),
          size_bytes: 2001,
          reviewed_symlink_chain: [
            { path: '/bin', target: 'usr/bin' },
            { path: '/usr/bin/sh', target: 'dash' },
          ],
        },
          exec_target: {
            path: '/qualified/ffmpeg',
          resolved_path: '/qualified/ffmpeg',
          sha256: 'a'.repeat(64),
          size_bytes: 2002,
          reviewed_symlink_chain: [],
        },
          ld_library_path: '   ',
        },
      },
    },
  })),
  /ld_library_path must be one non-empty line/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    expected_tool_identities: {
      ...baseConfig().expected_tool_identities,
      nvencc: {
        resolved_path: '/opt/nvencc-artifact/bin/nvencc',
        sha256: TOOL_SHA256.nvencc,
        size_bytes: 1003,
      },
    },
  })),
  /expected_tool_identities\.nvencc is missing reviewed_symlink_chain/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    expected_tool_identities: {
      ...baseConfig().expected_tool_identities,
      nvencc: {
        ...baseConfig().expected_tool_identities.nvencc,
        reviewed_symlink_chain: [
          { path: '/usr/local/bin/nvencc', target: '../bad\nlink' },
        ],
      },
    },
  })),
  /target must be 1-4096 non-control characters/
);
assert.strictEqual(normalized.privateOutputRoot, '/private/denoise-runs');
assert.deepStrictEqual(normalized.protectedRoots.media, ['/media']);
assert.strictEqual(normalized.thresholds.minimumControlSavingPct, 3);
assert.strictEqual(normalized.thresholds.minimumSourceEstimateSavingPct, 3);
assert.strictEqual(normalized.thresholds.maximumVmafDrop, 0.5);
assert.strictEqual(
  normalized.productionGpuLockPath,
  process.env.TDARR_GPU_PIPELINE_LOCK_DIR ||
    '/temp/tdarr-vmaf-gpu-pipeline.lock'
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    production_gpu_lock_path: '/private/not-production.lock',
  })),
  /must exactly match TDARR_GPU_PIPELINE_LOCK_DIR/
);

assert.throws(
  () => trial.normalizeConfig(baseConfig({ schema: 2 })),
  /input schema must be 3/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({ schema: '3' })),
  /input schema must be 3/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({ unexpected: true })),
  /input contains unknown field unexpected/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    include_strength_014: 'false',
  })),
  /include_strength_014 must be a boolean/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    strength_014_justification: '                    ',
  })),
  /justification must be a string of at least 20 characters/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    private_output_root: '/private/denoise-runs\ninjected',
  })),
  /must be an absolute path inside the container/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    nvenc_quality_profile: ['enhanced'],
  })),
  /nvenc_quality_profile must be enhanced or baseline/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    tools: null,
  })),
  /tools must be an object/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    tools: {
      ...baseConfig().tools,
      unexpected: '/tools/unexpected',
    },
  })),
  /tools contains unknown field unexpected/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      expected_source_sha256: undefined,
    }],
  })),
  /expected_source_sha256/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      expected_source_sha256: 'A'.repeat(64),
    }],
  })),
  /lowercase SHA-256/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      expected_source_size_bytes: Number.MAX_SAFE_INTEGER + 1,
    }],
  })),
  /positive safe integer/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      provenance_receipt: {
        ...baseConfig().cases[0].provenance_receipt,
        unexpected: true,
      },
    }],
  })),
  /unknown field unexpected/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      provenance_receipt: {
        ...baseConfig().cases[0].provenance_receipt,
        size_bytes: trial.MAX_PROVENANCE_RECEIPT_BYTES + 1,
      },
    }],
  })),
  /size_bytes exceeds 1048576/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      unexpected: true,
    }],
  })),
  /cases\[0\] contains unknown field unexpected/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      clips: [{
        ...baseConfig().cases[0].clips[0],
        unexpected: true,
      }].concat(baseConfig().cases[0].clips.slice(1)),
    }],
  })),
  /clips\[0\] contains unknown field unexpected/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      clips: [{
        ...baseConfig().cases[0].clips[0],
        timestamp_seconds: '60.25',
      }].concat(baseConfig().cases[0].clips.slice(1)),
    }],
  })),
  /timestamp_seconds must be a finite number/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      clips: [{
        ...baseConfig().cases[0].clips[0],
        review_note: 42,
      }].concat(baseConfig().cases[0].clips.slice(1)),
    }],
  })),
  /review_note must be a string/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      clips: [{
        ...baseConfig().cases[0].clips[0],
        review_note: 'x'.repeat(501),
      }].concat(baseConfig().cases[0].clips.slice(1)),
    }],
  })),
  /review_note must be a string of at most 500 characters/
);

assert.throws(
  () => trial.normalizeConfig(baseConfig({
    include_strength_014: true,
    strength_014_justification: 'try it',
  })),
  /acknowledge_s012_was_reviewed/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    include_strength_014: true,
    acknowledge_s012_was_reviewed: true,
    strength_014_justification: 'too short',
  })),
  /justification/
);
const with014 = trial.normalizeConfig(baseConfig({
  include_strength_014: true,
  acknowledge_s012_was_reviewed: true,
  strength_014_justification:
    'The 0.12 sample passed review but missed the size target.',
}));
assert.deepStrictEqual(
  with014.variants.map((variant) => variant.strength),
  [0.08, 0.10, 0.12, 0.14]
);

assert.throws(
  () => trial.normalizeConfig(baseConfig({
    acknowledge_node_paused_and_drained: false,
  })),
  /paused_and_drained/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      case_id: 'bad',
      source_path: '/media/bad.mkv',
      cq: 16,
      clips: [
        { clip_id: 'one', timestamp_seconds: 0, duration_seconds: 12 },
        { clip_id: 'two', timestamp_seconds: 20, duration_seconds: 12 },
      ],
    }],
  })),
  /3-5 exact clips/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    cases: [{
      ...baseConfig().cases[0],
      case_id: 'bad',
      source_path: '/media/bad.mkv',
      cq: 16,
      clips: [
        { clip_id: 'one', timestamp_seconds: 0, duration_seconds: 12 },
        { clip_id: 'two', timestamp_seconds: 20, duration_seconds: 12 },
        { clip_id: 'three', timestamp_seconds: 40, duration_seconds: 12 },
        { clip_id: 'four', timestamp_seconds: 60, duration_seconds: 4 },
      ],
    }],
  })),
  /cap is 36s/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    maximum_vmaf_drop: -0.1,
  })),
  /maximum_vmaf_drop must be from 0 to 5/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    private_output_root: undefined,
  })),
  /private_output_root/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    private_output_root: 'relative/trials',
  })),
  /absolute path/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    acknowledge_protected_roots_complete: false,
  })),
  /protected_roots_complete/
);
assert.throws(
  () => trial.normalizeConfig(baseConfig({
    protected_roots: {
      media: ['/media'],
      tdarr_database: ['/app/server/Tdarr/DB2'],
      tdarr_config: ['/app/configs'],
      tdarr_plugins: ['/app/server/Tdarr/Plugins'],
      git: [],
      backups: ['/protected-host/backups'],
    },
    acknowledge_no_git_checkout_mounted: false,
  })),
  /no_git_checkout_mounted/
);

function validProvenanceReceipt(overrides) {
  return Object.assign({
    schema: 1,
    kind: 'tdarr-denoise-retention-provenance-v1',
    case_id: normalized.cases[0].caseId,
    source_sha256: normalized.cases[0].expectedSourceSha256,
    source_size_bytes: normalized.cases[0].expectedSourceSizeBytes,
    cq: normalized.cases[0].cq,
    nvenc_quality_profile: 'enhanced',
    retained_original: true,
    job_decision: 'no_feasible_parameters',
    profile_evidence: 'explicit-enhanced',
    reviewed_evidence_artifacts: [
      {
        artifact_id: 'tdarr-job-report',
        sha256: EVIDENCE_A_SHA256,
        size_bytes: 5000,
      },
      {
        artifact_id: 'tdarr-jobsjsondb-row',
        sha256: EVIDENCE_B_SHA256,
        size_bytes: 6000,
      },
    ],
  }, overrides || {});
}

const validatedProvenance = trial.validateProvenanceReceipt(
  validProvenanceReceipt(),
  normalized.cases[0],
  normalized.nvencQualityProfile
);
assert.strictEqual(validatedProvenance.retainedOriginal, true);
assert.strictEqual(validatedProvenance.jobDecision, 'no_feasible_parameters');
assert.strictEqual(validatedProvenance.profileEvidence, 'explicit-enhanced');
assert.strictEqual(validatedProvenance.reviewedEvidenceArtifacts.length, 2);
const baselineNormalized = trial.normalizeConfig(baseConfig({
  nvenc_quality_profile: 'baseline',
}));
assert.strictEqual(
  trial.validateProvenanceReceipt(
    validProvenanceReceipt({
      nvenc_quality_profile: 'baseline',
      profile_evidence: 'explicit-baseline',
    }),
    baselineNormalized.cases[0],
    'baseline'
  ).profileEvidence,
  'explicit-baseline'
);

const receiptBytes = Buffer.from(
  `${JSON.stringify(validProvenanceReceipt(), null, 2)}\n`,
  'utf8'
);
const receiptReference = {
  sizeBytes: receiptBytes.length,
  sha256: crypto.createHash('sha256').update(receiptBytes).digest('hex'),
};
assert.deepStrictEqual(
  trial.authenticateJsonBytes(
    receiptReference, receiptBytes, 'test provenance receipt'
  ),
  validProvenanceReceipt()
);
assert.throws(
  () => trial.authenticateJsonBytes(
    receiptReference,
    Buffer.concat([receiptBytes, Buffer.from(' ')]),
    'test provenance receipt'
  ),
  /size does not match/
);
assert.throws(
  () => trial.authenticateJsonBytes(
    { ...receiptReference, sha256: 'f'.repeat(64) },
    receiptBytes,
    'test provenance receipt'
  ),
  /SHA-256 does not match/
);
assert.throws(
  () => trial.validateProvenanceReceipt(
    validProvenanceReceipt({ unexpected: true }),
    normalized.cases[0],
    'enhanced'
  ),
  /unknown field unexpected/
);
assert.throws(
  () => trial.validateProvenanceReceipt(
    validProvenanceReceipt({ schema: '1' }),
    normalized.cases[0],
    'enhanced'
  ),
  /receipt schema must be 1/
);
assert.throws(
  () => trial.validateProvenanceReceipt(
    validProvenanceReceipt({ case_id: 'different-case' }),
    normalized.cases[0],
    'enhanced'
  ),
  /case_id does not match/
);
assert.throws(
  () => trial.validateProvenanceReceipt(
    validProvenanceReceipt({ source_sha256: '5'.repeat(64) }),
    normalized.cases[0],
    'enhanced'
  ),
  /source identity does not match/
);
assert.throws(
  () => trial.validateProvenanceReceipt(
    validProvenanceReceipt({ cq: 17 }),
    normalized.cases[0],
    'enhanced'
  ),
  /CQ does not match/
);
assert.throws(
  () => trial.validateProvenanceReceipt(
    validProvenanceReceipt({ cq: '16' }),
    normalized.cases[0],
    'enhanced'
  ),
  /cq must be an integer/
);
assert.throws(
  () => trial.validateProvenanceReceipt(
    validProvenanceReceipt({
      nvenc_quality_profile: 'baseline',
      profile_evidence: 'explicit-baseline',
    }),
    normalized.cases[0],
    'enhanced'
  ),
  /NVENC profile does not match/
);
assert.throws(
  () => trial.validateProvenanceReceipt(
    validProvenanceReceipt({ profile_evidence: 'explicit-baseline' }),
    normalized.cases[0],
    'enhanced'
  ),
  /profile evidence does not prove/
);
assert.throws(
  () => trial.validateProvenanceReceipt(
    validProvenanceReceipt({ retained_original: false }),
    normalized.cases[0],
    'enhanced'
  ),
  /retained-original/
);
assert.throws(
  () => trial.validateProvenanceReceipt(
    validProvenanceReceipt({
      reviewed_evidence_artifacts:
        validProvenanceReceipt().reviewed_evidence_artifacts.slice(0, 1),
    }),
    normalized.cases[0],
    'enhanced'
  ),
  /must bind 2-16/
);
const duplicateEvidence = validProvenanceReceipt().reviewed_evidence_artifacts;
duplicateEvidence[1] = {
  artifact_id: 'different-artifact-id',
  sha256: duplicateEvidence[0].sha256,
  size_bytes: duplicateEvidence[0].size_bytes,
};
assert.throws(
  () => trial.validateProvenanceReceipt(
    validProvenanceReceipt({
      reviewed_evidence_artifacts: duplicateEvidence,
    }),
    normalized.cases[0],
    'enhanced'
  ),
  /duplicate evidence artifacts/
);
assert.strictEqual(
  trial.assertExpectedSourceIdentity(normalized.cases[0], {
    sha256: normalized.cases[0].expectedSourceSha256,
    sizeBytes: normalized.cases[0].expectedSourceSizeBytes,
    bytesHashed: normalized.cases[0].expectedSourceSizeBytes,
  }),
  true
);
assert.throws(
  () => trial.assertExpectedSourceIdentity(normalized.cases[0], {
    sha256: '9'.repeat(64),
    sizeBytes: normalized.cases[0].expectedSourceSizeBytes,
    bytesHashed: normalized.cases[0].expectedSourceSizeBytes,
  }),
  /expected authenticated identity/
);

const extraction = trial.buildExtractArgs({
  sourcePath: '/media/private/with-cover.mkv',
  outputPath: '/private/source-lossless.mkv',
  timestampSeconds: 10.25,
  frames: 193,
  depth: 10,
  streamSpecifier: 'v:1',
  stream: {
    color_range: 'tv',
    color_primaries: 'bt2020',
    color_transfer: 'smpte2084',
    color_space: 'bt2020nc',
  },
});
assert.strictEqual(extraction[extraction.indexOf('-map') + 1], '0:v:1');
assert.strictEqual(extraction[extraction.indexOf('-ss') + 1], '10.250000');
const sheet = trial.buildContactSheetArgs(
  '/private/source.mkv',
  '/private/trial.mkv',
  '/private/sheet.png',
  193,
  { width: 640, height: 360, x: 1280, y: 540 }
);
const sheetGraph = sheet[sheet.indexOf('-filter_complex') + 1];
assert.match(sheetGraph, /crop=640:360:1280:540/);
assert.doesNotMatch(sheetGraph, /scale=/, 'detail evidence must remain at 1:1 pixels');
assert.strictEqual(trial.hasSemanticGrainTable([
  'filmgrn1',
  'E 0 9223372036854775807 1',
  'sY 2 0 0.0 255 1.5',
].join('\n')), true);
assert.strictEqual(trial.hasSemanticGrainTable([
  'filmgrn1',
  'E 0 9223372036854775807 1',
  'sY 2 0 0.0 255 0.0',
].join('\n')), false);
assert.doesNotThrow(() => trial.assertDirectGlobalGrainTable([
  'filmgrn1',
  'E 0 9223372036854775807 1',
  'sY 2 0 0.0 255 1.5',
].join('\n')));
assert.throws(() => trial.assertDirectGlobalGrainTable([
  'filmgrn1',
  'E 0 4294967295 1',
  'sY 2 0 0.0 255 1.5',
].join('\n')), /exactly one unmodified global segment/);
assert.throws(() => trial.assertDirectGlobalGrainTable([
  'filmgrn1',
  'E 0 100 1',
  'E 101 200 1',
  'sY 2 0 0.0 255 1.5',
].join('\n')), /exactly one unmodified global segment/);
assert.throws(() => trial.assertDirectGlobalGrainTable([
  'filmgrn1',
  'E 0 9223372036854775807',
  'sY 2 0 0.0 255 1.5',
].join('\n')), /malformed or payload-free segment header/);
assert.throws(() => trial.assertDirectGlobalGrainTable([
  'filmgrn1',
  'E malformed',
  'E 0 9223372036854775807 1',
  'sY 2 0 0.0 255 1.5',
].join('\n')), /malformed or payload-free segment header/);
assert.throws(() => trial.assertDirectGlobalGrainTable([
  'filmgrn1',
  'E 10 9 1',
  'sY 2 0 0.0 255 1.5',
].join('\n')), /reversed segment boundary/);

const fitStarts = trial.productionGrainFitStartTimes(3600, 6);
assert.strictEqual(fitStarts.length, 24);
assert.strictEqual(fitStarts[0], 108);
assert.strictEqual(fitStarts[fitStarts.length - 1], 3486);
assert.strictEqual(
  trial.productionGrainFitStartTimes(18, 6).length,
  1
);
const proxyArgs = trial.buildGrainProxyArgs({
  sourcePath: '/media/private/example.mkv',
  streamIndex: 2,
  timestampSeconds: 108,
});
assert.strictEqual(proxyArgs[proxyArgs.indexOf('-ss') + 1], '108.000000');
assert.strictEqual(proxyArgs[proxyArgs.indexOf('-t') + 1], '6.000000');
assert.strictEqual(proxyArgs[proxyArgs.indexOf('-map') + 1], '0:2');
assert.strictEqual(
  proxyArgs[proxyArgs.indexOf('-vf') + 1],
  'fps=1/2,scale=192:108:flags=area,format=gray'
);
assert.strictEqual(proxyArgs[proxyArgs.length - 1], 'pipe:1');
const flatProxy = Buffer.alloc(
  trial.GRAIN_PROXY_WIDTH *
  trial.GRAIN_PROXY_HEIGHT *
  trial.GRAIN_PROXY_FRAMES,
  112
);
assert.deepStrictEqual(trial.analyzeGrainProxyBytes(flatProxy), {
  valid: true,
  meanLuma8bit: 112,
  meanGradient: 0,
  meanTemporalMad: 0,
  maximumTemporalMad: 0,
  cutLike: false,
  rankScore: 0,
});
const rankedFit = trial.rankProductionGrainFitEvidence([
  { startSeconds: 100, valid: true, rankScore: 1 },
  { startSeconds: 120, valid: true, rankScore: 0.5 },
  { startSeconds: 300, valid: true, rankScore: 2 },
  { startSeconds: 500, valid: true, rankScore: 3 },
], 1000, 6);
assert.deepStrictEqual(
  rankedFit.map((entry) => entry.startSeconds),
  [120, 300, 500],
  'production spacing must reject a better-scored but too-near candidate'
);
const reasonPlan = {
  candidates: [{}, {}, {}],
};
assert.strictEqual(
  trial.grainFitUnavailableDisposition(reasonPlan, [
    { status: 'rejected_non_global_table' },
    { status: 'rejected_empty_grain' },
    { status: 'rejected_non_global_table' },
  ]).reasonCode,
  'grain_synthesis_static_model_unrepresentable'
);
assert.strictEqual(
  trial.grainFitUnavailableDisposition(reasonPlan, [
    { status: 'rejected_non_global_table' },
    { status: 'failed_invalid_table' },
    { status: 'rejected_empty_grain' },
  ]).reasonCode,
  'grain_synthesis_invalid_table_output'
);
assert.strictEqual(
  trial.grainFitUnavailableDisposition(reasonPlan, [
    { status: 'rejected_non_global_table' },
    { status: 'failed' },
    { status: 'rejected_empty_grain' },
  ]).reasonCode,
  'grain_synthesis_fit_runtime_failure'
);
assert.strictEqual(
  trial.grainFitUnavailableDisposition({ candidates: [] }, []).reasonCode,
  'grain_synthesis_insufficient_flat_support'
);

const producer = trial.buildProducerArgs({
  sourcePath: '/private/source-lossless.mkv',
  frames: 193,
  depth: 10,
  variant: variants[1],
});
assert.deepStrictEqual(
  producer.slice(producer.indexOf('--vpp-knn'), producer.indexOf('--vpp-knn') + 2),
  ['--vpp-knn', 'radius=3,d=0,strength=0.10,lerp=0.2,th_lerp=0.8']
);
assert.strictEqual(producer[producer.length - 1], '-');
assert.strictEqual(producer.includes('--frames'), true);
assert.strictEqual(producer.includes('193'), true);

const encode = trial.buildEncodeArgs({
  inputPath: '/private/denoised.mkv',
  outputPath: '/private/encoded.mkv',
  depth: 10,
  cq: 16,
  profile: 'enhanced',
  stream: {
    color_range: 'tv',
    color_primaries: 'bt2020',
    color_transfer: 'smpte2084',
    color_space: 'bt2020nc',
  },
});
assert.strictEqual(encode[encode.indexOf('-c:v') + 1], 'av1_nvenc');
assert.strictEqual(encode[encode.indexOf('-preset') + 1], 'p7');
assert.strictEqual(encode[encode.indexOf('-cq') + 1], '16');
assert.strictEqual(encode[encode.indexOf('-pix_fmt') + 1], 'p010le');
assert.strictEqual(encode.includes('-tf_level'), false);
assert.doesNotThrow(() =>
  productionTemporalFilter.assertAv1NvencCommand(
    encode,
    productionTemporalFilter.CANONICAL_POLICY,
    'denoise-retention trial encode'
  )
);
assert.strictEqual(
  encode[encode.indexOf('-bsf:v:0') + 1],
  'av1_metadata=color_primaries=9:transfer_characteristics=16:matrix_coefficients=9'
);
assert.strictEqual(encode.includes('-an'), true);
assert.strictEqual(encode.includes('-sn'), true);
assert.strictEqual(encode.includes('-dn'), true);
assert.strictEqual(
  encode.some((value) => /hqdn3d|nlmeans|knnlm|vpp-knn/i.test(String(value))),
  false,
  'the FFmpeg consumer must not add a second denoiser'
);
const lumaArgs = trial.buildLumaArgs(
  '/private/source.mkv',
  '/private/evidence.raw',
  8,
  2,
  3
);
assert.strictEqual(trial.expectedLumaByteCount(3, 8, 2), 48);
assert.strictEqual(
  lumaArgs.includes('-frames:v'),
  false,
  'luma decode must not cap away unexpected extra frames'
);

const reference = Buffer.from([0, 63, 64, 111, 112, 175, 176, 255]);
const distorted = Buffer.from([1, 61, 65, 110, 114, 171, 180, 250]);
const evidence = trial.bandEvidence(reference, distorted, {
  frames: 1,
  width: 8,
  height: 1,
});
assert.strictEqual(evidence.exactDecodedEvidence, true);
assert.strictEqual(evidence.expectedDecodedFrames, 1);
assert.strictEqual(evidence.expectedLumaBytes, 8);
assert.strictEqual(evidence.unpairedReferenceBytes, 0);
assert.strictEqual(evidence.unpairedDistortedBytes, 0);
assert.throws(
  () => trial.bandEvidence(reference, distorted.subarray(0, 7), {
    frames: 1,
    width: 8,
    height: 1,
  }),
  /distorted luma byte count 7 does not equal expected 8/
);
assert.throws(
  () => trial.bandEvidence(reference, Buffer.concat([
    distorted,
    Buffer.from([0]),
  ]), {
    frames: 1,
    width: 8,
    height: 1,
  }),
  /distorted luma byte count 9 does not equal expected 8/
);
assert.deepStrictEqual(
  Object.keys(evidence.bands),
  ['dark', 'shadow', 'midtone', 'highlight']
);
for (const band of Object.values(evidence.bands)) {
  assert.strictEqual(band.pixels, 2);
  assert.ok(Number.isFinite(band.mae));
}
const exactAggregateEvidence = trial.aggregateBandEvidence([
  { bandEvidence: evidence },
]);
assert.strictEqual(exactAggregateEvidence.exactDecodedEvidence, true);
assert.strictEqual(exactAggregateEvidence.expectedDecodedFrames, 1);
assert.strictEqual(exactAggregateEvidence.pairedPixels, 8);
const unpairedAggregateEvidence = trial.aggregateBandEvidence([{
  bandEvidence: Object.assign({}, evidence, {
    exactDecodedEvidence: false,
    unpairedDistortedBytes: 1,
  }),
}]);
assert.strictEqual(unpairedAggregateEvidence.exactDecodedEvidence, false);
const partialMetricAggregate = trial.aggregateVariant({
  settingWallMs: 1,
  clips: [
    {
      grainedVideoPacketBytes: 100,
      grainedContainerBytes: 120,
      originalSourceIntervalPacketBytesEstimate: 200,
      metrics: { vmaf: 96, cambi: 1 },
      bandEvidence: evidence,
    },
    {
      grainedVideoPacketBytes: 100,
      grainedContainerBytes: 120,
      originalSourceIntervalPacketBytesEstimate: 200,
      metrics: { vmaf: null, cambi: null },
      bandEvidence: evidence,
    },
  ],
});
assert.strictEqual(partialMetricAggregate.meanVmaf, null);
assert.strictEqual(partialMetricAggregate.meanCambi, null);
assert.deepStrictEqual(partialMetricAggregate.metricCoverage, {
  totalClipCount: 2,
  vmafClipCount: 1,
  cambiClipCount: 1,
  vmafComplete: false,
  cambiComplete: false,
});

function variantResult(variant, bytes, vmaf, cambi, mae) {
  const bands = {};
  for (const band of trial.LUMA_BANDS) {
    bands[band.key] = {
      pixels: 10000,
      sourceShare: 0.25,
      mae,
      changedFraction: 0.1,
    };
  }
  return {
    variant,
    clips: ['clip-a', 'clip-b', 'clip-c'].map((clipId) => ({
      clipId,
      metrics: { vmaf, cambi },
    })),
    aggregate: {
      totalOutputVideoPacketBytes: bytes,
      totalOutputContainerBytes: bytes + 1000,
      totalOriginalSourceIntervalPacketBytesEstimate: 1100000,
      meanVmaf: vmaf,
      meanCambi: cambi,
      metricClipCount: 3,
      bandEvidence: {
        bands,
        presentBands: ['dark', 'shadow', 'midtone', 'highlight'],
        passesMultipleLuminanceBands: true,
        exactDecodedEvidence: true,
        expectedDecodedFrames: 3,
        referenceDecodedFrames: 3,
        distortedDecodedFrames: 3,
        expectedLumaBytes: 40000,
        pairedPixels: 40000,
        unpairedReferenceBytes: 0,
        unpairedDistortedBytes: 0,
      },
      exactDecodedEvidence: true,
      settingWallMs: 120000,
    },
  };
}

const decisions = trial.evaluateVariants([
  variantResult(variants[0], 1000000, 96.0, 2.0, 2.0),
  variantResult(variants[1], 950000, 95.8, 2.1, 2.1),
  variantResult(variants[2], 800000, 94.0, 3.0, 3.0),
], normalized.thresholds);
assert.strictEqual(decisions[0].objectiveScreenPass, true);
assert.ok(decisions[0].savingVsOriginalSourceIntervalEstimatePct > 3);
assert.strictEqual(decisions[0].decision, 'manual_visual_review_required');
assert.strictEqual(decisions[0].productionPromotionAuthorized, false);
assert.strictEqual(decisions[1].objectiveScreenPass, false);
assert.strictEqual(decisions[1].productionPromotionAuthorized, false);
const grainFitUnavailable = {
  variant: variants[1],
  status: 'setting_unavailable',
  unavailable: {
    reasonCode: 'grain_synthesis_static_model_unrepresentable',
  },
  clips: [],
  aggregate: null,
};
const unavailableFitDecision = trial.evaluateVariants([
  variantResult(variants[0], 1000000, 96.0, 2.0, 2.0),
  grainFitUnavailable,
], normalized.thresholds)[0];
assert.strictEqual(
  unavailableFitDecision.decision,
  'setting_unavailable_no_denoise_conclusion'
);
assert.strictEqual(unavailableFitDecision.objectiveScreenPass, false);
assert.strictEqual(
  unavailableFitDecision.settingAvailability.candidateReasonCode,
  'grain_synthesis_static_model_unrepresentable'
);
assert.strictEqual(
  unavailableFitDecision.metricEvidence.vmaf.status,
  'setting_unavailable'
);
assert.strictEqual(unavailableFitDecision.productionPromotionAuthorized, false);
const unavailableControlDecision = trial.evaluateVariants([
  {
    variant: variants[0],
    status: 'setting_unavailable',
    unavailable: {
      reasonCode: 'grain_synthesis_static_model_unrepresentable',
    },
    clips: [],
    aggregate: null,
  },
  variantResult(variants[1], 950000, 95.8, 2.1, 2.1),
], normalized.thresholds)[0];
assert.strictEqual(
  unavailableControlDecision.settingAvailability.control,
  'setting_unavailable'
);
assert.strictEqual(
  unavailableControlDecision.decision,
  'setting_unavailable_no_denoise_conclusion'
);
const truncatedExitZeroCandidate = variantResult(
  variants[1], 900000, 95.9, 2.0, 2.0
);
truncatedExitZeroCandidate.aggregate.exactDecodedEvidence = false;
truncatedExitZeroCandidate.aggregate.bandEvidence.exactDecodedEvidence = false;
const truncatedDecision = trial.evaluateVariants([
  variantResult(variants[0], 1000000, 96.0, 2.0, 2.0),
  truncatedExitZeroCandidate,
], normalized.thresholds)[0];
assert.strictEqual(truncatedDecision.gates.exactDecodedEvidence, false);
assert.strictEqual(
  truncatedDecision.objectiveScreenPass,
  false,
  'a truncated exit-0 variant cannot pass the objective screen'
);
const partialVmafCandidate = variantResult(
  variants[1], 950000, 95.8, 2.1, 2.1
);
partialVmafCandidate.clips[1].metrics.vmaf = null;
const partialVmafDecision = trial.evaluateVariants([
  variantResult(variants[0], 1000000, 96.0, 2.0, 2.0),
  partialVmafCandidate,
], normalized.thresholds)[0];
assert.strictEqual(
  partialVmafDecision.metricEvidence.vmaf.status,
  'partial_or_asymmetric'
);
assert.strictEqual(partialVmafDecision.gates.vmafNotMateriallyWorse, false);
assert.strictEqual(partialVmafDecision.objectiveScreenPass, false);

const partialCambiCandidate = variantResult(
  variants[1], 950000, 95.8, 2.1, 2.1
);
partialCambiCandidate.clips[2].metrics.cambi = null;
const partialCambiDecision = trial.evaluateVariants([
  variantResult(variants[0], 1000000, 96.0, 2.0, 2.0),
  partialCambiCandidate,
], normalized.thresholds)[0];
assert.strictEqual(
  partialCambiDecision.metricEvidence.cambi.status,
  'partial_or_asymmetric'
);
assert.strictEqual(partialCambiDecision.gates.cambiNotMateriallyWorse, false);
assert.strictEqual(partialCambiDecision.objectiveScreenPass, false);

const unavailableMetricDecision = trial.evaluateVariants([
  variantResult(variants[0], 1000000, null, null, 2.0),
  variantResult(variants[1], 950000, null, null, 2.1),
], normalized.thresholds)[0];
assert.strictEqual(unavailableMetricDecision.metricEvidence.vmaf.status, 'unavailable');
assert.strictEqual(unavailableMetricDecision.metricEvidence.cambi.status, 'unavailable');
assert.strictEqual(unavailableMetricDecision.gates.vmafNotMateriallyWorse, true);
assert.strictEqual(unavailableMetricDecision.gates.cambiNotMateriallyWorse, true);
assert.strictEqual(unavailableMetricDecision.metricEvidenceComplete, false);
assert.strictEqual(
  unavailableMetricDecision.objectiveScreenPass,
  true,
  'fully unavailable paired metrics intentionally leave the remaining screen active'
);
assert.strictEqual(
  unavailableMetricDecision.decision,
  'manual_visual_review_required'
);
assert.strictEqual(unavailableMetricDecision.productionPromotionAuthorized, false);

const zeroControlBand = variantResult(
  variants[0], 1000000, 96.0, 2.0, 2.0
);
const positiveCandidateBand = variantResult(
  variants[1], 950000, 95.8, 2.1, 2.1
);
zeroControlBand.aggregate.bandEvidence.bands.dark.mae = 0;
positiveCandidateBand.aggregate.bandEvidence.bands.dark.mae = 0.001;
const zeroControlRegressionDecision = trial.evaluateVariants([
  zeroControlBand,
  positiveCandidateBand,
], normalized.thresholds)[0];
assert.deepStrictEqual(
  zeroControlRegressionDecision.zeroControlBandRegressions,
  ['dark']
);
assert.strictEqual(
  zeroControlRegressionDecision.bandMaeIncreasePctVsControl.dark,
  null,
  'an unbounded percentage is represented without non-JSON Infinity'
);
assert.strictEqual(
  zeroControlRegressionDecision.gates.luminanceBandErrorBounded,
  false
);
assert.strictEqual(zeroControlRegressionDecision.objectiveScreenPass, false);

positiveCandidateBand.aggregate.bandEvidence.bands.dark.mae = 0;
const zeroToZeroDecision = trial.evaluateVariants([
  zeroControlBand,
  positiveCandidateBand,
], normalized.thresholds)[0];
assert.deepStrictEqual(zeroToZeroDecision.zeroControlBandRegressions, []);
assert.strictEqual(
  zeroToZeroDecision.bandMaeIncreasePctVsControl.dark,
  0
);
assert.strictEqual(zeroToZeroDecision.gates.luminanceBandErrorBounded, true);

assert.strictEqual(
  trial.parseCli([
    '--input', '/private/spec.json',
    '--output', '/private/denoise-runs/run',
  ]).nodeDrained,
  false,
  'execution receives an explicit false when --node-drained is omitted'
);

const sourceText = fs.readFileSync(
  path.join(__dirname, 'tools', 'denoise-retention-trial.js'),
  'utf8'
);
assert.doesNotMatch(sourceText, /vmaf_training\.db|\/api\/v2\/|update-node/);
assert.match(sourceText, /productionPromotionAuthorized:\s*false/g);
assert.ok(
  sourceText.indexOf("phase: 'startup-before-output'") <
    sourceText.indexOf('fs.mkdirSync(resolvedOutput'),
  'lock/process preflight must run before the output directory is created'
);
assert.ok(
  sourceText.indexOf('validateOutputPolicy(config, outputPath)') <
    sourceText.indexOf('fs.mkdirSync(resolvedOutput'),
  'canonical path containment must be proven before output is created'
);
assert.ok(
  sourceText.indexOf('await readAuthenticatedProvenanceReceipt(') <
    sourceText.indexOf('fs.mkdirSync(resolvedOutput'),
  'the private provenance receipt must authenticate before output is created'
);
assert.ok(
  sourceText.indexOf(
    'const sourceIdentity = await fullSourceIdentity(caseSpec.sourcePath)'
  ) < sourceText.indexOf('fs.mkdirSync(resolvedOutput'),
  'the expected full source identity must authenticate before output is created'
);
assert.ok(
  sourceText.indexOf('assertExpectedSourceIdentity(caseSpec, sourceIdentity)') <
    sourceText.indexOf('fs.mkdirSync(resolvedOutput'),
  'source hash and exact size must match before output is created'
);

assert.strictEqual(
  trial.dangerousProcessReason([
    'node', '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js',
  ]),
  'Tdarr NVEncC/FFmpeg coordinator'
);
assert.strictEqual(
  trial.dangerousProcessReason(['/usr/local/bin/nvencc', '--vpp-knn']),
  'NVEncC process'
);
assert.strictEqual(
  trial.dangerousProcessReason(['/usr/local/bin/tdarr-ffmpeg', '-filters']),
  'FFmpeg process'
);
assert.strictEqual(
  trial.dangerousProcessReason(['/usr/local/bin/vmaf-v1-score', '--reference']),
  'VMAF process'
);
assert.strictEqual(
  trial.dangerousProcessReason(['/usr/local/bin/grav1synth', 'apply']),
  'film-grain process'
);
assert.strictEqual(
  trial.dangerousProcessReason(['/app/Tdarr_Node/Tdarr_Node']),
  null,
  'the persistent node service alone is not evidence of active media work'
);

const processFixture = [
  { pid: 100, ppid: 1, argv: ['node', '/tmp/denoise-retention-trial.js'] },
  {
    pid: 101,
    ppid: 100,
    argv: ['/usr/local/bin/nvencc', '--vpp-knn'],
  },
  {
    pid: 200,
    ppid: 1,
    argv: ['node', '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js'],
  },
];
assert.deepStrictEqual(
  trial.conflictingProcesses(processFixture, 100).map((item) => item.pid),
  [200],
  'the harness process tree is excluded but a pre-existing coordinator is not'
);

const safetyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'denoise-trial-safety-'));
try {
  const absentLock = path.join(safetyRoot, 'production.lock');
  assert.doesNotThrow(() => trial.assertGpuQuiescent(absentLock, {
    phase: 'unit-clean',
    entries: processFixture.slice(0, 2),
    selfPid: 100,
  }));
  fs.mkdirSync(absentLock);
  assert.throws(() => trial.assertGpuQuiescent(absentLock, {
    phase: 'unit-lock',
    entries: [],
    selfPid: 100,
  }), /production lock exists/);

  const procRoot = path.join(safetyRoot, 'proc');
  const procPid = path.join(procRoot, '300');
  fs.mkdirSync(procPid, { recursive: true });
  fs.writeFileSync(
    path.join(procPid, 'cmdline'),
    Buffer.from('/usr/local/bin/nvencc\0--vpp-knn\0')
  );
  fs.writeFileSync(
    path.join(procPid, 'stat'),
    '300 (nvencc) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0'
  );
  const procEntries = trial.readProcEntries(procRoot);
  assert.strictEqual(procEntries.length, 1);
  assert.strictEqual(procEntries[0].pid, 300);
  assert.throws(() => trial.assertGpuQuiescent(
    path.join(safetyRoot, 'other-absent.lock'),
    { phase: 'unit-proc', procRoot, selfPid: 100 }
  ), /pre-existing media process.*NVEncC/s);
} finally {
  fs.rmSync(safetyRoot, { recursive: true, force: true });
}

function virtualPathFs(options) {
  options = options || {};
  const directories = new Set(
    (options.directories || []).map((item) => path.posix.normalize(item))
  );
  const files = new Map(
    (
      options.includeDefaultProvenance === false
        ? (options.files || [])
        : [
          '/protected-host/backups/private-provenance.json',
          ...(options.files || []),
        ]
    ).map((item) => [
      path.posix.normalize(typeof item === 'string' ? item : item.path),
      typeof item === 'string' ? Buffer.alloc(0) : Buffer.from(item.contents || ''),
    ])
  );
  const symlinks = new Set(
    (options.symlinks || []).map((item) => path.posix.normalize(item))
  );
  const realpaths = new Map(
    Object.entries(options.realpaths || {}).map(([key, value]) => [
      path.posix.normalize(key),
      path.posix.normalize(value),
    ])
  );
  const denied = new Set(
    (options.denied || []).map((item) => path.posix.normalize(item))
  );
  const missing = () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    return error;
  };
  const lstatSync = (value) => {
    const filePath = path.posix.normalize(value);
    if (denied.has(filePath)) {
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    }
    if (symlinks.has(filePath)) {
      return {
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true,
        size: 0,
      };
    }
    if (directories.has(filePath)) {
      return {
        isDirectory: () => true,
        isFile: () => false,
        isSymbolicLink: () => false,
        size: 0,
      };
    }
    if (files.has(filePath)) {
      return {
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
        size: files.get(filePath).length,
      };
    }
    throw missing();
  };
  return {
    lstatSync,
    realpathSync(value) {
      const filePath = path.posix.normalize(value);
      lstatSync(filePath);
      return realpaths.get(filePath) || filePath;
    },
    readFileSync(value) {
      const filePath = path.posix.normalize(value);
      lstatSync(filePath);
      if (!files.has(filePath)) throw missing();
      return Buffer.from(files.get(filePath));
    },
  };
}

const policyDirectories = [
  '/private/denoise-runs',
  '/media',
  '/media/private',
  '/app/server/Tdarr/DB2',
  '/app/configs',
  '/app/server/Tdarr/Plugins',
  '/protected-host/backups',
];
const cleanPolicyFs = virtualPathFs({
  directories: policyDirectories,
  files: ['/media/private/example.mkv'],
});
const cleanPolicy = trial.validateOutputPolicy(
  normalized,
  '/private/denoise-runs/run-1',
  { fileSystem: cleanPolicyFs }
);
assert.strictEqual(cleanPolicy.resolvedOutput, '/private/denoise-runs/run-1');
assert.deepStrictEqual(
  cleanPolicy.provenanceReceipts,
  ['/protected-host/backups/private-provenance.json']
);

assert.throws(
  () => trial.validateOutputPolicy(
    Object.assign({}, normalized, {
      cases: [{
        ...normalized.cases[0],
        provenanceReceipt: {
          ...normalized.cases[0].provenanceReceipt,
          path: '/private/unprotected/provenance.json',
        },
      }],
    }),
    '/private/denoise-runs/run-unprotected-receipt',
    {
      fileSystem: virtualPathFs({
        directories: policyDirectories.concat('/private/unprotected'),
        files: [
          '/media/private/example.mkv',
          '/private/unprotected/provenance.json',
        ],
      }),
    }
  ),
  /outside every declared protected backup root/
);

assert.throws(
  () => trial.validateOutputPolicy(
    normalized,
    '/private/other/run-1',
    {
      fileSystem: virtualPathFs({
        directories: policyDirectories.concat('/private/other'),
        files: ['/media/private/example.mkv'],
      }),
    }
  ),
  /contained by private_output_root/
);
assert.throws(
  () => trial.validateOutputPolicy(
    normalized,
    '/private/denoise-runs',
    { fileSystem: cleanPolicyFs }
  ),
  /already exists/
);
assert.throws(
  () => trial.validateOutputPolicy(
    Object.assign({}, normalized, {
      privateOutputRoot: '/media/private/trial-output',
    }),
    '/media/private/trial-output/run-1',
    {
      fileSystem: virtualPathFs({
        directories: policyDirectories.concat(
          '/media/private/trial-output'
        ),
        files: ['/media/private/example.mkv'],
      }),
    }
  ),
  /overlaps a source-parent directory/
);
for (const [group, protectedRoot] of [
  ['media', '/media'],
  ['tdarr_database', '/app/server/Tdarr/DB2'],
  ['tdarr_config', '/app/configs'],
  ['tdarr_plugins', '/app/server/Tdarr/Plugins'],
  ['git', '/workspace/repository'],
  ['backups', '/protected-host/backups'],
]) {
  const privateRoot = `${protectedRoot}/trial-output`;
  const groupRoots = Object.assign({}, normalized.protectedRoots);
  if (group === 'git') groupRoots.git = [protectedRoot];
  assert.throws(
    () => trial.validateOutputPolicy(
      Object.assign({}, normalized, {
        privateOutputRoot: privateRoot,
        protectedRoots: groupRoots,
      }),
      `${privateRoot}/run-1`,
      {
        fileSystem: virtualPathFs({
          directories: policyDirectories.concat(
            protectedRoot,
            privateRoot
          ),
          files: ['/media/private/example.mkv'],
        }),
      }
    ),
    new RegExp(`overlaps protected ${group} root`)
  );
}
assert.throws(
  () => trial.validateOutputPolicy(
    normalized,
    '/private/denoise-runs/run-1',
    {
      fileSystem: virtualPathFs({
        directories: policyDirectories,
        files: ['/media/private/example.mkv'],
        realpaths: {
          '/private/denoise-runs': '/private/elsewhere',
        },
      }),
    }
  ),
  /ambiguous canonical path/
);
assert.throws(
  () => trial.validateOutputPolicy(
    normalized,
    '/private/denoise-runs/run-1',
    {
      fileSystem: virtualPathFs({
        directories: policyDirectories.concat('/private/.git'),
        files: ['/media/private/example.mkv'],
      }),
    }
  ),
  /inside a Git root/
);
assert.throws(
  () => trial.validateOutputPolicy(
    normalized,
    '/private/denoise-runs/run-1',
    {
      fileSystem: virtualPathFs({
        directories: policyDirectories,
        files: ['/media/private/example.mkv'],
        denied: ['/private/denoise-runs/.git'],
      }),
    }
  ),
  /Git ancestry could not be inspected/
);
assert.throws(
  () => trial.validateOutputPolicy(
    Object.assign({}, normalized, {
      protectedRoots: Object.assign({}, normalized.protectedRoots, {
        media: ['/other-media'],
      }),
    }),
    '/private/denoise-runs/run-1',
    {
      fileSystem: virtualPathFs({
        directories: policyDirectories.concat('/other-media'),
        files: ['/media/private/example.mkv'],
      }),
    }
  ),
  /outside every declared media root/
);

const exactLumaRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'denoise-trial-luma-')
);
try {
  const exactLuma = path.join(exactLumaRoot, 'exact.raw');
  const truncatedLuma = path.join(exactLumaRoot, 'truncated.raw');
  fs.writeFileSync(exactLuma, Buffer.alloc(8));
  fs.writeFileSync(truncatedLuma, Buffer.alloc(7));
  assert.strictEqual(
    trial.readExactLumaFile(exactLuma, 8, 'exact fixture').length,
    8
  );
  assert.throws(
    () => trial.readExactLumaFile(
      truncatedLuma, 8, 'truncated exit-0 fixture'
    ),
    /byte count 7 does not equal expected 8/
  );
} finally {
  fs.rmSync(exactLumaRoot, { recursive: true, force: true });
}

class MockChild extends EventEmitter {
  constructor(name, killDelayMs, ignoreSigterm) {
    super();
    this.name = name;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.kills = [];
    this.killDelayMs = killDelayMs || 0;
    this.ignoreSigterm = ignoreSigterm === true;
  }

  finish(code, signal) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal || null;
    this.emit('exit', code, signal || null);
  }

  kill(signal) {
    this.kills.push(signal);
    if (signal === 'SIGTERM' && this.ignoreSigterm) return true;
    setTimeout(() => this.finish(null, signal), this.killDelayMs);
    return true;
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function testFullSourceIdentity() {
  const identityRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'denoise-trial-source-identity-')
  );
  const source = path.join(identityRoot, 'source.bin');
  const contents = Buffer.from('retained-original-source-identity-fixture');
  try {
    fs.writeFileSync(source, contents);
    const first = await trial.fullSourceIdentity(source, { chunkBytes: 4096 });
    const second = await trial.fullSourceIdentity(source, { chunkBytes: 4096 });
    assert.strictEqual(first.scheme, 'sha256-full-open-descriptor-v1');
    assert.strictEqual(first.bytesHashed, contents.length);
    assert.strictEqual(first.sizeBytes, contents.length);
    assert.strictEqual(
      first.sha256,
      crypto.createHash('sha256').update(contents).digest('hex')
    );
    assert.strictEqual(typeof first.device, 'string');
    assert.strictEqual(typeof first.inode, 'string');
    assert.strictEqual(typeof first.mtimeNs, 'string');
    assert.doesNotThrow(() =>
      trial.assertSameSourceIdentity(first, second, 'identity fixture')
    );
    assert.throws(
      () => trial.assertSameSourceIdentity(
        first,
        Object.assign({}, second, { sha256: '0'.repeat(64) }),
        'identity fixture'
      ),
      /changed during the trial.*sha256/
    );
  } finally {
    fs.rmSync(identityRoot, { recursive: true, force: true });
  }
}

async function testProductionShapedGrainFit() {
  const fitRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'denoise-trial-grain-fit-')
  );
  const sourcePath = path.join(fitRoot, 'source.mkv');
  const config = {
    tools: {
      ffmpeg: '/tools/ffmpeg',
      ffprobe: '/tools/ffprobe',
      nvencc: '/tools/nvencc',
      grav1synth: '/tools/grav1synth',
    },
  };
  const caseSpec = {
    caseId: 'fixture-case',
    sourcePath,
  };
  const media = {
    fps: 24,
    durationSeconds: 3600,
    depth: 8,
    stream: {
      index: 0,
      pix_fmt: 'yuv420p',
      color_range: 'tv',
      color_primaries: 'bt709',
      color_transfer: 'bt709',
      color_space: 'bt709',
    },
  };
  try {
    fs.writeFileSync(sourcePath, Buffer.from('source-fixture'));
    let proxyCalls = 0;
    const planned = await trial.buildProductionGrainFitPlan(
      config,
      caseSpec,
      media,
      {
        runCommandFn: async (_executable, argv) => {
          proxyCalls += 1;
          assert.strictEqual(argv[argv.indexOf('-frames:v') + 1], '3');
          return { stdoutBuffer: flatProxy };
        },
      }
    );
    assert.strictEqual(proxyCalls, 24);
    assert.strictEqual(planned.proxyPositionCount, 24);
    assert.strictEqual(planned.requestedFrames, 144);
    assert.strictEqual(planned.requestedCandidateLimit, 3);
    assert.strictEqual(planned.candidates.length, 3);

    const twoCandidatePlan = Object.assign({}, planned, {
      candidates: [
        { rank: 1, startSeconds: 100, valid: true, rankScore: 1 },
        { rank: 2, startSeconds: 500, valid: true, rankScore: 2 },
      ],
      proxyEvidence: [],
    });
    const variantDir = path.join(fitRoot, 'selected-variant');
    fs.mkdirSync(variantDir);
    const globalTable = Buffer.from([
      'filmgrn1',
      'E 0 9223372036854775807 1',
      'sY 2 0 0.0 255 1.5',
      '',
    ].join('\n'));
    const multiTable = Buffer.from([
      'filmgrn1',
      'E 0 100 1',
      'E 101 9223372036854775807 1',
      'sY 2 0 0.0 255 1.5',
      '',
    ].join('\n'));
    const commandRunner = async (executable, argv) => {
      if (executable === config.tools.ffmpeg) {
        assert.strictEqual(argv[argv.indexOf('-frames:v') + 1], '144');
        fs.writeFileSync(
          argv[argv.length - 1],
          Buffer.from(`lossless-${argv[argv.indexOf('-ss') + 1]}`)
        );
      } else if (executable === config.tools.grav1synth) {
        assert.strictEqual(argv[0], 'diff');
        assert.strictEqual(argv[3], '-o');
        assert.strictEqual(argv[argv.length - 1], '-y');
        const output = argv[argv.indexOf('-o') + 1];
        fs.writeFileSync(
          output,
          output.includes('candidate-1') ? multiTable : globalTable
        );
      } else {
        throw new Error(`unexpected command ${executable}`);
      }
      return { stdout: '', stderr: '', stdoutBuffer: Buffer.alloc(0) };
    };
    const pipelineRunner = async (
      _nvencc, producerArgs, _ffmpeg, consumerArgs
    ) => {
      assert.strictEqual(
        producerArgs[producerArgs.indexOf('--frames') + 1],
        '144'
      );
      assert.strictEqual(
        consumerArgs[consumerArgs.indexOf('-frames:v') + 1],
        '144'
      );
      fs.writeFileSync(
        consumerArgs[consumerArgs.length - 1],
        Buffer.from('denoised-lossless')
      );
      return { producerStderr: 'fixture diagnostics' };
    };
    const identityReader = async (filePath) => {
      const bytes = fs.readFileSync(filePath);
      return {
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
      };
    };
    const selected = await trial.fitVariantGlobalGrainTable(
      config,
      caseSpec,
      media,
      variantDir,
      variants[0],
      twoCandidatePlan,
      Date.now() + 60000,
      {
        runCommandFn: commandRunner,
        runPipelineFn: pipelineRunner,
        fullSourceIdentityFn: identityReader,
      }
    );
    assert.strictEqual(selected.status, 'available');
    assert.strictEqual(selected.grainFit.candidateRank, 2);
    assert.deepStrictEqual(
      selected.selection.attempts.map((attempt) => attempt.status),
      ['rejected_non_global_table', 'selected']
    );
    assert.deepStrictEqual(fs.readFileSync(selected.tablePath), globalTable);
    assert.strictEqual(
      fs.existsSync(path.join(variantDir, 'grain-fit-candidates')),
      false
    );
    assert.throws(
      () => trial.publishBytesAtomically(selected.tablePath, globalTable),
      /refusing to replace existing atomic output/
    );

    const unavailableDir = path.join(fitRoot, 'unavailable-variant');
    fs.mkdirSync(unavailableDir);
    const unavailable = await trial.fitVariantGlobalGrainTable(
      config,
      caseSpec,
      media,
      unavailableDir,
      variants[0],
      Object.assign({}, planned, {
        candidates: [
          { rank: 1, startSeconds: 100, valid: true, rankScore: 1 },
        ],
        proxyEvidence: [],
      }),
      Date.now() + 60000,
      {
        runCommandFn: commandRunner,
        runPipelineFn: pipelineRunner,
        fullSourceIdentityFn: identityReader,
      }
    );
    assert.strictEqual(unavailable.status, 'setting_unavailable');
    assert.strictEqual(
      unavailable.reasonCode,
      'grain_synthesis_static_model_unrepresentable'
    );
    assert.strictEqual(unavailable.tablePath, null);
    assert.strictEqual(
      fs.existsSync(path.join(unavailableDir, 'grain-table.txt')),
      false
    );

    const malformedDir = path.join(fitRoot, 'malformed-variant');
    fs.mkdirSync(malformedDir);
    const malformed = await trial.fitVariantGlobalGrainTable(
      config,
      caseSpec,
      media,
      malformedDir,
      variants[0],
      Object.assign({}, planned, {
        candidates: [
          { rank: 1, startSeconds: 100, valid: true, rankScore: 1 },
        ],
        proxyEvidence: [],
      }),
      Date.now() + 60000,
      {
        runCommandFn: async (executable, argv) => {
          if (executable === config.tools.grav1synth) {
            fs.writeFileSync(
              argv[argv.indexOf('-o') + 1],
              Buffer.from([
                'filmgrn1',
                'E 0 9223372036854775807',
                'sY 2 0 0.0 255 1.5',
                '',
              ].join('\n'))
            );
            return { stdout: '', stderr: '', stdoutBuffer: Buffer.alloc(0) };
          }
          return commandRunner(executable, argv);
        },
        runPipelineFn: pipelineRunner,
        fullSourceIdentityFn: identityReader,
      }
    );
    assert.strictEqual(
      malformed.reasonCode,
      'grain_synthesis_invalid_table_output'
    );
    assert.strictEqual(
      malformed.selection.attempts[0].status,
      'failed_invalid_table'
    );

    const runtimeFailureDir = path.join(fitRoot, 'runtime-failure-variant');
    fs.mkdirSync(runtimeFailureDir);
    const runtimeFailure = await trial.fitVariantGlobalGrainTable(
      config,
      caseSpec,
      media,
      runtimeFailureDir,
      variants[0],
      Object.assign({}, planned, {
        candidates: [
          { rank: 1, startSeconds: 100, valid: true, rankScore: 1 },
        ],
        proxyEvidence: [],
      }),
      Date.now() + 60000,
      {
        runCommandFn: async (executable, argv) => {
          if (executable === config.tools.grav1synth) {
            throw new Error('fixture command timed out');
          }
          return commandRunner(executable, argv);
        },
        runPipelineFn: pipelineRunner,
        fullSourceIdentityFn: identityReader,
      }
    );
    assert.strictEqual(
      runtimeFailure.reasonCode,
      'grain_synthesis_fit_runtime_failure'
    );
    assert.strictEqual(
      runtimeFailure.selection.attempts[0].status,
      'failed'
    );
  } finally {
    fs.rmSync(fitRoot, { recursive: true, force: true });
  }
}

async function testUnavailableControlShortCircuit() {
  const config = {
    variants: variants.slice(0, 3),
  };
  const caseSpec = { caseId: 'fixture-case' };
  const calls = [];
  const quiescence = [];
  const results = await trial.runConfiguredVariants(
    config,
    caseSpec,
    '/private/output',
    {},
    [],
    {},
    {
      runVariantFn: async (
        _config, _caseSpec, _caseDir, _media, _prepared, variant
      ) => {
        calls.push(variant.key);
        if (variant.role !== 'production-control') {
          throw new Error('stronger variant must not run after unavailable control');
        }
        return {
          variant,
          status: 'setting_unavailable',
          clips: [],
          aggregate: null,
          unavailable: {
            reasonCode: 'grain_synthesis_fit_runtime_failure',
          },
        };
      },
      recordGpuQuiescenceFn: (_config, phase) => quiescence.push(phase),
    }
  );
  assert.deepStrictEqual(calls, ['s008-control']);
  assert.strictEqual(results.length, 3);
  assert.strictEqual(quiescence.length, 2);
  for (const skipped of results.slice(1)) {
    assert.strictEqual(skipped.status, 'setting_unavailable');
    assert.strictEqual(
      skipped.unavailable.reasonCode,
      'control_setting_unavailable'
    );
    assert.strictEqual(
      skipped.unavailable.controlReasonCode,
      'grain_synthesis_fit_runtime_failure'
    );
    assert.strictEqual(skipped.unavailable.skippedWithoutGpuWork, true);
    assert.strictEqual(skipped.settingWallMs, 0);
  }
  const decisions = trial.evaluateVariants(results, normalized.thresholds);
  assert.strictEqual(decisions.length, 2);
  for (const decision of decisions) {
    assert.strictEqual(
      decision.decision,
      'setting_unavailable_no_denoise_conclusion'
    );
    assert.strictEqual(
      decision.settingAvailability.candidateReasonCode,
      'control_setting_unavailable'
    );
    assert.strictEqual(
      decision.settingAvailability.candidateControlReasonCode,
      'grain_synthesis_fit_runtime_failure'
    );
  }

  const successfulCalls = [];
  const successfulQuiescence = [];
  const successful = await trial.runConfiguredVariants(
    config,
    caseSpec,
    '/private/output',
    {},
    [],
    {},
    {
      runVariantFn: async (
        _config, _caseSpec, _caseDir, _media, _prepared, variant
      ) => {
        successfulCalls.push(variant.key);
        return {
          variant,
          status: 'available',
          clips: [],
          aggregate: {},
        };
      },
      recordGpuQuiescenceFn: (_config, phase) =>
        successfulQuiescence.push(phase),
    }
  );
  assert.deepStrictEqual(
    successfulCalls,
    ['s008-control', 's010-trial', 's012-trial']
  );
  assert.strictEqual(successful.length, 3);
  assert.strictEqual(successfulQuiescence.length, 6);
}

async function testAuthenticatedProvenanceReceiptFile() {
  const receiptRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'denoise-trial-provenance-')
  );
  const receiptPath = path.join(receiptRoot, 'receipt.json');
  const bytes = Buffer.from(
    `${JSON.stringify(validProvenanceReceipt(), null, 2)}\n`,
    'utf8'
  );
  const caseSpec = Object.assign({}, normalized.cases[0], {
    provenanceReceipt: {
      path: receiptPath,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
    },
  });
  try {
    fs.writeFileSync(receiptPath, bytes);
    const authenticated = await trial.readAuthenticatedProvenanceReceipt(
      caseSpec,
      'enhanced'
    );
    assert.strictEqual(authenticated.caseId, caseSpec.caseId);
    assert.strictEqual(authenticated.profileEvidence, 'explicit-enhanced');
    fs.appendFileSync(receiptPath, ' ');
    await assert.rejects(
      trial.readAuthenticatedProvenanceReceipt(caseSpec, 'enhanced'),
      /size is invalid or unauthenticated/
    );
  } finally {
    fs.rmSync(receiptRoot, { recursive: true, force: true });
  }
}

function writeExecutableFixture(filePath, contents) {
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

async function testExecutableIdentityContracts() {
  const identityRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'denoise-trial-tool-identity-')
  );
  try {
    const entrypoint = path.join(identityRoot, 'entrypoint.bin');
    const interpreter = path.join(identityRoot, 'interpreter.bin');
    const target = path.join(identityRoot, 'target.bin');
    writeExecutableFixture(entrypoint, Buffer.from('entrypoint-v1'));
    writeExecutableFixture(interpreter, Buffer.from('interpreter-v1'));
    writeExecutableFixture(target, Buffer.from('target-bytes-v1'));

    const entrypointIdentity = trial.fullExecutableIdentity(entrypoint, {
      chunkBytes: 4096,
    });
    const interpreterIdentity = trial.fullExecutableIdentity(interpreter, {
      chunkBytes: 4096,
    });
    const targetIdentity = trial.fullExecutableIdentity(target, {
      chunkBytes: 4096,
    });
    assert.strictEqual(
      entrypointIdentity.sha256,
      crypto.createHash('sha256').update('entrypoint-v1').digest('hex')
    );
    assert.doesNotThrow(() =>
      trial.assertExecutableIdentityUnchanged(
        entrypoint, entrypointIdentity, 'unit pre-spawn'
      )
    );

    const wrapper = trial.parsePosixShExecWrapperText([
      '#!/bin/sh',
      'export LD_LIBRARY_PATH=/qualified/lib:${LD_LIBRARY_PATH:-}',
      'exec /qualified/bin/ffmpeg "$@"',
      '',
    ].join('\n'), 'unit wrapper');
    assert.deepStrictEqual(wrapper, {
      interpreterPath: '/bin/sh',
      ldLibraryPath: '/qualified/lib:${LD_LIBRARY_PATH:-}',
      execTargetPath: '/qualified/bin/ffmpeg',
    });
    assert.throws(
      () => trial.parsePosixShExecWrapperText([
        '#!/bin/sh',
        'export LD_LIBRARY_PATH=/qualified/lib',
        'exec /qualified/bin/ffmpeg -unsafe "$@"',
      ].join('\n'), 'unit wrapper'),
      /not an exact posix-sh-exec-v1 wrapper/
    );

    const authenticatedTool = {
      entrypoint: { path: entrypoint, identity: entrypointIdentity },
      wrapper: {
        interpreter: { path: interpreter, identity: interpreterIdentity },
        execTarget: { path: target, identity: targetIdentity },
      },
    };
    assert.doesNotThrow(() =>
      trial.assertToolClosureUnchanged(
        authenticatedTool, 'unit wrapper closure'
      )
    );
    writeExecutableFixture(target, Buffer.from('target-bytes-v2'));
    assert.throws(
      () => trial.assertToolClosureUnchanged(
        authenticatedTool, 'unit wrapper target replacement'
      ),
      /identity changed/
    );

    const replacement = path.join(identityRoot, 'replacement.bin');
    writeExecutableFixture(entrypoint, Buffer.from('stable-inode'));
    const stableIdentity = trial.fullExecutableIdentity(entrypoint, {
      chunkBytes: 4096,
    });
    writeExecutableFixture(replacement, Buffer.from('stable-inode'));
    const originalTimes = fs.statSync(entrypoint);
    fs.utimesSync(
      replacement,
      originalTimes.atime,
      originalTimes.mtime
    );
    fs.unlinkSync(entrypoint);
    fs.renameSync(replacement, entrypoint);
    assert.throws(
      () => trial.assertExecutableIdentityUnchanged(
        entrypoint, stableIdentity, 'unit same-byte inode replacement'
      ),
      /identity changed/
    );

    const symlinkTargetA = path.join(identityRoot, 'symlink-target-a.bin');
    const symlinkTargetB = path.join(identityRoot, 'symlink-target-b.bin');
    const symlinkPath = path.join(identityRoot, 'published-tool');
    const intermediateA = path.join(identityRoot, 'intermediate-a');
    const intermediateB = path.join(identityRoot, 'intermediate-b');
    const chainedPath = path.join(identityRoot, 'published-chain');
    writeExecutableFixture(symlinkTargetA, Buffer.from('symlink-a'));
    writeExecutableFixture(symlinkTargetB, Buffer.from('symlink-b'));
    try {
      fs.symlinkSync(symlinkTargetA, symlinkPath, 'file');
      const symlinkIdentity = trial.fullExecutableIdentity(symlinkPath, {
        chunkBytes: 4096,
      });
      assert.strictEqual(
        symlinkIdentity.resolvedPath,
        fs.realpathSync(symlinkTargetA)
      );
      const reviewedSymlinkIdentity = {
        resolvedPath: symlinkIdentity.resolvedPath,
        sha256: symlinkIdentity.sha256,
        sizeBytes: symlinkIdentity.sizeBytes,
        reviewedSymlinkChain: symlinkIdentity.symlinkChain.map((hop) => ({
          path: hop.path,
          target: hop.target,
        })),
      };
      assert.doesNotThrow(() =>
        trial.assertMatchesExpectedExecutable(
          symlinkIdentity,
          reviewedSymlinkIdentity,
          'unit reviewed symlink chain'
        )
      );
      assert.throws(
        () => trial.assertMatchesExpectedExecutable(
          symlinkIdentity,
          {
            ...reviewedSymlinkIdentity,
            reviewedSymlinkChain: reviewedSymlinkIdentity
              .reviewedSymlinkChain.map((hop) => ({
                ...hop,
                target: `${hop.target}.unreviewed`,
              })),
          },
          'unit changed reviewed symlink chain'
        ),
        /reviewed symbolic-link chain/
      );
      fs.unlinkSync(symlinkPath);
      fs.symlinkSync(symlinkTargetB, symlinkPath, 'file');
      assert.throws(
        () => trial.assertExecutableIdentityUnchanged(
          symlinkPath, symlinkIdentity, 'unit symlink retarget'
        ),
        /identity changed/
      );

      fs.symlinkSync(symlinkTargetA, intermediateA, 'file');
      fs.symlinkSync(symlinkTargetA, intermediateB, 'file');
      fs.symlinkSync(intermediateA, chainedPath, 'file');
      const chainedIdentity = trial.fullExecutableIdentity(chainedPath, {
        chunkBytes: 4096,
      });
      assert.strictEqual(chainedIdentity.symlinkChain.length, 2);
      assert.doesNotThrow(() =>
        trial.assertMatchesExpectedExecutable(
          chainedIdentity,
          {
            resolvedPath: chainedIdentity.resolvedPath,
            sha256: chainedIdentity.sha256,
            sizeBytes: chainedIdentity.sizeBytes,
            reviewedSymlinkChain: chainedIdentity.symlinkChain.map((hop) => ({
              path: hop.path,
              target: hop.target,
            })),
          },
          'unit reviewed recursive symlink chain'
        )
      );
      fs.unlinkSync(intermediateA);
      fs.renameSync(intermediateB, intermediateA);
      assert.throws(
        () => trial.assertExecutableIdentityUnchanged(
          chainedPath,
          chainedIdentity,
          'unit intermediate symlink replacement'
        ),
        /identity changed/
      );
    } catch (error) {
      if (!error || !['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
        throw error;
      }
    }
  } finally {
    fs.rmSync(identityRoot, { recursive: true, force: true });
  }
}

async function testProductionGpuLeaseContracts() {
  const leaseRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'denoise-trial-gpu-lease-')
  );
  const lockPath = path.join(leaseRoot, 'production.lock');
  const registry = trial.createChildRegistry({ graceMs: 25 });
  const previousLockPath = process.env.TDARR_GPU_PIPELINE_LOCK_DIR;
  process.env.TDARR_GPU_PIPELINE_LOCK_DIR = lockPath;
  let lease = null;
  try {
    lease = trial.acquireProductionGpuLease(lockPath, {
      registry,
      allowShortHeartbeatForTests: true,
      heartbeatIntervalMs: 25,
    });
    const ownerPath = path.join(lockPath, 'owner.json');
    const originalOwnerBytes = fs.readFileSync(ownerPath);
    const owned = trial.assertOwnedProductionGpuLease(lockPath, lease);
    assert.strictEqual(owned.owned, true);
    assert.strictEqual(owned.automaticStaleBreakDisabled, true);
    assert.strictEqual(owned.tokenSha256.length, 64);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(owned, 'token'), false);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(lockPath).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(ownerPath).mode & 0o777, 0o600);
    }

    const productionAttempt = productionGpuLock.tryAcquireOnce({
      lockDir: lockPath,
      owner: { ownerId: 'production-unit-attempt' },
    });
    assert.strictEqual(productionAttempt.acquired, false);
    assert.deepStrictEqual(fs.readFileSync(ownerPath), originalOwnerBytes);

    const cleanEntries = [{
      pid: process.pid,
      ppid: 1,
      argv: [process.execPath, __filename],
    }];
    assert.doesNotThrow(() =>
      trial.assertFinalGpuProcessDrain(lease, {
        registry,
        entries: cleanEntries,
        selfPid: process.pid,
      })
    );
    assert.throws(
      () => trial.assertFinalGpuProcessDrain(lease, {
        registry,
        entries: cleanEntries.concat({
          pid: process.pid + 100000,
          ppid: process.pid,
          argv: ['/usr/local/bin/nvencc', '--vpp-knn'],
        }),
        selfPid: process.pid,
      }),
      /final GPU drain found 1 media process/
    );

    const deadOwner = JSON.parse(originalOwnerBytes.toString('utf8'));
    deadOwner.pid = 2147483000;
    deadOwner.workerStartTime = 1;
    clearInterval(lease.heartbeatTimer);
    lease.heartbeatTimer = null;
    const deadOwnerBytes = Buffer.from(
      `${JSON.stringify(deadOwner, null, 2)}\n`
    );
    fs.writeFileSync(ownerPath, deadOwnerBytes);
    await assert.rejects(
      productionGpuLock.acquire({
        lockDir: lockPath,
        owner: { ownerId: 'production-stale-break-attempt' },
        waitPollSeconds: 1,
        maxWaitSeconds: 1,
      }),
      /Timed out waiting/
    );
    assert.deepStrictEqual(fs.readFileSync(ownerPath), deadOwnerBytes);
    fs.writeFileSync(ownerPath, originalOwnerBytes);
    assert.strictEqual(
      trial.releaseProductionGpuLease(lease).released,
      true
    );
    lease = null;

    const raceLease = trial.acquireProductionGpuLease(lockPath, {
      registry,
      allowShortHeartbeatForTests: true,
      heartbeatIntervalMs: 25,
    });
    lease = raceLease;
    const raceOwnerPath = path.join(lockPath, 'owner.json');
    const raceOwnerBytes = fs.readFileSync(raceOwnerPath);
    const wrongTokenLease = Object.assign({}, raceLease, {
      token: 'wrong-token',
      heartbeatTimer: null,
      heartbeatFd: null,
    });
    assert.strictEqual(
      trial.releaseProductionGpuLease(wrongTokenLease).released,
      false
    );
    assert.strictEqual(fs.existsSync(lockPath), true);
    const refusedRelease = trial.releaseProductionGpuLease(raceLease, {
      afterRename(retiredPath) {
        const retiredOwnerPath = path.join(retiredPath, 'owner.json');
        const foreignOwner = JSON.parse(
          fs.readFileSync(retiredOwnerPath, 'utf8')
        );
        foreignOwner.token = 'foreign';
        fs.writeFileSync(
          retiredOwnerPath,
          `${JSON.stringify(foreignOwner, null, 2)}\n`
        );
      },
    });
    assert.strictEqual(refusedRelease.released, false);
    assert.strictEqual(fs.existsSync(lockPath), true);
    fs.writeFileSync(raceOwnerPath, raceOwnerBytes);
    assert.strictEqual(
      trial.releaseProductionGpuLease(raceLease).released,
      true
    );
    lease = null;

    fs.mkdirSync(lockPath);
    const foreignOwnerPath = path.join(lockPath, 'owner.json');
    const foreignBytes = Buffer.from('not-json-but-owned-by-someone-else');
    fs.writeFileSync(foreignOwnerPath, foreignBytes);
    assert.throws(
      () => trial.acquireProductionGpuLease(lockPath, { registry }),
      /already exists; refusing to steal or remove it/
    );
    assert.deepStrictEqual(fs.readFileSync(foreignOwnerPath), foreignBytes);
    fs.unlinkSync(foreignOwnerPath);
    fs.rmdirSync(lockPath);

    const heartbeatRegistry = trial.createChildRegistry({ graceMs: 25 });
    const heartbeatLease = trial.acquireProductionGpuLease(lockPath, {
      registry: heartbeatRegistry,
      allowShortHeartbeatForTests: true,
      heartbeatIntervalMs: 25,
    });
    lease = heartbeatLease;
    const heartbeatOwnerPath = path.join(lockPath, 'owner.json');
    const heartbeatOwnerBytes = fs.readFileSync(heartbeatOwnerPath);
    const changedOwner = JSON.parse(heartbeatOwnerBytes.toString('utf8'));
    changedOwner.token = 'changed';
    fs.writeFileSync(
      heartbeatOwnerPath,
      `${JSON.stringify(changedOwner, null, 2)}\n`
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(heartbeatLease.heartbeatError);
    assert.strictEqual(heartbeatRegistry.isShuttingDown(), true);
    let lateSpawnCalls = 0;
    await assert.rejects(
      trial.runCommand('/tools/ffmpeg', [], {
        registry: heartbeatRegistry,
        spawn: () => {
          lateSpawnCalls += 1;
          return new MockChild('unsafe-late-spawn');
        },
      }),
      /signal cleanup is active/
    );
    assert.strictEqual(lateSpawnCalls, 0);
    fs.writeFileSync(heartbeatOwnerPath, heartbeatOwnerBytes);
    heartbeatLease.heartbeatError = null;
    assert.strictEqual(
      trial.releaseProductionGpuLease(heartbeatLease).released,
      true
    );
    lease = null;

    const guardRegistry = trial.createChildRegistry({ graceMs: 25 });
    const guardLease = trial.acquireProductionGpuLease(lockPath, {
      registry: guardRegistry,
      allowShortHeartbeatForTests: true,
      heartbeatIntervalMs: 25,
    });
    lease = guardLease;
    const authenticatedTools = {};
    for (const toolKey of trial.TOOL_KEYS) {
      const toolPath = path.join(leaseRoot, `${toolKey}.bin`);
      writeExecutableFixture(toolPath, Buffer.from(`${toolKey}-stable-v1`));
      authenticatedTools[toolKey] = {
        toolKey,
        path: toolPath,
        authenticated: true,
        entrypoint: {
          path: toolPath,
          identity: trial.fullExecutableIdentity(toolPath, {
            chunkBytes: 4096,
          }),
        },
        wrapper: null,
      };
    }
    const leaseGuard =
      trial.activateProductionGpuLeaseEnforcement(guardLease);
    const toolGuard = trial.activateAuthenticatedTools(authenticatedTools);
    try {
      writeExecutableFixture(
        authenticatedTools.ffmpeg.path,
        Buffer.from('ffmpeg-changed-v2')
      );
      let guardedSpawnCalls = 0;
      await assert.rejects(
        trial.runPipeline(
          authenticatedTools.nvencc.path,
          [],
          authenticatedTools.ffmpeg.path,
          [],
          {
            registry: guardRegistry,
            spawn: () => {
              guardedSpawnCalls += 1;
              return new MockChild('must-not-spawn');
            },
          }
        ),
        /ffmpeg.*identity changed/i
      );
      assert.strictEqual(
        guardedSpawnCalls,
        0,
        'both pipeline executable closures must authenticate before either spawn'
      );
    } finally {
      toolGuard.dispose();
      leaseGuard.dispose();
    }
    assert.strictEqual(
      trial.releaseProductionGpuLease(guardLease).released,
      true
    );
    lease = null;
  } finally {
    if (lease) {
      const release = trial.releaseProductionGpuLease(lease);
      if (!release.released && fs.existsSync(lockPath)) {
        const ownerPath = path.join(lockPath, 'owner.json');
        const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        owner.token = lease.token;
        owner.leaseGeneration = lease.leaseGeneration;
        owner.pid = lease.pid;
        owner.workerStartTime = lease.workerStartTime;
        owner.automaticStaleBreakDisabled = true;
        fs.writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
        trial.releaseProductionGpuLease(lease);
      }
    }
    if (previousLockPath === undefined) {
      delete process.env.TDARR_GPU_PIPELINE_LOCK_DIR;
    } else {
      process.env.TDARR_GPU_PIPELINE_LOCK_DIR = previousLockPath;
    }
    fs.rmSync(leaseRoot, { recursive: true, force: true });
  }
}

async function testPipelineAndSignalCleanup() {
  {
    const decodeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'denoise-trial-exit-zero-')
    );
    const outputPath = path.join(decodeRoot, 'truncated.raw');
    let mockedExitCode = null;
    try {
      await assert.rejects(
        trial.decodeExactLuma({
          ffmpeg: '/tools/ffmpeg',
          inputPath: '/private/variant.mkv',
          outputPath,
          frames: 1,
          width: 8,
          height: 1,
          description: 'truncated exit-0 variant',
          runCommandFn: async () => {
            fs.writeFileSync(outputPath, Buffer.alloc(7));
            mockedExitCode = 0;
            return { code: 0 };
          },
        }),
        /byte count 7 does not equal expected 8/
      );
      assert.strictEqual(
        mockedExitCode,
        0,
        'an exit-zero decoder must still be rejected when bytes are truncated'
      );
    } finally {
      fs.rmSync(decodeRoot, { recursive: true, force: true });
    }
  }

  {
    const producerChild = new MockChild('producer');
    const consumerChild = new MockChild('consumer');
    const children = [producerChild, consumerChild];
    const registry = trial.createChildRegistry({ graceMs: 25 });
    const pipeline = trial.runPipeline(
      '/tools/nvencc', [], '/tools/ffmpeg', [],
      {
        timeoutMs: 1000,
        registry,
        spawn: () => children.shift(),
      }
    );
    const rejectedPipeline = assert.rejects(
      pipeline,
      /FFmpeg consumer exited before NVEncC producer completed/
    );
    consumerChild.finish(0, null);
    await nextTurn();
    assert.deepStrictEqual(
      producerChild.kills,
      ['SIGTERM'],
      'a consumer that exits first must terminate its producer even on code 0'
    );
    await rejectedPipeline;
    assert.strictEqual(registry.size(), 0);
  }

  {
    const producerChild = new MockChild('producer', 0, true);
    const consumerChild = new MockChild('consumer');
    const children = [producerChild, consumerChild];
    const registry = trial.createChildRegistry({ graceMs: 25 });
    const pipeline = trial.runPipeline(
      '/tools/nvencc', [], '/tools/ffmpeg', [],
      {
        timeoutMs: 1000,
        registry,
        spawn: () => children.shift(),
      }
    );
    const rejectedPipeline = assert.rejects(
      pipeline,
      /FFmpeg consumer exited before NVEncC producer completed/
    );
    consumerChild.finish(0, null);
    await nextTurn();
    assert.deepStrictEqual(
      producerChild.kills,
      ['SIGTERM'],
      'consumer-first completion must be remembered if the producer handles TERM'
    );
    producerChild.finish(0, null);
    await rejectedPipeline;
    assert.strictEqual(registry.size(), 0);
  }

  {
    const producerChild = new MockChild('producer');
    const consumerChild = new MockChild('consumer');
    const children = [producerChild, consumerChild];
    const registry = trial.createChildRegistry({ graceMs: 25 });
    const pipeline = trial.runPipeline(
      '/tools/nvencc', [], '/tools/ffmpeg', [],
      {
        timeoutMs: 1000,
        registry,
        spawn: () => children.shift(),
      }
    );
    producerChild.finish(0, null);
    await nextTurn();
    assert.deepStrictEqual(
      consumerChild.kills,
      [],
      'a successful producer may exit first while its consumer drains'
    );
    consumerChild.finish(0, null);
    await pipeline;
    assert.strictEqual(registry.size(), 0);
  }

  {
    const registry = trial.createChildRegistry({ graceMs: 5 });
    const stubborn = new MockChild('stubborn', 0, true);
    registry.register(stubborn, 'stubborn');
    await registry.terminateAndWait('SIGTERM');
    assert.deepStrictEqual(
      stubborn.kills,
      ['SIGTERM', 'SIGKILL'],
      'cleanup must escalate and wait for a child that ignores SIGTERM'
    );
    assert.strictEqual(registry.size(), 0);
    let spawnCalls = 0;
    await assert.rejects(
      trial.runCommand('/tools/ffmpeg', [], {
        registry,
        spawn: () => {
          spawnCalls += 1;
          return new MockChild('late');
        },
      }),
      /signal cleanup is active/
    );
    assert.strictEqual(spawnCalls, 0);
  }

  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const registry = trial.createChildRegistry({ graceMs: 50 });
    const first = new MockChild('first', 5);
    const second = new MockChild('second', 10);
    registry.register(first, 'first');
    registry.register(second, 'second');
    const fakeProcess = new EventEmitter();
    fakeProcess.exitCode = null;
    fakeProcess.exits = [];
    fakeProcess.exit = (code) => fakeProcess.exits.push(code);
    const handlers = trial.installSignalHandlers(registry, fakeProcess);
    fakeProcess.emit(signal);
    await handlers.waitForCleanup();
    assert.deepStrictEqual(first.kills, ['SIGTERM']);
    assert.deepStrictEqual(second.kills, ['SIGTERM']);
    assert.strictEqual(registry.size(), 0);
    assert.strictEqual(fakeProcess.exitCode, exitCode);
    assert.deepStrictEqual(
      fakeProcess.exits,
      [],
      'the signal handler must wait through normal control flow, not exit early'
    );
    handlers.dispose();
  }
}

testFullSourceIdentity()
  .then(() => testProductionShapedGrainFit())
  .then(() => testUnavailableControlShortCircuit())
  .then(() => testAuthenticatedProvenanceReceiptFile())
  .then(() => testExecutableIdentityContracts())
  .then(() => testProductionGpuLeaseContracts())
  .then(() => testPipelineAndSignalCleanup()).then(() => {
  console.log('PASS bounded denoise-retention trial contracts');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
