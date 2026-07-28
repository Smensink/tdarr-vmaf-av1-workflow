'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  BACKEND,
  REVISION,
  WRAPPER_PATH,
  CAMBI_MODEL_MAX,
  CAMBI_FULL_REFERENCE_MAX,
  buildCommand,
  buildMetricIdentity,
  parseOutput,
  selectModel,
  validateGeometry,
} = require('./vmafV1Cpu');

function baseOptions(overrides = {}) {
  return {
    referencePath: '/work/reference.yuv',
    distortedPath: '/work/distorted.yuv',
    outputPath: '/work/result.json',
    transport: 'raw',
    width: 1920,
    height: 1080,
    // Coded geometry, SAR/DAR and the normalization decision are part of the
    // measurement identity and must always be explicit; there is no implicit
    // normalization fallback.
    sampleAspectRatio: '1:1',
    displayAspectRatio: '16:9',
    geometryNormalization: 'none',
    pixelFormat: 'yuv420p10le',
    bitDepth: 10,
    frameCount: 3,
    subsample: 1,
    pooling: 'harmonic_mean',
    contentClass: 'sdr',
    fullReferenceCambi: true,
    ...overrides,
  };
}

function makeOutput(command, overrides = {}) {
  const candidateAlias = command.model.cambiAlias;
  const vmafAlias = command.model.vmafAlias;
  const distortedAlias = command.metricIdentity.contentClass === 'hdr-pq-provisional'
    ? 'cambi_ceot_pq' : 'cambi';
  const frames = overrides.frames || Array.from(
    { length: command.expectedMeasuredFrames },
    (_, index) => ({
      frameNum: index * command.metricIdentity.subsample,
      metrics: {
        [candidateAlias]: 3 + index,
        [vmafAlias]: 95 + index,
        ...(command.fullReferenceCambi
          ? {
            [distortedAlias]: 30 + index,
            cambi_source: 1 + index,
            cambi_full_reference: 2 + index,
          }
          : {}),
      },
    }),
  );

  return {
    version: '3.1.1',
    fps: 12.5,
    frames,
    pooled_metrics: {
      [candidateAlias]: {
        min: 3,
        max: 5,
        mean: 4,
        harmonic_mean: 3.829787,
      },
      [vmafAlias]: {
        min: 95,
        max: 97,
        mean: 96,
        harmonic_mean: 95.993055,
      },
      ...(command.fullReferenceCambi
        ? {
          [distortedAlias]: {
            min: 30,
            max: 32,
            mean: 31,
            harmonic_mean: 30.97848716169327,
          },
          cambi_source: { min: 1, max: 3, mean: 2, harmonic_mean: 1.636364 },
          cambi_full_reference: { min: 2, max: 4, mean: 3, harmonic_mean: 2.769231 },
        }
        : {}),
    },
    aggregate_metrics: {},
    ...overrides,
  };
}

test('selects pinned built-in SDR models and exposes the correct score maxima', () => {
  assert.deepEqual(selectModel({ width: 1920, height: 1080 }), {
    version: 'vmaf_v1.0.16_3d0h',
    resolutionClass: '1080p',
    viewingDistance: '3h',
    maxScore: 100,
    cambiAlias: 'cambi_hrs_1080_cmxv_17_vlt_0.06',
  });
  assert.equal(selectModel({ width: 3840, height: 2160 }).version,
    'vmaf_v1.0.16_1d5h_2160');
  assert.equal(selectModel({
    width: 3840,
    height: 2160,
    modelProfile: '4k-3h',
  }).maxScore, 110);

  assert.throws(() => selectModel({ width: 1280, height: 720 }), /1080p or 4K/);
  assert.throws(() => selectModel({
    width: 1920,
    height: 1080,
    modelProfile: '4k-3h',
  }), /not valid for/);
});

