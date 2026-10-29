import { describe, expect, it } from 'vitest';
import {
    resolvePerformanceMode,
    shouldPauseLoop,
    targetFrameRate
} from '../../src/main/services/performanceGovernor';

describe('performanceGovernor', () => {
    it.each([
        { reason: 'normal', frameRate: 30 },
        { reason: 'idle', frameRate: 10 },
        { reason: 'hidden', frameRate: 10 },
        { reason: 'battery', frameRate: 10 },
        { reason: 'paused', frameRate: 0 },
        { reason: 'fullscreen', frameRate: 0 }
    ] as const)('maps $reason to $frameRate FPS', ({ reason, frameRate }) => {
        expect(targetFrameRate({ reason, suppressed: false })).toBe(frameRate);
        expect(resolvePerformanceMode({ reason, suppressed: false })).toEqual({
            reason,
            frameRate,
            suppressed: false
        });
    });

    it('pauses hidden and suppressed rendering while preserving the hidden frame-rate contract', () => {
        expect(targetFrameRate({ hidden: true })).toBe(10);
        expect(shouldPauseLoop({ hidden: true })).toBe(true);
        expect(shouldPauseLoop({ reason: 'normal', suppressed: true })).toBe(true);
    });

    it('treats obscured rendering as suppressed and paused', () => {
        expect(resolvePerformanceMode({ obscured: true })).toEqual({
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        });
        expect(shouldPauseLoop({ obscured: true })).toBe(true);
    });

    it('uses deterministic precedence for overlapping boolean states', () => {
        expect(resolvePerformanceMode({
            idle: true,
            battery: true,
            hidden: true,
            paused: true,
            fullscreen: true
        })).toEqual({
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        });
    });

    it('caps active rendering at thirty frames per second', () => {
        expect(targetFrameRate({ reason: 'normal', suppressed: false })).toBe(30);
    });
});
