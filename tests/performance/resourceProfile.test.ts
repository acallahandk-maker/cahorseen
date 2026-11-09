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
    calculateCpuPercent,
    consumeInteractionLatencySample,
    evaluateAcceleratedIdleDrift,
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
    it('measures only CPU deltas between established process samples', () => {
        expect(calculateCpuPercent([
            { elapsedMs: 0, cpuMicrosByProcessId: { 42: 500_000 } },
            { elapsedMs: 1_000, cpuMicrosByProcessId: { 42: 600_000 } }
        ])).toBe(10);
        expect(calculateCpuPercent([
            { elapsedMs: 0, cpuMicrosByProcessId: {} },
            { elapsedMs: 1_000, cpuMicrosByProcessId: { 42: 500_000 } }
        ])).toBe(0);
    });

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

    it('accepts only executed workload-cycle evidence for accelerated idle drift', () => {
        const drift = evaluateAcceleratedIdleDrift({
            startPrivateBytes: 200 * 1024 * 1024,
            samples: Array.from({ length: 480 }, (_, index) => (
                200 * 1024 * 1024 + index * 100 * 1024
            )),
            cycleModel: {
                kind: 'idle-equivalent-local-maintenance',
                virtualHours: 8,
                minutesPerCycle: 1,
                cycleCount: 480
            },
            wallClockDurationMs: 12_000
        });

        expect(drift.measurementKind).toBe('accelerated-workload-cycles');
        expect(drift.executedCycles).toBe(480);
        expect(drift.equivalentHours).toBe(8);
        expect(drift.growthBytes).toBe(479 * 100 * 1024);
        expect(drift.pass).toBe(false);
    });

    it('rejects short sample sets that did not execute the declared workload cycles', () => {
        expect(() => evaluateAcceleratedIdleDrift({
            startPrivateBytes: 200 * 1024 * 1024,
            samples: [200 * 1024 * 1024, 201 * 1024 * 1024],
            cycleModel: {
                kind: 'idle-equivalent-local-maintenance',
                virtualHours: 8,
                minutesPerCycle: 1,
                cycleCount: 480
            },
            wallClockDurationMs: 1_000
        })).toThrow(/480 workload-cycle samples/);
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

    it('selects static fallback for sustained peak private-memory pressure', () => {
        const governor = new ResourcePressureGovernor();
        const critical = {
            privateBytes: 450 * 1024 * 1024,
            interactionLatencyMs: 100
        };

        expect(governor.observe(critical)).toBe('reduced');
        expect(governor.observe(critical)).toBe('reduced');
        expect(governor.observe(critical)).toBe('static');
    });

    it('recovers after consuming a single high interaction-latency sample', () => {
        const latencySample = { current: 250 };
        const governor = new ResourcePressureGovernor();
        const highLatency = consumeInteractionLatencySample(latencySample);

        expect(highLatency).toBe(250);
        expect(latencySample.current).toBe(0);
        expect(governor.observe({
            privateBytes: 280 * 1024 * 1024,
            interactionLatencyMs: highLatency
        })).toBe('reduced');
        expect(governor.observe({
            privateBytes: 280 * 1024 * 1024,
            interactionLatencyMs: consumeInteractionLatencySample(latencySample)
        })).toBe('full');
    });
});