test('builds native 10-bit raw argv and immutable execution metadata', () => {
  const command = buildCommand(baseOptions({ subsample: 2 }));

  assert.equal(command.executable, WRAPPER_PATH);
  assert.equal(command.backend, BACKEND);
  assert.equal(command.revision, REVISION);
  assert.deepEqual(command.args, [
    '--reference', '/work/reference.yuv',
    '--distorted', '/work/distorted.yuv',
    '--width', '1920',
    '--height', '1080',
    '--pixel_format', '420',
    '--bitdepth', '10',
    '--model', 'version=vmaf_v1.0.16_3d0h:name=vmaf_v1.0.16_3d0h',
    '--output', '/work/result.json',
    '--json',
    '--subsample', '2',
    '--frame_cnt', '3',
    '--feature', 'cambi=full_ref=true',
    '--quiet',
  ]);
  assert.deepEqual(command.transport, {
    kind: 'raw',
    pixelFormat: 'yuv420p10le',
    chromaSubsampling: '420',
    bitDepth: 10,
    width: 1920,
    height: 1080,
    sampleAspectRatio: '1:1',
    displayAspectRatio: '16:9',
    geometryNormalization: 'none',
  });
  assert.equal(command.expectedMeasuredFrames, 2);
  assert.equal(command.contractStatus, 'model-documented-sdr-runtime-unqualified');
  assert.equal(command.modelValidatedForContent, true);
  assert.ok(Object.isFrozen(command));
  assert.ok(Object.isFrozen(command.args));
  assert.ok(Object.isFrozen(command.metricIdentity));
});

test('builds Y4M argv without raw-only geometry flags while retaining transport identity', () => {
  const command = buildCommand(baseOptions({
    referencePath: '/work/reference.y4m',
    distortedPath: '/work/distorted.y4m',
    transport: 'y4m',
  }));

  assert.equal(command.transport.kind, 'y4m');
  for (const rawFlag of ['--width', '--height', '--pixel_format', '--bitdepth']) {
    assert.equal(command.args.includes(rawFlag), false);
  }
  assert.equal(command.metricIdentity.pixelFormat, 'yuv420p10le');
  assert.equal(command.metricIdentity.bitDepth, 10);
});

test('fails closed on non-native formats, incomplete paths, and invalid run controls', () => {
  assert.throws(() => buildCommand(baseOptions({ bitDepth: 8 })), /native 10-bit/);
  assert.throws(() => buildCommand(baseOptions({ pixelFormat: 'yuv420p' })), /yuv420p10le/);
  assert.throws(() => buildCommand(baseOptions({ frameCount: 0 })), /frameCount/);
  assert.throws(() => buildCommand(baseOptions({ subsample: 0 })), /subsample/);
  assert.throws(() => buildCommand(baseOptions({ outputPath: '' })), /outputPath/);
  assert.throws(() => buildCommand(baseOptions({ referencePath: 'bad\0path' })), /referencePath/);
  assert.throws(() => buildCommand(baseOptions({ transport: 'pipe' })), /transport/);
});

test('requires explicit opt-in and labels HDR as provisional, not SDR-validated', () => {
  assert.throws(() => buildCommand(baseOptions({ contentClass: 'hdr-pq' })),
    /allowProvisionalHdr/);

  const command = buildCommand(baseOptions({
    contentClass: 'hdr-pq',
    allowProvisionalHdr: true,
  }));

  assert.equal(command.contractStatus, 'provisional-hdr-unvalidated');
  assert.equal(command.modelValidatedForContent, false);
  assert.equal(command.metricIdentity.contentClass, 'hdr-pq-provisional');
  assert.match(command.args[command.args.indexOf('--model') + 1],
    /cambi\.cambi_eotf=pq/);
  const parsed = parseOutput(makeOutput(command), command);
  assert.equal(parsed.aliases.cambiDistorted, 'cambi_ceot_pq');
  assert.equal(parsed.cambiDistorted, 30.97848716169327);
  const wrongStandalone = makeOutput(command);
  wrongStandalone.pooled_metrics.cambi =
    wrongStandalone.pooled_metrics.cambi_ceot_pq;
  delete wrongStandalone.pooled_metrics.cambi_ceot_pq;
  assert.throws(() => parseOutput(wrongStandalone, command),
    /unexpected full-reference distorted CAMBI metric aliases.*expected cambi_ceot_pq/);
});

