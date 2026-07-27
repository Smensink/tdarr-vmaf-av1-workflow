"use strict";

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pluginPath = process.env.GRAIN_PLUGIN_PATH ||
    path.join(__dirname,
        'custom-cont-init.d/vmaf-plugin-patches/synthesizeFilmGrain/1.0.0/index.js');
const test = require(pluginPath)._test;
const samplePath = process.env.SEMANTIC_MKV_SAMPLE;

if (!samplePath) {
    console.log('mkvmerge primary-video semantic overlay integration skipped (SEMANTIC_MKV_SAMPLE unset)');
    process.exit(0);
}

function run(command, argv) {
    const result = childProcess.spawnSync(command, argv, {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} exited ${result.status}: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
}

function identify(filePath) {
    return test.parseMkvmergeIdentifyJson(run('mkvmerge', ['-J', filePath]), filePath);
}

function oneVideo(identifyJson) {
    const videos = identifyJson.tracks.filter((track) => track.type === 'video');
    assert.strictEqual(videos.length, 1);
    return videos[0];
}

const currentSourcePath = process.env.SEMANTIC_CURRENT_SOURCE;
const currentGrainedPath = process.env.SEMANTIC_CURRENT_GRAINED;
if (currentSourcePath || currentGrainedPath) {
    assert(currentSourcePath && currentGrainedPath,
        'SEMANTIC_CURRENT_SOURCE and SEMANTIC_CURRENT_GRAINED must be set together');
    const currentOverlay = test.buildMkvPrimaryVideoSemanticOverlay(
        identify(currentSourcePath), identify(currentGrainedPath));
    assert.deepStrictEqual(currentOverlay.custom_tags, {});
    assert.deepStrictEqual(test.buildMkvPrimaryVideoSemanticArgs(currentOverlay, null), [],
        'current no-semantics canary title must retain its existing MKVToolNix command');
    console.log('current no-semantics canary overlay is a command no-op');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grain-mkv-semantic-overlay-'));
try {
    const inputIdentify = identify(samplePath);
    const inputVideoId = oneVideo(inputIdentify).id;
    const sourcePath = path.join(root, 'source-rich-semantics.mkv');
    const grainedPath = path.join(root, 'grain-applied-video.mkv');
    const outputPath = path.join(root, 'grain-output.mkv');
    const sourceTagsPath = path.join(root, 'source-tags.xml');
    const overlayTagsPath = path.join(root, 'overlay-tags.xml');
    const sourceTags = {
        custom_rating: 'PG & 13',
        release_name: 'Festival <Master>',
    };
    fs.writeFileSync(sourceTagsPath, test.buildMkvmergeTrackTagsXml(sourceTags), 'utf8');

    const videoOnly = [
        '--no-audio', '--no-subtitles', '--no-buttons', '--no-chapters',
        '--no-attachments', '--no-global-tags',
    ];
    run('mkvmerge', [
        '--quiet', '--output', sourcePath,
        ...videoOnly,
        '--language', `${inputVideoId}:fr-CA`,
        '--track-name', `${inputVideoId}:Director's Cut`,
        '--default-track-flag', `${inputVideoId}:0`,
        '--forced-display-flag', `${inputVideoId}:1`,
        '--track-enabled-flag', `${inputVideoId}:0`,
        '--hearing-impaired-flag', `${inputVideoId}:1`,
        '--visual-impaired-flag', `${inputVideoId}:1`,
        '--text-descriptions-flag', `${inputVideoId}:1`,
        '--original-flag', `${inputVideoId}:1`,
        '--commentary-flag', `${inputVideoId}:1`,
        '--tags', `${inputVideoId}:${sourceTagsPath}`,
        samplePath,
    ]);
    run('mkvmerge', [
        '--quiet', '--output', grainedPath,
        ...videoOnly, '--no-track-tags', samplePath,
    ]);

    const sourceIdentify = identify(sourcePath);
    const grainedIdentify = identify(grainedPath);
    const overlay = test.buildMkvPrimaryVideoSemanticOverlay(
        sourceIdentify, grainedIdentify);
    assert.deepStrictEqual(overlay.custom_tags, sourceTags);
    fs.writeFileSync(overlayTagsPath,
        test.buildMkvmergeTrackTagsXml(overlay.custom_tags), 'utf8');

    const remuxArgs = test.buildMkvmergeRemuxArgs(
        grainedPath, sourcePath, outputPath,
        { format: { tags: {} } }, sourceIdentify, overlay, overlayTagsPath);
    run('mkvmerge', remuxArgs);
    const outputIdentify = identify(outputPath);
    const attestation = test.verifyMkvmergeGrainInventory(
        sourceIdentify, grainedIdentify, outputIdentify);
    assert.deepStrictEqual(attestation.primary_video_semantics.safe_custom_tag_names,
        ['custom_rating', 'release_name']);
    assert.strictEqual(attestation.primary_video_semantics.language_ietf, 'fr-CA');
    assert.strictEqual(attestation.primary_video_semantics.track_name_present, true);
    Object.values(attestation.primary_video_semantics.semantic_flags).forEach((value) => {
        assert.strictEqual(typeof value, 'boolean');
    });
    console.log('mkvmerge primary-video semantic overlay integration passed');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
