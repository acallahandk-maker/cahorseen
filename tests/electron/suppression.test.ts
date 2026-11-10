import { describe, expect, it, vi } from 'vitest';
import {
    configurePerformanceWindowEvents,
    SystemIntegration
} from '../../src/main/systemIntegration';

type PerformanceModeLike = {
    reason: 'normal' | 'idle' | 'hidden' | 'battery' | 'paused' | 'fullscreen';
    frameRate: 0 | 10 | 30;
    suppressed: boolean;
};

interface SystemIntegrationApi {
    setSuppressionPolicy(policy: {
        reduceMotion: boolean;
        pauseWhenFullscreen: boolean;
    }): Promise<void>;
    setFullscreen(fullscreen: boolean): void;
    setActiveTranslation(active: boolean): void;
    setIntenseInput(intenseInput: boolean): void;
    setPresentationActive(active: boolean): void;
    setHidden(hidden: boolean): void;
    setObscured(obscured: boolean): void;
    refreshSystemState(): Promise<void>;
    getPerformanceMode(): PerformanceModeLike;
    getQuizSuppressionReason(): 'fullscreen' | 'activeTranslation' | 'intenseInput' | undefined;
    canStartQuiz(): boolean;
    canAnswerQuiz(): boolean;
    dispose(): Promise<void>;
}

function createIntegration(): {
    integration: SystemIntegrationApi;
    powerMonitor: {
        onBattery: boolean;
        idleState: 'active' | 'idle' | 'locked' | 'unknown';
        batteryReads: number;
        idleReads: number;
        listeners: Map<
            'suspend' | 'resume' | 'on-ac' | 'on-battery',
            Set<() => void>
        >;
        emit(event: 'suspend' | 'resume' | 'on-ac' | 'on-battery'): void;
    };
} {
    const powerMonitor = {
        onBattery: false,
        idleState: 'active' as 'active' | 'idle' | 'locked' | 'unknown',
        batteryReads: 0,
        idleReads: 0,
        listeners: new Map<
            'suspend' | 'resume' | 'on-ac' | 'on-battery',
            Set<() => void>
        >(),
        isOnBatteryPower() {
            ++this.batteryReads;
            return this.onBattery;
        },
        getSystemIdleState() {
            ++this.idleReads;
            return this.idleState;
        },
        on(
            event: 'suspend' | 'resume' | 'on-ac' | 'on-battery',
            listener: () => void
        ) {
            const listeners = this.listeners.get(event) ?? new Set<() => void>();
            listeners.add(listener);
            this.listeners.set(event, listeners);
            return this;
        },
        removeListener(
            event: 'suspend' | 'resume' | 'on-ac' | 'on-battery',
            listener: () => void
        ) {
            this.listeners.get(event)?.delete(listener);
            return this;
        },
        emit(event: 'suspend' | 'resume' | 'on-ac' | 'on-battery') {
            for (const listener of this.listeners.get(event) ?? [])
                listener();
        }
    };
    const Integration = SystemIntegration as unknown as new (options: unknown) => SystemIntegrationApi;
    return {
        integration: new Integration({
            shortcutRegistrar: {
                register: () => true,
                unregister: () => undefined
            },
            tray: {
                setContextMenu: () => undefined,
                destroy: () => undefined
            },
            buildMenu: (template: unknown) => template,
            powerMonitor,
            onSelectionShortcut: () => undefined,
            onScreenshotShortcut: () => undefined,
            onShow: () => undefined,
            onOpenSettings: () => undefined,
            onCheckUpdates: () => undefined,
            onPausedChange: () => undefined,
            onExit: () => undefined
        }),
        powerMonitor
    };
}