test('metric identity is deterministic, complete, immutable, and contract-sensitive', () => {
  const identity = buildMetricIdentity({
    model: 'vmaf_v1.0.16_3d0h',
    pixelFormat: 'yuv420p10le',
    bitDepth: 10,
    pooling: 'harmonic_mean',
    subsample: 2,
    contentClass: 'sdr',
    codedWidth: 1920,
    codedHeight: 1080,
    sampleAspectRatio: '1:1',
    displayAspectRatio: '16:9',
    geometryNormalization: 'none',
  });

  assert.deepEqual(identity, {
    id: 'backend=cpu-vmaf-v1|revision=78e11b52c8fc1fcc6d15afd6c7479394fb3bc6af|model=vmaf_v1.0.16_3d0h|pixelFormat=yuv420p10le|bitDepth=10|pooling=harmonic_mean|subsample=2|contentClass=sdr|codedWidth=1920|codedHeight=1080|sampleAspectRatio=1:1|displayAspectRatio=16:9|geometryNormalization=none',
    backend: 'cpu-vmaf-v1',
    revision: '78e11b52c8fc1fcc6d15afd6c7479394fb3bc6af',
    model: 'vmaf_v1.0.16_3d0h',
    pixelFormat: 'yuv420p10le',
    bitDepth: 10,
    pooling: 'harmonic_mean',
    subsample: 2,
    contentClass: 'sdr',
    codedWidth: 1920,
    codedHeight: 1080,
    sampleAspectRatio: '1:1',
    displayAspectRatio: '16:9',
    geometryNormalization: 'none',
  });
  assert.ok(Object.isFrozen(identity));
  assert.notEqual(identity.id, buildMetricIdentity({
    ...identity,
    subsample: 1,
  }).id);
  assert.throws(() => buildMetricIdentity({
    ...identity,
    backend: 'some-other-backend',
  }), /backend/);
});

test('parses model-qualified CAMBI plus exact distorted/source/full-reference aliases', () => {
  const command = buildCommand(baseOptions());
  const parsed = parseOutput(JSON.stringify(makeOutput(command)), command);

  assert.equal(parsed.frameCount, 3);
  assert.equal(parsed.expectedFrameCount, 3);
  assert.equal(parsed.vmaf, 95.993055);
  assert.equal(parsed.cambi, 3.829787);
  assert.equal(parsed.cambiDistorted, 30.97848716169327);
  assert.equal(parsed.cambiSource, 1.636364);
  assert.equal(parsed.cambiFullReference, 2.769231);
  assert.equal(parsed.aliases.vmaf, command.model.vmafAlias);
  assert.equal(parsed.aliases.cambi, command.model.cambiAlias);
  assert.equal(parsed.aliases.cambiDistorted, 'cambi');
  assert.deepEqual(parsed.frames[0], {
    frameNum: 0,
    vmaf: 95,
    cambi: 3,
    cambiDistorted: 30,
    cambiSource: 1,
    cambiFullReference: 2,
  });
  assert.equal(parsed.metricIdentity, command.metricIdentity);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.frames));
});

