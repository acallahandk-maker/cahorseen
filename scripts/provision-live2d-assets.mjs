import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    cpSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const lockPath = path.join(projectRoot, 'config', 'live2d-assets.lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const assetRoot = resolveInside(projectRoot, lock.assetRoot, 'assetRoot');
const cacheRoot = path.join(projectRoot, 'node_modules', '.cache', 'desktop-pet-translator', 'live2d');
const pathCollator = new Intl.Collator('en');

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function fileSha256(filePath) {
    return sha256(readFileSync(filePath));
}

function assertHash(filePath, expected, label) {
    const actual = fileSha256(filePath);
    if (actual !== expected)
        throw new Error(`${label} checksum mismatch: expected ${expected}, received ${actual}`);
}

function resolveInside(root, relativePath, label) {
    if (
        typeof relativePath !== 'string'
        || relativePath.length === 0
        || path.isAbsolute(relativePath)
        || relativePath.includes('\\')
        || relativePath.includes('\0')
    ) {
        throw new Error(`${label} must be a relative POSIX path`);
    }
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, ...relativePath.split('/'));
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`))
        throw new Error(`${label} escapes its root`);
    return resolved;
}

function listFiles(root) {
    const files = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory())
                visit(entryPath);
            else if (entry.isFile())
                files.push(entryPath);
        }
    };
    visit(root);
    return files.sort((left, right) => pathCollator.compare(
        path.relative(root, left).replaceAll('\\', '/'),
        path.relative(root, right).replaceAll('\\', '/')
    ));
}

function hashTree(root) {
    const entries = listFiles(root).map((filePath) => {
        const relativePath = path.relative(root, filePath).replaceAll('\\', '/');
        return `${relativePath}\0${fileSha256(filePath)}\n`;
    });
    return sha256(entries.join(''));
}

async function downloadFile(url, destination, expectedHash, label) {
    mkdirSync(path.dirname(destination), { recursive: true });
    if (existsSync(destination)) {
        try {
            assertHash(destination, expectedHash, label);
            return;
        } catch {
            rmSync(destination, { force: true });
        }
    }

    const temporaryPath = `${destination}.part-${process.pid}`;
    try {
        const response = await fetch(url, { redirect: 'follow' });
        if (!response.ok || response.body === null)
            throw new Error(`${label} download failed with ${response.status}`);
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath));
        assertHash(temporaryPath, expectedHash, label);
        renameSync(temporaryPath, destination);
    } finally {
        rmSync(temporaryPath, { force: true });
    }
}

function extractArchive(archivePath, destination) {
    mkdirSync(destination, { recursive: true });
    const result = spawnSync('tar', ['-xf', archivePath, '-C', destination], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
    });
    if (result.error)
        throw result.error;
    if (result.status !== 0)
        throw new Error(`Archive extraction failed: ${result.stderr.toString()}`);
}

function removeGeneratedRoot(target) {
    const resolved = path.resolve(target);
    if (resolved !== assetRoot && !resolved.startsWith(`${assetRoot}${path.sep}`))
        throw new Error('Refusing to remove a path outside the Live2D asset root');
    rmSync(resolved, { force: true, recursive: true });
}

function isExcluded(relativePath, exclusions) {
    return exclusions.some((prefix) => relativePath.startsWith(prefix));
}

function copyVerifiedTree(sourceRoot, outputRoot, exclusions, manifestPath) {
    for (const sourceFile of listFiles(sourceRoot)) {
        const relativePath = path.relative(sourceRoot, sourceFile).replaceAll('\\', '/');
        if (isExcluded(relativePath, exclusions))
            continue;
        const destination = resolveInside(outputRoot, relativePath, 'model output file');
        mkdirSync(path.dirname(destination), { recursive: true });
        cpSync(sourceFile, destination);
    }
    return resolveInside(outputRoot, manifestPath, 'model manifest output');
}

function motionEntry(sourceMotions, file) {
    const entry = Object.values(sourceMotions)
        .flatMap((group) => Array.isArray(group) ? group : [])
        .find((candidate) => candidate?.File === file);
    return {
        File: file,
        FadeInTime: entry?.FadeInTime ?? 0.5,
        FadeOutTime: entry?.FadeOutTime ?? 0.5
    };
}

function modifyManifest(manifest, modelLock) {
    const fileReferences = manifest?.FileReferences;
    const sourceMotions = fileReferences?.Motions;
    if (!fileReferences || typeof fileReferences !== 'object' || !sourceMotions || typeof sourceMotions !== 'object')
        throw new Error('Haru source manifest is missing FileReferences.Motions');

    const stateMotions = {};
    for (const [group, file] of Object.entries(modelLock.stateMotionFiles))
        stateMotions[group] = [motionEntry(sourceMotions, file)];

    const tapBody = Array.isArray(sourceMotions.TapBody) ? sourceMotions.TapBody : [];
    stateMotions.TapBody = tapBody.map((entry) => {
        const silentEntry = { ...entry };
        delete silentEntry.Sound;
        return silentEntry;
    });
    fileReferences.Motions = stateMotions;
    return `${JSON.stringify(manifest, null, '\t')}\n`;
}

function collectManifestReferences(manifest) {
    const fileReferences = manifest?.FileReferences;
    if (!fileReferences || typeof fileReferences !== 'object')
        throw new Error('Generated model manifest is missing FileReferences');
    const references = [
        fileReferences.Moc,
        ...(Array.isArray(fileReferences.Textures) ? fileReferences.Textures : []),
        fileReferences.Physics,
        fileReferences.Pose,
        fileReferences.DisplayInfo,
        fileReferences.UserData
    ];
    for (const expression of Array.isArray(fileReferences.Expressions) ? fileReferences.Expressions : [])
        references.push(expression?.File);
    for (const group of Object.values(fileReferences.Motions ?? {})) {
        for (const motion of Array.isArray(group) ? group : [])
            references.push(motion?.File, motion?.Sound);
    }
    return references.filter((reference) => reference !== undefined);
}

function verifyGeneratedManifest(manifestPath, modelLock) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assertHash(manifestPath, modelLock.outputManifestSha256, 'generated Haru manifest');
    for (const reference of collectManifestReferences(manifest)) {
        const referencePath = resolveInside(path.dirname(manifestPath), reference, 'generated manifest reference');
        if (!existsSync(referencePath))
            throw new Error(`Generated manifest reference does not exist: ${reference}`);
    }
    for (const [group, file] of Object.entries(modelLock.stateMotionFiles)) {
        const motion = manifest.FileReferences.Motions[group]?.[0];
        if (motion?.File !== file)
            throw new Error(`Generated manifest state motion ${group} is incorrect`);
    }
}

function verifyOutputs() {
    const coreOutput = resolveInside(assetRoot, lock.core.outputPath, 'Core output');
    assertHash(coreOutput, lock.core.outputSha256, 'Cubism Core output');

    const modelOutput = resolveInside(assetRoot, lock.model.outputPath, 'model output');
    const modelFiles = listFiles(modelOutput);
    if (modelFiles.length !== lock.model.outputFileCount)
        throw new Error(`Haru output file count mismatch: expected ${lock.model.outputFileCount}, received ${modelFiles.length}`);
    if (hashTree(modelOutput) !== lock.model.outputTreeSha256)
        throw new Error('Haru output tree checksum mismatch');
    verifyGeneratedManifest(
        resolveInside(modelOutput, 'Haru.model3.json', 'Haru manifest'),
        lock.model
    );

    for (const license of [...lock.coreLicenses, ...lock.remoteLicenses]) {
        const outputPath = resolveInside(assetRoot, license.outputPath, 'license output');
        assertHash(outputPath, license.sha256, `${license.name ?? license.member} license`);
    }
}

async function provision() {
    mkdirSync(cacheRoot, { recursive: true });
    const extractionRoot = mkdtempSync(path.join(tmpdir(), 'desktop-pet-live2d-assets-'));
    try {
        const coreArchive = path.join(cacheRoot, lock.core.cacheName);
        await downloadFile(lock.core.url, coreArchive, lock.core.archiveSha256, 'Cubism SDK archive');
        const coreExtraction = path.join(extractionRoot, 'core');
        extractArchive(coreArchive, coreExtraction);
        const coreRoot = resolveInside(coreExtraction, lock.core.archiveRoot, 'Core archive root');
        const coreMember = resolveInside(coreRoot, lock.core.member, 'Core member');
        assertHash(coreMember, lock.core.memberSha256, 'Cubism Core member');

        const modelArchive = path.join(cacheRoot, lock.model.cacheName);
        await downloadFile(lock.model.url, modelArchive, lock.model.archiveSha256, 'Haru archive');
        const modelExtraction = path.join(extractionRoot, 'model');
        extractArchive(modelArchive, modelExtraction);
        const sampleRoot = resolveInside(modelExtraction, lock.model.archiveRoot, 'sample archive root');
        const modelSource = resolveInside(sampleRoot, lock.model.sourceRoot, 'Haru source root');
        const sourceFiles = listFiles(modelSource);
        if (sourceFiles.length !== lock.model.sourceFileCount)
            throw new Error(`Haru source file count mismatch: expected ${lock.model.sourceFileCount}, received ${sourceFiles.length}`);
        if (hashTree(modelSource) !== lock.model.sourceTreeSha256)
            throw new Error('Haru source tree checksum mismatch');
        const sourceManifest = resolveInside(modelSource, 'Haru.model3.json', 'Haru source manifest');
        assertHash(sourceManifest, lock.model.sourceManifestSha256, 'Haru source manifest');

        removeGeneratedRoot(assetRoot);
        mkdirSync(assetRoot, { recursive: true });
        const coreOutput = resolveInside(assetRoot, lock.core.outputPath, 'Core output');
        mkdirSync(path.dirname(coreOutput), { recursive: true });
        cpSync(coreMember, coreOutput);

        const modelOutput = resolveInside(assetRoot, lock.model.outputPath, 'model output');
        const generatedManifest = copyVerifiedTree(
            modelSource,
            modelOutput,
            lock.model.exclude,
            'Haru.model3.json'
        );
        const modifiedManifest = modifyManifest(
            JSON.parse(readFileSync(sourceManifest, 'utf8')),
            lock.model
        );
        writeFileSync(generatedManifest, modifiedManifest);

        for (const license of lock.coreLicenses) {
            const source = resolveInside(coreRoot, license.member, 'Core license member');
            assertHash(source, license.sha256, `${license.member} license`);
            const destination = resolveInside(assetRoot, license.outputPath, 'license output');
            mkdirSync(path.dirname(destination), { recursive: true });
            cpSync(source, destination);
        }
        for (const license of lock.remoteLicenses) {
            const cachedLicense = path.join(cacheRoot, path.basename(license.outputPath));
            await downloadFile(license.url, cachedLicense, license.sha256, `${license.name} license`);
            const destination = resolveInside(assetRoot, license.outputPath, 'license output');
            mkdirSync(path.dirname(destination), { recursive: true });
            cpSync(cachedLicense, destination);
        }

        verifyOutputs();
        writeFileSync(
            path.join(assetRoot, 'provisioning.json'),
            `${JSON.stringify({
                schemaVersion: lock.schemaVersion,
                core: {
                    version: lock.core.version,
                    archiveSha256: lock.core.archiveSha256,
                    outputSha256: lock.core.outputSha256
                },
                model: {
                    name: lock.model.name,
                    sourceRepository: lock.model.sourceRepository,
                    sourceCommit: lock.model.sourceCommit,
                    archiveSha256: lock.model.archiveSha256,
                    sourceTreeSha256: lock.model.sourceTreeSha256,
                    outputTreeSha256: lock.model.outputTreeSha256,
                    modifications: lock.model.modifications
                }
            }, null, 2)}\n`
        );
    } finally {
        const resolvedExtractionRoot = path.resolve(extractionRoot);
        const resolvedTempRoot = path.resolve(tmpdir());
        if (resolvedExtractionRoot.startsWith(`${resolvedTempRoot}${path.sep}`))
            rmSync(resolvedExtractionRoot, { force: true, recursive: true });
    }
}

try {
    if (process.argv.includes('--verify'))
        verifyOutputs();
    else
        await provision();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
