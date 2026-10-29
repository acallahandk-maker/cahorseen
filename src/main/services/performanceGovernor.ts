import type {
    PerformanceFrameRate,
    PerformanceMode,
    PerformanceReason
} from '../../shared/contracts';

export interface PerformanceContext {
    reason?: PerformanceReason;
    idle?: boolean;
    hidden?: boolean;
    battery?: boolean;
    paused?: boolean;
    fullscreen?: boolean;
    suppressed?: boolean;
    obscured?: boolean;
}

export type PerformanceInput = PerformanceContext | PerformanceMode;

const frameRateByReason: Readonly<Record<PerformanceReason, PerformanceFrameRate>> = {
    normal: 30,
    idle: 10,
    hidden: 10,
    battery: 10,
    paused: 0,
    fullscreen: 0
};

function isPerformanceMode(input: PerformanceInput): input is PerformanceMode {
    return 'reason' in input && 'frameRate' in input;
}

function reasonFromContext(context: PerformanceContext): PerformanceReason {
    if (context.reason !== undefined)
        return context.reason;
    if (context.paused === true || context.obscured === true)
        return 'paused';
    if (context.fullscreen === true)
        return 'fullscreen';
    if (context.hidden === true)
        return 'hidden';
    if (context.battery === true)
        return 'battery';
    if (context.idle === true)
        return 'idle';
    return 'normal';
}

export function resolvePerformanceMode(input: PerformanceInput): PerformanceMode {
    if (isPerformanceMode(input))
        return input;
    if (input.reason !== undefined) {
        return {
            reason: input.reason,
            frameRate: frameRateByReason[input.reason],
            suppressed: input.suppressed === true || input.obscured === true
        };
    }

    const reason = reasonFromContext(input);
    return {
        reason,
        frameRate: frameRateByReason[reason],
        suppressed: input.suppressed === true
            || input.obscured === true
            || reason === 'paused'
            || reason === 'fullscreen'
    };
}

export function targetFrameRate(input: PerformanceInput): PerformanceFrameRate {
    return resolvePerformanceMode(input).frameRate;
}

export function shouldPauseLoop(input: PerformanceInput): boolean {
    const mode = resolvePerformanceMode(input);
    return mode.suppressed || mode.reason === 'hidden' || mode.frameRate === 0;
}