test('requires the exact VMAF and CAMBI metric aliases from the pinned contract', () => {
  const command = buildCommand(baseOptions());

  const renameCandidate = (output, alias) => {
    for (const frame of output.frames) {
      frame.metrics[alias] = frame.metrics[command.model.cambiAlias];
      delete frame.metrics[command.model.cambiAlias];
    }
    output.pooled_metrics[alias] = output.pooled_metrics[command.model.cambiAlias];
    delete output.pooled_metrics[command.model.cambiAlias];
  };

  const unexpectedQualified = makeOutput(command);
  renameCandidate(unexpectedQualified, 'cambi_other_model');
  assert.throws(() => parseOutput(unexpectedQualified, command),
    /unexpected candidate CAMBI metric aliases.*expected cambi_hrs_1080_cmxv_17_vlt_0\.06/);

  const unexpectedBare = makeOutput(command);
  renameCandidate(unexpectedBare, 'cambi');
  assert.throws(() => parseOutput(unexpectedBare, command),
    /unexpected candidate CAMBI metric aliases.*expected cambi_hrs_1080_cmxv_17_vlt_0\.06/);

  const missingFullReferenceDistorted = makeOutput(command);
  delete missingFullReferenceDistorted.pooled_metrics.cambi;
  assert.throws(() => parseOutput(missingFullReferenceDistorted, command),
    /missing exact full-reference distorted CAMBI metric cambi/);

  const missingFrameFullReferenceDistorted = makeOutput(command);
  delete missingFrameFullReferenceDistorted.frames[0].metrics.cambi;
  assert.throws(() => parseOutput(missingFrameFullReferenceDistorted, command),
    /frame 0 metrics is missing exact full-reference distorted CAMBI metric cambi/);

  const unexpectedSource = makeOutput(command);
  for (const frame of unexpectedSource.frames) {
    frame.metrics.cambi_source_hrs_1080 = frame.metrics.cambi_source;
    delete frame.metrics.cambi_source;
  }
  unexpectedSource.pooled_metrics.cambi_source_hrs_1080 =
    unexpectedSource.pooled_metrics.cambi_source;
  delete unexpectedSource.pooled_metrics.cambi_source;
  assert.throws(() => parseOutput(unexpectedSource, command),
    /unexpected source CAMBI metric aliases.*expected cambi_source/);

  const unexpectedFullReference = makeOutput(command);
  for (const frame of unexpectedFullReference.frames) {
    frame.metrics.cambi_full_reference_hrs_1080 =
      frame.metrics.cambi_full_reference;
    delete frame.metrics.cambi_full_reference;
  }
  unexpectedFullReference.pooled_metrics.cambi_full_reference_hrs_1080 =
    unexpectedFullReference.pooled_metrics.cambi_full_reference;
  delete unexpectedFullReference.pooled_metrics.cambi_full_reference;
  assert.throws(() => parseOutput(unexpectedFullReference, command),
    /unexpected full-reference CAMBI metric aliases.*expected cambi_full_reference/);

  const unexpectedBareVmaf = makeOutput(command);
  for (const frame of unexpectedBareVmaf.frames) {
    frame.metrics.vmaf = frame.metrics[command.model.vmafAlias];
    delete frame.metrics[command.model.vmafAlias];
  }
  unexpectedBareVmaf.pooled_metrics.vmaf =
    unexpectedBareVmaf.pooled_metrics[command.model.vmafAlias];
  delete unexpectedBareVmaf.pooled_metrics[command.model.vmafAlias];
  assert.throws(() => parseOutput(unexpectedBareVmaf, command),
    /unexpected VMAF metric aliases.*expected vmaf_v1\.0\.16_3d0h/);

  const unexpectedQualifiedVmaf = makeOutput(command);
  for (const frame of unexpectedQualifiedVmaf.frames) {
    frame.metrics.vmaf_other_model = frame.metrics[command.model.vmafAlias];
    delete frame.metrics[command.model.vmafAlias];
  }
  unexpectedQualifiedVmaf.pooled_metrics.vmaf_other_model =
    unexpectedQualifiedVmaf.pooled_metrics[command.model.vmafAlias];
  delete unexpectedQualifiedVmaf.pooled_metrics[command.model.vmafAlias];
  assert.throws(() => parseOutput(unexpectedQualifiedVmaf, command),
    /unexpected VMAF metric aliases.*expected vmaf_v1\.0\.16_3d0h/);

  const duplicateVmaf = makeOutput(command);
  duplicateVmaf.frames[0].metrics.vmaf = 99;
  duplicateVmaf.pooled_metrics.vmaf = { harmonic_mean: 99 };
  assert.throws(() => parseOutput(duplicateVmaf, command),
    /unexpected VMAF metric aliases/);

  const frameOnlyWrongVmaf = makeOutput(command);
  frameOnlyWrongVmaf.frames[0].metrics.vmaf_other_model =
    frameOnlyWrongVmaf.frames[0].metrics[command.model.vmafAlias];
  delete frameOnlyWrongVmaf.frames[0].metrics[command.model.vmafAlias];
  assert.throws(() => parseOutput(frameOnlyWrongVmaf, command),
    /frame 0 metrics has unexpected VMAF metric aliases/);

  const noFullReferenceCommand = buildCommand(baseOptions({
    fullReferenceCambi: false,
  }));
  const noFullReferenceOutput = makeOutput(noFullReferenceCommand);
  assert.equal(parseOutput(noFullReferenceOutput, noFullReferenceCommand).cambi, 3.829787);
  const unexpectedFullReferenceDistorted = makeOutput(noFullReferenceCommand);
  unexpectedFullReferenceDistorted.frames[0].metrics.cambi = 30;
  unexpectedFullReferenceDistorted.pooled_metrics.cambi = { harmonic_mean: 30 };
  assert.throws(() => parseOutput(unexpectedFullReferenceDistorted, noFullReferenceCommand),
    /unexpected full-reference distorted CAMBI metric aliases.*expected none/);
  noFullReferenceOutput.frames[0].metrics.cambi_source = 1;
  noFullReferenceOutput.pooled_metrics.cambi_source = { harmonic_mean: 1 };
  assert.throws(() => parseOutput(noFullReferenceOutput, noFullReferenceCommand),
    /unexpected source CAMBI metric aliases.*expected none/);
});

