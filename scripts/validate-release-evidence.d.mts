export function scanSecrets(root: string): boolean;
export function validateDependencyLicenses(options: {
    root: string;
    queryPath: string;
    reviewPath: string;
    checklistPath: string;
    packageJsonPath: string;
}): {
    packageCount: number;
    runtimePackageCount: number;
    licenseCounts: Record<string, number>;
};
export function validateProfileFreshness(
    profile: {
        generatedAt: string;
        measurementKind: string;
    },
    now?: Date
): boolean;
export function validatePerformanceEvidence(profile: {
    evaluation?: { pass?: boolean };
    interactionLatencyBasis?: string;
    activeCpuBasis?: string;
    screenshotPeakBasis?: string;
    activeWindowMs?: number;
    interactionSamples?: number;
    screenshotCaptureCount?: number;
    screenshotPeakPrivateBytes?: number;
    idleDriftBasis?: string;
    measurement?: {
        idleCpuPercent?: number;
        activeCpuPercent?: number;
        normalPrivateBytes?: number;
        peakPrivateBytes?: number;
        interactionLatencyMs?: number;
    };
    measurementKind?: string;
    idleDrift?: {
        measurementKind?: string;
        executedCycles?: number;
        declaredCycles?: number;
        sampleCount?: number;
        equivalentHours?: number;
        minutesPerCycle?: number;
        measuredHours?: number;
        wallClockDurationMs?: number;
        wallClockHoursMeasured?: number;
        pass?: boolean;
    };
}): boolean;