describe('performance suppression', () => {
    it('pauses animation when the shared policy requests reduced motion', async () => {
        const harness = createIntegration();

        await harness.integration.setSuppressionPolicy({
            reduceMotion: true,
            pauseWhenFullscreen: true
        });

        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        });
    });

    it('uses deterministic modes for presentation, fullscreen, battery, and normal states', async () => {
        const harness = createIntegration();
        await harness.integration.setSuppressionPolicy({
            reduceMotion: false,
            pauseWhenFullscreen: true
        });

        harness.integration.setPresentationActive(true);
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        });

        harness.integration.setPresentationActive(false);
        harness.integration.setFullscreen(true);
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'fullscreen',
            frameRate: 0,
            suppressed: true
        });

        harness.integration.setFullscreen(false);
        harness.powerMonitor.onBattery = true;
        await harness.integration.refreshSystemState();
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'battery',
            frameRate: 10
        });

        harness.powerMonitor.onBattery = false;
        await harness.integration.refreshSystemState();
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'normal',
            frameRate: 30,
            suppressed: false
        });
    });

    it('shares fullscreen, translation, presentation, obscured, and pause suppression with quizzes', () => {
        const harness = createIntegration();

        harness.integration.setFullscreen(true);
        expect(harness.integration.getQuizSuppressionReason()).toBe('fullscreen');
        harness.integration.setFullscreen(false);

        harness.integration.setActiveTranslation(true);
        expect(harness.integration.getQuizSuppressionReason()).toBe('activeTranslation');
        harness.integration.setActiveTranslation(false);

        harness.integration.setPresentationActive(true);
        expect(harness.integration.getQuizSuppressionReason()).toBe('intenseInput');
        harness.integration.setPresentationActive(false);

        harness.integration.setObscured(true);
        expect(harness.integration.canStartQuiz()).toBe(false);
        expect(harness.integration.canAnswerQuiz()).toBe(false);
        harness.integration.setObscured(false);
        harness.integration.setHidden(true);
        expect(harness.integration.getQuizSuppressionReason()).toBe('intenseInput');
    });

    it('reduces hidden, idle, obscured, and battery rendering to the required frame rates', async () => {
        const harness = createIntegration();
        harness.integration.setHidden(true);
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'hidden',
            frameRate: 10
        });
        harness.integration.setHidden(false);
        harness.integration.setObscured(true);
        expect(harness.integration.getPerformanceMode()).toEqual({
            reason: 'paused',
            frameRate: 0,
            suppressed: true
        });
        harness.integration.setObscured(false);
        harness.powerMonitor.idleState = 'idle';
        await harness.integration.refreshSystemState();
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'idle',
            frameRate: 10
        });
        harness.powerMonitor.onBattery = true;
        await harness.integration.refreshSystemState();
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'battery',
            frameRate: 10
        });
    });
});

describe('system reads and power lifecycle', () => {
    it('refreshes battery and idle only at construction and explicit lifecycle interactions', async () => {
        vi.useFakeTimers();
        try {
            const harness = createIntegration();
            expect(harness.powerMonitor.batteryReads).toBe(1);
            expect(harness.powerMonitor.idleReads).toBe(1);

            await vi.advanceTimersByTimeAsync(120_000);
            expect(harness.powerMonitor.batteryReads).toBe(1);
            expect(harness.powerMonitor.idleReads).toBe(1);

            await harness.integration.refreshSystemState();
            expect(harness.powerMonitor.batteryReads).toBe(2);
            expect(harness.powerMonitor.idleReads).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('pauses on suspend and refreshes once when the app resumes', async () => {
        const harness = createIntegration();
        harness.powerMonitor.emit('suspend');
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'paused',
            frameRate: 0
        });

        harness.powerMonitor.emit('resume');
        await Promise.resolve();
        expect(harness.powerMonitor.batteryReads).toBe(2);
        expect(harness.powerMonitor.idleReads).toBe(2);
    });

    it('applies battery and AC transitions from powerMonitor events', () => {
        const harness = createIntegration();

        harness.powerMonitor.emit('on-battery');
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'battery',
            frameRate: 10
        });
        harness.powerMonitor.emit('on-ac');
        expect(harness.integration.getPerformanceMode()).toMatchObject({
            reason: 'normal',
            frameRate: 30
        });
    });
});

describe('window lifecycle events', () => {
    it('maps only permitted fullscreen and visibility events into suppression state', () => {
        const listeners = new Map<string, () => void>();
        const state = {
            setFullscreen: vi.fn(),
            setHidden: vi.fn()
        };
        configurePerformanceWindowEvents({
            on(event: string, listener: () => void) {
                listeners.set(event, listener);
            }
        }, state);

        listeners.get('enter-full-screen')?.();
        listeners.get('leave-full-screen')?.();
        listeners.get('hide')?.();
        listeners.get('show')?.();

        expect(state.setFullscreen).toHaveBeenNthCalledWith(1, true);
        expect(state.setFullscreen).toHaveBeenNthCalledWith(2, false);
        expect(state.setHidden).toHaveBeenNthCalledWith(1, true);
        expect(state.setHidden).toHaveBeenNthCalledWith(2, false);
        expect([...listeners.keys()]).toEqual([
            'enter-full-screen',
            'leave-full-screen',
            'hide',
            'show'
        ]);
    });
});