test('permits 4K 3H scores through 110 but enforces each model range', () => {
  const command4k = buildCommand(baseOptions({
    width: 3840,
    height: 2160,
    modelProfile: '4k-3h',
  }));
  const output4k = makeOutput(command4k);
  output4k.frames[0].metrics[command4k.model.vmafAlias] = 105;
  output4k.pooled_metrics[command4k.model.vmafAlias].harmonic_mean = 105;
  assert.equal(parseOutput(output4k, command4k).vmaf, 105);

  const command1080 = buildCommand(baseOptions());
  const output1080 = makeOutput(command1080);
  output1080.frames[0].metrics[command1080.model.vmafAlias] = 105;
  assert.throws(() => parseOutput(output1080, command1080), /VMAF.*range/);
});

test('enforces separate model-qualified and full-reference CAMBI domains', () => {
  assert.equal(CAMBI_MODEL_MAX, 17);
  assert.equal(CAMBI_FULL_REFERENCE_MAX, 1000);
  const command = buildCommand(baseOptions());
  const hoppers = makeOutput(command);
  hoppers.frames[0].metrics[command.model.cambiAlias] = 16.558754;
  hoppers.frames[0].metrics.cambi = 900;
  hoppers.frames[0].metrics.cambi_source = 17.3577;
  hoppers.frames[0].metrics.cambi_full_reference = 900;
  hoppers.pooled_metrics[command.model.cambiAlias].max = 16.558754;
  hoppers.pooled_metrics.cambi.max = 900;
  hoppers.pooled_metrics.cambi_source.max = 17.3577;
  hoppers.pooled_metrics.cambi_source.harmonic_mean = 12.28406199166666;
  hoppers.pooled_metrics.cambi_full_reference.max = 900;
  const parsed = parseOutput(hoppers, command);
  assert.equal(parsed.frames[0].cambi, 16.558754);
  assert.equal(parsed.frames[0].cambiDistorted, 900);
  assert.equal(parsed.frames[0].cambiSource, 17.3577);
  assert.equal(parsed.frames[0].cambiFullReference, 900);
  assert.equal(parsed.cambiSource, 12.28406199166666);

  const candidateOverflow = makeOutput(command);
  candidateOverflow.frames[0].metrics[command.model.cambiAlias] = 17.000001;
  assert.throws(() => parseOutput(candidateOverflow, command),
    /CAMBI frame 0 score .*17\.000001.*\[0, 17\]/);

  const distortedOverflow = makeOutput(command);
  distortedOverflow.frames[0].metrics.cambi = 1000.000001;
  assert.throws(() => parseOutput(distortedOverflow, command),
    /full-reference distorted CAMBI frame 0 score \(cambi\).*1000\.000001.*\[0, 1000\]/);

  const sourceOverflow = makeOutput(command);
  sourceOverflow.frames[0].metrics.cambi_source = 1000.000001;
  assert.throws(() => parseOutput(sourceOverflow, command),
    /source CAMBI frame 0 score \(cambi_source\).*1000\.000001.*\[0, 1000\]/);

  const exactFiniteCeiling = makeOutput(command);
  exactFiniteCeiling.frames[0].metrics.cambi = 1000;
  exactFiniteCeiling.pooled_metrics.cambi.max = 1000;
  exactFiniteCeiling.frames[0].metrics.cambi_source = 1000;
  exactFiniteCeiling.pooled_metrics.cambi_source.max = 1000;
  assert.equal(parseOutput(exactFiniteCeiling, command).frames[0].cambiDistorted, 1000);
  assert.equal(parseOutput(exactFiniteCeiling, command).frames[0].cambiSource, 1000);
});

