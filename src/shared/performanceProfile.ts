export interface PerformanceMeasurement {
    idleCpuPercent: number;
    activeCpuPercent: number;
    normalPrivateBytes: number;
    peakPrivateBytes: number;
    interactionLatencyMs: number;
}

export interface PerformanceTargets {
    idleCpuPercent: number;
    activeCpuPercent: number;
    normalPrivateBytes: number;
    peakPrivateBytes: number;
    interactionLatencyMs: number;
    idleDriftBytes: number;
}

export interface PerformanceEvaluation {
    pass: boolean;
    failures: string[];
}

export interface IdleDriftEvidence {
    measurementKind: 'accelerated-8-hour-equivalent' | 'real-wall-clock';
    simulatedHours: number;
    wallClockDurationMs: number;
    wallClockHoursMeasured: number;
    startPrivateBytes: number;
    endPrivateBytes: number;
    growthBytes: number;
    sampleCount: number;
    targetBytes: number;
    pass: boolean;
}

export type MascotResourceMode = 'full' | 'reduced' | 'static';

export interface ResourcePressureInput {
    privateBytes: number;
    interactionLatencyMs: number;
    sustainedPressureSamples?: number;
}

export const PERFORMANCE_TARGETS: PerformanceTargets = {
    idleCpuPercent: 1,
    activeCpuPercent: 15,
    normalPrivateBytes: 300 * 1024 * 1024,
    peakPrivateBytes: 450 * 1024 * 1024,
    interactionLatencyMs: 200,
    idleDriftBytes: 25 * 1024 * 1024
};

export function evaluatePerformanceProfile(
    measurement: PerformanceMeasurement,
    targets: PerformanceTargets = PERFORMANCE_TARGETS
): PerformanceEvaluation {
    const failures: string[] = [];
    if (!(measurement.idleCpuPercent < targets.idleCpuPercent))
        failures.push('idle CPU must be below 1%');
    if (!(measurement.activeCpuPercent < targets.activeCpuPercent))
        failures.push('translation CPU must be below 15%');
    if (!(measurement.normalPrivateBytes < targets.normalPrivateBytes))
        failures.push('normal private memory must be below 300 MB');
    if (!(measurement.peakPrivateBytes < targets.peakPrivateBytes))
        failures.push('screenshot peak private memory must be below 450 MB');
    if (!(measurement.interactionLatencyMs < targets.interactionLatencyMs))
        failures.push('interaction feedback must be below 200 ms');
    return {
        pass: failures.length === 0,
        failures
    };
}

export function accelerateIdleDrift(options: {
    startPrivateBytes: number;
    samples: readonly number[];
    simulatedHours: number;
    wallClockDurationMs: number;
    targetBytes?: number;
}): IdleDriftEvidence {
    const endPrivateBytes = options.samples.at(-1) ?? options.startPrivateBytes;
    const growthBytes = endPrivateBytes - options.startPrivateBytes;
    const targetBytes = options.targetBytes ?? PERFORMANCE_TARGETS.idleDriftBytes;
    return {
        measurementKind: 'accelerated-8-hour-equivalent',
        simulatedHours: options.simulatedHours,
        wallClockDurationMs: options.wallClockDurationMs,
        wallClockHoursMeasured: options.wallClockDurationMs / 3_600_000,
        startPrivateBytes: options.startPrivateBytes,
        endPrivateBytes,
        growthBytes,
        sampleCount: options.samples.length,
        targetBytes,
        pass: growthBytes <= targetBytes
    };
}

export function resolveMascotResourceMode(
    input: ResourcePressureInput
): MascotResourceMode {
    const sustainedPressureSamples = input.sustainedPressureSamples ?? 0;
    const criticalPressure = input.privateBytes >= PERFORMANCE_TARGETS.peakPrivateBytes
        || input.interactionLatencyMs >= PERFORMANCE_TARGETS.interactionLatencyMs;
    if (criticalPressure && sustainedPressureSamples >= 3)
        return 'static';
    const reducedPressure = input.privateBytes >= PERFORMANCE_TARGETS.normalPrivateBytes
        || input.interactionLatencyMs >= PERFORMANCE_TARGETS.interactionLatencyMs * 0.75;
    return reducedPressure ? 'reduced' : 'full';
}

export class ResourcePressureGovernor {
    private sustainedPressureSamples = 0;

    observe(
        input: Omit<ResourcePressureInput, 'sustainedPressureSamples'>
    ): MascotResourceMode {
        const criticalPressure = input.privateBytes >= PERFORMANCE_TARGETS.peakPrivateBytes
            || input.interactionLatencyMs >= PERFORMANCE_TARGETS.interactionLatencyMs;
        this.sustainedPressureSamples = criticalPressure
            ? Math.min(this.sustainedPressureSamples + 1, 3)
            : 0;
        return resolveMascotResourceMode({
            ...input,
            sustainedPressureSamples: this.sustainedPressureSamples
        });
    }
}
