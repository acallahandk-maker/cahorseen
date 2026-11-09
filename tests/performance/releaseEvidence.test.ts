import {
    mkdtempSync,
    writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';
import {
    scanSecrets,
    validateDependencyLicenses,
    validatePerformanceEvidence,
    validateProfileFreshness
} from '../../scripts/validate-release-evidence.mjs';

function temporaryDirectory(name: string): string {
    return mkdtempSync(path.join(tmpdir(), `desktop-pet-${name}-`));
}

describe('release evidence validation', () => {
    it('rejects secrets in dotfiles and extensionless files without printing values', () => {
        const root = temporaryDirectory('secret-scan');
        const secretValue = ['credential', 'value', 'must', 'not', 'leak'].join('-');
        writeFileSync(path.join(root, '.env'), `API_KEY=${secretValue}`);

        expect(() => scanSecrets(root)).toThrow(/potential secret/i);
        try {
            scanSecrets(root);
        } catch (error) {
            expect(String(error)).not.toContain(secretValue);
        }
    });

    it('rejects real-looking secrets even when generic fixture prose is adjacent', () => {
        const root = temporaryDirectory('secret-prose');
        const secretValue = ['AKIA', 'EXAMPLE', 'FIXTURE', '01'].join('');
        writeFileSync(
            path.join(root, '.env'),
            `API_KEY=${secretValue} example fixture sample`
        );

        expect(() => scanSecrets(root)).toThrow(/potential secret/i);
        try {
            scanSecrets(root);
        } catch (error) {
            expect(String(error)).not.toContain(secretValue);
        }
    });

    it('allows only explicit safe placeholder values', () => {
        const root = temporaryDirectory('secret-placeholder');
        writeFileSync(
            path.join(root, '.env'),
            [
                'API_KEY=placeholder-safe-credential',
                'TEST_API_KEY=sk-synthetic-test-only'
            ].join('\n')
        );

        expect(scanSecrets(root)).toBe(true);
    });

    it('enforces approved dependency licenses and checklist counts', () => {
        const root = temporaryDirectory('license-policy');
        const queryPath = path.join(root, 'query.json');
        const reviewPath = path.join(root, 'review.json');
        const checklistPath = path.join(root, 'checklist.md');
        const packages = [
            { name: 'root', version: '1.0.0', license: 'UNLICENSED', dev: false },
            { name: 'runtime-mit', version: '1.0.0', license: 'MIT', dev: false },
            { name: 'dev-apache', version: '1.0.0', license: 'Apache-2.0', dev: true }
        ];
        const summary = {
            packageCount: 2,
            runtimePackageCount: 1,
            licenseCounts: {
                'Apache-2.0': 1,
                MIT: 1
            }
        };
        writeFileSync(queryPath, `\uFEFF${JSON.stringify(packages)}`, 'utf8');
        writeFileSync(reviewPath, JSON.stringify(summary));
        writeFileSync(
            checklistPath,
            `<!-- dependency-license-summary ${JSON.stringify(summary)} -->`
        );

        expect(validateDependencyLicenses({
            root,
            queryPath,
            reviewPath,
            checklistPath,
            packageJsonPath: path.join(root, 'package.json')
        })).toEqual(summary);

        writeFileSync(queryPath, JSON.stringify([
            ...packages,
            { name: 'copyleft', version: '1.0.0', license: 'GPL-3.0', dev: false }
        ]));
        expect(() => validateDependencyLicenses({
            root,
            queryPath,
            reviewPath,
            checklistPath,
            packageJsonPath: path.join(root, 'package.json')
        })).toThrow(/not approved/i);
    });

    it('rejects stale performance evidence', () => {
        expect(() => validateProfileFreshness({
            generatedAt: '2026-11-09T00:00:00.000Z',
            measurementKind: 'electron-profile-with-accelerated-workload-cycles'
        }, new Date('2026-11-09T01:00:00.000Z'))).toThrow(/stale performance evidence/i);
    });

    it('accepts a fresh generated review when no prior review exists', () => {
        const root = temporaryDirectory('license-clean-run');
        const queryPath = path.join(root, 'query.json');
        const reviewPath = path.join(root, 'review.json');
        const checklistPath = path.join(root, 'checklist.md');
        const summary = {
            packageCount: 1,
            runtimePackageCount: 1,
            licenseCounts: { MIT: 1 }
        };
        writeFileSync(queryPath, JSON.stringify([
            { name: 'root', version: '1.0.0', license: 'UNLICENSED', dev: false },
            { name: 'runtime-mit', version: '1.0.0', license: 'MIT', dev: false }
        ]));
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({
            name: 'root',
            version: '1.0.0'
        }));
        writeFileSync(
            checklistPath,
            `<!-- dependency-license-summary ${JSON.stringify(summary)} -->`
        );

        expect(validateDependencyLicenses({
            root,
            queryPath,
            reviewPath,
            checklistPath,
            packageJsonPath: path.join(root, 'package.json')
        })).toEqual(summary);
    });

    it('rejects relabeled short drift evidence and accepts only eight-hour real evidence', () => {
        const base = {
            evaluation: { pass: true },
            interactionLatencyBasis: 'input-event-to-rendered-frame',
            activeCpuBasis: 'electron-app-metrics-active-work-window',
            screenshotPeakBasis: 'electron-app-metrics-private-bytes-fine-sampled',
            activeWindowMs: 500,
            interactionSamples: 1,
            screenshotCaptureCount: 1,
            screenshotPeakPrivateBytes: 250 * 1024 * 1024,
            measurement: {
                idleCpuPercent: 0.5,
                activeCpuPercent: 8,
                normalPrivateBytes: 220 * 1024 * 1024,
                peakPrivateBytes: 250 * 1024 * 1024,
                interactionLatencyMs: 50
            }
        };
        expect(() => validatePerformanceEvidence({
            ...base,
            measurementKind: 'electron-profile-with-accelerated-workload-cycles',
            idleDriftBasis: 'electron-app-metrics-private-bytes-executed-workload-cycles',
            idleDrift: {
                measurementKind: 'accelerated-workload-cycles',
                executedCycles: 2,
                declaredCycles: 2,
                sampleCount: 2,
                equivalentHours: 8,
                minutesPerCycle: 1,
                wallClockDurationMs: 100,
                pass: true
            }
        })).toThrow(/480 executed workload cycles/i);
        expect(validatePerformanceEvidence({
            ...base,
            measurementKind: 'electron-real-wall-clock-profile',
            idleDriftBasis: 'electron-app-metrics-private-bytes-real-wall-clock',
            idleDrift: {
                measurementKind: 'real-wall-clock',
                measuredHours: 8,
                wallClockDurationMs: 8 * 60 * 60 * 1000,
                pass: true
            }
        })).toBe(true);
        expect(() => validatePerformanceEvidence({
            ...base,
            measurementKind: 'electron-real-wall-clock-profile',
            idleDriftBasis: 'electron-app-metrics-private-bytes-real-wall-clock',
            idleDrift: {
                measurementKind: 'real-wall-clock',
                measuredHours: 8,
                wallClockDurationMs: 60 * 60 * 1000,
                pass: true
            }
        })).toThrow(/must measure eight hours/i);
    });

    it('rejects dependency evidence that no longer matches the checklist counts', () => {
        const root = temporaryDirectory('license-count-mismatch');
        const queryPath = path.join(root, 'query.json');
        const reviewPath = path.join(root, 'review.json');
        const checklistPath = path.join(root, 'checklist.md');
        const packageJsonPath = path.join(root, 'package.json');
        const summary = {
            packageCount: 1,
            runtimePackageCount: 1,
            licenseCounts: { MIT: 1 }
        };
        writeFileSync(queryPath, JSON.stringify([
            { name: 'root', version: '1.0.0', license: 'UNLICENSED', dev: false },
            { name: 'runtime-mit', version: '1.0.0', license: 'MIT', dev: false }
        ]));
        writeFileSync(packageJsonPath, JSON.stringify({
            name: 'root',
            version: '1.0.0'
        }));
        writeFileSync(reviewPath, JSON.stringify(summary));
        writeFileSync(
            checklistPath,
            `<!-- dependency-license-summary ${JSON.stringify({
                ...summary,
                packageCount: 2
            })} -->`
        );

        expect(() => validateDependencyLicenses({
            root,
            queryPath,
            reviewPath,
            checklistPath,
            packageJsonPath
        })).toThrow(/dependency\/license checklist/i);
    });
});