test('parser fails closed on malformed JSON, frame mismatch, gaps, ambiguity, and non-finite values', () => {
  const command = buildCommand(baseOptions({ subsample: 2 }));

  assert.throws(() => parseOutput('{', command), /valid JSON/);
  assert.throws(() => parseOutput(makeOutput(command, { frames: [] }), command), /frame count/);

  const wrongIndex = makeOutput(command);
  wrongIndex.frames[1].frameNum = 1;
  assert.throws(() => parseOutput(wrongIndex, command), /frameNum/);

  const unexpectedExtra = makeOutput(command);
  unexpectedExtra.frames[0].metrics.cambi_other_model = 2;
  unexpectedExtra.pooled_metrics.cambi_other_model = { harmonic_mean: 2 };
  assert.throws(() => parseOutput(unexpectedExtra, command),
    /unexpected candidate CAMBI metric aliases/);

  const frameOnlyUnexpected = makeOutput(command);
  frameOnlyUnexpected.frames[0].metrics.cambi_other_model = 2;
  assert.throws(() => parseOutput(frameOnlyUnexpected, command),
    /frame 0 metrics has unexpected candidate CAMBI metric aliases/);

  const nonFinite = makeOutput(command);
  nonFinite.pooled_metrics[command.model.vmafAlias].harmonic_mean = Number.NaN;
  assert.throws(() => parseOutput(nonFinite, command), /finite/);

  const missingSource = makeOutput(command);
  delete missingSource.frames[0].metrics.cambi_source;
  assert.throws(() => parseOutput(missingSource, command), /source CAMBI/);
});

test('parser rejects metadata that is not produced by this pinned helper', () => {
  const command = buildCommand(baseOptions());
  assert.throws(() => parseOutput(makeOutput(command), {
    ...command,
    revision: 'different',
  }), /command metadata/);
  assert.throws(() => parseOutput(makeOutput(command), {
    ...command,
    model: { ...command.model, vmafAlias: 'vmaf' },
  }), /command metadata/);
});

