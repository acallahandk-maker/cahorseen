import { describe, expect, it } from 'vitest';
import { mascotEventSchema, mascotStateSchema } from '../../src/shared/contracts';
import { transitionMascotState } from '../../src/shared/domainState';

describe('mascot state machine', () => {
    it('follows the translation path to success or error', () => {
        expect(transitionMascotState('idle', 'listening')).toBe('listening');
        expect(transitionMascotState('listening', 'thinking')).toBe('thinking');
        expect(transitionMascotState('thinking', 'success')).toBe('success');
        expect(transitionMascotState('thinking', 'error')).toBe('error');
    });

    it('follows the quiz path and returns to idle', () => {
        expect(transitionMascotState('idle', 'quizzing')).toBe('quizzing');
        expect(transitionMascotState('quizzing', 'happy')).toBe('happy');
        expect(transitionMascotState('happy', 'idle')).toBe('idle');
        expect(transitionMascotState('quizzing', 'sad')).toBe('sad');
        expect(transitionMascotState('sad', 'idle')).toBe('idle');
    });

    it('rejects unknown transitions without mutating the current state', () => {
        expect(() => transitionMascotState('idle', 'thinking')).toThrow(/unknown mascot transition/i);
        expect(() => transitionMascotState('success', 'idle')).toThrow(/unknown mascot transition/i);
    });

    it('rejects invalid runtime transition inputs at the schema boundary', () => {
        expect(() => transitionMascotState('unknown' as never, 'idle')).toThrow(/expected one of/i);
        expect(() => transitionMascotState('idle', 'unknown' as never)).toThrow(/expected one of/i);
    });

    it('rejects invalid runtime state and event values at the schema boundary', () => {
        for (const value of ['unknown', '', null, 1]) {
            expect(mascotStateSchema.safeParse(value).success).toBe(false);
            expect(mascotEventSchema.safeParse(value).success).toBe(false);
        }
    });
});
