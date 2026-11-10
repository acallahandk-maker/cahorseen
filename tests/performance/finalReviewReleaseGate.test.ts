import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('final review packaged smoke gate', () => {
    it('requires a normal sandbox installed-app launch in release validation', () => {
        const packageJson = JSON.parse(
            readFileSync(join(root, 'package.json'), 'utf8')
        ) as { scripts: Record<string, string> };
        const validateRelease = readFileSync(
            join(root, 'scripts/validate-release.ps1'),
            'utf8'
        );
        const installedSmoke = readFileSync(
            join(root, 'scripts/smoke-installed.ps1'),
            'utf8'
        );

        expect(packageJson.scripts['smoke:installed']).toContain(
            'smoke-installed.ps1'
        );
        expect(validateRelease).toContain('smoke-installed.ps1');
        expect(validateRelease).toContain('build:windows');
        expect(installedSmoke).not.toContain('--no-sandbox');
        expect(installedSmoke).toContain('sandbox');
    });
});