test('resolution class boundaries admit documented rasters and reject neighbours', () => {
  // Two documented display-model families, per resolutionClassForGeometry:
  //   full-width scope crops      1920x720..1080   / 3840x1440..2160
  //   full-height anamorphic      1440..1920x1080  / 2880..3840x2160
  // 1440x1080 is real Blu-ray material and must qualify; 1280x720 and
  // 2560x1440 must stay outside the immutable contract.
  const accept1080p = [
    [1920, 1080], // canonical
    [1920, 720], // scope-crop lower bound
    [1920, 800], // scope-crop interior
    [1440, 1080], // anamorphic lower bound (the gate-B case)
    [1442, 1080], // just inside the anamorphic bound
  ];
  for (const [width, height] of accept1080p) {
    assert.equal(selectModel({ width, height }).resolutionClass, '1080p',
      `${width}x${height} must resolve to 1080p`);
  }

  const accept4k = [
    [3840, 2160], // canonical
    [3840, 1440], // scope-crop lower bound
    [2880, 2160], // anamorphic lower bound
    [3838, 2160], // just inside the anamorphic bound
  ];
  for (const [width, height] of accept4k) {
    assert.equal(selectModel({ width, height }).resolutionClass, '4k',
      `${width}x${height} must resolve to 4k`);
  }

  const reject = [
    [1280, 720], // documented exclusion
    [2560, 1440], // documented exclusion
    [1438, 1080], // one step below the anamorphic 1080 bound
    [1920, 718], // one step below the scope-crop bound
    [2878, 2160], // one step below the anamorphic 2160 bound
    [3840, 1438], // one step below the 4K scope-crop bound
    [1441, 1080], // odd width is not a representable coded raster
    [1920, 1079], // odd height
  ];
  for (const [width, height] of reject) {
    assert.throws(() => selectModel({ width, height }), /1080p or 4K/,
      `${width}x${height} must be rejected`);
  }
});

