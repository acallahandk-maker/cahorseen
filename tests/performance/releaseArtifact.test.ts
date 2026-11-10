import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCurrentInstaller } from '../../scripts/resolve-current-installer.mjs';

const temporaryDirectories: string[] = [];

function temporaryProject() {
    const root = mkdtempSync(path.join(tmpdir(), 'desktop-pet-release-artifact-'));
    temporaryDirectories.push(root);
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({
        version: '0.1.0',
        build: {
            win: {
                artifactName: 'Desktop-Pet-Translator-${version}-setup.${ext}'
            }
        }
    }));
    mkdirSync(path.join(root, 'dist'));
    return root;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0))
        rmSync(directory, { recursive: true, force: true });
});

describe('current release installer enforcement', () => {
    it('rejects a stale expected installer even when a newer foreign installer exists', async () => {
        const root = temporaryProject();
        const expectedInstaller = path.join(
            root,
            'dist',
            'Desktop-Pet-Translator-0.1.0-setup.exe'
        );
        const staleTime = new Date('2026-01-01T00:00:00.000Z');
        writeFileSync(expectedInstaller, 'stale');
        utimesSync(expectedInstaller, staleTime, staleTime);
        writeFileSync(path.join(root, 'dist', 'foreign-setup.exe'), 'newer foreign artifact');

        await expect(resolveCurrentInstaller({
            projectRoot: root,
            builtAfterMs: Date.parse('2026-02-01T00:00:00.000Z')
        })).rejects.toThrow(/predates the current build/i);
    });

    it('returns only the exact current-build installer with size and hash evidence', async () => {
        const root = temporaryProject();
        const expectedInstaller = path.join(
            root,
            'dist',
            'Desktop-Pet-Translator-0.1.0-setup.exe'
        );
        const builtAfterMs = Date.now() - 1_000;
        writeFileSync(expectedInstaller, 'current installer');
        writeFileSync(path.join(root, 'dist', 'foreign-setup.exe'), 'foreign artifact');

        const result = await resolveCurrentInstaller({
            projectRoot: root,
            builtAfterMs
        });

        expect(result.path).toBe(expectedInstaller);
        expect(result.sizeBytes).toBe(Buffer.byteLength('current installer'));
        expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('requires release validation to rebuild and pass the exact installer to smoke', () => {
        const script = readFileSync(
            path.join(import.meta.dirname, '../../scripts/validate-release.ps1'),
            'utf8'
        );
        const buildIndex = script.indexOf("Invoke-Checked 'npm' @('run', 'build:windows')");
        const resolveIndex = script.indexOf('$currentInstallerJson = & node $installerResolverPath');
        const smokeIndex = script.indexOf("Invoke-Checked 'npm' @('run', 'smoke:installed'");

        expect(buildIndex).toBeGreaterThan(-1);
        expect(resolveIndex).toBeGreaterThan(buildIndex);
        expect(smokeIndex).toBeGreaterThan(resolveIndex);
        expect(script).toContain("'--InstallerPath', $installer.FullName");
        expect(script).not.toContain('if ($null -eq $installer)');
    });
});
