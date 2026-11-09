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

export interface IdleDriftCycleModel {
    kind: 'idle-equivalent-local-maintenance';
    virtualHours: 8;
    minutesPerCycle: 1;
    cycleCount: 480;
}

export interface AcceleratedIdleDriftEvidence {
    measurementKind: 'accelerated-workload-cycles';
    executedCycles: number;
    declaredCycles: number;
    equivalentHours: number;
    minutesPerCycle: number;
    wallClockDurationMs: number;
    startPrivateBytes: number;
    endPrivateBytes: number;
    growthBytes: number;
    sampleCount: number;
    targetBytes: number;
    pass: boolean;
}

export interface RealIdleDriftEvidence {
    measurementKind: 'real-wall-clock';
    measuredHours: number;
    wallClockDurationMs: number;
    startPrivateBytes: number;
    endPrivateBytes: number;
    growthBytes: number;
    sampleCount: number;
    targetBytes: number;
    pass: boolean;
}

export type IdleDriftEvidence =
    | AcceleratedIdleDriftEvidence
    | RealIdleDriftEvidence;

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

export function evaluateAcceleratedIdleDrift(options: {
    startPrivateBytes: number;
    samples: readonly number[];
    cycleModel: IdleDriftCycleModel;
    wallClockDurationMs: number;
    targetBytes?: number;
}): AcceleratedIdleDriftEvidence {
    const { cycleModel } = options;
    if (
        cycleModel.kind !== 'idle-equivalent-local-maintenance'
        || cycleModel.virtualHours !== 8
        || cycleModel.minutesPerCycle !== 1
        || cycleModel.cycleCount !== 480
    )
        throw new Error('Accelerated drift requires the declared 480-cycle, eight-hour-equivalent workload model.');
    if (options.samples.length !== cycleModel.cycleCount) {
        throw new Error(
            `Accelerated drift requires ${cycleModel.cycleCount} workload-cycle samples; received ${options.samples.length}.`
        );
    }
    if (
        !Number.isFinite(options.startPrivateBytes)
        || options.startPrivateBytes < 0
        || !Number.isFinite(options.wallClockDurationMs)
        || options.wallClockDurationMs <= 0
        || options.samples.some((sample) => !Number.isFinite(sample) || sample < 0)
    )
        throw new Error('Accelerated drift evidence contains invalid measurements.');
    const endPrivateBytes = options.samples.at(-1) ?? options.startPrivateBytes;
    const growthBytes = endPrivateBytes - options.startPrivateBytes;
    const targetBytes = options.targetBytes ?? PERFORMANCE_TARGETS.idleDriftBytes;
    return {
        measurementKind: 'accelerated-workload-cycles',
        executedCycles: options.samples.length,
        declaredCycles: cycleModel.cycleCount,
        equivalentHours: cycleModel.virtualHours,
        minutesPerCycle: cycleModel.minutesPerCycle,
        wallClockDurationMs: options.wallClockDurationMs,
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
    const criticalPressure =
        input.interactionLatencyMs >= PERFORMANCE_TARGETS.interactionLatencyMs;
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
        const criticalPressure =
            input.interactionLatencyMs >= PERFORMANCE_TARGETS.interactionLatencyMs;
        this.sustainedPressureSamples = criticalPressure
            ? Math.min(this.sustainedPressureSamples + 1, 3)
            : 0;
        return resolveMascotResourceMode({
            ...input,
            sustainedPressureSamples: this.sustainedPressureSamples
        });
    }
}