test('coded geometry, SAR/DAR and normalization are explicit and identity-bound', () => {
  const geometry = {
    model: 'vmaf_v1.0.16_3d0h',
    pixelFormat: 'yuv420p10le',
    bitDepth: 10,
    pooling: 'harmonic_mean',
    subsample: 1,
    contentClass: 'sdr',
    codedWidth: 1440,
    codedHeight: 1080,
    sampleAspectRatio: '4:3',
    displayAspectRatio: '16:9',
    geometryNormalization: 'none',
  };

  const identity = buildMetricIdentity(geometry);
  assert.equal(identity.codedWidth, 1440);
  assert.equal(identity.codedHeight, 1080);
  assert.equal(identity.sampleAspectRatio, '4:3');
  assert.equal(identity.displayAspectRatio, '16:9');
  assert.equal(identity.geometryNormalization, 'none');
  assert.match(identity.id,
    /codedWidth=1440\|codedHeight=1080\|sampleAspectRatio=4:3\|displayAspectRatio=16:9\|geometryNormalization=none/);

  // Never normalize implicitly: only an explicit 'none' is representable.
  for (const bad of [undefined, null, '', 'auto', 'scale', 'sar', 'letterbox']) {
    assert.throws(() => buildMetricIdentity({ ...geometry, geometryNormalization: bad }),
      /geometryNormalization must explicitly be none/,
      `geometryNormalization=${String(bad)} must fail closed`);
  }

  // Aspect ratios must be explicit positive N:D, never inferred from geometry.
  for (const bad of [undefined, null, '', '16x9', '16/9', '0:1', '1:0', '-1:1', 'square']) {
    assert.throws(() => buildMetricIdentity({ ...geometry, sampleAspectRatio: bad }),
      /sampleAspectRatio must be an explicit positive N:D ratio/,
      `sampleAspectRatio=${String(bad)} must fail closed`);
    assert.throws(() => buildMetricIdentity({ ...geometry, displayAspectRatio: bad }),
      /displayAspectRatio must be an explicit positive N:D ratio/,
      `displayAspectRatio=${String(bad)} must fail closed`);
  }

  // Ratios are canonicalized so equivalent forms share one identity.
  assert.equal(buildMetricIdentity({ ...geometry, sampleAspectRatio: '8:6' }).sampleAspectRatio, '4:3');
  assert.equal(buildMetricIdentity({ ...geometry, sampleAspectRatio: '8:6' }).id,
    buildMetricIdentity({ ...geometry, sampleAspectRatio: '4:3' }).id);

  // Coded geometry must be a positive integer raster.
  for (const bad of [undefined, null, 0, -1080, 1080.5, '1080']) {
    assert.throws(() => buildMetricIdentity({ ...geometry, codedWidth: bad }), /coded dimensions/,
      `codedWidth=${String(bad)} must fail closed`);
    assert.throws(() => buildMetricIdentity({ ...geometry, codedHeight: bad }), /coded dimensions/,
      `codedHeight=${String(bad)} must fail closed`);
  }

  // Individually changing the raster or either aspect ratio makes the identity
  // internally inconsistent and must fail before it can become authoritative.
  assert.throws(() => buildMetricIdentity({ ...geometry, codedWidth: 1920 }),
    /inconsistent/);
  assert.throws(() => buildMetricIdentity({ ...geometry, codedHeight: 1082 }),
    /does not support|inconsistent/);
  assert.throws(() => buildMetricIdentity({ ...geometry, sampleAspectRatio: '1:1' }),
    /inconsistent/);
  assert.throws(() => buildMetricIdentity({ ...geometry, displayAspectRatio: '4:3' }),
    /inconsistent/);

  const squareFourThree = buildMetricIdentity({
    ...geometry,
    sampleAspectRatio: '1:1',
    displayAspectRatio: '4:3',
  });
  assert.notEqual(identity.id, squareFourThree.id,
    'two distinct but internally valid SAR/DAR identities remain distinguishable');
});

test('geometry authority accepts only model-family rasters with exact SAR/DAR', () => {
  const accepted = [
    [1920, 1080, '1:1', '16:9', '1080p'],
    [1920, 800, '1:1', '12:5', '1080p'],
    [1440, 1080, '4:3', '16:9', '1080p'],
    [3840, 1604, '1:1', '960:401', '4k'],
    [2880, 2160, '4:3', '16:9', '4k'],
  ];
  for (const [width, height, sar, dar, resolutionClass] of accepted) {
    const geometry = validateGeometry({
      width,
      height,
      sampleAspectRatio: sar,
      displayAspectRatio: dar,
      geometryNormalization: 'none',
    });
    assert.equal(geometry.resolutionClass, resolutionClass);
  }

  for (const [width, height] of [
    [1280, 720], // 720p
    [2560, 1440], // 1440p
    [720, 480], // SD
    [1080, 1920], // portrait
    [4096, 2160], // DCI 4K
  ]) {
    assert.throws(() => validateGeometry({
      width,
      height,
      sampleAspectRatio: '1:1',
      displayAspectRatio: `${width}:${height}`,
      geometryNormalization: 'none',
    }), (error) => error.code === 'VMAF_V1_GEOMETRY_UNSUPPORTED');
  }

  assert.throws(() => validateGeometry({
    width: 1920,
    height: 800,
    sampleAspectRatio: '1:1',
    displayAspectRatio: '16:9',
    geometryNormalization: 'none',
  }), (error) => error.code === 'VMAF_V1_GEOMETRY_ASPECT_MISMATCH');
  assert.throws(() => validateGeometry({
    width: 1440,
    height: 1080,
    sampleAspectRatio: '1:1',
    displayAspectRatio: '16:9',
    geometryNormalization: 'none',
  }), (error) => error.code === 'VMAF_V1_GEOMETRY_ASPECT_MISMATCH');
});
