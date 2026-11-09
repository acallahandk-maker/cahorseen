import {
    readFileSync,
    statSync
} from 'node:fs';
import path from 'node:path';
import {
    describe,
    expect,
    it
} from 'vitest';
import {
    accelerateIdleDrift,
    evaluatePerformanceProfile,
    resolveMascotResourceMode,
    ResourcePressureGovernor,
    type PerformanceMeasurement
} from '../../src/shared/performanceProfile';

const measurement: PerformanceMeasurement = {
    idleCpuPercent: 0.4,
    activeCpuPercent: 8.2,
    normalPrivateBytes: 220 * 1024 * 1024,
    peakPrivateBytes: 410 * 1024 * 1024,
    interactionLatencyMs: 120
};

describe('performance profile release gate', () => {
    it('accepts measurements within the product targets', () => {
        expect(evaluatePerformanceProfile(measurement)).toEqual({
            pass: true,
            failures: []
        });
    });

    it('fails when any measured target is exceeded', () => {
        expect(evaluatePerformanceProfile({
            ...measurement,
            activeCpuPercent: 15,
            peakPrivateBytes: 450 * 1024 * 1024,
            interactionLatencyMs: 200
        })).toEqual({
            pass: false,
            failures: [
                'translation CPU must be below 15%',
                'screenshot peak private memory must be below 450 MB',
                'interaction feedback must be below 200 ms'
            ]
        });
    });

    it('reports accelerated eight-hour drift evidence without claiming a wall-clock run', () => {
        const drift = accelerateIdleDrift({
            startPrivateBytes: 200 * 1024 * 1024,
            samples: [200 * 1024 * 1024, 250 * 1024 * 1024],
            simulatedHours: 8,
            wallClockDurationMs: 120_000
        });

        expect(drift.measurementKind).toBe('accelerated-8-hour-equivalent');
        expect(drift.simulatedHours).toBe(8);
        expect(drift.wallClockDurationMs).toBe(120_000);
        expect(drift.wallClockHoursMeasured).toBe(120_000 / 3_600_000);
        expect(drift.pass).toBe(false);
    });
});

describe('release gates', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');

    it('requires release scripts and an installer-producing Windows build', () => {
        const gitignore = readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
        const packageJson = JSON.parse(
            readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
        ) as {
            scripts: Record<string, string>;
            build?: {
                npmRebuild?: boolean;
                electronDist?: string;
                win?: { target?: unknown };
            };
        };

        expect(packageJson.scripts['validate:release']).toContain('validate-release.ps1');
        expect(packageJson.scripts['profile:performance']).toContain('profile-performance.mjs');
        expect(packageJson.scripts['build:windows']).toContain('electron-builder --win');
        expect(packageJson.build?.npmRebuild).toBe(false);
        expect(packageJson.build?.electronDist).toBe('node_modules/electron/dist');
        expect(packageJson.build?.win?.target).toContainEqual(expect.objectContaining({
            target: 'nsis'
        }));
        expect(gitignore).toContain('/dist/');
        expect(statSync(path.join(projectRoot, 'scripts/validate-release.ps1')).isFile()).toBe(true);
    });

    it('records model, dependency, license, privacy, and personal-use release checks', () => {
        const assets = readFileSync(path.join(projectRoot, 'ASSETS.md'), 'utf8');
        const readme = readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
        const checklist = readFileSync(
            path.join(projectRoot, 'docs/operations/release-checklist.md'),
            'utf8'
        );

        expect(assets).toContain('personal-only');
        expect(readme).toContain('npm run validate:release');
        expect(readme).toContain('npm run build:windows');
        expect(checklist).toMatch(/Model and license verification/i);
        expect(checklist).toMatch(/Dependency and license review/i);
        expect(checklist).toContain('personal-only');
        expect(checklist).toMatch(/No API keys or secrets/i);
        expect(checklist).toMatch(/No screenshots or image buffers persist/i);
    });
});

describe('mascot resource pressure', () => {
    it('reduces animation resources before choosing a static mascot', () => {
        expect(resolveMascotResourceMode({
            privateBytes: 280 * 1024 * 1024,
            interactionLatencyMs: 100
        })).toBe('full');
        expect(resolveMascotResourceMode({
            privateBytes: 320 * 1024 * 1024,
            interactionLatencyMs: 100
        })).toBe('reduced');
        expect(resolveMascotResourceMode({
            privateBytes: 320 * 1024 * 1024,
            interactionLatencyMs: 250,
            sustainedPressureSamples: 3
        })).toBe('static');
    });

    it('keeps a static fallback only for sustained critical pressure', () => {
        expect(resolveMascotResourceMode({
            privateBytes: 320 * 1024 * 1024,
            interactionLatencyMs: 250,
            sustainedPressureSamples: 2
        })).toBe('reduced');
    });

    it('downgrades animation resources before a sustained static fallback', () => {
        const governor = new ResourcePressureGovernor();
        const critical = {
            privateBytes: 320 * 1024 * 1024,
            interactionLatencyMs: 250
        };

        expect(governor.observe({
            privateBytes: 320 * 1024 * 1024,
            interactionLatencyMs: 100
        })).toBe('reduced');
        expect(governor.observe(critical)).toBe('reduced');
        expect(governor.observe(critical)).toBe('reduced');
        expect(governor.observe(critical)).toBe('static');
    });
});
