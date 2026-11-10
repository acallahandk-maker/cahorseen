import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function expectedInstallerName(packageJson) {
    const version = packageJson?.version;
    const artifactName = packageJson?.build?.win?.artifactName;
    if (typeof version !== 'string' || version.length === 0)
        throw new Error('package.json must define a release version.');
    if (typeof artifactName !== 'string' || artifactName.length === 0)
        throw new Error('package.json must define build.win.artifactName.');
    return artifactName
        .replaceAll('${version}', version)
        .replaceAll('${ext}', 'exe');
}

export async function resolveCurrentInstaller({ projectRoot, builtAfterMs }) {
    if (!Number.isFinite(builtAfterMs))
        throw new Error('Current-build timestamp is required.');

    const packageJsonPath = path.join(projectRoot, 'package.json');
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    const installerPath = path.join(
        projectRoot,
        'dist',
        expectedInstallerName(packageJson)
    );

    let installerStat;
    try {
        installerStat = await stat(installerPath);
    } catch {
        throw new Error(`Current-build installer is missing: ${installerPath}`);
    }
    if (!installerStat.isFile())
        throw new Error(`Current-build installer is not a file: ${installerPath}`);
    if (installerStat.mtimeMs < builtAfterMs)
        throw new Error(`Installer predates the current build: ${installerPath}`);

    const bytes = await readFile(installerPath);
    return {
        path: installerPath,
        sizeBytes: installerStat.size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        modifiedAtUtc: new Date(installerStat.mtimeMs).toISOString()
    };
}

function parseArguments(arguments_) {
    const values = new Map();
    for (let index = 0; index < arguments_.length; index += 2) {
        const key = arguments_[index];
        const value = arguments_[index + 1];
        if (typeof key !== 'string' || !key.startsWith('--') || value === undefined)
            throw new Error('Installer resolver arguments must be --name value pairs.');
        values.set(key.slice(2), value);
    }
    return values;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const values = parseArguments(process.argv.slice(2));
        const projectRoot = values.get('root');
        const builtAfterMs = Number(values.get('built-after-ms'));
        if (projectRoot === undefined)
            throw new Error('--root is required.');
        const result = await resolveCurrentInstaller({ projectRoot, builtAfterMs });
        process.stdout.write(JSON.stringify(result));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
