'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const patchRoot = [
    '/custom-cont-init.d/.vmaf-plugin-patches',
    path.resolve(__dirname, '../custom-cont-init.d/.vmaf-plugin-patches'),
    path.resolve(__dirname, 'plugins/vmaf'),
].find((root) => fs.existsSync(path.join(
    root, 'replaceOriginalFileAttested/1.0.0/index.js')));
if (!patchRoot) {
    throw new Error('replaceOriginalFileAttested test payload was not found');
}
const replacement = require(path.join(
    patchRoot, 'replaceOriginalFileAttested/1.0.0/index.js'));
const postReplaceAttestation = require(path.join(
    patchRoot, '_lib/postReplaceAttestation.js'));

function identity(filePath) {
    const inspected = postReplaceAttestation.inspectInstalledFile(filePath);
    return Object.assign({ path: inspected.path }, inspected.identity);
}

function makeFixture(label) {
    const root = fs.mkdtempSync(
        path.join(os.tmpdir(), `tdarr-atomic-install-${label}-`));
    const mediaDir = path.join(root, 'media');
    const workDir = path.join(root, 'work');
    fs.mkdirSync(mediaDir);
    fs.mkdirSync(workDir);
    const original = path.join(mediaDir, 'title.mkv');
    const candidate = path.join(workDir, 'candidate.mkv');
    const originalBytes = Buffer.alloc(1280, 0x31);
    const candidateBytes = Buffer.alloc(1024, 0x43);
    fs.writeFileSync(original, originalBytes);
    fs.writeFileSync(candidate, candidateBytes);
    const paths = replacement._test.pathPlan(original, candidate);
    fs.copyFileSync(candidate, paths.temp, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(original, paths.backup, fs.constants.COPYFILE_EXCL);
    return {
        root,
        paths,
        originalBytes,
        candidateBytes,
        journal: {
            source: identity(original),
            candidate: identity(candidate),
        },
    };
}

function assertExactVisibleTarget(fixture, expected, label) {
    assert.strictEqual(fs.existsSync(fixture.paths.target), true, label);
    assert.deepStrictEqual(
        fs.readFileSync(fixture.paths.target),
        expected,
        label,
    );
}

function injectCopyCrash(fixture, copiedBytes) {
    const stagedBytes = fs.readFileSync(fixture.paths.temp);
    let published = false;
    assert.throws(() =>
        replacement._test.installCandidateAtomically(
            fixture.paths.temp,
            fixture.paths.installTemp,
            fixture.paths.target,
            () => { published = true; },
            'crash-injected replacement',
            fixture.journal.source,
            fixture.journal.candidate,
            {
                copyFileSync(source, destination, flags) {
                    assert.strictEqual(source, fixture.paths.temp);
                    assert.strictEqual(
                        flags,
                        fs.constants.COPYFILE_EXCL,
                        'candidate preparation must remain exclusive');
                    const handle = fs.openSync(destination, 'wx');
                    try {
                        fs.writeSync(
                            handle,
                            stagedBytes,
                            0,
                            copiedBytes,
                            0,
                        );
                    } finally {
                        fs.closeSync(handle);
                    }
                    throw new Error(
                        `injected install-copy crash at ${copiedBytes} bytes`);
                },
            },
        ),
    new RegExp(`injected install-copy crash at ${copiedBytes} bytes`));
    assert.strictEqual(
        published,
        false,
        'an interrupted copy must not publish its temporary bytes');
}

const created = [];
try {
    for (const copiedBytes of [0, 1, 257, 1023, 1024]) {
        const fixture = makeFixture(String(copiedBytes));
        created.push(fixture.root);
        injectCopyCrash(fixture, copiedBytes);
        assertExactVisibleTarget(
            fixture,
            fixture.originalBytes,
            `copy crash at ${copiedBytes} bytes must leave the original visible`,
        );
        let state = replacement._test.classifyReservedFilesystem(
            fixture.paths, fixture.journal);
        assert.strictEqual(
            state.phase,
            copiedBytes === fixture.candidateBytes.length
                ? 'install_ready'
                : 'install_copying',
        );
        if (state.phase === 'install_copying') {
            assert.strictEqual(
                replacement._test.removeInstallTemporary(fixture.paths),
                true,
                'partial .partial.new must be removed during resume');
            state = replacement._test.classifyReservedFilesystem(
                fixture.paths, fixture.journal);
            assert.strictEqual(state.phase, 'backed_up');
        }
        replacement._test.installCandidateAtomically(
            fixture.paths.temp,
            fixture.paths.installTemp,
            fixture.paths.target,
            () => {},
            'resumed replacement',
            fixture.journal.source,
            fixture.journal.candidate,
        );
        assertExactVisibleTarget(
            fixture,
            fixture.candidateBytes,
            `resume after ${copiedBytes} bytes must publish the exact candidate`,
        );
        assert.strictEqual(fs.existsSync(fixture.paths.installTemp), false);
        state = replacement._test.classifyReservedFilesystem(
            fixture.paths, fixture.journal);
        assert.strictEqual(state.phase, 'installed');
        assert.deepStrictEqual(
            fs.readFileSync(fixture.paths.backup),
            fixture.originalBytes,
            'the exact original backup must remain retained');
    }

    const collisionRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'tdarr-atomic-install-collision-'));
    created.push(collisionRoot);
    const collisionMediaDir = path.join(collisionRoot, 'media');
    const collisionWorkDir = path.join(collisionRoot, 'work');
    fs.mkdirSync(collisionMediaDir);
    fs.mkdirSync(collisionWorkDir);
    const collisionOriginal = path.join(collisionMediaDir, 'title.mkv');
    const collisionCandidate = path.join(collisionWorkDir, 'candidate.mkv');
    fs.writeFileSync(collisionOriginal, Buffer.alloc(1280, 0x31));
    fs.writeFileSync(collisionCandidate, Buffer.alloc(1024, 0x43));
    const collisionPaths = replacement._test.pathPlan(
        collisionOriginal, collisionCandidate);
    fs.writeFileSync(collisionPaths.installTemp, 'do-not-overwrite');
    assert.throws(
        () => replacement._test.assertFreshMutationPaths(collisionPaths),
        /partial\.new path already exists|partial\.old backup already exists/,
        'assertFreshMutationPaths must reject a pre-existing .partial.new',
    );
    assert.strictEqual(
        fs.readFileSync(collisionPaths.installTemp, 'utf8'),
        'do-not-overwrite',
        'a pre-existing .partial.new must never be overwritten');

    console.log(
        'PASS atomic candidate install: five copy crash offsets, exact visibility, ' +
        'classified cleanup/resume, retained backup, and exclusive collision guard');
} finally {
    for (const directory of created) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}
