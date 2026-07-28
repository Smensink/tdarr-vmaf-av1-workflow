'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const grainArtifact = require(
  './custom-cont-init.d/vmaf-plugin-patches/_lib/grainAnalysisArtifact.js'
);
const nvenccKnn = require(
  './custom-cont-init.d/vmaf-plugin-patches/_lib/nvenccKnn.js'
);
const analyze = require(
  './custom-cont-init.d/vmaf-plugin-patches/analyzeFilmGrain/1.0.0/index.js'
);
const synthesize = require(
  './custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js'
);
const postEncodeCheckpoint = require(
  './custom-cont-init.d/vmaf-plugin-patches/_lib/postEncodeCheckpoint.js'
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdarr-grain-direct-contract-'));
const safeTempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
assert(path.resolve(root).startsWith(safeTempRoot), `unsafe test root: ${root}`);

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fullFingerprint(filePath) {
  const resolved = fs.realpathSync(filePath);
  return {
    scheme: 'sha256-full-v1',
    sha256: sha256(resolved),
    size_bytes: fs.statSync(resolved).size,
    resolved_path: resolved,
  };
}

function writeFixture(name, contents) {
  const target = path.join(root, name);
  fs.writeFileSync(target, contents);
  return target;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

try {
  const sourcePath = writeFixture('source.mkv', Buffer.alloc(8192, 0x5a));
  const pipelinePath = writeFixture('grain_pipeline_v5_direct.py', 'pipeline-v5\n');
  const tablePath = writeFixture(
    'grain.txt',
    'filmgrn1\nE 0 9223372036854775807 1\nsY 1 128 7\n'
  );
  const manifestPath = path.join(root, 'manifest.json');
  const outcomePath = path.join(root, 'outcome.json');
  const tools = Object.fromEntries(
    ['ffmpeg', 'ffprobe', 'grav1synth', 'nvencc', 'coordinator'].map((name) => [
      name,
      writeFixture(name, `${name}-fixture\n`),
    ])
  );
  const sourceFingerprint = grainArtifact.sampledSourceFingerprint(sourcePath);
  const selectedAttempt = {
    rank: 1,
    start_seconds: 123.5,
    status: 'selected',
    segments: [{ start: 0, end: 9223372036854776000 }],
    semantic_grain: true,
    source_clip_sha256: '1'.repeat(64),
    denoised_clip_sha256: '2'.repeat(64),
  };
  const selection = {
    method: 'flat-mid-luma-no-cut-proxy-ranking-v1',
    requested_frames: 144,
    requested_candidate_limit: 3,
    clip_seconds: 6.006,
    source_duration_seconds: 3600,
    proxy_width: 320,
    proxy_height: 180,
    proxy_frames: 24,
    ranked_candidates: [{ rank: 1, start_seconds: 123.5 }],
    proxy_evidence: [],
    attempts: [selectedAttempt],
  };
  const manifest = {
    schema: 5,
    pipeline_version: 5,
    operation: 'fit-direct',
    purpose: grainArtifact.DIRECT_PURPOSE,
    grain_model_contract_id: grainArtifact.DIRECT_GRAIN_MODEL_CONTRACT_ID,
    source: fs.realpathSync(sourcePath),
    source_fingerprint: sourceFingerprint,
    source_video: {
      stream_index: 0,
      width: 1920,
      height: 1080,
      pix_fmt: 'yuv420p10le',
      bit_depth: 10,
      frame_rate: '24000/1001',
    },
    media_profile: { transfer_family: 'sdr' },
    comparison: {
      mode: grainArtifact.DIRECT_COMPARISON_MODE,
      source_role: 'lossless-original-source-clip',
      denoised_role: 'same-lossless-clip-after-spatial-gpu-knn',
      encoded_output_used_for_fit: false,
      direct_unmodified_table: true,
      global_segment_required: true,
    },
    denoise: {
      id: nvenccKnn.DENOISE_ID,
      implementation: 'NVEncC 9.25 vpp-knn',
      settings: nvenccKnn.KNN_SETTINGS,
      temporal_filtering: false,
      output_depth: 10,
      transport: 'raw-yuv420-nut-stdout',
    },
    selection,
    selected_clip: selectedAttempt,
    output: {
      path: path.resolve(tablePath),
      sha256: sha256(tablePath),
      bytes: fs.statSync(tablePath).size,
      segment_count: 1,
      segment_start: 0,
      segment_end: 9223372036854776000,
    },
    pipeline: {
      version: 5,
      script: fs.realpathSync(pipelinePath),
      sha256: sha256(pipelinePath),
    },
    toolchain: Object.fromEntries(
      Object.entries(tools).map(([name, toolPath]) => [
        name,
        { ...fullFingerprint(toolPath), ...(name === 'coordinator' ? {} : { version: 'fixture 1.0' }) },
      ])
    ),
    scratch: { retained: false, path: null },
    completed_at: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.deepStrictEqual(
    grainArtifact.directTableSegments(fs.readFileSync(tablePath, 'utf8')),
    [{ start: 0n, end: grainArtifact.DIRECT_GLOBAL_SEGMENT_END }]
  );
  grainArtifact.assertDirectGlobalTable(tablePath);

  const preparedOptions = {
    sourcePath,
    tablePath,
    manifestPath,
    pipelinePath,
    expectedProfile: 'sdr',
    ffmpegPath: tools.ffmpeg,
    ffprobePath: tools.ffprobe,
    grav1synthPath: tools.grav1synth,
    nvenccPath: tools.nvencc,
    coordinatorPath: tools.coordinator,
  };
  const artifact = grainArtifact.buildPreparedArtifact(manifest, preparedOptions);
  assert.strictEqual(artifact.schema, 2);
  assert.strictEqual(artifact.state, 'prepared');
  assert.strictEqual(artifact.contractKind, 'direct-global-v1');
  assert.strictEqual(artifact.tableApplication, 'single-direct-unmodified-apply');
  assert.strictEqual(artifact.temporalFiltering, false);
  assert.strictEqual(artifact.denoisePrerollSeconds, 0);
  assert.strictEqual(artifact.denoiseSettings, nvenccKnn.KNN_SETTINGS);
  assert.strictEqual(artifact.outputDepth, 10);
  assert.strictEqual(
    grainArtifact.validatePreparedArtifact(artifact, preparedOptions).checked.outputDepth,
    10
  );
  assert.strictEqual(grainArtifact.shouldUseCanonicalDenoise('prepared'), true);

  const badSettings = clone(manifest);
  badSettings.denoise.settings = 'radius=3,d=0,strength=0.16,lerp=0.2,th_lerp=0.8';
  assert.throws(
    () => grainArtifact.validateDirectPreparedManifest(badSettings, preparedOptions),
    /NVEncC KNN contract mismatch/
  );
  const badEncodedFit = clone(manifest);
  badEncodedFit.comparison.encoded_output_used_for_fit = true;
  assert.throws(
    () => grainArtifact.validateDirectPreparedManifest(badEncodedFit, preparedOptions),
    /comparison contract mismatch/
  );
  const badArtifact = { ...artifact, tableApplication: 'gain-adjusted-apply' };
  assert.throws(
    () => grainArtifact.validateDirectPreparedArtifact(badArtifact, preparedOptions),
    /artifact contract mismatch/
  );

  const multiTable = writeFixture(
    'multi-grain.txt',
    'filmgrn1\nE 0 100 1\nsY 1 128 7\nE 101 9223372036854775807 1\nsY 1 128 7\n'
  );
  assert.throws(
    () => grainArtifact.assertDirectGlobalTable(multiTable),
    /exactly one unmodified global segment/
  );
  const nonGlobalTable = writeFixture(
    'non-global-grain.txt',
    'filmgrn1\nE 1 9223372036854775807 1\nsY 1 128 7\n'
  );
  assert.throws(
    () => grainArtifact.assertDirectGlobalTable(nonGlobalTable),
    /exactly one unmodified global segment/
  );
  const emptyTable = writeFixture(
    'empty-grain.txt',
    'filmgrn1\nE 0 9223372036854775807 1\nsY 0\n'
  );
  assert.throws(
    () => grainArtifact.assertDirectGlobalTable(emptyTable),
    /contains no semantic grain/
  );

  const bypassSelection = {
    ...selection,
    attempts: [{
      rank: 1,
      start_seconds: 123.5,
      status: 'rejected_non_global_table',
      segments: [
        { start: 0, end: 100 },
        { start: 101, end: 9223372036854776000 },
      ],
      semantic_grain: true,
    }],
  };
  const bypass = {
    schema: 5,
    pipeline_version: 5,
    operation: 'fit-direct',
    purpose: grainArtifact.DIRECT_PURPOSE,
    disposition: 'bypass',
    reason_code: grainArtifact.NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE,
    production_action: grainArtifact.NO_GRAIN_PRODUCTION_ACTION,
    source: fs.realpathSync(sourcePath),
    source_fingerprint: sourceFingerprint,
    pipeline: fullFingerprint(pipelinePath),
    media_profile: 'sdr',
    selection: bypassSelection,
    completed_at: new Date().toISOString(),
  };
  fs.writeFileSync(outcomePath, `${JSON.stringify(bypass, null, 2)}\n`);
  const bypassOptions = {
    sourcePath,
    pipelinePath,
    tablePath: path.join(root, 'forbidden-table.txt'),
    manifestPath: path.join(root, 'forbidden-manifest.json'),
    outcomePath,
    expectedProfile: 'sdr',
  };
  const noGrainArtifact = grainArtifact.buildNoGrainArtifact(bypass, bypassOptions);
  assert.strictEqual(noGrainArtifact.schema, 2);
  assert.strictEqual(noGrainArtifact.state, 'no_grain');
  assert.strictEqual(noGrainArtifact.temporalFiltering, false);
  assert.strictEqual(noGrainArtifact.denoisePrerollSeconds, 0);
  assert.strictEqual(
    grainArtifact.validateNoGrainArtifact(noGrainArtifact).checked.reasonCode,
    grainArtifact.NO_GRAIN_STATIC_MODEL_UNREPRESENTABLE_REASON_CODE
  );
  assert.strictEqual(
    grainArtifact.canonicalDenoiseDisposition({
      grainAnalysisStatus: 'no_grain',
      grainAnalysisNoGrainArtifact: noGrainArtifact,
    }),
    'no_grain'
  );
  assert.strictEqual(grainArtifact.shouldUseCanonicalDenoise('no_grain'), false);

  const unsupportedBypass = clone(bypass);
  unsupportedBypass.reason_code = 'operator_chose_to_skip_grain';
  assert.throws(
    () => grainArtifact.validateDirectBypassOutcome(unsupportedBypass, bypassOptions),
    /unsupported disposition/
  );

  const pipelineArgs = analyze._test.buildPipelineArgsForContract({
    pipelinePath: '/opt/grain-pipeline/current/grain_pipeline_v5_direct.py',
    sourcePath: '/media/Movie/source.mkv',
    jobDir: '/temp/job/grain-analysis/movie',
    tablePath: '/temp/job/grain-analysis/movie/grain-table.txt',
    manifestPath: '/temp/job/grain-analysis/movie/grain-pipeline-manifest.json',
    outcomePath: '/temp/job/grain-analysis/movie/grain-fit-outcome.json',
    ffmpegPath: '/usr/local/bin/tdarr-ffmpeg',
    ffprobePath: '/usr/bin/ffprobe',
    grav1synthPath: '/usr/local/bin/grav1synth',
    nvenccPath: '/usr/local/bin/nvencc',
    coordinatorPath: '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js',
    mediaProfile: 'sdr',
  });
  assert.deepStrictEqual(pipelineArgs, [
    '/opt/grain-pipeline/current/grain_pipeline_v5_direct.py',
    '--operation', 'fit-direct',
    '--source', '/media/Movie/source.mkv',
    '--workdir', '/temp/job/grain-analysis/movie',
    '--output', '/temp/job/grain-analysis/movie/grain-table.txt',
    '--manifest', '/temp/job/grain-analysis/movie/grain-pipeline-manifest.json',
    '--outcome', '/temp/job/grain-analysis/movie/grain-fit-outcome.json',
    '--ffmpeg', '/usr/local/bin/tdarr-ffmpeg',
    '--ffprobe', '/usr/bin/ffprobe',
    '--grav1synth', '/usr/local/bin/grav1synth',
    '--nvencc', '/usr/local/bin/nvencc',
    '--coordinator', '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js',
    '--media-profile', 'sdr',
    '--frames', '144',
    '--max-candidates', '3',
  ]);
  assert(!pipelineArgs.join(' ').match(/hqdn3d|gain|calibrat|encoded-output/i));
  assert.strictEqual(
    nvenccKnn.KNN_SETTINGS,
    'radius=3,d=0,strength=0.08,lerp=0.2,th_lerp=0.8'
  );
  const producerArgs = nvenccKnn.buildProducerArgs({
    sourcePath: '/media/Movie/source.mkv',
    outputDepth: 10,
    frames: 144,
  });
  assert.deepStrictEqual(
    producerArgs.slice(producerArgs.indexOf('--vpp-knn'), producerArgs.indexOf('--vpp-knn') + 2),
    ['--vpp-knn', nvenccKnn.KNN_SETTINGS]
  );
  assert.strictEqual(producerArgs[producerArgs.indexOf('--output-depth') + 1], '10');
  assert.strictEqual(producerArgs[producerArgs.indexOf('--frames') + 1], '144');

  const analyzeDefaults = Object.fromEntries(
    analyze.details().inputs.map((input) => [input.name, input.defaultValue])
  );
  assert.strictEqual(analyzeDefaults.mode, 'active');
  assert.strictEqual(analyzeDefaults.sourcePathRegex, '^/media/');
  assert.strictEqual(analyzeDefaults.eligibleProfiles, 'sdrAndPq');
  assert.strictEqual(
    analyzeDefaults.pipelinePath,
    '/opt/grain-pipeline/current/grain_pipeline_v5_direct.py'
  );
  assert.strictEqual(analyzeDefaults.nvenccPath, '/usr/local/bin/nvencc');
  assert.strictEqual(
    analyzeDefaults.coordinatorPath,
    '/usr/local/libexec/tdarr-nvencc-knn-ffmpeg.js'
  );

  const synthOutputs = synthesize.details().outputs;
  assert.strictEqual(synthOutputs.length, 4);
  assert.match(synthOutputs[0].tooltip, /ACTIVE/);
  assert.match(synthOutputs[1].tooltip, /CANARY/);
  assert.match(synthOutputs[2].tooltip, /BYPASS/);
  assert.match(synthOutputs[3].tooltip, /FALLBACK RE-ENCODE/);

  const canonicalFlow = JSON.parse(
    fs.readFileSync(path.resolve('configs/flow_YR5PZ1QaD_CANONICAL.json'), 'utf8')
  );
  const analysisNode = canonicalFlow.flowPlugins.find(
    (node) => node.id === 'grainAnalysis1'
  );
  const synthesisNode = canonicalFlow.flowPlugins.find(
    (node) => node.id === 'grainSynthesis1'
  );
  assert(analysisNode, 'canonical Flow lacks direct grain analysis');
  assert(synthesisNode, 'canonical Flow lacks direct grain synthesis');
  assert.strictEqual(analysisNode.inputsDB.mode, 'active');
  assert.strictEqual(analysisNode.inputsDB.sourcePathRegex, '^/media/');
  assert.strictEqual(
    analysisNode.inputsDB.pipelinePath,
    '/opt/grain-pipeline/current/grain_pipeline_v5_direct.py'
  );
  assert.strictEqual(synthesisNode.inputsDB.mode, 'active');
  assert.strictEqual(synthesisNode.inputsDB.sourcePathRegex, '^/media/');
  assert.strictEqual(synthesisNode.inputsDB.preserveProductionReview, 'false');
  assert(
    canonicalFlow.flowEdges.some((edge) =>
      edge.source === 'grainSynthesis1' &&
      edge.sourceHandle === '4' &&
      edge.target === 'extract1'
    ),
    'direct synthesis failure must rerun AV1 from the untouched original'
  );

  const contractOutput = path.join(root, 'contract-output.mkv');
  const consumerArgs = [
    '-hide_banner', '-f', 'nut', '-i', 'pipe:0',
    '-c:v', 'av1_nvenc', '-cq', '28', contractOutput,
  ];
  function executableIdentity(filePath) {
    const resolved = fs.realpathSync(filePath);
    return {
      requested_path: filePath,
      resolved_path: resolved,
      size_bytes: fs.statSync(resolved).size,
      sha256_full: sha256(resolved),
    };
  }
  function pipelineContract(outputDepth) {
    const producerLog = `${contractOutput}.nvencc.log`;
    const coordinatorOptions = {
      nvenccPath: tools.nvencc,
      coordinatorPath: tools.coordinator,
      sourcePath,
      outputDepth,
      producerLog,
      ffmpegPath: tools.ffmpeg,
      ffmpegArgs: consumerArgs,
    };
    return {
      schema: 2,
      executable: tools.coordinator,
      executable_identity: executableIdentity(tools.coordinator),
      argv: nvenccKnn.buildCoordinatorArgs(coordinatorOptions).map((value) => {
        if (value === sourcePath) return '<SOURCE>';
        if (value === contractOutput) return '<OUTPUT>';
        if (value === producerLog) return '<PRODUCER_LOG>';
        return value;
      }),
      pipeline: nvenccKnn.contractDescriptor(coordinatorOptions),
      producer_identity: executableIdentity(tools.nvencc),
      consumer_identity: executableIdentity(tools.ffmpeg),
    };
  }
  const exactPipelineContract = pipelineContract(10);
  assert.strictEqual(exactPipelineContract.schema, 2);
  assert.doesNotThrow(
    () => postEncodeCheckpoint.assertEncodeContract(exactPipelineContract)
  );
  const legacyContract = {
    schema: 1,
    executable: tools.ffmpeg,
    executable_identity: { legacy_unvalidated_shape: true },
    argv: ['-i', '<SOURCE>', '-c:v', 'av1_nvenc', '<OUTPUT>'],
  };
  assert.doesNotThrow(() => postEncodeCheckpoint.assertEncodeContract(legacyContract));

  const pipelineTamperCases = [
    {
      name: 'unapproved KNN strength',
      mutate(value) {
        value.pipeline.knn_settings =
          'radius=3,d=0,strength=0.16,lerp=0.2,th_lerp=0.8';
      },
    },
    {
      name: 'producer executable bytes',
      mutate(value) {
        value.producer_identity.sha256_full = '0'.repeat(64);
      },
    },
    {
      name: 'coordinator executable bytes',
      mutate(value) {
        value.executable_identity.sha256_full = '0'.repeat(64);
      },
    },
    {
      name: 'consumer executable bytes',
      mutate(value) {
        value.consumer_identity.sha256_full = '0'.repeat(64);
      },
    },
    {
      name: 'consumer effective target not present in wrapper bytes',
      mutate(value) {
        value.consumer_identity.effective_target =
          executableIdentity(tools.nvencc);
      },
    },
    {
      name: 'producer argv',
      mutate(value) {
        value.pipeline.producer_argv.splice(-2, 0, '--frames', '144');
      },
    },
    {
      name: 'coordinator producer path',
      mutate(value) {
        value.argv[value.argv.indexOf('--nvencc') + 1] = tools.ffmpeg;
      },
    },
    {
      name: 'second FFmpeg denoiser',
      mutate(value) {
        value.argv.splice(value.argv.indexOf('--') + 1, 0, '-vf', 'hqdn3d=4:3:6:4.5');
      },
    },
    {
      name: 'unknown unauthenticated field',
      mutate(value) {
        value.pipeline_operator_override = true;
      },
    },
  ];
  for (const testCase of pipelineTamperCases) {
    const tampered = clone(exactPipelineContract);
    testCase.mutate(tampered);
    assert.throws(
      () => postEncodeCheckpoint.assertEncodeContract(tampered),
      /post-encode|denoiser|SHA-256/,
      testCase.name
    );
  }

  const checkpointWorkDir = path.join(root, 'checkpoint-job');
  const checkpointRoot = path.join(root, 'protected-checkpoints');
  const reuseRequiredRoot = path.join(root, 'reuse-required');
  fs.mkdirSync(checkpointWorkDir);
  postEncodeCheckpoint.initializeReuseRequiredRoot(reuseRequiredRoot);
  function checkpointPlan(encodeContract) {
    return postEncodeCheckpoint.buildPlan({
      workDir: checkpointWorkDir,
      checkpointRoot,
      reuseRequiredRoot,
      requireInitializedReuseRequiredRoot: true,
      sourceFingerprint,
      encodeContract,
      extension: '.mkv',
      validateArtifact() {
        return { validator: 'fixture-v1' };
      },
    });
  }
  const tenBitPlan = checkpointPlan(exactPipelineContract);
  const eightBitPlan = checkpointPlan(pipelineContract(8));
  const legacyPlan = checkpointPlan(legacyContract);
  assert.notStrictEqual(
    tenBitPlan.checkpointKey,
    eightBitPlan.checkpointKey,
    'pipeline descriptor changes must isolate protected checkpoint keys'
  );
  assert.notStrictEqual(
    tenBitPlan.checkpointKey,
    legacyPlan.checkpointKey,
    'legacy FFmpeg and coordinator-pipeline checkpoints must never collide'
  );

  const synthesisSource = fs.readFileSync(
    './custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js',
    'utf8'
  );
  assert(synthesisSource.includes("mode: 'direct-' + mode"));
  assert(synthesisSource.includes('requireFullTitle: true'));
  assert(synthesisSource.includes('full_title_decode_validation_performed: true'));
  assert(!synthesisSource.includes('full_title_decode_validation_performed: false'));
  const fullDecodeIndex = synthesisSource.indexOf(
    'Running mandatory full-title AV1 decode validation after direct grain bitstream rewrite.'
  );
  const promotionIndex = synthesisSource.indexOf(
    'fs.renameSync(finalPartialPath, validatedOutputPath)',
    fullDecodeIndex
  );
  assert(fullDecodeIndex >= 0 && promotionIndex > fullDecodeIndex,
    'full-title decode must complete before the rewritten bitstream can be promoted');
  assert(synthesisSource.includes('result = directFallbackResult(args, originalObj, error)'),
    'decode failure must route from the untouched original rather than publish the rewritten bitstream');

  const rejectedJobDir = path.join(root, 'direct-size-rejected-job');
  fs.mkdirSync(rejectedJobDir);
  fs.writeFileSync(path.join(rejectedJobDir, 'grain-output.partial.mkv'), 'rejected');
  fs.mkdirSync(path.join(rejectedJobDir, 'inspection'));
  fs.writeFileSync(path.join(rejectedJobDir, 'inspection', 'result.txt'), 'rejected');
  assert.strictEqual(
    synthesize._test.discardRejectedDirectGrainJob({ workDir: root }, rejectedJobDir),
    null
  );
  assert.strictEqual(fs.existsSync(rejectedJobDir), false,
    'direct size rejection must remove its complete owned scratch directory');
  assert.throws(
    () => synthesize._test.discardRejectedDirectGrainJob(
      { workDir: root },
      path.resolve(root, '..', 'outside-direct-size-rejection')
    ),
    /outside args\.workDir/
  );
  const directSizeRejectionStart = synthesisSource.indexOf(
    'var directGrainOriginalRejection = assessGrainOutputAgainstOriginal('
  );
  const directSizeRejectionReturn = synthesisSource.indexOf(
    "return makeResult(args, 3, args.inputFileObj, 'size_rejected'",
    directSizeRejectionStart
  );
  assert(directSizeRejectionStart >= 0 && directSizeRejectionReturn > directSizeRejectionStart,
    'direct grain original-size rejection block is missing');
  assert.match(
    synthesisSource.slice(directSizeRejectionStart, directSizeRejectionReturn),
    /jobDir = discardRejectedDirectGrainJob\(args, jobDir\)/,
    'direct grain size rejection must clean its owned scratch before returning'
  );
  const productionReviewCall = synthesisSource.indexOf(
    'productionReview = preserveProductionReview('
  );
  assert(productionReviewCall >= 0, 'production review implementation is missing');
  assert.match(
    synthesisSource.slice(Math.max(0, productionReviewCall - 220), productionReviewCall),
    /if \(boolValue\(args\.inputs\.preserveProductionReview, false\)\)/,
    'full production media review copies must require explicit opt-in'
  );

  console.log('PASS direct film-grain analysis, artifact, synthesis, and Flow contracts');
} finally {
  const resolved = path.resolve(root);
  assert(resolved.startsWith(safeTempRoot), `refusing unsafe test cleanup: ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}
